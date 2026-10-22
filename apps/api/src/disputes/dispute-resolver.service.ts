import { ConflictException, Injectable } from "@nestjs/common";
import { Dispute, Order } from "@prisma/client";
import { NotificationsService } from "../core/notifications.service";
import { OrderLifecycleService } from "../core/order-lifecycle.service";
import { PrismaService } from "../core/prisma.service";

export type DisputeOutcome = "RELEASE_TO_SELLER" | "FULL_REFUND" | "PARTIAL_REFUND";

@Injectable()
export class DisputeResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Shared by negotiation, withdrawal, agent decisions and the deadline job. */
  async resolve(dispute: Dispute, order: Order, outcome: DisputeOutcome, refundMinor: number, actorId: string | null, reasoning: string) {
    const to = outcome === "RELEASE_TO_SELLER" ? "COMPLETED" : outcome === "FULL_REFUND" ? "REFUNDED" : "PARTIALLY_REFUNDED";
    // Mark resolved first (guarded on the current stage) so concurrent resolutions can't both pay out.
    const { count } = await this.prisma.dispute.updateMany({
      where: { id: dispute.id, stage: { not: "RESOLVED" } },
      data: { stage: "RESOLVED", outcome, outcomeMinor: refundMinor, reasoning, decidedById: actorId, decidedAt: new Date() },
    });
    if (!count) throw new ConflictException("This dispute was just resolved");
    try {
      await this.lifecycle.settle(order.id, to, refundMinor, actorId, `Dispute resolved: ${reasoning}`);
    } catch (e) {
      await this.prisma.dispute.update({ where: { id: dispute.id }, data: { stage: dispute.stage, outcome: null, outcomeMinor: null, reasoning: null, decidedById: null, decidedAt: null } });
      throw e;
    }
    const store = await this.prisma.store.findUniqueOrThrow({ where: { id: order.storeId } });
    const text = `The dispute on order ${order.id.slice(0, 8)} is resolved: ${outcome.replace(/_/g, " ").toLowerCase()}.\n\nReason: ${reasoning}`;
    for (const userId of [order.buyerId, store.ownerId]) {
      await this.notifications.notify(userId, "orders", `Dispute resolved for order ${order.id.slice(0, 8)}`, text, `/orders/${order.id}`);
    }
    return this.prisma.dispute.findUniqueOrThrow({ where: { id: dispute.id } });
  }

}
