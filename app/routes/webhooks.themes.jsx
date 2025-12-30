import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }) => {
  try {
    const { topic, shop, payload } = await authenticate.webhook(request);

    console.log("Theme webhook received:", { topic, shop, payloadKeys: Object.keys(payload || {}) });

    const topicLower = topic.toLowerCase();
    const isMainTheme = payload?.role === "main" || payload?.role === "MAIN";
    
    if (!isMainTheme) {
      console.log(`[SKIP] Skipping theme event for non-main theme: ${payload?.name || payload?.id}`);
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
        console.log(`[DEDUPLICATION] Skipping theme_published for theme ${themeId} as ${anyRecentThemeEvent.type} was recently recorded.`);
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
          
          console.log("Theme switched change created:", { themeName, themeId, previousThemeName });
        } else {
          console.log(`[SKIP] Theme ${themeId} is the same as previous, treating as publish instead of switch.`);
          await prisma.change.create({
            data: {
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
          
          console.log("Theme published change created:", { themeName, themeId });
        }
      } else {
        await prisma.change.create({
          data: {
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
        
        console.log("Theme published change created:", { themeName, themeId });
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
          console.log(`[DEDUPLICATION] Skipping theme_updated (role: main) for theme ${themeId} as ${recentPublish.type} was recently recorded.`);
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
        console.log(`[DEDUPLICATION] Skipping theme_updated for theme ${themeId} as ${recentEvent.type} was recently recorded.`);
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
      
      console.log("Theme files updated change created:", { themeName, themeId, changes });
    }

    return new Response(null, { status: 200 });
  } catch (error) {
    console.error("Theme webhook error:", error);
    return new Response(null, { status: 200 });
  }
};

