import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { requireAuth, requireRole } from "../auth";
import { issueCommand } from "../lib/command";
import { getSshAccessConfigVersion, getTunnelStatus, hostnameFor, provisionRemoteAccess, remoteAccessConfigured, removeRemoteAccess } from "../lib/cloudflareTunnel";
import type { CommandType } from "@screenboard/shared";

type AgentSettings = {
  health_interval_sec: number;
  playlist_poll_sec: number;
  screenshot_interval_sec: number;
  ota_check_sec: number;
};

function validInterval(value: unknown, min: number, max: number) {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function parseAgentSettings(value: unknown): AgentSettings | null {
  if (!value || typeof value !== "object") return null;
  const settings = value as Record<string, unknown>;
  if (
    !validInterval(settings.health_interval_sec, 10, 3600) ||
    !validInterval(settings.playlist_poll_sec, 10, 3600) ||
    !validInterval(settings.screenshot_interval_sec, 0, 86400) ||
    !validInterval(settings.ota_check_sec, 60, 86400)
  ) return null;
  return {
    health_interval_sec: settings.health_interval_sec as number,
    playlist_poll_sec: settings.playlist_poll_sec as number,
    screenshot_interval_sec: settings.screenshot_interval_sec as number,
    ota_check_sec: settings.ota_check_sec as number,
  };
}

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
    .first<{ uuid: string; group_id: number | null }>();
  if (!device) return c.json({ error: "not_found" }, 404);
  const health = await c.env.DB.prepare(
    "SELECT cpu, memory, disk, net_ok, uptime, ts FROM device_health_latest WHERE device_id = ?",
  )
    .bind(uuid)
    .first();
  return c.json({ ...device, health });
});

app.patch("/:uuid", requireRole("admin", "operator"), async (c) => {
  const uuid = c.req.param("uuid");
  const body = await c.req.json<{
    name?: string;
    group_id?: number | null;
    source_type?: "scene" | "scene_playlist";
    scene_id?: number | null;
    scene_playlist_id?: number | null;
    status?: string;
    display?: Record<string, unknown>;
    agent_settings?: unknown;
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
  if (body.source_type !== undefined) {
    // Switching the source type sets source_type + the matching id and clears
    // the other two, so a device always has exactly one active source column.
    const st = body.source_type;
    if (st !== "scene" && st !== "scene_playlist") {
      return c.json({ error: "invalid_source_type" }, 400);
    }
    sets.push("source_type = ?");
    binds.push(st);
    sets.push("scene_id = ?");
    binds.push(st === "scene" ? (body.scene_id ?? null) : null);
    sets.push("scene_playlist_id = ?");
    binds.push(st === "scene_playlist" ? (body.scene_playlist_id ?? null) : null);
  } else {
    if (body.scene_id !== undefined) {
      sets.push("scene_id = ?");
      binds.push(body.scene_id);
    }
    if (body.scene_playlist_id !== undefined) {
      sets.push("scene_playlist_id = ?");
      binds.push(body.scene_playlist_id);
    }
  }
  if (body.status !== undefined) {
    sets.push("status = ?");
    binds.push(body.status);
  }
  if (body.display !== undefined) {
    sets.push("display = ?");
    binds.push(JSON.stringify(body.display));
  }
  const agentSettings = body.agent_settings === undefined ? null : parseAgentSettings(body.agent_settings);
  if (body.agent_settings !== undefined && !agentSettings) {
    return c.json({ error: "invalid_agent_settings" }, 400);
  }
  if (agentSettings) {
    sets.push("agent_settings = ?");
    binds.push(JSON.stringify(agentSettings));
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
  if (agentSettings) {
    await issueCommand(c.env, uuid, "apply_agent_settings", agentSettings, c.get("user").id);
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
    "reboot",
    "shutdown",
    "restart_player",
    "take_screenshot",
    "check_update",
    "sync_time",
    "set_hostname",
    "apply_display",
    "apply_agent_settings",
    "repair_tunnel",
    "reinstall",
  ];
  if (!valid.includes(type)) return c.json({ error: "invalid_command" }, 400);
  if (type === "set_hostname") {
    const hostname = payload?.hostname;
    if (typeof hostname !== "string" || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(hostname)) {
      return c.json({ error: "invalid_hostname" }, 400);
    }
    if (payload?.reboot !== undefined && typeof payload.reboot !== "boolean") {
      return c.json({ error: "invalid_hostname_reboot" }, 400);
    }
  }
  const result = await issueCommand(c.env, uuid, type, payload, c.get("user").id);
  return c.json(result);
});

app.get("/:uuid/commands", async (c) => {
  const requestedPage = Number(c.req.query("page") || "1");
  const requestedLimit = Number(c.req.query("limit") || "20");
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, 100)
    : 20;
  const deviceId = c.req.param("uuid");
  const [rows, count] = await Promise.all([
    c.env.DB.prepare(
      "SELECT id, type, payload, status, detail, issued_at, acked_at FROM commands WHERE device_id = ? ORDER BY issued_at DESC, id DESC LIMIT ? OFFSET ?",
    ).bind(deviceId, limit, (page - 1) * limit).all(),
    c.env.DB.prepare("SELECT COUNT(*) AS total FROM commands WHERE device_id = ?")
      .bind(deviceId)
      .first<{ total: number }>(),
  ]);
  const total = count?.total ?? 0;
  return c.json({
    items: rows.results,
    page,
    limit,
    total,
    total_pages: Math.max(1, Math.ceil(total / limit)),
  });
});

app.get("/:uuid/commands/:id", async (c) => {
  const command = await c.env.DB.prepare(
    "SELECT id, type, status, detail, issued_at, acked_at FROM commands WHERE id = ? AND device_id = ?",
  ).bind(c.req.param("id"), c.req.param("uuid")).first();
  if (!command) return c.json({ error: "not_found" }, 404);
  return c.json(command);
});

app.delete("/:uuid/commands/batch", requireRole("admin", "operator"), async (c) => {
  const { ids } = await c.req.json<{ ids?: unknown }>();
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || !ids.every((id) => typeof id === "string" && id)) {
    return c.json({ error: "invalid_ids" }, 400);
  }
  const uniqueIds = [...new Set(ids as string[])];
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const result = await c.env.DB.prepare(
    `DELETE FROM commands WHERE device_id = ? AND id IN (${placeholders})`,
  ).bind(c.req.param("uuid"), ...uniqueIds).run();
  return c.json({ ok: true, deleted: result.meta.changes });
});

