import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { requireAuth, requireRole } from "../auth";
import { buildResolvedPlaylist } from "../lib/resolve";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", requireAuth);

app.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id) AS item_count
     FROM playlists p ORDER BY p.updated_at DESC`,
  ).all();
  return c.json(rows.results);
});

app.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const pl = await c.env.DB.prepare("SELECT * FROM playlists WHERE id = ?").bind(id).first();
  if (!pl) return c.json({ error: "not_found" }, 404);
  const items = await c.env.DB.prepare(
    "SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY order_index",
  )
    .bind(id)
    .all();
  return c.json({ ...pl, items: items.results });
});

// Fully resolved playlist (absolute URLs) — handy for previewing.
app.get("/:id/resolved", async (c) => {
  const resolved = await buildResolvedPlaylist(c.env, Number(c.req.param("id")));
  if (!resolved) return c.json({ error: "not_found" }, 404);
  return c.json(resolved);
});

app.post("/", requireRole("admin", "operator"), async (c) => {
  const { name, loop } = await c.req.json<{ name: string; loop?: boolean }>();
  if (!name) return c.json({ error: "missing_name" }, 400);
  const res = await c.env.DB.prepare(
    "INSERT INTO playlists (name, loop, created_by) VALUES (?, ?, ?)",
  )
    .bind(name, loop === false ? 0 : 1, c.get("user").id)
    .run();
  return c.json({ id: res.meta.last_row_id });
});

app.patch("/:id", requireRole("admin", "operator"), async (c) => {
  const { name, loop } = await c.req.json<{ name?: string; loop?: boolean }>();
  await c.env.DB.prepare(
    "UPDATE playlists SET name = COALESCE(?, name), loop = COALESCE(?, loop), updated_at = datetime('now') WHERE id = ?",
  )
    .bind(name ?? null, loop === undefined ? null : loop ? 1 : 0, Number(c.req.param("id")))
    .run();
  return c.json({ ok: true });
});

app.delete("/:id", requireRole("admin", "operator"), async (c) => {
  await c.env.DB.prepare("DELETE FROM playlists WHERE id = ?")
    .bind(Number(c.req.param("id")))
    .run();
  return c.json({ ok: true });
});

// Replace the full item list (order is the array order).
app.put("/:id/items", requireRole("admin", "operator"), async (c) => {
  const id = Number(c.req.param("id"));
  const items = await c.req.json<
    Array<{ type: string; url?: string; media_id?: number; duration_sec?: number }>
  >();
  await c.env.DB.prepare("DELETE FROM playlist_items WHERE playlist_id = ?").bind(id).run();
  let idx = 0;
  for (const it of items) {
    await c.env.DB.prepare(
      "INSERT INTO playlist_items (playlist_id, type, url, media_id, duration_sec, order_index) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(id, it.type, it.url ?? null, it.media_id ?? null, it.duration_sec ?? 10, idx++)
      .run();
  }
  await c.env.DB.prepare("UPDATE playlists SET updated_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
  return c.json({ ok: true, count: items.length });
});

export default app;
