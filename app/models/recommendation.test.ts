import { describe, it, expect } from "vitest";
import { buildRecommendation, formatWindowLabel } from "./recommendation";

// Shared baseline of "clean" inputs: full coverage, no overlaps, no partials.
// Each test overrides only the fields it cares about.
function base(overrides: Record<string, unknown> = {}) {
  return {
    eventType: "products_update",
    eventContext: {},
    windowMinutes: 60,
    revenueDeltaPct: 0,
    ordersDeltaPct: 0,
    aovDeltaPct: null,
    conversionDeltaPct: null,
    pageViewsDeltaPct: null,
    partialData: false,
    overlappingEvents: 0,
    coverageBefore: 6,
    coverageAfter: 6,
    expectedBuckets: 6,
    ...overrides,
  };
}

describe("buildRecommendation — label & strength", () => {
  it("both metrics strongly up → positive / strong", () => {
    const r = buildRecommendation(base({ revenueDeltaPct: 15, ordersDeltaPct: 12 }));
    expect(r.label).toBe("positive");
    expect(r.strength).toBe("strong");
    expect(r.tone).toBe("success");
  });

  it("both metrics strongly down → negative / strong / critical", () => {
    const r = buildRecommendation(base({ revenueDeltaPct: -15, ordersDeltaPct: -12 }));
    expect(r.label).toBe("negative");
    expect(r.strength).toBe("strong");
    expect(r.tone).toBe("critical");
  });

  it("both moderately up → positive / moderate / attention", () => {
    const r = buildRecommendation(base({ revenueDeltaPct: 5, ordersDeltaPct: 4 }));
    expect(r.label).toBe("positive");
    expect(r.strength).toBe("moderate");
    expect(r.tone).toBe("attention");
  });

  it("revenue up but orders down → mixed / warning", () => {
    const r = buildRecommendation(base({ revenueDeltaPct: 12, ordersDeltaPct: -12 }));
    expect(r.label).toBe("mixed");
    expect(r.tone).toBe("warning");
  });

  it("tiny deltas inside the dead-band → neutral / info", () => {
    const r = buildRecommendation(base({ revenueDeltaPct: 1, ordersDeltaPct: -1 }));
    expect(r.label).toBe("neutral");
    expect(r.tone).toBe("info");
  });

  it("only revenue present, strongly up → positive / strong", () => {
    const r = buildRecommendation(base({ revenueDeltaPct: 20, ordersDeltaPct: null }));
    expect(r.label).toBe("positive");
    expect(r.strength).toBe("strong");
  });
});

describe("buildRecommendation — confidence scoring", () => {
  it("clean inputs → high confidence", () => {
    const r = buildRecommendation(base({ revenueDeltaPct: 12, ordersDeltaPct: 11 }));
    expect(r.confidence).toBe("high");
  });

  it("conflicting direction of revenue vs orders drops confidence", () => {
    // -30 for conflict → 70 → medium
    const r = buildRecommendation(base({ revenueDeltaPct: 12, ordersDeltaPct: -12 }));
    expect(r.confidence).toBe("medium");
  });

  it("overlapping events + partial data + missing one metric stacks penalties to low", () => {
    // -20 overlap, -20 partial, -15 one-metric-null = 55 → low
    const r = buildRecommendation(
      base({
        revenueDeltaPct: 12,
        ordersDeltaPct: null,
        overlappingEvents: 2,
        partialData: true,
      }),
    );
    expect(r.confidence).toBe("low");
  });

  it("low coverage before and after each cost 15 points", () => {
    // -15 -15 = 70 → medium
    const r = buildRecommendation(
      base({ revenueDeltaPct: 12, ordersDeltaPct: 11, coverageBefore: 2, coverageAfter: 2 }),
    );
    expect(r.confidence).toBe("medium");
  });

  it("confidence never goes negative (floored, reported as level)", () => {
    const r = buildRecommendation(
      base({
        revenueDeltaPct: null,
        ordersDeltaPct: null,
        overlappingEvents: 5,
        partialData: true,
        coverageBefore: 0,
        coverageAfter: 0,
      }),
    );
    expect(r.confidence).toBe("low");
  });
});

