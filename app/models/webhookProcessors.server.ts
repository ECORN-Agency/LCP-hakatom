// Topic-specific webhook processors. Called by the queue worker
// (api.jobs.run) after a WebhookJob row has been pulled off the queue.
//
// Each processor receives ({ shop, topic, webhookId, payload }) and writes
// the appropriate Change row(s) — or suppresses the job if it's a duplicate
// or a no-op (e.g. ghost products/update with empty diff).
//
// Idempotency layers:
//   1. WebhookJob.webhookId @unique — same Shopify delivery never enqueued twice.
//   2. Change.webhookId @unique     — Change row never created twice even if a
//                                     job somehow re-runs.

import prisma from "../db.server";
import { logger } from "../logger.server";
import {
  snapshotFromPayload,
  diffSnapshots,
  summarizeDiff,
} from "./productDiff.server";

export type JobInput = {
  shop: string;
  topic: string;
  webhookId: string;
  payload: any;
};

// Shopify ships webhook topic strings in different shapes across API versions
// and across the various SDKs (sometimes "themes/publish", sometimes
// "THEMES_PUBLISH"). Normalize to the slashed-lowercase form once at the
// entry so the rest of the file can rely on it.
function normalizeTopic(raw: string): string {
  return raw.toLowerCase().replace(/_/g, "/");
}

export async function processWebhookJob(job: JobInput) {
  const topic = normalizeTopic(job.topic);
  const normalizedJob = { ...job, topic };

  switch (topic) {
    case "themes/publish":
    case "themes/update":
      return processThemeJob(normalizedJob);
    case "products/create":
    case "products/update":
    case "products/delete":
      return processProductJob(normalizedJob);
    case "orders/create":
    case "orders/updated":
      return processOrderJob(normalizedJob);
    case "collections/create":
    case "collections/update":
    case "collections/delete":
      return processCollectionJob(normalizedJob);
    default:
      throw new Error(`unknown webhook topic: ${job.topic} (normalized: ${topic})`);
  }
}

