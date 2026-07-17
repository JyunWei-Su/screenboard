import type { Env } from "../types";
import type { PlaylistItem, ResolvedPlaylist } from "@screenboard/shared";

interface DeviceRow {
  uuid: string;
  group_id: number | null;
  playlist_id: number | null;
}

interface ScheduleRow {
  playlist_id: number;
  target_type: string;
  target_id: string;
  date_start: string | null;
  date_end: string | null;
  time_start: string | null;
  time_end: string | null;
  weekdays: number;
  priority: number;
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

function scheduleMatches(s: ScheduleRow, now: Date): boolean {
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

// Build a fully resolved playlist (absolute media URLs) for a device to play.
export async function buildResolvedPlaylist(
  env: Env,
  playlistId: number,
): Promise<ResolvedPlaylist | null> {
  const pl = await env.DB.prepare(
    "SELECT id, name, loop FROM playlists WHERE id = ?",
  )
    .bind(playlistId)
    .first<{ id: number; name: string; loop: number }>();
  if (!pl) return null;

  const rows = await env.DB.prepare(
    "SELECT id, type, url, media_id, duration_sec, order_index FROM playlist_items WHERE playlist_id = ? ORDER BY order_index",
  )
    .bind(playlistId)
    .all<{
      id: number;
      type: string;
      url: string | null;
      media_id: number | null;
      duration_sec: number;
      order_index: number;
    }>();

  const base = env.PUBLIC_API_URL.replace(/\/$/, "");
  const items: PlaylistItem[] = rows.results.map((r) => ({
    id: r.id,
    type: r.type as PlaylistItem["type"],
    source: r.media_id
      ? `${base}/api/content/media/${r.media_id}`
      : (r.url ?? ""),
    duration_sec: r.duration_sec,
    order_index: r.order_index,
  }));

  const revision = await shortHash(JSON.stringify(items) + pl.loop);
  return {
    playlist_id: pl.id,
    name: pl.name,
    loop: !!pl.loop,
    items,
    revision,
  };
}
