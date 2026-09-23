import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";
import "../canonical.js";
import "../sync-core.js";
import { createFakeBrowser, createFakeServer } from "./fakes.mjs";

const { canonicalUrl } = globalThis.SyncCanonical;
const { createSyncCore, KEYS } = globalThis.SyncCore;
const API = "https://sync.example";

describe("canonicalUrl (shared vectors)", () => {
  const vectors = JSON.parse(readFileSync(new URL("../canonical-vectors.json", import.meta.url), "utf8"));
  for (const { input, expected } of vectors) {
    it(JSON.stringify(input), () => assert.equal(canonicalUrl(input), expected));
  }
});

function setup(flavor = "chrome") {
  const browser = createFakeBrowser(flavor);
  const server = createFakeServer();
  let clock = 10_000_000;
  const core = createSyncCore({
    ext: browser.ext,
    platform: flavor,
    deviceName: flavor,
    fetch: server.fetch,
    now: () => clock,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    WebSocket: null,
    log: { warn() {}, error() {} },
  });
  core.install();
  return {
    browser,
    server,
    core,
    advance: ms => (clock += ms),
    rootId: () => browser.store[KEYS.config]?.root_id,
    queue: () => browser.store[KEYS.queue] || [],
    // Waits for queued event handlers, then flushes and pulls.
    settle: async () => {
      await core._idle();
      await core.poll();
    },
  };
}

function folderPathOf(browser, url) {
  const copies = browser.copiesOf(url);
  assert.equal(copies.length, 1, `expected exactly one copy of ${url}, got ${JSON.stringify(copies)}`);
  return copies[0][0];
}

