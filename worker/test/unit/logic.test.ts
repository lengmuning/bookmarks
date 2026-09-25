import { beforeEach, describe, expect, it } from "vitest";
import { applyBrowserOps, applySafariSnapshot, pendingDeletions, pendingImports } from "../../src/v2/logic";
import { MemoryStore } from "./memory-store";

const NOW = 1_700_000_000_000;
const A = "https://a.example/";
const B = "https://b.example/";

function bm(url: string, folderPath: string[], title = url, index = 0) {
  return { url, title, folderPath, index };
}

function snapshot(store: MemoryStore, items: unknown[], unconfirmed: unknown[] = [], confirm = false, deletedImports: unknown[] = []) {
  return applySafariSnapshot(store, items, unconfirmed, confirm, "safari-device", NOW, undefined, deletedImports);
}

function ops(store: MemoryStore, list: unknown[], baseCursor = store.seq, confirm = false, recentSafariDeletes = 0) {
  return applyBrowserOps(store, list, baseCursor, "chrome-device", NOW, undefined, { confirm, recentSafariDeletes });
}

const sites = (n: number, folder: string[] = ["Favorites"]) =>
  Array.from({ length: n }, (_, i) => bm(`https://site${i}.example/`, folder));

let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore();
});

describe("browser ops", () => {
  it("inserts an unknown URL as browser-owned and canonicalizes it", () => {
    const { results, changed } = ops(store, [{ op: "create", url: "HTTPS://A.example", title: "A", folderPath: ["Work"] }]);
    expect(results).toEqual([{ url: A, status: "applied" }]);
    expect(changed).toBe(true);
    expect(store.row(A)).toMatchObject({ owner: "browser", folderPath: ["Work"], seq: 1, removed: false });
  });

  it("is idempotent: the same create twice does not take a new seq", () => {
    ops(store, [{ op: "create", url: A, title: "A", folderPath: ["Work"] }]);
    const second = ops(store, [{ op: "create", url: A, title: "A", folderPath: ["Work"] }]);
    expect(second.results[0].status).toBe("noop");
    expect(second.changed).toBe(false);
    expect(store.seq).toBe(1);
  });

  it("updates a browser-owned row and bumps seq; index-only changes do not bump", () => {
    ops(store, [{ op: "create", url: A, title: "A", folderPath: ["Work"], index: 1 }]);
    expect(ops(store, [{ op: "update", url: A, title: "A", folderPath: ["Work"], index: 5 }]).results[0].status).toBe("noop");
    expect(store.row(A).idx).toBe(5);
    expect(store.seq).toBe(1);
    expect(ops(store, [{ op: "update", url: A, title: "A2", folderPath: ["Home"] }]).results[0].status).toBe("applied");
    expect(store.row(A)).toMatchObject({ title: "A2", folderPath: ["Home"], seq: 2 });
  });

  it("removes a browser-owned row as a tombstone", () => {
    ops(store, [{ op: "create", url: A, title: "A", folderPath: [] }]);
    expect(ops(store, [{ op: "remove", url: A }]).results[0].status).toBe("applied");
    expect(store.row(A)).toMatchObject({ removed: true, seq: 2 });
    expect(ops(store, [{ op: "remove", url: A }]).results[0].status).toBe("noop");
  });

  it("does not resurrect a delete the browser has not seen yet", () => {
    ops(store, [{ op: "create", url: A, title: "A", folderPath: [] }]); // seq 1
    ops(store, [{ op: "remove", url: A }]); // seq 2
    const stale = ops(store, [{ op: "create", url: A, title: "A", folderPath: [] }], 1);
    expect(stale.results[0]).toMatchObject({ status: "rejected", reason: "deleted", state: { url: A, removed: true } });
    expect(store.row(A).removed).toBe(true);
  });

  it("restores a URL re-added after the browser applied the delete", () => {
    ops(store, [{ op: "create", url: A, title: "A", folderPath: [] }]);
    ops(store, [{ op: "remove", url: A }]); // seq 2
    const fresh = ops(store, [{ op: "create", url: A, title: "A again", folderPath: ["X"] }], 2);
    expect(fresh.results[0].status).toBe("applied");
    expect(store.row(A)).toMatchObject({ removed: false, owner: "browser", title: "A again", seq: 3 });
  });

  it("enforces Safari's placement for Safari-owned rows", () => {
    snapshot(store, [bm(A, ["Favorites", "Tech"], "Safari title")]);
    const same = ops(store, [{ op: "create", url: A, title: "Safari title", folderPath: ["Favorites", "Tech"] }]);
    expect(same.results[0].status).toBe("noop");

    const moved = ops(store, [{ op: "update", url: A, title: "Safari title", folderPath: ["Other"] }]);
    expect(moved.results[0]).toMatchObject({
      status: "rejected",
      reason: "safari_authority",
      state: { url: A, folderPath: ["Favorites", "Tech"], title: "Safari title", owner: "safari" },
    });

    const renamed = ops(store, [{ op: "update", url: A, title: "Renamed", folderPath: ["Favorites", "Tech"] }]);
    expect(renamed.results[0].status).toBe("rejected");

    expect(store.row(A)).toMatchObject({ removed: false, folderPath: ["Favorites", "Tech"], title: "Safari title" });
  });

  it("treats an empty browser title as equal to a missing Safari title", () => {
    snapshot(store, [{ url: A, folderPath: ["Favorites"] }]);
    expect(ops(store, [{ op: "update", url: A, title: "", folderPath: ["Favorites"] }]).results[0].status).toBe("noop");
  });

  it("rejects inserts beyond the group's bookmark limit", () => {
    const { results } = applyBrowserOps(
      store,
      [
        { op: "create", url: A, folderPath: [] },
        { op: "create", url: B, folderPath: [] },
      ],
      0,
      "chrome-device",
      NOW,
      1,
    );
    expect(results.map(r => r.status)).toEqual(["applied", "rejected"]);
    expect(results[1].reason).toBe("group_full");
  });

  it("reports invalid ops without touching the store", () => {
    const { results, changed } = ops(store, [
      { op: "create", url: "javascript:alert(1)", title: "x", folderPath: [] },
      { op: "rename", url: A },
      { op: "create", url: A, folderPath: "Favorites" },
      null,
    ]);
    expect(results.map(r => r.status)).toEqual(["invalid", "invalid", "invalid", "invalid"]);
    expect(changed).toBe(false);
    expect(store.rows.size).toBe(0);
  });
});

