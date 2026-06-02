// Shared worker logic. Called from:
//   - api.jobs.run     (fire-and-forget kick from webhook handlers)
//   - api.cron.evaluate-alerts (daily backstop for stuck jobs)

import prisma from "../db.server";
import { logger } from "../logger.server";
import { processWebhookJob } from "./webhookProcessors.server";

const DEFAULT_BATCH_SIZE = 25;

export async function drainWebhookJobs(batchSize: number = DEFAULT_BATCH_SIZE) {
  const log = logger.child({ component: "workerDrain" });

  // Atomically claim up to batchSize pending jobs using FOR UPDATE SKIP LOCKED
  // so concurrent worker invocations never grab the same row.
  const claimed = await prisma.$queryRaw<any[]>`
    UPDATE "WebhookJob"
    SET status = 'processing', "startedAt" = NOW(), attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM "WebhookJob"
      WHERE status = 'pending'
      ORDER BY "createdAt" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, shop, topic, "webhookId", payload
  `;

  if (claimed.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  let succeeded = 0;
  let failed = 0;

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
      await prisma.webhookJob.update({
        where: { id: job.id },
        data: { status: "failed", errorMessage: msg },
      });
      log.error({ jobId: job.id, topic: job.topic, err: msg }, "job failed");
      failed += 1;
    }
  }

  log.info({ claimed: claimed.length, succeeded, failed }, "worker batch done");
  return { processed: claimed.length, succeeded, failed };
}
