// Canonical URL used as bookmark identity. Must match worker/src/utils/url.ts;
// both are checked against extensions-shared/canonical-vectors.json.
// Source of truth: extensions-shared/canonical.js (copied into each extension
// by scripts/sync-extensions.sh).

(function (root) {
  "use strict";

  function canonicalUrl(raw) {
    if (raw === null || raw === undefined) return null;
    const trimmed = String(raw).trim();
    if (!trimmed) return null;

    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.username = "";
    parsed.password = "";
    if (
      (parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "http:" && parsed.port === "80")
    ) {
      parsed.port = "";
    }
    if (parsed.pathname === "") parsed.pathname = "/";

    return parsed.toString();
  }

  root.SyncCanonical = { canonicalUrl };
})(typeof self !== "undefined" ? self : globalThis);
