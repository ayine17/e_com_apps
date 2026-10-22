"use client";

import { useEffect, useState } from "react";
import { formatDate } from "@/components/ui";
import { api } from "@/lib/api";

interface Email { id: string; to: string; subject: string; body: string; createdAt: string }

/** Development only: shows emails the app would have sent (login codes, notifications). */
export default function Inbox() {
  const [emails, setEmails] = useState<Email[]>([]);
  const [to, setTo] = useState("");
  useEffect(() => {
    const load = () => api<Email[]>(`/dev/emails${to ? `?to=${encodeURIComponent(to)}` : ""}`).then(setEmails).catch(() => setEmails([]));
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [to]);
  return (
    <div className="stack">
      <h1>Development inbox</h1>
      <p className="muted">Emails are stored here instead of being sent. This page doesn&apos;t exist in production.</p>
      <input placeholder="Filter by recipient" value={to} onChange={(e) => setTo(e.target.value)} style={{ maxWidth: 320 }} />
      {emails.map((e) => (
        <div key={e.id} className="card">
          <div className="spread"><strong>{e.subject}</strong><span className="muted small">{e.to} · {formatDate(e.createdAt, true)}</span></div>
          <p className="small" style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>{e.body}</p>
        </div>
      ))}
    </div>
  );
}
