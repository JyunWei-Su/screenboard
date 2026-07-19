import { Hono } from "hono";
import type { Env, Variables } from "../types";
import installScript from "../install.sh";
import uninstallScript from "../uninstall.sh";

// Public bootstrap: `curl -fsSL <api>/install.sh | sudo bash -s -- <token>`.
const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get("/install.sh", (c) => {
  // The installer must call back to the same public hostname it was fetched
  // from. This also keeps it correct if the configured API domain changes.
  const base = new URL(c.req.url).origin;
  // Replace only the assignment. The same marker below is intentionally kept
  // as the installer's fallback check when a script is run from a local file.
  const script = installScript.replace(/^SERVER="__SERVER__"/m, `SERVER="${base}"`);
  return new Response(script, {
    headers: { "Content-Type": "text/x-shellscript; charset=utf-8" },
  });
});

// Public teardown: `curl -fsSL <api>/uninstall.sh | sudo bash`. Self-contained
// (removes local ScreenBoard state only), so it needs no server injection.
app.get("/uninstall.sh", () => {
  return new Response(uninstallScript, {
    headers: { "Content-Type": "text/x-shellscript; charset=utf-8" },
  });
});

// Serves the latest agent binary for a channel (uploaded via the admin OTA page).
// Note: single binary per channel — assumes a single-architecture fleet.
app.get("/install/agent", async (c) => {
  const channel = c.req.query("channel") || "stable";
  const pkg = await c.env.DB.prepare(
    "SELECT r2_key FROM ota_packages WHERE channel = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(channel)
    .first<{ r2_key: string }>();
  if (!pkg) {
    return c.text(
      "No agent package uploaded yet. Build the agent and upload it via the admin OTA page (channel=" +
        channel +
        ") first.",
      404,
    );
  }
  const obj = await c.env.BUCKET.get(pkg.r2_key);
  if (!obj) return c.text("package binary missing in storage", 404);
  return new Response(obj.body, {
    headers: { "Content-Type": "application/octet-stream" },
  });
});

export default app;
