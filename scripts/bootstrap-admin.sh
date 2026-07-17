#!/usr/bin/env bash
# Create the first ScreenBoard admin and print its one-time TOTP provisioning data.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

[ -f .env ] || { echo "Missing .env. Create it from .env.example first." >&2; exit 1; }
set -a
# shellcheck disable=SC1091
. ./.env
set +a

[ -n "${API_DOMAIN:-}" ] || { echo "Missing API_DOMAIN in .env" >&2; exit 1; }
[ -n "${BOOTSTRAP_TOKEN:-}" ] || { echo "Missing BOOTSTRAP_TOKEN in .env" >&2; exit 1; }

name="${1:-admin}"
body="$(node -p 'JSON.stringify({name: process.argv[1]})' "$name")"

echo "Creating the first admin: $name"
response="$(curl --fail --silent --show-error \
  -X POST "https://$API_DOMAIN/api/auth/bootstrap" \
  -H "x-bootstrap-token: $BOOTSTRAP_TOKEN" \
  -H "Content-Type: application/json" \
  --data "$body")"

printf '%s' "$response" | node -e '
  let s = "";
  process.stdin.on("data", (d) => { s += d; });
  process.stdin.on("end", () => {
    const result = JSON.parse(s);
    if (!result.totp_secret) throw new Error("The API did not return TOTP provisioning data.");
    console.log("\nAdd this to your authenticator app now (shown only once):");
    console.log(`Account: ${result.name}`);
    console.log(`Secret:  ${result.totp_secret}`);
    console.log("Type:    Time-based (TOTP), 6 digits");
    console.log(`URI:     ${result.otpauth_uri}`);
  });
'
