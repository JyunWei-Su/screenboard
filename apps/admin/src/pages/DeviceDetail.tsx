import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { api, apiBase, contentUrl } from "../api";
import { useFetch } from "../hooks";
import { canWrite, useAuth } from "../auth";
import { TableCard } from "../components/ui";
import { assignSourceLabels, commandStatusLabels, label, tunnelStatusLabels } from "../labels";
import { StatusBadge } from "./Devices";
import { useToast } from "../toast";

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
  protocol_version?: number | null;
  agent_capabilities?: string | null;
  group_id: number | null;
  // New scene assignment fields (migration 0008). `source_type` drives which one
  // is active; the API clears the other two when the source type is switched.
  source_type?: "scene" | "scene_playlist";
  scene_id?: number | null;
  scene_playlist_id?: number | null;
  display: string;
  agent_settings: string;
  last_seen_at: string | null;
  health?: {
    cpu: number; memory: number; disk: number; uptime: number; ts: string;
    temperature?: number | null;
    chromium_status?: string | null;
    browser_restart_count?: number | null;
    browser_last_exit_at?: string | null;
    last_sync_success_at?: string | null;
    cache_used_bytes?: number | null;
    cache_limit_bytes?: number | null;
  } | null;
}
interface ScreenshotRow { id: number; taken_at: string; analysis: string | null; trigger: string }
interface CommandRow { id: string; type: string; status: string; detail?: string | null; issued_at: string }
interface CommandPage { items: CommandRow[]; page: number; limit: number; total: number; total_pages: number }
interface NamedRow { id: number; name: string }
interface AgentSettings {
  health_interval_sec: number;
  device_info_interval_sec: number;
  playlist_poll_sec: number;
  heartbeat_interval_sec: number;
  screenshot_interval_sec: number;
  ota_check_sec: number;
}
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
  { type: "take_screenshot", label: "截圖" },
  { type: "check_update", label: "立即檢查更新" },
  { type: "sync_time", label: "NTP 對時" },
  { type: "reboot", label: "重新開機", danger: true },
  { type: "shutdown", label: "關機", danger: true },
  { type: "reinstall", label: "重新安裝", danger: true },
];

// Commands heavy enough to warrant a confirmation prompt.
const CONFIRM_COMMANDS = new Set(["reboot", "shutdown", "reinstall"]);

const commandTypeLabels: Record<string, string> = Object.fromEntries(
  COMMANDS.map((c) => [c.type, c.label]),
);
commandTypeLabels.apply_agent_settings = "套用週期設定";
commandTypeLabels.set_hostname = "修改主機名稱";
commandTypeLabels.repair_tunnel = "修復 SSH 連線";

