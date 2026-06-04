import { authenticate } from "../shopify.server";
import {
  computeRollingBaseline,
  fetchActualAfterEvent,
} from "../models/baseline.server";
import { fetchPixelFunnel, funnelDeltaPct } from "../models/pixelMetrics.server";
import { logger } from "../logger.server";

// GET /api/baseline?eventTime=ISO&windowMinutes=1440&lookbackWeeks=4
// Returns:
//   {
//     actual: { orders, revenue, AOV, bucketCount },
//     baseline: { expectedOrders, expectedRevenue, expectedAOV,
//                 weeksWithData, totalWeeks, perWeek, bucketCoverage },
//     deltaPct: { revenue, orders, aov }
//   }
//
// The UI calls this when the user expands "Compare around event" so we don't
// blow up the main loader with 4 weeks × W minutes of bucket queries for
// every event in the list.

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);

  const eventTime = url.searchParams.get("eventTime");
  const windowMinutes = parseInt(url.searchParams.get("windowMinutes") || "1440", 10);
  const lookbackWeeks = parseInt(url.searchParams.get("lookbackWeeks") || "4", 10);

  if (!eventTime) {
    return Response.json(
      { error: "eventTime query param is required (ISO 8601)" },
      { status: 400 },
    );
  }

  const eventDate = new Date(eventTime);
  if (Number.isNaN(eventDate.getTime())) {
    return Response.json({ error: "eventTime is not a valid date" }, { status: 400 });
  }

  const log = logger.child({
    route: "api.baseline",
    shop: session.shop,
    eventTime,
    windowMinutes,
    lookbackWeeks,
  });

  try {
    // Pixel funnel windows — same shape as the metric-bucket comparison: W
    // minutes before the event vs W minutes after.
    const windowMs = windowMinutes * 60 * 1000;
    const beforeStart = new Date(eventDate.getTime() - windowMs);
    const afterEnd = new Date(eventDate.getTime() + windowMs);

    const [actual, baseline, funnelBefore, funnelAfter] = await Promise.all([
      fetchActualAfterEvent({ shop: session.shop, eventTime: eventDate, windowMinutes }),
      computeRollingBaseline({
        shop: session.shop,
        eventTime: eventDate,
        windowMinutes,
        lookbackWeeks,
      }),
      fetchPixelFunnel(session.shop, beforeStart, eventDate),
      fetchPixelFunnel(session.shop, eventDate, afterEnd),
    ]);

    // funnelDeltaPct signature is (before, after) — pass them in that order
    // so the resulting Δ% is positive when "after" is higher than "before".
    const funnelDelta = funnelDeltaPct(funnelBefore, funnelAfter);

    const deltaPct = {
      revenue:
        baseline.expectedRevenue !== null && baseline.expectedRevenue > 0
          ? ((actual.actualRevenue - baseline.expectedRevenue) / baseline.expectedRevenue) * 100
          : null,
      orders:
        baseline.expectedOrders !== null && baseline.expectedOrders > 0
          ? ((actual.actualOrders - baseline.expectedOrders) / baseline.expectedOrders) * 100
          : null,
      aov:
        baseline.expectedAOV !== null && actual.actualAOV !== null && baseline.expectedAOV > 0
          ? ((actual.actualAOV - baseline.expectedAOV) / baseline.expectedAOV) * 100
          : null,
    };

    log.info(
      {
        weeksWithData: baseline.weeksWithData,
        actualOrders: actual.actualOrders,
        expectedOrders: baseline.expectedOrders,
        pageViewsBefore: funnelBefore.pageViews,
        pageViewsAfter: funnelAfter.pageViews,
      },
      "baseline computed",
    );

    return Response.json({
      actual,
      baseline,
      deltaPct,
      funnel: {
        before: funnelBefore,
        after: funnelAfter,
        deltaPct: funnelDelta,
      },
    });
  } catch (err) {
    log.error({ err }, "baseline computation failed");
    return Response.json({ error: "internal error" }, { status: 500 });
  }
};
