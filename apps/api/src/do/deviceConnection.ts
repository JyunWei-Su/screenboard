import type { Env } from "../types";
import { recordEvent } from "../lib/notify";
import type { AgentMessage } from "@screenboard/shared";

// One Durable Object instance per device (addressed by device UUID).
// Holds the agent's hibernatable WebSocket, tracks presence, and dispatches commands.
export class DeviceConnection {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private get offlineTimeoutMs(): number {
    return (parseInt(this.env.OFFLINE_TIMEOUT_SECONDS || "90", 10) || 90) * 1000;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/connect":
        return this.handleConnect(req);
      case "/command":
        return this.handleCommand(req);
      case "/status":
        return this.handleStatus();
      default:
        return new Response("not found", { status: 404 });
    }
  }

  private async handleConnect(req: Request): Promise<Response> {
    const uuid = req.headers.get("x-device-uuid");
    if (!uuid) return new Response("missing uuid", { status: 400 });
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    await this.state.storage.put("uuid", uuid);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);

    await this.markOnline(uuid);
    await this.touch();
    server.send(JSON.stringify({ type: "welcome", device_uuid: uuid }));
    await this.flushQueued(uuid);

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleCommand(req: Request): Promise<Response> {
    const cmd = (await req.json()) as {
      id: string;
      type: string;
      payload?: Record<string, unknown>;
    };
    const sockets = this.state.getWebSockets();
    if (sockets.length === 0) {
      return Response.json({ delivered: false, reason: "offline" });
    }
    const frame = JSON.stringify({ id: cmd.id, type: cmd.type, payload: cmd.payload });
    for (const ws of sockets) {
      try {
        ws.send(frame);
      } catch {
        /* ignore individual socket errors */
      }
    }
    await this.env.DB.prepare(
      "UPDATE commands SET status = 'sent' WHERE id = ?",
    )
      .bind(cmd.id)
      .run();
    return Response.json({ delivered: true });
  }

  private async handleStatus(): Promise<Response> {
    const last = (await this.state.storage.get<number>("lastSeen")) ?? 0;
    const online = this.state.getWebSockets().length > 0;
    return Response.json({ online, last_seen: last });
  }

  // ---- WebSocket hibernation handlers ----

  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.touch();
    if (typeof message !== "string") return;
    let msg: AgentMessage;
    try {
      msg = JSON.parse(message) as AgentMessage;
    } catch {
      return;
    }

    if (msg.type === "ack") {
      await this.env.DB.prepare(
        "UPDATE commands SET status = ?, detail = ?, acked_at = datetime('now') WHERE id = ?",
      )
        .bind(msg.ok ? "acked" : "failed", msg.detail ?? null, msg.command_id)
        .run();
    } else if (msg.type === "playback") {
      const uuid = (await this.state.storage.get<string>("uuid")) ?? null;
      if (msg.black_screen) {
        await recordEvent(this.env, {
          type: "screenshot_error",
          device_id: uuid,
          severity: "warning",
          message: "Black screen detected during playback",
        });
      } else if (msg.browser_error) {
        await recordEvent(this.env, {
          type: "playlist_error",
          device_id: uuid,
          severity: "warning",
          message: `Player error: ${msg.browser_error}`,
        });
      }
    }
    // heartbeat: presence already refreshed via touch()
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
    // Presence flips to offline via the alarm timeout (or the cron sweep).
  }

  async webSocketError(): Promise<void> {
    // no-op; alarm handles offline transition
  }

  async alarm(): Promise<void> {
    const last = (await this.state.storage.get<number>("lastSeen")) ?? 0;
    const uuid = await this.state.storage.get<string>("uuid");
    const stale = Date.now() - last > this.offlineTimeoutMs;
    const hasSockets = this.state.getWebSockets().length > 0;
    if (uuid && stale && !hasSockets) {
      await this.markOffline(uuid);
    } else if (hasSockets) {
      // still connected: re-arm the watchdog
      await this.state.storage.setAlarm(Date.now() + this.offlineTimeoutMs);
    }
  }

  // ---- helpers ----

  private async touch(): Promise<void> {
    await this.state.storage.put("lastSeen", Date.now());
    await this.state.storage.setAlarm(Date.now() + this.offlineTimeoutMs + 5000);
    const uuid = await this.state.storage.get<string>("uuid");
    if (uuid) {
      await this.env.DB.prepare(
        "UPDATE devices SET last_seen_at = datetime('now') WHERE uuid = ?",
      )
        .bind(uuid)
        .run();
    }
  }

  private async markOnline(uuid: string): Promise<void> {
    const row = await this.env.DB.prepare(
      "SELECT status FROM devices WHERE uuid = ?",
    )
      .bind(uuid)
      .first<{ status: string }>();
    await this.env.DB.prepare(
      "UPDATE devices SET status = 'online', last_seen_at = datetime('now') WHERE uuid = ?",
    )
      .bind(uuid)
      .run();
    if (row && row.status === "offline") {
      await recordEvent(this.env, {
        type: "device_online",
        device_id: uuid,
        severity: "info",
        message: "Device came online",
      });
    }
  }

  private async markOffline(uuid: string): Promise<void> {
    const row = await this.env.DB.prepare(
      "SELECT status FROM devices WHERE uuid = ?",
    )
      .bind(uuid)
      .first<{ status: string }>();
    if (row && row.status === "online") {
      await this.env.DB.prepare(
        "UPDATE devices SET status = 'offline' WHERE uuid = ?",
      )
        .bind(uuid)
        .run();
      await recordEvent(this.env, {
        type: "device_offline",
        device_id: uuid,
        severity: "critical",
        message: "Device went offline",
      });
    }
  }

  private async flushQueued(uuid: string): Promise<void> {
    const sockets = this.state.getWebSockets();
    if (sockets.length === 0) return;
    const rows = await this.env.DB.prepare(
      "SELECT id, type, payload FROM commands WHERE device_id = ? AND status = 'queued' ORDER BY issued_at",
    )
      .bind(uuid)
      .all<{ id: string; type: string; payload: string | null }>();
    for (const r of rows.results) {
      const frame = JSON.stringify({
        id: r.id,
        type: r.type,
        payload: r.payload ? JSON.parse(r.payload) : undefined,
      });
      for (const ws of sockets) {
        try {
          ws.send(frame);
        } catch {
          /* ignore */
        }
      }
      await this.env.DB.prepare("UPDATE commands SET status = 'sent' WHERE id = ?")
        .bind(r.id)
        .run();
    }
  }
}
