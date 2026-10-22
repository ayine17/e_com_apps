"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ErrorNotice, formatDate, Money, StateBadge } from "@/components/ui";
import { api } from "@/lib/api";
import type { Order } from "@/lib/types";

function Orders() {
  const placed = useSearchParams().get("placed");
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Order[]>("/orders").then(setOrders).catch((e) => setError(e.message));
  }, []);
  return (
    <div className="stack">
      <h1>Your orders</h1>
      {placed && <div className="notice ok">Order placed. Your payment is held in escrow until delivery.</div>}
      <ErrorNotice error={error} />
      {orders?.length === 0 && <p className="muted">No orders yet.</p>}
      {orders?.map((o) => (
        <Link key={o.id} href={`/orders/${o.id}`} className="card spread" style={{ color: "var(--text)" }}>
          <div>
            <div className="row"><strong>{o.store?.name}</strong><StateBadge state={o.state} /></div>
            <div className="muted small">{o.items.map((i) => `${i.quantity} × ${i.title}`).join(", ")}</div>
            <div className="muted small">Ordered {formatDate(o.createdAt)} · #{o.id.slice(0, 8)}</div>
          </div>
          <strong><Money minor={o.totalMinor} currency={o.currency} /></strong>
        </Link>
      ))}
    </div>
  );
}

export default function Page() {
  return <Suspense><Orders /></Suspense>;
}
