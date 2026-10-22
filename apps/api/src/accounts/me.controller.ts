import { Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Res } from "@nestjs/common";
import { User } from "@prisma/client";
import { Response } from "express";
import { notificationPrefsSchema } from "@market/shared";
import { z } from "zod";
import { CurrentUser, SESSION_COOKIE } from "../common/auth";
import { ZodPipe } from "../common/zod.pipe";
import { AuditService } from "../core/audit.service";
import { Accounts, LedgerService } from "../core/ledger.service";
import { PrismaService } from "../core/prisma.service";

const ACTIVE_STATES = ["PENDING_PAYMENT", "PAID", "SHIPPED", "DELIVERED", "RETURN_REQUESTED", "DISPUTED"] as const;

/** The signed-in user's own data: wishlist, notifications, devices, privacy. */
@Controller("me")
export class MeController {
  constructor(private readonly prisma: PrismaService, private readonly ledger: LedgerService, private readonly audit: AuditService) {}

  // ---- Wishlist (spec section 2.2) ----

  @Get("wishlist")
  async wishlist(@CurrentUser() user: User) {
    const items = await this.prisma.wishlistItem.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      include: { product: { include: { store: { select: { id: true, name: true, slug: true, city: true, country: true, lat: true, lng: true } } } } },
    });
    return items.filter((i) => i.product.status !== "REMOVED");
  }

  @Get("wishlist/ids")
  async wishlistIds(@CurrentUser() user: User) {
    const rows = await this.prisma.wishlistItem.findMany({ where: { userId: user.id }, select: { productId: true } });
    return rows.map((r) => r.productId);
  }

  @Put("wishlist/:productId")
  @HttpCode(204)
  async save(@CurrentUser() user: User, @Param("productId", ParseUUIDPipe) productId: string) {
    const product = await this.prisma.product.findFirst({ where: { id: productId, status: "ACTIVE" } });
    if (!product) throw new NotFoundException("Product not found");
    if ((await this.prisma.wishlistItem.count({ where: { userId: user.id } })) >= 500) throw new ConflictException("Your wishlist is full");
    await this.prisma.wishlistItem.upsert({
      where: { userId_productId: { userId: user.id, productId } },
      update: {},
      create: { userId: user.id, productId, priceAtSave: product.priceMinor },
    });
  }

  @Delete("wishlist/:productId")
  @HttpCode(204)
  async unsave(@CurrentUser() user: User, @Param("productId", ParseUUIDPipe) productId: string) {
    await this.prisma.wishlistItem.deleteMany({ where: { userId: user.id, productId } });
  }

  // ---- Notifications (spec section 2.7) ----

  @Get("notifications")
  async notifications(@CurrentUser() user: User) {
    const [items, unread] = await Promise.all([
      this.prisma.notification.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 50 }),
      this.prisma.notification.count({ where: { userId: user.id, readAt: null } }),
    ]);
    return { unread, items };
  }

  @Post("notifications/read")
  @HttpCode(204)
  async markAllRead(@CurrentUser() user: User) {
    await this.prisma.notification.updateMany({ where: { userId: user.id, readAt: null }, data: { readAt: new Date() } });
  }

  @Patch("notification-prefs")
  async prefs(@CurrentUser() user: User, @Body(new ZodPipe(notificationPrefsSchema)) body: z.infer<typeof notificationPrefsSchema>) {
    const u = await this.prisma.user.update({ where: { id: user.id }, data: { emailPrefs: body } });
    return u.emailPrefs;
  }

  // ---- Devices (spec section 6.4) ----

  @Get("devices")
  devices(@CurrentUser() user: User) {
    return this.prisma.knownDevice.findMany({ where: { userId: user.id }, orderBy: { lastSeen: "desc" }, select: { id: true, userAgent: true, firstSeen: true, lastSeen: true } });
  }

  @Delete("devices/:id")
  @HttpCode(204)
  async forgetDevice(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string) {
    await this.prisma.knownDevice.deleteMany({ where: { id, userId: user.id } });
  }

  // ---- Privacy (spec section 10): export and deletion ----

  @Get("export")
  async export(@CurrentUser() user: User, @Res({ passthrough: true }) res: Response) {
    const [addresses, orders, messages, reviews, wishlist, notifications, devices, store, reports] = await Promise.all([
      this.prisma.address.findMany({ where: { userId: user.id }, omit: { fingerprint: true } }),
      this.prisma.order.findMany({ where: { buyerId: user.id }, include: { items: true, events: true }, omit: { riskHits: true, riskScore: true, riskAction: true, paymentRef: true } }),
      this.prisma.message.findMany({ where: { senderId: user.id } }),
      this.prisma.review.findMany({ where: { authorId: user.id } }),
      this.prisma.wishlistItem.findMany({ where: { userId: user.id } }),
      this.prisma.notification.findMany({ where: { userId: user.id } }),
      this.prisma.knownDevice.findMany({ where: { userId: user.id }, omit: { deviceId: true } }),
      this.prisma.store.findUnique({ where: { ownerId: user.id }, include: { products: true } }),
      this.prisma.report.findMany({ where: { reporterId: user.id } }),
    ]);
    res.setHeader("Content-Disposition", `attachment; filename="my-data-${new Date().toISOString().slice(0, 10)}.json"`);
    return {
      exportedAt: new Date().toISOString(),
      account: { id: user.id, email: user.email, name: user.name, roles: user.roles, createdAt: user.createdAt, emailPrefs: user.emailPrefs },
      addresses, orders, messages, reviews, wishlist, notifications, devices, store, reports,
    };
  }

  /**
   * Deletes the account by removing personal data. Order and ledger records are kept, without
   * personal details, because payment and tax law requires them.
   */
  @Delete()
  @HttpCode(204)
  async deleteAccount(@CurrentUser() user: User, @Res({ passthrough: true }) res: Response) {
    const activeBuying = await this.prisma.order.count({ where: { buyerId: user.id, state: { in: [...ACTIVE_STATES] } } });
    if (activeBuying) throw new ConflictException("Finish or cancel your open orders before deleting your account");
    const store = await this.prisma.store.findUnique({ where: { ownerId: user.id } });
    if (store) {
      const activeSelling = await this.prisma.order.count({ where: { storeId: store.id, state: { in: [...ACTIVE_STATES] } } });
      if (activeSelling) throw new ConflictException("Your store has open orders. Complete them before deleting your account");
      if ((await this.ledger.balance(Accounts.sellerPayable(store.id))) !== 0) throw new ConflictException("Pay out your store balance before deleting your account");
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.address.deleteMany({ where: { userId: user.id } });
      await tx.wishlistItem.deleteMany({ where: { userId: user.id } });
      await tx.notification.deleteMany({ where: { userId: user.id } });
      await tx.knownDevice.deleteMany({ where: { userId: user.id } });
      await tx.userBlock.deleteMany({ where: { OR: [{ blockerId: user.id }, { blockedId: user.id }] } });
      // Shipping addresses copied onto past orders are personal data too.
      await tx.order.updateMany({ where: { buyerId: user.id }, data: { shippingAddress: { deleted: true } } });
      if (store) {
        await tx.product.updateMany({ where: { storeId: store.id }, data: { status: "REMOVED" } });
        await tx.store.update({ where: { id: store.id }, data: { verificationStatus: "REJECTED", payoutAccountRef: null, description: null } });
      }
      await tx.user.update({
        where: { id: user.id },
        data: { email: `deleted+${user.id}@deleted.invalid`, name: null, deletedAt: new Date(), roles: ["BUYER"], emailPrefs: { orders: false, alerts: false } },
      });
    });
    await this.audit.record(user.id, "user.delete_self", user.id);
    res.clearCookie(SESSION_COOKIE, { path: "/" });
  }
}
