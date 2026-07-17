import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { verifyAdminToken, verifyDeviceToken } from "../auth";

// Public binary content, served to either the agent (device token) or the admin
// UI (admin token, passed via ?token= so <img>/<video> can load it). Mounted at
// /api/content so it never overlaps the admin auth wildcard.
const app = new Hono<{ Bindings: Env; Variables: Variables }>();

async function authed(env: Env, token: string): Promise<boolean> {
  if (!token) return false;
  if ((await verifyDeviceToken(env, token)) !== null) return true;
  return verifyAdminToken(env, token);
}

function bearer(c: { req: { header: (k: string) => string | undefined; query: (k: string) => string | undefined } }): string {
  return (c.req.header("Authorization")?.replace(/^Bearer /, "") || c.req.query("token")) ?? "";
}

async function stream(env: Env, key: string, contentType: string): Promise<Response> {
  const obj = await env.BUCKET.get(key);
  if (!obj) return new Response("not found", { status: 404 });
  return new Response(obj.body, {
    headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=3600" },
  });
}

app.get("/media/:id", async (c) => {
  if (!(await authed(c.env, bearer(c)))) return c.json({ error: "unauthorized" }, 401);
  const row = await c.env.DB.prepare(
    `SELECT v.r2_key, m.content_type FROM media m
     JOIN media_versions v ON v.id = m.current_version_id WHERE m.id = ?`,
  )
    .bind(Number(c.req.param("id")))
    .first<{ r2_key: string; content_type: string }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  return stream(c.env, row.r2_key, row.content_type || "application/octet-stream");
});

app.get("/screenshots/:id", async (c) => {
  if (!(await authed(c.env, bearer(c)))) return c.json({ error: "unauthorized" }, 401);
  const row = await c.env.DB.prepare("SELECT r2_key FROM screenshots WHERE id = ?")
    .bind(Number(c.req.param("id")))
    .first<{ r2_key: string }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  return stream(c.env, row.r2_key, "image/png");
});

app.get("/ota/:id", async (c) => {
  if (!(await authed(c.env, bearer(c)))) return c.json({ error: "unauthorized" }, 401);
  const row = await c.env.DB.prepare("SELECT r2_key FROM ota_packages WHERE id = ?")
    .bind(Number(c.req.param("id")))
    .first<{ r2_key: string }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  return stream(c.env, row.r2_key, "application/octet-stream");
});

export default app;
