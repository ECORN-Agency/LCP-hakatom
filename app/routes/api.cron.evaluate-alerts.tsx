// Vercel Cron entry point.
// Schedule lives in /vercel.json — runs every 15 min by default.
//
// For every shop that has at least one enabled AlertRule, scan recent Change
// rows from the past few hours that:
//   (a) are old enough to have after-window data (>= rule.evaluationDelayMin)
//   (b) have never fired this rule before (unique on (ruleId, changeId))
//
// Compute the recommendation and, if it meets the rule's thresholds, send
// the email and record an AlertDelivery row.

import prisma from "../db.server";
import { logger } from "../logger.server";
import { evaluateChange, ruleMatches } from "../models/alertEvaluation.server";
import { sendEmail } from "../lib/email.server";

// Don't scan too far back — events older than this aren't worth alerting on,
// they're stale.
const MAX_LOOKBACK_HOURS = 6;

export const loader = async ({ request }) => {
  // Vercel Cron requests carry an Authorization: Bearer <CRON_SECRET> header.
  // We require it so the endpoint isn't a free DoS target.
  const auth = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${process.env.CRON_SECRET ?? ""}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    logger.warn({ path: "/api/cron/evaluate-alerts" }, "unauthorized cron request");
    return new Response("unauthorized", { status: 401 });
  }

  const startedAt = Date.now();
  const log = logger.child({ route: "api.cron.evaluate-alerts" });

  const enabledRules = await prisma.alertRule.findMany({
    where: { enabled: true },
  });

  if (enabledRules.length === 0) {
    return Response.json({ ok: true, ruleCount: 0, sent: 0, skipped: 0 });
  }

  log.info({ ruleCount: enabledRules.length }, "starting alert evaluation");

  let sent = 0;
  let skipped = 0;
  let errors = 0;

  // Group rules by shop so we fetch each shop's Change rows once.
  const rulesByShop = new Map<string, typeof enabledRules>();
  for (const rule of enabledRules) {
    const list = rulesByShop.get(rule.shop) ?? [];
    list.push(rule);
    rulesByShop.set(rule.shop, list);
  }

  const now = Date.now();
  const lookbackFrom = new Date(now - MAX_LOOKBACK_HOURS * 60 * 60 * 1000);

  for (const [shop, rules] of rulesByShop.entries()) {
    const shopLog = log.child({ shop });

    // Fetch candidate Change rows (recent, but old enough for after-window).
    // We use the most permissive delay across rules — individual rules
    // re-check the delay below.
    const minDelay = Math.min(...rules.map((r) => r.evaluationDelayMin));
    const cutoff = new Date(now - minDelay * 60 * 1000);

    const changes = await prisma.change.findMany({
      where: {
        shop,
        occurredAt: { gte: lookbackFrom, lte: cutoff },
      },
      orderBy: { occurredAt: "desc" },
      take: 100, // safety cap per shop per run
    });

    for (const change of changes) {
      for (const rule of rules) {
        const ruleDelayCutoff = new Date(now - rule.evaluationDelayMin * 60 * 1000);
        if (change.occurredAt > ruleDelayCutoff) {
          // Too fresh for this rule's required delay.
          continue;
        }

        // Skip if we've already processed this (rule, change) pair.
        const existing = await prisma.alertDelivery.findUnique({
          where: { ruleId_changeId: { ruleId: rule.id, changeId: change.id } },
        });
        if (existing) {
          continue;
        }

        const result = await evaluateChange({
          shop,
          changeId: change.id,
          windowMinutes: rule.windowMinutes,
        });
        if (!result || !result.recommendation) {
          // No data yet — don't write a delivery row, will retry next cron tick.
          continue;
        }

        const rec = result.recommendation;
        if (!ruleMatches(rec, rule)) {
          // Recommendation doesn't meet threshold — record "skipped" so we
          // don't re-evaluate ad infinitum, then move on.
          await prisma.alertDelivery
            .create({
              data: {
                ruleId: rule.id,
                shop,
                changeId: change.id,
                recommendation: rec,
                channel: rule.channel,
                destination: rule.destination,
                status: "skipped",
              },
            })
            .catch(() => {
              // Concurrent insert — fine, ignore unique violation.
            });
          skipped += 1;
          continue;
        }

        // Match — deliver.
        if (rule.channel !== "email") {
          shopLog.warn({ channel: rule.channel }, "non-email channel not implemented yet");
          continue;
        }

        const subject = `[LSP Analizer] ${rec.text.replace(/^Early signal: /, "")}`;
        const html = renderAlertHtml(change, rec, result.metrics, rule);
        const text = renderAlertText(change, rec, result.metrics, rule);

        const sendResult = await sendEmail({
          to: rule.destination,
          subject,
          html,
          text,
        });

        await prisma.alertDelivery
          .create({
            data: {
              ruleId: rule.id,
              shop,
              changeId: change.id,
              recommendation: rec,
              channel: rule.channel,
              destination: rule.destination,
              status: sendResult.ok ? "sent" : "failed",
              errorMessage: sendResult.ok ? null : sendResult.error,
            },
          })
          .catch(() => {
            // Race lost, another worker already wrote it.
          });

        if (sendResult.ok) {
          sent += 1;
          shopLog.info({ changeId: change.id, ruleId: rule.id }, "alert delivered");
        } else {
          errors += 1;
          shopLog.error(
            { changeId: change.id, ruleId: rule.id, error: sendResult.error },
            "alert delivery failed",
          );
        }
      }
    }
  }

  const durationMs = Date.now() - startedAt;
  log.info({ sent, skipped, errors, durationMs }, "alert evaluation finished");

  return Response.json({ ok: true, ruleCount: enabledRules.length, sent, skipped, errors });
};

