import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useRevalidator } from "react-router";
import { useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getBucketMetrics, backfillLastNMinutes, normalizeTo10MinBucketUTC } from "../models/metricsBuckets.server";
import { buildRecommendation } from "../models/recommendation";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const minutes = parseInt(url.searchParams.get("minutes") || "120", 10);

  const nowUTC = new Date();
  const fromUTC = new Date(nowUTC.getTime() - minutes * 60 * 1000);
  const fromISO = fromUTC.toISOString();
  const toISO = nowUTC.toISOString();

  const metrics = await getBucketMetrics(session.shop, fromISO, toISO);

  const events = await prisma.change.findMany({
    where: {
      shop: session.shop,
      occurredAt: {
        gte: fromUTC,
        lte: nowUTC,
      },
    },
    orderBy: { occurredAt: "desc" },
  });

  const processedMetrics = metrics.map((m) => ({
    ...m,
    bucketAt: m.bucketAt instanceof Date ? m.bucketAt : new Date(m.bucketAt),
  }));

  return { metrics: processedMetrics, events, minutes };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "backfill") {
    const minutes = parseInt(formData.get("minutes") || "120", 10);
    const result = await backfillLastNMinutes(admin, session.shop, minutes);
    return { ok: true, anyPartial: result.anyPartial };
  }

  return { ok: false };
};

// Pull event-type-specific context out of the raw Change row before handing
// it to the recommendation engine. Keep this pure so it can move into
// app/models/ later if other surfaces need it.
function extractEventContext(event) {
  if (!event) return {};

  if (event.type === "products_update" || event.type === "products_create") {
    const priceChanges = event?.payload?.changeDetails?.priceChanges;
    if (!Array.isArray(priceChanges) || priceChanges.length === 0) {
      return {};
    }
    let ups = 0;
    let downs = 0;
    for (const change of priceChanges) {
      const oldP = parseFloat(change?.oldPrice ?? "");
      const newP = parseFloat(change?.newPrice ?? "");
      if (!Number.isFinite(oldP) || !Number.isFinite(newP) || oldP === newP) continue;
      if (newP > oldP) ups += 1;
      else downs += 1;
    }
    if (ups > 0 && downs === 0) return { priceDirection: "up" };
    if (downs > 0 && ups === 0) return { priceDirection: "down" };
    if (ups > 0 && downs > 0) return { priceDirection: "mixed" };
    return {};
  }

  return {};
}

