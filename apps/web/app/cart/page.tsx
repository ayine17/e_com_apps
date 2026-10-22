"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { ShippingQuote } from "@market/shared";
import { AddressForm } from "@/components/AddressForm";
import { ErrorNotice, Money } from "@/components/ui";
import { api } from "@/lib/api";
import { useCart } from "@/lib/cart";
import { useSession } from "@/lib/session";
import type { Address } from "@/lib/types";

interface QuoteResponse {
  currency: string;
  stores: { storeId: string; storeName: string; subtotalMinor: number; discountMinor: number; couponCode: string | null; couponError: string | null; freeShipping: boolean; freeShippingOverMinor: number | null; options: ShippingQuote[]; items: { productId: string; title: string; quantity: number; unitPriceMinor: number }[] }[];
}

export default function CartPage() {
  const { me, loading } = useSession();
  const { lines, setQuantity, clear } = useCart();
  const router = useRouter();
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [addressId, setAddressId] = useState("");
  const [addingAddress, setAddingAddress] = useState(false);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [shipping, setShipping] = useState<Record<string, string>>({});
  const [testCard, setTestCard] = useState("success");
  const [coupons, setCoupons] = useState<Record<string, string>>({});
  const [codeDrafts, setCodeDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);

  useEffect(() => {
    if (!me) return;
    api<Address[]>("/addresses").then((a) => { setAddresses(a); if (a[0]) setAddressId((id) => id || a[0].id); });
  }, [me]);

  const items = useMemo(() => lines.map((l) => ({ productId: l.productId, quantity: l.quantity })), [lines]);

  useEffect(() => {
    if (!me || !addressId || !items.length) return setQuote(null);
    setError(null);
    api<QuoteResponse>("/shipping/quotes", { method: "POST", json: { items, addressId, coupons } })
      .then((q) => {
        setQuote(q);
        setShipping((prev) => Object.fromEntries(q.stores.map((s) => [s.storeId, prev[s.storeId] ?? s.options[0].service])));
      })
      .catch((e) => { setQuote(null); setError(e.message); });
  }, [me, addressId, items, coupons]);

  const total = quote?.stores.reduce((sum, s) => sum + s.subtotalMinor - s.discountMinor + (s.options.find((o) => o.service === shipping[s.storeId])?.amountMinor ?? 0), 0) ?? 0;

  async function placeOrder() {
    setPlacing(true);
    setError(null);
    try {
      const res = await api<{ orderIds: string[]; onHold: boolean }>("/checkout", { method: "POST", json: { items, addressId, shipping, testCard, coupons } });
      clear();
      router.push(res.orderIds.length === 1 ? `/orders/${res.orderIds[0]}?placed=1` : "/orders?placed=1");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPlacing(false);
    }
  }

  if (!lines.length) return <div className="card"><h1>Your cart is empty</h1><Link href="/">Start shopping</Link></div>;

  return (
    <div className="grid-2" style={{ alignItems: "start" }}>
      <div className="stack">
        <h1>Cart</h1>
        {lines.map((l) => (
          <div key={l.productId} className="card spread">
            <div className="row">
              <div style={{ width: 56, height: 56, borderRadius: 6, overflow: "hidden", background: "var(--surface-2)", display: "grid", placeItems: "center" }}>
                {l.image ? <img src={l.image} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : "📦"}
              </div>
              <div>
                <Link href={`/products/${l.productId}`}>{l.title}</Link>
                <div className="muted small"><Money minor={l.priceMinor} currency={l.currency} /> each</div>
              </div>
            </div>
            <div className="row">
              <select value={l.quantity} onChange={(e) => setQuantity(l.productId, Number(e.target.value))} style={{ width: 72 }} aria-label="Quantity">
                {Array.from({ length: 10 }, (_, i) => <option key={i + 1}>{i + 1}</option>)}
              </select>
              <button className="link small" onClick={() => setQuantity(l.productId, 0)}>Remove</button>
            </div>
          </div>
        ))}
      </div>

      <div className="card stack">
        <h2>Checkout</h2>
        {loading ? null : !me ? (
          <p><Link href="/login?next=/cart">Log in</Link> to see delivery options and check out.</p>
        ) : (
          <>
            <div>
              <label>Deliver to</label>
              {addresses.length > 0 && (
                <select value={addressId} onChange={(e) => setAddressId(e.target.value)}>
                  {addresses.map((a) => <option key={a.id} value={a.id}>{a.label ? `${a.label}: ` : ""}{a.line1}, {a.city}</option>)}
                </select>
              )}
              {!addingAddress ? (
                <button className="link small" style={{ marginTop: 6 }} onClick={() => setAddingAddress(true)}>+ Add a new address</button>
              ) : (
                <div style={{ marginTop: 10 }}>
                  <AddressForm onSaved={(a) => { setAddresses([a, ...addresses]); setAddressId(a.id); setAddingAddress(false); }} />
                </div>
              )}
            </div>
            {quote?.stores.map((s) => (
              <div key={s.storeId} className="stack" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                <div className="spread"><strong>From {s.storeName}</strong><Money minor={s.subtotalMinor} currency={quote.currency} /></div>
                {s.discountMinor > 0 && <div className="spread small" style={{ color: "var(--ok)" }}><span>Code {s.couponCode}</span><span>−<Money minor={s.discountMinor} currency={quote.currency} /></span></div>}
                {s.freeShipping ? <div className="notice ok small">Free standard delivery from this seller</div>
                  : s.freeShippingOverMinor != null && <div className="muted small">Spend <Money minor={s.freeShippingOverMinor - (s.subtotalMinor - s.discountMinor)} currency={quote.currency} /> more for free delivery</div>}
                {s.options.map((o) => (
                  <label key={o.service} className="row" style={{ color: "var(--text)", fontSize: 14, cursor: "pointer" }}>
                    <input type="radio" name={`ship-${s.storeId}`} style={{ width: "auto" }} checked={shipping[s.storeId] === o.service} onChange={() => setShipping({ ...shipping, [s.storeId]: o.service })} />
                    <span style={{ flex: 1 }}>{o.label} · {o.minDays}–{o.maxDays} days <span className="muted small">({o.distanceKm} km)</span></span>
                    {o.amountMinor === 0 ? <strong>Free</strong> : <Money minor={o.amountMinor} currency={quote.currency} />}
                  </label>
                ))}
                <form className="row" onSubmit={(e) => { e.preventDefault(); const code = (codeDrafts[s.storeId] ?? "").trim(); setCoupons((c) => { const n = { ...c }; if (code) n[s.storeId] = code.toUpperCase(); else delete n[s.storeId]; return n; }); }}>
                  <input placeholder="Seller coupon code" value={codeDrafts[s.storeId] ?? ""} onChange={(e) => setCodeDrafts({ ...codeDrafts, [s.storeId]: e.target.value })} style={{ flex: 1 }} aria-label={`Coupon code for ${s.storeName}`} />
                  <button type="submit" className="secondary">Apply</button>
                </form>
                {s.couponError && <div className="notice error small">{s.couponError} <button className="link small" onClick={() => setCoupons((c) => { const n = { ...c }; delete n[s.storeId]; return n; })}>Remove code</button></div>}
              </div>
            ))}
            {quote && (
              <>
                <div className="spread" style={{ borderTop: "1px solid var(--border)", paddingTop: 12, fontSize: 18 }}>
                  <strong>Total</strong><strong><Money minor={total} currency={quote.currency} /></strong>
                </div>
                {process.env.NODE_ENV !== "production" && (
                  <div>
                    <label>Test payment (development only)</label>
                    <select value={testCard} onChange={(e) => setTestCard(e.target.value)}>
                      <option value="success">Card succeeds</option>
                      <option value="decline">Card is declined</option>
                      <option value="elevated_risk">Provider flags elevated fraud risk</option>
                    </select>
                  </div>
                )}
                <p className="muted small">You&apos;ll be charged now. The money is held in escrow and only released to each seller after delivery.</p>
              </>
            )}
            <ErrorNotice error={error} />
            <button disabled={!quote || placing} onClick={placeOrder}>{placing ? "Placing order…" : "Pay and place order"}</button>
          </>
        )}
      </div>
    </div>
  );
}
