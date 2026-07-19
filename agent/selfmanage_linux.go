//go:build linux

package main

import "syscall"

// detachAttr puts the reinstall helper in its own process group so a multi-minute
// install + reboot is never killed alongside the agent's command channel.
func detachAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}
