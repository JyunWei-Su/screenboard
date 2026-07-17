import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import { useFetch } from "../hooks";
import { canWrite, useAuth } from "../auth";
import { PageHeader } from "../components/ui";
import { label, mediaTypeLabels } from "../labels";

interface Item {
  type: string;
  url?: string | null;
  media_id?: number | null;
  duration_sec: number;
}
interface PlaylistDetail {
  id: number;
  name: string;
  loop: number;
  items: (Item & { id: number; order_index: number })[];
}
interface MediaRow { id: number; filename: string; type: string }

const TYPES = ["url", "image", "video", "pdf", "html"];

export default function PlaylistEditor() {
  const { id } = useParams();
  const { user } = useAuth();
  const writable = canWrite(user);
  const { data } = useFetch<PlaylistDetail>(`/api/playlists/${id}`);
  const { data: media } = useFetch<MediaRow[]>("/api/media");
  const [items, setItems] = useState<Item[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data)
      setItems(
        data.items.map((i) => ({
          type: i.type,
          url: i.url,
          media_id: i.media_id,
          duration_sec: i.duration_sec,
        })),
      );
  }, [data]);

  function update(idx: number, patch: Partial<Item>) {
    setItems((xs) => xs.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
  }
  function move(idx: number, dir: -1 | 1) {
    setItems((xs) => {
      const n = [...xs];
      const j = idx + dir;
      if (j < 0 || j >= n.length) return n;
      [n[idx], n[j]] = [n[j], n[idx]];
      return n;
    });
  }
  function remove(idx: number) {
    setItems((xs) => xs.filter((_, i) => i !== idx));
  }
  function add() {
    setItems((xs) => [...xs, { type: "url", url: "", duration_sec: 10 }]);
  }
  async function save() {
    await api.put(`/api/playlists/${id}/items`, items);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  if (!data) return <div className="text-slate-400">載入中…</div>;

  return (
    <div className="space-y-5">
      <PageHeader title={data.name} subtitle={`${items.length} 個項目`}>
        {writable && (
          <>
            <button className="btn-ghost" onClick={add}>
              + 新增項目
            </button>
            <button className="btn-primary" onClick={save}>
              {saved ? "已儲存 ✓" : "儲存"}
            </button>
          </>
        )}
      </PageHeader>

      <div className="space-y-3">
        {items.map((it, idx) => {
          const isMedia = ["image", "video", "pdf", "html"].includes(it.type) && it.type !== "url";
          return (
            <div key={idx} className="card flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center self-start rounded-lg bg-slate-100 text-sm font-semibold text-slate-500 sm:self-end dark:bg-dark-raised dark:text-dark-muted">
                {idx + 1}
              </div>
              <div className="sm:w-32">
                <label className="label">類型</label>
                <select
                  className="select"
                  value={it.type}
                  disabled={!writable}
                  onChange={(e) => update(idx, { type: e.target.value })}
                >
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {label(mediaTypeLabels, t)}
                    </option>
                  ))}
                </select>
              </div>
              {it.type === "url" || it.type === "html" ? (
                <div className="grow">
                  <label className="label">URL</label>
                  <input
                    className="input"
                    value={it.url ?? ""}
                    disabled={!writable}
                    placeholder="https://…"
                    onChange={(e) => update(idx, { url: e.target.value, media_id: null })}
                  />
                </div>
              ) : (
                <div className="grow">
                  <label className="label">媒體素材</label>
                  <select
                    className="select"
                    value={it.media_id ?? ""}
                    disabled={!writable}
                    onChange={(e) => update(idx, { media_id: Number(e.target.value), url: null })}
                  >
                    <option value="">— 選擇 —</option>
                    {(media ?? [])
                      .filter((m) => m.type === it.type || isMedia)
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.filename}
                        </option>
                      ))}
                  </select>
                </div>
              )}
              <div className="sm:w-28">
                <label className="label">秒數</label>
                <input
                  className="input"
                  type="number"
                  value={it.duration_sec}
                  disabled={!writable || it.type === "video"}
                  onChange={(e) => update(idx, { duration_sec: Number(e.target.value) })}
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
          );
        })}
        {items.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-400 dark:border-dark-border dark:bg-dark-surface dark:text-dark-subtle">
            尚無項目 — 請新增一個。
          </div>
        )}
      </div>
    </div>
  );
}
