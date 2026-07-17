package main

import (
	"fmt"
	"os/exec"
	"syscall"
)

// Root-owned helper scripts installed by install.sh and granted to the kiosk
// user through the narrow, password-less sudoers rule. They let the always-on
// agent command channel repair the parts of the stack the agent cannot touch
// unprivileged — the cloudflared connector and the installer itself.
const (
	repairTunnelHelper = "/usr/local/bin/screenboard-repair-tunnel"
	reinstallHelper    = "/usr/local/bin/screenboard-reinstall"
)

// RepairTunnel re-fetches this device's Cloudflare Tunnel token and reinstalls
// the cloudflared connector, restoring SSH remote access. It runs synchronously
// (seconds) so the command ack carries the real outcome.
func RepairTunnel() error {
	if _, err := exec.LookPath("sudo"); err != nil {
		return fmt.Errorf("sudo unavailable: %w", err)
	}
	out, err := exec.Command("sudo", "-n", repairTunnelHelper).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, out)
	}
	return nil
}

// Reinstall re-runs the full device installer as root (binary, helpers, sudoers,
// cloudflared, kiosk session) and reboots. It is detached and placed in its own
// process group so the multi-minute install + reboot never blocks or is killed
// with the command channel; the outcome is observable only after the reboot.
func Reinstall() error {
	if _, err := exec.LookPath("sudo"); err != nil {
		return fmt.Errorf("sudo unavailable: %w", err)
	}
	cmd := exec.Command("sudo", "-n", reinstallHelper)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return cmd.Start()
}
