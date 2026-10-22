"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ReportButton } from "@/components/ReportButton";
import { ErrorNotice, formatDate, ProductGrid } from "@/components/ui";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { Product, StoreStats } from "@/lib/types";

interface PublicStore { id: string; name: string; description: string | null; city: string; country: string; returnPolicyDays: number; createdAt: string; ownerId: string; products: Product[]; stats: StoreStats }

export default function StorePage() {
  const { slug } = useParams<{ slug: string }>();
  const { me } = useSession();
  const [store, setStore] = useState<PublicStore | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<PublicStore>(`/stores/${slug}`).then(setStore).catch((e) => setError(e.message)); }, [slug]);
  if (error) return <ErrorNotice error={error} />;
  if (!store) return <p className="muted">Loading…</p>;
  return (
    <div className="stack">
      <div className="card">
        <div className="spread"><h1>{store.name} <span className="pill ok">Verified</span></h1>{me && me.id !== store.ownerId && <ReportButton targetType="USER" targetId={store.ownerId} label="Report seller" />}</div>
        {store.description && <p>{store.description}</p>}
        <div className="row small muted">
          <span>{store.city}, {store.country}</span><span>Selling since {formatDate(store.createdAt)}</span>
          <span>{store.stats.completedOrders} completed orders</span>
          {store.stats.onTimeShippingRate != null && <span>{store.stats.onTimeShippingRate}% shipped on time</span>}
          <span>{store.returnPolicyDays ? `${store.returnPolicyDays}-day returns` : "No change-of-mind returns"}</span>
        </div>
      </div>
      <ProductGrid products={store.products} empty="No listings right now." />
    </div>
  );
}
