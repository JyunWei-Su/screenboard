#!/usr/bin/env bash
# Creates the ScreenBoard Email OTP identity provider once per Zero Trust org.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT_DIR/.env"
: "${CF_ACCOUNT_ID:?CF_ACCOUNT_ID is required}"
: "${CF_API_TOKEN:?CF_API_TOKEN is required}"

api="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/identity_providers"
providers="$(curl -fsSL -H "Authorization: Bearer $CF_API_TOKEN" "$api")"
exists="$(printf '%s' "$providers" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const r=JSON.parse(s).result||[];process.stdout.write(r.some(x=>x.type==="onetimepin")?"true":"false")})')"

if [ "$exists" = "true" ]; then
  echo "Email One-time PIN is already configured."
  exit 0
fi

curl -fsSL -X POST -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  --data '{"name":"ScreenBoard Email One-time PIN","type":"onetimepin","config":{}}' "$api" >/dev/null
echo "Email One-time PIN configured."
