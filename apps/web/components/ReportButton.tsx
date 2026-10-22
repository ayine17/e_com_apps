"use client";

import { useState } from "react";
import { api } from "@/lib/api";

export function ReportButton({ targetType, targetId, label = "Report" }: { targetType: "PRODUCT" | "USER" | "MESSAGE"; targetId: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (done) return <span className="muted small">Thanks, our team will review it.</span>;
  if (!open) return <button className="link small" onClick={() => setOpen(true)}>{label}</button>;
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api("/reports", { method: "POST", json: { targetType, targetId, reason } });
          setDone(true);
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <textarea required minLength={3} maxLength={1000} placeholder="What's wrong?" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
      {error && <div className="notice error">{error}</div>}
      <div className="row">
        <button type="submit">Send report</button>
        <button type="button" className="secondary" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}
