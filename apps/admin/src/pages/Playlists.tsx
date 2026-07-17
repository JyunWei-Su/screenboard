import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useFetch } from "../hooks";
import { canWrite, useAuth } from "../auth";
import { EmptyRow, PageHeader, TableCard } from "../components/ui";

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
    if (!confirm("要刪除播放清單嗎?")) return;
    await api.del(`/api/playlists/${id}`);
    reload();
  }

  return (
    <div className="space-y-5">
      <PageHeader title="播放清單" subtitle="顯示在螢幕上的內容序列" />

      {writable && (
        <div className="card flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="grow">
            <label className="label">新播放清單名稱</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <button className="btn-primary w-full sm:w-auto" onClick={create}>
            建立
          </button>
        </div>
      )}

      <TableCard>
        <table className="w-full min-w-[600px]">
          <thead>
            <tr>
              <th className="th">名稱</th>
              <th className="th">項目數</th>
              <th className="th">循環</th>
              <th className="th">更新時間</th>
              <th className="th" />
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((p) => (
              <tr key={p.id}>
                <td className="td">
                  <Link
                    className="font-medium text-brand-600 hover:text-brand-700 hover:underline"
                    to={`/playlists/${p.id}`}
                  >
                    {p.name}
                  </Link>
                </td>
                <td className="td">{p.item_count}</td>
                <td className="td">
                  <span className={`badge ${p.loop ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"}`}>
                    {p.loop ? "是" : "否"}
                  </span>
                </td>
                <td className="td whitespace-nowrap text-xs text-slate-500">{p.updated_at}</td>
                <td className="td text-right">
                  {writable && (
                    <button
                      className="text-xs font-medium text-red-600 hover:underline"
                      onClick={() => remove(p.id)}
                    >
                      刪除
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {data && data.length === 0 && <EmptyRow colSpan={5}>尚無播放清單。</EmptyRow>}
          </tbody>
        </table>
      </TableCard>
    </div>
  );
}
