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
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { drainWebhookJobs } from "./workerDrain.server";

const job = (id: string, attempts = 1) => ({
  id,
  shop: "s.myshopify.com",
  topic: "orders/create",
  webhookId: `wh-${id}`,
  payload: {},
  attempts,
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
    expect(r).toEqual({ processed: 0, succeeded: 0, failed: 0, retried: 0 });
    expect(processMock).not.toHaveBeenCalled();
    expect(prismaMock.webhookJob.update).not.toHaveBeenCalled();
  });

  it("processes all claimed jobs and marks them completed", async () => {
    prismaMock.$queryRaw.mockResolvedValue([job("1"), job("2")]);
    const r = await drainWebhookJobs();
    expect(r).toEqual({ processed: 2, succeeded: 2, failed: 0, retried: 0 });
    expect(processMock).toHaveBeenCalledTimes(2);
    expect(prismaMock.webhookJob.update).toHaveBeenCalledTimes(2);
    for (const call of prismaMock.webhookJob.update.mock.calls) {
      expect(call[0].data.status).toBe("completed");
      expect(call[0].data.errorMessage).toBeNull();
    }
  });

  it("returns a transient failure (below the attempt cap) to pending for retry (H2)", async () => {
    prismaMock.$queryRaw.mockResolvedValue([job("1", 1), job("2", 1)]);
    processMock
      .mockResolvedValueOnce(undefined) // job 1 ok
      .mockRejectedValueOnce(new Error("boom")); // job 2 transient failure

    const r = await drainWebhookJobs();
    expect(r).toEqual({ processed: 2, succeeded: 1, failed: 0, retried: 1 });

    const retried = prismaMock.webhookJob.update.mock.calls.find(
      (c) => c[0].where.id === "2",
    );
    expect(retried?.[0].data.status).toBe("pending");
    expect(retried?.[0].data.startedAt).toBeNull();
    expect(retried?.[0].data.errorMessage).toContain("boom");
  });

  it("parks a job in failed once it exhausts the attempt cap (H2)", async () => {
    prismaMock.$queryRaw.mockResolvedValue([job("1", 5)]); // 5th attempt
    processMock.mockRejectedValueOnce(new Error("still broken"));

    const r = await drainWebhookJobs();
    expect(r).toEqual({ processed: 1, succeeded: 0, failed: 1, retried: 0 });
    expect(prismaMock.webhookJob.update.mock.calls[0][0].data.status).toBe("failed");
  });

  it("fails a permanent error immediately, regardless of attempt count (H2)", async () => {
    prismaMock.$queryRaw.mockResolvedValue([job("1", 1)]);
    processMock.mockRejectedValueOnce(new Error("unknown webhook topic: foo/bar"));

    const r = await drainWebhookJobs();
    expect(r.failed).toBe(1);
    expect(r.retried).toBe(0);
    expect(prismaMock.webhookJob.update.mock.calls[0][0].data.status).toBe("failed");
  });

  it("truncates very long error messages to 500 chars", async () => {
    prismaMock.$queryRaw.mockResolvedValue([job("1", 5)]); // capped → terminal
    processMock.mockRejectedValueOnce(new Error("x".repeat(2000)));
    await drainWebhookJobs();
    const call = prismaMock.webhookJob.update.mock.calls[0];
    expect(call[0].data.errorMessage.length).toBe(500);
  });

  it("claim query reclaims stale processing rows and passes batch size (H1)", async () => {
    prismaMock.$queryRaw.mockResolvedValue([]);
    await drainWebhookJobs(10);
    const [strings, ...values] = prismaMock.$queryRaw.mock.calls[0];
    const sql = (strings as unknown as string[]).join("?");
    expect(sql).toContain("status = 'processing'");
    expect(sql).toContain("status = 'pending'");
    // Staleness is a SQL interval (timezone-safe), not an interpolated JS Date.
    expect(sql).toContain("NOW() - INTERVAL '5 minutes'");
    expect(values).toContain(10);
    expect(values.some((v) => v instanceof Date)).toBe(false);
  });
});