export default function Analytics() {
  const { metrics, events, minutes } = useLoaderData();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedEventId, setSelectedEventId] = useState(null);
  const [anyPartial, setAnyPartial] = useState(false);

  const selectedEvent = events.find((e) => e.id === selectedEventId);

  const handleBackfill = () => {
    fetcher.submit(
      { intent: "backfill", minutes: minutes.toString() },
      { method: "POST" }
    );
  };

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      if (fetcher.data.anyPartial) {
        setAnyPartial(true);
      }
      revalidator.revalidate();
    }
  }, [fetcher.state, fetcher.data, revalidator]);

  const handleMinutesChange = (newMinutes) => {
    const newParams = new URLSearchParams(searchParams);
    newParams.set("minutes", newMinutes.toString());
    setSearchParams(newParams);
  };

  const getTypeBadge = (type) => {
    const typeMap = {
      theme_published: "Theme published",
      theme_switched: "Theme switched",
      theme_files_updated: "Theme updated",
      orders_create: "Order created",
      orders_updated: "Order updated",
      products_create: "Product created",
      products_update: "Product updated",
      products_delete: "Product deleted",
      collections_create: "Collection created",
      collections_update: "Collection updated",
      collections_delete: "Collection deleted",
      manual: "Manual event",
    };
    return typeMap[type] || type;
  };

  const getTypeTone = (type) => {
    if (type.startsWith("theme_")) return "info";
    if (type.startsWith("orders_")) return "success";
    if (type.startsWith("products_")) return "warning";
    if (type.startsWith("collections_")) return "attention";
    return "neutral";
  };

  function normalizeTo10MinBucketUTC(date) {
    const d = new Date(date);
    const minutes = d.getUTCMinutes();
    const roundedMinutes = Math.floor(minutes / 10) * 10;
    d.setUTCMinutes(roundedMinutes, 0, 0);
    return d;
  }

  const calculateObservedChange = (event) => {
    if (!event) return null;

    const W = 10;
    const eventTime = new Date(event.occurredAt);
    const beforeStart = new Date(eventTime.getTime() - W * 60 * 1000);
    const afterEnd = new Date(eventTime.getTime() + W * 60 * 1000);

    const beforeBuckets = metrics.filter((m) => {
      const bucketAt = m.bucketAt instanceof Date ? m.bucketAt : new Date(m.bucketAt);
      return bucketAt >= beforeStart && bucketAt < eventTime;
    });
    const afterBuckets = metrics.filter((m) => {
      const bucketAt = m.bucketAt instanceof Date ? m.bucketAt : new Date(m.bucketAt);
      return bucketAt >= eventTime && bucketAt <= afterEnd;
    });

    const expectedBuckets = W / 10;

    if (afterBuckets.length === 0) {
      return { waiting: true, message: "No metrics available. Click 'Backfill' to collect metrics for this time window." };
    }

    if (beforeBuckets.length === 0 && afterBuckets.length === 0) {
      return { waiting: true, message: "No metrics available. Click 'Backfill' to collect metrics for this time window." };
    }

    const beforeRevenue = beforeBuckets.reduce((sum, b) => sum + b.revenue, 0);
    const beforeOrders = beforeBuckets.reduce((sum, b) => sum + b.orders, 0);
    const afterRevenue = afterBuckets.reduce((sum, b) => sum + b.revenue, 0);
    const afterOrders = afterBuckets.reduce((sum, b) => sum + b.orders, 0);

    const beforeAOV = beforeOrders > 0 ? beforeRevenue / beforeOrders : null;
    const afterAOV = afterOrders > 0 ? afterRevenue / afterOrders : null;

    const revenueDelta = afterRevenue - beforeRevenue;
    const ordersDelta = afterOrders - beforeOrders;
    const aovDelta = afterAOV !== null && beforeAOV !== null ? afterAOV - beforeAOV : null;

    const revenueDeltaPct = beforeRevenue > 0 ? ((afterRevenue - beforeRevenue) / beforeRevenue) * 100 : null;
    const ordersDeltaPct = beforeOrders > 0 ? ((afterOrders - beforeOrders) / beforeOrders) * 100 : null;
    const aovDeltaPct = beforeAOV !== null && beforeAOV > 0 ? ((afterAOV - beforeAOV) / beforeAOV) * 100 : null;

    const overlappingEvents = events.filter(
      (e) =>
        e.id !== event.id &&
        new Date(e.occurredAt) >= beforeStart &&
        new Date(e.occurredAt) <= afterEnd
    ).length;

    return {
      beforeRevenue,
      beforeOrders,
      beforeAOV,
      afterRevenue,
      afterOrders,
      afterAOV,
      revenueDelta,
      ordersDelta,
      aovDelta,
      revenueDeltaPct,
      ordersDeltaPct,
      aovDeltaPct,
      coverageBefore: beforeBuckets.length,
      coverageAfter: afterBuckets.length,
      expectedBuckets,
      overlappingEvents,
      partialData: anyPartial,
    };
  };

  const observedChangeData = calculateObservedChange(selectedEvent);
  
  const observedChange = observedChangeData ? {
    ...observedChangeData,
    recommendation: observedChangeData.waiting ? null : buildRecommendation({
      eventType: selectedEvent.type,
      eventContext: extractEventContext(selectedEvent),
      revenueDeltaPct: observedChangeData.revenueDeltaPct,
      ordersDeltaPct: observedChangeData.ordersDeltaPct,
      aovDeltaPct: observedChangeData.aovDeltaPct,
      partialData: observedChangeData.partialData,
      overlappingEvents: observedChangeData.overlappingEvents,
      coverageBefore: observedChangeData.coverageBefore,
      coverageAfter: observedChangeData.coverageAfter,
      expectedBuckets: observedChangeData.expectedBuckets,
    }),
  } : null;

  return (
    <s-page id="analytics-page" heading="Analytics">
      <s-section id="controls-section" heading="Controls">
        <s-box
          id="controls-card"
          padding="base"
          background="base"
          borderWidth="base"
          borderColor="base"
          borderRadius="base"
        >
          <s-stack id="controls-stack" gap="base">
            <s-stack id="range-selector" direction="inline" gap="small">
              <s-button
                variant={minutes === 60 ? "primary" : "secondary"}
                onClick={() => handleMinutesChange(60)}
              >
                60 min
              </s-button>
              <s-button
                variant={minutes === 120 ? "primary" : "secondary"}
                onClick={() => handleMinutesChange(120)}
              >
                120 min
              </s-button>
              <s-button
                variant={minutes === 240 ? "primary" : "secondary"}
                onClick={() => handleMinutesChange(240)}
              >
                240 min
              </s-button>
            </s-stack>
            <s-button
              id="backfill-button"
              variant="primary"
              onClick={handleBackfill}
              loading={fetcher.state !== "idle"}
            >
              Backfill last {minutes} minutes
            </s-button>
            <s-text color="subdued" type="subdued">
              MVP uses time-compressed windows; results are early signals (not causal proof).
            </s-text>
            {anyPartial && (
              <s-badge tone="warning">Partial data (pagination not implemented in MVP)</s-badge>
            )}
          </s-stack>
        </s-box>
      </s-section>

      <s-section id="events-section" heading="Events">
        {events.length === 0 ? (
          <s-box
            id="empty-events"
            padding="large"
            background="base"
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-text alignment="center" color="subdued">
              No events in this range.
            </s-text>
          </s-box>
        ) : (
          <s-stack id="events-list" gap="small">
            {events.map((event) => {
              const isSelected = selectedEventId === event.id;
              const eventObservedChangeData = isSelected ? calculateObservedChange(event) : null;
              const eventObservedChange = eventObservedChangeData ? {
                ...eventObservedChangeData,
                recommendation: eventObservedChangeData.waiting ? null : buildRecommendation({
                  eventType: event.type,
                  eventContext: extractEventContext(event),
                  revenueDeltaPct: eventObservedChangeData.revenueDeltaPct,
                  ordersDeltaPct: eventObservedChangeData.ordersDeltaPct,
                  aovDeltaPct: eventObservedChangeData.aovDeltaPct,
                  partialData: eventObservedChangeData.partialData,
                  overlappingEvents: eventObservedChangeData.overlappingEvents,
                  coverageBefore: eventObservedChangeData.coverageBefore,
                  coverageAfter: eventObservedChangeData.coverageAfter,
                  expectedBuckets: eventObservedChangeData.expectedBuckets,
                }),
              } : null;
              
              return (
                <s-box
                  id={`event-row-${event.id}`}
                  key={event.id}
                  padding="base"
                  background="base"
                  borderWidth="base"
                  borderColor="base"
                  borderRadius="base"
                >
                  <s-stack id={`event-row-stack-${event.id}`} gap="base">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--p-space-4)", width: "100%" }}>
                      <s-stack id={`event-row-main-${event.id}`} direction="inline" gap="base" alignItems="center" style={{ flex: "1 1 0%", minWidth: 0, overflow: "hidden" }}>
                        <s-text color="subdued" style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
                          {new Date(event.occurredAt).toLocaleString()}
                        </s-text>
                        <s-badge tone={getTypeTone(event.type)} style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
                          {getTypeBadge(event.type)}
                        </s-badge>
                        <s-text style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: "1 1 0%" }}>
                          {event.summary}
                        </s-text>
                      </s-stack>
                      <s-button
                        variant="secondary"
                        onClick={() => setSelectedEventId(isSelected ? null : event.id)}
                        style={{ flex: "0 0 auto" }}
                      >
                        <span style={{ whiteSpace: "nowrap" }}>
                          {isSelected ? "Hide comparison" : "Compare around event"}
                        </span>
                      </s-button>
                    </div>

                    {isSelected && eventObservedChange && (
                      <s-stack id={`observed-change-${event.id}`} gap="base">
                        {eventObservedChange.waiting ? (
                          <s-stack id={`waiting-state-${event.id}`} direction="inline" gap="small" alignItems="center">
                            <s-badge tone="info">Waiting for data</s-badge>
                            <s-text color="subdued">{eventObservedChange.message}</s-text>
                          </s-stack>
                        ) : (
                          <>
                            <s-text>
                              Data coverage: before {eventObservedChange.coverageBefore}/{eventObservedChange.expectedBuckets}, after {eventObservedChange.coverageAfter}/{eventObservedChange.expectedBuckets}
                            </s-text>

                            {(eventObservedChange.coverageBefore < eventObservedChange.expectedBuckets || eventObservedChange.coverageAfter < eventObservedChange.expectedBuckets) && (
                              <s-badge tone="warning">Low coverage</s-badge>
                            )}

                            {anyPartial && (
                              <s-badge tone="warning">Partial data (pagination not implemented)</s-badge>
                            )}

                            <s-box
                              id={`comparison-table-${event.id}`}
                              padding="base"
                              background="subdued"
                              borderWidth="base"
                              borderColor="base"
                              borderRadius="base"
                            >
                              <s-stack id={`comparison-stack-${event.id}`} gap="base">
                                <s-stack id={`revenue-row-${event.id}`} direction="inline" justifyContent="space-between">
                                  <s-text type="strong">Revenue</s-text>
                                  <s-text>Before: ${eventObservedChange.beforeRevenue.toFixed(2)}</s-text>
                                  <s-text>After: ${eventObservedChange.afterRevenue.toFixed(2)}</s-text>
                                  <s-text type="strong">
                                    Δ {eventObservedChange.revenueDelta >= 0 ? "+" : ""}${eventObservedChange.revenueDelta.toFixed(2)}
                                    {eventObservedChange.revenueDeltaPct !== null && ` (${eventObservedChange.revenueDeltaPct >= 0 ? "+" : ""}${eventObservedChange.revenueDeltaPct.toFixed(1)}%)`}
                                  </s-text>
                                </s-stack>
                                <s-stack id={`orders-row-${event.id}`} direction="inline" justifyContent="space-between">
                                  <s-text type="strong">Orders</s-text>
                                  <s-text>Before: {eventObservedChange.beforeOrders}</s-text>
                                  <s-text>After: {eventObservedChange.afterOrders}</s-text>
                                  <s-text type="strong">
                                    Δ {eventObservedChange.ordersDelta >= 0 ? "+" : ""}{eventObservedChange.ordersDelta}
                                    {eventObservedChange.ordersDeltaPct !== null && ` (${eventObservedChange.ordersDeltaPct >= 0 ? "+" : ""}${eventObservedChange.ordersDeltaPct.toFixed(1)}%)`}
                                  </s-text>
                                </s-stack>
                                <s-stack id={`aov-row-${event.id}`} direction="inline" justifyContent="space-between">
                                  <s-text type="strong">AOV</s-text>
                                  <s-text>Before: {eventObservedChange.beforeAOV !== null ? `$${eventObservedChange.beforeAOV.toFixed(2)}` : "n/a"}</s-text>
                                  <s-text>After: {eventObservedChange.afterAOV !== null ? `$${eventObservedChange.afterAOV.toFixed(2)}` : "n/a"}</s-text>
                                  <s-text type="strong">
                                    Δ {eventObservedChange.aovDelta !== null ? `${eventObservedChange.aovDelta >= 0 ? "+" : ""}$${eventObservedChange.aovDelta.toFixed(2)}` : "n/a"}
                                    {eventObservedChange.aovDeltaPct !== null && ` (${eventObservedChange.aovDeltaPct >= 0 ? "+" : ""}${eventObservedChange.aovDeltaPct.toFixed(1)}%)`}
                                  </s-text>
                                </s-stack>
                              </s-stack>
                            </s-box>

                            {eventObservedChange.recommendation && (
                              <s-box
                                id={`recommendation-box-${event.id}`}
                                padding="base"
                                background={eventObservedChange.recommendation.tone === "success" ? "success-subdued" : eventObservedChange.recommendation.tone === "critical" ? "critical-subdued" : "base"}
                                borderWidth="base"
                                borderColor={eventObservedChange.recommendation.tone === "success" ? "success" : eventObservedChange.recommendation.tone === "critical" ? "critical" : "base"}
                                borderRadius="base"
                              >
                                <s-stack id={`recommendation-stack-${event.id}`} gap="small">
                                  <s-stack id={`recommendation-header-${event.id}`} direction="inline" justifyContent="space-between" alignItems="center">
                                    <s-text type="strong">Recommendation</s-text>
                                    <s-badge tone={eventObservedChange.recommendation.tone}>
                                      {eventObservedChange.recommendation.confidence} confidence
                                    </s-badge>
                                  </s-stack>
                                  <s-text>{eventObservedChange.recommendation.text}</s-text>
                                  <s-stack id={`drivers-list-${event.id}`} gap="small">
                                    {eventObservedChange.recommendation.drivers.map((driver, idx) => (
                                      <s-text key={idx} color="subdued" type="subdued">
                                        • {driver}
                                      </s-text>
                                    ))}
                                  </s-stack>
                                  <s-text color="subdued" type="subdued">
                                    Early signal in compressed window; not causal proof.
                                  </s-text>
                                </s-stack>
                              </s-box>
                            )}
                          </>
                        )}
                      </s-stack>
                    )}
                  </s-stack>
                </s-box>
              );
            })}
          </s-stack>
        )}
      </s-section>

      <s-section id="metrics-section" heading="Metric buckets (10 min)">
        {metrics.length === 0 ? (
          <s-box
            id="empty-metrics"
            padding="large"
            background="base"
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-text alignment="center" color="subdued">
              No metrics yet. Press "Backfill" to populate metrics.
            </s-text>
          </s-box>
        ) : (
          <s-box
            id="metrics-table"
            padding="base"
            background="base"
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-stack id="metrics-list" gap="small">
              {metrics.map((metric) => {
                const aov = metric.orders > 0 ? metric.revenue / metric.orders : null;
                return (
                  <s-box
                    id={`metric-row-${metric.id}`}
                    key={metric.id}
                    padding="small"
                    background="subdued"
                    borderWidth="base"
                    borderColor="base"
                    borderRadius="base"
                  >
                    <s-stack id={`metric-row-stack-${metric.id}`} direction="inline" gap="base" justifyContent="space-between">
                      <s-text>{((metric.bucketAt instanceof Date) ? metric.bucketAt : new Date(metric.bucketAt)).toLocaleString()}</s-text>
                      <s-text>Revenue: ${metric.revenue.toFixed(2)}</s-text>
                      <s-text>Orders: {metric.orders}</s-text>
                      <s-text>AOV: {aov !== null ? `$${aov.toFixed(2)}` : "n/a"}</s-text>
                    </s-stack>
                  </s-box>
                );
              })}
            </s-stack>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};

