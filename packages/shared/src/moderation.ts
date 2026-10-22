/** Detects contact details or links that suggest a deal is being moved off-platform. */

const PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "email", re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i },
  { kind: "phone", re: /(?:\+?\d[\s().-]?){8,}\d/ },
  { kind: "link", re: /\b(?:https?:\/\/|www\.)\S+/i },
  { kind: "offplatform_payment", re: /\b(?:pay(?:ing)?\s+(?:me\s+)?(?:outside|directly|off(?:\s|-)?(?:the\s+)?(?:app|site|platform))|western\s+union|gift\s*cards?|crypto|bitcoin|usdt)\b/i },
];

export function detectOffPlatformSignals(text: string): string[] {
  return PATTERNS.filter((p) => p.re.test(text)).map((p) => p.kind);
}
