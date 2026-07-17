import { useState } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import { canWrite, useAuth } from "../auth";

interface Schedule {
  id: number;
  playlist_id: number;
  playlist_name: string;
  target_type: string;
  target_id: string;
  time_start: string | null;
  time_end: string | null;
  weekdays: number;
  priority: number;
}
interface NamedRow { id: number; name: string }
interface DeviceRow { uuid: string; name: string }

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function Schedules() {
  const { user } = useAuth();
  const writable = canWrite(user);
  const { data, reload } = useFetch<Schedule[]>("/api/schedules");
  const { data: playlists } = useFetch<NamedRow[]>("/api/playlists");
  const { data: groups } = useFetch<NamedRow[]>("/api/groups");
  const { data: devices } = useFetch<DeviceRow[]>("/api/devices");

  const [playlistId, setPlaylistId] = useState("");
  const [targetType, setTargetType] = useState<"group" | "device">("group");
  const [targetId, setTargetId] = useState("");
  const [timeStart, setTimeStart] = useState("");
  const [timeEnd, setTimeEnd] = useState("");
  const [days, setDays] = useState<boolean[]>([true, true, true, true, true, true, true]);
  const [priority, setPriority] = useState(0);

  const weekdays = days.reduce((m, on, i) => (on ? m | (1 << i) : m), 0);

  async function create() {
    if (!playlistId || !targetId) return;
    await api.post("/api/schedules", {
      playlist_id: Number(playlistId),
      target_type: targetType,
      target_id: targetId,
      time_start: timeStart || null,
      time_end: timeEnd || null,
      weekdays,
      priority,
    });
    reload();
  }
  async function remove(id: number) {
    await api.del(`/api/schedules/${id}`);
    reload();
  }

  function fmtDays(mask: number) {
    return DAYS.filter((_, i) => mask & (1 << i)).join(",");
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Schedules</h1>

      {writable && (
        <div className="card space-y-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div>
              <label className="mb-1 block text-xs text-slate-500">Playlist</label>
              <select className="input" value={playlistId} onChange={(e) => setPlaylistId(e.target.value)}>
                <option value="">— pick —</option>
                {(playlists ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-500">Target</label>
              <select className="input" value={targetType} onChange={(e) => { setTargetType(e.target.value as "group" | "device"); setTargetId(""); }}>
                <option value="group">Group</option>
                <option value="device">Device</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-500">{targetType === "group" ? "Group" : "Device"}</label>
              <select className="input" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                <option value="">— pick —</option>
                {targetType === "group"
                  ? (groups ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)
                  : (devices ?? []).map((d) => <option key={d.uuid} value={d.uuid}>{d.name}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-500">Priority</label>
              <input className="input" type="number" value={priority} onChange={(e) => setPriority(Number(e.target.value))} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-500">Start time</label>
              <input className="input" type="time" value={timeStart} onChange={(e) => setTimeStart(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-500">End time</label>
              <input className="input" type="time" value={timeEnd} onChange={(e) => setTimeEnd(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-slate-500">Days:</span>
            {DAYS.map((d, i) => (
              <label key={d} className="flex items-center gap-1 text-sm">
                <input type="checkbox" checked={days[i]} onChange={(e) => setDays((xs) => xs.map((x, j) => (j === i ? e.target.checked : x)))} />
                {d}
              </label>
            ))}
            <button className="btn-primary ml-auto" onClick={create}>Add schedule</button>
          </div>
          <p className="text-xs text-slate-400">Times are interpreted in UTC. Higher priority wins when schedules overlap; a device-targeted schedule beats a group one at equal priority.</p>
        </div>
      )}

      <div className="card p-0">
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">Playlist</th>
              <th className="th">Target</th>
              <th className="th">Time</th>
              <th className="th">Days</th>
              <th className="th">Priority</th>
              <th className="th"></th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((s) => (
              <tr key={s.id}>
                <td className="td font-medium">{s.playlist_name}</td>
                <td className="td">{s.target_type}:{s.target_id.length > 10 ? s.target_id.slice(0, 8) : s.target_id}</td>
                <td className="td">{s.time_start && s.time_end ? `${s.time_start}–${s.time_end}` : "all day"}</td>
                <td className="td text-xs">{fmtDays(s.weekdays)}</td>
                <td className="td">{s.priority}</td>
                <td className="td text-right">
                  {writable && <button className="text-xs text-red-600 hover:underline" onClick={() => remove(s.id)}>Delete</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
