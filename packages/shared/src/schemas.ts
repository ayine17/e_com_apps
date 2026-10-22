import { z } from "zod";

/** Input schemas shared by the API (validation) and the web app (forms). */

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export const requestOtpSchema = z.object({ email: emailSchema });
export const verifyOtpSchema = z.object({ email: emailSchema, code: z.string().regex(/^\d{6}$/) });

export const addressSchema = z.object({
  label: z.string().trim().max(40).optional(),
  line1: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(100),
  postcode: z.string().trim().max(20).optional(),
  country: z.string().trim().length(2).toUpperCase(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const createStoreSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(2000).optional(),
  returnPolicyDays: z.union([z.literal(0), z.literal(7), z.literal(14), z.literal(30)]),
  pickupAddressId: z.string().uuid(),
});

export const productInputSchema = z.object({
  title: z.string().trim().min(3).max(140),
  description: z.string().trim().min(10).max(5000),
  categoryId: z.string().uuid(),
  priceMinor: z.number().int().min(50).max(100_000_000),
  stock: z.number().int().min(0).max(100_000),
  condition: z.enum(["NEW", "USED"]),
  weightGrams: z.number().int().min(1).max(100_000),
  lengthCm: z.number().int().min(1).max(300),
  widthCm: z.number().int().min(1).max(300),
  heightCm: z.number().int().min(1).max(300),
  images: z.array(z.string().max(500)).max(10),
});

export const productSearchSchema = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().max(60).optional(),
  minPrice: z.coerce.number().int().min(0).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  condition: z.enum(["NEW", "USED"]).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  maxKm: z.coerce.number().min(1).max(20000).optional(),
  sort: z.enum(["relevance", "price_asc", "price_desc", "newest", "nearest"]).default("relevance"),
  page: z.coerce.number().int().min(1).max(500).default(1),
});

export const cartItemSchema = z.object({ productId: z.string().uuid(), quantity: z.number().int().min(1).max(100) });

export const couponCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,24}$/, "Codes are 3–24 letters, numbers, - or _");

export const shippingQuoteSchema = z.object({
  items: z.array(cartItemSchema).min(1).max(50),
  addressId: z.string().uuid(),
  /** Coupon code per store id. */
  coupons: z.record(z.string().uuid(), couponCodeSchema).default({}),
});

export const checkoutSchema = shippingQuoteSchema.extend({
  /** Chosen shipping service per store id. */
  shipping: z.record(z.string().uuid(), z.string().max(40)),
  /** Only honoured by the fake payment provider in development. */
  testCard: z.enum(["success", "decline", "elevated_risk"]).optional(),
});

export const shipOrderSchema = z.object({
  carrier: z.string().trim().min(2).max(60),
  trackingNumber: z.string().trim().min(4).max(60),
});

export const deliveryCodeSchema = z.object({ code: z.string().regex(/^\d{4}$/) });

export const messageSchema = z.object({
  body: z.string().trim().min(1).max(2000),
  attachments: z.array(z.string().max(500)).max(5).default([]),
});

export const DISPUTE_REASONS = ["NOT_RECEIVED", "NOT_AS_DESCRIBED", "DAMAGED", "WRONG_ITEM"] as const;

export const openDisputeSchema = z.object({
  reason: z.enum(DISPUTE_REASONS),
  description: z.string().trim().min(10).max(3000),
  evidence: z.array(z.string().max(500)).max(10).default([]),
});

export const disputeOfferSchema = z.object({
  kind: z.enum(["FULL_REFUND", "PARTIAL_REFUND"]),
  amountMinor: z.number().int().min(1).optional(),
  note: z.string().trim().max(1000).optional(),
});

export const disputeDecisionSchema = z.object({
  outcome: z.enum(["RELEASE_TO_SELLER", "FULL_REFUND", "PARTIAL_REFUND"]),
  amountMinor: z.number().int().min(1).optional(),
  reasoning: z.string().trim().min(10).max(3000),
});

export const reviewSchema = z.object({
  productId: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  body: z.string().trim().max(2000).optional(),
});

export const reviewReplySchema = z.object({ reply: z.string().trim().min(1).max(1000) });

export const RETURN_REASONS = ["CHANGE_OF_MIND", "NOT_AS_DESCRIBED", "DAMAGED", "WRONG_ITEM"] as const;

export const returnRequestSchema = z.object({
  reason: z.enum(RETURN_REASONS),
  description: z.string().trim().min(10).max(2000),
  evidence: z.array(z.string().max(500)).max(10).default([]),
});

export const returnShipmentSchema = z.object({
  carrier: z.string().trim().min(2).max(60),
  trackingNumber: z.string().trim().min(4).max(60),
});

export const couponSchema = z.object({
  code: couponCodeSchema,
  kind: z.enum(["PERCENT", "FIXED"]),
  /** PERCENT: basis points (1000 = 10%). FIXED: minor units. */
  value: z.number().int().min(1).max(100_000_000),
  minSubtotalMinor: z.number().int().min(0).default(0),
  maxUses: z.number().int().min(1).optional(),
  expiresAt: z.string().datetime().optional(),
}).refine((c) => c.kind !== "PERCENT" || c.value <= 9000, { message: "A percentage coupon can be at most 90%", path: ["value"] });

export const storeSettingsSchema = z.object({
  returnPolicyDays: z.union([z.literal(0), z.literal(7), z.literal(14), z.literal(30)]),
  freeShippingOverMinor: z.number().int().min(0).nullable(),
});

export const payoutAccountSchema = z.object({
  /** Connected account id at the payment provider. */
  accountRef: z.string().trim().regex(/^[A-Za-z0-9_]{6,64}$/, "Enter the account id from your payment provider"),
  /** A fresh login code, so a stolen session alone can't redirect payouts. */
  code: z.string().regex(/^\d{6}$/),
});

export const notificationPrefsSchema = z.object({ orders: z.boolean(), alerts: z.boolean() });

export const reportSchema = z.object({
  targetType: z.enum(["PRODUCT", "USER", "MESSAGE"]),
  targetId: z.string().uuid(),
  reason: z.string().trim().min(3).max(1000),
});

export type AddressInput = z.infer<typeof addressSchema>;
export type ProductInput = z.infer<typeof productInputSchema>;
export type ProductSearch = z.infer<typeof productSearchSchema>;
export type CartItem = z.infer<typeof cartItemSchema>;
export type CheckoutInput = z.infer<typeof checkoutSchema>;
export type OpenDisputeInput = z.infer<typeof openDisputeSchema>;
export type DisputeOfferInput = z.infer<typeof disputeOfferSchema>;
export type DisputeDecisionInput = z.infer<typeof disputeDecisionSchema>;
