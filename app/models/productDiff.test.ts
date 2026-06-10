import { describe, it, expect } from "vitest";
import {
  snapshotFromPayload,
  diffSnapshots,
  summarizeDiff,
  type ProductSnapshot,
} from "./productDiff.server";

describe("snapshotFromPayload", () => {
  it("projects a normal payload, stringifying ids and prices", () => {
    const snap = snapshotFromPayload({
      title: "Tee",
      status: "active",
      variants: [
        { id: 123, title: "S", price: 19.99, compare_at_price: 29.99, inventory_quantity: 5 },
      ],
    });
    expect(snap).toEqual<ProductSnapshot>({
      title: "Tee",
      status: "active",
      variants: [
        { id: "123", title: "S", price: "19.99", compareAtPrice: "29.99", inventoryQuantity: 5 },
      ],
    });
  });

  it("is defensive against missing fields", () => {
    const snap = snapshotFromPayload({});
    expect(snap).toEqual({ title: null, status: null, variants: [] });
  });

  it("handles non-array variants and null inner fields", () => {
    const snap = snapshotFromPayload({ title: "X", variants: null });
    expect(snap.variants).toEqual([]);
    const snap2 = snapshotFromPayload({ variants: [{ id: null }] });
    expect(snap2.variants[0]).toEqual({
      id: "",
      title: null,
      price: null,
      compareAtPrice: null,
      inventoryQuantity: null,
    });
  });

  it("coerces non-numeric inventory_quantity to null", () => {
    const snap = snapshotFromPayload({ variants: [{ id: 1, inventory_quantity: "5" }] });
    expect(snap.variants[0].inventoryQuantity).toBeNull();
  });
});

const mk = (over: Partial<ProductSnapshot> = {}): ProductSnapshot => ({
  title: "Tee",
  status: "active",
  variants: [{ id: "1", title: "S", price: "10.00", compareAtPrice: null, inventoryQuantity: 5 }],
  ...over,
});

describe("diffSnapshots", () => {
  it("no previous snapshot → hasChanges false", () => {
    expect(diffSnapshots(null, mk()).hasChanges).toBe(false);
  });

  it("identical re-send → hasChanges false (ghost update)", () => {
    expect(diffSnapshots(mk(), mk()).hasChanges).toBe(false);
  });

  it("detects title change", () => {
    const d = diffSnapshots(mk(), mk({ title: "Tee v2" }));
    expect(d.hasChanges).toBe(true);
    expect(d.titleChange).toEqual({ old: "Tee", new: "Tee v2" });
  });

  it("detects status change", () => {
    const d = diffSnapshots(mk(), mk({ status: "draft" }));
    expect(d.statusChange).toEqual({ old: "active", new: "draft" });
  });

  it("detects a price change on an existing variant", () => {
    const next = mk({
      variants: [{ id: "1", title: "S", price: "12.00", compareAtPrice: null, inventoryQuantity: 5 }],
    });
    const d = diffSnapshots(mk(), next);
    expect(d.priceChanges).toEqual([
      { variantId: "1", variantTitle: "S", oldPrice: "10.00", newPrice: "12.00" },
    ]);
  });

  it("detects inventory and compare-at changes", () => {
    const next = mk({
      variants: [{ id: "1", title: "S", price: "10.00", compareAtPrice: "20.00", inventoryQuantity: 2 }],
    });
    const d = diffSnapshots(mk(), next);
    expect(d.inventoryChanges?.[0]).toMatchObject({ oldQty: 5, newQty: 2 });
    expect(d.compareAtChanges?.[0]).toMatchObject({ oldPrice: null, newPrice: "20.00" });
  });

  it("ignores brand-new variants (only diffs existing ones)", () => {
    const next = mk({
      variants: [
        { id: "1", title: "S", price: "10.00", compareAtPrice: null, inventoryQuantity: 5 },
        { id: "2", title: "M", price: "11.00", compareAtPrice: null, inventoryQuantity: 9 },
      ],
    });
    expect(diffSnapshots(mk(), next).hasChanges).toBe(false);
  });
});

describe("summarizeDiff", () => {
  it("falls back to generic line when no changes", () => {
    expect(summarizeDiff("Tee", { hasChanges: false })).toBe("Product updated: Tee");
  });

  it("summarizes a single price change inline", () => {
    const s = summarizeDiff("Tee", {
      hasChanges: true,
      priceChanges: [{ variantId: "1", variantTitle: "S", oldPrice: "10.00", newPrice: "12.00" }],
    });
    expect(s).toBe("Product updated: Tee — price 10.00→12.00");
  });

  it("aggregates multi-variant price changes", () => {
    const s = summarizeDiff("Tee", {
      hasChanges: true,
      priceChanges: [
        { variantId: "1", variantTitle: "S", oldPrice: "10", newPrice: "12" },
        { variantId: "2", variantTitle: "M", oldPrice: "11", newPrice: "13" },
      ],
    });
    expect(s).toContain("prices on 2 variants");
  });

  it("combines status + stock parts", () => {
    const s = summarizeDiff("Tee", {
      hasChanges: true,
      statusChange: { old: "active", new: "draft" },
      inventoryChanges: [{ variantId: "1", variantTitle: "S", oldQty: 5, newQty: 0 }],
    });
    expect(s).toContain("status active→draft");
    expect(s).toContain("stock 5→0");
  });
});
