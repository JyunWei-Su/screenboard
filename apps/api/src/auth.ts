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

// A short, human-typeable one-time enrollment code: 4 uppercase letters
// (I and O omitted so they can't be confused with 1 and 0) followed by 6
// digits, e.g. "ABCD-123456". ~38 bits of entropy — safe as a one-time code
// paired with a short TTL and the enroll rate limit, and easy to read aloud.
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // A-Z without I, O (24 letters)

export function generateEnrollmentCode(): string {
  const rand = new Uint32Array(10);
  crypto.getRandomValues(rand);
  let code = "";
  for (let i = 0; i < 4; i++) code += CODE_LETTERS[rand[i] % CODE_LETTERS.length];
  for (let i = 4; i < 10; i++) code += String(rand[i] % 10);
  return code; // canonical form, no separator
}

// Normalize an entered code before lookup: uppercase and strip anything that is
// not a letter or digit, so "abcd-123456", "ABCD 123456" and "ABCD123456" all
// resolve to the same stored code.
export function normalizeEnrollmentCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
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
