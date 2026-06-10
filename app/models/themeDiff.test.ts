import { describe, it, expect, vi } from "vitest";

// themeDiff imports graphqlWithRetry from the shopify wrapper at module load.
// We only test the pure diff/summarize helpers here, so stub the wrapper to
// keep the import graph light and side-effect free.
vi.mock("../lib/shopifyGraphql.server", () => ({
  graphqlWithRetry: vi.fn(),
}));

import { diffThemeFiles, summarizeFileList, type ThemeFile } from "./themeDiff.server";

const file = (filename: string, md5: string, updatedAt = "2026-01-01T00:00:00Z"): ThemeFile => ({
  filename,
  checksumMd5: md5,
  updatedAt,
  size: "100",
});

describe("diffThemeFiles", () => {
  it("returns no changes when there is no previous snapshot", () => {
    const d = diffThemeFiles(null, [file("a.liquid", "x")]);
    expect(d).toEqual({ added: [], modified: [], removed: [], hasChanges: false });
  });

  it("detects added files", () => {
    const d = diffThemeFiles([file("a.liquid", "x")], [file("a.liquid", "x"), file("b.liquid", "y")]);
    expect(d.added).toEqual(["b.liquid"]);
    expect(d.hasChanges).toBe(true);
  });

  it("detects modified files via checksum", () => {
    const d = diffThemeFiles([file("a.liquid", "x")], [file("a.liquid", "y")]);
    expect(d.modified).toEqual(["a.liquid"]);
  });

  it("detects removed files", () => {
    const d = diffThemeFiles([file("a.liquid", "x"), file("b.liquid", "y")], [file("a.liquid", "x")]);
    expect(d.removed).toEqual(["b.liquid"]);
  });

  it("identical checksums → no change", () => {
    const d = diffThemeFiles([file("a.liquid", "x")], [file("a.liquid", "x")]);
    expect(d.hasChanges).toBe(false);
  });

  it("falls back to updatedAt when checksums are missing", () => {
    const prev = [file("a.liquid", "")];
    const next = [{ ...file("a.liquid", ""), updatedAt: "2026-02-02T00:00:00Z" }];
    const d = diffThemeFiles(prev, next);
    expect(d.modified).toEqual(["a.liquid"]);
  });

  it("does not flag updatedAt drift when checksums match", () => {
    const prev = [file("a.liquid", "x", "2026-01-01T00:00:00Z")];
    const next = [file("a.liquid", "x", "2026-09-09T00:00:00Z")];
    expect(diffThemeFiles(prev, next).hasChanges).toBe(false);
  });
});

describe("summarizeFileList", () => {
  it("empty list → empty string", () => {
    expect(summarizeFileList([])).toBe("");
  });

  it("joins without truncation by default", () => {
    expect(summarizeFileList(["a", "b", "c"])).toBe("a, b, c");
  });

  it("caps with +N more when maxShown is set", () => {
    expect(summarizeFileList(["a", "b", "c", "d"], 2)).toBe("a, b +2 more");
  });

  it("does not add +more when under the cap", () => {
    expect(summarizeFileList(["a", "b"], 5)).toBe("a, b");
  });
});