describe("buildRecommendation — theme conversion override", () => {
  it("strong conversion drop forces negative/strong even with flat orders", () => {
    const r = buildRecommendation(
      base({
        eventType: "theme_published",
        revenueDeltaPct: 0,
        ordersDeltaPct: 0,
        conversionDeltaPct: -25,
      }),
    );
    expect(r.label).toBe("negative");
    expect(r.strength).toBe("strong");
    expect(r.tone).toBe("critical");
  });

  it("moderate conversion drop only overrides a neutral verdict", () => {
    const r = buildRecommendation(
      base({
        eventType: "theme_files_updated",
        revenueDeltaPct: 0,
        ordersDeltaPct: 0,
        conversionDeltaPct: -12,
      }),
    );
    expect(r.label).toBe("negative");
    expect(r.strength).toBe("moderate");
  });

  it("strong conversion lift forces positive/strong", () => {
    const r = buildRecommendation(
      base({
        eventType: "theme_switched",
        revenueDeltaPct: 0,
        ordersDeltaPct: 0,
        conversionDeltaPct: 25,
      }),
    );
    expect(r.label).toBe("positive");
    expect(r.strength).toBe("strong");
  });

  it("conversion override does NOT apply to non-theme events", () => {
    const r = buildRecommendation(
      base({
        eventType: "products_update",
        revenueDeltaPct: 0,
        ordersDeltaPct: 0,
        conversionDeltaPct: -25,
      }),
    );
    expect(r.label).toBe("neutral");
  });
});

describe("buildRecommendation — recommendation text by price direction", () => {
  it("price up + positive → elasticity message", () => {
    const r = buildRecommendation(
      base({
        eventType: "products_update",
        eventContext: { priceDirection: "up" },
        revenueDeltaPct: 5,
        ordersDeltaPct: 4,
      }),
    );
    expect(r.text).toContain("Early signal:");
    expect(r.text.toLowerCase()).toContain("elasticity");
  });

  it("price down + strong positive → margin caution", () => {
    const r = buildRecommendation(
      base({
        eventType: "products_update",
        eventContext: { priceDirection: "down" },
        revenueDeltaPct: 15,
        ordersDeltaPct: 12,
      }),
    );
    expect(r.text.toLowerCase()).toContain("margin");
  });

  it("mixed price direction asks to break down by SKU", () => {
    const r = buildRecommendation(
      base({ eventType: "products_update", eventContext: { priceDirection: "mixed" } }),
    );
    expect(r.text.toLowerCase()).toContain("sku");
  });
});

describe("buildRecommendation — drivers", () => {
  it("includes pixel-derived conversion driver first when present", () => {
    const r = buildRecommendation(
      base({ eventType: "theme_published", conversionDeltaPct: -12, revenueDeltaPct: -5, ordersDeltaPct: -4 }),
    );
    expect(r.drivers[0]).toContain("Conversion rate");
    expect(r.drivers.some((d: string) => d.startsWith("Data coverage:"))).toBe(true);
  });

  it("reports n/a for null revenue/orders deltas", () => {
    const r = buildRecommendation(base({ revenueDeltaPct: null, ordersDeltaPct: null }));
    expect(r.drivers).toContain("Revenue Δ: n/a (baseline=0)");
    expect(r.drivers).toContain("Orders Δ: n/a (baseline=0)");
  });
});

describe("formatWindowLabel", () => {
  it("minutes under an hour", () => {
    expect(formatWindowLabel(10)).toBe("10m window");
  });
  it("whole hours", () => {
    expect(formatWindowLabel(60)).toBe("1h window");
    expect(formatWindowLabel(360)).toBe("6h window");
  });
  it("whole days", () => {
    expect(formatWindowLabel(1440)).toBe("1d window");
  });
  it("fractional days get one decimal", () => {
    expect(formatWindowLabel(2160)).toBe("1.5d window");
  });
});
