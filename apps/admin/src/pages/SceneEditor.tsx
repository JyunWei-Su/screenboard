import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { contentUrl, scenesApi } from "../api";
import type { SceneDetailResponse, SceneVersionRow, WidgetInput } from "../api";
import { useFetch } from "../hooks";
import { canWrite, useAuth } from "../auth";
import { PageHeader } from "../components/ui";
import {
  IconCheck,
  IconClock,
  IconCompass,
  IconCopy,
  IconEye,
  IconEyeOff,
  IconGlobe,
  IconImage,
  IconLock,
  IconTrash,
  IconType,
  IconUnlock,
  IconVideo,
} from "../components/icons";
import {
  alignLabels,
  clockDateFormatLabels,
  clockFormatLabels,
  clockLocaleLabels,
  directionArrowGlyphs,
  directionArrowLabels,
  label,
  objectFitLabels,
  sceneStatusLabels,
  tickerDirectionLabels,
  webModeLabels,
  widgetKindLabels,
} from "../labels";
import type {
  ClockWidgetConfig,
  CarouselWidgetConfig,
  DirectionArrow,
  DirectionWidgetConfig,
  ImageWidgetConfig,
  ObjectFit,
  Scene,
  SceneBackground,
  SceneWidget,
  TextWidgetConfig,
  TickerWidgetConfig,
  VideoWidgetConfig,
  WebWidgetConfig,
  WidgetConfig,
  WidgetKind,
} from "@screenboard/shared";

// ---- editor model ----------------------------------------------------------

interface EditorWidget {
  uid: number; // client-only stable id (React keys / selection)
  kind: WidgetKind;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  visible: boolean;
  locked: boolean;
  config: WidgetConfig;
}

interface MediaRow {
  id: number;
  filename: string;
  type: string;
}

interface Guide {
  axis: "x" | "y";
  pos: number;
}

const WIDGET_KINDS: WidgetKind[] = [
  "carousel",
  "web",
  "text",
  "direction",
  "clock",
];

// One icon per widget kind, shared by the「新增元件」palette, the selected-widget
// header, and the「圖層」list so a given kind always looks the same.
const KIND_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  carousel: IconImage,
  web: IconGlobe,
  text: IconType,
  direction: IconCompass,
  clock: IconClock,
};

const PRESETS: { label: string; w: number; h: number }[] = [
  { label: "1920×1080 (橫)", w: 1920, h: 1080 },
  { label: "1080×1920 (直)", w: 1080, h: 1920 },
  { label: "3840×2160 (4K)", w: 3840, h: 2160 },
  { label: "1280×720", w: 1280, h: 720 },
];

const SNAP_PX = 8; // snap threshold in on-screen pixels
const MIN_SIZE = 20; // minimum widget size in canvas px
const DEFAULT_BG = "#0f172a";

// Sites that reliably refuse to be iframed (X-Frame-Options / frame-ancestors).
const NON_EMBEDDABLE = [
  "google.com",
  "youtube.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
];

function defaultConfig(kind: WidgetKind): WidgetConfig {
  switch (kind) {
    case "image":
      return { fit: "contain" } as ImageWidgetConfig;
    case "video":
      return { fit: "cover", muted: true, loop: true } as VideoWidgetConfig;
    case "carousel":
      return { items: [], loop: true } as CarouselWidgetConfig;
    case "web":
      return { url: "", mode: "embed", refresh_sec: 0 } as WebWidgetConfig;
    case "text":
      return {
        text: "文字內容",
        font_size: 64,
        color: "#ffffff",
        align: "center",
        weight: 600,
      } as TextWidgetConfig;
    case "ticker":
      return {
        text: "跑馬燈文字…",
        speed: 80,
        direction: "left",
        color: "#ffffff",
        background: "#111827",
        font_size: 40,
      } as TickerWidgetConfig;
    case "direction":
      return {
        entries: [
          { label: "會議室", arrow: "right" },
          { label: "洗手間", arrow: "left" },
        ],
        color: "#ffffff",
        background: "#111827",
        font_size: 40,
      } as DirectionWidgetConfig;
    case "clock":
      return {
        format: "24h",
        show_date: true,
        show_lunar: false,
        locale: "zh-TW",
        date_format: "numeric",
        timezone: "",
        color: "#ffffff",
        font_size: 96,
      } as ClockWidgetConfig;
  }
}

function defaultSize(kind: WidgetKind, W: number, H: number): { w: number; h: number } {
  switch (kind) {
    case "image":
    case "video":
    case "carousel":
      return { w: Math.round(W * 0.35), h: Math.round(H * 0.35) };
    case "web":
      return { w: Math.round(W * 0.4), h: Math.round(H * 0.5) };
    case "text":
      return { w: Math.round(W * 0.3), h: Math.round(H * 0.12) };
    case "ticker":
      return { w: W, h: Math.round(H * 0.08) };
    case "direction":
      return { w: Math.round(W * 0.25), h: Math.round(H * 0.3) };
    case "clock":
      return { w: Math.round(W * 0.25), h: Math.round(H * 0.15) };
  }
}

function normalizeSceneDetail(raw: SceneDetailResponse): { scene: Scene; widgets: SceneWidget[] } {
  const scene = (raw.scene ?? raw) as Scene;
  const widgets = (raw.widgets ?? []) as SceneWidget[];
  return { scene, widgets };
}

function tickerGlyph(dir: TickerWidgetConfig["direction"]): string {
  switch (dir) {
    case "right":
      return "▶";
    case "up":
      return "▲";
    case "down":
      return "▼";
    default:
      return "◀";
  }
}

function formatClock(cfg: ClockWidgetConfig, now: Date): { time: string; date: string; lunar: string } {
  const locale = cfg.locale ?? "zh-TW";
  const timeOpts: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: cfg.format === "12h",
  };
  const dateOpts: Intl.DateTimeFormatOptions = cfg.date_format === "short"
    ? { year: "numeric", month: "numeric", day: "numeric" }
    : cfg.date_format === "long"
      ? { year: "numeric", month: "long", day: "numeric", weekday: "long" }
      : { year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" };
  const lunarOpts: Intl.DateTimeFormatOptions = { month: "long", day: "numeric", weekday: "short" };
  if (cfg.timezone) {
    timeOpts.timeZone = cfg.timezone;
    dateOpts.timeZone = cfg.timezone;
    lunarOpts.timeZone = cfg.timezone;
  }
  try {
    return {
      time: new Intl.DateTimeFormat(locale, timeOpts).format(now),
      date: new Intl.DateTimeFormat(locale, dateOpts).format(now),
      lunar: new Intl.DateTimeFormat(`${locale}-u-ca-chinese`, lunarOpts).format(now),
    };
  } catch {
    // Invalid timezone — fall back to device local time.
    return {
      time: new Intl.DateTimeFormat(locale, { ...timeOpts, timeZone: undefined }).format(now),
      date: new Intl.DateTimeFormat(locale, { ...dateOpts, timeZone: undefined }).format(now),
      lunar: new Intl.DateTimeFormat(`${locale}-u-ca-chinese`, { ...lunarOpts, timeZone: undefined }).format(now),
    };
  }
}

function isLikelyNonEmbeddable(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return NON_EMBEDDABLE.some((b) => host === b || host.endsWith("." + b));
  } catch {
    return false;
  }
}

function boxesOverlap(a: EditorWidget, b: EditorWidget): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

// ---- main component --------------------------------------------------------

