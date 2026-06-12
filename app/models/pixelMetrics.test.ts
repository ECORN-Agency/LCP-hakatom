import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Prisma singleton so the funnel math can be tested without a DB.
vi.mock("../db.server", () => ({
  default: { pixelEvent: { groupBy: vi.fn() } },
}));

import prisma from "../db.server";
import { computeRollingFunnelBaseline } from "./pixelMetrics.server";

const groupBy = prisma.pixelEvent.groupBy as unknown as ReturnType<typeof vi.fn>;

// Build a groupBy result for one slot from a simple counts map.
const slot = (counts: Partial<Record<string, number>>) =>
  Object.entries(counts).map(([eventName, n]) => ({
    eventName,
    _count: { _all: n },
  }));

const eventTime = new Date("2026-06-07T17:00:00Z");

beforeEach(() => {
  groupBy.mockReset();
});

describe("computeRollingFunnelBaseline", () => {
  it("averages funnel counts across weeks with traffic and recomputes rates", async () => {
    // 4 lookback weeks → 4 groupBy calls.
    groupBy
      .mockResolvedValueOnce(slot({ page_viewed: 100, checkout_completed: 2 })) // -1w
      .mockResolvedValueOnce(slot({ page_viewed: 200, checkout_completed: 6 })) // -2w
      .mockResolvedValueOnce(slot({ page_viewed: 300, checkout_completed: 12 })) // -3w
      .mockResolvedValueOnce(slot({ page_viewed: 400, checkout_completed: 20 })); // -4w

    const r = await computeRollingFunnelBaseline("s.myshopify.com", eventTime, 1440);

    expect(r.weeksWithData).toBe(4);
    expect(r.totalWeeks).toBe(4);
    expect(r.expected.pageViews).toBe(250); // (100+200+300+400)/4
    expect(r.expected.checkoutsCompleted).toBe(10); // (2+6+12+20)/4
    // Rate is recomputed from the AVERAGED counts, not averaged per-week.
    expect(r.expected.conversionRate).toBeCloseTo(10 / 250, 6);
  });

  it("skips slots with zero page views so empty weeks don't drag the average down", async () => {
    groupBy
      .mockResolvedValueOnce(slot({ page_viewed: 100, checkout_completed: 5 })) // -1w
      .mockResolvedValueOnce(slot({})) // -2w: no traffic → skipped
      .mockResolvedValueOnce(slot({ page_viewed: 300, checkout_completed: 15 })) // -3w
      .mockResolvedValueOnce(slot({})); // -4w: no traffic → skipped

    const r = await computeRollingFunnelBaseline("s.myshopify.com", eventTime, 1440);

    expect(r.weeksWithData).toBe(2);
    expect(r.expected.pageViews).toBe(200); // (100+300)/2, empty weeks excluded
    expect(r.expected.checkoutsCompleted).toBe(10); // (5+15)/2
  });

  it("returns weeksWithData=0 and an empty funnel when there is no history", async () => {
    groupBy.mockResolvedValue(slot({})); // every week empty

    const r = await computeRollingFunnelBaseline("s.myshopify.com", eventTime, 1440);

    expect(r.weeksWithData).toBe(0);
    expect(r.expected.pageViews).toBe(0);
    expect(r.expected.conversionRate).toBeNull();
  });
});
