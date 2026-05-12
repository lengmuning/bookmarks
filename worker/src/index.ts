import { AutoRouter } from "itty-router";
import { handleGeneratePair, handleJoinPair, handleGetPairInfo } from "./api/pair";
import { handleSync } from "./api/sync";
import { handleGetBookmarks, handleGetBookmarksSince } from "./api/bookmarks";
import { validateDevice } from "./utils/auth";

export { SyncChannel } from "./durable/SyncChannel";

const router = AutoRouter();

// CORS headers for browser extensions
function cors(r: Response): Response {
  r.headers.set("Access-Control-Allow-Origin", "*");
  r.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  r.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return r;
}

// Pairing
router.post("/api/pair/generate", async (req, env) => cors(await handleGeneratePair(req, env)));
router.post("/api/pair/join", async (req, env) => cors(await handleJoinPair(req, env)));
router.get("/api/pair/info", async (req, env) => cors(await handleGetPairInfo(req, env)));

// Sync
router.post("/api/sync", async (req, env) => cors(await handleSync(req, env)));

// Bookmarks
router.get("/api/bookmarks", async (req, env) => cors(await handleGetBookmarks(req, env)));
router.get("/api/bookmarks/since", async (req, env) => cors(await handleGetBookmarksSince(req, env)));

// OPTIONS preflight
router.options("*", () => {
  return cors(new Response(null, { status: 204 }));
});

// WebSocket endpoint: /ws?pair_id=X&device_id=X&device_token=X&browser=X
router.get("/ws", async (req, env) => {
  const url = new URL(req.url);
  const pairId = url.searchParams.get("pair_id");
  if (!pairId) return new Response("Missing pair_id", { status: 400 });
  if (!await validateDevice(
    env,
    pairId,
    url.searchParams.get("device_id"),
    url.searchParams.get("device_token"),
  )) {
    return new Response("Unauthorized device", { status: 401 });
  }

  const doId = env.SYNC_CHANNEL.idFromName(pairId);
  const stub = env.SYNC_CHANNEL.get(doId);
  return stub.fetch(req.raw);
});

// Health check
router.get("/health", () => Response.json({ status: "ok" }));

export default {
  fetch: (req: Request, env: Env) => router.fetch(req, env),
} satisfies ExportedHandler<Env>;
