"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { DISPUTE_REASONS, RETURN_REASONS } from "@market/shared";
import { ImageUploader } from "@/components/ImageUploader";
import { ReportButton } from "@/components/ReportButton";
import { StarInput, Stars } from "@/components/Stars";
import { ErrorNotice, formatDate, Money, StateBadge, toMinor } from "@/components/ui";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { Message, Order } from "@/lib/types";

const REASON_LABEL: Record<string, string> = {
  NOT_RECEIVED: "I didn't receive it", NOT_AS_DESCRIBED: "Not as described", DAMAGED: "Arrived damaged", WRONG_ITEM: "Wrong item",
  RETURN_PROBLEM: "Problem with a returned item",
};

function OrderPage() {
  const { id } = useParams<{ id: string }>();
  const placed = useSearchParams().get("placed");
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api<Order>(`/orders/${id}`).then(setOrder).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);

  /** Runs an action, then reloads the order. */
  async function act(path: string, json?: unknown, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: "POST", json: json ?? {} });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!order) return error ? <ErrorNotice error={error} /> : <p className="muted">Loading…</p>;
  const { role, state, dispute } = order;
  const money = (m: number) => <Money minor={m} currency={order.currency} />;

  return (
    <div className="stack">
      {placed && <div className="notice ok">Order placed. {money(order.totalMinor)} is held in escrow until you receive your items.</div>}
      <div className="spread">
        <div>
          <h1>Order #{order.id.slice(0, 8)}</h1>
          <div className="row"><StateBadge state={state} /><span className="muted small">Placed {formatDate(order.createdAt, true)}</span></div>
        </div>
        <span className="pill">{role === "buyer" ? "You're the buyer" : role === "seller" ? "You're the seller" : "Staff view"}</span>
      </div>
      <ErrorNotice error={error} />

      <div className="grid-2" style={{ alignItems: "start" }}>
        <div className="stack">
          <NextStep order={order} busy={busy} act={act} />
          {dispute && <DisputePanel order={order} busy={busy} act={act} />}
          {order.returnRequest && <ReturnPanel order={order} busy={busy} act={act} />}
          {role === "buyer" && state === "DELIVERED" && !order.returnRequest && <RequestReturn order={order} busy={busy} act={act} />}
          {role === "buyer" && ["SHIPPED", "DELIVERED"].includes(state) && !dispute && <OpenDispute order={order} busy={busy} act={act} />}
          {state === "COMPLETED" && <ReviewPanel order={order} busy={busy} act={act} />}
          <Chat order={order} />
        </div>

        <div className="stack">
          <div className="card">
            <h3>Items from {role === "seller" ? "your store" : <Link href={`/stores/${order.store?.slug}`}>{order.store?.name}</Link>}</h3>
            <table><tbody>
              {order.items.map((i) => <tr key={i.id}><td>{i.quantity} × <Link href={`/products/${i.productId}`}>{i.title}</Link></td><td className="right">{money(i.unitPriceMinor * i.quantity)}</td></tr>)}
              {!!order.discountMinor && <tr><td className="muted">Coupon {order.couponCode}</td><td className="right">−{money(order.discountMinor)}</td></tr>}
              <tr><td className="muted">Delivery ({order.shippingService})</td><td className="right">{money(order.shippingMinor)}</td></tr>
              <tr><td><strong>Total</strong></td><td className="right"><strong>{money(order.totalMinor)}</strong></td></tr>
              {order.refundedMinor > 0 && <tr><td className="muted">Refunded{order.refundStatus === "PENDING" && role !== "seller" ? " (processing)" : ""}</td><td className="right">−{money(order.refundedMinor)}</td></tr>}
              {role === "seller" && state === "COMPLETED" && <tr><td className="muted">Platform fee</td><td className="right">−{money(order.feeMinor)}</td></tr>}
            </tbody></table>
          </div>
          <div className="card">
            <h3>Delivery</h3>
            <p className="small">
              {order.shippingAddress.line1 && <>{order.shippingAddress.line1}, </>}{order.shippingAddress.city}
              {order.shippingAddress.country && <>, {order.shippingAddress.country}</>}
            </p>
            {order.shipment ? (
              <p className="small">{order.shipment.carrier} · tracking <span className="mono">{order.shipment.trackingNumber}</span>
                {order.shipment.deliveredAt && <><br />Delivered {formatDate(order.shipment.deliveredAt, true)}</>}</p>
            ) : <p className="muted small">Not shipped yet{order.shipBy && state === "PAID" ? `. Seller must ship by ${formatDate(order.shipBy)}.` : "."}</p>}
          </div>
          {role === "staff" && order.riskHits && (
            <div className="card"><h3>Risk</h3><p className="small">Score {order.riskScore}: {order.riskHits.map((h) => `${h.rule} (${h.points > 0 ? "+" : ""}${h.points})`).join(", ") || "no rules hit"}</p></div>
          )}
          <div className="card">
            <h3>History</h3>
            <ul className="timeline">
              {order.events?.map((e) => (
                <li key={e.id}><span className="dot" /><div><StateBadge state={e.toState} /> <span className="muted small">{formatDate(e.createdAt, true)}</span>{e.note && <div className="small">{e.note}</div>}</div></li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

type ActProps = { order: Order; busy: boolean; act: (path: string, json?: unknown, confirmText?: string) => Promise<void> };

function NextStep({ order, busy, act }: ActProps) {
  const [carrier, setCarrier] = useState("");
  const [tracking, setTracking] = useState("");
  const [code, setCode] = useState("");
  const { role, state } = order;

  if (role === "buyer") {
    if (state === "PAID") return (
      <div className="card stack">
        <p>{order.riskHold ? "We're doing a quick security check on this order. The seller will ship once it's cleared." : "Waiting for the seller to ship. Your payment is safe in escrow."}</p>
        <div><button className="secondary" disabled={busy} onClick={() => act(`/orders/${order.id}/cancel`, {}, "Cancel this order and get a full refund?")}>Cancel order</button></div>
      </div>
    );
    if (state === "SHIPPED" || state === "DELIVERED") return (
      <div className="card stack">
        <h3>{state === "SHIPPED" ? "On its way" : "Delivered"}</h3>
        {state === "SHIPPED" && <p className="small">We emailed you a 4-digit delivery code. Give it to the courier <strong>only</strong> once the package is in your hands.</p>}
        {state === "DELIVERED" && order.releaseAt && <p className="small">Payment will be released to the seller on {formatDate(order.releaseAt)} unless you report a problem.</p>}
        <div className="row">
          <button disabled={busy} onClick={() => act(`/orders/${order.id}/confirm`, {}, "Confirm you received everything in good condition? This releases payment to the seller.")}>I received my order</button>
        </div>
      </div>
    );
  }

  if (role === "seller") {
    if (state === "PAID" && order.riskHold) return <div className="notice warn">This order is under a security review. Don&apos;t ship it until we email you that it&apos;s cleared.</div>;
    if (state === "PAID") return (
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); act(`/orders/${order.id}/ship`, { carrier, trackingNumber: tracking }); }}>
        <h3>Ship this order by {formatDate(order.shipBy)}</h3>
        <div className="grid-2">
          <div><label>Carrier</label><input required value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="UPS, DHL, local courier…" /></div>
          <div><label>Tracking number</label><input required minLength={4} value={tracking} onChange={(e) => setTracking(e.target.value)} /></div>
        </div>
        <div className="row">
          <button type="submit" disabled={busy}>Mark as shipped</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => act(`/orders/${order.id}/cancel`, {}, "Cancel and fully refund the buyer?")}>Cancel order</button>
        </div>
      </form>
    );
    if (state === "SHIPPED") return (
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); act(`/orders/${order.id}/deliver`, { code }); }}>
        <h3>Confirm handover</h3>
        <p className="small muted">When the buyer receives the package, enter the 4-digit code they give the courier. This proves delivery.</p>
        <div className="row"><input required inputMode="numeric" pattern="\d{4}" maxLength={4} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} style={{ width: 120 }} /><button type="submit" disabled={busy}>Confirm delivery</button></div>
      </form>
    );
    if (state === "DELIVERED" && order.releaseAt) return <div className="notice info">Delivered. Funds release to your balance on {formatDate(order.releaseAt)} or sooner if the buyer confirms.</div>;
  }
  return null;
}

