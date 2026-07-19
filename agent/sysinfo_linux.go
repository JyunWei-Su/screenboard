//go:build linux

package main

import (
	"os"
	"strings"
	"syscall"
)

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

// physicalLinkUp reports whether the device has a live physical network link
// (carrier) on any real NIC. It reads sysfs directly so a pulled Ethernet cable
// or dropped Wi-Fi association is seen within one poll, rather than waiting for
// the command channel's heartbeat to time out.
//
// Only interfaces with a /sys/class/net/<if>/device node are considered, which
// excludes loopback and virtual interfaces (docker0, veth*, bridges, and the
// Cloudflare Tunnel tun) — so a running tunnel can never mask a dead uplink.
func physicalLinkUp() bool {
	entries, err := os.ReadDir("/sys/class/net")
	if err != nil {
		return true // can't tell; never force a false "offline"
	}
	sawPhysical := false
	for _, e := range entries {
		name := e.Name()
		if name == "lo" {
			continue
		}
		if _, err := os.Stat("/sys/class/net/" + name + "/device"); err != nil {
			continue // virtual interface
		}
		sawPhysical = true
		if ifaceCarrierUp(name) {
			return true
		}
	}
	// Physical NICs exist but none has a carrier -> link down. If none were found
	// at all (unusual), treat it as unknown and assume up rather than false-alarm.
	return !sawPhysical
}

func ifaceCarrierUp(name string) bool {
	base := "/sys/class/net/" + name + "/"
	// operstate is the best single summary. "up" is a live link; a definite
	// down/lowerlayerdown means no link. Some drivers report "unknown" even when
	// usable, so for those fall through to the raw carrier bit.
	if b, err := os.ReadFile(base + "operstate"); err == nil {
		switch strings.TrimSpace(string(b)) {
		case "up":
			return true
		case "unknown":
			// fall through to carrier
		default:
			return false
		}
	}
	// carrier reads EINVAL while the interface is administratively down, which the
	// error case correctly treats as "no link".
	if b, err := os.ReadFile(base + "carrier"); err == nil {
		return strings.TrimSpace(string(b)) == "1"
	}
	return false
}
