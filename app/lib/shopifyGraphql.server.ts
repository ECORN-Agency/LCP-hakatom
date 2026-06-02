// Wrapper around Shopify Admin GraphQL that adds:
//   1. Retry with exponential backoff on THROTTLED / network errors / 5xx.
//   2. Proactive cost-aware pacing — if Shopify says we're close to the
//      bucket limit (extensions.cost.throttleStatus.currentlyAvailable
//      below a safety margin), sleep until enough budget has restored.
//   3. Structured logging so you can see real cost numbers in Vercel logs.
//
// Use it in place of `admin.graphql(...)` whenever you make Admin API calls
// from server code that might run in a loop or under load.
//
// Reference: https://shopify.dev/docs/api/usage/rate-limits

import { logger } from "../logger.server";

export type AdminGraphqlClient = {
  graphql: (query: string, options?: { variables?: Record<string, any> }) => Promise<Response>;
};

type GraphqlExtensions = {
  cost?: {
    requestedQueryCost?: number;
    actualQueryCost?: number;
    throttleStatus?: {
      maximumAvailable?: number;
      currentlyAvailable?: number;
      restoreRate?: number;
    };
  };
};

type GraphqlResponse<T = any> = {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  extensions?: GraphqlExtensions;
};

export type GraphqlWithRetryOptions = {
  // How many retry attempts before giving up (default 5).
  maxAttempts?: number;
  // Initial backoff in ms; doubles each attempt (default 500 → 1s, 2s, 4s, 8s).
  baseDelayMs?: number;
  // Minimum bucket headroom we want before firing the next request.
  // If currentlyAvailable < safetyMargin, sleep until it restores.
  safetyMargin?: number;
  // Tag for structured logs.
  opName?: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Drop-in replacement for `admin.graphql(...).then(r => r.json())` that
 * retries, paces, and logs cost telemetry.
 */
export async function graphqlWithRetry<T = any>(
  admin: AdminGraphqlClient,
  query: string,
  variables: Record<string, any> = {},
  opts: GraphqlWithRetryOptions = {},
): Promise<GraphqlResponse<T>> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const safetyMargin = opts.safetyMargin ?? 100;
  const opName = opts.opName ?? "anonymous";
  const log = logger.child({ shopifyOp: opName });

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await admin.graphql(query, { variables });

      // HTTP-level throttle (rare for GraphQL but possible).
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get("retry-after") ?? "0", 10);
        const delay = retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** (attempt - 1);
        log.warn({ attempt, status: 429, delayMs: delay }, "HTTP 429, backing off");
        await sleep(delay);
        continue;
      }

      // 5xx — transient, retry with backoff.
      if (response.status >= 500) {
        const delay = baseDelayMs * 2 ** (attempt - 1);
        log.warn({ attempt, status: response.status, delayMs: delay }, "5xx, backing off");
        await sleep(delay);
        continue;
      }

      if (!response.ok) {
        const body = await response.text();
        log.error({ attempt, status: response.status, body }, "non-retryable HTTP error");
        throw new Error(`Shopify GraphQL HTTP ${response.status}: ${body.slice(0, 200)}`);
      }

      const json = (await response.json()) as GraphqlResponse<T>;

      // GraphQL-level THROTTLED — retry with backoff.
      const throttled = (json.errors ?? []).some(
        (e) => e?.extensions?.code === "THROTTLED" ||
          /throttle/i.test(e?.message ?? ""),
      );
      if (throttled) {
        const delay = baseDelayMs * 2 ** (attempt - 1);
        log.warn({ attempt, errors: json.errors, delayMs: delay }, "GraphQL throttled, backing off");
        await sleep(delay);
        continue;
      }

      // Proactive pacing — if we're close to the bucket floor, wait for it
      // to restore before returning. This lets the caller pipe many requests
      // back-to-back without hitting THROTTLED at all.
      const cost = json.extensions?.cost;
      if (cost?.throttleStatus) {
        const { currentlyAvailable = 0, restoreRate = 50 } = cost.throttleStatus;
        if (currentlyAvailable < safetyMargin) {
          const needed = safetyMargin - currentlyAvailable;
          const restoreMs = Math.ceil((needed / restoreRate) * 1000);
          log.info(
            {
              currentlyAvailable,
              safetyMargin,
              restoreMs,
            },
            "cost bucket low, pacing",
          );
          await sleep(restoreMs);
        }
      }

      return json;
    } catch (err) {
      lastError = err;
      // Network-level error — retry with backoff unless it's the last attempt.
      const delay = baseDelayMs * 2 ** (attempt - 1);
      log.warn({ attempt, err: String(err), delayMs: delay }, "graphql call threw, retrying");
      if (attempt < maxAttempts) await sleep(delay);
    }
  }

  throw new Error(
    `Shopify GraphQL failed after ${maxAttempts} attempts (op=${opName}): ${String(lastError ?? "unknown")}`,
  );
}
