#!/usr/bin/env bash
#
# ScreenBoard device bootstrap (Debian 12 / Raspberry Pi OS, amd64 or arm64).
# Installs X11 + Chromium + the agent + SSH + Cloudflare Tunnel, sets up
# autologin kiosk, and reboots.
#
#   curl -fsSL https://YOUR-API/install.sh | sudo bash -s -- <ENROLLMENT_TOKEN>
#
# Optional flags: --user <name> (default kiosk) --channel <stable|beta> --server <url>
set -euo pipefail

SERVER="__SERVER__"        # automatically injected from the download URL
TOKEN=""
KIOSK_USER="kiosk"
CHANNEL="stable"

while [ $# -gt 0 ]; do
  case "$1" in
    --server)  SERVER="$2"; shift 2;;
    --token)   TOKEN="$2"; shift 2;;
    --user)    KIOSK_USER="$2"; shift 2;;
    --channel) CHANNEL="$2"; shift 2;;
    -*) echo "unknown flag: $1" >&2; exit 1;;
    *)  if [ -z "$TOKEN" ]; then TOKEN="$1"; shift; else echo "unexpected arg: $1" >&2; exit 1; fi;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "Please run as root (sudo)." >&2; exit 1; }
if [ "$SERVER" = "__SERVER__" ]; then SERVER="${SB_SERVER:-}"; fi
[ -n "$SERVER" ] || { echo "Server URL required (--server <url>)." >&2; exit 1; }
# Re-installs keep the enrolled config, so they do not require a new token.
if [ -z "$TOKEN" ] && [ ! -f /etc/screenboard/agent.json ]; then
  echo "Enrollment token required for a new device: ... | sudo bash -s -- <TOKEN>" >&2
  exit 1
fi
SERVER="${SERVER%/}"

case "$(uname -m)" in
  x86_64)          ARCH=amd64;;
  aarch64|arm64)   ARCH=arm64;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1;;
esac
case "$CHANNEL" in
  stable|beta) ;;
  *) echo "Unsupported channel: $CHANNEL (use stable or beta)" >&2; exit 1;;
esac

echo "==> [1/8] Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  xserver-xorg xinit openbox chromium scrot x11-xserver-utils x11-utils xbindkeys \
  ca-certificates curl unclutter dbus-x11 fonts-liberation openssh-server sudo
CHROMIUM_BIN="$(command -v chromium || command -v chromium-browser || echo chromium)"

# cloudflared is supplied by Cloudflare's signed package repository.
install -d -m 755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  >/etc/apt/sources.list.d/cloudflared.list
apt-get update -y
apt-get install -y cloudflared

# SSH is reachable only through cloudflared. Keep a physical console available
# for recovery; no password or root logins are exposed.
install -d -m 755 /etc/ssh/sshd_config.d
cat >/etc/ssh/sshd_config.d/50-screenboard.conf <<'SSH'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
SSH
systemctl enable ssh
systemctl restart ssh

echo "==> [2/8] Creating kiosk user: $KIOSK_USER"
id "$KIOSK_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$KIOSK_USER"
usermod -aG video,render,input,audio,tty "$KIOSK_USER" 2>/dev/null || true

echo "==> [3/8] Downloading agent ($ARCH)"
install -d /usr/local/bin
# Download beside the target, then atomically replace it. This avoids curl(23)
# when a previous kiosk session is still executing the old Agent binary.
AGENT_TMP="$(mktemp /usr/local/bin/.screenboard-agent.XXXXXX)"
trap 'rm -f "$AGENT_TMP"' EXIT
curl -fsSL "$SERVER/install/agent?arch=$ARCH&channel=$CHANNEL" -o "$AGENT_TMP"
chmod 755 "$AGENT_TMP"
mv -f "$AGENT_TMP" /usr/local/bin/screenboard-agent
trap - EXIT

echo "==> [4/8] Writing config"
install -d -m 755 /etc/screenboard
install -d -o "$KIOSK_USER" -g "$KIOSK_USER" -m 755 /var/lib/screenboard/cache
if [ ! -f /etc/screenboard/agent.json ]; then
  cat >/etc/screenboard/agent.json <<JSON
{
  "server_url": "$SERVER",
  "enrollment_token": "$TOKEN",
  "channel": "$CHANNEL",
  "player_port": 8888,
  "screenshot_interval_sec": 0,
  "chromium_bin": "$CHROMIUM_BIN",
  "cache_dir": "/var/lib/screenboard/cache",
  "display": { "kiosk": true, "zoom": 1.0, "rotate": 0, "screen": 0 }
}
JSON
  chmod 600 /etc/screenboard/agent.json
else
  echo "    /etc/screenboard/agent.json exists — leaving as-is"
fi

