package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed assets/player.html
var playerHTML []byte

// Player serves the local kiosk page + cached media and controls Chromium.
type Player struct {
	cfg    *Config
	client *Client

	mu           sync.Mutex
	current      *ResolvedPlaylist // legacy playlist (served at /playlist.json)
	target       *ResolvedTarget   // full resolved target (served at /target.json)
	fileMap      map[int]string    // playlist item id / scene media id -> local cached file path
	proxyAllow   map[string]bool   // hostnames the active scene may proxy through
	chromium     *exec.Cmd
	notification PlayerNotification

	onPlayback func(PlaybackEvent) // relayed over the WS channel
}

// PlayerNotification is displayed by the local kiosk page. It never leaves the
// device and is intentionally limited to operational status, not credentials.
type PlayerNotification struct {
	ID         uint64 `json:"id"`
	Message    string `json:"message"`
	Level      string `json:"level"` // info | success | warning | error
	Persistent bool   `json:"persistent"`
}

func NewPlayer(cfg *Config, client *Client) *Player {
	return &Player{
		cfg:        cfg,
		client:     client,
		fileMap:    map[int]string{},
		proxyAllow: map[string]bool{},
	}
}

// StartServer runs the local HTTP server the Chromium kiosk points at.
func (p *Player) StartServer() {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(playerHTML)
	})
	mux.HandleFunc("/playlist.json", p.handlePlaylistJSON)
	mux.HandleFunc("/target.json", p.handleTargetJSON)
	mux.HandleFunc("/media/", p.handleMedia)
	mux.HandleFunc("/proxy", p.handleProxy)
	mux.HandleFunc("/event", p.handleEvent)
	mux.HandleFunc("/notification.json", p.handleNotification)

	addr := fmt.Sprintf("127.0.0.1:%d", p.cfg.PlayerPort)
	go func() {
		log.Printf("player server listening on %s", addr)
		if err := http.ListenAndServe(addr, mux); err != nil {
			log.Printf("player server error: %v", err)
		}
	}()
}

func (p *Player) handleNotification(w http.ResponseWriter, _ *http.Request) {
	p.mu.Lock()
	notice := p.notification
	p.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(notice)
}

// Notify places a status message in the lower-left of the kiosk display.
// A later notification replaces a persistent progress message with its result.
func (p *Player) Notify(message, level string, persistent bool) {
	p.mu.Lock()
	p.notification.ID++
	p.notification.Message = message
	p.notification.Level = level
	p.notification.Persistent = persistent
	p.mu.Unlock()
}

func (p *Player) handlePlaylistJSON(w http.ResponseWriter, _ *http.Request) {
	p.mu.Lock()
	defer p.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	if p.current == nil {
		w.Write([]byte(`{"playlist_id":null,"items":[],"revision":""}`))
		return
	}
	out := p.rewritePlaylist(*p.current)
	json.NewEncoder(w).Encode(out)
}

// handleTargetJSON serves the full resolved target (playlist / scene /
// scene_playlist / none) with any cached media rewritten to local /media URLs.
// The new scene-aware player polls this; /playlist.json stays for back-compat.
func (p *Player) handleTargetJSON(w http.ResponseWriter, _ *http.Request) {
	p.mu.Lock()
	defer p.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	if p.target == nil {
		w.Write([]byte(`{"kind":"none"}`))
		return
	}
	out := *p.target
	switch out.Kind {
	case "playlist":
		if out.Playlist != nil {
			pl := p.rewritePlaylist(*out.Playlist)
			out.Playlist = &pl
		}
	case "scene":
		if out.Scene != nil {
			sc := p.rewriteScene(*out.Scene)
			out.Scene = &sc
		}
	case "scene_playlist":
		if out.ScenePlaylist != nil {
			spl := *out.ScenePlaylist
			scenes := make([]ResolvedScenePlaylistItem, len(spl.Scenes))
			for i, e := range spl.Scenes {
				scenes[i] = ResolvedScenePlaylistItem{DwellSec: e.DwellSec, Scene: p.rewriteScene(e.Scene)}
			}
			spl.Scenes = scenes
			out.ScenePlaylist = &spl
		}
	}
	json.NewEncoder(w).Encode(out)
}

