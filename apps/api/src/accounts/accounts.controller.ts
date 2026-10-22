import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { User } from "@prisma/client";
import { addressSchema, AddressInput, createStoreSchema, reportSchema } from "@market/shared";
import { z } from "zod";
import { CurrentUser, Public } from "../common/auth";
import { ZodPipe } from "../common/zod.pipe";
import { Accounts, LedgerService } from "../core/ledger.service";
import { PrismaService } from "../core/prisma.service";
import { addressFingerprint } from "../core/risk.service";
import { toMe } from "../auth/auth.controller";
import { storeRating } from "../aftercare/reviews.controller";

const profileSchema = z.object({ name: z.string().trim().min(1).max(80) });

@Controller()
export class AccountsController {
  constructor(private readonly prisma: PrismaService, private readonly ledger: LedgerService) {}

  @Patch("me")
  async updateProfile(@CurrentUser() user: User, @Body(new ZodPipe(profileSchema)) body: z.infer<typeof profileSchema>) {
    return toMe(await this.prisma.user.update({ where: { id: user.id }, data: { name: body.name } }));
  }

  // ---- Addresses ----

  @Get("addresses")
  listAddresses(@CurrentUser() user: User) {
    return this.prisma.address.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, omit: { fingerprint: true } });
  }

  @Post("addresses")
  async createAddress(@CurrentUser() user: User, @Body(new ZodPipe(addressSchema)) body: AddressInput) {
    const count = await this.prisma.address.count({ where: { userId: user.id } });
    if (count >= 20) throw new ForbiddenException("You can save up to 20 addresses");
    return this.prisma.address.create({
      data: { ...body, userId: user.id, fingerprint: addressFingerprint(body) },
      omit: { fingerprint: true },
    });
  }

  @Delete("addresses/:id")
  @HttpCode(204)
  async deleteAddress(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string) {
    const { count } = await this.prisma.address.deleteMany({ where: { id, userId: user.id } });
    if (!count) throw new NotFoundException();
  }

  // ---- Seller store ----

  @Post("stores")
  async createStore(@CurrentUser() user: User, @Body(new ZodPipe(createStoreSchema)) body: z.infer<typeof createStoreSchema>) {
    const existing = await this.prisma.store.findUnique({ where: { ownerId: user.id } });
    if (existing) throw new ForbiddenException("You already have a store");
    const address = await this.prisma.address.findFirst({ where: { id: body.pickupAddressId, userId: user.id } });
    if (!address) throw new NotFoundException("Pickup address not found");
    const slugBase = body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "store";
    const slug = `${slugBase}-${user.id.slice(0, 6)}`;
    // Stores start PENDING; an admin verifies identity before products go live.
    // With Stripe Connect this step becomes the provider's KYC onboarding.
    return this.prisma.store.create({
      data: {
        ownerId: user.id, name: body.name, slug, description: body.description, returnPolicyDays: body.returnPolicyDays,
        city: address.city, country: address.country, lat: address.lat, lng: address.lng,
      },
    });
  }

  @Get("stores/me")
  async myStore(@CurrentUser() user: User) {
    const store = await this.prisma.store.findUnique({ where: { ownerId: user.id } });
    if (!store) return null;
    const payable = await this.ledger.balance(Accounts.sellerPayable(store.id));
    const held = await this.prisma.order.aggregate({
      where: { storeId: store.id, state: { in: ["PAID", "SHIPPED", "DELIVERED", "DISPUTED"] } },
      _sum: { totalMinor: true },
    });
    // Seller payable is a liability (credit), so flip the sign for display.
    return { ...store, balance: { availableMinor: -payable, inEscrowMinor: held._sum.totalMinor ?? 0 } };
  }

  @Public()
  @Get("stores/:slug")
  async publicStore(@Param("slug") slug: string) {
    const store = await this.prisma.store.findUnique({
      where: { slug },
      select: {
        id: true, name: true, slug: true, description: true, city: true, country: true, returnPolicyDays: true,
        verificationStatus: true, createdAt: true, ownerId: true,
        products: { where: { status: "ACTIVE" }, orderBy: { createdAt: "desc" }, take: 60 },
      },
    });
    if (!store || store.verificationStatus !== "VERIFIED") throw new NotFoundException();
    return { ...store, stats: { ...(await storeStats(this.prisma, store.id)), rating: await storeRating(this.prisma, store.id) } };
  }

  // ---- Safety: reports and blocks ----

  @Post("reports")
  async report(@CurrentUser() user: User, @Body(new ZodPipe(reportSchema)) body: z.infer<typeof reportSchema>) {
    await this.prisma.report.create({ data: { ...body, reporterId: user.id } });
    return { received: true };
  }

  @Post("users/:id/block")
  @HttpCode(204)
  async block(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string) {
    if (id === user.id) throw new ForbiddenException("You can't block yourself");
    await this.prisma.userBlock.upsert({
      where: { blockerId_blockedId: { blockerId: user.id, blockedId: id } },
      update: {},
      create: { blockerId: user.id, blockedId: id },
    });
  }

  @Delete("users/:id/block")
  @HttpCode(204)
  async unblock(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string) {
    await this.prisma.userBlock.deleteMany({ where: { blockerId: user.id, blockedId: id } });
  }
}

/** Trust indicators shown on listings and store pages. */
export async function storeStats(prisma: PrismaService, storeId: string) {
  const [completed, disputed, shippedOrders] = await Promise.all([
    prisma.order.count({ where: { storeId, state: "COMPLETED" } }),
    prisma.dispute.count({ where: { order: { storeId } } }),
    prisma.order.findMany({
      where: { storeId, shipment: { isNot: null }, shipBy: { not: null } },
      select: { shipBy: true, shipment: { select: { createdAt: true } } },
      take: 200,
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const onTime = shippedOrders.filter((o) => o.shipment!.createdAt <= o.shipBy!).length;
  const total = completed + disputed;
  return {
    completedOrders: completed,
    disputeRate: total ? Math.round((disputed / total) * 100) : 0,
    onTimeShippingRate: shippedOrders.length ? Math.round((onTime / shippedOrders.length) * 100) : null,
  };
}