function renderAlertHtml(change, rec, metrics, rule) {
  const driverLi = rec.drivers.map((d) => `<li style="margin: 2px 0;">${escapeHtml(d)}</li>`).join("");
  return `
    <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 560px;">
      <h2 style="color: #b00020; margin-bottom: 4px;">${escapeHtml(rec.text)}</h2>
      <p style="color: #666; margin-top: 0;">
        ${escapeHtml(rec.confidence)} confidence — ${escapeHtml(change.type)} on ${escapeHtml(change.shop)}
      </p>
      <h3 style="margin-bottom: 4px;">Event</h3>
      <p style="margin: 4px 0;">${escapeHtml(change.summary)}</p>
      <p style="color: #666; margin: 4px 0;">${new Date(change.occurredAt).toLocaleString()}</p>
      <h3 style="margin-bottom: 4px;">Drivers</h3>
      <ul style="padding-left: 20px;">${driverLi}</ul>
      <hr style="border: none; border-top: 1px solid #eee; margin: 16px 0;">
      <p style="color: #999; font-size: 12px;">
        Rule: ${escapeHtml(rule.minLabel)} / ${escapeHtml(rule.minConfidence)} confidence,
        ${rule.windowMinutes}-minute comparison window.
        Early signal in a compressed window — not causal proof.
      </p>
    </div>
  `.trim();
}

function renderAlertText(change, rec, metrics, rule) {
  const lines = [
    rec.text,
    `Confidence: ${rec.confidence}`,
    "",
    `Event: ${change.summary}`,
    `Type: ${change.type}`,
    `When: ${new Date(change.occurredAt).toISOString()}`,
    `Shop: ${change.shop}`,
    "",
    "Drivers:",
    ...rec.drivers.map((d) => `  - ${d}`),
    "",
    `Rule: ${rule.minLabel} / ${rule.minConfidence}+ confidence, ${rule.windowMinutes}m window`,
  ];
  return lines.join("\n");
}

function escapeHtml(s: unknown) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
