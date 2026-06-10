import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: { $transaction: vi.fn() },
}));

vi.mock("../db.server", () => ({ default: prismaMock }));

import { withAdvisoryLock } from "./dbLock.server";

beforeEach(() => {
  prismaMock.$transaction.mockReset();
});

describe("withAdvisoryLock", () => {
  it("acquires the advisory lock with the given key, then runs the callback", async () => {
    const tx = { $executeRaw: vi.fn().mockResolvedValue(1) };
    prismaMock.$transaction.mockImplementation(async (fn: any) => fn(tx));

    const result = await withAdvisoryLock("theme-agg:shop:1", async () => "done");

    expect(result).toBe("done");
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    // The key is interpolated into the tagged-template SQL.
    const interpolated = tx.$executeRaw.mock.calls[0].slice(1);
    expect(interpolated).toContain("theme-agg:shop:1");
  });

  it("runs everything inside a single transaction (uses the tx client)", async () => {
    const tx = { $executeRaw: vi.fn().mockResolvedValue(1), change: { create: vi.fn() } };
    prismaMock.$transaction.mockImplementation(async (fn: any) => fn(tx));

    await withAdvisoryLock("k", async (t: any) => {
      await t.change.create({ data: {} });
    });

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.change.create).toHaveBeenCalledTimes(1);
  });

  it("acquires the lock before the callback does its work (ordering)", async () => {
    const order: string[] = [];
    const tx = {
      $executeRaw: vi.fn().mockImplementation(async () => { order.push("lock"); }),
    };
    prismaMock.$transaction.mockImplementation(async (fn: any) => fn(tx));

    await withAdvisoryLock("k", async () => { order.push("work"); });

    expect(order).toEqual(["lock", "work"]);
  });
});
