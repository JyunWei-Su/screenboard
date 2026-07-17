import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { requireAuth, requireRole } from "../auth";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", requireAuth);

app.get("/", async (c) => {
  const unresolved = c.req.query("unresolved");
  const deviceId = c.req.query("device_id");
  const severity = c.req.query("severity");
  const type = c.req.query("type")?.trim();
  const query = c.req.query("q")?.trim();
  const from = c.req.query("from")?.trim();
  const to = c.req.query("to")?.trim();
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 20));
  const where: string[] = [];
  const binds: unknown[] = [];
  if (unresolved === "1") where.push("resolved_at IS NULL");
  if (deviceId) {
    where.push("device_id = ?");
    binds.push(deviceId);
  }
  if (severity && ["info", "warning", "critical"].includes(severity)) {
    where.push("severity = ?");
    binds.push(severity);
  }
  if (type) {
    where.push("type LIKE ?");
    binds.push(`%${type}%`);
  }
  if (query) {
    where.push("(message LIKE ? OR type LIKE ? OR device_id LIKE ?)");
    binds.push(`%${query}%`, `%${query}%`, `%${query}%`);
  }
  if (from) {
    where.push("created_at >= ?");
    binds.push(from.replace("T", " "));
  }
  if (to) {
    where.push("created_at <= ?");
    binds.push(to.replace("T", " "));
  }
  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM events${whereSql}`)
    .bind(...binds)
    .first<{ n: number }>();
  const rows = await c.env.DB.prepare(
    `SELECT events.*, devices.name AS device_name
     FROM events LEFT JOIN devices ON devices.uuid = events.device_id${whereSql}
     ORDER BY events.created_at DESC LIMIT ? OFFSET ?`,
  ).bind(...binds, limit, (page - 1) * limit).all();
  return c.json({
    items: rows.results,
    page,
    limit,
    total: total?.n ?? 0,
    total_pages: Math.max(1, Math.ceil((total?.n ?? 0) / limit)),
  });
});

app.post("/:id/resolve", requireRole("admin", "operator"), async (c) => {
  await c.env.DB.prepare(
    "UPDATE events SET resolved_at = datetime('now') WHERE id = ?",
  )
    .bind(Number(c.req.param("id")))
    .run();
  return c.json({ ok: true });
});

app.delete("/batch", requireRole("admin", "operator"), async (c) => {
  const { ids } = await c.req.json<{ ids?: unknown }>();
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || ids.some((id) => !Number.isInteger(id))) {
    return c.json({ error: "invalid_ids" }, 400);
  }
  const placeholders = ids.map(() => "?").join(", ");
  await c.env.DB.prepare(`DELETE FROM events WHERE id IN (${placeholders})`).bind(...ids).run();
  return c.json({ ok: true });
});

app.delete("/:id", requireRole("admin", "operator"), async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid_id" }, 400);
  await c.env.DB.prepare("DELETE FROM events WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

export default app;
