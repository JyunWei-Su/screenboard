//go:build linux

package main

import "syscall"

// diskUsage returns the used-space percentage of the filesystem holding path.
func diskUsage(path string) float64 {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0
	}
	total := float64(st.Blocks) * float64(st.Bsize)
	free := float64(st.Bavail) * float64(st.Bsize)
	if total == 0 {
		return 0
	}
	return (1 - free/total) * 100
}
