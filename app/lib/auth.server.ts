import { createHash, timingSafeEqual } from "crypto";

// Constant-time check of an incoming `Authorization` header against one or
// more shared secrets in `Bearer <secret>` form. (L1 in code review)
//
// We SHA-256 both sides first so timingSafeEqual always compares equal-length
// buffers (it throws on length mismatch) and the comparison time doesn't leak
// the secret's length. Undefined/empty secrets are skipped — if none are
// configured, every call is rejected.
export function bearerMatches(
  header: string | null | undefined,
  ...secrets: Array<string | undefined>
): boolean {
  if (!header) return false;
  const got = createHash("sha256").update(header).digest();

  let ok = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const want = createHash("sha256").update(`Bearer ${secret}`).digest();
    // Don't short-circuit — keep checking all secrets so timing doesn't depend
    // on which (if any) matched.
    if (timingSafeEqual(got, want)) ok = true;
  }
  return ok;
}
