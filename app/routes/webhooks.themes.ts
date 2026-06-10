import { enqueueWebhook } from "../lib/webhookEnqueue.server";

// Thin handler: shared intake verifies the webhook, enqueues a WebhookJob,
// kicks the worker and returns the right status code. All real processing
// lives in app/models/webhookProcessors.server.ts and runs in /api/jobs/run.
export const action = ({ request }: { request: Request }) =>
  enqueueWebhook(request, "webhooks.themes");
