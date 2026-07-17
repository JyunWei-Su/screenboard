import { useState } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import { canWrite, useAuth } from "../auth";
import { EmptyRow, PageHeader, TableCard } from "../components/ui";
import { groupTypeLabels, label } from "../labels";

interface Group {
  id: number;
  name: string;
  type: string;
  parent_id: number | null;
}

const TYPES = ["site", "building", "floor", "department", "custom"];

export default function Groups() {
  const { user } = useAuth();
  const writable = canWrite(user);
  const { data, reload } = useFetch<Group[]>("/api/groups");
  const [name, setName] = useState("");
  const [type, setType] = useState("site");
  const [parent, setParent] = useState<string>("");

  async function create() {
    if (!name) return;
    await api.post("/api/groups", {
      name,
      type,
      parent_id: parent ? Number(parent) : null,
    });
    setName("");
    reload();
  }
  async function remove(id: number) {
    if (!confirm("要刪除群組嗎?")) return;
    await api.del(`/api/groups/${id}`);
    reload();
  }

  const byId = new Map((data ?? []).map((g) => [g.id, g]));

  return (
    <div className="space-y-5">
      <PageHeader title="群組" subtitle="依場域、建築或樓層組織裝置" />

      {writable && (
        <div className="card grid grid-cols-1 gap-3 sm:grid-cols-2 sm:items-end lg:grid-cols-[1fr_auto_auto_auto]">
          <div>
            <label className="label">名稱</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="label">類型</label>
            <select className="select" value={type} onChange={(e) => setType(e.target.value)}>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {label(groupTypeLabels, t)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">上層</label>
            <select className="select" value={parent} onChange={(e) => setParent(e.target.value)}>
              <option value="">— 無 —</option>
              {(data ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
          <button className="btn-primary w-full sm:w-auto" onClick={create}>
            新增
          </button>
        </div>
      )}

      <TableCard>
        <table className="w-full min-w-[520px]">
          <thead>
            <tr>
              <th className="th">名稱</th>
              <th className="th">類型</th>
              <th className="th">上層</th>
              <th className="th" />
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((g) => (
              <tr key={g.id}>
                <td className="td font-medium">{g.name}</td>
                <td className="td">{label(groupTypeLabels, g.type)}</td>
                <td className="td">{g.parent_id ? byId.get(g.parent_id)?.name : "—"}</td>
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
            {data && data.length === 0 && <EmptyRow colSpan={4}>尚無群組。</EmptyRow>}
          </tbody>
        </table>
      </TableCard>
    </div>
  );
}
