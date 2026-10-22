import { Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { User } from "@prisma/client";
import {
  disputeDecisionSchema, DisputeDecisionInput, disputeOfferSchema, DisputeOfferInput, formatMoney, openDisputeSchema, OpenDisputeInput,
} from "@market/shared";
import { CurrentUser, Roles } from "../common/auth";
import { ZodPipe } from "../common/zod.pipe";
import { DAY_MS } from "../config";
import { AuditService } from "../core/audit.service";
import { NotificationsService } from "../core/notifications.service";
import { SettingsService } from "../core/settings.service";
import { OrderLifecycleService } from "../core/order-lifecycle.service";
import { PrismaService } from "../core/prisma.service";
import { loadOrderFor } from "../orders/order-access";
import { DisputeResolver } from "./dispute-resolver.service";

/** Dispute process, spec section 2.8: open → negotiate → escalate → decide. */
@Controller()
export class DisputesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly resolver: DisputeResolver,
  ) {}

  @Post("orders/:id/disputes")
  async open(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(openDisputeSchema)) body: OpenDisputeInput) {
    const { order, role } = await loadOrderFor(this.prisma, user, id);
    if (role !== "buyer") throw new ForbiddenException("Only the buyer can open a dispute");
    if (!["SHIPPED", "DELIVERED"].includes(order.state)) throw new ConflictException("You can only open a dispute after the order has shipped and before payment is released");
    if (await this.prisma.dispute.findUnique({ where: { orderId: id } })) throw new ConflictException("This order already has a dispute");

    const sellerRespondBy = new Date(Date.now() + (await this.settings.get("DISPUTE_RESPONSE_DAYS")) * DAY_MS);
    const dispute = await this.prisma.$transaction(async (tx) => {
      // Moving to DISPUTED pauses auto-release: the release job only looks at DELIVERED orders.
      await this.lifecycle.transition(tx, order, "DISPUTED", user.id, `Dispute opened: ${body.reason}`);
      return tx.dispute.create({
        data: { orderId: id, openedById: user.id, reason: body.reason, description: body.description, evidence: body.evidence, previousState: order.state, sellerRespondBy },
      });
    });
    await this.notifications.notify(order.store.ownerId, "orders", `Dispute opened on order ${id.slice(0, 8)}`, `The buyer reported a problem: ${body.reason.replace(/_/g, " ").toLowerCase()}. Respond with an offer by ${sellerRespondBy.toDateString()}, or the buyer will be refunded automatically.`, `/orders/${id}`);
    return dispute;
  }

  @Get("disputes/:id")
  async get(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string) {
    const { dispute, role } = await this.load(user, id);
    return { ...dispute, role };
  }

  /** Seller proposes a full or partial refund. */
  @Post("disputes/:id/offer")
  async offer(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(disputeOfferSchema)) body: DisputeOfferInput) {
    const { dispute, order, role } = await this.load(user, id);
    if (role !== "seller") throw new ForbiddenException("Only the seller can make an offer");
    if (dispute.stage !== "OPEN") throw new ConflictException("This dispute is with the resolution team");
    const amount = body.kind === "FULL_REFUND" ? order.totalMinor : body.amountMinor;
    if (body.kind === "PARTIAL_REFUND" && (!amount || amount >= order.totalMinor)) {
      throw new ConflictException("A partial refund must be more than zero and less than the order total");
    }
    const updated = await this.prisma.dispute.update({ where: { id }, data: { offerKind: body.kind, offerMinor: amount, offerNote: body.note, offerDeclined: false } });
    await this.notifications.notify(order.buyerId, "orders", `The seller made an offer on order ${order.id.slice(0, 8)}`, `The seller offered a refund of ${formatMoney(amount!, order.currency)}. Accept or decline it from your order page.`, `/orders/${order.id}`);
    return updated;
  }

  @Post("disputes/:id/accept")
  async accept(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string) {
    const { dispute, order, role } = await this.load(user, id);
    if (role !== "buyer") throw new ForbiddenException("Only the buyer can accept an offer");
    if (dispute.stage !== "OPEN" || !dispute.offerMinor || dispute.offerDeclined) throw new ConflictException("There's no open offer to accept");
    const full = dispute.offerMinor >= order.totalMinor;
    return this.resolver.resolve(dispute, order, full ? "FULL_REFUND" : "PARTIAL_REFUND", dispute.offerMinor, user.id, "Buyer accepted seller's offer");
  }

  @Post("disputes/:id/decline")
  async decline(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string) {
    const { dispute, role } = await this.load(user, id);
    if (role !== "buyer") throw new ForbiddenException("Only the buyer can decline an offer");
    if (dispute.stage !== "OPEN" || !dispute.offerMinor) throw new ConflictException("There's no open offer to decline");
    return this.prisma.dispute.update({ where: { id }, data: { offerDeclined: true } });
  }

  /** Buyer is satisfied after all: release payment to the seller. */
  @Post("disputes/:id/withdraw")
  async withdraw(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string) {
    const { dispute, order, role } = await this.load(user, id);
    if (role !== "buyer") throw new ForbiddenException("Only the buyer can withdraw a dispute");
    if (dispute.stage === "RESOLVED") throw new ConflictException("This dispute is already resolved");
    return this.resolver.resolve(dispute, order, "RELEASE_TO_SELLER", 0, user.id, "Buyer withdrew the dispute");
  }

  @Post("disputes/:id/escalate")
  async escalate(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string) {
    const { dispute, role } = await this.load(user, id);
    if (role === "staff") throw new ForbiddenException();
    if (dispute.stage !== "OPEN") throw new ConflictException("This dispute is already with the resolution team or resolved");
    // The seller may escalate at any time; the buyer after declining an offer or once the seller's deadline passes.
    const buyerMayEscalate = dispute.offerDeclined || dispute.sellerRespondBy < new Date();
    if (role === "buyer" && !buyerMayEscalate) {
      throw new ConflictException(`The seller has until ${dispute.sellerRespondBy.toDateString()} to respond before you can escalate`);
    }
    return this.prisma.dispute.update({ where: { id }, data: { stage: "ESCALATED", escalatedAt: new Date() } });
  }

  @Roles("AGENT", "ADMIN")
  @Post("disputes/:id/decide")
  async decide(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(disputeDecisionSchema)) body: DisputeDecisionInput) {
    const { dispute, order } = await this.load(user, id);
    if (dispute.stage === "RESOLVED") throw new ConflictException("This dispute is already resolved");
    const amount = body.outcome === "FULL_REFUND" ? order.totalMinor : body.outcome === "PARTIAL_REFUND" ? body.amountMinor ?? 0 : 0;
    if (body.outcome === "PARTIAL_REFUND" && (amount <= 0 || amount >= order.totalMinor)) {
      throw new ConflictException("A partial refund must be more than zero and less than the order total");
    }
    const result = await this.resolver.resolve(dispute, order, body.outcome, amount, user.id, body.reasoning);
    await this.audit.record(user.id, "dispute.decide", id, { outcome: body.outcome, amountMinor: amount });
    return result;
  }

  private async load(user: User, disputeId: string) {
    const dispute = await this.prisma.dispute.findUnique({ where: { id: disputeId } });
    if (!dispute) throw new NotFoundException("Dispute not found");
    const { order, role } = await loadOrderFor(this.prisma, user, dispute.orderId);
    return { dispute, order, role };
  }
}
