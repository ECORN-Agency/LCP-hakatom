import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { drainWebhookJobs } from "../models/workerDrain.server";
import { resetAndReactivatePixel } from "../models/pixelActivation.server";
import { sendEmail } from "../lib/email.server";
import { graphqlWithRetry } from "../lib/shopifyGraphql.server";
import { logger } from "../logger.server";

const SINCE_24H = () => new Date(Date.now() - 24 * 60 * 60 * 1000);
const SUBSCRIBED_TOPICS = [
  "themes/publish",
  "themes/update",
  "products/create",
  "products/update",
  "products/delete",
  "collections/create",
  "collections/update",
  "collections/delete",
  "orders/create",
  "orders/updated",
];

const WEBHOOK_SUBS_QUERY = `#graphql
  query WebhookSubscriptions($first: Int!) {
    webhookSubscriptions(first: $first) {
      edges {
        node {
          id
          topic
          endpoint {
            __typename
            ... on WebhookHttpEndpoint { callbackUrl }
          }
        }
      }
    }
  }
`;

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const since24h = SINCE_24H();

  // Optional: pull live webhook subscription list. Best-effort — if it fails
  // we still render the rest of the page.
  let subscribedTopicsLive: string[] = [];
  let subsError: string | null = null;
  try {
    const data: any = await graphqlWithRetry(
      admin,
      WEBHOOK_SUBS_QUERY,
      { first: 50 },
      { opName: "health.webhookSubscriptions" },
    );
    const edges = data?.data?.webhookSubscriptions?.edges ?? [];
    subscribedTopicsLive = edges
      .map((e: any) => String(e?.node?.topic ?? "").toLowerCase().replace(/_/g, "/"))
      .filter(Boolean);
  } catch (err) {
    subsError = String(err).slice(0, 200);
  }

  const [
    jobCountsRaw,
    recentFailedJobs,
    lastCompletedJob,
    jobsByTopicRaw,
    shopConfig,
    pixelEventsTotalRaw,
    pixelEventsByName,
    alertDelivery24hRaw,
    recentFailedDeliveries,
    activeRules,
    changeCount,
    bucketCount,
    pixelTotalAll,
    oldestChange,
    latestChange,
  ] = await Promise.all([
    prisma.webhookJob.groupBy({
      by: ["status"],
      where: { shop, createdAt: { gte: since24h } },
      _count: { _all: true },
    }),
    prisma.webhookJob.findMany({
      where: { shop, status: "failed" },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { topic: true, createdAt: true, attempts: true, errorMessage: true },
    }),
    prisma.webhookJob.findFirst({
      where: { shop, status: "completed" },
      orderBy: { completedAt: "desc" },
      select: { completedAt: true },
    }),
    prisma.webhookJob.groupBy({
      by: ["topic"],
      where: { shop, createdAt: { gte: since24h } },
      _count: { _all: true },
    }),
    prisma.shopConfig.findUnique({ where: { shop } }),
    prisma.pixelEvent.count({ where: { shop, occurredAt: { gte: since24h } } }),
    prisma.pixelEvent.groupBy({
      by: ["eventName"],
      where: { shop, occurredAt: { gte: since24h } },
      _count: { _all: true },
    }),
    prisma.alertDelivery.groupBy({
      by: ["status"],
      where: { shop, deliveredAt: { gte: since24h } },
      _count: { _all: true },
    }),
    prisma.alertDelivery.findMany({
      where: { shop, status: "failed" },
      orderBy: { deliveredAt: "desc" },
      take: 5,
      select: { destination: true, deliveredAt: true, errorMessage: true },
    }),
    prisma.alertRule.count({ where: { shop, enabled: true } }),
    prisma.change.count({ where: { shop } }),
    prisma.metricBucket.count({ where: { shop } }),
    prisma.pixelEvent.count({ where: { shop } }),
    prisma.change.findFirst({
      where: { shop },
      orderBy: { occurredAt: "asc" },
      select: { occurredAt: true },
    }),
    prisma.change.findFirst({
      where: { shop },
      orderBy: { occurredAt: "desc" },
      select: { occurredAt: true },
    }),
  ]);

  // Reshape groupBy results into status -> count maps.
  const jobCounts = Object.fromEntries(
    jobCountsRaw.map((g) => [g.status, g._count?._all ?? 0]),
  );
  const jobsByTopic = Object.fromEntries(
    jobsByTopicRaw.map((g) => [g.topic, g._count?._all ?? 0]),
  );
  const alertDelivery24h = Object.fromEntries(
    alertDelivery24hRaw.map((g) => [g.status, g._count?._all ?? 0]),
  );
  const pixelByName = Object.fromEntries(
    pixelEventsByName.map((g) => [g.eventName, g._count?._all ?? 0]),
  );

  // Webhook subscription health: which subscribed topics had no recent jobs?
  const subscribedSet = new Set(
    (subscribedTopicsLive.length > 0 ? subscribedTopicsLive : SUBSCRIBED_TOPICS).map((t) =>
      t.toLowerCase().replace(/_/g, "/"),
    ),
  );
  const knownTopics = Array.from(subscribedSet);

  return {
    shop,
    jobCounts: {
      pending: jobCounts.pending ?? 0,
      processing: jobCounts.processing ?? 0,
      completed: jobCounts.completed ?? 0,
      failed: jobCounts.failed ?? 0,
    },
    recentFailedJobs,
    lastCompletedAt: lastCompletedJob?.completedAt ?? null,
    jobsByTopic,
    knownTopics,
    subsError,
    pixelActive: !!shopConfig?.pixelActivatedAt,
    pixelActivatedAt: shopConfig?.pixelActivatedAt ?? null,
    pixelId: shopConfig?.pixelId ?? null,
    pixelLastError: shopConfig?.pixelLastError ?? null,
    pixelEventsTotal24h: pixelEventsTotalRaw,
    pixelByName,
    backfillStartedAt: shopConfig?.backfillStartedAt ?? null,
    backfillFinishedAt: shopConfig?.backfillFinishedAt ?? null,
    alertDelivery24h: {
      sent: alertDelivery24h.sent ?? 0,
      failed: alertDelivery24h.failed ?? 0,
      skipped: alertDelivery24h.skipped ?? 0,
    },
    recentFailedDeliveries,
    activeRules,
    totals: {
      changes: changeCount,
      buckets: bucketCount,
      pixelEvents: pixelTotalAll,
    },
    oldestChangeAt: oldestChange?.occurredAt ?? null,
    latestChangeAt: latestChange?.occurredAt ?? null,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  const log = logger.child({ route: "app.health", shop: session.shop, intent });

  if (intent === "drain_jobs") {
    const result = await drainWebhookJobs();
    log.info(result, "manual drain triggered");
    return { ok: true, message: `Drained ${result.processed} job(s): ${result.succeeded} ok, ${result.failed} failed` };
  }

  if (intent === "release_backfill_lock") {
    await prisma.shopConfig.upsert({
      where: { shop: session.shop },
      create: { shop: session.shop },
      update: { backfillStartedAt: null, backfillFinishedAt: new Date() },
    });
    log.info({}, "backfill lock force-released");
    return { ok: true, message: "Backfill lock released" };
  }

  if (intent === "reactivate_pixel") {
    const result = await resetAndReactivatePixel({ shop: session.shop, admin });
    log.info(result, "manual pixel re-activation");
    return result.activated
      ? { ok: true, message: `Pixel activated (${result.pixelId ?? "id unknown"})` }
      : { ok: false, message: `Pixel activation failed: ${result.error}` };
  }

  if (intent === "send_test_email") {
    const rule = await prisma.alertRule.findFirst({
      where: { shop: session.shop, channel: "email", enabled: true },
      orderBy: { createdAt: "desc" },
    });
    if (!rule) {
      return { ok: false, message: "No enabled email alert rules to test against. Create one first." };
    }
    const result = await sendEmail({
      to: rule.destination,
      subject: "[LSP Analizer] Test email",
      html: "<p>This is a test email from the LSP Analizer health page. If you received it, Resend is wired up correctly.</p>",
      text: "Test email from LSP Analizer health page. Resend is wired up correctly.",
    });
    return result.ok
      ? { ok: true, message: `Test email sent to ${rule.destination}` }
      : { ok: false, message: `Test email failed: ${result.error}` };
  }

  return { ok: false, message: `Unknown intent: ${intent}` };
};

