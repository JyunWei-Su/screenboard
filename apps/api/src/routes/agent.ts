import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { deviceAuth } from "../auth";
import { deviceStub } from "../lib/command";
import { buildResolvedPlaylist, resolvePlaylistId, resolveTarget } from "../lib/resolve";
import { recordEvent } from "../lib/notify";
import { allowedSshUsers, createTunnelToken, remoteAccessConfigured } from "../lib/cloudflareTunnel";
import type { HealthSample, OtaUpdateResponse } from "@screenboard/shared";

// Device-facing endpoints (agent), all behind deviceAuth.
const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", deviceAuth);

// WebSocket command channel: upgrade forwarded to the device's Durable Object.
app.get("/ws", (c) => {
  const uuid = c.get("deviceUuid");
  const headers = new Headers(c.req.raw.headers);
  headers.set("x-device-uuid", uuid);
  const doReq = new Request("https://do/connect", { method: "GET", headers });
  return deviceStub(c.env, uuid).fetch(doReq);
});

// Health ingestion: update latest snapshot + append history + threshold alerts.
app.post("/health", async (c) => {
  const uuid = c.get("deviceUuid");
  const h = await c.req.json<HealthSample>();
  const netOk = h.net_ok ? 1 : 0;

  await c.env.DB.prepare(
    `INSERT INTO device_health_latest (device_id, cpu, memory, disk, net_ok, uptime, ts)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(device_id) DO UPDATE SET
       cpu=excluded.cpu, memory=excluded.memory, disk=excluded.disk,
       net_ok=excluded.net_ok, uptime=excluded.uptime, ts=excluded.ts`,
  )
    .bind(uuid, h.cpu, h.memory, h.disk, netOk, h.uptime)
    .run();

  await c.env.DB.prepare(
    "INSERT INTO device_health_history (device_id, cpu, memory, disk, net_ok, uptime) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(uuid, h.cpu, h.memory, h.disk, netOk, h.uptime)
    .run();

  // Threshold alerts (deduped: at most one per type per device per 30 min).
  const thresholds: Array<[boolean, "cpu_high" | "memory_high" | "disk_low", string]> = [
    [h.cpu > 90, "cpu_high", `CPU usage high: ${h.cpu.toFixed(0)}%`],
    [h.memory > 90, "memory_high", `Memory usage high: ${h.memory.toFixed(0)}%`],
    [h.disk > 90, "disk_low", `Disk almost full: ${h.disk.toFixed(0)}%`],
  ];
  let warn = false;
  for (const [breached, type, message] of thresholds) {
    if (!breached) continue;
    warn = true;
    const recent = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE device_id = ? AND type = ? AND created_at >= datetime('now', '-30 minutes')",
    )
      .bind(uuid, type)
      .first<{ n: number }>();
    if ((recent?.n ?? 0) === 0) {
      await recordEvent(c.env, { type, device_id: uuid, severity: "warning", message });
    }
  }

  // Reflect warning state on the device (don't override maintenance).
  await c.env.DB.prepare(
    "UPDATE devices SET status = CASE WHEN status IN ('online','warning') THEN ? ELSE status END, last_seen_at = datetime('now') WHERE uuid = ?",
  )
    .bind(warn ? "warning" : "online", uuid)
    .run();

  return c.json({ ok: true });
});

// X11 is not available during first-boot enrollment. Update resolution after
// the kiosk session has started and whenever the display mode changes.
app.post("/display-info", async (c) => {
  const resolution = (await c.req.json<{ resolution?: string }>()).resolution?.trim() || "";
  if (!/^\d{2,5}x\d{2,5}$/.test(resolution)) return c.json({ error: "invalid_resolution" }, 400);
  await c.env.DB.prepare("UPDATE devices SET resolution = ? WHERE uuid = ?")
    .bind(resolution, c.get("deviceUuid"))
    .run();
  return c.json({ ok: true });
});

// Refresh mutable device-page information after reloads, OTA updates, and
// network changes. The device token limits this update to its own record.
app.post("/info", async (c) => {
  const info = await c.req.json<{
    hostname?: string;
    serial?: string;
    os_version?: string;
    agent_version?: string;
    ip?: string;
    mac?: string;
    resolution?: string;
  }>();
  const resolution = info.resolution?.trim() || "";
  if (resolution && !/^\d{2,5}x\d{2,5}$/.test(resolution)) {
    return c.json({ error: "invalid_resolution" }, 400);
  }
  await c.env.DB.prepare(
    `UPDATE devices SET hostname = COALESCE(NULLIF(?, ''), hostname),
     serial = COALESCE(NULLIF(?, ''), serial), os_version = COALESCE(NULLIF(?, ''), os_version),
     agent_version = COALESCE(NULLIF(?, ''), agent_version), ip = COALESCE(NULLIF(?, ''), ip),
     mac = COALESCE(NULLIF(?, ''), mac), resolution = CASE WHEN ? = '' THEN resolution ELSE ? END,
     last_seen_at = datetime('now') WHERE uuid = ?`,
  )
    .bind(
      info.hostname || "",
      info.serial || "",
      info.os_version || "",
      info.agent_version || "",
      info.ip || "",
      info.mac || "",
      resolution,
      resolution,
      c.get("deviceUuid"),
    )
    .run();
  return c.json({ ok: true });
});

