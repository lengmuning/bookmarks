// Canonical URL used as bookmark identity. Must match
// extensions-shared/canonical.js; both are checked against
// extensions-shared/canonical-vectors.json. The macOS app does not
// canonicalize: it uses the canonical_map the server returns.
//
// Rules (intentionally minimal — only fix differences that produce false-duplicate writes):
//   - lowercase hostname
//   - drop userinfo (bookmarks should never carry credentials)
//   - drop default port (80 for http, 443 for https)
//   - empty path becomes "/"
//   - leave scheme, query, and fragment untouched (semantic)

export function canonicalUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  let parsed: URL;
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
