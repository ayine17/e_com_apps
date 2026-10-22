/** Money is always an integer number of minor units (e.g. cents) plus a currency code. */

/** Applies a rate in basis points (1 bps = 0.01%), rounding half up to the nearest minor unit. */
export function applyBps(amountMinor: number, bps: number): number {
  assertMinor(amountMinor);
  return Math.round((amountMinor * bps) / 10_000);
}

export function assertMinor(amountMinor: number): void {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new Error(`Money amount must be an integer number of minor units, got ${amountMinor}`);
  }
}

export function formatMoney(amountMinor: number, currency: string, locale = "en-US"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amountMinor / 100);
}