function StatusBadge({ tone, children }) {
  return <s-badge tone={tone}>{children}</s-badge>;
}

function relativeTime(date) {
  if (!date) return "never";
  const ms = Date.now() - new Date(date).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export default function Health() {
  const d = useLoaderData();
  const drainFetcher = useFetcher();
  const lockFetcher = useFetcher();
  const pixelFetcher = useFetcher();
  const emailFetcher = useFetcher();

  // Queue health verdict
  const queueStuck = d.jobCounts.pending > 0 && d.lastCompletedAt
    ? Date.now() - new Date(d.lastCompletedAt).getTime() > 5 * 60_000
    : d.jobCounts.pending > 0;
  const lastJobAge = d.lastCompletedAt ? Date.now() - new Date(d.lastCompletedAt).getTime() : null;
  const lastJobTone = lastJobAge === null ? "warning" : lastJobAge < 15 * 60_000 ? "success" : lastJobAge < 60 * 60_000 ? "attention" : "critical";

  // Backfill stuck check
  const backfillStuck =
    d.backfillStartedAt &&
    !d.backfillFinishedAt &&
    Date.now() - new Date(d.backfillStartedAt).getTime() > 5 * 60_000;

  // Pixel verdict
  const pixelStaleData = d.pixelActive && d.pixelEventsTotal24h === 0;

  // Topics with no events in 24h
  const silentTopics = d.knownTopics.filter((t) => !d.jobsByTopic[t]);

  return (
    <s-page id="health-page" heading="Health">
      {/* Webhook queue */}
      <s-section heading="Webhook queue (24h)">
        <s-box padding="base" background="base" borderWidth="base" borderColor="base" borderRadius="base">
          <s-stack gap="small">
            <s-stack direction="inline" gap="base" alignItems="center">
              <StatusBadge tone={d.jobCounts.pending > 0 ? (queueStuck ? "critical" : "attention") : "success"}>
                Pending: {d.jobCounts.pending}
              </StatusBadge>
              <StatusBadge tone="info">Processing: {d.jobCounts.processing}</StatusBadge>
              <StatusBadge tone="success">Completed: {d.jobCounts.completed}</StatusBadge>
              <StatusBadge tone={d.jobCounts.failed > 0 ? "critical" : "success"}>
                Failed: {d.jobCounts.failed}
              </StatusBadge>
            </s-stack>
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-text color="subdued">Last successful drain:</s-text>
              <StatusBadge tone={lastJobTone}>{relativeTime(d.lastCompletedAt)}</StatusBadge>
              <s-button
                variant="primary"
                onClick={() => drainFetcher.submit({ intent: "drain_jobs" }, { method: "POST" })}
                loading={drainFetcher.state !== "idle"}
              >
                Drain queue now
              </s-button>
              {drainFetcher.data?.message && (
                <s-text color={drainFetcher.data.ok ? "subdued" : "critical"}>
                  {drainFetcher.data.message}
                </s-text>
              )}
            </s-stack>

            {d.recentFailedJobs.length > 0 && (
              <s-stack gap="small">
                <s-text type="strong">Recent failed jobs:</s-text>
                {d.recentFailedJobs.map((j, idx) => (
                  <s-box key={idx} padding="small" background="subdued" borderRadius="small">
                    <s-text color="subdued">
                      <s-text type="strong">{j.topic}</s-text> · {new Date(j.createdAt).toLocaleString()} · attempts {j.attempts}
                    </s-text>
                    {j.errorMessage && (
                      <s-text color="critical" type="subdued">{j.errorMessage}</s-text>
                    )}
                  </s-box>
                ))}
              </s-stack>
            )}
          </s-stack>
        </s-box>
      </s-section>

      {/* Webhook topics */}
      <s-section heading="Webhooks received per topic (24h)">
        <s-box padding="base" background="base" borderWidth="base" borderColor="base" borderRadius="base">
          <s-stack gap="small">
            {d.knownTopics.length === 0 ? (
              <s-text color="subdued">No webhook subscriptions visible. Check shopify.app.toml is deployed.</s-text>
            ) : (
              d.knownTopics.map((topic) => (
                <div
                  key={topic}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "2fr 1fr",
                    gap: "var(--p-space-3, 12px)",
                    alignItems: "center",
                  }}
                >
                  <s-text>{topic}</s-text>
                  <div style={{ textAlign: "right" }}>
                    {d.jobsByTopic[topic] > 0 ? (
                      <s-text type="strong">{d.jobsByTopic[topic]}</s-text>
                    ) : (
                      <StatusBadge tone="attention">silent</StatusBadge>
                    )}
                  </div>
                </div>
              ))
            )}
            {silentTopics.length > 0 && (
              <s-text color="subdued" type="subdued">
                {silentTopics.length} topic(s) had no events in 24h. Could be normal for a quiet store, or the subscription drifted — re-run `shopify app deploy` if you suspect drift.
              </s-text>
            )}
            {d.subsError && (
              <s-text color="critical" type="subdued">webhookSubscriptions check failed: {d.subsError}</s-text>
            )}
          </s-stack>
        </s-box>
      </s-section>

      {/* Storefront pixel */}
      <s-section heading="Storefront pixel">
        <s-box padding="base" background="base" borderWidth="base" borderColor="base" borderRadius="base">
          <s-stack gap="small">
            <s-stack direction="inline" gap="base" alignItems="center">
              <StatusBadge tone={d.pixelActive ? (pixelStaleData ? "attention" : "success") : "critical"}>
                {d.pixelActive ? "Active" : "Not active"}
              </StatusBadge>
              {d.pixelActivatedAt && (
                <s-text color="subdued">since {new Date(d.pixelActivatedAt).toLocaleString()}</s-text>
              )}
              <s-button
                variant="secondary"
                onClick={() => pixelFetcher.submit({ intent: "reactivate_pixel" }, { method: "POST" })}
                loading={pixelFetcher.state !== "idle"}
              >
                Re-activate
              </s-button>
              {pixelFetcher.data?.message && (
                <s-text color={pixelFetcher.data.ok ? "subdued" : "critical"}>{pixelFetcher.data.message}</s-text>
              )}
            </s-stack>
            {d.pixelId && (
              <s-text color="subdued" type="subdued">ID: {d.pixelId}</s-text>
            )}
            {d.pixelLastError && (
              <s-text color="critical" type="subdued">Last error: {d.pixelLastError}</s-text>
            )}

            <s-text type="strong">PixelEvent counts (24h, total: {d.pixelEventsTotal24h}):</s-text>
            {Object.keys(d.pixelByName).length === 0 ? (
              pixelStaleData ? (
                <s-text color="critical" type="subdued">
                  Pixel is active but received zero events in 24h. Either no customer traffic, or the pixel
                  isn't firing — check the storefront in incognito.
                </s-text>
              ) : (
                <s-text color="subdued" type="subdued">No events recorded yet.</s-text>
              )
            ) : (
              Object.entries(d.pixelByName).map(([name, count]) => (
                <div key={name} style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "var(--p-space-3)" }}>
                  <s-text>{name}</s-text>
                  <div style={{ textAlign: "right" }}>
                    <s-text type="strong">{String(count)}</s-text>
                  </div>
                </div>
              ))
            )}
          </s-stack>
        </s-box>
      </s-section>

      {/* Backfill state */}
      <s-section heading="Backfill">
        <s-box padding="base" background="base" borderWidth="base" borderColor="base" borderRadius="base">
          <s-stack gap="small">
            {!d.backfillStartedAt ? (
              <s-text color="subdued">No backfill recorded yet for this shop.</s-text>
            ) : (
              <>
                <s-text>
                  Last started: <s-text type="strong">{new Date(d.backfillStartedAt).toLocaleString()}</s-text>
                </s-text>
                {d.backfillFinishedAt ? (
                  <s-text>
                    Finished: <s-text type="strong">{new Date(d.backfillFinishedAt).toLocaleString()}</s-text>
                  </s-text>
                ) : backfillStuck ? (
                  <StatusBadge tone="critical">
                    Backfill stuck — started over 5 minutes ago and still running
                  </StatusBadge>
                ) : (
                  <StatusBadge tone="info">In progress</StatusBadge>
                )}
              </>
            )}
            {(backfillStuck || (d.backfillStartedAt && !d.backfillFinishedAt)) && (
              <s-button
                variant="secondary"
                onClick={() => lockFetcher.submit({ intent: "release_backfill_lock" }, { method: "POST" })}
                loading={lockFetcher.state !== "idle"}
              >
                Force release lock
              </s-button>
            )}
            {lockFetcher.data?.message && (
              <s-text color={lockFetcher.data.ok ? "subdued" : "critical"}>{lockFetcher.data.message}</s-text>
            )}
          </s-stack>
        </s-box>
      </s-section>

      {/* Alert deliveries */}
      <s-section heading={`Alert deliveries (24h) — ${d.activeRules} active rule${d.activeRules === 1 ? "" : "s"}`}>
        <s-box padding="base" background="base" borderWidth="base" borderColor="base" borderRadius="base">
          <s-stack gap="small">
            <s-stack direction="inline" gap="base" alignItems="center">
              <StatusBadge tone="success">Sent: {d.alertDelivery24h.sent}</StatusBadge>
              <StatusBadge tone={d.alertDelivery24h.failed > 0 ? "critical" : "success"}>
                Failed: {d.alertDelivery24h.failed}
              </StatusBadge>
              <StatusBadge tone="info">Skipped: {d.alertDelivery24h.skipped}</StatusBadge>
              <s-button
                variant="secondary"
                onClick={() => emailFetcher.submit({ intent: "send_test_email" }, { method: "POST" })}
                loading={emailFetcher.state !== "idle"}
              >
                Send test email
              </s-button>
              {emailFetcher.data?.message && (
                <s-text color={emailFetcher.data.ok ? "subdued" : "critical"}>{emailFetcher.data.message}</s-text>
              )}
            </s-stack>
            {d.recentFailedDeliveries.length > 0 && (
              <s-stack gap="small">
                <s-text type="strong">Recent failed deliveries:</s-text>
                {d.recentFailedDeliveries.map((dlv, idx) => (
                  <s-box key={idx} padding="small" background="subdued" borderRadius="small">
                    <s-text>
                      <s-text type="strong">{dlv.destination}</s-text> · {new Date(dlv.deliveredAt).toLocaleString()}
                    </s-text>
                    {dlv.errorMessage && (
                      <s-text color="critical" type="subdued">{dlv.errorMessage}</s-text>
                    )}
                  </s-box>
                ))}
              </s-stack>
            )}
          </s-stack>
        </s-box>
      </s-section>

      {/* Scale check */}
      <s-section heading="Scale">
        <s-box padding="base" background="base" borderWidth="base" borderColor="base" borderRadius="base">
          <s-stack gap="small">
            <s-text>Total Change rows: <s-text type="strong">{d.totals.changes}</s-text></s-text>
            <s-text>Total MetricBucket rows: <s-text type="strong">{d.totals.buckets}</s-text></s-text>
            <s-text>Total PixelEvent rows: <s-text type="strong">{d.totals.pixelEvents}</s-text></s-text>
            {d.oldestChangeAt && (
              <s-text color="subdued">
                Oldest event: {new Date(d.oldestChangeAt).toLocaleString()}
              </s-text>
            )}
            {d.latestChangeAt && (
              <s-text color="subdued">
                Latest event: {new Date(d.latestChangeAt).toLocaleString()} ({relativeTime(d.latestChangeAt)})
              </s-text>
            )}
            <s-text color="subdued" type="subdued">Shop: {d.shop}</s-text>
          </s-stack>
        </s-box>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
