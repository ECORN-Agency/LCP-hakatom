import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { logger } from "../logger.server";
import {
  snapshotFromPayload,
  diffSnapshots,
  summarizeDiff,
} from "../models/productDiff.server";

export const action = async ({ request }) => {
  let log = logger.child({ route: "webhooks.products" });
  // Read idempotency key BEFORE authenticate.webhook consumes the request body.
  const webhookId = request.headers.get("X-Shopify-Webhook-Id");
  try {
    const { topic, shop, payload } = await authenticate.webhook(request);
    log = log.child({ shop, topic, webhookId });

    // 1) Idempotency — same delivery retried.
    if (webhookId) {
      const existing = await prisma.change.findUnique({ where: { webhookId } });
      if (existing) {
        log.info({ existingChangeId: existing.id }, "duplicate delivery, already processed");
        return new Response(null, { status: 200 });
      }
    }

    const changeType = topic.replace(/\//g, "_").toLowerCase();
    const entityId = payload?.id ? String(payload.id) : null;
    const productTitle = payload?.title || payload?.name || "Unknown Product";

    // 2) products/delete — kill the snapshot and log the deletion.
    if (changeType === "products_delete") {
      if (entityId) {
        await prisma.productSnapshot
          .delete({ where: { shop_productId: { shop, productId: entityId } } })
          .catch(() => {
            // No snapshot existed — fine, log at debug and continue.
            log.debug({ entityId }, "no snapshot to delete");
          });
      }
      await prisma.change.create({
        data: {
          webhookId,
          shop,
          type: changeType,
          entityType: "product",
          entityId,
          summary: `Product deleted: ${productTitle}`,
          payload,
          occurredAt: new Date(),
        },
      });
      log.info({ entityId, type: changeType }, "product deleted, change created");
      return new Response(null, { status: 200 });
    }

    // 3) products/create — establish the snapshot, log a creation Change.
    if (changeType === "products_create") {
      if (entityId) {
        const snapshot = snapshotFromPayload(payload);
        await prisma.productSnapshot.upsert({
          where: { shop_productId: { shop, productId: entityId } },
          create: { shop, productId: entityId, snapshot },
          update: { snapshot },
        });
      }
      await prisma.change.create({
        data: {
          webhookId,
          shop,
          type: changeType,
          entityType: "product",
          entityId,
          summary: `Product created: ${productTitle}`,
          payload,
          occurredAt: new Date(),
        },
      });
      log.info({ entityId, type: changeType }, "product created, snapshot stored");
      return new Response(null, { status: 200 });
    }

    // 4) products/update — diff against last snapshot.
    if (changeType === "products_update" && entityId) {
      const stored = await prisma.productSnapshot.findUnique({
        where: { shop_productId: { shop, productId: entityId } },
      });

      const nextSnapshot = snapshotFromPayload(payload);
      const prevSnapshot = stored?.snapshot ?? null;
      const diff = diffSnapshots(prevSnapshot, nextSnapshot);

      // Always refresh the snapshot — even if diff is empty, the latest state
      // is still authoritative for the next webhook.
      await prisma.productSnapshot.upsert({
        where: { shop_productId: { shop, productId: entityId } },
        create: { shop, productId: entityId, snapshot: nextSnapshot },
        update: { snapshot: nextSnapshot },
      });

      // First time we see this product — we have no baseline so we can't
      // compute a rich diff, but we still log a generic Change so the merchant
      // sees that something happened. Subsequent updates will diff against
      // the snapshot we just stored.
      if (!stored) {
        await prisma.change.create({
          data: {
            webhookId,
            shop,
            type: changeType,
            entityType: "product",
            entityId,
            summary: `Product updated: ${productTitle}`,
            payload: {
              ...payload,
              changeDetails: {
                productTitle,
                productId: entityId,
                firstObservation: true,
              },
            },
            occurredAt: new Date(),
          },
        });
        log.info({ entityId }, "first observation of product, generic change created");
        return new Response(null, { status: 200 });
      }

      // Snapshot exists but diff is empty — Shopify fired an identical
      // products/update webhook for one merchant edit. Suppress.
      if (!diff.hasChanges) {
        log.info({ entityId }, "products/update with no diff, suppressed");
        return new Response(null, { status: 200 });
      }

      // Real change — write a rich Change row.
      const summary = summarizeDiff(productTitle, diff);
      const payloadWithDetails = {
        ...payload,
        changeDetails: {
          productTitle,
          productId: entityId,
          ...diff,
        },
      };

      await prisma.change.create({
        data: {
          webhookId,
          shop,
          type: changeType,
          entityType: "product",
          entityId,
          summary,
          payload: payloadWithDetails,
          occurredAt: new Date(),
        },
      });

      log.info({
        entityId,
        summary,
        hasTitle: !!diff.titleChange,
        hasStatus: !!diff.statusChange,
        priceChangesCount: diff.priceChanges?.length ?? 0,
        inventoryChangesCount: diff.inventoryChanges?.length ?? 0,
      }, "product diff captured, change created");
      return new Response(null, { status: 200 });
    }

    // 5) Fallback — unknown topic that hit this handler.
    log.warn({ topic }, "unhandled products topic, ignoring");
    return new Response(null, { status: 200 });
  } catch (error) {
    log.error({ err: error }, "products webhook failed");
    return new Response(null, { status: 200 });
  }
};
