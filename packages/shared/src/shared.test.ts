import {
  applyBps, assertTransition, canTransition, chargeableWeightKg, detectOffPlatformSignals,
  haversineKm, isSuspiciouslyCheap, quoteShipping, scoreCheckout, CheckoutSignals,
} from "./index";

describe("money", () => {
  it("applies basis points with rounding", () => {
    expect(applyBps(10_000, 800)).toBe(800);
    expect(applyBps(1_005, 1000)).toBe(101); // 100.5 rounds up
  });
  it("rejects fractional amounts", () => {
    expect(() => applyBps(10.5, 100)).toThrow();
  });
});

describe("order state machine", () => {
  it("allows the happy path", () => {
    expect(canTransition("PENDING_PAYMENT", "PAID")).toBe(true);
    expect(canTransition("PAID", "SHIPPED")).toBe(true);
    expect(canTransition("SHIPPED", "DELIVERED")).toBe(true);
    expect(canTransition("DELIVERED", "COMPLETED")).toBe(true);
  });
  it("blocks skipping steps and leaving final states", () => {
    expect(canTransition("PAID", "COMPLETED")).toBe(false);
    expect(canTransition("COMPLETED", "REFUNDED")).toBe(false);
    expect(() => assertTransition("CANCELLED", "PAID")).toThrow(/cannot move/);
  });
  it("does not allow cancelling after shipping", () => {
    expect(canTransition("SHIPPED", "CANCELLED")).toBe(false);
  });
});

describe("shipping", () => {
  it("computes distance between Accra and Kumasi (~200 km)", () => {
    const km = haversineKm({ lat: 5.6037, lng: -0.187 }, { lat: 6.6885, lng: -1.6244 });
    expect(km).toBeGreaterThan(190);
    expect(km).toBeLessThan(205);
  });
  it("uses volumetric weight when the parcel is bulky", () => {
    // 50×40×30 cm = 12 kg volumetric, 2 kg actual
    expect(chargeableWeightKg([{ weightGrams: 2000, lengthCm: 50, widthCm: 40, heightCm: 30, quantity: 1 }])).toBe(12);
  });
  it("quotes standard cheaper than express and adds days for distance", () => {
    const quotes = quoteShipping({ lat: 0, lng: 0 }, { lat: 0, lng: 10 }, [
      { weightGrams: 500, lengthCm: 10, widthCm: 10, heightCm: 10, quantity: 2 },
    ]);
    const [std, exp] = quotes;
    expect(std.amountMinor).toBeLessThan(exp.amountMinor);
    expect(std.distanceKm).toBeGreaterThan(1400);
    expect(std.minDays).toBeGreaterThan(2);
  });
});

describe("fraud scoring", () => {
  const base: CheckoutSignals = {
    accountAgeHours: 500, orderTotalMinor: 5_000, highValueThresholdMinor: 50_000,
    failedPaymentsLastHour: 0, linkedToSuspendedUser: false, providerElevatedRisk: false,
    otherAccountsOnAddress30d: 0, completedOrders: 0, disputesOpened: 0,
  };
  it("allows a normal order", () => {
    expect(scoreCheckout(base)).toMatchObject({ score: 0, action: "ALLOW" });
  });
  it("steps up a new account placing a large order", () => {
    const r = scoreCheckout({ ...base, accountAgeHours: 2, orderTotalMinor: 80_000 });
    expect(r.action).toBe("STEP_UP");
    expect(r.hits.map((h) => h.rule)).toContain("new_account_high_value");
  });
  it("holds when linked to a suspended user", () => {
    expect(scoreCheckout({ ...base, linkedToSuspendedUser: true }).action).toBe("HOLD");
  });
  it("blocks when several strong signals combine", () => {
    expect(scoreCheckout({ ...base, linkedToSuspendedUser: true, providerElevatedRisk: true }).action).toBe("BLOCK");
  });
  it("steps up a buyer who shares a device with the seller", () => {
    expect(scoreCheckout({ ...base, sharesDeviceWithSeller: true }).action).toBe("STEP_UP");
  });
  it("never scores below zero for trusted customers", () => {
    expect(scoreCheckout({ ...base, completedOrders: 10 }).score).toBe(0);
  });
  it("flags listings far below the category median", () => {
    expect(isSuspiciouslyCheap(500, 2000)).toBe(true);
    expect(isSuspiciouslyCheap(1500, 2000)).toBe(false);
    expect(isSuspiciouslyCheap(500, null)).toBe(false);
  });
});

describe("off-platform detection", () => {
  it("finds emails, phones, links and payment requests", () => {
    expect(detectOffPlatformSignals("email me at a.b@example.com")).toEqual(["email"]);
    expect(detectOffPlatformSignals("call +233 24 123 4567")).toEqual(["phone"]);
    expect(detectOffPlatformSignals("see www.cheap-deals.biz")).toEqual(["link"]);
    expect(detectOffPlatformSignals("just pay me directly via western union")).toContain("offplatform_payment");
  });
  it("ignores normal messages", () => {
    expect(detectOffPlatformSignals("Shipped today, should arrive in 3 days")).toEqual([]);
  });
});

describe("promotions", () => {
  const { couponDiscount, qualifiesForFreeShipping, canTransition: ct } = require("./index");
  const base = { kind: "PERCENT", value: 1000, minSubtotalMinor: 0, maxUses: null, usedCount: 0, expiresAt: null, active: true };
  it("applies percentage and fixed discounts, capped at the subtotal", () => {
    expect(couponDiscount(base, 5000)).toEqual({ ok: true, discountMinor: 500 });
    expect(couponDiscount({ ...base, kind: "FIXED", value: 9000 }, 5000)).toEqual({ ok: true, discountMinor: 5000 });
  });
  it("rejects expired, used-up, inactive and below-minimum codes", () => {
    expect(couponDiscount({ ...base, expiresAt: "2000-01-01T00:00:00Z" }, 5000).ok).toBe(false);
    expect(couponDiscount({ ...base, maxUses: 2, usedCount: 2 }, 5000).ok).toBe(false);
    expect(couponDiscount({ ...base, active: false }, 5000).ok).toBe(false);
    expect(couponDiscount({ ...base, minSubtotalMinor: 6000 }, 5000).ok).toBe(false);
  });
  it("applies free delivery at or above the threshold only", () => {
    expect(qualifiesForFreeShipping(5000, 5000)).toBe(true);
    expect(qualifiesForFreeShipping(4999, 5000)).toBe(false);
    expect(qualifiesForFreeShipping(99999, null)).toBe(false);
  });
  it("allows partial refunds after a return", () => {
    expect(ct("RETURN_REQUESTED", "PARTIALLY_REFUNDED")).toBe(true);
  });
});
