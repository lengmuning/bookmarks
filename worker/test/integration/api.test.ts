import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "https://sync.test";
const MASTER = "test-master-access-key";
const ADMIN = "test-admin-key-with-enough-length";
let ipCounter = 0;
const freshIp = () => `198.51.100.${++ipCounter}`;

interface CallOptions {
  token?: string;
  body?: unknown;
  ip?: string;
}

async function call(method: string, path: string, options: CallOptions = {}) {
  const headers = new Headers({ "CF-Connecting-IP": options.ip ?? freshIp() });
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await exports.default.fetch(
    new Request(BASE + path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
  );
  const text = await response.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: response.status, body: (text ? JSON.parse(text) : null) as any };
}

// Each test user gets their own access key, as the admin would issue it.
async function newKey(label = "user", extra: Record<string, unknown> = {}) {
  const issued = await call("POST", "/v2/admin/keys", { token: ADMIN, body: { label, ...extra } });
  expect(issued.status).toBe(200);
  return issued.body.key as string;
}

async function createGroup() {
  const key = await newKey();
  const safari = await call("POST", "/v2/connect", { body: { platform: "safari", name: "Test Mac", access_key: key } });
  expect(safari.status).toBe(200);
  expect(safari.body.created).toBe(true);
  const chrome = await call("POST", "/v2/join", { body: { code: safari.body.code, platform: "chrome", name: "Chrome" } });
  expect(chrome.status).toBe(200);
  return { safari: safari.body.token as string, chrome: chrome.body.token as string, pairId: safari.body.pair_id as string };
}

const A = "https://a.example/";
const B = "https://b.example/";

describe("pairing", () => {
  it("creates a group with a formatted single-use code", async () => {
    const created = await call("POST", "/v2/connect", { body: { platform: "safari", name: "Mac", access_key: await newKey() } });
    expect(created.status).toBe(200);
    expect(created.body.code).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    expect(created.body.token).toMatch(/^v2\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.[0-9a-f]{64}$/);

    const loose = created.body.code.toLowerCase().replace("-", " ");
    const joined = await call("POST", "/v2/join", { body: { code: loose, platform: "chrome" } });
    expect(joined.status).toBe(200);
    expect(joined.body.pair_id).toBe(created.body.pair_id);

    const again = await call("POST", "/v2/join", { body: { code: created.body.code, platform: "firefox" } });
    expect(again.status).toBe(404);
  });

  it("invalidates the previous code when a new one is issued", async () => {
    const created = await call("POST", "/v2/connect", { body: { platform: "safari", access_key: await newKey() } });
    const next = await call("POST", "/v2/pair-code", { token: created.body.token });
    expect(next.status).toBe(200);
    expect((await call("POST", "/v2/join", { body: { code: created.body.code, platform: "chrome" } })).status).toBe(404);
    expect((await call("POST", "/v2/join", { body: { code: next.body.code, platform: "chrome" } })).status).toBe(200);
  });

  it("allows only one Safari device per group", async () => {
    const { chrome } = await createGroup();
    const code = await call("POST", "/v2/pair-code", { token: chrome });
    const second = await call("POST", "/v2/join", { body: { code: code.body.code, platform: "safari" } });
    expect(second.status).toBe(409);
  });

  it("rate-limits failed joins per IP", async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i++) {
      const miss = await call("POST", "/v2/join", { ip, body: { code: "2222-2222", platform: "chrome" } });
      expect(miss.status).toBe(404);
    }
    const created = await call("POST", "/v2/connect", { body: { platform: "safari", access_key: await newKey() } });
    const blocked = await call("POST", "/v2/join", { ip, body: { code: created.body.code, platform: "chrome" } });
    expect(blocked.status).toBe(429);
    const other = await call("POST", "/v2/join", { body: { code: created.body.code, platform: "chrome" } });
    expect(other.status).toBe(200);
  });

  it("validates request bodies", async () => {
    expect((await call("POST", "/v2/connect", { body: { platform: "opera", access_key: MASTER } })).status).toBe(400);
    expect((await call("POST", "/v2/join", { body: { platform: "chrome" } })).status).toBe(400);
  });
});

