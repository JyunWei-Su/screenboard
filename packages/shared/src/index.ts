// Shared types & protocol contracts between the Workers API, admin console, and Go agent.
// The Go agent mirrors the wire-format types in agent/internal/protocol.

export type Role = "admin" | "operator";

export type DeviceStatus = "online" | "offline" | "warning" | "maintenance";

export type MediaType = "url" | "image" | "video" | "pdf" | "html";

export type OtaChannel = "stable" | "beta";

export type OtaStrategy = "all" | "group" | "canary";

export type CommandType =
  | "reload"
  | "switch_scene"
  | "reboot"
  | "shutdown"
  | "restart_player"
  | "take_screenshot"
  | "check_update"
  | "sync_time" // enable/restart the device's managed NTP service
  | "set_hostname" // set the OS hostname, optionally followed by a reboot
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
  protocol_version?: number;
  capabilities?: string[];
}

export interface Device extends DeviceInfo {
  uuid: string;
  name: string;
  group_id: number | null;
  status: DeviceStatus;
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
  device_info_interval_sec: number; // includes display resolution
  playlist_poll_sec: number;
  heartbeat_interval_sec: number; // 10-60 seconds, below the offline watchdog
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
  temperature?: number;
  chromium_status?: string;
  browser_restart_count?: number;
  browser_last_exit_at?: string;
  last_sync_success_at?: string;
  cache_used_bytes?: number;
  cache_limit_bytes?: number;
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
  | "image" // legacy schema value; the API no longer accepts it
  | "video" // legacy schema value; the API no longer accepts it
  | "carousel"
  | "web"
  | "text"
  | "ticker" // legacy schema value; merged into text.behavior="ticker"
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

/** A rotating media region within a scene; each item has its own dwell time. */
export interface CarouselItem {
  kind: "image" | "video";
  media_id?: number;
  url?: string;
  dwell_sec: number;
  fit?: ObjectFit;
  muted?: boolean;
  loop?: boolean;
  play_until_end?: boolean;
  mode?: WebSourceMode;
  refresh_sec?: number;
  source?: string;
}

export interface CarouselWidgetConfig {
  items: CarouselItem[];
  loop?: boolean;
}

export interface WebWidgetConfig {
  url: string;
  mode?: WebSourceMode;
  refresh_sec?: number;
}

export interface TextWidgetConfig {
  text: string;
  behavior?: "static" | "ticker";
  source_url?: string;
  speed?: number;
  direction?: "left" | "right" | "up" | "down";
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

/** Visual style of the wayfinding arrow drawn as SVG. */
export type DirectionArrowStyle = "block" | "triangle" | "chevron" | "line";

export interface DirectionWidgetConfig {
  entries: DirectionEntry[];
  color?: string;
  background?: string;
  font_size?: number;
  /** Arrow shape; defaults to "block". */
  arrow_style?: DirectionArrowStyle;
  /** Stroke thickness for the "line"/"chevron" styles. */
  arrow_weight?: number;
  /** Arrow box size as a multiple of font_size (defaults to 1.2). */
  arrow_size?: number;
  /** Arrow colour; falls back to `color` when unset. */
  arrow_color?: string;
  /** Which side the indicator column sits on; defaults to "right". */
  arrow_position?: "left" | "right";
}

export interface ClockWidgetConfig {
  format?: "24h" | "12h";
  show_date?: boolean;
  /** Show the lunar-calendar date below the Gregorian date. */
  show_lunar?: boolean;
  /** BCP 47 locale used for all clock text. */
  locale?: "zh-TW" | "zh-CN" | "en-US" | "ja-JP" | "ko-KR";
  /** Visual style for the Gregorian date. */
  date_format?: "numeric" | "short" | "long";
  timezone?: string; // IANA tz; empty = device local
  color?: string;
  background?: string;
  font_size?: number;
}

export type WidgetConfig =
  | ImageWidgetConfig
  | VideoWidgetConfig
  | CarouselWidgetConfig
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
  | { kind: "scene"; scene: ResolvedScene }
  | { kind: "scene_playlist"; scene_playlist: ResolvedScenePlaylist }
  | { kind: "none" };
