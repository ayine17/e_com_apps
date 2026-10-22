export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface Parcel {
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  quantity: number;
}

export interface ShippingRate {
  service: string;
  label: string;
  baseMinor: number;
  perKmMinor: number;
  perKgMinor: number;
  minDays: number;
  maxDays: number;
  /** Extra days per 500 km travelled. */
  daysPer500Km: number;
}

export interface ShippingQuote {
  service: string;
  label: string;
  amountMinor: number;
  distanceKm: number;
  chargeableKg: number;
  minDays: number;
  maxDays: number;
}

/** Standard volumetric divisor used by most couriers: cm³ / 5000 = kg. */
export const VOLUMETRIC_DIVISOR = 5000;

/** Straight-line distances are multiplied by this to approximate road distance when no routing API is configured. */
export const ROAD_FACTOR = 1.3;

export const DEFAULT_RATES: ShippingRate[] = [
  { service: "standard", label: "Standard", baseMinor: 300, perKmMinor: 2, perKgMinor: 80, minDays: 2, maxDays: 4, daysPer500Km: 1 },
  { service: "express", label: "Express", baseMinor: 700, perKmMinor: 4, perKgMinor: 150, minDays: 1, maxDays: 2, daysPer500Km: 1 },
];

export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Chargeable weight is the larger of actual and volumetric weight, summed over all parcels. */
export function chargeableWeightKg(parcels: Parcel[]): number {
  let total = 0;
  for (const p of parcels) {
    const actual = p.weightGrams / 1000;
    const volumetric = (p.lengthCm * p.widthCm * p.heightCm) / VOLUMETRIC_DIVISOR;
    total += Math.max(actual, volumetric) * p.quantity;
  }
  return Math.round(total * 100) / 100;
}

/** Formula-based fallback quote: base + road km × per-km + chargeable kg × per-kg. */
export function quoteShipping(
  origin: GeoPoint,
  destination: GeoPoint,
  parcels: Parcel[],
  rates: ShippingRate[] = DEFAULT_RATES,
): ShippingQuote[] {
  const distanceKm = Math.round(haversineKm(origin, destination) * ROAD_FACTOR);
  const kg = chargeableWeightKg(parcels);
  const billableKg = Math.max(1, Math.ceil(kg));
  return rates.map((r) => {
    const extraDays = Math.floor(distanceKm / 500) * r.daysPer500Km;
    return {
      service: r.service,
      label: r.label,
      amountMinor: r.baseMinor + distanceKm * r.perKmMinor + billableKg * r.perKgMinor,
      distanceKm,
      chargeableKg: kg,
      minDays: r.minDays + extraDays,
      maxDays: r.maxDays + extraDays,
    };
  });
}
