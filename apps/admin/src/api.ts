import type {
  Scene,
  SceneWidget,
  SceneBackground,
  ResolvedScene,
} from "@screenboard/shared";

const API = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

const TOKEN_KEY = "sb_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string) {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export function apiBase() {
  return API;
}

// Build an authenticated URL for <img>/<video>/download (token in query string).
export function contentUrl(path: string): string {
  const t = getToken();
  const sep = path.includes("?") ? "&" : "?";
  return `${API}${path}${sep}token=${t ?? ""}`;
}

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown, raw?: BodyInit): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (raw !== undefined) {
    payload = raw;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, { method, headers, body: payload });
  if (res.status === 401) {
    clearToken();
    if (!location.pathname.startsWith("/login")) location.href = "/login";
    throw new ApiError(401, "unauthorized");
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error || res.statusText);
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b?: unknown) => request<T>("POST", p, b),
  patch: <T>(p: string, b?: unknown) => request<T>("PATCH", p, b),
  put: <T>(p: string, b?: unknown) => request<T>("PUT", p, b),
  del: <T>(p: string, b?: unknown) => request<T>("DELETE", p, b),
  // raw binary upload (media / OTA) with an explicit Content-Type
  uploadWithType: <T>(p: string, contentType: string, data: ArrayBuffer): Promise<T> => {
    const token = getToken();
    return fetch(`${API}${p}`, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: data,
    }).then(async (r) => {
      const t = await r.text();
      const d = t ? JSON.parse(t) : null;
      if (!r.ok) throw new ApiError(r.status, d?.error || r.statusText);
      return d as T;
    });
  },
};

export { ApiError };

// ---- Scene endpoints ----
// Typed wrappers around the scene playback API. Response shapes are the frozen
// `@screenboard/shared` contract; a few list/detail envelopes are defined here.

/** A scene row in the list view (scene meta + a widget count). */
export interface SceneSummary extends Scene {
  widget_count?: number;
}

/** The widget payload sent when saving a draft (server assigns id/scene_id). */
export type WidgetInput = Omit<SceneWidget, "id" | "scene_id">;

/**
 * `GET /api/scenes/:id`. Tolerant of either a flat (`Scene & { widgets }`) or a
 * nested (`{ scene, widgets }`) envelope — normalize with `normalizeSceneDetail`.
 */
export type SceneDetailResponse = Scene & {
  widgets?: SceneWidget[];
  scene?: Scene;
};

export interface SceneVersionRow {
  version: number;
  revision?: string;
  created_at?: string;
  note?: string | null;
  published_by?: number | string | null;
}

export const scenesApi = {
  list: () => api.get<SceneSummary[]>("/api/scenes"),
  create: (body: { name: string; width?: number; height?: number; background?: SceneBackground }) =>
    api.post<{ id: number }>("/api/scenes", body),
  get: (id: number | string) => api.get<SceneDetailResponse>(`/api/scenes/${id}`),
  patch: (
    id: number | string,
    body: Partial<Pick<Scene, "name" | "width" | "height" | "background" | "status">>,
  ) => api.patch<{ ok: boolean }>(`/api/scenes/${id}`, body),
  remove: (id: number | string) => api.del(`/api/scenes/${id}`),
  duplicate: (id: number | string) => api.post<{ id: number }>(`/api/scenes/${id}/duplicate`),
  saveWidgets: (id: number | string, widgets: WidgetInput[]) =>
    api.put<{ ok: boolean; count: number }>(`/api/scenes/${id}/widgets`, widgets),
  publish: (id: number | string) =>
    api.post<{ ok: boolean; version: number; revision: string }>(`/api/scenes/${id}/publish`),
  versions: (id: number | string) => api.get<SceneVersionRow[]>(`/api/scenes/${id}/versions`),
  // restore_draft=true also copies the snapshot back into the editable draft so
  // the editor reflects the rolled-back content after a reload.
  rollback: (id: number | string, version: number) =>
    api.post<{ ok: boolean; published_version: number }>(
      `/api/scenes/${id}/rollback/${version}?restore_draft=true`,
    ),
  resolved: (id: number | string) => api.get<ResolvedScene>(`/api/scenes/${id}/resolved`),
};

// ---- Scene playlist endpoints ----

export interface ScenePlaylistSummary {
  id: number;
  name: string;
  loop: number | boolean;
  item_count?: number;
  updated_at?: string;
}

export interface ScenePlaylistItemRow {
  scene_id: number;
  dwell_sec: number;
  order_index?: number;
  scene_name?: string;
  published_version?: number | null;
}

export interface ScenePlaylistDetail {
  id: number;
  name: string;
  loop: number | boolean;
  items: ScenePlaylistItemRow[];
}

export interface ScenePlaylistItemInput {
  scene_id: number;
  dwell_sec: number;
}

export const scenePlaylistsApi = {
  list: () => api.get<ScenePlaylistSummary[]>("/api/scene-playlists"),
  create: (body: { name: string }) => api.post<{ id: number }>("/api/scene-playlists", body),
  get: (id: number | string) => api.get<ScenePlaylistDetail>(`/api/scene-playlists/${id}`),
  patch: (id: number | string, body: { name?: string; loop?: boolean }) =>
    api.patch<{ ok: boolean }>(`/api/scene-playlists/${id}`, body),
  remove: (id: number | string) => api.del(`/api/scene-playlists/${id}`),
  saveItems: (id: number | string, items: ScenePlaylistItemInput[]) =>
    api.put<{ ok: boolean; count: number }>(`/api/scene-playlists/${id}/items`, items),
};
