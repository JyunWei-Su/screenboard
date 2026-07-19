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
	updateMu     sync.Mutex        // serializes target downloads and cache commits
	current      *ResolvedPlaylist // legacy playlist (served at /playlist.json)
	target       *ResolvedTarget   // full resolved target (served at /target.json)
	fileMap      map[int]string    // playlist item id / scene media id -> local cached file path
	proxyAllow   map[string]bool   // hostnames the active scene may proxy through
	notification  PlayerNotification
	channelOnline bool // WS command channel up
	linkUp        bool // physical network link (carrier) present
	server        *http.Server

	browser *Browser      // supervises the kiosk browser process
	cache   *CacheManager // media cache with retention + byte cap

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
	p := &Player{
		cfg:        cfg,
		client:     client,
		fileMap:    map[int]string{},
		proxyAllow: map[string]bool{},
		cache:      NewCacheManager(cfg, client),
		// Assume connected until the signals say otherwise, so a booting device
		// doesn't flash the offline badge before its first connect / link check.
		channelOnline: true,
		linkUp:        true,
	}
	// The browser is relaunched with the current display settings; reapply
	// rotation before each launch so an orientation change survives a restart.
	p.browser = NewBrowser(cfg, p.applyRotation)
	return p
}

// StartBrowser begins supervising the kiosk browser (launch + crash recovery).
func (p *Player) StartBrowser() { p.browser.Start() }

// RestartBrowser performs an operator-requested relaunch (not counted a crash).
func (p *Player) RestartBrowser() { p.browser.Relaunch() }

// BrowserStatus reports the supervised browser's state for health.
func (p *Player) BrowserStatus() BrowserStatus { return p.browser.Status() }

// CacheStats reports media-cache usage for health.
func (p *Player) CacheStats() CacheStats { return p.cache.Stats() }

