import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";

export interface ChargeRequest {
  amountMinor: number;
  currency: string;
  /** Same key → same result, so a retried checkout never charges twice. */
  idempotencyKey: string;
  /** Ask the provider for 3-D Secure (risk step-up). */
  requireStrongAuth: boolean;
  testCard?: "success" | "decline" | "elevated_risk";
}

export interface ChargeResult {
  ok: boolean;
  ref?: string;
  failureCode?: string;
  /** The provider's own fraud screening flagged this payment (e.g. Stripe Radar "elevated"). */
  elevatedRisk: boolean;
}

export interface RefundRequest {
  chargeRef: string;
  amountMinor: number;
  idempotencyKey: string;
}

export interface TransferRequest {
  /** The seller's connected account at the provider (Stripe Connect account id). */
  destination: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
}

/**
 * Funds are captured into the platform's balance at a licensed provider and only moved to
 * sellers on release (Stripe Connect "separate charges and transfers"). The platform never
 * stores card details: the browser sends them straight to the provider.
 */
export abstract class PaymentProvider {
  abstract charge(req: ChargeRequest): Promise<ChargeResult>;
  /** Finds a charge made with this idempotency key, e.g. after a crash mid-checkout. Null if none was made. */
  abstract lookupCharge(idempotencyKey: string): Promise<ChargeResult | null>;
  abstract refund(req: RefundRequest): Promise<{ ok: boolean; ref?: string }>;
  /** Pays out from the platform balance to a seller's connected account. */
  abstract transfer(req: TransferRequest): Promise<{ ok: boolean; ref?: string }>;
}

/** Development provider. Behaves like a real one, including idempotency, without moving money. */
@Injectable()
export class FakePaymentProvider extends PaymentProvider {
  private readonly charges = new Map<string, ChargeResult>();
  private readonly refunds = new Map<string, { ok: boolean; ref?: string }>();

  /** Test switches for simulating provider outages. */
  failRefunds = false;
  /** "after": the provider took the money but the response was lost. "before": it never charged. */
  throwOnCharge: false | "before" | "after" = false;

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    if (this.throwOnCharge === "before") throw new Error("Payment provider unreachable");
    const existing = this.charges.get(req.idempotencyKey);
    if (existing) return existing;
    const result: ChargeResult =
      req.testCard === "decline"
        ? { ok: false, failureCode: "card_declined", elevatedRisk: false }
        : { ok: true, ref: `fake_ch_${randomUUID()}`, elevatedRisk: req.testCard === "elevated_risk" };
    this.charges.set(req.idempotencyKey, result);
    // Simulates the network dropping after the provider has already taken the money.
    if (this.throwOnCharge === "after") throw new Error("Payment provider timed out");
    return result;
  }

  async lookupCharge(idempotencyKey: string) {
    return this.charges.get(idempotencyKey) ?? null;
  }

  async refund(req: RefundRequest) {
    if (this.failRefunds) return { ok: false };
    const existing = this.refunds.get(req.idempotencyKey);
    if (existing) return existing;
    const result = { ok: true, ref: `fake_re_${randomUUID()}` };
    this.refunds.set(req.idempotencyKey, result);
    return result;
  }

  async transfer(_req: TransferRequest) {
    return { ok: true, ref: `fake_tr_${randomUUID()}` };
  }
}
