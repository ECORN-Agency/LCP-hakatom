// Pure rule-based recommendation engine.
// Runs on both server (loader/action) and client (component render),
// so this file must NOT import prisma, admin client, or anything server-only.
// Do NOT add the ".server" suffix back — React Router would strip it from the client bundle.

export function buildRecommendation({
  eventType,
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

  const text = getRecommendationText(eventType, label, strength);
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

function getRecommendationText(eventType, label, strength) {
  let text = "";

  if (eventType === "theme_published") {
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
  } else {
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
