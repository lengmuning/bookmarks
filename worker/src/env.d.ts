interface Env {
  SYNC_GROUP: DurableObjectNamespace<import("./v2/SyncGroup").SyncGroup>;
  REGISTRY: DurableObjectNamespace<import("./v2/Registry").Registry>;
  // Static files of the /admin page (public/)
  ASSETS: Fetcher;
  // Secrets (`wrangler secret put`), see src/v2/access.ts
  ACCESS_KEY?: string;
  ADMIN_KEY?: string;
}
