// Compute a structured diff between a freshly arrived Shopify product payload
// and the last known snapshot we stored. Used by webhooks/products to:
//   1. Skip "ghost" updates (Shopify re-sends the same state).
//   2. Build a human-readable summary of what actually changed.
//   3. Hand a rich eventContext to the recommendation engine.
//
// We intentionally diff only the fields that drive merchant decisions:
// price, compareAtPrice, inventory quantity, status, title.
// Add more (tags, productType, descriptionHtml, …) as the product surfaces them.

export type VariantSlim = {
  id: string;
  title: string | null;
  price: string | null;
  compareAtPrice: string | null;
  inventoryQuantity: number | null;
};

export type ProductSnapshot = {
  title: string | null;
  status: string | null;
  variants: VariantSlim[];
};

export type PriceChange = {
  variantId: string;
  variantTitle: string | null;
  oldPrice: string | null;
  newPrice: string | null;
};

export type InventoryChange = {
  variantId: string;
  variantTitle: string | null;
  oldQty: number | null;
  newQty: number | null;
};

export type ProductDiff = {
  hasChanges: boolean;
  titleChange?: { old: string | null; new: string | null };
  statusChange?: { old: string | null; new: string | null };
  priceChanges?: PriceChange[];
  inventoryChanges?: InventoryChange[];
  compareAtChanges?: PriceChange[];
};

/**
 * Project a Shopify products webhook payload down to the slim shape we store.
 * Defensive against missing / renamed fields — Shopify's product webhook
 * payloads have drifted across API versions.
 */
export function snapshotFromPayload(payload: any): ProductSnapshot {
  const rawVariants = Array.isArray(payload?.variants) ? payload.variants : [];

  return {
    title: payload?.title ?? null,
    status: payload?.status ?? null,
    variants: rawVariants.map((v: any): VariantSlim => ({
      id: v?.id != null ? String(v.id) : "",
      title: v?.title ?? null,
      price: v?.price != null ? String(v.price) : null,
      compareAtPrice: v?.compare_at_price != null ? String(v.compare_at_price) : null,
      inventoryQuantity:
        typeof v?.inventory_quantity === "number" ? v.inventory_quantity : null,
    })),
  };
}

/**
 * Compare new vs old slim snapshot. Returns hasChanges=false when payload is
 * a pure re-send (Shopify sometimes fires multiple identical updates).
 */
export function diffSnapshots(
  prev: ProductSnapshot | null,
  next: ProductSnapshot,
): ProductDiff {
  if (!prev) {
    // No history yet — caller decides whether to suppress the Change row or
    // log it as "first observation".
    return { hasChanges: false };
  }

  const diff: ProductDiff = { hasChanges: false };

  if (prev.title !== next.title) {
    diff.titleChange = { old: prev.title, new: next.title };
    diff.hasChanges = true;
  }

  if (prev.status !== next.status) {
    diff.statusChange = { old: prev.status, new: next.status };
    diff.hasChanges = true;
  }

  const prevById = new Map(prev.variants.map((v) => [v.id, v]));

  const priceChanges: PriceChange[] = [];
  const compareAtChanges: PriceChange[] = [];
  const inventoryChanges: InventoryChange[] = [];

  for (const v of next.variants) {
    const p = prevById.get(v.id);
    if (!p) continue; // new variant — not treated as a change-of-existing here

    if (p.price !== v.price) {
      priceChanges.push({
        variantId: v.id,
        variantTitle: v.title,
        oldPrice: p.price,
        newPrice: v.price,
      });
    }
    if (p.compareAtPrice !== v.compareAtPrice) {
      compareAtChanges.push({
        variantId: v.id,
        variantTitle: v.title,
        oldPrice: p.compareAtPrice,
        newPrice: v.compareAtPrice,
      });
    }
    if (p.inventoryQuantity !== v.inventoryQuantity) {
      inventoryChanges.push({
        variantId: v.id,
        variantTitle: v.title,
        oldQty: p.inventoryQuantity,
        newQty: v.inventoryQuantity,
      });
    }
  }

  if (priceChanges.length > 0) {
    diff.priceChanges = priceChanges;
    diff.hasChanges = true;
  }
  if (compareAtChanges.length > 0) {
    diff.compareAtChanges = compareAtChanges;
    diff.hasChanges = true;
  }
  if (inventoryChanges.length > 0) {
    diff.inventoryChanges = inventoryChanges;
    diff.hasChanges = true;
  }

  return diff;
}

/**
 * Human-readable one-line summary, used as Change.summary.
 * Falls back to a generic message if the diff is empty.
 */
export function summarizeDiff(productTitle: string, diff: ProductDiff): string {
  if (!diff.hasChanges) {
    return `Product updated: ${productTitle}`;
  }

  const parts: string[] = [];

  if (diff.statusChange) {
    parts.push(`status ${diff.statusChange.old ?? "?"}→${diff.statusChange.new ?? "?"}`);
  }
  if (diff.titleChange) {
    parts.push(`title changed`);
  }
  if (diff.priceChanges && diff.priceChanges.length > 0) {
    if (diff.priceChanges.length === 1) {
      const c = diff.priceChanges[0];
      parts.push(`price ${c.oldPrice ?? "?"}→${c.newPrice ?? "?"}`);
    } else {
      parts.push(`prices on ${diff.priceChanges.length} variants`);
    }
  }
  if (diff.inventoryChanges && diff.inventoryChanges.length > 0) {
    if (diff.inventoryChanges.length === 1) {
      const c = diff.inventoryChanges[0];
      parts.push(`stock ${c.oldQty ?? "?"}→${c.newQty ?? "?"}`);
    } else {
      parts.push(`stock on ${diff.inventoryChanges.length} variants`);
    }
  }
  if (diff.compareAtChanges && diff.compareAtChanges.length > 0) {
    parts.push(`compare-at price`);
  }

  return `Product updated: ${productTitle} — ${parts.join(", ")}`;
}
