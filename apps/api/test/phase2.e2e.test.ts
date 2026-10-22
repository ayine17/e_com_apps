import { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { FakePaymentProvider, PaymentProvider } from "../src/core/payments";
import { SettingsService } from "../src/core/settings.service";
import { EscrowJobs } from "../src/jobs/escrow-jobs.service";
import { CheckoutService } from "../src/orders/checkout.service";
import { Agent, buy, createApp, lastEmail, login, makeAdmin, NYC, PHILLY, prisma, resetDb, setupSeller } from "./helpers";

let app: NestExpressApplication;
let admin: Agent;
let provider: FakePaymentProvider;

const MIN = 60_000;
const DAY = 86_400_000;

beforeAll(async () => {
  app = await createApp();
  provider = app.get(PaymentProvider) as FakePaymentProvider;
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb();
  app.get(SettingsService).clearCache();
  provider.failRefunds = false;
  provider.throwOnCharge = false;
  await login(app, "admin@example.test");
  await makeAdmin("admin@example.test");
  admin = await login(app, "admin@example.test");
});

const balance = async (account: string) =>
  (await prisma.ledgerEntry.aggregate({ where: { account }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0;
const unbalanced = async () =>
  (await prisma.$queryRaw<unknown[]>`SELECT "txnId" FROM "LedgerEntry" GROUP BY "txnId" HAVING SUM("amountMinor") <> 0`).length;
const state = async (id: string) => (await prisma.order.findUniqueOrThrow({ where: { id } })).state;

async function paidOrder(opts: { stock?: number } = {}) {
  const s = await setupSeller(app, admin, "seller@example.test", { stock: opts.stock ?? 5 });
  const buyer = await login(app, "buyer@example.test");
  const res = await buy(buyer, s.productId, s.storeId);
  expect(res.status).toBe(201);
  return { ...s, buyer, orderId: res.body.orderIds[0] as string };
}

async function deliveredOrder() {
  const o = await paidOrder();
  await o.seller.post(`/api/orders/${o.orderId}/ship`).send({ carrier: "UPS", trackingNumber: "TRK100" }).expect(201);
  const code = (await lastEmail("buyer@example.test")).body.match(/delivery code is (\d{4})/)![1];
  await o.seller.post(`/api/orders/${o.orderId}/deliver`).send({ code }).expect(201);
  return o;
}

describe("review fixes", () => {
  it("never pays twice when a cancel races a shipment", async () => {
    for (let i = 0; i < 5; i++) {
      await resetDb();
      await login(app, "admin@example.test");
      await makeAdmin("admin@example.test");
      admin = await login(app, "admin@example.test");
      const o = await paidOrder();
      const [cancel, ship] = await Promise.all([
        o.buyer.post(`/api/orders/${o.orderId}/cancel`),
        o.seller.post(`/api/orders/${o.orderId}/ship`).send({ carrier: "UPS", trackingNumber: `RACE${i}` }),
      ]);
      // Exactly one wins.
      expect([cancel.status, ship.status].filter((s) => s === 201)).toHaveLength(1);
      const order = await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } });
      if (cancel.status === 201) {
        expect(order.state).toBe("CANCELLED");
        expect(order.refundStatus).toBe("DONE");
      } else {
        expect(order.state).toBe("SHIPPED");
        expect(order.refundStatus).toBe("NONE");
        expect(await balance(`escrow:order:${o.orderId}`)).toBe(-order.totalMinor);
      }
      expect(await unbalanced()).toBe(0);
    }
  });

  it("records a refund even when the provider is down, and retries it", async () => {
    const o = await paidOrder();
    provider.failRefunds = true;
    await o.buyer.post(`/api/orders/${o.orderId}/cancel`).expect(201);
    let order = await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } });
    expect(order.state).toBe("CANCELLED");
    expect(order.refundStatus).toBe("PENDING");
    // A shipment can no longer sneak in.
    await o.seller.post(`/api/orders/${o.orderId}/ship`).send({ carrier: "UPS", trackingNumber: "LATE1" }).expect(409);
    provider.failRefunds = false;
    expect(await app.get(EscrowJobs).retryRefunds(new Date(Date.now() + 2 * MIN))).toBe(1);
    order = await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } });
    expect(order.refundStatus).toBe("DONE");
  });

  it("recovers a checkout whose charge timed out after the money was taken", async () => {
    const s = await setupSeller(app, admin);
    const buyer = await login(app, "buyer@example.test");
    provider.throwOnCharge = "after";
    expect((await buy(buyer, s.productId, s.storeId)).status).toBe(502);
    provider.throwOnCharge = false;
    const order = await prisma.order.findFirstOrThrow();
    expect(order.state).toBe("PENDING_PAYMENT");
    expect(await app.get(CheckoutService).recoverPendingPayments(new Date(Date.now() + 11 * MIN))).toBe(1);
    expect(await state(order.id)).toBe("PAID");
    expect(await balance(`escrow:order:${order.id}`)).toBe(-order.totalMinor);
  });

  it("cancels and restocks a checkout that was never charged", async () => {
    const s = await setupSeller(app, admin);
    const buyer = await login(app, "buyer@example.test");
    provider.throwOnCharge = "before";
    expect((await buy(buyer, s.productId, s.storeId, { quantity: 2 })).status).toBe(502);
    provider.throwOnCharge = false;
    const svc = app.get(CheckoutService);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: s.productId } })).stock).toBe(3);
    expect(await svc.recoverPendingPayments(new Date(Date.now() + 11 * MIN))).toBe(1);
    expect((await prisma.order.findFirstOrThrow()).state).toBe("CANCELLED");
    expect((await prisma.product.findUniqueOrThrow({ where: { id: s.productId } })).stock).toBe(5);
  });

  it("lets a seller offer a full refund in a dispute", async () => {
    const o = await deliveredOrder();
    const d = await o.buyer.post(`/api/orders/${o.orderId}/disputes`).send({ reason: "DAMAGED", description: "The case is cracked." }).expect(201);
    await o.seller.post(`/api/disputes/${d.body.id}/offer`).send({ kind: "FULL_REFUND" }).expect(201);
    await o.buyer.post(`/api/disputes/${d.body.id}/accept`).expect(201);
    expect(await state(o.orderId)).toBe("REFUNDED");
  });

  it("doesn't let the buyer release a disputed order by confirming it", async () => {
    const o = await deliveredOrder();
    await o.buyer.post(`/api/orders/${o.orderId}/disputes`).send({ reason: "DAMAGED", description: "The case is cracked." }).expect(201);
    await o.buyer.post(`/api/orders/${o.orderId}/confirm`).expect(409);
    expect(await state(o.orderId)).toBe("DISPUTED");
  });

  it("never shows the buyer's email to the seller", async () => {
    const o = await paidOrder();
    const view = await o.seller.get(`/api/orders/${o.orderId}`).expect(200);
    expect(JSON.stringify(view.body)).not.toContain("buyer@example.test");
  });
});

