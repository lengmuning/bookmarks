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
  // Deleted in a browser while Safari still had it: the app removes it from
  // Bookmarks.plist, then the flag is cleared.
  safariDelete: boolean;
  seq: number;
  updatedAt: number;
  lastActor: string | null;
}

export interface Store {
  get(url: string): Row | null;
  put(row: Row): void;
  all(): Row[];
  countActive(): number;
  // Active rows present in the last Safari snapshot.
  countInSafari(): number;
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

export interface DeletionConfirmation {
  count: number;
  sample: string[];
}

export interface BrowserOpsResult {
  results: OpResult[];
  changed: boolean;
  // Removes of bookmarks Safari has, applied or held back.
  safariDeletes: number;
  needsConfirmation: DeletionConfirmation | null;
}

// `recentSafariDeletes` counts earlier removes of Safari's bookmarks in the
// guard window, so a large delete sent in several requests is still caught.
export interface BrowserDeleteGuard {
  confirm: boolean;
  recentSafariDeletes: number;
}

const inSafari = (row: Row) => row.owner === "safari" || row.inSafari;

export function applyBrowserOps(
  store: Store,
  ops: unknown[],
  baseCursor: number,
  actor: string,
  now: number,
  maxActive: number = LIMITS.activeBookmarks,
  guard: BrowserDeleteGuard = { confirm: false, recentSafariDeletes: 0 },
): BrowserOpsResult {
  const results: OpResult[] = [];
  let changed = false;
  let active = store.countActive();

  // Removes of bookmarks that Safari has also delete them from Safari, so a
  // large one waits for the user to confirm it in the browser.
  const safariTargets: string[] = [];
  for (const raw of ops) {
    const op = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    if (op.op !== "remove") continue;
    const url = normalizeUrl(op.url);
    const row = url ? store.get(url) : null;
    if (url && row && !row.removed && inSafari(row) && !safariTargets.includes(url)) safariTargets.push(url);
  }
  const attempted = guard.recentSafariDeletes + safariTargets.length;
  const held =
    safariTargets.length > 0 &&
    !guard.confirm &&
    attempted > SAFARI_GUARD.minCount &&
    attempted > SAFARI_GUARD.ratio * store.countInSafari();

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
      } else if (inSafari(row) && held) {
        results.push({ url, status: "rejected", reason: "mass_delete", state: toPublic(row) });
      } else {
        row.safariDelete = inSafari(row);
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
        safariDelete: false,
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

  const needsConfirmation = held
    ? { count: safariTargets.length, sample: safariTargets.slice(0, SAFARI_GUARD.sampleSize) }
    : null;
  return { results, changed, safariDeletes: safariTargets.length, needsConfirmation };
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
  needsConfirmation: DeletionConfirmation | null;
  changed: boolean;
}

// `deletedImports`: bookmarks the app wrote into the plist for a browser that
// are gone again after Safari rewrote the file, i.e. deleted in Safari.
export function applySafariSnapshot(
  store: Store,
  items: unknown[],
  unconfirmedImports: unknown[],
  confirmDeletions: boolean,
  actor: string,
  now: number,
  maxActive: number = LIMITS.activeBookmarks,
  deletedImports: unknown[] = [],
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

  const vanished = new Set<string>();
  for (const raw of deletedImports) {
    const url = normalizeUrl(raw);
    if (url) vanished.add(url);
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

    if (row && row.removed && row.safariDelete) {
      // Deleted in a browser; the app has not removed it from the plist yet.
      stats.unchanged += 1;
      continue;
    }

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
        safariDelete: false,
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
        safariDelete: false,
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

  const safariActive = [...byUrl.values()].filter(row => !row.removed && inSafari(row));
  const toDelete = [...byUrl.values()].filter(
    row => !row.removed && !seen.has(row.url) && (row.owner === "safari" || vanished.has(row.url)),
  );
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
    // The app removed it from the plist: the browser delete is complete.
    if (row.removed && row.safariDelete && !seen.has(row.url)) {
      row.safariDelete = false;
      store.put(row);
    }
  }

  return { stats, canonicalMap, skippedSample, needsConfirmation, changed };
}

// URLs the app must remove from Bookmarks.plist (deleted in a browser).
export function pendingDeletions(store: Store): string[] {
  return store
    .all()
    .filter(row => row.removed && row.safariDelete)
    .sort((a, b) => a.seq - b.seq)
    .map(row => row.url);
}

export function pendingImports(store: Store): PublicRow[] {
  return store
    .all()
    .filter(row => !row.removed && row.owner === "browser" && !row.inSafari)
    .sort((a, b) => a.seq - b.seq)
    .map(toPublic);
}
