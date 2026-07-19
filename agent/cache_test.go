package main

import (
	"os"
	"path/filepath"
	"testing"
)

func writeCacheFile(t *testing.T, dir, name string, size int) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, make([]byte, size), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestCacheCommitRetainsCurrentAndPreviousTarget(t *testing.T) {
	dir := t.TempDir()
	cm := &CacheManager{dir: dir, curSet: map[string]bool{}, prevSet: map[string]bool{}}
	a := writeCacheFile(t, dir, "a", 1)
	cm.Commit([]string{a})
	b := writeCacheFile(t, dir, "b", 1)
	cm.Commit([]string{b})
	if _, err := os.Stat(a); err != nil {
		t.Fatalf("previous target was removed: %v", err)
	}
	c := writeCacheFile(t, dir, "c", 1)
	cm.Commit([]string{c})
	if _, err := os.Stat(a); !os.IsNotExist(err) {
		t.Fatalf("target older than previous should be collected, stat err = %v", err)
	}
	if _, err := os.Stat(b); err != nil {
		t.Fatalf("previous target was removed: %v", err)
	}
	if _, err := os.Stat(c); err != nil {
		t.Fatalf("current target was removed: %v", err)
	}
}

func TestCacheCapEvictsPreviousBeforeCurrent(t *testing.T) {
	dir := t.TempDir()
	cm := &CacheManager{dir: dir, maxBytes: 10, curSet: map[string]bool{}, prevSet: map[string]bool{}}
	a := writeCacheFile(t, dir, "a", 8)
	cm.Commit([]string{a})
	b := writeCacheFile(t, dir, "b", 8)
	stats := cm.Commit([]string{b})
	if _, err := os.Stat(a); !os.IsNotExist(err) {
		t.Fatalf("previous target should be evicted first, stat err = %v", err)
	}
	if _, err := os.Stat(b); err != nil {
		t.Fatalf("current target must never be evicted: %v", err)
	}
	if stats.UsedBytes != 8 {
		t.Fatalf("cache usage = %d, want 8", stats.UsedBytes)
	}
}
