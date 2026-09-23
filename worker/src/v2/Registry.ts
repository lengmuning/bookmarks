import { DurableObject } from "cloudflare:workers";
import { PAIRING } from "./limits";
import { normalizePairingCode } from "./normalize";

const HOUR_MS = 60 * 60 * 1000;

export type RedeemResult =
  | { ok: true; pairId: string }
  | { ok: false; reason: "invalid" | "rate_limited"; retryAfterSec?: number };

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

// Single global instance: pairing codes and rate-limit counters need strong
// consistency (a code must be redeemable exactly once).
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

  async allowCreate(ip: string): Promise<{ ok: boolean; retryAfterSec?: number }> {
    const now = Date.now();
    const key = `create:${ip}`;
    if (this.windowCount(key, now) >= PAIRING.createPerIpPerHour) return { ok: false, retryAfterSec: 3600 };
    this.bump(key, now);
    return { ok: true };
  }

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
        return { ok: true, pairId: String(rows[0].pair_id) };
      }
    }
    this.bump(ipKey, now);
    this.bump(globalKey, now);
    return { ok: false, reason: "invalid" };
  }
}
