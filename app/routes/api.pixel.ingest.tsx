// POST endpoint that the Web Pixel extension hits from the storefront sandbox.
//
// Contract (POST application/json):
//   {
//     shop: string,           // myshopify.com domain (from pixel settings)
//     eventName: string,      // page_viewed | product_viewed | …
//     occurredAt: string,     // ISO 8601
//     data: object            // event-specific payload (productId, totals, …)
//   }
//
// Auth: we don't HMAC-sign pixel requests (the secret would leak in the
// sandbox bundle). Instead we require that `shop` matches a row in Session —
// i.e. the app must be installed in that shop. This is "good enough" for MVP;
// a malicious actor can still inject events for a known shop, but they can't
// access the data or trigger any business logic — worst case is poisoning
// our funnel metrics for that shop.

import prisma from "../db.server";
import { logger } from "../logger.server";

const ALLOWED_EVENTS = new Set([
  "page_viewed",
  "product_viewed",
  "cart_viewed",
  "product_added_to_cart",
  "checkout_started",
  "checkout_completed",
]);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

// CORS preflight from the sandbox iframe.
export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
};

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400, headers: CORS_HEADERS });
  }

  const shop = String(payload?.shop || "").trim();
  const eventName = String(payload?.eventName || "").trim();
  const occurredAtRaw = payload?.occurredAt;
  const data = payload?.data ?? {};

  if (!shop || !eventName || !occurredAtRaw) {
    return Response.json(
      { error: "shop, eventName, occurredAt required" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  if (!ALLOWED_EVENTS.has(eventName)) {
    return Response.json(
      { error: `unsupported event: ${eventName}` },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  // Validate shop is installed.
  const session = await prisma.session.findFirst({ where: { shop } });
  if (!session) {
    logger.warn({ shop, eventName }, "pixel event for unknown shop");
    return Response.json({ error: "unknown shop" }, { status: 403, headers: CORS_HEADERS });
  }

  const occurredAt = new Date(occurredAtRaw);
  if (Number.isNaN(occurredAt.getTime())) {
    return Response.json(
      { error: "occurredAt is not a valid date" },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  // Pull out hot fields for indexing; keep the rest in `data` JSON.
  const productId = data?.productId ? String(data.productId) : null;
  const variantId = data?.variantId ? String(data.variantId) : null;
  const totalAmount = Number.isFinite(data?.totalAmount)
    ? Number(data.totalAmount)
    : Number.isFinite(data?.totalPrice)
      ? Number(data.totalPrice)
      : Number.isFinite(data?.price)
        ? Number(data.price)
        : null;

  await prisma.pixelEvent.create({
    data: {
      shop,
      eventName,
      occurredAt,
      productId,
      variantId,
      totalAmount,
      data,
    },
  });

  return Response.json({ ok: true }, { headers: CORS_HEADERS });
};
