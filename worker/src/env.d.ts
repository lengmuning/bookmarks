interface Env {
  // v1
  DB: D1Database;
  BOOKMARKS_KV: KVNamespace;
  SYNC_CHANNEL: DurableObjectNamespace<import("./durable/SyncChannel").SyncChannel>;
  // v2
  SYNC_GROUP: DurableObjectNamespace<import("./v2/SyncGroup").SyncGroup>;
  REGISTRY: DurableObjectNamespace<import("./v2/Registry").Registry>;
}
