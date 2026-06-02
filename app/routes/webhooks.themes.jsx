import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { logger } from "../logger.server";
import { kickWorker } from "../lib/jobs.server";

// Thin handler: verify the webhook, enqueue a WebhookJob, fire-and-forget
// a kick to wake the worker, return 200. All real processing lives in
// app/models/webhookProcessors.server.ts and runs in /api/jobs/run.
export const action = async ({ request }) => {
  const log = logger.child({ route: "webhooks.themes" });
  const webhookId = request.headers.get("X-Shopify-Webhook-Id");

  try {
    const { topic, shop, payload } = await authenticate.webhook(request);

    if (!webhookId) {
      log.warn({ shop, topic }, "no X-Shopify-Webhook-Id header — falling back to opaque enqueue");
    }

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
        // P2002 = unique violation on webhookId → already enqueued (retry from
        // Shopify or a parallel handler instance). Idempotent: ack silently.
        if (err?.code === "P2002") {
          log.info({ webhookId, shop, topic }, "duplicate delivery, already enqueued");
          return;
        }
        throw err;
      });

    kickWorker();
    return new Response(null, { status: 200 });
  } catch (err) {
    log.error({ err }, "theme webhook enqueue failed");
    return new Response(null, { status: 200 });
  }
};
