import { enqueueWebhook } from "../lib/webhookEnqueue.server";

export const action = ({ request }: { request: Request }) =>
  enqueueWebhook(request, "webhooks.collections");
