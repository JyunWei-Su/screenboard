package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
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

	mu       sync.Mutex
	current  *ResolvedPlaylist
	fileMap  map[int]string // item id -> local cached file path
	chromium *exec.Cmd

	onPlayback func(PlaybackEvent) // relayed over the WS channel
}

func NewPlayer(cfg *Config, client *Client) *Player {
	return &Player{cfg: cfg, client: client, fileMap: map[int]string{}}
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
	mux.HandleFunc("/media/", p.handleMedia)
	mux.HandleFunc("/event", p.handleEvent)

	addr := fmt.Sprintf("127.0.0.1:%d", p.cfg.PlayerPort)
	go func() {
		log.Printf("player server listening on %s", addr)
		if err := http.ListenAndServe(addr, mux); err != nil {
			log.Printf("player server error: %v", err)
		}
	}()
}

func (p *Player) handlePlaylistJSON(w http.ResponseWriter, _ *http.Request) {
	p.mu.Lock()
	defer p.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	if p.current == nil {
		w.Write([]byte(`{"playlist_id":null,"items":[],"revision":""}`))
		return
	}
	// Rewrite cached media items to local URLs; leave external URLs intact.
	out := *p.current
	items := make([]PlaylistItem, len(out.Items))
	for i, it := range out.Items {
		if _, ok := p.fileMap[it.ID]; ok {
			it.Source = fmt.Sprintf("/media/%d", it.ID)
		}
		items[i] = it
	}
	out.Items = items
	json.NewEncoder(w).Encode(out)
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
