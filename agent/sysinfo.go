package main

import (
	"bufio"
	"net"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// CollectDeviceInfo gathers static-ish device attributes for enrollment/health.
func CollectDeviceInfo() DeviceInfo {
	host, _ := os.Hostname()
	return DeviceInfo{
		Hostname:        host,
		Serial:          readSerial(),
		OSVersion:       readOSVersion(),
		AgentVersion:    AgentVersion,
		IP:              outboundIP(),
		MAC:             primaryMAC(),
		Resolution:      screenResolution(),
		ProtocolVersion: ProtocolVersion,
		Capabilities:    AgentCapabilities,
	}
}

func readSerial() string {
	for _, p := range []string{"/sys/class/dmi/id/product_serial", "/etc/machine-id"} {
		if b, err := os.ReadFile(p); err == nil {
			return strings.TrimSpace(string(b))
		}
	}
	return ""
}

func readOSVersion() string {
	f, err := os.Open("/etc/os-release")
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if strings.HasPrefix(sc.Text(), "PRETTY_NAME=") {
			return strings.Trim(strings.TrimPrefix(sc.Text(), "PRETTY_NAME="), `"`)
		}
	}
	return ""
}

func outboundIP() string {
	conn, err := net.Dial("udp", "1.1.1.1:53")
	if err != nil {
		return ""
	}
	defer conn.Close()
	return conn.LocalAddr().(*net.UDPAddr).IP.String()
}

func primaryMAC() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, i := range ifaces {
		if i.Flags&net.FlagLoopback == 0 && i.HardwareAddr != nil && len(i.HardwareAddr) > 0 {
			return i.HardwareAddr.String()
		}
	}
	return ""
}

var (
	activeModeResRe    = regexp.MustCompile(`(\d+x\d+)\s*\*`)
	currentScreenResRe = regexp.MustCompile(`current\s+(\d+)\s+x\s+(\d+)`)
)

func screenResolution() string {
	out, err := exec.Command("xrandr").Output()
	if err != nil {
		return ""
	}
	text := string(out)
	if m := activeModeResRe.FindStringSubmatch(text); m != nil {
		return m[1]
	}
	// Some X11 drivers omit the '*' active-mode marker but always report the
	// current screen dimensions in xrandr's first line.
	if m := currentScreenResRe.FindStringSubmatch(text); m != nil {
		return m[1] + "x" + m[2]
	}
	return ""
}

// CollectHealth samples CPU/memory/disk/uptime, a connectivity probe, and the
// SoC temperature when readable. Runtime status (browser, cache, last sync) is
// layered on by the agent, which owns that state.
func CollectHealth(serverHost string) HealthSample {
	return HealthSample{
		CPU:         cpuUsage(),
		Memory:      memUsage(),
		Disk:        diskUsage("/"),
		NetOK:       netOK(serverHost),
		Uptime:      uptimeSeconds(),
		Temperature: cpuTemperature(),
	}
}

// cpuTemperature reads the SoC temperature in Celsius from the standard thermal
// zone Raspberry Pi and many ARM boards expose. It returns nil on hardware that
// has no readable zone, so health omits the field rather than reporting a
// misleading zero.
func cpuTemperature() *float64 {
	for _, path := range []string{
		"/sys/class/thermal/thermal_zone0/temp",
		"/sys/class/hwmon/hwmon0/temp1_input",
	} {
		b, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		milli, err := strconv.ParseFloat(strings.TrimSpace(string(b)), 64)
		if err != nil || milli <= 0 {
			continue
		}
		c := milli / 1000
		return &c
	}
	return nil
}

func readCPUTimes() (idle, total uint64) {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0, 0
	}
	line := strings.SplitN(string(b), "\n", 2)[0]
	fields := strings.Fields(line)
	if len(fields) < 5 || fields[0] != "cpu" {
		return 0, 0
	}
	for i, f := range fields[1:] {
		v, _ := strconv.ParseUint(f, 10, 64)
		total += v
		if i == 3 || i == 4 { // idle + iowait
			idle += v
		}
	}
	return idle, total
}

func cpuUsage() float64 {
	i1, t1 := readCPUTimes()
	time.Sleep(200 * time.Millisecond)
	i2, t2 := readCPUTimes()
	dt := float64(t2 - t1)
	if dt <= 0 {
		return 0
	}
	return (1 - float64(i2-i1)/dt) * 100
}

func memUsage() float64 {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer f.Close()
	var total, avail float64
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 {
			continue
		}
		v, _ := strconv.ParseFloat(fields[1], 64)
		switch fields[0] {
		case "MemTotal:":
			total = v
		case "MemAvailable:":
			avail = v
		}
	}
	if total == 0 {
		return 0
	}
	return (1 - avail/total) * 100
}

func uptimeSeconds() int64 {
	b, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(b))
	if len(fields) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(fields[0], 64)
	return int64(v)
}

func netOK(host string) bool {
	if host == "" {
		host = "1.1.1.1:53"
	}
	conn, err := net.DialTimeout("tcp", host, 5*time.Second)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// CaptureScreenshot grabs the current screen via whichever tool is installed.
func CaptureScreenshot() ([]byte, error) {
	tmp, err := os.CreateTemp("", "sb-shot-*.png")
	if err != nil {
		return nil, err
	}
	path := tmp.Name()
	tmp.Close()
	defer os.Remove(path)

	candidates := [][]string{
		{"scrot", "-o", path},
		{"grim", path},
		{"import", "-window", "root", path},
	}
	var lastErr error
	for _, c := range candidates {
		if _, err := exec.LookPath(c[0]); err != nil {
			continue
		}
		cmd := exec.Command(c[0], c[1:]...)
		cmd.Env = append(os.Environ(), "DISPLAY=:0")
		if err := cmd.Run(); err == nil {
			return os.ReadFile(path)
		} else {
			lastErr = err
		}
	}
	if lastErr == nil {
		lastErr = errNoScreenshotTool
	}
	return nil, lastErr
}

var errNoScreenshotTool = &simpleError{"no screenshot tool found (install scrot or grim)"}

type simpleError struct{ s string }

func (e *simpleError) Error() string { return e.s }

// Reboot / Shutdown use the narrowly-scoped sudo permission installed by the
// device bootstrap. `-n` guarantees a remote command never hangs on a prompt.
func Reboot() error   { return powerAction("reboot") }
func Shutdown() error { return powerAction("poweroff") }

func powerAction(action string) error {
	output, err := exec.Command("sudo", "-n", "/usr/bin/systemctl", action).CombinedOutput()
	if err == nil {
		return nil
	}
	if detail := strings.TrimSpace(string(output)); detail != "" {
		return &simpleError{detail}
	}
	return err
}
