import { useState } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { resetAndReactivatePixel } from "../models/pixelActivation.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const [rules, recentDeliveries, shopConfig] = await Promise.all([
    prisma.alertRule.findMany({
      where: { shop: session.shop },
      orderBy: { createdAt: "desc" },
    }),
    prisma.alertDelivery.findMany({
      where: { shop: session.shop, status: { in: ["sent", "failed"] } },
      orderBy: { deliveredAt: "desc" },
      take: 20,
    }),
    prisma.shopConfig.findUnique({ where: { shop: session.shop } }),
  ]);

  return { rules, recentDeliveries, shopConfig };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "reactivate_pixel") {
    const result = await resetAndReactivatePixel({ shop: session.shop, admin });
    return { ok: result.activated, error: result.activated ? null : result.error };
  }

  if (intent === "create") {
    const destination = String(formData.get("destination") || "").trim();
    if (!destination) {
      return { ok: false, error: "Destination email is required" };
    }
    await prisma.alertRule.create({
      data: {
        shop: session.shop,
        channel: "email",
        destination,
        minLabel: String(formData.get("minLabel") || "strong_negative"),
        minConfidence: String(formData.get("minConfidence") || "medium"),
        evaluationDelayMin: parseInt(String(formData.get("evaluationDelayMin") || "30"), 10),
        windowMinutes: parseInt(String(formData.get("windowMinutes") || "1440"), 10),
        enabled: true,
      },
    });
    return { ok: true };
  }

  if (intent === "toggle") {
    const id = String(formData.get("id"));
    const current = await prisma.alertRule.findUnique({ where: { id } });
    if (current && current.shop === session.shop) {
      await prisma.alertRule.update({
        where: { id },
        data: { enabled: !current.enabled },
      });
    }
    return { ok: true };
  }

  if (intent === "delete") {
    const id = String(formData.get("id"));
    const current = await prisma.alertRule.findUnique({ where: { id } });
    if (current && current.shop === session.shop) {
      await prisma.alertRule.delete({ where: { id } });
    }
    return { ok: true };
  }

  return { ok: false, error: "Unknown intent" };
};

