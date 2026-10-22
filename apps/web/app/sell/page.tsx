"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AddressForm } from "@/components/AddressForm";
import { ImageUploader } from "@/components/ImageUploader";
import { ErrorNotice, formatDate, Money, StateBadge, toMinor } from "@/components/ui";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { SellerAnalytics, SellerCoupons, SellerPayouts, SellerReviews, SellerSettings } from "./tools";
import type { Address, Category, Order, Product } from "@/lib/types";

interface MyStore { id: string; name: string; slug: string; verificationStatus: "PENDING" | "VERIFIED" | "REJECTED"; returnPolicyDays: number; freeShippingOverMinor: number | null; balance: { availableMinor: number; inEscrowMinor: number } }

export default function SellPage() {
  const { me, loading } = useSession();
  const [store, setStore] = useState<MyStore | null | undefined>(undefined);
  const [tab, setTab] = useState<"orders" | "listings" | "new" | "analytics" | "payouts" | "coupons" | "reviews" | "settings">("orders");
  const [editing, setEditing] = useState<Product | null>(null);

  const load = useCallback(() => api<MyStore | null>("/stores/me").then(setStore), []);
  useEffect(() => { if (me) load(); }, [me, load]);

  if (loading) return null;
  if (!me) return <p><Link href="/login?next=/sell">Log in</Link> to start selling.</p>;
  if (store === undefined) return <p className="muted">Loading…</p>;
  if (store === null) return <CreateStore onCreated={load} />;
  const currency = "USD";

  return (
    <div className="stack">
      <div className="spread">
        <div>
          <h1>{store.name}</h1>
          {store.verificationStatus === "VERIFIED" ? <Link href={`/stores/${store.slug}`} className="small">View public store page</Link> : null}
        </div>
        <div className="row">
          <div className="card" style={{ padding: "10px 16px" }}><div className="muted small">Available balance</div><strong><Money minor={store.balance.availableMinor} currency={currency} /></strong></div>
          <div className="card" style={{ padding: "10px 16px" }}><div className="muted small">Held in escrow</div><strong><Money minor={store.balance.inEscrowMinor} currency={currency} /></strong></div>
        </div>
      </div>
      {store.verificationStatus === "PENDING" && <div className="notice warn">Your store is waiting for verification. You can list products once it&apos;s approved.</div>}
      {store.verificationStatus === "REJECTED" && <div className="notice error">Your store couldn&apos;t be verified. Check your email for details.</div>}
      <div className="tabs">
        <button className={tab === "orders" ? "active" : ""} onClick={() => setTab("orders")}>Orders</button>
        <button className={tab === "listings" ? "active" : ""} onClick={() => setTab("listings")}>Listings</button>
        <button className={tab === "new" ? "active" : ""} onClick={() => { setEditing(null); setTab("new"); }} disabled={store.verificationStatus !== "VERIFIED"}>{editing ? "Edit listing" : "New listing"}</button>
        <button className={tab === "analytics" ? "active" : ""} onClick={() => setTab("analytics")}>Analytics</button>
        <button className={tab === "payouts" ? "active" : ""} onClick={() => setTab("payouts")}>Payouts</button>
        <button className={tab === "coupons" ? "active" : ""} onClick={() => setTab("coupons")} disabled={store.verificationStatus !== "VERIFIED"}>Coupons</button>
        <button className={tab === "reviews" ? "active" : ""} onClick={() => setTab("reviews")}>Reviews</button>
        <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>Settings</button>
      </div>
      {tab === "orders" && <StoreOrders />}
      {tab === "listings" && <Listings onEdit={(p) => { setEditing(p); setTab("new"); }} />}
      {tab === "analytics" && <SellerAnalytics />}
      {tab === "payouts" && <SellerPayouts />}
      {tab === "coupons" && <SellerCoupons />}
      {tab === "reviews" && <SellerReviews />}
      {tab === "settings" && <SellerSettings store={store} onSaved={load} />}
      {tab === "new" && <ProductForm key={editing?.id ?? "new"} product={editing} onSaved={() => { setEditing(null); setTab("listings"); }} />}
    </div>
  );
}

