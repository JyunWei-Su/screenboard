import type { Env } from "../types";
import type {
  ResolvedScene,
  ResolvedSceneWidget,
  ResolvedScenePlaylist,
  ResolvedTarget,
  WidgetConfig,
  WidgetKind,
} from "@screenboard/shared";

interface DeviceRow {
  uuid: string;
  group_id: number | null;
  playlist_id: number | null;
}

// The subset of schedule columns used to decide whether a schedule is active
// right now. Shared by both the legacy playlist path and the scene path.
interface ScheduleWindow {
  date_start: string | null;
  date_end: string | null;
  time_start: string | null;
  time_end: string | null;
  weekdays: number;
}

interface ScheduleRow extends ScheduleWindow {
  playlist_id: number;
  target_type: string;
  target_id: string;
  priority: number;
}

// Full schedule row including the new multi-source targeting columns.
interface ScheduleSourceRow extends ScheduleWindow {
  source_type: string; // scene | scene_playlist
  scene_id: number | null;
  scene_playlist_id: number | null;
  target_type: string;
  target_id: string;
  priority: number;
}

// A device's own default source assignment (fallback when no schedule matches).
interface TargetDeviceRow {
  uuid: string;
  group_id: number | null;
  source_type: string; // scene | scene_playlist
  scene_id: number | null;
  scene_playlist_id: number | null;
}

// Collect a group's ancestor chain (including itself) so a schedule on a parent
// group applies to devices in child groups.
async function ancestorGroupIds(env: Env, groupId: number | null): Promise<Set<string>> {
  const ids = new Set<string>();
  if (groupId == null) return ids;
  const rows = await env.DB.prepare("SELECT id, parent_id FROM groups").all<{
    id: number;
    parent_id: number | null;
  }>();
  const parentOf = new Map<number, number | null>();
  for (const r of rows.results) parentOf.set(r.id, r.parent_id);
  let cur: number | null = groupId;
  while (cur != null && !ids.has(String(cur))) {
    ids.add(String(cur));
    cur = parentOf.get(cur) ?? null;
  }
  return ids;
}

function scheduleMatches(s: ScheduleWindow, now: Date): boolean {
  const day = now.getUTCDay(); // 0=Sun..6=Sat
  if (((s.weekdays >> day) & 1) === 0) return false;

  const dateStr = now.toISOString().slice(0, 10);
  if (s.date_start && dateStr < s.date_start) return false;
  if (s.date_end && dateStr > s.date_end) return false;

  const hhmm = now.toISOString().slice(11, 16);
  if (s.time_start && s.time_end) {
    if (s.time_start <= s.time_end) {
      if (hhmm < s.time_start || hhmm >= s.time_end) return false;
    } else {
      // overnight window (e.g. 22:00 -> 06:00)
      if (hhmm < s.time_start && hhmm >= s.time_end) return false;
    }
  }
  return true;
}

// Determine which playlist a device should currently play.
export async function resolvePlaylistId(
  env: Env,
  device: DeviceRow,
  now = new Date(),
): Promise<number | null> {
  const groupIds = await ancestorGroupIds(env, device.group_id);
  const schedules = await env.DB.prepare("SELECT * FROM schedules").all<ScheduleRow>();

  let best: { playlist_id: number; priority: number; specific: number } | null = null;
  for (const s of schedules.results) {
    const applies =
      (s.target_type === "device" && s.target_id === device.uuid) ||
      (s.target_type === "group" && groupIds.has(s.target_id));
    if (!applies) continue;
    if (!scheduleMatches(s, now)) continue;
    const specific = s.target_type === "device" ? 1 : 0;
    if (
      !best ||
      s.priority > best.priority ||
      (s.priority === best.priority && specific > best.specific)
    ) {
      best = { playlist_id: s.playlist_id, priority: s.priority, specific };
    }
  }
  if (best) return best.playlist_id;
  return device.playlist_id; // fall back to manually assigned default
}

