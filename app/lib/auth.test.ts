import { describe, it, expect } from "vitest";
import { bearerMatches } from "./auth.server";

describe("bearerMatches (L1)", () => {
  it("matches a correct Bearer token", () => {
    expect(bearerMatches("Bearer s3cret", "s3cret")).toBe(true);
  });

  it("matches against any of several configured secrets", () => {
    expect(bearerMatches("Bearer two", "one", "two")).toBe(true);
    expect(bearerMatches("Bearer one", "one", "two")).toBe(true);
  });

  it("rejects a wrong token", () => {
    expect(bearerMatches("Bearer nope", "s3cret")).toBe(false);
  });

  it("rejects a token of different length (no throw)", () => {
    expect(bearerMatches("Bearer short", "a-much-longer-secret-value")).toBe(false);
  });

  it("rejects when the Bearer prefix is missing", () => {
    expect(bearerMatches("s3cret", "s3cret")).toBe(false);
  });

  it("rejects empty / missing header", () => {
    expect(bearerMatches("", "s3cret")).toBe(false);
    expect(bearerMatches(null, "s3cret")).toBe(false);
    expect(bearerMatches(undefined, "s3cret")).toBe(false);
  });

  it("rejects when no secrets are configured", () => {
    expect(bearerMatches("Bearer anything")).toBe(false);
    expect(bearerMatches("Bearer anything", undefined, "")).toBe(false);
  });
});
