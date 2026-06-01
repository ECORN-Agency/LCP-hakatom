import prisma from "../db.server";
import { logger } from "../logger.server";

export function normalizeTo10MinBucketUTC(date: Date): Date {
  const d = new Date(date);
  const minutes = d.getUTCMinutes();
  const roundedMinutes = Math.floor(minutes / 10) * 10;
  d.setUTCMinutes(roundedMinutes, 0, 0);
  return d;
}

export async function fetchOrdersStats(admin, sinceISO, untilISO) {
  const ordersQuery = `
    query getOrders($first: Int!, $query: String!) {
      orders(first: $first, query: $query) {
        edges {
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
        }
      }
    }
  `;

  const sinceDate = new Date(sinceISO).toISOString();
  const untilDate = new Date(untilISO).toISOString();

  const ordersResponse = await admin.graphql(ordersQuery, {
    variables: {
      first: 250,
      query: `created_at:>=${sinceDate} AND created_at:<${untilDate} AND -test:true`,
    },
  });

  if (!ordersResponse.ok) {
    throw new Error(`GraphQL error: ${ordersResponse.statusText}`);
  }

  const ordersData = await ordersResponse.json();

  let orders = 0;
  let revenue = 0;
  const partial = ordersData.data?.orders?.pageInfo?.hasNextPage || false;

  if (ordersData.data?.orders?.edges) {
    orders = ordersData.data.orders.edges.length;
    revenue = ordersData.data.orders.edges.reduce((sum, edge) => {
      const amount = parseFloat(edge.node.totalPriceSet?.shopMoney?.amount || "0");
      return sum + amount;
    }, 0);
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


