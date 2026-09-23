export const LIMITS = {
  urlLength: 4096,
  titleLength: 1024,
  folderDepth: 32,
  folderNameLength: 255,
  deviceNameLength: 100,
  opsPerRequest: 500,
  snapshotItems: 60_000,
  activeBookmarks: 50_000,
  bodyBytes: 16 * 1024 * 1024,
  changesPageDefault: 500,
  changesPageMax: 1000,
} as const;

export const SAFARI_GUARD = {
  // A snapshot that would delete more than `minCount` rows AND more than
  // `ratio` of Safari's rows needs explicit confirmation.
  minCount: 20,
  ratio: 0.1,
  sampleSize: 10,
} as const;

export const PAIRING = {
  codeLength: 8,
  alphabet: "23456789ABCDEFGHJKMNPQRSTUVWXYZ",
  codeTtlMs: 30 * 60 * 1000,
  createPerIpPerHour: 10,
  joinFailuresPerIpPerHour: 10,
  joinFailuresGlobalPerHour: 300,
} as const;

export const WS = {
  ticketTtlMs: 60 * 1000,
  ping: '{"type":"ping"}',
  pong: '{"type":"pong"}',
} as const;

export const DEVICE_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000;

// Deleted rows are kept this long so offline browsers can learn about the
// delete; a browser whose cursor is older than the purged range resyncs.
export const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const COMPACTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const ACCESS = {
  keyPrefix: "sbk_",
  minSecretLength: 16,
} as const;

export const PLATFORMS = ["safari", "chrome", "firefox"] as const;
export type Platform = (typeof PLATFORMS)[number];
