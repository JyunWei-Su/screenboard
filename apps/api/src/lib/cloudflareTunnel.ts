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

function configured(env: Env): boolean {
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

function allowedEmails(env: Env): string[] {
  return (env.CF_ACCESS_ALLOWED_EMAILS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function allowedSshUsers(env: Env): string[] {
  return [...new Set(allowedEmails(env)
    .map((email) => email.split("@", 1)[0].toLowerCase())
    .filter((name) => /^[a-z_][a-z0-9_-]{0,31}$/.test(name)))];
}

export async function provisionRemoteAccess(env: Env, device: { uuid: string; name: string }): Promise<{ ok: boolean; error?: string }> {
  if (!configured(env)) return { ok: false, error: "remote_access_not_configured" };
  const emails = allowedEmails(env);
  const sshUsers = allowedSshUsers(env);
  if (!emails.length || !sshUsers.length) {
    return { ok: false, error: "CF_ACCESS_ALLOWED_EMAILS must contain at least one valid Linux username prefix" };
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
        name: `ScreenBoard SSH: ${device.name}`,
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
      `INSERT INTO device_remote_access (device_id, tunnel_id, access_app_id, hostname, status, ssh_ca_public_key, provisioning_version)
       VALUES (?, ?, ?, ?, 'inactive', ?, 3)`,
    ).bind(device.uuid, tunnel.id, app.id, hostname, ca.public_key).run();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "remote_access_provision_failed", device_id: device.uuid, error: message }));
    if (tunnel) {
      await env.DB.prepare(
        `INSERT INTO device_remote_access (device_id, tunnel_id, access_app_id, hostname, status, last_error, provisioning_version)
         VALUES (?, ?, ?, ?, 'error', ?, 3) ON CONFLICT(device_id) DO UPDATE SET status='error', last_error=excluded.last_error, provisioning_version=excluded.provisioning_version, updated_at=datetime('now')`,
      ).bind(device.uuid, tunnel.id, app?.id ?? null, hostname, message).run();
    }
    return { ok: false, error: message };
  }
}

export async function getTunnelStatus(env: Env, tunnelId: string): Promise<string | null> {
  if (!configured(env)) return null;
  const tunnel = await cf<TunnelResult>(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}`);
  return tunnel.status || "inactive";
}

export async function createTunnelToken(env: Env, tunnelId: string): Promise<string | null> {
  if (!configured(env)) return null;
  // This is the connector token consumed by `cloudflared service install`.
  // The /management endpoint returns a different token for management APIs.
  return cf<string>(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/token`);
}

export async function removeRemoteAccess(
  env: Env,
  access: { tunnel_id: string; access_app_id: string | null; hostname: string },
): Promise<void> {
  if (!configured(env)) return;
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
    await cf(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${access.tunnel_id}`, { method: "DELETE" });
  } catch (error) {
    // Device deletion must not be blocked by a stale or already-deleted CF resource.
    console.error(JSON.stringify({ event: "remote_access_cleanup_failed", tunnel_id: access.tunnel_id, error: String(error) }));
  }
}

export function remoteAccessConfigured(env: Env): boolean { return configured(env); }
