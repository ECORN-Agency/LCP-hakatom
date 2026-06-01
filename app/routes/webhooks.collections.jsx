import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { logger } from "../logger.server";

const getChangeSummary = (topic, payload) => {
  const topicLower = topic.toLowerCase();
  const summaries = {
    "collections/create": (p) => `Collection created: ${p.title || p.id || "Unknown"}`,
    "collections/update": (p) => `Collection updated: ${p.title || p.id || "Unknown"}`,
    "collections/delete": (p) => `Collection deleted: ${p.title || p.id || "Unknown"}`,
    "collections_create": (p) => `Collection created: ${p.title || p.id || "Unknown"}`,
    "collections_update": (p) => `Collection updated: ${p.title || p.id || "Unknown"}`,
    "collections_delete": (p) => `Collection deleted: ${p.title || p.id || "Unknown"}`,
  };

  const getSummary = summaries[topicLower] || summaries[topic];
  return getSummary ? getSummary(payload) : `Collection ${topicLower.includes("create") ? "created" : topicLower.includes("delete") ? "deleted" : "updated"}: ${payload?.title || payload?.id || "Unknown"}`;
};

export const action = async ({ request }) => {
  // Read idempotency key BEFORE authenticate.webhook consumes the request body.
  const webhookId = request.headers.get("X-Shopify-Webhook-Id");
  try {
    const { topic, shop, payload } = await authenticate.webhook(request);

    // Idempotency: if we've already processed this delivery, ack and bail.
    if (webhookId) {
      const existing = await prisma.change.findUnique({ where: { webhookId } });
      if (existing) {
        logger.info({ webhookId, shop, topic, route: "webhooks.collections" }, "duplicate delivery, already processed");
        return new Response(null, { status: 200 });
      }
    }

    const changeType = topic.replace(/\//g, "_").toLowerCase();
    const summary = getChangeSummary(topic, payload);
    const entityId = payload?.id ? String(payload.id) : null;

    await prisma.change.create({
      data: {
        webhookId,
        shop: shop,
        type: changeType,
        entityType: "collection",
        entityId: entityId,
        summary: summary,
        payload: payload,
        occurredAt: new Date(),
      },
    });

    return new Response(null, { status: 200 });
  } catch (error) {
    logger.error({ err: error, route: "webhooks.collections" }, "collections webhook failed");
    return new Response(null, { status: 200 });
  }
};

