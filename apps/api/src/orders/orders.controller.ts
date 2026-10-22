import {
  Body, Controller, ForbiddenException, Get, Headers, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe,
  Post, Req, UnauthorizedException, ConflictException,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Order, User } from "@prisma/client";
import { createHmac, timingSafeEqual } from "crypto";
import { z } from "zod";
import {
  checkoutSchema, CheckoutInput, deliveryCodeSchema, detectOffPlatformSignals, messageSchema, shipOrderSchema, shippingQuoteSchema,
} from "@market/shared";
import { AuthedRequest, CurrentUser, Public } from "../common/auth";
import { ZodPipe } from "../common/zod.pipe";
import { AppConfig, CONFIG, DAY_MS } from "../config";
import { NotificationsService } from "../core/notifications.service";
import { SettingsService } from "../core/settings.service";
import { OrderLifecycleService } from "../core/order-lifecycle.service";
import { PrismaService } from "../core/prisma.service";
import { CheckoutService, newDeliveryCode } from "./checkout.service";
import { loadOrderFor } from "./order-access";

const MAX_CODE_ATTEMPTS = 5;

const carrierEventSchema = z.object({
  carrier: z.string().min(1).max(60),
  trackingNumber: z.string().min(1).max(60),
  event: z.enum(["delivered", "in_transit", "exception"]),
  occurredAt: z.string().datetime(),
});