describe("reviews", () => {
  it("lets a buyer review a completed order once, and the seller reply once", async () => {
    const o = await deliveredOrder();
    await o.buyer.post(`/api/orders/${o.orderId}/reviews`).send({ productId: o.productId, rating: 4 }).expect(409); // not complete yet
    await o.buyer.post(`/api/orders/${o.orderId}/confirm`).expect(201);
    const r = await o.buyer.post(`/api/orders/${o.orderId}/reviews`).send({ productId: o.productId, rating: 4, body: "Great sound" }).expect(201);
    await o.buyer.post(`/api/orders/${o.orderId}/reviews`).send({ productId: o.productId, rating: 5 }).expect(409);
    await o.buyer.post(`/api/reviews/${r.body.id}/reply`).send({ reply: "Me again" }).expect(404);
    await o.seller.post(`/api/reviews/${r.body.id}/reply`).send({ reply: "Thank you!" }).expect(201);
    await o.seller.post(`/api/reviews/${r.body.id}/reply`).send({ reply: "Twice" }).expect(409);
    const list = await request(app.getHttpServer()).get(`/api/products/${o.productId}/reviews`).expect(200);
    expect(list.body).toMatchObject({ average: 4, total: 1 });
    expect(list.body.items[0].sellerReply).toBe("Thank you!");
    const product = await request(app.getHttpServer()).get(`/api/products/${o.productId}`).expect(200);
    expect(product.body.rating).toEqual({ average: 4, count: 1 });
  });
});

