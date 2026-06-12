import { defineConfig } from "vitest/config";

// Integration tests run against a REAL Postgres (booted by
// scripts/with-test-db.mjs, which sets DATABASE_URL before launching vitest).
// They exercise the things mocks can't prove: FOR UPDATE SKIP LOCKED, the
// advisory-lock serialization (H3) and unique-constraint idempotency.
//
// Run via `npm run test:integration` — NOT part of the unit suite or the
// pre-push hook (those stay DB-free and fast).
export default defineConfig({
  test: {
    environment: "node",
    include: ["app/**/*.itest.ts"],
    globals: false,
    // One worker: a single shared Postgres, and tests reset tables between
    // cases. Concurrency within a test (Promise.all) still uses the Prisma
    // connection pool, so SKIP LOCKED / advisory locks are exercised for real.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
