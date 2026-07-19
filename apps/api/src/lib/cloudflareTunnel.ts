import type { Env } from "../types";

interface CloudflareEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ message?: string }>;
}

interface TunnelResult { id: string; status?: string }
interface AccessAppResult { id: string }
interface AccessCaResult { public_key: string }
interface DnsRecordResult { id: string }

export function configuredRemoteAccess(env: Env): boolean {
  return Boolean(env.CF_API_TOKEN && env.CF_ACCOUNT_ID && env.CF_ZONE_ID && env.CF_ZONE_NAME);
}

export function hostnameFor(env: Env, uuid: string): string {
  // Universal SSL covers a zone apex and its first-level subdomains. Do not
  // use <uuid>.ssh.example.com here: it needs a separate certificate.
  return `ssh-${uuid}.${env.CF_ZONE_NAME!.replace(/^\.+|\.+$/g, "")}`.toLowerCase();
}

async function cf<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const body = await res.json<CloudflareEnvelope<T>>();
  if (!res.ok || !body.success) {
    throw new Error(body.errors?.map((e) => e.message).filter(Boolean).join(", ") || `Cloudflare API ${res.status}`);
  }
  return body.result;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeAccessEmails(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string" ? value.split(/[\n,]/) : [];
  return [...new Set(raw
    .filter((email): email is string => typeof email === "string")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => EMAIL.test(email)))];
}

export async function getAllowedAccessEmails(env: Env): Promise<string[]> {
  const row = await env.DB.prepare("SELECT value FROM system_settings WHERE key = 'ssh_access_allowed_emails'")
    .first<{ value: string }>();
  if (row?.value) {
    try {
      const stored = normalizeAccessEmails(JSON.parse(row.value));
      if (stored.length) return stored;
    } catch {
      // Treat malformed stored data as unset; provisioning will request an
      // administrator to save a valid list in System Settings.
    }
  }
  return [];
}

export async function getSshAccessConfigVersion(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT value FROM system_settings WHERE key = 'ssh_access_config_version'")
    .first<{ value: string }>();
  const version = Number(row?.value ?? "0");
  return Number.isInteger(version) && version >= 0 ? version : 0;
}

export async function allowedSshUsers(env: Env): Promise<string[]> {
  return [...new Set((await getAllowedAccessEmails(env))
    .map((email) => email.split("@", 1)[0].toLowerCase())
    .filter((name) => /^[a-z_][a-z0-9_-]{0,31}$/.test(name)))];
}

