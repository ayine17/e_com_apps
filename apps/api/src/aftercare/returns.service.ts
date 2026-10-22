import { ConflictException, Injectable } from "@nestjs/common";
import { formatMoney } from "@market/shared";
import { OrderLifecycleService } from "../core/order-lifecycle.service";
import { PrismaService } from "../core/prisma.service";

@Injectable()
export class ReturnsService {
  constructor(private readonly prisma: PrismaService, private readonly lifecycle: OrderLifecycleService) {}

  /** Shared by seller confirmation and the auto-refund job. */
  async refund(returnId: string, actorId: string | null, note: string) {
    const ret = await this.prisma.returnRequest.findUniqueOrThrow({ where: { id: returnId }, include: { order: true } });
    const { count } = await this.prisma.returnRequest.updateMany({ where: { id: returnId, status: "SHIPPED_BACK" }, data: { status: "RECEIVED", autoRefundAt: null } });
    if (!count) throw new ConflictException("This return was just settled");
    const to = ret.refundMinor >= ret.order.totalMinor ? "REFUNDED" : "PARTIALLY_REFUNDED";
    try {
      return await this.lifecycle.settle(ret.orderId, to, ret.refundMinor, actorId, `${note}. Refund ${formatMoney(ret.refundMinor, ret.order.currency)}`);
    } catch (e) {
      await this.prisma.returnRequest.update({ where: { id: returnId }, data: { status: "SHIPPED_BACK", autoRefundAt: ret.autoRefundAt } });
      throw e;
    }
  }


  /** The buyer asked to return but never shipped it back: the return lapses and the seller is paid. */
  async lapse(returnId: string) {
    const ret = await this.prisma.returnRequest.findUniqueOrThrow({ where: { id: returnId } });
    const { count } = await this.prisma.returnRequest.updateMany({ where: { id: returnId, status: "REQUESTED" }, data: { status: "REJECTED" } });
    if (!count) return;
    await this.lifecycle.settle(ret.orderId, "COMPLETED", 0, null, "Return was never shipped back");
  }
}
