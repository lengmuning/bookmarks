import { DurableObject } from "cloudflare:workers";
import { configuredSecret } from "./access";
import { ACCESS, ADMIN, LIMITS, PAIRING } from "./limits";
import { normalizePairingCode } from "./normalize";
import { randomHex, sha256Hex } from "./token";
import { keyHint, openKey, sealKey } from "./vault";

const HOUR_MS = 60 * 60 * 1000;

export type RedeemResult =
  | { ok: true; pairId: string }
  | { ok: false; reason: "invalid" | "rate_limited" | "group_disabled"; retryAfterSec?: number };

export type ConnectResult =
  | { ok: true; created: true; pairId: string; maxBookmarks: number }
  | { ok: true; created: false; pairId: string }
  | { ok: false; reason: "rate_limited" | "invalid_access_key" | "group_disabled" };

export type ResetKeyResult = { ok: true; id: string; key: string } | { ok: false; reason: "not_found" | "revoked" };
export type RevealKeyResult = { ok: true; key: string } | { ok: false; reason: "not_found" | "not_viewable" };

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
  // First and last characters, to recognise the key; null for keys created
  // before keys were stored.
  key_hint: string | null;
  // A copy is stored and can be shown on the admin page.
  viewable: boolean;
  group: GroupInfo | null;
}

const KEY_COLUMNS = "id, label, max_bookmarks, created_at, revoked_at, key_hint, key_enc";

// The master ACCESS_KEY is recorded under this key id.
const MASTER_KEY_ID = "master";

