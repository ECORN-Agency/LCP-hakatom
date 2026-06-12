import { describe, it, expect, beforeEach, afterAll } from "vitest";
import prisma from "../db.server";
import { drainWebhookJobs } from "./workerDrain.server";

// Integration: real Postgres (booted by scripts/with-test-db.mjs). Exercises
// FOR UPDATE SKIP LOCKED, the stale-processing reclaim (H1) and permanent
// failure handling (H2) — none of which a mocked prisma can prove.

function order(n: number) {
  return {
    shop: "s.myshopify.com",
    topic: "orders/create",
    webhookId: `wh-${n}-${Math.random()}`,
    payload: { id: n, order_number: 1000 + n, created_at: "2026-06-07T10:00:00Z" },
    status: "pending",
  };
}

beforeEach(async () => {
  await prisma.change.deleteMany();
  await prisma.webhookJob.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("drainWebhookJobs (integration)", () => {
  it("processes pending jobs, writes Change rows and marks them completed", async () => {
    await prisma.webhookJob.createMany({ data: [order(1), order(2), order(3)] });

    const r = await drainWebhookJobs();

    expect(r.processed).toBe(3);
    expect(r.succeeded).toBe(3);
    expect(await prisma.change.count({ where: { type: "orders_create" } })).toBe(3);
    expect(await prisma.webhookJob.count({ where: { status: "completed" } })).toBe(3);
  });

  it("never double-processes under concurrent drains (FOR UPDATE SKIP LOCKED)", async () => {
    await prisma.webhookJob.createMany({
      data: Array.from({ length: 8 }, (_, i) => order(i + 1)),
    });

    const [a, b] = await Promise.all([drainWebhookJobs(), drainWebhookJobs()]);

    // Every job claimed exactly once across the two concurrent workers.
    expect(a.processed + b.processed).toBe(8);
    expect(await prisma.change.count({ where: { type: "orders_create" } })).toBe(8);
    expect(await prisma.webhookJob.count({ where: { status: "pending" } })).toBe(0);
    expect(await prisma.webhookJob.count({ where: { status: "completed" } })).toBe(8);
  });

  it("reclaims a stale 'processing' job but leaves a fresh one alone (H1)", async () => {
    const stale = await prisma.webhookJob.create({
      data: { ...order(1), status: "processing", attempts: 1 },
    });
    const fresh = await prisma.webhookJob.create({
      data: { ...order(2), status: "processing", attempts: 1 },
    });
    // Set startedAt with SQL NOW() (same convention the worker writes with), so
    // the comparison is timezone-consistent: stale = 6 min ago, fresh = now.
    await prisma.$executeRaw`UPDATE "WebhookJob" SET "startedAt" = NOW() - INTERVAL '6 minutes' WHERE id = ${stale.id}`;
    await prisma.$executeRaw`UPDATE "WebhookJob" SET "startedAt" = NOW() WHERE id = ${fresh.id}`;

    const r = await drainWebhookJobs();

    expect(r.processed).toBe(1); // only the stale one reclaimed
    expect(r.succeeded).toBe(1);
    expect(await prisma.webhookJob.count({ where: { status: "completed" } })).toBe(1);
    expect(await prisma.webhookJob.count({ where: { status: "processing" } })).toBe(1);
  });

  it("permanently fails an unknown topic without retrying (H2)", async () => {
    await prisma.webhookJob.create({
      data: {
        shop: "s.myshopify.com",
        topic: "weird/topic",
        webhookId: `wh-weird-${Math.random()}`,
        payload: {},
        status: "pending",
        attempts: 0,
      },
    });

    const r = await drainWebhookJobs();

    expect(r.failed).toBe(1);
    expect(r.retried).toBe(0);
    const job = await prisma.webhookJob.findFirst({ where: { topic: "weird/topic" } });
    expect(job?.status).toBe("failed");
    expect(job?.errorMessage).toContain("unknown webhook topic");
  });

  it("enforces webhookId uniqueness — duplicate enqueue rejected (idempotency)", async () => {
    const dupe = order(1);
    await prisma.webhookJob.create({ data: dupe });
    await expect(prisma.webhookJob.create({ data: { ...dupe } })).rejects.toMatchObject({
      code: "P2002",
    });
  });
});
