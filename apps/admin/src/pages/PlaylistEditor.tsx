import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import { useFetch } from "../hooks";
import { canWrite, useAuth } from "../auth";

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
    if (data) setItems(data.items.map((i) => ({ type: i.type, url: i.url, media_id: i.media_id, duration_sec: i.duration_sec })));
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

  if (!data) return <div className="text-slate-400">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{data.name}</h1>
        {writable && (
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={add}>+ Item</button>
            <button className="btn-primary" onClick={save}>{saved ? "Saved ✓" : "Save"}</button>
          </div>
        )}
      </div>

      <div className="space-y-2">
        {items.map((it, idx) => {
          const isMedia = ["image", "video", "pdf", "html"].includes(it.type) && it.type !== "url";
          return (
            <div key={idx} className="card flex flex-wrap items-end gap-3">
              <div className="w-24 text-sm text-slate-400">#{idx + 1}</div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">Type</label>
                <select className="input" value={it.type} disabled={!writable}
                  onChange={(e) => update(idx, { type: e.target.value })}>
                  {TYPES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </div>
              {it.type === "url" || it.type === "html" ? (
                <div className="grow">
                  <label className="mb-1 block text-xs text-slate-500">URL</label>
                  <input className="input" value={it.url ?? ""} disabled={!writable}
                    placeholder="https://…"
                    onChange={(e) => update(idx, { url: e.target.value, media_id: null })} />
                </div>
              ) : (
                <div className="grow">
                  <label className="mb-1 block text-xs text-slate-500">Media asset</label>
                  <select className="input" value={it.media_id ?? ""} disabled={!writable}
                    onChange={(e) => update(idx, { media_id: Number(e.target.value), url: null })}>
                    <option value="">— pick —</option>
                    {(media ?? []).filter((m) => m.type === it.type || isMedia).map((m) => (
                      <option key={m.id} value={m.id}>{m.filename}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="w-28">
                <label className="mb-1 block text-xs text-slate-500">Seconds</label>
                <input className="input" type="number" value={it.duration_sec} disabled={!writable || it.type === "video"}
                  onChange={(e) => update(idx, { duration_sec: Number(e.target.value) })} />
              </div>
              {writable && (
                <div className="flex gap-1">
                  <button className="btn-ghost" onClick={() => move(idx, -1)}>↑</button>
                  <button className="btn-ghost" onClick={() => move(idx, 1)}>↓</button>
                  <button className="btn-danger" onClick={() => remove(idx)}>✕</button>
                </div>
              )}
            </div>
          );
        })}
        {items.length === 0 && <div className="card text-sm text-slate-400">No items — add one.</div>}
      </div>
    </div>
  );
}
