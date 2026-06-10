import { describe, it, expect, vi, beforeEach } from "vitest";

const { authMock, prismaMock, kickMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  prismaMock: { webhookJob: { create: vi.fn() } },
  kickMock: vi.fn(),
}));

vi.mock("../shopify.server", () => ({ authenticate: { webhook: authMock } }));
vi.mock("../db.server", () => ({ default: prismaMock }));
vi.mock("./jobs.server", () => ({ kickWorker: kickMock }));
vi.mock("../logger.server", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { enqueueWebhook } from "./webhookEnqueue.server";

const req = (webhookId: string | null = "wh-1") =>
  new Request("https://app/webhooks/orders", {
    method: "POST",
    headers: webhookId ? { "X-Shopify-Webhook-Id": webhookId } : {},
  });

beforeEach(() => {
  authMock.mockReset().mockResolvedValue({ topic: "orders/create", shop: "s.myshopify.com", payload: { id: 1 } });
  prismaMock.webhookJob.create.mockReset().mockResolvedValue({ id: "job-1" });
  kickMock.mockReset();
});

describe("enqueueWebhook", () => {
  it("enqueues and returns 200 on success, then kicks the worker", async () => {
    const res = await enqueueWebhook(req(), "webhooks.orders");
    expect(res.status).toBe(200);
    expect(prismaMock.webhookJob.create).toHaveBeenCalledTimes(1);
    expect(kickMock).toHaveBeenCalledTimes(1);
  });

  it("acks a duplicate delivery (P2002) with 200 and does not error", async () => {
    prismaMock.webhookJob.create.mockRejectedValueOnce({ code: "P2002" });
    const res = await enqueueWebhook(req(), "webhooks.orders");
    expect(res.status).toBe(200);
    expect(kickMock).toHaveBeenCalledTimes(1);
  });

  it("returns 500 on a real enqueue failure so Shopify retries (M2)", async () => {
    prismaMock.webhookJob.create.mockRejectedValueOnce(new Error("db down"));
    const res = await enqueueWebhook(req(), "webhooks.orders");
    expect(res.status).toBe(500);
    expect(kickMock).not.toHaveBeenCalled();
  });

  it("propagates the SDK Response on verification failure", async () => {
    authMock.mockRejectedValueOnce(new Response(null, { status: 401 }));
    const res = await enqueueWebhook(req(), "webhooks.orders");
    expect(res.status).toBe(401);
    expect(prismaMock.webhookJob.create).not.toHaveBeenCalled();
  });

  it("returns 401 on an unexpected (non-Response) verification error", async () => {
    authMock.mockRejectedValueOnce(new Error("boom"));
    const res = await enqueueWebhook(req(), "webhooks.orders");
    expect(res.status).toBe(401);
  });

  it("falls back to an opaque webhookId when the header is missing", async () => {
    await enqueueWebhook(req(null), "webhooks.orders");
    const data = prismaMock.webhookJob.create.mock.calls[0][0].data;
    expect(typeof data.webhookId).toBe("string");
    expect(data.webhookId).toContain("s.myshopify.com:orders/create:");
  });
});
