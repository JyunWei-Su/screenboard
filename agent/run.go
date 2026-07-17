package main

import (
	"bytes"
	"image/png"
	"log"
	"net/url"
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
	a.syncPlaylist() // fetch before first paint
	a.player.LaunchChromium()

	// Enrollment runs before X11 starts, so collect resolution again once the
	// agent is running in the kiosk display session.
	go a.loop(5*time.Minute, a.reportResolution)
	go a.loop(5*time.Minute, a.reportDeviceInfo)

	go a.loop(time.Duration(a.cfg.HealthInterval)*time.Second, a.reportHealth)
	go a.loop(time.Duration(a.cfg.PlaylistPoll)*time.Second, a.syncPlaylist)
	// Automatic screenshots are opt-in. A non-positive interval disables them;
	// administrators can still request a screenshot manually from the console.
	if a.cfg.ScreenshotEvery > 0 {
		go a.loop(time.Duration(a.cfg.ScreenshotEvery)*time.Second, a.autoScreenshot)
	}
	go a.loop(time.Duration(a.cfg.OTAEvery)*time.Second, func() { MaybeUpdate(a.client, a.cfg) })

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
		a.player.LaunchChromium()
	case "switch_playlist":
		a.syncPlaylist()
	case "take_screenshot":
		a.captureAndPost("manual")
	case "check_update":
		MaybeUpdate(a.client, a.cfg)
	case "reboot":
		if err := Reboot(); err != nil {
			return false, err.Error()
		}
	case "shutdown":
		if err := Shutdown(); err != nil {
			return false, err.Error()
		}
	case "apply_display":
		a.player.ApplyDisplay(displayFromPayload(cmd.Payload, a.cfg.Display))
	default:
		return false, "unknown command"
	}
	return true, ""
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
