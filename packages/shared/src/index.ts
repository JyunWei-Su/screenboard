// Shared types & protocol contracts between the Workers API, admin console, and Go agent.
// The Go agent mirrors the wire-format types in agent/internal/protocol.

export type Role = "admin" | "operator" | "viewer";

export type DeviceStatus = "online" | "offline" | "warning" | "maintenance";

export type GroupType = "site" | "building" | "floor" | "department" | "custom";

export type MediaType = "url" | "image" | "video" | "pdf" | "html";

export type OtaChannel = "stable" | "beta";

export type OtaStrategy = "all" | "group" | "canary";

export type CommandType =
  | "reload"
  | "switch_playlist"
  | "reboot"
  | "shutdown"
  | "restart_player"
  | "take_screenshot"
  | "check_update"
  | "apply_display"; // push display settings (zoom/rotate/etc.)

export type EventType =
  | "device_offline"
  | "device_online"
  | "cpu_high"
  | "memory_high"
  | "disk_low"
  | "ota_failed"
  | "playlist_error"
  | "screenshot_error";

export type EventSeverity = "info" | "warning" | "critical";

// ---- Device ----

export interface DeviceInfo {
  hostname: string;
  serial: string;
  os_version: string;
  agent_version: string;
  ip: string;
  mac: string;
  resolution: string; // e.g. "1920x1080"
}

export interface Device extends DeviceInfo {
  uuid: string;
  name: string;
  group_id: number | null;
  status: DeviceStatus;
  playlist_id: number | null;
  last_seen_at: string | null;
  registered_at: string;
}

export interface DisplaySettings {
  kiosk: boolean;
  zoom: number; // 1.0 = 100%
  rotate: 0 | 90 | 180 | 270;
  screen: number; // primary screen index for multi-monitor
}

// ---- Health ----

export interface HealthSample {
  cpu: number; // percent 0-100
  memory: number; // percent 0-100
  disk: number; // percent 0-100
  net_ok: boolean;
  uptime: number; // seconds
}

// ---- Enrollment ----

export interface EnrollRequest {
  enrollment_token: string;
  info: DeviceInfo;
  display?: DisplaySettings;
}

export interface EnrollResponse {
  device_uuid: string;
  access_token: string;
  refresh_token: string;
  ws_url: string;
}

export interface RemoteAccessBootstrap {
  enabled: boolean;
  hostname?: string;
  tunnel_token?: string;
}

// ---- Playlist ----

export interface PlaylistItem {
  id: number;
  type: MediaType;
  source: string; // absolute URL the player can load
  duration_sec: number;
  order_index: number;
}

export interface ResolvedPlaylist {
  playlist_id: number;
  name: string;
  loop: boolean;
  items: PlaylistItem[];
  revision: string; // hash for cache comparison
}

// ---- Commands (over WebSocket) ----

export interface Command {
  id: string;
  type: CommandType;
  payload?: Record<string, unknown>;
}

export interface CommandAck {
  type: "ack";
  command_id: string;
  ok: boolean;
  detail?: string;
}

export interface Heartbeat {
  type: "heartbeat";
  health?: HealthSample;
}

export interface PlaybackEvent {
  type: "playback";
  item_id: number | null;
  ok: boolean;
  black_screen?: boolean;
  browser_error?: string;
}

export type AgentMessage = CommandAck | Heartbeat | PlaybackEvent;
export type ServerMessage = Command | { type: "welcome"; device_uuid: string };

// ---- OTA ----

export interface OtaUpdateResponse {
  update_available: boolean;
  version?: string;
  url?: string;
  checksum?: string; // sha256 hex
  signature?: string; // base64 ed25519 signature of the checksum
}
