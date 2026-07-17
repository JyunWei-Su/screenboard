# ScreenBoard

A centrally-managed digital-signage platform for Linux devices, built on Cloudflare.
Manage a fleet of kiosk screens: register devices, push playlists, control screens
remotely, monitor health, capture screenshots, and ship agent updates over the air.

> Architecture design & rationale: [docs/architecture.md](docs/architecture.md)
>
> Deployment checklist: [DEPLOY.md](DEPLOY.md)

## Stack

| Layer | Technology |
|---|---|
| API / backend | Cloudflare **Workers** (Hono) |
| Database | Cloudflare **D1** (SQLite) |
| Object storage | Cloudflare **R2** (media, screenshots, OTA binaries) |
| Realtime / presence | **Durable Objects** (one per device, WebSocket Hibernation) |
| Admin login | **Single TOTP** (RFC 6238), no passwords → session JWT |
| Admin console | **React + Vite + Tailwind** |
| Device agent | **Go** (single static binary) |
| Remote debug (standard) | **Cloudflare Tunnel + Access SSH** per device (optional) |

Health time-series are retained for **90 days** (`HEALTH_RETENTION_DAYS`) in D1 and
pruned by a daily cron.

## Repository layout

```
screenboard/
├─ apps/
│  ├─ api/       # Workers API + D1 migrations + Durable Object + cron handlers
│  ├─ admin/     # React admin console
│  └─ player/    # Standalone/preview web player (static)
├─ agent/        # Go device agent (kiosk player control, health, OTA, screenshots)
├─ packages/
│  └─ shared/    # Shared TypeScript protocol types
└─ docs/         # Architecture design
```

---

## 1. Provision Cloudflare resources

```bash
npm install

# From apps/api (wrangler reads apps/api/wrangler.jsonc):
cd apps/api
wrangler d1 create screenboard              # copy database_id into wrangler.jsonc
wrangler r2 bucket create screenboard
```

Edit `apps/api/wrangler.jsonc`:
- set `d1_databases[0].database_id` to the id printed above,
- set `vars.PUBLIC_API_URL` to your deployed Worker URL (used to build media/OTA/WS URLs).

### Optional: per-device Cloudflare Tunnel + browser SSH

To provision a remotely-managed Tunnel and an Access SSH application for every
device, configure these non-secret Worker variables:

```text
CF_ACCOUNT_ID=<Cloudflare account id>
CF_ZONE_ID=<zone id for the managed root domain>
CF_ACCESS_ALLOWED_EMAILS=ops@example.com,admin@example.com
```

The deploy script reads the zone name from `CF_ZONE_ID`. Each device receives
`ssh-<device-uuid>.<zone>`; this first-level hostname is covered by Cloudflare
Universal SSL. Access policies allow only the configured email addresses.
Configure an Identity Provider or email OTP in Cloudflare Zero Trust before
enrolling a device.

#### Browser SSH provisioning

ScreenBoard creates a Cloudflare `ssh` Access application and its application-specific
short-lived certificate authority automatically. The installer trusts that CA in
`sshd` and creates unprivileged Linux users from `CF_ACCESS_ALLOWED_EMAILS` email
prefixes (for example, `ops@example.com` creates `ops`). A TLS protocol error on an old
`<device-uuid>.ssh.<zone>` hostname is instead a certificate-depth issue; use
**Reprovision SSH** to migrate it to `ssh-<device-uuid>.<zone>`.

Browser SSH users are not granted `sudo`. Add a separate, narrowly-scoped sudoers rule
only when an operator needs administrative access.

## 2. Secrets

```bash
cd apps/api
wrangler secret put JWT_SECRET          # random string (admin session signing)
wrangler secret put DEVICE_JWT_SECRET   # random string (device token signing)
wrangler secret put BOOTSTRAP_TOKEN     # random string, used once to create first admin
wrangler secret put TOTP_ENC_KEY        # base64 of 32 random bytes: openssl rand -base64 32
wrangler secret put CF_API_TOKEN         # optional: Tunnel, DNS, and Access provisioning
```