// rewritePlaylist swaps cached media item sources for local /media/<id> URLs
// while leaving external URLs intact. Caller holds p.mu.
func (p *Player) rewritePlaylist(pl ResolvedPlaylist) ResolvedPlaylist {
	items := make([]PlaylistItem, len(pl.Items))
	for i, it := range pl.Items {
		if _, ok := p.fileMap[it.ID]; ok {
			it.Source = fmt.Sprintf("/media/%d", it.ID)
		}
		items[i] = it
	}
	pl.Items = items
	return pl
}

// rewriteScene returns a copy of the scene with any cached widget/background
// media source rewritten to a local /media/<media_id> URL. Caller holds p.mu.
func (p *Player) rewriteScene(sc ResolvedScene) ResolvedScene {
	sc.Background = p.rewriteSourceMap(sc.Background)
	widgets := make([]ResolvedSceneWidget, len(sc.Widgets))
	for i, wdg := range sc.Widgets {
		widgets[i] = wdg
		widgets[i].Config = p.rewriteSourceMap(wdg.Config)
	}
	sc.Widgets = widgets
	return sc
}

// rewriteSourceMap shallow-copies a config/background map and, when its
// "source" points at a cached media file, rewrites it to /media/<id>.
func (p *Player) rewriteSourceMap(m map[string]interface{}) map[string]interface{} {
	if m == nil {
		return nil
	}
	src, ok := m["source"].(string)
	if !ok || src == "" {
		return m
	}
	id, ok := mediaIDFromURL(src)
	if !ok {
		return m
	}
	if _, cached := p.fileMap[id]; !cached {
		return m
	}
	out := make(map[string]interface{}, len(m))
	for k, v := range m {
		out[k] = v
	}
	out["source"] = fmt.Sprintf("/media/%d", id)
	return out
}

func (p *Player) handleMedia(w http.ResponseWriter, r *http.Request) {
	idStr := strings.TrimPrefix(r.URL.Path, "/media/")
	id, err := strconv.Atoi(idStr)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	p.mu.Lock()
	path, ok := p.fileMap[id]
	p.mu.Unlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, path)
}

func (p *Player) handleEvent(w http.ResponseWriter, r *http.Request) {
	var ev PlaybackEvent
	if err := json.NewDecoder(r.Body).Decode(&ev); err != nil {
		w.WriteHeader(400)
		return
	}
	ev.Type = "playback"
	if p.onPlayback != nil {
		p.onPlayback(ev)
	}
	w.WriteHeader(204)
}

// SetPlaylist caches any new media and swaps in the new playlist for the player.
func (p *Player) SetPlaylist(pl *ResolvedPlaylist) {
	p.mu.Lock()
	sameRev := p.current != nil && p.current.Revision == pl.Revision
	p.mu.Unlock()
	if sameRev {
		return
	}

	if err := os.MkdirAll(p.cfg.CacheDir, 0o755); err != nil {
		log.Printf("cache dir: %v", err)
	}
	fileMap := map[int]string{}
	for _, it := range pl.Items {
		if !strings.Contains(it.Source, "/api/content/media/") {
			continue // external URL/html — the browser loads it directly
		}
		dest := filepath.Join(p.cfg.CacheDir, fmt.Sprintf("%s_%d", pl.Revision, it.ID))
		if _, err := os.Stat(dest); err != nil {
			if err := p.client.DownloadTo(it.Source, dest); err != nil {
				log.Printf("download item %d: %v", it.ID, err)
				continue
			}
		}
		fileMap[it.ID] = dest
	}

	p.mu.Lock()
	p.current = pl
	p.fileMap = fileMap
	p.mu.Unlock()
	log.Printf("playlist updated: %s (%d items, rev %s)", pl.Name, len(pl.Items), pl.Revision)
}

// SetTarget applies whatever a device currently resolves to: a legacy playlist,
// a single scene, a scene playlist, or nothing. Media referenced by each shape
// is cached locally (like SetPlaylist) so playback survives a network drop.
func (p *Player) SetTarget(t *ResolvedTarget) {
	if t == nil {
		return
	}
	switch t.Kind {
	case "playlist":
		if t.Playlist == nil {
			p.clearTarget()
			return
		}
		// Reuse the legacy playlist path verbatim so back-compat behaviour is
		// byte-for-byte identical, then record the target for /target.json.
		p.SetPlaylist(t.Playlist)
		p.mu.Lock()
		p.target = t
		p.proxyAllow = map[string]bool{}
		p.mu.Unlock()
	case "scene":
		p.setScene(t)
	case "scene_playlist":
		p.setScenePlaylist(t)
	default: // "none" or unknown
		p.clearTarget()
	}
}

