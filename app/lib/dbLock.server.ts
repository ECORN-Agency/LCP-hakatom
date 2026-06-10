import { Prisma } from "@prisma/client";
import prisma from "../db.server";

// Serialize a read-modify-write critical section across connections/instances
// using a Postgres transaction-scoped advisory lock. The lock is released
// automatically when the surrounding transaction commits or rolls back, so
// there's no leak risk even if the callback throws.
//
// Used to close the theme-aggregation race (H3 in docs/code-review-2026-06.md):
// two concurrent invocations (webhook themes/update + cron poll, or two polls)
// would each find-or-create the open `theme_files_updated` row, producing
// duplicate rows or lost updates. Wrapping the find+upsert in this lock makes
// the section run one-at-a-time per (shop, themeId).
//
// The callback receives the transaction client `tx` — all reads/writes in the
// critical section MUST use it (not the global prisma) so they share the same
// transaction and lock scope.
export async function withAdvisoryLock<T>(
  key: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // hashtextextended → stable bigint from an arbitrary string key.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    return fn(tx);
  });
}
