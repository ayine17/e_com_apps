"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ErrorNotice, formatDate, Money } from "@/components/ui";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { AdminAnalytics, AdminSettings, AdminUsers } from "./more";
import type { Dispute, Order, Product } from "@/lib/types";

type Tab = "stores" | "held" | "listings" | "reports" | "disputes" | "finance" | "analytics" | "settings" | "users";
interface Overview { pendingStores: number; heldOrders: number; productsInReview: number; openReports: number; escalatedDisputes: number }

export default function AdminPage() {
  const { me, loading } = useSession();
  const [tab, setTab] = useState<Tab>("held");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => api<Overview>("/admin/overview").then(setOverview).catch((e) => setError(e.message)), []);
  useEffect(() => { if (me) refresh(); }, [me, refresh]);

  if (loading) return null;
  const isAdmin = me?.roles.includes("ADMIN");
  if (!me || !(isAdmin || me.roles.includes("AGENT"))) return <p>You don&apos;t have access to this page.</p>;

  const tabs: [Tab, string, number | undefined, boolean][] = [
    ["held", "Fraud review", overview?.heldOrders, true],
    ["disputes", "Disputes", overview?.escalatedDisputes, true],
    ["listings", "Listings", overview?.productsInReview, true],
    ["reports", "Reports", overview?.openReports, true],
    ["stores", "Seller verification", overview?.pendingStores, !!isAdmin],
    ["finance", "Finance", undefined, !!isAdmin],
    ["analytics", "Analytics", undefined, !!isAdmin],
    ["users", "Users", undefined, !!isAdmin],
    ["settings", "Settings", undefined, !!isAdmin],
  ];

  return (
    <div className="stack">
      <h1>Admin</h1>
      <ErrorNotice error={error} />
      <div className="tabs">
        {tabs.filter((t) => t[3]).map(([key, label, count]) => (
          <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{label}{count ? <span className="badge-count">{count}</span> : null}</button>
        ))}
      </div>
      {tab === "stores" && <Stores onChange={refresh} />}
      {tab === "held" && <Held onChange={refresh} />}
      {tab === "listings" && <ListingReview onChange={refresh} />}
      {tab === "reports" && <Reports onChange={refresh} isAdmin={!!isAdmin} />}
      {tab === "disputes" && <Disputes />}
      {tab === "finance" && <Finance />}
      {tab === "analytics" && <AdminAnalytics />}
      {tab === "users" && <AdminUsers />}
      {tab === "settings" && <AdminSettings />}
    </div>
  );
}

function useList<T>(path: string) {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<T[]>(path).then(setItems).catch((e) => setError(e.message)), [path]);
  useEffect(() => { load(); }, [load]);
  return { items, error, load, setError };
}

function Stores({ onChange }: { onChange: () => void }) {
  const { items, error, load, setError } = useList<{ id: string; name: string; city: string; country: string; createdAt: string; owner: { email: string; createdAt: string } }>("/admin/stores?status=PENDING");
  async function decide(id: string, approve: boolean) {
    const note = approve ? undefined : window.prompt("Reason (sent to the seller)") ?? undefined;
    try { await api(`/admin/stores/${id}/verify`, { method: "POST", json: { approve, note } }); load(); onChange(); } catch (e) { setError((e as Error).message); }
  }
  if (!items) return <p className="muted">Loading…</p>;
  return (
    <div className="stack">
      <p className="muted small">Check the seller&apos;s ID and payout details before approving. Once Stripe Connect is set up, this step is replaced by its identity checks.</p>
      <ErrorNotice error={error} />
      {items.length === 0 && <p className="muted">No stores waiting.</p>}
      {items.map((s) => (
        <div key={s.id} className="card spread">
          <div><strong>{s.name}</strong><div className="muted small">{s.owner.email} · {s.city}, {s.country} · applied {formatDate(s.createdAt)} · account since {formatDate(s.owner.createdAt)}</div></div>
          <div className="row"><button onClick={() => decide(s.id, true)}>Approve</button><button className="secondary" onClick={() => decide(s.id, false)}>Reject</button></div>
        </div>
      ))}
    </div>
  );
}

function Held({ onChange }: { onChange: () => void }) {
  const { items, error, load, setError } = useList<Order & { buyer: { email: string; createdAt: string } }>("/admin/orders/held");
  async function review(id: string, decision: "clear" | "cancel") {
    if (decision === "cancel" && !window.confirm("Cancel and refund this order as fraud?")) return;
    try { await api(`/admin/orders/${id}/risk-review`, { method: "POST", json: { decision } }); load(); onChange(); } catch (e) { setError((e as Error).message); }
  }
  if (!items) return <p className="muted">Loading…</p>;
  return (
    <div className="stack">
      <ErrorNotice error={error} />
      {items.length === 0 && <p className="muted">No orders waiting for review.</p>}
      {items.map((o) => (
        <div key={o.id} className="card stack">
          <div className="spread">
            <div><Link href={`/orders/${o.id}`}><strong>#{o.id.slice(0, 8)}</strong></Link> · <Money minor={o.totalMinor} currency={o.currency} /> · {o.store?.name}</div>
            <span className="pill warn">Risk score {o.riskScore}</span>
          </div>
          <div className="small muted">Buyer {o.buyer.email}, account since {formatDate(o.buyer.createdAt)} · {o.items.map((i) => `${i.quantity} × ${i.title}`).join(", ")}</div>
          <div className="small">Rules hit: {o.riskHits?.map((h) => `${h.rule.replace(/_/g, " ")} (${h.points > 0 ? "+" : ""}${h.points})`).join(", ")}</div>
          <div className="row"><button onClick={() => review(o.id, "clear")}>Looks legitimate, release to seller</button><button className="danger" onClick={() => review(o.id, "cancel")}>Fraud: cancel and refund</button></div>
        </div>
      ))}
    </div>
  );
}

