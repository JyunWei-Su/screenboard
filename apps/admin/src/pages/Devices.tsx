import { useState } from "react";
import { Link } from "react-router-dom";
import { api, apiBase } from "../api";
import { useFetch } from "../hooks";
import { useDeviceStream } from "../realtime";
import { canWrite, useAuth } from "../auth";
import { EmptyRow, PageHeader, TableCard } from "../components/ui";
import { label, statusLabels } from "../labels";
import { useToast } from "../toast";

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
  const isAdmin = user?.role === "admin";
  const { showToast } = useToast();
  const { data, loading, reload, setData } = useFetch<DeviceRow[]>("/api/devices");
  const [token, setToken] = useState<string | null>(null);
  const [expiresMin, setExpiresMin] = useState(10);

  // Live presence: the badge flips the moment the server pushes a transition;
  // on every (re)connect we re-sync the full list to catch anything missed.
  useDeviceStream({
    onReady: reload,
    onEvent: (e) =>
      setData((prev) =>
        prev ? prev.map((d) => (d.uuid === e.uuid ? { ...d, status: e.status } : d)) : prev,
      ),
  });

  // Codes are stored canonically (ABCD123456); show them hyphenated for reading.
  const codeDisplay = token ? `${token.slice(0, 4)}-${token.slice(4)}` : "";
  const installCommand = token
    ? `curl -fsSL ${apiBase() || "https://YOUR-API"}/install.sh | sudo bash -s -- ${codeDisplay}`
    : "";

  async function enroll() {
    const res = await api.post<{ token: string; expires_in_minutes: number }>(
      "/api/groups/enroll-token",
      { ttl_minutes: 10 },
    );
    setToken(res.token);
    setExpiresMin(res.expires_in_minutes);
  }

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(installCommand);
      showToast("已複製安裝指令", "success");
    } catch {
      showToast("複製失敗，請手動選取指令。", "error");
    }
  }

  async function remove(uuid: string, name: string) {
    if (!confirm(`確定要移除裝置「${name}」嗎?此操作會刪除主控台的所有裝置紀錄,且無法復原。`)) return;
    try {
      await api.del(`/api/devices/${uuid}`);
      showToast("裝置已移除。", "success");
      reload();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "移除裝置失敗", "error");
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader title="裝置" subtitle="已註冊的看板播放器">
        {canWrite(user) && (
          <button className="btn-primary" onClick={enroll}>
            + 註冊裝置
          </button>
        )}
      </PageHeader>

      {token && (
        <div className="card animate-slide-in border-brand-200 bg-brand-50 dark:border-brand-500/30 dark:bg-brand-500/10">
          <div className="text-sm font-medium text-brand-700 dark:text-brand-200">
            一次性註冊碼(請於 {expiresMin} 分鐘內於裝置完成註冊;逾時請重新產生):
          </div>
          <div className="mt-2 select-all text-center font-mono text-3xl font-bold tracking-[0.3em] text-brand-800 dark:text-brand-100">
            {codeDisplay}
          </div>
          <div className="mt-3 text-sm font-medium text-brand-700 dark:text-brand-200">
            在 Debian 裝置上執行以下安裝指令:
          </div>
          <div className="mt-2 flex items-start gap-2">
            <code className="block flex-1 break-all rounded-lg border border-brand-100 bg-white p-2.5 text-xs dark:border-dark-border dark:bg-dark-raised dark:text-dark-text">
              {installCommand}
            </code>
            <button type="button" className="btn-ghost btn-sm shrink-0" onClick={() => void copyCommand()}>
              複製
            </button>
          </div>
        </div>
      )}

      <TableCard>
        <table className="w-full min-w-[760px]">
          <thead>
            <tr>
              <th className="th">名稱</th>
              <th className="th">狀態</th>
              <th className="th">Local IP</th>
              <th className="th">Agent 版本</th>
              <th className="th">CPU</th>
              <th className="th">記憶體</th>
              <th className="th">磁碟</th>
              <th className="th">最後上線</th>
              {isAdmin && <th className="th" />}
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
                {isAdmin && (
                  <td className="td text-right">
                    <button
                      className="text-xs font-medium text-red-600 hover:underline"
                      onClick={() => void remove(d.uuid, d.name)}
                    >
                      移除
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {loading && <EmptyRow colSpan={isAdmin ? 9 : 8}>載入中…</EmptyRow>}
            {data && data.length === 0 && (
              <EmptyRow colSpan={isAdmin ? 9 : 8}>
                尚無裝置。請點「註冊裝置」取得安裝指令。
              </EmptyRow>
            )}
          </tbody>
        </table>
      </TableCard>
    </div>
  );
}
