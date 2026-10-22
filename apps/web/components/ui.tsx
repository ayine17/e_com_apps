"use client";

import Link from "next/link";
import { formatMoney, type OrderState } from "@market/shared";
import type { Product } from "@/lib/types";

export function Money({ minor, currency }: { minor: number; currency: string }) {
  return <>{formatMoney(minor, currency)}</>;
}

export function ProductCard({ p }: { p: Product }) {
  return (
    <Link href={`/products/${p.id}`} className="product-card">
      <div className="thumb">{p.images[0] ? <img src={p.images[0]} alt="" loading="lazy" /> : "📦"}</div>
      <div className="body">
        <span className="title">{p.title}</span>
        <span className="price">
          <Money minor={p.priceMinor} currency={p.currency} />
        </span>
        {p.store && (
          <span className="muted small">
            {p.store.city}
            {p.distanceKm != null && ` · ${p.distanceKm} km`}
          </span>
        )}
      </div>
    </Link>
  );
}

export function ProductGrid({ products, empty = "Nothing here yet." }: { products: Product[]; empty?: string }) {
  if (!products.length) return <p className="muted">{empty}</p>;
  return (
    <div className="products">
      {products.map((p) => (
        <ProductCard key={p.id} p={p} />
      ))}
    </div>
  );
}

const STATE_LABEL: Record<OrderState, [string, string]> = {
  PENDING_PAYMENT: ["Awaiting payment", ""],
  PAID: ["Paid · awaiting shipment", "info"],
  SHIPPED: ["Shipped", "info"],
  DELIVERED: ["Delivered", "ok"],
  RETURN_REQUESTED: ["Return requested", "warn"],
  DISPUTED: ["In dispute", "warn"],
  COMPLETED: ["Completed", "ok"],
  REFUNDED: ["Refunded", ""],
  PARTIALLY_REFUNDED: ["Partially refunded", ""],
  CANCELLED: ["Cancelled", "danger"],
};

export function StateBadge({ state }: { state: OrderState }) {
  const [label, tone] = STATE_LABEL[state];
  return <span className={`pill ${tone}`}>{label}</span>;
}

export function ErrorNotice({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="notice error" role="alert">
      {error}
    </div>
  );
}

export function formatDate(iso: string | null | undefined, withTime = false) {
  if (!iso) return "";
  const d = new Date(iso);
  return withTime ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : d.toLocaleDateString(undefined, { dateStyle: "medium" });
}

/** Parses a decimal money string like "12.50" into minor units. */
export function toMinor(value: string): number {
  return Math.round(parseFloat(value || "0") * 100);
}
