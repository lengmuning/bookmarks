interface Env {
  SYNC_GROUP: DurableObjectNamespace<import("./v2/SyncGroup").SyncGroup>;
  REGISTRY: DurableObjectNamespace<import("./v2/Registry").Registry>;
  // Secrets (`wrangler secret put`), see src/v2/access.ts
  ACCESS_KEY?: string;
  ADMIN_KEY?: string;
}
