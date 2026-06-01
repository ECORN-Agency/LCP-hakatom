import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { logger } from "../logger.server";

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
  let log = logger.child({ route: "webhooks.orders" });
  // Read idempotency key BEFORE authenticate.webhook consumes the request body.
  const webhookId = request.headers.get("X-Shopify-Webhook-Id");
  try {
    const { topic, shop, payload } = await authenticate.webhook(request);
    log = log.child({ shop, topic, webhookId });

    // Idempotency: if we've already processed this delivery, ack and bail.
    if (webhookId) {
      const existing = await prisma.change.findUnique({ where: { webhookId } });
      if (existing) {
        log.info({ existingChangeId: existing.id }, "duplicate delivery, already processed");
        return new Response(null, { status: 200 });
      }
    }

    log.info({
      orderNumber: payload?.order_number || payload?.id,
      payloadKeys: Object.keys(payload || {}),
    }, "order webhook received");

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
        log.info({ changeType, entityId, suppressedBy: "orders_create", windowMs: 10000 }, "deduplicated order event");
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
        log.info({ deletedChangeId: recentUpdated.id, entityId }, "replacing recent orders_updated with orders_create");
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
    
    log.debug({ entityId, occurredAt: orderCreatedAt.toISOString(), payloadCreatedAt: payload?.created_at ?? null }, "resolved order occurredAt");
    
    await prisma.change.create({
      data: {
        webhookId,
        shop: shop,
        type: changeType,
        entityType: "order",
        entityId: entityId,
        summary: summary,
        payload: payload,
        occurredAt: orderCreatedAt,
      },
    });

    log.info({ type: changeType, entityId, summary }, "change created");
    return new Response(null, { status: 200 });
  } catch (error) {
    log.error({ err: error }, "order webhook failed");
    return new Response(null, { status: 200 });
  }
};

