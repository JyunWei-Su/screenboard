import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { requireAuth, requireRole } from "../auth";

// Admin: list screenshots. Image bytes are served from routes/content.ts, and the
// device upload endpoint lives in routes/agent.ts (device-authenticated).
const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", requireAuth);

app.get("/", async (c) => {
  const deviceId = c.req.query("device_id");
  const limit = Math.min(Number(c.req.query("limit") || "50"), 200);
  let sql = "SELECT id, device_id, r2_key, trigger, analysis, taken_at FROM screenshots";
  const binds: unknown[] = [];
  if (deviceId) {
    sql += " WHERE device_id = ?";
    binds.push(deviceId);
  }
  sql += " ORDER BY taken_at DESC LIMIT ?";
  binds.push(limit);
  const rows = await c.env.DB.prepare(sql).bind(...binds).all();
  return c.json(rows.results);
});

// Remove both the metadata and image object so manual cleanup also frees R2 storage.
app.delete("/:id", requireRole("admin", "operator"), async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "invalid_id" }, 400);
  const shot = await c.env.DB.prepare("SELECT r2_key FROM screenshots WHERE id = ?")
    .bind(id)
    .first<{ r2_key: string }>();
  if (!shot) return c.json({ error: "not_found" }, 404);
  await c.env.BUCKET.delete(shot.r2_key);
  await c.env.DB.prepare("DELETE FROM screenshots WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

export default app;