async function shortHash(input: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(d)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---- Scenes ----

// A widget as stored/snapshotted, before media_id references are resolved into
// absolute source URLs. `visible`/`locked` may be SQLite ints (draft) or JSON
// booleans (snapshot); both are handled with truthiness.
interface RawWidget {
  id: number;
  kind: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  visible: number | boolean;
  locked: number | boolean;
  config: Record<string, unknown>;
}

// The immutable, resolution-independent form persisted in scene_versions.snapshot
// and rebuilt on the fly from the draft widgets. Holds canvas + widgets only —
// media_id references are resolved to absolute URLs later, per request.
interface SceneSnapshot {
  name: string;
  width: number;
  height: number;
  background: { color?: string; media_id?: number };
  widgets: RawWidget[];
}

function mediaUrl(base: string, mediaId: number): string {
  return `${base}/api/content/media/${mediaId}`;
}

// Content hash for cache comparison. Deliberately excludes widget ids (which
// differ between draft rows and snapshot copies) and the scene name (a rename
// should not force players to reload). Widgets are sorted by z so ordering is
// deterministic regardless of how they were read.
async function hashScene(snapshot: SceneSnapshot): Promise<string> {
  const widgets = [...snapshot.widgets]
    .sort((a, b) => a.z - b.z)
    .map((w) => ({
      kind: w.kind,
      x: w.x,
      y: w.y,
      width: w.width,
      height: w.height,
      z: w.z,
      visible: !!w.visible,
      locked: !!w.locked,
      config: w.config,
    }));
  return shortHash(
    JSON.stringify({
      width: snapshot.width,
      height: snapshot.height,
      background: snapshot.background,
      widgets,
    }),
  );
}

// Build a snapshot of a scene's current DRAFT (canvas + widgets) plus its
// content hash. Used both by publish (to persist an immutable version) and by
// the draft-preview resolver so an unchanged draft hashes to the same revision
// as the version it would publish to.
export async function buildSceneSnapshot(
  env: Env,
  sceneId: number,
): Promise<{ snapshot: SceneSnapshot; revision: string } | null> {
  const scene = await env.DB.prepare(
    "SELECT name, width, height, background FROM scenes WHERE id = ?",
  )
    .bind(sceneId)
    .first<{ name: string; width: number; height: number; background: string }>();
  if (!scene) return null;

  const rows = await env.DB.prepare(
    "SELECT id, kind, x, y, width, height, z, visible, locked, config FROM scene_widgets WHERE scene_id = ? ORDER BY z",
  )
    .bind(sceneId)
    .all<{
      id: number;
      kind: string;
      x: number;
      y: number;
      width: number;
      height: number;
      z: number;
      visible: number;
      locked: number;
      config: string;
    }>();

  const widgets: RawWidget[] = rows.results.map((r) => ({
    id: r.id,
    kind: r.kind,
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
    z: r.z,
    visible: !!r.visible,
    locked: !!r.locked,
    config: safeParse(r.config),
  }));

  const snapshot: SceneSnapshot = {
    name: scene.name,
    width: scene.width,
    height: scene.height,
    background: safeParse(scene.background) as SceneSnapshot["background"],
    widgets,
  };
  const revision = await hashScene(snapshot);
  return { snapshot, revision };
}

function safeParse(text: string | null | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// Resolve a snapshot into the client-facing ResolvedScene: media_id references
// become absolute source URLs, hidden widgets are dropped, and widgets are
// ordered by z ascending.
function resolveSnapshot(
  base: string,
  sceneId: number,
  snapshot: SceneSnapshot,
  version: number | null,
  revision: string,
): ResolvedScene {
  const background: { color?: string; source?: string } = {};
  if (snapshot.background?.color) background.color = snapshot.background.color;
  if (snapshot.background?.media_id) {
    background.source = mediaUrl(base, snapshot.background.media_id);
  }

  const widgets: ResolvedSceneWidget[] = [...snapshot.widgets]
    .filter((w) => !!w.visible)
    .sort((a, b) => a.z - b.z)
    .map((w) => {
      const config = { ...(w.config as object) } as WidgetConfig & { source?: string };
      const mediaId = (w.config as { media_id?: number }).media_id;
      if (mediaId) config.source = mediaUrl(base, mediaId);
      if (w.kind === "carousel" && Array.isArray((config as { items?: unknown[] }).items)) {
        (config as { items: Array<Record<string, unknown>> }).items = (config as { items: Array<Record<string, unknown>> }).items.map((item) => ({
          ...item,
          ...(typeof item.media_id === "number" ? { source: mediaUrl(base, item.media_id) } : {}),
        }));
      }
      return {
        id: w.id,
        kind: w.kind as WidgetKind,
        x: w.x,
        y: w.y,
        width: w.width,
        height: w.height,
        z: w.z,
        config,
      };
    });

  return {
    scene_id: sceneId,
    name: snapshot.name,
    width: snapshot.width,
    height: snapshot.height,
    background,
    widgets,
    version,
    revision,
  };
}

// Build a fully resolved scene for a client. With `version` set, reads the
// immutable published snapshot; otherwise resolves the live draft (preview).
export async function buildResolvedScene(
  env: Env,
  sceneId: number,
  version?: number | null,
): Promise<ResolvedScene | null> {
  const base = env.PUBLIC_API_URL.replace(/\/$/, "");
  if (version != null) {
    const row = await env.DB.prepare(
      "SELECT snapshot, revision FROM scene_versions WHERE scene_id = ? AND version = ?",
    )
      .bind(sceneId, version)
      .first<{ snapshot: string; revision: string }>();
    if (!row) return null;
    let snapshot: SceneSnapshot;
    try {
      snapshot = JSON.parse(row.snapshot) as SceneSnapshot;
    } catch {
      return null;
    }
    return resolveSnapshot(base, sceneId, snapshot, version, row.revision);
  }
  const built = await buildSceneSnapshot(env, sceneId);
  if (!built) return null;
  return resolveSnapshot(base, sceneId, built.snapshot, null, built.revision);
}

// Build a resolved scene playlist. Each entry resolves to the scene's currently
// PUBLISHED version; scenes that have never been published are skipped (they
// cannot play).
export async function buildResolvedScenePlaylist(
  env: Env,
  id: number,
): Promise<ResolvedScenePlaylist | null> {
  const pl = await env.DB.prepare(
    "SELECT id, name, loop FROM scene_playlists WHERE id = ?",
  )
    .bind(id)
    .first<{ id: number; name: string; loop: number }>();
  if (!pl) return null;

  const rows = await env.DB.prepare(
    `SELECT i.scene_id, i.dwell_sec, s.published_version
     FROM scene_playlist_items i
     JOIN scenes s ON s.id = i.scene_id
     WHERE i.scene_playlist_id = ?
     ORDER BY i.order_index`,
  )
    .bind(id)
    .all<{ scene_id: number; dwell_sec: number; published_version: number | null }>();

  const scenes: ResolvedScenePlaylist["scenes"] = [];
  for (const r of rows.results) {
    if (r.published_version == null) continue; // unpublished scenes cannot play
    const scene = await buildResolvedScene(env, r.scene_id, r.published_version);
    if (scene) scenes.push({ dwell_sec: r.dwell_sec, scene });
  }

  const revision = await shortHash(
    JSON.stringify(scenes.map((s) => ({ d: s.dwell_sec, r: s.scene.revision }))) + pl.loop,
  );
  return {
    scene_playlist_id: pl.id,
    name: pl.name,
    loop: !!pl.loop,
    scenes,
    revision,
  };
}

// Resolve the single effective playback target for a device right now. Reuses
// the schedule matching + ancestor-group + priority logic (a matching schedule
// wins over the device's own default assignment). Scenes resolve to their
// PUBLISHED version only; a never-published scene yields no source.
export async function resolveTarget(
  env: Env,
  device: TargetDeviceRow,
  now = new Date(),
): Promise<ResolvedTarget> {
  const groupIds = await ancestorGroupIds(env, device.group_id);
  const schedules = await env.DB.prepare("SELECT * FROM schedules").all<ScheduleSourceRow>();

  let best:
    | {
        source_type: string;
        scene_id: number | null;
        scene_playlist_id: number | null;
        priority: number;
        specific: number;
      }
    | null = null;
  for (const s of schedules.results) {
    const applies =
      (s.target_type === "device" && s.target_id === device.uuid) ||
      (s.target_type === "group" && groupIds.has(s.target_id));
    if (!applies) continue;
    if (!scheduleMatches(s, now)) continue;
    const specific = s.target_type === "device" ? 1 : 0;
    if (
      !best ||
      s.priority > best.priority ||
      (s.priority === best.priority && specific > best.specific)
    ) {
      best = {
        source_type: s.source_type,
        scene_id: s.scene_id,
        scene_playlist_id: s.scene_playlist_id,
        priority: s.priority,
        specific,
      };
    }
  }

  const src = best ?? {
    source_type: device.source_type,
    scene_id: device.scene_id,
    scene_playlist_id: device.scene_playlist_id,
  };

  if (src.source_type === "scene") {
    if (src.scene_id == null) return { kind: "none" };
    const scene = await env.DB.prepare("SELECT published_version FROM scenes WHERE id = ?")
      .bind(src.scene_id)
      .first<{ published_version: number | null }>();
    if (!scene || scene.published_version == null) return { kind: "none" };
    const resolved = await buildResolvedScene(env, src.scene_id, scene.published_version);
    return resolved ? { kind: "scene", scene: resolved } : { kind: "none" };
  }

  if (src.source_type === "scene_playlist") {
    if (src.scene_playlist_id == null) return { kind: "none" };
    const resolved = await buildResolvedScenePlaylist(env, src.scene_playlist_id);
    return resolved ? { kind: "scene_playlist", scene_playlist: resolved } : { kind: "none" };
  }

  return { kind: "none" };
}
