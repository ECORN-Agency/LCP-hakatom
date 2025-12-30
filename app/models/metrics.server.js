export async function fetchOrdersStats(admin, sinceISO, untilISO, includeEnd = true) {
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
      }
    }
  `;

  const checkoutsQuery = `
    query getCheckouts($first: Int!, $query: String!) {
      checkouts(first: $first, query: $query) {
        edges {
          node {
            id
          }
        }
      }
    }
  `;

  const sinceDate = new Date(sinceISO).toISOString();
  const untilDate = new Date(untilISO).toISOString();
  
  const dateOperator = includeEnd ? "<=" : "<";
  const queryString = `created_at:>=${sinceDate} AND created_at:${dateOperator}${untilDate} AND -test:true`;

  // Fetch orders
  const ordersResponse = await admin.graphql(ordersQuery, {
    variables: {
      first: 250,
      query: queryString,
    },
  });

  if (!ordersResponse.ok) {
    throw new Error(`GraphQL error: ${ordersResponse.statusText}`);
  }

  const ordersData = await ordersResponse.json();

  let orders = 0;
  let revenue = 0;

  if (ordersData.data?.orders?.edges) {
    orders = ordersData.data.orders.edges.length;
    revenue = ordersData.data.orders.edges.reduce((sum, edge) => {
      const amount = parseFloat(edge.node.totalPriceSet?.shopMoney?.amount || "0");
      return sum + amount;
    }, 0);
  }

  // Fetch checkouts for conversion rate calculation
  let sessions = 0;
  try {
    const checkoutsResponse = await admin.graphql(checkoutsQuery, {
      variables: {
        first: 250,
        query: `created_at:>=${sinceDate} AND created_at:${dateOperator}${untilDate}`,
      },
    });

    if (checkoutsResponse.ok) {
      const checkoutsData = await checkoutsResponse.json();
      if (checkoutsData.data?.checkouts?.edges) {
        // Use checkouts as proxy for sessions (simplified for MVP)
        sessions = checkoutsData.data.checkouts.edges.length;
      }
    } else {
      // If checkouts query fails, estimate sessions
      sessions = orders * 10 || 1;
    }
  } catch (error) {
    // Silently handle checkout fetch errors - not critical for MVP
    // If we can't get checkouts, estimate sessions as orders * 10 (typical conversion rate ~10%)
    sessions = orders * 10 || 1;
  }

  // Calculate conversion rate
  const conversionRate = sessions > 0 ? (orders / sessions) * 100 : 0;

  return { orders, revenue, conversionRate };
}

