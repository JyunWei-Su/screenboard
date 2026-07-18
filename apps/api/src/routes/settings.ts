import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { requireAuth, requireRole } from "../auth";
import { configuredRemoteAccess, getAllowedAccessEmails, normalizeAccessEmails } from "../lib/cloudflareTunnel";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", requireAuth);

app.get("/ssh-access", async (c) => {
  const emails = await getAllowedAccessEmails(c.env);
  return c.json({ emails, configured: configuredRemoteAccess(c.env) });
});

app.put("/ssh-access", requireRole("admin"), async (c) => {
  const body = await c.req.json<{ emails?: unknown }>();
  const emails = normalizeAccessEmails(body.emails);
  if (!emails.length) return c.json({ error: "at_least_one_valid_email_required" }, 400);
  const current = await c.env.DB.prepare("SELECT value FROM system_settings WHERE key = 'ssh_access_config_version'")
    .first<{ value: string }>();
  const version = Math.max(0, Number(current?.value ?? "0") || 0) + 1;
  await c.env.DB.batch([
    c.env.DB.prepare(
    "INSERT INTO system_settings (key, value, updated_at) VALUES ('ssh_access_allowed_emails', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).bind(JSON.stringify(emails)),
    c.env.DB.prepare(
      "INSERT INTO system_settings (key, value, updated_at) VALUES ('ssh_access_config_version', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).bind(String(version)),
  ]);
  return c.json({ emails, version });
});

export default app;
