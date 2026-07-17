package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// Display mirrors the server-side DisplaySettings.
type Display struct {
	Kiosk  bool    `json:"kiosk"`
	Zoom   float64 `json:"zoom"`
	Rotate int     `json:"rotate"`
	Screen int     `json:"screen"`
}

// Config is persisted to disk and updated in place as enrollment/token state changes.
type Config struct {
	ServerURL       string  `json:"server_url"`
	EnrollmentToken string  `json:"enrollment_token,omitempty"`
	DeviceUUID      string  `json:"device_uuid,omitempty"`
	AccessToken     string  `json:"access_token,omitempty"`
	RefreshToken    string  `json:"refresh_token,omitempty"`
	WSURL           string  `json:"ws_url,omitempty"`
	Channel         string  `json:"channel,omitempty"`
	OTAPublicKey    string  `json:"ota_public_key,omitempty"` // base64 ed25519 public key
	PlayerPort      int     `json:"player_port,omitempty"`
	HealthInterval  int     `json:"health_interval_sec,omitempty"`
	PlaylistPoll    int     `json:"playlist_poll_sec,omitempty"`
	ScreenshotEvery int     `json:"screenshot_interval_sec,omitempty"`
	OTAEvery        int     `json:"ota_check_sec,omitempty"`
	CacheDir        string  `json:"cache_dir,omitempty"`
	ChromiumBin     string  `json:"chromium_bin,omitempty"`
	Display         Display `json:"display"`

	path string
	mu   sync.Mutex
}

func LoadConfig(path string) (*Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	c := &Config{}
	if err := json.Unmarshal(b, c); err != nil {
		return nil, err
	}
	c.path = path
	c.applyDefaults()
	return c, nil
}

func (c *Config) applyDefaults() {
	if c.PlayerPort == 0 {
		c.PlayerPort = 8888
	}
	if c.HealthInterval == 0 {
		c.HealthInterval = 60
	}
	if c.PlaylistPoll == 0 {
		c.PlaylistPoll = 30
	}
	if c.OTAEvery == 0 {
		c.OTAEvery = 1800
	}
	if c.Channel == "" {
		c.Channel = "stable"
	}
	if c.CacheDir == "" {
		c.CacheDir = "/var/lib/screenboard/cache"
	}
	if c.ChromiumBin == "" {
		c.ChromiumBin = "chromium"
	}
	if c.Display.Zoom == 0 {
		c.Display.Zoom = 1
	}
}

// Save atomically persists the current config to disk.
func (c *Config) Save() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(c.path), 0o755); err != nil {
		return err
	}
	tmp := c.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, c.path)
}
