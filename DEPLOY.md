# ScreenBoard deployment guide

This guide deploys ScreenBoard with a Cloudflare Worker API, Pages admin console,
per-device Cloudflare Tunnel, Cloudflare Access browser SSH, and Debian kiosk devices.

## Automated deployment

For a first deployment, copy `.env.example` to `.env`, fill in an API Token and the
required domains/secrets, then run `bash scripts/deploy.sh` from the repository root.
The script creates or finds D1, creates the R2 bucket and Queues, deploys the Worker
at `API_DOMAIN`, uploads Worker secrets, applies migrations, builds the admin console,
and deploys it to Pages, including the `ADMIN_DOMAIN` custom-domain attachment and
its proxied CNAME record.
`.env` is ignored by Git. The Zero Trust Identity Provider remains a dashboard step.

## Target domains

This example uses the following hostnames. Replace `example.com` with your domain.

| Purpose | Hostname |
| --- | --- |
| Worker API | `api.example.com` |
| Admin console | `screenboard.example.com` |
| Device SSH | `<device-uuid>.ssh.example.com` |

Add `example.com` to Cloudflare and change the authoritative nameservers at your
domain registrar to the Cloudflare nameservers. The SSH hostname records are created
automatically by ScreenBoard when a device is enrolled; do not create them manually.

## 1. Create Cloudflare resources

Install dependencies, then create the D1 database, R2 bucket, and Queues.

```bash
npm install
cd apps/api
wrangler d1 create screenboard
wrangler r2 bucket create screenboard
wrangler queues create screenboard-events
```

Copy the D1 `database_id` into `apps/api/wrangler.jsonc`.

Set the Worker variable `PUBLIC_API_URL` to the final public API URL:

```text
PUBLIC_API_URL=https://api.example.com
```

Bind `api.example.com` as a Worker custom domain in the Cloudflare Dashboard, or
add an equivalent custom-domain route to the Worker configuration.

## 2. Configure Cloudflare Zero Trust and remote SSH

Create a Cloudflare Zero Trust organization. Configure an Identity Provider such as
Google Workspace or Microsoft Entra ID; email one-time PIN is acceptable for an
initial deployment.

Set these non-secret Worker variables in the Worker Dashboard or your deployment
environment:

```text
CF_ACCOUNT_ID=<Cloudflare account ID>
CF_ZONE_ID=<Zone ID for example.com>
CF_ACCESS_ALLOWED_EMAILS=ops@example.com,admin@example.com
```

The deployment script reads the root domain name from `CF_ZONE_ID`. Each enrolled
device gets `ssh-<device-uuid>.<zone>`, a separately managed Tunnel, DNS record,
and Cloudflare Access browser-SSH app. This first-level hostname is covered by
Cloudflare Universal SSL.
The Access policy allows only the email addresses above.
ScreenBoard automatically creates each app as a browser-SSH Access application,
creates its short-lived certificate CA, and installs the CA on the device. The
email prefix is also used as the unprivileged Linux login name.

Create a least-privilege Cloudflare API token and store it as the `CF_API_TOKEN`
Worker secret. It must be able to:

- create and manage Cloudflare Tunnels;
- create and delete DNS records in the SSH zone;
- create and manage Cloudflare Access applications and policies.

The device installer installs `cloudflared` and uses a one-time Tunnel token. The
token is not persisted in ScreenBoard's D1 database.

After the Zero Trust organization itself has been created once in the Cloudflare
Dashboard, enable Email One-time PIN automatically with:

```bash
bash scripts/setup-zero-trust.sh
```

## 3. Set Worker secrets

From `apps/api`, set every secret interactively. Do not store values in source code
or `wrangler.jsonc`.

```bash
wrangler secret put JWT_SECRET
wrangler secret put DEVICE_JWT_SECRET
wrangler secret put BOOTSTRAP_TOKEN
wrangler secret put TOTP_ENC_KEY
wrangler secret put CF_API_TOKEN
```

`TOTP_ENC_KEY` is the base64 encoding of 32 random bytes. For example:

```bash
openssl rand -base64 32
```

## 4. Deploy the API

Apply all D1 migrations, including `0002_device_remote_access.sql`, then deploy.

```bash
cd apps/api
wrangler d1 migrations apply screenboard --remote
wrangler deploy
```

Verify the public health endpoint:

```bash
curl https://api.example.com/health
```

## 5. Create the first ScreenBoard administrator

Bootstrap works only when no users exist:

```bash
curl -X POST https://api.example.com/api/auth/bootstrap \
  -H "x-bootstrap-token: <BOOTSTRAP_TOKEN>" \
  -H "content-type: application/json" \
  -d '{"name":"admin"}'
```

Save the returned TOTP enrollment URI in an authenticator application.

## 6. Deploy the admin console

Create `apps/admin/.env` locally:

```text
VITE_API_URL=https://api.example.com
```

Then build and deploy the console:

```bash
cd apps/admin
npm run build
wrangler pages deploy dist --project-name screenboard-admin
```

`scripts/deploy.sh` automatically binds `ADMIN_DOMAIN` to the Pages project and, when
no record already exists, creates a proxied CNAME to `<PAGES_PROJECT_NAME>.pages.dev`.
It deliberately does not overwrite an existing DNS record.

## 7. Prepare the initial device agent package

Build the agent and upload the matching architecture binary through the Admin
console's **OTA** page before installing a device.

```bash
# x86_64 Debian: amd64；aarch64 / arm64 Debian: arm64
bash scripts/build-agent.sh 0.1.0 amd64
```

The current `/install/agent` endpoint serves one binary per channel. For a mixed
amd64 and arm64 fleet, use the manual installation path until architecture-specific
package selection is added.

## 8. Install a Debian device

Install Debian 12 without a full desktop environment. Keep **SSH server** and
**standard system utilities** selected.

In ScreenBoard, create an enrollment token. On the device run:

```bash
curl -fsSL https://api.example.com/install.sh | sudo bash -s -- <ENROLLMENT_TOKEN>
```

The installer automatically uses the API hostname it was downloaded from. New
enrollment tokens are 22-character base64url values with 128 bits of randomness.

The script installs X11, Openbox, Chromium, the ScreenBoard agent, OpenSSH, and
`cloudflared`. It disables SSH root and password login, enrolls the device, retrieves
the device-specific Tunnel token, starts `cloudflared`, and reboots into kiosk mode.

The device must allow outbound HTTPS and Cloudflare Tunnel connectivity. It does not
need a public IP address or an inbound port-22 firewall rule.

## 9. Verify remote access

After the device comes online:

1. Open **Devices** in the ScreenBoard console.
2. Open the device detail page.
3. Confirm the Tunnel status is `healthy`.
4. Select **Open SSH terminal**.
5. Complete Cloudflare Access authentication and open the browser terminal.

If the device was enrolled before Tunnel variables were configured, use the
**Provision SSH** button on its device detail page. Re-run the installer (or install
the returned Tunnel token as the `cloudflared` service) to connect the Tunnel on the
device.

## Operational notes

- ScreenBoard TOTP and Cloudflare Access authentication are separate systems.
- Deleting a device in ScreenBoard also attempts to delete its Cloudflare Tunnel,
  DNS record, and Access application.
- Keep `CF_API_TOKEN` scoped to only the required account and zone.
- Use the Cloudflare Access audit logs and Tunnel status page when diagnosing SSH
  access failures.
