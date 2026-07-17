import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { requireAuth, requireRole } from "../auth";
import { issueCommand } from "../lib/command";
import { resolvePlaylistId } from "../lib/resolve";
import { getTunnelStatus, hostnameFor, provisionRemoteAccess, remoteAccessConfigured, removeRemoteAccess } from "../lib/cloudflareTunnel";
import type { CommandType } from "@screenboard/shared";

// Admin-facing device management.
const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", requireAuth);

app.get("/", async (c) => {
  const group = c.req.query("group_id");
  const status = c.req.query("status");
  let sql =
    `SELECT d.*, h.cpu, h.memory, h.disk, h.net_ok, h.uptime, h.ts AS health_ts
     FROM devices d LEFT JOIN device_health_latest h ON h.device_id = d.uuid`;
  const where: string[] = [];
  const binds: unknown[] = [];
  if (group) {
    where.push("d.group_id = ?");
    binds.push(Number(group));
  }
  if (status) {
    where.push("d.status = ?");
    binds.push(status);
  }
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY d.name";
  const rows = await c.env.DB.prepare(sql).bind(...binds).all();
  return c.json(rows.results);
});

app.get("/:uuid", async (c) => {
  const uuid = c.req.param("uuid");
  const device = await c.env.DB.prepare("SELECT * FROM devices WHERE uuid = ?")
    .bind(uuid)
    .first<{ uuid: string; group_id: number | null; playlist_id: number | null }>();
  if (!device) return c.json({ error: "not_found" }, 404);
  const health = await c.env.DB.prepare(
    "SELECT cpu, memory, disk, net_ok, uptime, ts FROM device_health_latest WHERE device_id = ?",
  )
    .bind(uuid)
    .first();
  const activePlaylist = await resolvePlaylistId(c.env, device);
  return c.json({ ...device, health, active_playlist_id: activePlaylist });
});

app.patch("/:uuid", requireRole("admin", "operator"), async (c) => {
  const uuid = c.req.param("uuid");
  const body = await c.req.json<{
    name?: string;
    group_id?: number | null;
    playlist_id?: number | null;
    status?: string;
    display?: Record<string, unknown>;
  }>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.name !== undefined) {
    sets.push("name = ?");
    binds.push(body.name);
  }
  if (body.group_id !== undefined) {
    sets.push("group_id = ?");
    binds.push(body.group_id);
  }
  if (body.playlist_id !== undefined) {
    sets.push("playlist_id = ?");
    binds.push(body.playlist_id);
  }
  if (body.status !== undefined) {
    sets.push("status = ?");
    binds.push(body.status);
  }
  if (body.display !== undefined) {
    sets.push("display = ?");
    binds.push(JSON.stringify(body.display));
  }
  if (!sets.length) return c.json({ error: "no_fields" }, 400);
  binds.push(uuid);
  await c.env.DB.prepare(`UPDATE devices SET ${sets.join(", ")} WHERE uuid = ?`)
    .bind(...binds)
    .run();

  // If display settings changed, push them to the device.
  if (body.display !== undefined) {
    await issueCommand(c.env, uuid, "apply_display", body.display, c.get("user").id);
  }
  return c.json({ ok: true });
});

app.delete("/:uuid", requireRole("admin"), async (c) => {
  const uuid = c.req.param("uuid");
  const remote = await c.env.DB.prepare(
    "SELECT tunnel_id, access_app_id, hostname FROM device_remote_access WHERE device_id = ?",
  ).bind(uuid).first<{ tunnel_id: string; access_app_id: string | null; hostname: string }>();
  if (remote) await removeRemoteAccess(c.env, remote);
  await c.env.DB.prepare("DELETE FROM devices WHERE uuid = ?")
    .bind(uuid)
    .run();
  return c.json({ ok: true });
});

