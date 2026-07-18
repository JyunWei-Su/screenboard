import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { requireAuth, requireRole } from "../auth";
import { configuredRemoteAccess, deleteOrphanTunnels, getAllowedAccessEmails, listOrphanTunnels, normalizeAccessEmails } from "../lib/cloudflareTunnel";

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

// Lists ScreenBoard-managed Cloudflare Tunnels no device still uses, the leftovers
// of reprovisioning. Admin-only: it exposes account-wide Tunnel names.
app.get("/tunnels", requireRole("admin"), async (c) => {
  if (!configuredRemoteAccess(c.env)) return c.json({ configured: false, orphans: [], in_use: 0 });
  try {
    const { orphans, inUse } = await listOrphanTunnels(c.env);
    return c.json({ configured: true, orphans, in_use: inUse });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "list_failed" }, 502);
  }
});

// Deletes orphaned Tunnels. With no `ids`, cleans up every current orphan; the lib
// re-verifies each id is still orphaned before deleting.
app.post("/tunnels/cleanup", requireRole("admin"), async (c) => {
  if (!configuredRemoteAccess(c.env)) return c.json({ error: "remote_access_not_configured" }, 409);
  const body: { ids?: unknown } = await c.req.json<{ ids?: unknown }>().catch(() => ({}));
  let ids: string[];
  if (body.ids === undefined) {
    ids = (await listOrphanTunnels(c.env)).orphans.map((t) => t.id);
  } else if (Array.isArray(body.ids) && body.ids.every((x): x is string => typeof x === "string")) {
    ids = body.ids;
  } else {
    return c.json({ error: "invalid_ids" }, 400);
  }
  try {
    const result = await deleteOrphanTunnels(c.env, ids);
    return c.json(result);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "cleanup_failed" }, 502);
  }
});

export default app;
