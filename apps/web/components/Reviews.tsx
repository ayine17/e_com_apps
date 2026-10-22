"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Review } from "@/lib/types";
import { Stars } from "./Stars";
import { formatDate } from "./ui";

interface ReviewPage { average: number | null; total: number; counts: Record<string, number>; page: number; items: Review[] }

export function Reviews({ productId }: { productId: string }) {
  const [data, setData] = useState<ReviewPage | null>(null);
  const [page, setPage] = useState(1);
  useEffect(() => {
    api<ReviewPage>(`/products/${productId}/reviews?page=${page}`).then(setData).catch(() => {});
  }, [productId, page]);
  if (!data) return null;
  return (
    <section className="stack">
      <h2>Reviews</h2>
      {data.total === 0 ? (
        <p className="muted">No reviews yet. Only buyers who received this item can review it.</p>
      ) : (
        <>
          <div className="card row" style={{ gap: 24, alignItems: "flex-start" }}>
            <div>
              <div style={{ fontSize: 32, fontWeight: 700 }}>{data.average}</div>
              <Stars value={data.average ?? 0} />
              <div className="muted small">{data.total} review{data.total === 1 ? "" : "s"}</div>
            </div>
            <div style={{ flex: 1, minWidth: 200 }}>
              {[5, 4, 3, 2, 1].map((r) => {
                const n = data.counts[r] ?? 0;
                return (
                  <div key={r} className="row small" style={{ gap: 8 }}>
                    <span style={{ width: 14 }}>{r}</span>
                    <div style={{ flex: 1, height: 8, background: "var(--surface-2)", borderRadius: 4, overflow: "hidden" }}>
                      <div style={{ width: `${(n / data.total) * 100}%`, height: "100%", background: "#e0951b" }} />
                    </div>
                    <span className="muted" style={{ width: 24 }}>{n}</span>
                  </div>
                );
              })}
            </div>
          </div>
          {data.items.map((r) => (
            <div key={r.id} className="card stack" style={{ gap: 6 }}>
              <div className="spread"><Stars value={r.rating} /><span className="muted small">{r.author?.name} · verified purchase · {formatDate(r.createdAt)}</span></div>
              {r.body && <p style={{ whiteSpace: "pre-wrap" }}>{r.body}</p>}
              {r.sellerReply && <div className="notice info small"><strong>Seller reply:</strong> {r.sellerReply}</div>}
            </div>
          ))}
          {data.total > 10 && (
            <div className="row">
              <button className="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Newer</button>
              <button className="secondary" disabled={page * 10 >= data.total} onClick={() => setPage(page + 1)}>Older</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
