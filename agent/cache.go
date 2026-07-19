package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// MediaRef is a single cacheable media source referenced by a playback target.
type MediaRef struct {
	ID  int    // media / playlist-item id, used as the player's fileMap key
	URL string // absolute source URL to download
	Key string // stable cache filename (survives restarts), e.g. "scene_<rev>_<id>"
}

// CacheStats is a snapshot of media-cache usage for health reporting.
type CacheStats struct {
	UsedBytes   int64     `json:"used_bytes"`
	LimitBytes  int64     `json:"limit_bytes"`
	FileCount   int       `json:"file_count"`
	LastGCError string    `json:"last_gc_error,omitempty"`
	LastGCAt    time.Time `json:"last_gc_at,omitempty"`
}

// CacheManager owns the on-disk media cache. It downloads a new target's media
// to completion before the player switches to it, retains the current and the
// previous target's files, garbage-collects everything else, and enforces a byte
// cap by evicting the previous target's files (never the current one's) LRU-first.
type CacheManager struct {
	dir      string
	maxBytes int64
	download func(url, dest string) error

	mu          sync.Mutex
	curSet      map[string]bool // absolute paths the current target needs
	prevSet     map[string]bool // absolute paths the previous target needed
	lastGCError string
	lastGCAt    time.Time
}

// NewCacheManager builds a cache manager bound to the agent's cache dir + cap.
func NewCacheManager(cfg *Config, client *Client) *CacheManager {
	return &CacheManager{
		dir:      cfg.CacheDir,
		maxBytes: cfg.CacheMaxBytes,
		download: client.DownloadTo,
		curSet:   map[string]bool{},
		prevSet:  map[string]bool{},
	}
}

// Prepare downloads every ref into the cache and returns an id -> local path map.
// Each file is fetched to a temporary name and renamed on success, so a partial
// download is never presented. If ANY ref cannot be fully fetched it returns an
// error and the caller keeps serving its current content — a failed switch never
// corrupts what is on screen. Refs sharing an id are downloaded once.
func (cm *CacheManager) Prepare(refs []MediaRef) (map[int]string, error) {
	if err := os.MkdirAll(cm.dir, 0o755); err != nil {
		return nil, fmt.Errorf("cache dir: %w", err)
	}
	fileMap := make(map[int]string, len(refs))
	for _, ref := range refs {
		if _, done := fileMap[ref.ID]; done {
			continue
		}
		dest := filepath.Join(cm.dir, ref.Key)
		if fi, err := os.Stat(dest); err == nil && fi.Size() > 0 {
			fileMap[ref.ID] = dest
			continue
		}
		part := dest + ".part"
		if err := cm.download(ref.URL, part); err != nil {
			os.Remove(part)
			return nil, fmt.Errorf("download media %d: %w", ref.ID, err)
		}
		if err := os.Rename(part, dest); err != nil {
			os.Remove(part)
			return nil, fmt.Errorf("commit media %d: %w", ref.ID, err)
		}
		fileMap[ref.ID] = dest
	}
	return fileMap, nil
}

// Commit records the file set the player now actively serves. It promotes the
// prior current set to "previous", garbage-collects any file in the cache dir
// outside current ∪ previous (including stale .part temporaries), and enforces
// the byte cap by evicting previous-only files oldest-first. It returns fresh
// usage stats for health.
func (cm *CacheManager) Commit(paths []string) CacheStats {
	cm.mu.Lock()
	defer cm.mu.Unlock()

	cm.prevSet = cm.curSet
	cur := make(map[string]bool, len(paths))
	for _, p := range paths {
		if abs, err := filepath.Abs(p); err == nil {
			cur[abs] = true
		} else {
			cur[p] = true
		}
	}
	cm.curSet = cur

	cm.lastGCError = ""
	cm.lastGCAt = time.Now()
	cm.gcLocked()
	cm.enforceCapLocked()
	return cm.statsLocked()
}

// gcLocked removes every regular file in the cache dir that neither the current
// nor the previous target needs. Caller holds cm.mu.
func (cm *CacheManager) gcLocked() {
	entries, err := os.ReadDir(cm.dir)
	if err != nil {
		cm.lastGCError = err.Error()
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		full := filepath.Join(cm.dir, e.Name())
		abs, err := filepath.Abs(full)
		if err != nil {
			abs = full
		}
		if cm.curSet[abs] || cm.prevSet[abs] {
			continue
		}
		if err := os.Remove(full); err != nil {
			cm.lastGCError = err.Error()
		}
	}
}

// enforceCapLocked evicts previous-only files, oldest-first, until usage is
// within the cap. Files the current target needs are never evicted; if the
// current set alone exceeds the cap that is recorded, not force-deleted.
func (cm *CacheManager) enforceCapLocked() {
	if cm.maxBytes <= 0 {
		return
	}
	entries, err := os.ReadDir(cm.dir)
	if err != nil {
		cm.lastGCError = err.Error()
		return
	}
	type cached struct {
		path      string
		size      int64
		mod       time.Time
		evictable bool
	}
	var files []cached
	var total int64
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		full := filepath.Join(cm.dir, e.Name())
		abs, aerr := filepath.Abs(full)
		if aerr != nil {
			abs = full
		}
		total += info.Size()
		files = append(files, cached{
			path:      full,
			size:      info.Size(),
			mod:       info.ModTime(),
			evictable: !cm.curSet[abs], // current content is never evicted
		})
	}
	if total <= cm.maxBytes {
		return
	}
	// Evict oldest evictable files first.
	sort.Slice(files, func(i, j int) bool { return files[i].mod.Before(files[j].mod) })
	for _, f := range files {
		if total <= cm.maxBytes {
			break
		}
		if !f.evictable {
			continue
		}
		if err := os.Remove(f.path); err != nil {
			cm.lastGCError = err.Error()
			continue
		}
		total -= f.size
		abs, aerr := filepath.Abs(f.path)
		if aerr != nil {
			abs = f.path
		}
		delete(cm.prevSet, abs)
	}
	if total > cm.maxBytes {
		cm.lastGCError = fmt.Sprintf("current content %d bytes exceeds cache cap %d bytes", total, cm.maxBytes)
		log.Printf("cache: %s", cm.lastGCError)
	}
}

// Stats returns current usage without changing retention.
func (cm *CacheManager) Stats() CacheStats {
	cm.mu.Lock()
	defer cm.mu.Unlock()
	return cm.statsLocked()
}

func (cm *CacheManager) statsLocked() CacheStats {
	var used int64
	var count int
	if entries, err := os.ReadDir(cm.dir); err == nil {
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			if info, err := e.Info(); err == nil {
				used += info.Size()
				count++
			}
		}
	}
	return CacheStats{
		UsedBytes:   used,
		LimitBytes:  cm.maxBytes,
		FileCount:   count,
		LastGCError: cm.lastGCError,
		LastGCAt:    cm.lastGCAt,
	}
}
