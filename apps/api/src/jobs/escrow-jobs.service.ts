import { Inject, Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { AppConfig, CONFIG } from "../config";
import { OrderLifecycleService } from "../core/order-lifecycle.service";
import { PrismaService } from "../core/prisma.service";
import { DisputeResolver } from "../disputes/dispute-resolver.service";
import { ReturnsService } from "../aftercare/returns.service";
import { CheckoutService } from "../orders/checkout.service";
import { PayoutsService } from "../sellers/payouts.service";
import { SettingsService } from "../core/settings.service";
import { DAY_MS } from "../config";

const BATCH = 100;

/**
 * Time-based escrow rules. Each job is safe to run on several servers at once: every
 * change goes through the lifecycle's optimistic state check, so only one run wins.
 */
@Injectable()
export class EscrowJobs {
  private readonly log = new Logger(EscrowJobs.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly disputes: DisputeResolver,
    private readonly returns: ReturnsService,
    private readonly checkout: CheckoutService,
    private readonly payouts: PayoutsService,
    private readonly settings: SettingsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async runAll() {
    if (this.config.NODE_ENV === "test") return; // tests call the jobs directly
    await this.autoRelease();
    await this.cancelUnshipped();
    await this.resolveUnansweredDisputes();
    await this.retryRefunds();
    await this.checkout.recoverPendingPayments();
    await this.settleReturns();
  }

  /** Daily automatic payouts of released funds to sellers. */
  @Cron("0 6 * * *")
  async dailyPayouts() {
    if (this.config.NODE_ENV === "test") return;
    const n = await this.payouts.payOutAll();
    if (n) this.log.log(`Paid out ${n} stores`);
  }

  /** Finishes refunds that were recorded but not yet accepted by the payment provider. */
  async retryRefunds(now = new Date()): Promise<number> {
    const due = await this.prisma.order.findMany({
      where: { refundStatus: "PENDING", updatedAt: { lte: new Date(now.getTime() - 60_000) } },
      select: { id: true },
      take: BATCH,
    });
    let done = 0;
    for (const o of due) if (await this.lifecycle.sendRefund(o.id)) done++;
    return done;
  }

  /**
   * Returns: refund the buyer if the seller doesn't confirm or dispute in time; release to the
   * seller if the buyer never ships the item back.
   */
  async settleReturns(now = new Date()): Promise<number> {
    const confirmDays = await this.settings.get("RETURN_CONFIRM_DAYS");
    const [unanswered, unshipped] = await Promise.all([
      this.prisma.returnRequest.findMany({ where: { status: "SHIPPED_BACK", autoRefundAt: { lte: now } }, select: { id: true }, take: BATCH }),
      this.prisma.returnRequest.findMany({ where: { status: "REQUESTED", createdAt: { lte: new Date(now.getTime() - confirmDays * DAY_MS) } }, select: { id: true }, take: BATCH }),
    ]);
    return (
      (await this.each(unanswered, (r) => this.returns.refund(r.id, null, "Seller didn't confirm the return in time"))) +
      (await this.each(unshipped, (r) => this.returns.lapse(r.id)))
    );
  }

  /** Releases escrow once the protection window after delivery has passed with no dispute. */
  async autoRelease(now = new Date()): Promise<number> {
    const due = await this.prisma.order.findMany({ where: { state: "DELIVERED", releaseAt: { lte: now } }, select: { id: true }, take: BATCH });
    return this.each(due, (o) => this.lifecycle.settle(o.id, "COMPLETED", 0, null, "Auto-released after protection window"));
  }

  /** Refunds paid orders the seller didn't ship within the handling time. */
  async cancelUnshipped(now = new Date()): Promise<number> {
    const due = await this.prisma.order.findMany({ where: { state: "PAID", riskHold: false, shipBy: { lte: now } }, select: { id: true, totalMinor: true }, take: BATCH });
    return this.each(due, (o) => this.lifecycle.settle(o.id, "CANCELLED", o.totalMinor, null, "Seller did not ship in time"));
  }

  /** The buyer wins by default when the seller ignores a dispute past the deadline. */
  async resolveUnansweredDisputes(now = new Date()): Promise<number> {
    const due = await this.prisma.dispute.findMany({
      where: { stage: "OPEN", offerMinor: null, sellerRespondBy: { lte: now } },
      include: { order: true },
      take: BATCH,
    });
    return this.each(due, (d) => this.disputes.resolve(d, d.order, "FULL_REFUND", d.order.totalMinor, null, "Seller did not respond before the deadline"));
  }

  private async each<T>(items: T[], fn: (item: T) => Promise<unknown>): Promise<number> {
    let done = 0;
    for (const item of items) {
      try {
        await fn(item);
        done++;
      } catch (e) {
        this.log.warn(`Escrow job step failed: ${(e as Error).message}`);
      }
    }
    return done;
  }
}
