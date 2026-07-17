import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { requireAuth, requireRole } from "../auth";
import { encryptSecret, generateSecret, provisioningUri } from "../totp";

// User management (admin only).
const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", requireAuth);
app.use("*", requireRole("admin"));

app.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, name, role, created_at, last_login_at FROM users ORDER BY id",
  ).all();
  return c.json(rows.results);
});

// Create a user; returns the TOTP secret + provisioning URI (shown once).
app.post("/", async (c) => {
  const { name, role } = await c.req.json<{ name: string; role: string }>();
  if (!name || !role) return c.json({ error: "missing_fields" }, 400);
  const secret = generateSecret();
  const enc = await encryptSecret(secret, c.env.TOTP_ENC_KEY);
  const res = await c.env.DB.prepare(
    "INSERT INTO users (name, totp_secret, role) VALUES (?, ?, ?)",
  )
    .bind(name, enc, role)
    .run();
  return c.json({
    id: res.meta.last_row_id,
    name,
    role,
    totp_secret: secret,
    otpauth_uri: provisioningUri(secret, name),
  });
});

app.patch("/:id", async (c) => {
  const { name, role } = await c.req.json<{ name?: string; role?: string }>();
  await c.env.DB.prepare(
    "UPDATE users SET name = COALESCE(?, name), role = COALESCE(?, role) WHERE id = ?",
  )
    .bind(name ?? null, role ?? null, Number(c.req.param("id")))
    .run();
  return c.json({ ok: true });
});

// Rotate a user's TOTP secret (returns a fresh provisioning URI).
app.post("/:id/reset-totp", async (c) => {
  const id = Number(c.req.param("id"));
  const user = await c.env.DB.prepare("SELECT name FROM users WHERE id = ?")
    .bind(id)
    .first<{ name: string }>();
  if (!user) return c.json({ error: "not_found" }, 404);
  const secret = generateSecret();
  const enc = await encryptSecret(secret, c.env.TOTP_ENC_KEY);
  await c.env.DB.prepare("UPDATE users SET totp_secret = ? WHERE id = ?").bind(enc, id).run();
  return c.json({ totp_secret: secret, otpauth_uri: provisioningUri(secret, user.name) });
});

app.delete("/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM users WHERE id = ?")
    .bind(Number(c.req.param("id")))
    .run();
  return c.json({ ok: true });
});

export default app;
