import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const getChangeSummary = (topic, payload) => {
  const topicLower = topic.toLowerCase();
  const summaries = {
    "orders/create": (p) => `Order created: #${p.order_number || p.id || "Unknown"}`,
    "orders/updated": (p) => `Order updated: #${p.order_number || p.id || "Unknown"}`,
    "orders_create": (p) => `Order created: #${p.order_number || p.id || "Unknown"}`,
    "orders_updated": (p) => `Order updated: #${p.order_number || p.id || "Unknown"}`,
  };

  const getSummary = summaries[topicLower] || summaries[topic];
  return getSummary ? getSummary(payload) : `Order ${topicLower.includes("create") ? "created" : "updated"}: #${payload?.order_number || payload?.id || "Unknown"}`;
};

export const action = async ({ request }) => {
  try {
    const { topic, shop, payload } = await authenticate.webhook(request);

    console.log("Order webhook received:", { topic, shop, orderNumber: payload?.order_number || payload?.id, payloadKeys: Object.keys(payload || {}) });

    const changeType = topic.replace(/\//g, "_").toLowerCase();
    const summary = getChangeSummary(topic, payload);
    const entityId = payload?.id ? String(payload.id) : null;

    // Deduplication logic:
    // - If ORDERS_CREATE comes, always create it (it's the primary event)
    // - If ORDERS_UPDATED comes and ORDERS_CREATE was recently recorded, skip ORDERS_UPDATED
    // - If ORDERS_UPDATED comes first, create it, but if ORDERS_CREATE comes later, it will replace it
    if (entityId && changeType === "orders_updated") {
      const recentCreate = await prisma.change.findFirst({
        where: {
          shop: shop,
          type: "orders_create",
          entityId: entityId,
          occurredAt: {
            gte: new Date(Date.now() - 10000), // Last 10 seconds
          },
        },
        orderBy: { occurredAt: "desc" },
      });

      if (recentCreate) {
        console.log(`[DEDUPLICATION] Skipping ${changeType} for order ${entityId} as orders_create was recently recorded.`);
        return new Response(null, { status: 200 });
      }
    }
    
    // If ORDERS_CREATE comes and ORDERS_UPDATED was recently recorded, delete the updated event and create create event
    if (entityId && changeType === "orders_create") {
      const recentUpdated = await prisma.change.findFirst({
        where: {
          shop: shop,
          type: "orders_updated",
          entityId: entityId,
          occurredAt: {
            gte: new Date(Date.now() - 10000), // Last 10 seconds
          },
        },
        orderBy: { occurredAt: "desc" },
      });

      if (recentUpdated) {
        console.log(`[DEDUPLICATION] Deleting orders_updated event ${recentUpdated.id} and creating orders_create for order ${entityId}.`);
        await prisma.change.delete({
          where: { id: recentUpdated.id },
        });
      }
    }

    let orderCreatedAt;
    if (payload?.created_at) {
      orderCreatedAt = new Date(payload.created_at);
      if (isNaN(orderCreatedAt.getTime())) {
        orderCreatedAt = new Date();
      }
    } else {
      orderCreatedAt = new Date();
    }
    
    console.log(`[ORDER WEBHOOK] Using occurredAt: ${orderCreatedAt.toISOString()} for order ${entityId} (created_at: ${payload?.created_at || 'not provided'})`);
    
    await prisma.change.create({
      data: {
        shop: shop,
        type: changeType,
        entityType: "order",
        entityId: entityId,
        summary: summary,
        payload: payload,
        occurredAt: orderCreatedAt,
      },
    });

    console.log("Order change created:", { type: changeType, summary, entityId });
    return new Response(null, { status: 200 });
  } catch (error) {
    console.error("Order webhook error:", error);
    return new Response(null, { status: 200 });
  }
};

