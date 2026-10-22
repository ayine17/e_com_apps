import { NestExpressApplication } from "@nestjs/platform-express";
import { createHmac } from "crypto";
import sharp from "sharp";
import request from "supertest";
import { EscrowJobs } from "../src/jobs/escrow-jobs.service";
import { Agent, buy, createApp, lastEmail, login, makeAdmin, prisma, resetDb, setupSeller } from "./helpers";

let app: NestExpressApplication;
let admin: Agent;

beforeAll(async () => {
  app = await createApp();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb();
  await login(app, "admin@example.test");
  await makeAdmin("admin@example.test");
  admin = await login(app, "admin@example.test");
});

const ledgerBalance = async (account: string) =>
  (await prisma.ledgerEntry.aggregate({ where: { account }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0;

async function shipAndGetCode(seller: Agent, buyerEmail: string, orderId: string, tracking = "TRK123456") {
  await seller.post(`/api/orders/${orderId}/ship`).send({ carrier: "UPS", trackingNumber: tracking }).expect(201);
  return (await lastEmail(buyerEmail)).body.match(/delivery code is (\d{4})/)![1];
}

describe("happy path: buy → ship → deliver → confirm", () => {
  it("holds money in escrow and releases it to the seller minus the fee", async () => {
    const { seller, productId, storeId } = await setupSeller(app, admin);
    const buyer = await login(app, "buyer@example.test");

    const res = await buy(buyer, productId, storeId, { quantity: 2 });
    expect(res.status).toBe(201);
    const [orderId] = res.body.orderIds;
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.state).toBe("PAID");
    expect(order.subtotalMinor).toBe(20_000);
    expect(order.totalMinor).toBe(20_000 + order.shippingMinor);
    expect(await ledgerBalance(`escrow:order:${orderId}`)).toBe(-order.totalMinor);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stock).toBe(3);

    const code = await shipAndGetCode(seller, "buyer@example.test", orderId);
    await seller.post(`/api/orders/${orderId}/deliver`).send({ code: code === "0000" ? "0001" : "0000" }).expect(401);
    await seller.post(`/api/orders/${orderId}/deliver`).send({ code }).expect(201);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).state).toBe("DELIVERED");

    await buyer.post(`/api/orders/${orderId}/confirm`).expect(201);
    const done = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(done.state).toBe("COMPLETED");
    const fee = Math.round(done.totalMinor * 0.08);
    expect(done.feeMinor).toBe(fee);
    expect(await ledgerBalance(`escrow:order:${orderId}`)).toBe(0);
    expect(await ledgerBalance(`seller:${storeId}:payable`)).toBe(-(done.totalMinor - fee));
    expect(await ledgerBalance("platform:fees")).toBe(-fee);

    const finance = await admin.get("/api/admin/finance").expect(200);
    expect(finance.body.unbalancedTransactions).toBe(0);
    expect(finance.body.feesEarnedMinor).toBe(fee);

    const events = await prisma.orderEvent.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.toState)).toEqual(["PENDING_PAYMENT", "PAID", "SHIPPED", "DELIVERED", "COMPLETED"]);
  });

  it("auto-releases after the protection window, but not while disputed", async () => {
    const { seller, productId, storeId } = await setupSeller(app, admin);
    const buyer = await login(app, "buyer@example.test");
    const a = (await buy(buyer, productId, storeId)).body.orderIds[0];
    const b = (await buy(buyer, productId, storeId)).body.orderIds[0];
    for (const [id, trk] of [[a, "TRKA0001"], [b, "TRKB0001"]]) {
      const code = await shipAndGetCode(seller, "buyer@example.test", id, trk);
      await seller.post(`/api/orders/${id}/deliver`).send({ code }).expect(201);
    }
    await buyer.post(`/api/orders/${b}/disputes`).send({ reason: "DAMAGED", description: "The box arrived crushed." }).expect(201);

    const jobs = app.get(EscrowJobs);
    expect(await jobs.autoRelease(new Date())).toBe(0);
    expect(await jobs.autoRelease(new Date(Date.now() + 8 * 86_400_000))).toBe(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: a } })).state).toBe("COMPLETED");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: b } })).state).toBe("DISPUTED");
  });
});

