"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Stars } from "@/components/Stars";
import { ErrorNotice, formatDate, Money, toMinor } from "@/components/ui";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { Review } from "@/lib/types";

const C = "USD";

interface Analytics {
  periodDays: number; orders: number; salesMinor: number; refundsMinor: number; averageOrderMinor: number; netEarnedMinor: number; feesMinor: number;
  disputes: number; rating: { average: number | null; count: number }; topProducts: { productId: string; title: string; quantity: number }[];
  lowStock: { id: string; title: string; stock: number }[];
}

export function SellerAnalytics() {
  const [a, setA] = useState<Analytics | null>(null);
  useEffect(() => { api<Analytics>("/stores/me/analytics").then(setA); }, []);
  if (!a) return <p className="muted">Loading…</p>;
  const tiles: [string, React.ReactNode][] = [
    ["Sales", <Money key="s" minor={a.salesMinor} currency={C} />],
    ["Orders", a.orders],
    ["Average order", <Money key="a" minor={a.averageOrderMinor} currency={C} />],
    ["Earned after fees", <Money key="n" minor={a.netEarnedMinor} currency={C} />],
    ["Refunds", <Money key="r" minor={a.refundsMinor} currency={C} />],
    ["Disputes", a.disputes],
    ["Rating", a.rating.count ? <span key="ra">{a.rating.average} <Stars value={a.rating.average ?? 0} /></span> : "No reviews yet"],
  ];
  return (
    <div className="stack">
      <p className="muted small">Last {a.periodDays} days</p>
      <div className="grid-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
        {tiles.map(([label, v]) => <div key={label} className="card"><div className="muted small">{label}</div><div style={{ fontSize: 22, fontWeight: 700 }}>{v}</div></div>)}
      </div>
      <div className="grid-2">
        <div className="card stack"><h3>Best sellers</h3>
          {a.topProducts.length ? a.topProducts.map((t) => <div key={t.productId} className="spread small"><Link href={`/products/${t.productId}`}>{t.title}</Link><span>{t.quantity} sold</span></div>) : <p className="muted small">No sales yet.</p>}
        </div>
        <div className="card stack"><h3>Low stock</h3>
          {a.lowStock.length ? a.lowStock.map((p) => <div key={p.id} className="spread small"><span>{p.title}</span><span className={`pill ${p.stock === 0 ? "danger" : "warn"}`}>{p.stock} left</span></div>) : <p className="muted small">Everything is well stocked.</p>}
        </div>
      </div>
    </div>
  );
}

interface PayoutInfo { availableMinor: number; account: string | null; holdUntil: string | null; history: { id: string; amountMinor: number; status: string; createdAt: string; destination: string }[] }

