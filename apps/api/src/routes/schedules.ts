import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { requireAuth, requireRole } from "../auth";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", requireAuth);

app.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT s.*, p.name AS playlist_name FROM schedules s
     JOIN playlists p ON p.id = s.playlist_id ORDER BY s.priority DESC, s.id`,
  ).all();
  return c.json(rows.results);
});

app.post("/", requireRole("admin", "operator"), async (c) => {
  const b = await c.req.json<{
    playlist_id: number;
    target_type: "device" | "group";
    target_id: string;
    date_start?: string | null;
    date_end?: string | null;
    time_start?: string | null;
    time_end?: string | null;
    weekdays?: number;
    priority?: number;
  }>();
  if (!b.playlist_id || !b.target_type || !b.target_id) {
    return c.json({ error: "missing_fields" }, 400);
  }
  const res = await c.env.DB.prepare(
    `INSERT INTO schedules (playlist_id, target_type, target_id, date_start, date_end, time_start, time_end, weekdays, priority)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      b.playlist_id,
      b.target_type,
      b.target_id,
      b.date_start ?? null,
      b.date_end ?? null,
      b.time_start ?? null,
      b.time_end ?? null,
      b.weekdays ?? 127,
      b.priority ?? 0,
    )
    .run();
  return c.json({ id: res.meta.last_row_id });
});

app.delete("/:id", requireRole("admin", "operator"), async (c) => {
  await c.env.DB.prepare("DELETE FROM schedules WHERE id = ?")
    .bind(Number(c.req.param("id")))
    .run();
  return c.json({ ok: true });
});

export default app;