func (p *Player) clearTarget() {
	p.mu.Lock()
	p.target = &ResolvedTarget{Kind: "none"}
	p.current = nil
	p.fileMap = map[int]string{}
	p.proxyAllow = map[string]bool{}
	p.mu.Unlock()
}

func (p *Player) setScene(t *ResolvedTarget) {
	sc := t.Scene
	if sc == nil {
		p.clearTarget()
		return
	}
	p.mu.Lock()
	same := p.target != nil && p.target.Kind == "scene" && p.target.Scene != nil &&
		p.target.Scene.Revision == sc.Revision
	p.mu.Unlock()
	if same {
		return
	}
	if err := os.MkdirAll(p.cfg.CacheDir, 0o755); err != nil {
		log.Printf("cache dir: %v", err)
	}
	fileMap := map[int]string{}
	p.cacheSceneInto(*sc, fileMap)
	allow := proxyAllowForScene(*sc)

	p.mu.Lock()
	p.target = t
	p.current = nil
	p.fileMap = fileMap
	p.proxyAllow = allow
	p.mu.Unlock()
	log.Printf("scene updated: %s (%d widgets, rev %s)", sc.Name, len(sc.Widgets), sc.Revision)
}

func (p *Player) setScenePlaylist(t *ResolvedTarget) {
	spl := t.ScenePlaylist
	if spl == nil {
		p.clearTarget()
		return
	}
	p.mu.Lock()
	same := p.target != nil && p.target.Kind == "scene_playlist" && p.target.ScenePlaylist != nil &&
		p.target.ScenePlaylist.Revision == spl.Revision
	p.mu.Unlock()
	if same {
		return
	}
	if err := os.MkdirAll(p.cfg.CacheDir, 0o755); err != nil {
		log.Printf("cache dir: %v", err)
	}
	fileMap := map[int]string{}
	allow := map[string]bool{}
	for _, entry := range spl.Scenes {
		p.cacheSceneInto(entry.Scene, fileMap)
		for h := range proxyAllowForScene(entry.Scene) {
			allow[h] = true
		}
	}

	p.mu.Lock()
	p.target = t
	p.current = nil
	p.fileMap = fileMap
	p.proxyAllow = allow
	p.mu.Unlock()
	log.Printf("scene playlist updated: %s (%d scenes, rev %s)", spl.Name, len(spl.Scenes), spl.Revision)
}

// cacheSceneInto downloads any media-backed source (background + widgets) that
// points at the API media endpoint, keyed by media id, into fileMap.
func (p *Player) cacheSceneInto(sc ResolvedScene, fileMap map[int]string) {
	type mediaRef struct {
		id  int
		url string
	}
	var refs []mediaRef
	collect := func(m map[string]interface{}) {
		if m == nil {
			return
		}
		s, ok := m["source"].(string)
		if !ok || !strings.Contains(s, "/api/content/media/") {
			return
		}
		if id, ok := mediaIDFromURL(s); ok {
			refs = append(refs, mediaRef{id: id, url: s})
		}
	}
	collect(sc.Background)
	for _, wdg := range sc.Widgets {
		collect(wdg.Config)
	}
	for _, ref := range refs {
		if _, done := fileMap[ref.id]; done {
			continue
		}
		dest := filepath.Join(p.cfg.CacheDir, fmt.Sprintf("scene_%s_%d", sc.Revision, ref.id))
		if _, err := os.Stat(dest); err != nil {
			if err := p.client.DownloadTo(ref.url, dest); err != nil {
				log.Printf("download scene media %d: %v", ref.id, err)
				continue
			}
		}
		fileMap[ref.id] = dest
	}
}

