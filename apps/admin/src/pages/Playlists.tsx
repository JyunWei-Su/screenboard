import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useFetch } from "../hooks";
import { canWrite, useAuth } from "../auth";

interface Playlist {
  id: number;
  name: string;
  loop: number;
  item_count: number;
  updated_at: string;
}

export default function Playlists() {
  const { user } = useAuth();
  const writable = canWrite(user);
  const { data, reload } = useFetch<Playlist[]>("/api/playlists");
  const [name, setName] = useState("");

  async function create() {
    if (!name) return;
    await api.post("/api/playlists", { name });
    setName("");
    reload();
  }
  async function remove(id: number) {
    if (!confirm("Delete playlist?")) return;
    await api.del(`/api/playlists/${id}`);
    reload();
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Playlists</h1>

      {writable && (
        <div className="card flex items-end gap-3">
          <div className="grow">
            <label className="mb-1 block text-xs text-slate-500">New playlist name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <button className="btn-primary" onClick={create}>Create</button>
        </div>
      )}

      <div className="card p-0">
        <table className="w-full">
          <thead>
            <tr>
              <th className="th">Name</th>
              <th className="th">Items</th>
              <th className="th">Loop</th>
              <th className="th">Updated</th>
              <th className="th"></th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((p) => (
              <tr key={p.id} className="hover:bg-slate-50">
                <td className="td">
                  <Link className="font-medium text-brand-600 hover:underline" to={`/playlists/${p.id}`}>
                    {p.name}
                  </Link>
                </td>
                <td className="td">{p.item_count}</td>
                <td className="td">{p.loop ? "yes" : "no"}</td>
                <td className="td text-xs text-slate-500">{p.updated_at}</td>
                <td className="td text-right">
                  {writable && (
                    <button className="text-xs text-red-600 hover:underline" onClick={() => remove(p.id)}>
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
