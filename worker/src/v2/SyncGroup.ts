import { DurableObject } from "cloudflare:workers";
import {
  COMPACTION_INTERVAL_MS,
  DEVICE_SEEN_WRITE_INTERVAL_MS,
  LIMITS,
  Platform,
  TOMBSTONE_RETENTION_MS,
  WS,
} from "./limits";
import { applyBrowserOps, applySafariSnapshot, pendingImports, Row, Store, toPublic } from "./logic";
import { randomHex, sha256Hex, timingSafeEqual } from "./token";

// Bodies cross the RPC boundary as JSON text: the router returns them as-is.
export interface RpcResult {
  status: number;
  json: string;
}

export interface DeviceAuth {
  deviceId: string;
  secret: string;
}

interface DeviceRow {
  id: string;
  platform: Platform;
  name: string | null;
  token_hash: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

const ok = (body: object): RpcResult => ({ status: 200, json: JSON.stringify(body) });
const fail = (status: number, error: string): RpcResult => ({ status, json: JSON.stringify({ error }) });
const isResult = (value: unknown): value is RpcResult =>
  typeof value === "object" && value !== null && "status" in value && "json" in value;

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS devices (
     id TEXT PRIMARY KEY,
     platform TEXT NOT NULL,
     name TEXT,
     token_hash TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     last_seen_at INTEGER,
     revoked_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS bookmarks (
     url TEXT PRIMARY KEY,
     title TEXT,
     folder_path TEXT NOT NULL,
     idx INTEGER,
     owner TEXT NOT NULL,
     removed INTEGER NOT NULL DEFAULT 0,
     in_safari INTEGER NOT NULL DEFAULT 0,
     seq INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     last_actor TEXT
   )`,
  "CREATE INDEX IF NOT EXISTS bookmarks_by_seq ON bookmarks(seq)",
  `CREATE TABLE IF NOT EXISTS ws_tickets (
     ticket_hash TEXT PRIMARY KEY,
     device_id TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
];

function rowFromDb(r: Record<string, SqlStorageValue>): Row {
  let folderPath: string[] = [];
  try {
    const parsed = JSON.parse(String(r.folder_path));
    if (Array.isArray(parsed)) folderPath = parsed.filter((p): p is string => typeof p === "string");
  } catch {
    // Written by this object only; treat corruption as the root folder.
  }
  return {
    url: String(r.url),
    title: r.title === null ? null : String(r.title),
    folderPath,
    idx: r.idx === null ? null : Number(r.idx),
    owner: r.owner === "safari" ? "safari" : "browser",
    removed: Number(r.removed) === 1,
    inSafari: Number(r.in_safari) === 1,
    seq: Number(r.seq),
    updatedAt: Number(r.updated_at),
    lastActor: r.last_actor === null ? null : String(r.last_actor),
  };
}

class SqlStore implements Store {
  constructor(private readonly sql: SqlStorage) {}

  get(url: string): Row | null {
    const rows = this.sql.exec("SELECT * FROM bookmarks WHERE url = ?", url).toArray();
    return rows.length ? rowFromDb(rows[0]) : null;
  }

  put(row: Row): void {
    this.sql.exec(
      `INSERT INTO bookmarks (url, title, folder_path, idx, owner, removed, in_safari, seq, updated_at, last_actor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET
         title = excluded.title, folder_path = excluded.folder_path, idx = excluded.idx,
         owner = excluded.owner, removed = excluded.removed, in_safari = excluded.in_safari,
         seq = excluded.seq, updated_at = excluded.updated_at, last_actor = excluded.last_actor`,
      row.url,
      row.title,
      JSON.stringify(row.folderPath),
      row.idx,
      row.owner,
      row.removed ? 1 : 0,
      row.inSafari ? 1 : 0,
      row.seq,
      row.updatedAt,
      row.lastActor,
    );
  }

  all(): Row[] {
    return this.sql.exec("SELECT * FROM bookmarks").toArray().map(rowFromDb);
  }

  countActive(): number {
    return Number(this.sql.exec("SELECT COUNT(*) AS n FROM bookmarks WHERE removed = 0").one().n);
  }

  currentSeq(): number {
    return Number(this.sql.exec("SELECT value FROM meta WHERE key = 'seq'").one().value);
  }

  nextSeq(): number {
    const next = this.currentSeq() + 1;
    this.sql.exec("UPDATE meta SET value = ? WHERE key = 'seq'", String(next));
    return next;
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export class SyncGroup extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly store: SqlStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.store = new SqlStore(this.sql);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(WS.ping, WS.pong));
  }

  // Schema is created only by init(), so a request for a random pair id never
  // writes storage.
  private initialized(): boolean {
    return this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0;
  }

  private meta(key: string): string | null {
    const rows = this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray();
    return rows.length ? String(rows[0].value) : null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, value);
  }

