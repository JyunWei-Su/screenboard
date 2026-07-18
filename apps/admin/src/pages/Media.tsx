import { useRef, useState } from "react";
import { api, contentUrl } from "../api";
import { useFetch } from "../hooks";
import { canWrite, useAuth } from "../auth";
import { PageHeader } from "../components/ui";
import { IconFileText, IconGlobe, IconVideo } from "../components/icons";
import { label, mediaTypeLabels } from "../labels";

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
    if (!confirm("要刪除媒體嗎?")) return;
    await api.del(`/api/media/${id}`);
    reload();
  }
  async function editTags(m: MediaRow) {
    const next = prompt("以逗號分隔的標籤", m.tags ?? "");
    if (next == null) return;
    await api.put(`/api/media/${m.id}/tags`, next.split(",").map((s) => s.trim()).filter(Boolean));
    reload();
  }

  return (
    <div className="space-y-5">
      <PageHeader title="媒體庫" subtitle="供播放清單使用的圖片、影片與文件">
        {writable && (
          <label className="btn-primary cursor-pointer">
            {busy ? "上傳中…" : "上傳"}
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              accept="image/*,video/*,application/pdf"
              onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
            />
          </label>
        )}
      </PageHeader>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {(data ?? []).map((m) => (
          <div key={m.id} className="card group space-y-2 p-3 transition-shadow hover:shadow-md">
            <div className="flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-slate-100 dark:bg-dark-raised">
              {m.type === "image" ? (
                <img
                  src={contentUrl(`/api/content/media/${m.id}`)}
                  className="h-full w-full object-cover transition-transform group-hover:scale-105"
                  alt={m.filename}
                  loading="lazy"
                />
              ) : (
                m.type === "video" ? <IconVideo className="h-10 w-10 text-slate-400" /> :
                  m.type === "pdf" ? <IconFileText className="h-10 w-10 text-slate-400" /> :
                    <IconGlobe className="h-10 w-10 text-slate-400" />
              )}
            </div>
            <div className="truncate text-sm font-medium" title={m.filename}>
              {m.filename}
            </div>
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>
                {label(mediaTypeLabels, m.type)} · v{m.version ?? 1}
              </span>
              <span>{m.size ? `${Math.round(m.size / 1024)} KB` : ""}</span>
            </div>
            {m.tags && (
              <div className="truncate text-xs text-brand-600">#{m.tags.split(",").join(" #")}</div>
            )}
            {writable && (
              <div className="flex gap-3 border-t border-slate-100 pt-2 text-xs dark:border-dark-border">
                <button className="font-medium text-slate-600 hover:underline" onClick={() => editTags(m)}>
                  標籤
                </button>
                <button className="font-medium text-red-600 hover:underline" onClick={() => remove(m.id)}>
                  刪除
                </button>
              </div>
            )}
          </div>
        ))}
        {data && data.length === 0 && (
          <div className="col-span-full rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-400 dark:border-dark-border dark:bg-dark-surface dark:text-dark-subtle">
            尚未上傳媒體。
          </div>
        )}
      </div>
    </div>
  );
}
