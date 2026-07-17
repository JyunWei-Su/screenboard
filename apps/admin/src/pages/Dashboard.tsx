import { useFetch } from "../hooks";

interface Stats {
  total: number;
  online: number;
  offline: number;
  warning: number;
  maintenance: number;
  open_alerts: number;
  online_rate: number;
  playback_7d: number;
}

interface EventRow {
  id: number;
  type: string;
  device_id: string | null;
  severity: string;
  message: string;
  created_at: string;
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="card">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-3xl font-bold ${tone ?? "text-slate-900"}`}>{value}</div>
    </div>
  );
}

export default function Dashboard() {
  const { data: stats } = useFetch<Stats>("/api/dashboard/stats");
  const { data: events } = useFetch<EventRow[]>("/api/events?unresolved=1");

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Dashboard</h1>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Total" value={stats?.total ?? "—"} />
        <Stat label="Online" value={stats?.online ?? "—"} tone="text-green-600" />
        <Stat label="Offline" value={stats?.offline ?? "—"} tone="text-slate-500" />
        <Stat label="Warning" value={stats?.warning ?? "—"} tone="text-amber-500" />
        <Stat label="Open alerts" value={stats?.open_alerts ?? "—"} tone="text-red-600" />
        <Stat
          label="Online rate"
          value={stats ? `${Math.round(stats.online_rate * 100)}%` : "—"}
        />
      </div>

      <div className="card">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Open alerts</h2>
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">Time</th>
              <th className="th">Type</th>
              <th className="th">Severity</th>
              <th className="th">Device</th>
              <th className="th">Message</th>
            </tr>
          </thead>
          <tbody>
            {(events ?? []).slice(0, 10).map((e) => (
              <tr key={e.id}>
                <td className="td whitespace-nowrap">{e.created_at}</td>
                <td className="td">{e.type}</td>
                <td className="td">
                  <span
                    className={
                      e.severity === "critical"
                        ? "text-red-600"
                        : e.severity === "warning"
                          ? "text-amber-600"
                          : "text-slate-500"
                    }
                  >
                    {e.severity}
                  </span>
                </td>
                <td className="td font-mono text-xs">{e.device_id?.slice(0, 8) ?? "—"}</td>
                <td className="td">{e.message}</td>
              </tr>
            ))}
            {events && events.length === 0 && (
              <tr>
                <td className="td text-slate-400" colSpan={5}>
                  No open alerts 🎉
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
