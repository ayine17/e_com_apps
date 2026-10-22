"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ErrorNotice, Money, ProductCard } from "@/components/ui";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { Product } from "@/lib/types";

interface Saved { productId: string; priceAtSave: number; createdAt: string; product: Product }

export default function WishlistPage() {
  const { me, loading } = useSession();
  const [items, setItems] = useState<Saved[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (me) api<Saved[]>("/me/wishlist").then(setItems).catch((e) => setError(e.message));
  }, [me]);

  if (loading) return null;
  if (!me) return <p><Link href="/login?next=/wishlist">Log in</Link> to see your saved items.</p>;
  return (
    <div className="stack">
      <h1>Saved items</h1>
      <p className="muted">We&apos;ll let you know when a saved item drops in price or comes back in stock.</p>
      <ErrorNotice error={error} />
      {items?.length === 0 && <p className="muted">Nothing saved yet. Tap ♡ Save on any product.</p>}
      <div className="products">
        {items?.map((i) => (
          <div key={i.productId} className="stack" style={{ gap: 6 }}>
            <ProductCard p={i.product} />
            <div className="row small" style={{ justifyContent: "space-between" }}>
              {i.product.status !== "ACTIVE" || i.product.stock === 0 ? <span className="pill">Unavailable</span>
                : i.product.priceMinor < i.priceAtSave ? <span className="pill ok">Price dropped from <Money minor={i.priceAtSave} currency={i.product.currency} /></span> : <span />}
              <button className="link small" onClick={async () => {
                await api(`/me/wishlist/${i.productId}`, { method: "DELETE" });
                setItems(items!.filter((x) => x.productId !== i.productId));
              }}>Remove</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
