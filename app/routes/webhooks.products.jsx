import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const getChangeSummary = (topic, payload) => {
  const topicLower = topic.toLowerCase();
  const summaries = {
    "products/create": (p) => `Product created: ${p.title || p.id || "Unknown"}`,
    "products/update": (p) => {
      // Check if price changed in variants
      const variants = p.variants || p.variant || [];
      if (variants.length > 0) {
        const priceChanges = variants
          .filter(v => v.old_price && v.price && v.old_price !== v.price)
          .map(v => `${v.title || "Default"}: $${v.old_price} → $${v.price}`);
        
        if (priceChanges.length > 0) {
          return `Product updated: ${p.title || p.id || "Unknown"} - Price changes: ${priceChanges.join(", ")}`;
        }
      }
      return `Product updated: ${p.title || p.id || "Unknown"}`;
    },
    "products/delete": (p) => `Product deleted: ${p.title || p.id || "Unknown"}`,
    "products_create": (p) => `Product created: ${p.title || p.id || "Unknown"}`,
    "products_update": (p) => {
      const variants = p.variants || p.variant || [];
      if (variants.length > 0) {
        const priceChanges = variants
          .filter(v => v.old_price && v.price && v.old_price !== v.price)
          .map(v => `${v.title || "Default"}: $${v.old_price} → $${v.price}`);
        
        if (priceChanges.length > 0) {
          return `Product updated: ${p.title || p.id || "Unknown"} - Price changes: ${priceChanges.join(", ")}`;
        }
      }
      return `Product updated: ${p.title || p.id || "Unknown"}`;
    },
    "products_delete": (p) => `Product deleted: ${p.title || p.id || "Unknown"}`,
  };

  const getSummary = summaries[topicLower] || summaries[topic];
  return getSummary ? getSummary(payload) : `Product ${topicLower.includes("create") ? "created" : topicLower.includes("delete") ? "deleted" : "updated"}: ${payload?.title || payload?.id || "Unknown"}`;
};

export const action = async ({ request }) => {
  try {
    const { topic, shop, payload } = await authenticate.webhook(request);

    const changeType = topic.replace(/\//g, "_").toLowerCase();
    const summary = getChangeSummary(topic, payload);
    const entityId = payload?.id ? String(payload.id) : null;

    // Extract change details for products/update
    let changeDetails = null;
    const topicLower = topic.toLowerCase();
    if (topicLower === "products/update" || topicLower === "products_update") {
      const productTitle = payload?.title || payload?.name || "Unknown Product";
      const variants = payload?.variants || payload?.variant || [];
      
      console.log("Products/update webhook received:", {
        productTitle,
        entityId,
        variantsCount: variants.length,
        payloadKeys: Object.keys(payload || {}),
      });
      
      // Try to extract price changes from variants
      // Note: Shopify webhook may not include old_price, so we check multiple possible fields
      const priceChanges = variants
        .filter(v => {
          // Check if price changed (old_price field exists) or if we have both old and new values
          const oldPrice = v.old_price || v.previous_price || v.previous_value?.price;
          const newPrice = v.price || v.new_price || v.current_value?.price;
          return oldPrice && newPrice && oldPrice !== newPrice;
        })
        .map(v => ({
          variantTitle: v.title || "Default",
          oldPrice: v.old_price || v.previous_price || v.previous_value?.price,
          newPrice: v.price || v.new_price || v.current_value?.price,
          variantId: v.id ? String(v.id) : null,
        }));

      // Always create changeDetails for products/update
      changeDetails = {
        productTitle: productTitle,
        productId: entityId,
        field: priceChanges.length > 0 ? "price" : "product",
      };

      if (priceChanges.length > 0) {
        changeDetails.priceChanges = priceChanges;
        console.log("Price changes detected:", priceChanges);
      } else {
        // Store current variant info for reference
        // Even if we don't know what changed, we know the product was updated
        changeDetails.variants = variants.map(v => ({
          variantTitle: v.title || "Default",
          price: v.price,
          variantId: v.id ? String(v.id) : null,
        }));
        console.log("Product updated (no price changes detected), storing product info:", changeDetails);
      }
    }

    // Prepare payload with changeDetails
    const payloadWithDetails = changeDetails 
      ? { ...payload, changeDetails }
      : payload;

    const entityType = changeType.includes("product") ? "product" : changeType.includes("variant") ? "variant" : null;
    
    await prisma.change.create({
      data: {
        shop: shop,
        type: changeType,
        entityType: entityType,
        entityId: entityId,
        summary: summary,
        payload: payloadWithDetails,
        occurredAt: new Date(),
      },
    });
    
    console.log("Change created:", {
      type: changeType,
      summary,
      hasChangeDetails: !!changeDetails,
      changeDetails,
    });

    return new Response(null, { status: 200 });
  } catch (error) {
    console.error("Webhook error:", error);
    return new Response(null, { status: 200 });
  }
};

