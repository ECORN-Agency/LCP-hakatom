import { authenticate } from "../shopify.server";
import {
  computeRollingBaseline,
  fetchActualAfterEvent,
} from "../models/baseline.server";
import {
  fetchPixelFunnel,
  funnelDeltaPct,
  computeRollingFunnelBaseline,
} from "../models/pixelMetrics.server";
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

export const loader = async ({ request }: { request: Request }) => {
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
    // Pixel funnel windows.
    //   - "after"   = funnel in [event, event+W]  (the actual signal)
    //   - "expected"= rolling funnel baseline over the same slot, last N weeks
    //   - "before"  = funnel in [event-W, event]  (fallback only)
    // The conversion delta drives the theme-event verdict override, so it must
    // use the same seasonality-cancelling rolling baseline as orders/revenue —
    // NOT the naive before/after window (which mixes day-of-week + hour-of-day
    // noise). We only fall back to before/after when there is no history yet.
    const windowMs = windowMinutes * 60 * 1000;
    const beforeStart = new Date(eventDate.getTime() - windowMs);
    const afterEnd = new Date(eventDate.getTime() + windowMs);

    const [actual, baseline, funnelBefore, funnelAfter, funnelBaseline] = await Promise.all([
      fetchActualAfterEvent({ shop: session.shop, eventTime: eventDate, windowMinutes }),
      computeRollingBaseline({
        shop: session.shop,
        eventTime: eventDate,
        windowMinutes,
        lookbackWeeks,
      }),
      fetchPixelFunnel(session.shop, beforeStart, eventDate),
      fetchPixelFunnel(session.shop, eventDate, afterEnd),
      computeRollingFunnelBaseline(session.shop, eventDate, windowMinutes, lookbackWeeks),
    ]);

    // Prefer the rolling baseline as the comparison reference; fall back to the
    // before-window when there is no funnel history yet (new store / new pixel).
    const useFunnelBaseline = funnelBaseline.weeksWithData > 0;
    const funnelReference = useFunnelBaseline ? funnelBaseline.expected : funnelBefore;
    const funnelBasis: "baseline" | "before_after" = useFunnelBaseline
      ? "baseline"
      : "before_after";

    // funnelDeltaPct signature is (reference, actual) — pass them in that order
    // so the resulting Δ% is positive when "after" is higher than the reference.
    const funnelDelta = funnelDeltaPct(funnelReference, funnelAfter);

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

    // Statistical guards for the verdict (consumed by buildRecommendation):
    //   lowVolume       — too few orders to make a strong call.
    //   withinNoiseBand — actual is within ~1σ of the weekly baseline for BOTH
    //                     orders and revenue, i.e. indistinguishable from the
    //                     store's normal week-to-week swing.
    const VOLUME_FLOOR_ORDERS = 5;
    const lowVolume =
      baseline.expectedOrders === null ||
      baseline.expectedOrders < VOLUME_FLOOR_ORDERS ||
      actual.actualOrders < VOLUME_FLOOR_ORDERS;

    const withinNoiseBand =
      baseline.weeksWithData >= 2 &&
      baseline.stdDevOrders !== null &&
      baseline.stdDevRevenue !== null &&
      baseline.expectedOrders !== null &&
      baseline.expectedRevenue !== null &&
      Math.abs(actual.actualOrders - baseline.expectedOrders) <= baseline.stdDevOrders &&
      Math.abs(actual.actualRevenue - baseline.expectedRevenue) <= baseline.stdDevRevenue;

    log.info(
      {
        weeksWithData: baseline.weeksWithData,
        actualOrders: actual.actualOrders,
        expectedOrders: baseline.expectedOrders,
        stdDevOrders: baseline.stdDevOrders,
        lowVolume,
        withinNoiseBand,
        pageViewsBefore: funnelBefore.pageViews,
        pageViewsAfter: funnelAfter.pageViews,
      },
      "baseline computed",
    );

    return Response.json({
      actual,
      baseline,
      deltaPct,
      guards: { lowVolume, withinNoiseBand },
      funnel: {
        // `before` is the comparison reference shown in the UI: the rolling
        // baseline when available, else the literal before-window.
        before: funnelReference,
        after: funnelAfter,
        deltaPct: funnelDelta,
        basis: funnelBasis,
        weeksWithData: funnelBaseline.weeksWithData,
        totalWeeks: funnelBaseline.totalWeeks,
      },
    });
  } catch (err) {
    log.error({ err }, "baseline computation failed");
    return Response.json({ error: "internal error" }, { status: 500 });
  }
};
