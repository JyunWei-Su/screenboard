import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { requireAuth, requireRole } from "../auth";
import { buildResolvedScene, buildSceneSnapshot } from "../lib/resolve";
import type { WidgetKind } from "@screenboard/shared";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", requireAuth);

const WIDGET_KINDS: WidgetKind[] = [
  "image",
  "video",
  "web",
  "text",
  "ticker",
  "direction",
  "clock",
];

const MAX_CANVAS = 16_384;
const MAX_WIDGETS = 200;

function isIntIn(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 4_096) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// Validate the wire-level shape before it becomes a published snapshot. Empty
// configs are intentionally allowed while an editor is assembling a draft, but
// any supplied setting must belong to the widget's declared schema.
function validateWidget(widget: {
  kind: string; x?: number; y?: number; width?: number; height?: number; z?: number;
  visible?: boolean; locked?: boolean; config?: Record<string, unknown>;
}): string | null {
  if (!WIDGET_KINDS.includes(widget.kind as WidgetKind)) return "invalid_widget_kind";
  for (const [name, value, min, max] of [
    ["x", widget.x, -MAX_CANVAS, MAX_CANVAS], ["y", widget.y, -MAX_CANVAS, MAX_CANVAS],
    ["width", widget.width, 1, MAX_CANVAS], ["height", widget.height, 1, MAX_CANVAS],
    ["z", widget.z, -10_000, 10_000],
  ] as const) if (value !== undefined && !isIntIn(value, min, max)) return `invalid_${name}`;
  if (widget.visible !== undefined && typeof widget.visible !== "boolean") return "invalid_visible";
  if (widget.locked !== undefined && typeof widget.locked !== "boolean") return "invalid_locked";
  const c = widget.config ?? {};
  if (!c || typeof c !== "object" || Array.isArray(c)) return "invalid_config";
  const media = c.media_id;
  if (media !== undefined && !isIntIn(media, 1, Number.MAX_SAFE_INTEGER)) return "invalid_media_id";
  if (c.url !== undefined && !isHttpUrl(c.url)) return "invalid_url";
  if (c.source_url !== undefined && !isHttpUrl(c.source_url)) return "invalid_source_url";
  if (c.refresh_sec !== undefined && !isIntIn(c.refresh_sec, 0, 86_400)) return "invalid_refresh_sec";
  if (c.font_size !== undefined && !isIntIn(c.font_size, 1, 4_096)) return "invalid_font_size";
  if (c.text !== undefined && (typeof c.text !== "string" || c.text.length > 10_000)) return "invalid_text";
  if (widget.kind === "web" && c.mode !== undefined && !["embed", "proxy", "open"].includes(String(c.mode))) return "invalid_web_mode";
  if (widget.kind === "ticker" && c.direction !== undefined && !["left", "right", "up", "down"].includes(String(c.direction))) return "invalid_ticker_direction";
  if (widget.kind === "direction" && c.entries !== undefined && !Array.isArray(c.entries)) return "invalid_direction_entries";
  if (widget.kind === "clock" && c.format !== undefined && !["12h", "24h"].includes(String(c.format))) return "invalid_clock_format";
  return null;
}

function validBackground(background: unknown): boolean {
  if (!background || typeof background !== "object" || Array.isArray(background)) return false;
  const b = background as Record<string, unknown>;
  return (b.color === undefined || (typeof b.color === "string" && b.color.length <= 64)) &&
    (b.media_id === undefined || isIntIn(b.media_id, 1, Number.MAX_SAFE_INTEGER));
}

// Rows come back with `background`/`config` as JSON text and int booleans; map
// them into the shapes the shared Scene / SceneWidget contract describes.
interface SceneRow {
  id: number;
  name: string;
  width: number;
  height: number;
  background: string;
  status: string;
  published_version: number | null;
  created_at: string;
  updated_at: string;
  widget_count?: number;
}

