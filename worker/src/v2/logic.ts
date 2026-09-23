// Sync rules from docs/SYNC-V2.md. Pure functions over a small Store interface
// so they can be unit-tested without a Durable Object.

import { LIMITS, SAFARI_GUARD } from "./limits";
import { normalizeItem, normalizeUrl, NormalizedItem } from "./normalize";

export type Owner = "safari" | "browser";

export interface Row {
  url: string;
  title: string | null;
  folderPath: string[];
  idx: number | null;
  owner: Owner;
  removed: boolean;
  inSafari: boolean;
  seq: number;
  updatedAt: number;
  lastActor: string | null;
}

export interface Store {
  get(url: string): Row | null;
  put(row: Row): void;
  all(): Row[];
  countActive(): number;
  currentSeq(): number;
  nextSeq(): number;
}

export interface PublicRow {
  url: string;
  title: string | null;
  folderPath: string[];
  index: number | null;
  owner: Owner;
  removed: boolean;
  seq: number;
}

export function toPublic(row: Row): PublicRow {
  return {
    url: row.url,
    title: row.title,
    folderPath: row.folderPath,
    index: row.idx,
    owner: row.owner,
    removed: row.removed,
    seq: row.seq,
  };
}

export function samePath(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((part, i) => part === b[i]);
}

// ---------------------------------------------------------------------------
// Browser ops

export type OpStatus = "applied" | "noop" | "rejected" | "invalid";

export interface OpResult {
  url: string | null;
  status: OpStatus;
  reason?: string;
  state?: PublicRow;
}

export interface BrowserOpsResult {
  results: OpResult[];
  changed: boolean;
}

export function applyBrowserOps(
  store: Store,
  ops: unknown[],
  baseCursor: number,
  actor: string,
  now: number,
  maxActive: number = LIMITS.activeBookmarks,
): BrowserOpsResult {
  const results: OpResult[] = [];
  let changed = false;
  let active = store.countActive();

  const write = (row: Row) => {
    row.seq = store.nextSeq();
    row.updatedAt = now;
    row.lastActor = actor;
    store.put(row);
    changed = true;
  };

  for (const raw of ops) {
    const op = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const kind = op.op;

    if (kind === "remove") {
      const url = normalizeUrl(op.url);
      if (!url) {
        results.push({ url: null, status: "invalid", reason: "invalid_url" });
        continue;
      }
      const row = store.get(url);
      if (!row || row.removed) {
        results.push({ url, status: "noop" });
      } else if (row.owner === "safari") {
        results.push({ url, status: "rejected", reason: "safari_authority", state: toPublic(row) });
      } else {
        row.removed = true;
        row.inSafari = false;
        write(row);
        active -= 1;
        results.push({ url, status: "applied" });
      }
      continue;
    }

    if (kind !== "create" && kind !== "update") {
      results.push({ url: null, status: "invalid", reason: "invalid_op" });
      continue;
    }

    const normalized = normalizeItem(op);
    if (!normalized.ok) {
      results.push({ url: normalizeUrl(op.url), status: "invalid", reason: normalized.reason });
      continue;
    }
    const item = normalized.value;
    const row = store.get(item.url);

    if (!row || (row.removed && row.seq <= baseCursor)) {
      if (active >= maxActive) {
        results.push({ url: item.url, status: "rejected", reason: "group_full" });
        continue;
      }
      write({
        url: item.url,
        title: item.title,
        folderPath: item.folderPath,
        idx: item.index,
        owner: "browser",
        removed: false,
        inSafari: false,
        seq: 0,
        updatedAt: now,
        lastActor: actor,
      });
      active += 1;
      results.push({ url: item.url, status: "applied" });
    } else if (row.removed) {
      results.push({ url: item.url, status: "rejected", reason: "deleted", state: toPublic(row) });
    } else if (row.owner === "safari") {
      if (row.title === item.title && samePath(row.folderPath, item.folderPath)) {
        results.push({ url: item.url, status: "noop" });
      } else {
        results.push({ url: item.url, status: "rejected", reason: "safari_authority", state: toPublic(row) });
      }
    } else if (row.title !== item.title || !samePath(row.folderPath, item.folderPath)) {
      row.title = item.title;
      row.folderPath = item.folderPath;
      row.idx = item.index;
      write(row);
      results.push({ url: item.url, status: "applied" });
    } else {
      if (row.idx !== item.index) {
        row.idx = item.index;
        store.put(row);
      }
      results.push({ url: item.url, status: "noop" });
    }
  }

  return { results, changed };
}

// ---------------------------------------------------------------------------
// Safari snapshot

export interface SnapshotStats {
  received: number;
  accepted: number;
  skipped: number;
  inserted: number;
  updated: number;
  restored: number;
  unchanged: number;
  deleted: number;
}

export interface SnapshotResult {
  stats: SnapshotStats;
  canonicalMap: Record<string, string>;
  skippedSample: string[];
  needsConfirmation: { count: number; sample: string[] } | null;
  changed: boolean;
}

