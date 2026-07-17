import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { requireAuth, requireRole } from "../auth";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", requireAuth);

app.get("/", async (c) => {
  const unresolved = c.req.query("unresolved");
  const deviceId = c.req.query("device_id");
  let sql = "SELECT * FROM events";
  const where: string[] = [];
  const binds: unknown[] = [];
  if (unresolved === "1") where.push("resolved_at IS NULL");
  if (deviceId) {
    where.push("device_id = ?");
    binds.push(deviceId);
  }
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY created_at DESC LIMIT 200";
  const rows = await c.env.DB.prepare(sql).bind(...binds).all();
  return c.json(rows.results);
});

app.post("/:id/resolve", requireRole("admin", "operator"), async (c) => {
  await c.env.DB.prepare(
    "UPDATE events SET resolved_at = datetime('now') WHERE id = ?",
  )
    .bind(Number(c.req.param("id")))
    .run();
  return c.json({ ok: true });
});

// ---- Notification channels (Teams / generic webhook) ----

app.get("/channels", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, kind, url, events, enabled, created_at FROM notification_channels ORDER BY id",
  ).all();
  return c.json(rows.results);
});

app.post("/channels", requireRole("admin"), async (c) => {
  const { kind, url, events } = await c.req.json<{
    kind: "teams" | "webhook";
    url: string;
    events?: string;
  }>();
  if (!kind || !url) return c.json({ error: "missing_fields" }, 400);
  const res = await c.env.DB.prepare(
    "INSERT INTO notification_channels (kind, url, events) VALUES (?, ?, ?)",
  )
    .bind(kind, url, events || "*")
    .run();
  return c.json({ id: res.meta.last_row_id });
});

app.patch("/channels/:id", requireRole("admin"), async (c) => {
  const { url, events, enabled } = await c.req.json<{
    url?: string;
    events?: string;
    enabled?: boolean;
  }>();
  await c.env.DB.prepare(
    "UPDATE notification_channels SET url = COALESCE(?, url), events = COALESCE(?, events), enabled = COALESCE(?, enabled) WHERE id = ?",
  )
    .bind(
      url ?? null,
      events ?? null,
      enabled === undefined ? null : enabled ? 1 : 0,
      Number(c.req.param("id")),
    )
    .run();
  return c.json({ ok: true });
});

app.delete("/channels/:id", requireRole("admin"), async (c) => {
  await c.env.DB.prepare("DELETE FROM notification_channels WHERE id = ?")
    .bind(Number(c.req.param("id")))
    .run();
  return c.json({ ok: true });
});

export default app;
