import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Prisma singleton so the rolling-baseline math can be tested without a DB.
vi.mock("../db.server", () => ({
  default: { metricBucket: { findMany: vi.fn() } },
}));

import prisma from "../db.server";
import { computeRollingBaseline, fetchActualAfterEvent } from "./baseline.server";

const findMany = prisma.metricBucket.findMany as unknown as ReturnType<typeof vi.fn>;

const bucket = (orders: number, revenue: number) => ({ orders, revenue });

beforeEach(() => {
  findMany.mockReset();
});

describe("computeRollingBaseline", () => {
  it("averages orders/revenue across the weeks that have data", async () => {
    // 4 lookback weeks → 4 findMany calls.
    findMany
      .mockResolvedValueOnce([bucket(10, 100)]) // week -1
      .mockResolvedValueOnce([bucket(20, 200)]) // week -2
      .mockResolvedValueOnce([bucket(30, 300)]) // week -3
      .mockResolvedValueOnce([bucket(40, 400)]); // week -4

    const r = await computeRollingBaseline({
      shop: "s.myshopify.com",
      eventTime: new Date("2026-06-07T17:00:00Z"),
      windowMinutes: 1440,
    });

    expect(r.weeksWithData).toBe(4);
    expect(r.totalWeeks).toBe(4);
    expect(r.expectedOrders).toBe(25); // (10+20+30+40)/4
    expect(r.expectedRevenue).toBe(250);
    expect(r.expectedAOV).toBe(10); // 250/25
    expect(r.bucketCoverage).toBe(4);
  });

  it("skips empty weeks and only averages weeks with data", async () => {
    findMany
      .mockResolvedValueOnce([bucket(10, 100)])
      .mockResolvedValueOnce([]) // empty week
      .mockResolvedValueOnce([bucket(30, 300)])
      .mockResolvedValueOnce([]); // empty week

    const r = await computeRollingBaseline({
      shop: "s.myshopify.com",
      eventTime: "2026-06-07T17:00:00Z",
      windowMinutes: 60,
    });

    expect(r.weeksWithData).toBe(2);
    expect(r.expectedOrders).toBe(20); // (10+30)/2
    expect(r.expectedRevenue).toBe(200);
    expect(r.perWeek.filter((w) => w === null)).toHaveLength(2);
  });

  it("returns null expectations when there is no history at all", async () => {
    findMany.mockResolvedValue([]);

    const r = await computeRollingBaseline({
      shop: "s.myshopify.com",
      eventTime: new Date("2026-06-07T17:00:00Z"),
      windowMinutes: 60,
    });

    expect(r.weeksWithData).toBe(0);
    expect(r.expectedOrders).toBeNull();
    expect(r.expectedRevenue).toBeNull();
    expect(r.expectedAOV).toBeNull();
    expect(r.bucketCoverage).toBe(0);
  });

  it("AOV is null when expected orders is zero", async () => {
    findMany.mockResolvedValueOnce([bucket(0, 0)]).mockResolvedValue([]);

    const r = await computeRollingBaseline({
      shop: "s.myshopify.com",
      eventTime: new Date("2026-06-07T17:00:00Z"),
      windowMinutes: 60,
      lookbackWeeks: 4,
    });

    expect(r.expectedOrders).toBe(0);
    expect(r.expectedAOV).toBeNull();
  });

  it("honours a custom lookbackWeeks count", async () => {
    findMany.mockResolvedValue([bucket(5, 50)]);
    const r = await computeRollingBaseline({
      shop: "s.myshopify.com",
      eventTime: new Date("2026-06-07T17:00:00Z"),
      windowMinutes: 60,
      lookbackWeeks: 2,
    });
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(r.totalWeeks).toBe(2);
  });

  it("computes population stddev of weekly orders/revenue", async () => {
    findMany
      .mockResolvedValueOnce([bucket(10, 100)])
      .mockResolvedValueOnce([bucket(20, 200)])
      .mockResolvedValueOnce([bucket(30, 300)])
      .mockResolvedValueOnce([bucket(40, 400)]);

    const r = await computeRollingBaseline({
      shop: "s.myshopify.com",
      eventTime: new Date("2026-06-07T17:00:00Z"),
      windowMinutes: 1440,
    });

    // orders [10,20,30,40], mean 25 → variance 125 → σ ≈ 11.18
    expect(r.stdDevOrders).toBeCloseTo(Math.sqrt(125), 4);
    // revenue [100,200,300,400], mean 250 → variance 12500 → σ ≈ 111.8
    expect(r.stdDevRevenue).toBeCloseTo(Math.sqrt(12500), 4);
  });

  it("stddev is null with fewer than 2 weeks of data", async () => {
    findMany
      .mockResolvedValueOnce([bucket(10, 100)])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const r = await computeRollingBaseline({
      shop: "s.myshopify.com",
      eventTime: new Date("2026-06-07T17:00:00Z"),
      windowMinutes: 1440,
    });

    expect(r.weeksWithData).toBe(1);
    expect(r.stdDevOrders).toBeNull();
    expect(r.stdDevRevenue).toBeNull();
  });
});

describe("fetchActualAfterEvent", () => {
  it("sums orders/revenue in the after-event window and computes AOV", async () => {
    findMany.mockResolvedValueOnce([bucket(3, 60), bucket(1, 40)]);
    const r = await fetchActualAfterEvent({
      shop: "s.myshopify.com",
      eventTime: new Date("2026-06-07T17:00:00Z"),
      windowMinutes: 60,
    });
    expect(r.actualOrders).toBe(4);
    expect(r.actualRevenue).toBe(100);
    expect(r.actualAOV).toBe(25);
    expect(r.bucketCount).toBe(2);
  });

  it("AOV is null when there are zero orders", async () => {
    findMany.mockResolvedValueOnce([]);
    const r = await fetchActualAfterEvent({
      shop: "s.myshopify.com",
      eventTime: new Date("2026-06-07T17:00:00Z"),
      windowMinutes: 60,
    });
    expect(r.actualOrders).toBe(0);
    expect(r.actualAOV).toBeNull();
  });
});
