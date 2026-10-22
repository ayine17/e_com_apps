"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { currentPosition } from "@/lib/geo";
import type { Address } from "@/lib/types";

/**
 * Collects an address with coordinates for delivery quotes. Coordinates come from the browser's
 * location for now; a geocoding API (Google Maps / Mapbox) will fill them from the address later.
 */
export function AddressForm({ onSaved }: { onSaved: (a: Address) => void }) {
  const [form, setForm] = useState({ label: "", line1: "", city: "", postcode: "", country: "US", lat: "", lng: "" });
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          const a = await api<Address>("/addresses", {
            method: "POST",
            json: { ...form, label: form.label || undefined, postcode: form.postcode || undefined, lat: Number(form.lat), lng: Number(form.lng) },
          });
          onSaved(a);
          setForm({ label: "", line1: "", city: "", postcode: "", country: form.country, lat: "", lng: "" });
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <div className="grid-2">
        <div><label>Label (optional)</label><input value={form.label} onChange={set("label")} placeholder="Home" /></div>
        <div><label>Street address</label><input required value={form.line1} onChange={set("line1")} /></div>
        <div><label>City</label><input required value={form.city} onChange={set("city")} /></div>
        <div><label>Postcode</label><input value={form.postcode} onChange={set("postcode")} /></div>
        <div><label>Country code</label><input required maxLength={2} value={form.country} onChange={set("country")} /></div>
      </div>
      <div className="row">
        <div style={{ flex: 1 }}><label>Latitude</label><input required inputMode="decimal" value={form.lat} onChange={set("lat")} /></div>
        <div style={{ flex: 1 }}><label>Longitude</label><input required inputMode="decimal" value={form.lng} onChange={set("lng")} /></div>
        <button
          type="button"
          className="secondary"
          style={{ alignSelf: "flex-end" }}
          disabled={locating}
          onClick={async () => {
            setLocating(true);
            const pos = await currentPosition();
            setLocating(false);
            if (pos) setForm((f) => ({ ...f, lat: String(pos.lat), lng: String(pos.lng) }));
            else setError("Couldn't get your location. Enter coordinates manually.");
          }}
        >
          {locating ? "Locating…" : "Use my location"}
        </button>
      </div>
      {error && <div className="notice error">{error}</div>}
      <div><button type="submit">Save address</button></div>
    </form>
  );
}
