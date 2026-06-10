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
import {
  fetchThemeFiles,
  diffThemeFiles,
  summarizeFileList,
  type ThemeFile,
  type ThemeFileDiff,
} from "./themeDiff.server";
import { unauthenticated } from "../shopify.server";
import { withAdvisoryLock } from "../lib/dbLock.server";

export type JobInput = {
  shop: string;
  topic: string;
  webhookId: string;
  payload: any;
};

// Dedup half-windows, measured around the EVENT's own timestamp (not wall
// clock). See M1 in docs/code-review-2026-06.md.
const DEDUP_WINDOW_MS = 10_000; // orders create↔updated double-fire
const THEME_PUBLISH_DEDUP_MS = 60_000; // any recent theme change near a publish
const THEME_UPDATE_DEDUP_MS = 30_000; // publish/switch double-fire vs real edit

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

  // Event time of THIS theme change — used to anchor dedup windows so they
  // keep working under delayed (cron-backstop) processing. (M1)
  const themeEventTime =
    payload?.updated_at && !Number.isNaN(new Date(payload.updated_at).getTime())
      ? new Date(payload.updated_at)
      : payload?.created_at && !Number.isNaN(new Date(payload.created_at).getTime())
        ? new Date(payload.created_at)
        : new Date();

  if (topicLower === "themes/publish") {
    const themeName = payload?.name || payload?.theme_name || themeId || "Unknown";

    const anyRecent = await prisma.change.findFirst({
      where: {
        shop,
        type: { in: ["theme_published", "theme_switched", "theme_files_updated"] },
        entityId: themeId,
        occurredAt: {
          gte: new Date(themeEventTime.getTime() - THEME_PUBLISH_DEDUP_MS),
          lte: new Date(themeEventTime.getTime() + THEME_PUBLISH_DEDUP_MS),
        },
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

    // Shopify fires a themes/update as part of the publish/switch flow
    // (because role changes to "main"). We only want to suppress THAT
    // bookkeeping update, not real merchant edits a minute or two later.
    // 30s window is wide enough to catch the double-fire but narrow enough
    // that a customer who switches a theme and immediately edits it still
    // gets their edits recorded.
    if (isMainTheme) {
      const recentPublish = await prisma.change.findFirst({
        where: {
          shop,
          type: { in: ["theme_published", "theme_switched"] },
          entityId: themeId,
          occurredAt: {
            gte: new Date(themeEventTime.getTime() - THEME_UPDATE_DEDUP_MS),
            lte: new Date(themeEventTime.getTime() + THEME_UPDATE_DEDUP_MS),
          },
        },
        orderBy: { occurredAt: "desc" },
      });
      if (recentPublish) {
        log.info({ themeId, suppressedBy: recentPublish.type }, "deduplicated theme_updated (publish double-fire)");
        return;
      }
    }

    // Try to pull the current theme file list. Best effort — if it fails
    // (network, scope, missing session) we still record a generic Change.
    let fileDiff: ThemeFileDiff | null = null;
    let nextFiles: ThemeFile[] | null = null;
    if (themeId) {
      try {
        const { admin } = await unauthenticated.admin(shop);
        nextFiles = await fetchThemeFiles(admin, themeId);
        const stored = await prisma.themeSnapshot.findUnique({
          where: { shop_themeId: { shop, themeId } },
        });
        fileDiff = diffThemeFiles((stored?.files as ThemeFile[] | null) ?? null, nextFiles);
        await prisma.themeSnapshot.upsert({
          where: { shop_themeId: { shop, themeId } },
          create: { shop, themeId, files: nextFiles as any },
          update: { files: nextFiles as any },
        });
      } catch (err) {
        log.warn({ err: String(err), themeId }, "couldn't fetch theme files for diff");
      }
    }

    const changedNow: string[] = fileDiff
      ? [...fileDiff.modified, ...fileDiff.added]
      : [];
    const removedNow: string[] = fileDiff?.removed ?? [];

    // 1-hour aggregation window: if there's already an open theme_files_updated
    // Change for this theme in the last hour, merge into it instead of
    // spawning a new row. Serialized per (shop, themeId) with an advisory lock
    // so a concurrent poll / webhook can't both find-or-create and produce a
    // duplicate row or lose a merge. (H3)
    await withAdvisoryLock(`theme-agg:${shop}:${themeId}`, async (tx) => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const open = await tx.change.findFirst({
        where: {
          shop,
          type: "theme_files_updated",
          entityId: themeId,
          occurredAt: { gte: oneHourAgo },
        },
        orderBy: { occurredAt: "desc" },
      });

      if (open) {
        const cd: any = (open.payload as any)?.changeDetails ?? {};
        const newCount = (cd.updateCount ?? 1) + 1;
        const mergedChanged = Array.from(new Set([...(cd.filesChanged ?? []), ...changedNow]));
        const mergedRemoved = Array.from(new Set([...(cd.filesRemoved ?? []), ...removedNow]));

        const filePart =
          mergedChanged.length > 0
            ? ` — ${summarizeFileList(mergedChanged)}`
            : "";
        const removedPart =
          mergedRemoved.length > 0 ? `, ${mergedRemoved.length} removed` : "";

        await tx.change.update({
          where: { id: open.id },
          data: {
            summary: `Theme updated ${newCount}× (${themeName})${filePart}${removedPart}`,
            payload: {
              ...(open.payload as any),
              changeDetails: {
                ...cd,
                themeName,
                themeId,
                updateCount: newCount,
                lastUpdatedAt: new Date(),
                filesChanged: mergedChanged,
                filesRemoved: mergedRemoved,
              },
            },
          },
        });
        log.info(
          { themeId, updateCount: newCount, filesAddedNow: changedNow.length, filesRemovedNow: removedNow.length },
          "theme update aggregated into existing change",
        );
        return;
      }

      // No open window — create a fresh Change.
      const filePart =
        changedNow.length > 0 ? ` — ${summarizeFileList(changedNow)}` : "";
      const removedPart =
        removedNow.length > 0 ? `, ${removedNow.length} removed` : "";

      await tx.change.create({
        data: {
          webhookId,
          shop,
          type: "theme_files_updated",
          entityType: "theme",
          entityId: themeId,
          summary: `Theme updated: ${themeName}${filePart}${removedPart}`,
          payload: {
            ...payload,
            changeDetails: {
              themeName,
              themeId,
              action: "customize",
              updateCount: 1,
              firstUpdatedAt: new Date(),
              lastUpdatedAt: new Date(),
              filesChanged: changedNow,
              filesRemoved: removedNow,
            },
          },
          occurredAt: new Date(payload?.updated_at || Date.now()),
        },
      });
      log.info(
        { themeId, filesChanged: changedNow.length, filesRemoved: removedNow.length },
        "theme files updated (new window)",
      );
    });
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

  // Anchor dedup on the ORDER's created_at — identical for the create and
  // updated events of the same order — not on Date.now(). Keeps create↔updated
  // dedup working even when jobs are processed late (daily cron backstop),
  // where a wall-clock "recent" window would silently miss the sibling. (M1)
  const orderCreatedAt = payload?.created_at && !Number.isNaN(new Date(payload.created_at).getTime())
    ? new Date(payload.created_at)
    : new Date();
  const dedupLo = new Date(orderCreatedAt.getTime() - DEDUP_WINDOW_MS);
  const dedupHi = new Date(orderCreatedAt.getTime() + DEDUP_WINDOW_MS);

  if (entityId && changeType === "orders_updated") {
    const recentCreate = await prisma.change.findFirst({
      where: {
        shop,
        type: "orders_create",
        entityId,
        occurredAt: { gte: dedupLo, lte: dedupHi },
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
        occurredAt: { gte: dedupLo, lte: dedupHi },
      },
      orderBy: { occurredAt: "desc" },
    });
    if (recentUpdated) {
      await prisma.change.delete({ where: { id: recentUpdated.id } }).catch(() => {});
    }
  }

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