describe("access control", () => {
  it("hides orders from other users and admin pages from non-admins", async () => {
    const { productId, storeId } = await setupSeller(app, admin);
    const buyer = await login(app, "buyer@example.test");
    const orderId = (await buy(buyer, productId, storeId)).body.orderIds[0];

    const stranger = await login(app, "stranger@example.test");
    await stranger.get(`/api/orders/${orderId}`).expect(404);
    await stranger.post(`/api/orders/${orderId}/confirm`).expect(404);
    await stranger.get("/api/admin/overview").expect(403);
    await request(app.getHttpServer()).get("/api/orders").expect(401);
    await buyer.post(`/api/orders/${orderId}/ship`).send({ carrier: "UPS", trackingNumber: "TRK0001" }).expect(403);
  });

  it("rejects cross-site POSTs", async () => {
    await request(app.getHttpServer()).post("/api/auth/otp").set("Origin", "https://evil.example").send({ email: "x@example.test" }).expect(403);
  });

  it("locks out a login code after repeated wrong guesses", async () => {
    const server = request(app.getHttpServer());
    await server.post("/api/auth/otp").send({ email: "guess@example.test" }).expect(202);
    for (let i = 0; i < 5; i++) await server.post("/api/auth/verify").send({ email: "guess@example.test", code: "000000" });
    const code = (await lastEmail("guess@example.test")).subject.match(/(\d{6})/)![1];
    await server.post("/api/auth/verify").send({ email: "guess@example.test", code }).expect(401);
  });
});

describe("checkout safety", () => {
  it("cancels and restores stock when payment is declined", async () => {
    const { productId, storeId } = await setupSeller(app, admin);
    const buyer = await login(app, "buyer@example.test");
    const res = await buy(buyer, productId, storeId, { testCard: "decline" });
    expect(res.status).toBe(402);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stock).toBe(5);
    expect(await prisma.order.findFirst({ where: { state: "CANCELLED" } })).not.toBeNull();
    expect(await prisma.ledgerEntry.count()).toBe(0);
  });

  it("never oversells", async () => {
    const { productId, storeId } = await setupSeller(app, admin, "seller@example.test", { stock: 1 });
    const buyer = await login(app, "buyer@example.test");
    expect((await buy(buyer, productId, storeId)).status).toBe(201);
    expect((await buy(buyer, productId, storeId)).status).toBe(409);
  });

  it("stops buyers from purchasing their own listing", async () => {
    const { seller, productId, storeId } = await setupSeller(app, admin);
    expect((await buy(seller, productId, storeId)).status).toBe(400);
  });

  it("holds risky orders for review and blocks the worst", async () => {
    const { seller, productId, storeId } = await setupSeller(app, admin);
    // A suspended fraudster used the same shipping address.
    const fraudster = await login(app, "fraud@example.test");
    await fraudster.post("/api/addresses").send({ line1: "200 Market St", city: "Philadelphia", country: "US", lat: 39.95, lng: -75.16 }).expect(201);
    await prisma.user.update({ where: { email: "fraud@example.test" }, data: { suspendedAt: new Date() } });

    const buyer = await login(app, "buyer@example.test");
    const held = await buy(buyer, productId, storeId);
    expect(held.status).toBe(201);
    expect(held.body.onHold).toBe(true);
    const orderId = held.body.orderIds[0];
    await seller.post(`/api/orders/${orderId}/ship`).send({ carrier: "UPS", trackingNumber: "TRK9999" }).expect(403);
    expect((await admin.get("/api/admin/orders/held").expect(200)).body).toHaveLength(1);
    await admin.post(`/api/admin/orders/${orderId}/risk-review`).send({ decision: "clear" }).expect(201);
    await seller.post(`/api/orders/${orderId}/ship`).send({ carrier: "UPS", trackingNumber: "TRK9999" }).expect(201);
    expect((await prisma.riskEvent.findFirstOrThrow({ where: { userId: (await prisma.user.findUniqueOrThrow({ where: { email: "buyer@example.test" } })).id } })).label).toBe("legit");

    // Same signals plus the payment provider flagging the card: blocked and refunded.
    const blocked = await buy(buyer, productId, storeId, { testCard: "elevated_risk" });
    expect(blocked.status).toBe(403);
    const cancelled = await prisma.order.findFirstOrThrow({ where: { state: "CANCELLED" } });
    expect(await ledgerBalance(`escrow:order:${cancelled.id}`)).toBe(0);
  });
});