const newAccessKey = () => ACCESS.keyPrefix + randomHex(24);

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
    // Added after the first release: an encrypted copy of issued keys.
    const columns = new Set(this.sql.exec("PRAGMA table_info(access_keys)").toArray().map(c => String(c.name)));
    if (!columns.has("key_enc")) this.sql.exec("ALTER TABLE access_keys ADD COLUMN key_enc TEXT");
    if (!columns.has("key_hint")) this.sql.exec("ALTER TABLE access_keys ADD COLUMN key_hint TEXT");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY,
      admin_fp TEXT NOT NULL,
      expires_at INTEGER NOT NULL
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
    this.sql.exec("DELETE FROM admin_sessions WHERE expires_at <= ?", now);
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

  private async sealed(key: string): Promise<string | null> {
    const admin = configuredSecret(this.env.ADMIN_KEY);
    return admin ? sealKey(key, admin) : null;
  }

  async createKey(input: { label: string | null; maxBookmarks: number }): Promise<{ id: string; key: string }> {
    const id = crypto.randomUUID();
    const key = newAccessKey();
    const keyHash = await sha256Hex(key);
    this.sql.exec(
      "INSERT INTO access_keys (id, key_hash, label, max_bookmarks, created_at, key_hint, key_enc) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      keyHash,
      input.label,
      input.maxBookmarks,
      Date.now(),
      keyHint(key),
      await this.sealed(key),
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

  private keyInfo(row: Record<string, SqlStorageValue>): AccessKeyInfo {
    return {
      id: String(row.id),
      label: row.label === null ? null : String(row.label),
      max_bookmarks: Number(row.max_bookmarks),
      created_at: Number(row.created_at),
      revoked_at: row.revoked_at === null ? null : Number(row.revoked_at),
      key_hint: row.key_hint === null ? null : String(row.key_hint),
      viewable: row.key_enc !== null,
      group: this.groupOf(String(row.id)),
    };
  }

  async listKeys(): Promise<{ keys: AccessKeyInfo[]; master_group: GroupInfo | null }> {
    const keys = this.sql
      .exec(`SELECT ${KEY_COLUMNS} FROM access_keys ORDER BY created_at`)
      .toArray()
      .map(row => this.keyInfo(row));
    return { keys, master_group: this.groupOf(MASTER_KEY_ID) };
  }

  // Omitted fields are left unchanged; a null label clears it.
  async updateKey(id: string, patch: { label?: string | null; maxBookmarks?: number }): Promise<AccessKeyInfo | null> {
    if (!this.sql.exec("SELECT id FROM access_keys WHERE id = ?", id).toArray().length) return null;
    if (patch.label !== undefined) this.sql.exec("UPDATE access_keys SET label = ? WHERE id = ?", patch.label, id);
    if (patch.maxBookmarks !== undefined) {
      this.sql.exec("UPDATE access_keys SET max_bookmarks = ? WHERE id = ?", patch.maxBookmarks, id);
    }
    const row = this.sql.exec(`SELECT ${KEY_COLUMNS} FROM access_keys WHERE id = ?`, id).one();
    return this.keyInfo(row);
  }

  // Replaces the secret of an active key. The group and its devices are kept:
  // devices sign in with their own tokens, only new connections need the key.
  async resetKey(id: string): Promise<ResetKeyResult> {
    const rows = this.sql.exec("SELECT revoked_at FROM access_keys WHERE id = ?", id).toArray();
    if (!rows.length) return { ok: false, reason: "not_found" };
    if (rows[0].revoked_at !== null) return { ok: false, reason: "revoked" };
    const key = newAccessKey();
    this.sql.exec(
      "UPDATE access_keys SET key_hash = ?, key_hint = ?, key_enc = ? WHERE id = ?",
      await sha256Hex(key),
      keyHint(key),
      await this.sealed(key),
      id,
    );
    return { ok: true, id, key };
  }

  async revealKey(id: string): Promise<RevealKeyResult> {
    const rows = this.sql.exec("SELECT key_enc FROM access_keys WHERE id = ?", id).toArray();
    if (!rows.length) return { ok: false, reason: "not_found" };
    const admin = configuredSecret(this.env.ADMIN_KEY);
    const key = rows[0].key_enc !== null && admin ? await openKey(String(rows[0].key_enc), admin) : null;
    return key ? { ok: true, key } : { ok: false, reason: "not_viewable" };
  }

  // A key can be deleted once revoked; returns its groups for the caller to
  // purge before calling deleteKey.
  async keyForDeletion(id: string): Promise<{ found: boolean; revoked: boolean; pairIds: string[] }> {
    const rows = this.sql.exec("SELECT revoked_at FROM access_keys WHERE id = ?", id).toArray();
    if (!rows.length) return { found: false, revoked: false, pairIds: [] };
    const pairIds = this.sql
      .exec("SELECT pair_id FROM groups WHERE key_id = ?", id)
      .toArray()
      .map(r => String(r.pair_id));
    return { found: true, revoked: rows[0].revoked_at !== null, pairIds };
  }

  async deleteKey(id: string): Promise<void> {
    this.sql.exec("DELETE FROM codes WHERE pair_id IN (SELECT pair_id FROM groups WHERE key_id = ?)", id);
    this.sql.exec("DELETE FROM groups WHERE key_id = ?", id);
    this.sql.exec("DELETE FROM access_keys WHERE id = ? AND revoked_at IS NOT NULL", id);
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

  // ----------------------------------------------------------- admin sign-in

  // Every ADMIN_KEY attempt goes through here before its result is used, so a
  // blocked IP learns nothing even when it guesses right.
  async adminAuthAttempt(ip: string, matched: boolean): Promise<"ok" | "invalid" | "rate_limited"> {
    const now = Date.now();
    const key = `adminfail:${ip}`;
    if (this.windowCount(key, now) >= ADMIN.failuresPerIpPerHour) return "rate_limited";
    if (matched) return "ok";
    this.bump(key, now);
    return "invalid";
  }

  async adminCreateSession(adminFp: string): Promise<{ token: string; expiresAt: number }> {
    const now = Date.now();
    this.cleanup(now);
    const token = randomHex(32);
    const expiresAt = now + ADMIN.sessionTtlMs;
    this.sql.exec(
      "INSERT INTO admin_sessions (token_hash, admin_fp, expires_at) VALUES (?, ?, ?)",
      await sha256Hex(token),
      adminFp,
      expiresAt,
    );
    return { token, expiresAt };
  }

  async adminSessionValid(tokenHash: string, adminFp: string): Promise<boolean> {
    const rows = this.sql.exec("SELECT admin_fp, expires_at FROM admin_sessions WHERE token_hash = ?", tokenHash).toArray();
    return rows.length > 0 && String(rows[0].admin_fp) === adminFp && Number(rows[0].expires_at) > Date.now();
  }

  async adminEndSession(tokenHash: string): Promise<void> {
    this.sql.exec("DELETE FROM admin_sessions WHERE token_hash = ?", tokenHash);
  }
}
