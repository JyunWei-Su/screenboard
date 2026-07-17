import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { requireAuth, requireRole, sha256Hex } from "../auth";

// Admin media library. Public binary content is served from routes/content.ts.
export const adminMedia = new Hono<{ Bindings: Env; Variables: Variables }>();
adminMedia.use("*", requireAuth);

adminMedia.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT m.*, v.size, v.version, v.checksum,
       (SELECT GROUP_CONCAT(tag) FROM media_tags t WHERE t.media_id = m.id) AS tags
     FROM media m LEFT JOIN media_versions v ON v.id = m.current_version_id
     ORDER BY m.created_at DESC`,
  ).all();
  return c.json(rows.results);
});

adminMedia.get("/:id/versions", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, version, size, checksum, created_at FROM media_versions WHERE media_id = ? ORDER BY version DESC",
  )
    .bind(Number(c.req.param("id")))
    .all();
  return c.json(rows.results);
});

// Upload a new media asset (raw body). ?filename=&type=image|video|pdf|html
adminMedia.put("/", requireRole("admin", "operator"), async (c) => {
  const filename = c.req.query("filename") || "upload.bin";
  const type = c.req.query("type") || "image";
  const contentType = c.req.header("Content-Type") || "application/octet-stream";
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength === 0) return c.json({ error: "empty_body" }, 400);

  const res = await c.env.DB.prepare(
    "INSERT INTO media (filename, type, content_type, created_by) VALUES (?, ?, ?, ?)",
  )
    .bind(filename, type, contentType, c.get("user").id)
    .run();
  const mediaId = res.meta.last_row_id;
  const key = `media/${mediaId}/1/${filename}`;
  await c.env.BUCKET.put(key, bytes, { httpMetadata: { contentType } });
  const checksum = await sha256Hex(new TextDecoder("latin1").decode(bytes));
  const ver = await c.env.DB.prepare(
    "INSERT INTO media_versions (media_id, version, r2_key, size, checksum, uploaded_by) VALUES (?, 1, ?, ?, ?, ?)",
  )
    .bind(mediaId, key, bytes.byteLength, checksum, c.get("user").id)
    .run();
  await c.env.DB.prepare("UPDATE media SET current_version_id = ? WHERE id = ?")
    .bind(ver.meta.last_row_id, mediaId)
    .run();
  return c.json({ id: mediaId, version: 1, key });
});

// Upload a new version of an existing asset.
adminMedia.put("/:id/version", requireRole("admin", "operator"), async (c) => {
  const mediaId = Number(c.req.param("id"));
  const filename = c.req.query("filename") || "upload.bin";
  const contentType = c.req.header("Content-Type") || "application/octet-stream";
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const last = await c.env.DB.prepare(
    "SELECT MAX(version) AS v FROM media_versions WHERE media_id = ?",
  )
    .bind(mediaId)
    .first<{ v: number | null }>();
  const version = (last?.v ?? 0) + 1;
  const key = `media/${mediaId}/${version}/${filename}`;
  await c.env.BUCKET.put(key, bytes, { httpMetadata: { contentType } });
  const checksum = await sha256Hex(new TextDecoder("latin1").decode(bytes));
  const ver = await c.env.DB.prepare(
    "INSERT INTO media_versions (media_id, version, r2_key, size, checksum, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(mediaId, version, key, bytes.byteLength, checksum, c.get("user").id)
    .run();
  await c.env.DB.prepare(
    "UPDATE media SET current_version_id = ?, filename = ? WHERE id = ?",
  )
    .bind(ver.meta.last_row_id, filename, mediaId)
    .run();
  return c.json({ id: mediaId, version });
});

// Roll back the current pointer to an earlier version.
adminMedia.post("/:id/rollback/:versionId", requireRole("admin", "operator"), async (c) => {
  const mediaId = Number(c.req.param("id"));
  const versionId = Number(c.req.param("versionId"));
  const v = await c.env.DB.prepare(
    "SELECT id FROM media_versions WHERE id = ? AND media_id = ?",
  )
    .bind(versionId, mediaId)
    .first();
  if (!v) return c.json({ error: "version_not_found" }, 404);
  await c.env.DB.prepare("UPDATE media SET current_version_id = ? WHERE id = ?")
    .bind(versionId, mediaId)
    .run();
  return c.json({ ok: true });
});

adminMedia.put("/:id/tags", requireRole("admin", "operator"), async (c) => {
  const mediaId = Number(c.req.param("id"));
  const tags = await c.req.json<string[]>();
  await c.env.DB.prepare("DELETE FROM media_tags WHERE media_id = ?").bind(mediaId).run();
  for (const tag of tags) {
    await c.env.DB.prepare("INSERT OR IGNORE INTO media_tags (media_id, tag) VALUES (?, ?)")
      .bind(mediaId, tag)
      .run();
  }
  return c.json({ ok: true });
});

adminMedia.delete("/:id", requireRole("admin", "operator"), async (c) => {
  const mediaId = Number(c.req.param("id"));
  const versions = await c.env.DB.prepare(
    "SELECT r2_key FROM media_versions WHERE media_id = ?",
  )
    .bind(mediaId)
    .all<{ r2_key: string }>();
  for (const v of versions.results) await c.env.BUCKET.delete(v.r2_key);
  await c.env.DB.prepare("DELETE FROM media WHERE id = ?").bind(mediaId).run();
  return c.json({ ok: true });
});

export default adminMedia;
