import type { Env } from "../types";
import { recordEvent } from "./notify";
import { broadcastDeviceStatus } from "./presence";

// Backstop for the Durable Object watchdog: flip stale devices to offline.
export async function sweepOffline(env: Env): Promise<void> {
  const timeout = parseInt(env.OFFLINE_TIMEOUT_SECONDS || "90", 10) || 90;
  const cutoff = `-${timeout * 2} seconds`;
  const stale = await env.DB.prepare(
    `SELECT uuid FROM devices WHERE status IN ('online','warning')
       AND (last_seen_at IS NULL OR last_seen_at < datetime('now', ?))`,
  )
    .bind(cutoff)
    .all<{ uuid: string }>();
  for (const d of stale.results) {
    await env.DB.prepare("UPDATE devices SET status = 'offline' WHERE uuid = ?")
      .bind(d.uuid)
      .run();
    await recordEvent(env, {
      type: "device_offline",
      device_id: d.uuid,
      severity: "critical",
      message: "Device went offline (no heartbeat)",
    });
    // Push live too, so anything the watchdog missed still updates open consoles.
    await broadcastDeviceStatus(env, d.uuid, "offline");
  }
}

// Daily retention: prune health history + old resolved events beyond retention.
export async function pruneRetention(env: Env): Promise<void> {
  const days = parseInt(env.HEALTH_RETENTION_DAYS || "90", 10) || 90;
  await env.DB.prepare(
    "DELETE FROM device_health_history WHERE ts < datetime('now', ?)",
  )
    .bind(`-${days} days`)
    .run();
  await env.DB.prepare(
    "DELETE FROM events WHERE resolved_at IS NOT NULL AND created_at < datetime('now', ?)",
  )
    .bind(`-${days} days`)
    .run();
}
