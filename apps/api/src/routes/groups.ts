import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { generateEnrollmentCode, requireAuth, requireRole } from "../auth";

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

// Create a short, one-time enrollment code (optionally bound to a group). The
// code is deliberately short-lived; if it expires before use, just issue a new
// one. Default TTL is 10 minutes (max 1440).
app.post("/enroll-token", requireRole("admin", "operator"), async (c) => {
  const { group_id, ttl_minutes } = await c.req.json<{
    group_id?: number | null;
    ttl_minutes?: number;
  }>().catch(() => ({ group_id: null, ttl_minutes: 10 }));
  const ttl = ttl_minutes && ttl_minutes > 0 ? Math.min(Math.floor(ttl_minutes), 1440) : 10;
  // The code is the PRIMARY KEY and short codes can (rarely) collide, so retry
  // a few times on a uniqueness conflict before giving up.
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = generateEnrollmentCode();
    try {
      await c.env.DB.prepare(
        "INSERT INTO enrollment_tokens (token, group_id, expires_at) VALUES (?, ?, datetime('now', ?))",
      )
        .bind(token, group_id ?? null, `+${ttl} minutes`)
        .run();
      return c.json({ token, expires_in_minutes: ttl });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/unique|constraint/i.test(message)) throw error;
    }
  }
  return c.json({ error: "could_not_allocate_code" }, 500);
});

export default app;
