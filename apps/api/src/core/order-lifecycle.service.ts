import { ConflictException, Injectable, Logger } from "@nestjs/common";
import { Order, OrderState, Prisma } from "@prisma/client";
import { applyBps, assertTransition, formatMoney } from "@market/shared";
import { Accounts, LedgerService } from "./ledger.service";
import { NotificationsService } from "./notifications.service";
import { PaymentProvider } from "./payments";
import { PrismaService, Tx } from "./prisma.service";
import { SettingsService } from "./settings.service";

type SettlementState = Extract<OrderState, "COMPLETED" | "REFUNDED" | "PARTIALLY_REFUNDED" | "CANCELLED">;

/**
 * The single place where orders change state and escrow money moves. Every state change is
 * checked against the shared state machine, applied with an optimistic lock on the current
 * state (so two requests or a request and a scheduled job can't both win), and logged.
 */
@Injectable()
export class OrderLifecycleService {
  private readonly log = new Logger(OrderLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly payments: PaymentProvider,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
  ) {}

  async transition(
    tx: Tx,
    order: Pick<Order, "id" | "state">,
    to: OrderState,
    actorId: string | null,
    note?: string,
    data: Prisma.OrderUpdateManyMutationInput = {},
  ): Promise<void> {
    assertTransition(order.state, to);
    const { count } = await tx.order.updateMany({ where: { id: order.id, state: order.state }, data: { ...data, state: to } });
    if (count !== 1) throw new ConflictException("This order was just updated by someone else. Refresh and try again.");
    await tx.orderEvent.create({ data: { orderId: order.id, fromState: order.state, toState: to, actorId, note } });
  }

  /**
   * Ends an order's escrow. `refundMinor` goes back to the buyer; the rest, less the platform
   * fee, goes to the seller. 0 = full release, total = full refund.
   *
   * The outcome is committed to the database first, guarded by the order's current state, so
   * two competing actions (a cancel and a shipment, a confirmation and a refund decision) can
   * never both pay out. The provider refund happens afterwards and is retried until it succeeds.
   */
  async settle(orderId: string, to: SettlementState, refundMinor: number, actorId: string | null, note: string): Promise<Order> {
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
    assertTransition(order.state, to);
    if (refundMinor < 0 || refundMinor > order.totalMinor) throw new ConflictException("Refund amount is out of range");
    if (to === "PARTIALLY_REFUNDED" && (refundMinor === 0 || refundMinor === order.totalMinor)) {
      throw new ConflictException("A partial refund must be more than zero and less than the order total");
    }
    if (refundMinor > 0 && !order.paymentRef) throw new ConflictException("Order has no payment to refund");

    const sellerGross = order.totalMinor - refundMinor;
    const fee = applyBps(sellerGross, await this.settings.get("PLATFORM_FEE_BPS"));

    await this.prisma.$transaction(async (tx) => {
      await this.transition(tx, order, to, actorId, note, {
        refundedMinor: refundMinor, feeMinor: fee, releaseAt: null, refundStatus: refundMinor > 0 ? "PENDING" : "NONE",
      });
      await this.ledger.post(tx, `${to.toLowerCase()} order ${order.id}`, order.currency, order.id, [
        { account: Accounts.escrow(order.id), amountMinor: order.totalMinor },
        { account: Accounts.providerCash, amountMinor: -refundMinor },
        { account: Accounts.sellerPayable(order.storeId), amountMinor: -(sellerGross - fee) },
        { account: Accounts.platformFees, amountMinor: -fee },
      ]);
      if (to === "CANCELLED") {
        for (const item of order.items) {
          await tx.product.update({ where: { id: item.productId }, data: { stock: { increment: item.quantity } } });
        }
      }
    });

    if (refundMinor > 0) await this.sendRefund(order.id);
    await this.notifySettlement(order, to, refundMinor, sellerGross - fee);
    return this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  }

  /** Sends a recorded refund to the provider. Safe to call repeatedly: the idempotency key is per order. */
  async sendRefund(orderId: string): Promise<boolean> {
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    if (order.refundStatus !== "PENDING" || !order.paymentRef) return order.refundStatus === "DONE";
    try {
      const res = await this.payments.refund({ chargeRef: order.paymentRef, amountMinor: order.refundedMinor, idempotencyKey: `refund:${order.id}` });
      if (!res.ok) throw new Error("Provider rejected the refund");
      await this.prisma.order.update({ where: { id: orderId }, data: { refundStatus: "DONE", refundError: null } });
      return true;
    } catch (e) {
      // Recorded, not thrown: the settlement itself is final and the retry job will finish the refund.
      this.log.warn(`Refund for order ${orderId} failed, will retry: ${(e as Error).message}`);
      await this.prisma.order.update({ where: { id: orderId }, data: { refundError: (e as Error).message.slice(0, 200) } });
      return false;
    }
  }

  private async notifySettlement(order: Order, to: SettlementState, refundMinor: number, sellerNet: number) {
    const store = await this.prisma.store.findUniqueOrThrow({ where: { id: order.storeId } });
    const ref = order.id.slice(0, 8);
    const link = `/orders/${order.id}`;
    const money = (m: number) => formatMoney(m, order.currency);
    if (refundMinor > 0) {
      await this.notifications.notify(order.buyerId, "orders", `Refund of ${money(refundMinor)} for order ${ref}`, `We've refunded ${money(refundMinor)} to your original payment method. It can take 5–10 days to appear.`, link);
    }
    if (sellerNet > 0) {
      await this.notifications.notify(store.ownerId, "orders", `${money(sellerNet)} released for order ${ref}`, `Funds for order ${ref} have been released to your balance after fees.`, link);
    } else if (to === "CANCELLED" || to === "REFUNDED") {
      await this.notifications.notify(store.ownerId, "orders", `Order ${ref} was ${to.toLowerCase()}`, `Order ${ref} has been ${to.toLowerCase()} and the buyer refunded.`, link);
    }
  }
}
