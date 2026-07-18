import { useState } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import { canWrite, useAuth } from "../auth";
import { EmptyRow, PageHeader, TableCard } from "../components/ui";
import { assignSourceLabels, label, targetTypeLabels } from "../labels";

type SourceType = "scene" | "scene_playlist";

interface Schedule {
  id: number;
  // new scene assignment fields (optional; API being extended in parallel)
  source_type?: SourceType;
  scene_id?: number | null;
  scene_name?: string | null;
  scene_playlist_id?: number | null;
  scene_playlist_name?: string | null;
  target_type: string;
  target_id: string;
  time_start: string | null;
  time_end: string | null;
  weekdays: number;
  priority: number;
}
interface NamedRow { id: number; name: string }
interface DeviceRow { uuid: string; name: string }

const DAYS = ["日", "一", "二", "三", "四", "五", "六"];
const SOURCE_TYPES: SourceType[] = ["scene", "scene_playlist"];

export default function Schedules() {
  const { user } = useAuth();
  const writable = canWrite(user);
  const { data, reload } = useFetch<Schedule[]>("/api/schedules");
  const { data: scenes } = useFetch<NamedRow[]>("/api/scenes");
  const { data: scenePlaylists } = useFetch<NamedRow[]>("/api/scene-playlists");
  const { data: groups } = useFetch<NamedRow[]>("/api/groups");
  const { data: devices } = useFetch<DeviceRow[]>("/api/devices");

  const [sourceType, setSourceType] = useState<SourceType>("scene");
  const [sourceId, setSourceId] = useState("");
  const [targetType, setTargetType] = useState<"group" | "device">("group");
  const [targetId, setTargetId] = useState("");
  const [timeStart, setTimeStart] = useState("");
  const [timeEnd, setTimeEnd] = useState("");
  const [days, setDays] = useState<boolean[]>([true, true, true, true, true, true, true]);
  const [priority, setPriority] = useState(0);

  const weekdays = days.reduce((m, on, i) => (on ? m | (1 << i) : m), 0);

  const sourceOptions = sourceType === "scene" ? scenes : scenePlaylists;

  async function create() {
    if (!sourceId || !targetId) return;
    const body: Record<string, unknown> = {
      source_type: sourceType,
      target_type: targetType,
      target_id: targetId,
      time_start: timeStart || null,
      time_end: timeEnd || null,
      weekdays,
      priority,
    };
    if (sourceType === "scene") body.scene_id = Number(sourceId);
    else body.scene_playlist_id = Number(sourceId);
    await api.post("/api/schedules", body);
    setSourceId("");
    reload();
  }
  async function remove(id: number) {
    await api.del(`/api/schedules/${id}`);
    reload();
  }

  function fmtDays(mask: number) {
    return DAYS.filter((_, i) => mask & (1 << i)).join("、");
  }

  function sourceCell(s: Schedule) {
    const t: SourceType = s.source_type ?? "scene";
    const name =
      t === "scene"
        ? s.scene_name
        : s.scene_playlist_name;
    return `${label(assignSourceLabels, t)}:${name ?? "—"}`;
  }

  return (
    <div className="space-y-5">
      <PageHeader title="排程" subtitle="依時間與星期指派場景或場景群組" />

      {writable && (
        <div className="card space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <div>
              <label className="label">來源類型</label>
              <select
                className="select"
                value={sourceType}
                onChange={(e) => {
                  setSourceType(e.target.value as SourceType);
                  setSourceId("");
                }}
              >
                {SOURCE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {label(assignSourceLabels, t)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">{label(assignSourceLabels, sourceType)}</label>
              <select className="select" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                <option value="">— 選擇 —</option>
                {(sourceOptions ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">目標</label>
              <select
                className="select"
                value={targetType}
                onChange={(e) => {
                  setTargetType(e.target.value as "group" | "device");
                  setTargetId("");
                }}
              >
                <option value="group">裝置群組</option>
                <option value="device">裝置</option>
              </select>
            </div>
            <div>
              <label className="label">{targetType === "group" ? "裝置群組" : "裝置"}</label>
              <select className="select" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                <option value="">— 選擇 —</option>
                {targetType === "group"
                  ? (groups ?? []).map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))
                  : (devices ?? []).map((d) => (
                      <option key={d.uuid} value={d.uuid}>
                        {d.name}
                      </option>
                    ))}
              </select>
            </div>
            <div>
              <label className="label">優先度</label>
              <input
                className="input"
                type="number"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">開始</label>
                <input className="input" type="time" value={timeStart} onChange={(e) => setTimeStart(e.target.value)} />
              </div>
              <div>
                <label className="label">結束</label>
                <input className="input" type="time" value={timeEnd} onChange={(e) => setTimeEnd(e.target.value)} />
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-3 border-t border-slate-100 pt-3 sm:flex-row sm:flex-wrap sm:items-center dark:border-dark-border">
            <span className="text-xs font-medium text-slate-500 dark:text-dark-muted">星期:</span>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {DAYS.map((d, i) => (
                <label key={d} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-slate-300 text-brand-500 focus:ring-brand-500 dark:border-dark-border dark:bg-dark-raised"
                    checked={days[i]}
                    onChange={(e) => setDays((xs) => xs.map((x, j) => (j === i ? e.target.checked : x)))}
                  />
                  {d}
                </label>
              ))}
            </div>
            <button className="btn-primary sm:ml-auto" onClick={create}>
              新增排程
            </button>
          </div>
          <p className="text-xs text-slate-400">
            時間以 UTC 解讀。排程重疊時,優先度較高者勝出;優先度相同時,以裝置為目標的排程優先於裝置群組。
          </p>
        </div>
      )}

      <TableCard>
        <table className="w-full min-w-[680px]">
          <thead>
            <tr>
              <th className="th">來源</th>
              <th className="th">目標</th>
              <th className="th">時間</th>
              <th className="th">星期</th>
              <th className="th">優先度</th>
              <th className="th" />
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((s) => (
              <tr key={s.id}>
                <td className="td font-medium">{sourceCell(s)}</td>
                <td className="td whitespace-nowrap">
                  {label(targetTypeLabels, s.target_type)}:{s.target_id.length > 10 ? s.target_id.slice(0, 8) : s.target_id}
                </td>
                <td className="td whitespace-nowrap">
                  {s.time_start && s.time_end ? `${s.time_start}–${s.time_end}` : "全天"}
                </td>
                <td className="td text-xs">{fmtDays(s.weekdays)}</td>
                <td className="td">{s.priority}</td>
                <td className="td text-right">
                  {writable && (
                    <button
                      className="text-xs font-medium text-red-600 hover:underline"
                      onClick={() => remove(s.id)}
                    >
                      刪除
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {data && data.length === 0 && <EmptyRow colSpan={6}>尚無排程。</EmptyRow>}
          </tbody>
        </table>
      </TableCard>
    </div>
  );
}
