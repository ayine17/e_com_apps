"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { ErrorNotice } from "@/components/ui";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";

function Login() {
  const router = useRouter();
  const next = useSearchParams().get("next");
  const { refresh } = useSession();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 420, margin: "40px auto" }}>
      <h1>Log in or sign up</h1>
      {!sent ? (
        <form onSubmit={(e) => { e.preventDefault(); run(async () => { await api("/auth/otp", { method: "POST", json: { email } }); setSent(true); }); }}>
          <p className="muted">We&apos;ll email you a 6-digit code. No password needed.</p>
          <div className="field"><label>Email</label><input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <ErrorNotice error={error} />
          <button type="submit" disabled={busy} style={{ width: "100%", marginTop: 8 }}>Email me a code</button>
        </form>
      ) : (
        <form onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            await api("/auth/verify", { method: "POST", json: { email, code } });
            await refresh();
            // Only follow same-site relative paths, never an external URL.
            router.push(next?.startsWith("/") && !next.startsWith("//") ? next : "/");
          });
        }}>
          <p className="muted">Enter the code we sent to <strong>{email}</strong>.</p>
          {process.env.NODE_ENV !== "production" && <p className="small"><a href="/dev/inbox" target="_blank">Open the development inbox</a> to read the code.</p>}
          <div className="field"><label>Code</label><input required inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} /></div>
          <ErrorNotice error={error} />
          <button type="submit" disabled={busy} style={{ width: "100%", marginTop: 8 }}>Log in</button>
          <button type="button" className="link small" style={{ marginTop: 12 }} onClick={() => { setSent(false); setCode(""); }}>Use a different email</button>
        </form>
      )}
    </div>
  );
}

export default function Page() {
  return <Suspense><Login /></Suspense>;
}
