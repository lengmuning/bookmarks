import { canonicalUrl } from "../utils/url";
import { LIMITS, PAIRING, PLATFORMS, Platform } from "./limits";

export interface NormalizedItem {
  url: string;
  title: string | null;
  folderPath: string[];
  index: number | null;
}

export type Normalized<T> = { ok: true; value: T } | { ok: false; reason: string };

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

export function normalizeUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > LIMITS.urlLength * 2) return null;
  const url = canonicalUrl(raw);
  if (!url || url.length > LIMITS.urlLength) return null;
  return url;
}

// Browsers report an untitled bookmark as "", Safari may omit the title; both
// become null so they compare equal.
export function normalizeTitle(raw: unknown): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  return truncate(raw, LIMITS.titleLength);
}

export function normalizeFolderPath(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > LIMITS.folderDepth) return null;
  const out: string[] = [];
  for (const part of raw) {
    if (typeof part !== "string") return null;
    const trimmed = part.trim();
    if (trimmed) out.push(truncate(trimmed, LIMITS.folderNameLength));
  }
  return out;
}

export function normalizeIndex(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 1_000_000 ? raw : null;
}

export function normalizeItem(raw: unknown): Normalized<NormalizedItem> {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "not_an_object" };
  const item = raw as Record<string, unknown>;
  const url = normalizeUrl(item.url);
  if (!url) return { ok: false, reason: "invalid_url" };
  const folderPath = normalizeFolderPath(item.folderPath ?? item.folder_path);
  if (!folderPath) return { ok: false, reason: "invalid_folder_path" };
  return {
    ok: true,
    value: { url, title: normalizeTitle(item.title), folderPath, index: normalizeIndex(item.index) },
  };
}

export function normalizePlatform(raw: unknown): Platform | null {
  return typeof raw === "string" && (PLATFORMS as readonly string[]).includes(raw) ? (raw as Platform) : null;
}

export function normalizeDeviceName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed ? truncate(trimmed, LIMITS.deviceNameLength) : null;
}

export function normalizePairingCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== PAIRING.codeLength) return null;
  for (const ch of code) {
    if (!PAIRING.alphabet.includes(ch)) return null;
  }
  return code;
}

export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
