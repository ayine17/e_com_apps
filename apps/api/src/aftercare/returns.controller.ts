import { Body, ConflictException, Controller, ForbiddenException, NotFoundException, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { User } from "@prisma/client";
import { returnRequestSchema, returnShipmentSchema } from "@market/shared";
import { z } from "zod";
import { CurrentUser } from "../common/auth";
import { ZodPipe } from "../common/zod.pipe";
import { DAY_MS } from "../config";
import { NotificationsService } from "../core/notifications.service";
import { OrderLifecycleService } from "../core/order-lifecycle.service";
import { PrismaService } from "../core/prisma.service";
import { SettingsService } from "../core/settings.service";
import { loadOrderFor } from "../orders/order-access";
import { ReturnsService } from "./returns.service";

/**
 * Returns (spec section 2.6). Change-of-mind returns follow the seller's policy and refund the
 * items only; faulty or wrong items can always be returned for a full refund.
 */
@Controller()
export class ReturnsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly returns: ReturnsService,
  ) {}

  @Post("orders/:id/returns")
  async request(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(returnRequestSchema)) body: z.infer<typeof returnRequestSchema>) {
    const { order, role } = await loadOrderFor(this.prisma, user, id);
    if (role !== "buyer") throw new ForbiddenException("Only the buyer can return this order");
    if (order.state !== "DELIVERED") throw new ConflictException("Returns can be requested after delivery and before payment is released");

    const changeOfMind = body.reason === "CHANGE_OF_MIND";
    if (changeOfMind) {
      const shipment = await this.prisma.shipment.findUnique({ where: { orderId: id } });
      const days = order.store.returnPolicyDays;
      if (!days) throw new ConflictException("This seller doesn't accept change-of-mind returns. If the item is faulty, choose that reason instead.");
      if (shipment?.deliveredAt && Date.now() - shipment.deliveredAt.getTime() > days * DAY_MS) {
        throw new ConflictException(`The ${days}-day return window has passed`);
      }
    }
    // Change of mind: items back, original delivery not refunded, buyer pays return postage.
    const refundMinor = changeOfMind ? order.subtotalMinor - order.discountMinor : order.totalMinor;

    const ret = await this.prisma.$transaction(async (tx) => {
      await this.lifecycle.transition(tx, order, "RETURN_REQUESTED", user.id, `Return requested: ${body.reason}`, { releaseAt: null });
      return tx.returnRequest.create({
        data: { orderId: id, reason: body.reason, description: body.description, evidence: body.evidence, returnPaidBy: changeOfMind ? "BUYER" : "SELLER", refundMinor },
      });
    });
    await this.notifications.notify(order.store.ownerId, "orders", `Return requested for order ${id.slice(0, 8)}`,
      `The buyer is returning this order (${body.reason.replace(/_/g, " ").toLowerCase()}). Payment stays in escrow until the return is settled.`, `/orders/${id}`);
    return ret;
  }

  /** Buyer adds tracking for the parcel going back. The seller then has a fixed time to confirm or dispute. */
  @Post("returns/:id/ship")
  async ship(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(returnShipmentSchema)) body: z.infer<typeof returnShipmentSchema>) {
    const { ret, role } = await this.load(user, id);
    if (role !== "buyer") throw new ForbiddenException("Only the buyer can ship the return");
    const days = await this.settings.get("RETURN_CONFIRM_DAYS");
    const autoRefundAt = new Date(Date.now() + days * DAY_MS);
    const { count } = await this.prisma.returnRequest.updateMany({
      where: { id, status: "REQUESTED" },
      data: { status: "SHIPPED_BACK", carrier: body.carrier, trackingNumber: body.trackingNumber, shippedBackAt: new Date(), autoRefundAt },
    });
    if (!count) throw new ConflictException("This return has already been shipped");
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: ret.orderId }, include: { store: true } });
    await this.notifications.notify(order.store.ownerId, "orders", `Return for order ${order.id.slice(0, 8)} is on its way`,
      `Tracking: ${body.carrier} ${body.trackingNumber}. Confirm when it arrives, or report a problem, by ${autoRefundAt.toDateString()}. After that the buyer is refunded automatically.`, `/orders/${order.id}`);
    return this.prisma.returnRequest.findUniqueOrThrow({ where: { id } });
  }

  /** Seller confirms the item came back in acceptable condition: the buyer is refunded. */
  @Post("returns/:id/receive")
  async receive(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string) {
    const { ret, role } = await this.load(user, id);
    if (role !== "seller") throw new ForbiddenException("Only the seller can confirm the return arrived");
    if (ret.status !== "SHIPPED_BACK") throw new ConflictException("The buyer hasn't shipped this return yet");
    return this.returns.refund(ret.id, user.id, "Seller confirmed the return arrived");
  }

  /** Seller reports the return arrived damaged, used or not at all: the resolution team decides. */
  @Post("returns/:id/dispute")
  async dispute(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(z.object({ description: z.string().trim().min(10).max(3000), evidence: z.array(z.string().max(500)).max(10).default([]) }))) body: { description: string; evidence: string[] }) {
    const { ret, order, role } = await this.load(user, id);
    if (role !== "seller") throw new ForbiddenException("Only the seller can dispute a return");
    if (ret.status !== "SHIPPED_BACK") throw new ConflictException("You can report a problem once the buyer has shipped the return");
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.returnRequest.updateMany({ where: { id, status: "SHIPPED_BACK" }, data: { status: "REJECTED", autoRefundAt: null } });
      if (!count) throw new ConflictException("This return was just settled");
      await this.lifecycle.transition(tx, order, "DISPUTED", user.id, "Seller disputed the returned item");
      // Goes straight to the resolution team: buyer and seller have already disagreed.
      await tx.dispute.create({
        data: {
          orderId: order.id, openedById: user.id, reason: "RETURN_PROBLEM", description: body.description, evidence: body.evidence,
          previousState: "RETURN_REQUESTED", sellerRespondBy: new Date(), stage: "ESCALATED", escalatedAt: new Date(),
        },
      });
    });
    await this.notifications.notify(order.buyerId, "orders", `The seller reported a problem with your return`,
      `Our resolution team will review the return for order ${order.id.slice(0, 8)} and decide within 5 business days.`, `/orders/${order.id}`);
    return { disputed: true };
  }

  private async load(user: User, returnId: string) {
    const ret = await this.prisma.returnRequest.findUnique({ where: { id: returnId } });
    if (!ret) throw new NotFoundException("Return not found");
    const { order, role } = await loadOrderFor(this.prisma, user, ret.orderId);
    return { ret, order, role };
  }
}
