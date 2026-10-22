import type { OrderState } from "@market/shared";

export type Role = "BUYER" | "SELLER" | "AGENT" | "ADMIN";
export interface Me { id: string; email: string; name: string | null; roles: Role[]; emailPrefs?: { orders: boolean; alerts: boolean } }

export interface Category { id: string; slug: string; name: string }

export interface StoreSummary { id: string; name: string; slug: string; city: string; country: string; lat: number; lng: number }

export interface Product {
  id: string; storeId: string; categoryId: string; title: string; description: string; priceMinor: number; currency: string;
  stock: number; condition: "NEW" | "USED"; weightGrams: number; lengthCm: number; widthCm: number; heightCm: number;
  images: string[]; status: "ACTIVE" | "PENDING_REVIEW" | "REMOVED"; createdAt: string;
  store?: StoreSummary & { returnPolicyDays?: number; ownerId?: string }; distanceKm?: number | null; reviewNote?: string | null;
}

export interface Rating { average: number | null; count: number }
export interface StoreStats { completedOrders: number; disputeRate: number; onTimeShippingRate: number | null; rating?: Rating }

export interface Address { id: string; label: string | null; line1: string; city: string; postcode: string | null; country: string; lat: number; lng: number }

export interface OrderItem { id: string; productId: string; title: string; unitPriceMinor: number; quantity: number }
export interface OrderEvent { id: string; fromState: OrderState | null; toState: OrderState; note: string | null; createdAt: string; actorId: string | null }
export interface Shipment { carrier: string; trackingNumber: string; deliveredAt: string | null; deliveredVia: string | null; createdAt: string }

export interface Dispute {
  id: string; orderId: string; reason: string; description: string; evidence: string[]; stage: "OPEN" | "ESCALATED" | "RESOLVED";
  sellerRespondBy: string; offerKind: string | null; offerMinor: number | null; offerNote: string | null; offerDeclined: boolean;
  outcome: string | null; outcomeMinor: number | null; reasoning: string | null; createdAt: string; escalatedAt: string | null;
}

export interface Order {
  id: string; checkoutId: string; buyerId: string; storeId: string; state: OrderState; currency: string;
  subtotalMinor: number; shippingMinor: number; feeMinor: number; totalMinor: number; refundedMinor: number;
  shippingService: string; shippingAddress: Partial<Address>; riskHold: boolean; shipBy: string | null; releaseAt: string | null; createdAt: string;
  items: OrderItem[]; store?: { id?: string; name: string; slug: string; ownerId?: string; returnPolicyDays?: number };
  shipment?: Shipment | null; events?: OrderEvent[]; dispute?: Dispute | null; role?: "buyer" | "seller" | "staff";
  buyer?: { id: string; name: string | null; email?: string };
  riskScore?: number; riskHits?: { rule: string; points: number }[];
  discountMinor?: number; couponCode?: string | null; refundStatus?: string;
  returnRequest?: ReturnRequest | null; reviews?: Review[];
}

export interface ReturnRequest {
  id: string; orderId: string; reason: string; description: string; evidence: string[]; returnPaidBy: "BUYER" | "SELLER";
  refundMinor: number; status: "REQUESTED" | "SHIPPED_BACK" | "RECEIVED" | "REJECTED"; carrier: string | null; trackingNumber: string | null;
  shippedBackAt: string | null; autoRefundAt: string | null; createdAt: string;
}

export interface Review {
  id: string; orderId: string; productId: string; rating: number; body: string | null; sellerReply: string | null; createdAt: string;
  author?: { name: string }; product?: { title: string };
}

export interface Notification { id: string; kind: string; title: string; body: string; link: string | null; readAt: string | null; createdAt: string }

export interface Message { id: string; senderId: string; body: string; attachments: string[]; flags: string[]; createdAt: string; sender: { id: string; name: string | null; roles: Role[] } }
