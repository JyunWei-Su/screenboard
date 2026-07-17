import { useParams, Link } from "react-router-dom";
import { api, contentUrl } from "../api";
import { useFetch } from "../hooks";
import { canWrite, useAuth } from "../auth";
import { TableCard } from "../components/ui";
import { commandStatusLabels, label, tunnelStatusLabels } from "../labels";
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
  { type: "reload", label: "重新載入" },
  { type: "restart_player", label: "重新啟動播放器" },
  { type: "switch_playlist", label: "重新同步播放清單" },
  { type: "take_screenshot", label: "截圖" },
  { type: "check_update", label: "立即檢查更新" },
  { type: "repair_tunnel", label: "修復 SSH 連線" },
  { type: "reboot", label: "重新開機", danger: true },
  { type: "shutdown", label: "關機", danger: true },
  { type: "reinstall", label: "重新安裝", danger: true },
];

// Commands heavy enough to warrant a confirmation prompt.
const CONFIRM_COMMANDS = new Set(["reboot", "shutdown", "reinstall"]);

const commandTypeLabels: Record<string, string> = Object.fromEntries(
  COMMANDS.map((c) => [c.type, c.label]),
);

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

  if (!d) return <div className="text-slate-400">載入中…</div>;
  const display = safeParse(d.display);

  async function runCommand(type: string) {
    if (CONFIRM_COMMANDS.has(type) && !confirm(`要送出「${label(commandTypeLabels, type)}」嗎?`)) return;
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
      alert(error instanceof Error ? error.message : "SSH 佈建失敗");
      await reloadRemoteAccess();
    }
  }
  async function deleteScreenshot(id: number) {
    if (!confirm("要刪除這張截圖嗎?此操作無法復原。")) return;
    await api.del(`/api/screenshots/${id}`);
    await reloadShots();
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/devices" className="text-sm text-slate-400 hover:text-brand-600 hover:underline">
          裝置
        </Link>
        <span className="text-slate-300">/</span>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{d.name}</h1>
        <StatusBadge status={d.status} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">資訊</h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <Info k="UUID" v={d.uuid} mono />
            <Info k="主機名稱" v={d.hostname} />
            <Info k="序號" v={d.serial} />
            <Info k="OS" v={d.os_version} />
            <Info k="Agent" v={d.agent_version} />
            <Info k="IP" v={d.ip} />
            <Info k="MAC" v={d.mac} mono />
            <Info k="解析度" v={d.resolution} />
            <Info k="最後上線" v={d.last_seen_at ?? "—"} />
            <Info k="使用中播放清單" v={d.active_playlist_id ? `#${d.active_playlist_id}` : "無"} />
          </dl>
          {d.health && (
            <div className="mt-4 grid grid-cols-3 gap-3">
              <Meter label="CPU" v={d.health.cpu} />
              <Meter label="記憶體" v={d.health.memory} />
              <Meter label="磁碟" v={d.health.disk} />
            </div>
          )}
        </div>

        <div className="card space-y-4">
          <div>
            <h2 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">遠端操作</h2>
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
              <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">SSH / Cloudflare Tunnel</h2>
              {writable && <button className="btn-ghost" onClick={() => reloadRemoteAccess()}>重新整理</button>}
            </div>
            {!writable && <p className="text-xs text-slate-400">需要操作員權限。</p>}
            {writable && !remoteAccess && <p className="text-xs text-slate-400">正在載入 Tunnel 狀態…</p>}
            {remoteAccess && !remoteAccess.configured && (
              <p className="text-xs text-amber-600">API 尚未設定 Cloudflare 遠端存取。</p>
            )}
            {remoteAccess?.configured && !remoteAccess.enabled && (
              <div className="space-y-2">
                <p className="text-xs text-slate-400">此裝置尚未佈建 Tunnel。</p>
                {user?.role === "admin" && <button className="btn-primary" onClick={() => void provisionRemoteAccess()}>佈建 SSH</button>}
              </div>
            )}
            {remoteAccess?.enabled && (
              <div className="space-y-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className={`inline-block h-2 w-2 rounded-full ${remoteAccess.status === "healthy" ? "bg-emerald-500" : "bg-amber-500"}`} />
                  <span>{label(tunnelStatusLabels, remoteAccess.status ?? "unknown")}</span>
                </div>
                <div className="break-all font-mono text-slate-500">{remoteAccess.hostname}</div>
                {remoteAccess.needs_reprovision && (
                  <p className="text-amber-600">此舊版 SSH 主機名稱未涵蓋於 Cloudflare 憑證中。請重新佈建 SSH 以進行遷移。</p>
                )}
                <a className="btn-primary inline-flex" href={`https://${remoteAccess.hostname}`} target="_blank" rel="noreferrer">
                  開啟 SSH 終端機
                </a>
                {remoteAccess.status === "inactive" && (
                  <p className="text-slate-500">Tunnel 正在等待裝置上的 cloudflared。請重新執行裝置安裝程式,然後檢查 <code>systemctl status cloudflared</code>。</p>
                )}
                {user?.role === "admin" && (remoteAccess.status === "error" || remoteAccess.last_error || remoteAccess.needs_reprovision) && (
                  <button className="btn-ghost" onClick={() => void provisionRemoteAccess()}>重新佈建 SSH</button>
                )}
                {remoteAccess.last_error && <p className="text-amber-600">{remoteAccess.last_error}</p>}
              </div>
            )}
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">指派</h2>
            <label className="mb-1 block text-xs text-slate-500">群組</label>
            <select
              className="input mb-2"
              disabled={!writable}
              value={d.group_id ?? ""}
              onChange={(e) => patch({ group_id: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">— 無 —</option>
              {(groups ?? []).map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
            <label className="mb-1 block text-xs text-slate-500">預設播放清單</label>
            <select
              className="input"
              disabled={!writable}
              value={d.playlist_id ?? ""}
              onChange={(e) => patch({ playlist_id: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">— 無 —</option>
              {(playlists ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">顯示</h2>
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
                縮放
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
                旋轉
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
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">最近截圖</h2>
          <button className="btn-ghost" onClick={() => reloadShots()}>重新整理</button>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {(shots ?? []).map((s) => (
            <div key={s.id}>
              <a href={contentUrl(`/api/content/screenshots/${s.id}`)} target="_blank" rel="noreferrer">
                <img
                  src={contentUrl(`/api/content/screenshots/${s.id}`)}
                  className={`aspect-video w-full rounded border object-cover ${
                    s.analysis === "black_screen" ? "border-red-400" : "border-slate-200 dark:border-dark-border"
                  }`}
                  alt={s.taken_at}
                />
              </a>
              <div className="mt-1 flex items-center justify-between gap-1 text-[10px] text-slate-400">
                <span>{s.taken_at}</span>
                {writable && <button className="text-red-600 hover:underline" onClick={() => void deleteScreenshot(s.id)}>刪除</button>}
              </div>
            </div>
          ))}
          {shots && shots.length === 0 && (
            <div className="col-span-full text-sm text-slate-400">尚無截圖。</div>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="card-title">指令歷史</h2>
        <TableCard>
          <table className="w-full min-w-[420px]">
            <thead>
              <tr>
                <th className="th">時間</th>
                <th className="th">類型</th>
                <th className="th">狀態</th>
              </tr>
            </thead>
            <tbody>
              {(cmds ?? []).map((c) => (
                <tr key={c.id}>
                  <td className="td whitespace-nowrap text-xs">{c.issued_at}</td>
                  <td className="td">{label(commandTypeLabels, c.type)}</td>
                  <td className="td">{label(commandStatusLabels, c.status)}</td>
                </tr>
              ))}
              {cmds && cmds.length === 0 && (
                <tr className="hover:bg-transparent">
                  <td className="td px-4 py-6 text-center text-sm text-slate-400" colSpan={3}>
                    尚未送出任何指令。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableCard>
      </div>
    </div>
  );
}

function Info({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-slate-400 dark:text-dark-subtle">{k}</dt>
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
      <div className="h-2 w-full rounded bg-slate-100 dark:bg-dark-raised">
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
