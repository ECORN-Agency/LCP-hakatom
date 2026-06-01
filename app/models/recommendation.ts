// Pure rule-based recommendation engine.
// Runs on both server (loader/action) and client (component render),
// so this file must NOT import prisma, admin client, or anything server-only.
// Do NOT add the ".server" suffix back — React Router would strip it from the client bundle.

export function buildRecommendation({
  eventType,
  // Optional event-specific extras. Currently used:
  //   priceDirection: "up" | "down" | "mixed" — for products_update events
  //                   where the caller has computed the dominant variant direction.
  eventContext = {},
  revenueDeltaPct,
  ordersDeltaPct,
  aovDeltaPct,
  partialData,
  overlappingEvents,
  coverageBefore,
  coverageAfter,
  expectedBuckets,
}) {
  let confidence = 100;

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

  // Floor so we never report negative confidence numbers downstream.
  confidence = Math.max(0, confidence);

  let confidenceLevel = "high";
  if (confidence < 60) {
    confidenceLevel = "low";
  } else if (confidence < 80) {
    confidenceLevel = "medium";
  }

  const revenueTier = getImpactTier(revenueDeltaPct);
  const ordersTier = getImpactTier(ordersDeltaPct);

  let label = "neutral";
  let strength = "moderate";

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

  let tone = "info";
  if (label === "positive" && strength === "strong") {
    tone = "success";
  } else if (label === "negative" && strength === "strong") {
    tone = "critical";
  } else if (label === "positive" || label === "negative") {
    tone = "attention";
  } else if (label === "mixed") {
    tone = "warning";
  }

  const text = getRecommendationText(eventType, label, strength, eventContext);
  const drivers = buildDrivers({
    revenueDeltaPct,
    ordersDeltaPct,
    aovDeltaPct,
    coverageBefore,
    coverageAfter,
    expectedBuckets,
    partialData,
    overlappingEvents,
  });

  return {
    label,
    strength,
    confidence: confidenceLevel,
    tone,
    text,
    drivers,
  };
}

function getImpactTier(pct) {
  if (pct === null) return "neutral";
  if (pct >= 10) return "strong_positive";
  if (pct >= 3) return "positive";
  if (pct <= -10) return "strong_negative";
  if (pct <= -3) return "negative";
  return "neutral";
}

function getRecommendationText(eventType, label, strength, eventContext = {}) {
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

function buildDrivers({
  revenueDeltaPct,
  ordersDeltaPct,
  aovDeltaPct,
  coverageBefore,
  coverageAfter,
  expectedBuckets,
  partialData,
  overlappingEvents,
}) {
  const drivers = [];

  if (revenueDeltaPct !== null) {
    drivers.push(`Revenue Δ: ${revenueDeltaPct >= 0 ? "+" : ""}${revenueDeltaPct.toFixed(1)}% (10m window)`);
  } else {
    drivers.push("Revenue Δ: n/a (baseline=0)");
  }

  if (ordersDeltaPct !== null) {
    drivers.push(`Orders Δ: ${ordersDeltaPct >= 0 ? "+" : ""}${ordersDeltaPct.toFixed(1)}% (10m window)`);
  } else {
    drivers.push("Orders Δ: n/a (baseline=0)");
  }

  if (aovDeltaPct !== null) {
    drivers.push(`AOV Δ: ${aovDeltaPct >= 0 ? "+" : ""}${aovDeltaPct.toFixed(1)}%`);
  }

  drivers.push(`Data coverage: before ${coverageBefore}/${expectedBuckets}, after ${coverageAfter}/${expectedBuckets}`);

  if (overlappingEvents > 0) {
    drivers.push(`Overlapping events: ${overlappingEvents}`);
  }

  if (partialData) {
    drivers.push("Partial data: pagination limit");
  }

  return drivers;
}
