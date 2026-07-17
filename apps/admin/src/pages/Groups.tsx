import { useState } from "react";
import { api } from "../api";
import { useFetch } from "../hooks";
import { canWrite, useAuth } from "../auth";

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
    if (!confirm("Delete group?")) return;
    await api.del(`/api/groups/${id}`);
    reload();
  }

  const byId = new Map((data ?? []).map((g) => [g.id, g]));

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Groups</h1>

      {writable && (
        <div className="card flex flex-wrap items-end gap-3">
          <div className="grow">
            <label className="mb-1 block text-xs text-slate-500">Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">Type</label>
            <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
              {TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">Parent</label>
            <select className="input" value={parent} onChange={(e) => setParent(e.target.value)}>
              <option value="">— none —</option>
              {(data ?? []).map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </div>
          <button className="btn-primary" onClick={create}>Add</button>
        </div>
      )}

      <div className="card p-0">
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">Name</th>
              <th className="th">Type</th>
              <th className="th">Parent</th>
              <th className="th"></th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((g) => (
              <tr key={g.id}>
                <td className="td font-medium">{g.name}</td>
                <td className="td">{g.type}</td>
                <td className="td">{g.parent_id ? byId.get(g.parent_id)?.name : "—"}</td>
                <td className="td text-right">
                  {writable && (
                    <button className="text-xs text-red-600 hover:underline" onClick={() => remove(g.id)}>
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
