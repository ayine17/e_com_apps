"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ProductGrid } from "@/components/ui";
import { api } from "@/lib/api";
import { currentPosition } from "@/lib/geo";
import type { Category, Product } from "@/lib/types";

interface Results { total: number; page: number; pageSize: number; items: Product[] }

function SearchPage() {
  const params = useSearchParams();
  const router = useRouter();
  const [categories, setCategories] = useState<Category[]>([]);
  const [results, setResults] = useState<Results | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Category[]>("/categories").then(setCategories).catch(() => {});
  }, []);
  useEffect(() => {
    setResults(null);
    api<Results>(`/products?${params.toString()}`).then(setResults).catch((e) => setError(e.message));
  }, [params]);

  function update(changes: Record<string, string | undefined>) {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) v ? next.set(k, v) : next.delete(k);
    if (!("page" in changes)) next.delete("page");
    router.push(`/search?${next.toString()}`);
  }

  const page = Number(params.get("page") ?? 1);
  return (
    <div className="stack">
      <h1>{params.get("q") ? `Results for “${params.get("q")}”` : "Browse"}</h1>
      <div className="card row">
        <div style={{ minWidth: 160 }}>
          <label>Category</label>
          <select value={params.get("category") ?? ""} onChange={(e) => update({ category: e.target.value })}>
            <option value="">All</option>
            {categories.map((c) => <option key={c.id} value={c.slug}>{c.name}</option>)}
          </select>
        </div>
        <div style={{ width: 110 }}>
          <label>Min price</label>
          <input inputMode="decimal" defaultValue={params.get("minPrice") ? Number(params.get("minPrice")) / 100 : ""} onBlur={(e) => update({ minPrice: e.target.value ? String(Math.round(Number(e.target.value) * 100)) : undefined })} />
        </div>
        <div style={{ width: 110 }}>
          <label>Max price</label>
          <input inputMode="decimal" defaultValue={params.get("maxPrice") ? Number(params.get("maxPrice")) / 100 : ""} onBlur={(e) => update({ maxPrice: e.target.value ? String(Math.round(Number(e.target.value) * 100)) : undefined })} />
        </div>
        <div style={{ width: 120 }}>
          <label>Condition</label>
          <select value={params.get("condition") ?? ""} onChange={(e) => update({ condition: e.target.value })}>
            <option value="">Any</option><option value="NEW">New</option><option value="USED">Used</option>
          </select>
        </div>
        <div style={{ minWidth: 150 }}>
          <label>Sort</label>
          <select value={params.get("sort") ?? "relevance"} onChange={(e) => update({ sort: e.target.value })}>
            <option value="relevance">Best match</option><option value="price_asc">Price: low to high</option>
            <option value="price_desc">Price: high to low</option><option value="newest">Newest</option>
            <option value="nearest" disabled={!params.get("lat")}>Nearest</option>
          </select>
        </div>
        <div style={{ minWidth: 150 }}>
          <label>Distance</label>
          {params.get("lat") ? (
            <select value={params.get("maxKm") ?? ""} onChange={(e) => update({ maxKm: e.target.value })}>
              <option value="">Any distance</option><option value="10">Within 10 km</option><option value="50">Within 50 km</option>
              <option value="200">Within 200 km</option><option value="1000">Within 1000 km</option>
            </select>
          ) : (
            <button className="secondary" onClick={async () => { const p = await currentPosition(); if (p) update({ lat: String(p.lat), lng: String(p.lng) }); }}>Use my location</button>
          )}
        </div>
      </div>
      {error && <div className="notice error">{error}</div>}
      {!results ? <p className="muted">Searching…</p> : (
        <>
          <p className="muted small">{results.total} result{results.total === 1 ? "" : "s"}</p>
          <ProductGrid products={results.items} empty="No products match. Try fewer filters." />
          {results.total > results.pageSize && (
            <div className="row">
              <button className="secondary" disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}>Previous</button>
              <span className="muted small">Page {page} of {Math.ceil(results.total / results.pageSize)}</span>
              <button className="secondary" disabled={page * results.pageSize >= results.total} onClick={() => update({ page: String(page + 1) })}>Next</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function Page() {
  return <Suspense><SearchPage /></Suspense>;
}