describe("authentication and isolation", () => {
  it("rejects missing, malformed and forged tokens", async () => {
    const one = await createGroup();
    const two = await createGroup();
    expect((await call("GET", "/v2/snapshot")).status).toBe(401);
    expect((await call("GET", "/v2/snapshot", { token: "v2.nope" })).status).toBe(401);

    const [, , deviceTwo, secretTwo] = two.chrome.split(".");
    const forged = `v2.${one.pairId}.${deviceTwo}.${secretTwo}`;
    expect((await call("GET", "/v2/snapshot", { token: forged })).status).toBe(401);
  });

  it("keeps groups separate even for the same URL", async () => {
    const one = await createGroup();
    const two = await createGroup();
    await call("POST", "/v2/safari/snapshot", { token: one.safari, body: { bookmarks: [{ url: A, title: "one", folderPath: ["Favorites"] }] } });
    await call("POST", "/v2/safari/snapshot", { token: two.safari, body: { bookmarks: [{ url: A, title: "two", folderPath: ["Favorites"] }] } });
    const snapOne = await call("GET", "/v2/snapshot", { token: one.chrome });
    const snapTwo = await call("GET", "/v2/snapshot", { token: two.chrome });
    expect(snapOne.body.bookmarks.map((b: { title: string }) => b.title)).toEqual(["one"]);
    expect(snapTwo.body.bookmarks.map((b: { title: string }) => b.title)).toEqual(["two"]);
  });

  it("restricts endpoints by platform", async () => {
    const { safari, chrome } = await createGroup();
    expect((await call("POST", "/v2/safari/snapshot", { token: chrome, body: { bookmarks: [] } })).status).toBe(403);
    expect((await call("GET", "/v2/safari/pending", { token: chrome })).status).toBe(403);
    expect((await call("POST", "/v2/changes", { token: safari, body: { base_cursor: 0, ops: [] } })).status).toBe(403);
  });

  it("revokes devices", async () => {
    const { safari, chrome } = await createGroup();
    const listed = await call("GET", "/v2/devices", { token: safari });
    expect(listed.body.devices).toHaveLength(2);
    const chromeId = listed.body.devices.find((d: { platform: string }) => d.platform === "chrome").id;

    expect((await call("DELETE", `/v2/devices/${chromeId}`, { token: safari })).status).toBe(200);
    expect((await call("GET", "/v2/snapshot", { token: chrome })).status).toBe(401);
    expect((await call("GET", "/v2/devices", { token: safari })).body.devices).toHaveLength(1);
    expect((await call("DELETE", "/v2/devices/self", { token: safari })).status).toBe(200);
    expect((await call("GET", "/v2/devices", { token: safari })).status).toBe(401);
  });
});

