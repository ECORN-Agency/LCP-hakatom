import prisma from "../db.server";
import { logger } from "../logger.server";
import { graphqlWithRetry, type AdminGraphqlClient } from "../lib/shopifyGraphql.server";

export function normalizeTo10MinBucketUTC(date: Date): Date {
  const d = new Date(date);
  const minutes = d.getUTCMinutes();
  const roundedMinutes = Math.floor(minutes / 10) * 10;
  d.setUTCMinutes(roundedMinutes, 0, 0);
  return d;
}

// Per-bucket safety cap. 250 orders/page × 20 pages = 5000 orders in a 10-min window.
// If a real bucket somehow exceeds this we stop and flag `partial=true` rather than
// looping forever or blowing the Vercel function timeout.
const MAX_PAGES_PER_BUCKET = 20;
const PAGE_SIZE = 250;

// A backfill that's already this old is assumed dead (Vercel function timed
// out, etc.) — we let a new run reclaim the lock.
const STALE_LOCK_MS = 5 * 60 * 1000;

const ORDERS_QUERY = `
  query getOrders($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query) {
      edges {
        cursor
        node {
          totalPriceSet {
            shopMoney {
              amount
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export async function fetchOrdersStats(
  admin: AdminGraphqlClient,
  sinceISO: string,
  untilISO: string,
) {
  const sinceDate = new Date(sinceISO).toISOString();
  const untilDate = new Date(untilISO).toISOString();
  const queryFilter = `created_at:>=${sinceDate} AND created_at:<${untilDate} AND -test:true`;

  let orders = 0;
  let revenue = 0;
  let after: string | null = null;
  let pages = 0;
  let partial = false;

  while (true) {
    const data = await graphqlWithRetry<any>(
      admin,
      ORDERS_QUERY,
      { first: PAGE_SIZE, after, query: queryFilter },
      { opName: "fetchOrdersStats" },
    );

    if (data.errors && data.errors.length > 0) {
      throw new Error(
        `fetchOrdersStats GraphQL errors: ${data.errors.map((e) => e.message).join("; ")}`,
      );
    }

    const edges = data?.data?.orders?.edges ?? [];
    const pageInfo = data?.data?.orders?.pageInfo ?? { hasNextPage: false, endCursor: null };

    orders += edges.length;
    for (const edge of edges) {
      revenue += parseFloat(edge?.node?.totalPriceSet?.shopMoney?.amount || "0");
    }
    pages += 1;

    if (!pageInfo.hasNextPage) break;

    if (pages >= MAX_PAGES_PER_BUCKET) {
      logger.warn(
        { sinceISO, untilISO, pages, ordersSoFar: orders, cap: MAX_PAGES_PER_BUCKET },
        "fetchOrdersStats hit MAX_PAGES_PER_BUCKET, stopping with partial=true",
      );
      partial = true;
      break;
    }

    after = pageInfo.endCursor;
  }

  return { orders, revenue, partial };
}

export async function upsertBucketMetric(shop, bucketAtUTC, orders, revenue) {
  await prisma.metricBucket.upsert({
    where: {
      shop_bucketAt: {
        shop,
        bucketAt: bucketAtUTC,
      },
    },
    update: {
      orders,
      revenue,
    },
    create: {
      shop,
      bucketAt: bucketAtUTC,
      orders,
      revenue,
    },
  });
}

export async function getBucketMetrics(shop, fromISO, toISO) {
  const fromDate = new Date(fromISO);
  const toDate = new Date(toISO);

  return await prisma.metricBucket.findMany({
    where: {
      shop,
      bucketAt: {
        gte: fromDate,
        lte: toDate,
      },
    },
    orderBy: {
      bucketAt: "asc",
    },
  });
}

// Try to claim the per-shop backfill lock. Returns true if we got it, false
// if another invocation already owns a fresh lock. Stale locks (older than
// STALE_LOCK_MS without a finish) are reclaimed automatically.
export async function tryAcquireBackfillLock(shop: string): Promise<boolean> {
  await prisma.shopConfig.upsert({
    where: { shop },
    create: { shop },
    update: {},
  });

  const config = await prisma.shopConfig.findUnique({ where: { shop } });
  if (!config) return false;

  const now = new Date();
  const lockIsActive =
    config.backfillStartedAt !== null &&
    config.backfillFinishedAt === null &&
    now.getTime() - config.backfillStartedAt.getTime() < STALE_LOCK_MS;

  if (lockIsActive) return false;

  await prisma.shopConfig.update({
    where: { shop },
    data: { backfillStartedAt: now, backfillFinishedAt: null },
  });
  return true;
}

export async function releaseBackfillLock(shop: string) {
  await prisma.shopConfig
    .update({
      where: { shop },
      data: { backfillFinishedAt: new Date() },
    })
    .catch(() => {});
}

export async function backfillLastNMinutes(
  admin: AdminGraphqlClient,
  shop: string,
  minutes = 120,
): Promise<{ updatedBuckets: number; anyPartial: boolean; locked?: boolean }> {
  const acquired = await tryAcquireBackfillLock(shop);
  if (!acquired) {
    logger.warn({ shop, minutes }, "backfill skipped — another run is in flight");
    return { updatedBuckets: 0, anyPartial: false, locked: true };
  }

  try {
    const nowUTC = new Date();
    const startUTC = new Date(nowUTC.getTime() - minutes * 60 * 1000);

    let updatedBuckets = 0;
    let anyPartial = false;

    const bucketSize = 10 * 60 * 1000;

    for (
      let bucketStart = normalizeTo10MinBucketUTC(startUTC);
      bucketStart < nowUTC;
      bucketStart = new Date(bucketStart.getTime() + bucketSize)
    ) {
      const bucketEnd = new Date(bucketStart.getTime() + bucketSize);
      const bucketStartISO = bucketStart.toISOString();
      const bucketEndISO = bucketEnd.toISOString();

      try {
        const stats = await fetchOrdersStats(admin, bucketStartISO, bucketEndISO);
        await upsertBucketMetric(shop, bucketStart, stats.orders, stats.revenue);
        updatedBuckets++;
        if (stats.partial) anyPartial = true;
      } catch (error) {
        logger.error(
          { err: error, shop, bucketStart: bucketStartISO, bucketEnd: bucketEndISO },
          "failed to backfill bucket",
        );
      }
    }

    return { updatedBuckets, anyPartial };
  } finally {
    await releaseBackfillLock(shop);
  }
}