function parseJson(text: string | null | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function mapScene(r: SceneRow) {
  return {
    id: r.id,
    name: r.name,
    width: r.width,
    height: r.height,
    background: parseJson(r.background),
    status: r.status,
    published_version: r.published_version,
    created_at: r.created_at,
    updated_at: r.updated_at,
    ...(r.widget_count !== undefined ? { widget_count: r.widget_count } : {}),
  };
}

interface WidgetRow {
  id: number;
  scene_id: number;
  kind: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  visible: number;
  locked: number;
  config: string;
}

function mapWidget(r: WidgetRow) {
  return {
    id: r.id,
    scene_id: r.scene_id,
    kind: r.kind,
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
    z: r.z,
    visible: !!r.visible,
    locked: !!r.locked,
    config: parseJson(r.config),
  };
}

// List scenes with a draft widget count.
app.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT s.*, (SELECT COUNT(*) FROM scene_widgets w WHERE w.scene_id = s.id) AS widget_count
     FROM scenes s ORDER BY s.updated_at DESC`,
  ).all<SceneRow>();
  return c.json(rows.results.map(mapScene));
});

// Scene + its draft widgets (ordered by z).
app.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const scene = await c.env.DB.prepare("SELECT * FROM scenes WHERE id = ?")
    .bind(id)
    .first<SceneRow>();
  if (!scene) return c.json({ error: "not_found" }, 404);
  const widgets = await c.env.DB.prepare(
    "SELECT * FROM scene_widgets WHERE scene_id = ? ORDER BY z",
  )
    .bind(id)
    .all<WidgetRow>();
  return c.json({ ...mapScene(scene), widgets: widgets.results.map(mapWidget) });
});

app.post("/", requireRole("admin", "operator"), async (c) => {
  const body = await c.req.json<{
    name: string;
    width?: number;
    height?: number;
    background?: Record<string, unknown>;
  }>();
  if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 200) return c.json({ error: "invalid_name" }, 400);
  if ((body.width !== undefined && !isIntIn(body.width, 1, MAX_CANVAS)) ||
      (body.height !== undefined && !isIntIn(body.height, 1, MAX_CANVAS)) ||
      (body.background !== undefined && !validBackground(body.background))) return c.json({ error: "invalid_canvas" }, 400);
  const res = await c.env.DB.prepare(
    "INSERT INTO scenes (name, width, height, background, created_by) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(
      body.name,
      body.width ?? 1920,
      body.height ?? 1080,
      JSON.stringify(body.background ?? { color: "#000000" }),
      c.get("user").id,
    )
    .run();
  return c.json({ id: res.meta.last_row_id });
});

app.patch("/:id", requireRole("admin", "operator"), async (c) => {
  const body = await c.req.json<{
    name?: string;
    width?: number;
    height?: number;
    background?: Record<string, unknown>;
  }>();
  if ((body.name !== undefined && (typeof body.name !== "string" || !body.name.trim() || body.name.length > 200)) ||
      (body.width !== undefined && !isIntIn(body.width, 1, MAX_CANVAS)) ||
      (body.height !== undefined && !isIntIn(body.height, 1, MAX_CANVAS)) ||
      (body.background !== undefined && !validBackground(body.background))) return c.json({ error: "invalid_scene" }, 400);
  await c.env.DB.prepare(
    `UPDATE scenes SET name = COALESCE(?, name), width = COALESCE(?, width),
     height = COALESCE(?, height), background = COALESCE(?, background),
     updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(
      body.name ?? null,
      body.width ?? null,
      body.height ?? null,
      body.background === undefined ? null : JSON.stringify(body.background),
      Number(c.req.param("id")),
    )
    .run();
  return c.json({ ok: true });
});

app.delete("/:id", requireRole("admin", "operator"), async (c) => {
  // FK cascade removes scene_widgets + scene_versions; schedules pointing here
  // cascade too, device.scene_id references are set NULL (see migration 0008).
  await c.env.DB.prepare("DELETE FROM scenes WHERE id = ?")
    .bind(Number(c.req.param("id")))
    .run();
  return c.json({ ok: true });
});

