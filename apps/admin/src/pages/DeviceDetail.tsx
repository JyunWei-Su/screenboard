import { useParams } from "react-router-dom";
import { api, contentUrl } from "../api";
import { useFetch } from "../hooks";
import { canWrite, useAuth } from "../auth";
import { StatusBadge } from "./Devices";

interface Device {
  uuid: string;
  name: string;
  status: string;
  hostname: string;
  serial: string;
  os_version: string;
  agent_version: string;
  ip: string;
  mac: string;
  resolution: string;
  group_id: number | null;
  playlist_id: number | null;
  display: string;
  last_seen_at: string | null;
  health?: { cpu: number; memory: number; disk: number; uptime: number; ts: string } | null;
  active_playlist_id: number | null;
}
interface ScreenshotRow { id: number; taken_at: string; analysis: string | null; trigger: string }
interface CommandRow { id: string; type: string; status: string; issued_at: string }
interface NamedRow { id: number; name: string }
interface RemoteAccess {
  configured: boolean;
  enabled: boolean;
  hostname?: string;
  status?: string;
  last_error?: string | null;
  needs_reprovision?: boolean;
}

const COMMANDS: { type: string; label: string; danger?: boolean }[] = [
  { type: "reload", label: "Reload" },
  { type: "restart_player", label: "Restart player" },
  { type: "switch_playlist", label: "Resync playlist" },
  { type: "take_screenshot", label: "Screenshot" },
  { type: "check_update", label: "Check update now" },
  { type: "reboot", label: "Reboot", danger: true },
  { type: "shutdown", label: "Shutdown", danger: true },
];