const RETURN_LABEL: Record<string, string> = {
  CHANGE_OF_MIND: "Changed my mind", NOT_AS_DESCRIBED: "Not as described", DAMAGED: "Arrived damaged", WRONG_ITEM: "Wrong item",
};

function RequestReturn({ order, busy, act }: ActProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>("NOT_AS_DESCRIBED");
  const [description, setDescription] = useState("");
  const [evidence, setEvidence] = useState<string[]>([]);
  const policy = order.store?.returnPolicyDays ?? 0;
  if (!open) return <div><button className="link" onClick={() => setOpen(true)}>Return this order</button></div>;
  const changeOfMind = reason === "CHANGE_OF_MIND";
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); act(`/orders/${order.id}/returns`, { reason, description, evidence }); }}>
      <h3>Return this order</h3>
      <div><label>Why are you returning it?</label>
        <select value={reason} onChange={(e) => setReason(e.target.value)}>
          {RETURN_REASONS.map((r) => <option key={r} value={r} disabled={r === "CHANGE_OF_MIND" && !policy}>{RETURN_LABEL[r]}{r === "CHANGE_OF_MIND" && !policy ? " (not accepted by this seller)" : ""}</option>)}
        </select>
      </div>
      <p className="small muted">
        {changeOfMind
          ? `Within ${policy} days of delivery. You pay return postage, and you're refunded the item price (not the original delivery) once the seller receives it.`
          : "The seller pays return postage and you get a full refund once the item arrives back."}
      </p>
      <div><label>Details</label><textarea required minLength={10} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
      {!changeOfMind && <div><label>Photos</label><ImageUploader value={evidence} onChange={setEvidence} /></div>}
      <div className="row"><button type="submit" disabled={busy}>Request return</button><button type="button" className="secondary" onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
  );
}

