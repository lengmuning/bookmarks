import { beforeEach, describe, expect, it } from "vitest";
import { applyBrowserOps, applySafariSnapshot, pendingImports } from "../../src/v2/logic";
import { MemoryStore } from "./memory-store";

const NOW = 1_700_000_000_000;
const A = "https://a.example/";
const B = "https://b.example/";

function bm(url: string, folderPath: string[], title = url, index = 0) {
  return { url, title, folderPath, index };
}

function snapshot(store: MemoryStore, items: unknown[], unconfirmed: unknown[] = [], confirm = false) {
  return applySafariSnapshot(store, items, unconfirmed, confirm, "safari-device", NOW);
}

function ops(store: MemoryStore, list: unknown[], baseCursor = store.seq) {
  return applyBrowserOps(store, list, baseCursor, "chrome-device", NOW);
}

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

    const removed = ops(store, [{ op: "remove", url: A }]);
    expect(removed.results[0]).toMatchObject({ status: "rejected", reason: "safari_authority" });
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

  it("does not treat a dropped unconfirmed import as a delete", () => {
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
