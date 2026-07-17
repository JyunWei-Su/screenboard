import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { requireAuth } from "../auth";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", requireAuth);

app.get("/stats", async (c) => {
  const statusRows = await c.env.DB.prepare(
    "SELECT status, COUNT(*) AS n FROM devices GROUP BY status",
  ).all<{ status: string; n: number }>();
  const byStatus: Record<string, number> = {
    online: 0,
    offline: 0,
    warning: 0,
    maintenance: 0,
  };
  let total = 0;
  for (const r of statusRows.results) {
    byStatus[r.status] = r.n;
    total += r.n;
  }

  const alerts = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE resolved_at IS NULL",
  ).first<{ n: number }>();

  const playback = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(count), 0) AS n FROM playback_counters WHERE day >= date('now', '-7 days')",
  ).first<{ n: number }>();

  const topContent = await c.env.DB.prepare(
    `SELECT media_id, SUM(count) AS plays FROM playback_counters
     WHERE media_id IS NOT NULL AND day >= date('now', '-30 days')
     GROUP BY media_id ORDER BY plays DESC LIMIT 10`,
  ).all();

  const onlineRate = total > 0 ? byStatus.online / total : 0;

  return c.json({
    total,
    online: byStatus.online,
    offline: byStatus.offline,
    warning: byStatus.warning,
    maintenance: byStatus.maintenance,
    open_alerts: alerts?.n ?? 0,
    online_rate: Number(onlineRate.toFixed(3)),
    playback_7d: playback?.n ?? 0,
    top_content: topContent.results,
  });
});

export default app;
