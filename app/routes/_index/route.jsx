import { redirect } from "react-router";

// Root route. ALWAYS bounces into /app/.
//
// History: this file used to render a marketing landing page when there were
// no Shopify embed parameters. That broke the embedded experience because
// App Bridge does client-side routing inside the iframe — when a merchant
// clicked the app name in the sidebar after being on a sub-tab, App Bridge
// navigated to "/" without shop/host params, our conditional redirect
// didn't fire, and the public landing rendered inside the embedded iframe.
//
// Fix: unconditional redirect. Param-less hits (direct typing, App Store
// install entry) fall through to /app/, which handles its own auth flow.
// The marketing copy is preserved at /install for explicit link-outs.

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  throw redirect(`/app?${url.searchParams.toString()}`, {
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
};

// We never render — the loader always redirects.
export default function Root() {
  return null;
}
