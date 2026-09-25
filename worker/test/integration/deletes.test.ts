import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "https://sync.test";
const ADMIN = "test-admin-key-with-enough-length";
let ipCounter = 0;
const freshIp = () => `192.0.2.${++ipCounter}`;

async function call(method: string, path: string, options: { token?: string; body?: unknown } = {}) {
  const headers = new Headers({ "CF-Connecting-IP": freshIp() });
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await exports.default.fetch(
    new Request(BASE + path, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) }),
  );
  const text = await response.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: response.status, body: (text ? JSON.parse(text) : null) as any };
}

async function createGroup() {
  const key = (await call("POST", "/v2/admin/keys", { token: ADMIN, body: { label: "deletes" } })).body.key;
  const safari = await call("POST", "/v2/connect", { body: { platform: "safari", name: "Mac mini", access_key: key } });
  const chrome = await call("POST", "/v2/join", { body: { code: safari.body.code, platform: "chrome" } });
  return { safari: safari.body.token as string, chrome: chrome.body.token as string, pairId: safari.body.pair_id as string };
}

const site = (i: number) => `https://site${i}.example/`;
const bookmarks = (n: number) => Array.from({ length: n }, (_, i) => ({ url: site(i), title: `Site ${i}`, folderPath: ["Favorites"] }));

describe("two-way deletes", () => {
  it("a bookmark deleted in a browser is removed from Safari by the app", async () => {
    const { safari, chrome } = await createGroup();
    await call("POST", "/v2/safari/snapshot", { token: safari, body: { bookmarks: bookmarks(3) } });

    const removed = await call("POST", "/v2/changes", { token: chrome, body: { base_cursor: 3, ops: [{ op: "remove", url: site(0) }] } });
    expect(removed.body.results).toEqual([{ url: site(0), status: "applied" }]);
    expect(removed.body.needs_confirmation).toBeNull();

    const pending = await call("GET", "/v2/safari/pending", { token: safari });
    expect(pending.body.pending_deletions).toEqual([site(0)]);

    // Safari still has it: it stays deleted and stays pending.
    const still = await call("POST", "/v2/safari/snapshot", { token: safari, body: { bookmarks: bookmarks(3) } });
    expect(still.body.stats.restored).toBe(0);
    expect(still.body.pending_deletions).toEqual([site(0)]);

    // The app removed it from the plist.
    const done = await call("POST", "/v2/safari/snapshot", { token: safari, body: { bookmarks: bookmarks(3).slice(1) } });
    expect(done.body.pending_deletions).toEqual([]);
    expect(done.body.stats.deleted).toBe(0);
    expect((await call("GET", "/v2/snapshot", { token: chrome })).body.count).toBe(2);
  });

  it("an import deleted in Safari is deleted in the browsers", async () => {
    const { safari, chrome } = await createGroup();
    await call("POST", "/v2/safari/snapshot", { token: safari, body: { bookmarks: bookmarks(1) } });
    const created = await call("POST", "/v2/changes", {
      token: chrome,
      body: { base_cursor: 1, ops: [{ op: "create", url: "https://new.example/", folderPath: ["Favorites"] }] },
    });
    expect(created.body.results[0].status).toBe("applied");
    // The app wrote it into the plist, then the user deleted it in Safari.
    await call("POST", "/v2/safari/snapshot", {
      token: safari,
      body: { bookmarks: [...bookmarks(1), { url: "https://new.example/", folderPath: ["Favorites"] }], unconfirmed_imports: ["https://new.example/"] },
    });
    const deleted = await call("POST", "/v2/safari/snapshot", {
      token: safari,
      body: { bookmarks: bookmarks(1), deleted_imports: ["https://new.example/"] },
    });
    expect(deleted.body.stats.deleted).toBe(1);
    expect(deleted.body.pending_imports).toEqual([]);
    const changes = await call("GET", "/v2/changes?since=2", { token: chrome });
    expect(changes.body.changes).toMatchObject([{ url: "https://new.example/", removed: true }]);
  });

  it("a large browser delete, even split over requests, waits for confirmation", async () => {
    const { safari, chrome } = await createGroup();
    await call("POST", "/v2/safari/snapshot", { token: safari, body: { bookmarks: bookmarks(100) } });
    const remove = (from: number, to: number) => bookmarks(100).slice(from, to).map(b => ({ op: "remove", url: b.url }));

    const first = await call("POST", "/v2/changes", { token: chrome, body: { base_cursor: 100, ops: remove(0, 15) } });
    expect(first.body.needs_confirmation).toBeNull();
    const second = await call("POST", "/v2/changes", { token: chrome, body: { base_cursor: 115, ops: remove(15, 30) } });
    expect(second.body.needs_confirmation.count).toBe(15);
    expect(second.body.results[0]).toMatchObject({ status: "rejected", reason: "mass_delete", state: { removed: false } });

    const confirmed = await call("POST", "/v2/changes", {
      token: chrome,
      body: { base_cursor: 115, ops: remove(15, 30), confirm_deletions: true },
    });
    expect(confirmed.body.results.every((r: { status: string }) => r.status === "applied")).toBe(true);
    const pending = await call("GET", "/v2/safari/pending", { token: safari });
    expect(pending.body.pending_deletions).toHaveLength(30);
  });

  it("upgrades a group created before two-way deletes", async () => {
    const { safari, chrome, pairId } = await createGroup();
    await call("POST", "/v2/safari/snapshot", { token: safari, body: { bookmarks: bookmarks(2) } });
    const stub = env.SYNC_GROUP.get(env.SYNC_GROUP.idFromName(pairId));
    await runInDurableObject(stub, (instance, state) => {
      state.storage.sql.exec("ALTER TABLE bookmarks DROP COLUMN safari_delete");
      state.storage.sql.exec("UPDATE meta SET value = '1' WHERE key = 'schema'");
      (instance as unknown as { schemaChecked: boolean }).schemaChecked = false;
    });

    const removed = await call("POST", "/v2/changes", { token: chrome, body: { base_cursor: 2, ops: [{ op: "remove", url: site(1) }] } });
    expect(removed.body.results[0].status).toBe("applied");
    expect((await call("GET", "/v2/safari/pending", { token: safari })).body.pending_deletions).toEqual([site(1)]);
    const schema = await runInDurableObject(stub, (_instance, state) =>
      String(state.storage.sql.exec("SELECT value FROM meta WHERE key = 'schema'").one().value),
    );
    expect(schema).toBe("2");
  });
});
