import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { scenePlaylistsApi } from "../api";
import type { ScenePlaylistSummary } from "../api";
import { useFetch } from "../hooks";
import { canWrite, useAuth } from "../auth";
import { EmptyRow, PageHeader, TableCard } from "../components/ui";

export default function ScenePlaylists() {
  const { user } = useAuth();
  const writable = canWrite(user);
  const navigate = useNavigate();
  const { data, reload } = useFetch<ScenePlaylistSummary[]>("/api/scene-playlists");
  const [name, setName] = useState("");

  async function create() {
    if (!name.trim()) return;
    const created = await scenePlaylistsApi.create({ name: name.trim() });
    setName("");
    if (created?.id) navigate(`/scene-playlists/${created.id}`);
    else reload();
  }
  async function remove(id: number) {
    if (!confirm("要刪除場景輪播清單嗎?")) return;
    await scenePlaylistsApi.remove(id);
    reload();
  }

  return (
    <div className="space-y-5">
      <PageHeader title="場景輪播" subtitle="輪播多個完整場景,而非單一媒體" />

      {writable && (
        <div className="card flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="grow">
            <label className="label">新場景輪播名稱</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
            />
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
              <th className="th">場景數</th>
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
                    to={`/scene-playlists/${p.id}`}
                  >
                    {p.name}
                  </Link>
                </td>
                <td className="td">{p.item_count ?? "—"}</td>
                <td className="td">
                  <span
                    className={`badge ${
                      p.loop
                        ? "bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300"
                        : "bg-slate-100 text-slate-500 dark:bg-dark-raised dark:text-dark-muted"
                    }`}
                  >
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
            {data && data.length === 0 && <EmptyRow colSpan={5}>尚無場景輪播清單。</EmptyRow>}
          </tbody>
        </table>
      </TableCard>
    </div>
  );
}