app.delete("/:uuid/commands/:id", requireRole("admin", "operator"), async (c) => {
  const id = c.req.param("id");
  const uuid = c.req.param("uuid");
  const command = await c.env.DB.prepare(
    "SELECT status FROM commands WHERE id = ? AND device_id = ?",
  ).bind(id, uuid).first<{ status: string }>();
  if (!command) return c.json({ error: "not_found" }, 404);
  await c.env.DB.prepare("DELETE FROM commands WHERE id = ? AND device_id = ?")
    .bind(id, uuid)
    .run();
  return c.json({ ok: true });
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
    "SELECT tunnel_id, hostname, access_app_id, status, last_error, updated_at, provisioning_version, access_config_version, ssh_ca_public_key FROM device_remote_access WHERE device_id = ?",
  ).bind(uuid).first<{ tunnel_id: string; hostname: string; access_app_id: string | null; status: string; last_error: string | null; updated_at: string; provisioning_version: number; access_config_version: number; ssh_ca_public_key: string | null }>();
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
  const accessConfigVersion = await getSshAccessConfigVersion(c.env);
  return c.json({
    configured: true,
    enabled: true,
    hostname: row.hostname,
    status,
    last_error: row.last_error,
    updated_at: row.updated_at,
    ca_ready: Boolean(row.ssh_ca_public_key),
    needs_reprovision: row.hostname !== hostnameFor(c.env, uuid) || row.provisioning_version < 3 || row.access_config_version !== accessConfigVersion,
  });
});

app.post("/:uuid/remote-access", requireRole("admin"), async (c) => {
  if (!remoteAccessConfigured(c.env)) return c.json({ error: "remote_access_not_configured" }, 409);
  const uuid = c.req.param("uuid");
  const body: { force?: unknown } = await c.req.json<{ force?: unknown }>().catch(() => ({}));
  if (body.force !== undefined && typeof body.force !== "boolean") return c.json({ error: "invalid_force" }, 400);
  const device = await c.env.DB.prepare("SELECT uuid, name FROM devices WHERE uuid = ?")
    .bind(uuid).first<{ uuid: string; name: string }>();
  if (!device) return c.json({ error: "not_found" }, 404);
  let existing = await c.env.DB.prepare(
    "SELECT tunnel_id, access_app_id, hostname, status, provisioning_version, access_config_version FROM device_remote_access WHERE device_id = ?",
  ).bind(uuid).first<{ tunnel_id: string; access_app_id: string | null; hostname: string; status: string; provisioning_version: number; access_config_version: number }>();
  const accessConfigVersion = await getSshAccessConfigVersion(c.env);
  const needsReplacement = Boolean(
    existing && (body.force || existing.hostname !== hostnameFor(c.env, uuid) || existing.provisioning_version < 3 || existing.access_config_version !== accessConfigVersion),
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
  // The Agent must install the newly issued connector token. It also gives the
  // device a visible status notification for an operator-initiated provision.
  const repair = await issueCommand(c.env, uuid, "repair_tunnel", undefined, c.get("user").id);
  return c.json({ ok: true, action: needsReplacement || !existing ? "reprovision_and_repair" : "connector_repair", repair });
});

export default app;
