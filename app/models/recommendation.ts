// Pure rule-based recommendation engine.
// Runs on both server (loader/action) and client (component render),
// so this file must NOT import prisma, admin client, or anything server-only.
// Do NOT add the ".server" suffix back — React Router would strip it from the client bundle.

export type PriceDirection = "up" | "down" | "mixed";

export type EventContext = {
  // Callers compute this from raw variant data, so accept any string and let
  // the text branching match the known directions.
  priceDirection?: string;
  [key: string]: unknown;
};

export type RecommendationLabel = "positive" | "negative" | "mixed" | "neutral";
export type RecommendationStrength = "strong" | "moderate";
export type RecommendationConfidence = "low" | "medium" | "high";
export type RecommendationTone = "success" | "critical" | "attention" | "warning" | "info";

export type BuildRecommendationInput = {
  eventType?: string;
  eventContext?: EventContext;
  windowMinutes?: number;
  // Nullable metric deltas. `undefined` is accepted (callers may omit fields)
  // and normalized to null via the destructuring defaults below.
  revenueDeltaPct?: number | null;
  ordersDeltaPct?: number | null;
  aovDeltaPct?: number | null;
  conversionDeltaPct?: number | null;
  pageViewsDeltaPct?: number | null;
  partialData?: boolean;
  overlappingEvents?: number;
  // Optional human labels for the events overlapping the comparison window
  // (e.g. "theme_published @ 14:05"). When provided, the overlapping-events
  // driver lists what is competing for attribution instead of just a count.
  overlappingEventLabels?: string[];
  coverageBefore?: number;
  coverageAfter?: number;
  expectedBuckets?: number;
  // Statistical guards (computed by the caller from the rolling baseline):
  //   withinNoiseBand — the actual movement is within ~1σ of the store's normal
  //     week-to-week swing, i.e. not distinguishable from noise.
  //   lowVolume — too few orders in the baseline/actual window to make a strong
  //     call (small-sample, where Δ% explodes off a tiny denominator).
  // Both cap strength at "moderate" and dock confidence; neither flips a label.
  withinNoiseBand?: boolean;
  lowVolume?: boolean;
};

export type Recommendation = {
  label: RecommendationLabel;
  strength: RecommendationStrength;
  confidence: RecommendationConfidence;
  tone: RecommendationTone;
  text: string;
  drivers: string[];
};

type ImpactTier =
  | "strong_positive"
  | "positive"
  | "neutral"
  | "negative"
  | "strong_negative";

