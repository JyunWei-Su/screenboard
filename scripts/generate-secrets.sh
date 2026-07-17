#!/usr/bin/env bash
# Generate ScreenBoard's locally managed secrets in .env.
# CF_API_TOKEN is deliberately not generated: it must be issued by Cloudflare.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
EXAMPLE_FILE="$ROOT/.env.example"
umask 077

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required. Install it first (Debian/Ubuntu: sudo apt install openssl)." >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  cp "$EXAMPLE_FILE" "$ENV_FILE"
  echo "Created .env from .env.example."
fi

set_empty_value() {
  local key="$1"
  local value="$2"
  local tmp

  if grep -q "^${key}=" "$ENV_FILE"; then
    if ! grep -q "^${key}=$" "$ENV_FILE"; then
      echo "Kept existing ${key}."
      return
    fi
    tmp="$(mktemp "$ROOT/.env.XXXXXX")"
    awk -v key="$key" -v value="$value" \
      '{ if ($0 == key "=") print key "=" value; else print }' \
      "$ENV_FILE" >"$tmp"
    mv "$tmp" "$ENV_FILE"
  else
    printf '\n%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi

  echo "Generated ${key}."
}

# Hex values are safe to load with Bash and provide 384 bits of randomness.
set_empty_value JWT_SECRET "$(openssl rand -hex 48)"
set_empty_value DEVICE_JWT_SECRET "$(openssl rand -hex 48)"
set_empty_value BOOTSTRAP_TOKEN "$(openssl rand -hex 48)"
# AES-256 key material used to encrypt TOTP secrets stored in D1.
set_empty_value TOTP_ENC_KEY "$(openssl rand -base64 32 | tr -d '\r\n')"

chmod 600 "$ENV_FILE" 2>/dev/null || true

cat <<'EOF'

Done. Four local secrets are now in .env.

You must still paste a Cloudflare API Token into CF_API_TOKEN=.
That token is created in the Cloudflare dashboard and must have permission to
manage Tunnels, DNS records, and Zero Trust Access applications/policies.
Never commit or share .env.
EOF