  private maxActive(): number {
    return Number(this.meta("max_bookmarks") ?? LIMITS.activeBookmarks);
  }

  private horizon(): number {
    return Number(this.meta("horizon") ?? 0);
  }

  private disabled(): boolean {
    return this.meta("disabled_at") !== null;
  }

  private activeSafariDevice(): string | null {
    const rows = this.sql
      .exec("SELECT id FROM devices WHERE platform = 'safari' AND revoked_at IS NULL LIMIT 1")
      .toArray();
    return rows.length ? String(rows[0].id) : null;
  }

  private insertDevice(id: string, platform: Platform, name: string | null, tokenHash: string, now: number): void {
    this.sql.exec(
      "INSERT INTO devices (id, platform, name, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      platform,
      name,
      tokenHash,
      now,
      now,
    );
  }

  async init(input: { pairId: string; platform: Platform; name: string | null; maxBookmarks: number }): Promise<RpcResult> {
    const deviceId = crypto.randomUUID();
    const secret = randomHex(32);
    const tokenHash = await sha256Hex(secret);
    if (this.initialized()) return fail(409, "group_exists");
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      for (const statement of SCHEMA) this.sql.exec(statement);
      this.setMeta("pair_id", input.pairId);
      this.setMeta("seq", "0");
      this.setMeta("created_at", String(now));
      this.setMeta("schema", "1");
      this.setMeta("max_bookmarks", String(input.maxBookmarks));
      this.insertDevice(deviceId, input.platform, input.name, tokenHash, now);
    });
    return ok({ device_id: deviceId, secret });
  }

  async addDevice(input: { platform: Platform; name: string | null }): Promise<RpcResult> {
    const deviceId = crypto.randomUUID();
    const secret = randomHex(32);
    const tokenHash = await sha256Hex(secret);
    if (!this.initialized()) return fail(404, "group_not_found");
    if (this.disabled()) return fail(403, "group_disabled");
    if (input.platform === "safari" && this.activeSafariDevice()) return fail(409, "safari_device_exists");
    this.insertDevice(deviceId, input.platform, input.name, tokenHash, Date.now());
    return ok({ device_id: deviceId, secret, cursor: this.store.currentSeq() });
  }

  // Returns the device, or the error to send back.
  private async gate(auth: DeviceAuth): Promise<DeviceRow | RpcResult> {
    if (!this.initialized()) return fail(401, "unauthorized");
    const candidate = await sha256Hex(auth.secret);
    const rows = this.sql.exec("SELECT * FROM devices WHERE id = ?", auth.deviceId).toArray();
    if (!rows.length) return fail(401, "unauthorized");
    const device = rows[0] as unknown as DeviceRow;
    if (device.revoked_at !== null || !timingSafeEqual(String(device.token_hash), candidate)) {
      return fail(401, "unauthorized");
    }
    if (this.disabled()) return fail(403, "group_disabled");
    const now = Date.now();
    if (device.last_seen_at === null || now - Number(device.last_seen_at) > DEVICE_SEEN_WRITE_INTERVAL_MS) {
      this.sql.exec("UPDATE devices SET last_seen_at = ? WHERE id = ?", now, auth.deviceId);
    }
    return device;
  }

  private notify(): void {
    const message = JSON.stringify({ type: "changed", cursor: this.store.currentSeq() });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // Closed sockets are cleaned up by the runtime.
      }
    }
  }

  private async scheduleCompaction(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + COMPACTION_INTERVAL_MS);
    }
  }

  async whoami(auth: DeviceAuth): Promise<RpcResult> {
    const device = await this.gate(auth);
    if (isResult(device)) return device;
    return ok({ device_id: device.id, platform: device.platform, name: device.name });
  }

  async snapshot(auth: DeviceAuth): Promise<RpcResult> {
    const device = await this.gate(auth);
    if (isResult(device)) return device;
    const bookmarks = this.sql
      .exec("SELECT * FROM bookmarks WHERE removed = 0 ORDER BY folder_path, idx, url")
      .toArray()
      .map(r => toPublic(rowFromDb(r)));
    return ok({ cursor: this.store.currentSeq(), count: bookmarks.length, bookmarks });
  }

  async changes(auth: DeviceAuth, since: number, limit: number): Promise<RpcResult> {
    const device = await this.gate(auth);
    if (isResult(device)) return device;
    if (since > 0 && since < this.horizon()) return fail(409, "cursor_expired");
    const rows = this.sql
      .exec("SELECT * FROM bookmarks WHERE seq > ? ORDER BY seq LIMIT ?", since, limit + 1)
      .toArray()
      .map(rowFromDb);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const cursor = hasMore ? page[page.length - 1].seq : Math.max(since, this.store.currentSeq());
    return ok({ cursor, has_more: hasMore, changes: page.map(toPublic) });
  }

  async browserChanges(auth: DeviceAuth, bodyText: string): Promise<RpcResult> {
    const device = await this.gate(auth);
    if (isResult(device)) return device;
    if (device.platform === "safari") return fail(403, "safari_uses_snapshot");
    const body = parseJson(bodyText);
    if (!body || !Array.isArray(body.ops)) return fail(400, "invalid_body");
    if (body.ops.length > LIMITS.opsPerRequest) return fail(413, "too_many_ops");
    const baseCursor = typeof body.base_cursor === "number" && body.base_cursor >= 0 ? Math.floor(body.base_cursor) : 0;
    if (baseCursor > 0 && baseCursor < this.horizon()) return fail(409, "cursor_expired");
    const now = Date.now();
    const result = this.ctx.storage.transactionSync(() =>
      applyBrowserOps(this.store, body.ops as unknown[], baseCursor, auth.deviceId, now, this.maxActive()),
    );
    if (result.changed) {
      this.notify();
      await this.scheduleCompaction();
    }
    return ok({ cursor: this.store.currentSeq(), results: result.results });
  }

  async safariSnapshot(auth: DeviceAuth, bodyText: string): Promise<RpcResult> {
    const device = await this.gate(auth);
    if (isResult(device)) return device;
    if (device.platform !== "safari") return fail(403, "safari_only");
    const body = parseJson(bodyText);
    if (!body || !Array.isArray(body.bookmarks)) return fail(400, "invalid_body");
    if (body.bookmarks.length > LIMITS.snapshotItems) return fail(413, "too_many_bookmarks");
    const unconfirmed = Array.isArray(body.unconfirmed_imports) ? body.unconfirmed_imports : [];
    const now = Date.now();
    const { result, pending, cursor } = this.ctx.storage.transactionSync(() => {
      const result = applySafariSnapshot(
        this.store,
        body.bookmarks as unknown[],
        unconfirmed,
        body.confirm_deletions === true,
        auth.deviceId,
        now,
        this.maxActive(),
      );
      return { result, pending: pendingImports(this.store), cursor: this.store.currentSeq() };
    });
    if (result.changed) {
      this.notify();
      await this.scheduleCompaction();
    }
    return ok({
      cursor,
      stats: result.stats,
      canonical_map: result.canonicalMap,
      skipped_sample: result.skippedSample,
      needs_confirmation: result.needsConfirmation,
      pending_imports: pending,
    });
  }

  async safariPending(auth: DeviceAuth): Promise<RpcResult> {
    const device = await this.gate(auth);
    if (isResult(device)) return device;
    if (device.platform !== "safari") return fail(403, "safari_only");
    return ok({ cursor: this.store.currentSeq(), pending_imports: pendingImports(this.store) });
  }

  async devices(auth: DeviceAuth): Promise<RpcResult> {
    const device = await this.gate(auth);
    if (isResult(device)) return device;
    const devices = this.sql
      .exec("SELECT id, platform, name, created_at, last_seen_at FROM devices WHERE revoked_at IS NULL ORDER BY created_at")
      .toArray()
      .map(r => ({ ...r, self: r.id === auth.deviceId }));
    return ok({ devices });
  }

  private closeSockets(tag?: string, code = 4001, reason = "device revoked"): void {
    for (const ws of tag ? this.ctx.getWebSockets(tag) : this.ctx.getWebSockets()) {
      try {
        ws.close(code, reason);
      } catch {
        // Already closed.
      }
    }
  }

  async revokeDevice(auth: DeviceAuth, target: string): Promise<RpcResult> {
    const device = await this.gate(auth);
    if (isResult(device)) return device;
    const deviceId = target === "self" ? auth.deviceId : target;
    const rows = this.sql.exec("SELECT id FROM devices WHERE id = ? AND revoked_at IS NULL", deviceId).toArray();
    if (!rows.length) return fail(404, "device_not_found");
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE devices SET revoked_at = ? WHERE id = ?", Date.now(), deviceId);
      this.sql.exec("DELETE FROM ws_tickets WHERE device_id = ?", deviceId);
    });
    this.closeSockets(deviceId);
    return ok({ revoked: deviceId });
  }

  async wsTicket(auth: DeviceAuth): Promise<RpcResult> {
    const device = await this.gate(auth);
    if (isResult(device)) return device;
    const ticket = randomHex(32);
    const hash = await sha256Hex(ticket);
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM ws_tickets WHERE expires_at <= ?", now);
      this.sql.exec(
        "INSERT INTO ws_tickets (ticket_hash, device_id, expires_at) VALUES (?, ?, ?)",
        hash,
        auth.deviceId,
        now + WS.ticketTtlMs,
      );
    });
    return ok({ ticket, expires_in: Math.floor(WS.ticketTtlMs / 1000) });
  }

  // ------------------------------------------------------------------ admin

  async stats(): Promise<RpcResult> {
    if (!this.initialized()) return fail(404, "group_not_found");
    const count = (sql: string) => Number(this.sql.exec(sql).one().n);
    return ok({
      pair_id: this.meta("pair_id"),
      created_at: Number(this.meta("created_at")),
      disabled_at: this.meta("disabled_at") === null ? null : Number(this.meta("disabled_at")),
      max_bookmarks: this.maxActive(),
      cursor: this.store.currentSeq(),
      bookmarks: count("SELECT COUNT(*) AS n FROM bookmarks WHERE removed = 0"),
      tombstones: count("SELECT COUNT(*) AS n FROM bookmarks WHERE removed = 1"),
      devices: this.sql
        .exec("SELECT id, platform, name, created_at, last_seen_at FROM devices WHERE revoked_at IS NULL ORDER BY created_at")
        .toArray(),
      storage_bytes: this.ctx.storage.sql.databaseSize,
    });
  }

  async disable(): Promise<void> {
    if (!this.initialized() || this.disabled()) return;
    this.setMeta("disabled_at", String(Date.now()));
    this.sql.exec("DELETE FROM ws_tickets");
    this.closeSockets(undefined, 4003, "group disabled");
  }

  // Deletes everything this group stored.
  async purge(): Promise<void> {
    this.closeSockets(undefined, 4003, "group deleted");
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // Drops tombstones older than the retention period. A browser whose cursor
  // falls inside the dropped range gets `cursor_expired` and resyncs.
  async compact(now: number = Date.now()): Promise<{ purged: number; horizon: number }> {
    if (!this.initialized()) return { purged: 0, horizon: 0 };
    const cutoff = now - TOMBSTONE_RETENTION_MS;
    return this.ctx.storage.transactionSync(() => {
      const top = this.sql
        .exec("SELECT COUNT(*) AS n, MAX(seq) AS s FROM bookmarks WHERE removed = 1 AND updated_at < ?", cutoff)
        .one();
      const purged = Number(top.n);
      let horizon = this.horizon();
      if (purged > 0) {
        this.sql.exec("DELETE FROM bookmarks WHERE removed = 1 AND updated_at < ?", cutoff);
        horizon = Math.max(horizon, Number(top.s));
        this.setMeta("horizon", String(horizon));
      }
      return { purged, horizon };
    });
  }

  async alarm(): Promise<void> {
    await this.compact();
    const remaining = this.initialized()
      ? Number(this.sql.exec("SELECT COUNT(*) AS n FROM bookmarks WHERE removed = 1").one().n)
      : 0;
    if (remaining > 0) await this.ctx.storage.setAlarm(Date.now() + COMPACTION_INTERVAL_MS);
  }

  // --------------------------------------------------------------- websocket

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const ticket = new URL(request.url).searchParams.get("ticket") ?? "";
    if (!/^[0-9a-f]{64}$/.test(ticket) || !this.initialized() || this.disabled()) {
      return new Response("Unauthorized", { status: 401 });
    }
    const hash = await sha256Hex(ticket);
    const now = Date.now();
    const deviceId = this.ctx.storage.transactionSync(() => {
      const rows = this.sql.exec("SELECT device_id, expires_at FROM ws_tickets WHERE ticket_hash = ?", hash).toArray();
      this.sql.exec("DELETE FROM ws_tickets WHERE ticket_hash = ?", hash);
      if (!rows.length || Number(rows[0].expires_at) <= now) return null;
      const id = String(rows[0].device_id);
      const active = this.sql.exec("SELECT id FROM devices WHERE id = ? AND revoked_at IS NULL", id).toArray();
      return active.length ? id : null;
    });
    if (!deviceId) return new Response("Unauthorized", { status: 401 });

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [deviceId]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(): Promise<void> {
    // Pings are answered by the auto-response; clients send nothing else.
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }
}
