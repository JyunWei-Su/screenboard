import { Hono } from "hono";
import type { Env, Variables } from "../types";
import {
  generateRefreshToken,
  normalizeEnrollmentCode,
  sha256Hex,
  signDeviceToken,
} from "../auth";
import type { EnrollRequest, EnrollResponse } from "@screenboard/shared";
import { provisionRemoteAccess } from "../lib/cloudflareTunnel";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Basic per-IP rate limit for the public enrollment endpoint. Best-effort and
// per-isolate (no shared state), which is enough to blunt brute-force bursts
// against the short enrollment codes without blocking a normal site rollout.
const ENROLL_WINDOW_MS = 60_000;
const ENROLL_MAX_PER_WINDOW = 30;
const enrollHits = new Map<string, number[]>();

function enrollRateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (enrollHits.get(ip) ?? []).filter((t) => now - t < ENROLL_WINDOW_MS);
  recent.push(now);
  enrollHits.set(ip, recent);
  // Opportunistic cleanup so an attacker rotating IPs cannot grow the map without bound.
  if (enrollHits.size > 5000) {
    for (const [key, times] of enrollHits) {
      if (times.every((t) => now - t >= ENROLL_WINDOW_MS)) enrollHits.delete(key);
    }
  }
  return recent.length > ENROLL_MAX_PER_WINDOW;
}

// First-boot auto registration. Consumes a one-time enrollment code, creates the
// device, and returns access + refresh tokens plus the WebSocket command URL.
app.post("/enroll", async (c) => {
  const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown";
  if (enrollRateLimited(ip)) return c.json({ error: "rate_limited" }, 429);

  const body = await c.req.json<EnrollRequest>();
  if (!body.enrollment_token || !body.info) {
    return c.json({ error: "missing_fields" }, 400);
  }

  const code = normalizeEnrollmentCode(body.enrollment_token);
  const tok = await c.env.DB.prepare(
    "SELECT token, group_id, expires_at, used_by_uuid FROM enrollment_tokens WHERE token = ?",
  )
    .bind(code)
    .first<{ token: string; group_id: number | null; expires_at: string; used_by_uuid: string | null }>();

  if (!tok) return c.json({ error: "invalid_token" }, 401);
  if (tok.used_by_uuid) return c.json({ error: "token_used" }, 409);
  // SQLite datetime('now', …) is UTC formatted as "YYYY-MM-DD HH:MM:SS" (no
  // zone). Parsing that non-ISO form with new Date() treats it as LOCAL time, so
  // on a non-UTC runtime every short-lived code reads as already expired. Force
  // a UTC interpretation before comparing.
  const expiresAtMs = new Date(`${tok.expires_at.replace(" ", "T")}Z`).getTime();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) {
    return c.json({ error: "token_expired" }, 410);
  }

  const uuid = crypto.randomUUID();
  const info = body.info;
  const display = JSON.stringify(
    body.display ?? { kiosk: true, zoom: 1, rotate: 0, screen: 0 },
  );
  const refresh = generateRefreshToken();
  const refreshHash = await sha256Hex(refresh);

  await c.env.DB.prepare(
    `INSERT INTO devices (uuid, name, hostname, serial, os_version, agent_version, ip, mac, resolution, protocol_version, agent_capabilities, group_id, display, refresh_token, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'offline')`,
  )
    .bind(
      uuid,
      // Default the display name to the stable UUID (not the hostname, which can
      // change). It is editable later from the device detail page.
      uuid,
      info.hostname,
      info.serial,
      info.os_version,
      info.agent_version,
      info.ip,
      info.mac,
      info.resolution,
      info.protocol_version ?? null,
      info.capabilities ? JSON.stringify(info.capabilities) : null,
      tok.group_id,
      display,
      refreshHash,
    )
    .run();

  // Consume the code immediately after the device row exists, before anything
  // that can fail. This guarantees a later error can never leave the code
  // spendable while a half-registered device already occupies the fleet.
  await c.env.DB.prepare(
    "UPDATE enrollment_tokens SET used_by_uuid = ? WHERE token = ?",
  )
    .bind(uuid, tok.token)
    .run();

  // Remote-access provisioning is best-effort: a signage device must still come
  // up as a player when Cloudflare Zero Trust is unconfigured or the API errors,
  // so never let a provisioning failure fail enrollment.
  try {
    await provisionRemoteAccess(c.env, { uuid });
  } catch (error) {
    console.error(JSON.stringify({ event: "enroll_provision_failed", device_id: uuid, error: String(error) }));
  }

  const access = await signDeviceToken(c.env, uuid);
  const wsUrl = c.env.PUBLIC_API_URL.replace(/^http/, "ws").replace(/\/$/, "") +
    `/api/agent/ws`;

  const resp: EnrollResponse = {
    device_uuid: uuid,
    access_token: access,
    refresh_token: refresh,
    ws_url: wsUrl,
  };
  return c.json(resp);
});

// Exchange a refresh token for a fresh access token.
app.post("/token/refresh", async (c) => {
  const { device_uuid, refresh_token } = await c.req.json<{
    device_uuid: string;
    refresh_token: string;
  }>();
  if (!device_uuid || !refresh_token) return c.json({ error: "missing_fields" }, 400);

  const dev = await c.env.DB.prepare(
    "SELECT refresh_token FROM devices WHERE uuid = ?",
  )
    .bind(device_uuid)
    .first<{ refresh_token: string | null }>();
  if (!dev || !dev.refresh_token) return c.json({ error: "unknown_device" }, 401);
  if ((await sha256Hex(refresh_token)) !== dev.refresh_token) {
    return c.json({ error: "invalid_refresh" }, 401);
  }
  const access = await signDeviceToken(c.env, device_uuid);
  return c.json({ access_token: access });
});

export default app;
