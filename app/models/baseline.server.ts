import prisma from "../db.server";

// Rolling baseline: instead of comparing W-before-event vs W-after-event
// (which mixes day-of-week and hour-of-day noise into the signal), we compare
// the after-event window against the SAME wall-clock slot over the last N
// weeks. That cancels out weekly + daily seasonality.
//
// Example: event at Sunday 17:00, window 24h.
//   - "actual" = sum of MetricBucket rows in [event, event+24h]
//   - "expected" = average over [event-1w, event-1w+24h], [event-2w, ...], etc.
//
// Returns null expected values + weeksWithData=0 when there is no history
// yet — caller must fall back to the simpler before/after view in that case.

export type BaselineWeek = {
  weekOffset: number;
  orders: number;
  revenue: number;
};

export type BaselineResult = {
  expectedOrders: number | null;
  expectedRevenue: number | null;
  expectedAOV: number | null;
  weeksWithData: number;
  totalWeeks: number;
  perWeek: (BaselineWeek | null)[];
  bucketCoverage: number; // # of unique buckets across all weeks combined
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function computeRollingBaseline({
  shop,
  eventTime,
  windowMinutes,
  lookbackWeeks = 4,
}: {
  shop: string;
  eventTime: Date | string;
  windowMinutes: number;
  lookbackWeeks?: number;
}): Promise<BaselineResult> {
  const eventDate = eventTime instanceof Date ? eventTime : new Date(eventTime);
  const windowMs = windowMinutes * 60 * 1000;

  const perWeek: (BaselineWeek | null)[] = [];
  let totalBuckets = 0;

  for (let weekOffset = 1; weekOffset <= lookbackWeeks; weekOffset++) {
    const slotStart = new Date(eventDate.getTime() - weekOffset * WEEK_MS);
    const slotEnd = new Date(slotStart.getTime() + windowMs);

    const buckets = await prisma.metricBucket.findMany({
      where: {
        shop,
        bucketAt: { gte: slotStart, lt: slotEnd },
      },
      select: { orders: true, revenue: true },
    });

    if (buckets.length === 0) {
      perWeek.push(null);
      continue;
    }

    let orders = 0;
    let revenue = 0;
    for (const b of buckets) {
      orders += b.orders;
      revenue += b.revenue;
    }
    perWeek.push({ weekOffset, orders, revenue });
    totalBuckets += buckets.length;
  }

  const validWeeks = perWeek.filter((w): w is BaselineWeek => w !== null);

  if (validWeeks.length === 0) {
    return {
      expectedOrders: null,
      expectedRevenue: null,
      expectedAOV: null,
      weeksWithData: 0,
      totalWeeks: lookbackWeeks,
      perWeek,
      bucketCoverage: 0,
    };
  }

  const expectedOrders =
    validWeeks.reduce((sum, w) => sum + w.orders, 0) / validWeeks.length;
  const expectedRevenue =
    validWeeks.reduce((sum, w) => sum + w.revenue, 0) / validWeeks.length;
  const expectedAOV = expectedOrders > 0 ? expectedRevenue / expectedOrders : null;

  return {
    expectedOrders,
    expectedRevenue,
    expectedAOV,
    weeksWithData: validWeeks.length,
    totalWeeks: lookbackWeeks,
    perWeek,
    bucketCoverage: totalBuckets,
  };
}

// Compute "actual" for the after-event window. Same logic the UI uses, but
// runs server-side so we can return everything from one endpoint.
export async function fetchActualAfterEvent({
  shop,
  eventTime,
  windowMinutes,
}: {
  shop: string;
  eventTime: Date | string;
  windowMinutes: number;
}) {
  const eventDate = eventTime instanceof Date ? eventTime : new Date(eventTime);
  const windowMs = windowMinutes * 60 * 1000;
  const end = new Date(eventDate.getTime() + windowMs);

  const buckets = await prisma.metricBucket.findMany({
    where: {
      shop,
      bucketAt: { gte: eventDate, lt: end },
    },
    select: { orders: true, revenue: true },
  });

  let orders = 0;
  let revenue = 0;
  for (const b of buckets) {
    orders += b.orders;
    revenue += b.revenue;
  }

  return {
    actualOrders: orders,
    actualRevenue: revenue,
    actualAOV: orders > 0 ? revenue / orders : null,
    bucketCount: buckets.length,
  };
}
