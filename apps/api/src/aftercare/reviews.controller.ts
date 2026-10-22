import { Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { User } from "@prisma/client";
import { reviewReplySchema, reviewSchema } from "@market/shared";
import { z } from "zod";
import { CurrentUser, Public } from "../common/auth";
import { ZodPipe } from "../common/zod.pipe";
import { NotificationsService } from "../core/notifications.service";
import { PrismaService } from "../core/prisma.service";
import { loadOrderFor } from "../orders/order-access";

const PAGE = 10;

/** Reviews and ratings (spec section 2.9). Only buyers with a completed order can review. */
@Controller()
export class ReviewsController {
  constructor(private readonly prisma: PrismaService, private readonly notifications: NotificationsService) {}

  @Post("orders/:id/reviews")
  async create(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(reviewSchema)) body: z.infer<typeof reviewSchema>) {
    const { order, role } = await loadOrderFor(this.prisma, user, id);
    if (role !== "buyer") throw new ForbiddenException("Only the buyer can review this order");
    if (order.state !== "COMPLETED") throw new ConflictException("You can review once the order is complete");
    const item = await this.prisma.orderItem.findFirst({ where: { orderId: id, productId: body.productId } });
    if (!item) throw new NotFoundException("That product isn't part of this order");
    try {
      const review = await this.prisma.review.create({
        data: { orderId: id, productId: body.productId, storeId: order.storeId, authorId: user.id, rating: body.rating, body: body.body || null },
      });
      await this.notifications.notify(order.store.ownerId, "orders", `New ${body.rating}-star review`, `A buyer reviewed "${item.title}".`, `/products/${body.productId}`);
      return review;
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") throw new ConflictException("You've already reviewed this item");
      throw e;
    }
  }

  /** One public reply per review, by the seller. */
  @Post("reviews/:id/reply")
  async reply(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(reviewReplySchema)) body: z.infer<typeof reviewReplySchema>) {
    const review = await this.prisma.review.findUnique({ where: { id }, include: { store: true } });
    if (!review || review.store.ownerId !== user.id) throw new NotFoundException("Review not found");
    const { count } = await this.prisma.review.updateMany({ where: { id, sellerReply: null }, data: { sellerReply: body.reply, sellerRepliedAt: new Date() } });
    if (!count) throw new ConflictException("You've already replied to this review");
    return this.prisma.review.findUniqueOrThrow({ where: { id } });
  }

  @Public()
  @Get("products/:id/reviews")
  async forProduct(@Param("id", ParseUUIDPipe) id: string, @Query("page") pageRaw?: string) {
    const page = Math.max(1, Math.min(100, Number(pageRaw) || 1));
    const [items, total, dist] = await Promise.all([
      this.prisma.review.findMany({
        where: { productId: id },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * PAGE,
        take: PAGE,
        include: { author: { select: { name: true } } },
      }),
      this.prisma.review.count({ where: { productId: id } }),
      this.prisma.review.groupBy({ by: ["rating"], where: { productId: id }, _count: { rating: true } }),
    ]);
    const counts = Object.fromEntries([1, 2, 3, 4, 5].map((r) => [r, dist.find((d) => d.rating === r)?._count.rating ?? 0]));
    const sum = dist.reduce((s, d) => s + d.rating * d._count.rating, 0);
    return {
      average: total ? Math.round((sum / total) * 10) / 10 : null,
      total,
      counts,
      page,
      // Show first names only.
      items: items.map((r) => ({ ...r, authorId: undefined, author: { name: r.author.name?.split(" ")[0] ?? "Verified buyer" } })),
    };
  }

  @Get("stores/me/reviews")
  async storeReviews(@CurrentUser() user: User) {
    const store = await this.prisma.store.findUnique({ where: { ownerId: user.id } });
    if (!store) throw new ForbiddenException("Create a store first");
    return this.prisma.review.findMany({ where: { storeId: store.id }, orderBy: { createdAt: "desc" }, take: 100, include: { product: { select: { title: true } } } });
  }
}

/** Average rating for a store, shown on listings and the store page. */
export async function storeRating(prisma: PrismaService, storeId: string) {
  const r = await prisma.review.aggregate({ where: { storeId }, _avg: { rating: true }, _count: { rating: true } });
  return { average: r._avg.rating ? Math.round(r._avg.rating * 10) / 10 : null, count: r._count.rating };
}
