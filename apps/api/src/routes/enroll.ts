import { Hono } from "hono";
import type { Env, Variables } from "../types";
import {
  generateRefreshToken,
  sha256Hex,
  signDeviceToken,
} from "../auth";
import type { EnrollRequest, EnrollResponse } from "@screenboard/shared";
import { provisionRemoteAccess } from "../lib/cloudflareTunnel";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// First-boot auto registration. Consumes a one-time enrollment token, creates the
// device, and returns access + refresh tokens plus the WebSocket command URL.
app.post("/enroll", async (c) => {
  const body = await c.req.json<EnrollRequest>();
  if (!body.enrollment_token || !body.info) {
    return c.json({ error: "missing_fields" }, 400);
  }

  const tok = await c.env.DB.prepare(
    "SELECT token, group_id, expires_at, used_by_uuid FROM enrollment_tokens WHERE token = ?",
  )
    .bind(body.enrollment_token)
    .first<{ token: string; group_id: number | null; expires_at: string; used_by_uuid: string | null }>();

  if (!tok) return c.json({ error: "invalid_token" }, 401);
  if (tok.used_by_uuid) return c.json({ error: "token_used" }, 409);
  if (new Date(tok.expires_at).getTime() < Date.now()) {
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
    `INSERT INTO devices (uuid, name, hostname, serial, os_version, agent_version, ip, mac, resolution, group_id, display, refresh_token, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'offline')`,
  )
    .bind(
      uuid,
      info.hostname || uuid.slice(0, 8),
      info.hostname,
      info.serial,
      info.os_version,
      info.agent_version,
      info.ip,
      info.mac,
      info.resolution,
      tok.group_id,
      display,
      refreshHash,
    )
    .run();

  // Provisioning is intentionally best-effort: a signage device must still be
  // usable when Cloudflare Zero Trust has not yet been configured.
  await provisionRemoteAccess(c.env, { uuid, name: info.hostname || uuid.slice(0, 8) });

  await c.env.DB.prepare(
    "UPDATE enrollment_tokens SET used_by_uuid = ? WHERE token = ?",
  )
    .bind(uuid, tok.token)
    .run();

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