echo "==> [5/8] Enrolling device and starting Cloudflare Tunnel"
# Run enrollment once as root so the agent can persist credentials. The kiosk
# process later runs unprivileged as $KIOSK_USER.
/usr/local/bin/screenboard-agent --config /etc/screenboard/agent.json --enroll-only
ACCESS_TOKEN="$(sed -n 's/.*\"access_token\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p' /etc/screenboard/agent.json | head -n1)"
if [ -n "$ACCESS_TOKEN" ]; then
  REMOTE_ACCESS="$(curl -fsSL -H "Authorization: Bearer $ACCESS_TOKEN" "$SERVER/api/agent/remote-access" || true)"
  TUNNEL_TOKEN="$(printf '%s' "$REMOTE_ACCESS" | sed -n 's/.*\"tunnel_token\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p')"
  if [ -n "$TUNNEL_TOKEN" ]; then
    install -d -m 700 /etc/cloudflared
    # A host can have only one cloudflared system service. Re-install it so a
    # re-run uses the current device's Tunnel token instead of failing with
    # "cloudflared service is already installed".
    if systemctl cat cloudflared.service >/dev/null 2>&1; then
      echo "    Replacing existing Cloudflare Tunnel service"
      systemctl stop cloudflared || true
      cloudflared service uninstall
    fi
    cloudflared service install "$TUNNEL_TOKEN"
    systemctl enable --now cloudflared
    echo "    Cloudflare Tunnel installed"
  else
    REMOTE_REASON="$(printf '%s' "$REMOTE_ACCESS" | sed -n 's/.*"reason"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    case "$REMOTE_REASON" in
      not_provisioned)
        echo "    SSH remote access has not been provisioned for this device; skipping Tunnel"
        ;;
      not_configured)
        echo "    Cloudflare remote access is not configured on the server; skipping Tunnel"
        ;;
      *)
        echo "    Could not retrieve the Cloudflare Tunnel token; skipping Tunnel"
        ;;
    esac
  fi
fi
chown "$KIOSK_USER:$KIOSK_USER" /etc/screenboard/agent.json

echo "==> [6/8] Console autologin on tty1"
install -d /etc/systemd/system/getty@tty1.service.d
cat >/etc/systemd/system/getty@tty1.service.d/autologin.conf <<CONF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin $KIOSK_USER --noclear %I \$TERM
CONF

echo "==> [7/8] Start X on login + kiosk restart loop"
HOME_DIR="$(getent passwd "$KIOSK_USER" | cut -d: -f6)"
cat >/usr/local/bin/screenboard-debug <<'DEBUG'
#!/bin/sh
# Local-only diagnostics for the kiosk display. Never print credentials.
set -u
CONFIG=/etc/screenboard/agent.json
agent_version="$(/usr/local/bin/screenboard-agent --version 2>/dev/null || echo unknown)"
device_id="$(sed -n 's/.*"device_uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONFIG" 2>/dev/null | head -n1)"
resolution="$(xrandr --current 2>/dev/null | sed -n 's/.*current \([0-9][0-9]* x [0-9][0-9]*\).*/\1/p' | head -n1)"
ip_address="$(hostname -I 2>/dev/null | awk '{print $1}')"
tunnel="$(systemctl is-active cloudflared 2>/dev/null || true)"
[ -n "$device_id" ] || device_id="not enrolled"
[ -n "$resolution" ] || resolution="unavailable"
[ -n "$ip_address" ] || ip_address="unavailable"
[ -n "$tunnel" ] || tunnel="not installed"

message="ScreenBoard local diagnostics

Device: $device_id
Agent: $agent_version
Tunnel: $tunnel
Network IP: $ip_address
Display: $resolution
Uptime: $(uptime -p 2>/dev/null || uptime)

Press Enter or Close to return to ScreenBoard."
exec xmessage -center -title "ScreenBoard Debug" -buttons "Close:0" -default Close "$message"
DEBUG
chmod 755 /usr/local/bin/screenboard-debug

cat >"$HOME_DIR/.xbindkeysrc" <<'XBINDKEYS'
"/usr/local/bin/screenboard-debug"
  Control+Shift + F12
XBINDKEYS
cat >"$HOME_DIR/.bash_profile" <<'PROF'
if [ -z "$DISPLAY" ] && [ "$XDG_VTNR" = "1" ]; then
  exec startx -- -nocursor
fi
PROF
cat >"$HOME_DIR/.xinitrc" <<'XINIT'
#!/bin/sh
xset s off; xset -dpms; xset s noblank
# Paint the X root black so the gap between killing and relaunching Chromium
# (reload / display change / OTA restart) never flashes the default grey/white.
xsetroot -solid black
unclutter -idle 0 &
openbox-session &
xbindkeys &
# Restart loop: OTA replaces the binary and exits(0); the new one relaunches here.
while true; do
  /usr/local/bin/screenboard-agent --config /etc/screenboard/agent.json
  sleep 2
