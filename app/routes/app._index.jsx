import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [events24h, events7d, recentChange, alertsActive, pixelEvents24h, shopConfig] =
    await Promise.all([
      prisma.change.count({ where: { shop, occurredAt: { gte: since24h } } }),
      prisma.change.count({ where: { shop, occurredAt: { gte: since7d } } }),
      prisma.change.findFirst({
        where: { shop },
        orderBy: { occurredAt: "desc" },
        select: { type: true, summary: true, occurredAt: true },
      }),
      prisma.alertRule.count({ where: { shop, enabled: true } }),
      prisma.pixelEvent.count({ where: { shop, occurredAt: { gte: since24h } } }),
      prisma.shopConfig.findUnique({ where: { shop } }),
    ]);

  return {
    shop,
    events24h,
    events7d,
    recentChange,
    alertsActive,
    pixelEvents24h,
    pixelActive: !!shopConfig?.pixelActivatedAt,
  };
};

export default function Home() {
  const {
    shop,
    events24h,
    events7d,
    recentChange,
    alertsActive,
    pixelEvents24h,
    pixelActive,
  } = useLoaderData();

  return (
    <s-page id="home-page" heading="LSP Analizer">
      <s-section id="home-intro" heading="What this app does">
        <s-box
          padding="base"
          background="base"
          borderWidth="base"
          borderColor="base"
          borderRadius="base"
        >
          <s-text>
            Every change you make to your store — publishing a theme, updating a
            price, restocking inventory — gets logged automatically. We then measure
            what happens to your sales, conversion, and orders right after, compare
            it against your store's normal pattern, and flag anything that looks off.
          </s-text>
        </s-box>
      </s-section>

      <s-section id="home-stats" heading="At a glance">
        <s-stack direction="inline" gap="base">
          <s-box
            padding="base"
            background="base"
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-stack gap="small">
              <s-text color="subdued" type="subdued">Events captured (24h)</s-text>
              <s-text type="strong" size="large">{events24h}</s-text>
              <s-text color="subdued" type="subdued">
                {events7d} in the last 7 days
              </s-text>
            </s-stack>
          </s-box>

          <s-box
            padding="base"
            background="base"
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-stack gap="small">
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-text color="subdued" type="subdued">Storefront pixel</s-text>
                <s-badge tone={pixelActive ? "success" : "warning"}>
                  {pixelActive ? "Active" : "Inactive"}
                </s-badge>
              </s-stack>
              <s-text type="strong" size="large">{pixelEvents24h}</s-text>
              <s-text color="subdued" type="subdued">
                customer events captured today
              </s-text>
            </s-stack>
          </s-box>

          <s-box
            padding="base"
            background="base"
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-stack gap="small">
              <s-text color="subdued" type="subdued">Active alerts</s-text>
              <s-text type="strong" size="large">{alertsActive}</s-text>
              <s-text color="subdued" type="subdued">
                rules currently watching your store
              </s-text>
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>

      {recentChange && (
        <s-section id="home-latest" heading="Latest change">
          <s-box
            padding="base"
            background="base"
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-stack direction="inline" justifyContent="space-between" alignItems="center">
              <s-stack gap="small">
                <s-text type="strong">{recentChange.summary}</s-text>
                <s-text color="subdued" type="subdued">
                  {new Date(recentChange.occurredAt).toLocaleString()}
                </s-text>
              </s-stack>
              <s-link href="/app/timeline">
                <s-button variant="secondary">Open Timeline</s-button>
              </s-link>
            </s-stack>
          </s-box>
        </s-section>
      )}

      <s-section id="home-nav" heading="Where to go next">
        <s-stack gap="base">
          <s-box
            padding="base"
            background="base"
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
              <s-stack gap="small">
                <s-text type="strong" size="medium">Timeline</s-text>
                <s-text color="subdued">
                  Every change in your store, newest first. Theme publishes, price
                  updates, stock moves, orders. Add your own notes for context.
                </s-text>
              </s-stack>
              <s-link href="/app/timeline">
                <s-button variant="primary">Open Timeline</s-button>
              </s-link>
            </s-stack>
          </s-box>

          <s-box
            padding="base"
            background="base"
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
              <s-stack gap="small">
                <s-text type="strong" size="medium">Analytics</s-text>
                <s-text color="subdued">
                  For any change, compare what happened after with your store's
                  normal pattern at the same time of day and day of week. See
                  conversion-rate impact for theme changes in near-realtime.
                </s-text>
              </s-stack>
              <s-link href="/app/analytics">
                <s-button variant="primary">Open Analytics</s-button>
              </s-link>
            </s-stack>
          </s-box>

          <s-box
            padding="base"
            background="base"
            borderWidth="base"
            borderColor="base"
            borderRadius="base"
          >
            <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
              <s-stack gap="small">
                <s-text type="strong" size="medium">Alerts</s-text>
                <s-text color="subdued">
                  Get an email when a change looks like it hurt your sales —
                  before you find out from a customer or a quiet day.
                </s-text>
              </s-stack>
              <s-link href="/app/alerts">
                <s-button variant="primary">Open Alerts</s-button>
              </s-link>
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>

      <s-section id="home-shop-info" heading="Connected store">
        <s-box
          padding="base"
          background="base"
          borderWidth="base"
          borderColor="base"
          borderRadius="base"
        >
          <s-text color="subdued">{shop}</s-text>
        </s-box>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useLoaderData());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
