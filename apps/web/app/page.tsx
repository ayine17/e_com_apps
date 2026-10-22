"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ProductGrid } from "@/components/ui";
import { api } from "@/lib/api";
import { currentPosition } from "@/lib/geo";
import type { Category, Product } from "@/lib/types";

export default function Home() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [trending, setTrending] = useState<Product[] | null>(null);
  const [nearMe, setNearMe] = useState(false);

  useEffect(() => {
    api<Category[]>("/categories").then(setCategories).catch(() => {});
    api<Product[]>("/products/trending").then(setTrending).catch(() => setTrending([]));
  }, []);

  async function useLocation() {
    const pos = await currentPosition();
    if (!pos) return;
    setNearMe(true);
    setTrending(await api<Product[]>(`/products/trending?lat=${pos.lat}&lng=${pos.lng}`));
  }

  return (
    <div className="stack">
      <section className="card" style={{ padding: 28 }}>
        <h1>Buy and sell with confidence</h1>
        <p className="muted" style={{ maxWidth: 640 }}>
          Your payment is held in escrow and only released to the seller after you receive your order. If something goes wrong, our
          resolution team steps in.
        </p>
        <div className="row small muted">
          <span>✓ Verified sellers</span>
          <span>✓ Tracked delivery with handover code</span>
          <span>✓ Refund if it doesn&apos;t arrive</span>
        </div>
      </section>

      <section>
        <h2>Categories</h2>
        <div className="chips">
          {categories.map((c) => (
            <Link key={c.id} className="chip" href={`/search?category=${c.slug}`}>
              {c.name}
            </Link>
          ))}
        </div>
      </section>

      <section>
        <div className="spread">
          <h2>{nearMe ? "Trending near you" : "Trending now"}</h2>
          {!nearMe && (
            <button className="link" onClick={useLocation}>
              Show items near me
            </button>
          )}
        </div>
        {trending === null ? <p className="muted">Loading…</p> : <ProductGrid products={trending} empty="No products yet. Be the first to sell!" />}
      </section>
    </div>
  );
}
