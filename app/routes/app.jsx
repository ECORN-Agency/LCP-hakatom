import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import { ensurePixelActivated } from "../models/pixelActivation.server";
import { logger } from "../logger.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  // Idempotently activate the storefront Web Pixel on first app open per shop.
  // The function early-exits if ShopConfig.pixelActivatedAt is already set,
  // so this only costs one Prisma query on subsequent loads.
  await ensurePixelActivated({ shop: session.shop, admin }).catch((err) => {
    logger.error({ err, shop: session.shop }, "pixel activation in app loader failed");
  });

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <ui-nav-menu>
        <s-link href="/app/timeline">Timeline</s-link>
        <s-link href="/app/analytics">Analytics</s-link>
        <s-link href="/app/alerts">Alerts</s-link>
      </ui-nav-menu>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
