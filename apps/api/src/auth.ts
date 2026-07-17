import { sign, verify } from "hono/jwt";
import type { MiddlewareHandler } from "hono";
import type { Role } from "@screenboard/shared";
import type { Env, Variables, AuthUser } from "./types";

const ADMIN_TTL_SECONDS = 12 * 60 * 60; // 12h
const DEVICE_TTL_SECONDS = 60 * 60; // 1h access token

type HonoEnv = { Bindings: Env; Variables: Variables };

// ---- Admin session tokens ----

export async function signAdminToken(
  env: Env,
  user: { id: number; name: string; role: Role },
): Promise<{ token: string; jti: string; exp: number }> {
  const jti = crypto.randomUUID();
  const exp = Math.floor(Date.now() / 1000) + ADMIN_TTL_SECONDS;
  const token = await sign(
    { sub: user.id, name: user.name, role: user.role, jti, exp },
    env.JWT_SECRET,
    "HS256",
  );
  return { token, jti, exp };
}

export const requireAuth: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return c.json({ error: "unauthorized" }, 401);
  try {
    const payload = (await verify(token, c.env.JWT_SECRET, "HS256")) as Record<string, unknown>;
    const jti = String(payload.jti);
    const row = await c.env.DB.prepare(
      "SELECT revoked FROM sessions WHERE token_id = ?",
    )
      .bind(jti)
      .first<{ revoked: number }>();
    if (!row || row.revoked) return c.json({ error: "session_revoked" }, 401);
    const user: AuthUser = {
      id: Number(payload.sub),
      name: String(payload.name),
      role: payload.role as Role,
      jti,
    };
    c.set("user", user);
    await next();
  } catch {
    return c.json({ error: "invalid_token" }, 401);
  }
};

// Lightweight admin-token check (no session lookup) — for media/screenshot
// content endpoints that accept a token via query string for <img>/<video>.
export async function verifyAdminToken(
  env: Env,
  token: string,
): Promise<boolean> {
  try {
    await verify(token, env.JWT_SECRET, "HS256");
    return true;
  } catch {
    return false;
  }
}

export function requireRole(...roles: Role[]): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const user = c.get("user");
    if (!user || !roles.includes(user.role)) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  };
}

// ---- Device tokens ----

export async function signDeviceToken(env: Env, uuid: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + DEVICE_TTL_SECONDS;
  return sign({ sub: uuid, kind: "device", exp }, env.DEVICE_JWT_SECRET, "HS256");
}

export async function verifyDeviceToken(env: Env, token: string): Promise<string | null> {
  try {
    const payload = (await verify(token, env.DEVICE_JWT_SECRET, "HS256")) as Record<string, unknown>;
    if (payload.kind !== "device") return null;
    return String(payload.sub);
  } catch {
    return null;
  }
}

// Middleware for device-authenticated endpoints (agent). Accepts token via
// Authorization: Bearer or ?token= (used for WebSocket upgrade).
export const deviceAuth: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : c.req.query("token") || "";
  const uuid = token ? await verifyDeviceToken(c.env, token) : null;
  if (!uuid) return c.json({ error: "unauthorized" }, 401);
  c.set("deviceUuid", uuid);
  await next();
};

// ---- Refresh tokens (opaque, stored hashed) ----

export function generateRefreshToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A one-time, 24-hour enrollment token. 128 bits of randomness remains
// impractical to guess while its base64url representation is only 22 chars.
export function generateEnrollmentToken(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  let binary = "";
  for (const byte of buf) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
