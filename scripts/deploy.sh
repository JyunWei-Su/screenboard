#!/usr/bin/env bash
# First-time ScreenBoard deployment. Run from the repository root with Bash.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

[ -f .env ] || { echo "Missing .env. Copy .env.example and fill every value." >&2; exit 1; }
set -a
# shellcheck disable=SC1091
. ./.env
set +a

required=(CLOUDFLARE_API_TOKEN CF_ACCOUNT_ID CF_ZONE_ID API_DOMAIN ADMIN_DOMAIN CF_ACCESS_ALLOWED_EMAILS JWT_SECRET DEVICE_JWT_SECRET BOOTSTRAP_TOKEN TOTP_ENC_KEY CF_API_TOKEN)
for key in "${required[@]}"; do
  [ -n "${!key:-}" ] || { echo "Missing $key in .env" >&2; exit 1; }
done

# Wrangler uses CLOUDFLARE_ACCOUNT_ID. Keep CF_ACCOUNT_ID as this project's
# configuration key, but do not export its deprecated Wrangler alias.
ACCOUNT_ID="$CF_ACCOUNT_ID"
export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID"
unset CF_ACCOUNT_ID

D1_DATABASE_NAME="${D1_DATABASE_NAME:-screenboard}"
R2_BUCKET_NAME="${R2_BUCKET_NAME:-screenboard}"
PAGES_PROJECT_NAME="${PAGES_PROJECT_NAME:-screenboard-admin}"
WORKER_NAME="${WORKER_NAME:-screenboard-api}"
WRANGLER=(node "$ROOT/node_modules/wrangler/bin/wrangler.js")

cf() {
  curl --fail-with-body --silent --show-error \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json" "$@"
}

# Use a first-level hostname (ssh-<uuid>.<zone>) for every device. This is
# covered by Cloudflare Universal SSL, unlike <uuid>.ssh.<zone>.
zone_json="$(cf "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID")"
zone_name="$(printf '%s' "$zone_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).result?.name||""))')"
[ -n "$zone_name" ] || { echo "Could not determine the zone name for CF_ZONE_ID." >&2; exit 1; }

echo "==> Installing project dependencies"
npm install

echo "==> Looking up D1 database"
d1_json="$(cf "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/d1/database?name=$D1_DATABASE_NAME")"
d1_id="$(printf '%s' "$d1_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).result||[];process.stdout.write(r[0]?.uuid||"")})')"
if [ -z "$d1_id" ]; then
  echo "==> Creating D1 database"
  d1_json="$(cf -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/d1/database" --data "{\"name\":\"$D1_DATABASE_NAME\",\"primary_location_hint\":\"apac\"}")"
  d1_id="$(printf '%s' "$d1_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).result.uuid))')"
fi

echo "==> Creating R2 bucket if absent"
if ! "${WRANGLER[@]}" r2 bucket info "$R2_BUCKET_NAME" >/dev/null 2>&1; then
  "${WRANGLER[@]}" r2 bucket create "$R2_BUCKET_NAME"
fi

tmp_config="$(mktemp "$ROOT/apps/api/.deploy.wrangler.XXXXXX.jsonc")"
tmp_secrets="$(mktemp)"
trap 'rm -f "$tmp_config" "$tmp_secrets"' EXIT
sed -e "s/REPLACE_WITH_D1_DATABASE_ID/$d1_id/" \
    -e "s/\"name\": \"screenboard-api\"/\"name\": \"$WORKER_NAME\"/" \
    -e "s#https://screenboard-api.example.workers.dev#https://$API_DOMAIN#" \
    -e "s/\"database_name\": \"screenboard\"/\"database_name\": \"$D1_DATABASE_NAME\"/" \
    -e "s/\"bucket_name\": \"screenboard\"/\"bucket_name\": \"$R2_BUCKET_NAME\"/" \
    "$ROOT/apps/api/wrangler.jsonc" >"$tmp_config"