describe("first sync after joining", () => {
  let t;
  beforeEach(() => {
    t = setup("chrome");
  });

  it("backs up, moves existing copies into Safari's folders and leaves unrelated bookmarks alone", async () => {
    const { browser, server, core } = t;
    const personal = browser.seedFolder(browser.ids.bar, "Personal");
    const original = browser.seedBookmark(browser.ids.bar, "GitHub", "https://github.com", 1);
    browser.seedBookmark(personal, "Unrelated", "https://unrelated.example/");
    // Leftovers from the v1 extension inside the sync root.
    const oldRoot = browser.seedFolder(browser.ids.other, "Safari Bookmarks");
    const oldFav = browser.seedFolder(oldRoot, "Favorites");
    const oldDev = browser.seedFolder(oldFav, "Dev");
    browser.seedBookmark(oldDev, "github copy", "https://github.com/", 5);
    const oldStuff = browser.seedFolder(oldRoot, "Old");
    browser.seedBookmark(oldStuff, "Deleted in Safari", "https://deleted.example/");

    server.safariSnapshot([
      { url: "https://deleted.example/", title: "Deleted", folderPath: ["Favorites"] },
      { url: "https://github.com/", title: "GitHub (Safari)", folderPath: ["Favorites", "Tech"] },
      { url: "https://news.example/", title: "News", folderPath: ["Bookmarks Menu", "News"] },
    ]);
    server.safariSnapshot([
      { url: "https://github.com/", title: "GitHub (Safari)", folderPath: ["Favorites", "Tech"] },
      { url: "https://news.example/", title: "News", folderPath: ["Bookmarks Menu", "News"] },
    ]);

    const result = await core.join(API, "GOOD-CODE");
    assert.equal(result.ok, true, result.error);

    const backup = browser.store[KEYS.backup];
    assert.ok(JSON.stringify(backup.tree).includes("https://github.com"), "backup taken before changes");

    const github = browser.copiesOf("https://github.com/");
    assert.equal(github.length, 1);
    assert.equal(github[0][0], "Other bookmarks / Safari Bookmarks / Favorites / Tech");
    assert.equal(github[0][1], "GitHub (Safari)");
    assert.equal(github[0][3], original, "the user's original (oldest) bookmark is the one kept");

    assert.equal(folderPathOf(browser, "https://news.example/"), "Other bookmarks / Safari Bookmarks / Bookmarks Menu / News");
    assert.deepEqual(browser.copiesOf("https://unrelated.example/").map(c => c[0]), ["Bookmarks bar / Personal"]);
    // The old root is set aside: what Safari does not have stays there for
    // review and is not uploaded back into Safari.
    assert.equal(browser.node(oldRoot).title, "Safari Bookmarks (before sync v2)");
    assert.deepEqual(browser.copiesOf("https://deleted.example/").map(c => c[0]), ["Other bookmarks / Safari Bookmarks (before sync v2) / Old"]);
    assert.equal(server.rows.get("https://deleted.example/").removed, true, "still deleted on the server");
    assert.equal(browser.findFolder(oldFav, "Dev"), null, "emptied folders inside it are cleaned up");

    assert.deepEqual(t.queue(), [], "our own writes are not queued as user changes");
    assert.equal(browser.store[KEYS.config].cursor, server.seq);
  });

  it("keeps an earlier root for review and uploads what the user moves into the new one", async () => {
    const { browser, server, core } = t;
    const root = browser.seedFolder(browser.ids.other, "Safari Bookmarks");
    const work = browser.seedFolder(root, "Work");
    const wiki = browser.seedBookmark(work, "Wiki", "https://wiki.example/");
    const result = await core.join(API, "GOOD-CODE");
    assert.equal(result.ok, true, result.error);
    assert.equal(server.rows.has("https://wiki.example/"), false, "not uploaded on its own");

    t.advance(60_000);
    await browser.ext.bookmarks.move(wiki, { parentId: t.rootId() });
    await t.settle();
    assert.deepEqual(server.rows.get("https://wiki.example/"), {
      url: "https://wiki.example/",
      title: "Wiki",
      folderPath: [],
      owner: "browser",
      removed: false,
      seq: 1,
    });
  });

  it("removes the set-aside root when nothing is left in it", async () => {
    const { browser, server, core } = t;
    const root = browser.seedFolder(browser.ids.other, "Safari Bookmarks");
    browser.seedBookmark(browser.seedFolder(root, "Favorites"), "GitHub", "https://github.com/");
    server.safariSnapshot([{ url: "https://github.com/", title: "GitHub", folderPath: ["Favorites"] }]);
    assert.equal((await core.join(API, "GOOD-CODE")).ok, true);
    assert.equal(browser.node(root), null);
    assert.equal(folderPathOf(browser, "https://github.com/"), "Other bookmarks / Safari Bookmarks / Favorites");
  });

  it("reports a bad pairing code without touching anything", async () => {
    const { browser, core } = t;
    const result = await core.join(API, "WRONG");
    assert.equal(result.ok, false);
    assert.match(result.error, /wrong, already used or expired/);
    assert.equal(browser.store[KEYS.config], undefined);
  });
});

