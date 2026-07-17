import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { requireAuth, requireRole } from "../auth";
import { issueCommand } from "../lib/command";

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Admin OTA management. Package binaries are served from routes/content.ts.
export const adminOta = new Hono<{ Bindings: Env; Variables: Variables }>();
adminOta.use("*", requireAuth);

adminOta.get("/packages", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, channel, version, checksum, signature, notes, created_at FROM ota_packages ORDER BY created_at DESC",
  ).all();
  return c.json(rows.results);
});

// Upload an agent binary. ?channel=stable|beta&version=x.y.z&notes=&signature=
adminOta.put("/packages", requireRole("admin"), async (c) => {
  const channel = c.req.query("channel") || "stable";
  const version = c.req.query("version");
  const notes = c.req.query("notes") || null;
  const signature = c.req.query("signature") || null;
  if (!version) return c.json({ error: "missing_version" }, 400);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength === 0) return c.json({ error: "empty_body" }, 400);
  const checksum = await sha256HexBytes(bytes);
  const key = `ota/${channel}/${version}/screenboard-agent`;
  await c.env.BUCKET.put(key, bytes, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  const res = await c.env.DB.prepare(
    "INSERT INTO ota_packages (channel, version, r2_key, checksum, signature, notes) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(channel, version, key, checksum, signature, notes)
    .run();
  return c.json({ id: res.meta.last_row_id, checksum });
});

adminOta.delete("/packages/:id", requireRole("admin"), async (c) => {
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare("SELECT r2_key FROM ota_packages WHERE id = ?")
    .bind(id)
    .first<{ r2_key: string }>();
  if (row) await c.env.BUCKET.delete(row.r2_key);
  await c.env.DB.prepare("DELETE FROM ota_packages WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

adminOta.get("/deployments", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT d.*, p.version, p.channel FROM ota_deployments d
     JOIN ota_packages p ON p.id = d.package_id ORDER BY d.created_at DESC`,
  ).all();
  return c.json(rows.results);
});

// Create a rollout: strategy = all | group | canary
adminOta.post("/deployments", requireRole("admin"), async (c) => {
  const b = await c.req.json<{
    package_id: number;
    strategy: "all" | "group" | "canary";
    target?: string | null;
    percent?: number;
  }>();
  if (!b.package_id || !b.strategy) return c.json({ error: "missing_fields" }, 400);
  const res = await c.env.DB.prepare(
    "INSERT INTO ota_deployments (package_id, strategy, target, percent) VALUES (?, ?, ?, ?)",
  )
    .bind(b.package_id, b.strategy, b.target ?? null, b.percent ?? 100)
    .run();
  // Push an immediate check to connected devices. Offline devices keep the
  // normal polling fallback and update when they reconnect.
  let sql = "SELECT uuid FROM devices";
  const binds: unknown[] = [];
  if (b.strategy === "group" && b.target) {
    sql += " WHERE group_id = ?";
    binds.push(Number(b.target));
  }
  const devices = await c.env.DB.prepare(sql).bind(...binds).all<{ uuid: string }>();
  const percent = Math.max(0, Math.min(100, b.percent ?? 100));
  for (const device of devices.results) {
    if (b.strategy === "canary" && (parseInt(device.uuid.replace(/-/g, "").slice(0, 8), 16) % 100) >= percent) continue;
    await issueCommand(c.env, device.uuid, "check_update", undefined, c.get("user").id);
  }
  return c.json({ id: res.meta.last_row_id });
});

adminOta.patch("/deployments/:id", requireRole("admin"), async (c) => {
  const { status, percent } = await c.req.json<{ status?: string; percent?: number }>();
  await c.env.DB.prepare(
    "UPDATE ota_deployments SET status = COALESCE(?, status), percent = COALESCE(?, percent) WHERE id = ?",
  )
    .bind(status ?? null, percent ?? null, Number(c.req.param("id")))
    .run();
  return c.json({ ok: true });
});

adminOta.delete("/deployments/:id", requireRole("admin"), async (c) => {
  await c.env.DB.prepare("DELETE FROM ota_deployments WHERE id = ?")
    .bind(Number(c.req.param("id")))
    .run();
  return c.json({ ok: true });
});

export default adminOta;
