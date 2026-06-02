// LSP Storefront Pixel — runs inside Shopify's sandboxed iframe on the
// customer-facing storefront. Subscribes to standard analytics events and
// POSTs a slim payload to our backend.
//
// Privacy: no PII. We never forward email / phone / address — only event
// name, timestamps, product/cart ids, and totals.

import { register } from "@shopify/web-pixels-extension";

register(({ analytics, settings, browser }) => {
  const shop = (settings && settings.shop_domain) || "";
  const ingestUrl = (settings && settings.ingest_url) || "";

  if (!shop || !ingestUrl) {
    // Misconfigured pixel — fail closed (don't send anything).
    return;
  }

  const post = (eventName, eventData) => {
    const body = JSON.stringify({
      shop,
      eventName,
      occurredAt: new Date().toISOString(),
      data: eventData,
    });

    // keepalive: true so the request survives tab unloads (e.g. on
    // checkout_completed → redirect).
    fetch(ingestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
      mode: "cors",
    }).catch(() => {
      // Swallow — never break the storefront because we couldn't phone home.
    });
  };

  // page_viewed: base rate signal. Every customer interaction starts here.
  analytics.subscribe("page_viewed", (event) => {
    post("page_viewed", {
      url: event?.context?.window?.location?.href ?? null,
      pageType: event?.context?.document?.title ?? null,
    });
  });

  // product_viewed: did customers actually land on the product detail page?
  analytics.subscribe("product_viewed", (event) => {
    const variant = event?.data?.productVariant;
    post("product_viewed", {
      productId: variant?.product?.id ?? null,
      productTitle: variant?.product?.title ?? null,
      variantId: variant?.id ?? null,
      price: variant?.price?.amount ?? null,
    });
  });

  // cart events — Shopify emits product_added_to_cart in current API.
  analytics.subscribe("product_added_to_cart", (event) => {
    const line = event?.data?.cartLine;
    post("product_added_to_cart", {
      productId: line?.merchandise?.product?.id ?? null,
      variantId: line?.merchandise?.id ?? null,
      quantity: line?.quantity ?? null,
      price: line?.cost?.totalAmount?.amount ?? null,
    });
  });

  analytics.subscribe("cart_viewed", (event) => {
    post("cart_viewed", {
      totalAmount: event?.data?.cart?.cost?.totalAmount?.amount ?? null,
      itemCount: event?.data?.cart?.lines?.length ?? null,
    });
  });

  // checkout funnel — these are the moneymakers for "did the theme break
  // checkout?" diagnostics.
  analytics.subscribe("checkout_started", (event) => {
    post("checkout_started", {
      checkoutId: event?.data?.checkout?.id ?? null,
      totalPrice: event?.data?.checkout?.totalPrice?.amount ?? null,
      itemCount: event?.data?.checkout?.lineItems?.length ?? null,
    });
  });

  analytics.subscribe("checkout_completed", (event) => {
    post("checkout_completed", {
      orderId: event?.data?.checkout?.order?.id ?? null,
      totalPrice: event?.data?.checkout?.totalPrice?.amount ?? null,
      itemCount: event?.data?.checkout?.lineItems?.length ?? null,
    });
  });
});
