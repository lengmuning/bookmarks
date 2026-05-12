import { DurableObject } from "cloudflare:workers";

type Client = { ws: WebSocket; deviceId: string; browser: string };

export class SyncChannel extends DurableObject {
  private clients: Map<string, Client> = new Map();
  private pairId: string = "";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.getWebSockets().forEach(ws => {
      const meta = ws.deserializeAttachment() as { deviceId: string; browser: string };
      this.clients.set(meta.deviceId, { ws, ...meta });
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pairId = url.searchParams.get("pair_id");
    if (!pairId) return new Response("Missing pair_id", { status: 400 });

    this.pairId = pairId;

    const pair = [request.headers.get("Upgrade") ?? ""];
    if (pair[0] === "websocket") {
      const deviceId = url.searchParams.get("device_id") ?? crypto.randomUUID();
      const browser = url.searchParams.get("browser") ?? "unknown";

      const { 0: client, 1: server } = new WebSocketPair();
      server.serializeAttachment({ deviceId, browser });
      this.ctx.acceptWebSocket(server);
      this.clients.set(deviceId, { ws: server, deviceId, browser });

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("WebSocket only", { status: 426 });
  }

  async webSocketMessage(ws: WebSocket, message: string) {
    // Clients send pong in response to ping; no other client→server messages
    try {
      const data = JSON.parse(message);
      if (data.type === "pong") return;
    } catch {
      // ignore unparseable messages
    }
  }

  async webSocketClose(ws: WebSocket) {
    const meta = ws.deserializeAttachment() as { deviceId: string };
    if (meta?.deviceId) {
      this.clients.delete(meta.deviceId);
    }
  }

  async webSocketError(ws: WebSocket) {
    const meta = ws.deserializeAttachment() as { deviceId: string };
    if (meta?.deviceId) {
      this.clients.delete(meta.deviceId);
    }
  }

  async broadcast(event: BookmarkEvent) {
    const payload = JSON.stringify(event);
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
    id: string;
    title?: string;
    url?: string;
    parentId?: string;
    index?: number;
  };
}
