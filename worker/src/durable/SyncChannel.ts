import { DurableObject } from "cloudflare:workers";

type Client = { ws: WebSocket; deviceId: string; browser: string };

export class SyncChannel extends DurableObject {
  private clients: Map<string, Client> = new Map();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.getWebSockets().forEach(ws => {
      const meta = ws.deserializeAttachment() as { deviceId: string; browser: string } | null;
      if (meta?.deviceId) {
        this.clients.set(meta.deviceId, { ws, deviceId: meta.deviceId, browser: meta.browser });
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pairId = url.searchParams.get("pair_id");
    if (!pairId) return new Response("Missing pair_id", { status: 400 });

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket only", { status: 426 });
    }

    const deviceId = url.searchParams.get("device_id") ?? crypto.randomUUID();
    const browser = url.searchParams.get("browser") ?? "unknown";

    const { 0: client, 1: server } = new WebSocketPair();
    server.serializeAttachment({ deviceId, browser });
    this.ctx.acceptWebSocket(server);

    // Drop any previous socket for the same device.
    const previous = this.clients.get(deviceId);
    if (previous && previous.ws !== server) {
      try { previous.ws.close(1000, "replaced"); } catch { /* ignore */ }
    }
    this.clients.set(deviceId, { ws: server, deviceId, browser });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(_ws: WebSocket, message: string): Promise<void> {
    if (typeof message !== "string") return;
    try {
      const data = JSON.parse(message);
      if (data?.type === "ping") {
        _ws.send(JSON.stringify({ type: "pong", server_now: Date.now() }));
      }
    } catch {
      // Ignore unparseable messages.
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.dropSocket(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.dropSocket(ws);
  }

  private dropSocket(ws: WebSocket): void {
    const meta = ws.deserializeAttachment() as { deviceId?: string } | null;
    if (meta?.deviceId) {
      const entry = this.clients.get(meta.deviceId);
      if (entry?.ws === ws) {
        this.clients.delete(meta.deviceId);
      }
    }
  }

  async broadcast(event: BookmarkEvent): Promise<void> {
    const payload = JSON.stringify({ ...event, server_now: Date.now() });
    const dead: string[] = [];

    for (const [id, client] of this.clients) {
      try {
        client.ws.send(payload);
      } catch {
        dead.push(id);
      }
    }

    dead.forEach(id => this.clients.delete(id));
  }
}

export interface BookmarkEvent {
  type: "bookmark_change";
  action: "create" | "update" | "remove";
  bookmark: {
    url: string;
    title: string | null;
    folderPath: string[];
    index: number | null;
    updated_at: number;
  };
}