function CreateStore({ onCreated }: { onCreated: () => void }) {
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [form, setForm] = useState({ name: "", description: "", returnPolicyDays: 14, pickupAddressId: "" });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<Address[]>("/addresses").then((a) => { setAddresses(a); if (a[0]) setForm((f) => ({ ...f, pickupAddressId: a[0].id })); }); }, []);

  return (
    <div className="stack" style={{ maxWidth: 640 }}>
      <h1>Open your store</h1>
      <p className="muted">After you apply, we verify your identity before your listings go live. Payouts are made from your balance once buyers receive their orders.</p>
      {addresses.length === 0 ? (
        <div className="card stack"><h3>First, add your pickup address</h3><p className="muted small">Delivery prices are calculated from here.</p><AddressForm onSaved={(a) => { setAddresses([a]); setForm((f) => ({ ...f, pickupAddressId: a.id })); }} /></div>
      ) : (
        <form className="card stack" onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            await api("/stores", { method: "POST", json: { ...form, description: form.description || undefined } });
            onCreated();
          } catch (err) {
            setError((err as Error).message);
          }
        }}>
          <div><label>Store name</label><input required minLength={2} maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div><label>About your store</label><textarea rows={3} maxLength={2000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
          <div><label>Return policy</label>
            <select value={form.returnPolicyDays} onChange={(e) => setForm({ ...form, returnPolicyDays: Number(e.target.value) })}>
              <option value={0}>No change-of-mind returns</option><option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option>
            </select>
          </div>
          <div><label>Ships from</label>
            <select value={form.pickupAddressId} onChange={(e) => setForm({ ...form, pickupAddressId: e.target.value })}>
              {addresses.map((a) => <option key={a.id} value={a.id}>{a.line1}, {a.city}</option>)}
            </select>
          </div>
          <ErrorNotice error={error} />
          <div><button type="submit">Apply to sell</button></div>
        </form>
      )}
    </div>
  );
}

function StoreOrders() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  useEffect(() => { api<Order[]>("/stores/me/orders").then(setOrders); }, []);
  if (!orders) return <p className="muted">Loading…</p>;
  if (!orders.length) return <p className="muted">No orders yet.</p>;
  const needsAction = (o: Order) => (o.state === "PAID" && !o.riskHold) || o.state === "DISPUTED";
  return (
    <div className="table-wrap"><table>
      <thead><tr><th>Order</th><th>Items</th><th>Status</th><th>Ship by</th><th className="right">Total</th></tr></thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.id}>
            <td><Link href={`/orders/${o.id}`}>#{o.id.slice(0, 8)}</Link>{needsAction(o) && <> <span className="pill warn">Action needed</span></>}</td>
            <td className="small">{o.items.map((i) => `${i.quantity} × ${i.title}`).join(", ")}</td>
            <td><StateBadge state={o.state} />{o.riskHold && <> <span className="pill">In review</span></>}</td>
            <td className="small">{o.state === "PAID" ? formatDate(o.shipBy) : ""}</td>
            <td className="right"><Money minor={o.totalMinor} currency={o.currency} /></td>
          </tr>
        ))}
      </tbody>
    </table></div>
  );
}

