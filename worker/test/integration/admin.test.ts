import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleAdminBearer, handleAdminPage } from "../../src/v2/admin";

const BASE = "https://sync.test";
const ADMIN = "test-admin-key-with-enough-length";
const COOKIE = "__Host-sbs_admin";
let ipCounter = 0;
const freshIp = () => `203.0.113.${++ipCounter}`;

interface PageOptions {
  cookie?: string;
  body?: unknown;
  origin?: string | null;
  ip?: string;
  bearer?: string;
}

async function send(method: string, path: string, options: PageOptions = {}) {
  const headers = new Headers({ "CF-Connecting-IP": options.ip ?? freshIp() });
  const origin = options.origin === undefined ? BASE : options.origin;
  if (origin) headers.set("Origin", origin);
  if (options.cookie) headers.set("Cookie", `other=1; ${COOKIE}=${options.cookie}`);
  if (options.bearer) headers.set("Authorization", `Bearer ${options.bearer}`);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await exports.default.fetch(
    new Request(BASE + path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: "manual",
    }),
  );
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // HTML, CSS or JS
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: response.status, headers: response.headers, text, body: body as any };
}

async function signIn(): Promise<string> {
  const res = await send("POST", "/admin/api/login", { body: { key: ADMIN } });
  expect(res.status).toBe(200);
  const match = new RegExp(`${COOKIE}=([0-9a-f]{64})`).exec(res.headers.get("Set-Cookie") ?? "");
  expect(match).not.toBeNull();
  return match![1];
}

async function connectSafari(key: string) {
  const res = await send("POST", "/v2/connect", { origin: null, body: { platform: "safari", name: "Mac", access_key: key } });
  return res;
}

describe("admin page", () => {
  it("serves the page under a strict content security policy", async () => {
    const page = await send("GET", "/admin/");
    expect(page.status).toBe(200);
    expect(page.text).toContain('<script src="app.js" defer></script>');
    expect(page.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("X-Frame-Options")).toBe("DENY");
    expect(page.headers.get("Cache-Control")).toBe("no-store");

    const script = await send("GET", "/admin/app.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("Content-Type")).toContain("javascript");

    const bare = await send("GET", "/admin");
    expect([301, 307, 308]).toContain(bare.status);
    expect(bare.headers.get("Location")).toMatch(/\/admin\/$/);

    expect((await send("POST", "/admin/")).status).toBe(405);
  });

  it("answers 404 everywhere when ADMIN_KEY is not set", async () => {
    const noAdmin = { ...env, ADMIN_KEY: undefined } as Env;
    const request = (path: string) => new Request(BASE + path, { headers: { Authorization: `Bearer ${ADMIN}` } });
    expect((await handleAdminPage(request("/admin/"), noAdmin)).status).toBe(404);
    expect((await handleAdminPage(request("/admin/api/session"), noAdmin)).status).toBe(404);
    expect((await handleAdminBearer(request("/v2/admin/keys"), noAdmin, new URL(BASE + "/v2/admin/keys"))).status).toBe(404);
  });

  it("signs in with ADMIN_KEY into an HttpOnly session and signs out", async () => {
    expect((await send("POST", "/admin/api/login", { body: { key: "wrong-key-wrong-key" } })).status).toBe(401);

    const login = await send("POST", "/admin/api/login", { body: { key: ADMIN } });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("Set-Cookie") ?? "";
    for (const part of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=43200"]) expect(setCookie).toContain(part);
    expect(setCookie).not.toContain(ADMIN);
    const cookie = /=([0-9a-f]{64})/.exec(setCookie)![1];

    expect((await send("GET", "/admin/api/session", { cookie })).body).toEqual({ signed_in: true });
    expect((await send("GET", "/admin/api/session")).body).toEqual({ signed_in: false });
    expect((await send("GET", "/admin/api/keys", { cookie })).status).toBe(200);

    const logout = await send("POST", "/admin/api/logout", { cookie });
    expect(logout.headers.get("Set-Cookie")).toContain("Max-Age=0");
    const after = await send("GET", "/admin/api/keys", { cookie });
    expect(after.status).toBe(401);
    expect(after.body.error).toBe("session_expired");
  });

  it("refuses API calls without a session or from another origin", async () => {
    expect((await send("GET", "/admin/api/keys")).status).toBe(401);
    expect((await send("GET", "/admin/api/keys", { cookie: "0".repeat(64) })).status).toBe(401);

    const cookie = await signIn();
    const foreign = await send("POST", "/admin/api/keys", { cookie, origin: "https://evil.example", body: { label: "x" } });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error).toBe("bad_origin");
    expect((await send("POST", "/admin/api/keys", { cookie, origin: null, body: { label: "x" } })).status).toBe(403);
    expect((await send("POST", "/admin/api/login", { origin: "https://evil.example", body: { key: ADMIN } })).status).toBe(403);
  });

  it("blocks an IP after repeated wrong keys, even when it then guesses right", async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i++) {
      expect((await send("POST", "/admin/api/login", { ip, body: { key: `wrong-${i}-wrong-wrong` } })).status).toBe(401);
    }
    expect((await send("POST", "/admin/api/login", { ip, body: { key: ADMIN } })).status).toBe(429);
    expect((await send("GET", "/v2/admin/keys", { ip, bearer: ADMIN })).status).toBe(429);
    expect((await send("POST", "/admin/api/login", { body: { key: ADMIN } })).status).toBe(200);
  });

  it("counts wrong Bearer keys on the script API too", async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i++) expect((await send("GET", "/v2/admin/keys", { ip, bearer: `wrong-${i}-wrong-wrong` })).status).toBe(401);
    expect((await send("GET", "/v2/admin/keys", { ip, bearer: ADMIN })).status).toBe(429);
  });
});