describe("sync rules over HTTP", () => {
  it("enforces Safari's placement and tracks browser additions", async () => {
    const { safari, chrome } = await createGroup();
    const first = await call("POST", "/v2/safari/snapshot", {
      token: safari,
      body: { bookmarks: [{ url: A, title: "A", folderPath: ["Favorites", "Tech"], index: 0 }] },
    });
    expect(first.status).toBe(200);
    expect(first.body.stats.inserted).toBe(1);

    const moved = await call("POST", "/v2/changes", {
      token: chrome,
      body: { base_cursor: first.body.cursor, ops: [{ op: "update", url: A, title: "A", folderPath: ["Other"] }] },
    });
    expect(moved.body.results[0]).toMatchObject({ status: "rejected", reason: "safari_authority" });
    expect(moved.body.results[0].state.folderPath).toEqual(["Favorites", "Tech"]);

    const added = await call("POST", "/v2/changes", {
      token: chrome,
      body: { base_cursor: moved.body.cursor, ops: [{ op: "create", url: B, title: "B", folderPath: ["Favorites", "New"] }] },
    });
    expect(added.body.results[0].status).toBe("applied");

    const pending = await call("GET", "/v2/safari/pending", { token: safari });
    expect(pending.body.pending_imports.map((r: { url: string }) => r.url)).toEqual([B]);

    const imported = await call("POST", "/v2/safari/snapshot", {
      token: safari,
      body: {
        bookmarks: [
          { url: A, title: "A", folderPath: ["Favorites", "Tech"] },
          { url: B, title: "B", folderPath: ["Favorites", "New"] },
        ],
        unconfirmed_imports: [B],
      },
    });
    expect(imported.body.pending_imports).toEqual([]);

    await call("POST", "/v2/safari/snapshot", {
      token: safari,
      body: {
        bookmarks: [
          { url: A, title: "A", folderPath: ["Favorites", "Tech"] },
          { url: B, title: "B", folderPath: ["Favorites", "New"] },
        ],
      },
    });
    const snap = await call("GET", "/v2/snapshot", { token: chrome });
    expect(snap.body.bookmarks.map((b: { url: string; owner: string }) => [b.url, b.owner])).toEqual([
      [B, "safari"],
      [A, "safari"],
    ]);
  });

  it("returns needs_confirmation instead of mass-deleting", async () => {
    const { safari } = await createGroup();
    const all = Array.from({ length: 50 }, (_, i) => ({ url: `https://s${i}.example/`, folderPath: ["Favorites"] }));
    await call("POST", "/v2/safari/snapshot", { token: safari, body: { bookmarks: all } });
    const guarded = await call("POST", "/v2/safari/snapshot", { token: safari, body: { bookmarks: all.slice(0, 20) } });
    expect(guarded.body.needs_confirmation.count).toBe(30);
    expect(guarded.body.stats.deleted).toBe(0);
    const confirmed = await call("POST", "/v2/safari/snapshot", {
      token: safari,
      body: { bookmarks: all.slice(0, 20), confirm_deletions: true },
    });
    expect(confirmed.body.stats.deleted).toBe(30);
  });

  it("pages through changes with a seq cursor", async () => {
    const { chrome } = await createGroup();
    const opsList = Array.from({ length: 5 }, (_, i) => ({ op: "create", url: `https://p${i}.example/`, title: `p${i}`, folderPath: [] }));
    const posted = await call("POST", "/v2/changes", { token: chrome, body: { base_cursor: 0, ops: opsList } });
    expect(posted.body.cursor).toBe(5);

    const seen: string[] = [];
    let cursor = 0;
    for (;;) {
      const page = await call("GET", `/v2/changes?since=${cursor}&limit=2`, { token: chrome });
      seen.push(...page.body.changes.map((c: { url: string }) => c.url));
      cursor = page.body.cursor;
      if (!page.body.has_more) break;
    }
    expect(seen).toEqual(opsList.map(o => o.url));
    expect(cursor).toBe(5);

    const empty = await call("GET", `/v2/changes?since=${cursor}`, { token: chrome });
    expect(empty.body).toMatchObject({ cursor: 5, has_more: false, changes: [] });
  });

  it("rejects oversized batches", async () => {
    const { chrome } = await createGroup();
    const ops = Array.from({ length: 501 }, (_, i) => ({ op: "create", url: `https://x${i}.example/`, folderPath: [] }));
    expect((await call("POST", "/v2/changes", { token: chrome, body: { base_cursor: 0, ops } })).status).toBe(413);
  });
});

