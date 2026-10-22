"use client";

import { useCallback, useEffect, useState } from "react";

export interface CartLine { productId: string; quantity: number; title: string; priceMinor: number; currency: string; storeId: string; image?: string }

const KEY = "cart.v1";
const EVENT = "cart-changed";

function read(): CartLine[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}

function write(lines: CartLine[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(lines));
  } catch {
    // Storage blocked (private mode): the cart just won't persist.
  }
  window.dispatchEvent(new Event(EVENT));
}

/** Cart lives in the browser until checkout; the server re-validates prices and stock. */
export function useCart() {
  const [lines, setLines] = useState<CartLine[]>([]);
  useEffect(() => {
    const sync = () => setLines(read());
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const add = useCallback((line: CartLine) => {
    const current = read();
    const existing = current.find((l) => l.productId === line.productId);
    if (existing) existing.quantity = Math.min(100, existing.quantity + line.quantity);
    else current.push(line);
    write(current);
  }, []);
  const setQuantity = useCallback((productId: string, quantity: number) => {
    write(read().map((l) => (l.productId === productId ? { ...l, quantity } : l)).filter((l) => l.quantity > 0));
  }, []);
  const clear = useCallback(() => write([]), []);

  return { lines, add, setQuantity, clear, count: lines.reduce((s, l) => s + l.quantity, 0) };
}
