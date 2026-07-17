import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useFetch } from "../hooks";
import { canWrite, useAuth } from "../auth";

interface DeviceRow {
  uuid: string;
  name: string;
  status: string;
  group_id: number | null;
  ip: string | null;
  agent_version: string | null;
  last_seen_at: string | null;
  cpu: number | null;
  memory: number | null;
  disk: number | null;
}

const statusColor: Record<string, string> = {
  online: "bg-green-100 text-green-700",
  offline: "bg-slate-100 text-slate-500",
  warning: "bg-amber-100 text-amber-700",
  maintenance: "bg-blue-100 text-blue-700",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColor[status] ?? ""}`}>
      {status}
    </span>
  );
}

export default function Devices() {
  const { user } = useAuth();
  const { data, loading } = useFetch<DeviceRow[]>("/api/devices");
  const [token, setToken] = useState<string | null>(null);

  async function enroll() {
    const res = await api.post<{ token: string; expires_in_hours: number }>(
      "/api/groups/enroll-token",
      { ttl_hours: 24 },
    );
    setToken(res.token);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Devices</h1>
        {canWrite(user) && (
          <button className="btn-primary" onClick={enroll}>
            + Enrollment token
          </button>
        )}
      </div>

      {token && (
        <div className="card bg-brand-50">
          <div className="text-sm font-medium text-brand-700">
            One-time enrollment token (valid 24h) — paste it into the Debian install command:
          </div>
          <code className="mt-1 block break-all rounded bg-white p-2 text-xs">{token}</code>
        </div>
      )}

      <div className="card overflow-x-auto p-0">
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">Name</th>
              <th className="th">Status</th>
              <th className="th">IP</th>
              <th className="th">Agent</th>
              <th className="th">CPU</th>
              <th className="th">Mem</th>
              <th className="th">Disk</th>
              <th className="th">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((d) => (
              <tr key={d.uuid} className="hover:bg-slate-50">
                <td className="td">
                  <Link className="font-medium text-brand-600 hover:underline" to={`/devices/${d.uuid}`}>
                    {d.name}
                  </Link>
                </td>
                <td className="td">
                  <StatusBadge status={d.status} />
                </td>
                <td className="td">{d.ip ?? "—"}</td>
                <td className="td">{d.agent_version ?? "—"}</td>
                <td className="td">{d.cpu != null ? `${Math.round(d.cpu)}%` : "—"}</td>
                <td className="td">{d.memory != null ? `${Math.round(d.memory)}%` : "—"}</td>
                <td className="td">{d.disk != null ? `${Math.round(d.disk)}%` : "—"}</td>
                <td className="td whitespace-nowrap text-xs text-slate-500">{d.last_seen_at ?? "—"}</td>
              </tr>
            ))}
            {loading && (
              <tr>
                <td className="td text-slate-400" colSpan={8}>
                  Loading…
                </td>
              </tr>
            )}
            {data && data.length === 0 && (
              <tr>
                <td className="td text-slate-400" colSpan={8}>
                  No devices yet. Create an enrollment token and boot an agent.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
