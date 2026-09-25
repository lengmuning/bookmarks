import { describe, expect, it } from "vitest";
import { keyHint, openKey, sealKey } from "../../src/v2/vault";

describe("access key vault", () => {
  const key = "sbk_" + "0123456789abcdef".repeat(3);

  it("round-trips a key with the same ADMIN_KEY", async () => {
    const sealed = await sealKey(key, "admin-key-one-long-enough");
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain(key);
    expect(await openKey(sealed, "admin-key-one-long-enough")).toBe(key);
  });

  it("cannot open a copy after ADMIN_KEY changed, or a damaged copy", async () => {
    const sealed = await sealKey(key, "admin-key-one-long-enough");
    expect(await openKey(sealed, "admin-key-two-long-enough")).toBeNull();
    expect(await openKey(sealed.slice(0, -4) + "AAAA", "admin-key-one-long-enough")).toBeNull();
    expect(await openKey("garbage", "admin-key-one-long-enough")).toBeNull();
  });

  it("uses a fresh nonce every time", async () => {
    expect(await sealKey(key, "admin-key-one-long-enough")).not.toBe(await sealKey(key, "admin-key-one-long-enough"));
  });

  it("hints show the prefix and the last four characters only", () => {
    expect(keyHint(key)).toBe("sbk_0123…cdef");
  });
});