describe("browser deletes of Safari's bookmarks", () => {
  it("delete the bookmark everywhere and queue its removal from Safari", () => {
    snapshot(store, [bm(A, ["Favorites"]), bm(B, ["Favorites"])]);
    const removed = ops(store, [{ op: "remove", url: A }]);
    expect(removed.results[0]).toEqual({ url: A, status: "applied" });
    expect(removed.safariDeletes).toBe(1);
    expect(store.row(A)).toMatchObject({ removed: true, safariDelete: true, inSafari: false, seq: 3 });
    expect(pendingDeletions(store)).toEqual([A]);

    // Safari still has it until the app edits the plist: not restored.
    const before = snapshot(store, [bm(A, ["Favorites"]), bm(B, ["Favorites"])]);
    expect(before.stats).toMatchObject({ restored: 0, unchanged: 2 });
    expect(store.row(A).removed).toBe(true);

    // The app removed it: done.
    snapshot(store, [bm(B, ["Favorites"])]);
    expect(store.row(A)).toMatchObject({ removed: true, safariDelete: false });
    expect(pendingDeletions(store)).toEqual([]);

    // Seen in Safari again later (re-added there, or brought back by iCloud).
    expect(snapshot(store, [bm(A, ["Favorites"]), bm(B, ["Favorites"])]).stats.restored).toBe(1);
  });

  it("also removes an import that Safari has but not yet confirmed", () => {
    ops(store, [{ op: "create", url: B, title: "B", folderPath: [] }]);
    snapshot(store, [bm(B, [])], [B]);
    ops(store, [{ op: "remove", url: B }]);
    expect(store.row(B)).toMatchObject({ removed: true, safariDelete: true });
    expect(pendingDeletions(store)).toEqual([B]);
  });

  it("cancel the pending removal when a browser adds the bookmark back", () => {
    snapshot(store, [bm(A, ["Favorites"])]);
    ops(store, [{ op: "remove", url: A }]);
    const readded = ops(store, [{ op: "create", url: A, title: "A", folderPath: ["Favorites"] }]);
    expect(readded.results[0].status).toBe("applied");
    expect(store.row(A)).toMatchObject({ removed: false, safariDelete: false });
    expect(pendingDeletions(store)).toEqual([]);
  });

  it("hold a large delete back until the browser confirms it", () => {
    snapshot(store, sites(100));
    const doomed = sites(100).slice(0, 30).map(s => ({ op: "remove", url: s.url }));

    const held = ops(store, doomed);
    expect(held.needsConfirmation?.count).toBe(30);
    expect(held.results.every(r => r.status === "rejected" && r.reason === "mass_delete" && r.state)).toBe(true);
    expect(store.countActive()).toBe(100);

    const confirmed = ops(store, doomed, store.seq, true);
    expect(confirmed.needsConfirmation).toBeNull();
    expect(confirmed.results.every(r => r.status === "applied")).toBe(true);
    expect(pendingDeletions(store)).toHaveLength(30);
  });

  it("count earlier deletes of the guard window", () => {
    snapshot(store, sites(100));
    const ten = sites(100).slice(0, 10).map(s => ({ op: "remove", url: s.url }));
    expect(ops(store, ten, store.seq, false, 0).needsConfirmation).toBeNull();
    const more = sites(100).slice(10, 20).map(s => ({ op: "remove", url: s.url }));
    expect(ops(store, more, store.seq, false, 15).needsConfirmation?.count).toBe(10);
  });

  it("never hold deletes of browser bookmarks Safari does not have", () => {
    ops(store, sites(30, []).map(s => ({ op: "create", url: s.url, folderPath: [] })));
    const removed = ops(store, sites(30, []).map(s => ({ op: "remove", url: s.url })));
    expect(removed.needsConfirmation).toBeNull();
    expect(removed.safariDeletes).toBe(0);
    expect(pendingDeletions(store)).toEqual([]);
  });
});

