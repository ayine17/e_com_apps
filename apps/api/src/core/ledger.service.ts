import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import { assertMinor } from "@market/shared";
import { PrismaService, Tx } from "./prisma.service";

export interface LedgerLine {
  account: string;
  /** Positive = debit, negative = credit. Lines in one transaction must sum to zero. */
  amountMinor: number;
}

/** Account names. Escrow is a liability, so a held order shows a negative balance. */
export const Accounts = {
  providerCash: "cash:provider",
  escrow: (orderId: string) => `escrow:order:${orderId}`,
  sellerPayable: (storeId: string) => `seller:${storeId}:payable`,
  platformFees: "platform:fees",
};

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async post(tx: Tx, memo: string, currency: string, orderId: string | null, lines: LedgerLine[]): Promise<void> {
    const nonZero = lines.filter((l) => l.amountMinor !== 0);
    nonZero.forEach((l) => assertMinor(l.amountMinor));
    const sum = nonZero.reduce((s, l) => s + l.amountMinor, 0);
    if (sum !== 0) throw new Error(`Unbalanced ledger transaction (${memo}): off by ${sum}`);
    const txnId = randomUUID();
    await tx.ledgerEntry.createMany({
      data: nonZero.map((l) => ({ txnId, account: l.account, amountMinor: l.amountMinor, currency, orderId, memo })),
    });
  }

  async balance(account: string, tx: Tx = this.prisma): Promise<number> {
    const r = await tx.ledgerEntry.aggregate({ where: { account }, _sum: { amountMinor: true } });
    return r._sum.amountMinor ?? 0;
  }

  async balanceByPrefix(prefix: string): Promise<number> {
    const r = await this.prisma.ledgerEntry.aggregate({ where: { account: { startsWith: prefix } }, _sum: { amountMinor: true } });
    return r._sum.amountMinor ?? 0;
  }
}