`TOTP_ENC_KEY` encrypts TOTP secrets at rest (AES-GCM). If omitted, secrets are stored
in plaintext (dev only).

For remote access, make `CF_API_TOKEN` least-privilege: permissions to manage
Cloudflare Tunnels, edit DNS in the SSH zone, and create Access applications and
policies. Never put it in `wrangler.jsonc` or device configuration.

## 3. Migrate & deploy the API

```bash
cd apps/api
wrangler d1 migrations apply screenboard --remote
wrangler deploy
```

## 4. Create the first admin (TOTP)

From the repository root, run:

```bash
bash scripts/bootstrap-admin.sh admin
```

The script reads `API_DOMAIN` and `BOOTSTRAP_TOKEN` from `.env`, then prints the
one-time TOTP provisioning secret and URI. Add it to an authenticator app immediately.

Equivalent manual request:

```bash
curl -X POST "$PUBLIC_API_URL/api/auth/bootstrap" \
  -H "x-bootstrap-token: $BOOTSTRAP_TOKEN" \
  -H "content-type: application/json" \
  -d '{"name":"admin"}'
```

The response includes `otpauth_uri` — add it to an authenticator app (or scan the
secret). Bootstrap only works while there are zero users. Additional users are created
from the admin console (Users page), which shows each new user's TOTP once.

## 5. Admin console

```bash
cd apps/admin
cp .env.example .env       # set VITE_API_URL to your Worker URL
npm run dev                # http://localhost:5173
# or deploy:
npm run build
wrangler pages deploy dist --project-name screenboard-admin
```

Sign in with your name + 6-digit authenticator code.

## 6. Enroll & run a device

**Recommended OS:** Debian 12 (amd64) or Raspberry Pi OS Bookworm (arm64), X11 session,
`apt` Chromium (not snap).

### Option A — one-line install (recommended)

Prerequisite (once): build the agent and upload it via the admin **OTA** page so the
API can serve it (`channel=stable`):

```bash
bash scripts/build-agent.sh 0.1.0 amd64
# then admin console → OTA → upload dist/screenboard-agent-linux-amd64-v0.1.0
# (the OTA page reads the version from the filename automatically)
```

Create an enrollment token in the admin console (**Devices → + Enrollment token**), then
on the device:

```bash
curl -fsSL https://YOUR-API/install.sh | sudo bash -s -- <ENROLLMENT_TOKEN>
```

New enrollment tokens are 22-character base64url values with 128 bits of randomness.
The installer automatically uses the same API hostname it was downloaded from; no
`--server` option is normally needed.

The script (served from `apps/api/src/install.sh`) installs X11 + Chromium + the agent,
OpenSSH, and `cloudflared`,
downloads the newest package in the selected channel from `/install/agent?arch=…&channel=…`, writes `/etc/screenboard/agent.json`,
sets up tty1 autologin → `startx` → a kiosk restart loop (which also handles OTA restarts),
grants the kiosk Agent permission only for reboot/power-off, and reboots.

Automatic screenshots are disabled by default. You can still request a screenshot
manually from a device detail page; set `screenshot_interval_sec` to a positive
number of seconds in the Agent configuration to enable periodic screenshots.
Flags: `--user <name>` (default `kiosk`), `--channel <stable|beta>`, `--server <url>`.

On the kiosk display, press `Ctrl+Shift+F12` for local diagnostics (device ID,
Agent version, Tunnel state, network IP, display resolution, and uptime). It never
shows enrollment or access tokens. `Ctrl+Alt+F1` and `Ctrl+Alt+F2` remain available
for Linux virtual-terminal recovery.

> The `/install/agent` endpoint serves a single binary per channel, so the one-liner
> assumes a **single-architecture fleet**. For mixed amd64/arm64, install manually (Option B).