export function applySafariSnapshot(
  store: Store,
  items: unknown[],
  unconfirmedImports: unknown[],
  confirmDeletions: boolean,
  actor: string,
  now: number,
  maxActive: number = LIMITS.activeBookmarks,
): SnapshotResult {
  const stats: SnapshotStats = {
    received: items.length,
    accepted: 0,
    skipped: 0,
    inserted: 0,
    updated: 0,
    restored: 0,
    unchanged: 0,
    deleted: 0,
  };
  const canonicalMap: Record<string, string> = {};
  const skippedSample: string[] = [];
  let changed = false;

  const seen = new Set<string>();
  const accepted: NormalizedItem[] = [];
  for (const raw of items) {
    const normalized = normalizeItem(raw);
    const rawUrl = raw && typeof raw === "object" ? (raw as Record<string, unknown>).url : undefined;
    if (!normalized.ok) {
      stats.skipped += 1;
      if (skippedSample.length < 20 && typeof rawUrl === "string") skippedSample.push(rawUrl.slice(0, 200));
      continue;
    }
    const item = normalized.value;
    if (typeof rawUrl === "string" && rawUrl !== item.url) canonicalMap[rawUrl] = item.url;
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    accepted.push(item);
  }
  stats.accepted = accepted.length;

  const unconfirmed = new Set<string>();
  for (const raw of unconfirmedImports) {
    const url = normalizeUrl(raw);
    if (url) unconfirmed.add(url);
  }

  const byUrl = new Map(store.all().map(row => [row.url, row]));
  let active = 0;
  for (const row of byUrl.values()) if (!row.removed) active += 1;

  const write = (row: Row) => {
    row.seq = store.nextSeq();
    row.updatedAt = now;
    row.lastActor = actor;
    store.put(row);
    byUrl.set(row.url, row);
    changed = true;
  };

  for (const item of accepted) {
    const row = byUrl.get(item.url);

    if (unconfirmed.has(item.url)) {
      // Written into the plist by the app but not yet confirmed: keep the
      // browser's ownership, only record that Safari currently has it.
      if (row && !row.inSafari) {
        row.inSafari = true;
        store.put(row);
      }
      stats.unchanged += 1;
      continue;
    }

    if (!row) {
      if (active >= maxActive) {
        stats.skipped += 1;
        continue;
      }
      write({
        url: item.url,
        title: item.title,
        folderPath: item.folderPath,
        idx: item.index,
        owner: "safari",
        removed: false,
        inSafari: true,
        seq: 0,
        updatedAt: now,
        lastActor: actor,
      });
      active += 1;
      stats.inserted += 1;
    } else if (row.removed) {
      if (active >= maxActive) {
        stats.skipped += 1;
        continue;
      }
      Object.assign(row, {
        title: item.title,
        folderPath: item.folderPath,
        idx: item.index,
        owner: "safari",
        removed: false,
        inSafari: true,
      });
      write(row);
      active += 1;
      stats.restored += 1;
    } else if (row.owner !== "safari" || row.title !== item.title || !samePath(row.folderPath, item.folderPath)) {
      Object.assign(row, {
        title: item.title,
        folderPath: item.folderPath,
        idx: item.index,
        owner: "safari",
        inSafari: true,
      });
      write(row);
      stats.updated += 1;
    } else {
      if (row.idx !== item.index || !row.inSafari) {
        row.idx = item.index;
        row.inSafari = true;
        store.put(row);
      }
      stats.unchanged += 1;
    }
  }

  const safariActive = [...byUrl.values()].filter(row => !row.removed && row.owner === "safari");
  const toDelete = safariActive.filter(row => !seen.has(row.url));
  const guarded =
    toDelete.length > 0 &&
    !confirmDeletions &&
    (accepted.length === 0 ||
      (toDelete.length > SAFARI_GUARD.minCount && toDelete.length > SAFARI_GUARD.ratio * safariActive.length));

  let needsConfirmation: SnapshotResult["needsConfirmation"] = null;
  if (guarded) {
    needsConfirmation = {
      count: toDelete.length,
      sample: toDelete.slice(0, SAFARI_GUARD.sampleSize).map(row => row.url),
    };
  } else {
    for (const row of toDelete) {
      row.removed = true;
      row.inSafari = false;
      write(row);
      stats.deleted += 1;
    }
  }

  for (const row of byUrl.values()) {
    if (row.inSafari && !row.removed && row.owner === "browser" && !seen.has(row.url)) {
      row.inSafari = false;
      store.put(row);
    }
  }

  return { stats, canonicalMap, skippedSample, needsConfirmation, changed };
}

export function pendingImports(store: Store): PublicRow[] {
  return store
    .all()
    .filter(row => !row.removed && row.owner === "browser" && !row.inSafari)
    .sort((a, b) => a.seq - b.seq)
    .map(toPublic);
}
