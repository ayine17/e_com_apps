"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AddressForm } from "@/components/AddressForm";
import { ErrorNotice, formatDate } from "@/components/ui";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { Address } from "@/lib/types";

interface Device { id: string; userAgent: string; firstSeen: string; lastSeen: string }

/** Shortens a user-agent string to "Browser on OS". */
function describeDevice(ua: string) {
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "unknown system";
  return `${browser} on ${os}`;
}

export default function AccountPage() {
  const { me, loading, refresh } = useSession();
  const router = useRouter();
  const [name, setName] = useState("");
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [prefs, setPrefs] = useState({ orders: true, alerts: true });
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    setName(me.name ?? "");
    if (me.emailPrefs) setPrefs(me.emailPrefs);
    api<Address[]>("/addresses").then(setAddresses);
    api<Device[]>("/me/devices").then(setDevices);
  }, [me]);

  if (loading) return null;
  if (!me) return <p><Link href="/login?next=/account">Log in</Link> to manage your account.</p>;

  async function run(fn: () => Promise<void>, msg: string) {
    setError(null);
    try {
      await fn();
      setSaved(msg);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <h1>Account</h1>
      <ErrorNotice error={error} />
      {saved && <div className="notice ok">{saved}</div>}

      <form className="card stack" onSubmit={(e) => { e.preventDefault(); run(async () => { await api("/me", { method: "PATCH", json: { name } }); await refresh(); }, "Name saved"); }}>
        <div className="muted small">{me.email}</div>
        <div><label>Display name</label><input required value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div><button type="submit">Save</button></div>
      </form>

      <div className="card stack">
        <h2>Addresses</h2>
        {addresses.map((a) => (
          <div key={a.id} className="spread">
            <span>{a.label && <strong>{a.label}: </strong>}{a.line1}, {a.city}, {a.country}</span>
            <button className="link small" onClick={async () => { await api(`/addresses/${a.id}`, { method: "DELETE" }); setAddresses(addresses.filter((x) => x.id !== a.id)); }}>Remove</button>
          </div>
        ))}
        <hr />
        <h3>Add an address</h3>
        <AddressForm onSaved={(a) => setAddresses([a, ...addresses])} />
      </div>

      <div className="card stack">
        <h2>Email notifications</h2>
        <p className="muted small">You&apos;ll always see notifications in the app, and we always email security alerts.</p>
        {([["orders", "Orders, payments and disputes"], ["alerts", "Price drops and back-in-stock alerts"]] as const).map(([k, label]) => (
          <label key={k} className="row" style={{ color: "var(--text)", fontSize: 15 }}>
            <input type="checkbox" style={{ width: "auto" }} checked={prefs[k]} onChange={(e) => {
              const next = { ...prefs, [k]: e.target.checked };
              setPrefs(next);
              run(() => api("/me/notification-prefs", { method: "PATCH", json: next }), "Email preferences saved");
            }} />
            {label}
          </label>
        ))}
      </div>

      <div className="card stack">
        <h2>Devices</h2>
        <p className="muted small">Devices that have logged in to your account. We email you when a new one does. If you don&apos;t recognise one, contact support.</p>
        {devices.map((d) => (
          <div key={d.id} className="spread small">
            <span>{describeDevice(d.userAgent)}<br /><span className="muted">First seen {formatDate(d.firstSeen)} · last used {formatDate(d.lastSeen, true)}</span></span>
            <button className="link small" onClick={async () => { await api(`/me/devices/${d.id}`, { method: "DELETE" }); setDevices(devices.filter((x) => x.id !== d.id)); }}>Forget</button>
          </div>
        ))}
      </div>

      <div className="card stack">
        <h2>Your data</h2>
        <p className="muted small">Download a copy of everything we hold about you, or delete your account.</p>
        <div className="row">
          <a className="button secondary" href="/api/me/export" download>Download my data</a>
          <button className="danger" onClick={() => {
            if (!window.confirm("Delete your account? Your personal details are removed for good. Past order records are kept without your details, as the law requires.")) return;
            run(async () => {
              await api("/me", { method: "DELETE" });
              await refresh();
              router.push("/");
            }, "Account deleted");
          }}>Delete my account</button>
        </div>
      </div>
    </div>
  );
}