export default function DeviceDetail() {
  const { uuid } = useParams();
  const { user } = useAuth();
  const writable = canWrite(user);
  const { data: d, reload } = useFetch<Device>(`/api/devices/${uuid}`);
  const { data: shots, reload: reloadShots } = useFetch<ScreenshotRow[]>(
    `/api/screenshots?device_id=${uuid}&limit=12`,
  );
  const { data: cmds, reload: reloadCmds } = useFetch<CommandRow[]>(`/api/devices/${uuid}/commands`);
  const { data: groups } = useFetch<NamedRow[]>("/api/groups");
  const { data: playlists } = useFetch<NamedRow[]>("/api/playlists");
  const { data: remoteAccess, reload: reloadRemoteAccess } = useFetch<RemoteAccess>(
    writable ? `/api/devices/${uuid}/remote-access` : null,
  );

  if (!d) return <div className="text-slate-400">Loading…</div>;
  const display = safeParse(d.display);

  async function runCommand(type: string) {
    if ((type === "reboot" || type === "shutdown") && !confirm(`Send ${type}?`)) return;
    await api.post(`/api/devices/${uuid}/commands`, { type });
    setTimeout(reloadCmds, 500);
  }
  async function patch(body: Record<string, unknown>) {
    await api.patch(`/api/devices/${uuid}`, body);
    reload();
  }
  async function provisionRemoteAccess() {
    try {
      await api.post(`/api/devices/${uuid}/remote-access`);
      await reloadRemoteAccess();
    } catch (error) {
      alert(error instanceof Error ? error.message : "SSH provisioning failed");
      await reloadRemoteAccess();
    }
  }
  async function deleteScreenshot(id: number) {
    if (!confirm("Delete this screenshot? This cannot be undone.")) return;
    await api.del(`/api/screenshots/${id}`);
    await reloadShots();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">{d.name}</h1>
        <StatusBadge status={d.status} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Info</h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <Info k="UUID" v={d.uuid} mono />
            <Info k="Hostname" v={d.hostname} />
            <Info k="Serial" v={d.serial} />
            <Info k="OS" v={d.os_version} />
            <Info k="Agent" v={d.agent_version} />
            <Info k="IP" v={d.ip} />
            <Info k="MAC" v={d.mac} mono />
            <Info k="Resolution" v={d.resolution} />
            <Info k="Last seen" v={d.last_seen_at ?? "—"} />
            <Info k="Active playlist" v={d.active_playlist_id ? `#${d.active_playlist_id}` : "none"} />
          </dl>
          {d.health && (
            <div className="mt-4 grid grid-cols-3 gap-3">
              <Meter label="CPU" v={d.health.cpu} />
              <Meter label="Memory" v={d.health.memory} />
              <Meter label="Disk" v={d.health.disk} />
            </div>
          )}
        </div>

        <div className="card space-y-4">
          <div>
            <h2 className="mb-2 text-sm font-semibold text-slate-700">Remote actions</h2>
            <div className="flex flex-wrap gap-2">
              {COMMANDS.map((c) => (
                <button
                  key={c.type}
                  className={c.danger ? "btn-danger" : "btn-ghost"}
                  disabled={!writable}
                  onClick={() => runCommand(c.type)}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-700">SSH / Cloudflare Tunnel</h2>
              {writable && <button className="btn-ghost" onClick={() => reloadRemoteAccess()}>Refresh</button>}
            </div>
            {!writable && <p className="text-xs text-slate-400">Operator access is required.</p>}
            {writable && !remoteAccess && <p className="text-xs text-slate-400">Loading tunnel status…</p>}
            {remoteAccess && !remoteAccess.configured && (
              <p className="text-xs text-amber-600">Cloudflare remote access has not been configured on the API.</p>
            )}
            {remoteAccess?.configured && !remoteAccess.enabled && (
              <div className="space-y-2">
                <p className="text-xs text-slate-400">No Tunnel is provisioned for this device yet.</p>
                {user?.role === "admin" && <button className="btn-primary" onClick={() => void provisionRemoteAccess()}>Provision SSH</button>}
              </div>
            )}
            {remoteAccess?.enabled && (
              <div className="space-y-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className={`inline-block h-2 w-2 rounded-full ${remoteAccess.status === "healthy" ? "bg-emerald-500" : "bg-amber-500"}`} />
                  <span className="capitalize">{remoteAccess.status ?? "unknown"}</span>
                </div>
                <div className="break-all font-mono text-slate-500">{remoteAccess.hostname}</div>
                {remoteAccess.needs_reprovision && (
                  <p className="text-amber-600">This legacy SSH hostname is not covered by the Cloudflare certificate. Reprovision SSH to migrate it.</p>
                )}
                <a className="btn-primary inline-flex" href={`https://${remoteAccess.hostname}`} target="_blank" rel="noreferrer">
                  Open SSH terminal
                </a>
                {remoteAccess.status === "inactive" && (
                  <p className="text-slate-500">Tunnel is waiting for cloudflared on the device. Re-run the device installer, then check <code>systemctl status cloudflared</code>.</p>
                )}
                {user?.role === "admin" && (remoteAccess.status === "error" || remoteAccess.last_error || remoteAccess.needs_reprovision) && (
                  <button className="btn-ghost" onClick={() => void provisionRemoteAccess()}>Reprovision SSH</button>
                )}
                {remoteAccess.last_error && <p className="text-amber-600">{remoteAccess.last_error}</p>}
              </div>
            )}
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-slate-700">Assignment</h2>
            <label className="mb-1 block text-xs text-slate-500">Group</label>
            <select
              className="input mb-2"
              disabled={!writable}
              value={d.group_id ?? ""}
              onChange={(e) => patch({ group_id: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">— none —</option>
              {(groups ?? []).map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
            <label className="mb-1 block text-xs text-slate-500">Default playlist</label>
            <select
              className="input"
              disabled={!writable}
              value={d.playlist_id ?? ""}
              onChange={(e) => patch({ playlist_id: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">— none —</option>
              {(playlists ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-slate-700">Display</h2>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={display.kiosk}
                  disabled={!writable}
                  onChange={(e) => patch({ display: { ...display, kiosk: e.target.checked } })}
                />
                Kiosk
              </label>
              <label className="flex items-center gap-2">
                Zoom
                <input
                  className="input"
                  type="number"
                  step="0.1"
                  value={display.zoom}
                  disabled={!writable}
                  onChange={(e) => patch({ display: { ...display, zoom: Number(e.target.value) } })}
                />
              </label>
              <label className="col-span-2 flex items-center gap-2">
                Rotate
                <select
                  className="input"
                  value={display.rotate}
                  disabled={!writable}
                  onChange={(e) => patch({ display: { ...display, rotate: Number(e.target.value) } })}
                >
                  {[0, 90, 180, 270].map((r) => (
                    <option key={r} value={r}>{r}°</option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700">Recent screenshots</h2>
          <button className="btn-ghost" onClick={() => reloadShots()}>Refresh</button>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {(shots ?? []).map((s) => (
            <div key={s.id}>
              <a href={contentUrl(`/api/content/screenshots/${s.id}`)} target="_blank" rel="noreferrer">
                <img
                  src={contentUrl(`/api/content/screenshots/${s.id}`)}
                  className={`aspect-video w-full rounded border object-cover ${
                    s.analysis === "black_screen" ? "border-red-400" : "border-slate-200"
                  }`}
                  alt={s.taken_at}
                />
              </a>
              <div className="mt-1 flex items-center justify-between gap-1 text-[10px] text-slate-400">
                <span>{s.taken_at}</span>
                {writable && <button className="text-red-600 hover:underline" onClick={() => void deleteScreenshot(s.id)}>Delete</button>}
              </div>
            </div>
          ))}
          {shots && shots.length === 0 && (
            <div className="col-span-full text-sm text-slate-400">No screenshots yet.</div>
          )}
        </div>
      </div>

      <div className="card">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Command history</h2>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">Time</th>
              <th className="th">Type</th>
              <th className="th">Status</th>
            </tr>
          </thead>
          <tbody>
            {(cmds ?? []).map((c) => (
              <tr key={c.id}>
                <td className="td whitespace-nowrap text-xs">{c.issued_at}</td>
                <td className="td">{c.type}</td>
                <td className="td">{c.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Info({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-slate-400">{k}</dt>
      <dd className={mono ? "font-mono text-xs" : ""}>{v || "—"}</dd>
    </div>
  );
}

function Meter({ label, v }: { label: string; v: number }) {
  const pct = Math.min(100, Math.round(v));
  const color = pct > 90 ? "bg-red-500" : pct > 70 ? "bg-amber-500" : "bg-brand-500";
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs text-slate-500">
        <span>{label}</span>
        <span>{pct}%</span>
      </div>
      <div className="h-2 w-full rounded bg-slate-100">
        <div className={`h-2 rounded ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function safeParse(s: string): { kiosk: boolean; zoom: number; rotate: number; screen: number } {
  try {
    return JSON.parse(s);
  } catch {
    return { kiosk: true, zoom: 1, rotate: 0, screen: 0 };
  }
}
