package main

import (
	"bytes"
	"fmt"
	"image/png"
	"log"
	"net/url"
	"os"
	"time"
)

// Agent wires the API client, player, and command channel together.
type Agent struct {
	cfg    *Config
	client *Client
	player *Player
	ws     *WSClient
}

func NewAgent(cfg *Config) *Agent {
	client := NewClient(cfg)
	a := &Agent{cfg: cfg, client: client, player: NewPlayer(cfg, client)}
	a.ws = NewWSClient(cfg, client, a.handleCommand)
	return a
}

func (a *Agent) Run() {
	if err := a.ensureEnrolled(); err != nil {
		log.Fatalf("enrollment failed: %v", err)
	}

	a.player.onPlayback = func(ev PlaybackEvent) { a.ws.SendPlayback(ev) }
	a.player.StartServer()
	a.player.waitForServer()
	a.syncTarget() // fetch before first paint
	a.player.LaunchChromium()

	// Enrollment runs before X11 starts, so collect resolution again once the
	// agent is running in the kiosk display session.
	go a.loop(5*time.Minute, a.reportResolution)
	go a.loop(5*time.Minute, a.reportDeviceInfo)

	go a.loop(time.Duration(a.cfg.HealthInterval)*time.Second, a.reportHealth)
	go a.loop(time.Duration(a.cfg.PlaylistPoll)*time.Second, a.syncTarget)
	// Automatic screenshots are opt-in. A non-positive interval disables them;
	// administrators can still request a screenshot manually from the console.
	if a.cfg.ScreenshotEvery > 0 {
		go a.loop(time.Duration(a.cfg.ScreenshotEvery)*time.Second, a.autoScreenshot)
	}
	// NetworkManager/DHCP/DNS may still be coming online just after boot. Delay
	// the first background OTA check; a manual update check remains immediate.
	go a.delayedLoop(90*time.Second, time.Duration(a.cfg.OTAEvery)*time.Second, a.autoUpdate)

	a.ws.Run() // blocks
}

func (a *Agent) reportResolution() {
	if err := a.client.PostResolution(screenResolution()); err != nil {
		log.Printf("display resolution: %v", err)
	}
}

func (a *Agent) reportDeviceInfo() {
	if err := a.client.PostDeviceInfo(CollectDeviceInfo()); err != nil {
		log.Printf("device info: %v", err)
	}
}

func (a *Agent) ensureEnrolled() error {
	if a.cfg.DeviceUUID != "" && a.cfg.AccessToken != "" {
		return nil
	}
	log.Printf("enrolling device…")
	resp, err := a.client.Enroll(CollectDeviceInfo())
	if err != nil {
		return err
	}
	a.cfg.DeviceUUID = resp.DeviceUUID
	a.cfg.AccessToken = resp.AccessToken
	a.cfg.RefreshToken = resp.RefreshToken
	a.cfg.WSURL = resp.WSURL
	a.cfg.EnrollmentToken = "" // consumed
	log.Printf("enrolled as %s", resp.DeviceUUID)
	return a.cfg.Save()
}

// loop runs fn immediately and then on a fixed interval.
func (a *Agent) loop(d time.Duration, fn func()) {
	if d <= 0 {
		d = time.Minute
	}
	fn()
	t := time.NewTicker(d)
	defer t.Stop()
	for range t.C {
		fn()
	}
}

func (a *Agent) delayedLoop(initialDelay, interval time.Duration, fn func()) {
	time.Sleep(initialDelay)
	a.loop(interval, fn)
}

func (a *Agent) autoUpdate() {
	if !CollectHealth(a.serverHostPort()).NetOK {
		log.Printf("ota: skipped; API network route is not ready")
		return
	}
	if _, err := MaybeUpdate(a.client, func(version string) {
		a.player.Notify("正在更新至 "+version+"…", "warning", true)
	}); err != nil {
		// Background checks are best effort. Do not disturb signage with a boot
		// timing/DNS error; an operator-initiated check still reports the error.
		log.Printf("ota: %v", err)
	}
}

