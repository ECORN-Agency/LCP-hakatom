// Idempotently activate the Web Pixel for a shop. Called from the app layout
// loader so that the pixel "just works" from the first time the merchant opens
// the app — no manual GraphQL ritual required.
//
// Strategy:
//   1. Upsert ShopConfig row for the shop (cheap, single Prisma query).
//   2. If pixelActivatedAt is set → already done, return early.
//   3. Otherwise, call webPixelCreate via Admin GraphQL with our settings
//      (shop_domain + ingest_url). Record success/failure on ShopConfig.
//
// Failure isn't fatal — the rest of the app should keep loading. We just
// note the error on ShopConfig.pixelLastError so the UI can surface it and
// retry on next load.

import prisma from "../db.server";
import { logger } from "../logger.server";

const WEB_PIXEL_CREATE_MUTATION = `#graphql
  mutation webPixelCreate($webPixel: WebPixelInput!) {
    webPixelCreate(webPixel: $webPixel) {
      webPixel {
        id
        settings
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export async function ensurePixelActivated({
  shop,
  admin,
}: {
  shop: string;
  admin: { graphql: (...args: any[]) => Promise<Response> };
}) {
  const log = logger.child({ shop, route: "pixelActivation" });

  // Make sure the row exists, then check current state.
  const config = await prisma.shopConfig.upsert({
    where: { shop },
    create: { shop },
    update: {},
  });

  if (config.pixelActivatedAt) {
    return { activated: true, pixelId: config.pixelId };
  }

  const appUrl =
    process.env.SHOPIFY_APP_URL?.replace(/\/$/, "") ??
    "https://lcp-hakatom.vercel.app";
  const ingestUrl = `${appUrl}/api/pixel/ingest`;

  const settings = JSON.stringify({
    shop_domain: shop,
    ingest_url: ingestUrl,
  });

  try {
    const response = await admin.graphql(WEB_PIXEL_CREATE_MUTATION, {
      variables: { webPixel: { settings } },
    });

    if (!response.ok) {
      const text = await response.text();
      log.error({ status: response.status, body: text }, "webPixelCreate http error");
      await prisma.shopConfig.update({
        where: { shop },
        data: { pixelLastError: `HTTP ${response.status}: ${text.slice(0, 200)}` },
      });
      return { activated: false, error: `HTTP ${response.status}` };
    }

    const data: any = await response.json();
    const userErrors = data?.data?.webPixelCreate?.userErrors ?? [];

    if (userErrors.length > 0) {
      const message = userErrors.map((e: any) => `${e.field?.join?.(".") ?? "?"}: ${e.message}`).join("; ");

      // The pixel might already exist for this shop (e.g. activated manually
      // earlier). Treat "already exists" as success and mark activated.
      const alreadyExists = userErrors.some((e: any) =>
        String(e.message ?? "").toLowerCase().includes("already"),
      );

      if (alreadyExists) {
        await prisma.shopConfig.update({
          where: { shop },
          data: {
            pixelActivatedAt: new Date(),
            pixelLastError: null,
          },
        });
        log.info({ message }, "pixel already exists, marking activated");
        return { activated: true, pixelId: null };
      }

      log.warn({ userErrors: message }, "webPixelCreate returned userErrors");
      await prisma.shopConfig.update({
        where: { shop },
        data: { pixelLastError: message },
      });
      return { activated: false, error: message };
    }

    const pixelId = data?.data?.webPixelCreate?.webPixel?.id ?? null;

    await prisma.shopConfig.update({
      where: { shop },
      data: {
        pixelId,
        pixelActivatedAt: new Date(),
        pixelLastError: null,
      },
    });

    log.info({ pixelId, ingestUrl }, "pixel activated");
    return { activated: true, pixelId };
  } catch (err) {
    log.error({ err }, "pixel activation threw");
    await prisma.shopConfig
      .update({
        where: { shop },
        data: { pixelLastError: String(err).slice(0, 200) },
      })
      .catch(() => {});
    return { activated: false, error: String(err) };
  }
}

// Called by the manual "Re-activate" button in the UI when something has
// gone wrong and we want to force another attempt.
export async function resetAndReactivatePixel({
  shop,
  admin,
}: {
  shop: string;
  admin: { graphql: (...args: any[]) => Promise<Response> };
}) {
  await prisma.shopConfig.upsert({
    where: { shop },
    create: { shop },
    update: { pixelActivatedAt: null, pixelLastError: null },
  });
  return ensurePixelActivated({ shop, admin });
}