// Stop closes the local HTTP server and waits for Chromium to be reaped.
func (p *Player) Stop(ctx context.Context) {
	p.browser.Stop()
	p.mu.Lock()
	server := p.server
	p.mu.Unlock()
	if server != nil {
		if err := server.Shutdown(ctx); err != nil {
			log.Printf("player server shutdown: %v", err)
		}
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
	mux.HandleFunc("/status.json", p.handleStatus)

	addr := fmt.Sprintf("127.0.0.1:%d", p.cfg.PlayerPort)
	server := &http.Server{Addr: addr, Handler: mux}
	p.mu.Lock()
	p.server = server
	p.mu.Unlock()
	go func() {
		log.Printf("player server listening on %s", addr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
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

// handleStatus reports the live connectivity state the kiosk page polls to show
// or hide the "目前離線" badge.
func (p *Player) handleStatus(w http.ResponseWriter, _ *http.Request) {
	p.mu.Lock()
	// Offline if the command channel is down OR the physical link is gone. The
	// link signal is the faster, unambiguous one when a cable is pulled.
	online := p.channelOnline && p.linkUp
	p.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"online": online})
}

// SetChannelOnline records whether the WS command channel to the server is up.
// The kiosk shows "目前離線" whenever the device is offline, so an on-site viewer
// can tell the screen is running on cached content, not live data.
func (p *Player) SetChannelOnline(online bool) {
	p.mu.Lock()
	p.channelOnline = online
	p.mu.Unlock()
}

// SetLinkUp records whether the device has a physical network link (carrier).
// A pulled cable or dropped Wi-Fi clears this within one link-monitor tick —
// much faster than waiting for the command channel's heartbeat to fail.
func (p *Player) SetLinkUp(up bool) {
	p.mu.Lock()
	p.linkUp = up
	p.mu.Unlock()
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

// SetPlaylist caches the playlist's media to completion and, only on success,
// swaps in the new playlist. It returns false when caching failed so the caller
// keeps serving the current content. A same-revision playlist is a no-op.
func (p *Player) SetPlaylist(pl *ResolvedPlaylist) bool {
	p.mu.Lock()
	sameRev := p.current != nil && p.current.Revision == pl.Revision
	p.mu.Unlock()
	if sameRev {
		return true
	}

	fileMap, err := p.cache.Prepare(playlistRefs(pl))
	if err != nil {
		log.Printf("playlist %s: cache prepare failed, keeping current content: %v", pl.Revision, err)
		return false
	}

	p.mu.Lock()
	p.current = pl
	p.fileMap = fileMap
	p.mu.Unlock()
	p.cache.Commit(pathsOf(fileMap))
	log.Printf("playlist updated: %s (%d items, rev %s)", pl.Name, len(pl.Items), pl.Revision)
	return true
}

// SetTarget applies whatever a device currently resolves to: a legacy playlist,
// a single scene, a scene playlist, or nothing. Each target's media is cached to
// completion before the swap, so a failed download leaves the screen unchanged.
func (p *Player) SetTarget(t *ResolvedTarget) bool {
	p.updateMu.Lock()
	defer p.updateMu.Unlock()
	if t == nil {
		return false
	}
	switch t.Kind {
	case "playlist":
		if t.Playlist == nil {
			p.clearTarget()
			return true
		}
		if !p.SetPlaylist(t.Playlist) {
			return false // caching failed; current content preserved
		}
		p.mu.Lock()
		p.target = t
		p.proxyAllow = map[string]bool{}
		p.mu.Unlock()
		return true
	case "scene":
		return p.setScene(t)
	case "scene_playlist":
		return p.setScenePlaylist(t)
	default: // "none" or unknown
		p.clearTarget()
		return true
	}
}

func (p *Player) clearTarget() {
	p.mu.Lock()
	p.target = &ResolvedTarget{Kind: "none"}
	p.current = nil
	p.fileMap = map[int]string{}
	p.proxyAllow = map[string]bool{}
	p.mu.Unlock()
	p.cache.Commit(nil)
}

func (p *Player) setScene(t *ResolvedTarget) bool {
	sc := t.Scene
	if sc == nil {
		p.clearTarget()
		return true
	}
	p.mu.Lock()
	same := p.target != nil && p.target.Kind == "scene" && p.target.Scene != nil &&
		p.target.Scene.Revision == sc.Revision
	p.mu.Unlock()
	if same {
		return true
	}
	fileMap, err := p.cache.Prepare(sceneRefs(*sc))
	if err != nil {
		log.Printf("scene %s: cache prepare failed, keeping current content: %v", sc.Revision, err)
		return false
	}
	allow := proxyAllowForScene(*sc)

	p.mu.Lock()
	p.target = t
	p.current = nil
	p.fileMap = fileMap
	p.proxyAllow = allow
	p.mu.Unlock()
	p.cache.Commit(pathsOf(fileMap))
	log.Printf("scene updated: %s (%d widgets, rev %s)", sc.Name, len(sc.Widgets), sc.Revision)
	return true
}

func (p *Player) setScenePlaylist(t *ResolvedTarget) bool {
	spl := t.ScenePlaylist
	if spl == nil {
		p.clearTarget()
		return true
	}
	p.mu.Lock()
	same := p.target != nil && p.target.Kind == "scene_playlist" && p.target.ScenePlaylist != nil &&
		p.target.ScenePlaylist.Revision == spl.Revision
	p.mu.Unlock()
	if same {
		return true
	}
	var refs []MediaRef
	allow := map[string]bool{}
	for _, entry := range spl.Scenes {
		refs = append(refs, sceneRefs(entry.Scene)...)
		for h := range proxyAllowForScene(entry.Scene) {
			allow[h] = true
		}
	}
	fileMap, err := p.cache.Prepare(refs)
	if err != nil {
		log.Printf("scene playlist %s: cache prepare failed, keeping current content: %v", spl.Revision, err)
		return false
	}

	p.mu.Lock()
	p.target = t
	p.current = nil
	p.fileMap = fileMap
	p.proxyAllow = allow
	p.mu.Unlock()
	p.cache.Commit(pathsOf(fileMap))
	log.Printf("scene playlist updated: %s (%d scenes, rev %s)", spl.Name, len(spl.Scenes), spl.Revision)
	return true
}

// playlistRefs lists the cacheable media in a playlist. External URLs/HTML the
// browser loads directly are skipped. The cache key embeds the revision so a
// content change downloads fresh files while a restart reuses the existing ones.
func playlistRefs(pl *ResolvedPlaylist) []MediaRef {
	var refs []MediaRef
	for _, it := range pl.Items {
		if !strings.Contains(it.Source, "/api/content/media/") {
			continue
		}
		refs = append(refs, MediaRef{
			ID:  it.ID,
			URL: it.Source,
			Key: fmt.Sprintf("%s_%d", pl.Revision, it.ID),
		})
	}
	return refs
}

// sceneRefs lists the cacheable media referenced by a scene's background and
// widgets (media-backed sources pointing at the API media endpoint).
func sceneRefs(sc ResolvedScene) []MediaRef {
	var refs []MediaRef
	collect := func(m map[string]interface{}) {
		if m == nil {
			return
		}
		s, ok := m["source"].(string)
		if !ok || !strings.Contains(s, "/api/content/media/") {
			return
		}
		if id, ok := mediaIDFromURL(s); ok {
			refs = append(refs, MediaRef{
				ID:  id,
				URL: s,
				Key: fmt.Sprintf("scene_%s_%d", sc.Revision, id),
			})
		}
	}
	collect(sc.Background)
	for _, wdg := range sc.Widgets {
		collect(wdg.Config)
	}
	return refs
}

// pathsOf returns the unique local file paths in a fileMap.
func pathsOf(fileMap map[int]string) []string {
	paths := make([]string, 0, len(fileMap))
	for _, p := range fileMap {
		paths = append(paths, p)
	}
	return paths
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

// Reload restarts the browser (simplest reliable reload for a kiosk).
func (p *Player) Reload() { p.browser.Relaunch() }

// ApplyDisplay updates display settings and relaunches with them.
func (p *Player) ApplyDisplay(d Display) {
	p.cfg.Display = d
	_ = p.cfg.Save()
	p.browser.Relaunch()
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
