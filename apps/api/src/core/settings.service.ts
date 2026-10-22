import { Inject, Injectable } from "@nestjs/common";
import { AppConfig, CONFIG } from "../config";
import { PrismaService } from "./prisma.service";

/** Business rules an admin can change without a release (spec section 2.10). */
export const SETTING_DEFS = {
  PLATFORM_FEE_BPS: { label: "Platform fee (basis points, 800 = 8%)", min: 0, max: 5000 },
  RELEASE_AFTER_DAYS: { label: "Days after delivery before escrow auto-releases", min: 1, max: 60 },
  HANDLING_DAYS: { label: "Days a seller has to ship", min: 1, max: 30 },
  DISPUTE_RESPONSE_DAYS: { label: "Days a seller has to answer a dispute", min: 1, max: 30 },
  HIGH_VALUE_THRESHOLD_MINOR: { label: "High-value order threshold for new accounts (minor units)", min: 0, max: 100_000_000 },
  RETURN_CONFIRM_DAYS: { label: "Days a seller has to confirm a returned item before the buyer is refunded", min: 1, max: 60 },
  PAYOUT_HOLD_HOURS: { label: "Payout hold after changing payout account (hours)", min: 0, max: 720 },
} as const;

export type SettingKey = keyof typeof SETTING_DEFS;

const CACHE_MS = 15_000;

@Injectable()
export class SettingsService {
  private cache: { at: number; values: Record<string, number> } | null = null;

  constructor(private readonly prisma: PrismaService, @Inject(CONFIG) private readonly config: AppConfig) {}

  private defaults(): Record<SettingKey, number> {
    const c = this.config;
    return {
      PLATFORM_FEE_BPS: c.PLATFORM_FEE_BPS,
      RELEASE_AFTER_DAYS: c.RELEASE_AFTER_DAYS,
      HANDLING_DAYS: c.HANDLING_DAYS,
      DISPUTE_RESPONSE_DAYS: c.DISPUTE_RESPONSE_DAYS,
      HIGH_VALUE_THRESHOLD_MINOR: c.HIGH_VALUE_THRESHOLD_MINOR,
      RETURN_CONFIRM_DAYS: 14,
      PAYOUT_HOLD_HOURS: 72,
    };
  }

  async all(): Promise<Record<SettingKey, number>> {
    if (!this.cache || Date.now() - this.cache.at > CACHE_MS) {
      const rows = await this.prisma.platformSetting.findMany();
      this.cache = { at: Date.now(), values: Object.fromEntries(rows.map((r) => [r.key, r.value])) };
    }
    return { ...this.defaults(), ...this.cache.values } as Record<SettingKey, number>;
  }

  async get(key: SettingKey): Promise<number> {
    return (await this.all())[key];
  }

  clearCache() {
    this.cache = null;
  }

  async set(key: SettingKey, value: number, actorId: string): Promise<void> {
    await this.prisma.platformSetting.upsert({ where: { key }, update: { value, updatedBy: actorId }, create: { key, value, updatedBy: actorId } });
    this.cache = null;
  }
}
