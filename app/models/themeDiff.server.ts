// Theme file diff util. Shopify's themes/update webhook only tells us the
// theme changed — not which files. We pull the current file list (filename
// + md5 + updatedAt, no body) from Admin GraphQL and compare against the
// previous snapshot to detect added / modified / removed files.

import { graphqlWithRetry, type AdminGraphqlClient } from "../lib/shopifyGraphql.server";

export type ThemeFile = {
  filename: string;
  checksumMd5: string;
  updatedAt: string;
  size: string;
};

export type ThemeFileDiff = {
  added: string[];
  modified: string[];
  removed: string[];
  hasChanges: boolean;
};

const THEME_FILES_QUERY = `#graphql
  query ThemeFiles($themeId: ID!, $first: Int!, $after: String) {
    theme(id: $themeId) {
      files(first: $first, after: $after) {
        edges {
          node {
            filename
            checksumMd5
            updatedAt
            size
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

const MAX_PAGES = 30; // 50 files/page × 30 = 1500 files cap (safe upper bound)
const PAGE_SIZE = 50;

export async function fetchThemeFiles(
  admin: AdminGraphqlClient,
  themeId: string,
): Promise<ThemeFile[]> {
  const gid = themeId.startsWith("gid://")
    ? themeId
    : `gid://shopify/OnlineStoreTheme/${themeId}`;

  const all: ThemeFile[] = [];
  let after: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const data: any = await graphqlWithRetry<any>(
      admin,
      THEME_FILES_QUERY,
      { themeId: gid, first: PAGE_SIZE, after },
      { opName: "fetchThemeFiles" },
    );

    if (data.errors && data.errors.length > 0) {
      throw new Error(
        `fetchThemeFiles GraphQL errors: ${data.errors.map((e: any) => e.message).join("; ")}`,
      );
    }

    const edges = data?.data?.theme?.files?.edges ?? [];
    const pageInfo = data?.data?.theme?.files?.pageInfo ?? { hasNextPage: false, endCursor: null };

    for (const e of edges) {
      const n = e?.node;
      if (n?.filename) {
        all.push({
          filename: n.filename,
          checksumMd5: n.checksumMd5 ?? "",
          updatedAt: n.updatedAt ?? "",
          size: String(n.size ?? "0"),
        });
      }
    }

    if (!pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
  }

  return all;
}

export function diffThemeFiles(
  prev: ThemeFile[] | null,
  next: ThemeFile[],
): ThemeFileDiff {
  if (!prev) {
    return { added: [], modified: [], removed: [], hasChanges: false };
  }

  const prevByName = new Map(prev.map((f) => [f.filename, f]));
  const nextByName = new Set(next.map((f) => f.filename));

  const added: string[] = [];
  const modified: string[] = [];

  for (const f of next) {
    const p = prevByName.get(f.filename);
    if (!p) {
      added.push(f.filename);
    } else if (p.checksumMd5 && f.checksumMd5 && p.checksumMd5 !== f.checksumMd5) {
      modified.push(f.filename);
    } else if (p.updatedAt !== f.updatedAt && (!p.checksumMd5 || !f.checksumMd5)) {
      // Fall back to updatedAt diff if checksums are missing for some reason.
      modified.push(f.filename);
    }
  }

  const removed = prev
    .filter((f) => !nextByName.has(f.filename))
    .map((f) => f.filename);

  return {
    added,
    modified,
    removed,
    hasChanges: added.length > 0 || modified.length > 0 || removed.length > 0,
  };
}

/**
 * Build a merchant-readable comma-separated list of changed files.
 * No truncation — if 20 distinct files moved, the merchant sees all 20.
 * Optionally pass maxShown to cap the visible count (e.g. for tight UIs).
 */
export function summarizeFileList(filenames: string[], maxShown?: number): string {
  if (filenames.length === 0) return "";
  if (maxShown === undefined || filenames.length <= maxShown) {
    return filenames.join(", ");
  }
  const shown = filenames.slice(0, maxShown).join(", ");
  return `${shown} +${filenames.length - maxShown} more`;
}
