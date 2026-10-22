import { Test } from "@nestjs/testing";
import { NestExpressApplication } from "@nestjs/platform-express";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/setup";

export const prisma = new PrismaClient();

export async function createApp(): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
  configureApp(app);
  await app.init();
  return app;
}

export async function resetDb() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
}

export type Agent = ReturnType<typeof request.agent>;

/** Logs in through the real OTP flow, reading the code from the email outbox. */
export async function login(app: NestExpressApplication, email: string): Promise<Agent> {
  const agent = request.agent(app.getHttpServer());
  await agent.post("/api/auth/otp").send({ email }).expect(202);
  const mail = await prisma.emailOutbox.findFirstOrThrow({ where: { to: email }, orderBy: { createdAt: "desc" } });
  const code = mail.subject.match(/(\d{6})/)![1];
  await agent.post("/api/auth/verify").send({ email, code }).expect(201);
  return agent;
}

export async function lastEmail(to: string) {
  return prisma.emailOutbox.findFirstOrThrow({ where: { to }, orderBy: { createdAt: "desc" } });
}

export async function makeAdmin(email: string) {
  await prisma.user.update({ where: { email }, data: { roles: ["BUYER", "ADMIN"] } });
}

export const NYC = { line1: "100 Broadway", city: "New York", country: "US", lat: 40.7128, lng: -74.006 };
export const PHILLY = { line1: "200 Market St", city: "Philadelphia", country: "US", lat: 39.9526, lng: -75.1652 };

/** Creates a verified seller with one listing. Returns the seller agent, product id and store id. */
export async function setupSeller(app: NestExpressApplication, admin: Agent, email = "seller@example.test", product: Record<string, unknown> = {}) {
  const seller = await login(app, email);
  const addr = await seller.post("/api/addresses").send(NYC).expect(201);
  const store = await seller.post("/api/stores").send({ name: "Test Store", returnPolicyDays: 14, pickupAddressId: addr.body.id }).expect(201);
  await admin.post(`/api/admin/stores/${store.body.id}/verify`).send({ approve: true }).expect(201);
  let category = await prisma.category.findFirst({ where: { slug: "electronics" } });
  category ??= await prisma.category.create({ data: { slug: "electronics", name: "Electronics" } });
  const p = await seller.post("/api/products").send({
    title: "Wireless headphones", description: "Over-ear Bluetooth headphones.", categoryId: category.id,
    priceMinor: 10_000, stock: 5, condition: "NEW", weightGrams: 400, lengthCm: 20, widthCm: 15, heightCm: 8, images: [],
    ...product,
  }).expect(201);
  return { seller, productId: p.body.id as string, storeId: store.body.id as string, categoryId: category.id };
}

/** Buyer with an address, checking out one product with standard shipping. */
export async function buy(buyer: Agent, productId: string, storeId: string, opts: { quantity?: number; testCard?: string } = {}) {
  const addr = await buyer.post("/api/addresses").send(PHILLY).expect(201);
  const items = [{ productId, quantity: opts.quantity ?? 1 }];
  return buyer.post("/api/checkout").send({ items, addressId: addr.body.id, shipping: { [storeId]: "standard" }, testCard: opts.testCard });
}
