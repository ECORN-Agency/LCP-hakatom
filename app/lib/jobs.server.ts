// Fire-and-forget "wake the worker" call. The webhook handler invokes this
// after writing a WebhookJob row so the worker picks it up within seconds
// instead of waiting for the daily cron backstop.
//
// We deliberately do NOT await the fetch — the webhook handler must return
// 200 to Shopify within ~5s, and we don't want to block on internal work.
// If the kick fails the job stays in `pending` and the cron eventually drains.

import { logger } from "../logger.server";

export function kickWorker() {
  const appUrl =
    process.env.SHOPIFY_APP_URL?.replace(/\/$/, "") ??
    "https://lcp-hakatom.vercel.app";
  const secret = process.env.INTERNAL_SECRET;
  if (!secret) {
    logger.warn({}, "INTERNAL_SECRET not set — worker kick skipped");
    return;
  }

  // Don't await; let it fly. Catch swallows so unhandled-rejection isn't logged.
  fetch(`${appUrl}/api/jobs/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
  }).catch((err) => {
    logger.warn({ err: String(err) }, "worker kick failed (cron will pick up later)");
  });
}
