import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body;
  const contentType = request.headers.get("content-type");

  if (contentType?.includes("application/json")) {
    body = await request.json();
  } else {
    const formData = await request.formData();
    body = { summary: formData.get("summary") };
  }

  const summary = body.summary?.trim();
  if (!summary || summary.length === 0 || summary.length > 200) {
    return Response.json({ error: "Summary is required and must be max 200 characters" }, { status: 400 });
  }

      const change = await prisma.change.create({
        data: {
          shop: session.shop,
          type: "manual",
          entityType: "manual",
          summary,
          occurredAt: new Date(),
        },
      });

  return Response.json({ ok: true, change });
};