function ReturnPanel({ order, busy, act }: ActProps) {
  const r = order.returnRequest!;
  const [carrier, setCarrier] = useState("");
  const [tracking, setTracking] = useState("");
  const [problem, setProblem] = useState("");
  const money = (m: number) => <Money minor={m} currency={order.currency} />;
  const status = { REQUESTED: "Waiting for the buyer to send it back", SHIPPED_BACK: "On its way back to the seller", RECEIVED: "Returned and refunded", REJECTED: order.state === "COMPLETED" ? "Return lapsed (not sent back)" : "With the resolution team" }[r.status];
  return (
    <div className="card stack">
      <div className="spread"><h3>Return: {RETURN_LABEL[r.reason]}</h3><span className="pill warn">{status}</span></div>
      <p className="small">{r.description}</p>
      <p className="small muted">Refund on return: {money(r.refundMinor)} · postage paid by {r.returnPaidBy === "BUYER" ? "the buyer" : "the seller"}</p>
      {r.trackingNumber && <p className="small">Return tracking: {r.carrier} <span className="mono">{r.trackingNumber}</span></p>}

      {order.role === "buyer" && r.status === "REQUESTED" && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); act(`/returns/${r.id}/ship`, { carrier, trackingNumber: tracking }); }}>
          <p className="small">Send the item back to the seller{r.returnPaidBy === "SELLER" ? " (ask them for a prepaid label in the chat)" : ""}, then add the tracking number.</p>
          <div className="grid-2">
            <div><label>Carrier</label><input required value={carrier} onChange={(e) => setCarrier(e.target.value)} /></div>
            <div><label>Tracking number</label><input required minLength={4} value={tracking} onChange={(e) => setTracking(e.target.value)} /></div>
          </div>
          <div><button type="submit" disabled={busy}>I&apos;ve sent it back</button></div>
        </form>
      )}
      {order.role === "buyer" && r.status === "SHIPPED_BACK" && r.autoRefundAt && <p className="small">If the seller doesn&apos;t confirm by {formatDate(r.autoRefundAt)}, you&apos;ll be refunded automatically.</p>}

      {order.role === "seller" && r.status === "REQUESTED" && <p className="small muted">Payment stays in escrow until the return is settled. If the buyer doesn&apos;t send it back, the payment is released to you.</p>}
      {order.role === "seller" && r.status === "SHIPPED_BACK" && (
        <div className="stack">
          <p className="small">When the parcel arrives, check it. Confirm by {r.autoRefundAt ? formatDate(r.autoRefundAt) : "the deadline"} or the buyer is refunded automatically.</p>
          <div><button disabled={busy} onClick={() => act(`/returns/${r.id}/receive`, {}, `Confirm the item arrived and refund ${(r.refundMinor / 100).toFixed(2)} to the buyer?`)}>Item received, refund buyer</button></div>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); act(`/returns/${r.id}/dispute`, { description: problem }, "Send this return to the resolution team?"); }}>
            <label>Problem with the returned item?</label>
            <textarea required minLength={10} rows={2} value={problem} onChange={(e) => setProblem(e.target.value)} placeholder="Describe what's wrong (damaged, used, empty box…)" />
            <div><button type="submit" className="secondary" disabled={busy}>Report a problem</button></div>
          </form>
        </div>
      )}
    </div>
  );
}

