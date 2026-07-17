import { useRef, useState } from "react";
import { api, contentUrl } from "../api";
import { useFetch } from "../hooks";
import { canWrite, useAuth } from "../auth";

interface MediaRow {
  id: number;
  filename: string;
  type: string;
  size: number | null;
  version: number | null;
  tags: string | null;
}

function mediaType(mime: string): string {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  return "image";
}

export default function Media() {
  const { user } = useAuth();
  const writable = canWrite(user);
  const { data, reload } = useFetch<MediaRow[]>("/api/media");
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const type = mediaType(file.type);
      await api.uploadWithType(
        `/api/media?filename=${encodeURIComponent(file.name)}&type=${type}`,
        file.type || "application/octet-stream",
        buf,
      );
      reload();
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }
  async function remove(id: number) {
    if (!confirm("Delete media?")) return;
    await api.del(`/api/media/${id}`);
    reload();
  }
  async function editTags(m: MediaRow) {
    const next = prompt("Comma-separated tags", m.tags ?? "");
    if (next == null) return;
    await api.put(`/api/media/${m.id}/tags`, next.split(",").map((s) => s.trim()).filter(Boolean));
    reload();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Media library</h1>
        {writable && (
          <label className="btn-primary cursor-pointer">
            {busy ? "Uploading…" : "Upload"}
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              accept="image/*,video/*,application/pdf"
              onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
            />
          </label>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {(data ?? []).map((m) => (
          <div key={m.id} className="card space-y-2">
            <div className="flex aspect-video items-center justify-center overflow-hidden rounded bg-slate-100">
              {m.type === "image" ? (
                <img src={contentUrl(`/api/content/media/${m.id}`)} className="h-full w-full object-cover" alt={m.filename} />
              ) : (
                <span className="text-3xl">{m.type === "video" ? "🎬" : m.type === "pdf" ? "📄" : "🌐"}</span>
              )}
            </div>
            <div className="truncate text-sm font-medium" title={m.filename}>{m.filename}</div>
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>{m.type} · v{m.version ?? 1}</span>
              <span>{m.size ? `${Math.round(m.size / 1024)} KB` : ""}</span>
            </div>
            {m.tags && <div className="text-xs text-brand-600">#{m.tags.split(",").join(" #")}</div>}
            {writable && (
              <div className="flex gap-3 text-xs">
                <button className="text-slate-600 hover:underline" onClick={() => editTags(m)}>Tags</button>
                <button className="text-red-600 hover:underline" onClick={() => remove(m.id)}>Delete</button>
              </div>
            )}
          </div>
        ))}
        {data && data.length === 0 && (
          <div className="col-span-full text-sm text-slate-400">No media uploaded yet.</div>
        )}
      </div>
    </div>
  );
}