describe("returns", () => {
  it("refunds a faulty item in full once the seller confirms it came back", async () => {
    const o = await deliveredOrder();
    const ret = await o.buyer.post(`/api/orders/${o.orderId}/returns`).send({ reason: "DAMAGED", description: "Arrived with a cracked case." }).expect(201);
    expect(ret.body.returnPaidBy).toBe("SELLER");
    // Escrow must not auto-release while a return is open.
    expect(await app.get(EscrowJobs).autoRelease(new Date(Date.now() + 30 * DAY))).toBe(0);
    await o.seller.post(`/api/returns/${ret.body.id}/receive`).expect(409); // not shipped yet
    await o.buyer.post(`/api/returns/${ret.body.id}/ship`).send({ carrier: "UPS", trackingNumber: "RET123" }).expect(201);
    await o.seller.post(`/api/returns/${ret.body.id}/receive`).expect(201);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } });
    expect(order.state).toBe("REFUNDED");
    expect(order.refundedMinor).toBe(order.totalMinor);
  });

  it("refunds only the items for a change of mind, and refunds automatically if the seller stays silent", async () => {
    const o = await deliveredOrder();
    const ret = await o.buyer.post(`/api/orders/${o.orderId}/returns`).send({ reason: "CHANGE_OF_MIND", description: "Doesn't suit me after all." }).expect(201);
    await o.buyer.post(`/api/returns/${ret.body.id}/ship`).send({ carrier: "UPS", trackingNumber: "RET456" }).expect(201);
    expect(await app.get(EscrowJobs).settleReturns(new Date(Date.now() + 15 * DAY))).toBe(1);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } });
    expect(order.state).toBe("PARTIALLY_REFUNDED");
    expect(order.refundedMinor).toBe(order.subtotalMinor);
    expect(await unbalanced()).toBe(0);
  });

  it("refuses change-of-mind returns when the store doesn't allow them", async () => {
    const o = await deliveredOrder();
    await o.seller.patch("/api/stores/me/settings").send({ returnPolicyDays: 0, freeShippingOverMinor: null }).expect(200);
    await o.buyer.post(`/api/orders/${o.orderId}/returns`).send({ reason: "CHANGE_OF_MIND", description: "Changed my mind about it." }).expect(409);
  });

  it("sends a disputed return straight to the resolution team", async () => {
    const o = await deliveredOrder();
    const ret = await o.buyer.post(`/api/orders/${o.orderId}/returns`).send({ reason: "NOT_AS_DESCRIBED", description: "Colour is different." }).expect(201);
    await o.buyer.post(`/api/returns/${ret.body.id}/ship`).send({ carrier: "UPS", trackingNumber: "RET789" }).expect(201);
    await o.seller.post(`/api/returns/${ret.body.id}/dispute`).send({ description: "The box came back empty." }).expect(201);
    expect(await state(o.orderId)).toBe("DISPUTED");
    const disputes = await admin.get("/api/admin/disputes").expect(200);
    expect(disputes.body[0].reason).toBe("RETURN_PROBLEM");
    // Not auto-refunded by the job while the team decides.
    expect(await app.get(EscrowJobs).settleReturns(new Date(Date.now() + 30 * DAY))).toBe(0);
  });

  it("releases payment if the buyer never sends the return", async () => {
    const o = await deliveredOrder();
    await o.buyer.post(`/api/orders/${o.orderId}/returns`).send({ reason: "WRONG_ITEM", description: "Got the blue one." }).expect(201);
    expect(await app.get(EscrowJobs).settleReturns(new Date(Date.now() + 15 * DAY))).toBe(1);
    expect(await state(o.orderId)).toBe("COMPLETED");
  });
});

