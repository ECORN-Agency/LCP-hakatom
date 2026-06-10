// Pure helpers for the public pixel ingest endpoint. No server-only imports
// so they're trivially unit-testable. See M3/M4 in docs/code-review-2026-06.md.

// Cap on the pixel `data` blob. The endpoint is unauthenticated, so we don't
// let a caller stuff arbitrarily large JSON into the DB.
export const MAX_DATA_BYTES = 8 * 1024; // 8 KB

// Reject pixel events whose timestamp is implausibly far from now (replay /
// junk). Storefront clocks drift, so we allow a generous window.
export const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000; // ±24h

/**
 * Resolve a monetary amount from a pixel `data` blob, trying the known keys in
 * priority order. Accepts numbers AND numeric strings (Shopify often sends
 * money as strings) — the previous `Number.isFinite(value)` check silently
 * dropped string amounts. (M4)
 */
export function parseAmount(data: any): number | null {
  for (const key of ["totalAmount", "totalPrice", "price"] as const) {
    const raw = data?.[key];
    if (raw === null || raw === undefined || raw === "") continue;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** True if occurredAt is a valid date within ±maxSkewMs of `now`. (M3) */
export function isAcceptableTimestamp(
  occurredAt: Date,
  now: number = Date.now(),
  maxSkewMs: number = MAX_CLOCK_SKEW_MS,
): boolean {
  const t = occurredAt.getTime();
  if (Number.isNaN(t)) return false;
  return Math.abs(now - t) <= maxSkewMs;
}

/** True if `data` serializes to at most maxBytes of UTF-8 JSON. (M3) */
export function dataWithinSizeLimit(data: unknown, maxBytes: number = MAX_DATA_BYTES): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(data ?? {}), "utf8") <= maxBytes;
  } catch {
    return false; // circular / non-serializable
  }
}
