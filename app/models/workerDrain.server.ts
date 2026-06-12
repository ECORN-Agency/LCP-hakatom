// Shared worker logic. Called from:
//   - api.jobs.run     (fire-and-forget kick from webhook handlers)
//   - api.cron.evaluate-alerts (daily backstop for stuck jobs)

import prisma from "../db.server";
import { logger } from "../logger.server";
import { processWebhookJob } from "./webhookProcessors.server";

const DEFAULT_BATCH_SIZE = 25;

// A job left in `processing` longer than 5 minutes is assumed orphaned — the
// function that claimed it crashed / timed out (Vercel) before writing a
// terminal status. We reclaim it on the next drain (see the INTERVAL in the
// claim query below). Mirrors the backfill lock's STALE_LOCK_MS reclaim. (H1)

// Max delivery attempts before a job is parked in `failed`. Transient errors
// (network blip, GraphQL hiccup) get retried up to this many times by being
// returned to `pending`; only after exhausting them do we give up. (H2)
const MAX_ATTEMPTS = 5;

// Errors that will never succeed on retry — fail them immediately instead of
// burning MAX_ATTEMPTS cycles. (H2)
function isPermanentError(message: string): boolean {
  return message.includes("unknown webhook topic");
}

export async function drainWebhookJobs(batchSize: number = DEFAULT_BATCH_SIZE) {
  const log = logger.child({ component: "workerDrain" });

  // Atomically claim up to batchSize jobs using FOR UPDATE SKIP LOCKED so
  // concurrent worker invocations never grab the same row. We claim both
  // fresh `pending` rows and `processing` rows whose claim has gone stale
  // (orphaned by a crashed/timed-out invocation). (H1)
  // Staleness is compared entirely in SQL (NOW() - INTERVAL) rather than
  // against a JS Date param. `startedAt` is written with NOW() in this very
  // query, and the column is `timestamp` (without tz); comparing it to a
  // JS Date (a UTC instant) skews by the server's timezone offset and would
  // wrongly reclaim fresh, in-flight jobs. Keeping both sides on NOW() makes
  // the window self-consistent regardless of timezone.
  const claimed = await prisma.$queryRaw<any[]>`
    UPDATE "WebhookJob"
    SET status = 'processing', "startedAt" = NOW(), attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM "WebhookJob"
      WHERE status = 'pending'
         OR (status = 'processing' AND "startedAt" < NOW() - INTERVAL '5 minutes')
      ORDER BY "createdAt" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, shop, topic, "webhookId", payload, attempts
  `;

  if (claimed.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0, retried: 0 };
  }

  let succeeded = 0;
  let failed = 0;
  let retried = 0;

  for (const job of claimed) {
    try {
      await processWebhookJob({
        shop: job.shop,
        topic: job.topic,
        webhookId: job.webhookId,
        payload: job.payload,
      });
      await prisma.webhookJob.update({
        where: { id: job.id },
        data: { status: "completed", completedAt: new Date(), errorMessage: null },
      });
      succeeded += 1;
    } catch (err) {
      const msg = String(err).slice(0, 500);
      // `attempts` already includes the current try (incremented at claim).
      const attempts = typeof job.attempts === "number" ? job.attempts : MAX_ATTEMPTS;
      const willRetry = attempts < MAX_ATTEMPTS && !isPermanentError(msg);

      await prisma.webhookJob.update({
        where: { id: job.id },
        data: willRetry
          ? // Return to the queue; clear startedAt so it's eligible again
            // and isn't mistaken for an in-flight claim.
            { status: "pending", errorMessage: msg, startedAt: null }
          : { status: "failed", errorMessage: msg },
      });

      if (willRetry) {
        log.warn({ jobId: job.id, topic: job.topic, attempts, err: msg }, "job failed, will retry");
        retried += 1;
      } else {
        log.error({ jobId: job.id, topic: job.topic, attempts, err: msg }, "job failed permanently");
        failed += 1;
      }
    }
  }

  log.info({ claimed: claimed.length, succeeded, failed, retried }, "worker batch done");
  return { processed: claimed.length, succeeded, failed, retried };
}
