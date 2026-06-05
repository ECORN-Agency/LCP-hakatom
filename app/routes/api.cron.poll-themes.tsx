// Theme file polling endpoint.
//
// Why this exists: Shopify's themes/update webhook does NOT fire when
// merchants edit files in the Customizer. The only way to see file-level
// edits is to pull theme.files on a schedule and diff against a snapshot.
//
// Auth: same INTERNAL_SECRET / CRON_SECRET bearer scheme as the rest of the
// internal endpoints.
//
// Suggested cadence: every 5–15 minutes via an external scheduler
// (cron-job.org / QStash / GitHub Actions). Vercel Hobby's daily cron in
// vercel.json calls this as a backstop so something happens even without
// the external pinger.

import { logger } from "../logger.server";
import { pollAllActiveShops } from "../models/themeChangeRecorder.server";

export const action = async ({ request }) => {
  const auth = request.headers.get("authorization") ?? "";
  const cronExpected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : null;
  const internalExpected = process.env.INTERNAL_SECRET ? `Bearer ${process.env.INTERNAL_SECRET}` : null;

  if (!(auth === cronExpected || auth === internalExpected)) {
    logger.warn({ path: "/api/cron/poll-themes" }, "unauthorized poll request");
    return new Response("unauthorized", { status: 401 });
  }

  const startedAt = Date.now();
  const results = await pollAllActiveShops();
  const durationMs = Date.now() - startedAt;

  const summary = results.reduce<Record<string, number>>((acc, r) => {
    const key = r.reason ?? (r.ok ? "ok" : "fail");
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  logger.info(
    { shopsPolled: results.length, durationMs, summary },
    "theme polling complete",
  );

  return Response.json({
    ok: true,
    shopsPolled: results.length,
    durationMs,
    summary,
    results,
  });
};

export const loader = async () => {
  return Response.json({
    ok: true,
    hint: "POST with Authorization: Bearer <CRON_SECRET or INTERNAL_SECRET>",
  });
};