function Listings({ onEdit }: { onEdit: (p: Product) => void }) {
  const [products, setProducts] = useState<Product[] | null>(null);
  const load = () => api<Product[]>("/stores/me/products").then(setProducts);
  useEffect(() => { load(); }, []);
  if (!products) return <p className="muted">Loading…</p>;
  if (!products.length) return <p className="muted">No listings yet.</p>;
  return (
    <div className="table-wrap"><table>
      <thead><tr><th>Listing</th><th>Status</th><th>Stock</th><th className="right">Price</th><th /></tr></thead>
      <tbody>
        {products.map((p) => (
          <tr key={p.id}>
            <td><Link href={`/products/${p.id}`}>{p.title}</Link></td>
            <td>{p.status === "ACTIVE" ? <span className="pill ok">Live</span> : <span className="pill warn" title={p.reviewNote ?? ""}>In review</span>}</td>
            <td>{p.stock === 0 ? <span className="pill danger">Sold out</span> : p.stock}</td>
            <td className="right"><Money minor={p.priceMinor} currency={p.currency} /></td>
            <td className="right row" style={{ justifyContent: "flex-end" }}>
              <button className="link small" onClick={() => onEdit(p)}>Edit</button>
              <button className="link small" onClick={async () => { if (window.confirm(`Remove "${p.title}"?`)) { await api(`/products/${p.id}`, { method: "DELETE" }); load(); } }}>Remove</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table></div>
  );
}

function ProductForm({ product, onSaved }: { product: Product | null; onSaved: () => void }) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [f, setF] = useState({
    title: product?.title ?? "", description: product?.description ?? "", categoryId: product?.categoryId ?? "",
    price: product ? String(product.priceMinor / 100) : "", stock: String(product?.stock ?? 1), condition: product?.condition ?? "NEW",
    weightGrams: String(product?.weightGrams ?? ""), lengthCm: String(product?.lengthCm ?? ""), widthCm: String(product?.widthCm ?? ""), heightCm: String(product?.heightCm ?? ""),
  });
  const [images, setImages] = useState<string[]>(product?.images ?? []);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { api<Category[]>("/categories").then((c) => { setCategories(c); setF((x) => ({ ...x, categoryId: x.categoryId || c[0]?.id || "" })); }); }, []);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <form className="card stack" style={{ maxWidth: 760 }} onSubmit={async (e) => {
      e.preventDefault();
      setError(null);
      try {
        const body = {
          title: f.title, description: f.description, categoryId: f.categoryId, priceMinor: toMinor(f.price), stock: Number(f.stock),
          condition: f.condition, weightGrams: Number(f.weightGrams), lengthCm: Number(f.lengthCm), widthCm: Number(f.widthCm), heightCm: Number(f.heightCm), images,
        };
        const saved = await api<Product>(product ? `/products/${product.id}` : "/products", { method: product ? "PATCH" : "POST", json: body });
        if (saved.status === "PENDING_REVIEW") setNotice("Saved. This listing needs a quick review by our team before it goes live.");
        else onSaved();
      } catch (err) {
        setError((err as Error).message);
      }
    }}>
      <h2>{product ? "Edit listing" : "New listing"}</h2>
      <div><label>Title</label><input required minLength={3} maxLength={140} value={f.title} onChange={set("title")} /></div>
      <div><label>Description</label><textarea required minLength={10} rows={5} value={f.description} onChange={set("description")} /></div>
      <div><label>Photos (location data is removed automatically)</label><ImageUploader value={images} onChange={setImages} /></div>
      <div className="grid-2">
        <div><label>Category</label><select value={f.categoryId} onChange={set("categoryId")}>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div><label>Condition</label><select value={f.condition} onChange={set("condition")}><option value="NEW">New</option><option value="USED">Used</option></select></div>
        <div><label>Price</label><input required inputMode="decimal" value={f.price} onChange={set("price")} /></div>
        <div><label>Quantity in stock</label><input required type="number" min={0} value={f.stock} onChange={set("stock")} /></div>
      </div>
      <h3>Package size (used for delivery prices)</h3>
      <div className="grid-2">
        <div><label>Weight (grams)</label><input required type="number" min={1} value={f.weightGrams} onChange={set("weightGrams")} /></div>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <div><label>Length cm</label><input required type="number" min={1} value={f.lengthCm} onChange={set("lengthCm")} /></div>
          <div><label>Width cm</label><input required type="number" min={1} value={f.widthCm} onChange={set("widthCm")} /></div>
          <div><label>Height cm</label><input required type="number" min={1} value={f.heightCm} onChange={set("heightCm")} /></div>
        </div>
      </div>
      <ErrorNotice error={error} />
      {notice && <div className="notice warn">{notice}</div>}
      <div className="row"><button type="submit">{product ? "Save changes" : "Publish listing"}</button>{notice && <button type="button" className="secondary" onClick={onSaved}>Back to listings</button>}</div>
    </form>
  );
}