describe("promotions", () => {
  it("applies a seller coupon and the free-delivery threshold, and limits coupon uses", async () => {
    const s = await setupSeller(app, admin);
    await s.seller.post("/api/stores/me/coupons").send({ code: "save10", kind: "PERCENT", value: 1000, maxUses: 1 }).expect(201);
    await s.seller.patch("/api/stores/me/settings").send({ returnPolicyDays: 14, freeShippingOverMinor: 5_000 }).expect(200);
    const buyer = await login(app, "buyer@example.test");
    const addr = await buyer.post("/api/addresses").send(PHILLY).expect(201);
    const items = [{ productId: s.productId, quantity: 1 }];
    const q = await buyer.post("/api/shipping/quotes").send({ items, addressId: addr.body.id, coupons: { [s.storeId]: "SAVE10" } }).expect(201);
    expect(q.body.stores[0]).toMatchObject({ discountMinor: 1_000, freeShipping: true, couponCode: "SAVE10" });
    expect(q.body.stores[0].options[0].amountMinor).toBe(0);
    const res = await buyer.post("/api/checkout").send({ items, addressId: addr.body.id, shipping: { [s.storeId]: "standard" }, coupons: { [s.storeId]: "save10" } }).expect(201);
    expect(res.body.totalMinor).toBe(9_000);
    const again = await buyer.post("/api/checkout").send({ items, addressId: addr.body.id, shipping: { [s.storeId]: "standard" }, coupons: { [s.storeId]: "SAVE10" } });
    expect(again.status).toBe(400);
    expect(again.body.message).toMatch(/fully used/);
  });

  it("blocks buying from a store that shares your address", async () => {
    const s = await setupSeller(app, admin);
    const buyer = await login(app, "buyer@example.test");
    const addr = await buyer.post("/api/addresses").send(NYC).expect(201);
    const res = await buyer.post("/api/checkout").send({ items: [{ productId: s.productId, quantity: 1 }], addressId: addr.body.id, shipping: { [s.storeId]: "standard" } });
    expect(res.status).toBe(403);
  });
});

describe("shared device", () => {
  it("adds risk instead of blocking when a buyer shares a device with the seller", async () => {
    const s = await setupSeller(app, admin);
    // Same browser (same device cookie) logs in as the seller, then as the buyer.
    const device = request.agent(app.getHttpServer());
    for (const email of ["seller@example.test", "buyer@example.test"]) {
      await device.post("/api/auth/otp").send({ email }).expect(202);
      const c = (await lastEmail(email)).subject.match(/(\d{6})/)![1];
      await device.post("/api/auth/verify").send({ email, code: c }).expect(201);
    }
    const res = await buy(device, s.productId, s.storeId);
    expect(res.status).toBe(201);
    const order = await prisma.order.findFirstOrThrow();
    expect(order.riskHits).toEqual(expect.arrayContaining([expect.objectContaining({ rule: "shares_device_with_seller" })]));
  });
});

describe("wishlist alerts", () => {
  it("notifies savers about a price drop once", async () => {
    const s = await setupSeller(app, admin);
    const buyer = await login(app, "buyer@example.test");
    await buyer.put(`/api/me/wishlist/${s.productId}`).expect(204);
    const product = await prisma.product.findUniqueOrThrow({ where: { id: s.productId } });
    const edit = { title: product.title, description: product.description, categoryId: product.categoryId, stock: 5, condition: "NEW", weightGrams: 400, lengthCm: 20, widthCm: 15, heightCm: 8, images: [] };
    await s.seller.patch(`/api/products/${s.productId}`).send({ ...edit, priceMinor: 8_000 }).expect(200);
    await s.seller.patch(`/api/products/${s.productId}`).send({ ...edit, priceMinor: 8_000, stock: 4 }).expect(200);
    const n = await buyer.get("/api/me/notifications").expect(200);
    expect(n.body.items.filter((x: { title: string }) => x.title.startsWith("Price drop"))).toHaveLength(1);
    expect(n.body.unread).toBeGreaterThan(0);
    await buyer.post("/api/me/notifications/read").expect(204);
    expect((await buyer.get("/api/me/notifications")).body.unread).toBe(0);
  });
});

