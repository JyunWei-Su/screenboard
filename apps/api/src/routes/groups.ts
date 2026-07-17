import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { generateEnrollmentToken, requireAuth, requireRole } from "../auth";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", requireAuth);

app.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, name, type, parent_id, created_at FROM groups ORDER BY name",
  ).all();
  return c.json(rows.results);
});

app.post("/", requireRole("admin", "operator"), async (c) => {
  const { name, type, parent_id } = await c.req.json<{
    name: string;
    type?: string;
    parent_id?: number | null;
  }>();
  if (!name) return c.json({ error: "missing_name" }, 400);
  const res = await c.env.DB.prepare(
    "INSERT INTO groups (name, type, parent_id) VALUES (?, ?, ?)",
  )
    .bind(name, type || "custom", parent_id ?? null)
    .run();
  return c.json({ id: res.meta.last_row_id });
});

app.patch("/:id", requireRole("admin", "operator"), async (c) => {
  const { name, type, parent_id } = await c.req.json<{
    name?: string;
    type?: string;
    parent_id?: number | null;
  }>();
  await c.env.DB.prepare(
    "UPDATE groups SET name = COALESCE(?, name), type = COALESCE(?, type), parent_id = ? WHERE id = ?",
  )
    .bind(name ?? null, type ?? null, parent_id ?? null, Number(c.req.param("id")))
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
