import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { verifyAdminToken } from "../auth";

// Admin real-time streams. These upgrade to a WebSocket, and a browser cannot
// set an Authorization header on a WebSocket, so the short-lived admin JWT is
// passed as ?token= and verified by signature — the same trust level as the
// media/screenshot content URLs (routes/content.ts).
const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Live device online/offline presence. Forwards the upgrade to the global
// PresenceHub Durable Object, which broadcasts every status transition.
app.get("/devices", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.json({ error: "expected_websocket" }, 426);
  }
  const token = c.req.query("token") || "";
  if (!token || !(await verifyAdminToken(c.env, token))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const stub = c.env.PRESENCE_HUB.get(c.env.PRESENCE_HUB.idFromName("global"));
  const doReq = new Request("https://hub/subscribe", {
    method: "GET",
    headers: c.req.raw.headers,
  });
  return stub.fetch(doReq);
});

export default app;
