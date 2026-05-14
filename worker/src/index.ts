import { AutoRouter, IRequest } from "itty-router";
import { handleGeneratePair, handleJoinPair, handleGetPairInfo } from "./api/pair";
import { handleSync } from "./api/sync";
import { handleGetBookmarks, handleGetBookmarksSince } from "./api/bookmarks";
import { validateRequest } from "./utils/auth";

export { SyncChannel } from "./durable/SyncChannel";

const router = AutoRouter();

router.get("/", () => Response.json({
  name: "Safari Bookmarks Sync",
  status: "ok",
  endpoints: ["/health", "/api/pair/generate", "/api/pair/join", "/api/sync", "/api/bookmarks", "/api/bookmarks/since", "/ws"],
}));

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return (
    origin.startsWith("chrome-extension://") ||
    origin.startsWith("moz-extension://") ||
    origin.startsWith("safari-web-extension://")
  );
}

function applyCors(req: Request, res: Response): Response {
  const origin = req.headers.get("Origin");
  if (origin && isAllowedOrigin(origin)) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.set("Vary", "Origin");
    res.headers.set("Access-Control-Allow-Credentials", "false");
  }
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.headers.set("Access-Control-Max-Age", "86400");
  return res;
}

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
  fetch: (req: Request, env: Env) => router.fetch(req, env),
} satisfies ExportedHandler<Env>;
