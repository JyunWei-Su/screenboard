// Display-only Chinese labels for data enums returned by / sent to the API.
// The underlying values (used as API payloads and map keys) are never changed —
// only how they are rendered to the user.

export function label(map: Record<string, string>, key: string | null | undefined): string {
  if (key == null) return "—";
  return map[key] ?? key;
}

export const statusLabels: Record<string, string> = {
  online: "上線",
  offline: "離線",
  warning: "警告",
  maintenance: "維護",
};

export const severityLabels: Record<string, string> = {
  critical: "嚴重",
  warning: "警告",
  info: "資訊",
};

export const roleLabels: Record<string, string> = {
  admin: "管理員",
  operator: "操作員",
};

export const groupTypeLabels: Record<string, string> = {
  site: "場域",
  building: "建築",
  floor: "樓層",
  department: "部門",
  custom: "自訂",
};

export const mediaTypeLabels: Record<string, string> = {
  image: "圖片",
  video: "影片",
  pdf: "PDF",
  html: "HTML",
  url: "URL",
};

export const targetTypeLabels: Record<string, string> = {
  group: "裝置群組",
  device: "裝置",
};

export const otaStrategyLabels: Record<string, string> = {
  all: "全部",
  group: "裝置群組",
  canary: "金絲雀",
};

export const otaStatusLabels: Record<string, string> = {
  active: "啟用中",
  paused: "已暫停",
  completed: "已完成",
};

export const tunnelStatusLabels: Record<string, string> = {
  healthy: "正常",
  inactive: "未啟用",
  error: "錯誤",
  unknown: "未知",
};

export const commandStatusLabels: Record<string, string> = {
  queued: "佇列中",
  sent: "已送出",
  acked: "已確認",
  done: "已完成",
  failed: "失敗",
  expired: "已逾期",
};

// ---- Scenes ----

export const sceneStatusLabels: Record<string, string> = {
  draft: "草稿",
  published: "已發布",
};

export const widgetKindLabels: Record<string, string> = {
  image: "圖片",
  video: "影片",
  carousel: "媒體",
  web: "網頁",
  text: "文字",
  ticker: "跑馬燈",
  direction: "動線指示",
  clock: "時鐘",
};

export const objectFitLabels: Record<string, string> = {
  contain: "完整顯示",
  cover: "填滿裁切",
  fill: "拉伸填滿",
};

export const webModeLabels: Record<string, string> = {
  embed: "直接嵌入",
  proxy: "本機代理",
  open: "直接開啟",
};

export const alignLabels: Record<string, string> = {
  left: "靠左",
  center: "置中",
  right: "靠右",
};

export const tickerDirectionLabels: Record<string, string> = {
  left: "向左",
  right: "向右",
  up: "向上",
  down: "向下",
};

// Arrow glyphs used when rendering direction widgets on the canvas.
export const directionArrowGlyphs: Record<string, string> = {
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  "up-left": "↖",
  "up-right": "↗",
  "down-left": "↙",
  "down-right": "↘",
};

export const directionArrowLabels: Record<string, string> = {
  up: "上 ↑",
  down: "下 ↓",
  left: "左 ←",
  right: "右 →",
  "up-left": "左上 ↖",
  "up-right": "右上 ↗",
  "down-left": "左下 ↙",
  "down-right": "右下 ↘",
};

export const directionArrowStyleLabels: Record<string, string> = {
  block: "粗塊",
  triangle: "實心三角",
  chevron: "V 形",
  line: "線條",
};

export const directionArrowPositionLabels: Record<string, string> = {
  left: "靠左",
  right: "靠右",
};

// Base arrow shape points right; other directions are the same shape rotated.
const directionArrowAngle: Record<string, number> = {
  right: 0,
  "down-right": 45,
  down: 90,
  "down-left": 135,
  left: 180,
  "up-left": 225,
  up: 270,
  "up-right": 315,
};

/**
 * Build an inline SVG string for a wayfinding arrow. Shared verbatim (in spirit)
 * with the standalone/agent players so the editor preview matches playback.
 */
export function directionArrowSvg(
  arrow: string,
  style: string,
  weight: number,
  sizePx: number,
  color: string,
): string {
  const a = directionArrowAngle[arrow] ?? 0;
  let inner: string;
  if (style === "line") {
    inner = `<path d="M16,50 L74,50 M54,28 L80,50 L54,72" fill="none" stroke="${color}" stroke-width="${weight}" stroke-linecap="round" stroke-linejoin="round"/>`;
  } else if (style === "chevron") {
    inner = `<path d="M40,20 L76,50 L40,80" fill="none" stroke="${color}" stroke-width="${weight + 2}" stroke-linecap="round" stroke-linejoin="round"/>`;
  } else if (style === "triangle") {
    inner = `<path d="M32,18 L84,50 L32,82 Z" fill="${color}"/>`;
  } else {
    const half = Math.min(24, 5 + weight * 1.5);
    inner = `<path d="M12,${50 - half} L54,${50 - half} L54,22 L88,50 L54,78 L54,${50 + half} L12,${50 + half} Z" fill="${color}"/>`;
  }
  return `<svg viewBox="0 0 100 100" width="${sizePx}" height="${sizePx}" style="display:block"><g transform="rotate(${a} 50 50)">${inner}</g></svg>`;
}

export const clockFormatLabels: Record<string, string> = {
  "24h": "24 小時制",
  "12h": "12 小時制",
};

export const clockLocaleLabels: Record<string, string> = {
  "zh-TW": "繁體中文（台灣）",
  "zh-CN": "简体中文（中国）",
  "en-US": "English (US)",
  "ja-JP": "日本語",
  "ko-KR": "한국어",
};

export const clockDateFormatLabels: Record<string, string> = {
  numeric: "數字＋星期",
  short: "簡短數字日期",
  long: "完整日期＋星期",
};

// Assignment source for schedules / device defaults.
export const assignSourceLabels: Record<string, string> = {
  playlist: "播放清單",
  scene: "場景",
  scene_playlist: "場景群組",
};
