import { describe, it, expect } from "vitest";
import {
  parseAmount,
  isAcceptableTimestamp,
  dataWithinSizeLimit,
  MAX_DATA_BYTES,
  MAX_CLOCK_SKEW_MS,
} from "./pixelParse";

describe("parseAmount (M4)", () => {
  it("reads a numeric totalAmount", () => {
    expect(parseAmount({ totalAmount: 19.99 })).toBe(19.99);
  });

  it("reads a string totalAmount (the bug that dropped revenue)", () => {
    expect(parseAmount({ totalAmount: "19.99" })).toBe(19.99);
  });

  it("falls back through totalPrice then price", () => {
    expect(parseAmount({ totalPrice: "5.00" })).toBe(5);
    expect(parseAmount({ price: "3" })).toBe(3);
  });

  it("prefers totalAmount over the fallbacks", () => {
    expect(parseAmount({ totalAmount: "1", totalPrice: "2", price: "3" })).toBe(1);
  });

  it("skips empty/null and returns null when nothing usable", () => {
    expect(parseAmount({ totalAmount: "", price: null })).toBeNull();
    expect(parseAmount({})).toBeNull();
    expect(parseAmount({ totalAmount: "abc" })).toBeNull();
  });

  it("treats a real zero as zero, not null", () => {
    expect(parseAmount({ totalAmount: 0 })).toBe(0);
  });
});

describe("isAcceptableTimestamp (M3)", () => {
  const now = Date.parse("2026-06-10T12:00:00Z");

  it("accepts a timestamp within the window", () => {
    expect(isAcceptableTimestamp(new Date(now - 60_000), now)).toBe(true);
  });

  it("rejects a timestamp far in the past", () => {
    expect(isAcceptableTimestamp(new Date(now - MAX_CLOCK_SKEW_MS - 1), now)).toBe(false);
  });

  it("rejects a timestamp far in the future", () => {
    expect(isAcceptableTimestamp(new Date(now + MAX_CLOCK_SKEW_MS + 1), now)).toBe(false);
  });

  it("rejects an invalid date", () => {
    expect(isAcceptableTimestamp(new Date("nope"), now)).toBe(false);
  });
});

describe("dataWithinSizeLimit (M3)", () => {
  it("accepts small payloads", () => {
    expect(dataWithinSizeLimit({ a: 1 })).toBe(true);
  });

  it("rejects payloads over the cap", () => {
    const big = { blob: "x".repeat(MAX_DATA_BYTES + 1) };
    expect(dataWithinSizeLimit(big)).toBe(false);
  });

  it("handles null/undefined as empty", () => {
    expect(dataWithinSizeLimit(undefined)).toBe(true);
    expect(dataWithinSizeLimit(null)).toBe(true);
  });

  it("rejects non-serializable (circular) data", () => {
    const circular: any = {};
    circular.self = circular;
    expect(dataWithinSizeLimit(circular)).toBe(false);
  });
});
