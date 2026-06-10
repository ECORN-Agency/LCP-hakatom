import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks --------------------------------------------------------------
// Hoisted so the vi.mock factories below can reference them safely.
const { prismaMock, adminMock } = vi.hoisted(() => {
  const model = () => ({
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    upsert: vi.fn(),
  });
  return {
    prismaMock: {
      change: model(),
      productSnapshot: model(),
      themeSnapshot: model(),
    },
    adminMock: vi.fn(),
  };
});

vi.mock("../db.server", () => ({ default: prismaMock }));
vi.mock("../shopify.server", () => ({ unauthenticated: { admin: adminMock } }));
vi.mock("../logger.server", () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
  },
}));

import { processWebhookJob } from "./webhookProcessors.server";

beforeEach(() => {
  for (const m of Object.values(prismaMock)) {
    for (const fn of Object.values(m)) {
      fn.mockReset();
      fn.mockResolvedValue(undefined);
    }
  }
  // Sensible defaults: nothing found, writes succeed.
  prismaMock.change.findFirst.mockResolvedValue(null);
  prismaMock.change.create.mockResolvedValue({ id: "change-1" });
  prismaMock.productSnapshot.findUnique.mockResolvedValue(null);
  prismaMock.themeSnapshot.findUnique.mockResolvedValue(null);
  adminMock.mockReset();
});

// --- Dispatch -----------------------------------------------------------
describe("processWebhookJob — dispatch & topic normalization", () => {
  it("throws on an unknown topic", async () => {
    await expect(
      processWebhookJob({ shop: "s", topic: "foo/bar", webhookId: "w", payload: {} }),
    ).rejects.toThrow(/unknown webhook topic/);
  });

  it("normalizes UPPER_SNAKE topics (ORDERS_CREATE → orders/create)", async () => {
    await processWebhookJob({
      shop: "s",
      topic: "ORDERS_CREATE",
      webhookId: "w",
      payload: { id: 1, order_number: 1001 },
    });
    expect(prismaMock.change.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.change.create.mock.calls[0][0].data.type).toBe("orders_create");
  });
});

// --- Orders dedup -------------------------------------------------------
describe("processOrderJob — create/updated dedup", () => {
  it("records a normal order create", async () => {
    await processWebhookJob({
      shop: "s",
      topic: "orders/create",
      webhookId: "w",
      payload: { id: 7, order_number: 1007, created_at: "2026-06-07T10:00:00Z" },
    });
    const data = prismaMock.change.create.mock.calls[0][0].data;
    expect(data.type).toBe("orders_create");
    expect(data.entityId).toBe("7");
    expect(prismaMock.change.delete).not.toHaveBeenCalled();
  });

  it("suppresses orders/updated that immediately follows a create", async () => {
    // recentCreate lookup returns a row → early return, no new Change.
    prismaMock.change.findFirst.mockResolvedValueOnce({ id: "c-create" });
    await processWebhookJob({
      shop: "s",
      topic: "orders/updated",
      webhookId: "w",
      payload: { id: 7, order_number: 1007 },
    });
    expect(prismaMock.change.create).not.toHaveBeenCalled();
  });

  it("orders/create replaces a just-seen orders_updated (deletes it, then creates)", async () => {
    prismaMock.change.findFirst.mockResolvedValueOnce({ id: "c-updated" });
    await processWebhookJob({
      shop: "s",
      topic: "orders/create",
      webhookId: "w",
      payload: { id: 7, order_number: 1007 },
    });
    expect(prismaMock.change.delete).toHaveBeenCalledWith({ where: { id: "c-updated" } });
    expect(prismaMock.change.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.change.create.mock.calls[0][0].data.type).toBe("orders_create");
  });

  it("anchors the dedup window on the order's created_at, not Date.now() (M1)", async () => {
    const createdAt = "2020-01-01T00:00:00.000Z"; // far in the past
    await processWebhookJob({
      shop: "s",
      topic: "orders/create",
      webhookId: "w",
      payload: { id: 7, order_number: 1007, created_at: createdAt },
    });
    const where = prismaMock.change.findFirst.mock.calls[0][0].where;
    // Window = created_at ± 10s, independent of wall clock.
    expect(where.occurredAt.gte.toISOString()).toBe("2019-12-31T23:59:50.000Z");
    expect(where.occurredAt.lte.toISOString()).toBe("2020-01-01T00:00:10.000Z");
  });
});

// --- Products -----------------------------------------------------------
const productPayload = (over: Record<string, unknown> = {}) => ({
  id: 10,
  title: "Tee",
  status: "active",
  variants: [
    { id: 1, title: "S", price: "10.00", compare_at_price: null, inventory_quantity: 5 },
  ],
  ...over,
});

