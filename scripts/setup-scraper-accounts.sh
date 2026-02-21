#!/bin/bash
#
# One-time setup: create passwordless scraper accounts and generate API keys.
#
# Each scraper gets its own account on the server with NO password — only
# API-key authentication is possible, so there is no password to leak or brute-force.
#
# Usage:
#   ./scripts/setup-scraper-accounts.sh [server-url]
#   ./scripts/setup-scraper-accounts.sh --out /path/to/keys.json [server-url]
#
# The script prints:
#   1. Status for each scraper account
#   2. A ready-to-use docker-compose volume config
#   3. Alternative env var format for Docker secrets
#
# If an account already exists (409), it is skipped — run this script only
# once per server. To rotate keys, delete the old ones via the API and re-run.
#
# Requires: curl, jq
#

set -e

# Parse args
OUT_FILE="scraper-api-keys.json"
SERVER="http://localhost:3000"
for arg in "$@"; do
  if [ "$arg" = "--out" ]; then
    NEXT_IS_OUT=1
  elif [ -n "$NEXT_IS_OUT" ]; then
    OUT_FILE="$arg"
    NEXT_IS_OUT=""
  elif [ "$arg" != "--out" ] && [[ ! "$arg" =~ ^-- ]]; then
    SERVER="$arg"
  fi
done

# Discover scrapers from packages/scrapers/src/scrapers (all .ts files except index.ts)
# Scraper id = basename with hyphens → underscores (e.g. flex-at.ts → flex_at)
SCRAPER_DIR="$(cd "$(dirname "$0")/.." && pwd)/packages/scrapers/src/scrapers"
SCRAPERS=$(find "$SCRAPER_DIR" -name "*.ts" -type f ! -name "index.ts" -exec sh -c 'basename "$1" .ts | tr "-" "_"' _ {} \; | sort -u)

# Placeholder display name (scrapers update profile on first run)
scraper_display_name() {
  echo "$1" | tr '_' ' ' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) tolower(substr($i,2));}1'
}

# Minimal profile placeholder — scrapers update bio/website/avatar on first run
scraper_profile_json() {
  echo '{"isBot":true,"discoverable":true}'
}

echo ""
echo "🗓️  EveryCal Scraper Account Setup"
echo "   Server: $SERVER"
echo ""

# Start fresh JSON
echo "{" > "$OUT_FILE"
FIRST=1
CREATED=0
ERRORS=""

for scraper in $SCRAPERS; do
  display_name=$(scraper_display_name "$scraper")
  printf "  %-30s" "$scraper"

  # Register without a password
  REG_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$SERVER/api/v1/auth/register" \
    -H "Content-Type: application/json" \
    -c "/tmp/${scraper}-cookie.txt" \
    -d "{\"username\":\"$scraper\",\"displayName\":\"$display_name\",\"isBot\":true,\"city\":\"Wien\",\"cityLat\":48.2082,\"cityLng\":16.3738}")

  HTTP_CODE=$(echo "$REG_RESPONSE" | tail -n1)
  REG_BODY=$(echo "$REG_RESPONSE" | sed '$d')

  if [ "$HTTP_CODE" = "409" ]; then
    echo "SKIP (already exists)"
    ERRORS="${ERRORS}${scraper}: already exists — delete and re-run to rotate keys"$'\n'
    rm -f "/tmp/${scraper}-cookie.txt"
    continue
  fi

  if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "201" ]; then
    echo "❌ register failed: $HTTP_CODE $REG_BODY"
    ERRORS="${ERRORS}${scraper}: register failed"$'\n'
    rm -f "/tmp/${scraper}-cookie.txt"
    continue
  fi

  # Set profile: bot flag, discoverable, bio, website, avatar
  profile_json=$(scraper_profile_json "$scraper")
  curl -s -X PATCH "$SERVER/api/v1/auth/me" \
    -H "Content-Type: application/json" \
    -b "/tmp/${scraper}-cookie.txt" \
    -d "$profile_json" > /dev/null

  # Create API key
  KEY_RESPONSE=$(curl -s -X POST "$SERVER/api/v1/auth/api-keys" \
    -H "Content-Type: application/json" \
    -b "/tmp/${scraper}-cookie.txt" \
    -d '{"label":"scraper"}')

  API_KEY=$(echo "$KEY_RESPONSE" | jq -r '.key // empty')
  rm -f "/tmp/${scraper}-cookie.txt"

  if [ -n "$API_KEY" ] && [ "$API_KEY" != "null" ]; then
    echo "✅ created"
    CREATED=$((CREATED + 1))
    if [ "$FIRST" -eq 1 ]; then
      FIRST=0
      echo "  \"$scraper\": \"$API_KEY\"" >> "$OUT_FILE"
    else
      echo "  ,\"$scraper\": \"$API_KEY\"" >> "$OUT_FILE"
    fi
  else
    echo "❌ API key creation failed"
    ERRORS="${ERRORS}${scraper}: API key creation failed"$'\n'
  fi

  sleep 0.5
done

echo "}" >> "$OUT_FILE"

if [ "$CREATED" -eq 0 ]; then
  echo ""
  echo "❌ No accounts were created. Nothing to configure."
  if [ -n "$ERRORS" ]; then
    echo ""
    echo "Issues:"
    echo "$ERRORS" | while read -r line; do [ -n "$line" ] && echo "  - $line"; done
  fi
  rm -f "$OUT_FILE"
  exit 1
fi

# Secure the keys file
chmod 600 "$OUT_FILE" 2>/dev/null || true

echo ""
echo "══════════════════════════════════════════════════════════════════════"
echo "  $CREATED scraper account(s) created"
echo "══════════════════════════════════════════════════════════════════════"
echo ""
echo "🔑 API keys written to: $OUT_FILE  (mode 600, owner-read only)"
echo "   Move this file to your server, e.g. /opt/everycal/scraper-api-keys.json"
echo ""
echo "──────────────────────────────────────────────────────────────────────"
echo ""
echo "🐳 Docker — scrapers run inside the main container via node-cron."
echo ""
echo "  1. Add the volume to docker-compose.yml under everycal volumes:"
echo "     - ./scraper-api-keys.json:/secrets/scraper-api-keys.json:ro"
echo "  2. Restart: docker compose up -d --build"
echo ""
echo "  Scrapers run every 6h, reminders every 15min. No separate scraper container."
echo ""
echo "──────────────────────────────────────────────────────────────────────"
echo ""
echo "📋 Alternative — pass keys as env var (e.g. Docker secrets):"
echo ""
echo "  SCRAPER_API_KEYS_JSON='{\"scraper_id\":\"ecal_xxx\",...}'"
echo ""

if [ -n "$ERRORS" ]; then
  echo "⚠️  Issues:"
  echo "$ERRORS" | while read -r line; do [ -n "$line" ] && echo "  - $line"; done
  echo ""
fi
