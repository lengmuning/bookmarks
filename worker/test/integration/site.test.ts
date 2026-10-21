import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "https://sync.test";
const get = (path: string, init?: RequestInit) => exports.default.fetch(new Request(BASE + path, init));

describe("home page", () => {
  it("serves the introduction at / with strict page headers", async () => {
    const page = await get("/");
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Type")).toContain("text/html");
    expect(page.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("X-Frame-Options")).toBe("DENY");
    expect(page.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const html = await page.text();
    expect(html).toContain("https://github.com/lengmuning/bookmarks/releases/latest");
    expect(html).toContain("Itsuka_Sayonara");
    expect(html).toContain("mailto:will.leng@ethtest.com");
    expect(html).toContain('data-l="zh"');
    expect(html).toContain('data-l="en"');
  });

  it("serves its stylesheet, script and icon", async () => {
    const files: [string, string][] = [
      ["/site/site.css", "text/css"],
      ["/site/site.js", "javascript"],
      ["/site/icon.svg", "image/svg+xml"],
    ];
    for (const [path, type] of files) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("Content-Type"), path).toContain(type);
      await response.arrayBuffer();
    }
  });

  it("answers only GET and HEAD", async () => {
    const post = await get("/", { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("Allow")).toBe("GET, HEAD");
    const head = await get("/", { method: "HEAD" });
    expect(head.status).toBe(200);
  });

  it("leaves the API and other paths as they were", async () => {
    const health = await get("/v2/health");
    expect(health.status).toBe(200);
    expect(((await health.json()) as { status: string }).status).toBe("ok");

    for (const path of ["/index.html", "/nope", "/site.css"]) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
      expect(((await response.json()) as { error: string }).error, path).toBe("not_found");
    }
  });
});
