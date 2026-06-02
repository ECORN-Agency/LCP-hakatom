// Worker endpoint. Pulls pending WebhookJob rows off the queue and runs the
// topic-specific processor for each. Safe to call concurrently — Postgres
// FOR UPDATE SKIP LOCKED guarantees each row is processed exactly once.
//
// Two callers:
//   1. Fire-and-forget kick from webhook handlers (immediate, low-latency).
//   2. Daily cron in vercel.json (backstop for stuck/missed kicks).
//
// Authorization required via INTERNAL_SECRET or CRON_SECRET. Both are
// shared-secret Bearer tokens.

import prisma from "../db.server";
import { logger } from "../logger.server";
import { drainWebhookJobs } from "../models/workerDrain.server";

export const action = async ({ request }) => {
  const auth = request.headers.get("authorization") ?? "";
  const internalExpected = process.env.INTERNAL_SECRET
    ? `Bearer ${process.env.INTERNAL_SECRET}`
    : null;
  const cronExpected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : null;

  if (!(auth === internalExpected || auth === cronExpected)) {
    logger.warn({ path: "/api/jobs/run" }, "unauthorized worker call");
    return new Response("unauthorized", { status: 401 });
  }

  const result = await drainWebhookJobs();
  return Response.json({ ok: true, ...result });
};

// GET is reserved for healthcheck — useful from cron or uptime monitors.
export const loader = async () => {
  const counts = await prisma.webhookJob.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  const summary = Object.fromEntries(counts.map((c) => [c.status, c._count?._all ?? 0]));
  return Response.json({ ok: true, summary });
};
