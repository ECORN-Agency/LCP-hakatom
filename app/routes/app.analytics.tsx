import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useRevalidator, type HeadersFunction } from "react-router";
import { useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getBucketMetrics, backfillLastNMinutes, normalizeTo10MinBucketUTC } from "../models/metricsBuckets.server";
import { buildRecommendation } from "../models/recommendation";

export const loader = async ({ request }: { request: Request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  // Default data range is 24h — covers a 24h symmetric comparison window
  // for any event that happened in the last day.
  const minutes = parseInt(url.searchParams.get("minutes") || "1440", 10);

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

export const action = async ({ request }: { request: Request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "backfill") {
    const minutes = parseInt(String(formData.get("minutes") || "120"), 10);
    const result = await backfillLastNMinutes(admin, session.shop, minutes);
    if (result.locked) {
      return {
        ok: false,
        locked: true,
        error: "Another backfill is already running for this shop. Wait a bit and try again.",
      };
    }
    return { ok: true, anyPartial: result.anyPartial, updatedBuckets: result.updatedBuckets };
  }

  return { ok: false };
};

// Pull event-type-specific context out of the raw Change row before handing
// it to the recommendation engine. Keep this pure so it can move into
// app/models/ later if other surfaces need it.
function extractEventContext(event: any) {
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
  const { metrics, events, minutes } = useLoaderData() as { metrics: any[]; events: any[]; minutes: number };
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedEventId, setSelectedEventId] = useState(null);
  const [anyPartial, setAnyPartial] = useState(false);

  // Comparison window (per-event before/after width) is independent of the
  // data-range loader param. Persisted in the URL as ?compare=<minutes>.
  // Default 24h — first window where the signal stops being dominated by
  // hour-of-day noise. 10m / 1h are still reachable via URL for smoke tests.
  const compareMinutes = parseInt(searchParams.get("compare") || "1440", 10);

  // Category-level filter. All categories visible by default; user toggles
  // individual chips off. Stored client-side — not in URL, since it's quick
  // exploration state and resetting on reload is fine.
  const ALL_CATEGORIES = ["theme", "products", "orders", "collections", "manual"];
  const [enabledCategories, setEnabledCategories] = useState(new Set(ALL_CATEGORIES));
  // Quick time filter inside the loaded data range. "all" means no extra filter.
  const [timeFilter, setTimeFilter] = useState("all");
  // Free-text search over Change.summary.
  const [searchText, setSearchText] = useState("");

  // Multi-select chips: each category toggles independently. The "All" button
  // acts as a reset — clicking it switches everything back on. Default state
  // has all categories enabled.
  const toggleCategory = (cat: string) => {
    setEnabledCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const selectAllCategories = () => setEnabledCategories(new Set(ALL_CATEGORIES));

  const isAllCategoriesSelected = enabledCategories.size === ALL_CATEGORIES.length;

  const categoryOfType = (type: string) => {
    if (!type) return "manual";
    if (type.startsWith("theme")) return "theme";
    if (type.startsWith("products")) return "products";
    if (type.startsWith("orders")) return "orders";
    if (type.startsWith("collections")) return "collections";
    return "manual";
  };

  const isInTimeFilter = (eventDate: string | Date) => {
    if (timeFilter === "all") return true;
    const now = Date.now();
    const t = new Date(eventDate).getTime();
    if (timeFilter === "1h") return t >= now - 60 * 60 * 1000;
    if (timeFilter === "6h") return t >= now - 6 * 60 * 60 * 1000;
    if (timeFilter === "today") {
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      return t >= startOfToday.getTime();
    }
    return true;
  };

  const trimmedSearch = searchText.trim().toLowerCase();
  const filteredEvents = events.filter((e) => {
    if (!enabledCategories.has(categoryOfType(e.type))) return false;
    if (!isInTimeFilter(new Date(e.occurredAt))) return false;
    if (trimmedSearch && !(e.summary || "").toLowerCase().includes(trimmedSearch)) return false;
    return true;
  });

  const selectedEvent = events.find((e) => e.id === selectedEventId);

  const handleBackfill = () => {
    fetcher.submit(
      { intent: "backfill", minutes: minutes.toString() },
      { method: "POST" }
    );
  };

  const handleCompareChange = (newCompare: number) => {
    const newParams = new URLSearchParams(searchParams);
    newParams.set("compare", newCompare.toString());
    setSearchParams(newParams);
  };

  const formatRangeLabel = (mins: number) => {
    if (mins >= 1440) return `${mins / 1440}d`;
    if (mins >= 60) return `${mins / 60}h`;
    return `${mins}m`;
  };

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      if (fetcher.data.anyPartial) {
        setAnyPartial(true);
      }
      revalidator.revalidate();
    }
  }, [fetcher.state, fetcher.data, revalidator]);

  // Rolling baseline: fetched lazily for the currently selected event.
  // Re-fetches when the user picks a different event or changes the
  // comparison window.
  const baselineFetcher = useFetcher();

  useEffect(() => {
    if (!selectedEventId) return;
    const ev = events.find((e) => e.id === selectedEventId);
    if (!ev) return;
    const params = new URLSearchParams({
      eventTime: new Date(ev.occurredAt).toISOString(),
      windowMinutes: compareMinutes.toString(),
      lookbackWeeks: "4",
    });
    baselineFetcher.load(`/api/baseline?${params.toString()}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEventId, compareMinutes]);

  const baselineData =
    baselineFetcher.data && !baselineFetcher.data.error ? baselineFetcher.data : null;

  const handleMinutesChange = (newMinutes: number) => {
    const newParams = new URLSearchParams(searchParams);
    newParams.set("minutes", newMinutes.toString());
    setSearchParams(newParams);
  };

  const getTypeBadge = (type: string) => {
    const typeMap: Record<string, string> = {
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

  const getTypeTone = (type: string) => {
    if (type.startsWith("theme_")) return "info";
    if (type.startsWith("orders_")) return "success";
    if (type.startsWith("products_")) return "warning";
    if (type.startsWith("collections_")) return "caution";
    return "neutral";
  };

  function normalizeTo10MinBucketUTC(date: Date) {
    const d = new Date(date);
    const minutes = d.getUTCMinutes();
    const roundedMinutes = Math.floor(minutes / 10) * 10;
    d.setUTCMinutes(roundedMinutes, 0, 0);
    return d;
  }

  const calculateObservedChange = (event: any) => {
    if (!event) return null;

    // Use the URL-controlled comparison window (minutes), not a hardcoded 10.
    const W = compareMinutes;
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

    // Each MetricBucket spans 10 minutes; expectedBuckets is the count we'd
    // see if the entire window were covered.
    const expectedBuckets = Math.max(1, Math.round(W / 10));

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
    const aovDeltaPct = beforeAOV !== null && beforeAOV > 0 && afterAOV !== null ? ((afterAOV - beforeAOV) / beforeAOV) * 100 : null;

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
      windowMinutes: compareMinutes,
      revenueDeltaPct: observedChangeData.revenueDeltaPct,
      ordersDeltaPct: observedChangeData.ordersDeltaPct,
      aovDeltaPct: observedChangeData.aovDeltaPct,
      conversionDeltaPct: baselineData?.funnel?.deltaPct?.conversionRate ?? null,
      pageViewsDeltaPct: baselineData?.funnel?.deltaPct?.pageViews ?? null,
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
            <s-stack id="range-row" gap="small">
              <s-text type="strong">Data range (events + metrics shown):</s-text>
              <s-stack id="range-selector" direction="inline" gap="small">
                {[360, 1440, 10080].map((mins) => (
                  <s-button
                    key={`range-${mins}`}
                    variant={minutes === mins ? "primary" : "secondary"}
                    onClick={() => handleMinutesChange(mins)}
                  >
                    {formatRangeLabel(mins)}
                  </s-button>
                ))}
              </s-stack>
            </s-stack>

            <s-stack id="compare-row" gap="small">
              <s-text type="strong">Comparison window (before / after each event):</s-text>
              <s-stack id="compare-selector" direction="inline" gap="small">
                {[60, 360, 1440, 10080].map((mins) => (
                  <s-button
                    key={`compare-${mins}`}
                    variant={compareMinutes === mins ? "primary" : "secondary"}
                    onClick={() => handleCompareChange(mins)}
                  >
                    {formatRangeLabel(mins)}
                  </s-button>
                ))}
              </s-stack>
              <s-text color="subdued">
                24h is the recommended default — smooths hour-of-day noise. Pick 7d
                for stores with low daily traffic (smooths day-of-week patterns too).
              </s-text>
              {compareMinutes >= 10080 && (
                <s-badge tone="warning">
                  7-day comparisons need a lot of historical data — first runs may take a minute or show partial coverage.
                </s-badge>
              )}
              {compareMinutes * 2 > minutes && (
                <s-text color="subdued">
                  Heads up: comparison window is wider than the data range, so coverage
                  will be capped. Bump the data range above for a fairer comparison.
                </s-text>
              )}
            </s-stack>

            <s-button
              id="backfill-button"
              variant="primary"
              onClick={handleBackfill}
              loading={fetcher.state !== "idle"}
            >
              Backfill last {formatRangeLabel(minutes)}
            </s-button>
            <s-text color="subdued">
              Results are early signals, not causal proof. Wider windows = stronger signal but more chance of overlapping events.
            </s-text>
            {anyPartial && (
              <s-badge tone="warning">Partial data (at least one bucket hit the backfill cap)</s-badge>
            )}
            {fetcher.data?.locked && (
              <s-badge tone="warning">{fetcher.data.error}</s-badge>
            )}
          </s-stack>
        </s-box>
      </s-section>

      <s-section id="events-section" heading="Events">
        <s-box
          id="events-filters"
          padding="base"
          background="base"
          borderWidth="base"
          borderColor="base"
          borderRadius="base"
        >
          <s-stack id="events-filters-stack" gap="small">
            <s-stack id="category-filters" direction="inline" gap="small" alignItems="center">
              <s-text type="strong">Type:</s-text>
              <s-button
                key="cat-all"
                variant={isAllCategoriesSelected ? "primary" : "secondary"}
                onClick={selectAllCategories}
              >
                All
              </s-button>
              {ALL_CATEGORIES.map((cat) => (
                <s-button
                  key={`cat-${cat}`}
                  variant={enabledCategories.has(cat) ? "primary" : "secondary"}
                  onClick={() => toggleCategory(cat)}
                >
                  {cat[0].toUpperCase() + cat.slice(1)}
                </s-button>
              ))}
            </s-stack>

            <s-stack id="time-filters" direction="inline" gap="small" alignItems="center">
              <s-text type="strong">When:</s-text>
              {[
                { value: "all", label: "All loaded" },
                { value: "1h", label: "Last 1h" },
                { value: "6h", label: "Last 6h" },
                { value: "today", label: "Today" },
              ].map((opt) => (
                <s-button
                  key={`time-${opt.value}`}
                  variant={timeFilter === opt.value ? "primary" : "secondary"}
                  onClick={() => setTimeFilter(opt.value)}
                >
                  {opt.label}
                </s-button>
              ))}
            </s-stack>

            <s-text-field
              id="events-search"
              label="Search summary"
              value={searchText}
              onInput={(e) => setSearchText(e.currentTarget.value)}
              placeholder="e.g. price, theme, snowboard…"
            />

            <s-text color="subdued">
              Showing {filteredEvents.length} of {events.length} events.
              {trimmedSearch || timeFilter !== "all" || !isAllCategoriesSelected
                ? " Filters active."
                : ""}
            </s-text>
          </s-stack>
        </s-box>

        {filteredEvents.length === 0 ? (
          <s-box
            id="empty-events"
            padding="large"
            background="base"
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-text color="subdued">
              {events.length === 0
                ? "No events in this range."
                : "No events match the current filters. Loosen them above."}
            </s-text>
          </s-box>
        ) : (
          <s-stack id="events-list" gap="small">
            {filteredEvents.map((event) => {
              const isSelected = selectedEventId === event.id;
              const eventObservedChangeData = isSelected ? calculateObservedChange(event) : null;
              // For the selected event we also have pixel funnel data from the
              // baseline API call — pass it into buildRecommendation so theme
              // events can react to conversion-rate drops directly.
              const funnelDelta = isSelected ? baselineData?.funnel?.deltaPct : null;

              const eventObservedChange: any = eventObservedChangeData ? {
                ...eventObservedChangeData,
                recommendation: eventObservedChangeData.waiting ? null : buildRecommendation({
                  eventType: event.type,
                  eventContext: extractEventContext(event),
                  windowMinutes: compareMinutes,
                  revenueDeltaPct: eventObservedChangeData.revenueDeltaPct,
                  ordersDeltaPct: eventObservedChangeData.ordersDeltaPct,
                  aovDeltaPct: eventObservedChangeData.aovDeltaPct,
                  conversionDeltaPct: funnelDelta?.conversionRate ?? null,
                  pageViewsDeltaPct: funnelDelta?.pageViews ?? null,
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
                      <s-stack id={`event-row-main-${event.id}`} direction="inline" gap="base" alignItems="center" {...{ style: { flex: "1 1 0%", minWidth: 0, overflow: "hidden" } }}>
                        <s-text color="subdued" {...{ style: { whiteSpace: "nowrap", flexShrink: 0 } }}>
                          {new Date(event.occurredAt).toLocaleString()}
                        </s-text>
                        <s-badge tone={getTypeTone(event.type)} {...{ style: { whiteSpace: "nowrap", flexShrink: 0 } }}>
                          {getTypeBadge(event.type)}
                        </s-badge>
                        <s-text {...{ style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: "1 1 0%" } }}>
                          {event.summary}
                        </s-text>
                      </s-stack>
                      <s-button
                        variant="secondary"
                        onClick={() => setSelectedEventId(isSelected ? null : event.id)}
                        {...{ style: { flex: "0 0 auto" } }}
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
                              <s-badge tone="warning">Partial data — one bucket had more orders than we could pull in time</s-badge>
                            )}

                            <s-box
                              id={`comparison-table-${event.id}`}
                              padding="base"
                              background="subdued"
                              borderWidth="base"
                              borderColor="base"
                              borderRadius="base"
                            >
                              <s-stack id={`comparison-stack-${event.id}`} gap="small">
                                {[
                                  {
                                    label: "Revenue",
                                    before: `$${eventObservedChange.beforeRevenue.toFixed(2)}`,
                                    after: `$${eventObservedChange.afterRevenue.toFixed(2)}`,
                                    delta:
                                      `Δ ${eventObservedChange.revenueDelta >= 0 ? "+" : ""}$${eventObservedChange.revenueDelta.toFixed(2)}` +
                                      (eventObservedChange.revenueDeltaPct !== null
                                        ? ` (${eventObservedChange.revenueDeltaPct >= 0 ? "+" : ""}${eventObservedChange.revenueDeltaPct.toFixed(1)}%)`
                                        : ""),
                                  },
                                  {
                                    label: "Orders",
                                    before: String(eventObservedChange.beforeOrders),
                                    after: String(eventObservedChange.afterOrders),
                                    delta:
                                      `Δ ${eventObservedChange.ordersDelta >= 0 ? "+" : ""}${eventObservedChange.ordersDelta}` +
                                      (eventObservedChange.ordersDeltaPct !== null
                                        ? ` (${eventObservedChange.ordersDeltaPct >= 0 ? "+" : ""}${eventObservedChange.ordersDeltaPct.toFixed(1)}%)`
                                        : ""),
                                  },
                                  {
                                    label: "AOV",
                                    before:
                                      eventObservedChange.beforeAOV !== null
                                        ? `$${eventObservedChange.beforeAOV.toFixed(2)}`
                                        : "n/a",
                                    after:
                                      eventObservedChange.afterAOV !== null
                                        ? `$${eventObservedChange.afterAOV.toFixed(2)}`
                                        : "n/a",
                                    delta:
                                      eventObservedChange.aovDelta !== null
                                        ? `Δ ${eventObservedChange.aovDelta >= 0 ? "+" : ""}$${eventObservedChange.aovDelta.toFixed(2)}` +
                                          (eventObservedChange.aovDeltaPct !== null
                                            ? ` (${eventObservedChange.aovDeltaPct >= 0 ? "+" : ""}${eventObservedChange.aovDeltaPct.toFixed(1)}%)`
                                            : "")
                                        : "Δ n/a",
                                  },
                                ].map((row) => (
                                  <div
                                    key={`${event.id}-${row.label}`}
                                    style={{
                                      display: "grid",
                                      gridTemplateColumns: "1.2fr 1fr 1fr 1.5fr",
                                      gap: "var(--p-space-3, 12px)",
                                      alignItems: "center",
                                    }}
                                  >
                                    <s-text type="strong">{row.label}</s-text>
                                    <s-text color="subdued">Before: {row.before}</s-text>
                                    <s-text color="subdued">After: {row.after}</s-text>
                                    <div style={{ textAlign: "right" }}>
                                      <s-text type="strong">{row.delta}</s-text>
                                    </div>
                                  </div>
                                ))}
                              </s-stack>
                            </s-box>

                            {/* Storefront funnel panel — pixel-driven near-realtime signal */}
                            {isSelected && baselineData?.funnel && (() => {
                              const f = baselineData.funnel;
                              const hasAnyTraffic =
                                f.before.pageViews > 0 || f.after.pageViews > 0;
                              const fmtPct = (v: number | null) =>
                                v === null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
                              const fmtRate = (v: number | null) =>
                                v === null ? "n/a" : `${(v * 100).toFixed(2)}%`;
                              return (
                                <s-box
                                  id={`funnel-box-${event.id}`}
                                  padding="base"
                                  background="base"
                                  borderWidth="base"
                                  borderColor="base"
                                  borderRadius="base"
                                >
                                  <s-stack gap="small">
                                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                                      <s-text type="strong">Storefront funnel (Web Pixel)</s-text>
                                      {hasAnyTraffic ? (
                                        <s-badge tone="success">Live signal</s-badge>
                                      ) : (
                                        <s-badge tone="warning">No pixel traffic in window</s-badge>
                                      )}
                                    </s-stack>
                                    {hasAnyTraffic ? (
                                      <s-stack gap="small">
                                        {[
                                          { label: "Page views", before: f.before.pageViews, after: f.after.pageViews, pct: f.deltaPct.pageViews },
                                          { label: "Cart adds", before: f.before.cartAdds, after: f.after.cartAdds, pct: f.deltaPct.cartAdds },
                                          { label: "Checkouts started", before: f.before.checkoutsStarted, after: f.after.checkoutsStarted, pct: f.deltaPct.checkoutsStarted },
                                          { label: "Conversion rate", before: fmtRate(f.before.conversionRate), after: fmtRate(f.after.conversionRate), pct: f.deltaPct.conversionRate },
                                        ].map((row) => (
                                          <div
                                            key={row.label}
                                            style={{
                                              display: "grid",
                                              gridTemplateColumns: "1.6fr 1fr 1fr 0.9fr",
                                              gap: "var(--p-space-3, 12px)",
                                              alignItems: "center",
                                            }}
                                          >
                                            <s-text type="strong">{row.label}</s-text>
                                            <s-text color="subdued">Before: {row.before}</s-text>
                                            <s-text color="subdued">After: {row.after}</s-text>
                                            <div style={{ textAlign: "right" }}>
                                              <s-text type="strong">{fmtPct(row.pct)}</s-text>
                                            </div>
                                          </div>
                                        ))}
                                        <s-text color="subdued">
                                          Pixel data arrives in seconds vs orders that lag by minutes-to-hours.
                                          For theme changes, conversion rate Δ is the earliest meaningful signal.
                                        </s-text>
                                      </s-stack>
                                    ) : (
                                      <s-text color="subdued">
                                        No storefront pixel events in this window. Either no customer traffic
                                        in the comparison range, or the pixel isn't active yet.
                                      </s-text>
                                    )}
                                  </s-stack>
                                </s-box>
                              );
                            })()}

                            {/* Rolling baseline panel — only rendered for the currently selected event */}
                            {isSelected && (
                              <s-box
                                id={`baseline-box-${event.id}`}
                                padding="base"
                                background="base"
                                borderWidth="base"
                                borderColor="base"
                                borderRadius="base"
                              >
                                <s-stack id={`baseline-stack-${event.id}`} gap="small">
                                  <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                                    <s-text type="strong">Rolling baseline (same slot, last 4 weeks)</s-text>
                                    {baselineFetcher.state !== "idle" ? (
                                      <s-badge tone="info">Loading…</s-badge>
                                    ) : baselineData ? (
                                      <s-badge tone={baselineData.baseline.weeksWithData >= 3 ? "success" : baselineData.baseline.weeksWithData >= 1 ? "caution" : "warning"}>
                                        {baselineData.baseline.weeksWithData}/{baselineData.baseline.totalWeeks} weeks of history
                                      </s-badge>
                                    ) : (
                                      <s-badge tone="warning">No baseline yet</s-badge>
                                    )}
                                  </s-stack>

                                  {baselineFetcher.state === "idle" && baselineData && baselineData.baseline.weeksWithData === 0 && (
                                    <s-text color="subdued">
                                      No buckets in the same time-of-day × day-of-week slot over the last 4 weeks.
                                      Baseline will improve as the app accumulates history (or once you backfill further back).
                                    </s-text>
                                  )}

                                  {baselineFetcher.state === "idle" && baselineData && baselineData.baseline.weeksWithData > 0 && (
                                    <s-stack gap="small">
                                      {[
                                        {
                                          label: "Revenue",
                                          actual: `$${baselineData.actual.actualRevenue.toFixed(2)}`,
                                          expected: `$${baselineData.baseline.expectedRevenue.toFixed(2)}`,
                                          delta:
                                            baselineData.deltaPct.revenue !== null
                                              ? `Δ ${baselineData.deltaPct.revenue >= 0 ? "+" : ""}${baselineData.deltaPct.revenue.toFixed(1)}%`
                                              : "Δ n/a",
                                        },
                                        {
                                          label: "Orders",
                                          actual: String(baselineData.actual.actualOrders),
                                          expected: baselineData.baseline.expectedOrders.toFixed(1),
                                          delta:
                                            baselineData.deltaPct.orders !== null
                                              ? `Δ ${baselineData.deltaPct.orders >= 0 ? "+" : ""}${baselineData.deltaPct.orders.toFixed(1)}%`
                                              : "Δ n/a",
                                        },
                                        {
                                          label: "AOV",
                                          actual:
                                            baselineData.actual.actualAOV !== null
                                              ? `$${baselineData.actual.actualAOV.toFixed(2)}`
                                              : "n/a",
                                          expected:
                                            baselineData.baseline.expectedAOV !== null
                                              ? `$${baselineData.baseline.expectedAOV.toFixed(2)}`
                                              : "n/a",
                                          delta:
                                            baselineData.deltaPct.aov !== null
                                              ? `Δ ${baselineData.deltaPct.aov >= 0 ? "+" : ""}${baselineData.deltaPct.aov.toFixed(1)}%`
                                              : "Δ n/a",
                                        },
                                      ].map((row) => (
                                        <div
                                          key={`baseline-${event.id}-${row.label}`}
                                          style={{
                                            display: "grid",
                                            gridTemplateColumns: "1.2fr 1.2fr 1.2fr 1fr",
                                            gap: "var(--p-space-3, 12px)",
                                            alignItems: "center",
                                          }}
                                        >
                                          <s-text type="strong">{row.label}</s-text>
                                          <s-text color="subdued">Actual: {row.actual}</s-text>
                                          <s-text color="subdued">Expected: {row.expected}</s-text>
                                          <div style={{ textAlign: "right" }}>
                                            <s-text type="strong">{row.delta}</s-text>
                                          </div>
                                        </div>
                                      ))}
                                      <s-text color="subdued">
                                        Expected = average of the same wall-clock window across the prior {baselineData.baseline.weeksWithData} weeks.
                                        Smooths out hour-of-day and day-of-week seasonality.
                                      </s-text>
                                    </s-stack>
                                  )}
                                </s-stack>
                              </s-box>
                            )}

                            {eventObservedChange.recommendation && (
                              <s-box
                                id={`recommendation-box-${event.id}`}
                                padding="base"
                                background={(eventObservedChange.recommendation.tone === "success" ? "success-subdued" : eventObservedChange.recommendation.tone === "critical" ? "critical-subdued" : "base") as any}
                                borderWidth="base"
                                borderColor={(eventObservedChange.recommendation.tone === "success" ? "success" : eventObservedChange.recommendation.tone === "critical" ? "critical" : "base") as any}
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
                                    {eventObservedChange.recommendation.drivers.map((driver: string, idx: number) => (
                                      <s-text key={idx} color="subdued">
                                        • {driver}
                                      </s-text>
                                    ))}
                                  </s-stack>
                                  <s-text color="subdued">
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
            <s-text color="subdued">
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

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

