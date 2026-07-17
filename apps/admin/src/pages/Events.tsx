import { useState } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import { canWrite, useAuth } from "../auth";

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

export default function Events() {
  const { user } = useAuth();
  const writable = canWrite(user);
  const isAdmin = user?.role === "admin";
  const { data: events, reload } = useFetch<EventRow[]>("/api/events");
  const { data: channels, reload: reloadCh } = useFetch<Channel[]>("/api/events/channels");

  const [kind, setKind] = useState<"teams" | "webhook">("teams");
  const [url, setUrl] = useState("");

  async function resolve(id: number) {
    await api.post(`/api/events/${id}/resolve`);
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
      <h1 className="text-xl font-semibold">Events & alerts</h1>

      <div className="card p-0">
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">Time</th>
              <th className="th">Type</th>
              <th className="th">Severity</th>
              <th className="th">Device</th>
              <th className="th">Message</th>
              <th className="th"></th>
            </tr>
          </thead>
          <tbody>
            {(events ?? []).map((e) => (
              <tr key={e.id} className={e.resolved_at ? "opacity-50" : ""}>
                <td className="td whitespace-nowrap text-xs">{e.created_at}</td>
                <td className="td">{e.type}</td>
                <td className="td">
                  <span className={e.severity === "critical" ? "text-red-600" : e.severity === "warning" ? "text-amber-600" : "text-slate-500"}>
                    {e.severity}
                  </span>
                </td>
                <td className="td font-mono text-xs">{e.device_id?.slice(0, 8) ?? "—"}</td>
                <td className="td">{e.message}</td>
                <td className="td text-right">
                  {!e.resolved_at && writable && (
                    <button className="text-xs text-brand-600 hover:underline" onClick={() => resolve(e.id)}>Resolve</button>
                  )}
                  {e.resolved_at && <span className="text-xs text-slate-400">resolved</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isAdmin && (
        <div className="card space-y-3">
          <h2 className="text-sm font-semibold text-slate-700">Notification channels</h2>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1 block text-xs text-slate-500">Type</label>
              <select className="input" value={kind} onChange={(e) => setKind(e.target.value as "teams" | "webhook")}>
                <option value="teams">Microsoft Teams</option>
                <option value="webhook">Webhook</option>
              </select>
            </div>
            <div className="grow">
              <label className="mb-1 block text-xs text-slate-500">Incoming webhook URL</label>
              <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
            </div>
            <button className="btn-primary" onClick={addChannel}>Add</button>
          </div>
          <table className="w-full">
            <tbody>
              {(channels ?? []).map((c) => (
                <tr key={c.id}>
                  <td className="td w-24">{c.kind}</td>
                  <td className="td truncate font-mono text-xs">{c.url}</td>
                  <td className="td text-right">
                    <button className="text-xs text-red-600 hover:underline" onClick={() => delChannel(c.id)}>Delete</button>
                  </td>
                </tr>
              ))}
              {channels && channels.length === 0 && (
                <tr><td className="td text-slate-400">No channels — offline/OTA/playlist alerts won’t be pushed.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
