import { AutoRouter, IRequest } from "itty-router";
import { handleGeneratePair, handleJoinPair, handleGetPairInfo } from "./api/pair";
import { handleSync } from "./api/sync";
import { handleGetBookmarks, handleGetBookmarksSince } from "./api/bookmarks";
import { validateRequest } from "./utils/auth";
import { applyCors } from "./utils/cors";
import { handleV2 } from "./v2/router";

export { SyncChannel } from "./durable/SyncChannel";
export { SyncGroup } from "./v2/SyncGroup";
export { Registry } from "./v2/Registry";

// v1 (/api/*, /ws) is kept unchanged for clients installed before v2.
const router = AutoRouter();

router.get("/", () => Response.json({
  name: "Safari Bookmarks Sync",
  status: "ok",
  api_versions: [1, 2],
}));

function wrap(handler: (req: IRequest, env: Env) => Promise<Response>) {
  return async (req: IRequest, env: Env) =>
    applyCors(req as unknown as Request, await handler(req, env));
}

router.post("/api/pair/generate", wrap(handleGeneratePair));
router.post("/api/pair/join", wrap(handleJoinPair));
router.get("/api/pair/info", wrap(handleGetPairInfo));

router.post("/api/sync", wrap(handleSync));

router.get("/api/bookmarks", wrap(handleGetBookmarks));
router.get("/api/bookmarks/since", wrap(handleGetBookmarksSince));

router.options("*", (req: IRequest) =>
  applyCors(req as unknown as Request, new Response(null, { status: 204 }))
);

router.get("/ws", async (req: IRequest, env: Env) => {
  const url = new URL(req.url);
  const auth = await validateRequest(env, req, url);
  if (!auth.ok) return new Response(auth.error, { status: auth.status });

  const doId = env.SYNC_CHANNEL.idFromName(auth.pairId);
  const stub = env.SYNC_CHANNEL.get(doId);
  return stub.fetch(req.raw);
});

router.get("/health", () => Response.json({ status: "ok", server_now: Date.now() }));

export default {
  fetch: (req: Request, env: Env) =>
    new URL(req.url).pathname.startsWith("/v2/") ? handleV2(req, env) : router.fetch(req, env),
} satisfies ExportedHandler<Env>;
