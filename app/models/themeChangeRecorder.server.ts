// Polls the live main-theme file list for a shop and records any diffs as
// theme_files_updated Change rows. This compensates for a Shopify limitation:
//   "themes/update webhook does not occur when theme files are updated"
// So a merchant editing files in the Customizer never triggers a webhook —
// the only way to detect those edits is to pull theme.files on a schedule
// and diff against the snapshot we stored on the previous pull.
//
// Called by /api/cron/poll-themes on a schedule (external scheduler on
// Vercel Hobby; built-in Vercel cron once a day as the backstop).

import prisma from "../db.server";
import { logger } from "../logger.server";
import {
  fetchThemeFiles,
  diffThemeFiles,
  summarizeFileList,
  type ThemeFile,
} from "./themeDiff.server";
import { unauthenticated } from "../shopify.server";
import { withAdvisoryLock } from "../lib/dbLock.server";

const MAIN_THEME_QUERY = `#graphql
  query MainTheme {
    themes(first: 1, roles: [MAIN]) {
      nodes { id name }
    }
  }
`;

type PollResult = {
  ok: boolean;
  shop: string;
  themeId?: string;
  reason?: string;
  filesChanged?: number;
  filesRemoved?: number;
};

export async function pollThemeChangesForShop(shop: string): Promise<PollResult> {
  const log = logger.child({ component: "pollThemeChanges", shop });

  let admin;
  try {
    const result = await unauthenticated.admin(shop);
    admin = result.admin;
  } catch (err) {
    log.warn({ err: String(err) }, "no valid session for shop, skipping");
    return { ok: false, shop, reason: "no_session" };
  }

  // 1. Find the main theme
  let themeId: string | null = null;
  let themeName = "main theme";
  try {
    const res = await admin.graphql(MAIN_THEME_QUERY);
    const data: any = await res.json();
    const node = data?.data?.themes?.nodes?.[0];
    if (node?.id) {
      themeId = String(node.id).replace(/^gid:\/\/shopify\/OnlineStoreTheme\//, "");
      themeName = node?.name ?? themeName;
    }
  } catch (err) {
    log.warn({ err: String(err) }, "couldn't fetch main theme");
    return { ok: false, shop, reason: "fetch_main_theme_failed" };
  }
  if (!themeId) {
    return { ok: false, shop, reason: "no_main_theme" };
  }

  // 2. Suppress if a publish/switch landed in the last 30s — same dedup rule
  // as the webhook processor uses, since Shopify's own update double-fire can
  // also race with a polling cycle.
  const recentPublish = await prisma.change.findFirst({
    where: {
      shop,
      type: { in: ["theme_published", "theme_switched"] },
      entityId: themeId,
      occurredAt: { gte: new Date(Date.now() - 30_000) },
    },
  });
  if (recentPublish) {
    return { ok: true, shop, themeId, reason: "recent_publish" };
  }

  // 3. Fetch current files + diff against last snapshot
  let nextFiles: ThemeFile[];
  try {
    nextFiles = await fetchThemeFiles(admin, themeId);
  } catch (err) {
    log.warn({ err: String(err), themeId }, "couldn't fetch theme files");
    return { ok: false, shop, themeId, reason: "fetch_files_failed" };
  }

  const stored = await prisma.themeSnapshot.findUnique({
    where: { shop_themeId: { shop, themeId } },
  });
  const fileDiff = diffThemeFiles((stored?.files as ThemeFile[] | null) ?? null, nextFiles);

  // 4. Always refresh the snapshot, even if nothing changed — the next poll
  // diffs against the latest known state.
  await prisma.themeSnapshot.upsert({
    where: { shop_themeId: { shop, themeId } },
    create: { shop, themeId, files: nextFiles as any },
    update: { files: nextFiles as any },
  });

  // 5. First poll for this theme — establish baseline, don't spam a Change.
  if (!stored) {
    log.info({ themeId, fileCount: nextFiles.length }, "first poll, snapshot established");
    return { ok: true, shop, themeId, reason: "first_observation" };
  }

  if (!fileDiff.hasChanges) {
    return { ok: true, shop, themeId, reason: "no_diff" };
  }

  // 6. We have real file changes. Use the same 1-hour aggregation rule as
  // the webhook processor so a burst of Customizer saves collapses into one
  // Timeline row.
  const changedNow = [...fileDiff.modified, ...fileDiff.added];
  const removedNow = fileDiff.removed;
  // Serialize the find-or-create aggregation per (shop, themeId) — the webhook
  // processor and a concurrent poll (or two overlapping polls) would otherwise
  // race here and duplicate the row or lose a merge. (H3)
  return withAdvisoryLock(`theme-agg:${shop}:${themeId}`, async (tx): Promise<PollResult> => {
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

      const filePart = mergedChanged.length > 0 ? ` — ${summarizeFileList(mergedChanged)}` : "";
      const removedPart = mergedRemoved.length > 0 ? `, ${mergedRemoved.length} removed` : "";

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
        "theme update aggregated (poll)",
      );
      return {
        ok: true,
        shop,
        themeId,
        reason: "aggregated",
        filesChanged: changedNow.length,
        filesRemoved: removedNow.length,
      };
    }

    const filePart = changedNow.length > 0 ? ` — ${summarizeFileList(changedNow)}` : "";
    const removedPart = removedNow.length > 0 ? `, ${removedNow.length} removed` : "";

    await tx.change.create({
      data: {
        // Poll-sourced events have no Shopify X-Shopify-Webhook-Id, so use a
        // synthetic key that still satisfies the unique constraint.
        webhookId: `poll:${shop}:${themeId}:${Date.now()}`,
        shop,
        type: "theme_files_updated",
        entityType: "theme",
        entityId: themeId,
        summary: `Theme updated: ${themeName}${filePart}${removedPart}`,
        payload: {
          source: "poll",
          themeId,
          themeName,
          changeDetails: {
            themeName,
            themeId,
            action: "customize",
            source: "poll",
            updateCount: 1,
            firstUpdatedAt: new Date(),
            lastUpdatedAt: new Date(),
            filesChanged: changedNow,
            filesRemoved: removedNow,
          },
        },
        occurredAt: new Date(),
      },
    });
    log.info(
      { themeId, filesChanged: changedNow.length, filesRemoved: removedNow.length },
      "theme files updated (new poll window)",
    );
    return {
      ok: true,
      shop,
      themeId,
      reason: "new_change",
      filesChanged: changedNow.length,
      filesRemoved: removedNow.length,
    };
  });
}

export async function pollAllActiveShops(): Promise<PollResult[]> {
  const sessions = await prisma.session.findMany({
    where: { accessToken: { not: "" } },
    distinct: ["shop"],
    select: { shop: true },
  });

  const results: PollResult[] = [];
  for (const { shop } of sessions) {
    try {
      const r = await pollThemeChangesForShop(shop);
      results.push(r);
    } catch (err) {
      logger.error({ err: String(err), shop }, "poll threw unexpectedly");
      results.push({ ok: false, shop, reason: "unexpected_error" });
    }
  }

  return results;
}
