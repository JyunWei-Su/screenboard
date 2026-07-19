package main

import (
	"fmt"
	"log"
	"time"
)

// handleCommand executes a server command and returns the ack outcome. It is the
// single dispatch point for the WebSocket command channel.
func (a *Agent) handleCommand(cmd ServerCommand) (bool, string) {
	log.Printf("command: %s", cmd.Type)
	switch cmd.Type {
	case "reload":
		a.player.Reload()
		a.reportDeviceInfo()
		a.reportHealth()
		go a.notifyAfter("管理端要求的重新載入已完成", "success", time.Second)
	case "restart_player":
		a.player.Notify("正在重新啟動播放器…", "warning", true)
		a.player.RestartBrowser()
		go a.notifyAfter("播放器已重新啟動", "success", time.Second)
	case "switch_scene":
		a.syncTarget()
	case "take_screenshot":
		a.player.Notify("管理端要求擷取螢幕畫面…", "warning", true)
		if !a.captureAndPost("manual") {
			return false, "screenshot failed"
		}
		a.player.Notify("螢幕畫面已擷取並回傳管理端", "success", false)
	case "check_update":
		a.player.Notify("正在檢查並套用更新…", "warning", true)
		updated, err := MaybeUpdate(a.client, func(version string) {
			a.player.Notify("正在下載並套用 "+version+"…", "warning", true)
		})
		if err != nil {
			a.player.Notify("更新失敗："+err.Error(), "error", false)
			return false, err.Error()
		}
		if updated {
			// Let dispatch send the command ACK before the graceful restart.
			a.requestShutdownAfter(250 * time.Millisecond)
		} else {
			a.player.Notify("已是最新版本", "success", false)
		}
	case "sync_time":
		a.player.Notify("正在透過 NTP 對時…", "warning", true)
		detail, err := SyncTime()
		if err != nil {
			a.player.Notify("NTP 對時失敗："+err.Error(), "error", false)
			return false, err.Error()
		}
		a.player.Notify("NTP 對時已啟用", "success", false)
		return true, detail
	case "set_hostname":
		hostname, ok := cmd.Payload["hostname"].(string)
		if !ok {
			return false, "missing hostname"
		}
		a.player.Notify("正在修改裝置名稱…", "warning", true)
		if err := SetHostname(hostname); err != nil {
			a.player.Notify("修改裝置名稱失敗："+err.Error(), "error", false)
			return false, err.Error()
		}
		a.reportDeviceInfo()
		if reboot, _ := cmd.Payload["reboot"].(bool); reboot {
			a.player.Notify("裝置名稱已更新，正在重新開機…", "warning", true)
			time.Sleep(1500 * time.Millisecond)
			if err := Reboot(); err != nil {
				a.player.Notify("重新開機失敗："+err.Error(), "error", false)
				return false, err.Error()
			}
			return true, "hostname updated; rebooting"
		}
		a.player.Notify("裝置名稱已更新", "success", false)
		return true, "hostname updated"
	case "reboot":
		a.player.Notify("裝置即將重新啟動…", "warning", true)
		time.Sleep(1500 * time.Millisecond)
		if err := Reboot(); err != nil {
			a.player.Notify("重新啟動失敗："+err.Error(), "error", false)
			return false, err.Error()
		}
	case "shutdown":
		a.player.Notify("裝置即將關機…", "warning", true)
		time.Sleep(1500 * time.Millisecond)
		if err := Shutdown(); err != nil {
			a.player.Notify("關機失敗："+err.Error(), "error", false)
			return false, err.Error()
		}
	case "apply_display":
		a.player.Notify("正在套用顯示設定…", "warning", true)
		a.player.ApplyDisplay(displayFromPayload(cmd.Payload, a.cfg.Display))
		go a.notifyAfter("顯示設定已套用", "success", time.Second)
	case "apply_agent_settings":
		a.player.Notify("正在套用週期設定…", "warning", true)
		if err := a.applyAgentSettings(cmd.Payload); err != nil {
			a.player.Notify("套用週期設定失敗："+err.Error(), "error", false)
			return false, err.Error()
		}
		// Apply the new cadences in-process. The display and Chromium stay up.
		a.startManagedLoops()
		a.ws.SetHeartbeatInterval(time.Duration(a.cfg.HeartbeatEvery) * time.Second)
		go a.notifyAfter("週期設定已套用", "success", time.Second)
	case "repair_tunnel":
		a.player.Notify("正在修復 SSH 連線…", "warning", true)
		// Freshen the on-disk access token the helper reads, then reinstall the
		// cloudflared connector so SSH remote access recovers over this channel.
		_ = a.client.refresh()
		if err := RepairTunnel(); err != nil {
			a.player.Notify("修復 SSH 連線失敗："+err.Error(), "error", false)
			return false, err.Error()
		}
		a.player.Notify("SSH 連線已修復", "success", false)
	case "reinstall":
		a.player.Notify("正在重新安裝，裝置即將重新啟動…", "warning", true)
		time.Sleep(1500 * time.Millisecond)
		if err := Reinstall(); err != nil {
			a.player.Notify("重新安裝失敗："+err.Error(), "error", false)
			return false, err.Error()
		}
	default:
		return false, "unknown command"
	}
	return true, ""
}

func (a *Agent) notifyAfter(message, level string, delay time.Duration) {
	time.Sleep(delay)
	a.player.Notify(message, level, false)
}

func (a *Agent) applyAgentSettings(p map[string]interface{}) error {
	health, err := intervalFromPayload(p, "health_interval_sec", 10, 3600)
	if err != nil {
		return err
	}
	deviceInfo, err := intervalFromPayload(p, "device_info_interval_sec", 60, 86400)
	if err != nil {
		return err
	}
	playlist, err := intervalFromPayload(p, "playlist_poll_sec", 10, 3600)
	if err != nil {
		return err
	}
	heartbeat, err := intervalFromPayload(p, "heartbeat_interval_sec", 10, 60)
	if err != nil {
		return err
	}
	screenshot, err := intervalFromPayload(p, "screenshot_interval_sec", 0, 86400)
	if err != nil {
		return err
	}
	ota, err := intervalFromPayload(p, "ota_check_sec", 60, 86400)
	if err != nil {
		return err
	}
	a.cfg.HealthInterval = health
	a.cfg.DeviceInfoEvery = deviceInfo
	a.cfg.PlaylistPoll = playlist
	a.cfg.HeartbeatEvery = heartbeat
	a.cfg.ScreenshotEvery = screenshot
	a.cfg.OTAEvery = ota
	return a.cfg.Save()
}

func intervalFromPayload(p map[string]interface{}, key string, min, max int) (int, error) {
	v, ok := p[key].(float64)
	if !ok || v != float64(int(v)) || v < float64(min) || v > float64(max) {
		return 0, fmt.Errorf("invalid %s", key)
	}
	return int(v), nil
}

func displayFromPayload(p map[string]interface{}, cur Display) Display {
	d := cur
	if v, ok := p["kiosk"].(bool); ok {
		d.Kiosk = v
	}
	if v, ok := p["zoom"].(float64); ok {
		d.Zoom = v
	}
	if v, ok := p["rotate"].(float64); ok {
		d.Rotate = int(v)
	}
	if v, ok := p["screen"].(float64); ok {
		d.Screen = int(v)
	}
	return d
}
