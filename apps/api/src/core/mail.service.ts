import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "./prisma.service";

/**
 * Email sender. In this MVP every email is written to the EmailOutbox table, which the
 * development inbox page reads. Swap the body of `send` for Postmark/SES in production.
 */
@Injectable()
export class MailService {
  private readonly log = new Logger(MailService.name);

  constructor(private readonly prisma: PrismaService) {}

  async send(to: string, subject: string, body: string): Promise<void> {
    await this.prisma.emailOutbox.create({ data: { to, subject, body } });
    this.log.log(`Email queued to ${maskEmail(to)}: ${subject}`);
  }
}

/** Keeps personal data out of logs. */
export function maskEmail(email: string): string {
  const [name, domain] = email.split("@");
  return `${name.slice(0, 2)}***@${domain}`;
}
