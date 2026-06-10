import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { logger } from "../logger.server";

export const action = async ({ request }: { request: Request }) => {
  const { payload, session, topic, shop } = await authenticate.webhook(request);

  logger.info({ shop, topic, route: "webhooks.app.scopes_update" }, "received");
  const current = (payload as any).current as string[];

  if (session) {
    await prisma.session.update({
      where: {
        id: session.id,
      },
      data: {
        scope: current.toString(),
      },
    });
  }

  return new Response();
};
