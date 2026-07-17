import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useFetch } from "../hooks";
import { canWrite, useAuth } from "../auth";
import { EmptyRow, PageHeader, TableCard } from "../components/ui";
import { label, statusLabels } from "../labels";

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
    <span className={`badge ${statusColor[status] ?? "bg-slate-100 text-slate-600"}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      {label(statusLabels, status)}
    </span>
  );
}

function Usage({ value }: { value: number | null }) {
  if (value == null) return <span className="text-slate-400 dark:text-dark-subtle">—</span>;
  const pct = Math.round(value);
  const color =
    pct > 90 ? "text-red-600 dark:text-red-400" : pct > 70 ? "text-amber-600 dark:text-amber-400" : "text-slate-700 dark:text-slate-200";
  return <span className={color}>{pct}%</span>;
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
    <div className="space-y-5">
      <PageHeader title="裝置" subtitle="已註冊的看板播放器">
        {canWrite(user) && (
          <button className="btn-primary" onClick={enroll}>
            + 註冊權杖
          </button>
        )}
      </PageHeader>

      {token && (
        <div className="card animate-slide-in border-brand-200 bg-brand-50 dark:border-brand-500/30 dark:bg-brand-500/10">
          <div className="text-sm font-medium text-brand-700 dark:text-brand-200">
            一次性註冊權杖(24 小時內有效)— 請貼入 Debian 安裝指令:
          </div>
          <code className="mt-2 block break-all rounded-lg border border-brand-100 bg-white p-2.5 text-xs dark:border-dark-border dark:bg-dark-raised dark:text-dark-text">
            {token}
          </code>
        </div>
      )}

      <TableCard>
        <table className="w-full min-w-[760px]">
          <thead>
            <tr>
              <th className="th">名稱</th>
              <th className="th">狀態</th>
              <th className="th">IP</th>
              <th className="th">Agent 版本</th>
              <th className="th">CPU</th>
              <th className="th">記憶體</th>
              <th className="th">磁碟</th>
              <th className="th">最後上線</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((d) => (
              <tr key={d.uuid}>
                <td className="td">
                  <Link
                    className="font-medium text-brand-600 hover:text-brand-700 hover:underline"
                    to={`/devices/${d.uuid}`}
                  >
                    {d.name}
                  </Link>
                </td>
                <td className="td">
                  <StatusBadge status={d.status} />
                </td>
                <td className="td whitespace-nowrap">{d.ip ?? "—"}</td>
                <td className="td whitespace-nowrap">{d.agent_version ?? "—"}</td>
                <td className="td">
                  <Usage value={d.cpu} />
                </td>
                <td className="td">
                  <Usage value={d.memory} />
                </td>
                <td className="td">
                  <Usage value={d.disk} />
                </td>
                <td className="td whitespace-nowrap text-xs text-slate-500">
                  {d.last_seen_at ?? "—"}
                </td>
              </tr>
            ))}
            {loading && <EmptyRow colSpan={8}>載入中…</EmptyRow>}
            {data && data.length === 0 && (
              <EmptyRow colSpan={8}>
                尚無裝置。請建立註冊權杖並啟動 agent。
              </EmptyRow>
            )}
          </tbody>
        </table>
      </TableCard>
    </div>
  );
}