export function buildRecommendation({
  eventType,
  // Optional event-specific extras. Currently used:
  //   priceDirection: "up" | "down" | "mixed" — for products_update events
  //                   where the caller has computed the dominant variant direction.
  eventContext = {},
  // Size of the comparison window in minutes (10, 60, 360, 1440, ...).
  // Drivers will be labelled with the appropriate human unit.
  windowMinutes = 10,
  revenueDeltaPct = null,
  ordersDeltaPct = null,
  aovDeltaPct = null,
  // Storefront pixel deltas. Optional — if the pixel has no data in the
  // window, leave null and we skip the conversion-aware logic.
  conversionDeltaPct = null,
  pageViewsDeltaPct = null,
  partialData = false,
  overlappingEvents = 0,
  overlappingEventLabels = [],
  coverageBefore = 0,
  coverageAfter = 0,
  expectedBuckets = 0,
  withinNoiseBand = false,
  lowVolume = false,
}: BuildRecommendationInput): Recommendation {
  let confidence = 100;
  // Set when a large traffic swing means the orders/revenue movement is likely
  // driven by external traffic rather than the merchant's change. Surfaced as a
  // driver so the reduced confidence is explainable.
  let trafficConfounded = false;

  if (revenueDeltaPct !== null && ordersDeltaPct !== null) {
    if ((revenueDeltaPct > 0 && ordersDeltaPct < 0) || (revenueDeltaPct < 0 && ordersDeltaPct > 0)) {
      confidence -= 30;
    }
  }

  if (overlappingEvents > 0) {
    confidence -= 20;
  }

  if (partialData) {
    confidence -= 20;
  }

  if (revenueDeltaPct === null || ordersDeltaPct === null) {
    if (revenueDeltaPct === null && ordersDeltaPct === null) {
      confidence -= 25;
    } else {
      confidence -= 15;
    }
  }

  if (coverageBefore < expectedBuckets) {
    confidence -= 15;
  }

  if (coverageAfter < expectedBuckets) {
    confidence -= 15;
  }

  // pageViews is NOT a primary verdict axis — a big traffic swing usually
  // reflects marketing / referrals / seasonality, not the store change. When
  // traffic moves a lot, the orders/revenue delta is confounded by it, so we
  // lower confidence rather than letting it sway the label.
  if (pageViewsDeltaPct !== null && Math.abs(pageViewsDeltaPct) >= 40) {
    confidence -= 15;
    trafficConfounded = true;
  }

  // Statistical guards: a move inside normal weekly noise, or off a tiny
  // sample, can't support a confident verdict.
  if (withinNoiseBand) {
    confidence -= 15;
  }
  if (lowVolume) {
    confidence -= 20;
  }

  // Floor so we never report negative confidence numbers downstream.
  confidence = Math.max(0, confidence);

  let confidenceLevel: RecommendationConfidence = "high";
  if (confidence < 60) {
    confidenceLevel = "low";
  } else if (confidence < 80) {
    confidenceLevel = "medium";
  }

  const revenueTier = getImpactTier(revenueDeltaPct);
  const ordersTier = getImpactTier(ordersDeltaPct);

  let label: RecommendationLabel = "neutral";
  let strength: RecommendationStrength = "moderate";

  if (revenueDeltaPct !== null && ordersDeltaPct !== null) {
    if (revenueTier === "strong_positive" && ordersTier === "strong_positive") {
      label = "positive";
      strength = "strong";
    } else if (revenueTier === "strong_negative" && ordersTier === "strong_negative") {
      label = "negative";
      strength = "strong";
    } else if ((revenueTier === "positive" || revenueTier === "strong_positive") && (ordersTier === "positive" || ordersTier === "strong_positive")) {
      label = "positive";
      strength = "moderate";
    } else if ((revenueTier === "negative" || revenueTier === "strong_negative") && (ordersTier === "negative" || ordersTier === "strong_negative")) {
      label = "negative";
      strength = "moderate";
    } else if ((revenueTier === "positive" || revenueTier === "strong_positive") && (ordersTier === "negative" || ordersTier === "strong_negative")) {
      label = "mixed";
    } else if ((revenueTier === "negative" || revenueTier === "strong_negative") && (ordersTier === "positive" || ordersTier === "strong_positive")) {
      label = "mixed";
    }
  } else if (revenueDeltaPct !== null) {
    if (revenueTier === "strong_positive") {
      label = "positive";
      strength = "strong";
    } else if (revenueTier === "strong_negative") {
      label = "negative";
      strength = "strong";
    } else if (revenueTier === "positive") {
      label = "positive";
    } else if (revenueTier === "negative") {
      label = "negative";
    }
  } else if (ordersDeltaPct !== null) {
    if (ordersTier === "strong_positive") {
      label = "positive";
      strength = "strong";
    } else if (ordersTier === "strong_negative") {
      label = "negative";
      strength = "strong";
    } else if (ordersTier === "positive") {
      label = "positive";
    } else if (ordersTier === "negative") {
      label = "negative";
    }
  }

  let tone: RecommendationTone = "info";
  if (label === "positive" && strength === "strong") {
    tone = "success";
  } else if (label === "negative" && strength === "strong") {
    tone = "critical";
  } else if (label === "positive" || label === "negative") {
    tone = "attention";
  } else if (label === "mixed") {
    tone = "warning";
  }

  // Conversion-rate override for theme events.
  // For theme changes, customer behaviour on the storefront moves long
  // before orders do, so a strong conversion-rate drop should dominate the
  // verdict even if orders haven't reacted yet.
  if (
    eventType === "theme_published" ||
    eventType === "theme_switched" ||
    eventType === "theme_files_updated"
  ) {
    if (conversionDeltaPct !== null) {
      if (conversionDeltaPct <= -20) {
        label = "negative";
        strength = "strong";
      } else if (conversionDeltaPct <= -10 && label === "neutral") {
        label = "negative";
        strength = "moderate";
      } else if (conversionDeltaPct >= 20 && label !== "negative") {
        label = "positive";
        strength = "strong";
      }
    }
  }

  // AOV-aware nuance for price changes. For a deliberate price move, AOV is
  // the decision-relevant axis: a price increase that trades volume for a
  // higher average order value (revenue not cratering) is the intended
  // elasticity outcome, not a pure loss — and a price cut that lifts volume
  // while sharply dropping AOV is a margin risk, not a clean win. Only applies
  // to product price events; theme events use the conversion override above.
  // Thresholds (±5 / ±10) are tunable.
  const priceDir = eventContext?.priceDirection;
  if (
    (eventType === "products_update" || eventType === "products_create") &&
    aovDeltaPct !== null
  ) {
    if (priceDir === "up" && aovDeltaPct >= 5 && label === "negative") {
      label = "mixed";
      strength = "moderate";
    } else if (priceDir === "down" && aovDeltaPct <= -10 && label === "positive") {
      label = "mixed";
      strength = "moderate";
    }
  }

  // Statistical guards never flip a label, but they forbid a "strong" claim:
  // if the move is within normal weekly noise or off a tiny sample, the most
  // we'll say is "moderate".
  if ((withinNoiseBand || lowVolume) && strength === "strong") {
    strength = "moderate";
  }

  // Re-pick tone after potential conversion / AOV override.
  tone = "info";
  if (label === "positive" && strength === "strong") tone = "success";
  else if (label === "negative" && strength === "strong") tone = "critical";
  else if (label === "positive" || label === "negative") tone = "attention";
  else if (label === "mixed") tone = "warning";

  const text = getRecommendationText(eventType, label, strength, eventContext);
  const drivers = buildDrivers({
    revenueDeltaPct,
    ordersDeltaPct,
    aovDeltaPct,
    conversionDeltaPct,
    pageViewsDeltaPct,
    coverageBefore,
    coverageAfter,
    expectedBuckets,
    partialData,
    overlappingEvents,
    overlappingEventLabels,
    windowMinutes,
  });

  if (trafficConfounded) {
    drivers.push(
      "Large traffic swing — orders/revenue Δ may reflect traffic, not the change (confidence reduced)",
    );
  }

  if (lowVolume) {
    drivers.push("Low volume — too few orders for a strong call (capped at moderate)");
  }

  if (withinNoiseBand) {
    drivers.push("Δ within normal weekly variance (≤1σ) — not distinguishable from noise");
  }

  return {
    label,
    strength,
    confidence: confidenceLevel,
    tone,
    text,
    drivers,
  };
}

