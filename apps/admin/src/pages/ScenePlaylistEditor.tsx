import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { scenePlaylistsApi } from "../api";
import type { ScenePlaylistDetail, ScenePlaylistItemInput, SceneSummary } from "../api";
import { useFetch } from "../hooks";
import { canWrite, useAuth } from "../auth";
import { label, sceneStatusLabels } from "../labels";

interface Entry {
  scene_id: number;
  dwell_sec: number;
}

export default function ScenePlaylistEditor() {
  const { id } = useParams();
  const { user } = useAuth();
  const writable = canWrite(user);
  const { data } = useFetch<ScenePlaylistDetail>(id ? `/api/scene-playlists/${id}` : null);
  const { data: scenes } = useFetch<SceneSummary[]>("/api/scenes");

  const [name, setName] = useState("");
  const [loop, setLoop] = useState(true);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!data) return;
    setName(data.name);
    setLoop(Boolean(data.loop));
    setEntries(
      [...data.items]
        .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))
        .map((e) => ({ scene_id: e.scene_id, dwell_sec: e.dwell_sec })),
    );
  }, [data]);

  function update(idx: number, patch: Partial<Entry>) {
    setEntries((xs) => xs.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
  }
  function move(idx: number, dir: -1 | 1) {
    setEntries((xs) => {
      const n = [...xs];
      const j = idx + dir;
      if (j < 0 || j >= n.length) return n;
      [n[idx], n[j]] = [n[j], n[idx]];
      return n;
    });
  }
  function remove(idx: number) {
    setEntries((xs) => xs.filter((_, i) => i !== idx));
  }
  function add() {
    const firstScene = (scenes ?? [])[0];
    setEntries((xs) => [...xs, { scene_id: firstScene?.id ?? 0, dwell_sec: 15 }]);
  }
  async function save() {
    if (!id) return;
    await scenePlaylistsApi.patch(id, { name, loop });
    const items: ScenePlaylistItemInput[] = entries.map((e) => ({
      scene_id: e.scene_id,
      dwell_sec: e.dwell_sec,
    }));
    await scenePlaylistsApi.saveItems(id, items);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  if (!id) return <div className="text-slate-400">找不到清單。</div>;
  if (!data) return <div className="text-slate-400">載入中…</div>;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/scene-playlists" className="text-sm text-slate-400 hover:text-brand-600 hover:underline">
          場景輪播
        </Link>
        <span className="text-slate-300">/</span>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{data.name}</h1>
        <span className="text-sm text-slate-500 dark:text-dark-muted">{entries.length} 個場景</span>
        {writable && (
          <div className="ml-auto flex items-center gap-2">
            <button className="btn-ghost" onClick={add} disabled={!(scenes ?? []).length}>
              + 新增場景
            </button>
            <button className="btn-primary" onClick={save}>
              {saved ? "已儲存 ✓" : "儲存"}
            </button>
          </div>
        )}
      </div>

      <div className="card flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="grow">
          <label className="label">名稱</label>
          <input
            className="input"
            value={name}
            disabled={!writable}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300 text-brand-500 focus:ring-brand-500 dark:border-dark-border dark:bg-dark-raised"
            checked={loop}
            disabled={!writable}
            onChange={(e) => setLoop(e.target.checked)}
          />
          循環播放
        </label>
      </div>

      <div className="space-y-3">
        {entries.map((it, idx) => (
          <div key={idx} className="card flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center self-start rounded-lg bg-slate-100 text-sm font-semibold text-slate-500 sm:self-end dark:bg-dark-raised dark:text-dark-muted">
              {idx + 1}
            </div>
            <div className="grow">
              <label className="label">場景</label>
              <select
                className="select"
                value={it.scene_id || ""}
                disabled={!writable}
                onChange={(e) => update(idx, { scene_id: Number(e.target.value) })}
              >
                <option value="">— 選擇 —</option>
                {(scenes ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.status ? ` (${label(sceneStatusLabels, s.status)})` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:w-32">
              <label className="label">停留秒數</label>
              <input
                className="input"
                type="number"
                min={1}
                value={it.dwell_sec}
                disabled={!writable}
                onChange={(e) => update(idx, { dwell_sec: Number(e.target.value) })}
              />
            </div>
            {writable && (
              <div className="flex gap-1.5">
                <button className="btn-ghost btn-sm !px-2.5" onClick={() => move(idx, -1)} title="上移">
                  ↑
                </button>
                <button className="btn-ghost btn-sm !px-2.5" onClick={() => move(idx, 1)} title="下移">
                  ↓
                </button>
                <button className="btn-danger btn-sm !px-2.5" onClick={() => remove(idx)} title="移除">
                  ✕
                </button>
              </div>
            )}
          </div>
        ))}
        {entries.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-400 dark:border-dark-border dark:bg-dark-surface dark:text-dark-subtle">
            尚無場景 — 請新增一個。
          </div>
        )}
      </div>
    </div>
  );
}