describe("websocket", () => {
  async function connect(token: string, pairId: string) {
    const issued = await call("POST", "/v2/ws-ticket", { token });
    expect(issued.status).toBe(200);
    expect(issued.body.path).toBe(`/v2/ws?pair=${pairId}&ticket=${issued.body.ticket}`);
    const response = await exports.default.fetch(new Request(BASE + issued.body.path, { headers: { Upgrade: "websocket" } }));
    return { response, path: issued.body.path as string };
  }

  it("uses single-use tickets and notifies on change", async () => {
    const { safari, chrome, pairId } = await createGroup();
    const { response, path } = await connect(chrome, pairId);
    expect(response.status).toBe(101);
    const ws = response.webSocket!;
    ws.accept();

    const reuse = await exports.default.fetch(new Request(BASE + path, { headers: { Upgrade: "websocket" } }));
    expect(reuse.status).toBe(401);

    const message = new Promise<string>(resolve => ws.addEventListener("message", (e: MessageEvent) => resolve(String(e.data)), { once: true }));
    await call("POST", "/v2/safari/snapshot", { token: safari, body: { bookmarks: [{ url: A, folderPath: [] }] } });
    expect(JSON.parse(await message)).toEqual({ type: "changed", cursor: 1 });
    ws.close();
  });

  it("answers pings without a handler", async () => {
    const { chrome, pairId } = await createGroup();
    const { response } = await connect(chrome, pairId);
    const ws = response.webSocket!;
    ws.accept();
    const reply = new Promise<string>(resolve => ws.addEventListener("message", (e: MessageEvent) => resolve(String(e.data)), { once: true }));
    ws.send('{"type":"ping"}');
    expect(await reply).toBe('{"type":"pong"}');
    ws.close();
  });

  it("rejects bad tickets", async () => {
    const { pairId } = await createGroup();
    const bad = await exports.default.fetch(
      new Request(`${BASE}/v2/ws?pair=${pairId}&ticket=${"0".repeat(64)}`, { headers: { Upgrade: "websocket" } }),
    );
    expect(bad.status).toBe(401);
  });
});

