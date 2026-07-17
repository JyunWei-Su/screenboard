import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, QueueEvent, Variables } from "./types";

import authRoutes from "./routes/auth";
import enrollRoutes from "./routes/enroll";
import agentRoutes from "./routes/agent";
import contentRoutes from "./routes/content";
import devicesRoutes from "./routes/devices";
import groupsRoutes from "./routes/groups";
import playlistsRoutes from "./routes/playlists";
import schedulesRoutes from "./routes/schedules";
import mediaRoutes from "./routes/media";
import screenshotsRoutes from "./routes/screenshots";
import otaRoutes from "./routes/ota";
import eventsRoutes from "./routes/events";
import dashboardRoutes from "./routes/dashboard";
import usersRoutes from "./routes/users";
import installRoutes from "./routes/install";

import { consumeEvents } from "./lib/notifications";
import { pruneRetention, sweepOffline } from "./lib/scheduled";
import { DeviceConnection } from "./do/deviceConnection";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Bearer-token auth (no cookies), so a permissive CORS policy is safe here.
app.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type"] }));

app.get("/health", (c) => c.json({ ok: true, service: "screenboard-api" }));

// Public device bootstrap: /install.sh + /install/agent
app.route("/", installRoutes);

// Public / device / content
app.route("/api/auth", authRoutes);
app.route("/api", enrollRoutes); // /api/enroll, /api/token/refresh
app.route("/api/agent", agentRoutes);
app.route("/api/content", contentRoutes);

// Admin (each router enforces requireAuth internally)
app.route("/api/devices", devicesRoutes);
app.route("/api/groups", groupsRoutes);
app.route("/api/playlists", playlistsRoutes);
app.route("/api/schedules", schedulesRoutes);
app.route("/api/media", mediaRoutes);
app.route("/api/screenshots", screenshotsRoutes);
app.route("/api/ota", otaRoutes);
app.route("/api/events", eventsRoutes);
app.route("/api/dashboard", dashboardRoutes);
app.route("/api/users", usersRoutes);

app.notFound((c) => c.json({ error: "not_found" }, 404));

export default {
  fetch: app.fetch,

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === "0 3 * * *") {
      await pruneRetention(env);
    } else {
      await sweepOffline(env);
    }
  },

  async queue(batch: MessageBatch<QueueEvent>, env: Env): Promise<void> {
    await consumeEvents(batch, env);
  },
};

export { DeviceConnection };
