import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { requireAuth, requireRole } from "../auth";
import { buildResolvedScenePlaylist, buildSceneSnapshot } from "../lib/resolve";

// Scene playlists rotate whole published scenes (not single media items).
// Mirrors the playlists route style.
const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", requireAuth);

app.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT sp.*, (SELECT COUNT(*) FROM scene_playlist_items i WHERE i.scene_playlist_id = sp.id) AS item_count
     FROM scene_playlists sp ORDER BY sp.updated_at DESC`,
  ).all();
  return c.json(rows.results);
});

app.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const pl = await c.env.DB.prepare("SELECT * FROM scene_playlists WHERE id = ?")
    .bind(id)
    .first();
  if (!pl) return c.json({ error: "not_found" }, 404);
  const items = await c.env.DB.prepare(
    `SELECT i.*, s.name AS scene_name, s.published_version
     FROM scene_playlist_items i LEFT JOIN scenes s ON s.id = i.scene_id
     WHERE i.scene_playlist_id = ? ORDER BY i.order_index`,
  )
    .bind(id)
    .all();
  return c.json({ ...pl, items: items.results });
});

// Fully resolved scene playlist (published scenes, absolute URLs).
app.get("/:id/resolved", async (c) => {
  const resolved = await buildResolvedScenePlaylist(c.env, Number(c.req.param("id")));
  if (!resolved) return c.json({ error: "not_found" }, 404);
  return c.json(resolved);
});

app.post("/", requireRole("admin", "operator"), async (c) => {
  const { name, loop } = await c.req.json<{ name: string; loop?: boolean }>();
  if (!name) return c.json({ error: "missing_name" }, 400);
  const res = await c.env.DB.prepare(
    "INSERT INTO scene_playlists (name, loop, created_by) VALUES (?, ?, ?)",
  )
    .bind(name, loop === false ? 0 : 1, c.get("user").id)
    .run();
  return c.json({ id: res.meta.last_row_id });
});

app.patch("/:id", requireRole("admin", "operator"), async (c) => {
  const { name, loop } = await c.req.json<{ name?: string; loop?: boolean }>();
  await c.env.DB.prepare(
    "UPDATE scene_playlists SET name = COALESCE(?, name), loop = COALESCE(?, loop), updated_at = datetime('now') WHERE id = ?",
  )
    .bind(name ?? null, loop === undefined ? null : loop ? 1 : 0, Number(c.req.param("id")))
    .run();
  return c.json({ ok: true });
});

app.delete("/:id", requireRole("admin", "operator"), async (c) => {
  await c.env.DB.prepare("DELETE FROM scene_playlists WHERE id = ?")
    .bind(Number(c.req.param("id")))
    .run();
  return c.json({ ok: true });
});

// Replace the full item list (order is the array order).
app.put("/:id/items", requireRole("admin", "operator"), async (c) => {
  const id = Number(c.req.param("id"));
  const items = await c.req.json<Array<{ scene_id: number; dwell_sec?: number }>>();
  if (!Array.isArray(items)) return c.json({ error: "invalid_body" }, 400);
  for (const it of items) {
    if (!Number.isInteger(it.scene_id) || it.scene_id < 1) return c.json({ error: "invalid_scene_id" }, 400);
    if (it.dwell_sec !== undefined && (!Number.isInteger(it.dwell_sec) || it.dwell_sec < 1 || it.dwell_sec > 86_400)) {
      return c.json({ error: "invalid_dwell_sec" }, 400);
    }
  }
  const exists = await c.env.DB.prepare("SELECT id FROM scene_playlists WHERE id = ?").bind(id).first();
  if (!exists) return c.json({ error: "not_found" }, 404);
  await c.env.DB.prepare("DELETE FROM scene_playlist_items WHERE scene_playlist_id = ?")
    .bind(id)
    .run();
  let idx = 0;
  for (const it of items) {
    await c.env.DB.prepare(
      "INSERT INTO scene_playlist_items (scene_playlist_id, scene_id, dwell_sec, order_index) VALUES (?, ?, ?, ?)",
    )
      .bind(id, it.scene_id, it.dwell_sec ?? 15, idx++)
      .run();
  }
  await c.env.DB.prepare("UPDATE scene_playlists SET updated_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
  return c.json({ ok: true, count: items.length });
});

// Migration helper for the transition period. Each legacy playlist item becomes
// an independently published, full-canvas scene, preserving order and dwell.
app.post("/from-playlist/:playlistId", requireRole("admin", "operator"), async (c) => {
  const playlistId = Number(c.req.param("playlistId"));
  const playlist = await c.env.DB.prepare("SELECT id, name, loop FROM playlists WHERE id = ?")
    .bind(playlistId).first<{ id: number; name: string; loop: number }>();
  if (!playlist) return c.json({ error: "playlist_not_found" }, 404);
  const items = await c.env.DB.prepare(
    "SELECT type, url, media_id, duration_sec FROM playlist_items WHERE playlist_id = ? ORDER BY order_index",
  ).bind(playlistId).all<{ type: string; url: string | null; media_id: number | null; duration_sec: number }>();
  const created = await c.env.DB.prepare(
    "INSERT INTO scene_playlists (name, loop, created_by) VALUES (?, ?, ?)",
  ).bind(`${playlist.name} (scenes)`, playlist.loop, c.get("user").id).run();
  const scenePlaylistId = Number(created.meta.last_row_id);

  let order = 0;
  for (const item of items.results) {
    const kind = item.type === "video" ? "video" : item.type === "image" ? "image" : "web";
    const config: Record<string, unknown> = item.media_id ? { media_id: item.media_id } : { url: item.url ?? "" };
    if (kind === "web") config.mode = "embed";
    const scene = await c.env.DB.prepare(
      "INSERT INTO scenes (name, width, height, background, status, created_by) VALUES (?, 1920, 1080, ?, 'draft', ?)",
    ).bind(`${playlist.name} — ${order + 1}`, '{"color":"#000000"}', c.get("user").id).run();
    const sceneId = Number(scene.meta.last_row_id);
    await c.env.DB.prepare(
      "INSERT INTO scene_widgets (scene_id, kind, x, y, width, height, z, visible, locked, config) VALUES (?, ?, 0, 0, 1920, 1080, 0, 1, 0, ?)",
    ).bind(sceneId, kind, JSON.stringify(config)).run();
    const built = await buildSceneSnapshot(c.env, sceneId);
    if (!built) return c.json({ error: "scene_snapshot_failed" }, 500);
    await c.env.DB.prepare(
      "INSERT INTO scene_versions (scene_id, version, snapshot, revision, published_by) VALUES (?, 1, ?, ?, ?)",
    ).bind(sceneId, JSON.stringify(built.snapshot), built.revision, c.get("user").id).run();
    await c.env.DB.prepare("UPDATE scenes SET status = 'published', published_version = 1 WHERE id = ?")
      .bind(sceneId).run();
    await c.env.DB.prepare(
      "INSERT INTO scene_playlist_items (scene_playlist_id, scene_id, dwell_sec, order_index) VALUES (?, ?, ?, ?)",
    ).bind(scenePlaylistId, sceneId, Math.max(1, item.duration_sec || 15), order++).run();
  }
  return c.json({ id: scenePlaylistId, scene_count: order }, 201);
});

export default app;
