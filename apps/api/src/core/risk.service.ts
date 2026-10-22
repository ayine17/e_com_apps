import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { CheckoutSignals, RiskResult, scoreCheckout } from "@market/shared";
import { AppConfig, CONFIG, DAY_MS } from "../config";
import { PrismaService } from "./prisma.service";

@Injectable()
export class RiskService {
  constructor(private readonly prisma: PrismaService, @Inject(CONFIG) private readonly config: AppConfig) {}

  /** Gathers checkout signals for the fraud rules (spec section 6.3). */
  async checkoutSignals(userId: string, addressFingerprint: string, orderTotalMinor: number): Promise<CheckoutSignals> {
    const now = Date.now();
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const [failedPayments, otherAccounts, linkedSuspended, completedOrders, disputesOpened] = await Promise.all([
      this.prisma.paymentAttempt.count({
        where: { userId, succeeded: false, createdAt: { gte: new Date(now - 60 * 60 * 1000) } },
      }),
      this.prisma.address.findMany({
        where: { fingerprint: addressFingerprint, userId: { not: userId }, createdAt: { gte: new Date(now - 30 * DAY_MS) } },
        distinct: ["userId"],
        select: { userId: true },
      }),
      this.prisma.address.count({
        where: { fingerprint: addressFingerprint, userId: { not: userId }, user: { suspendedAt: { not: null } } },
      }),
      this.prisma.order.count({ where: { buyerId: userId, state: "COMPLETED" } }),
      this.prisma.dispute.count({ where: { openedById: userId } }),
    ]);
    return {
      accountAgeHours: (now - user.createdAt.getTime()) / (60 * 60 * 1000),
      orderTotalMinor,
      highValueThresholdMinor: this.config.HIGH_VALUE_THRESHOLD_MINOR,
      failedPaymentsLastHour: failedPayments,
      linkedToSuspendedUser: linkedSuspended > 0,
      providerElevatedRisk: false,
      otherAccountsOnAddress30d: otherAccounts.length,
      completedOrders,
      disputesOpened,
    };
  }

  score(signals: CheckoutSignals): RiskResult {
    return scoreCheckout(signals);
  }

  record(kind: string, userId: string, subjectId: string | null, result: RiskResult) {
    return this.prisma.riskEvent.create({
      data: { kind, userId, subjectId, score: result.score, action: result.action, hits: result.hits as unknown as Prisma.InputJsonValue },
    });
  }
}

/** Normalises an address so the same place typed differently still matches. */
export function addressFingerprint(a: { line1: string; city: string; postcode?: string | null; country: string }): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return [norm(a.line1), norm(a.city), norm(a.postcode ?? ""), a.country.toUpperCase()].join("|");
}