// ============================================================================
// Themes
// ============================================================================
async function processThemeJob({ shop, topic, webhookId, payload }: JobInput) {
  const log = logger.child({ processor: "theme", shop, topic, webhookId });
  const topicLower = topic.toLowerCase();
  const isMainTheme = payload?.role === "main" || payload?.role === "MAIN";

  if (!isMainTheme) {
    log.debug({ themeName: payload?.name, themeId: payload?.id }, "skipped non-main");
    return;
  }

  const themeId = payload?.id ? String(payload.id) : null;

  if (topicLower === "themes/publish") {
    const themeName = payload?.name || payload?.theme_name || themeId || "Unknown";

    const anyRecent = await prisma.change.findFirst({
      where: {
        shop,
        type: { in: ["theme_published", "theme_switched", "theme_files_updated"] },
        entityId: themeId,
        occurredAt: { gte: new Date(Date.now() - 60_000) },
      },
      orderBy: { occurredAt: "desc" },
    });
    if (anyRecent) {
      log.info({ themeId, suppressedBy: anyRecent.type }, "deduplicated theme_published");
      return;
    }

    const lastLive = await prisma.change.findFirst({
      where: { shop, type: { in: ["theme_published", "theme_switched"] } },
      orderBy: { occurredAt: "desc" },
    });
    const isSwitch = lastLive?.entityId && lastLive.entityId !== themeId;

    if (isSwitch) {
      const previousThemeName =
        (lastLive!.payload as any)?.changeDetails?.themeName ||
        lastLive!.summary?.match(/published: (.+?)(?: \(from|$)/)?.[1] ||
        lastLive!.summary?.match(/switched to: (.+?)(?: \(from|$)/)?.[1] ||
        "Unknown";

      if (previousThemeName !== themeName) {
        await prisma.change.create({
          data: {
            webhookId,
            shop,
            type: "theme_switched",
            entityType: "theme",
            entityId: themeId,
            summary: `Live theme switched to: ${themeName} (from ${previousThemeName})`,
            payload: {
              ...payload,
              changeDetails: {
                themeName,
                themeId,
                action: "switch",
                previousThemeId: lastLive!.entityId,
                previousThemeName,
              },
            },
            occurredAt: payload?.updated_at
              ? new Date(payload.updated_at)
              : payload?.created_at
                ? new Date(payload.created_at)
                : new Date(),
          },
        });
        log.info({ themeName, themeId }, "theme switched");
        return;
      }
    }

    await prisma.change.create({
      data: {
        webhookId,
        shop,
        type: "theme_published",
        entityType: "theme",
        entityId: themeId,
        summary: `Theme published: ${themeName}`,
        payload: {
          ...payload,
          changeDetails: { themeName, themeId, action: "publish" },
        },
        occurredAt: payload?.updated_at
          ? new Date(payload.updated_at)
          : payload?.created_at
            ? new Date(payload.created_at)
            : new Date(),
      },
    });
    log.info({ themeName, themeId }, "theme published");
    return;
  }

  if (topicLower === "themes/update") {
    const themeName = payload?.name || payload?.theme_name || themeId || "Unknown";

    if (isMainTheme) {
      const recentPublish = await prisma.change.findFirst({
        where: {
          shop,
          type: { in: ["theme_published", "theme_switched"] },
          entityId: themeId,
          occurredAt: { gte: new Date(Date.now() - 300_000) },
        },
        orderBy: { occurredAt: "desc" },
      });
      if (recentPublish) {
        log.info({ themeId, suppressedBy: recentPublish.type }, "deduplicated theme_updated");
        return;
      }
    }

    const recent = await prisma.change.findFirst({
      where: {
        shop,
        type: { in: ["theme_published", "theme_switched", "theme_files_updated"] },
        entityId: themeId,
        occurredAt: { gte: new Date(Date.now() - 60_000) },
      },
      orderBy: { occurredAt: "desc" },
    });
    if (recent) {
      log.info({ themeId, suppressedBy: recent.type }, "deduplicated theme_updated");
      return;
    }

    const changes: string[] = [];
    if (payload?.name) changes.push(`name: ${payload.name}`);
    if (payload?.role) changes.push(`role: ${payload.role}`);
    if (payload?.updated_at) changes.push(`updated at: ${new Date(payload.updated_at).toLocaleString()}`);
    const summary = changes.length > 0
      ? `Theme updated: ${themeName} (${changes.join(", ")})`
      : `Theme updated: ${themeName}`;

    await prisma.change.create({
      data: {
        webhookId,
        shop,
        type: "theme_files_updated",
        entityType: "theme",
        entityId: themeId,
        summary,
        payload: {
          ...payload,
          changeDetails: { themeName, themeId, action: "customize", changes },
        },
        occurredAt: new Date(payload?.updated_at || Date.now()),
      },
    });
    log.info({ themeName, themeId }, "theme files updated");
  }
}

// ============================================================================
// Products
// ============================================================================
async function processProductJob({ shop, topic, webhookId, payload }: JobInput) {
  const log = logger.child({ processor: "product", shop, topic, webhookId });
  const changeType = topic.replace(/\//g, "_").toLowerCase();
  const entityId = payload?.id ? String(payload.id) : null;
  const productTitle = payload?.title || payload?.name || "Unknown Product";

  if (changeType === "products_delete") {
    if (entityId) {
      await prisma.productSnapshot
        .delete({ where: { shop_productId: { shop, productId: entityId } } })
        .catch(() => {});
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
    log.info({ entityId }, "product deleted");
    return;
  }

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
    log.info({ entityId }, "product created");
    return;
  }

  if (changeType === "products_update" && entityId) {
    const stored = await prisma.productSnapshot.findUnique({
      where: { shop_productId: { shop, productId: entityId } },
    });
    const nextSnapshot = snapshotFromPayload(payload);
    const prevSnapshot = (stored?.snapshot as any) ?? null;
    const diff = diffSnapshots(prevSnapshot, nextSnapshot);

    await prisma.productSnapshot.upsert({
      where: { shop_productId: { shop, productId: entityId } },
      create: { shop, productId: entityId, snapshot: nextSnapshot as any },
      update: { snapshot: nextSnapshot as any },
    });

    if (!stored) {
      await prisma.change.create({
        data: {
          webhookId,
          shop,
          type: changeType,
          entityType: "product",
          entityId,
          summary: `Product updated: ${productTitle}`,
          payload: { ...payload, changeDetails: { productTitle, productId: entityId, firstObservation: true } },
          occurredAt: new Date(),
        },
      });
      log.info({ entityId }, "first observation");
      return;
    }

    if (!diff.hasChanges) {
      log.info({ entityId }, "no diff, suppressed");
      return;
    }

    const summary = summarizeDiff(productTitle, diff);
    await prisma.change.create({
      data: {
        webhookId,
        shop,
        type: changeType,
        entityType: "product",
        entityId,
        summary,
        payload: { ...payload, changeDetails: { productTitle, productId: entityId, ...diff } },
        occurredAt: new Date(),
      },
    });
    log.info({ entityId, summary }, "product diff captured");
  }
}

// ============================================================================
// Orders
// ============================================================================
async function processOrderJob({ shop, topic, webhookId, payload }: JobInput) {
  const log = logger.child({ processor: "order", shop, topic, webhookId });
  const changeType = topic.replace(/\//g, "_").toLowerCase();
  const entityId = payload?.id ? String(payload.id) : null;

  if (entityId && changeType === "orders_updated") {
    const recentCreate = await prisma.change.findFirst({
      where: {
        shop,
        type: "orders_create",
        entityId,
        occurredAt: { gte: new Date(Date.now() - 10_000) },
      },
      orderBy: { occurredAt: "desc" },
    });
    if (recentCreate) {
      log.info({ entityId }, "deduplicated orders_updated");
      return;
    }
  }

  if (entityId && changeType === "orders_create") {
    const recentUpdated = await prisma.change.findFirst({
      where: {
        shop,
        type: "orders_updated",
        entityId,
        occurredAt: { gte: new Date(Date.now() - 10_000) },
      },
      orderBy: { occurredAt: "desc" },
    });
    if (recentUpdated) {
      await prisma.change.delete({ where: { id: recentUpdated.id } }).catch(() => {});
    }
  }

  const orderCreatedAt = payload?.created_at && !Number.isNaN(new Date(payload.created_at).getTime())
    ? new Date(payload.created_at)
    : new Date();

  const summary = changeType === "orders_create"
    ? `Order created: #${payload?.order_number || payload?.id || "Unknown"}`
    : `Order updated: #${payload?.order_number || payload?.id || "Unknown"}`;

  await prisma.change.create({
    data: {
      webhookId,
      shop,
      type: changeType,
      entityType: "order",
      entityId,
      summary,
      payload,
      occurredAt: orderCreatedAt,
    },
  });
  log.info({ type: changeType, entityId }, "order change recorded");
}

// ============================================================================
// Collections
// ============================================================================
async function processCollectionJob({ shop, topic, webhookId, payload }: JobInput) {
  const changeType = topic.replace(/\//g, "_").toLowerCase();
  const entityId = payload?.id ? String(payload.id) : null;
  const title = payload?.title || payload?.id || "Unknown";

  const summary =
    changeType === "collections_create" ? `Collection created: ${title}` :
    changeType === "collections_delete" ? `Collection deleted: ${title}` :
    `Collection updated: ${title}`;

  await prisma.change.create({
    data: {
      webhookId,
      shop,
      type: changeType,
      entityType: "collection",
      entityId,
      summary,
      payload,
      occurredAt: new Date(),
    },
  });
}