export async function provisionRemoteAccess(env: Env, device: { uuid: string }): Promise<{ ok: boolean; error?: string }> {
  if (!configuredRemoteAccess(env)) return { ok: false, error: "remote_access_not_configured" };
  const emails = await getAllowedAccessEmails(env);
  const accessConfigVersion = await getSshAccessConfigVersion(env);
  const sshUsers = await allowedSshUsers(env);
  if (!emails.length || !sshUsers.length) {
    return { ok: false, error: "SSH Access must contain at least one valid email with a Linux-safe username prefix" };
  }
  const hostname = hostnameFor(env, device.uuid);
  // Cloudflare may retain a deleted Tunnel name briefly. Keep the device UUID
  // for traceability but add a fresh suffix so reprovisioning never collides
  // with a stale Tunnel from a previous attempt.
  const tunnelName = `screenboard-${device.uuid}-${crypto.randomUUID().slice(0, 8)}`;
  let tunnel: TunnelResult | null = null;
  let app: AccessAppResult | null = null;
  try {
    tunnel = await cf<TunnelResult>(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel`, {
      method: "POST",
      body: JSON.stringify({ name: tunnelName, config_src: "cloudflare" }),
    });
    await cf(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnel.id}/configurations`, {
      method: "PUT",
      body: JSON.stringify({ config: { ingress: [
        { hostname, service: "ssh://localhost:22" },
        { service: "http_status:404" },
      ] } }),
    });
    await cf(env, `/zones/${env.CF_ZONE_ID}/dns_records`, {
      method: "POST",
      body: JSON.stringify({
        type: "CNAME", name: hostname, content: `${tunnel.id}.cfargotunnel.com`, proxied: true,
      }),
    });
    app = await cf<AccessAppResult>(env, `/accounts/${env.CF_ACCOUNT_ID}/access/apps`, {
      method: "POST",
      body: JSON.stringify({
        // Identify the app by the stable device UUID (matches the ssh-<uuid>
        // destination). The device's display name can change, so keep it out of
        // the Cloudflare label to avoid drift.
        name: `ScreenBoard SSH: ${device.uuid}`,
        domain: hostname,
        // BrowserSSHApplication: enables Cloudflare's browser-rendered terminal.
        type: "ssh",
        app_launcher_visible: true,
        session_duration: "8h",
        destinations: [{ type: "public", uri: hostname }],
      }),
    });
    await cf(env, `/accounts/${env.CF_ACCOUNT_ID}/access/apps/${app.id}/policies`, {
      method: "POST",
      body: JSON.stringify({
        name: "ScreenBoard SSH operators",
        decision: "allow",
        precedence: 1,
        include: emails.map((email) => ({ email: { email } })),
      }),
    });
    const ca = await cf<AccessCaResult>(env, `/accounts/${env.CF_ACCOUNT_ID}/access/apps/${app.id}/ca`, {
      method: "POST",
      body: "{}",
    });
    await env.DB.prepare(
      `INSERT INTO device_remote_access (device_id, tunnel_id, access_app_id, hostname, status, ssh_ca_public_key, provisioning_version, access_config_version)
       VALUES (?, ?, ?, ?, 'inactive', ?, 3, ?)`,
    ).bind(device.uuid, tunnel.id, app.id, hostname, ca.public_key, accessConfigVersion).run();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "remote_access_provision_failed", device_id: device.uuid, error: message }));
    if (tunnel) {
      await env.DB.prepare(
        `INSERT INTO device_remote_access (device_id, tunnel_id, access_app_id, hostname, status, last_error, provisioning_version, access_config_version)
         VALUES (?, ?, ?, ?, 'error', ?, 3, ?) ON CONFLICT(device_id) DO UPDATE SET status='error', last_error=excluded.last_error, provisioning_version=excluded.provisioning_version, access_config_version=excluded.access_config_version, updated_at=datetime('now')`,
      ).bind(device.uuid, tunnel.id, app?.id ?? null, hostname, message, accessConfigVersion).run();
    }
    return { ok: false, error: message };
  }
}

export async function getTunnelStatus(env: Env, tunnelId: string): Promise<string | null> {
  if (!configuredRemoteAccess(env)) return null;
  const tunnel = await cf<TunnelResult>(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}`);
  return tunnel.status || "inactive";
}

interface TunnelListItem { id: string; name?: string; status?: string; created_at?: string; deleted_at?: string | null }
interface PagedEnvelope<T> extends CloudflareEnvelope<T> { result_info?: { page: number; total_pages: number } }

// cfList pages through a Cloudflare list endpoint that reports result_info. The
// shared cf() helper drops result_info, so listing needs its own reader.
async function cfList<T>(env: Env, path: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= 50; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`https://api.cloudflare.com/client/v4${path}${sep}per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
    });
    const body = await res.json<PagedEnvelope<T[]>>();
    if (!res.ok || !body.success) {
      throw new Error(body.errors?.map((e) => e.message).filter(Boolean).join(", ") || `Cloudflare API ${res.status}`);
    }
    const batch = body.result ?? [];
    items.push(...batch);
    const info = body.result_info;
    if (batch.length === 0 || !info || info.page >= info.total_pages) break;
  }
  return items;
}

export interface OrphanTunnel { id: string; name: string; status: string; created_at: string | null }

