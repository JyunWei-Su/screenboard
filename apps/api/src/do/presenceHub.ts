import type { Env } from "../types";

// A single global broadcast hub for the admin console's live device-presence
// stream. Admin browsers open a hibernatable WebSocket at /subscribe; each
// device's DeviceConnection DO POSTs to /broadcast when it flips a device
// online or offline, and the hub fans that event out to every open console.
//
// It holds no authoritative state — the `devices` table stays the source of
// truth. A console re-syncs the full list on every (re)connect, so an event
// missed while it was briefly disconnected is corrected on reconnect rather
// than lost.
export class PresenceHub {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    // Answer console keepalive pings from the hibernation runtime itself, so an
    // idle connection is kept warm through edge proxies without ever waking the
    // DO (and thus without cost).
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/subscribe":
        return this.handleSubscribe(req);
      case "/broadcast":
        return this.handleBroadcast(req);
      default:
        return new Response("not found", { status: 404 });
    }
  }

  private handleSubscribe(req: Request): Response {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleBroadcast(req: Request): Promise<Response> {
    const evt = (await req.json()) as { uuid: string; status: string };
    const frame = JSON.stringify({
      type: "device_status",
      uuid: evt.uuid,
      status: evt.status,
    });
    const sockets = this.state.getWebSockets();
    for (const ws of sockets) {
      try {
        ws.send(frame);
      } catch {
        /* drop dead sockets silently; the runtime reaps them */
      }
    }
    return Response.json({ ok: true, subscribers: sockets.length });
  }

  // Hibernation handlers. Consoles are receive-only apart from "ping" keepalives
  // (answered by the auto-responder above), so inbound frames are ignored.
  async webSocketMessage(): Promise<void> {}

  async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }

  async webSocketError(): Promise<void> {}
}