// Screenshot upload from the device. Raw PNG body. ?trigger=auto|manual&analysis=
app.post("/screenshot", async (c) => {
  const uuid = c.get("deviceUuid");
  const trigger = c.req.query("trigger") || "auto";
  const analysis = c.req.query("analysis") || null;
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength === 0) return c.json({ error: "empty_body" }, 400);
  const key = `screenshots/${uuid}/${Date.now()}.png`;
  await c.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: "image/png" } });
  const res = await c.env.DB.prepare(
    `INSERT INTO screenshots (device_id, r2_key, trigger, analysis, scene_id, scene_version, widget_errors)
     SELECT ?, ?, ?, ?, active_scene_id, active_scene_version, widget_errors FROM devices WHERE uuid = ?`,
  )
    .bind(uuid, key, trigger, analysis, uuid)
    .run();
  if (analysis === "black_screen") {
    await recordEvent(c.env, {
      type: "screenshot_error",
      device_id: uuid,
      severity: "warning",
      message: "Screenshot analysis: black screen",
    });
  }
  return c.json({ id: res.meta.last_row_id });
});

// Resolve the playlist the device should currently play.
app.get("/playlist", async (c) => {
  const uuid = c.get("deviceUuid");
  const device = await c.env.DB.prepare(
    "SELECT uuid, group_id, playlist_id FROM devices WHERE uuid = ?",
  )
    .bind(uuid)
    .first<{ uuid: string; group_id: number | null; playlist_id: number | null }>();
  if (!device) return c.json({ error: "unknown_device" }, 404);
  const playlistId = await resolvePlaylistId(c.env, device);
  if (!playlistId) return c.json({ playlist_id: null, items: [] });
  const resolved = await buildResolvedPlaylist(c.env, playlistId);
  return c.json(resolved ?? { playlist_id: null, items: [] });
});

// Resolve the single effective playback target (playlist | scene |
// scene_playlist | none) for this device right now. Newer agents use this in
// place of /playlist; /playlist is kept unchanged for back-compat.
app.get("/target", async (c) => {
  const uuid = c.get("deviceUuid");
  const device = await c.env.DB.prepare(
    "SELECT uuid, group_id, source_type, playlist_id, scene_id, scene_playlist_id FROM devices WHERE uuid = ?",
  )
    .bind(uuid)
    .first<{
      uuid: string;
      group_id: number | null;
      source_type: string;
      playlist_id: number | null;
      scene_id: number | null;
      scene_playlist_id: number | null;
    }>();
  if (!device) return c.json({ error: "unknown_device" }, 404);
  const target = await resolveTarget(c.env, device);
  return c.json(target);
});

// Called once by the root-owned installer after enrollment. A fresh token is
// returned without persisting it in D1, then written directly to cloudflared.
app.get("/remote-access", async (c) => {
  const uuid = c.get("deviceUuid");
  const row = await c.env.DB.prepare(
    "SELECT tunnel_id, hostname, status, ssh_ca_public_key FROM device_remote_access WHERE device_id = ?",
  ).bind(uuid).first<{ tunnel_id: string; hostname: string; status: string; ssh_ca_public_key: string | null }>();
  if (!row) {
    return c.json({
      enabled: false,
      configured: remoteAccessConfigured(c.env),
      reason: remoteAccessConfigured(c.env) ? "not_provisioned" : "not_configured",
    });
  }
  try {
    const tunnelToken = await createTunnelToken(c.env, row.tunnel_id);
    if (!tunnelToken) return c.json({ enabled: false, configured: remoteAccessConfigured(c.env), reason: "token_unavailable" });
    return c.json({
      enabled: true,
      hostname: row.hostname,
      tunnel_token: tunnelToken,
      ssh_ca_public_key: row.ssh_ca_public_key,
      ssh_users: allowedSshUsers(c.env),
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "remote_access_token_failed", device_id: uuid, error: String(error) }));
    return c.json({ enabled: false, configured: true, reason: "token_unavailable" }, 503);
  }
});

// OTA update check for this device's channel, honoring active deployments.
app.get("/update", async (c) => {
  const uuid = c.get("deviceUuid");
  const channel = c.req.query("channel") || "stable";
  const current = c.req.query("current") || "";

  const pkg = await c.env.DB.prepare(
    "SELECT id, version, r2_key, checksum FROM ota_packages WHERE channel = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(channel)
    .first<{ id: number; version: string; checksum: string }>();

  const none: OtaUpdateResponse = { update_available: false };
  if (!pkg || pkg.version === current) return c.json(none);

  const deployment = await c.env.DB.prepare(
    "SELECT strategy, target, percent FROM ota_deployments WHERE package_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
  )
    .bind(pkg.id)
    .first<{ strategy: string; target: string | null; percent: number }>();
  if (!deployment) return c.json(none);

  let covered = false;
  if (deployment.strategy === "all") {
    covered = true;
  } else if (deployment.strategy === "canary") {
    // deterministic per-device bucket 0-99
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(uuid));
    const bucket = new Uint8Array(digest)[0] % 100;
    covered = bucket < deployment.percent;
  } else if (deployment.strategy === "group" && deployment.target) {
    const dev = await c.env.DB.prepare("SELECT group_id FROM devices WHERE uuid = ?")
      .bind(uuid)
      .first<{ group_id: number | null }>();
    const rows = await c.env.DB.prepare("SELECT id, parent_id FROM groups").all<{
      id: number;
      parent_id: number | null;
    }>();
    const parentOf = new Map<number, number | null>();
    for (const r of rows.results) parentOf.set(r.id, r.parent_id);
    let cur = dev?.group_id ?? null;
    const target = Number(deployment.target);
    while (cur != null) {
      if (cur === target) {
        covered = true;
        break;
      }
      cur = parentOf.get(cur) ?? null;
    }
  }
  if (!covered) return c.json(none);

  const base = c.env.PUBLIC_API_URL.replace(/\/$/, "");
  const resp: OtaUpdateResponse = {
    update_available: true,
    version: pkg.version,
    url: `${base}/api/content/ota/${pkg.id}`,
    checksum: pkg.checksum,
  };
  return c.json(resp);
});

export default app;