describe("cancellations and deadlines", () => {
  it("lets the buyer cancel before shipping with a full refund", async () => {
    const { productId, storeId } = await setupSeller(app, admin);
    const buyer = await login(app, "buyer@example.test");
    const orderId = (await buy(buyer, productId, storeId)).body.orderIds[0];
    await buyer.post(`/api/orders/${orderId}/cancel`).expect(201);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).state).toBe("CANCELLED");
    expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stock).toBe(5);
    expect(await ledgerBalance("cash:provider")).toBe(0);
  });

  it("refunds orders the seller doesn't ship in time", async () => {
    const { productId, storeId } = await setupSeller(app, admin);
    const buyer = await login(app, "buyer@example.test");
    const orderId = (await buy(buyer, productId, storeId)).body.orderIds[0];
    expect(await app.get(EscrowJobs).cancelUnshipped(new Date(Date.now() + 4 * 86_400_000))).toBe(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).state).toBe("CANCELLED");
  });
});

describe("disputes", () => {
  async function disputedOrder() {
    const setup = await setupSeller(app, admin);
    const buyer = await login(app, "buyer@example.test");
    const orderId = (await buy(buyer, setup.productId, setup.storeId)).body.orderIds[0];
    await shipAndGetCode(setup.seller, "buyer@example.test", orderId);
    const d = await buyer.post(`/api/orders/${orderId}/disputes`).send({ reason: "NOT_AS_DESCRIBED", description: "Left ear cup does not work." }).expect(201);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    return { ...setup, buyer, orderId, order, disputeId: d.body.id as string };
  }

  it("settles a partial refund the buyer accepts", async () => {
    const { seller, buyer, order, disputeId, storeId } = await disputedOrder();
    await seller.post(`/api/disputes/${disputeId}/offer`).send({ kind: "PARTIAL_REFUND", amountMinor: 3_000 }).expect(201);
    await buyer.post(`/api/disputes/${disputeId}/accept`).expect(201);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.state).toBe("PARTIALLY_REFUNDED");
    expect(after.refundedMinor).toBe(3_000);
    const fee = Math.round((order.totalMinor - 3_000) * 0.08);
    expect(await ledgerBalance(`seller:${storeId}:payable`)).toBe(-(order.totalMinor - 3_000 - fee));
    expect(await ledgerBalance(`escrow:order:${order.id}`)).toBe(0);
  });

  it("only lets the buyer escalate after declining or the deadline, then an agent decides", async () => {
    const { seller, buyer, order, disputeId } = await disputedOrder();
    await buyer.post(`/api/disputes/${disputeId}/escalate`).expect(409);
    await seller.post(`/api/disputes/${disputeId}/offer`).send({ kind: "PARTIAL_REFUND", amountMinor: 500 }).expect(201);
    await buyer.post(`/api/disputes/${disputeId}/decline`).expect(201);
    await buyer.post(`/api/disputes/${disputeId}/escalate`).expect(201);

    await login(app, "agent@example.test");
    await prisma.user.update({ where: { email: "agent@example.test" }, data: { roles: ["BUYER", "AGENT"] } });
    const agent = await login(app, "agent@example.test");
    await buyer.post(`/api/disputes/${disputeId}/decide`).send({ outcome: "FULL_REFUND", reasoning: "Buyer cannot decide." }).expect(403);
    expect((await agent.get("/api/admin/disputes").expect(200)).body).toHaveLength(1);
    await agent.post(`/api/disputes/${disputeId}/decide`).send({ outcome: "FULL_REFUND", reasoning: "Photos show the item is faulty." }).expect(201);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).state).toBe("REFUNDED");
    await agent.post(`/api/disputes/${disputeId}/decide`).send({ outcome: "RELEASE_TO_SELLER", reasoning: "Trying to pay twice." }).expect(409);
  });

  it("refunds the buyer when the seller ignores the dispute", async () => {
    const { order } = await disputedOrder();
    expect(await app.get(EscrowJobs).resolveUnansweredDisputes(new Date(Date.now() + 4 * 86_400_000))).toBe(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).state).toBe("REFUNDED");
  });
});