function ListingReview({ onChange }: { onChange: () => void }) {
  const { items, error, load, setError } = useList<Product & { store: { name: string }; category: { name: string } }>("/admin/products/review");
  async function decide(id: string, approve: boolean) {
    try { await api(`/admin/products/${id}/review`, { method: "POST", json: { approve } }); load(); onChange(); } catch (e) { setError((e as Error).message); }
  }
  if (!items) return <p className="muted">Loading…</p>;
  return (
    <div className="stack">
      <ErrorNotice error={error} />
      {items.length === 0 && <p className="muted">No listings waiting for review.</p>}
      {items.map((p) => (
        <div key={p.id} className="card stack">
          <div className="spread"><div><Link href={`/products/${p.id}`}><strong>{p.title}</strong></Link> · <Money minor={p.priceMinor} currency={p.currency} /> · {p.category.name} · {p.store.name}</div><span className="pill warn">{p.reviewNote}</span></div>
          <p className="small">{p.description}</p>
          <div className="row"><button onClick={() => decide(p.id, true)}>Approve</button><button className="danger" onClick={() => decide(p.id, false)}>Remove</button></div>
        </div>
      ))}
    </div>
  );
}

function Reports({ onChange, isAdmin }: { onChange: () => void; isAdmin: boolean }) {
  const { items, error, load, setError } = useList<{ id: string; targetType: string; targetId: string; reason: string; createdAt: string; reporter: { email: string } }>("/admin/reports");
  async function act(id: string, action: string) {
    try { await api(`/admin/reports/${id}`, { method: "POST", json: { action } }); load(); onChange(); } catch (e) { setError((e as Error).message); }
  }
  if (!items) return <p className="muted">Loading…</p>;
  return (
    <div className="stack">
      <ErrorNotice error={error} />
      {items.length === 0 && <p className="muted">No open reports.</p>}
      {items.map((r) => (
        <div key={r.id} className="card stack">
          <div className="spread"><span><span className="pill">{r.targetType}</span> {r.targetType === "PRODUCT" ? <Link href={`/products/${r.targetId}`}>View listing</Link> : <span className="mono small">{r.targetId}</span>}</span><span className="muted small">{r.reporter.email} · {formatDate(r.createdAt, true)}</span></div>
          <p>{r.reason}</p>
          <div className="row">
            <button className="secondary" onClick={() => act(r.id, "dismiss")}>Dismiss</button>
            {r.targetType === "PRODUCT" && <button onClick={() => act(r.id, "remove_product")}>Remove listing</button>}
            {isAdmin && <button className="danger" onClick={() => window.confirm("Suspend this user's account?") && act(r.id, "suspend_user")}>Suspend user</button>}
          </div>
        </div>
      ))}
    </div>
  );
}

function Disputes() {
  const [stage, setStage] = useState("ESCALATED");
  const { items, error } = useList<Dispute & { order: Order }>(`/admin/disputes?stage=${stage}`);
  return (
    <div className="stack">
      <div className="chips">{["ESCALATED", "OPEN", "RESOLVED"].map((s) => <button key={s} className={`chip ${stage === s ? "active" : ""}`} onClick={() => setStage(s)}>{s.toLowerCase()}</button>)}</div>
      <ErrorNotice error={error} />
      {items?.length === 0 && <p className="muted">Nothing here.</p>}
      {items?.map((d) => (
        <Link key={d.id} href={`/orders/${d.orderId}`} className="card spread" style={{ color: "var(--text)" }}>
          <div><strong>{d.reason.replace(/_/g, " ").toLowerCase()}</strong> · {d.order.store?.name} · <Money minor={d.order.totalMinor} currency={d.order.currency} /><div className="muted small">{d.description.slice(0, 140)}</div></div>
          <span className="muted small">{d.escalatedAt ? `Escalated ${formatDate(d.escalatedAt)}` : `Opened ${formatDate(d.createdAt)}`}</span>
        </Link>
      ))}
    </div>
  );
}

function Finance() {
  const [f, setF] = useState<Record<string, number> | null>(null);
  useEffect(() => { api<Record<string, number>>("/admin/finance").then(setF); }, []);
  if (!f) return <p className="muted">Loading…</p>;
  const c = "USD";
  return (
    <div className="stack">
      <div className="grid-2">
        <div className="card"><div className="muted small">Held in escrow</div><h2><Money minor={f.heldInEscrowMinor} currency={c} /></h2></div>
        <div className="card"><div className="muted small">Owed to sellers</div><h2><Money minor={f.owedToSellersMinor} currency={c} /></h2></div>
        <div className="card"><div className="muted small">Fees earned</div><h2><Money minor={f.feesEarnedMinor} currency={c} /></h2></div>
        <div className="card"><div className="muted small">Cash at payment provider</div><h2><Money minor={f.providerCashMinor} currency={c} /></h2></div>
      </div>
      {f.unbalancedTransactions > 0
        ? <div className="notice error">{f.unbalancedTransactions} ledger transactions don&apos;t balance. Investigate before paying out.</div>
        : <div className="notice ok">Ledger balanced: escrow + seller balances + fees = cash at provider.</div>}
    </div>
  );
}