function getImpactTier(pct: number | null): ImpactTier {
  if (pct === null) return "neutral";
  if (pct >= 10) return "strong_positive";
  if (pct >= 3) return "positive";
  if (pct <= -10) return "strong_negative";
  if (pct <= -3) return "negative";
  return "neutral";
}

function getRecommendationText(
  eventType: string | undefined,
  label: RecommendationLabel,
  strength: RecommendationStrength,
  eventContext: EventContext = {},
): string {
  let text = "";

  if (eventType === "theme_published" || eventType === "theme_switched") {
    if (label === "positive" && strength === "strong") {
      text = "Observed uplift after theme publish. Consider keeping and monitoring a longer window.";
    } else if (label === "negative" && strength === "strong") {
      text = "Observed drop after theme publish. Consider rollback / QA key flows (cart/checkout/PDP).";
    } else if (label === "mixed") {
      text = "Signals are mixed. Check friction points (navigation, add-to-cart, mobile).";
    } else if (label === "neutral") {
      text = "No clear change in this short window. Monitor longer.";
    } else {
      text = "Observed change after theme publish. Monitor longer window.";
    }
  } else if (eventType === "products_update" || eventType === "products_create") {
    // Tailor by price direction if the caller computed one.
    const priceDirection = eventContext?.priceDirection;

    if (priceDirection === "up") {
      if (label === "positive") {
        text = "Price increase did not hurt demand — good elasticity signal. Keep an eye on AOV.";
      } else if (label === "negative" && strength === "strong") {
        text = "Demand dropped sharply after price increase. Consider partial rollback or A/B on price tiers.";
      } else if (label === "negative") {
        text = "Soft drop after price increase. Watch over a longer window before deciding.";
      } else if (label === "mixed") {
        text = "Revenue up but orders down — verify the AOV bump actually offsets volume loss.";
      } else {
        text = "No clear demand response to the price increase yet.";
      }
    } else if (priceDirection === "down") {
      if (label === "positive" && strength === "strong") {
        text = "Price drop pulled volume up — confirm margin remains healthy at the new price.";
      } else if (label === "positive") {
        text = "Modest lift after price drop. Watch AOV / margin trade-off over a longer window.";
      } else if (label === "negative") {
        text = "Price drop did NOT lift demand. Pricing isn't the friction — review PDP / UX / inventory.";
      } else if (label === "mixed") {
        text = "Mixed signals. AOV likely fell — confirm order volume gain outweighs margin loss.";
      } else {
        text = "No clear demand response to the price drop yet.";
      }
    } else if (priceDirection === "mixed") {
      text = "Multiple variants moved in different directions — break the comparison down by SKU before acting.";
    } else {
      // products_update without a price change (e.g. title/SEO/media edit).
      if (label === "positive") {
        text = "Product update coincides with positive movement. Confirm cause before scaling the change.";
      } else if (label === "negative") {
        text = "Negative movement after product update. Check for accidental unpublish / variant disable.";
      } else if (label === "mixed") {
        text = "Mixed signals around the product update. Review what specifically changed.";
      } else {
        text = "No clear impact from this product update yet.";
      }
    }
  } else if (eventType === "products_delete") {
    if (label === "negative") {
      text = "Negative movement after product delete. Verify nothing critical to discoverability was removed.";
    } else {
      text = "Product deletion logged. Monitor a longer window before drawing conclusions.";
    }
  } else if (eventType?.startsWith("collections_")) {
    if (label === "positive") {
      text = "Positive movement after collection change. Likely safe to keep.";
    } else if (label === "negative") {
      text = "Negative movement after collection change. Check that nav / merchandising still reaches the catalog.";
    } else if (label === "mixed") {
      text = "Mixed signals after collection change. Compare against a longer window.";
    } else {
      text = "No clear impact yet from the collection change.";
    }
  } else {
    // Manual / housekeeping / unknown event types
    if (label === "positive") {
      text = "Observed positive change. Monitor longer window.";
    } else if (label === "negative") {
      text = "Observed negative change. Review and consider adjustments.";
    } else if (label === "mixed") {
      text = "Signals are mixed. Review key metrics.";
    } else {
      text = "No clear change observed. Monitor longer.";
    }
  }

  return `Early signal: ${text}`;
}