# Add an exact Worker custom domain without altering the tracked configuration.
sed -i "s#\"main\": \"src/index.ts\",#\"main\": \"src/index.ts\",\n  \"routes\": [{ \"pattern\": \"$API_DOMAIN\", \"custom_domain\": true }],#" "$tmp_config"
sed -i "s#\"PUBLIC_API_URL\": \"https://$API_DOMAIN\"#\"PUBLIC_API_URL\": \"https://$API_DOMAIN\",\n    \"CF_ACCOUNT_ID\": \"$ACCOUNT_ID\",\n    \"CF_ZONE_ID\": \"$CF_ZONE_ID\",\n    \"CF_ZONE_NAME\": \"$zone_name\",\n    \"CF_ACCESS_ALLOWED_EMAILS\": \"$CF_ACCESS_ALLOWED_EMAILS\"#" "$tmp_config"

printf '{"JWT_SECRET":%s,"DEVICE_JWT_SECRET":%s,"BOOTSTRAP_TOKEN":%s,"TOTP_ENC_KEY":%s,"CF_API_TOKEN":%s}\n' \
  "$(node -p 'JSON.stringify(process.argv[1])' "$JWT_SECRET")" \
  "$(node -p 'JSON.stringify(process.argv[1])' "$DEVICE_JWT_SECRET")" \
  "$(node -p 'JSON.stringify(process.argv[1])' "$BOOTSTRAP_TOKEN")" \
  "$(node -p 'JSON.stringify(process.argv[1])' "$TOTP_ENC_KEY")" \
  "$(node -p 'JSON.stringify(process.argv[1])' "$CF_API_TOKEN")" >"$tmp_secrets"

echo "==> Uploading Worker secrets and deploying API"
"${WRANGLER[@]}" secret bulk "$tmp_secrets" --config "$tmp_config"
"${WRANGLER[@]}" d1 migrations apply "$D1_DATABASE_NAME" --remote --cwd "$ROOT/apps/api" --config "$tmp_config"
"${WRANGLER[@]}" deploy --config "$tmp_config" --keep-vars

echo "==> Building and deploying admin console"
( cd apps/admin && VITE_API_URL="https://$API_DOMAIN" npm run build )
"${WRANGLER[@]}" pages project create "$PAGES_PROJECT_NAME" --production-branch main || true
"${WRANGLER[@]}" pages deploy apps/admin/dist --project-name "$PAGES_PROJECT_NAME"

echo "==> Attaching admin custom domain"
pages_domains="$(cf "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects/$PAGES_PROJECT_NAME/domains")"
pages_domain_exists="$(printf '%s' "$pages_domains" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const domains=JSON.parse(s).result||[];const target=process.argv[1].toLowerCase();process.stdout.write(domains.some(d=>String(d.name||"").toLowerCase()===target)?"true":"false")})' "$ADMIN_DOMAIN")"
if [ "$pages_domain_exists" != "true" ]; then
  cf -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects/$PAGES_PROJECT_NAME/domains" \
    --data "{\"name\":\"$ADMIN_DOMAIN\"}" >/dev/null
fi

# A Pages subdomain needs both the Pages association above and a proxied CNAME.
# Never overwrite an existing DNS record because it may belong to another service.
admin_dns_records="$(cf "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records?name=$ADMIN_DOMAIN")"
admin_dns_exists="$(printf '%s' "$admin_dns_records" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const records=JSON.parse(s).result||[];process.stdout.write(records.length?"true":"false")})')"
if [ "$admin_dns_exists" != "true" ]; then
  cf -X POST "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records" \
    --data "{\"type\":\"CNAME\",\"name\":\"$ADMIN_DOMAIN\",\"content\":\"$PAGES_PROJECT_NAME.pages.dev\",\"proxied\":true,\"ttl\":1}" >/dev/null
fi

cat <<EOF

Deployment finished.
API: https://$API_DOMAIN
Admin Pages project: $PAGES_PROJECT_NAME

One manual Cloudflare step remains: create/configure your Zero Trust organization and
Identity Provider.
Then bootstrap the first ScreenBoard admin with BOOTSTRAP_TOKEN.
EOF
