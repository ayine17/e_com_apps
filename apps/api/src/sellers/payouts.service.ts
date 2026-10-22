import { ConflictException, Injectable, Logger } from "@nestjs/common";
import { formatMoney } from "@market/shared";
import { Accounts, LedgerService } from "../core/ledger.service";
import { NotificationsService } from "../core/notifications.service";
import { PaymentProvider } from "../core/payments";
import { PrismaService } from "../core/prisma.service";
import { loadConfig } from "../config";

/** Smallest amount worth paying out, to avoid tiny transfers and their fees. */
export const MIN_PAYOUT_MINOR = 1000;

@Injectable()
export class PayoutsService {
  private readonly log = new Logger(PayoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly payments: PaymentProvider,
    private readonly notifications: NotificationsService,
  ) {}

  /** Available balance for a store, as a positive amount (the ledger stores it as a credit). */
  async available(storeId: string): Promise<number> {
    return -(await this.ledger.balance(Accounts.sellerPayable(storeId)));
  }

  /**
   * Pays a store's whole available balance to its payout account (spec section 2.4).
   * The ledger entry and payout record are written first, under a row lock on the store so
   * two payouts can't both spend the same balance; the transfer follows.
   */
  async payOut(storeId: string): Promise<{ id: string; amountMinor: number; status: string }> {
    const currency = loadConfig().PLATFORM_CURRENCY;
    const payout = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Store" WHERE id = ${storeId}::uuid FOR UPDATE`;
      const store = await tx.store.findUniqueOrThrow({ where: { id: storeId } });
      if (!store.payoutAccountRef) throw new ConflictException("Add a payout account first");
      if (store.payoutHoldUntil && store.payoutHoldUntil > new Date()) {
        throw new ConflictException(`Payouts are paused until ${store.payoutHoldUntil.toUTCString()} because your payout account changed recently`);
      }
      const amount = -(await this.ledger.balance(Accounts.sellerPayable(storeId), tx));
      if (amount < MIN_PAYOUT_MINOR) throw new ConflictException(`Your balance must be at least ${formatMoney(MIN_PAYOUT_MINOR, currency)} to pay out`);
      const p = await tx.payout.create({ data: { storeId, amountMinor: amount, currency, destination: store.payoutAccountRef } });
      await this.ledger.post(tx, `payout ${p.id}`, currency, null, [
        { account: Accounts.sellerPayable(storeId), amountMinor: amount },
        { account: Accounts.providerCash, amountMinor: -amount },
      ]);
      return p;
    });

    const res = await this.payments
      .transfer({ destination: payout.destination, amountMinor: payout.amountMinor, currency, idempotencyKey: `payout:${payout.id}` })
      .catch((e: Error) => ({ ok: false, ref: undefined, error: e.message }));
    const store = await this.prisma.store.findUniqueOrThrow({ where: { id: storeId } });
    if (res.ok) {
      await this.prisma.payout.update({ where: { id: payout.id }, data: { status: "PAID", providerRef: res.ref, paidAt: new Date() } });
      await this.notifications.notify(store.ownerId, "orders", `Payout of ${formatMoney(payout.amountMinor, currency)} sent`, `We've sent ${formatMoney(payout.amountMinor, currency)} to your payout account. It usually arrives in 1–2 business days.`, "/sell");
      return { id: payout.id, amountMinor: payout.amountMinor, status: "PAID" };
    }
    // Put the money back in the seller's balance so the next payout picks it up.
    await this.prisma.$transaction(async (tx) => {
      await tx.payout.update({ where: { id: payout.id }, data: { status: "FAILED", error: "Transfer failed" } });
      await this.ledger.post(tx, `reverse failed payout ${payout.id}`, currency, null, [
        { account: Accounts.providerCash, amountMinor: payout.amountMinor },
        { account: Accounts.sellerPayable(storeId), amountMinor: -payout.amountMinor },
      ]);
    });
    this.log.warn(`Payout ${payout.id} failed`);
    return { id: payout.id, amountMinor: payout.amountMinor, status: "FAILED" };
  }

  /** Daily automatic payouts for every eligible store. */
  async payOutAll(): Promise<number> {
    const stores = await this.prisma.store.findMany({
      where: { payoutAccountRef: { not: null }, OR: [{ payoutHoldUntil: null }, { payoutHoldUntil: { lte: new Date() } }] },
      select: { id: true },
    });
    let paid = 0;
    for (const s of stores) {
      if ((await this.available(s.id)) < MIN_PAYOUT_MINOR) continue;
      try {
        if ((await this.payOut(s.id)).status === "PAID") paid++;
      } catch (e) {
        this.log.warn(`Automatic payout for store ${s.id} skipped: ${(e as Error).message}`);
      }
    }
    return paid;
  }
}
