import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, processMock } = vi.hoisted(() => ({
  prismaMock: {
    $queryRaw: vi.fn(),
    webhookJob: { update: vi.fn() },
  },
  processMock: vi.fn(),
}));

vi.mock("../db.server", () => ({ default: prismaMock }));
vi.mock("./webhookProcessors.server", () => ({ processWebhookJob: processMock }));
vi.mock("../logger.server", () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn() }) },
}));

import { drainWebhookJobs } from "./workerDrain.server";

const job = (id: string) => ({
  id,
  shop: "s.myshopify.com",
  topic: "orders/create",
  webhookId: `wh-${id}`,
  payload: {},
});

beforeEach(() => {
  prismaMock.$queryRaw.mockReset();
  prismaMock.webhookJob.update.mockReset().mockResolvedValue(undefined);
  processMock.mockReset().mockResolvedValue(undefined);
});

describe("drainWebhookJobs", () => {
  it("returns zeros and does no work when the queue is empty", async () => {
    prismaMock.$queryRaw.mockResolvedValue([]);
    const r = await drainWebhookJobs();
    expect(r).toEqual({ processed: 0, succeeded: 0, failed: 0 });
    expect(processMock).not.toHaveBeenCalled();
    expect(prismaMock.webhookJob.update).not.toHaveBeenCalled();
  });

  it("processes all claimed jobs and marks them completed", async () => {
    prismaMock.$queryRaw.mockResolvedValue([job("1"), job("2")]);
    const r = await drainWebhookJobs();
    expect(r).toEqual({ processed: 2, succeeded: 2, failed: 0 });
    expect(processMock).toHaveBeenCalledTimes(2);
    expect(prismaMock.webhookJob.update).toHaveBeenCalledTimes(2);
    for (const call of prismaMock.webhookJob.update.mock.calls) {
      expect(call[0].data.status).toBe("completed");
      expect(call[0].data.errorMessage).toBeNull();
    }
  });

  it("isolates a failing job: marks it failed with a message, others still complete", async () => {
    prismaMock.$queryRaw.mockResolvedValue([job("1"), job("2")]);
    processMock
      .mockResolvedValueOnce(undefined) // job 1 ok
      .mockRejectedValueOnce(new Error("boom")); // job 2 throws

    const r = await drainWebhookJobs();
    expect(r).toEqual({ processed: 2, succeeded: 1, failed: 1 });

    const statuses = prismaMock.webhookJob.update.mock.calls.map((c) => c[0].data.status);
    expect(statuses).toContain("completed");
    expect(statuses).toContain("failed");

    const failedCall = prismaMock.webhookJob.update.mock.calls.find(
      (c) => c[0].data.status === "failed",
    );
    expect(failedCall?.[0].where).toEqual({ id: "2" });
    expect(failedCall?.[0].data.errorMessage).toContain("boom");
  });

  it("truncates very long error messages to 500 chars", async () => {
    prismaMock.$queryRaw.mockResolvedValue([job("1")]);
    processMock.mockRejectedValueOnce(new Error("x".repeat(2000)));
    await drainWebhookJobs();
    const failedCall = prismaMock.webhookJob.update.mock.calls[0];
    expect(failedCall[0].data.errorMessage.length).toBe(500);
  });

  it("passes the batch size through to the claim query", async () => {
    prismaMock.$queryRaw.mockResolvedValue([]);
    await drainWebhookJobs(10);
    // Tagged-template call: (stringsArray, ...interpolatedValues)
    const interpolated = prismaMock.$queryRaw.mock.calls[0].slice(1);
    expect(interpolated).toContain(10);
  });
});
