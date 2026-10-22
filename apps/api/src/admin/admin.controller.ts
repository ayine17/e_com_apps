import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from "@nestjs/common";
import { Prisma, User } from "@prisma/client";
import { z } from "zod";
import { CurrentUser, Roles } from "../common/auth";
import { ZodPipe } from "../common/zod.pipe";
import { AuditService } from "../core/audit.service";
import { Accounts, LedgerService } from "../core/ledger.service";
import { NotificationsService } from "../core/notifications.service";
import { OrderLifecycleService } from "../core/order-lifecycle.service";
import { PrismaService } from "../core/prisma.service";
import { SETTING_DEFS, SettingKey, SettingsService } from "../core/settings.service";
import { DAY_MS } from "../config";

const verifySchema = z.object({ approve: z.boolean(), note: z.string().max(500).optional() });
const riskReviewSchema = z.object({ decision: z.enum(["clear", "cancel"]), note: z.string().max(500).optional() });
const productReviewSchema = z.object({ approve: z.boolean(), note: z.string().max(500).optional() });
const reportActionSchema = z.object({ action: z.enum(["dismiss", "remove_product", "suspend_user"]), note: z.string().max(500).optional() });

/** Admin console API (spec section 2.10). Every action is audit-logged. */
@Roles("ADMIN", "AGENT")
@Controller("admin")
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
  ) {}

  @Get("overview")
  async overview() {
    const [pendingStores, heldOrders, productsInReview, openReports, escalatedDisputes] = await Promise.all([
      this.prisma.store.count({ where: { verificationStatus: "PENDING" } }),
      this.prisma.order.count({ where: { riskHold: true, state: "PAID" } }),
      this.prisma.product.count({ where: { status: "PENDING_REVIEW" } }),
      this.prisma.report.count({ where: { status: "OPEN" } }),
      this.prisma.dispute.count({ where: { stage: "ESCALATED" } }),
    ]);
    return { pendingStores, heldOrders, productsInReview, openReports, escalatedDisputes };
  }

  // ---- Seller verification ----

  @Roles("ADMIN")
  @Get("stores")
  stores(@Query("status") status: "PENDING" | "VERIFIED" | "REJECTED" = "PENDING") {
    return this.prisma.store.findMany({ where: { verificationStatus: status }, include: { owner: { select: { id: true, email: true, name: true, createdAt: true } } }, orderBy: { createdAt: "asc" } });
  }

  @Roles("ADMIN")
  @Post("stores/:id/verify")
  async verifyStore(@CurrentUser() admin: User, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(verifySchema)) body: z.infer<typeof verifySchema>) {
    const store = await this.prisma.store.findUnique({ where: { id }, include: { owner: true } });
    if (!store) throw new NotFoundException();
    await this.prisma.$transaction(async (tx) => {
      await tx.store.update({ where: { id }, data: { verificationStatus: body.approve ? "VERIFIED" : "REJECTED" } });
      if (body.approve && !store.owner.roles.includes("SELLER")) {
        await tx.user.update({ where: { id: store.ownerId }, data: { roles: { push: "SELLER" } } });
      }
      await this.audit.record(admin.id, body.approve ? "store.verify" : "store.reject", id, { note: body.note ?? null }, tx);
    });
    await this.notifications.notify(store.ownerId, "orders", body.approve ? "Your store is verified" : "Your store couldn't be verified",
      body.approve ? "You can now list products." : `We couldn't verify your store. ${body.note ?? ""}`, "/sell");
    return { ok: true };
  }

  // ---- Fraud review queue ----

  @Get("orders/held")
  held() {
    return this.prisma.order.findMany({
      where: { riskHold: true, state: "PAID" },
      include: { buyer: { select: { id: true, email: true, createdAt: true } }, store: { select: { name: true } }, items: true },
      orderBy: { createdAt: "asc" },
    });
  }

  @Post("orders/:id/risk-review")
  async riskReview(@CurrentUser() admin: User, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(riskReviewSchema)) body: z.infer<typeof riskReviewSchema>) {
    const order = await this.prisma.order.findUnique({ where: { id }, include: { store: { include: { owner: true } } } });
    if (!order || !order.riskHold) throw new NotFoundException("No held order with that id");
    // Labels feed rule tuning now and model training later (spec section 6.1 step 4).
    await this.prisma.riskEvent.updateMany({ where: { subjectId: order.checkoutId }, data: { label: body.decision === "clear" ? "legit" : "fraud" } });
    await this.audit.record(admin.id, `order.risk_${body.decision}`, id, { note: body.note ?? null });
    if (body.decision === "cancel") {
      await this.prisma.order.update({ where: { id }, data: { riskHold: false } });
      return this.lifecycle.settle(id, "CANCELLED", order.totalMinor, admin.id, "Cancelled after fraud review");
    }
    // Give the seller a full handling window from the moment the hold is lifted.
    const days = order.shipBy ? Math.max(1, Math.round((order.shipBy.getTime() - order.createdAt.getTime()) / 86_400_000)) : 3;
    const updated = await this.prisma.order.update({ where: { id }, data: { riskHold: false, shipBy: new Date(Date.now() + days * 86_400_000) } });
    await this.notifications.notify(order.store.ownerId, "orders", `New order ${id.slice(0, 8)} is ready to ship`, "A new paid order has cleared review. Ship it from your seller dashboard.", `/orders/${id}`);
    return updated;
  }

  // ---- Listing moderation ----

  @Get("products/review")
  productsInReview() {
    return this.prisma.product.findMany({ where: { status: "PENDING_REVIEW" }, include: { store: { select: { name: true, createdAt: true } }, category: true }, orderBy: { updatedAt: "asc" } });
  }

  @Post("products/:id/review")
  async reviewProduct(@CurrentUser() admin: User, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(productReviewSchema)) body: z.infer<typeof productReviewSchema>) {
    const { count } = await this.prisma.product.updateMany({ where: { id, status: "PENDING_REVIEW" }, data: { status: body.approve ? "ACTIVE" : "REMOVED", reviewNote: body.note } });
    if (!count) throw new NotFoundException("No listing awaiting review with that id");
    await this.audit.record(admin.id, body.approve ? "product.approve" : "product.remove", id, { note: body.note ?? null });
    return { ok: true };
  }

  // ---- Reports ----

  @Get("reports")
  reports() {
    return this.prisma.report.findMany({ where: { status: "OPEN" }, include: { reporter: { select: { email: true } } }, orderBy: { createdAt: "asc" } });
  }

  @Post("reports/:id")
  async actOnReport(@CurrentUser() admin: User, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(reportActionSchema)) body: z.infer<typeof reportActionSchema>) {
    const report = await this.prisma.report.findUnique({ where: { id } });
    if (!report || report.status !== "OPEN") throw new NotFoundException();
    if (body.action === "remove_product") {
      if (report.targetType !== "PRODUCT") throw new ConflictException("This report isn't about a product");
      await this.prisma.product.update({ where: { id: report.targetId }, data: { status: "REMOVED", reviewNote: `Removed after report: ${report.reason}` } });
    }
    if (body.action === "suspend_user") {
      const userId = await this.reportedUserId(report.targetType, report.targetId);
      if (!admin.roles.includes("ADMIN")) throw new ConflictException("Only admins can suspend accounts");
      await this.prisma.user.update({ where: { id: userId }, data: { suspendedAt: new Date() } });
      await this.audit.record(admin.id, "user.suspend", userId, { reportId: id });
    }
    await this.prisma.report.update({ where: { id }, data: { status: body.action === "dismiss" ? "DISMISSED" : "ACTIONED", resolvedBy: admin.id } });
    await this.audit.record(admin.id, `report.${body.action}`, id, { note: body.note ?? null });
    return { ok: true };
  }

  // ---- Disputes ----

  @Get("disputes")
  disputes(@Query("stage") stage: "OPEN" | "ESCALATED" | "RESOLVED" = "ESCALATED") {
    return this.prisma.dispute.findMany({
      where: { stage },
      include: { order: { include: { items: true, store: { select: { name: true } }, shipment: { omit: { deliveryCodeHash: true } } } } },
      orderBy: { escalatedAt: "asc" },
    });
  }

  // ---- Finance ----

  @Roles("ADMIN")
  @Get("finance")
  async finance() {
    const [cash, fees, escrow, sellerPayable] = await Promise.all([
      this.ledger.balance(Accounts.providerCash),
      this.ledger.balance(Accounts.platformFees),
      this.ledger.balanceByPrefix("escrow:"),
      this.ledger.balanceByPrefix("seller:"),
    ]);
    const unbalanced = await this.prisma.$queryRaw<{ txnId: string }[]>(Prisma.sql`
      SELECT "txnId" FROM "LedgerEntry" GROUP BY "txnId" HAVING SUM("amountMinor") <> 0 LIMIT 10`);
    // Liabilities are stored as credits (negative); show them as positive amounts.
    return { providerCashMinor: cash, heldInEscrowMinor: -escrow, owedToSellersMinor: -sellerPayable, feesEarnedMinor: -fees, unbalancedTransactions: unbalanced.length };
  }

  @Roles("ADMIN")
  @Get("audit")
  auditLog() {
    return this.prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  }

  private async reportedUserId(type: string, targetId: string): Promise<string> {
    let userId: string | undefined;
    if (type === "USER") userId = (await this.prisma.user.findUnique({ where: { id: targetId } }))?.id;
    else if (type === "PRODUCT") userId = (await this.prisma.product.findUnique({ where: { id: targetId }, include: { store: true } }))?.store.ownerId;
    else userId = (await this.prisma.message.findUnique({ where: { id: targetId } }))?.senderId;
    if (!userId) throw new NotFoundException("The reported account or item no longer exists");
    return userId;
  }

  // ---- Settings (spec section 2.10) ----

  @Roles("ADMIN")
  @Get("settings")
  async getSettings() {
    const values = await this.settings.all();
    return Object.entries(SETTING_DEFS).map(([key, def]) => ({ key, ...def, value: values[key as SettingKey] }));
  }

  @Roles("ADMIN")
  @Put("settings/:key")
  async putSetting(@CurrentUser() admin: User, @Param("key") key: string, @Body(new ZodPipe(z.object({ value: z.number().int() }))) body: { value: number }) {
    const def = SETTING_DEFS[key as SettingKey];
    if (!def) throw new NotFoundException("Unknown setting");
    if (body.value < def.min || body.value > def.max) throw new BadRequestException(`Must be between ${def.min} and ${def.max}`);
    const before = await this.settings.get(key as SettingKey);
    await this.settings.set(key as SettingKey, body.value, admin.id);
    await this.audit.record(admin.id, "settings.update", key, { from: before, to: body.value });
    return { key, value: body.value };
  }

  // ---- Platform analytics (spec section 12) ----

  @Roles("ADMIN")
  @Get("analytics")
  async analytics(@Query("days") daysRaw?: string) {
    const days = Math.min(365, Math.max(1, Number(daysRaw) || 30));
    const since = new Date(Date.now() - days * DAY_MS);
    const placed = { createdAt: { gte: since }, state: { notIn: ["PENDING_PAYMENT", "CANCELLED"] as ("PENDING_PAYMENT" | "CANCELLED")[] } };
    const [gmv, settled, buyers, disputes, resolved, shipped, refunds, fraudCancelled] = await Promise.all([
      this.prisma.order.aggregate({ where: placed, _sum: { totalMinor: true }, _count: { _all: true } }),
      this.prisma.order.aggregate({ where: { updatedAt: { gte: since }, state: { in: ["COMPLETED", "PARTIALLY_REFUNDED"] } }, _sum: { feeMinor: true, totalMinor: true, refundedMinor: true } }),
      this.prisma.order.groupBy({ by: ["buyerId"], where: placed, _count: { _all: true } }),
      this.prisma.dispute.count({ where: { createdAt: { gte: since } } }),
      this.prisma.dispute.findMany({ where: { decidedAt: { gte: since } }, select: { createdAt: true, decidedAt: true } }),
      this.prisma.order.findMany({ where: { ...placed, shipment: { isNot: null } }, select: { shipBy: true, shipment: { select: { createdAt: true } } } }),
      this.prisma.order.aggregate({ where: { updatedAt: { gte: since }, refundedMinor: { gt: 0 } }, _sum: { refundedMinor: true }, _count: { _all: true } }),
      this.prisma.orderEvent.count({ where: { createdAt: { gte: since }, toState: "CANCELLED", note: { contains: "fraud" } } }),
    ]);
    const orders = gmv._count._all;
    const gmvMinor = gmv._sum.totalMinor ?? 0;
    const settledGross = (settled._sum.totalMinor ?? 0) - (settled._sum.refundedMinor ?? 0);
    const onTime = shipped.filter((o) => o.shipBy && o.shipment && o.shipment.createdAt <= o.shipBy).length;
    const resolutionHours = resolved.map((d) => (d.decidedAt!.getTime() - d.createdAt.getTime()) / 3_600_000).sort((a, b) => a - b);
    const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);
    return {
      periodDays: days,
      gmvMinor,
      orders,
      averageOrderMinor: orders ? Math.round(gmvMinor / orders) : 0,
      feesMinor: settled._sum.feeMinor ?? 0,
      takeRatePct: pct(settled._sum.feeMinor ?? 0, settledGross),
      buyers: buyers.length,
      repeatBuyerPct: pct(buyers.filter((b) => b._count._all > 1).length, buyers.length),
      onTimeShippingPct: pct(onTime, shipped.length),
      disputeRatePct: pct(disputes, orders),
      medianDisputeResolutionHours: resolutionHours.length ? Math.round(resolutionHours[Math.floor(resolutionHours.length / 2)]) : null,
      refundRatePct: pct(refunds._count._all, orders),
      refundsMinor: refunds._sum.refundedMinor ?? 0,
      fraudCancellations: fraudCancelled,
    };
  }

  // ---- Fraud rings (spec section 6.5) ----

  /** Accounts that share an address, device, or payout account with this user. */
  @Get("users/:id/links")
  async links(@Param("id", ParseUUIDPipe) id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, include: { addresses: true, devices: true, store: true } });
    if (!user) throw new NotFoundException();
    const fingerprints = user.addresses.map((a) => a.fingerprint);
    const devices = user.devices.map((d) => d.deviceId);
    const [byAddress, byDevice, byPayout] = await Promise.all([
      fingerprints.length ? this.prisma.address.findMany({ where: { fingerprint: { in: fingerprints }, userId: { not: id } }, distinct: ["userId"], select: { userId: true } }) : [],
      devices.length ? this.prisma.knownDevice.findMany({ where: { deviceId: { in: devices }, userId: { not: id } }, distinct: ["userId"], select: { userId: true } }) : [],
      user.store?.payoutAccountRef ? this.prisma.store.findMany({ where: { payoutAccountRef: user.store.payoutAccountRef, ownerId: { not: id } }, select: { ownerId: true } }) : [],
    ]);
    const reasons = new Map<string, string[]>();
    const add = (uid: string, why: string) => reasons.set(uid, [...(reasons.get(uid) ?? []), why]);
    byAddress.forEach((r) => add(r.userId, "same address"));
    byDevice.forEach((r) => add(r.userId, "same device"));
    byPayout.forEach((r) => add(r.ownerId, "same payout account"));
    const linked = await this.prisma.user.findMany({ where: { id: { in: [...reasons.keys()] } }, select: { id: true, email: true, createdAt: true, suspendedAt: true } });
    return {
      user: { id: user.id, email: user.email, suspendedAt: user.suspendedAt },
      linked: linked.map((u) => ({ ...u, reasons: reasons.get(u.id) })),
    };
  }

  @Roles("ADMIN")
  @Get("users")
  async findUsers(@Query("q") q = "") {
    if (q.trim().length < 3) return [];
    return this.prisma.user.findMany({
      where: { email: { contains: q.trim(), mode: "insensitive" } },
      select: { id: true, email: true, name: true, roles: true, createdAt: true, suspendedAt: true },
      take: 20,
    });
  }
}