describe("access keys", () => {
  const adminCall = (method: string, path: string, body?: unknown, key = ADMIN) =>
    call(method, path, { token: key, body });

  it("requires a valid access key to create a group", async () => {
    expect((await call("POST", "/v2/connect", { body: { platform: "safari" } })).status).toBe(401);
    const wrong = await call("POST", "/v2/connect", { body: { platform: "safari", access_key: "not-the-key-at-all" } });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toBe("invalid_access_key");
    const header = await exports.default.fetch(
      new Request(`${BASE}/v2/connect`, {
        method: "POST",
        headers: { "CF-Connecting-IP": freshIp(), "X-Access-Key": MASTER, "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "safari" }),
      }),
    );
    expect(header.status).toBe(200);
    const listed = await adminCall("GET", "/v2/admin/keys");
    expect(listed.body.master_group.pair_id).toBe(((await header.json()) as { pair_id: string }).pair_id);
  });

  it("protects the admin API", async () => {
    expect((await adminCall("GET", "/v2/admin/keys", undefined, "wrong-admin-key-000000000")).status).toBe(401);
    expect((await call("GET", "/v2/admin/keys")).status).toBe(401);
    expect((await adminCall("GET", "/v2/admin/keys", undefined, MASTER)).status).toBe(401);
  });

  it("maps one access key to one group and lets a new Mac take over", async () => {
    const key = await newKey("me");
    const first = await call("POST", "/v2/connect", { body: { platform: "safari", name: "Old Mac", access_key: key } });
    expect(first.body.created).toBe(true);

    const chrome = await call("POST", "/v2/connect", { body: { platform: "chrome", access_key: key } });
    expect(chrome.status).toBe(200);
    expect(chrome.body).toMatchObject({ created: false, pair_id: first.body.pair_id });

    const again = await call("POST", "/v2/connect", { body: { platform: "safari", name: "New Mac", access_key: key } });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: "safari_device_exists", device: { name: "Old Mac" } });

    const takeover = await call("POST", "/v2/connect", {
      body: { platform: "safari", name: "New Mac", access_key: key, replace_safari: true },
    });
    expect(takeover.status).toBe(200);
    expect(takeover.body).toMatchObject({ created: false, pair_id: first.body.pair_id });
    expect(takeover.body.replaced_device).toBe(first.body.device_id);
    expect((await call("GET", "/v2/snapshot", { token: first.body.token })).status).toBe(401);
    const devices = await call("GET", "/v2/devices", { token: takeover.body.token });
    expect(devices.body.devices.map((d: { name: string | null }) => d.name ?? "").sort()).toEqual(["", "New Mac"]);
  });

  it("issues per-user keys with a bookmark limit and revokes them", async () => {
    const issued = await adminCall("POST", "/v2/admin/keys", { label: "friend", max_bookmarks: 2 });
    expect(issued.status).toBe(200);
    expect(issued.body.key).toMatch(/^sbk_[0-9a-f]{48}$/);

    const first = await call("POST", "/v2/connect", { body: { platform: "safari", access_key: issued.body.key } });
    expect(first.status).toBe(200);
    const three = [A, B, "https://c.example/"].map(url => ({ url, folderPath: [] }));
    const capped = await call("POST", "/v2/safari/snapshot", { token: first.body.token, body: { bookmarks: three } });
    expect(capped.body.stats).toMatchObject({ inserted: 2, skipped: 1 });

    const listed = await adminCall("GET", "/v2/admin/keys");
    const entry = listed.body.keys.find((k: { id: string }) => k.id === issued.body.id);
    expect(entry).toMatchObject({ label: "friend", max_bookmarks: 2, revoked_at: null, group: { pair_id: first.body.pair_id } });

    const stats = await adminCall("GET", `/v2/admin/groups/${first.body.pair_id}`);
    expect(stats.body).toMatchObject({ bookmarks: 2, tombstones: 0, max_bookmarks: 2 });

    const revoked = await adminCall("DELETE", `/v2/admin/keys/${issued.body.id}`);
    expect(revoked.body.disabled_groups).toEqual([first.body.pair_id]);
    const blocked = await call("GET", "/v2/snapshot", { token: first.body.token });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe("group_disabled");
    const join = await call("POST", "/v2/join", { body: { code: first.body.code, platform: "chrome" } });
    expect(join.status).toBe(404);
    expect((await call("POST", "/v2/connect", { body: { platform: "safari", access_key: issued.body.key } })).body.error).toBe(
      "invalid_access_key",
    );
  });

  it("disables and deletes single groups", async () => {
    const { safari, chrome, pairId } = await createGroup();
    expect((await adminCall("POST", `/v2/admin/groups/${pairId}/disable`)).status).toBe(200);
    expect((await call("GET", "/v2/snapshot", { token: chrome })).body.error).toBe("group_disabled");
    expect((await adminCall("DELETE", `/v2/admin/groups/${pairId}`)).status).toBe(200);
    expect((await call("GET", "/v2/snapshot", { token: safari })).status).toBe(401);
    expect((await adminCall("GET", `/v2/admin/groups/${pairId}`)).status).toBe(404);
  });

  it("answers 404 on the removed v1 API", async () => {
    const res = await exports.default.fetch(
      new Request(`${BASE}/api/pair/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("tombstone compaction", () => {
  it("purges old tombstones and makes stale cursors resync", async () => {
    const { chrome, pairId } = await createGroup();
    await call("POST", "/v2/changes", { token: chrome, body: { base_cursor: 0, ops: [{ op: "create", url: A, folderPath: [] }] } });
    await call("POST", "/v2/changes", { token: chrome, body: { base_cursor: 1, ops: [{ op: "remove", url: A }] } });
    await call("POST", "/v2/changes", { token: chrome, body: { base_cursor: 2, ops: [{ op: "create", url: B, folderPath: [] }] } });

    const stub = env.SYNC_GROUP.get(env.SYNC_GROUP.idFromName(pairId));
    expect(await stub.compact(Date.now())).toEqual({ purged: 0, horizon: 0 });
    expect(await stub.compact(Date.now() + 91 * 24 * 60 * 60 * 1000)).toEqual({ purged: 1, horizon: 2 });

    const stale = await call("GET", "/v2/changes?since=1", { token: chrome });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("cursor_expired");
    expect((await call("GET", "/v2/changes?since=2", { token: chrome })).status).toBe(200);
    expect((await call("GET", "/v2/changes?since=0", { token: chrome })).body.changes.map((c: { url: string }) => c.url)).toEqual([B]);
    const staleOps = await call("POST", "/v2/changes", { token: chrome, body: { base_cursor: 1, ops: [] } });
    expect(staleOps.status).toBe(409);
  });
});
