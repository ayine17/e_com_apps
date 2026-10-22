export const ORDER_STATES = [
  "PENDING_PAYMENT",
  "PAID",
  "SHIPPED",
  "DELIVERED",
  "RETURN_REQUESTED",
  "DISPUTED",
  "COMPLETED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
  "CANCELLED",
] as const;
export type OrderState = (typeof ORDER_STATES)[number];

/** The only transitions an order may make. See spec section 3. */
const TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  PENDING_PAYMENT: ["PAID", "CANCELLED"],
  PAID: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["DELIVERED", "DISPUTED"],
  DELIVERED: ["COMPLETED", "DISPUTED", "RETURN_REQUESTED"],
  // COMPLETED when the buyer never sends the item back.
  RETURN_REQUESTED: ["REFUNDED", "PARTIALLY_REFUNDED", "DISPUTED", "COMPLETED"],
  DISPUTED: ["COMPLETED", "REFUNDED", "PARTIALLY_REFUNDED"],
  COMPLETED: [],
  REFUNDED: [],
  PARTIALLY_REFUNDED: [],
  CANCELLED: [],
};

export function canTransition(from: OrderState, to: OrderState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function nextStates(from: OrderState): readonly OrderState[] {
  return TRANSITIONS[from];
}

export function isFinal(state: OrderState): boolean {
  return TRANSITIONS[state].length === 0;
}

export class InvalidTransitionError extends Error {
  constructor(public from: OrderState, public to: OrderState) {
    super(`Order cannot move from ${from} to ${to}`);
  }
}

export function assertTransition(from: OrderState, to: OrderState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
