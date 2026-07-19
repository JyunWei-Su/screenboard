import type { Env } from "../types";
import { recordEvent } from "../lib/notify";
import { broadcastDeviceStatus } from "../lib/presence";
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

  // Grace after a socket drops before the device is flipped offline. Much
  // shorter than the heartbeat watchdog, so a clean disconnect (network loss,
  // agent stop) surfaces in the console within seconds instead of ~90s, while
  // still absorbing a quick reconnect (token-refresh reconnect, brief network
  // blip, an agent restart for an update) without flapping.
  private get disconnectGraceMs(): number {
    return (parseInt(this.env.OFFLINE_DISCONNECT_GRACE_SECONDS || "20", 10) || 20) * 1000;
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
      // A scene report is operational state, not merely an ephemeral event.
      // Keep its revision and per-widget failures with the device record so an
      // operator can correlate the current screen (and screenshots) with it.
      if (uuid) {
        await this.env.DB.prepare(
          `UPDATE devices SET active_scene_id = ?, active_scene_version = ?,
           widget_errors = ?, playback_updated_at = datetime('now') WHERE uuid = ?`,
        ).bind(
          msg.scene_id ?? null,
          msg.scene_version ?? null,
          msg.widget_errors ? JSON.stringify(msg.widget_errors) : null,
          uuid,
        ).run();
      }
      if (msg.black_screen) {
        await recordEvent(this.env, {
          type: "screenshot_error",
          device_id: uuid,
          severity: "warning",
          message: "Black screen detected during playback",
        });
      } else if (msg.browser_error) {
        await recordEvent(this.env, {
          type: "screenshot_error",
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
    // A dropped socket starts the short offline grace so the console sees the
    // change within seconds. The alarm re-checks the live socket set, so arming
    // it while another socket still remains is harmless — it clears itself.
    await this.scheduleDisconnectSweep();
  }

  async webSocketError(): Promise<void> {
    await this.scheduleDisconnectSweep();
  }

  async alarm(): Promise<void> {
    const uuid = await this.state.storage.get<string>("uuid");
    if (!uuid) return;
    const now = Date.now();
    const last = (await this.state.storage.get<number>("lastSeen")) ?? 0;
    const disconnectedAt = (await this.state.storage.get<number>("disconnectedAt")) ?? 0;
    // Heartbeat has gone silent past the watchdog window. A device sends at least
    // every 60s (the settings cap), so this only trips on a genuinely dead link.
    // Crucially it does NOT require the socket to be gone: a pulled cable leaves
    // the socket looking attached (no close event ever arrives), so gating on
    // socket presence would let it hang online until the cron backstop. Trusting
    // heartbeat staleness is what makes a silent drop visible in ~90s.
    const stale = now - last > this.offlineTimeoutMs;
    // A cleanly closed socket whose short grace has elapsed (fast path).
    const graceElapsed = disconnectedAt > 0 && now - disconnectedAt >= this.disconnectGraceMs;
    if (stale || graceElapsed) {
      await this.markOffline(uuid); // broadcasts the transition to consoles
      await this.state.storage.delete("disconnectedAt");
      return;
    }
    // Not offline yet: re-check at whichever deadline comes first — a pending
    // disconnect grace, or the next heartbeat-staleness cutoff.
    const nextGrace = disconnectedAt > 0 ? disconnectedAt + this.disconnectGraceMs : Number.POSITIVE_INFINITY;
    const nextStale = last + this.offlineTimeoutMs + 1000;
    await this.state.storage.setAlarm(Math.min(nextGrace, nextStale));
  }

  // ---- helpers ----

  // A socket dropped: record when, and arm the short grace alarm. The alarm
  // re-checks the live socket set, so this is safe even if another socket
  // remains or the device reconnects before the grace elapses.
  private async scheduleDisconnectSweep(): Promise<void> {
    await this.state.storage.put("disconnectedAt", Date.now());
    await this.state.storage.setAlarm(Date.now() + this.disconnectGraceMs);
  }

  private async touch(): Promise<void> {
    // Hearing from the device cancels any pending disconnect grace.
    await this.state.storage.delete("disconnectedAt");
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
    await this.state.storage.delete("disconnectedAt");
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
    // Push to consoles on every connect (not only offline→online) so a reconnect
    // that never flipped the DB still refreshes a stale badge.
    await this.broadcastStatus(uuid, "online");
  }

  private async markOffline(uuid: string): Promise<void> {
    const row = await this.env.DB.prepare(
      "SELECT status FROM devices WHERE uuid = ?",
    )
      .bind(uuid)
      .first<{ status: string }>();
    // 'warning' is an online-with-alerts state; treat it like online here so the
    // fast path flips it too (the cron sweep already did).
    if (row && (row.status === "online" || row.status === "warning")) {
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
      await this.broadcastStatus(uuid, "offline");
    }
  }

  private async broadcastStatus(uuid: string, status: string): Promise<void> {
    await broadcastDeviceStatus(this.env, uuid, status);
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
