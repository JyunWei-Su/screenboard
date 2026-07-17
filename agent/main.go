// ScreenBoard device agent. Registers the device on first boot, reports health,
// keeps a WebSocket command channel open, drives the Chromium kiosk player, and
// applies OTA updates.
package main

import (
	"flag"
	"fmt"
	"log"
)

// AgentVersion is stamped into enrollment/health and compared during OTA checks.
// Override at build time: go build -ldflags "-X main.AgentVersion=1.2.3".
var AgentVersion = "0.1.0"

func main() {
	cfgPath := flag.String("config", "/etc/screenboard/agent.json", "path to agent config JSON")
	enrollOnly := flag.Bool("enroll-only", false, "enroll and persist device credentials, then exit")
	version := flag.Bool("version", false, "print the agent version and exit")
	flag.Parse()
	if *version {
		fmt.Println(AgentVersion)
		return
	}

	cfg, err := LoadConfig(*cfgPath)
	if err != nil {
		log.Fatalf("failed to load config %s: %v", *cfgPath, err)
	}
	log.Printf("ScreenBoard agent %s starting (server=%s)", AgentVersion, cfg.ServerURL)

	agent := NewAgent(cfg)
	if *enrollOnly {
		// A re-run installer needs a valid device token to retrieve the
		// one-time cloudflared Tunnel token. Refreshing here avoids using an
		// expired access token from a prior installation.
		if cfg.DeviceUUID != "" && cfg.RefreshToken != "" {
			if err := agent.client.refresh(); err != nil {
				log.Fatalf("credential refresh failed: %v", err)
			}
			return
		}
		if err := agent.ensureEnrolled(); err != nil {
			log.Fatalf("enrollment failed: %v", err)
		}
		return
	}
	agent.Run()
}
