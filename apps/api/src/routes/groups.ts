import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { generateEnrollmentToken, requireAuth, requireRole } from "../auth";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", requireAuth);

app.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT g.id, g.name, g.created_at, COUNT(d.uuid) AS device_count
     FROM groups g LEFT JOIN devices d ON d.group_id = g.id
     GROUP BY g.id, g.name, g.created_at
     ORDER BY g.name`,
  ).all();
  return c.json(rows.results);
});

// Group detail: the group plus the devices assigned to it.
app.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid_id" }, 400);
  const group = await c.env.DB.prepare("SELECT id, name FROM groups WHERE id = ?")
    .bind(id)
    .first<{ id: number; name: string }>();
  if (!group) return c.json({ error: "not_found" }, 404);
  const devices = await c.env.DB.prepare(
    "SELECT uuid, name, status, last_seen_at FROM devices WHERE group_id = ? ORDER BY name",
  )
    .bind(id)
    .all();
  return c.json({ ...group, devices: devices.results });
});

app.post("/", requireRole("admin", "operator"), async (c) => {
  const { name } = await c.req.json<{ name: string }>();
  if (!name) return c.json({ error: "missing_name" }, 400);
  const res = await c.env.DB.prepare("INSERT INTO groups (name) VALUES (?)")
    .bind(name)
    .run();
  return c.json({ id: res.meta.last_row_id });
});

app.patch("/:id", requireRole("admin", "operator"), async (c) => {
  const { name } = await c.req.json<{ name?: string }>();
  if (!name) return c.json({ error: "missing_name" }, 400);
  await c.env.DB.prepare("UPDATE groups SET name = ? WHERE id = ?")
    .bind(name, Number(c.req.param("id")))
    .run();
  return c.json({ ok: true });
});

app.delete("/:id", requireRole("admin"), async (c) => {
  await c.env.DB.prepare("DELETE FROM groups WHERE id = ?")
    .bind(Number(c.req.param("id")))
    .run();
  return c.json({ ok: true });
});

// Create a one-time enrollment token (optionally bound to a group).
app.post("/enroll-token", requireRole("admin", "operator"), async (c) => {
  const { group_id, ttl_hours } = await c.req.json<{
    group_id?: number | null;
    ttl_hours?: number;
  }>().catch(() => ({ group_id: null, ttl_hours: 24 }));
  const token = generateEnrollmentToken();
  const ttl = ttl_hours && ttl_hours > 0 ? ttl_hours : 24;
  await c.env.DB.prepare(
    "INSERT INTO enrollment_tokens (token, group_id, expires_at) VALUES (?, ?, datetime('now', ?))",
  )
    .bind(token, group_id ?? null, `+${ttl} hours`)
    .run();
  return c.json({ token, expires_in_hours: ttl });
});

export default app;