func (a *Agent) serverHostPort() string {
	u, err := url.Parse(a.cfg.ServerURL)
	if err != nil {
		return ""
	}
	port := u.Port()
	if port == "" {
		if u.Scheme == "http" {
			port = "80"
		} else {
			port = "443"
		}
	}
	return u.Hostname() + ":" + port
}

func (a *Agent) reportHealth() {
	h := CollectHealth(a.serverHostPort())
	if err := a.client.PostHealth(h); err != nil {
		log.Printf("health: %v", err)
	}
}

// syncTarget fetches the device's single effective target (playlist / scene /
// scene_playlist). If the target endpoint is unavailable (older API), it falls
// back to the legacy playlist poll so back-compat behaviour is preserved.
func (a *Agent) syncTarget() {
	t, err := a.client.GetTarget()
	if err != nil {
		a.syncPlaylist()
		return
	}
	a.player.SetTarget(t)
}

func (a *Agent) syncPlaylist() {
	pl, err := a.client.GetPlaylist()
	if err != nil {
		log.Printf("playlist: %v", err)
		return
	}
	if pl.PlaylistID == 0 {
		return
	}
	a.player.SetPlaylist(pl)
}

func (a *Agent) autoScreenshot() {
	a.captureAndPost("auto")
}

func (a *Agent) captureAndPost(trigger string) {
	img, err := CaptureScreenshot()
	if err != nil {
		log.Printf("screenshot: %v", err)
		return
	}
	analysis := ""
	if isBlackScreen(img) {
		analysis = "black_screen"
	}
	if err := a.client.PostScreenshot(img, trigger, analysis); err != nil {
		log.Printf("screenshot post: %v", err)
	}
}

// handleCommand executes a server command and returns the ack outcome.
func (a *Agent) handleCommand(cmd ServerCommand) (bool, string) {
	log.Printf("command: %s", cmd.Type)
	switch cmd.Type {
	case "reload":
		a.player.Reload()
		a.reportDeviceInfo()
		a.reportResolution()
		a.reportHealth()
	case "restart_player":
		a.player.Notify("正在重新啟動播放器…", "warning", true)
		a.player.LaunchChromium()
		go a.notifyAfter("播放器已重新啟動", "success", time.Second)
	case "switch_playlist", "switch_scene":
		a.syncTarget()
	case "take_screenshot":
		a.captureAndPost("manual")
	case "check_update":
		a.player.Notify("正在檢查並套用更新…", "warning", true)
		updated, err := MaybeUpdate(a.client, func(version string) {
			a.player.Notify("正在下載並套用 "+version+"…", "warning", true)
		})
		if err != nil {
			a.player.Notify("更新失敗："+err.Error(), "error", false)
			return false, err.Error()
		}
		if !updated {
			a.player.Notify("已是最新版本", "success", false)
		}
	case "sync_time":
		a.player.Notify("正在透過 NTP 對時…", "warning", true)
		detail, err := SyncTime()
		if err != nil {
			a.player.Notify("NTP 對時失敗："+err.Error(), "error", false)
			return false, err.Error()
		}
		a.player.Notify("NTP 對時已啟用", "success", false)
		return true, detail
	case "reboot":
		a.player.Notify("裝置即將重新啟動…", "warning", true)
		time.Sleep(1500 * time.Millisecond)
		if err := Reboot(); err != nil {
			a.player.Notify("重新啟動失敗："+err.Error(), "error", false)
			return false, err.Error()
		}
	case "shutdown":
		a.player.Notify("裝置即將關機…", "warning", true)
		time.Sleep(1500 * time.Millisecond)
		if err := Shutdown(); err != nil {
			a.player.Notify("關機失敗："+err.Error(), "error", false)
			return false, err.Error()
		}
	case "apply_display":
		a.player.Notify("正在套用顯示設定…", "warning", true)
		a.player.ApplyDisplay(displayFromPayload(cmd.Payload, a.cfg.Display))
		go a.notifyAfter("顯示設定已套用", "success", time.Second)
	case "apply_agent_settings":
		a.player.Notify("正在套用週期設定…", "warning", true)
		if err := a.applyAgentSettings(cmd.Payload); err != nil {
			a.player.Notify("套用週期設定失敗："+err.Error(), "error", false)
			return false, err.Error()
		}
		// The kiosk launcher restarts this process. Restarting gives every loop a
		// fresh ticker using the newly persisted intervals, after the ACK is sent.
		go func() {
			time.Sleep(1500 * time.Millisecond)
			os.Exit(0)
		}()
	case "repair_tunnel":
		a.player.Notify("正在修復 SSH 連線…", "warning", true)
		// Freshen the on-disk access token the helper reads, then reinstall the
		// cloudflared connector so SSH remote access recovers over this channel.
		_ = a.client.refresh()
		if err := RepairTunnel(); err != nil {
			a.player.Notify("修復 SSH 連線失敗："+err.Error(), "error", false)
			return false, err.Error()
		}
		a.player.Notify("SSH 連線已修復", "success", false)
	case "reinstall":
		a.player.Notify("正在重新安裝，裝置即將重新啟動…", "warning", true)
		time.Sleep(1500 * time.Millisecond)
		if err := Reinstall(); err != nil {
			a.player.Notify("重新安裝失敗："+err.Error(), "error", false)
			return false, err.Error()
		}
	default:
		return false, "unknown command"
	}
	return true, ""
}

