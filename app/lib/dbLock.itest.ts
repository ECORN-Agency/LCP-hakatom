import { describe, it, expect, beforeEach, afterAll } from "vitest";
import prisma from "../db.server";
import { withAdvisoryLock } from "./dbLock.server";

// Integration: proves the advisory lock actually serializes a read-modify-write
// across concurrent connections (the H3 fix). We run the find-or-increment
// critical section N times in parallel; with the lock it must collapse to a
// single row whose counter equals N. Without the lock, concurrent callers
// would each see "no row yet" and insert duplicates / lose increments.

const SHOP = "lock-itest.myshopify.com";

async function findOrIncrement() {
  await withAdvisoryLock(`itest-agg:${SHOP}`, async (tx) => {
    const open = await tx.change.findFirst({
      where: { shop: SHOP, type: "theme_files_updated" },
    });
    if (!open) {
      await tx.change.create({
        data: {
          shop: SHOP,
          type: "theme_files_updated",
          occurredAt: new Date(),
          summary: "agg",
          payload: { changeDetails: { updateCount: 1 } },
        },
      });
    } else {
      const cd: any = (open.payload as any)?.changeDetails ?? {};
      await tx.change.update({
        where: { id: open.id },
        data: { payload: { changeDetails: { updateCount: (cd.updateCount ?? 1) + 1 } } },
      });
    }
  });
}

beforeEach(async () => {
  await prisma.change.deleteMany({ where: { shop: SHOP } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("withAdvisoryLock (integration)", () => {
  it("serializes concurrent find-or-increment into one row (H3)", async () => {
    const N = 8;
    await Promise.all(Array.from({ length: N }, () => findOrIncrement()));

    const rows = await prisma.change.findMany({
      where: { shop: SHOP, type: "theme_files_updated" },
    });
    expect(rows).toHaveLength(1);
    expect((rows[0].payload as any).changeDetails.updateCount).toBe(N);
  });

  it("releases the lock so a second batch continues from committed state", async () => {
    await findOrIncrement();
    await Promise.all(Array.from({ length: 4 }, () => findOrIncrement()));

    const rows = await prisma.change.findMany({
      where: { shop: SHOP, type: "theme_files_updated" },
    });
    expect(rows).toHaveLength(1);
    expect((rows[0].payload as any).changeDetails.updateCount).toBe(5);
  });
});
