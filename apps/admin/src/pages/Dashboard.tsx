import type { ReactNode } from "react";
import { useFetch } from "../hooks";
import { EmptyRow, PageHeader, TableCard } from "../components/ui";
import { label, severityLabels } from "../labels";
import {
  IconBell,
  IconDashboard,
  IconMonitor,
} from "../components/icons";

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

function Stat({
  label,
  value,
  tone,
  icon,
  accent,
}: {
  label: string;
  value: string | number;
  tone?: string;
  icon: ReactNode;
  accent: string;
}) {
  return (
    <div className="card flex items-center gap-4">
      <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${accent}`}>
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-dark-muted">
          {label}
        </div>
        <div className={`mt-0.5 text-2xl font-bold sm:text-3xl ${tone ?? "text-slate-900 dark:text-dark-text"}`}>
          {value}
        </div>
      </div>
    </div>
  );
}

const severityBadge: Record<string, string> = {
  critical: "bg-red-100 text-red-700",
  warning: "bg-amber-100 text-amber-700",
};

export default function Dashboard() {
  const { data: stats } = useFetch<Stats>("/api/dashboard/stats");
  const { data: events, loading } = useFetch<EventRow[]>("/api/events?unresolved=1");

  return (
    <div className="space-y-6">
      <PageHeader title="儀表板" subtitle="裝置總覽與未處理警示" />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Stat
          label="總數"
          value={stats?.total ?? "—"}
          icon={<IconMonitor className="h-5 w-5 text-slate-500" />}
          accent="bg-slate-100"
        />
        <Stat
          label="上線"
          value={stats?.online ?? "—"}
          tone="text-green-600"
          icon={<IconMonitor className="h-5 w-5 text-green-600" />}
          accent="bg-green-100"
        />
        <Stat
          label="離線"
          value={stats?.offline ?? "—"}
          tone="text-slate-500"
          icon={<IconMonitor className="h-5 w-5 text-slate-400" />}
          accent="bg-slate-100"
        />
        <Stat
          label="警告"
          value={stats?.warning ?? "—"}
          tone="text-amber-500"
          icon={<IconMonitor className="h-5 w-5 text-amber-500" />}
          accent="bg-amber-100"
        />
        <Stat
          label="未處理警示"
          value={stats?.open_alerts ?? "—"}
          tone="text-red-600"
          icon={<IconBell className="h-5 w-5 text-red-600" />}
          accent="bg-red-100"
        />
        <Stat
          label="上線率"
          value={stats ? `${Math.round(stats.online_rate * 100)}%` : "—"}
          icon={<IconDashboard className="h-5 w-5 text-brand-600" />}
          accent="bg-brand-100"
        />
      </div>

      <div className="space-y-3">
        <h2 className="card-title">未處理警示</h2>
        <TableCard>
          <table className="w-full min-w-[640px]">
            <thead>
              <tr>
                <th className="th">時間</th>
                <th className="th">類型</th>
                <th className="th">嚴重程度</th>
                <th className="th">裝置</th>
                <th className="th">訊息</th>
              </tr>
            </thead>
            <tbody>
              {(events ?? []).slice(0, 10).map((e) => (
                <tr key={e.id}>
                  <td className="td whitespace-nowrap text-xs text-slate-500">{e.created_at}</td>
                  <td className="td">{e.type}</td>
                  <td className="td">
                    <span className={`badge ${severityBadge[e.severity] ?? "bg-slate-100 text-slate-600"}`}>
                      {label(severityLabels, e.severity)}
                    </span>
                  </td>
                  <td className="td font-mono text-xs">{e.device_id?.slice(0, 8) ?? "—"}</td>
                  <td className="td">{e.message}</td>
                </tr>
              ))}
              {loading && <EmptyRow colSpan={5}>載入中…</EmptyRow>}
              {events && events.length === 0 && <EmptyRow colSpan={5}>沒有未處理的警示 🎉</EmptyRow>}
            </tbody>
          </table>
        </TableCard>
      </div>
    </div>
  );
}
