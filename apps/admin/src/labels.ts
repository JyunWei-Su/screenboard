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
  viewer: "檢視者",
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
  group: "群組",
  device: "裝置",
};

export const otaStrategyLabels: Record<string, string> = {
  all: "全部",
  group: "群組",
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
