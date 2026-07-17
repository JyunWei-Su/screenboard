import { useState } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import { canWrite, useAuth } from "../auth";
import { EmptyRow, PageHeader, TableCard } from "../components/ui";
import { label, severityLabels } from "../labels";

interface EventRow {
  id: number;
  type: string;
  device_id: string | null;
  severity: string;
  message: string;
  created_at: string;
  resolved_at: string | null;
}
interface Channel {
  id: number;
  kind: string;
  url: string;
  events: string;
  enabled: number;
}

const severityBadge: Record<string, string> = {
  critical: "bg-red-100 text-red-700",
  warning: "bg-amber-100 text-amber-700",
};

export default function Events() {
  const { user } = useAuth();
  const writable = canWrite(user);
  const isAdmin = user?.role === "admin";
  const { data: events, reload } = useFetch<EventRow[]>("/api/events");
  const { data: channels, reload: reloadCh } = useFetch<Channel[]>("/api/events/channels");

  const [kind, setKind] = useState<"teams" | "webhook">("teams");
  const [url, setUrl] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  async function resolve(id: number) {
    await api.post(`/api/events/${id}/resolve`);
    reload();
  }
  async function deleteEvent(id: number) {
    if (!confirm("要刪除這筆事件嗎？此操作無法復原。")) return;
    await api.del(`/api/events/${id}`);
    setSelectedIds((selected) => {
      const next = new Set(selected);
      next.delete(id);
      return next;
    });
    reload();
  }
  function toggleEvent(id: number) {
    setSelectedIds((selected) => {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function selectAllEvents() {
    const ids = (events ?? []).map((event) => event.id);
    const allSelected = ids.length > 0 && ids.every((id) => selectedIds.has(id));
    setSelectedIds(allSelected ? new Set() : new Set(ids));
  }
  async function deleteSelectedEvents() {
    const ids = [...selectedIds];
    if (!ids.length || !confirm(`要刪除選取的 ${ids.length} 筆事件嗎？此操作無法復原。`)) return;
    await api.del("/api/events/batch", { ids });
    setSelectedIds(new Set());
    reload();
  }
  async function addChannel() {
    if (!url) return;
    await api.post("/api/events/channels", { kind, url, events: "*" });
    setUrl("");
    reloadCh();
  }
  async function delChannel(id: number) {
    await api.del(`/api/events/channels/${id}`);
    reloadCh();
  }

  return (
    <div className="space-y-6">
      <PageHeader title="事件與警示" subtitle="裝置健康通知" />

      <div className="flex justify-end gap-2">
        {writable && (
          <>
            <button className="btn-ghost" disabled={!events?.length} onClick={selectAllEvents}>
              {(events?.length ?? 0) > 0 && events!.every((event) => selectedIds.has(event.id)) ? "取消全選" : "全選"}
            </button>
            <button className="btn-danger" disabled={!selectedIds.size} onClick={() => void deleteSelectedEvents()}>
              刪除選取（{selectedIds.size}）
            </button>
          </>
        )}
      </div>
      <TableCard>
        <table className="w-full min-w-[680px]">
          <thead>
            <tr>
              {writable && <th className="th w-10" />}
              <th className="th">時間</th>
              <th className="th">類型</th>
              <th className="th">嚴重程度</th>
              <th className="th">裝置</th>
              <th className="th">訊息</th>
              <th className="th" />
            </tr>
          </thead>
          <tbody>
            {(events ?? []).map((e) => (
              <tr key={e.id} className={e.resolved_at ? "opacity-50" : ""}>
                {writable && (
                  <td className="td">
                    <input type="checkbox" checked={selectedIds.has(e.id)} onChange={() => toggleEvent(e.id)} aria-label={`選取 ${e.type}`} />
                  </td>
                )}
                <td className="td whitespace-nowrap text-xs text-slate-500">{e.created_at}</td>
                <td className="td">{e.type}</td>
                <td className="td">
                  <span className={`badge ${severityBadge[e.severity] ?? "bg-slate-100 text-slate-600"}`}>
                    {label(severityLabels, e.severity)}
                  </span>
                </td>
                <td className="td font-mono text-xs">{e.device_id?.slice(0, 8) ?? "—"}</td>
                <td className="td">{e.message}</td>
                <td className="td text-right">
                  {writable && (
                    <div className="flex justify-end gap-3">
                      {!e.resolved_at && <button className="text-xs font-medium text-brand-600 hover:underline" onClick={() => void resolve(e.id)}>標記已解決</button>}
                      <button className="text-xs font-medium text-red-600 hover:underline" onClick={() => void deleteEvent(e.id)}>刪除</button>
                    </div>
                  )}
                  {!writable && e.resolved_at && <span className="text-xs text-slate-400">已解決</span>}
                </td>
              </tr>
            ))}
            {events && events.length === 0 && <EmptyRow colSpan={writable ? 7 : 6}>尚無事件紀錄。</EmptyRow>}
          </tbody>
        </table>
      </TableCard>

      {isAdmin && (
        <div className="card space-y-4">
          <h2 className="card-title">通知管道</h2>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="sm:w-48">
              <label className="label">類型</label>
              <select
                className="select"
                value={kind}
                onChange={(e) => setKind(e.target.value as "teams" | "webhook")}
              >
                <option value="teams">Microsoft Teams</option>
                <option value="webhook">Webhook</option>
              </select>
            </div>
            <div className="grow">
              <label className="label">傳入 Webhook URL</label>
              <input
                className="input"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://…"
              />
            </div>
            <button className="btn-primary w-full sm:w-auto" onClick={addChannel}>
              新增
            </button>
          </div>

          <TableCard>
            <table className="w-full min-w-[480px]">
              <tbody>
                {(channels ?? []).map((c) => (
                  <tr key={c.id}>
                    <td className="td w-28 capitalize">{c.kind}</td>
                    <td className="td truncate font-mono text-xs">{c.url}</td>
                    <td className="td text-right">
                      <button
                        className="text-xs font-medium text-red-600 hover:underline"
                        onClick={() => delChannel(c.id)}
                      >
                        刪除
                      </button>
                    </td>
                  </tr>
                ))}
                {channels && channels.length === 0 && (
                  <EmptyRow colSpan={3}>
                    尚無管道 — 離線／OTA／播放清單警示將不會推送。
                  </EmptyRow>
                )}
              </tbody>
            </table>
          </TableCard>
        </div>
      )}
    </div>
  );
}
