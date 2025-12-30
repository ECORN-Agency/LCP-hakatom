import { authenticate } from "../shopify.server";
import prisma from "../db.server";

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
  try {
    const { topic, shop, payload } = await authenticate.webhook(request);

    const changeType = topic.replace(/\//g, "_").toLowerCase();
    const summary = getChangeSummary(topic, payload);
    const entityId = payload?.id ? String(payload.id) : null;

    await prisma.change.create({
      data: {
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
    console.error("Webhook error:", error);
    return new Response(null, { status: 200 });
  }
};