export default function SceneEditor() {
  const params = useParams();
  const id = params.id;
  const { user } = useAuth();
  const writable = canWrite(user);

  const { data, reload } = useFetch<SceneDetailResponse>(id ? `/api/scenes/${id}` : null);
  const { data: media } = useFetch<MediaRow[]>("/api/media");

  // ---- scene meta (editable) ----
  const [name, setName] = useState("");
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);
  const [background, setBackground] = useState<SceneBackground>({});
  const [status, setStatus] = useState<Scene["status"]>("draft");
  const [publishedVersion, setPublishedVersion] = useState<number | null>(null);

  const [widgets, setWidgets] = useState<EditorWidget[]>([]);
  const [selectedUid, setSelectedUid] = useState<number | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [versions, setVersions] = useState<SceneVersionRow[] | null>(null);
  const [showVersions, setShowVersions] = useState(false);

  const uidRef = useRef(1);
  const nextUid = () => uidRef.current++;

  // Populate local editing state from the server payload (initial load + rollback).
  useEffect(() => {
    if (!data) return;
    const { scene, widgets: raw } = normalizeSceneDetail(data);
    setName(scene.name);
    setWidth(scene.width);
    setHeight(scene.height);
    setBackground(scene.background ?? {});
    setStatus(scene.status);
    setPublishedVersion(scene.published_version);
    const sorted = [...raw].sort((a, b) => a.z - b.z);
    setWidgets(
      sorted.map((w, i) => ({
        uid: nextUid(),
        kind: w.kind,
        x: w.x,
        y: w.y,
        width: w.width,
        height: w.height,
        z: i, // normalize z to a sequential stack index
        visible: w.visible,
        locked: w.locked,
        config: w.config,
      })),
    );
    setSelectedUid(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // ---- canvas scaling ----
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wrapW, setWrapW] = useState(800);
  const [maxH, setMaxH] = useState(() => Math.max(320, window.innerHeight * 0.6));

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWrapW(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onResize = () => setMaxH(Math.max(320, window.innerHeight * 0.6));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const safeW = Math.max(1, width);
  const safeH = Math.max(1, height);
  const scale = Math.min(wrapW / safeW, maxH / safeH) || 0.01;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  // ---- clock ticking (only when a clock widget exists) ----
  const hasClock = widgets.some((w) => w.kind === "clock");
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!hasClock) return;
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, [hasClock]);

  // ---- widget mutators ----
  const patchWidget = (uid: number, patch: Partial<EditorWidget>) =>
    setWidgets((ws) => ws.map((w) => (w.uid === uid ? { ...w, ...patch } : w)));

  const setWidgetConfig = (uid: number, config: WidgetConfig) =>
    setWidgets((ws) => ws.map((w) => (w.uid === uid ? { ...w, config } : w)));

  function addWidget(kind: WidgetKind) {
    const size = defaultSize(kind, safeW, safeH);
    const maxZ = widgets.reduce((m, w) => Math.max(m, w.z), -1);
    const uid = nextUid();
    const w: EditorWidget = {
      uid,
      kind,
      x: kind === "ticker" ? 0 : Math.round((safeW - size.w) / 2),
      y: kind === "ticker" ? Math.round(safeH - size.h) : Math.round((safeH - size.h) / 2),
      width: size.w,
      height: size.h,
      z: maxZ + 1,
      visible: true,
      locked: false,
      config: defaultConfig(kind),
    };
    setWidgets((ws) => [...ws, w]);
    setSelectedUid(uid);
  }

  function removeWidget(uid: number) {
    setWidgets((ws) => ws.filter((w) => w.uid !== uid));
    setSelectedUid((s) => (s === uid ? null : s));
  }

  function duplicateWidget(uid: number) {
    const src = widgets.find((w) => w.uid === uid);
    if (!src) return;
    const maxZ = widgets.reduce((m, w) => Math.max(m, w.z), -1);
    const nuid = nextUid();
    setWidgets((ws) => [
      ...ws,
      {
        ...src,
        uid: nuid,
        x: src.x + 24,
        y: src.y + 24,
        z: maxZ + 1,
        config: JSON.parse(JSON.stringify(src.config)) as WidgetConfig,
      },
    ]);
    setSelectedUid(nuid);
  }

  // dir: +1 bring forward (raise), -1 send backward (lower)
  function reorder(uid: number, dir: 1 | -1) {
    setWidgets((ws) => {
      const sorted = [...ws].sort((a, b) => a.z - b.z);
      const i = sorted.findIndex((w) => w.uid === uid);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= sorted.length) return ws;
      const zi = sorted[i].z;
      const zj = sorted[j].z;
      return ws.map((w) =>
        w.uid === sorted[i].uid ? { ...w, z: zj } : w.uid === sorted[j].uid ? { ...w, z: zi } : w,
      );
    });
  }

  // ---- pointer drag / resize ----
  function beginDrag(e: React.MouseEvent, w: EditorWidget) {
    if (!writable || w.locked) return;
    e.preventDefault();
    e.stopPropagation();
    setSelectedUid(w.uid);
    const startX = w.x;
    const startY = w.y;
    const sx = e.clientX;
    const sy = e.clientY;
    const sc = scaleRef.current;
    const thr = SNAP_PX / sc;
    const others = widgets.filter((o) => o.uid !== w.uid && o.visible);

    const move = (ev: MouseEvent) => {
      let nx = startX + (ev.clientX - sx) / sc;
      let ny = startY + (ev.clientY - sy) / sc;
      const g: Guide[] = [];
      const targetsX = [0, safeW / 2, safeW];
      const targetsY = [0, safeH / 2, safeH];
      for (const o of others) {
        targetsX.push(o.x, o.x + o.width / 2, o.x + o.width);
        targetsY.push(o.y, o.y + o.height / 2, o.y + o.height);
      }
      const sxr = snapEdges([nx, nx + w.width / 2, nx + w.width], targetsX, thr);
      if (sxr) {
        nx += sxr.shift;
        g.push({ axis: "x", pos: sxr.target });
      }
      const syr = snapEdges([ny, ny + w.height / 2, ny + w.height], targetsY, thr);
      if (syr) {
        ny += syr.shift;
        g.push({ axis: "y", pos: syr.target });
      }
      patchWidget(w.uid, { x: nx, y: ny });
      setGuides(g);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      setGuides([]);
      // finalize: snap the live float coordinates to whole pixels
      setWidgets((ws) =>
        ws.map((x) => (x.uid === w.uid ? { ...x, x: Math.round(x.x), y: Math.round(x.y) } : x)),
      );
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  function beginResize(e: React.MouseEvent, w: EditorWidget, hx: -1 | 0 | 1, hy: -1 | 0 | 1) {
    if (!writable || w.locked) return;
    e.preventDefault();
    e.stopPropagation();
    setSelectedUid(w.uid);
    const startX = w.x;
    const startY = w.y;
    const startW = w.width;
    const startH = w.height;
    const sx = e.clientX;
    const sy = e.clientY;
    const sc = scaleRef.current;
    const thr = SNAP_PX / sc;
    const others = widgets.filter((o) => o.uid !== w.uid && o.visible);
    const targetsX = [0, safeW];
    const targetsY = [0, safeH];
    for (const o of others) {
      targetsX.push(o.x, o.x + o.width);
      targetsY.push(o.y, o.y + o.height);
    }

    const move = (ev: MouseEvent) => {
      const dx = (ev.clientX - sx) / sc;
      const dy = (ev.clientY - sy) / sc;
      let nx = startX;
      let ny = startY;
      let nw = startW;
      let nh = startH;
      const g: Guide[] = [];
      if (hx === -1) {
        nx = startX + dx;
        nw = startW - dx;
      } else if (hx === 1) {
        nw = startW + dx;
      }
      if (hy === -1) {
        ny = startY + dy;
        nh = startH - dy;
      } else if (hy === 1) {
        nh = startH + dy;
      }
      // enforce minimum size
      if (nw < MIN_SIZE) {
        if (hx === -1) nx = startX + startW - MIN_SIZE;
        nw = MIN_SIZE;
      }
      if (nh < MIN_SIZE) {
        if (hy === -1) ny = startY + startH - MIN_SIZE;
        nh = MIN_SIZE;
      }
      // snap the active edges
      if (hx === 1) {
        const t = nearest(nx + nw, targetsX, thr);
        if (t != null) {
          nw = t - nx;
          g.push({ axis: "x", pos: t });
        }
      } else if (hx === -1) {
        const right = nx + nw;
        const t = nearest(nx, targetsX, thr);
        if (t != null) {
          nx = t;
          nw = right - nx;
          g.push({ axis: "x", pos: t });
        }
      }
      if (hy === 1) {
        const t = nearest(ny + nh, targetsY, thr);
        if (t != null) {
          nh = t - ny;
          g.push({ axis: "y", pos: t });
        }
      } else if (hy === -1) {
        const bottom = ny + nh;
        const t = nearest(ny, targetsY, thr);
        if (t != null) {
          ny = t;
          nh = bottom - ny;
          g.push({ axis: "y", pos: t });
        }
      }
      patchWidget(w.uid, { x: nx, y: ny, width: Math.max(MIN_SIZE, nw), height: Math.max(MIN_SIZE, nh) });
      setGuides(g);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      setGuides([]);
      setWidgets((ws) =>
        ws.map((x) =>
          x.uid === w.uid
            ? {
                ...x,
                x: Math.round(x.x),
                y: Math.round(x.y),
                width: Math.round(x.width),
                height: Math.round(x.height),
              }
            : x,
        ),
      );
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  // ---- keyboard nudge / delete ----
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!writable || selectedUid == null) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const sel = widgets.find((w) => w.uid === selectedUid);
      if (!sel || sel.locked) return;
      const step = e.shiftKey ? 10 : 1;
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          patchWidget(selectedUid, { x: sel.x - step });
          break;
        case "ArrowRight":
          e.preventDefault();
          patchWidget(selectedUid, { x: sel.x + step });
          break;
        case "ArrowUp":
          e.preventDefault();
          patchWidget(selectedUid, { y: sel.y - step });
          break;
        case "ArrowDown":
          e.preventDefault();
          patchWidget(selectedUid, { y: sel.y + step });
          break;
        case "Delete":
        case "Backspace":
          e.preventDefault();
          removeWidget(selectedUid);
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUid, widgets, writable]);

  // ---- save / publish / versions ----
  function flashMsg(text: string) {
    setFlash(text);
    window.setTimeout(() => setFlash(null), 1800);
  }

  async function persist() {
    if (!id) return;
    await scenesApi.patch(id, { name, width: safeW, height: safeH, background });
    const payload: WidgetInput[] = [...widgets]
      .sort((a, b) => a.z - b.z)
      .map((w, i) => ({
        kind: w.kind,
        x: Math.round(w.x),
        y: Math.round(w.y),
        width: Math.round(w.width),
        height: Math.round(w.height),
        z: i,
        visible: w.visible,
        locked: w.locked,
        config: w.config,
      }));
    await scenesApi.saveWidgets(id, payload);
  }

  async function saveDraft() {
    if (!id) return;
    setBusy(true);
    try {
      await persist();
      flashMsg("已儲存草稿");
    } catch (err) {
      alert(err instanceof Error ? err.message : "儲存失敗");
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!id) return;
    if (!confirm("要發布此場景嗎?系統會先儲存目前草稿並建立新版本。")) return;
    setBusy(true);
    try {
      await persist();
      const res = await scenesApi.publish(id);
      setStatus("published");
      if (typeof res?.version === "number") setPublishedVersion(res.version);
      flashMsg("已發布");
      if (showVersions) void loadVersions();
    } catch (err) {
      alert(err instanceof Error ? err.message : "發布失敗");
    } finally {
      setBusy(false);
    }
  }

  async function loadVersions() {
    if (!id) return;
    try {
      setVersions(await scenesApi.versions(id));
    } catch {
      setVersions([]);
    }
  }

  function toggleVersions() {
    const next = !showVersions;
    setShowVersions(next);
    if (next && versions == null) void loadVersions();
  }

  async function rollback(version: number) {
    if (!id) return;
    if (!confirm(`要回退到版本 v${version} 嗎?目前未儲存的變更將會遺失。`)) return;
    setBusy(true);
    try {
      await scenesApi.rollback(id, version);
      reload(); // repopulates local state via the data effect
      flashMsg(`已回退至 v${version}`);
      void loadVersions();
    } catch (err) {
      alert(err instanceof Error ? err.message : "回退失敗");
    } finally {
      setBusy(false);
    }
  }

  // ---- warnings ----
  const warnings = useMemo(() => computeWarnings(widgets, safeW, safeH), [widgets, safeW, safeH]);

  const selected = widgets.find((w) => w.uid === selectedUid) ?? null;
  const stackDesc = [...widgets].sort((a, b) => b.z - a.z); // top layer first
  const bgColor = background.color || DEFAULT_BG;
  const bgMediaSrc = background.media_id ? contentUrl(`/api/content/media/${background.media_id}`) : null;

  if (!id) return <div className="text-slate-400">找不到場景。</div>;
  if (!data) return <div className="text-slate-400">載入中…</div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/scenes" className="text-sm text-slate-400 hover:text-brand-600 hover:underline">
          場景
        </Link>
        <span className="text-slate-300">/</span>
        <input
          className="input w-full max-w-xs !py-1.5 text-base font-semibold sm:w-auto"
          value={name}
          disabled={!writable}
          onChange={(e) => setName(e.target.value)}
        />
        <span
          className={`badge ${
            status === "published"
              ? "bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300"
              : "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
          }`}
        >
          {label(sceneStatusLabels, status)}
          {status === "published" && publishedVersion != null && ` · v${publishedVersion}`}
        </span>
        {flash && <span className="inline-flex items-center gap-1 text-sm font-medium text-green-600"><IconCheck className="h-4 w-4" />{flash}</span>}
        {writable && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button className="btn-ghost" onClick={toggleVersions}>
              版本紀錄
            </button>
            <button className="btn-ghost" onClick={saveDraft} disabled={busy}>
              {busy ? "處理中…" : "儲存草稿"}
            </button>
            <button className="btn-primary" onClick={publish} disabled={busy}>
              發布
            </button>
          </div>
        )}
      </div>

      {showVersions && (
        <div className="card space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="card-title">版本紀錄</h2>
            <button className="btn-ghost btn-sm" onClick={() => void loadVersions()}>
              重新整理
            </button>
          </div>
          {versions == null && <p className="text-xs text-slate-400">載入中…</p>}
          {versions && versions.length === 0 && (
            <p className="text-xs text-slate-400">尚無已發布版本。</p>
          )}
          <div className="space-y-1">
            {(versions ?? []).map((v) => (
              <div
                key={v.version}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-100 px-3 py-2 text-sm dark:border-dark-border"
              >
                <div>
                  <span className="font-medium">v{v.version}</span>
                  {v.created_at && <span className="ml-2 text-xs text-slate-400">{v.created_at}</span>}
                  {v.note && <span className="ml-2 text-xs text-slate-500">{v.note}</span>}
                </div>
                {writable && v.version !== publishedVersion && (
                  <button
                    className="text-xs font-medium text-brand-600 hover:underline"
                    onClick={() => void rollback(v.version)}
                  >
                    回退至此版本
                  </button>
                )}
                {v.version === publishedVersion && (
                  <span className="text-xs text-green-600">目前版本</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* palette */}
      {writable && (
        <div className="card flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-slate-500 dark:text-dark-muted">新增元件:</span>
          {WIDGET_KINDS.map((k) => {
            const Icon = KIND_ICONS[k];
            return (
              <button
                key={k}
                className="btn-ghost btn-sm"
                onClick={() => addWidget(k)}
                title={`新增${label(widgetKindLabels, k)}`}
              >
                <Icon className="mr-1 h-4 w-4" />
                {label(widgetKindLabels, k)}
              </button>
            );
          })}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        {/* canvas column */}
        <div className="space-y-3">
          {/* resolution presets */}
          <div className="card flex flex-wrap items-end gap-3">
            <div>
              <label className="label">解析度預設</label>
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((p) => (
                  <button
                    key={p.label}
                    className={`btn-sm ${
                      width === p.w && height === p.h ? "btn-primary" : "btn-ghost"
                    }`}
                    disabled={!writable}
                    onClick={() => {
                      setWidth(p.w);
                      setHeight(p.h);
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-end gap-2">
              <div className="w-24">
                <label className="label">寬 (px)</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={width}
                  disabled={!writable}
                  onChange={(e) => setWidth(Math.max(1, Number(e.target.value)))}
                />
              </div>
              <span className="pb-2 text-slate-400">×</span>
              <div className="w-24">
                <label className="label">高 (px)</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={height}
                  disabled={!writable}
                  onChange={(e) => setHeight(Math.max(1, Number(e.target.value)))}
                />
              </div>
            </div>
            <div className="ml-auto text-xs text-slate-400">縮放 {Math.round(scale * 100)}%</div>
          </div>

          {/* the canvas */}
          <div ref={wrapRef} className="card overflow-hidden">
            <div
              className="relative mx-auto select-none overflow-hidden shadow-inner"
              style={{ width: safeW * scale, height: safeH * scale, background: bgColor }}
              onMouseDown={() => setSelectedUid(null)}
            >
              {bgMediaSrc && (
                <img
                  src={bgMediaSrc}
                  className="pointer-events-none absolute inset-0 h-full w-full object-cover"
                  alt=""
                />
              )}
              {[...widgets]
                .sort((a, b) => a.z - b.z)
                .map((w) => {
                  const isSel = w.uid === selectedUid;
                  return (
                    <div
                      key={w.uid}
                      className={`absolute ${w.locked ? "cursor-not-allowed" : "cursor-move"} ${
                        w.visible ? "" : "opacity-30"
                      }`}
                      style={{
                        left: w.x * scale,
                        top: w.y * scale,
                        width: w.width * scale,
                        height: w.height * scale,
                        outline: isSel ? "2px solid #ec4899" : "1px dashed rgba(148,163,184,0.7)",
                        outlineOffset: 0,
                      }}
                      onMouseDown={(e) => beginDrag(e, w)}
                    >
                      <WidgetView w={w} scale={scale} media={media ?? []} now={now} />
                      {isSel && writable && !w.locked && <ResizeHandles onStart={beginResize} w={w} />}
                    </div>
                  );
                })}

              {/* alignment guides */}
              {guides.map((g, i) =>
                g.axis === "x" ? (
                  <div
                    key={`gx-${i}`}
                    className="pointer-events-none absolute top-0 bottom-0 w-px bg-pink-500"
                    style={{ left: g.pos * scale }}
                  />
                ) : (
                  <div
                    key={`gy-${i}`}
                    className="pointer-events-none absolute left-0 right-0 h-px bg-pink-500"
                    style={{ top: g.pos * scale }}
                  />
                ),
              )}
            </div>
          </div>

          {/* warnings */}
          {warnings.length > 0 && (
            <div className="card space-y-1 border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10">
              <h2 className="text-sm font-semibold text-amber-700 dark:text-amber-300">
                注意事項 ({warnings.length})
              </h2>
              <ul className="space-y-0.5 text-xs text-amber-700 dark:text-amber-200">
                {warnings.map((wn, i) => (
                  <li key={i}>• {wn}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* right panel */}
        <div className="space-y-4">
          {/* scene background */}
          <div className="card space-y-3">
            <h2 className="card-title">場景背景</h2>
            <ColorField
              label="背景顏色"
              value={background.color ?? ""}
              disabled={!writable}
              onChange={(v) => setBackground((b) => ({ ...b, color: v || undefined }))}
            />
            <div>
              <label className="label">背景圖片 (選填)</label>
              <select
                className="select"
                value={background.media_id ?? ""}
                disabled={!writable}
                onChange={(e) =>
                  setBackground((b) => ({
                    ...b,
                    media_id: e.target.value ? Number(e.target.value) : undefined,
                  }))
                }
              >
                <option value="">— 無 —</option>
                {(media ?? [])
                  .filter((m) => m.type === "image")
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.filename}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          {/* selected widget config */}
          {selected ? (
            <div className="card space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="card-title">
                  {(() => {
                    const Icon = KIND_ICONS[selected.kind];
                    return Icon ? <Icon className="mr-1 inline-block h-4 w-4 align-text-bottom" /> : null;
                  })()}
                  {label(widgetKindLabels, selected.kind)}
                </h2>
                {writable && (
                  <div className="flex gap-1.5">
                    <button
                      className="btn-ghost btn-sm !px-2"
                      title="複製元件"
                      onClick={() => duplicateWidget(selected.uid)}
                    >
                      ⧉
                    </button>
                    <button
                      className="btn-danger btn-sm !px-2"
                      title="刪除元件"
                      onClick={() => removeWidget(selected.uid)}
                    >
                      <IconTrash className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>

              {/* geometry + layer controls */}
              <div className="grid grid-cols-2 gap-2">
                <NumberField
                  label="X"
                  value={Math.round(selected.x)}
                  disabled={!writable || selected.locked}
                  onChange={(v) => patchWidget(selected.uid, { x: v })}
                />
                <NumberField
                  label="Y"
                  value={Math.round(selected.y)}
                  disabled={!writable || selected.locked}
                  onChange={(v) => patchWidget(selected.uid, { y: v })}
                />
                <NumberField
                  label="寬"
                  value={Math.round(selected.width)}
                  min={MIN_SIZE}
                  disabled={!writable || selected.locked}
                  onChange={(v) => patchWidget(selected.uid, { width: Math.max(MIN_SIZE, v) })}
                />
                <NumberField
                  label="高"
                  value={Math.round(selected.height)}
                  min={MIN_SIZE}
                  disabled={!writable || selected.locked}
                  onChange={(v) => patchWidget(selected.uid, { height: Math.max(MIN_SIZE, v) })}
                />
              </div>
              {writable && (
                <div className="flex flex-wrap gap-1.5">
                  <button className="btn-ghost btn-sm" onClick={() => reorder(selected.uid, 1)}>
                    上移一層
                  </button>
                  <button className="btn-ghost btn-sm" onClick={() => reorder(selected.uid, -1)}>
                    下移一層
                  </button>
                  <button
                    className="btn-ghost btn-sm"
                    onClick={() => patchWidget(selected.uid, { locked: !selected.locked })}
                  >
                    {selected.locked ? <IconUnlock className="h-4 w-4" /> : <IconLock className="h-4 w-4" />}
                    <span>{selected.locked ? "解鎖" : "鎖定"}</span>
                  </button>
                  <button
                    className="btn-ghost btn-sm"
                    onClick={() => patchWidget(selected.uid, { visible: !selected.visible })}
                  >
                    {selected.visible ? <IconEyeOff className="h-4 w-4" /> : <IconEye className="h-4 w-4" />}
                    <span>{selected.visible ? "隱藏" : "顯示"}</span>
                  </button>
                </div>
              )}

              <div className="border-t border-slate-100 pt-3 dark:border-dark-border">
                <WidgetConfigForm
                  widget={selected}
                  media={media ?? []}
                  disabled={!writable || selected.locked}
                  onChange={(cfg) => setWidgetConfig(selected.uid, cfg)}
                />
              </div>
            </div>
          ) : (
            <div className="card text-sm text-slate-400">點選畫布上的元件以編輯屬性。</div>
          )}

          {/* layers list */}
          <div className="card space-y-2">
            <h2 className="card-title">圖層 ({widgets.length})</h2>
            {widgets.length === 0 && <p className="text-xs text-slate-400">尚無元件。</p>}
            <div className="space-y-1">
              {stackDesc.map((w) => (
                <div
                  key={w.uid}
                  className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
                    w.uid === selectedUid
                      ? "bg-brand-50 dark:bg-brand-500/15"
                      : "hover:bg-slate-50 dark:hover:bg-white/5"
                  }`}
                >
                  <button
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => setSelectedUid(w.uid)}
                  >
                    {(() => {
                      const Icon = KIND_ICONS[w.kind];
                      return Icon ? <Icon className="h-4 w-4 shrink-0" /> : null;
                    })()}
                    <span className="truncate">{label(widgetKindLabels, w.kind)}</span>
                  </button>
                  {writable && (
                    <>
                      <button
                        className="text-slate-400 hover:text-slate-700 dark:hover:text-dark-text"
                        title={w.visible ? "隱藏" : "顯示"}
                        onClick={() => patchWidget(w.uid, { visible: !w.visible })}
                      >
                        {w.visible ? <IconEyeOff className="h-4 w-4" /> : <IconEye className="h-4 w-4" />}
                      </button>
                      <button
                        className="text-slate-400 hover:text-slate-700 dark:hover:text-dark-text"
                        title={w.locked ? "解鎖" : "鎖定"}
                        onClick={() => patchWidget(w.uid, { locked: !w.locked })}
                      >
                        {w.locked ? <IconUnlock className="h-4 w-4" /> : <IconLock className="h-4 w-4" />}
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- snap helpers ----------------------------------------------------------

function nearest(value: number, targets: number[], threshold: number): number | null {
  let best: number | null = null;
  let bestDist = threshold;
  for (const t of targets) {
    const d = Math.abs(value - t);
    if (d <= bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return best;
}

// Snap any of the given widget edges onto the nearest target; returns the shift
// to apply to the widget position plus the guide line target, or null.
function snapEdges(
  edges: number[],
  targets: number[],
  threshold: number,
): { shift: number; target: number } | null {
  let best: { shift: number; target: number } | null = null;
  let bestDist = threshold;
  for (const e of edges) {
    for (const t of targets) {
      const d = Math.abs(e - t);
      if (d <= bestDist) {
        bestDist = d;
        best = { shift: t - e, target: t };
      }
    }
  }
  return best;
}

// ---- warnings --------------------------------------------------------------

function computeWarnings(widgets: EditorWidget[], W: number, H: number): string[] {
  const out: string[] = [];
  const nameOf = (w: EditorWidget, list: EditorWidget[]) => {
    const kindLabel = widgetKindLabels[w.kind] ?? w.kind;
    const idx = list.findIndex((x) => x.uid === w.uid) + 1;
    return `${kindLabel} #${idx}`;
  };
  const list = [...widgets].sort((a, b) => a.z - b.z);

  for (const w of list) {
    if (w.x < 0 || w.y < 0 || w.x + w.width > W || w.y + w.height > H) {
      out.push(`元件「${nameOf(w, list)}」超出畫布範圍`);
    }
    if ((w.kind === "image" || w.kind === "video")) {
      const cfg = w.config as ImageWidgetConfig | VideoWidgetConfig;
      if (!cfg.media_id && !cfg.url) {
        out.push(`元件「${nameOf(w, list)}」尚未選擇素材`);
      }
    }
    if (w.kind === "carousel") {
      const cfg = w.config as CarouselWidgetConfig;
      if (!cfg.items?.length) out.push(`媒體元件「${nameOf(w, list)}」至少需要一個項目`);
      if ((cfg.items ?? []).some((item) => !item.media_id && !item.url)) out.push(`媒體元件「${nameOf(w, list)}」有未設定素材的項目`);
    }
    if (w.kind === "web") {
      const cfg = w.config as WebWidgetConfig;
      if (!cfg.url) {
        out.push(`網頁元件「${nameOf(w, list)}」尚未設定網址`);
      } else if ((cfg.mode ?? "embed") === "embed" && isLikelyNonEmbeddable(cfg.url)) {
        out.push(`網頁元件「${nameOf(w, list)}」的網址可能無法嵌入,建議改用代理或直接開啟`);
      }
    }
  }

  // overlapping visible widgets
  const overlapping = new Set<number>();
  const visible = list.filter((w) => w.visible);
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      if (boxesOverlap(visible[i], visible[j])) {
        overlapping.add(visible[i].uid);
        overlapping.add(visible[j].uid);
      }
    }
  }
  if (overlapping.size > 0) {
    const names = list
      .filter((w) => overlapping.has(w.uid))
      .map((w) => nameOf(w, list))
      .join("、");
    out.push(`元件重疊:${names}`);
  }

  return out;
}

// ---- resize handles --------------------------------------------------------

const HANDLES: { hx: -1 | 0 | 1; hy: -1 | 0 | 1; cx: number; cy: number; cursor: string }[] = [
  { hx: -1, hy: -1, cx: 0, cy: 0, cursor: "nwse-resize" },
  { hx: 0, hy: -1, cx: 0.5, cy: 0, cursor: "ns-resize" },
  { hx: 1, hy: -1, cx: 1, cy: 0, cursor: "nesw-resize" },
  { hx: 1, hy: 0, cx: 1, cy: 0.5, cursor: "ew-resize" },
  { hx: 1, hy: 1, cx: 1, cy: 1, cursor: "nwse-resize" },
  { hx: 0, hy: 1, cx: 0.5, cy: 1, cursor: "ns-resize" },
  { hx: -1, hy: 1, cx: 0, cy: 1, cursor: "nesw-resize" },
  { hx: -1, hy: 0, cx: 0, cy: 0.5, cursor: "ew-resize" },
];

function ResizeHandles({
  w,
  onStart,
}: {
  w: EditorWidget;
  onStart: (e: React.MouseEvent, w: EditorWidget, hx: -1 | 0 | 1, hy: -1 | 0 | 1) => void;
}) {
  return (
    <>
      {HANDLES.map((h, i) => (
        <div
          key={i}
          className="absolute h-2.5 w-2.5 rounded-sm border border-pink-500 bg-white"
          style={{
            left: `${h.cx * 100}%`,
            top: `${h.cy * 100}%`,
            transform: "translate(-50%, -50%)",
            cursor: h.cursor,
          }}
          onMouseDown={(e) => onStart(e, w, h.hx, h.hy)}
        />
      ))}
    </>
  );
}

// ---- widget canvas renderer ------------------------------------------------

function WidgetView({
  w,
  scale,
  media,
  now,
}: {
  w: EditorWidget;
  scale: number;
  media: MediaRow[];
  now: Date;
}) {
  const box: React.CSSProperties = { width: "100%", height: "100%", overflow: "hidden" };

  switch (w.kind) {
    case "image": {
      const cfg = w.config as ImageWidgetConfig;
      const m = cfg.media_id ? media.find((x) => x.id === cfg.media_id) : undefined;
      const src = m ? contentUrl(`/api/content/media/${m.id}`) : cfg.url;
      return src ? (
        <img src={src} alt="" style={{ ...box, objectFit: cfg.fit ?? "contain" }} draggable={false} />
      ) : (
        <Placeholder icon={<IconImage className="h-8 w-8" />} text="未選擇圖片" />
      );
    }
    case "video": {
      const cfg = w.config as VideoWidgetConfig;
      const m = cfg.media_id ? media.find((x) => x.id === cfg.media_id) : undefined;
      return (
        <Placeholder
          icon={<IconVideo className="h-8 w-8" />}
          text={m?.filename ?? cfg.url ?? "未選擇影片"}
          sub={`影片 · ${label(objectFitLabels, cfg.fit ?? "cover")}`}
          dark
        />
      );
    }
    case "carousel": {
      const cfg = w.config as CarouselWidgetConfig;
      return <Placeholder icon={<IconImage className="h-8 w-8" />} text={cfg.items?.length ? `媒體 ${cfg.items.length} 個項目` : "尚未加入媒體項目"} dark />;
    }
    case "web": {
      const cfg = w.config as WebWidgetConfig;
      return (
        <Placeholder
          icon={<IconGlobe className="h-8 w-8" />}
          text={cfg.url || "未設定網址"}
          sub={label(webModeLabels, cfg.mode ?? "embed")}
          dark
        />
      );
    }
    case "text": {
      const cfg = w.config as TextWidgetConfig;
      return (
        <div
          style={{
            ...box,
            display: "flex",
            alignItems: "center",
            justifyContent:
              cfg.align === "left" ? "flex-start" : cfg.align === "right" ? "flex-end" : "center",
            textAlign: cfg.align ?? "center",
            background: cfg.background || "transparent",
            color: cfg.color || "#ffffff",
            fontSize: Math.max(4, (cfg.font_size ?? 48) * scale),
            fontWeight: cfg.weight ?? 400,
            padding: 4 * scale,
            lineHeight: 1.2,
            wordBreak: "break-word",
          }}
        >
          {cfg.text || "文字"}
        </div>
      );
    }
    case "ticker": {
      const cfg = w.config as TickerWidgetConfig;
      return (
        <div
          style={{
            ...box,
            display: "flex",
            alignItems: "center",
            gap: 6 * scale,
            background: cfg.background || "#111827",
            color: cfg.color || "#ffffff",
            fontSize: Math.max(4, (cfg.font_size ?? 32) * scale),
            padding: `0 ${8 * scale}px`,
            whiteSpace: "nowrap",
          }}
        >
          <span>{tickerGlyph(cfg.direction)}</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {cfg.text || cfg.source_url || "跑馬燈"}
          </span>
        </div>
      );
    }
    case "direction": {
      const cfg = w.config as DirectionWidgetConfig;
      return (
        <div
          style={{
            ...box,
            background: cfg.background || "#111827",
            color: cfg.color || "#ffffff",
            fontSize: Math.max(4, (cfg.font_size ?? 32) * scale),
            padding: 8 * scale,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: 4 * scale,
          }}
        >
          {(cfg.entries ?? []).map((e, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 * scale }}>
              <span>{directionArrowGlyphs[e.arrow] ?? "→"}</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {e.label}
              </span>
            </div>
          ))}
        </div>
      );
    }
    case "clock": {
      const cfg = w.config as ClockWidgetConfig;
      const { time, date, lunar } = formatClock(cfg, now);
      return (
        <div
          style={{
            ...box,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            background: cfg.background || "transparent",
            color: cfg.color || "#ffffff",
            fontSize: Math.max(4, (cfg.font_size ?? 64) * scale),
            lineHeight: 1.1,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <div>{time}</div>
          {cfg.show_date && (
            <div style={{ fontSize: Math.max(4, (cfg.font_size ?? 64) * scale * 0.4), opacity: 0.85 }}>
              {date}
            </div>
          )}
          {cfg.show_lunar && (
            <div style={{ fontSize: Math.max(4, (cfg.font_size ?? 64) * scale * 0.34), opacity: 0.75 }}>
              {lunar}
            </div>
          )}
        </div>
      );
    }
  }
}

function Placeholder({
  icon,
  text,
  sub,
  dark,
}: {
  icon: React.ReactNode;
  text: string;
  sub?: string;
  dark?: boolean;
}) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 2,
        overflow: "hidden",
        padding: 6,
        textAlign: "center",
        background: dark ? "#1f2937" : "#e2e8f0",
        color: dark ? "#cbd5e1" : "#64748b",
        fontSize: 12,
      }}
    >
      <span style={{ fontSize: 22 }}>{icon}</span>
      <span
        style={{ maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {text}
      </span>
      {sub && <span style={{ fontSize: 10, opacity: 0.8 }}>{sub}</span>}
    </div>
  );
}

// ---- config forms ----------------------------------------------------------

function WidgetConfigForm({
  widget,
  media,
  disabled,
  onChange,
}: {
  widget: EditorWidget;
  media: MediaRow[];
  disabled: boolean;
  onChange: (cfg: WidgetConfig) => void;
}) {
  switch (widget.kind) {
    case "image":
      return (
        <ImageForm
          cfg={widget.config as ImageWidgetConfig}
          media={media}
          disabled={disabled}
          onChange={onChange}
        />
      );
    case "video":
      return (
        <VideoForm
          cfg={widget.config as VideoWidgetConfig}
          media={media}
          disabled={disabled}
          onChange={onChange}
        />
      );
    case "carousel":
      return <CarouselForm cfg={widget.config as CarouselWidgetConfig} media={media} disabled={disabled} onChange={onChange} />;
    case "web":
      return <WebForm cfg={widget.config as WebWidgetConfig} disabled={disabled} onChange={onChange} />;
    case "text":
      return <TextForm cfg={widget.config as TextWidgetConfig} disabled={disabled} onChange={onChange} />;
    case "ticker":
      return (
        <TickerForm cfg={widget.config as TickerWidgetConfig} disabled={disabled} onChange={onChange} />
      );
    case "direction":
      return (
        <DirectionForm
          cfg={widget.config as DirectionWidgetConfig}
          disabled={disabled}
          onChange={onChange}
        />
      );
    case "clock":
      return <ClockForm cfg={widget.config as ClockWidgetConfig} disabled={disabled} onChange={onChange} />;
  }
}

const FIT_OPTS: [string, string][] = Object.entries(objectFitLabels);
const WEB_MODE_OPTS: [string, string][] = Object.entries(webModeLabels);
const ALIGN_OPTS: [string, string][] = Object.entries(alignLabels);
const TICKER_DIR_OPTS: [string, string][] = Object.entries(tickerDirectionLabels);
const ARROW_OPTS: [string, string][] = Object.entries(directionArrowLabels);
const CLOCK_FMT_OPTS: [string, string][] = Object.entries(clockFormatLabels);
const CLOCK_LOCALE_OPTS: [string, string][] = Object.entries(clockLocaleLabels);
const CLOCK_DATE_FORMAT_OPTS: [string, string][] = Object.entries(clockDateFormatLabels);

function CarouselForm({
  cfg, media, disabled, onChange,
}: {
  cfg: CarouselWidgetConfig;
  media: MediaRow[];
  disabled: boolean;
  onChange: (c: CarouselWidgetConfig) => void;
}) {
  const items = cfg.items ?? [];
  const update = (index: number, patch: Record<string, unknown>) =>
    onChange({ ...cfg, items: items.map((item, i) => i === index ? { ...item, ...patch } : item) });
  const add = (kind: "image" | "video") => onChange({ ...cfg, items: [...items, { kind, dwell_sec: 10, fit: "contain", muted: true, loop: true }] });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">媒體項目</span>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={cfg.loop !== false} disabled={disabled} onChange={(e) => onChange({ ...cfg, loop: e.target.checked })} />循環</label>
      </div>
      {items.map((item, index) => (
        <div key={index} className="rounded border border-slate-200 p-2 space-y-2">
          <div className="flex gap-2 items-center"><span className="text-sm flex-1">{index + 1}. {item.kind === "image" ? "圖片" : "影片"}</span><button type="button" className="btn-secondary text-xs" disabled={disabled} onClick={() => onChange({ ...cfg, items: items.filter((_, i) => i !== index) })}>移除</button></div>
          <>
            <MediaPicker media={media} type={item.kind} value={item.media_id} disabled={disabled} onChange={(id) => update(index, { media_id: id })} />
            <TextField label="外部 URL（未選媒體時使用）" value={item.url ?? ""} disabled={disabled} placeholder="https://" onChange={(url) => update(index, { url, media_id: undefined })} />
            <SelectField label="顯示方式" value={item.fit ?? "contain"} options={FIT_OPTS} disabled={disabled} onChange={(fit) => update(index, { fit })} />
            {item.kind === "video" && <div className="flex gap-4 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={item.muted !== false} disabled={disabled} onChange={(e) => update(index, { muted: e.target.checked })} />靜音</label><label className="flex items-center gap-2"><input type="checkbox" checked={item.loop !== false} disabled={disabled || item.play_until_end === true} onChange={(e) => update(index, { loop: e.target.checked })} />影片循環</label><label className="flex items-center gap-2"><input type="checkbox" checked={item.play_until_end === true} disabled={disabled} onChange={(e) => update(index, { play_until_end: e.target.checked, ...(e.target.checked ? { loop: false } : {}) })} />播放至結束</label></div>}
          </>
          <TextField label="停留秒數" value={String(item.dwell_sec ?? 10)} disabled={disabled} onChange={(v) => update(index, { dwell_sec: Math.max(1, Number(v) || 1) })} />
        </div>
      ))}
      <div className="flex gap-2"><button type="button" className="btn-secondary" disabled={disabled} onClick={() => add("image")}>＋圖片</button><button type="button" className="btn-secondary" disabled={disabled} onClick={() => add("video")}>＋影片</button></div>
    </div>
  );
}

function ImageForm({
  cfg,
  media,
  disabled,
  onChange,
}: {
  cfg: ImageWidgetConfig;
  media: MediaRow[];
  disabled: boolean;
  onChange: (c: ImageWidgetConfig) => void;
}) {
  const set = (p: Partial<ImageWidgetConfig>) => onChange({ ...cfg, ...p });
  return (
    <div className="space-y-3">
      <MediaPicker
        media={media}
        type="image"
        value={cfg.media_id}
        disabled={disabled}
        onChange={(id) => set({ media_id: id })}
      />
      <TextField
        label="或圖片網址"
        value={cfg.url ?? ""}
        disabled={disabled}
        placeholder="https://…"
        onChange={(v) => set({ url: v || undefined })}
      />
      <SelectField
        label="縮放方式"
        value={cfg.fit ?? "contain"}
        options={FIT_OPTS}
        disabled={disabled}
        onChange={(v) => set({ fit: v as ObjectFit })}
      />
    </div>
  );
}

function VideoForm({
  cfg,
  media,
  disabled,
  onChange,
}: {
  cfg: VideoWidgetConfig;
  media: MediaRow[];
  disabled: boolean;
  onChange: (c: VideoWidgetConfig) => void;
}) {
  const set = (p: Partial<VideoWidgetConfig>) => onChange({ ...cfg, ...p });
  return (
    <div className="space-y-3">
      <MediaPicker
        media={media}
        type="video"
        value={cfg.media_id}
        disabled={disabled}
        onChange={(id) => set({ media_id: id })}
      />
      <TextField
        label="或影片網址"
        value={cfg.url ?? ""}
        disabled={disabled}
        placeholder="https://…"
        onChange={(v) => set({ url: v || undefined })}
      />
      <SelectField
        label="縮放方式"
        value={cfg.fit ?? "cover"}
        options={FIT_OPTS}
        disabled={disabled}
        onChange={(v) => set({ fit: v as ObjectFit })}
      />
      <div className="flex gap-4">
        <CheckboxField
          label="靜音"
          checked={cfg.muted ?? true}
          disabled={disabled}
          onChange={(v) => set({ muted: v })}
        />
        <CheckboxField
          label="循環播放"
          checked={cfg.loop ?? true}
          disabled={disabled}
          onChange={(v) => set({ loop: v })}
        />
      </div>
    </div>
  );
}

function WebForm({
  cfg,
  disabled,
  onChange,
}: {
  cfg: WebWidgetConfig;
  disabled: boolean;
  onChange: (c: WebWidgetConfig) => void;
}) {
  const set = (p: Partial<WebWidgetConfig>) => onChange({ ...cfg, ...p });
  return (
    <div className="space-y-3">
      <TextField
        label="網址"
        value={cfg.url ?? ""}
        disabled={disabled}
        placeholder="https://…"
        onChange={(v) => set({ url: v })}
      />
      <SelectField
        label="來源模式"
        value={cfg.mode ?? "embed"}
        options={WEB_MODE_OPTS}
        disabled={disabled}
        onChange={(v) => set({ mode: v as WebWidgetConfig["mode"] })}
      />
      <NumberField
        label="重新整理間隔 (秒,0 為不重整)"
        value={cfg.refresh_sec ?? 0}
        min={0}
        disabled={disabled}
        onChange={(v) => set({ refresh_sec: v })}
      />
      {(cfg.mode ?? "embed") === "proxy" && (
        <p className="text-xs text-amber-600">
          本機代理需在裝置端設定網域白名單,且不得存取內網 / localhost。
        </p>
      )}
    </div>
  );
}

function TextForm({
  cfg,
  disabled,
  onChange,
}: {
  cfg: TextWidgetConfig;
  disabled: boolean;
  onChange: (c: TextWidgetConfig) => void;
}) {
  const set = (p: Partial<TextWidgetConfig>) => onChange({ ...cfg, ...p });
  return (
    <div className="space-y-3">
      <div>
        <label className="label">文字</label>
        <textarea
          className="input min-h-[64px]"
          value={cfg.text ?? ""}
          disabled={disabled}
          onChange={(e) => set({ text: e.target.value })}
        />
      </div>
      <SelectField
        label="顯示模式"
        value={cfg.behavior ?? "static"}
        options={[["static", "靜態文字"], ["ticker", "跑馬燈"]]}
        disabled={disabled}
        onChange={(v) => set({ behavior: v as "static" | "ticker" })}
      />
      {(cfg.behavior ?? "static") === "ticker" && (
        <>
          <TextField label="動態文字來源 URL（選填）" value={cfg.source_url ?? ""} disabled={disabled} placeholder="https://" onChange={(v) => set({ source_url: v || undefined })} />
          <div className="grid grid-cols-2 gap-2">
            <SelectField label="方向" value={cfg.direction ?? "left"} options={TICKER_DIR_OPTS} disabled={disabled} onChange={(v) => set({ direction: v as TextWidgetConfig["direction"] })} />
            <NumberField label="速度 (px/秒)" value={cfg.speed ?? 80} min={1} disabled={disabled} onChange={(v) => set({ speed: v })} />
          </div>
        </>
      )}
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="字級 (px)"
          value={cfg.font_size ?? 48}
          min={1}
          disabled={disabled}
          onChange={(v) => set({ font_size: v })}
        />
        <NumberField
          label="字重"
          value={cfg.weight ?? 400}
          min={100}
          step={100}
          disabled={disabled}
          onChange={(v) => set({ weight: v })}
        />
      </div>
      <SelectField
        label="對齊"
        value={cfg.align ?? "center"}
        options={ALIGN_OPTS}
        disabled={disabled}
        onChange={(v) => set({ align: v as TextWidgetConfig["align"] })}
      />
      <ColorField
        label="文字顏色"
        value={cfg.color ?? "#ffffff"}
        disabled={disabled}
        onChange={(v) => set({ color: v })}
      />
      <ColorField
        label="背景顏色 (留空為透明)"
        value={cfg.background ?? ""}
        disabled={disabled}
        onChange={(v) => set({ background: v || undefined })}
      />
    </div>
  );
}

function TickerForm({
  cfg,
  disabled,
  onChange,
}: {
  cfg: TickerWidgetConfig;
  disabled: boolean;
  onChange: (c: TickerWidgetConfig) => void;
}) {
  const set = (p: Partial<TickerWidgetConfig>) => onChange({ ...cfg, ...p });
  return (
    <div className="space-y-3">
      <TextField
        label="文字"
        value={cfg.text ?? ""}
        disabled={disabled}
        onChange={(v) => set({ text: v })}
      />
      <TextField
        label="即時來源網址 (選填)"
        value={cfg.source_url ?? ""}
        disabled={disabled}
        placeholder="https://…"
        onChange={(v) => set({ source_url: v || undefined })}
      />
      <div className="grid grid-cols-2 gap-2">
        <SelectField
          label="方向"
          value={cfg.direction ?? "left"}
          options={TICKER_DIR_OPTS}
          disabled={disabled}
          onChange={(v) => set({ direction: v as TickerWidgetConfig["direction"] })}
        />
        <NumberField
          label="速度 (px/秒)"
          value={cfg.speed ?? 80}
          min={1}
          disabled={disabled}
          onChange={(v) => set({ speed: v })}
        />
      </div>
      <NumberField
        label="字級 (px)"
        value={cfg.font_size ?? 32}
        min={1}
        disabled={disabled}
        onChange={(v) => set({ font_size: v })}
      />
      <ColorField
        label="文字顏色"
        value={cfg.color ?? "#ffffff"}
        disabled={disabled}
        onChange={(v) => set({ color: v })}
      />
      <ColorField
        label="背景顏色"
        value={cfg.background ?? "#111827"}
        disabled={disabled}
        onChange={(v) => set({ background: v || undefined })}
      />
    </div>
  );
}

function DirectionForm({
  cfg,
  disabled,
  onChange,
}: {
  cfg: DirectionWidgetConfig;
  disabled: boolean;
  onChange: (c: DirectionWidgetConfig) => void;
}) {
  const entries = cfg.entries ?? [];
  const setEntries = (next: DirectionWidgetConfig["entries"]) => onChange({ ...cfg, entries: next });
  return (
    <div className="space-y-3">
      <div>
        <label className="label">動線項目</label>
        <div className="space-y-2">
          {entries.map((e, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                className="input"
                value={e.label}
                disabled={disabled}
                placeholder="名稱"
                onChange={(ev) =>
                  setEntries(entries.map((x, j) => (j === i ? { ...x, label: ev.target.value } : x)))
                }
              />
              <select
                className="select !w-28"
                value={e.arrow}
                disabled={disabled}
                onChange={(ev) =>
                  setEntries(
                    entries.map((x, j) =>
                      j === i ? { ...x, arrow: ev.target.value as DirectionArrow } : x,
                    ),
                  )
                }
              >
                {ARROW_OPTS.map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
              {!disabled && (
                <button
                  className="btn-danger btn-sm !px-2"
                  onClick={() => setEntries(entries.filter((_, j) => j !== i))}
                >
                  <IconTrash className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
        </div>
        {!disabled && (
          <button
            className="btn-ghost btn-sm mt-2"
            onClick={() => setEntries([...entries, { label: "新項目", arrow: "right" }])}
          >
            + 新增項目
          </button>
        )}
      </div>
      <NumberField
        label="字級 (px)"
        value={cfg.font_size ?? 32}
        min={1}
        disabled={disabled}
        onChange={(v) => onChange({ ...cfg, font_size: v })}
      />
      <ColorField
        label="文字顏色"
        value={cfg.color ?? "#ffffff"}
        disabled={disabled}
        onChange={(v) => onChange({ ...cfg, color: v })}
      />
      <ColorField
        label="背景顏色"
        value={cfg.background ?? "#111827"}
        disabled={disabled}
        onChange={(v) => onChange({ ...cfg, background: v || undefined })}
      />
    </div>
  );
}

function ClockForm({
  cfg,
  disabled,
  onChange,
}: {
  cfg: ClockWidgetConfig;
  disabled: boolean;
  onChange: (c: ClockWidgetConfig) => void;
}) {
  const set = (p: Partial<ClockWidgetConfig>) => onChange({ ...cfg, ...p });
  return (
    <div className="space-y-3">
      <SelectField
        label="時間格式"
        value={cfg.format ?? "24h"}
        options={CLOCK_FMT_OPTS}
        disabled={disabled}
        onChange={(v) => set({ format: v as ClockWidgetConfig["format"] })}
      />
      <SelectField
        label="語言"
        value={cfg.locale ?? "zh-TW"}
        options={CLOCK_LOCALE_OPTS}
        disabled={disabled}
        onChange={(v) => set({ locale: v as ClockWidgetConfig["locale"] })}
      />
      <SelectField
        label="日期格式"
        value={cfg.date_format ?? "numeric"}
        options={CLOCK_DATE_FORMAT_OPTS}
        disabled={disabled}
        onChange={(v) => set({ date_format: v as ClockWidgetConfig["date_format"] })}
      />
      <TextField
        label="時區 (IANA,留空為裝置本地)"
        value={cfg.timezone ?? ""}
        disabled={disabled}
        placeholder="Asia/Taipei"
        onChange={(v) => set({ timezone: v })}
      />
      <CheckboxField
        label="顯示日期"
        checked={cfg.show_date ?? false}
        disabled={disabled}
        onChange={(v) => set({ show_date: v })}
      />
      <CheckboxField
        label="顯示農曆"
        checked={cfg.show_lunar ?? false}
        disabled={disabled}
        onChange={(v) => set({ show_lunar: v })}
      />
      <NumberField
        label="字級 (px)"
        value={cfg.font_size ?? 64}
        min={1}
        disabled={disabled}
        onChange={(v) => set({ font_size: v })}
      />
      <ColorField
        label="文字顏色"
        value={cfg.color ?? "#ffffff"}
        disabled={disabled}
        onChange={(v) => set({ color: v })}
      />
      <ColorField
        label="背景顏色 (留空為透明)"
        value={cfg.background ?? ""}
        disabled={disabled}
        onChange={(v) => set({ background: v || undefined })}
      />
    </div>
  );
}

// ---- primitive field components --------------------------------------------

function MediaPicker({
  media,
  type,
  value,
  disabled,
  onChange,
}: {
  media: MediaRow[];
  type: "image" | "video";
  value?: number;
  disabled: boolean;
  onChange: (id: number | undefined) => void;
}) {
  const opts = media.filter((m) => m.type === type);
  return (
    <div>
      <label className="label">媒體素材</label>
      <select
        className="select"
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
      >
        <option value="">— 選擇 —</option>
        {opts.map((m) => (
          <option key={m.id} value={m.id}>
            {m.filename}
          </option>
        ))}
      </select>
      {value != null && type === "image" && (
        <img
          src={contentUrl(`/api/content/media/${value}`)}
          alt=""
          className="mt-2 max-h-28 w-full rounded border border-slate-200 object-contain dark:border-dark-border"
        />
      )}
    </div>
  );
}

function TextField({
  label: l,
  value,
  disabled,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="label">{l}</label>
      <input
        className="input"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function NumberField({
  label: l,
  value,
  min,
  step,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  step?: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="label">{l}</label>
      <input
        className="input"
        type="number"
        value={value}
        min={min}
        step={step}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function SelectField({
  label: l,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="label">{l}</label>
      <select
        className="select"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
    </div>
  );
}

function CheckboxField({
  label: l,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="h-4 w-4 rounded border-slate-300 text-brand-500 focus:ring-brand-500 dark:border-dark-border dark:bg-dark-raised"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {l}
    </label>
  );
}

function ColorField({
  label: l,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="label">{l}</label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value || "#000000"}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-10 shrink-0 cursor-pointer rounded border border-slate-300 bg-white dark:border-dark-border dark:bg-dark-raised"
        />
        <input
          className="input"
          value={value}
          disabled={disabled}
          placeholder="#RRGGBB / 留空"
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  );
}
