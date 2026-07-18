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
  | "switch_scene"
  | "reboot"
  | "shutdown"
  | "restart_player"
  | "take_screenshot"
  | "check_update"
  | "sync_time" // enable/restart the device's managed NTP service
  | "apply_display" // push display settings (zoom/rotate/etc.)
  | "apply_agent_settings" // push reporting/polling/screenshot/OTA intervals
  | "repair_tunnel" // re-provision cloudflared so SSH remote access recovers
  | "reinstall"; // re-run the device installer as root, then reboot

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

export interface AgentSettings {
  health_interval_sec: number;
  playlist_poll_sec: number;
  screenshot_interval_sec: number; // 0 disables scheduled screenshots
  ota_check_sec: number;
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
  // Scene playback context (present when a scene is active).
  scene_id?: number | null;
  scene_version?: number | null;
  // Per-widget load errors: widget id -> short error summary.
  widget_errors?: Record<string, string>;
}

export type AgentMessage = CommandAck | Heartbeat | PlaybackEvent;
export type ServerMessage = Command | { type: "welcome"; device_uuid: string };

// ---- OTA ----

export interface OtaUpdateResponse {
  update_available: boolean;
  version?: string;
  url?: string;
  checksum?: string; // sha256 hex
}

// ---- Scenes ----
// A Scene is a full-screen canvas composed of positioned widgets. This is the
// wire contract shared by the Workers API, admin editor, and player. See TODO.md.

export type WidgetKind =
  | "image"
  | "video"
  | "web"
  | "text"
  | "ticker"
  | "direction"
  | "clock";

export type ObjectFit = "contain" | "cover" | "fill";

// How a `web` widget loads its URL:
//  - embed: iframe directly (only works for embeddable sites)
//  - proxy: fetched through the agent's local proxy (needs domain allowlist;
//           must block internal/localhost — never expose the device's LAN)
//  - open:  opened as a full navigation (kiosk takeover)
export type WebSourceMode = "embed" | "proxy" | "open";

export interface ImageWidgetConfig {
  media_id?: number;
  url?: string;
  fit?: ObjectFit;
}

export interface VideoWidgetConfig {
  media_id?: number;
  url?: string;
  fit?: ObjectFit;
  muted?: boolean;
  loop?: boolean;
}

export interface WebWidgetConfig {
  url: string;
  mode?: WebSourceMode;
  refresh_sec?: number;
}

export interface TextWidgetConfig {
  text: string;
  font_size?: number;
  color?: string;
  background?: string;
  align?: "left" | "center" | "right";
  weight?: number;
}

export interface TickerWidgetConfig {
  text?: string;
  source_url?: string; // optional live feed the client polls
  speed?: number; // px/sec
  direction?: "left" | "right" | "up" | "down";
  color?: string;
  background?: string;
  font_size?: number;
}

export type DirectionArrow =
  | "up"
  | "down"
  | "left"
  | "right"
  | "up-left"
  | "up-right"
  | "down-left"
  | "down-right";

export interface DirectionEntry {
  label: string;
  arrow: DirectionArrow;
}

export interface DirectionWidgetConfig {
  entries: DirectionEntry[];
  color?: string;
  background?: string;
  font_size?: number;
}

export interface ClockWidgetConfig {
  format?: "24h" | "12h";
  show_date?: boolean;
  timezone?: string; // IANA tz; empty = device local
  color?: string;
  background?: string;
  font_size?: number;
}

export type WidgetConfig =
  | ImageWidgetConfig
  | VideoWidgetConfig
  | WebWidgetConfig
  | TextWidgetConfig
  | TickerWidgetConfig
  | DirectionWidgetConfig
  | ClockWidgetConfig;

export interface SceneBackground {
  color?: string;
  media_id?: number;
}

export type SceneStatus = "draft" | "published";

export interface Scene {
  id: number;
  name: string;
  width: number;
  height: number;
  background: SceneBackground;
  status: SceneStatus;
  published_version: number | null;
  created_at: string;
  updated_at: string;
}

export interface SceneWidget {
  id: number;
  scene_id: number;
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

// ---- Resolved scene (client-facing) ----
// The API resolves media_id references to absolute `source` URLs so the client
// never re-derives URL rules. Widgets are already ordered by z ascending.

export interface ResolvedSceneWidget {
  id: number;
  kind: WidgetKind;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  // Per-kind config, plus a resolved absolute `source` for media-backed kinds.
  config: WidgetConfig & { source?: string };
}

export interface ResolvedScene {
  scene_id: number;
  name: string;
  width: number;
  height: number;
  background: { color?: string; source?: string };
  widgets: ResolvedSceneWidget[];
  version: number | null; // published version, or null for a draft preview
  revision: string; // content hash for cache comparison
}

// ---- Scene playlists (rotate whole scenes) ----

export interface ScenePlaylistEntry {
  scene_id: number;
  dwell_sec: number;
  order_index: number;
}

export interface ScenePlaylist {
  id: number;
  name: string;
  loop: boolean;
  entries: ScenePlaylistEntry[];
}

export interface ResolvedScenePlaylist {
  scene_playlist_id: number;
  name: string;
  loop: boolean;
  scenes: Array<{ dwell_sec: number; scene: ResolvedScene }>;
  revision: string;
}

// A device resolves to exactly one of these at any moment.
export type ResolvedTarget =
  | { kind: "playlist"; playlist: ResolvedPlaylist }
  | { kind: "scene"; scene: ResolvedScene }
  | { kind: "scene_playlist"; scene_playlist: ResolvedScenePlaylist }
  | { kind: "none" };