// Issue a remote command (reload / reboot / switch_playlist / take_screenshot / ...).
app.post("/:uuid/commands", requireRole("admin", "operator"), async (c) => {
  const uuid = c.req.param("uuid");
  const { type, payload } = await c.req.json<{
    type: CommandType;
    payload?: Record<string, unknown>;
  }>();
  const valid: CommandType[] = [
    "reload",
    "switch_playlist",
    "reboot",
    "shutdown",
    "restart_player",
    "take_screenshot",
    "check_update",
    "apply_display",
  ];
  if (!valid.includes(type)) return c.json({ error: "invalid_command" }, 400);
  const result = await issueCommand(c.env, uuid, type, payload, c.get("user").id);
  return c.json(result);
});

app.get("/:uuid/commands", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, type, payload, status, detail, issued_at, acked_at FROM commands WHERE device_id = ? ORDER BY issued_at DESC LIMIT 50",
  )
    .bind(c.req.param("uuid"))
    .all();
  return c.json(rows.results);
});

app.get("/:uuid/health", async (c) => {
  const hours = Number(c.req.query("hours") || "24");
  const rows = await c.env.DB.prepare(
    `SELECT cpu, memory, disk, net_ok, uptime, ts FROM device_health_history
     WHERE device_id = ? AND ts >= datetime('now', ?) ORDER BY ts`,
  )
    .bind(c.req.param("uuid"), `-${hours} hours`)
    .all();
  return c.json(rows.results);
});

app.get("/:uuid/remote-access", requireRole("admin", "operator"), async (c) => {
  const uuid = c.req.param("uuid");
  const row = await c.env.DB.prepare(
    "SELECT tunnel_id, hostname, access_app_id, status, last_error, updated_at, provisioning_version FROM device_remote_access WHERE device_id = ?",
  ).bind(uuid).first<{ tunnel_id: string; hostname: string; access_app_id: string | null; status: string; last_error: string | null; updated_at: string; provisioning_version: number }>();
  if (!row) return c.json({ configured: remoteAccessConfigured(c.env), enabled: false });
  let status = row.status;
  try {
    const current = await getTunnelStatus(c.env, row.tunnel_id);
    if (current && current !== status) {
      status = current;
      await c.env.DB.prepare("UPDATE device_remote_access SET status = ?, updated_at = datetime('now') WHERE device_id = ?")
        .bind(status, uuid).run();
    }
  } catch (error) {
    console.warn(JSON.stringify({ event: "remote_access_status_failed", device_id: uuid, error: String(error) }));
  }
  return c.json({
    configured: true,
    enabled: true,
    hostname: row.hostname,
    status,
    last_error: row.last_error,
    updated_at: row.updated_at,
    needs_reprovision: row.hostname !== hostnameFor(c.env, uuid) || row.provisioning_version < 2,
  });
});

app.post("/:uuid/remote-access", requireRole("admin"), async (c) => {
  if (!remoteAccessConfigured(c.env)) return c.json({ error: "remote_access_not_configured" }, 409);
  const uuid = c.req.param("uuid");
  const device = await c.env.DB.prepare("SELECT uuid, name FROM devices WHERE uuid = ?")
    .bind(uuid).first<{ uuid: string; name: string }>();
  if (!device) return c.json({ error: "not_found" }, 404);
  let existing = await c.env.DB.prepare(
    "SELECT tunnel_id, access_app_id, hostname, status, provisioning_version FROM device_remote_access WHERE device_id = ?",
  ).bind(uuid).first<{ tunnel_id: string; access_app_id: string | null; hostname: string; status: string; provisioning_version: number }>();
  const needsReplacement = Boolean(
    existing && (existing.hostname !== hostnameFor(c.env, uuid) || existing.provisioning_version < 2),
  );
  if (existing?.status === "error" || (existing && !existing.access_app_id) || needsReplacement) {
    // A former multi-level hostname requires a separate TLS certificate.
    // Explicit reprovisioning replaces it with the Universal SSL-compatible form.
    const staleAccess = existing;
    if (staleAccess) await removeRemoteAccess(c.env, staleAccess);
    await c.env.DB.prepare("DELETE FROM device_remote_access WHERE device_id = ?").bind(uuid).run();
    existing = null;
  }
  if (!existing) {
    const result = await provisionRemoteAccess(c.env, device);
    if (!result.ok) return c.json({ error: result.error || "remote_access_provision_failed" }, 502);
  }
  return c.json({ ok: true });
});

export default app;
