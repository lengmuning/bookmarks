import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalUrl } from "../../src/utils/url";
import { formatPairingCode, normalizeFolderPath, normalizePairingCode, normalizeTitle } from "../../src/v2/normalize";

const vectors: { input: string; expected: string | null }[] = JSON.parse(
  readFileSync(new URL("../../../extensions-shared/canonical-vectors.json", import.meta.url), "utf8"),
);

describe("canonicalUrl (shared vectors)", () => {
  for (const { input, expected } of vectors) {
    it(JSON.stringify(input), () => {
      expect(canonicalUrl(input)).toBe(expected);
    });
  }
});

describe("normalize", () => {
  it("treats an empty title as null", () => {
    expect(normalizeTitle("")).toBeNull();
    expect(normalizeTitle(" x ")).toBe(" x ");
  });

  it("truncates long titles without splitting a surrogate pair", () => {
    const title = "a".repeat(1023) + "😀";
    expect(normalizeTitle(title)).toBe("a".repeat(1023));
  });

  it("trims folder names, drops empty ones and keeps repeated names", () => {
    expect(normalizeFolderPath([" Favorites ", "", "Tech", "Tech"])).toEqual(["Favorites", "Tech", "Tech"]);
    expect(normalizeFolderPath(undefined)).toEqual([]);
    expect(normalizeFolderPath("Favorites")).toBeNull();
    expect(normalizeFolderPath([1])).toBeNull();
    expect(normalizeFolderPath(new Array(33).fill("x"))).toBeNull();
  });

  it("accepts pairing codes regardless of case and separators", () => {
    expect(normalizePairingCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normalizePairingCode("AB CD EF GH")).toBe("ABCDEFGH");
    expect(normalizePairingCode("ABCD-EFG0")).toBeNull(); // 0 is not in the alphabet
    expect(normalizePairingCode("ABCDEFG")).toBeNull();
    expect(formatPairingCode("ABCDEFGH")).toBe("ABCD-EFGH");
  });
});