function ReviewPanel({ order, busy, act }: ActProps) {
  const reviewed = new Map((order.reviews ?? []).map((r) => [r.productId, r]));
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [bodies, setBodies] = useState<Record<string, string>>({});
  if (order.role === "staff") return null;
  const items = order.items.filter((i, idx, all) => all.findIndex((x) => x.productId === i.productId) === idx);
  if (order.role === "seller" && reviewed.size === 0) return null;
  return (
    <div className="card stack">
      <h3>{order.role === "buyer" ? "Rate your purchase" : "Buyer reviews"}</h3>
      {items.map((i) => {
        const r = reviewed.get(i.productId);
        if (r) return (
          <div key={i.productId} className="stack" style={{ gap: 4 }}>
            <div className="spread"><span>{i.title}</span><Stars value={r.rating} /></div>
            {r.body && <p className="small">{r.body}</p>}
            {r.sellerReply && <div className="notice info small"><strong>Seller reply:</strong> {r.sellerReply}</div>}
            {order.role === "seller" && !r.sellerReply && <ReplyForm reviewId={r.id} busy={busy} act={act} />}
          </div>
        );
        if (order.role !== "buyer") return null;
        return (
          <form key={i.productId} className="stack" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); act(`/orders/${order.id}/reviews`, { productId: i.productId, rating: ratings[i.productId], body: bodies[i.productId] || undefined }); }}>
            <div className="spread"><span>{i.title}</span><StarInput value={ratings[i.productId] ?? 0} onChange={(v) => setRatings({ ...ratings, [i.productId]: v })} /></div>
            <textarea rows={2} maxLength={2000} placeholder="What did you think? (optional)" value={bodies[i.productId] ?? ""} onChange={(e) => setBodies({ ...bodies, [i.productId]: e.target.value })} />
            <div><button type="submit" disabled={busy || !ratings[i.productId]}>Post review</button></div>
          </form>
        );
      })}
    </div>
  );
}

function ReplyForm({ reviewId, busy, act }: { reviewId: string; busy: boolean; act: ActProps["act"] }) {
  const [reply, setReply] = useState("");
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); act(`/reviews/${reviewId}/reply`, { reply }); }}>
      <input required maxLength={1000} placeholder="Reply publicly" value={reply} onChange={(e) => setReply(e.target.value)} style={{ flex: 1 }} />
      <button type="submit" className="secondary" disabled={busy}>Reply</button>
    </form>
  );
}

function OpenDispute({ order, busy, act }: ActProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>(DISPUTE_REASONS[0]);
  const [description, setDescription] = useState("");
  const [evidence, setEvidence] = useState<string[]>([]);
  if (!open) return <div><button className="link" onClick={() => setOpen(true)}>Report a problem with this order</button></div>;
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); act(`/orders/${order.id}/disputes`, { reason, description, evidence }); }}>
      <h3>Report a problem</h3>
      <p className="small muted">Payment to the seller is paused while we sort this out. The seller has 3 days to respond.</p>
      <div><label>What happened?</label><select value={reason} onChange={(e) => setReason(e.target.value)}>{DISPUTE_REASONS.map((r) => <option key={r} value={r}>{REASON_LABEL[r]}</option>)}</select></div>
      <div><label>Details</label><textarea required minLength={10} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
      <div><label>Photos (recommended)</label><ImageUploader value={evidence} onChange={setEvidence} /></div>
      <div className="row"><button type="submit" disabled={busy}>Open dispute</button><button type="button" className="secondary" onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
  );
}

