import { DurableObject } from "cloudflare:workers";
import { ACCESS, LIMITS, PAIRING } from "./limits";
import { normalizePairingCode } from "./normalize";
import { randomHex } from "./token";

const HOUR_MS = 60 * 60 * 1000;

export type RedeemResult =
  | { ok: true; pairId: string }
  | { ok: false; reason: "invalid" | "rate_limited" | "group_disabled"; retryAfterSec?: number };

export type ConnectResult =
  | { ok: true; created: true; pairId: string; maxBookmarks: number }
  | { ok: true; created: false; pairId: string }
  | { ok: false; reason: "rate_limited" | "invalid_access_key" | "group_disabled" };

export interface GroupInfo {
  pair_id: string;
  created_at: number;
  disabled_at: number | null;
}

export interface AccessKeyInfo {
  id: string;
  label: string | null;
  max_bookmarks: number;
  created_at: number;
  revoked_at: number | null;
  group: GroupInfo | null;
}

// The master ACCESS_KEY is recorded under this key id.
const MASTER_KEY_ID = "master";

function generateCode(): string {
  const alphabet = PAIRING.alphabet;
  const accept = 256 - (256 % alphabet.length); // rejection sampling, no modulo bias
  let code = "";
  while (code.length < PAIRING.codeLength) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < accept && code.length < PAIRING.codeLength) code += alphabet[byte % alphabet.length];
    }
  }
  return code;
}

