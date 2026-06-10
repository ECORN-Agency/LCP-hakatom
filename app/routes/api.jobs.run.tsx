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
import { bearerMatches } from "../lib/auth.server";

export const action = async ({ request }: { request: Request }) => {
  const auth = request.headers.get("authorization");

  if (!bearerMatches(auth, process.env.INTERNAL_SECRET, process.env.CRON_SECRET)) {
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