describe("after joining", () => {
  let t;
  beforeEach(async () => {
    t = setup("chrome");
    t.server.safariSnapshot([
      { url: "https://github.com/", title: "GitHub", folderPath: ["Favorites", "Tech"] },
      { url: "https://news.example/", title: "News", folderPath: ["Bookmarks Menu"] },
    ]);
    const joined = await t.core.join(API, "GOOD-CODE");
    assert.equal(joined.ok, true, joined.error);
    t.server.requests.length = 0;
    t.advance(60_000); // user actions come after our own write marks expire
  });

  const idOf = (browser, url) => browser.copiesOf(url)[0][3];

  it("puts a Safari bookmark back when the user moves it in the browser", async () => {
    const { browser, server } = t;
    const elsewhere = await browser.ext.bookmarks.create({ parentId: t.rootId(), title: "Elsewhere" });
    await browser.ext.bookmarks.move(idOf(browser, "https://github.com/"), { parentId: elsewhere.id });
    await t.settle();
    assert.equal(folderPathOf(browser, "https://github.com/"), "Other bookmarks / Safari Bookmarks / Favorites / Tech");
    assert.equal(server.rows.get("https://github.com/").folderPath.join("/"), "Favorites/Tech");
  });

  it("restores a Safari bookmark the user deletes in the browser", async () => {
    const { browser } = t;
    await browser.ext.bookmarks.remove(idOf(browser, "https://news.example/"));
    await t.settle();
    assert.equal(folderPathOf(browser, "https://news.example/"), "Other bookmarks / Safari Bookmarks / Bookmarks Menu");
  });

  it("uploads, moves and deletes bookmarks added in the browser", async () => {
    const { browser, server } = t;
    const favorites = browser.findFolder(t.rootId(), "Favorites");
    const created = await browser.ext.bookmarks.create({ parentId: favorites, title: "Docs", url: "https://docs.example/" });
    await t.settle();
    assert.deepEqual(server.rows.get("https://docs.example/").folderPath, ["Favorites"]);
    assert.equal(server.rows.get("https://docs.example/").owner, "browser");

    await browser.ext.bookmarks.move(created.id, { parentId: t.rootId() });
    await t.settle();
    assert.deepEqual(server.rows.get("https://docs.example/").folderPath, []);

    await browser.ext.bookmarks.remove(created.id);
    await t.settle();
    assert.equal(server.rows.get("https://docs.example/").removed, true);
    assert.equal(browser.copiesOf("https://docs.example/").length, 0);
  });

  it("ignores bookmarks outside the sync root", async () => {
    const { browser, server } = t;
    await browser.ext.bookmarks.create({ parentId: browser.ids.bar, title: "Private", url: "https://private.example/" });
    await t.settle();
    assert.equal(server.rows.has("https://private.example/"), false);
    assert.deepEqual(t.queue(), []);
  });

  it("sends a remove and a create when the user edits a URL", async () => {
    const { browser, server } = t;
    const created = await browser.ext.bookmarks.create({ parentId: t.rootId(), title: "Old", url: "https://old.example/" });
    await t.settle();
    await browser.ext.bookmarks.update(created.id, { url: "https://new.example/" });
    await t.settle();
    assert.equal(server.rows.get("https://old.example/").removed, true);
    assert.equal(server.rows.get("https://new.example/").removed, false);
  });

  it("moving a bookmark into the root uploads it, moving it out deletes it", async () => {
    const { browser, server } = t;
    const outside = await browser.ext.bookmarks.create({ parentId: browser.ids.bar, title: "X", url: "https://x.example/" });
    await t.settle();
    await browser.ext.bookmarks.move(outside.id, { parentId: t.rootId() });
    await t.settle();
    assert.equal(server.rows.get("https://x.example/").removed, false);
    await browser.ext.bookmarks.move(outside.id, { parentId: browser.ids.bar });
    await t.settle();
    assert.equal(server.rows.get("https://x.example/").removed, true);
    assert.deepEqual(browser.copiesOf("https://x.example/").map(c => c[0]), ["Bookmarks bar"], "the user's copy outside the root stays");
  });

  it("applies Safari deletions inside the root only", async () => {
    const { browser, server } = t;
    // A copy the user adds outside the root is only consolidated by the next
    // full sync; a Safari delete arriving before that must not touch it.
    await browser.ext.bookmarks.create({ parentId: browser.ids.bar, title: "mine", url: "https://news.example/" });
    await t.settle();
    server.safariSnapshot([{ url: "https://github.com/", title: "GitHub", folderPath: ["Favorites", "Tech"] }]);
    await t.settle();
    assert.deepEqual(browser.copiesOf("https://news.example/").map(c => c[0]), ["Bookmarks bar"]);
  });

  it("a full sync consolidates a copy the user added elsewhere", async () => {
    const { browser, core } = t;
    await browser.ext.bookmarks.create({ parentId: browser.ids.bar, title: "again", url: "https://github.com" });
    await t.settle();
    await core.fullSync();
    assert.equal(folderPathOf(browser, "https://github.com/"), "Other bookmarks / Safari Bookmarks / Favorites / Tech");
  });

  it("renaming a folder updates the paths of the bookmarks inside it", async () => {
    const { browser, server } = t;
    const folder = await browser.ext.bookmarks.create({ parentId: t.rootId(), title: "Reading" });
    await browser.ext.bookmarks.create({ parentId: folder.id, title: "Paper", url: "https://paper.example/" });
    await t.settle();
    await browser.ext.bookmarks.update(folder.id, { title: "Papers" });
    await t.settle();
    assert.deepEqual(server.rows.get("https://paper.example/").folderPath, ["Papers"]);
  });

  it("disconnects and revokes the device", async () => {
    const { browser, core, server } = t;
    const result = await core.unpair();
    assert.equal(result.ok, true);
    assert.equal(browser.store[KEYS.config], undefined);
    assert.ok(server.requests.some(r => r.method === "DELETE" && r.path === "/v2/devices/self"));
    assert.ok(browser.store[KEYS.backup], "the backup is kept");
  });
});

