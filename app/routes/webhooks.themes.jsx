import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { logger } from "../logger.server";

export const action = async ({ request }) => {
  let log = logger.child({ route: "webhooks.themes" });
  // Read idempotency key BEFORE authenticate.webhook consumes the request body.
  const webhookId = request.headers.get("X-Shopify-Webhook-Id");
  try {
    const { topic, shop, payload } = await authenticate.webhook(request);
    log = log.child({ shop, topic, webhookId });

    // Idempotency: if we've already processed this delivery, ack and bail.
    if (webhookId) {
      const existing = await prisma.change.findUnique({ where: { webhookId } });
      if (existing) {
        log.info({ existingChangeId: existing.id }, "duplicate delivery, already processed");
        return new Response(null, { status: 200 });
      }
    }

    log.info({ payloadKeys: Object.keys(payload || {}) }, "theme webhook received");

    const topicLower = topic.toLowerCase();
    const isMainTheme = payload?.role === "main" || payload?.role === "MAIN";
    
    if (!isMainTheme) {
      log.debug({ themeName: payload?.name, themeId: payload?.id, role: payload?.role }, "skipped non-main theme event");
      return new Response(null, { status: 200 });
    }

    const themeId = payload?.id ? String(payload.id) : null;
    
    if (topicLower === "themes/publish" || topicLower === "themes_publish") {
      const themeName = payload?.name || payload?.theme_name || payload?.id || "Unknown";
      
      const anyRecentThemeEvent = await prisma.change.findFirst({
        where: {
          shop: shop,
          type: { in: ["theme_published", "theme_switched", "theme_files_updated"] },
          entityId: themeId,
          occurredAt: {
            gte: new Date(Date.now() - 60000),
          },
        },
        orderBy: { occurredAt: "desc" },
      });

      if (anyRecentThemeEvent) {
        log.info({ themeId, suppressedBy: anyRecentThemeEvent.type, windowMs: 60000 }, "deduplicated theme_published");
        return new Response(null, { status: 200 });
      }
      
      const lastLiveThemeChange = await prisma.change.findFirst({
        where: {
          shop: shop,
          type: { in: ["theme_published", "theme_switched"] },
        },
        orderBy: { occurredAt: "desc" },
      });

      const isThemeSwitch = lastLiveThemeChange && lastLiveThemeChange.entityId && lastLiveThemeChange.entityId !== themeId;
      
      if (isThemeSwitch) {
        const previousThemeName = lastLiveThemeChange?.payload?.changeDetails?.themeName || 
                                 lastLiveThemeChange?.summary?.match(/published: (.+?)(?: \(from|$)/)?.[1] ||
                                 lastLiveThemeChange?.summary?.match(/switched to: (.+?)(?: \(from|$)/)?.[1] ||
                                 "Unknown";
        
        if (previousThemeName !== themeName) {
          await prisma.change.create({
            data: {
              webhookId,
              shop: shop,
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
                  previousThemeId: lastLiveThemeChange.entityId,
                  previousThemeName: previousThemeName,
                },
              },
              occurredAt: payload?.updated_at ? new Date(payload.updated_at) : (payload?.created_at ? new Date(payload.created_at) : new Date()),
            },
          });
          
          log.info({ themeName, themeId, previousThemeName, type: "theme_switched" }, "change created");
        } else {
          log.debug({ themeId }, "theme matches previous live, treating as publish");
          await prisma.change.create({
            data: {
              webhookId,
              shop: shop,
              type: "theme_published",
              entityType: "theme",
              entityId: themeId,
              summary: `Theme published: ${themeName}`,
              payload: {
                ...payload,
                changeDetails: {
                  themeName,
                  themeId,
                  action: "publish",
                },
                note: "Files list will be saved on next page load for comparison",
              },
              occurredAt: payload?.updated_at ? new Date(payload.updated_at) : (payload?.created_at ? new Date(payload.created_at) : new Date()),
            },
          });
          
          log.info({ themeName, themeId, type: "theme_published" }, "change created");
        }
      } else {
        await prisma.change.create({
          data: {
            webhookId,
            shop: shop,
            type: "theme_published",
            entityType: "theme",
            entityId: themeId,
            summary: `Theme published: ${themeName}`,
            payload: {
              ...payload,
              changeDetails: {
                themeName,
                themeId,
                action: "publish",
              },
              note: "Files list will be saved on next page load for comparison",
            },
            occurredAt: new Date(),
          },
        });
        
        log.info({ themeName, themeId, type: "theme_published" }, "change created");
      }
    } else if (topicLower === "themes/update" || topicLower === "themes_update") {
      const themeName = payload?.name || payload?.theme_name || payload?.id || "Unknown";
      
      const roleChangedToMain = payload?.role === "main" || payload?.role === "MAIN";
      
      if (roleChangedToMain) {
        const recentPublish = await prisma.change.findFirst({
          where: {
            shop: shop,
            type: { in: ["theme_published", "theme_switched"] },
            entityId: themeId,
            occurredAt: {
              gte: new Date(Date.now() - 300000),
            },
          },
          orderBy: { occurredAt: "desc" },
        });

        if (recentPublish) {
          log.info({ themeId, suppressedBy: recentPublish.type, windowMs: 300000 }, "deduplicated theme_updated (role=main)");
          return new Response(null, { status: 200 });
        }
      }
      
      const recentEvent = await prisma.change.findFirst({
        where: {
          shop: shop,
          type: { in: ["theme_published", "theme_switched", "theme_files_updated"] },
          entityId: themeId,
          occurredAt: {
            gte: new Date(Date.now() - 60000),
          },
        },
        orderBy: { occurredAt: "desc" },
      });

      if (recentEvent) {
        log.info({ themeId, suppressedBy: recentEvent.type, windowMs: 60000 }, "deduplicated theme_updated");
        return new Response(null, { status: 200 });
      }
      
      const changes = [];
      if (payload?.name) changes.push(`name: ${payload.name}`);
      if (payload?.role) changes.push(`role: ${payload.role}`);
      if (payload?.updated_at) {
        const updatedAt = new Date(payload.updated_at);
        const formattedDate = updatedAt.toLocaleString("en-US", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          timeZoneName: "short"
        });
        changes.push(`updated at: ${formattedDate}`);
      }
      
      const summary = changes.length > 0 
        ? `Theme updated: ${themeName} (${changes.join(", ")})`
        : `Theme updated: ${themeName}`;
      
      await prisma.change.create({
        data: {
          webhookId,
          shop: shop,
          type: "theme_files_updated",
          entityType: "theme",
          entityId: themeId,
          summary: summary,
          payload: {
            ...payload,
            changeDetails: {
              themeName,
              themeId,
              action: "customize",
              changes: changes,
            },
          },
          occurredAt: new Date(payload?.updated_at || new Date()),
        },
      });
      
      log.info({ themeName, themeId, changes, type: "theme_files_updated" }, "change created");
    }

    return new Response(null, { status: 200 });
  } catch (error) {
    log.error({ err: error }, "theme webhook failed");
    return new Response(null, { status: 200 });
  }
};