describe("payouts", () => {
  async function completedSale() {
    const o = await deliveredOrder();
    await o.buyer.post(`/api/orders/${o.orderId}/confirm`).expect(201);
    return o;
  }
  async function code(email: string) {
    await request(app.getHttpServer()).post("/api/auth/otp").send({ email }).expect(202);
    return (await lastEmail(email)).subject.match(/(\d{6})/)![1];
  }

  it("needs a fresh code to set the payout account, pays out the balance, and holds after a change", async () => {
    const o = await completedSale();
    await o.seller.post("/api/stores/me/payout-account").send({ accountRef: "acct_first1", code: "000000" }).expect(401);
    const c1 = await code("seller@example.test");
    await o.seller.post("/api/stores/me/payout-account").send({ accountRef: "acct_first1", code: c1 }).expect(201);
    const before = (await o.seller.get("/api/stores/me/payouts").expect(200)).body.availableMinor;
    expect(before).toBeGreaterThan(0);
    const p = await o.seller.post("/api/stores/me/payouts").expect(201);
    expect(p.body).toMatchObject({ status: "PAID", amountMinor: before });
    expect((await o.seller.get("/api/stores/me/payouts")).body.availableMinor).toBe(0);
    await o.seller.post("/api/stores/me/payouts").expect(409); // nothing left
    expect(await unbalanced()).toBe(0);

    // Changing the account starts a 72-hour hold.
    const c2 = await code("seller@example.test");
    await o.seller.post("/api/stores/me/payout-account").send({ accountRef: "acct_second2", code: c2 }).expect(201);
    const info = (await o.seller.get("/api/stores/me/payouts")).body;
    expect(info.account).toBe("••••ond2");
    expect(new Date(info.holdUntil).getTime()).toBeGreaterThan(Date.now() + 71 * 3_600_000);
  });
});

describe("account security and privacy", () => {
  it("alerts on a login from a new device", async () => {
    await login(app, "buyer@example.test");
    await login(app, "buyer@example.test");
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "buyer@example.test" } });
    expect(await prisma.notification.count({ where: { userId: user.id, title: "New login to your account" } })).toBe(1);
  });

  it("exports data and deletes the account, but not with open orders", async () => {
    const o = await paidOrder();
    const exp = await o.buyer.get("/api/me/export").expect(200);
    expect(exp.body.account.email).toBe("buyer@example.test");
    expect(exp.body.orders).toHaveLength(1);
    await o.buyer.delete("/api/me").expect(409);
    await o.buyer.post(`/api/orders/${o.orderId}/cancel`).expect(201);
    await o.buyer.delete("/api/me").expect(204);
    await o.buyer.get("/api/auth/me").expect(401);
    const user = await prisma.user.findFirstOrThrow({ where: { deletedAt: { not: null } } });
    expect(user.email).toMatch(/@deleted\.invalid$/);
    expect(await prisma.address.count({ where: { userId: user.id } })).toBe(0);
  });
});

describe("admin", () => {
  it("changes the platform fee through settings", async () => {
    await admin.put("/api/admin/settings/PLATFORM_FEE_BPS").send({ value: 99_999 }).expect(400);
    await admin.put("/api/admin/settings/PLATFORM_FEE_BPS").send({ value: 500 }).expect(200);
    const o = await deliveredOrder();
    await o.buyer.post(`/api/orders/${o.orderId}/confirm`).expect(201);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } });
    expect(order.feeMinor).toBe(Math.round(order.totalMinor * 0.05));
    const audit = await admin.get("/api/admin/audit").expect(200);
    expect(audit.body.some((a: { action: string }) => a.action === "settings.update")).toBe(true);
  });

  it("reports analytics and linked accounts", async () => {
    const o = await deliveredOrder();
    await o.buyer.post(`/api/orders/${o.orderId}/confirm`).expect(201);
    const a = await admin.get("/api/admin/analytics").expect(200);
    expect(a.body).toMatchObject({ orders: 1, buyers: 1, onTimeShippingPct: 100, takeRatePct: 8 });
    const twin = await login(app, "twin@example.test");
    await twin.post("/api/addresses").send(PHILLY).expect(201);
    const buyerId = (await prisma.user.findUniqueOrThrow({ where: { email: "buyer@example.test" } })).id;
    const links = await admin.get(`/api/admin/users/${buyerId}/links`).expect(200);
    expect(links.body.linked).toEqual([expect.objectContaining({ email: "twin@example.test", reasons: ["same address"] })]);
  });

  it("returns 404 instead of crashing when suspending a missing user", async () => {
    const reporter = await login(app, "reporter@example.test");
    await reporter.post("/api/reports").send({ targetType: "USER", targetId: "00000000-0000-4000-8000-000000000000", reason: "Scammer" }).expect(201);
    const report = await prisma.report.findFirstOrThrow();
    await admin.post(`/api/admin/reports/${report.id}`).send({ action: "suspend_user" }).expect(404);
  });
});
