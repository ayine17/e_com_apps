"use client";

import { useEffect, useState } from "react";
import { ErrorNotice, formatDate, Money } from "@/components/ui";
import { api } from "@/lib/api";

const C = "USD";

interface Analytics {
  periodDays: number; gmvMinor: number; orders: number; averageOrderMinor: number; feesMinor: number; takeRatePct: number; buyers: number;
  repeatBuyerPct: number; onTimeShippingPct: number; disputeRatePct: number; medianDisputeResolutionHours: number | null;
  refundRatePct: number; refundsMinor: number; fraudCancellations: number;
}

export function AdminAnalytics() {
  const [days, setDays] = useState(30);
  const [a, setA] = useState<Analytics | null>(null);
  useEffect(() => { api<Analytics>(`/admin/analytics?days=${days}`).then(setA); }, [days]);
  if (!a) return <p className="muted">Loading…</p>;
  const tiles: [string, React.ReactNode, string?][] = [
    ["Gross merchandise value", <Money key="g" minor={a.gmvMinor} currency={C} />],
    ["Orders", a.orders],
    ["Average order", <Money key="a" minor={a.averageOrderMinor} currency={C} />],
    ["Fees earned", <Money key="f" minor={a.feesMinor} currency={C} />],
    ["Take rate", `${a.takeRatePct}%`],
    ["Buyers", a.buyers],
    ["Repeat buyers", `${a.repeatBuyerPct}%`],
    ["Shipped on time", `${a.onTimeShippingPct}%`],
    ["Dispute rate", `${a.disputeRatePct}%`, "Keep under 2%"],
    ["Median dispute resolution", a.medianDisputeResolutionHours != null ? `${a.medianDisputeResolutionHours} h` : "—", "Target under 120 h"],
    ["Refund rate", `${a.refundRatePct}%`],
    ["Fraud cancellations", a.fraudCancellations],
  ];
  return (
    <div className="stack">
      <div className="chips">{[7, 30, 90].map((d) => <button key={d} className={`chip ${d === days ? "active" : ""}`} onClick={() => setDays(d)}>Last {d} days</button>)}</div>
      <div className="grid-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
        {tiles.map(([label, v, hint]) => <div key={label} className="card"><div className="muted small">{label}</div><div style={{ fontSize: 22, fontWeight: 700 }}>{v}</div>{hint && <div className="muted small">{hint}</div>}</div>)}
      </div>
    </div>
  );
}

interface Setting { key: string; label: string; min: number; max: number; value: number }

export function AdminSettings() {
  const [items, setItems] = useState<Setting[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const load = () => api<Setting[]>("/admin/settings").then((s) => { setItems(s); setDrafts(Object.fromEntries(s.map((x) => [x.key, String(x.value)]))); });
  useEffect(() => { load(); }, []);
  if (!items) return <p className="muted">Loading…</p>;
  return (
    <div className="stack" style={{ maxWidth: 680 }}>
      <p className="muted small">Changes apply to new orders and events right away and are recorded in the audit log.</p>
      <ErrorNotice error={error} />
      {saved && <div className="notice ok">{saved}</div>}
      {items.map((s) => (
        <form key={s.key} className="card spread" onSubmit={async (e) => {
          e.preventDefault();
          setError(null); setSaved(null);
          try {
            await api(`/admin/settings/${s.key}`, { method: "PUT", json: { value: Number(drafts[s.key]) } });
            setSaved(`${s.label}: saved`);
            load();
          } catch (err) { setError((err as Error).message); }
        }}>
          <div style={{ flex: 1, minWidth: 220 }}><strong className="small">{s.label}</strong><div className="muted small">Allowed {s.min}–{s.max}</div></div>
          <div className="row">
            <input type="number" min={s.min} max={s.max} value={drafts[s.key] ?? ""} onChange={(e) => setDrafts({ ...drafts, [s.key]: e.target.value })} style={{ width: 130 }} />
            <button type="submit" className="secondary" disabled={drafts[s.key] === String(s.value)}>Save</button>
          </div>
        </form>
      ))}
    </div>
  );
}

interface UserRow { id: string; email: string; name: string | null; roles: string[]; createdAt: string; suspendedAt: string | null }
interface Links { user: { id: string; email: string }; linked: (UserRow & { reasons: string[] })[] }

export function AdminUsers() {
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<UserRow[]>([]);
  const [links, setLinks] = useState<Links | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <form className="row" onSubmit={async (e) => { e.preventDefault(); setLinks(null); try { setUsers(await api<UserRow[]>(`/admin/users?q=${encodeURIComponent(q)}`)); } catch (err) { setError((err as Error).message); } }}>
        <input placeholder="Search by email (3+ characters)" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
        <button type="submit">Search</button>
      </form>
      <ErrorNotice error={error} />
      {users.map((u) => (
        <div key={u.id} className="card spread">
          <div><strong>{u.email}</strong> {u.suspendedAt && <span className="pill danger">Suspended</span>}<div className="muted small">{u.roles.join(", ").toLowerCase()} · joined {formatDate(u.createdAt)}</div></div>
          <button className="secondary" onClick={async () => setLinks(await api<Links>(`/admin/users/${u.id}/links`))}>Linked accounts</button>
        </div>
      ))}
      {links && (
        <div className="card stack">
          <h3>Accounts linked to {links.user.email}</h3>
          <p className="muted small">Accounts sharing an address, device or payout account. Several linked accounts, especially suspended ones, can mean a fraud ring.</p>
          {links.linked.length === 0 ? <p className="small">No linked accounts.</p> : links.linked.map((l) => (
            <div key={l.id} className="spread small">
              <span>{l.email} {l.suspendedAt && <span className="pill danger">Suspended</span>}</span>
              <span>{l.reasons.map((r) => <span key={r} className="pill warn" style={{ marginLeft: 4 }}>{r}</span>)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
