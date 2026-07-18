package main

// Wire types shared with the Workers API (see packages/shared/src/index.ts).

type DeviceInfo struct {
	Hostname     string `json:"hostname"`
	Serial       string `json:"serial"`
	OSVersion    string `json:"os_version"`
	AgentVersion string `json:"agent_version"`
	IP           string `json:"ip"`
	MAC          string `json:"mac"`
	Resolution   string `json:"resolution"`
}

type EnrollRequest struct {
	EnrollmentToken string     `json:"enrollment_token"`
	Info            DeviceInfo `json:"info"`
	Display         *Display   `json:"display,omitempty"`
}

type EnrollResponse struct {
	DeviceUUID   string `json:"device_uuid"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	WSURL        string `json:"ws_url"`
}

type HealthSample struct {
	CPU    float64 `json:"cpu"`
	Memory float64 `json:"memory"`
	Disk   float64 `json:"disk"`
	NetOK  bool    `json:"net_ok"`
	Uptime int64   `json:"uptime"`
}

type PlaylistItem struct {
	ID          int    `json:"id"`
	Type        string `json:"type"`
	Source      string `json:"source"`
	DurationSec int    `json:"duration_sec"`
	OrderIndex  int    `json:"order_index"`
}

type ResolvedPlaylist struct {
	PlaylistID int            `json:"playlist_id"`
	Name       string         `json:"name"`
	Loop       bool           `json:"loop"`
	Items      []PlaylistItem `json:"items"`
	Revision   string         `json:"revision"`
}

type OtaUpdate struct {
	UpdateAvailable bool   `json:"update_available"`
	Version         string `json:"version"`
	URL             string `json:"url"`
	Checksum        string `json:"checksum"`
}

// Command channel messages.

type ServerCommand struct {
	ID      string                 `json:"id"`
	Type    string                 `json:"type"`
	Payload map[string]interface{} `json:"payload"`
}

type CommandAck struct {
	Type      string `json:"type"` // "ack"
	CommandID string `json:"command_id"`
	OK        bool   `json:"ok"`
	Detail    string `json:"detail,omitempty"`
}

type Heartbeat struct {
	Type string `json:"type"` // "heartbeat"
}

type PlaybackEvent struct {
	Type         string            `json:"type"` // "playback"
	ItemID       *int              `json:"item_id"`
	OK           bool              `json:"ok"`
	BlackScreen  bool              `json:"black_screen,omitempty"`
	BrowserError string            `json:"browser_error,omitempty"`
	SceneID      *int              `json:"scene_id,omitempty"`
	SceneVersion *int              `json:"scene_version,omitempty"`
	WidgetErrors map[string]string `json:"widget_errors,omitempty"`
}

// ---- Scenes (mirror of packages/shared/src/index.ts) ----

type ResolvedSceneWidget struct {
	ID     int                    `json:"id"`
	Kind   string                 `json:"kind"`
	X      int                    `json:"x"`
	Y      int                    `json:"y"`
	Width  int                    `json:"width"`
	Height int                    `json:"height"`
	Z      int                    `json:"z"`
	Config map[string]interface{} `json:"config"`
}

type ResolvedScene struct {
	SceneID    int                    `json:"scene_id"`
	Name       string                 `json:"name"`
	Width      int                    `json:"width"`
	Height     int                    `json:"height"`
	Background map[string]interface{} `json:"background"`
	Widgets    []ResolvedSceneWidget  `json:"widgets"`
	Version    *int                   `json:"version"`
	Revision   string                 `json:"revision"`
}

type ResolvedScenePlaylistItem struct {
	DwellSec int           `json:"dwell_sec"`
	Scene    ResolvedScene `json:"scene"`
}

type ResolvedScenePlaylist struct {
	ScenePlaylistID int                         `json:"scene_playlist_id"`
	Name            string                      `json:"name"`
	Loop            bool                        `json:"loop"`
	Scenes          []ResolvedScenePlaylistItem `json:"scenes"`
	Revision        string                      `json:"revision"`
}

// ResolvedTarget is what a device resolves to at any moment: exactly one of
// playlist / scene / scene_playlist (or none).
type ResolvedTarget struct {
	Kind          string                 `json:"kind"` // playlist | scene | scene_playlist | none
	Playlist      *ResolvedPlaylist      `json:"playlist,omitempty"`
	Scene         *ResolvedScene         `json:"scene,omitempty"`
	ScenePlaylist *ResolvedScenePlaylist `json:"scene_playlist,omitempty"`
}
