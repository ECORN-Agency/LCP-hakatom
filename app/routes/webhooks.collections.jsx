import { enqueueWebhook } from "../lib/webhookEnqueue.server";

export const action = ({ request }) => enqueueWebhook(request, "webhooks.collections");
