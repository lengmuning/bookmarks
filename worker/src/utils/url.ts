// Canonical URL normalization shared between Worker and clients.
// Keep this logic identical across all platforms: Chrome, Firefox, Safari macOS.
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

export function normalizeFolderPath(value: unknown): string[] {
  if (!value) return [];
  let parts: unknown[] = [];

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

  const result: string[] = [];
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
