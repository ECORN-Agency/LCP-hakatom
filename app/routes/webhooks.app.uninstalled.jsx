import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { logger } from "../logger.server";

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  logger.info({ shop, topic, route: "webhooks.app.uninstalled" }, "received");

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await prisma.session.deleteMany({ where: { shop } });
  }

  return new Response();
};
