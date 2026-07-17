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
  del: <T>(p: string) => request<T>("DELETE", p),
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