export function formatWindowLabel(minutes: number): string {
  if (minutes >= 1440) {
    const days = minutes / 1440;
    return Number.isInteger(days) ? `${days}d window` : `${days.toFixed(1)}d window`;
  }
  if (minutes >= 60) {
    const hours = minutes / 60;
    return Number.isInteger(hours) ? `${hours}h window` : `${hours.toFixed(1)}h window`;
  }
  return `${minutes}m window`;
}

function buildDrivers({
  revenueDeltaPct,
  ordersDeltaPct,
  aovDeltaPct,
  conversionDeltaPct,
  pageViewsDeltaPct,
  coverageBefore,
  coverageAfter,
  expectedBuckets,
  partialData,
  overlappingEvents,
  overlappingEventLabels,
  windowMinutes,
}: {
  revenueDeltaPct: number | null;
  ordersDeltaPct: number | null;
  aovDeltaPct: number | null;
  conversionDeltaPct: number | null;
  pageViewsDeltaPct: number | null;
  coverageBefore: number;
  coverageAfter: number;
  expectedBuckets: number;
  partialData: boolean;
  overlappingEvents: number;
  overlappingEventLabels: string[];
  windowMinutes: number;
}): string[] {
  const drivers: string[] = [];
  const windowLabel = formatWindowLabel(windowMinutes);

  // Storefront signals first — they're the leading indicator.
  if (conversionDeltaPct !== null) {
    drivers.push(`Conversion rate Δ: ${conversionDeltaPct >= 0 ? "+" : ""}${conversionDeltaPct.toFixed(1)}% (${windowLabel}, pixel)`);
  }

  if (pageViewsDeltaPct !== null) {
    drivers.push(`Page views Δ: ${pageViewsDeltaPct >= 0 ? "+" : ""}${pageViewsDeltaPct.toFixed(1)}% (${windowLabel}, pixel)`);
  }

  if (revenueDeltaPct !== null) {
    drivers.push(`Revenue Δ: ${revenueDeltaPct >= 0 ? "+" : ""}${revenueDeltaPct.toFixed(1)}% (${windowLabel})`);
  } else {
    drivers.push("Revenue Δ: n/a (baseline=0)");
  }

  if (ordersDeltaPct !== null) {
    drivers.push(`Orders Δ: ${ordersDeltaPct >= 0 ? "+" : ""}${ordersDeltaPct.toFixed(1)}% (${windowLabel})`);
  } else {
    drivers.push("Orders Δ: n/a (baseline=0)");
  }

  if (aovDeltaPct !== null) {
    drivers.push(`AOV Δ: ${aovDeltaPct >= 0 ? "+" : ""}${aovDeltaPct.toFixed(1)}%`);
  }

  drivers.push(`Data coverage: before ${coverageBefore}/${expectedBuckets}, after ${coverageAfter}/${expectedBuckets} buckets`);

  if (overlappingEvents > 0) {
    if (overlappingEventLabels.length > 0) {
      // List what competes for attribution. Cap the list so the driver stays
      // readable; note the remainder.
      const MAX_SHOWN = 3;
      const shown = overlappingEventLabels.slice(0, MAX_SHOWN);
      const extra = overlappingEvents - shown.length;
      const suffix = extra > 0 ? ` +${extra} more` : "";
      drivers.push(
        `Overlapping events (${overlappingEvents}) compete for attribution: ${shown.join(", ")}${suffix}`,
      );
    } else {
      drivers.push(`Overlapping events: ${overlappingEvents}`);
    }
  }

  if (partialData) {
    drivers.push("Partial data: backfill cap hit on at least one bucket");
  }

  return drivers;
}
