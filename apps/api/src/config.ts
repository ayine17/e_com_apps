import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  PORT: z.coerce.number().int().default(4000),
  PLATFORM_CURRENCY: z.string().length(3).default("USD"),
  PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(5000).default(800),
  RELEASE_AFTER_DAYS: z.coerce.number().min(0).default(7),
  HANDLING_DAYS: z.coerce.number().min(0).default(3),
  DISPUTE_RESPONSE_DAYS: z.coerce.number().min(0).default(3),
  HIGH_VALUE_THRESHOLD_MINOR: z.coerce.number().int().default(50_000),
  PAYMENT_PROVIDER: z.enum(["fake"]).default("fake"),
  CARRIER_WEBHOOK_SECRET: z.string().min(16),
  UPLOAD_DIR: z.string().default("uploads"),
});

export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | undefined;

export function loadConfig(): AppConfig {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(`Invalid environment configuration:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
    }
    if (parsed.data.NODE_ENV === "production" && parsed.data.PAYMENT_PROVIDER === "fake") {
      throw new Error("The fake payment provider cannot be used in production");
    }
    cached = parsed.data;
  }
  return cached;
}

export const CONFIG = Symbol("CONFIG");

export const DAY_MS = 24 * 60 * 60 * 1000;
