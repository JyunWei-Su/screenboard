import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useFetch } from "../hooks";
import { canWrite, useAuth } from "../auth";
import { EmptyRow, PageHeader, TableCard } from "../components/ui";

interface Group {
  id: number;
  name: string;
  device_count?: number;
}

export default function Groups() {
  const { user } = useAuth();
  const writable = canWrite(user);
  const { data, reload } = useFetch<Group[]>("/api/groups");
  const [name, setName] = useState("");

  async function create() {
    if (!name) return;
    await api.post("/api/groups", { name });
    setName("");
    reload();
  }
  async function remove(id: number) {
    if (!confirm("要刪除裝置群組嗎?")) return;
    await api.del(`/api/groups/${id}`);
    reload();
  }

  return (
    <div className="space-y-5">
      <PageHeader title="裝置群組" subtitle="用來組織與批次排程裝置" />

      {writable && (
        <div className="card grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <div>
            <label className="label">名稱</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") create();
              }}
            />
          </div>
          <button className="btn-primary w-full sm:w-auto" onClick={create}>
            新增
          </button>
        </div>
      )}

      <TableCard>
        <table className="w-full min-w-[420px]">
          <thead>
            <tr>
              <th className="th">名稱</th>
              <th className="th">裝置數</th>
              <th className="th" />
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((g) => (
              <tr key={g.id}>
                <td className="td font-medium">
                  <Link
                    className="text-brand-600 hover:text-brand-700 hover:underline"
                    to={`/groups/${g.id}`}
                  >
                    {g.name}
                  </Link>
                </td>
                <td className="td whitespace-nowrap">{g.device_count ?? 0}</td>
                <td className="td text-right">
                  {writable && (
                    <button
                      className="text-xs font-medium text-red-600 hover:underline"
                      onClick={() => remove(g.id)}
                    >
                      刪除
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {data && data.length === 0 && <EmptyRow colSpan={3}>尚無裝置群組。</EmptyRow>}
          </tbody>
        </table>
      </TableCard>
    </div>
  );
}