export default function DeviceDetail() {
  const { uuid } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const writable = canWrite(user);
  const isAdmin = user?.role === "admin";
  const { showToast } = useToast();
  const uninstallCommand = `curl -fsSL ${apiBase() || "https://YOUR-API"}/uninstall.sh | sudo bash`;
  const { data: d, reload } = useFetch<Device>(`/api/devices/${uuid}`);
  const { data: shots, reload: reloadShots } = useFetch<ScreenshotRow[]>(
    `/api/screenshots?device_id=${uuid}&limit=12`,
  );
  const [commandPage, setCommandPage] = useState(1);
  const { data: commandHistory, reload: reloadCmds } = useFetch<CommandPage>(
    `/api/devices/${uuid}/commands?page=${commandPage}&limit=20`,
  );
  const { data: groups } = useFetch<NamedRow[]>("/api/groups");
  const { data: scenes } = useFetch<NamedRow[]>("/api/scenes");
  const { data: scenePlaylists } = useFetch<NamedRow[]>("/api/scene-playlists");
  const { data: remoteAccess, reload: reloadRemoteAccess } = useFetch<RemoteAccess>(
    writable ? `/api/devices/${uuid}/remote-access` : null,
  );
  const [agentSettings, setAgentSettings] = useState<AgentSettings>(DEFAULT_AGENT_SETTINGS);
  const [selectedScreenshotIds, setSelectedScreenshotIds] = useState<Set<number>>(new Set());
  const [selectedCommandIds, setSelectedCommandIds] = useState<Set<string>>(new Set());
  const [hostname, setHostname] = useState("");
  const [name, setName] = useState("");
  const [actionBusy, setActionBusy] = useState(false);

  useEffect(() => {
    if (d) setAgentSettings(safeAgentSettings(d.agent_settings));
  }, [d?.uuid, d?.agent_settings]);

  useEffect(() => {
    if (d) setHostname(d.hostname);
  }, [d?.uuid, d?.hostname]);

  useEffect(() => {
    if (d) setName(d.name);
  }, [d?.uuid, d?.name]);

  useEffect(() => {
    setSelectedScreenshotIds((selected) => new Set(
      [...selected].filter((id) => (shots ?? []).some((shot) => shot.id === id)),
    ));
  }, [shots]);

  if (!d) return <div className="text-slate-400">載入中…</div>;
  const display = safeParse(d.display);

  async function watchCommand(commandId: string, description: string) {
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        const command = await api.get<CommandRow>(`/api/devices/${uuid}/commands/${commandId}`);
        if (command.status === "acked") {
          showToast(`${description}已完成${command.detail ? `：${command.detail}` : "。"}`, "success");
          void reloadCmds();
          return;
        }
        if (command.status === "failed") {
          showToast(`${description}失敗${command.detail ? `：${command.detail}` : "。"}`, "error");
          void reloadCmds();
          return;
        }
      } catch {
        return;
      }
    }
  }

  async function runCommand(type: string) {
    if (CONFIRM_COMMANDS.has(type) && !confirm(`要送出「${label(commandTypeLabels, type)}」嗎?`)) return;
    setActionBusy(true);
    try {
      const result = await api.post<{ id: string; delivered: boolean }>(`/api/devices/${uuid}/commands`, { type });
      showToast(result.delivered ? "指令已送達裝置，等待執行結果。" : "指令已排入佇列，裝置連線後會執行。", "info");
      setTimeout(reloadCmds, 500);
      setTimeout(reloadCmds, 2500);
      void watchCommand(result.id, label(commandTypeLabels, type));
    } catch (error) {
      showToast(error instanceof Error ? error.message : "送出指令失敗", "error");
    } finally {
      setActionBusy(false);
    }
  }
  async function patch(body: Record<string, unknown>) {
    try {
      await api.patch(`/api/devices/${uuid}`, body);
      showToast("設定已儲存；需要套用至裝置的設定已送出。", "success");
      reload();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "儲存設定失敗", "error");
    }
  }
  async function saveAgentSettings() {
    await patch({ agent_settings: agentSettings });
    setTimeout(reloadCmds, 500);
  }
  async function provisionRemoteAccess() {
    try {
      const result = await api.post<{ action: "connector_repair" | "reprovision_and_repair"; repair?: { id: string; delivered?: boolean } }>(`/api/devices/${uuid}/remote-access`);
      const prefix = result.action === "reprovision_and_repair" ? "SSH 設定已重新佈建，" : "正在修復裝置端 SSH 連線，";
      showToast(result.repair?.delivered ? `${prefix}等待裝置執行結果。` : `${prefix}裝置連線後會自動套用。`, "info");
      await reloadRemoteAccess();
      setTimeout(reloadCmds, 500);
      setTimeout(reloadCmds, 2500);
      if (result.repair?.id) void watchCommand(result.repair.id, "SSH 修復");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "SSH 修復失敗", "error");
      await reloadRemoteAccess();
    }
  }
  async function updateName() {
    const next = name.trim();
    if (!next) {
      showToast("裝置名稱不可為空。", "error");
      return;
    }
    if (next === d?.name) return;
    setActionBusy(true);
    try {
      await api.patch(`/api/devices/${uuid}`, { name: next });
      showToast("已更新裝置名稱。", "success");
      reload();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "更新裝置名稱失敗", "error");
    } finally {
      setActionBusy(false);
    }
  }
  async function updateHostname() {
    const next = hostname.trim();
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(next)) {
      showToast("主機名稱須為 1–63 個英數或連字號，且不能以連字號開頭或結尾。", "error");
      return;
    }
    if (!confirm(`要將主機名稱改為「${next}」並重新開機嗎？`)) return;
    setActionBusy(true);
    try {
      const result = await api.post<{ id: string; delivered: boolean }>(`/api/devices/${uuid}/commands`, { type: "set_hostname", payload: { hostname: next, reboot: true } });
      showToast(result.delivered ? "主機名稱變更已送達裝置，裝置即將重新開機。" : "主機名稱變更已排入佇列，裝置連線後會執行並重新開機。", "info");
      setTimeout(reloadCmds, 500);
      setTimeout(reloadCmds, 2500);
      void watchCommand(result.id, "主機名稱變更");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "修改主機名稱失敗", "error");
    } finally {
      setActionBusy(false);
    }
  }
  async function deleteScreenshot(id: number) {
    if (!confirm("要刪除這張截圖嗎?此操作無法復原。")) return;
    await api.del(`/api/screenshots/${id}`);
    await reloadShots();
  }
  function toggleScreenshot(id: number) {
    setSelectedScreenshotIds((selected) => {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function selectAllScreenshots() {
    const ids = (shots ?? []).map((shot) => shot.id);
    const allSelected = ids.length > 0 && ids.every((id) => selectedScreenshotIds.has(id));
    setSelectedScreenshotIds(allSelected ? new Set() : new Set(ids));
  }
  async function deleteSelectedScreenshots() {
    const ids = [...selectedScreenshotIds];
    if (!ids.length || !confirm(`要刪除選取的 ${ids.length} 張截圖嗎？此操作無法復原。`)) return;
    await api.del("/api/screenshots/batch", { ids });
    setSelectedScreenshotIds(new Set());
    await reloadShots();
  }
  async function deleteCommand(id: string) {
    if (!confirm("要刪除這筆指令歷史嗎？這不會取消已送到裝置的指令。")) return;
    await api.del(`/api/devices/${uuid}/commands/${id}`);
    await reloadCmds();
  }
  function toggleCommand(id: string) {
    setSelectedCommandIds((selected) => {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function selectAllCommands() {
    const ids = (commandHistory?.items ?? []).map((command) => command.id);
    const allSelected = ids.length > 0 && ids.every((id) => selectedCommandIds.has(id));
    setSelectedCommandIds(allSelected ? new Set() : new Set(ids));
  }
  async function deleteSelectedCommands() {
    const ids = [...selectedCommandIds];
    if (!ids.length || !confirm(`要刪除選取的 ${ids.length} 筆指令歷史嗎？這不會取消已送到裝置的指令。`)) return;
    await api.del(`/api/devices/${uuid}/commands/batch`, { ids });
    setSelectedCommandIds(new Set());
    await reloadCmds();
  }
  async function copyUninstall() {
    try {
      await navigator.clipboard.writeText(uninstallCommand);
      showToast("已複製解除安裝指令", "success");
    } catch {
      showToast("複製失敗，請手動選取指令。", "error");
    }
  }
  async function removeDevice() {
    if (!d) return;
    if (!confirm(
      `確定要移除裝置「${d.name}」嗎?\n\n` +
      "這會刪除此裝置在主控台的所有紀錄(健康、截圖、指令、排程、SSH Tunnel),且無法復原。\n" +
      "實體裝置仍會繼續播放 — 請先在裝置上執行解除安裝指令,或先送出「關機」。",
    )) return;
    setActionBusy(true);
    try {
      await api.del(`/api/devices/${uuid}`);
      showToast("裝置已移除。", "success");
      navigate("/devices");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "移除裝置失敗", "error");
      setActionBusy(false);
    }
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
        <div className="space-y-6 lg:col-span-2">
          <div className="card">
            <h2 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">資訊</h2>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <Info k="UUID" v={d.uuid} mono />
              <Info k="主機名稱" v={d.hostname} />
              <Info k="序號" v={d.serial} />
              <Info k="OS" v={d.os_version} />
              <Info k="Agent" v={d.agent_version} />
              <Info k="Local IP" v={d.ip} />
              <Info k="MAC" v={d.mac} mono />
              <Info k="解析度" v={d.resolution} />
              <Info k="最後上線" v={d.last_seen_at ?? "—"} />
            </dl>
            <div className="mt-4 border-t border-slate-100 pt-4 dark:border-dark-border">
              <label className="mb-1 block text-xs text-slate-500">裝置名稱</label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  className="input min-w-0 flex-1"
                  value={name}
                  disabled={!writable || actionBusy}
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void updateName();
                  }}
                />
                {writable && (
                  <button className="btn-primary shrink-0" disabled={actionBusy || !name.trim() || name.trim() === d.name} onClick={() => void updateName()}>
                    儲存名稱
                  </button>
                )}
              </div>
              <p className="mt-1 text-xs text-slate-400">主控台顯示用的名稱，不會重新開機，也不影響裝置作業系統的主機名稱。</p>
            </div>
            <div className="mt-4 border-t border-slate-100 pt-4 dark:border-dark-border">
              <label className="mb-1 block text-xs text-slate-500">主機名稱</label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  className="input min-w-0 flex-1"
                  value={hostname}
                  disabled={!writable || actionBusy}
                  maxLength={63}
                  pattern="[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
                  onChange={(e) => setHostname(e.target.value)}
                />
                {writable && (
                  <button className="btn-primary shrink-0" disabled={actionBusy || hostname.trim() === d.hostname} onClick={() => void updateHostname()}>
                    儲存並重新開機
                  </button>
                )}
              </div>
              <p className="mt-1 text-xs text-slate-400">變更裝置作業系統的主機名稱，會立即重新開機以完成套用。</p>
            </div>
            {d.health && (
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Meter label="CPU" v={d.health.cpu} />
                <Info k="Chromium" v={d.health.chromium_status ?? "—"} />
                <Info k="Browser restarts" v={String(d.health.browser_restart_count ?? 0)} />
                <Info k="Last browser exit" v={d.health.browser_last_exit_at ?? "—"} />
                <Info k="Last content sync" v={d.health.last_sync_success_at ?? "—"} />
                <Info k="Temperature" v={d.health.temperature == null ? "—" : `${d.health.temperature.toFixed(1)} °C`} />
                <Info k="Cache" v={`${d.health.cache_used_bytes ?? 0} / ${d.health.cache_limit_bytes ?? 0} bytes`} />
                <Meter label="記憶體" v={d.health.memory} />
                <Meter label="磁碟" v={d.health.disk} />
              </div>
            )}
          </div>

          <div className="card">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
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
                {remoteAccess.last_error && <p className="text-amber-600">{remoteAccess.last_error}</p>}
              </div>
            )}
            {user?.role === "admin" && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  className="btn-primary"
                  disabled={!remoteAccess?.configured || actionBusy}
                  onClick={() => void provisionRemoteAccess()}
                >
                  修復 SSH
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="card space-y-4">
          <div>
            <h2 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">遠端操作</h2>
            <div className="flex flex-wrap gap-2">
              {COMMANDS.map((c) => (
                <button
                  key={c.type}
                  className={c.danger ? "btn-danger" : "btn-ghost"}
                  disabled={!writable || actionBusy}
                  onClick={() => runCommand(c.type)}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">指派</h2>
            <label className="mb-1 block text-xs text-slate-500">裝置群組</label>
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
            <label className="mb-1 block text-xs text-slate-500">指派來源</label>
            <select
              className="input mb-2"
              disabled={!writable}
              value={d.source_type ?? "scene"}
              onChange={(e) => {
                const st = e.target.value as "scene" | "scene_playlist";
                // Keep any id already stored for that source type when switching.
                const keep =
                  st === "scene"
                      ? { scene_id: d.scene_id ?? null }
                      : { scene_playlist_id: d.scene_playlist_id ?? null };
                patch({ source_type: st, ...keep });
              }}
            >
              <option value="scene">{label(assignSourceLabels, "scene")}</option>
              <option value="scene_playlist">{label(assignSourceLabels, "scene_playlist")}</option>
            </select>

            {d.source_type === "scene" && (
              <select
                className="input"
                disabled={!writable}
                value={d.scene_id ?? ""}
                onChange={(e) =>
                  patch({
                    source_type: "scene",
                    scene_id: e.target.value ? Number(e.target.value) : null,
                  })
                }
              >
                <option value="">— 無 —</option>
                {(scenes ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            )}
            {d.source_type === "scene_playlist" && (
              <select
                className="input"
                disabled={!writable}
                value={d.scene_playlist_id ?? ""}
                onChange={(e) =>
                  patch({
                    source_type: "scene_playlist",
                    scene_playlist_id: e.target.value ? Number(e.target.value) : null,
                  })
                }
              >
                <option value="">— 無 —</option>
                {(scenePlaylists ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            )}
            <p className="mt-2 text-xs text-slate-400">
              裝置同一時刻只會解析出一個有效來源。切換來源類型會清除其他來源的指派。播放清單欄位於遷移期間保留。
            </p>
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">顯示</h2>
            <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
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

          <div>
            <h2 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">監控與更新週期</h2>
            <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              <IntervalInput label="健康回報" value={agentSettings.health_interval_sec} min={10} onChange={(value) => setAgentSettings({ ...agentSettings, health_interval_sec: value })} disabled={!writable} />
              <IntervalInput label="裝置資訊（含解析度）回報" value={agentSettings.device_info_interval_sec} min={60} onChange={(value) => setAgentSettings({ ...agentSettings, device_info_interval_sec: value })} disabled={!writable} />
              <IntervalInput label="播放目標檢查" value={agentSettings.playlist_poll_sec} min={10} onChange={(value) => setAgentSettings({ ...agentSettings, playlist_poll_sec: value })} disabled={!writable} />
              <IntervalInput label="WebSocket 心跳" value={agentSettings.heartbeat_interval_sec} min={10} max={60} onChange={(value) => setAgentSettings({ ...agentSettings, heartbeat_interval_sec: value })} disabled={!writable} />
              <IntervalInput label="自動截圖" value={agentSettings.screenshot_interval_sec} min={0} onChange={(value) => setAgentSettings({ ...agentSettings, screenshot_interval_sec: value })} disabled={!writable} />
              <IntervalInput label="OTA 更新檢查" value={agentSettings.ota_check_sec} min={60} onChange={(value) => setAgentSettings({ ...agentSettings, ota_check_sec: value })} disabled={!writable} />
            </div>
            <p className="mt-2 text-xs text-slate-500">單位為秒；自動截圖填 0 即關閉。儲存後 Agent 會自動重啟並套用設定。</p>
            {writable && <button className="btn-primary mt-2" onClick={() => void saveAgentSettings()}>儲存週期設定</button>}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">最近截圖</h2>
          <div className="flex flex-wrap items-center gap-2">
            {writable && (
              <>
                <button className="btn-ghost" disabled={!shots?.length} onClick={selectAllScreenshots}>
                  {(shots?.length ?? 0) > 0 && shots!.every((shot) => selectedScreenshotIds.has(shot.id)) ? "取消全選" : "全選"}
                </button>
                <button className="btn-danger" disabled={!selectedScreenshotIds.size} onClick={() => void deleteSelectedScreenshots()}>
                  刪除選取（{selectedScreenshotIds.size}）
                </button>
              </>
            )}
            <button className="btn-ghost" onClick={() => reloadShots()}>重新整理</button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {(shots ?? []).map((s) => (
            <div key={s.id} className="relative">
              {writable && (
                <label className="absolute left-2 top-2 z-10 rounded bg-white/90 p-1 shadow dark:bg-slate-900/90">
                  <input
                    type="checkbox"
                    checked={selectedScreenshotIds.has(s.id)}
                    onChange={() => toggleScreenshot(s.id)}
                    aria-label={`選取 ${s.taken_at}`}
                  />
                </label>
              )}
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="card-title">指令歷史</h2>
          {writable && (
            <div className="flex gap-2">
              <button className="btn-ghost" onClick={selectAllCommands}>全選</button>
              <button className="btn-danger" disabled={!selectedCommandIds.size} onClick={() => void deleteSelectedCommands()}>
                刪除選取（{selectedCommandIds.size}）
              </button>
            </div>
          )}
        </div>
        <TableCard>
          <table className="w-full min-w-[420px]">
            <thead>
              <tr>
                {writable && <th className="th w-10" />}
                <th className="th">時間</th>
                <th className="th">類型</th>
                <th className="th">狀態</th>
                {writable && <th className="th">操作</th>}
              </tr>
            </thead>
            <tbody>
              {(commandHistory?.items ?? []).map((c) => (
                <tr key={c.id}>
                  {writable && (
                    <td className="td">
                      <input type="checkbox" checked={selectedCommandIds.has(c.id)} onChange={() => toggleCommand(c.id)} aria-label={`選取 ${c.type}`} />
                    </td>
                  )}
                  <td className="td whitespace-nowrap text-xs">{c.issued_at}</td>
                  <td className="td">{label(commandTypeLabels, c.type)}</td>
                  <td className="td">
                    <div>{label(commandStatusLabels, c.status)}</div>
                    {c.detail && <div className="mt-0.5 break-words text-xs text-slate-400">{c.detail}</div>}
                  </td>
                  {writable && (
                    <td className="td">
                      <button className="text-red-600 hover:underline" onClick={() => void deleteCommand(c.id)}>刪除</button>
                    </td>
                  )}
                </tr>
              ))}
              {commandHistory && commandHistory.items.length === 0 && (
                <tr className="hover:bg-transparent">
                  <td className="td px-4 py-6 text-center text-sm text-slate-400" colSpan={writable ? 5 : 3}>
                    尚未送出任何指令。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableCard>
        {commandHistory && (
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-500">
            <span>共 {commandHistory.total} 筆，第 {commandHistory.page} / {commandHistory.total_pages} 頁</span>
            <div className="flex gap-2">
              <button
                className="btn-ghost"
                disabled={commandHistory.page <= 1}
                onClick={() => setCommandPage((page) => Math.max(1, page - 1))}
              >上一頁</button>
              <button
                className="btn-ghost"
                disabled={commandHistory.page >= commandHistory.total_pages}
                onClick={() => setCommandPage((page) => Math.min(commandHistory.total_pages, page + 1))}
              >下一頁</button>
            </div>
          </div>
        )}
      </div>

      {isAdmin && (
        <div className="card border-red-200 dark:border-red-500/30">
          <h2 className="mb-2 text-sm font-semibold text-red-700 dark:text-red-400">危險區</h2>
          <p className="text-xs text-slate-500 dark:text-dark-subtle">
            移除裝置只會刪除主控台的紀錄;實體機器仍會繼續播放。若要一併清除裝置端的 Agent、Kiosk 與 SSH 設定,請先在該裝置上以 root 執行:
          </p>
          <div className="mt-2 flex items-start gap-2">
            <code className="block flex-1 break-all rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs dark:border-dark-border dark:bg-dark-raised dark:text-dark-text">
              {uninstallCommand}
            </code>
            <button type="button" className="btn-ghost btn-sm shrink-0" onClick={() => void copyUninstall()}>
              複製
            </button>
          </div>
          <div className="mt-3 border-t border-red-100 pt-3 dark:border-red-500/20">
            <button className="btn-danger" disabled={actionBusy} onClick={() => void removeDevice()}>
              移除裝置
            </button>
            <p className="mt-1 text-xs text-slate-400">刪除主控台的所有裝置紀錄,此操作無法復原。</p>
          </div>
        </div>
      )}
    </div>
  );
}

function Info({ k, v }: { k: string; v: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-slate-400 dark:text-dark-subtle">{k}</dt>
      <dd className="break-all text-sm text-slate-700 dark:text-dark-text">{v || "—"}</dd>
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

const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  health_interval_sec: 60,
  device_info_interval_sec: 300,
  playlist_poll_sec: 30,
  heartbeat_interval_sec: 30,
  screenshot_interval_sec: 0,
  ota_check_sec: 1800,
};

function safeAgentSettings(s: string): AgentSettings {
  try {
    const parsed = JSON.parse(s) as Partial<AgentSettings>;
    return { ...DEFAULT_AGENT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_AGENT_SETTINGS;
  }
}

function IntervalInput({ label, value, min, max = 86400, disabled, onChange }: { label: string; value: number; min: number; max?: number; disabled: boolean; onChange: (value: number) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-slate-500">{label}（秒）</span>
      <input className="input" type="number" min={min} max={max} step="1" value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}
