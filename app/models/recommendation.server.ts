// This file used to contain a copy of buildRecommendation.
// The canonical implementation now lives in ./recommendation.ts (no .server suffix),
// so the same pure function can be imported from both server loaders and React components.
// Kept as a re-export shim for backwards-compat — safe to delete with `git rm` once
// nothing imports `recommendation.server` anymore (currently nothing does).

export { buildRecommendation } from "./recommendation";