// Deep-copy a scene (canvas + widgets) into a brand-new draft.
app.post("/:id/duplicate", requireRole("admin", "operator"), async (c) => {
  const id = Number(c.req.param("id"));
  const scene = await c.env.DB.prepare(
    "SELECT name, width, height, background FROM scenes WHERE id = ?",
  )
    .bind(id)
    .first<{ name: string; width: number; height: number; background: string }>();
  if (!scene) return c.json({ error: "not_found" }, 404);

  const res = await c.env.DB.prepare(
    "INSERT INTO scenes (name, width, height, background, status, created_by) VALUES (?, ?, ?, ?, 'draft', ?)",
  )
    .bind(`${scene.name} (copy)`, scene.width, scene.height, scene.background, c.get("user").id)
    .run();
  const newId = res.meta.last_row_id;

  const widgets = await c.env.DB.prepare(
    "SELECT kind, x, y, width, height, z, visible, locked, config FROM scene_widgets WHERE scene_id = ? ORDER BY z",
  )
    .bind(id)
    .all<WidgetRow>();
  for (const w of widgets.results) {
    await c.env.DB.prepare(
      "INSERT INTO scene_widgets (scene_id, kind, x, y, width, height, z, visible, locked, config) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(newId, w.kind, w.x, w.y, w.width, w.height, w.z, w.visible, w.locked, w.config)
      .run();
  }
  return c.json({ id: newId });
});

// Replace the full draft widget set. z comes from an explicit `z` or, failing
// that, the array order. Mirrors playlists' PUT /:id/items.
app.put("/:id/widgets", requireRole("admin", "operator"), async (c) => {
  const id = Number(c.req.param("id"));
  const scene = await c.env.DB.prepare("SELECT id FROM scenes WHERE id = ?")
    .bind(id)
    .first<{ id: number }>();
  if (!scene) return c.json({ error: "not_found" }, 404);

  const widgets = await c.req.json<
    Array<{
      kind: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      z?: number;
      visible?: boolean;
      locked?: boolean;
      // NOTE: `web` widgets may carry a { url, mode: "proxy" } config. We only
      // STORE it here — the API never fetches remote URLs on a widget's behalf.
      // Proxying is the agent's job, gated by a domain allowlist that blocks
      // internal/localhost/private IPs. Do not add URL-fetching here.
      config?: Record<string, unknown>;
    }>
  >();
  if (!Array.isArray(widgets) || widgets.length > MAX_WIDGETS) return c.json({ error: "invalid_body" }, 400);
  for (const w of widgets) {
    const error = validateWidget(w);
    if (error) return c.json({ error, kind: w.kind }, 400);
  }

  await c.env.DB.prepare("DELETE FROM scene_widgets WHERE scene_id = ?").bind(id).run();
  let idx = 0;
  for (const w of widgets) {
    await c.env.DB.prepare(
      `INSERT INTO scene_widgets (scene_id, kind, x, y, width, height, z, visible, locked, config)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        w.kind,
        w.x ?? 0,
        w.y ?? 0,
        w.width ?? 320,
        w.height ?? 240,
        w.z ?? idx,
        w.visible === false ? 0 : 1,
        w.locked ? 1 : 0,
        JSON.stringify(w.config ?? {}),
      )
      .run();
    idx++;
  }
  await c.env.DB.prepare("UPDATE scenes SET updated_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
  return c.json({ ok: true, count: widgets.length });
});

// Snapshot the current draft into an immutable scene_versions row with an
// incrementing version (per scene, from 1), then mark the scene published.
app.post("/:id/publish", requireRole("admin", "operator"), async (c) => {
  const id = Number(c.req.param("id"));
  const built = await buildSceneSnapshot(c.env, id);
  if (!built) return c.json({ error: "not_found" }, 404);

  // Calculate the next version inside the INSERT. This avoids the former
  // read-then-write race when two operators publish the same draft together.
  await c.env.DB.prepare(
    `INSERT INTO scene_versions (scene_id, version, snapshot, revision, published_by)
     SELECT ?, COALESCE(MAX(version), 0) + 1, ?, ?, ? FROM scene_versions WHERE scene_id = ?`,
  )
    .bind(id, JSON.stringify(built.snapshot), built.revision, c.get("user").id, id)
    .run();

  const current = await c.env.DB.prepare(
    "SELECT MAX(version) AS v FROM scene_versions WHERE scene_id = ?",
  ).bind(id).first<{ v: number }>();
  const version = current?.v;
  if (!version) return c.json({ error: "publish_failed" }, 500);

  await c.env.DB.prepare(
    "UPDATE scenes SET status = 'published', published_version = ?, updated_at = datetime('now') WHERE id = ?",
  )
    .bind(version, id)
    .run();

  return c.json({ ok: true, version, revision: built.revision });
});

// List published versions (newest first). Snapshots are omitted for brevity.
app.get("/:id/versions", async (c) => {
  const id = Number(c.req.param("id"));
  const rows = await c.env.DB.prepare(
    `SELECT id, scene_id, version, revision, published_by, created_at
     FROM scene_versions WHERE scene_id = ? ORDER BY version DESC`,
  )
    .bind(id)
    .all();
  return c.json(rows.results);
});

// Point published_version back at an existing version (the snapshot is NOT
// mutated). With ?restore_draft=true the snapshot is also copied back into the
// editable draft widgets + canvas.
app.post("/:id/rollback/:version", requireRole("admin", "operator"), async (c) => {
  const id = Number(c.req.param("id"));
  const version = Number(c.req.param("version"));
  const row = await c.env.DB.prepare(
    "SELECT snapshot FROM scene_versions WHERE scene_id = ? AND version = ?",
  )
    .bind(id, version)
    .first<{ snapshot: string }>();
  if (!row) return c.json({ error: "version_not_found" }, 404);

  await c.env.DB.prepare(
    "UPDATE scenes SET published_version = ?, status = 'published', updated_at = datetime('now') WHERE id = ?",
  )
    .bind(version, id)
    .run();

  if (c.req.query("restore_draft") === "true") {
    let snap: {
      width?: number;
      height?: number;
      background?: Record<string, unknown>;
      widgets?: Array<{
        kind: string;
        x: number;
        y: number;
        width: number;
        height: number;
        z: number;
        visible: number | boolean;
        locked: number | boolean;
        config: Record<string, unknown>;
      }>;
    };
    try {
      snap = JSON.parse(row.snapshot);
    } catch {
      return c.json({ error: "corrupt_snapshot" }, 500);
    }
    await c.env.DB.prepare(
      `UPDATE scenes SET width = COALESCE(?, width), height = COALESCE(?, height),
       background = COALESCE(?, background), updated_at = datetime('now') WHERE id = ?`,
    )
      .bind(
        snap.width ?? null,
        snap.height ?? null,
        snap.background === undefined ? null : JSON.stringify(snap.background),
        id,
      )
      .run();
    await c.env.DB.prepare("DELETE FROM scene_widgets WHERE scene_id = ?").bind(id).run();
    for (const w of snap.widgets ?? []) {
      await c.env.DB.prepare(
        `INSERT INTO scene_widgets (scene_id, kind, x, y, width, height, z, visible, locked, config)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          w.kind,
          w.x,
          w.y,
          w.width,
          w.height,
          w.z,
          w.visible ? 1 : 0,
          w.locked ? 1 : 0,
          JSON.stringify(w.config ?? {}),
        )
        .run();
    }
  }
  return c.json({ ok: true, published_version: version });
});

// Draft preview as a ResolvedScene (version=null). Admin auth only.
app.get("/:id/resolved", async (c) => {
  const resolved = await buildResolvedScene(c.env, Number(c.req.param("id")));
  if (!resolved) return c.json({ error: "not_found" }, 404);
  return c.json(resolved);
});

// A specific published version as a ResolvedScene.
app.get("/:id/resolved/:version", async (c) => {
  const resolved = await buildResolvedScene(
    c.env,
    Number(c.req.param("id")),
    Number(c.req.param("version")),
  );
  if (!resolved) return c.json({ error: "not_found" }, 404);
  return c.json(resolved);
});

export default app;
