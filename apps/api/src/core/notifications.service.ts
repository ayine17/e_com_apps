import { Injectable } from "@nestjs/common";
import { MailService } from "./mail.service";
import { PrismaService, Tx } from "./prisma.service";

/**
 * orders: anything about the user's own orders and money.
 * alerts: price drops, back-in-stock and other optional updates.
 * security: logins and account changes — always emailed.
 */
export type NotifyCategory = "orders" | "alerts" | "security";

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService, private readonly mail: MailService) {}

  /** Records an in-app notification and emails it if the user wants that category. */
  async notify(userId: string, category: NotifyCategory, title: string, body: string, link?: string, tx: Tx = this.prisma) {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt) return;
    await tx.notification.create({ data: { userId, kind: category, title, body, link } });
    const prefs = (user.emailPrefs ?? {}) as Partial<Record<NotifyCategory, boolean>>;
    if (category === "security" || prefs[category] !== false) await this.mail.send(user.email, title, body);
  }
}
