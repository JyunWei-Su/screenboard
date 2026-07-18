import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { useFetch } from "../hooks";
import { canWrite, useAuth } from "../auth";
import { EmptyRow, TableCard } from "../components/ui";
import { useToast } from "../toast";
import { StatusBadge } from "./Devices";

interface GroupDevice {
  uuid: string;
  name: string;
  status: string;
  last_seen_at: string | null;
}

interface GroupDetailData {
  id: number;
  name: string;
  devices: GroupDevice[];
}

interface DeviceOption {
  uuid: string;
  name: string;
  group_id: number | null;
}

export default function GroupDetail() {
  const { id } = useParams();
  const groupId = Number(id);
  const navigate = useNavigate();
  const { user } = useAuth();
  const writable = canWrite(user);
  const { showToast } = useToast();
  const { data, loading, reload } = useFetch<GroupDetailData>(`/api/groups/${id}`);
  const { data: allDevices, reload: reloadDevices } = useFetch<DeviceOption[]>("/api/devices");
  const [name, setName] = useState("");
  const [addUuid, setAddUuid] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data) setName(data.name);
  }, [data]);

  const available = (allDevices ?? []).filter((d) => d.group_id !== groupId);
  const nameChanged = data != null && name.trim() !== "" && name.trim() !== data.name;

  function fail(error: unknown, fallback: string) {
    showToast(error instanceof Error ? error.message : fallback, "error");
  }

  async function saveName() {
    if (!nameChanged) return;
    setBusy(true);
    try {
      await api.patch(`/api/groups/${id}`, { name: name.trim() });
      showToast("已更新群組名稱", "success");
      reload();
    } catch (error) {
      fail(error, "更新失敗");
    } finally {
      setBusy(false);
    }
  }

  async function addDevice() {
    if (!addUuid) return;
    setBusy(true);
    try {
      await api.patch(`/api/devices/${addUuid}`, { group_id: groupId });
      setAddUuid("");
      reload();
      reloadDevices();
    } catch (error) {
      fail(error, "加入裝置失敗");
    } finally {
      setBusy(false);
    }
  }

  async function removeDevice(uuid: string) {
    setBusy(true);
    try {
      await api.patch(`/api/devices/${uuid}`, { group_id: null });
      reload();
      reloadDevices();
    } catch (error) {
      fail(error, "移除裝置失敗");
    } finally {
      setBusy(false);
    }
  }

  async function removeGroup() {
    if (!confirm("要刪除這個裝置群組嗎?群組內的裝置會變成未分群。")) return;
    setBusy(true);
    try {
      await api.del(`/api/groups/${id}`);
      navigate("/groups");
    } catch (error) {
      fail(error, "刪除失敗");
      setBusy(false);
    }
  }

  if (!loading && !data) {
    return (
      <div className="space-y-4">
        <Link to="/groups" className="text-sm text-slate-400 hover:text-brand-600 hover:underline">
          ← 裝置群組
        </Link>
        <p className="text-sm text-slate-500">找不到這個群組。</p>
      </div>
    );
  }

  const devices = data?.devices ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/groups" className="text-sm text-slate-400 hover:text-brand-600 hover:underline">
          裝置群組
        </Link>
        <span className="text-slate-300">/</span>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{data?.name ?? "…"}</h1>
      </div>

      {writable && (
        <div className="card grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
          <div>
            <label className="label">群組名稱</label>
            <input
              className="input"
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveName();
              }}
            />
          </div>
          <button className="btn-primary w-full sm:w-auto" disabled={busy || !nameChanged} onClick={() => void saveName()}>
            儲存名稱
          </button>
          <button className="btn-danger w-full sm:w-auto" disabled={busy} onClick={() => void removeGroup()}>
            刪除群組
          </button>
        </div>
      )}

      <div className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            群組內裝置（{devices.length}）
          </h2>
          {writable && (
            <div className="flex items-end gap-2">
              <select
                className="select"
                value={addUuid}
                disabled={busy || available.length === 0}
                onChange={(e) => setAddUuid(e.target.value)}
              >
                <option value="">
                  {available.length === 0 ? "沒有可加入的裝置" : "選擇裝置加入…"}
                </option>
                {available.map((d) => (
                  <option key={d.uuid} value={d.uuid}>
                    {d.name}
                    {d.group_id != null ? "（已在其他群組）" : ""}
                  </option>
                ))}
              </select>
              <button className="btn-primary" disabled={busy || !addUuid} onClick={() => void addDevice()}>
                加入
              </button>
            </div>
          )}
        </div>

        <TableCard>
          <table className="w-full min-w-[520px]">
            <thead>
              <tr>
                <th className="th">名稱</th>
                <th className="th">狀態</th>
                <th className="th">最後上線</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.uuid}>
                  <td className="td font-medium">
                    <Link
                      className="text-brand-600 hover:text-brand-700 hover:underline"
                      to={`/devices/${d.uuid}`}
                    >
                      {d.name}
                    </Link>
                  </td>
                  <td className="td">
                    <StatusBadge status={d.status} />
                  </td>
                  <td className="td whitespace-nowrap text-xs text-slate-500">{d.last_seen_at ?? "—"}</td>
                  <td className="td text-right">
                    {writable && (
                      <button
                        className="text-xs font-medium text-red-600 hover:underline"
                        disabled={busy}
                        onClick={() => void removeDevice(d.uuid)}
                      >
                        移出群組
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {loading && <EmptyRow colSpan={4}>載入中…</EmptyRow>}
              {data && devices.length === 0 && <EmptyRow colSpan={4}>此群組尚無裝置。</EmptyRow>}
            </tbody>
          </table>
        </TableCard>
      </div>
    </div>
  );
}