export default function Alerts() {
  const { rules, recentDeliveries, shopConfig } = useLoaderData();
  const createFetcher = useFetcher();
  const toggleFetcher = useFetcher();
  const deleteFetcher = useFetcher();
  const pixelFetcher = useFetcher();

  const handleReactivatePixel = () => {
    pixelFetcher.submit({ intent: "reactivate_pixel" }, { method: "POST" });
  };

  const [destination, setDestination] = useState("");
  const [minLabel, setMinLabel] = useState("strong_negative");
  const [minConfidence, setMinConfidence] = useState("medium");
  const [windowMinutes, setWindowMinutes] = useState(1440);
  const [evaluationDelayMin, setEvaluationDelayMin] = useState(30);

  const handleCreate = () => {
    if (!destination.trim()) return;
    createFetcher.submit(
      {
        intent: "create",
        destination,
        minLabel,
        minConfidence,
        windowMinutes: String(windowMinutes),
        evaluationDelayMin: String(evaluationDelayMin),
      },
      { method: "POST" },
    );
    setDestination("");
  };

  const handleToggle = (id) => {
    toggleFetcher.submit({ intent: "toggle", id }, { method: "POST" });
  };

  const handleDelete = (id) => {
    if (!confirm("Delete this alert rule?")) return;
    deleteFetcher.submit({ intent: "delete", id }, { method: "POST" });
  };

  const formatWindow = (mins) => {
    if (mins >= 1440) return `${mins / 1440}d`;
    if (mins >= 60) return `${mins / 60}h`;
    return `${mins}m`;
  };

  return (
    <s-page id="alerts-page" heading="Alerts">
      <s-section id="pixel-status-section" heading="Storefront pixel">
        <s-box padding="base" background="base" borderWidth="base" borderColor="base" borderRadius="base">
          <s-stack gap="small">
            <s-stack direction="inline" justifyContent="space-between" alignItems="center">
              <s-text type="strong">Web Pixel activation</s-text>
              {shopConfig?.pixelActivatedAt ? (
                <s-badge tone="success">Active</s-badge>
              ) : shopConfig?.pixelLastError ? (
                <s-badge tone="critical">Failed</s-badge>
              ) : (
                <s-badge tone="warning">Not active yet</s-badge>
              )}
            </s-stack>
            <s-text color="subdued">
              {shopConfig?.pixelActivatedAt
                ? `Activated ${new Date(shopConfig.pixelActivatedAt).toLocaleString()}. Storefront events flow into PixelEvent in real time. Pixel ID: ${shopConfig.pixelId ?? "n/a"}.`
                : shopConfig?.pixelLastError
                  ? `Last attempt failed: ${shopConfig.pixelLastError}`
                  : "The pixel will activate automatically the next time the app loader runs. Use the button below to force it now."}
            </s-text>
            <s-stack direction="inline" gap="small">
              <s-button
                variant="secondary"
                onClick={handleReactivatePixel}
                loading={pixelFetcher.state !== "idle"}
              >
                {shopConfig?.pixelActivatedAt ? "Re-activate pixel" : "Activate pixel now"}
              </s-button>
              {pixelFetcher.data?.error && (
                <s-badge tone="critical">{pixelFetcher.data.error}</s-badge>
              )}
              {pixelFetcher.data?.ok && (
                <s-badge tone="success">Pixel activated</s-badge>
              )}
            </s-stack>
          </s-stack>
        </s-box>
      </s-section>

      <s-section id="alerts-intro-section" heading="How alerts work">
        <s-box padding="base" background="base" borderWidth="base" borderColor="base" borderRadius="base">
          <s-stack gap="small">
            <s-text>
              When a Shopify event lands in your store, the alert worker waits a bit (so
              there's after-window data), computes the recommendation, and if it crosses
              your threshold it sends you an email.
            </s-text>
            <s-text color="subdued" type="subdued">
              The cron runs every 15 minutes. Email delivery uses Resend — set
              <code> RESEND_API_KEY</code> and <code> ALERT_FROM_EMAIL</code> in Vercel
              env vars to actually receive mail. Without those, the rule still records
              but nothing is sent.
            </s-text>
          </s-stack>
        </s-box>
      </s-section>

      <s-section id="alerts-new-section" heading="New alert rule">
        <s-box padding="base" background="base" borderWidth="base" borderColor="base" borderRadius="base">
          <s-stack gap="base">
            <s-text-field
              id="alerts-destination"
              label="Send email to"
              value={destination}
              onInput={(e) => setDestination(e.currentTarget.value)}
              placeholder="alerts@your-domain.com"
              type="email"
            />

            <s-stack gap="small">
              <s-text type="strong">Trigger when label is at least:</s-text>
              <s-stack direction="inline" gap="small">
                {[
                  { value: "any", label: "Any change" },
                  { value: "negative", label: "Negative" },
                  { value: "strong_negative", label: "Strong negative (recommended)" },
                ].map((opt) => (
                  <s-button
                    key={`lbl-${opt.value}`}
                    variant={minLabel === opt.value ? "primary" : "secondary"}
                    onClick={() => setMinLabel(opt.value)}
                  >
                    {opt.label}
                  </s-button>
                ))}
              </s-stack>
            </s-stack>

            <s-stack gap="small">
              <s-text type="strong">…and confidence at least:</s-text>
              <s-stack direction="inline" gap="small">
                {["low", "medium", "high"].map((c) => (
                  <s-button
                    key={`conf-${c}`}
                    variant={minConfidence === c ? "primary" : "secondary"}
                    onClick={() => setMinConfidence(c)}
                  >
                    {c[0].toUpperCase() + c.slice(1)}
                  </s-button>
                ))}
              </s-stack>
            </s-stack>

            <s-stack gap="small">
              <s-text type="strong">Comparison window:</s-text>
              <s-stack direction="inline" gap="small">
                {[60, 360, 1440].map((mins) => (
                  <s-button
                    key={`win-${mins}`}
                    variant={windowMinutes === mins ? "primary" : "secondary"}
                    onClick={() => setWindowMinutes(mins)}
                  >
                    {formatWindow(mins)}
                  </s-button>
                ))}
              </s-stack>
            </s-stack>

            <s-stack gap="small">
              <s-text type="strong">Evaluate this many minutes after the event:</s-text>
              <s-stack direction="inline" gap="small">
                {[15, 30, 60, 120].map((mins) => (
                  <s-button
                    key={`delay-${mins}`}
                    variant={evaluationDelayMin === mins ? "primary" : "secondary"}
                    onClick={() => setEvaluationDelayMin(mins)}
                  >
                    {mins}m
                  </s-button>
                ))}
              </s-stack>
              <s-text color="subdued" type="subdued">
                Should be ≤ the comparison window so there's after-event data when we
                evaluate.
              </s-text>
            </s-stack>

            <s-button
              variant="primary"
              onClick={handleCreate}
              loading={createFetcher.state !== "idle"}
              disabled={!destination.trim()}
            >
              Create alert rule
            </s-button>
            {createFetcher.data?.error && (
              <s-badge tone="critical">{createFetcher.data.error}</s-badge>
            )}
          </s-stack>
        </s-box>
      </s-section>

      <s-section id="alerts-rules-section" heading={`Active rules (${rules.length})`}>
        {rules.length === 0 ? (
          <s-box padding="large" background="base" borderWidth="base" borderColor="base" borderRadius="base">
            <s-text alignment="center" color="subdued">
              No alert rules yet. Add one above to start receiving notifications.
            </s-text>
          </s-box>
        ) : (
          <s-stack gap="small">
            {rules.map((rule) => (
              <s-box
                key={rule.id}
                padding="base"
                background="base"
                borderWidth="base"
                borderColor="base"
                borderRadius="base"
              >
                <s-stack gap="small">
                  <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                    <s-stack direction="inline" gap="small" alignItems="center">
                      <s-badge tone={rule.enabled ? "success" : "neutral"}>
                        {rule.enabled ? "Enabled" : "Paused"}
                      </s-badge>
                      <s-text type="strong">{rule.destination}</s-text>
                    </s-stack>
                    <s-stack direction="inline" gap="small">
                      <s-button variant="secondary" onClick={() => handleToggle(rule.id)}>
                        {rule.enabled ? "Pause" : "Resume"}
                      </s-button>
                      <s-button variant="secondary" onClick={() => handleDelete(rule.id)}>
                        Delete
                      </s-button>
                    </s-stack>
                  </s-stack>
                  <s-text color="subdued">
                    Fires on <strong>{rule.minLabel}</strong> recommendations with{" "}
                    <strong>{rule.minConfidence}+</strong> confidence,{" "}
                    {formatWindow(rule.windowMinutes)} window, evaluated{" "}
                    {rule.evaluationDelayMin}m after each event.
                  </s-text>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section id="alerts-deliveries-section" heading="Recent deliveries">
        {recentDeliveries.length === 0 ? (
          <s-box padding="large" background="base" borderWidth="base" borderColor="base" borderRadius="base">
            <s-text alignment="center" color="subdued">
              No alerts have fired yet. Once an event triggers a matching recommendation, it will land here.
            </s-text>
          </s-box>
        ) : (
          <s-stack gap="small">
            {recentDeliveries.map((d) => (
              <s-box key={d.id} padding="base" background="base" borderWidth="base" borderColor="base" borderRadius="base">
                <s-stack gap="small">
                  <s-stack direction="inline" gap="small" alignItems="center" justifyContent="space-between">
                    <s-text type="strong">{d.destination}</s-text>
                    <s-badge tone={d.status === "sent" ? "success" : "critical"}>{d.status}</s-badge>
                  </s-stack>
                  <s-text color="subdued">
                    {new Date(d.deliveredAt).toLocaleString()}
                    {d.errorMessage ? ` — ${d.errorMessage}` : ""}
                  </s-text>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}
