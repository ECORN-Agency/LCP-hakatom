// Storefront funnel aggregations over PixelEvent rows. These are the *real*
// near-realtime signal — orders lag by minutes-to-hours, page_viewed and
// product_added_to_cart arrive in seconds.
//
// Used by:
//   - api.baseline (to enrich the compare-around-event panel)
//   - alertEvaluation (so theme_published can fire on conversion-rate drops
//     before the order count moves at all)

import prisma from "../db.server";

export type PixelFunnel = {
  pageViews: number;
  productViews: number;
  cartAdds: number;
  checkoutsStarted: number;
  checkoutsCompleted: number;
  /**
   * checkouts_completed / page_viewed. Null when there are no page views in
   * the window (avoids divide-by-zero noise).
   */
  conversionRate: number | null;
  /**
   * checkouts_started / page_viewed — earliest conversion-funnel signal,
   * fires within seconds of a customer reaching checkout.
   */
  checkoutInitiationRate: number | null;
};

export function emptyFunnel(): PixelFunnel {
  return {
    pageViews: 0,
    productViews: 0,
    cartAdds: 0,
    checkoutsStarted: 0,
    checkoutsCompleted: 0,
    conversionRate: null,
    checkoutInitiationRate: null,
  };
}

/**
 * Single Postgres groupBy per call — cheap regardless of window size.
 */
export async function fetchPixelFunnel(
  shop: string,
  start: Date,
  end: Date,
): Promise<PixelFunnel> {
  const groups = await prisma.pixelEvent.groupBy({
    by: ["eventName"],
    where: { shop, occurredAt: { gte: start, lt: end } },
    _count: { _all: true },
  });

  const f = emptyFunnel();
  for (const g of groups) {
    const count = g._count?._all ?? 0;
    switch (g.eventName) {
      case "page_viewed":
        f.pageViews = count;
        break;
      case "product_viewed":
        f.productViews = count;
        break;
      case "product_added_to_cart":
        f.cartAdds = count;
        break;
      case "checkout_started":
        f.checkoutsStarted = count;
        break;
      case "checkout_completed":
        f.checkoutsCompleted = count;
        break;
    }
  }

  if (f.pageViews > 0) {
    f.conversionRate = f.checkoutsCompleted / f.pageViews;
    f.checkoutInitiationRate = f.checkoutsStarted / f.pageViews;
  }

  return f;
}

export type FunnelDeltaPct = {
  pageViews: number | null;
  cartAdds: number | null;
  checkoutsStarted: number | null;
  checkoutsCompleted: number | null;
  conversionRate: number | null;
  checkoutInitiationRate: number | null;
};

// Rolling funnel baseline: instead of comparing the W-minutes-before window
// against the W-minutes-after window (which mixes day-of-week + hour-of-day
// noise into the conversion signal), compare the after-event window against
// the SAME wall-clock slot over the last N weeks. This mirrors
// computeRollingBaseline (orders/revenue) so conversion uses the same
// seasonality-cancelling method as the rest of the verdict.
//
// Counts are averaged across weeks that actually had pixel traffic; rates
// (conversionRate / checkoutInitiationRate) are recomputed from the averaged
// counts. weeksWithData=0 means no history yet — caller must fall back to the
// before/after view.
const FUNNEL_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type RollingFunnelBaseline = {
  expected: PixelFunnel;
  weeksWithData: number;
  totalWeeks: number;
};

export async function computeRollingFunnelBaseline(
  shop: string,
  eventTime: Date,
  windowMinutes: number,
  lookbackWeeks = 4,
): Promise<RollingFunnelBaseline> {
  const windowMs = windowMinutes * 60 * 1000;

  const weekFunnels: PixelFunnel[] = [];
  for (let weekOffset = 1; weekOffset <= lookbackWeeks; weekOffset++) {
    const slotStart = new Date(eventTime.getTime() - weekOffset * FUNNEL_WEEK_MS);
    const slotEnd = new Date(slotStart.getTime() + windowMs);
    const f = await fetchPixelFunnel(shop, slotStart, slotEnd);
    // Treat a slot with zero page views as "no data" (storefront closed / no
    // traffic) rather than a real zero, so it doesn't drag the average down.
    if (f.pageViews > 0) {
      weekFunnels.push(f);
    }
  }

  if (weekFunnels.length === 0) {
    return { expected: emptyFunnel(), weeksWithData: 0, totalWeeks: lookbackWeeks };
  }

  const n = weekFunnels.length;
  const avg = (pick: (f: PixelFunnel) => number) =>
    weekFunnels.reduce((s, f) => s + pick(f), 0) / n;

  const expected = emptyFunnel();
  expected.pageViews = avg((f) => f.pageViews);
  expected.productViews = avg((f) => f.productViews);
  expected.cartAdds = avg((f) => f.cartAdds);
  expected.checkoutsStarted = avg((f) => f.checkoutsStarted);
  expected.checkoutsCompleted = avg((f) => f.checkoutsCompleted);
  if (expected.pageViews > 0) {
    expected.conversionRate = expected.checkoutsCompleted / expected.pageViews;
    expected.checkoutInitiationRate = expected.checkoutsStarted / expected.pageViews;
  }

  return { expected, weeksWithData: n, totalWeeks: lookbackWeeks };
}

export function funnelDeltaPct(before: PixelFunnel, after: PixelFunnel): FunnelDeltaPct {
  const pct = (a: number | null, b: number | null) => {
    if (a === null || b === null || b === 0) return null;
    return ((a - b) / b) * 100;
  };
  return {
    pageViews: before.pageViews > 0 ? ((after.pageViews - before.pageViews) / before.pageViews) * 100 : null,
    cartAdds: before.cartAdds > 0 ? ((after.cartAdds - before.cartAdds) / before.cartAdds) * 100 : null,
    checkoutsStarted:
      before.checkoutsStarted > 0
        ? ((after.checkoutsStarted - before.checkoutsStarted) / before.checkoutsStarted) * 100
        : null,
    checkoutsCompleted:
      before.checkoutsCompleted > 0
        ? ((after.checkoutsCompleted - before.checkoutsCompleted) / before.checkoutsCompleted) * 100
        : null,
    conversionRate: pct(after.conversionRate, before.conversionRate),
    checkoutInitiationRate: pct(after.checkoutInitiationRate, before.checkoutInitiationRate),
  };
}
