import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useRevalidator, type HeadersFunction } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: { request: Request }) => {
  const { session } = await authenticate.admin(request);

  const changes = await prisma.change.findMany({
    where: { shop: session.shop },
    orderBy: { occurredAt: "desc" },
    take: 50,
  });

  return { changes };
};

export default function Timeline() {
  // payload is free-form JSON per change type, so we read it untyped here.
  const { changes } = useLoaderData() as { changes: any[] };
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const [expandedRows, setExpandedRows] = useState(new Set());
  const [summaryText, setSummaryText] = useState("");

  const handleSubmit = () => {
    if (!summaryText.trim()) return;

    fetcher.submit(
      { summary: summaryText.trim() },
      { method: "POST", action: "/api/changes/manual", encType: "application/json" }
    );
    setSummaryText("");
  };

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      revalidator.revalidate();
      shopify.toast.show("Event created successfully");
      setSummaryText("");
    }
  }, [fetcher.state, fetcher.data, revalidator, shopify]);

  const toggleRow = (changeId: string) => {
    setExpandedRows((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(changeId)) {
        newSet.delete(changeId);
      } else {
        newSet.add(changeId);
      }
      return newSet;
    });
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

  const getTypeTone = (
    type: string,
  ): "info" | "success" | "warning" | "caution" | "neutral" => {
    if (type.startsWith("theme_")) return "info";
    if (type.startsWith("orders_")) return "success";
    if (type.startsWith("products_")) return "warning";
    if (type.startsWith("collections_")) return "caution";
    return "neutral";
  };

  return (
    <s-page id="timeline-page" heading="Timeline">
      <s-section id="manual-event-section" heading="Create manual event">
        <s-box
          id="manual-event-card"
          padding="base"
          background="base"
          borderWidth="base"
          borderColor="base"
          borderRadius="base"
        >
          <s-stack id="manual-event-stack" gap="base">
            <s-text-field
              id="manual-event-input"
              label="Event Summary"
              value={summaryText}
              onInput={(e) => setSummaryText(e.currentTarget.value)}
              placeholder="Enter a description of the change (max 200 characters)"
              maxLength={200}
            />
            <s-button
              id="manual-event-button"
              variant="primary"
              onClick={handleSubmit}
              disabled={!summaryText.trim()}
              loading={fetcher.state !== "idle"}
            >
              Create Event
            </s-button>
          </s-stack>
        </s-box>
      </s-section>

      <s-section id="events-section" heading="Events">
        {changes.length === 0 ? (
          <s-box
            id="empty-state"
            padding="large"
            background="base"
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-text color="subdued">
              No events yet. Publish a theme or add a manual event to get started.
            </s-text>
          </s-box>
        ) : (
          <s-box
            id="events-table-container"
            padding="base"
            background="base"
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-stack id="events-list" gap="small">
              {changes.map((change) => {
                const isExpanded = expandedRows.has(change.id);
                const occurredAt = new Date(change.occurredAt);

                return (
                  <s-box
                    id={`event-row-${change.id}`}
                    key={change.id}
                    padding="base"
                    background="base"
                    borderWidth="base"
                    borderColor="base"
                    borderRadius="base"
                  >
                    <s-stack id={`event-row-stack-${change.id}`} gap="base">
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--p-space-4)", width: "100%" }}>
                        <s-stack id={`event-row-main-${change.id}`} direction="inline" gap="base" alignItems="center" {...{ style: { flex: "1 1 0%", minWidth: 0, overflow: "hidden" } }}>
                          <s-text id={`event-time-${change.id}`} color="subdued" {...{ style: { whiteSpace: "nowrap", flexShrink: 0 } }}>
                            {occurredAt.toLocaleString("en-US", {
                              year: "numeric",
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </s-text>
                          <s-badge
                            id={`event-type-${change.id}`}
                            tone={getTypeTone(change.type)}
                            {...{ style: { whiteSpace: "nowrap", flexShrink: 0 } }}
                          >
                            {getTypeBadge(change.type)}
                          </s-badge>
                          <s-text id={`event-summary-${change.id}`} type="strong" {...{ style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: "1 1 0%" } }}>
                            {change.summary}
                          </s-text>
                        </s-stack>
                        <s-button
                          id={`toggle-details-${change.id}`}
                          variant="secondary"
                          onClick={() => toggleRow(change.id)}
                          {...{ style: { flex: "0 0 auto" } }}
                        >
                          <span style={{ whiteSpace: "nowrap" }}>
                            {isExpanded ? "Hide details" : "Details"}
                          </span>
                        </s-button>
                      </div>

                      {isExpanded && (
                        <s-stack id={`event-details-${change.id}`} gap="base">
                          <s-divider id={`event-divider-${change.id}`} />
                          
                          {change.entityId && (
                            <s-stack id={`entity-id-${change.id}`} gap="small">
                              <s-text type="strong">Entity ID:</s-text>
                              <s-text color="subdued">{change.entityId}</s-text>
                            </s-stack>
                          )}

                          {change.type === "products_update" && (
                            <s-stack id={`product-details-${change.id}`} gap="small">
                              <s-text type="strong">Product Details:</s-text>
                              {change.payload?.changeDetails?.productTitle && (
                                <s-text>Title: {change.payload.changeDetails.productTitle}</s-text>
                              )}
                              {change.payload?.changeDetails?.productId && (
                                <s-text>Product ID: {change.payload.changeDetails.productId}</s-text>
                              )}
                              {change.payload?.changeDetails?.priceChanges && change.payload.changeDetails.priceChanges.length > 0 && (
                                <s-stack gap="small">
                                  <s-text type="strong">Price Changes:</s-text>
                                  {change.payload.changeDetails.priceChanges.map((pc: any, idx: number) => (
                                    <s-text key={idx} color="subdued">
                                      • {pc.variantTitle}: ${pc.oldPrice} → ${pc.newPrice}
                                      {pc.variantId && ` (Variant ID: ${pc.variantId})`}
                                    </s-text>
                                  ))}
                                </s-stack>
                              )}
                              {change.payload?.changeDetails?.variants && change.payload.changeDetails.variants.length > 0 && !change.payload.changeDetails.priceChanges && (
                                <s-stack gap="small">
                                  <s-text type="strong">Variants:</s-text>
                                  {change.payload.changeDetails.variants.map((v: any, idx: number) => (
                                    <s-text key={idx} color="subdued">
                                      • {v.variantTitle}: ${v.price || "N/A"}
                                      {v.variantId && ` (ID: ${v.variantId})`}
                                    </s-text>
                                  ))}
                                </s-stack>
                              )}
                            </s-stack>
                          )}

                          {change.type === "products_create" && (
                            <s-stack id={`product-create-details-${change.id}`} gap="small">
                              <s-text type="strong">Product Details:</s-text>
                              {change.payload?.title && (
                                <s-text>Title: {change.payload.title}</s-text>
                              )}
                              {change.payload?.id && (
                                <s-text>Product ID: {change.payload.id}</s-text>
                              )}
                              {change.payload?.handle && (
                                <s-text>Handle: {change.payload.handle}</s-text>
                              )}
                              {change.payload?.vendor && (
                                <s-text>Vendor: {change.payload.vendor}</s-text>
                              )}
                            </s-stack>
                          )}

                          {change.type === "products_delete" && (
                            <s-stack id={`product-delete-details-${change.id}`} gap="small">
                              <s-text type="strong">Deleted Product:</s-text>
                              {change.payload?.title && (
                                <s-text>Title: {change.payload.title}</s-text>
                              )}
                              {change.payload?.id && (
                                <s-text>Product ID: {change.payload.id}</s-text>
                              )}
                            </s-stack>
                          )}

                          {(change.type === "orders_create" || change.type === "orders_updated") && (
                            <s-stack id={`order-details-${change.id}`} gap="small">
                              <s-text type="strong">Order Details:</s-text>
                              {change.payload?.name && (
                                <s-text>Order Name: {change.payload.name}</s-text>
                              )}
                              {change.payload?.id && (
                                <s-text>Order ID: {change.payload.id}</s-text>
                              )}
                              {change.payload?.total_price && (
                                <s-text>Total: ${change.payload.total_price}</s-text>
                              )}
                              {change.payload?.financial_status && (
                                <s-text>Financial Status: {change.payload.financial_status}</s-text>
                              )}
                              {change.payload?.fulfillment_status && (
                                <s-text>Fulfillment Status: {change.payload.fulfillment_status}</s-text>
                              )}
                              {change.payload?.line_items && change.payload.line_items.length > 0 && (
                                <s-stack gap="small">
                                  <s-text type="strong">Line Items ({change.payload.line_items.length}):</s-text>
                                  {change.payload.line_items.slice(0, 5).map((item: any, idx: number) => (
                                    <s-text key={idx} color="subdued">
                                      • {item.title || item.name || "Unknown"} x{item.quantity || 1} - ${item.price || "0.00"}
                                    </s-text>
                                  ))}
                                  {change.payload.line_items.length > 5 && (
                                    <s-text color="subdued">... and {change.payload.line_items.length - 5} more</s-text>
                                  )}
                                </s-stack>
                              )}
                            </s-stack>
                          )}

                          {(change.type === "collections_create" || change.type === "collections_update" || change.type === "collections_delete") && (
                            <s-stack id={`collection-details-${change.id}`} gap="small">
                              <s-text type="strong">Collection Details:</s-text>
                              {change.payload?.title && (
                                <s-text>Title: {change.payload.title}</s-text>
                              )}
                              {change.payload?.id && (
                                <s-text>Collection ID: {change.payload.id}</s-text>
                              )}
                              {change.payload?.handle && (
                                <s-text>Handle: {change.payload.handle}</s-text>
                              )}
                            </s-stack>
                          )}

                          {(change.type === "theme_published" || change.type === "theme_switched" || change.type === "theme_files_updated") && (
                            <s-stack id={`theme-details-${change.id}`} gap="small">
                              <s-text type="strong">Theme Details:</s-text>
                              {change.payload?.name && (
                                <s-text>Name: {change.payload.name}</s-text>
                              )}
                              {change.payload?.id && (
                                <s-text>Theme ID: {change.payload.id}</s-text>
                              )}
                              {change.payload?.role && (
                                <s-text>Role: {change.payload.role}</s-text>
                              )}
                            </s-stack>
                          )}

                          {change.type === "manual" && (
                            <s-stack id={`manual-details-${change.id}`} gap="small">
                              <s-text type="strong">Manual Event:</s-text>
                              <s-text color="subdued">This event was created manually by the user.</s-text>
                            </s-stack>
                          )}

                          <s-divider id={`event-divider-bottom-${change.id}`} />
                          <s-stack id={`event-meta-${change.id}`} gap="small">
                            <s-text type="strong">Metadata:</s-text>
                            <s-text color="subdued">Occurred At: {occurredAt.toLocaleString("en-US", {
                              year: "numeric",
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                              timeZoneName: "short"
                            })}</s-text>
                            {change.receivedAt && (
                              <s-text color="subdued">Received At: {new Date(change.receivedAt).toLocaleString("en-US", {
                                year: "numeric",
                                month: "2-digit",
                                day: "2-digit",
                                hour: "2-digit",
                                minute: "2-digit",
                                second: "2-digit",
                                timeZoneName: "short"
                              })}</s-text>
                            )}
                            {change.entityType && (
                              <s-text color="subdued">Entity Type: {change.entityType}</s-text>
                            )}
                          </s-stack>
                        </s-stack>
                      )}
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

