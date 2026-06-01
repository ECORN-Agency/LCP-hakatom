// Given an AlertRule and a Change row, compute the recommendation for that
// change's after-window and decide whether the alert should fire.
//
// This duplicates a small slice of the calculation that lives client-side in
// app.analytics.tsx — keep them in sync. When we extract a fully-server
// "observed change" helper we should consolidate.

import prisma from "../db.server";
import { buildRecommendation } from "./recommendation";

// Ordering of confidence and label tiers — used for threshold comparison.
const CONFIDENCE_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2 };
const LABEL_ORDER: Record<string, number> = {
  any: 0,
  negative: 1,
  strong_negative: 2,
};

function meetsConfidence(actual: string, min: string) {
  return (CONFIDENCE_ORDER[actual] ?? 0) >= (CONFIDENCE_ORDER[min] ?? 0);
}

function meetsLabel(label: string, strength: string, min: string) {
  const minTier = LABEL_ORDER[min] ?? 0;
  if (minTier === 0) return true; // "any"
  if (label !== "negative") return false;
  // "strong_negative" requires strength="strong"; "negative" accepts any strength.
  if (minTier === 2 && strength !== "strong") return false;
  return true;
}

export async function evaluateChange({
  shop,
  changeId,
  windowMinutes,
}: {
  shop: string;
  changeId: string;
  windowMinutes: number;
}) {
  const change = await prisma.change.findUnique({ where: { id: changeId } });
  if (!change || change.shop !== shop) return null;

  const eventTime = new Date(change.occurredAt);
  const windowMs = windowMinutes * 60 * 1000;
  const beforeStart = new Date(eventTime.getTime() - windowMs);
  const afterEnd = new Date(eventTime.getTime() + windowMs);

  const buckets = await prisma.metricBucket.findMany({
    where: {
      shop,
      bucketAt: { gte: beforeStart, lte: afterEnd },
    },
    select: { bucketAt: true, orders: true, revenue: true },
  });

  const beforeBuckets = buckets.filter((b) => b.bucketAt < eventTime);
  const afterBuckets = buckets.filter((b) => b.bucketAt >= eventTime);

  if (afterBuckets.length === 0) {
    return { change, recommendation: null, reason: "no_after_data" as const };
  }

  const beforeRevenue = beforeBuckets.reduce((s, b) => s + b.revenue, 0);
  const beforeOrders = beforeBuckets.reduce((s, b) => s + b.orders, 0);
  const afterRevenue = afterBuckets.reduce((s, b) => s + b.revenue, 0);
  const afterOrders = afterBuckets.reduce((s, b) => s + b.orders, 0);

  const beforeAOV = beforeOrders > 0 ? beforeRevenue / beforeOrders : null;
  const afterAOV = afterOrders > 0 ? afterRevenue / afterOrders : null;

  const revenueDeltaPct =
    beforeRevenue > 0 ? ((afterRevenue - beforeRevenue) / beforeRevenue) * 100 : null;
  const ordersDeltaPct =
    beforeOrders > 0 ? ((afterOrders - beforeOrders) / beforeOrders) * 100 : null;
  const aovDeltaPct =
    beforeAOV !== null && beforeAOV > 0 && afterAOV !== null
      ? ((afterAOV - beforeAOV) / beforeAOV) * 100
      : null;

  const expectedBuckets = Math.max(1, Math.round(windowMinutes / 10));

  // For products_update we could compute priceDirection here too, but skip
  // for the alerts MVP — the recommendation engine still produces a useful
  // verdict without it.
  const rec = buildRecommendation({
    eventType: change.type,
    windowMinutes,
    revenueDeltaPct,
    ordersDeltaPct,
    aovDeltaPct,
    partialData: false,
    overlappingEvents: 0,
    coverageBefore: beforeBuckets.length,
    coverageAfter: afterBuckets.length,
    expectedBuckets,
  });

  return {
    change,
    recommendation: rec,
    metrics: {
      beforeRevenue,
      beforeOrders,
      afterRevenue,
      afterOrders,
      revenueDeltaPct,
      ordersDeltaPct,
    },
    reason: "ok" as const,
  };
}

export function ruleMatches(
  recommendation: { label: string; strength: string; confidence: string },
  rule: { minLabel: string; minConfidence: string },
) {
  return (
    meetsLabel(recommendation.label, recommendation.strength, rule.minLabel) &&
    meetsConfidence(recommendation.confidence, rule.minConfidence)
  );
}