function DisputePanel({ order, busy, act }: ActProps) {
  const d = order.dispute!;
  const { me } = useSession();
  const [offerKind, setOfferKind] = useState("PARTIAL_REFUND");
  const [offerAmount, setOfferAmount] = useState("");
  const [outcome, setOutcome] = useState("FULL_REFUND");
  const [amount, setAmount] = useState("");
  const [reasoning, setReasoning] = useState("");
  const money = (m: number) => <Money minor={m} currency={order.currency} />;
  const isStaff = me?.roles.some((r) => r === "ADMIN" || r === "AGENT");
  const buyerCanEscalate = d.offerDeclined || new Date(d.sellerRespondBy) < new Date();

  return (
    <div className="card stack" style={{ borderColor: "var(--warn)" }}>
      <div className="spread"><h3>Dispute: {REASON_LABEL[d.reason]}</h3><span className={`pill ${d.stage === "RESOLVED" ? "ok" : "warn"}`}>{d.stage === "OPEN" ? "Negotiating" : d.stage === "ESCALATED" ? "With resolution team" : "Resolved"}</span></div>
      <p className="small" style={{ whiteSpace: "pre-wrap" }}>{d.description}</p>
      {d.evidence.length > 0 && <div className="uploads">{d.evidence.map((u) => <a key={u} className="u" href={u} target="_blank" rel="noreferrer"><img src={u} alt="Evidence" /></a>)}</div>}

      {d.stage === "RESOLVED" ? (
        <div className="notice info small"><strong>Decision:</strong> {d.outcome?.replace(/_/g, " ").toLowerCase()}{d.outcomeMinor ? <> ({money(d.outcomeMinor)} refunded)</> : null}. {d.reasoning}</div>
      ) : (
        <>
          {d.offerMinor != null && (
            <div className="notice info small">Seller offered a refund of <strong>{money(d.offerMinor)}</strong>{d.offerNote && <>: “{d.offerNote}”</>}{d.offerDeclined && " (declined)"}</div>
          )}
          {d.stage === "OPEN" && <p className="muted small">Seller must respond by {formatDate(d.sellerRespondBy, true)}, or the buyer is refunded automatically.</p>}

          {order.role === "buyer" && (
            <div className="row">
              {d.stage === "OPEN" && d.offerMinor != null && !d.offerDeclined && <>
                <button disabled={busy} onClick={() => act(`/disputes/${d.id}/accept`, {}, "Accept this offer? The dispute will close.")}>Accept offer</button>
                <button className="secondary" disabled={busy} onClick={() => act(`/disputes/${d.id}/decline`)}>Decline</button>
              </>}
              {d.stage === "OPEN" && <button className="secondary" disabled={busy || !buyerCanEscalate} title={buyerCanEscalate ? "" : "Available after the seller's deadline or once you decline an offer"} onClick={() => act(`/disputes/${d.id}/escalate`)}>Ask the resolution team</button>}
              <button className="link small" disabled={busy} onClick={() => act(`/disputes/${d.id}/withdraw`, {}, "Close the dispute and release payment to the seller?")}>Problem solved, close dispute</button>
            </div>
          )}

          {order.role === "seller" && d.stage === "OPEN" && (
            <form className="stack" onSubmit={(e) => { e.preventDefault(); act(`/disputes/${d.id}/offer`, { kind: offerKind, amountMinor: offerKind === "PARTIAL_REFUND" ? toMinor(offerAmount) : undefined }); }}>
              <div className="row">
                <select value={offerKind} onChange={(e) => setOfferKind(e.target.value)} style={{ width: 180 }}><option value="PARTIAL_REFUND">Partial refund</option><option value="FULL_REFUND">Full refund</option></select>
                {offerKind === "PARTIAL_REFUND" && <input required inputMode="decimal" placeholder="Amount" value={offerAmount} onChange={(e) => setOfferAmount(e.target.value)} style={{ width: 120 }} />}
                <button type="submit" disabled={busy}>Send offer</button>
                <button type="button" className="secondary" disabled={busy} onClick={() => act(`/disputes/${d.id}/escalate`)}>Ask the resolution team</button>
              </div>
            </form>
          )}

          {isStaff && order.role === "staff" && (
            <form className="stack" onSubmit={(e) => { e.preventDefault(); act(`/disputes/${d.id}/decide`, { outcome, amountMinor: outcome === "PARTIAL_REFUND" ? toMinor(amount) : undefined, reasoning }, "Issue this final decision?"); }}>
              <h3>Decision</h3>
              <div className="row">
                <select value={outcome} onChange={(e) => setOutcome(e.target.value)} style={{ width: 200 }}><option value="FULL_REFUND">Full refund to buyer</option><option value="PARTIAL_REFUND">Partial refund</option><option value="RELEASE_TO_SELLER">Release to seller</option></select>
                {outcome === "PARTIAL_REFUND" && <input required inputMode="decimal" placeholder="Refund amount" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 140 }} />}
              </div>
              <textarea required minLength={10} rows={3} placeholder="Reasoning (sent to both parties)" value={reasoning} onChange={(e) => setReasoning(e.target.value)} />
              <div><button type="submit" disabled={busy}>Issue decision</button></div>
            </form>
          )}
        </>
      )}
    </div>
  );
}