When Cloudflare remote-access variables are configured, the installer enrolls the
device, retrieves a one-time Tunnel token through device-authenticated HTTPS, and
starts `cloudflared`. SSH disables root and password logins; access is through
Cloudflare Access, without exposing port 22 or requiring a public device IP.

### Option B — manual install (systemd)

```bash
sudo apt install --no-install-recommends xserver-xorg xinit openbox chromium scrot x11-xserver-utils
sudo install -Dm755 dist/screenboard-agent-linux-amd64-v0.1.0 /usr/local/bin/screenboard-agent
sudo mkdir -p /etc/screenboard
sudo cp agent/config.example.json /etc/screenboard/agent.json
# edit agent.json: set server_url and paste enrollment_token
sudo cp agent/systemd/screenboard-agent.service /etc/systemd/system/
sudo systemctl enable --now screenboard-agent
```

On first boot the agent auto-registers (consuming the enrollment token), stores its
device credentials, opens the WebSocket command channel, launches the Chromium kiosk,
and starts reporting health.

## 7. OTA updates

Build a new agent version, then in the admin console → **OTA** upload the binary
(channel + version) and create a rollout (**all** / **group** / **canary %**).
Agents verify the SHA-256 checksum, self-replace, and restart via systemd.

---

## Local development

```bash
# API (local D1 + DO emulated by wrangler)
cd apps/api
wrangler d1 migrations apply screenboard --local
wrangler dev                       # http://localhost:8787
# trigger cron jobs locally:
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"

# Admin
cd apps/admin
echo "VITE_API_URL=http://localhost:8787" > .env
npm run dev
```

For local bootstrap, set the secrets in `apps/api/.dev.vars` (same keys as production).

---

## The 12 feature areas → where they live

| Area | Implementation |
|---|---|
| 1. Device registration & info | `POST /api/enroll`, `devices` table, first-boot in `agent/run.go` |
| 2. Grouping (Site/Building/…) | `groups` tree, `apps/admin/.../Groups.tsx` |
| 3. Playlists & scheduling | `playlists`/`playlist_items`/`schedules`, `lib/resolve.ts`, PlaylistEditor/Schedules |
| 4. Screen control (kiosk/zoom/rotate) | `agent/player.go`, commands via `POST /api/devices/:uuid/commands` |
| 5. Health & online status | `POST /api/agent/health`, DO presence + alarm, cron sweep, Dashboard |
| 6. Screenshots (auto + on demand) | `agent` capture + `/api/agent/screenshot`, black-screen detection, DeviceDetail |
| 7. OTA (stable/beta, canary) | `ota_packages`/`ota_deployments`, `agent/ota.go`, Ota page |
| 8. CMS (media, versions, tags) | `media*` tables, `routes/media.ts`, Media page |
| 9. Users & RBAC | `users` + TOTP, `requireRole`, Users page (admin/operator/viewer) |
| 10. Dashboard & stats | `routes/dashboard.ts`, Dashboard page |
| 11. Cloudflare integration | Workers/D1/R2/DO; Tunnel for optional remote debug |

## Status & caveats

- **Fully wired end-to-end**: enrollment, WebSocket command dispatch, health + presence,
  playlist resolution/playback, media library, screenshots, OTA checksum
  verification, RBAC, dashboard, retention cron.
- **Schedules** evaluate in **UTC**. Add a per-device/tenant timezone if you need local time.
- **Multi-screen**: rotate/zoom/kiosk are applied; true per-monitor layout for multi-head
  setups is left as a follow-up (the `screen` index is stored but not fully driven).
- **Remote SSH** requires a Cloudflare Zero Trust organization, a Cloudflare-managed
  domain, and the optional Worker configuration above. Its Access identity is separate
  from the ScreenBoard TOTP login.
- No automated test suite is included yet.

## License

Internal project scaffold — add a license before distributing.