// Single global instance: pairing codes, access keys and rate-limit counters
// need strong consistency (a code is redeemable exactly once, a key owns
// exactly one group).
export class Registry extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, pair_id TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS codes_by_pair ON codes(pair_id)");
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL)",
    );
    this.sql.exec(`CREATE TABLE IF NOT EXISTS access_keys (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      label TEXT,
      max_bookmarks INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    )`);
    // One access key, one user, one group. key_id is "master" for the group of
    // the ACCESS_KEY secret.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS groups (
      pair_id TEXT PRIMARY KEY,
      key_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      disabled_at INTEGER
    )`);
  }

  private windowCount(key: string, now: number): number {
    const rows = this.sql.exec("SELECT count, window_start FROM counters WHERE key = ?", key).toArray();
    if (!rows.length || now - Number(rows[0].window_start) >= HOUR_MS) return 0;
    return Number(rows[0].count);
  }

  private bump(key: string, now: number): void {
    if (this.windowCount(key, now) === 0) {
      this.sql.exec("INSERT OR REPLACE INTO counters (key, count, window_start) VALUES (?, 1, ?)", key, now);
    } else {
      this.sql.exec("UPDATE counters SET count = count + 1 WHERE key = ?", key);
    }
  }

  private cleanup(now: number): void {
    this.sql.exec("DELETE FROM codes WHERE expires_at <= ?", now);
    this.sql.exec("DELETE FROM counters WHERE window_start <= ?", now - 2 * HOUR_MS);
  }

  // ----------------------------------------------------------- access keys

  // Finds the group owned by the access key, or records `candidatePairId` as
  // its new group. `keyHash` is null for the master ACCESS_KEY.
  async connectKey(keyHash: string | null, candidatePairId: string, ip: string): Promise<ConnectResult> {
    const now = Date.now();
    const rateKey = `connect:${ip}`;
    if (this.windowCount(rateKey, now) >= PAIRING.createPerIpPerHour) return { ok: false, reason: "rate_limited" };
    this.bump(rateKey, now);

    let keyId = MASTER_KEY_ID;
    let maxBookmarks: number = LIMITS.activeBookmarks;
    if (keyHash !== null) {
      const rows = this.sql
        .exec("SELECT id, max_bookmarks FROM access_keys WHERE key_hash = ? AND revoked_at IS NULL", keyHash)
        .toArray();
      if (!rows.length) return { ok: false, reason: "invalid_access_key" };
      keyId = String(rows[0].id);
      maxBookmarks = Number(rows[0].max_bookmarks);
    }

    const existing = this.sql.exec("SELECT pair_id, disabled_at FROM groups WHERE key_id = ?", keyId).toArray();
    if (existing.length) {
      if (existing[0].disabled_at !== null) return { ok: false, reason: "group_disabled" };
      return { ok: true, created: false, pairId: String(existing[0].pair_id) };
    }
    this.sql.exec("INSERT INTO groups (pair_id, key_id, created_at) VALUES (?, ?, ?)", candidatePairId, keyId, now);
    return { ok: true, created: true, pairId: candidatePairId, maxBookmarks };
  }

  async releaseGroup(pairId: string): Promise<void> {
    this.sql.exec("DELETE FROM groups WHERE pair_id = ?", pairId);
    this.sql.exec("DELETE FROM codes WHERE pair_id = ?", pairId);
  }

  // ------------------------------------------------------------------ pairing

  async issueCode(pairId: string): Promise<{ code: string; expiresAt: number }> {
    const now = Date.now();
    this.cleanup(now);
    this.sql.exec("DELETE FROM codes WHERE pair_id = ?", pairId);
    let code = generateCode();
    while (this.sql.exec("SELECT code FROM codes WHERE code = ?", code).toArray().length) code = generateCode();
    const expiresAt = now + PAIRING.codeTtlMs;
    this.sql.exec("INSERT INTO codes (code, pair_id, expires_at) VALUES (?, ?, ?)", code, pairId, expiresAt);
    return { code, expiresAt };
  }

  async redeem(rawCode: string, ip: string): Promise<RedeemResult> {
    const now = Date.now();
    const ipKey = `joinfail:${ip}`;
    const globalKey = "joinfail:*";
    if (
      this.windowCount(ipKey, now) >= PAIRING.joinFailuresPerIpPerHour ||
      this.windowCount(globalKey, now) >= PAIRING.joinFailuresGlobalPerHour
    ) {
      return { ok: false, reason: "rate_limited", retryAfterSec: 3600 };
    }
    const code = normalizePairingCode(rawCode);
    if (code) {
      const rows = this.sql.exec("SELECT pair_id, expires_at FROM codes WHERE code = ?", code).toArray();
      if (rows.length && Number(rows[0].expires_at) > now) {
        this.sql.exec("DELETE FROM codes WHERE code = ?", code);
        const pairId = String(rows[0].pair_id);
        const disabled = this.sql
          .exec("SELECT pair_id FROM groups WHERE pair_id = ? AND disabled_at IS NOT NULL", pairId)
          .toArray();
        if (disabled.length) return { ok: false, reason: "group_disabled" };
        return { ok: true, pairId };
      }
    }
    this.bump(ipKey, now);
    this.bump(globalKey, now);
    return { ok: false, reason: "invalid" };
  }

  // -------------------------------------------------------------------- admin

  async createKey(input: { label: string | null; maxBookmarks: number }): Promise<{ id: string; key: string }> {
    const id = crypto.randomUUID();
    const key = ACCESS.keyPrefix + randomHex(24);
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    const keyHash = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
    this.sql.exec(
      "INSERT INTO access_keys (id, key_hash, label, max_bookmarks, created_at) VALUES (?, ?, ?, ?, ?)",
      id,
      keyHash,
      input.label,
      input.maxBookmarks,
      Date.now(),
    );
    return { id, key };
  }

  private groupOf(keyId: string): GroupInfo | null {
    const rows = this.sql.exec("SELECT pair_id, created_at, disabled_at FROM groups WHERE key_id = ?", keyId).toArray();
    if (!rows.length) return null;
    return {
      pair_id: String(rows[0].pair_id),
      created_at: Number(rows[0].created_at),
      disabled_at: rows[0].disabled_at === null ? null : Number(rows[0].disabled_at),
    };
  }

  async listKeys(): Promise<{ keys: AccessKeyInfo[]; master_group: GroupInfo | null }> {
    const keys = this.sql
      .exec("SELECT id, label, max_bookmarks, created_at, revoked_at FROM access_keys ORDER BY created_at")
      .toArray()
      .map(row => ({
        id: String(row.id),
        label: row.label === null ? null : String(row.label),
        max_bookmarks: Number(row.max_bookmarks),
        created_at: Number(row.created_at),
        revoked_at: row.revoked_at === null ? null : Number(row.revoked_at),
        group: this.groupOf(String(row.id)),
      }));
    return { keys, master_group: this.groupOf(MASTER_KEY_ID) };
  }

  // Revokes the key and returns its group so the caller can disable it.
  async revokeKey(id: string): Promise<{ found: boolean; pairIds: string[] }> {
    const rows = this.sql.exec("SELECT id FROM access_keys WHERE id = ?", id).toArray();
    if (!rows.length) return { found: false, pairIds: [] };
    const now = Date.now();
    this.sql.exec("UPDATE access_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?", now, id);
    const pairIds = this.sql
      .exec("SELECT pair_id FROM groups WHERE key_id = ? AND disabled_at IS NULL", id)
      .toArray()
      .map(r => String(r.pair_id));
    this.sql.exec("UPDATE groups SET disabled_at = ? WHERE key_id = ? AND disabled_at IS NULL", now, id);
    this.sql.exec("DELETE FROM codes WHERE pair_id IN (SELECT pair_id FROM groups WHERE key_id = ?)", id);
    return { found: true, pairIds };
  }

  async markGroupDisabled(pairId: string): Promise<boolean> {
    const found = this.sql.exec("SELECT pair_id FROM groups WHERE pair_id = ?", pairId).toArray().length > 0;
    this.sql.exec("UPDATE groups SET disabled_at = COALESCE(disabled_at, ?) WHERE pair_id = ?", Date.now(), pairId);
    this.sql.exec("DELETE FROM codes WHERE pair_id = ?", pairId);
    return found;
  }

  async forgetGroup(pairId: string): Promise<boolean> {
    const found = this.sql.exec("SELECT pair_id FROM groups WHERE pair_id = ?", pairId).toArray().length > 0;
    this.sql.exec("DELETE FROM groups WHERE pair_id = ?", pairId);
    this.sql.exec("DELETE FROM codes WHERE pair_id = ?", pairId);
    return found;
  }
}
