import prisma from "../db.server";
import { logger } from "../logger.server";

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

export async function fetchOrdersStats(admin, sinceISO, untilISO) {
  const ordersQuery = `
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

  const sinceDate = new Date(sinceISO).toISOString();
  const untilDate = new Date(untilISO).toISOString();
  const queryFilter = `created_at:>=${sinceDate} AND created_at:<${untilDate} AND -test:true`;

  let orders = 0;
  let revenue = 0;
  let after: string | null = null;
  let pages = 0;
  let partial = false;

  while (true) {
    const response = await admin.graphql(ordersQuery, {
      variables: { first: PAGE_SIZE, after, query: queryFilter },
    });

    if (!response.ok) {
      throw new Error(`GraphQL error: ${response.statusText}`);
    }

    const data = await response.json();
    const edges = data?.data?.orders?.edges ?? [];
    const pageInfo = data?.data?.orders?.pageInfo ?? { hasNextPage: false, endCursor: null };

    orders += edges.length;
    for (const edge of edges) {
      revenue += parseFloat(edge?.node?.totalPriceSet?.shopMoney?.amount || "0");
    }
    pages += 1;

    if (!pageInfo.hasNextPage) break;

    if (pages >= MAX_PAGES_PER_BUCKET) {
      // We hit the safety cap — report partial so the UI can warn the user.
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

export async function backfillLastNMinutes(admin, shop, minutes = 120) {
  const nowUTC = new Date();
  const startUTC = new Date(nowUTC.getTime() - minutes * 60 * 1000);

  let updatedBuckets = 0;
  let anyPartial = false;

  const bucketSize = 10 * 60 * 1000;

  for (let bucketStart = normalizeTo10MinBucketUTC(startUTC); bucketStart < nowUTC; bucketStart = new Date(bucketStart.getTime() + bucketSize)) {
    const bucketEnd = new Date(bucketStart.getTime() + bucketSize);
    const bucketStartISO = bucketStart.toISOString();
    const bucketEndISO = bucketEnd.toISOString();

    try {
      const stats = await fetchOrdersStats(admin, bucketStartISO, bucketEndISO);
      await upsertBucketMetric(shop, bucketStart, stats.orders, stats.revenue);
      updatedBuckets++;

      if (stats.partial) {
        anyPartial = true;
      }
    } catch (error) {
      logger.error({ err: error, shop, bucketStart: bucketStartISO, bucketEnd: bucketEndISO }, "failed to backfill bucket");
    }
  }

  return { updatedBuckets, anyPartial };
}