const storedSnapshot = (priceOver?: string) => ({
  snapshot: {
    title: "Tee",
    status: "active",
    variants: [
      {
        id: "1",
        title: "S",
        price: priceOver ?? "10.00",
        compareAtPrice: null,
        inventoryQuantity: 5,
      },
    ],
  },
});

describe("processProductJob", () => {
  it("delete removes the snapshot and records a delete Change", async () => {
    prismaMock.productSnapshot.delete.mockResolvedValue(undefined);
    await processWebhookJob({
      shop: "s",
      topic: "products/delete",
      webhookId: "w",
      payload: productPayload(),
    });
    expect(prismaMock.productSnapshot.delete).toHaveBeenCalled();
    expect(prismaMock.change.create.mock.calls[0][0].data.type).toBe("products_delete");
  });

  it("create upserts a snapshot and records a create Change", async () => {
    await processWebhookJob({
      shop: "s",
      topic: "products/create",
      webhookId: "w",
      payload: productPayload(),
    });
    expect(prismaMock.productSnapshot.upsert).toHaveBeenCalled();
    expect(prismaMock.change.create.mock.calls[0][0].data.type).toBe("products_create");
  });

  it("update with no prior snapshot records a first-observation Change", async () => {
    prismaMock.productSnapshot.findUnique.mockResolvedValue(null);
    await processWebhookJob({
      shop: "s",
      topic: "products/update",
      webhookId: "w",
      payload: productPayload(),
    });
    const data = prismaMock.change.create.mock.calls[0][0].data;
    expect(data.payload.changeDetails.firstObservation).toBe(true);
  });

  it("update that matches the stored snapshot is suppressed (ghost update)", async () => {
    prismaMock.productSnapshot.findUnique.mockResolvedValue(storedSnapshot());
    await processWebhookJob({
      shop: "s",
      topic: "products/update",
      webhookId: "w",
      payload: productPayload(),
    });
    expect(prismaMock.change.create).not.toHaveBeenCalled();
  });

  it("update with a real price change records a Change with a price summary", async () => {
    prismaMock.productSnapshot.findUnique.mockResolvedValue(storedSnapshot("8.00"));
    await processWebhookJob({
      shop: "s",
      topic: "products/update",
      webhookId: "w",
      payload: productPayload(),
    });
    const data = prismaMock.change.create.mock.calls[0][0].data;
    expect(data.type).toBe("products_update");
    expect(data.summary).toContain("price 8.00→10.00");
  });
});

// --- Themes -------------------------------------------------------------
describe("processThemeJob", () => {
  it("skips non-main themes entirely", async () => {
    await processWebhookJob({
      shop: "s",
      topic: "themes/publish",
      webhookId: "w",
      payload: { id: 99, role: "unpublished", name: "Draft" },
    });
    expect(prismaMock.change.create).not.toHaveBeenCalled();
  });

  it("records theme_published for a main theme with no recent history", async () => {
    await processWebhookJob({
      shop: "s",
      topic: "themes/publish",
      webhookId: "w",
      payload: { id: 99, role: "main", name: "Dawn", updated_at: "2026-06-07T10:00:00Z" },
    });
    const data = prismaMock.change.create.mock.calls[0][0].data;
    expect(data.type).toBe("theme_published");
    expect(data.summary).toContain("Dawn");
  });

  it("suppresses a duplicate theme publish within the dedup window", async () => {
    prismaMock.change.findFirst.mockResolvedValueOnce({ type: "theme_published" });
    await processWebhookJob({
      shop: "s",
      topic: "themes/publish",
      webhookId: "w",
      payload: { id: 99, role: "main", name: "Dawn" },
    });
    expect(prismaMock.change.create).not.toHaveBeenCalled();
  });

  it("anchors the publish dedup window on the event's updated_at (M1)", async () => {
    await processWebhookJob({
      shop: "s",
      topic: "themes/publish",
      webhookId: "w",
      payload: { id: 99, role: "main", name: "Dawn", updated_at: "2020-01-01T00:00:00.000Z" },
    });
    const where = prismaMock.change.findFirst.mock.calls[0][0].where;
    expect(where.occurredAt.gte.toISOString()).toBe("2019-12-31T23:59:00.000Z"); // -60s
    expect(where.occurredAt.lte.toISOString()).toBe("2020-01-01T00:01:00.000Z"); // +60s
  });

  it("suppresses the themes/update double-fire right after a publish", async () => {
    prismaMock.change.findFirst.mockResolvedValueOnce({ type: "theme_published" });
    await processWebhookJob({
      shop: "s",
      topic: "themes/update",
      webhookId: "w",
      payload: { id: 99, role: "main", name: "Dawn" },
    });
    expect(prismaMock.change.create).not.toHaveBeenCalled();
    expect(adminMock).not.toHaveBeenCalled();
  });
});