describe("server-side recovery", () => {
  let t;
  beforeEach(async () => {
    t = setup("chrome");
    t.server.safariSnapshot([
      { url: "https://github.com/", title: "GitHub", folderPath: ["Favorites"] },
      { url: "https://news.example/", title: "News", folderPath: ["Favorites"] },
    ]);
    assert.equal((await t.core.join(API, "GOOD-CODE")).ok, true);
    t.advance(60_000);
  });

  it("starts over when purged deletes make the cursor expire, without resurrecting them", async () => {
    const { browser, server, core } = t;
    // While the browser was away: Safari deleted News, added Late, and the
    // server later purged the tombstone.
    server.safariSnapshot([
      { url: "https://github.com/", title: "GitHub", folderPath: ["Favorites"] },
      { url: "https://late.example/", title: "Late", folderPath: ["Favorites"] },
    ]);
    server.purgeTombstones();
    assert.equal(server.rows.has("https://news.example/"), false);

    await core.poll();
    assert.equal(browser.copiesOf("https://news.example/").length, 0, "the deleted bookmark is removed, not re-uploaded");
    assert.equal(server.rows.has("https://news.example/"), false);
    assert.equal(folderPathOf(browser, "https://late.example/"), "Other bookmarks / Safari Bookmarks / Favorites");
    assert.equal(browser.store[KEYS.config].cursor, server.seq);
  });

  it("still uploads bookmarks that were added locally but never synced", async () => {
    const { browser, server, core } = t;
    // An addition whose event was lost (for example the worker was stopped).
    browser.seedBookmark(t.rootId(), "Offline", "https://offline.example/");
    await core.fullSync();
    assert.equal(server.rows.get("https://offline.example/").owner, "browser");
  });

  it("stops and explains when the group is disabled", async () => {
    const { browser, server, core } = t;
    server.disable();
    await core.poll();
    const status = browser.store[KEYS.status];
    assert.equal(status.auth_failed, true);
    assert.match(status.last_error, /disabled this sync group/);
    const before = server.requests.length;
    await core.poll();
    assert.equal(server.requests.length, before, "no more requests after a fatal error");
  });
});

describe("Firefox", () => {
  it("removing a folder uploads removes for its bookmarks even without a children list", async () => {
    const t = setup("firefox");
    t.server.safariSnapshot([{ url: "https://github.com/", title: "GitHub", folderPath: ["Favorites"] }]);
    assert.equal((await t.core.join(API, "GOOD-CODE")).ok, true);
    t.advance(60_000);
    const { browser, server } = t;

    const folder = await browser.ext.bookmarks.create({ parentId: t.rootId(), title: "Mine" });
    await browser.ext.bookmarks.create({ parentId: folder.id, title: "A", url: "https://a.example/" });
    await browser.ext.bookmarks.create({ parentId: folder.id, title: "B", url: "https://b.example/" });
    await t.settle();
    assert.equal(server.rows.get("https://a.example/").removed, false);

    await browser.ext.bookmarks.removeTree(folder.id);
    await t.settle();
    assert.equal(server.rows.get("https://a.example/").removed, true);
    assert.equal(server.rows.get("https://b.example/").removed, true);

    await browser.ext.bookmarks.removeTree(browser.findFolder(t.rootId(), "Favorites"));
    await t.settle();
    assert.equal(folderPathOf(browser, "https://github.com/"), "Other Bookmarks / Safari Bookmarks / Favorites", "Safari's bookmark is restored");
  });
});
