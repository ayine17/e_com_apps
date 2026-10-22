import { Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { User } from "@prisma/client";
import { couponSchema, payoutAccountSchema, storeSettingsSchema } from "@market/shared";
import { z } from "zod";
import { CurrentUser } from "../common/auth";
import { ZodPipe } from "../common/zod.pipe";
import { DAY_MS } from "../config";
import { AuditService } from "../core/audit.service";
import { LoginCodesService } from "../core/login-codes.service";
import { NotificationsService } from "../core/notifications.service";
import { PrismaService } from "../core/prisma.service";
import { SettingsService } from "../core/settings.service";
import { storeRating } from "../aftercare/reviews.controller";
import { PayoutsService } from "./payouts.service";

/** Seller tools: store settings, coupons, payouts and analytics. */
@Controller("stores/me")
export class SellersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payouts: PayoutsService,
    private readonly codes: LoginCodesService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  @Patch("settings")
  async updateSettings(@CurrentUser() user: User, @Body(new ZodPipe(storeSettingsSchema)) body: z.infer<typeof storeSettingsSchema>) {
    const store = await this.store(user);
    return this.prisma.store.update({ where: { id: store.id }, data: body });
  }

  // ---- Coupons (spec section 2.3) ----

  @Get("coupons")
  async coupons(@CurrentUser() user: User) {
    const store = await this.store(user);
    return this.prisma.coupon.findMany({ where: { storeId: store.id }, orderBy: { createdAt: "desc" } });
  }

  @Post("coupons")
  async createCoupon(@CurrentUser() user: User, @Body(new ZodPipe(couponSchema)) body: z.infer<typeof couponSchema>) {
    const store = await this.store(user, true);
    try {
      return await this.prisma.coupon.create({ data: { ...body, storeId: store.id, expiresAt: body.expiresAt ? new Date(body.expiresAt) : null } });
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") throw new ConflictException("You already have a coupon with that code");
      throw e;
    }
  }

  @Patch("coupons/:id")
  async toggleCoupon(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ active: z.boolean() }))) body: { active: boolean }) {
    const store = await this.store(user);
    const { count } = await this.prisma.coupon.updateMany({ where: { id, storeId: store.id }, data: { active: body.active } });
    if (!count) throw new NotFoundException("Coupon not found");
    return { ok: true };
  }

  // ---- Payouts (spec sections 2.4 and 6.4) ----

  @Get("payouts")
  async payoutInfo(@CurrentUser() user: User) {
    const store = await this.store(user);
    const [available, history] = await Promise.all([
      this.payouts.available(store.id),
      this.prisma.payout.findMany({ where: { storeId: store.id }, orderBy: { createdAt: "desc" }, take: 50 }),
    ]);
    return {
      availableMinor: available,
      // Show only the last 4 characters of the account id.
      account: store.payoutAccountRef ? `••••${store.payoutAccountRef.slice(-4)}` : null,
      holdUntil: store.payoutHoldUntil && store.payoutHoldUntil > new Date() ? store.payoutHoldUntil : null,
      history,
    };
  }

  /** Changing where money goes needs a fresh email code and starts a payout hold, so a stolen session can't redirect funds. */
  @Post("payout-account")
  async setPayoutAccount(@CurrentUser() user: User, @Body(new ZodPipe(payoutAccountSchema)) body: z.infer<typeof payoutAccountSchema>) {
    const store = await this.store(user);
    await this.codes.consume(user.email, body.code);
    const hours = await this.settings.get("PAYOUT_HOLD_HOURS");
    const hadAccount = !!store.payoutAccountRef;
    const holdUntil = hadAccount && hours > 0 ? new Date(Date.now() + hours * 60 * 60 * 1000) : null;
    await this.prisma.store.update({ where: { id: store.id }, data: { payoutAccountRef: body.accountRef, payoutHoldUntil: holdUntil } });
    await this.audit.record(user.id, "store.payout_account_changed", store.id, { last4: body.accountRef.slice(-4) });
    await this.notifications.notify(
      user.id,
      "security",
      "Your payout account was changed",
      hadAccount
        ? `Payouts now go to the account ending ${body.accountRef.slice(-4)}. For your security, payouts are paused for ${hours} hours. If you didn't make this change, contact support immediately.`
        : `Payouts will go to the account ending ${body.accountRef.slice(-4)}.`,
      "/sell",
    );
    return { account: `••••${body.accountRef.slice(-4)}`, holdUntil };
  }

  @Post("payouts")
  async payOutNow(@CurrentUser() user: User) {
    const store = await this.store(user, true);
    return this.payouts.payOut(store.id);
  }

  // ---- Analytics (spec section 12) ----

  @Get("analytics")
  async analytics(@CurrentUser() user: User) {
    const store = await this.store(user);
    const since = new Date(Date.now() - 30 * DAY_MS);
    const sold = { storeId: store.id, createdAt: { gte: since }, state: { notIn: ["PENDING_PAYMENT", "CANCELLED"] as ("PENDING_PAYMENT" | "CANCELLED")[] } };
    const [totals, completed, top, lowStock, rating, disputes] = await Promise.all([
      this.prisma.order.aggregate({ where: sold, _sum: { totalMinor: true, refundedMinor: true }, _count: { _all: true } }),
      this.prisma.order.aggregate({ where: { storeId: store.id, state: { in: ["COMPLETED", "PARTIALLY_REFUNDED"] }, updatedAt: { gte: since } }, _sum: { totalMinor: true, refundedMinor: true, feeMinor: true } }),
      this.prisma.orderItem.groupBy({ by: ["productId", "title"], where: { order: sold }, _sum: { quantity: true }, orderBy: { _sum: { quantity: "desc" } }, take: 5 }),
      this.prisma.product.findMany({ where: { storeId: store.id, status: "ACTIVE", stock: { lte: 3 } }, select: { id: true, title: true, stock: true }, orderBy: { stock: "asc" }, take: 10 }),
      storeRating(this.prisma, store.id),
      this.prisma.dispute.count({ where: { order: { storeId: store.id }, createdAt: { gte: since } } }),
    ]);
    const orders = totals._count._all;
    return {
      periodDays: 30,
      orders,
      salesMinor: totals._sum.totalMinor ?? 0,
      refundsMinor: totals._sum.refundedMinor ?? 0,
      averageOrderMinor: orders ? Math.round((totals._sum.totalMinor ?? 0) / orders) : 0,
      netEarnedMinor: (completed._sum.totalMinor ?? 0) - (completed._sum.refundedMinor ?? 0) - (completed._sum.feeMinor ?? 0),
      feesMinor: completed._sum.feeMinor ?? 0,
      disputes,
      rating,
      topProducts: top.map((t) => ({ productId: t.productId, title: t.title, quantity: t._sum.quantity ?? 0 })),
      lowStock,
    };
  }

  private async store(user: User, mustBeVerified = false) {
    const store = await this.prisma.store.findUnique({ where: { ownerId: user.id } });
    if (!store) throw new ForbiddenException("Create a store first");
    if (mustBeVerified && store.verificationStatus !== "VERIFIED") throw new ForbiddenException("Your store is waiting for verification");
    return store;
  }
}
