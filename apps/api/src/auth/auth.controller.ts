import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Throttle } from "@nestjs/throttler";
import { User } from "@prisma/client";
import { randomBytes } from "crypto";
import { Request, Response } from "express";
import { requestOtpSchema, verifyOtpSchema } from "@market/shared";
import { CurrentUser, Public, SESSION_COOKIE } from "../common/auth";
import { ZodPipe } from "../common/zod.pipe";
import { AppConfig, CONFIG } from "../config";
import { LoginCodesService } from "../core/login-codes.service";
import { NotificationsService } from "../core/notifications.service";
import { PrismaService } from "../core/prisma.service";

const SESSION_DAYS = 7;
export const DEVICE_COOKIE = "did";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly codes: LoginCodesService,
    private readonly notifications: NotificationsService,
    private readonly jwt: JwtService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Passwordless login, step 1: email a 6-digit code. Also used to confirm sensitive changes. */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("otp")
  @HttpCode(202)
  async requestCode(@Body(new ZodPipe(requestOtpSchema)) { email }: { email: string }) {
    await this.codes.issue(email);
    // Same response whether or not an account exists, so emails can't be enumerated.
    return { sent: true };
  }

  /** Step 2: exchange the code for a session cookie. Creates the account on first login. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("verify")
  async verify(@Body(new ZodPipe(verifyOtpSchema)) { email, code }: { email: string; code: string }, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.codes.consume(email, code);
    const user = await this.prisma.user.upsert({ where: { email }, update: {}, create: { email } });
    if (user.suspendedAt) throw new UnauthorizedException("This account is suspended. Contact support.");

    await this.trackDevice(user, req, res);
    const token = await this.jwt.signAsync({ sub: user.id }, { expiresIn: `${SESSION_DAYS}d` });
    res.cookie(SESSION_COOKIE, token, this.cookieOptions(SESSION_DAYS));
    return toMe(user);
  }

  @Public()
  @Post("logout")
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: "/" });
  }

  @Get("me")
  me(@CurrentUser() user: User) {
    return toMe(user);
  }

  /**
   * Spec section 6.4: alert on every login from a new device. The device id lives in a
   * long-lived cookie; the first device on an account doesn't trigger an alert.
   */
  private async trackDevice(user: User, req: Request, res: Response) {
    let deviceId: string | undefined = req.cookies?.[DEVICE_COOKIE];
    if (!deviceId || !/^[a-f0-9]{32}$/.test(deviceId)) {
      deviceId = randomBytes(16).toString("hex");
      res.cookie(DEVICE_COOKIE, deviceId, this.cookieOptions(730));
    }
    const userAgent = (req.headers["user-agent"] ?? "Unknown device").slice(0, 200);
    const existing = await this.prisma.knownDevice.findUnique({ where: { userId_deviceId: { userId: user.id, deviceId } } });
    if (existing) {
      await this.prisma.knownDevice.update({ where: { id: existing.id }, data: { lastSeen: new Date(), userAgent } });
      return;
    }
    const others = await this.prisma.knownDevice.count({ where: { userId: user.id } });
    await this.prisma.knownDevice.create({ data: { userId: user.id, deviceId, userAgent } });
    if (others > 0) {
      await this.notifications.notify(
        user.id,
        "security",
        "New login to your account",
        `Your account was just accessed from a new device (${userAgent}). If this wasn't you, contact support right away and don't share your login codes.`,
        "/account",
      );
    }
  }

  private cookieOptions(days: number) {
    return { httpOnly: true, sameSite: "lax" as const, secure: this.config.NODE_ENV === "production", maxAge: days * 24 * 60 * 60 * 1000, path: "/" };
  }
}

export function toMe(user: User) {
  return { id: user.id, email: user.email, name: user.name, roles: user.roles, emailPrefs: user.emailPrefs };
}