function Chat({ order }: { order: Order }) {
  const { me } = useSession();
  const [messages, setMessages] = useState<Message[]>([]);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<Message[]>(`/orders/${order.id}/messages`).then(setMessages).catch(() => {}), [order.id]);

  useEffect(() => {
    load();
    // Polling keeps the MVP simple; switch to WebSockets when chat volume grows.
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const otherUserId = order.role === "buyer" ? order.store?.ownerId : order.buyer?.id;
  const anyFlagged = messages.some((m) => m.flags.length > 0);

  return (
    <div className="card stack">
      <div className="spread"><h3>Messages</h3>{otherUserId && order.role !== "staff" && <BlockButton userId={otherUserId} />}</div>
      {anyFlagged && <div className="notice warn small"><strong>Stay safe:</strong> buyer protection only covers payments made on this site. Never pay by bank transfer, gift cards or crypto, and never share your delivery code before you have the package.</div>}
      <div className="chat">
        {messages.length === 0 && <p className="muted small">No messages yet.</p>}
        {messages.map((m) => {
          const staff = m.sender.roles.some((r) => r === "ADMIN" || r === "AGENT");
          return (
            <div key={m.id} className={`bubble ${m.senderId === me?.id ? "mine" : ""} ${staff ? "staff" : ""}`}>
              {staff && <div className="small"><strong>Resolution team</strong></div>}
              {m.body}
              <div className="muted small row" style={{ gap: 8 }}>
                {formatDate(m.createdAt, true)}
                {m.flags.length > 0 && <span className="pill warn">⚠ contains {m.flags.join(", ").replace(/_/g, " ")}</span>}
                {m.senderId !== me?.id && <ReportButton targetType="MESSAGE" targetId={m.id} />}
              </div>
            </div>
          );
        })}
      </div>
      {(order.role !== "staff" || order.state === "DISPUTED") && (
        <form className="row" onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            await api(`/orders/${order.id}/messages`, { method: "POST", json: { body } });
            setBody("");
            load();
          } catch (err) {
            setError((err as Error).message);
          }
        }}>
          <input required maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a message" style={{ flex: 1 }} />
          <button type="submit">Send</button>
        </form>
      )}
      <ErrorNotice error={error} />
    </div>
  );
}

function BlockButton({ userId }: { userId: string }) {
  const [blocked, setBlocked] = useState(false);
  return (
    <button className="link small" onClick={async () => {
      if (!blocked && !window.confirm("Block this user? They won't be able to message you. You can still open a dispute.")) return;
      await api(`/users/${userId}/block`, { method: blocked ? "DELETE" : "POST" });
      setBlocked(!blocked);
    }}>{blocked ? "Unblock" : "Block user"}</button>
  );
}

export default function Page() {
  return <Suspense><OrderPage /></Suspense>;
}
