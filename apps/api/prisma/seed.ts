/* Development seed: categories, an admin, a verified seller with listings, and a buyer.
 * Log in as any of these at the web app; read the code in the dev inbox (/dev/inbox). */
import { PrismaClient } from "@prisma/client";
import { addressFingerprint } from "../src/core/risk.service";

try {
  process.loadEnvFile();
} catch {}

const prisma = new PrismaClient();

const CATEGORIES = [
  ["electronics", "Electronics"], ["phones", "Phones & tablets"], ["fashion", "Fashion"], ["home", "Home & kitchen"],
  ["beauty", "Health & beauty"], ["sports", "Sports & outdoors"], ["books", "Books"], ["toys", "Toys & games"],
] as const;

const fp = (line1: string, city: string, country: string) => addressFingerprint({ line1, city, country });

async function main() {
  const cats: Record<string, string> = {};
  for (const [slug, name] of CATEGORIES) {
    const c = await prisma.category.upsert({ where: { slug }, update: { name }, create: { slug, name } });
    cats[slug] = c.id;
  }

  await prisma.user.upsert({ where: { email: "admin@example.test" }, update: { roles: ["BUYER", "ADMIN"] }, create: { email: "admin@example.test", name: "Admin", roles: ["BUYER", "ADMIN"] } });
  await prisma.user.upsert({ where: { email: "agent@example.test" }, update: { roles: ["BUYER", "AGENT"] }, create: { email: "agent@example.test", name: "Resolution Agent", roles: ["BUYER", "AGENT"] } });

  const sellers = [
    { email: "seller@example.test", name: "Ada's Electronics", city: "New York", lat: 40.7128, lng: -74.006, line1: "100 Broadway" },
    { email: "seller2@example.test", name: "Boston Home Goods", city: "Boston", lat: 42.3601, lng: -71.0589, line1: "1 Beacon St" },
  ];
  const storeIds: string[] = [];
  for (const s of sellers) {
    const user = await prisma.user.upsert({ where: { email: s.email }, update: {}, create: { email: s.email, name: s.name, roles: ["BUYER", "SELLER"] } });
    if (!(await prisma.address.findFirst({ where: { userId: user.id } }))) {
      await prisma.address.create({ data: { userId: user.id, label: "Warehouse", line1: s.line1, city: s.city, country: "US", lat: s.lat, lng: s.lng, fingerprint: fp(s.line1, s.city, "US") } });
    }
    const slug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-$/, "");
    const store = await prisma.store.upsert({
      where: { ownerId: user.id },
      update: {},
      create: { ownerId: user.id, name: s.name, slug, description: `Welcome to ${s.name}.`, verificationStatus: "VERIFIED", returnPolicyDays: 14, city: s.city, country: "US", lat: s.lat, lng: s.lng },
    });
    storeIds.push(store.id);
  }

  const buyer = await prisma.user.upsert({ where: { email: "buyer@example.test" }, update: {}, create: { email: "buyer@example.test", name: "Ben Buyer" } });
  if (!(await prisma.address.findFirst({ where: { userId: buyer.id } }))) {
    await prisma.address.create({ data: { userId: buyer.id, label: "Home", line1: "200 Market St", city: "Philadelphia", country: "US", lat: 39.9526, lng: -75.1652, fingerprint: fp("200 Market St", "Philadelphia", "US") } });
  }

  if ((await prisma.product.count()) === 0) {
    const P = (storeIdx: number, category: string, title: string, priceMinor: number, weightGrams: number, dims: [number, number, number], description: string) => ({
      storeId: storeIds[storeIdx], categoryId: cats[category], title, description, priceMinor, currency: process.env.PLATFORM_CURRENCY ?? "USD",
      stock: 10, condition: "NEW" as const, weightGrams, lengthCm: dims[0], widthCm: dims[1], heightCm: dims[2], images: [],
    });
    await prisma.product.createMany({
      data: [
        P(0, "electronics", "Wireless noise-cancelling headphones", 12900, 450, [22, 18, 9], "Over-ear Bluetooth headphones with 30-hour battery and active noise cancelling."),
        P(0, "electronics", "Portable Bluetooth speaker", 4900, 600, [18, 8, 8], "Waterproof speaker with 12-hour battery. Pairs with any phone."),
        P(0, "phones", "Refurbished smartphone 128 GB", 24900, 300, [17, 9, 5], "Fully tested, unlocked, with a 6-month warranty and charger."),
        P(0, "electronics", "USB-C fast charger 65 W", 2900, 150, [8, 6, 4], "Charges laptops, tablets and phones. Two USB-C ports."),
        P(1, "home", "Cast iron skillet 26 cm", 3900, 2500, [45, 28, 6], "Pre-seasoned cast iron pan for stovetop and oven."),
        P(1, "home", "Ceramic dinner plate set (6)", 5400, 4000, [30, 30, 15], "Six stoneware dinner plates, dishwasher and microwave safe."),
        P(1, "home", "Linen throw blanket", 6900, 1200, [40, 30, 10], "Soft washed linen throw, 130 × 170 cm."),
        P(1, "books", "Beginner's guide to home cooking", 1900, 700, [24, 18, 3], "Over 100 simple recipes with step-by-step photos."),
      ],
    });
  }
  console.log("Seeded. Log in as admin@example.test, seller@example.test or buyer@example.test.");
}

main().finally(() => prisma.$disconnect());
