/**
 * Rule-based risk scoring (spec section 6). Pure function: the API gathers the signals,
 * this decides the score and action so the rules are easy to test and tune.
 */

export type RiskAction = "ALLOW" | "STEP_UP" | "HOLD" | "BLOCK";

export interface CheckoutSignals {
  accountAgeHours: number;
  orderTotalMinor: number;
  /** Orders above this from very new accounts are risky. */
  highValueThresholdMinor: number;
  failedPaymentsLastHour: number;
  linkedToSuspendedUser: boolean;
  providerElevatedRisk: boolean;
  /** Other accounts that used the same shipping address in the last 30 days. */
  otherAccountsOnAddress30d: number;
  completedOrders: number;
  disputesOpened: number;
  /** The buyer has logged in on the same device as one of the sellers (possible self-dealing). */
  sharesDeviceWithSeller?: boolean;
}

export interface RiskRuleHit {
  rule: string;
  points: number;
}

export interface RiskResult {
  score: number;
  action: RiskAction;
  hits: RiskRuleHit[];
}

export interface RiskThresholds {
  stepUp: number;
  hold: number;
  block: number;
}

export const DEFAULT_THRESHOLDS: RiskThresholds = { stepUp: 30, hold: 60, block: 85 };

type Rule = { rule: string; points: number; when: (s: CheckoutSignals) => boolean };

export const CHECKOUT_RULES: Rule[] = [
  {
    rule: "new_account_high_value",
    points: 30,
    when: (s) => s.accountAgeHours < 24 && s.orderTotalMinor > s.highValueThresholdMinor,
  },
  { rule: "failed_payments_velocity", points: 35, when: (s) => s.failedPaymentsLastHour >= 3 },
  { rule: "linked_to_suspended_user", points: 60, when: (s) => s.linkedToSuspendedUser },
  { rule: "provider_elevated_risk", points: 40, when: (s) => s.providerElevatedRisk },
  { rule: "shared_shipping_address", points: 25, when: (s) => s.otherAccountsOnAddress30d >= 3 },
  { rule: "shares_device_with_seller", points: 40, when: (s) => !!s.sharesDeviceWithSeller },
  {
    rule: "trusted_returning_customer",
    points: -20,
    when: (s) => s.completedOrders >= 5 && s.disputesOpened === 0,
  },
];

export function actionForScore(score: number, t: RiskThresholds = DEFAULT_THRESHOLDS): RiskAction {
  if (score >= t.block) return "BLOCK";
  if (score >= t.hold) return "HOLD";
  if (score >= t.stepUp) return "STEP_UP";
  return "ALLOW";
}

export function scoreCheckout(signals: CheckoutSignals, thresholds: RiskThresholds = DEFAULT_THRESHOLDS): RiskResult {
  const hits = CHECKOUT_RULES.filter((r) => r.when(signals)).map(({ rule, points }) => ({ rule, points }));
  const raw = hits.reduce((sum, h) => sum + h.points, 0);
  const score = Math.max(0, Math.min(100, raw));
  return { score, action: actionForScore(score, thresholds), hits };
}

/** Flags a listing priced far below its category median (possible scam bait). */
export function isSuspiciouslyCheap(priceMinor: number, categoryMedianMinor: number | null): boolean {
  if (!categoryMedianMinor || categoryMedianMinor <= 0) return false;
  return priceMinor < categoryMedianMinor * 0.6;
}