describe("key management", () => {
  it("lists keys with their usage", async () => {
    const cookie = await signIn();
    const created = await send("POST", "/admin/api/keys", { cookie, body: { label: "  Alice  ", max_bookmarks: 100 } });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ label: "Alice", max_bookmarks: 100 });
    expect(created.body.key).toMatch(/^sbk_[0-9a-f]{48}$/);

    const unused = (await send("GET", "/admin/api/keys", { cookie })).body.keys.find((k: { id: string }) => k.id === created.body.id);
    expect(unused).toMatchObject({ group: null, usage: null });

    const mac = await connectSafari(created.body.key);
    await send("POST", "/v2/safari/snapshot", {
      origin: null,
      bearer: mac.body.token,
      body: { bookmarks: [{ url: "https://a.example/", folderPath: [] }] },
    });
    const listed = await send("GET", "/admin/api/keys", { cookie });
    const entry = listed.body.keys.find((k: { id: string }) => k.id === created.body.id);
    expect(entry.group.pair_id).toBe(mac.body.pair_id);
    expect(entry.usage).toMatchObject({ bookmarks: 1, tombstones: 0, devices: 1, max_bookmarks: 100 });
    expect(entry.usage.last_seen_at).toBeGreaterThan(0);
  });

  it("edits the label and the bookmark limit, which the group enforces", async () => {
    const cookie = await signIn();
    const created = await send("POST", "/admin/api/keys", { cookie, body: { label: "Bob", max_bookmarks: 5 } });
    const mac = await connectSafari(created.body.key);

    const edited = await send("PATCH", `/admin/api/keys/${created.body.id}`, { cookie, body: { label: "Bobby", max_bookmarks: 2 } });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ label: "Bobby", max_bookmarks: 2 });

    const three = ["https://a.example/", "https://b.example/", "https://c.example/"].map(url => ({ url, folderPath: [] }));
    const capped = await send("POST", "/v2/safari/snapshot", { origin: null, bearer: mac.body.token, body: { bookmarks: three } });
    expect(capped.body.stats).toMatchObject({ inserted: 2, skipped: 1 });

    const labelOnly = await send("PATCH", `/admin/api/keys/${created.body.id}`, { cookie, body: { label: "" } });
    expect(labelOnly.body).toMatchObject({ label: null, max_bookmarks: 2 });

    for (const max_bookmarks of [0, 50_001, "10", 1.5, null]) {
      const bad = await send("PATCH", `/admin/api/keys/${created.body.id}`, { cookie, body: { max_bookmarks } });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe("invalid_limits");
    }
    expect((await send("PATCH", `/admin/api/keys/${created.body.id}`, { cookie, body: {} })).status).toBe(400);
    expect((await send("PATCH", `/admin/api/keys/${crypto.randomUUID()}`, { cookie, body: { label: "x" } })).status).toBe(404);
  });

  it("applies an edited limit to a group created later", async () => {
    const cookie = await signIn();
    const created = await send("POST", "/admin/api/keys", { cookie, body: { max_bookmarks: 5 } });
    await send("PATCH", `/admin/api/keys/${created.body.id}`, { cookie, body: { max_bookmarks: 1 } });
    const mac = await connectSafari(created.body.key);
    const stats = await send("GET", `/admin/api/groups/${mac.body.pair_id}`, { cookie });
    expect(stats.body.max_bookmarks).toBe(1);
  });

  it("resets a key: the old one stops working, the group and its devices stay", async () => {
    const cookie = await signIn();
    const created = await send("POST", "/admin/api/keys", { cookie, body: { label: "Carol" } });
    const mac = await connectSafari(created.body.key);

    const reset = await send("POST", `/admin/api/keys/${created.body.id}/reset`, { cookie });
    expect(reset.status).toBe(200);
    expect(reset.body.key).toMatch(/^sbk_[0-9a-f]{48}$/);
    expect(reset.body.key).not.toBe(created.body.key);

    expect((await connectSafari(created.body.key)).body.error).toBe("invalid_access_key");
    const again = await connectSafari(reset.body.key);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("safari_device_exists");
    expect((await send("GET", "/v2/snapshot", { origin: null, bearer: mac.body.token })).status).toBe(200);

    await send("DELETE", `/admin/api/keys/${created.body.id}`, { cookie });
    const revoked = await send("POST", `/admin/api/keys/${created.body.id}/reset`, { cookie });
    expect(revoked.status).toBe(409);
    expect(revoked.body.error).toBe("key_revoked");
    expect((await send("POST", `/admin/api/keys/${crypto.randomUUID()}/reset`, { cookie })).status).toBe(404);
  });

  it("offers the same operations to scripts with the Bearer key", async () => {
    const created = await send("POST", "/v2/admin/keys", { origin: null, bearer: ADMIN, body: { label: "Dan" } });
    const edited = await send("PATCH", `/v2/admin/keys/${created.body.id}`, { origin: null, bearer: ADMIN, body: { max_bookmarks: 10 } });
    expect(edited.body).toMatchObject({ label: "Dan", max_bookmarks: 10 });
    const reset = await send("POST", `/v2/admin/keys/${created.body.id}/reset`, { origin: null, bearer: ADMIN });
    expect(reset.body.key).toMatch(/^sbk_/);
    expect((await send("PATCH", "/v2/admin/keys/not-a-uuid", { origin: null, bearer: ADMIN, body: {} })).status).toBe(400);
  });

  it("deletes a user's data from the page", async () => {
    const cookie = await signIn();
    const created = await send("POST", "/admin/api/keys", { cookie, body: { label: "Eve" } });
    const mac = await connectSafari(created.body.key);
    expect((await send("DELETE", `/admin/api/groups/${mac.body.pair_id}`, { cookie })).status).toBe(200);
    expect((await send("GET", "/v2/snapshot", { origin: null, bearer: mac.body.token })).status).toBe(401);
    const entry = (await send("GET", "/admin/api/keys", { cookie })).body.keys.find((k: { id: string }) => k.id === created.body.id);
    expect(entry).toMatchObject({ group: null, usage: null, revoked_at: null });
  });
});