// mediaIDFromURL extracts the numeric media id from a .../api/content/media/<id>
// URL (ignoring any query string), used both to cache and to rewrite sources.
func mediaIDFromURL(u string) (int, bool) {
	const marker = "/api/content/media/"
	idx := strings.Index(u, marker)
	if idx < 0 {
		return 0, false
	}
	rest := u[idx+len(marker):]
	end := len(rest)
	for i := 0; i < len(rest); i++ {
		if rest[i] < '0' || rest[i] > '9' {
			end = i
			break
		}
	}
	if end == 0 {
		return 0, false
	}
	n, err := strconv.Atoi(rest[:end])
	if err != nil {
		return 0, false
	}
	return n, true
}

// proxyAllowForScene returns the set of hostnames the scene is permitted to
// proxy through: exactly the hosts named by its web widgets in proxy mode.
func proxyAllowForScene(sc ResolvedScene) map[string]bool {
	allow := map[string]bool{}
	for _, wdg := range sc.Widgets {
		if wdg.Kind != "web" || wdg.Config == nil {
			continue
		}
		if mode, _ := wdg.Config["mode"].(string); mode != "proxy" {
			continue
		}
		raw, _ := wdg.Config["url"].(string)
		if raw == "" {
			continue
		}
		if u, err := url.Parse(raw); err == nil {
			if h := strings.ToLower(u.Hostname()); h != "" {
				allow[h] = true
			}
		}
	}
	return allow
}

// handleProxy fetches an allowlisted external page on behalf of a `web` widget
// in proxy mode. It refuses any host not declared by the active scene and any
// host that resolves to loopback/private/link-local space, so the proxy can
// never be turned into a window onto the device's own LAN.
func (p *Player) handleProxy(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("url")
	if target == "" {
		http.Error(w, "missing url", http.StatusBadRequest)
		return
	}
	u, err := url.Parse(target)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		http.Error(w, "invalid url", http.StatusBadRequest)
		return
	}
	host := strings.ToLower(u.Hostname())

	p.mu.Lock()
	allowed := p.proxyAllow[host]
	p.mu.Unlock()
	if !allowed {
		http.Error(w, "host not allowed", http.StatusForbidden)
		return
	}
	resolved := make(map[string][]net.IP)
	ips, err := resolvePublicHost(host)
	if err != nil {
		http.Error(w, "blocked internal target", http.StatusForbidden)
		return
	}
	resolved[host] = ips

	// Pin every outbound connection to the IPs that passed validation. The
	// default transport would perform a second DNS lookup after validation,
	// leaving a DNS-rebinding window to the device's private network.
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	transport := &http.Transport{
		Proxy: nil, // an environment proxy would bypass the checked destination
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			h, port, splitErr := net.SplitHostPort(addr)
			if splitErr != nil {
				return nil, splitErr
			}
			pinned := resolved[strings.ToLower(h)]
			if len(pinned) == 0 {
				return nil, fmt.Errorf("unvalidated destination")
			}
			return dialer.DialContext(ctx, network, net.JoinHostPort(pinned[0].String(), port))
		},
	}
	defer transport.CloseIdleConnections()

	client := &http.Client{
		Timeout:   20 * time.Second,
		Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("too many redirects")
			}
			h := strings.ToLower(req.URL.Hostname())
			p.mu.Lock()
			ok := p.proxyAllow[h]
			p.mu.Unlock()
			if !ok {
				return fmt.Errorf("redirect to disallowed host blocked")
			}
			redirectIPs, resolveErr := resolvePublicHost(h)
			if resolveErr != nil {
				return fmt.Errorf("redirect to internal target blocked")
			}
			resolved[h] = redirectIPs
			return nil
		},
	}
	req, err := http.NewRequest("GET", u.String(), nil)
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	req.Header.Set("User-Agent", "ScreenBoard-Proxy")
	resp, err := client.Do(req)
	if err != nil {
		http.Error(w, "upstream fetch failed", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Pass content through but strip framing-restrictive headers so the fetched
	// page can render inside the widget iframe. HTML gets an explicit base URL,
	// otherwise relative styles/scripts/images would resolve against /proxy.
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.Header().Set("X-Proxied-By", "screenboard")
	if strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "text/html") {
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
		if readErr != nil {
			http.Error(w, "upstream read failed", http.StatusBadGateway)
			return
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(injectHTMLBase(body, resp.Request.URL))
		return
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, io.LimitReader(resp.Body, 32<<20))
}

func injectHTMLBase(body []byte, source *url.URL) []byte {
	lower := strings.ToLower(string(body))
	base := []byte(`<base href="` + html.EscapeString(source.String()) + `">`)
	if start := strings.Index(lower, "<head"); start >= 0 {
		if end := strings.Index(lower[start:], ">"); end >= 0 {
			at := start + end + 1
			return append(append(body[:at:at], base...), body[at:]...)
		}
	}
	return append(base, body...)
}

// resolvePublicHost returns the exact IPs that a request may use. Callers must
// dial only these addresses rather than resolving the hostname again.
func resolvePublicHost(host string) ([]net.IP, error) {
	if host == "" {
		return nil, fmt.Errorf("empty host")
	}
	if host == "localhost" || strings.HasSuffix(host, ".localhost") ||
		strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") {
		return nil, fmt.Errorf("internal hostname")
	}
	if ip := net.ParseIP(host); ip != nil {
		if isBlockedIP(ip) {
			return nil, fmt.Errorf("blocked address")
		}
		return []net.IP{ip}, nil
	}
	ips, err := net.LookupIP(host)
	if err != nil || len(ips) == 0 {
		return nil, fmt.Errorf("hostname did not resolve")
	}
	for _, ip := range ips {
		if isBlockedIP(ip) {
			return nil, fmt.Errorf("blocked address")
		}
	}
	return ips, nil
}

