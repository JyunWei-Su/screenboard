package main

import (
	"fmt"
	"os/exec"
	"strings"
)

// Root-owned helper scripts installed by install.sh and granted to the kiosk
// user through the narrow, password-less sudoers rule. They let the always-on
// agent command channel repair the parts of the stack the agent cannot touch
// unprivileged — the cloudflared connector and the installer itself.
const (
	repairTunnelHelper = "/usr/local/bin/screenboard-repair-tunnel"
	reinstallHelper    = "/usr/local/bin/screenboard-reinstall"
	syncTimeHelper     = "/usr/local/bin/screenboard-sync-time"
	setHostnameHelper  = "/usr/local/bin/screenboard-set-hostname"
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
	cmd.SysProcAttr = detachAttr()
	return cmd.Start()
}

// SyncTime asks a root-owned helper to enable and restart the operating
// system's managed NTP client. The command has no caller-controlled arguments,
// so an admin command can never become arbitrary privileged shell execution.
func SyncTime() (string, error) {
	if _, err := exec.LookPath("sudo"); err != nil {
		return "", fmt.Errorf("sudo unavailable: %w", err)
	}
	out, err := exec.Command("sudo", "-n", syncTimeHelper).CombinedOutput()
	detail := strings.TrimSpace(string(out))
	if len(detail) > 500 {
		detail = detail[:500]
	}
	if err != nil {
		return "", fmt.Errorf("%v: %s", err, detail)
	}
	return detail, nil
}

// SetHostname delegates hostname changes to a root-owned helper. The argument
// is validated again here and passed as one argv value, never through a shell.
func SetHostname(hostname string) error {
	if _, err := exec.LookPath("sudo"); err != nil {
		return fmt.Errorf("sudo unavailable: %w", err)
	}
	if len(hostname) < 1 || len(hostname) > 63 {
		return fmt.Errorf("invalid hostname")
	}
	for i, r := range hostname {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || (r == '-' && i > 0 && i < len(hostname)-1)) {
			return fmt.Errorf("invalid hostname")
		}
	}
	out, err := exec.Command("sudo", "-n", setHostnameHelper, hostname).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}
