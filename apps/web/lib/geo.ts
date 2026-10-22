"use client";

/** Asks the browser for the user's location. Resolves null if denied or unavailable. */
export function currentPosition(timeoutMs = 8000): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: Math.round(p.coords.latitude * 1e4) / 1e4, lng: Math.round(p.coords.longitude * 1e4) / 1e4 }),
      () => resolve(null),
      { timeout: timeoutMs, maximumAge: 10 * 60 * 1000 },
    );
  });
}