done
XINIT
chmod +x "$HOME_DIR/.xinitrc"
chown "$KIOSK_USER:$KIOSK_USER" "$HOME_DIR/.bash_profile" "$HOME_DIR/.xinitrc" "$HOME_DIR/.xbindkeysrc"

# OTA self-update helper. The kiosk Agent runs unprivileged and its binary is
# root-owned in /usr/local/bin, so it cannot replace itself. It stages a
# checksum/signature-verified binary and calls this helper (via the sudoers rule
# below) to swap it in atomically as root. The destination is hardcoded; only
# the staged source path comes from the caller.
cat >/usr/local/bin/screenboard-apply-update <<'APPLY'
#!/bin/sh
set -eu
DEST=/usr/local/bin/screenboard-agent
SRC="${1:?usage: screenboard-apply-update <staged-binary>}"
[ -f "$SRC" ] || { echo "source not found: $SRC" >&2; exit 1; }
[ -s "$SRC" ] || { echo "source is empty: $SRC" >&2; exit 1; }
# Stage beside the destination so the final swap is atomic and never crosses
# filesystems, then replace the running binary.
TMP="$(mktemp "$(dirname "$DEST")/.screenboard-agent.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
cat "$SRC" >"$TMP"
chown root:root "$TMP"
chmod 0755 "$TMP"
mv -f "$TMP" "$DEST"
trap - EXIT
APPLY
chown root:root /usr/local/bin/screenboard-apply-update
chmod 755 /usr/local/bin/screenboard-apply-update

# Remote tunnel-repair helper. Re-fetches this device's Cloudflare Tunnel token
# and reinstalls the cloudflared connector, so SSH remote access can be restored
# entirely over the agent's command channel (no working SSH required).
cat >/usr/local/bin/screenboard-repair-tunnel <<'REPAIR'
#!/bin/sh
set -eu
CONFIG=/etc/screenboard/agent.json
SERVER="$(sed -n 's/.*"server_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONFIG" | head -n1)"
TOKEN="$(sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONFIG" | head -n1)"
[ -n "$SERVER" ] || { echo "server_url missing from config" >&2; exit 1; }
[ -n "$TOKEN" ] || { echo "access_token missing from config" >&2; exit 1; }
SERVER="${SERVER%/}"
RESP="$(curl -fsSL -H "Authorization: Bearer $TOKEN" "$SERVER/api/agent/remote-access" || true)"
TUNNEL_TOKEN="$(printf '%s' "$RESP" | sed -n 's/.*"tunnel_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
[ -n "$TUNNEL_TOKEN" ] || { echo "no tunnel token — provision SSH for this device first: $RESP" >&2; exit 1; }
install -d -m 700 /etc/cloudflared
if systemctl cat cloudflared.service >/dev/null 2>&1; then
  systemctl stop cloudflared || true
  cloudflared service uninstall || true
fi
cloudflared service install "$TUNNEL_TOKEN"
systemctl enable --now cloudflared
echo "cloudflared reinstalled and started"
REPAIR
chown root:root /usr/local/bin/screenboard-repair-tunnel
chmod 755 /usr/local/bin/screenboard-repair-tunnel

# Remote full-reinstall helper. Re-runs this installer as root (repairs binary,
# helpers, sudoers, cloudflared, kiosk session) and reboots. The persisted
# config means no enrollment token is needed.
cat >/usr/local/bin/screenboard-reinstall <<'REINSTALL'
#!/bin/sh
set -eu
CONFIG=/etc/screenboard/agent.json
SERVER="$(sed -n 's/.*"server_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONFIG" | head -n1)"
[ -n "$SERVER" ] || { echo "server_url missing from config" >&2; exit 1; }
SERVER="${SERVER%/}"
curl -fsSL "$SERVER/install.sh" | bash -s -- --server "$SERVER"
REINSTALL
chown root:root /usr/local/bin/screenboard-reinstall
chmod 755 /usr/local/bin/screenboard-reinstall

# Permit only the Agent's power operations and the self-management helpers. The
# non-interactive sudo call gives failed remote commands a useful error instead
# of an auth prompt.
install -d -m 750 /etc/sudoers.d
cat >/etc/sudoers.d/screenboard-agent <<SUDOERS
$KIOSK_USER ALL=(root) NOPASSWD: /usr/bin/systemctl reboot, /usr/bin/systemctl poweroff, /usr/local/bin/screenboard-apply-update, /usr/local/bin/screenboard-repair-tunnel, /usr/local/bin/screenboard-reinstall
SUDOERS
chmod 440 /etc/sudoers.d/screenboard-agent
visudo -cf /etc/sudoers.d/screenboard-agent

echo "==> [8/8] Enabling boot-to-console and rebooting"
systemctl set-default multi-user.target
systemctl daemon-reload
echo
echo "Setup complete. Rebooting into kiosk mode in 5s (Ctrl-C to cancel)…"
sleep 5
systemctl reboot