export function SellerPayouts() {
  const { me } = useSession();
  const [info, setInfo] = useState<PayoutInfo | null>(null);
  const [accountRef, setAccountRef] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(() => api<PayoutInfo>("/stores/me/payouts").then(setInfo), []);
  useEffect(() => { load(); }, [load]);
  async function run(fn: () => Promise<void>) {
    setError(null); setNotice(null);
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); }
  }
  if (!info) return <p className="muted">Loading…</p>;
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <div className="card spread">
        <div><div className="muted small">Available to pay out</div><div style={{ fontSize: 26, fontWeight: 700 }}><Money minor={info.availableMinor} currency={C} /></div>
          <div className="muted small">Paid automatically every day at 6:00. Money from orders still in escrow appears here once released.</div></div>
        <button disabled={!info.account || !!info.holdUntil || info.availableMinor < 1000} onClick={() => run(async () => {
          const r = await api<{ status: string; amountMinor: number }>("/stores/me/payouts", { method: "POST" });
          setNotice(r.status === "PAID" ? "Payout sent." : "The transfer failed. Your balance has been restored; try again later.");
        })}>Pay out now</button>
      </div>
      {info.holdUntil && <div className="notice warn">Payouts are paused until {formatDate(info.holdUntil, true)} because your payout account changed. This protects you if someone else got into your account.</div>}
      <ErrorNotice error={error} />
      {notice && <div className="notice ok">{notice}</div>}

      <form className="card stack" onSubmit={(e) => { e.preventDefault(); run(async () => {
        await api("/stores/me/payout-account", { method: "POST", json: { accountRef, code } });
        setAccountRef(""); setCode(""); setCodeSent(false);
        setNotice("Payout account saved.");
      }); }}>
        <h3>Payout account</h3>
        <p className="small">{info.account ? <>Payouts go to the account ending <strong>{info.account}</strong>.</> : "No payout account yet."}</p>
        <p className="muted small">Enter your account id from the payment provider. For your security we&apos;ll email you a code to confirm, and changing an existing account pauses payouts for 72 hours.</p>
        <div><label>Account id</label><input required pattern="[A-Za-z0-9_]{6,64}" value={accountRef} onChange={(e) => setAccountRef(e.target.value)} placeholder="acct_…" /></div>
        {!codeSent ? (
          <div><button type="button" className="secondary" disabled={!accountRef} onClick={() => run(async () => { await api("/auth/otp", { method: "POST", json: { email: me?.email } }); setCodeSent(true); })}>Email me a confirmation code</button></div>
        ) : (
          <>
            <div><label>Confirmation code</label><input required inputMode="numeric" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} /></div>
            <div><button type="submit">Save payout account</button></div>
          </>
        )}
      </form>

      <div className="card stack">
        <h3>Payout history</h3>
        {info.history.length === 0 ? <p className="muted small">No payouts yet.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Date</th><th>To</th><th>Status</th><th className="right">Amount</th></tr></thead>
            <tbody>{info.history.map((p) => (
              <tr key={p.id}><td className="small">{formatDate(p.createdAt, true)}</td><td className="small mono">••••{p.destination.slice(-4)}</td>
                <td><span className={`pill ${p.status === "PAID" ? "ok" : p.status === "FAILED" ? "danger" : ""}`}>{p.status.toLowerCase()}</span></td>
                <td className="right"><Money minor={p.amountMinor} currency={C} /></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}

interface Coupon { id: string; code: string; kind: "PERCENT" | "FIXED"; value: number; minSubtotalMinor: number; maxUses: number | null; usedCount: number; expiresAt: string | null; active: boolean }

export function SellerCoupons() {
  const [items, setItems] = useState<Coupon[] | null>(null);
  const [f, setF] = useState({ code: "", kind: "PERCENT", value: "10", min: "", maxUses: "", expires: "" });
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<Coupon[]>("/stores/me/coupons").then(setItems), []);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <form className="card stack" onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await api("/stores/me/coupons", { method: "POST", json: {
            code: f.code, kind: f.kind,
            value: f.kind === "PERCENT" ? Math.round(Number(f.value) * 100) : toMinor(f.value),
            minSubtotalMinor: f.min ? toMinor(f.min) : 0,
            maxUses: f.maxUses ? Number(f.maxUses) : undefined,
            expiresAt: f.expires ? new Date(`${f.expires}T23:59:59`).toISOString() : undefined,
          } });
          setF({ ...f, code: "" });
          load();
        } catch (err) { setError((err as Error).message); }
      }}>
        <h3>New coupon</h3>
        <p className="muted small">Coupons come off your price, so you fund the discount. Buyers enter the code at checkout.</p>
        <div className="grid-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
          <div><label>Code</label><input required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} placeholder="SPRING10" /></div>
          <div><label>Type</label><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="PERCENT">% off</option><option value="FIXED">Amount off</option></select></div>
          <div><label>{f.kind === "PERCENT" ? "Percent" : "Amount"}</label><input required inputMode="decimal" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></div>
          <div><label>Minimum order (optional)</label><input inputMode="decimal" value={f.min} onChange={(e) => setF({ ...f, min: e.target.value })} /></div>
          <div><label>Max uses (optional)</label><input type="number" min={1} value={f.maxUses} onChange={(e) => setF({ ...f, maxUses: e.target.value })} /></div>
          <div><label>Expires (optional)</label><input type="date" value={f.expires} onChange={(e) => setF({ ...f, expires: e.target.value })} /></div>
        </div>
        <ErrorNotice error={error} />
        <div><button type="submit">Create coupon</button></div>
      </form>
      {items && items.length > 0 && (
        <div className="table-wrap"><table>
          <thead><tr><th>Code</th><th>Discount</th><th>Used</th><th>Expires</th><th /></tr></thead>
          <tbody>{items.map((c) => (
            <tr key={c.id}>
              <td className="mono">{c.code}</td>
              <td>{c.kind === "PERCENT" ? `${c.value / 100}%` : <Money minor={c.value} currency={C} />}{c.minSubtotalMinor > 0 && <span className="muted small"> over <Money minor={c.minSubtotalMinor} currency={C} /></span>}</td>
              <td>{c.usedCount}{c.maxUses ? ` / ${c.maxUses}` : ""}</td>
              <td className="small">{c.expiresAt ? formatDate(c.expiresAt) : "Never"}</td>
              <td className="right"><button className="link small" onClick={async () => { await api(`/stores/me/coupons/${c.id}`, { method: "PATCH", json: { active: !c.active } }); load(); }}>{c.active ? "Turn off" : "Turn on"}</button></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

export function SellerReviews() {
  const [items, setItems] = useState<Review[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const load = useCallback(() => api<Review[]>("/stores/me/reviews").then(setItems), []);
  useEffect(() => { load(); }, [load]);
  if (!items) return <p className="muted">Loading…</p>;
  if (!items.length) return <p className="muted">No reviews yet.</p>;
  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      {items.map((r) => (
        <div key={r.id} className="card stack" style={{ gap: 6 }}>
          <div className="spread"><span><Stars value={r.rating} /> <Link href={`/products/${r.productId}`} className="small">{r.product?.title}</Link></span><span className="muted small">{formatDate(r.createdAt)}</span></div>
          {r.body && <p>{r.body}</p>}
          {r.sellerReply ? <div className="notice info small"><strong>Your reply:</strong> {r.sellerReply}</div> : (
            <form className="row" onSubmit={async (e) => { e.preventDefault(); await api(`/reviews/${r.id}/reply`, { method: "POST", json: { reply: drafts[r.id] } }); load(); }}>
              <input required maxLength={1000} placeholder="Reply publicly (once)" value={drafts[r.id] ?? ""} onChange={(e) => setDrafts({ ...drafts, [r.id]: e.target.value })} style={{ flex: 1 }} />
              <button type="submit" className="secondary">Reply</button>
            </form>
          )}
        </div>
      ))}
    </div>
  );
}

export function SellerSettings({ store, onSaved }: { store: { returnPolicyDays: number; freeShippingOverMinor: number | null }; onSaved: () => void }) {
  const [days, setDays] = useState(store.returnPolicyDays);
  const [threshold, setThreshold] = useState(store.freeShippingOverMinor != null ? String(store.freeShippingOverMinor / 100) : "");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="card stack" style={{ maxWidth: 560 }} onSubmit={async (e) => {
      e.preventDefault();
      setError(null);
      try {
        await api("/stores/me/settings", { method: "PATCH", json: { returnPolicyDays: days, freeShippingOverMinor: threshold ? toMinor(threshold) : null } });
        setMsg("Saved");
        onSaved();
      } catch (err) { setError((err as Error).message); }
    }}>
      <h3>Store settings</h3>
      <div><label>Change-of-mind returns</label>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={0}>Not accepted</option><option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option>
        </select>
        <p className="muted small">Faulty, damaged or wrong items can always be returned, whatever you choose.</p>
      </div>
      <div><label>Free delivery on orders over (leave empty for none)</label><input inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
        <p className="muted small">You pay the standard delivery cost on these orders.</p></div>
      <ErrorNotice error={error} />
      {msg && <div className="notice ok">{msg}</div>}
      <div><button type="submit">Save settings</button></div>
    </form>
  );
}
