import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import { canWrite, useAuth } from "../auth";
import { EmptyRow, PageHeader, TableCard } from "../components/ui";
import { label, severityLabels } from "../labels";
import { IconAlertOctagon, IconAlertTriangle, IconInfo, IconMonitor } from "../components/icons";

interface Stats {
  total: number; online: number; offline: number; device_warning: number;
  info_events: number; warning_events: number; critical_events: number; online_rate: number;
}
interface EventRow { id: number; type: string; device_id: string | null; device_name: string | null; severity: string; message: string; created_at: string }
interface EventPage { items: EventRow[]; page: number; total: number; total_pages: number }
interface DeviceRow { uuid: string; name: string }
const severityBadge: Record<string, string> = { critical: "bg-red-100 text-red-700", warning: "bg-amber-100 text-amber-700" };

export default function Dashboard() {
  const { user } = useAuth();
  const writable = canWrite(user);
  const { data: stats, reload: reloadStats } = useFetch<Stats>("/api/dashboard/stats");
  const { data: devices } = useFetch<DeviceRow[]>("/api/devices");
  const [page, setPage] = useState(1);
  const [severity, setSeverity] = useState("");
  const [type, setType] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const params = new URLSearchParams({ unresolved: "1", page: String(page), limit: "20" });
  if (severity) params.set("severity", severity);
  if (type) params.set("type", type);
  if (deviceId) params.set("device_id", deviceId);
  if (query) params.set("q", query);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const { data: eventPage, loading, reload: reloadEvents } = useFetch<EventPage>(`/api/events?${params}`);

  useEffect(() => setSelectedIds(new Set()), [page, severity, type, deviceId, query, from, to]);
  function resetPage(action: () => void) { setPage(1); action(); }
  async function deleteEvent(id: number) {
    if (!confirm("要刪除這筆事件嗎？此操作無法復原。")) return;
    await api.del(`/api/events/${id}`);
    await Promise.all([reloadEvents(), reloadStats()]);
  }
  function toggleEvent(id: number) {
    setSelectedIds((selected) => {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function selectAllEvents() {
    const ids = eventPage?.items.map((event) => event.id) ?? [];
    setSelectedIds(ids.length && ids.every((id) => selectedIds.has(id)) ? new Set() : new Set(ids));
  }
  async function deleteSelectedEvents() {
    const ids = [...selectedIds];
    if (!ids.length || !confirm(`要刪除選取的 ${ids.length} 筆事件嗎？此操作無法復原。`)) return;
    await api.del("/api/events/batch", { ids });
    setSelectedIds(new Set());
    if (eventPage && eventPage.items.length === ids.length && page > 1) setPage(page - 1);
    else await Promise.all([reloadEvents(), reloadStats()]);
  }
  function clearFilters() {
    setPage(1); setSeverity(""); setType(""); setDeviceId(""); setQuery(""); setFrom(""); setTo("");
  }

  return <div className="space-y-6">
    <PageHeader title="儀表板" subtitle="裝置總覽與未處理事件" />
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className="card"><div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-dark-text"><IconMonitor className="h-5 w-5 text-brand-600" />裝置總覽</div><div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4"><Metric label="總數" value={stats?.total ?? "—"} /><Metric label="上線" value={stats?.online ?? "—"} tone="text-emerald-600" /><Metric label="離線" value={stats?.offline ?? "—"} tone="text-slate-500" /><Metric label="上線率" value={stats ? `${Math.round(stats.online_rate * 100)}%` : "—"} tone="text-brand-600" /></div>{(stats?.device_warning ?? 0) > 0 && <p className="mt-3 text-xs text-amber-600">另有 {stats?.device_warning ?? 0} 台裝置處於警告狀態</p>}</div>
      <div className="card"><div className="mb-3 text-sm font-semibold text-slate-700 dark:text-dark-text">未處理事件</div><div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3"><EventMetric label="資訊" value={stats?.info_events ?? "—"} tone="text-sky-600" icon={<IconInfo className="h-4 w-4" />} /><EventMetric label="警告" value={stats?.warning_events ?? "—"} tone="text-amber-600" icon={<IconAlertTriangle className="h-4 w-4" />} /><EventMetric label="嚴重" value={stats?.critical_events ?? "—"} tone="text-red-600" icon={<IconAlertOctagon className="h-4 w-4" />} /></div></div>
    </div>

    <div className="space-y-3"><h2 className="card-title">未處理事件</h2>
      <div className="card grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <label><span className="label">開始時間</span><input className="input" type="datetime-local" value={from} onChange={(e) => resetPage(() => setFrom(e.target.value))} /></label>
        <label><span className="label">結束時間</span><input className="input" type="datetime-local" value={to} onChange={(e) => resetPage(() => setTo(e.target.value))} /></label>
        <label><span className="label">類型</span><input className="input" value={type} placeholder="例如 cpu_high" onChange={(e) => resetPage(() => setType(e.target.value))} /></label>
        <label><span className="label">嚴重程度</span><select className="select" value={severity} onChange={(e) => resetPage(() => setSeverity(e.target.value))}><option value="">全部</option><option value="info">資訊</option><option value="warning">警告</option><option value="critical">嚴重</option></select></label>
        <label><span className="label">裝置</span><select className="select" value={deviceId} onChange={(e) => resetPage(() => setDeviceId(e.target.value))}><option value="">全部裝置</option>{(devices ?? []).map((device) => <option key={device.uuid} value={device.uuid}>{device.name}</option>)}</select></label>
        <label><span className="label">訊息／關鍵字</span><input className="input" value={query} onChange={(e) => resetPage(() => setQuery(e.target.value))} /></label>
      </div>
      <div className="flex flex-wrap justify-end gap-2"><button className="btn-ghost" onClick={clearFilters}>清除篩選</button>{writable && <><button className="btn-ghost" disabled={!eventPage?.items.length} onClick={selectAllEvents}>{eventPage?.items.length && eventPage.items.every((event) => selectedIds.has(event.id)) ? "取消全選" : "全選本頁"}</button><button className="btn-danger" disabled={!selectedIds.size} onClick={() => void deleteSelectedEvents()}>刪除選取（{selectedIds.size}）</button></>}</div>
      <TableCard><table className="w-full min-w-[760px]"><thead><tr>{writable && <th className="th w-10" />}<th className="th">時間</th><th className="th">類型</th><th className="th">嚴重程度</th><th className="th">裝置</th><th className="th">訊息</th>{writable && <th className="th" />}</tr></thead><tbody>{(eventPage?.items ?? []).map((e) => <tr key={e.id}>{writable && <td className="td"><input type="checkbox" checked={selectedIds.has(e.id)} onChange={() => toggleEvent(e.id)} aria-label={`選取 ${e.type}`} /></td>}<td className="td whitespace-nowrap text-xs text-slate-500">{e.created_at}</td><td className="td">{e.type}</td><td className="td"><span className={`badge ${severityBadge[e.severity] ?? "bg-slate-100 text-slate-600"}`}>{label(severityLabels, e.severity)}</span></td><td className="td text-xs">{e.device_name ?? (e.device_id ? e.device_id.slice(0, 8) : "—")}</td><td className="td">{e.message}</td>{writable && <td className="td text-right"><button className="text-xs font-medium text-red-600 hover:underline" onClick={() => void deleteEvent(e.id)}>刪除</button></td>}</tr>)}{loading && <EmptyRow colSpan={writable ? 7 : 5}>載入中…</EmptyRow>}{eventPage && eventPage.items.length === 0 && <EmptyRow colSpan={writable ? 7 : 5}>沒有符合條件的未處理事件</EmptyRow>}</tbody></table></TableCard>
      {eventPage && <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-500"><span>共 {eventPage.total} 筆，第 {eventPage.page} / {eventPage.total_pages} 頁</span><div className="flex gap-2"><button className="btn-ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一頁</button><button className="btn-ghost" disabled={page >= eventPage.total_pages} onClick={() => setPage(page + 1)}>下一頁</button></div></div>}
    </div>
  </div>;
}

function Metric({ label, value, tone }: { label: string; value: string | number; tone?: string }) { return <div><div className="text-xs text-slate-500 dark:text-dark-muted">{label}</div><div className={`text-xl font-bold ${tone ?? "text-slate-900 dark:text-dark-text"}`}>{value}</div></div>; }
function EventMetric({ label, value, tone, icon }: { label: string; value: string | number; tone: string; icon: ReactNode }) { return <div><div className={`flex items-center gap-1 text-xs ${tone}`}>{icon}{label}</div><div className={`mt-1 text-2xl font-bold ${tone}`}>{value}</div></div>; }
