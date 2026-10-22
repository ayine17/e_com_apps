import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Order, Prisma, User } from "@prisma/client";
import { randomInt, randomUUID } from "crypto";
import { CartItem, CheckoutInput, CheckoutSignals, couponDiscount, formatMoney, qualifiesForFreeShipping, quoteShipping, RiskResult, ShippingQuote } from "@market/shared";
import { AppConfig, CONFIG, DAY_MS } from "../config";
import { Accounts, LedgerService } from "../core/ledger.service";
import { NotificationsService } from "../core/notifications.service";
import { OrderLifecycleService } from "../core/order-lifecycle.service";
import { ChargeResult, PaymentProvider } from "../core/payments";
import { PrismaService } from "../core/prisma.service";
import { addressFingerprint, RiskService } from "../core/risk.service";
import { SettingsService } from "../core/settings.service";

interface StoreGroup {
  store: { id: string; name: string; lat: number; lng: number; ownerId: string; freeShippingOverMinor: number | null };
  lines: { product: { id: string; title: string; priceMinor: number; weightGrams: number; lengthCm: number; widthCm: number; heightCm: number }; quantity: number }[];
  subtotalMinor: number;
  discountMinor: number;
  coupon: { id: string; code: string } | null;
  couponError: string | null;
  freeShipping: boolean;
  quotes: ShippingQuote[];
}

/** Orders still unpaid after this long are checked with the provider and finished or cancelled. */
export const PENDING_PAYMENT_TIMEOUT_MS = 10 * 60 * 1000;

