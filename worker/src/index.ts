import { handleAdminPage } from "./v2/admin";
import { handleV2 } from "./v2/router";

export { SyncGroup } from "./v2/SyncGroup";
export { Registry } from "./v2/Registry";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/v2/")) return handleV2(request, env);
    if (pathname === "/admin" || pathname.startsWith("/admin/")) return handleAdminPage(request, env);
    if (pathname === "/") return Response.json({ name: "Safari Bookmarks Sync", status: "ok", api_version: 2 });
    return Response.json({ error: "not_found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
