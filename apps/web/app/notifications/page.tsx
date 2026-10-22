"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ErrorNotice, formatDate } from "@/components/ui";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { Notification } from "@/lib/types";

export default function NotificationsPage() {
  const { me, loading } = useSession();
  const [items, setItems] = useState<Notification[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    api<{ items: Notification[] }>("/me/notifications")
      .then(async (n) => {
        setItems(n.items);
        if (n.items.some((i) => !i.readAt)) {
          await api("/me/notifications/read", { method: "POST" });
          window.dispatchEvent(new Event("notifications-read"));
        }
      })
      .catch((e) => setError(e.message));
  }, [me]);

  if (loading) return null;
  if (!me) return <p><Link href="/login?next=/notifications">Log in</Link> to see your notifications.</p>;
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <div className="spread"><h1>Notifications</h1><Link href="/account" className="small">Email preferences</Link></div>
      <ErrorNotice error={error} />
      {items?.length === 0 && <p className="muted">Nothing yet.</p>}
      {items?.map((n) => {
        const body = (
          <div className="card stack" style={{ gap: 4, borderColor: n.readAt ? undefined : "var(--accent)" }}>
            <div className="spread">
              <strong>{n.kind === "security" && "🔒 "}{n.title}</strong>
              <span className="muted small">{formatDate(n.createdAt, true)}</span>
            </div>
            <p className="small" style={{ whiteSpace: "pre-wrap", color: "var(--text)" }}>{n.body}</p>
          </div>
        );
        // Only follow internal links.
        return n.link?.startsWith("/") ? <Link key={n.id} href={n.link} style={{ textDecoration: "none" }}>{body}</Link> : <div key={n.id}>{body}</div>;
      })}
    </div>
  );
}
