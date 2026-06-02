import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { logger } from "../logger.server";
import { kickWorker } from "../lib/jobs.server";

export const action = async ({ request }) => {
  const log = logger.child({ route: "webhooks.collections" });
  const webhookId = request.headers.get("X-Shopify-Webhook-Id");

  try {
    const { topic, shop, payload } = await authenticate.webhook(request);

    await prisma.webhookJob
      .create({
        data: {
          shop,
          topic,
          webhookId: webhookId ?? `${shop}:${topic}:${Date.now()}:${Math.random()}`,
          payload,
        },
      })
      .catch((err) => {
        if (err?.code === "P2002") {
          log.info({ webhookId, shop, topic }, "duplicate delivery, already enqueued");
          return;
        }
        throw err;
      });

    kickWorker();
    return new Response(null, { status: 200 });
  } catch (err) {
    log.error({ err }, "collections webhook enqueue failed");
    return new Response(null, { status: 200 });
  }
};
