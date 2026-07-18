import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { requireAuth, requireRole } from "../auth";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", requireAuth);

app.get("/", async (c) => {
  // LEFT JOINs so schedules of any source_type are listed (a schedule sets
  // exactly one of playlist_id / scene_id / scene_playlist_id).
  const rows = await c.env.DB.prepare(
    `SELECT s.*, p.name AS playlist_name, sc.name AS scene_name, spl.name AS scene_playlist_name
     FROM schedules s
     LEFT JOIN playlists p ON p.id = s.playlist_id
     LEFT JOIN scenes sc ON sc.id = s.scene_id
     LEFT JOIN scene_playlists spl ON spl.id = s.scene_playlist_id
     ORDER BY s.priority DESC, s.id`,
  ).all();
  return c.json(rows.results);
});

type SourceType = "playlist" | "scene" | "scene_playlist";

app.post("/", requireRole("admin", "operator"), async (c) => {
  const b = await c.req.json<{
    source_type?: SourceType;
    playlist_id?: number | null;
    scene_id?: number | null;
    scene_playlist_id?: number | null;
    target_type: "device" | "group";
    target_id: string;
    date_start?: string | null;
    date_end?: string | null;
    time_start?: string | null;
    time_end?: string | null;
    weekdays?: number;
    priority?: number;
  }>();
  if (!b.target_type || !b.target_id) {
    return c.json({ error: "missing_fields" }, 400);
  }
  // Default to legacy playlist targeting so old clients keep working.
  const sourceType: SourceType = b.source_type ?? "playlist";
  // Exactly one source column is set per row.
  let playlistId: number | null = null;
  let sceneId: number | null = null;
  let scenePlaylistId: number | null = null;
  if (sourceType === "playlist") {
    if (!b.playlist_id) return c.json({ error: "missing_playlist_id" }, 400);
    playlistId = b.playlist_id;
  } else if (sourceType === "scene") {
    if (!b.scene_id) return c.json({ error: "missing_scene_id" }, 400);
    sceneId = b.scene_id;
  } else if (sourceType === "scene_playlist") {
    if (!b.scene_playlist_id) return c.json({ error: "missing_scene_playlist_id" }, 400);
    scenePlaylistId = b.scene_playlist_id;
  } else {
    return c.json({ error: "invalid_source_type" }, 400);
  }
  const res = await c.env.DB.prepare(
    `INSERT INTO schedules (source_type, playlist_id, scene_id, scene_playlist_id, target_type, target_id, date_start, date_end, time_start, time_end, weekdays, priority)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      sourceType,
      playlistId,
      sceneId,
      scenePlaylistId,
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
