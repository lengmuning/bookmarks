// Shared canonical URL + folder-path normalization. MUST stay in sync with:
//   worker/src/utils/url.ts
//   firefox-extension/lib/canonical.js
//   safari-macos/App/Shared (App)/ViewController.swift (canonicalUrl + sanitizedRemoteFolderPath)
//
// Identity rule: a logical bookmark is uniquely identified within a pair by its
// canonical URL alone. Folder path is an attribute that can change without
// changing identity.

(function (root) {
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

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.username = "";
    parsed.password = "";

    if (
      (parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "http:" && parsed.port === "80")
    ) {
      parsed.port = "";
    }

    if (parsed.pathname === "") {
      parsed.pathname = "/";
    }

    return parsed.toString();
  }

  function normalizeFolderPath(value) {
    if (!value) return [];
    let parts = [];

    if (Array.isArray(value)) {
      parts = value;
    } else if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) parts = parsed;
      } catch {
        return [];
      }
    } else {
      return [];
    }

    const result = [];
    for (const part of parts) {
      if (typeof part !== "string") continue;
      const trimmed = part.trim();
      if (!trimmed) continue;
      if (trimmed === "Safari Bookmarks") continue;
      if (result[result.length - 1] === trimmed) continue;
      result.push(trimmed);
    }
    return result;
  }

  root.SyncCanonical = { canonicalUrl, normalizeFolderPath };
})(typeof self !== "undefined" ? self : globalThis);
