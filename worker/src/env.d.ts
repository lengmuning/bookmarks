interface Env {
  DB: D1Database;
  BOOKMARKS_KV: KVNamespace;
  SYNC_CHANNEL: DurableObjectNamespace<import("./durable/SyncChannel").SyncChannel>;
}