describe("messaging and safety", () => {
  it("flags off-platform contact attempts and respects blocks", async () => {
    const { seller, productId, storeId } = await setupSeller(app, admin);
    const buyer = await login(app, "buyer@example.test");
    const orderId = (await buy(buyer, productId, storeId)).body.orderIds[0];
    const m = await seller.post(`/api/orders/${orderId}/messages`).send({ body: "Cheaper if you pay me directly, email me at deal@example.com" }).expect(201);
    expect(m.body.flags).toEqual(expect.arrayContaining(["email", "offplatform_payment"]));

    const sellerId = (await prisma.user.findUniqueOrThrow({ where: { email: "seller@example.test" } })).id;
    await buyer.post(`/api/users/${sellerId}/block`).expect(204);
    await seller.post(`/api/orders/${orderId}/messages`).send({ body: "hello?" }).expect(403);
  });

  it("sends prohibited listings to review instead of going live", async () => {
    const { seller, categoryId } = await setupSeller(app, admin);
    const p = await seller.post("/api/products").send({
      title: "Replica designer watch", description: "Looks just like the real thing.", categoryId,
      priceMinor: 5000, stock: 3, condition: "NEW", weightGrams: 200, lengthCm: 10, widthCm: 10, heightCm: 5, images: [],
    }).expect(201);
    expect(p.body.status).toBe("PENDING_REVIEW");
    const search = await request(app.getHttpServer()).get("/api/products?q=replica").expect(200);
    expect(search.body.total).toBe(0);
  });

  it("strips GPS metadata from uploaded photos", async () => {
    const user = await login(app, "seller@example.test");
    const jpeg = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#c33" } })
      .jpeg()
      .withExif({ IFD3: { GPSLatitudeRef: "N", GPSLatitude: "40/1 42/1 0/1" } })
      .toBuffer();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    const res = await user.post("/api/uploads/images").attach("file", jpeg, { filename: "p.jpg", contentType: "image/jpeg" }).expect(201);
    const served = await request(app.getHttpServer()).get(res.body.url).expect(200);
    expect((await sharp(served.body).metadata()).exif).toBeUndefined();

    await user.post("/api/uploads/images").attach("file", Buffer.from("<script>alert(1)</script>"), { filename: "x.jpg", contentType: "image/jpeg" }).expect(400);
  });
});

describe("carrier webhook", () => {
  it("accepts only correctly signed delivery events", async () => {
    const { seller, productId, storeId } = await setupSeller(app, admin);
    const buyer = await login(app, "buyer@example.test");
    const orderId = (await buy(buyer, productId, storeId)).body.orderIds[0];
    await shipAndGetCode(seller, "buyer@example.test", orderId, "1Z999");

    const body = JSON.stringify({ carrier: "UPS", trackingNumber: "1Z999", event: "delivered", occurredAt: new Date().toISOString() });
    const server = request(app.getHttpServer());
    await server.post("/api/webhooks/carrier").set("Content-Type", "application/json").set("X-Signature", "00".repeat(32)).send(body).expect(401);
    const sig = createHmac("sha256", "test-carrier-webhook-secret").update(body).digest("hex");
    await server.post("/api/webhooks/carrier").set("Content-Type", "application/json").set("X-Signature", sig).send(body).expect(200);
    await server.post("/api/webhooks/carrier").set("Content-Type", "application/json").set("X-Signature", sig).send(body).expect(200); // replay is harmless
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.state).toBe("DELIVERED");
    expect(order.releaseAt).not.toBeNull();
  });
});

describe("catalog and recommendations", () => {
  it("searches by distance and recommends similar items", async () => {
    const { seller, productId, categoryId } = await setupSeller(app, admin);
    await seller.post("/api/products").send({
      title: "Wireless earbuds", description: "In-ear Bluetooth earbuds with case.", categoryId,
      priceMinor: 8_000, stock: 5, condition: "NEW", weightGrams: 100, lengthCm: 8, widthCm: 6, heightCm: 4, images: [],
    }).expect(201);
    const server = request(app.getHttpServer());
    const near = await server.get("/api/products?lat=40.73&lng=-73.99&maxKm=50&sort=nearest").expect(200);
    expect(near.body.total).toBe(2);
    expect(near.body.items[0].distanceKm).toBeLessThan(10);
    const far = await server.get("/api/products?lat=34.05&lng=-118.24&maxKm=100").expect(200);
    expect(far.body.total).toBe(0);
    const recs = await server.get(`/api/products/${productId}/recommendations`).expect(200);
    expect(recs.body.similar[0].title).toBe("Wireless earbuds");
    expect((await server.get("/api/products/trending").expect(200)).body.length).toBeGreaterThan(0);
  });
});
