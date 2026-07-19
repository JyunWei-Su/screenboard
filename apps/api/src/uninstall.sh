#!/usr/bin/env bash
#
# ScreenBoard device uninstall. Reverses install.sh: stops the kiosk autologin
# session, removes the agent and its helpers, tears down the Cloudflare Tunnel,
# reverts the SSH configuration, and deletes config and cached data. By default
# it then reboots into a plain console.
#
#   curl -fsSL https://YOUR-API/uninstall.sh | sudo bash
#
# By default this performs a FULL decommission: it also deletes the kiosk
# account and purges the cloudflared package. Use --keep-* to retain either.
#
# Optional flags:
#   --user <name>       kiosk account created by install.sh (default kiosk)
#   --keep-user         keep the kiosk account (default: delete it + home dir)
#   --keep-cloudflared  keep the cloudflared package/repo (default: purge it)
#   --no-reboot         leave the machine running (stops the live kiosk session)
#   --yes, -y           skip the interactive confirmation prompt
set -euo pipefail

KIOSK_USER="kiosk"
REMOVE_USER=1
PURGE_CLOUDFLARED=1
REBOOT=1
ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --user)              KIOSK_USER="$2"; shift 2;;
    --keep-user)         REMOVE_USER=0; shift;;
    --keep-cloudflared)  PURGE_CLOUDFLARED=0; shift;;
    --no-reboot)         REBOOT=0; shift;;
    --yes|-y)            ASSUME_YES=1; shift;;
    *) echo "unexpected arg: $1" >&2; exit 1;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "Please run as root (sudo)." >&2; exit 1; }

if [ "$ASSUME_YES" -ne 1 ]; then
  echo "This will PERMANENTLY remove ScreenBoard from this device:"
  echo "  • agent, kiosk session, Cloudflare Tunnel, SSH access CA, config and cached data"
  [ "$REMOVE_USER" -eq 1 ] && echo "  • the '$KIOSK_USER' account and its home directory"
  [ "$PURGE_CLOUDFLARED" -eq 1 ] && echo "  • the cloudflared package and its apt repository"
  [ "$REBOOT" -eq 1 ] && echo "Then the device reboots into a plain console."
  echo
  # curl | bash leaves stdin attached to the script, so read the confirmation
  # from the controlling terminal instead. With no terminal (e.g. CI), fail
  # closed and require -y rather than silently proceeding with a destructive op.
  if { true < /dev/tty; } 2>/dev/null; then
    printf "Type 'y' to continue, anything else to abort: " > /dev/tty
    IFS= read -r reply < /dev/tty || reply=""
    case "$reply" in
      y|Y|yes|YES) ;;
      *) echo "Aborted." >&2; exit 1;;
    esac
  else
    echo "No interactive terminal detected. Re-run with -y to confirm non-interactively." >&2
    exit 1
  fi
fi

echo "==> [1/8] Stopping kiosk autologin session"
# Drop the tty1 autologin override so the machine returns to a plain console.
rm -f /etc/systemd/system/getty@tty1.service.d/autologin.conf
rmdir /etc/systemd/system/getty@tty1.service.d 2>/dev/null || true
systemctl set-default multi-user.target >/dev/null 2>&1 || true

echo "==> [2/8] Stopping the agent"
# The kiosk .xinitrc relaunches the agent in a loop; it is torn down with the
# session at the end. Stop any running instance now so it releases resources.
pkill -TERM -x screenboard-agent 2>/dev/null || true

echo "==> [3/8] Removing Cloudflare Tunnel"
if command -v cloudflared >/dev/null 2>&1 && systemctl cat cloudflared.service >/dev/null 2>&1; then
  systemctl stop cloudflared 2>/dev/null || true
  cloudflared service uninstall 2>/dev/null || true
fi
rm -rf /etc/cloudflared
if [ "$PURGE_CLOUDFLARED" -eq 1 ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get purge -y cloudflared >/dev/null 2>&1 || true
  rm -f /etc/apt/sources.list.d/cloudflared.list /usr/share/keyrings/cloudflare-main.gpg
fi

echo "==> [4/8] Reverting SSH configuration"
rm -f /etc/ssh/sshd_config.d/50-screenboard.conf /etc/ssh/screenboard_access_ca.pub
systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || true

echo "==> [5/8] Removing agent binary and helpers"
rm -f \
  /usr/local/bin/screenboard-agent \
  /usr/local/bin/screenboard-apply-update \
  /usr/local/bin/screenboard-repair-tunnel \
  /usr/local/bin/screenboard-reinstall \
  /usr/local/bin/screenboard-sync-time \
  /usr/local/bin/screenboard-set-hostname \
  /usr/local/bin/screenboard-debug
rm -f /etc/sudoers.d/screenboard-agent

echo "==> [6/8] Removing config and cached data"
rm -rf /etc/screenboard /var/lib/screenboard

echo "==> [7/8] Cleaning kiosk session files"
HOME_DIR="$(getent passwd "$KIOSK_USER" 2>/dev/null | cut -d: -f6 || true)"
if [ -n "$HOME_DIR" ] && [ -d "$HOME_DIR" ]; then
  rm -f "$HOME_DIR/.xinitrc" "$HOME_DIR/.bash_profile" "$HOME_DIR/.xbindkeysrc"
fi
if [ "$REMOVE_USER" -eq 1 ] && id "$KIOSK_USER" >/dev/null 2>&1; then
  pkill -TERM -u "$KIOSK_USER" 2>/dev/null || true
  sleep 1
  userdel -r "$KIOSK_USER" 2>/dev/null || echo "    could not fully remove $KIOSK_USER (still logged in?)"
fi

echo "==> [8/8] Reloading systemd"
systemctl daemon-reload

echo
echo "ScreenBoard has been removed from this device."
echo "Remember to delete the device from the admin console as well."
if [ "$REBOOT" -eq 1 ]; then
  echo "Rebooting into console in 5s (Ctrl-C to cancel)…"
  sleep 5
  systemctl reboot
else
  # Without a reboot, stop the live X/kiosk session so the screen stops playing.
  pkill -TERM -u "$KIOSK_USER" 2>/dev/null || true
fi
