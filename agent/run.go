package main

import (
	"bytes"
	"context"
	"image/png"
	"log"
	"net/url"
	"sync"
	"time"
)

// Agent wires the API client, player, and command channel together.
type Agent struct {
	cfg    *Config
	client *Client
	player *Player
	ws     *WSClient

	mu       sync.Mutex
	lastSync time.Time // last successful content sync with the server
	ctx      context.Context
	cancel   context.CancelFunc
	wg       sync.WaitGroup
	loops    *loopSet
}

func NewAgent(cfg *Config) *Agent {
	client := NewClient(cfg)
	a := &Agent{cfg: cfg, client: client, player: NewPlayer(cfg, client)}
	a.ws = NewWSClient(cfg, client, a.handleCommand, a.player.SetChannelOnline)
	return a
}

func (a *Agent) Run(parent context.Context) error {
	if err := a.ensureEnrolled(); err != nil {
		return err
	}
	a.ctx, a.cancel = context.WithCancel(parent)
	a.loops = newLoopSet(a.ctx, &a.wg)
	defer a.shutdown()

	a.player.onPlayback = func(ev PlaybackEvent) { a.ws.SendPlayback(ev) }
	a.player.StartServer()
	a.player.waitForServer()
	a.syncTarget() // fetch before first paint
	a.player.StartBrowser()

	// DeviceInfo includes the current X11 resolution. Enrollment can run before
	// X11 starts, so refresh the complete record once the kiosk is running.
	a.startManagedLoops()
	return a.ws.Run(a.ctx)
}

// RequestShutdown begins a graceful stop. It is safe to call more than once.
func (a *Agent) RequestShutdown() {
	if a.cancel != nil {
		a.cancel()
	}
}

func (a *Agent) shutdown() {
	if a.cancel != nil {
		a.cancel()
	}
	if a.loops != nil {
		a.loops.stop()
	}
	a.ws.Stop()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	a.player.Stop(shutdownCtx)
	a.wg.Wait()
}

func (a *Agent) startManagedLoops() {
	a.loops.replace("device-info", 0, time.Duration(a.cfg.DeviceInfoEvery)*time.Second, a.reportDeviceInfo)
	a.loops.replace("health", 0, time.Duration(a.cfg.HealthInterval)*time.Second, a.reportHealth)
	a.loops.replace("target-sync", 0, time.Duration(a.cfg.PlaylistPoll)*time.Second, a.syncTarget)
	a.loops.replace("screenshot", 0, time.Duration(a.cfg.ScreenshotEvery)*time.Second, a.autoScreenshot)
	// Poll the physical link often: a pulled cable should flip the offline badge
	// in seconds, well before the command channel's heartbeat would notice.
	a.loops.replace("link-monitor", 0, 2*time.Second, a.checkLink)
	// Network/DNS may still be coming online just after boot.
	a.loops.replace("ota", 90*time.Second, time.Duration(a.cfg.OTAEvery)*time.Second, a.autoUpdate)
}

func (a *Agent) checkLink() {
	a.player.SetLinkUp(physicalLinkUp())
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

func (a *Agent) autoUpdate() {
	if !CollectHealth(a.serverHostPort()).NetOK {
		log.Printf("ota: skipped; API network route is not ready")
		return
	}
	updated, err := MaybeUpdate(a.client, func(version string) {
		a.player.Notify("正在更新至 "+version+"…", "warning", true)
	})
	if err != nil {
		// Background checks are best effort. Do not disturb signage with a boot
		// timing/DNS error; an operator-initiated check still reports the error.
		log.Printf("ota: %v", err)
		return
	}
	if updated {
		a.RequestShutdown()
	}
}

func (a *Agent) requestShutdownAfter(delay time.Duration) {
	go func() {
		t := time.NewTimer(delay)
		defer t.Stop()
		select {
		case <-a.ctx.Done():
		case <-t.C:
			a.RequestShutdown()
		}
	}()
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
	bs := a.player.BrowserStatus()
	h.ChromiumStatus = bs.State
	h.BrowserRestartCount = bs.RestartCount
	if !bs.LastExitAt.IsZero() {
		h.BrowserLastExitAt = bs.LastExitAt.UTC().Format(time.RFC3339)
	}
	cs := a.player.CacheStats()
	h.CacheUsedBytes = cs.UsedBytes
	h.CacheLimitBytes = cs.LimitBytes
	a.mu.Lock()
	last := a.lastSync
	a.mu.Unlock()
	if !last.IsZero() {
		h.LastSyncSuccessAt = last.UTC().Format(time.RFC3339)
	}
	if err := a.client.PostHealth(h); err != nil {
		log.Printf("health: %v", err)
	}
}

// syncTarget fetches the device's single effective scene or scene-group target.
func (a *Agent) syncTarget() {
	t, err := a.client.GetTarget()
	if err != nil {
		log.Printf("target: %v", err)
		return
	}
	if !a.player.SetTarget(t) {
		return
	}
	a.mu.Lock()
	a.lastSync = time.Now()
	a.mu.Unlock()
}

func (a *Agent) autoScreenshot() {
	_ = a.captureAndPost("auto")
}

func (a *Agent) captureAndPost(trigger string) bool {
	img, err := CaptureScreenshot()
	if err != nil {
		log.Printf("screenshot: %v", err)
		if trigger == "manual" {
			a.player.Notify("擷取螢幕畫面失敗："+err.Error(), "error", false)
		}
		return false
	}
	analysis := ""
	if isBlackScreen(img) {
		analysis = "black_screen"
	}
	if err := a.client.PostScreenshot(img, trigger, analysis); err != nil {
		log.Printf("screenshot post: %v", err)
		if trigger == "manual" {
			a.player.Notify("回傳螢幕畫面失敗："+err.Error(), "error", false)
		}
		return false
	}
	return true
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
