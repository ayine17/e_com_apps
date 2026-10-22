"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ReportButton } from "@/components/ReportButton";
import { Reviews } from "@/components/Reviews";
import { Stars } from "@/components/Stars";
import { WishlistButton } from "@/components/WishlistButton";
import { ErrorNotice, Money, ProductGrid } from "@/components/ui";
import { api } from "@/lib/api";
import { useCart } from "@/lib/cart";
import { useSession } from "@/lib/session";
import type { Category, Product, Rating, StoreStats } from "@/lib/types";

type Detail = Product & { category: Category; storeStats: StoreStats; rating: Rating };
interface Recs { similar: Product[]; boughtTogether: Product[]; moreFromSeller: Product[] }

export default function ProductPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { me } = useSession();
  const { add } = useCart();
  const [p, setP] = useState<Detail | null>(null);
  const [recs, setRecs] = useState<Recs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [image, setImage] = useState(0);
  const [added, setAdded] = useState(false);
  const [savedIds, setSavedIds] = useState<string[] | null>(null);

  useEffect(() => {
    api<Detail>(`/products/${id}`).then(setP).catch((e) => setError(e.message));
    api<Recs>(`/products/${id}/recommendations`).then(setRecs).catch(() => {});
  }, [id]);
  useEffect(() => {
    if (me) api<string[]>("/me/wishlist/ids").then(setSavedIds).catch(() => setSavedIds([]));
    else setSavedIds([]);
  }, [me]);

  if (error) return <ErrorNotice error={error} />;
  if (!p) return <p className="muted">Loading…</p>;
  const isOwn = me && p.store?.ownerId === me.id;
  const stats = p.storeStats;

  return (
    <div className="stack">
      <div className="grid-2">
        <div className="gallery">
          <div className="main">{p.images[image] ? <img src={p.images[image]} alt={p.title} /> : "📦"}</div>
          {p.images.length > 1 && (
            <div className="thumbs">
              {p.images.map((src, i) => (
                <button key={src} className={i === image ? "active" : ""} onClick={() => setImage(i)} aria-label={`Image ${i + 1}`}><img src={src} alt="" /></button>
              ))}
            </div>
          )}
        </div>
        <div className="stack">
          <div>
            <Link href={`/search?category=${p.category.slug}`} className="small">{p.category.name}</Link>
            <h1>{p.title}</h1>
            <div className="price" style={{ fontSize: 24 }}><Money minor={p.priceMinor} currency={p.currency} /></div>
            {p.rating.count > 0 && <a href="#reviews" className="row small" style={{ gap: 6 }}><Stars value={p.rating.average ?? 0} /> <span>{p.rating.average} ({p.rating.count})</span></a>}
            <div className="row small muted">
              <span className="pill">{p.condition === "NEW" ? "New" : "Used"}</span>
              <span>{p.stock > 0 ? `${p.stock} available` : "Sold out"}</span>
            </div>
          </div>
          {p.status !== "ACTIVE" && <div className="notice warn">This listing is {p.status === "PENDING_REVIEW" ? "waiting for review" : "removed"} and isn&apos;t visible to buyers.</div>}
          {isOwn ? (
            <Link className="button secondary" href="/sell">Manage this listing</Link>
          ) : p.stock > 0 && (
            <div className="row">
              <select value={qty} onChange={(e) => setQty(Number(e.target.value))} style={{ width: 80 }} aria-label="Quantity">
                {Array.from({ length: Math.min(10, p.stock) }, (_, i) => <option key={i + 1}>{i + 1}</option>)}
              </select>
              <button onClick={() => { add({ productId: p.id, quantity: qty, title: p.title, priceMinor: p.priceMinor, currency: p.currency, storeId: p.storeId, image: p.images[0] }); setAdded(true); }}>Add to cart</button>
              {added && <button className="secondary" onClick={() => router.push("/cart")}>Go to cart</button>}
            </div>
          )}
          {!isOwn && savedIds && <div><WishlistButton productId={p.id} initiallySaved={savedIds.includes(p.id)} /></div>}
          <div className="notice info small">
            <strong>Buyer protection.</strong> Your payment is held in escrow and released to the seller only after you confirm delivery,
            or automatically 7 days after delivery if you don&apos;t report a problem.
          </div>
          <div className="card">
            <div className="spread">
              <div>
                <Link href={`/stores/${p.store?.slug}`}><strong>{p.store?.name}</strong></Link> <span className="pill ok">Verified</span>
                <div className="muted small">{p.store?.city}, {p.store?.country}</div>
              </div>
            </div>
            <div className="row small muted" style={{ marginTop: 8 }}>
              {stats.rating?.count ? <span>★ {stats.rating.average} seller rating ({stats.rating.count})</span> : null}
              <span>{stats.completedOrders} completed orders</span>
              {stats.onTimeShippingRate != null && <span>{stats.onTimeShippingRate}% shipped on time</span>}
              <span>{stats.disputeRate}% disputes</span>
              <span>{p.store?.returnPolicyDays ? `${p.store.returnPolicyDays}-day returns` : "No change-of-mind returns"}</span>
            </div>
          </div>
          <div>
            <h3>Description</h3>
            <p style={{ whiteSpace: "pre-wrap" }}>{p.description}</p>
            <p className="muted small">Package: {p.weightGrams / 1000} kg · {p.lengthCm} × {p.widthCm} × {p.heightCm} cm</p>
          </div>
          {me && !isOwn && <ReportButton targetType="PRODUCT" targetId={p.id} label="Report this listing" />}
        </div>
      </div>
      <div id="reviews"><Reviews productId={p.id} /></div>
      {recs && recs.boughtTogether.length > 0 && <section><h2>Frequently bought together</h2><ProductGrid products={recs.boughtTogether} /></section>}
      {recs && recs.similar.length > 0 && <section><h2>Similar items</h2><ProductGrid products={recs.similar} /></section>}
      {recs && recs.moreFromSeller.length > 0 && <section><h2>More from {p.store?.name}</h2><ProductGrid products={recs.moreFromSeller} /></section>}
    </div>
  );
}
