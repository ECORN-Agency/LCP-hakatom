import { describe, it, expect, vi } from "vitest";

// metricsBuckets pulls in prisma, the logger and the GraphQL wrapper at import
// time. We only unit-test the pure UTC bucket-normalizer, so stub the rest.
vi.mock("../db.server", () => ({ default: {} }));
vi.mock("../logger.server", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("../lib/shopifyGraphql.server", () => ({ graphqlWithRetry: vi.fn() }));

import { normalizeTo10MinBucketUTC } from "./metricsBuckets.server";

describe("normalizeTo10MinBucketUTC", () => {
  it("floors to the start of the 10-minute bucket", () => {
    const out = normalizeTo10MinBucketUTC(new Date("2026-06-07T17:23:45.678Z"));
    expect(out.toISOString()).toBe("2026-06-07T17:20:00.000Z");
  });

  it("leaves an exact bucket boundary unchanged", () => {
    const out = normalizeTo10MinBucketUTC(new Date("2026-06-07T17:20:00.000Z"));
    expect(out.toISOString()).toBe("2026-06-07T17:20:00.000Z");
  });

  it("zeroes seconds and milliseconds", () => {
    const out = normalizeTo10MinBucketUTC(new Date("2026-06-07T17:29:59.999Z"));
    expect(out.toISOString()).toBe("2026-06-07T17:20:00.000Z");
  });

  it("handles the 00–09 minute range → :00", () => {
    const out = normalizeTo10MinBucketUTC(new Date("2026-06-07T17:07:00.000Z"));
    expect(out.getUTCMinutes()).toBe(0);
  });

  it("does not mutate the input date", () => {
    const input = new Date("2026-06-07T17:23:45.678Z");
    normalizeTo10MinBucketUTC(input);
    expect(input.toISOString()).toBe("2026-06-07T17:23:45.678Z");
  });
});
