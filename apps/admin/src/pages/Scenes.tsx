import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { scenesApi } from "../api";
import type { SceneSummary } from "../api";
import { useFetch } from "../hooks";
import { canWrite, useAuth } from "../auth";
import { EmptyRow, PageHeader, TableCard } from "../components/ui";
import { label, sceneStatusLabels } from "../labels";

const DEFAULT_W = 1920;
const DEFAULT_H = 1080;

export default function Scenes() {
  const { user } = useAuth();
  const writable = canWrite(user);
  const navigate = useNavigate();
  const { data, reload } = useFetch<SceneSummary[]>("/api/scenes");
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = data ?? [];
    if (!q) return rows;
    return rows.filter((s) => s.name.toLowerCase().includes(q));
  }, [data, query]);

  async function create() {
    if (!name.trim()) return;
    const scene = await scenesApi.create({ name: name.trim(), width: DEFAULT_W, height: DEFAULT_H });
    setName("");
    // Jump straight into the editor for the freshly created scene.
    if (scene?.id) navigate(`/scenes/${scene.id}`);
    else reload();
  }
  async function duplicate(id: number) {
    await scenesApi.duplicate(id);
    reload();
  }
  async function remove(id: number) {
    if (!confirm("要刪除場景嗎?此操作無法復原。")) return;
    await scenesApi.remove(id);
    reload();
  }

  return (
    <div className="space-y-5">
      <PageHeader title="場景" subtitle="以完整畫面版型組合多個元件" />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="grow">
          <label className="label">搜尋場景</label>
          <input
            className="input"
            value={query}
            placeholder="輸入名稱關鍵字…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {writable && (
        <div className="card flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="grow">
            <label className="label">新場景名稱</label>
            <input
              className="input"
              value={name}
              placeholder="例如:大廳主畫面"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
            />
          </div>
          <button className="btn-primary w-full sm:w-auto" onClick={create}>
            建立場景
          </button>
        </div>
      )}

      <TableCard>
        <table className="w-full min-w-[680px]">
          <thead>
            <tr>
              <th className="th">名稱</th>
              <th className="th">解析度</th>
              <th className="th">元件數</th>
              <th className="th">狀態</th>
              <th className="th">更新時間</th>
              <th className="th" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => (
              <tr key={s.id}>
                <td className="td">
                  <Link
                    className="font-medium text-brand-600 hover:text-brand-700 hover:underline"
                    to={`/scenes/${s.id}`}
                  >
                    {s.name}
                  </Link>
                </td>
                <td className="td whitespace-nowrap text-xs text-slate-500">
                  {s.width}×{s.height}
                </td>
                <td className="td">{s.widget_count ?? "—"}</td>
                <td className="td">
                  <span
                    className={`badge ${
                      s.status === "published"
                        ? "bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300"
                        : "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
                    }`}
                  >
                    {label(sceneStatusLabels, s.status)}
                    {s.status === "published" && s.published_version != null && ` · v${s.published_version}`}
                  </span>
                </td>
                <td className="td whitespace-nowrap text-xs text-slate-500">{s.updated_at}</td>
                <td className="td text-right">
                  {writable && (
                    <div className="flex justify-end gap-3">
                      <button
                        className="text-xs font-medium text-slate-600 hover:underline dark:text-dark-muted"
                        onClick={() => duplicate(s.id)}
                      >
                        複製
                      </button>
                      <button
                        className="text-xs font-medium text-red-600 hover:underline"
                        onClick={() => remove(s.id)}
                      >
                        刪除
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {data && filtered.length === 0 && (
              <EmptyRow colSpan={6}>{query ? "找不到符合的場景。" : "尚無場景。"}</EmptyRow>
            )}
          </tbody>
        </table>
      </TableCard>
    </div>
  );
}