@Injectable()
export class CheckoutService {
  private readonly log = new Logger(CheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly risk: RiskService,
    private readonly payments: PaymentProvider,
    private readonly ledger: LedgerService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Splits a cart by seller, applies coupons and free delivery, and quotes delivery for each (spec sections 2.3, 2.5). */
  async quote(user: User, items: CartItem[], addressId: string, coupons: Record<string, string> = {}) {
    const address = await this.prisma.address.findFirst({ where: { id: addressId, userId: user.id } });
    if (!address) throw new NotFoundException("Address not found");

    const ids = [...new Set(items.map((i) => i.productId))];
    const products = await this.prisma.product.findMany({
      where: { id: { in: ids }, status: "ACTIVE", store: { verificationStatus: "VERIFIED", owner: { suspendedAt: null, deletedAt: null } } },
      include: { store: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    const groups = new Map<string, StoreGroup>();
    const wanted = new Map<string, number>();

    for (const item of items) {
      const p = byId.get(item.productId);
      if (!p) throw new BadRequestException("An item in your cart is no longer available");
      if (p.store.ownerId === user.id) throw new BadRequestException("You can't buy your own listing");
      const total = (wanted.get(p.id) ?? 0) + item.quantity;
      wanted.set(p.id, total);
      if (p.stock < total) throw new ConflictException(`Only ${p.stock} of "${p.title}" left`);
      const g = groups.get(p.storeId) ?? { store: p.store, lines: [], subtotalMinor: 0, discountMinor: 0, coupon: null, couponError: null, freeShipping: false, quotes: [] };
      const existing = g.lines.find((l) => l.product.id === p.id);
      if (existing) existing.quantity += item.quantity;
      else g.lines.push({ product: p, quantity: item.quantity });
      g.subtotalMinor += p.priceMinor * item.quantity;
      groups.set(p.storeId, g);
    }

    const { sharesDevice } = await this.selfDealingCheck(user.id, address.fingerprint, [...groups.values()].map((g) => g.store.ownerId));

    for (const g of groups.values()) {
      const code = coupons[g.store.id];
      if (code) {
        const coupon = await this.prisma.coupon.findUnique({ where: { storeId_code: { storeId: g.store.id, code } } });
        const check = coupon ? couponDiscount(coupon, g.subtotalMinor) : { ok: false as const, reason: "That code isn't valid for this store" };
        if (check.ok) {
          g.discountMinor = check.discountMinor;
          g.coupon = { id: coupon!.id, code };
        } else g.couponError = check.reason;
      }
      g.freeShipping = qualifiesForFreeShipping(g.subtotalMinor - g.discountMinor, g.store.freeShippingOverMinor);
      const quotes = quoteShipping(g.store, address, g.lines.map((l) => ({ ...l.product, quantity: l.quantity })));
      // Free delivery covers the standard service; faster options cost the difference.
      g.quotes = g.freeShipping ? quotes.map((q, i) => ({ ...q, amountMinor: i === 0 ? 0 : q.amountMinor - quotes[0].amountMinor })) : quotes;
    }
    return { address, currency: this.config.PLATFORM_CURRENCY, groups: [...groups.values()], sharesDeviceWithSeller: sharesDevice };
  }

  /**
   * Spec section 6.5: a seller can't buy their own listings through another account to fake
   * sales or reviews. Sharing a shipping address with the seller blocks the purchase. Sharing a
   * device is weaker evidence (families share computers), so it only adds fraud risk.
   */
  private async selfDealingCheck(buyerId: string, fingerprint: string, sellerIds: string[]): Promise<{ sharesDevice: boolean }> {
    if (!sellerIds.length) return { sharesDevice: false };
    const sharedAddress = await this.prisma.address.count({ where: { userId: { in: sellerIds }, fingerprint } });
    if (sharedAddress) throw new ForbiddenException("You can't buy from a store linked to your own account");
    const buyerDevices = await this.prisma.knownDevice.findMany({ where: { userId: buyerId }, select: { deviceId: true } });
    const sharedDevice = buyerDevices.length
      ? await this.prisma.knownDevice.count({ where: { userId: { in: sellerIds }, deviceId: { in: buyerDevices.map((d) => d.deviceId) } } })
      : 0;
    return { sharesDevice: sharedDevice > 0 };
  }

  async checkout(user: User, input: CheckoutInput) {
    const { address, currency, groups, sharesDeviceWithSeller } = await this.quote(user, input.items, input.addressId, input.coupons);

    const planned = groups.map((g) => {
      if (g.couponError) throw new BadRequestException(`${g.store.name}: ${g.couponError}`);
      const service = input.shipping[g.store.id];
      const quote = g.quotes.find((q) => q.service === service);
      if (!quote) throw new BadRequestException(`Choose a delivery option for ${g.store.name}`);
      return { ...g, quote, totalMinor: g.subtotalMinor - g.discountMinor + quote.amountMinor };
    });
    const grandTotal = planned.reduce((s, g) => s + g.totalMinor, 0);
    if (grandTotal <= 0) throw new BadRequestException("Your order total must be more than zero");

    // 1. Score before charging, so blocked checkouts never reach the card network.
    const signals = { ...(await this.risk.checkoutSignals(user.id, address.fingerprint, grandTotal)), sharesDeviceWithSeller };
    const risk = this.risk.score(signals);
    const checkoutId = randomUUID();
    if (risk.action === "BLOCK") {
      await this.risk.record("checkout", user.id, checkoutId, risk);
      throw new ForbiddenException("We couldn't process this order. Contact support if you think this is a mistake.");
    }

    // 2. Reserve stock and coupon uses, and create orders, atomically. Conditional updates prevent overselling.
    const { fingerprint: _fp, userId: _uid, ...shippingAddress } = address;
    const orders = await this.prisma.$transaction(async (tx) => {
      const created = [];
      for (const g of planned) {
        for (const l of g.lines) {
          const { count } = await tx.product.updateMany({
            where: { id: l.product.id, status: "ACTIVE", stock: { gte: l.quantity } },
            data: { stock: { decrement: l.quantity } },
          });
          if (!count) throw new ConflictException(`"${l.product.title}" just sold out`);
        }
        if (g.coupon) {
          const used = await tx.$executeRaw`UPDATE "Coupon" SET "usedCount" = "usedCount" + 1
            WHERE id = ${g.coupon.id}::uuid AND active AND ("maxUses" IS NULL OR "usedCount" < "maxUses")`;
          if (!used) throw new ConflictException(`The code ${g.coupon.code} was just used up`);
        }
        const order = await tx.order.create({
          data: {
            checkoutId, buyerId: user.id, storeId: g.store.id, currency,
            subtotalMinor: g.subtotalMinor, discountMinor: g.discountMinor, couponCode: g.coupon?.code,
            shippingMinor: g.quote.amountMinor, feeMinor: 0, totalMinor: g.totalMinor,
            shippingService: g.quote.service, shippingAddress: shippingAddress as Prisma.InputJsonValue,
            riskScore: risk.score, riskAction: risk.action, riskHits: risk.hits as unknown as Prisma.InputJsonValue,
            items: { create: g.lines.map((l) => ({ productId: l.product.id, title: l.product.title, unitPriceMinor: l.product.priceMinor, quantity: l.quantity })) },
            events: { create: { toState: "PENDING_PAYMENT", actorId: user.id } },
          },
        });
        created.push(order);
      }
      return created;
    });

    // 3. One charge for the whole checkout; each order holds its own share in escrow.
    let charge: ChargeResult;
    try {
      charge = await this.payments.charge({
        amountMinor: grandTotal, currency, idempotencyKey: `checkout:${checkoutId}`,
        requireStrongAuth: risk.action === "STEP_UP", testCard: input.testCard,
      });
    } catch (e) {
      // We don't know whether the card was charged. Leave the orders pending: the recovery job
      // asks the provider and either completes or cancels them.
      this.log.warn(`Charge for checkout ${checkoutId} failed with an error: ${(e as Error).message}`);
      throw new BadGatewayException("We couldn't confirm your payment yet. Check your orders in a few minutes. You won't be charged twice.");
    }
    return this.finish(user, orders, checkoutId, charge, signals, risk);
  }

  /** Completes or cancels a checkout once the charge outcome is known. Used by checkout and the recovery job. */
  private async finish(user: User, orders: Order[], checkoutId: string, charge: ChargeResult, signals: CheckoutSignals, initialRisk: RiskResult) {
    const total = orders.reduce((s, o) => s + o.totalMinor, 0);
    const currency = orders[0].currency;
    await this.prisma.paymentAttempt.create({
      data: { userId: user.id, checkoutId, amountMinor: total, currency, succeeded: charge.ok, providerRef: charge.ref, failureCode: charge.failureCode },
    });

    if (!charge.ok) {
      await this.cancelUnpaid(orders, `Payment failed: ${charge.failureCode}`);
      throw new HttpException({ message: "Your payment was declined. Try another payment method.", code: charge.failureCode }, HttpStatus.PAYMENT_REQUIRED);
    }

    // 4. Re-score with the provider's own fraud signal.
    const risk = charge.elevatedRisk ? this.risk.score({ ...signals, providerElevatedRisk: true }) : initialRisk;
    await this.risk.record("checkout", user.id, checkoutId, risk);

    const shipBy = new Date(Date.now() + (await this.settings.get("HANDLING_DAYS")) * DAY_MS);
    await this.prisma.$transaction(async (tx) => {
      for (const o of orders) {
        await this.lifecycle.transition(tx, o, "PAID", user.id, "Payment captured into escrow", {
          paymentRef: charge.ref, shipBy, riskScore: risk.score, riskAction: risk.action,
          riskHits: risk.hits as unknown as Prisma.InputJsonValue,
          riskHold: risk.action === "HOLD" || risk.action === "BLOCK",
        });
        await this.ledger.post(tx, `payment for order ${o.id}`, currency, o.id, [
          { account: Accounts.providerCash, amountMinor: o.totalMinor },
          { account: Accounts.escrow(o.id), amountMinor: -o.totalMinor },
        ]);
      }
    });

    // Provider flagged it so strongly that we shouldn't proceed: refund straight away.
    if (risk.action === "BLOCK") {
      for (const o of orders) await this.lifecycle.settle(o.id, "CANCELLED", o.totalMinor, null, "Cancelled by fraud screening");
      throw new ForbiddenException("We couldn't process this order and you have not been charged.");
    }

    await this.notifyPlaced(user, orders.map((o) => o.id), risk.action === "HOLD");
    return { checkoutId, orderIds: orders.map((o) => o.id), totalMinor: total, currency, onHold: risk.action === "HOLD" };
  }

  private async cancelUnpaid(orders: Order[], reason: string) {
    await this.prisma.$transaction(async (tx) => {
      for (const o of orders) {
        await this.lifecycle.transition(tx, o, "CANCELLED", null, reason);
        const items = await tx.orderItem.findMany({ where: { orderId: o.id } });
        for (const i of items) await tx.product.update({ where: { id: i.productId }, data: { stock: { increment: i.quantity } } });
        if (o.couponCode) await tx.coupon.updateMany({ where: { storeId: o.storeId, code: o.couponCode, usedCount: { gt: 0 } }, data: { usedCount: { decrement: 1 } } });
      }
    });
  }

  /**
   * Finishes checkouts left unpaid by a crash or provider timeout. If the provider has a charge
   * for the checkout the orders become PAID; otherwise they're cancelled and stock is released.
   */
  async recoverPendingPayments(now = new Date()): Promise<number> {
    const stale = await this.prisma.order.findMany({
      where: { state: "PENDING_PAYMENT", createdAt: { lte: new Date(now.getTime() - PENDING_PAYMENT_TIMEOUT_MS) } },
      distinct: ["checkoutId"],
      select: { checkoutId: true },
      take: 50,
    });
    let done = 0;
    for (const { checkoutId } of stale) {
      const orders = await this.prisma.order.findMany({ where: { checkoutId, state: "PENDING_PAYMENT" } });
      if (!orders.length) continue;
      try {
        const charge = await this.payments.lookupCharge(`checkout:${checkoutId}`);
        if (!charge) {
          await this.cancelUnpaid(orders, "Payment never completed");
        } else {
          const user = await this.prisma.user.findUniqueOrThrow({ where: { id: orders[0].buyerId } });
          const address = orders[0].shippingAddress as { line1: string; city: string; postcode?: string; country: string };
          const signals = await this.risk.checkoutSignals(user.id, addressFingerprint(address), orders.reduce((s, o) => s + o.totalMinor, 0));
          await this.finish(user, orders, checkoutId, charge, signals, this.risk.score(signals)).catch((e) => {
            // Declines and fraud blocks are handled inside finish(); they just surface as HTTP errors.
            if (!(e instanceof HttpException)) throw e;
          });
        }
        done++;
      } catch (e) {
        this.log.warn(`Could not recover checkout ${checkoutId}: ${(e as Error).message}`);
      }
    }
    return done;
  }

  private async notifyPlaced(buyer: User, orderIds: string[], held: boolean) {
    const orders = await this.prisma.order.findMany({ where: { id: { in: orderIds } }, include: { store: true, items: true } });
    for (const o of orders) {
      const ref = o.id.slice(0, 8);
      const link = `/orders/${o.id}`;
      await this.notifications.notify(buyer.id, "orders", `Order ${ref} confirmed`, `Thanks for your order. ${formatMoney(o.totalMinor, o.currency)} is held safely in escrow and only released to ${o.store.name} after you receive your items.`, link);
      if (!held) {
        const list = o.items.map((i) => `${i.quantity} × ${i.title}`).join(", ");
        await this.notifications.notify(o.store.ownerId, "orders", `New order ${ref}: please ship by ${o.shipBy?.toDateString()}`, `You have a new paid order: ${list}. Ship it and add tracking before ${o.shipBy?.toDateString()}.`, link);
      }
    }
  }
}

export function newDeliveryCode(): string {
  return randomInt(0, 10_000).toString().padStart(4, "0");
}
