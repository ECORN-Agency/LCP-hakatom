// Shared webhook intake. Previously copy-pasted across webhooks.{themes,
// products,orders,collections}.jsx — now one place so the status-code
// contract can't drift between topics.
//
// Flow: verify HMAC → enqueue a WebhookJob (idempotent on webhookId) →
// fire-and-forget kick the worker → return 200. Real processing happens
// async in app/models/webhookProcessors.server.ts via /api/jobs/run.
//
// Status-code contract (M2):
//   - verification failure → propagate the SDK's Response (or 401). We do NOT
//     200 a bad-HMAC request.
//   - duplicate delivery (P2002 on webhookId) → 200, already enqueued.
//   - real enqueue failure (e.g. DB down) → 500, so Shopify RETRIES the
//     delivery instead of us silently dropping the event.
//   - success → 200.

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { logger } from "../logger.server";
import { kickWorker } from "./jobs.server";

export async function enqueueWebhook(request: Request, route: string): Promise<Response> {
  const log = logger.child({ route });
  const webhookId = request.headers.get("X-Shopify-Webhook-Id");

  let topic: string;
  let shop: string;
  let payload: unknown;
  try {
    ({ topic, shop, payload } = await authenticate.webhook(request));
  } catch (err) {
    // The Shopify SDK throws a Response on verification failure — return it
    // as-is. Anything else is an unexpected verify error.
    if (err instanceof Response) return err;
    log.error({ err: String(err) }, "webhook verification failed");
    return new Response(null, { status: 401 });
  }

  if (!webhookId) {
    log.warn({ shop, topic }, "no X-Shopify-Webhook-Id header — falling back to opaque enqueue");
  }

  try {
    await prisma.webhookJob.create({
      data: {
        shop,
        topic,
        webhookId: webhookId ?? `${shop}:${topic}:${Date.now()}:${Math.random()}`,
        payload: payload as any,
      },
    });
  } catch (err: any) {
    if (err?.code === "P2002") {
      // Duplicate delivery (Shopify retry or parallel handler) — already
      // enqueued. Idempotent: ack and still nudge the worker.
      log.info({ webhookId, shop, topic }, "duplicate delivery, already enqueued");
      kickWorker();
      return new Response(null, { status: 200 });
    }
    // Genuine enqueue failure — make Shopify retry rather than lose the event.
    log.error({ err: String(err), shop, topic }, "enqueue failed — asking Shopify to retry");
    return new Response(null, { status: 500 });
  }

  kickWorker();
  return new Response(null, { status: 200 });
}