@Controller()
export class OrdersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly checkoutService: CheckoutService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Post("shipping/quotes")
  async quotes(@CurrentUser() user: User, @Body(new ZodPipe(shippingQuoteSchema)) body: z.infer<typeof shippingQuoteSchema>) {
    const { currency, groups } = await this.checkoutService.quote(user, body.items, body.addressId, body.coupons);
    return {
      currency,
      stores: groups.map((g) => ({
        storeId: g.store.id, storeName: g.store.name, subtotalMinor: g.subtotalMinor, options: g.quotes,
        discountMinor: g.discountMinor, couponCode: g.coupon?.code ?? null, couponError: g.couponError,
        freeShipping: g.freeShipping, freeShippingOverMinor: g.store.freeShippingOverMinor,
        items: g.lines.map((l) => ({ productId: l.product.id, title: l.product.title, quantity: l.quantity, unitPriceMinor: l.product.priceMinor })),
      })),
    };
  }

  @Post("checkout")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  checkout(@CurrentUser() user: User, @Body(new ZodPipe(checkoutSchema)) body: CheckoutInput) {
    if (body.testCard && this.config.PAYMENT_PROVIDER !== "fake") delete body.testCard;
    return this.checkoutService.checkout(user, body);
  }

  @Get("orders")
  myOrders(@CurrentUser() user: User) {
    return this.prisma.order.findMany({
      where: { buyerId: user.id, state: { not: "PENDING_PAYMENT" } },
      orderBy: { createdAt: "desc" },
      include: { items: true, store: { select: { name: true, slug: true } } },
      omit: { riskHits: true, riskScore: true, riskAction: true, paymentRef: true },
    });
  }

  @Get("stores/me/orders")
  async storeOrders(@CurrentUser() user: User) {
    const store = await this.prisma.store.findUnique({ where: { ownerId: user.id } });
    if (!store) throw new ForbiddenException("Create a store first");
    return this.prisma.order.findMany({
      where: { storeId: store.id, state: { not: "PENDING_PAYMENT" } },
      orderBy: { createdAt: "desc" },
      include: { items: true, shipment: { omit: { deliveryCodeHash: true } } },
      omit: { riskHits: true, riskScore: true, riskAction: true, paymentRef: true },
    });
  }

  @Get("orders/:id")
  async detail(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string) {
    const { role } = await loadOrderFor(this.prisma, user, id);
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id },
      include: {
        items: true,
        events: { orderBy: { createdAt: "asc" } },
        shipment: { omit: { deliveryCodeHash: true } },
        dispute: true,
        store: { select: { id: true, name: true, slug: true, ownerId: true, returnPolicyDays: true } },
        // Never the buyer's email: contact stays on the platform (spec section 2.7).
        buyer: { select: { id: true, name: true } },
        returnRequest: true,
        reviews: true,
      },
    });
    const { riskHits, riskScore, riskAction, paymentRef, shippingAddress, ...rest } = order;
    // The seller sees the full address only while they need it to ship (spec section 9).
    const showAddress = role !== "seller" || ["PAID", "SHIPPED"].includes(order.state);
    return {
      ...rest,
      role,
      shippingAddress: showAddress ? shippingAddress : { city: (shippingAddress as { city?: string }).city },
      ...(role === "staff" ? { riskHits, riskScore, riskAction, paymentRef } : {}),
    };
  }

  @Post("orders/:id/ship")
  async ship(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(shipOrderSchema)) body: z.infer<typeof shipOrderSchema>) {
    const { order, role } = await loadOrderFor(this.prisma, user, id);
    if (role !== "seller") throw new ForbiddenException("Only the seller can ship this order");
    if (order.riskHold) throw new ForbiddenException("This order is being reviewed. Don't ship it until we confirm.");
    const code = newDeliveryCode();
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.lifecycle.transition(tx, order, "SHIPPED", user.id, `${body.carrier} ${body.trackingNumber}`);
        await tx.shipment.create({ data: { orderId: id, carrier: body.carrier, trackingNumber: body.trackingNumber, deliveryCodeHash: this.codeHash(id, code) } });
      });
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") throw new ConflictException("That tracking number is already used on another order");
      throw e;
    }
    await this.notifications.notify(
      order.buyerId,
      "orders",
      `Order ${id.slice(0, 8)} has shipped`,
      `Your order is on its way with ${body.carrier} (tracking ${body.trackingNumber}).\n\nYour delivery code is ${code}. Give it to the courier only when you have the package in your hands. Never share it before.`,
      `/orders/${id}`,
    );
    return { shipped: true };
  }

  /** Proof of delivery: the courier or seller enters the code the buyer gives them on handover. */
  @Post("orders/:id/deliver")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async deliver(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(deliveryCodeSchema)) { code }: { code: string }) {
    const { order, role } = await loadOrderFor(this.prisma, user, id);
    if (role !== "seller") throw new ForbiddenException("Only the seller or their courier can confirm handover");
    const shipment = await this.prisma.shipment.findUnique({ where: { orderId: id } });
    if (!shipment || order.state !== "SHIPPED") throw new ConflictException("This order isn't out for delivery");
    if (shipment.codeAttempts >= MAX_CODE_ATTEMPTS) throw new ForbiddenException("Too many wrong codes. The buyer can confirm receipt from their order page.");
    const ok = timingSafeEqual(Buffer.from(shipment.deliveryCodeHash, "hex"), Buffer.from(this.codeHash(id, code), "hex"));
    if (!ok) {
      await this.prisma.shipment.update({ where: { id: shipment.id }, data: { codeAttempts: { increment: 1 } } });
      throw new UnauthorizedException("Wrong delivery code");
    }
    await this.markDelivered(order, user.id, "delivery_code");
    return { delivered: true };
  }

  /** Buyer confirms they received the items: escrow is released to the seller immediately. */
  @Post("orders/:id/confirm")
  async confirm(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string) {
    const { order, role } = await loadOrderFor(this.prisma, user, id);
    if (role !== "buyer") throw new ForbiddenException("Only the buyer can confirm receipt");
    // A disputed or returned order is settled through that process, not by confirming.
    if (order.state !== "SHIPPED" && order.state !== "DELIVERED") throw new ConflictException("This order can't be confirmed in its current state");
    if (order.state === "SHIPPED") await this.markDelivered(order, user.id, "buyer_confirmed");
    return this.lifecycle.settle(id, "COMPLETED", 0, user.id, "Buyer confirmed receipt");
  }

  @Post("orders/:id/cancel")
  async cancel(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string) {
    const { order, role } = await loadOrderFor(this.prisma, user, id);
    if (role === "staff") throw new ForbiddenException("Use the admin console to cancel orders");
    if (order.state !== "PAID") throw new ConflictException("Orders can only be cancelled before they ship");
    return this.lifecycle.settle(id, "CANCELLED", order.totalMinor, user.id, `Cancelled by ${role}`);
  }

  // ---- Order chat ----

  @Get("orders/:id/messages")
  async messages(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string) {
    await loadOrderFor(this.prisma, user, id);
    return this.prisma.message.findMany({
      where: { orderId: id },
      orderBy: { createdAt: "asc" },
      include: { sender: { select: { id: true, name: true, roles: true } } },
    });
  }

  @Post("orders/:id/messages")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async send(@CurrentUser() user: User, @Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(messageSchema)) body: z.infer<typeof messageSchema>) {
    const { order, role } = await loadOrderFor(this.prisma, user, id);
    if (role === "staff" && order.state !== "DISPUTED") throw new ForbiddenException("Staff can only join chats on disputed orders");
    const otherId = role === "buyer" ? order.store.ownerId : order.buyerId;
    if (role !== "staff") {
      const blocked = await this.prisma.userBlock.findUnique({ where: { blockerId_blockedId: { blockerId: otherId, blockedId: user.id } } });
      if (blocked) throw new ForbiddenException("You can't message this user. If you need help with the order, open a dispute.");
    }
    // Messages with contact details or outside-payment requests are delivered but flagged,
    // and the app shows both sides a scam warning (spec sections 2.7 and 9).
    const flags = detectOffPlatformSignals(body.body);
    return this.prisma.message.create({ data: { orderId: id, senderId: user.id, body: body.body, attachments: body.attachments, flags } });
  }

  // ---- Carrier webhook ----

  /** Carriers call this with an HMAC-SHA256 signature of the raw body in X-Signature. */
  @Public()
  @Post("webhooks/carrier")
  @HttpCode(200)
  async carrierWebhook(@Req() req: AuthedRequest & { rawBody?: Buffer }, @Headers("x-signature") signature?: string) {
    const raw = req.rawBody;
    if (!raw || !signature) throw new UnauthorizedException("Missing signature");
    const expected = createHmac("sha256", this.config.CARRIER_WEBHOOK_SECRET).update(raw).digest();
    const given = Buffer.from(signature, "hex");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new UnauthorizedException("Bad signature");

    const event = carrierEventSchema.parse(req.body);
    const occurred = new Date(event.occurredAt);
    if (Math.abs(Date.now() - occurred.getTime()) > 7 * DAY_MS) throw new UnauthorizedException("Stale event");
    if (event.event !== "delivered") return { ok: true };

    const shipment = await this.prisma.shipment.findUnique({
      where: { carrier_trackingNumber: { carrier: event.carrier, trackingNumber: event.trackingNumber } },
      include: { order: true },
    });
    if (!shipment) throw new NotFoundException("Unknown shipment");
    // Replays are harmless: only a SHIPPED order can become DELIVERED.
    if (shipment.order.state === "SHIPPED") await this.markDelivered(shipment.order, null, "carrier_webhook");
    return { ok: true };
  }

  private async markDelivered(order: Pick<Order, "id" | "state" | "buyerId">, actorId: string | null, via: string) {
    const releaseAt = new Date(Date.now() + (await this.settings.get("RELEASE_AFTER_DAYS")) * DAY_MS);
    await this.prisma.$transaction(async (tx) => {
      await this.lifecycle.transition(tx, order, "DELIVERED", actorId, `Delivered (${via})`, { releaseAt });
      await tx.shipment.update({ where: { orderId: order.id }, data: { deliveredAt: new Date(), deliveredVia: via } });
    });
    if (via !== "buyer_confirmed") {
      await this.notifications.notify(
        order.buyerId,
        "orders",
        `Order ${order.id.slice(0, 8)} was delivered`,
        `Your order was delivered. Check it and confirm receipt, or report a problem before ${releaseAt.toDateString()}. After that, payment is released to the seller automatically.`,
        `/orders/${order.id}`,
      );
    }
  }

  private codeHash(orderId: string, code: string): string {
    return createHmac("sha256", this.config.JWT_SECRET).update(`delivery:${orderId}:${code}`).digest("hex");
  }
}
