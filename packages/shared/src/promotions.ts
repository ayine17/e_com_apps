import { applyBps } from "./money";

export interface CouponRule {
  kind: string; // "PERCENT" | "FIXED"
  value: number;
  minSubtotalMinor: number;
  maxUses: number | null;
  usedCount: number;
  expiresAt: Date | string | null;
  active: boolean;
}

export type CouponCheck = { ok: true; discountMinor: number } | { ok: false; reason: string };

/** Discount a seller coupon gives on a store's subtotal. Never more than the subtotal. */
export function couponDiscount(c: CouponRule, subtotalMinor: number, now = new Date()): CouponCheck {
  if (!c.active) return { ok: false, reason: "This code is no longer active" };
  if (c.expiresAt && new Date(c.expiresAt) <= now) return { ok: false, reason: "This code has expired" };
  if (c.maxUses !== null && c.usedCount >= c.maxUses) return { ok: false, reason: "This code has been fully used" };
  if (subtotalMinor < c.minSubtotalMinor) return { ok: false, reason: "Your order is below this code's minimum" };
  const raw = c.kind === "PERCENT" ? applyBps(subtotalMinor, c.value) : c.value;
  return { ok: true, discountMinor: Math.min(raw, subtotalMinor) };
}

/** True when the store's free-delivery threshold applies to this subtotal (after discounts). */
export function qualifiesForFreeShipping(subtotalMinor: number, thresholdMinor: number | null): boolean {
  return thresholdMinor !== null && subtotalMinor >= thresholdMinor;
}