// isBlockedIP is true for any address the proxy must never reach.
func isBlockedIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast()
}

// LaunchChromium (re)starts the kiosk browser with current display settings.
func (p *Player) LaunchChromium() {
	p.mu.Lock()
	if p.chromium != nil && p.chromium.Process != nil {
		_ = p.chromium.Process.Kill()
	}
	p.mu.Unlock()

	p.applyRotation()

	url := fmt.Sprintf("http://127.0.0.1:%d/", p.cfg.PlayerPort)
	args := []string{
		"--noerrdialogs",
		"--disable-infobars",
		"--disable-session-crashed-bubble",
		"--disable-translate",
		"--incognito",
		"--user-data-dir=/tmp/screenboard-chromium",
		// Paint the pre-first-paint surface black instead of Chromium's default
		// white, so a cold (re)launch does not flash white before player.html's
		// black background renders. Value is ARGB hex (opaque black).
		"--default-background-color=FF000000",
		fmt.Sprintf("--force-device-scale-factor=%.2f", p.cfg.Display.Zoom),
	}
	if p.cfg.Display.Kiosk {
		args = append(args, "--kiosk")
	}
	args = append(args, "--app="+url)

	cmd := exec.Command(p.cfg.ChromiumBin, args...)
	cmd.Env = append(os.Environ(), "DISPLAY=:0")
	if err := cmd.Start(); err != nil {
		log.Printf("chromium start failed: %v", err)
		return
	}
	p.mu.Lock()
	p.chromium = cmd
	p.mu.Unlock()
	log.Printf("chromium launched: %s", url)
}

// Reload restarts the browser (simplest reliable reload for a kiosk).
func (p *Player) Reload() { p.LaunchChromium() }

// ApplyDisplay updates display settings and relaunches with them.
func (p *Player) ApplyDisplay(d Display) {
	p.cfg.Display = d
	_ = p.cfg.Save()
	p.LaunchChromium()
}

func (p *Player) applyRotation() {
	out := connectedOutput()
	if out == "" {
		return
	}
	rot := map[int]string{0: "normal", 90: "right", 180: "inverted", 270: "left"}[p.cfg.Display.Rotate]
	if rot == "" {
		rot = "normal"
	}
	cmd := exec.Command("xrandr", "--output", out, "--rotate", rot)
	cmd.Env = append(os.Environ(), "DISPLAY=:0")
	if err := cmd.Run(); err != nil {
		log.Printf("xrandr rotate: %v", err)
	}
}

func connectedOutput() string {
	cmd := exec.Command("xrandr")
	cmd.Env = append(os.Environ(), "DISPLAY=:0")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, " connected") {
			return strings.Fields(line)[0]
		}
	}
	return ""
}

// waitForServer blocks briefly until the local player server accepts connections.
func (p *Player) waitForServer() {
	url := fmt.Sprintf("http://127.0.0.1:%d/", p.cfg.PlayerPort)
	for i := 0; i < 20; i++ {
		if resp, err := http.Get(url); err == nil {
			resp.Body.Close()
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
}
