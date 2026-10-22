import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException,
  Param, ParseUUIDPipe, Patch, Post, Query, UploadedFile, UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Throttle } from "@nestjs/throttler";
import { Prisma, Product, User } from "@prisma/client";
import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import sharp from "sharp";
import { formatMoney, haversineKm, isSuspiciouslyCheap, productInputSchema, ProductInput, productSearchSchema, ProductSearch } from "@market/shared";
import { CurrentUser, Public } from "../common/auth";
import { ZodPipe } from "../common/zod.pipe";
import { AppConfig, CONFIG, DAY_MS } from "../config";
import { NotificationsService } from "../core/notifications.service";
import { PrismaService } from "../core/prisma.service";
import { storeRating } from "../aftercare/reviews.controller";
import { storeStats } from "../accounts/accounts.controller";

const PAGE_SIZE = 24;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Listings mentioning these go to manual review instead of going live. */
const PROHIBITED_TERMS = /\b(gun|firearm|ammunition|cocaine|heroin|counterfeit|replica|fake id|passport|ivory)\b/i;

const publicStoreSelect = { id: true, name: true, slug: true, city: true, country: true, lat: true, lng: true } as const;

@Controller()
export class CatalogController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get("categories")
  categories() {
    return this.prisma.category.findMany({ orderBy: { name: "asc" } });
  }

  // ---- Search ----

  @Public()
  @Get("products")
  async search(@Query(new ZodPipe(productSearchSchema)) q: ProductSearch) {
    const where: Prisma.ProductWhereInput = {
      status: "ACTIVE",
      stock: { gt: 0 },
      store: { verificationStatus: "VERIFIED", owner: { suspendedAt: null, deletedAt: null } },
      condition: q.condition,
      priceMinor: { gte: q.minPrice, lte: q.maxPrice },
    };
    if (q.category) where.category = { slug: q.category };
    if (q.q) {
      where.OR = [
        { title: { contains: q.q, mode: "insensitive" } },
        { description: { contains: q.q, mode: "insensitive" } },
      ];
    }
    const geo = q.lat !== undefined && q.lng !== undefined ? { lat: q.lat, lng: q.lng } : null;

    // Distance filtering and sorting happen in memory over a bounded candidate set.
    // Move to PostGIS + a search engine when the catalog outgrows this.
    const orderBy: Prisma.ProductOrderByWithRelationInput =
      q.sort === "price_asc" ? { priceMinor: "asc" } : q.sort === "price_desc" ? { priceMinor: "desc" } : q.sort === "newest" ? { createdAt: "desc" } : { viewCount: "desc" };
    const candidates = await this.prisma.product.findMany({ where, orderBy, take: 500, include: { store: { select: publicStoreSelect } } });

    let results = candidates.map((p) => ({ ...p, distanceKm: geo ? Math.round(haversineKm(geo, p.store)) : null }));
    if (geo && q.maxKm) results = results.filter((p) => p.distanceKm! <= q.maxKm!);
    if (q.sort === "nearest" && geo) results.sort((a, b) => a.distanceKm! - b.distanceKm!);
    if (q.sort === "relevance" && q.q) {
      const needle = q.q.toLowerCase();
      results.sort((a, b) => Number(b.title.toLowerCase().includes(needle)) - Number(a.title.toLowerCase().includes(needle)));
    }
    const start = (q.page - 1) * PAGE_SIZE;
    return { total: results.length, page: q.page, pageSize: PAGE_SIZE, items: results.slice(start, start + PAGE_SIZE).map(toPublicProduct) };
  }

  // ---- Recommendations (spec section 7, stages 1–2) ----

  @Public()
  @Get("products/trending")
  async trending(@Query("lat") lat?: string, @Query("lng") lng?: string) {
    const since = new Date(Date.now() - 14 * DAY_MS);
    const sold = await this.prisma.orderItem.groupBy({
      by: ["productId"],
      where: { order: { createdAt: { gte: since }, state: { notIn: ["CANCELLED", "PENDING_PAYMENT"] } } },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: "desc" } },
      take: 50,
    });
    const soldMap = new Map(sold.map((s) => [s.productId, s._sum.quantity ?? 0]));
    const products = await this.prisma.product.findMany({
      where: {
        status: "ACTIVE", stock: { gt: 0 }, store: { verificationStatus: "VERIFIED", owner: { suspendedAt: null, deletedAt: null } },
        OR: [{ id: { in: [...soldMap.keys()] } }, { createdAt: { gte: since } }, { viewCount: { gt: 0 } }],
      },
      include: { store: { select: publicStoreSelect } },
      take: 200,
    });
    const geo = lat && lng ? { lat: Number(lat), lng: Number(lng) } : null;
    const scored = products.map((p) => {
      let score = (soldMap.get(p.id) ?? 0) * 10 + Math.log1p(p.viewCount);
      // Nearby items rank higher: cheaper, faster delivery.
      if (geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lng)) score /= 1 + haversineKm(geo, p.store) / 200;
      return { p, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return diversify(scored.map((s) => s.p), 3).slice(0, 12).map(toPublicProduct);
  }

  @Public()
  @Get("products/:id")
  async detail(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() user?: User) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: { category: true, store: { select: { ...publicStoreSelect, returnPolicyDays: true, ownerId: true, verificationStatus: true } } },
    });
    const isOwner = product && user?.id === product.store.ownerId;
    if (!product || (product.status !== "ACTIVE" && !isOwner)) throw new NotFoundException();
    if (!isOwner) await this.prisma.product.update({ where: { id }, data: { viewCount: { increment: 1 } } });
    const [stats, rating, productRating] = await Promise.all([
      storeStats(this.prisma, product.storeId),
      storeRating(this.prisma, product.storeId),
      this.prisma.review.aggregate({ where: { productId: id }, _avg: { rating: true }, _count: { rating: true } }),
    ]);
    return {
      ...toPublicProduct(product), category: product.category, storeStats: { ...stats, rating },
      rating: { average: productRating._avg.rating ? Math.round(productRating._avg.rating * 10) / 10 : null, count: productRating._count.rating },
    };
  }

  @Public()
  @Get("products/:id/recommendations")
  async recommendations(@Param("id", ParseUUIDPipe) id: string) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException();
    const live = { status: "ACTIVE" as const, stock: { gt: 0 }, id: { not: id }, store: { verificationStatus: "VERIFIED" as const, owner: { suspendedAt: null, deletedAt: null } } };

    // Similar: same category, scored by shared title words and closeness in price.
    const sameCategory = await this.prisma.product.findMany({ where: { ...live, categoryId: product.categoryId }, take: 100, include: { store: { select: publicStoreSelect } } });
    const words = tokens(product.title);
    const similar = sameCategory
      .map((p) => {
        const overlap = tokens(p.title).filter((w) => words.includes(w)).length;
        const priceRatio = Math.min(p.priceMinor, product.priceMinor) / Math.max(p.priceMinor, product.priceMinor);
        return { p, score: overlap * 2 + priceRatio };
      })
      .sort((a, b) => b.score - a.score)
      .map((s) => s.p);

    // Frequently bought together: other products in orders that contained this one.
    const coPurchased = await this.prisma.orderItem.groupBy({
      by: ["productId"],
      where: { productId: { not: id }, order: { items: { some: { productId: id } }, state: { notIn: ["CANCELLED", "PENDING_PAYMENT"] } } },
      _count: { productId: true },
      orderBy: { _count: { productId: "desc" } },
      take: 6,
    });
    const together = await this.prisma.product.findMany({ where: { ...live, id: { in: coPurchased.map((c) => c.productId) } }, include: { store: { select: publicStoreSelect } } });

    const fromSeller = await this.prisma.product.findMany({ where: { ...live, storeId: product.storeId }, take: 6, orderBy: { viewCount: "desc" }, include: { store: { select: publicStoreSelect } } });

    return {
      similar: diversify(similar, 2).slice(0, 8).map(toPublicProduct),
      boughtTogether: together.map(toPublicProduct),
      moreFromSeller: fromSeller.map(toPublicProduct),
    };
  }

  // ---- Seller listing management ----

  @Get("stores/me/products")
  async myProducts(@CurrentUser() user: User) {
    const store = await this.requireStore(user, false);
    return this.prisma.product.findMany({ where: { storeId: store.id, status: { not: "REMOVED" } }, orderBy: { createdAt: "desc" } });
  }

  @Post("products")
  async create(@CurrentUser() user: User, @Body(new ZodPipe(productInputSchema)) body: ProductInput) {
    const store = await this.requireStore(user, true);
    await this.assertCategory(body.categoryId);
    const review = await this.moderate(store, body);
    return this.prisma.product.create({
      data: { ...body, storeId: store.id, currency: this.config.PLATFORM_CURRENCY, status: review ? "PENDING_REVIEW" : "ACTIVE", reviewNote: review },
    });
  }

  @Patch("products/:id")
  async update(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(productInputSchema)) body: ProductInput) {
    const store = await this.requireStore(user, true);
    const existing = await this.ownedProduct(store.id, id);
    if (existing.status === "REMOVED") throw new ForbiddenException("This listing was removed");
    await this.assertCategory(body.categoryId);
    const review = await this.moderate(store, body);
    const updated = await this.prisma.product.update({
      where: { id },
      data: { ...body, status: review ? "PENDING_REVIEW" : existing.status, reviewNote: review ?? existing.reviewNote },
    });
    if (updated.status === "ACTIVE") await this.alertWishlisters(existing, updated);
    return updated;
  }

  /** Price-drop and back-in-stock alerts for people who saved the item (spec section 2.2). */
  private async alertWishlisters(before: Product, after: Product) {
    const backInStock = before.stock === 0 && after.stock > 0;
    const savers = await this.prisma.wishlistItem.findMany({
      where: { productId: after.id, ...(backInStock ? {} : { priceAtSave: { gt: after.priceMinor } }) },
    });
    for (const w of savers) {
      const dropped = after.priceMinor < w.priceAtSave;
      const title = dropped ? `Price drop: ${after.title}` : `Back in stock: ${after.title}`;
      const body = dropped
        ? `An item on your wishlist is now ${formatMoney(after.priceMinor, after.currency)} (was ${formatMoney(w.priceAtSave, after.currency)}).`
        : `An item on your wishlist is available again.`;
      await this.notifications.notify(w.userId, "alerts", title, body, `/products/${after.id}`);
      // Only announce each new low once.
      if (dropped) await this.prisma.wishlistItem.update({ where: { userId_productId: { userId: w.userId, productId: w.productId } }, data: { priceAtSave: after.priceMinor } });
    }
  }

  @Delete("products/:id")
  @HttpCode(204)
  async remove(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string) {
    const store = await this.requireStore(user, false);
    await this.ownedProduct(store.id, id);
    await this.prisma.product.update({ where: { id }, data: { status: "REMOVED" } });
  }

  // ---- Image uploads ----

  @Post("uploads/images")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  async upload(@UploadedFile() file?: Express.Multer.File) {
    if (!file || !ALLOWED_IMAGE_TYPES.has(file.mimetype)) throw new BadRequestException("Upload a JPEG, PNG or WebP image under 8 MB");
    let output: Buffer;
    try {
      // Re-encoding checks the file really is an image and drops all metadata,
      // including GPS location, so photos can't reveal where a seller lives.
      output = await sharp(file.buffer, { limitInputPixels: 50_000_000 })
        .rotate()
        .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
    } catch {
      throw new BadRequestException("That file isn't a valid image");
    }
    const name = `${randomUUID()}.webp`;
    await mkdir(this.config.UPLOAD_DIR, { recursive: true });
    await writeFile(join(this.config.UPLOAD_DIR, name), output);
    return { url: `/uploads/${name}` };
  }

  private async requireStore(user: User, mustBeVerified: boolean) {
    const store = await this.prisma.store.findUnique({ where: { ownerId: user.id } });
    if (!store) throw new ForbiddenException("Create a store first");
    if (mustBeVerified && store.verificationStatus !== "VERIFIED") throw new ForbiddenException("Your store is waiting for verification");
    return store;
  }

  private async ownedProduct(storeId: string, id: string): Promise<Product> {
    const product = await this.prisma.product.findFirst({ where: { id, storeId } });
    if (!product) throw new NotFoundException();
    return product;
  }

  private async assertCategory(id: string) {
    if (!(await this.prisma.category.findUnique({ where: { id } }))) throw new BadRequestException("Unknown category");
  }

  /** Returns a reason when the listing needs manual review (spec sections 2.2 and 6.3). */
  private async moderate(store: { id: string; createdAt: Date }, body: ProductInput): Promise<string | null> {
    if (PROHIBITED_TERMS.test(`${body.title} ${body.description}`)) return "Possible prohibited item";
    const isNewSeller = Date.now() - store.createdAt.getTime() < 30 * DAY_MS;
    if (!isNewSeller) return null;
    const [row] = await this.prisma.$queryRaw<{ median: number | null }[]>`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY "priceMinor") AS median
      FROM "Product" WHERE "categoryId" = ${body.categoryId}::uuid AND status = 'ACTIVE' AND "storeId" <> ${store.id}::uuid`;
    if (isSuspiciouslyCheap(body.priceMinor, row?.median ?? null)) return "New seller pricing far below category median";
    return null;
  }
}

function toPublicProduct<T extends Product & { store?: { ownerId?: string } | unknown }>(p: T) {
  const { viewCount: _v, reviewNote: _r, ...rest } = p;
  return rest;
}

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
}

/** Caps how many items one store contributes so a single seller can't dominate a list. */
function diversify<T extends { storeId: string }>(items: T[], perStore: number): T[] {
  const counts = new Map<string, number>();
  return items.filter((i) => {
    const n = counts.get(i.storeId) ?? 0;
    counts.set(i.storeId, n + 1);
    return n < perStore;
  });
}
