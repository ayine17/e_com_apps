import { HttpException, HttpStatus, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { createHmac, randomInt, timingSafeEqual } from "crypto";
import { AppConfig, CONFIG } from "../config";
import { MailService } from "./mail.service";
import { PrismaService } from "./prisma.service";

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 5;

/** One-time email codes, used for login and to confirm sensitive changes such as the payout account. */
@Injectable()
export class LoginCodesService {
  constructor(private readonly prisma: PrismaService, private readonly mail: MailService, @Inject(CONFIG) private readonly config: AppConfig) {}

  async issue(email: string, purpose = "login"): Promise<void> {
    const recent = await this.prisma.otpCode.count({ where: { email, createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } } });
    if (recent >= MAX_CODES_PER_HOUR) throw new HttpException("Too many codes requested. Try again in an hour.", HttpStatus.TOO_MANY_REQUESTS);
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    await this.prisma.otpCode.create({ data: { email, codeHash: this.hash(email, code), expiresAt: new Date(Date.now() + CODE_TTL_MS) } });
    const what = purpose === "login" ? "login code" : `code to confirm: ${purpose}`;
    await this.mail.send(email, `Your ${what}: ${code}`, `Your code is ${code}. It expires in 10 minutes. If you didn't ask for it, ignore this email and don't share it with anyone.`);
  }

  /** Consumes a valid code or throws. Wrong guesses count towards a lockout. */
  async consume(email: string, code: string): Promise<void> {
    const otp = await this.prisma.otpCode.findFirst({
      where: { email, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    if (!otp || otp.attempts >= MAX_ATTEMPTS) throw new UnauthorizedException("Code expired. Request a new one.");
    const ok = timingSafeEqual(Buffer.from(otp.codeHash, "hex"), Buffer.from(this.hash(email, code), "hex"));
    if (!ok) {
      await this.prisma.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      throw new UnauthorizedException("That code isn't right");
    }
    // Conditional update: two requests racing with the same code can't both succeed.
    const { count } = await this.prisma.otpCode.updateMany({ where: { id: otp.id, usedAt: null }, data: { usedAt: new Date() } });
    if (!count) throw new UnauthorizedException("Code already used. Request a new one.");
  }

  private hash(email: string, code: string): string {
    return createHmac("sha256", this.config.JWT_SECRET).update(`${email}:${code}`).digest("hex");
  }
}