describe("Safari snapshot", () => {
  it("inserts Safari bookmarks as Safari-owned and is a no-op when repeated", () => {
    const first = snapshot(store, [bm(A, ["Favorites"]), bm(B, ["Bookmarks Menu", "News"])]);
    expect(first.stats).toMatchObject({ received: 2, accepted: 2, inserted: 2, deleted: 0 });
    expect(store.row(A)).toMatchObject({ owner: "safari", inSafari: true, seq: 1 });

    const again = snapshot(store, [bm(A, ["Favorites"]), bm(B, ["Bookmarks Menu", "News"])]);
    expect(again.changed).toBe(false);
    expect(again.stats.unchanged).toBe(2);
    expect(store.seq).toBe(2);
  });

  it("applies Safari moves and renames", () => {
    snapshot(store, [bm(A, ["Favorites"], "A")]);
    const moved = snapshot(store, [bm(A, ["Favorites", "Tech"], "A2")]);
    expect(moved.stats.updated).toBe(1);
    expect(store.row(A)).toMatchObject({ folderPath: ["Favorites", "Tech"], title: "A2", seq: 2 });
  });

  it("deletes Safari-owned rows missing from the snapshot", () => {
    snapshot(store, [bm(A, []), bm(B, [])]);
    const result = snapshot(store, [bm(A, [])]);
    expect(result.stats.deleted).toBe(1);
    expect(store.row(B)).toMatchObject({ removed: true, inSafari: false });
  });

  it("asks for confirmation before a mass delete and deletes after confirmation", () => {
    const all = Array.from({ length: 100 }, (_, i) => bm(`https://site${i}.example/`, ["Favorites"]));
    snapshot(store, all);
    const kept = all.slice(30);

    const guarded = snapshot(store, kept);
    expect(guarded.needsConfirmation?.count).toBe(30);
    expect(guarded.needsConfirmation?.sample).toHaveLength(10);
    expect(guarded.stats.deleted).toBe(0);
    expect(store.countActive()).toBe(100);

    const confirmed = snapshot(store, kept, [], true);
    expect(confirmed.needsConfirmation).toBeNull();
    expect(confirmed.stats.deleted).toBe(30);
    expect(store.countActive()).toBe(70);
  });

  it("does not guard small deletes", () => {
    const all = Array.from({ length: 100 }, (_, i) => bm(`https://site${i}.example/`, []));
    snapshot(store, all);
    expect(snapshot(store, all.slice(20)).stats.deleted).toBe(20);
  });

  it("always guards an empty snapshot while Safari owns rows", () => {
    snapshot(store, [bm(A, [])]);
    const empty = snapshot(store, []);
    expect(empty.needsConfirmation).toEqual({ count: 1, sample: [A] });
    expect(store.row(A).removed).toBe(false);
  });

  it("takes ownership of a browser bookmark the user also has in Safari", () => {
    ops(store, [{ op: "create", url: A, title: "Chrome", folderPath: ["Chrome folder"] }]);
    snapshot(store, [bm(A, ["Favorites", "Tech"], "Safari")]);
    expect(store.row(A)).toMatchObject({ owner: "safari", folderPath: ["Favorites", "Tech"], title: "Safari" });
  });

  it("restores a URL deleted in a browser when Safari still has it", () => {
    ops(store, [{ op: "create", url: A, title: "A", folderPath: [] }]);
    ops(store, [{ op: "remove", url: A }]);
    const result = snapshot(store, [bm(A, ["Favorites"])]);
    expect(result.stats.restored).toBe(1);
    expect(store.row(A)).toMatchObject({ owner: "safari", removed: false });
  });

  it("tracks browser additions through import and confirmation", () => {
    snapshot(store, [bm(A, ["Favorites"])]);
    ops(store, [{ op: "create", url: B, title: "B", folderPath: ["Favorites", "New"] }]);
    expect(pendingImports(store).map(r => r.url)).toEqual([B]);

    // The app wrote B into the plist; Safari has not confirmed it yet.
    const unconfirmed = snapshot(store, [bm(A, ["Favorites"]), bm(B, ["Favorites", "New"])], [B]);
    expect(unconfirmed.changed).toBe(false);
    expect(store.row(B)).toMatchObject({ owner: "browser", inSafari: true });
    expect(pendingImports(store)).toEqual([]);

    // Confirmed: Safari rewrote the plist and kept B.
    snapshot(store, [bm(A, ["Favorites"]), bm(B, ["Favorites", "New"])]);
    expect(store.row(B)).toMatchObject({ owner: "safari" });
  });

  it("deletes an import everywhere once the app reports it was deleted in Safari", () => {
    snapshot(store, [bm(A, [])]);
    ops(store, [{ op: "create", url: B, title: "B", folderPath: [] }]);
    snapshot(store, [bm(A, []), bm(B, [])], [B]);
    const deleted = snapshot(store, [bm(A, [])], [], false, [B]);
    expect(deleted.stats.deleted).toBe(1);
    expect(store.row(B)).toMatchObject({ removed: true, safariDelete: false });
    expect(pendingImports(store)).toEqual([]);
  });

  it("counts deleted imports toward the mass-delete guard", () => {
    snapshot(store, sites(10));
    const imports = sites(40, ["New"]).map(s => ({ ...s, url: s.url.replace("site", "import") }));
    ops(store, imports.map(s => ({ op: "create", url: s.url, folderPath: ["New"] })));
    const all = [...sites(10), ...imports];
    snapshot(store, all, imports.map(s => s.url));
    const guarded = snapshot(store, sites(10), [], false, imports.map(s => s.url));
    expect(guarded.needsConfirmation?.count).toBe(40);
    expect(store.countActive()).toBe(50);
  });

  it("does not treat a dropped unconfirmed import as a delete unless the app reports it", () => {
    ops(store, [{ op: "create", url: B, title: "B", folderPath: [] }]);
    snapshot(store, [bm(B, [])], [B]);
    const dropped = snapshot(store, []);
    expect(dropped.stats.deleted).toBe(0);
    expect(store.row(B)).toMatchObject({ owner: "browser", removed: false, inSafari: false });
    expect(pendingImports(store).map(r => r.url)).toEqual([B]);
  });

  it("returns a canonical map, keeps the first duplicate and skips invalid URLs", () => {
    const result = snapshot(store, [
      bm("HTTPS://A.EXAMPLE", ["Favorites"], "first"),
      bm("https://a.example/", ["Other"], "second"),
      bm("javascript:void(0)", ["Favorites"]),
      { title: "no url" },
    ]);
    expect(result.canonicalMap).toEqual({ "HTTPS://A.EXAMPLE": A });
    expect(result.stats).toMatchObject({ received: 4, accepted: 1, skipped: 2 });
    expect(result.skippedSample).toEqual(["javascript:void(0)"]);
    expect(store.row(A)).toMatchObject({ title: "first", folderPath: ["Favorites"] });
  });
});