// A ScreenBoard-managed Tunnel is "orphaned" when no device row still references
// it. These are the leftovers of reprovisioning (delete of the old Tunnel is
// best-effort and fails while its connector is still live), safe to remove.
export async function listOrphanTunnels(env: Env): Promise<{ orphans: OrphanTunnel[]; inUse: number }> {
  if (!configuredRemoteAccess(env)) return { orphans: [], inUse: 0 };
  const tunnels = await cfList<TunnelListItem>(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel?is_deleted=false`);
  const managed = tunnels.filter((t): t is TunnelListItem & { name: string } =>
    typeof t.name === "string" && t.name.startsWith("screenboard-"));
  const rows = await env.DB.prepare("SELECT tunnel_id FROM device_remote_access").all<{ tunnel_id: string }>();
  const inUseIds = new Set((rows.results ?? []).map((r) => r.tunnel_id));
  const orphans = managed
    .filter((t) => !inUseIds.has(t.id))
    .map((t) => ({ id: t.id, name: t.name, status: t.status || "inactive", created_at: t.created_at ?? null }));
  return { orphans, inUse: managed.length - orphans.length };
}

// Deletes only Tunnels confirmed orphaned at call time, so an in-use id passed by
// a stale client can never remove a live device's Tunnel.
export async function deleteOrphanTunnels(
  env: Env,
  ids: string[],
): Promise<{ deleted: string[]; failed: Array<{ id: string; error: string }> }> {
  const deleted: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  if (!configuredRemoteAccess(env)) return { deleted, failed };
  const { orphans } = await listOrphanTunnels(env);
  const allowed = new Set(orphans.map((t) => t.id));
  for (const id of ids) {
    if (!allowed.has(id)) { failed.push({ id, error: "not_an_orphan" }); continue; }
    try {
      // Clear any stale connection records first so Cloudflare will delete a
      // Tunnel whose connector has gone away but is still marked connected.
      await cf(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${id}/connections`, { method: "DELETE" })
        .catch(() => {});
      await cf(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${id}`, { method: "DELETE" });
      deleted.push(id);
    } catch (error) {
      failed.push({ id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { deleted, failed };
}

export async function createTunnelToken(env: Env, tunnelId: string): Promise<string | null> {
  if (!configuredRemoteAccess(env)) return null;
  // This is the connector token consumed by `cloudflared service install`.
  // The /management endpoint returns a different token for management APIs.
  return cf<string>(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/token`);
}

export async function removeRemoteAccess(
  env: Env,
  access: { tunnel_id: string; access_app_id: string | null; hostname: string },
): Promise<void> {
  if (!configuredRemoteAccess(env)) return;
  try {
    if (access.access_app_id) {
      await cf(env, `/accounts/${env.CF_ACCOUNT_ID}/access/apps/${access.access_app_id}`, { method: "DELETE" });
    }
    const records = await cf<DnsRecordResult[]>(
      env,
      `/zones/${env.CF_ZONE_ID}/dns_records?type=CNAME&name=${encodeURIComponent(access.hostname)}`,
    );
    for (const record of records) {
      await cf(env, `/zones/${env.CF_ZONE_ID}/dns_records/${record.id}`, { method: "DELETE" });
    }
    // Removing the device means it has left the fleet, so tear the connector down
    // with it. Cloudflare refuses to delete a Tunnel that still has connections,
    // so drop them first; this severs the device's live cloudflared connector and
    // lets the Tunnel delete cleanly instead of orphaning.
    await cf(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${access.tunnel_id}/connections`, { method: "DELETE" })
      .catch(() => {});
    await cf(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${access.tunnel_id}`, { method: "DELETE" });
  } catch (error) {
    // Device deletion must not be blocked by a stale or already-deleted CF resource.
    console.error(JSON.stringify({ event: "remote_access_cleanup_failed", tunnel_id: access.tunnel_id, error: String(error) }));
  }
}

export function remoteAccessConfigured(env: Env): boolean { return configuredRemoteAccess(env); }
