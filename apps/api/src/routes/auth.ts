import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { requireAuth, signAdminToken } from "../auth";
import {
  decryptSecret,
  encryptSecret,
  generateSecret,
  provisioningUri,
  verifyTotp,
} from "../totp";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// One-time bootstrap of the first admin. Only works while there are zero users
// and requires the BOOTSTRAP_TOKEN secret. Returns a TOTP provisioning URI.
app.post("/bootstrap", async (c) => {
  const token = c.req.header("x-bootstrap-token");
  if (!c.env.BOOTSTRAP_TOKEN || token !== c.env.BOOTSTRAP_TOKEN) {
    return c.json({ error: "forbidden" }, 403);
  }
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  if ((count?.n ?? 0) > 0) return c.json({ error: "already_initialized" }, 409);

  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  const name = body.name || "admin";
  const secret = generateSecret();
  const enc = await encryptSecret(secret, c.env.TOTP_ENC_KEY);
  const res = await c.env.DB.prepare(
    "INSERT INTO users (name, totp_secret, role) VALUES (?, ?, 'admin')",
  )
    .bind(name, enc)
    .run();
  return c.json({
    user_id: res.meta.last_row_id,
    name,
    totp_secret: secret,
    otpauth_uri: provisioningUri(secret, name),
  });
});

// Passwordless login: user picks their name and enters a 6-digit TOTP code.
app.post("/login", async (c) => {
  const { name, code } = await c.req.json<{ name: string; code: string }>();
  if (!name || !code) return c.json({ error: "missing_fields" }, 400);
  const user = await c.env.DB.prepare(
    "SELECT id, name, totp_secret, role FROM users WHERE name = ?",
  )
    .bind(name)
    .first<{ id: number; name: string; totp_secret: string; role: string }>();
  if (!user) return c.json({ error: "invalid_credentials" }, 401);

  const secret = await decryptSecret(user.totp_secret, c.env.TOTP_ENC_KEY);
  if (!(await verifyTotp(secret, code))) {
    return c.json({ error: "invalid_credentials" }, 401);
  }

  const { token, jti, exp } = await signAdminToken(c.env, {
    id: user.id,
    name: user.name,
    role: user.role as Variables["user"]["role"],
  });
  await c.env.DB.prepare(
    "INSERT INTO sessions (token_id, user_id, expires_at) VALUES (?, ?, datetime(?, 'unixepoch'))",
  )
    .bind(jti, user.id, exp)
    .run();
  await c.env.DB.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?")
    .bind(user.id)
    .run();

  return c.json({ token, user: { id: user.id, name: user.name, role: user.role } });
});

app.post("/logout", requireAuth, async (c) => {
  const user = c.get("user");
  await c.env.DB.prepare("UPDATE sessions SET revoked = 1 WHERE token_id = ?")
    .bind(user.jti)
    .run();
  return c.json({ ok: true });
});

app.get("/me", requireAuth, (c) => {
  const user = c.get("user");
  return c.json({ id: user.id, name: user.name, role: user.role });
});

export default app;