func (a *Agent) notifyAfter(message, level string, delay time.Duration) {
	time.Sleep(delay)
	a.player.Notify(message, level, false)
}

func (a *Agent) applyAgentSettings(p map[string]interface{}) error {
	health, err := intervalFromPayload(p, "health_interval_sec", 10, 3600)
	if err != nil {
		return err
	}
	playlist, err := intervalFromPayload(p, "playlist_poll_sec", 10, 3600)
	if err != nil {
		return err
	}
	screenshot, err := intervalFromPayload(p, "screenshot_interval_sec", 0, 86400)
	if err != nil {
		return err
	}
	ota, err := intervalFromPayload(p, "ota_check_sec", 60, 86400)
	if err != nil {
		return err
	}
	a.cfg.HealthInterval = health
	a.cfg.PlaylistPoll = playlist
	a.cfg.ScreenshotEvery = screenshot
	a.cfg.OTAEvery = ota
	return a.cfg.Save()
}

func intervalFromPayload(p map[string]interface{}, key string, min, max int) (int, error) {
	v, ok := p[key].(float64)
	if !ok || v != float64(int(v)) || v < float64(min) || v > float64(max) {
		return 0, fmt.Errorf("invalid %s", key)
	}
	return int(v), nil
}

func displayFromPayload(p map[string]interface{}, cur Display) Display {
	d := cur
	if v, ok := p["kiosk"].(bool); ok {
		d.Kiosk = v
	}
	if v, ok := p["zoom"].(float64); ok {
		d.Zoom = v
	}
	if v, ok := p["rotate"].(float64); ok {
		d.Rotate = int(v)
	}
	if v, ok := p["screen"].(float64); ok {
		d.Screen = int(v)
	}
	return d
}

// isBlackScreen returns true when a screenshot is almost entirely black.
func isBlackScreen(pngBytes []byte) bool {
	img, err := png.Decode(bytes.NewReader(pngBytes))
	if err != nil {
		return false
	}
	b := img.Bounds()
	if b.Dx() == 0 || b.Dy() == 0 {
		return false
	}
	var sampled, dark int
	stepX := max(1, b.Dx()/64)
	stepY := max(1, b.Dy()/64)
	for y := b.Min.Y; y < b.Max.Y; y += stepY {
		for x := b.Min.X; x < b.Max.X; x += stepX {
			r, g, bl, _ := img.At(x, y).RGBA()
			sampled++
			if (r>>8)+(g>>8)+(bl>>8) < 24 {
				dark++
			}
		}
	}
	return sampled > 0 && float64(dark)/float64(sampled) > 0.99
}
