#!/bin/bash
#
# Create a "wirmachen.wien" umbrella account that auto-reposts all
# wirmachen.wien organisation scraper accounts.
#
# Usage:
#   ./scripts/setup-wirmachenwien.sh [server-url] [--password=secret]
#
# The scraper accounts must already exist (run setup-scraper-accounts.sh first).
# If the account doesn't exist, a random password is generated and saved to
# .wirmachenwien_password (printed to stdout once, then saved securely).
#
# If the account already exists, provide --password to authenticate.
#
# Requires: curl
#

set -e

# Parse args
SERVER="http://localhost:3000"
PASSWORD_ARG=""
for arg in "$@"; do
  if [[ "$arg" == --password=* ]]; then
    PASSWORD_ARG="${arg#--password=}"
  elif [[ "$arg" != --* ]]; then
    SERVER="$arg"
  fi
done

USERNAME="wirmachenwien"
DISPLAY_NAME="Wir machen Wien"
BIO="Für eine klimagerechte, lebenswerte und partizipative Stadt Wien"
WEBSITE="https://wirmachen.wien"
AVATAR_URL="https://wirmachen.wien/wp-content/uploads/2023/09/WMW_favicon-300x300.png"
PASSWORD_FILE=".wirmachenwien_password"
COOKIE_FILE="/tmp/wirmachenwien-cookie.txt"

# Scraper account usernames that belong to the wirmachen.wien network
ORG_USERNAMES="critical_mass_vienna kirchberggasse matznerviertel radlobby_wien space_and_place westbahnpark"

# Cleanup on exit
cleanup() { rm -f "$COOKIE_FILE"; }
trap cleanup EXIT

echo ""
echo "Setting up @${USERNAME} umbrella account on ${SERVER}"
echo ""

PASSWORD="$PASSWORD_ARG"
IS_NEW_ACCOUNT=false

# Try to load password from file if not provided
if [ -z "$PASSWORD" ] && [ -f "$PASSWORD_FILE" ]; then
  PASSWORD=$(cat "$PASSWORD_FILE")
  echo "  ℹ️  Found existing password in ${PASSWORD_FILE}"
fi

# Attempt login if we have a password
if [ -n "$PASSWORD" ]; then
  LOGIN_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$SERVER/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    -c "$COOKIE_FILE" \
    -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}")

  HTTP_CODE=$(echo "$LOGIN_RESPONSE" | tail -n1)
  LOGIN_BODY=$(echo "$LOGIN_RESPONSE" | sed '$d')

  if [ "$HTTP_CODE" = "200" ]; then
    echo "  ✅ Logged in as @${USERNAME}"
    echo ""
  elif [ "$HTTP_CODE" = "401" ]; then
    echo "  ❌ Login failed: wrong password"
    echo "  Delete ${PASSWORD_FILE} to reset or provide --password=<new>"
    exit 1
  else
    # Account doesn't exist or other error, will register below
    PASSWORD=""
    rm -f "$COOKIE_FILE"
  fi
fi

# Register if we don't have a session
if [ ! -f "$COOKIE_FILE" ] || ! grep -q "everycal_session" "$COOKIE_FILE" 2>/dev/null; then
  PASSWORD=$(openssl rand -base64 32 | tr -d '\n')
  IS_NEW_ACCOUNT=true

  REG_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$SERVER/api/v1/auth/register" \
    -H "Content-Type: application/json" \
    -c "$COOKIE_FILE" \
    -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\",\"displayName\":\"$DISPLAY_NAME\"}")

  HTTP_CODE=$(echo "$REG_RESPONSE" | tail -n1)
  REG_BODY=$(echo "$REG_RESPONSE" | sed '$d')

  if [ "$HTTP_CODE" = "409" ]; then
    echo "  ❌ Account @${USERNAME} already exists but login failed."
    echo "  Provide correct password with --password=<secret>"
    exit 1
  fi

  if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "201" ]; then
    echo "  ❌ Registration failed: $REG_BODY"
    exit 1
  fi

  echo "$PASSWORD" > "$PASSWORD_FILE"
  chmod 600 "$PASSWORD_FILE"

  echo "  ✅ Registered @${USERNAME}"
  echo "  🔑 Password: $PASSWORD"
  echo "  💾 Saved to ${PASSWORD_FILE} (keep this secure!)"
  echo ""
fi

# Update profile (only if new account)
if [ "$IS_NEW_ACCOUNT" = true ]; then
  PROFILE_RES=$(curl -s -w "%{http_code}" -o /tmp/wirmachen-profile-resp.txt -X PATCH "$SERVER/api/v1/auth/me" \
    -H "Content-Type: application/json" \
    -b "$COOKIE_FILE" \
    -d "{\"displayName\":\"$DISPLAY_NAME\",\"bio\":\"$BIO\",\"website\":\"$WEBSITE\",\"avatarUrl\":\"$AVATAR_URL\",\"discoverable\":true}")

  if [ "$PROFILE_RES" = "200" ]; then
    echo "  ✅ Profile updated (bio, website, avatar)"
    echo ""
  else
    echo "  ⚠️  Profile update: $PROFILE_RES $(cat /tmp/wirmachen-profile-resp.txt)"
    echo ""
  fi
  rm -f /tmp/wirmachen-profile-resp.txt
fi

# Follow + auto-repost each org account
echo "Setting up auto-reposts from wirmachen.wien org accounts:"
echo ""

for org in $ORG_USERNAMES; do
  FOLLOW_RES=$(curl -s -w "%{http_code}" -o /dev/null -X POST "$SERVER/api/v1/users/${org}/follow" \
    -H "Content-Type: application/json" \
    -b "$COOKIE_FILE")

  REPOST_RES=$(curl -s -w "%{http_code}" -o /dev/null -X POST "$SERVER/api/v1/users/${org}/auto-repost" \
    -H "Content-Type: application/json" \
    -b "$COOKIE_FILE")

  FOLLOW_OK=false
  REPOST_OK=false
  [ "$FOLLOW_RES" = "200" ] || [ "$FOLLOW_RES" = "409" ] && FOLLOW_OK=true
  [ "$REPOST_RES" = "200" ] || [ "$REPOST_RES" = "409" ] && REPOST_OK=true

  if $FOLLOW_OK && $REPOST_OK; then
    echo "  ✅ @${org} — following + auto-repost enabled"
  elif ! $FOLLOW_OK; then
    echo "  ❌ @${org} — follow failed: $FOLLOW_RES"
  else
    echo "  ❌ @${org} — auto-repost failed: $REPOST_RES"
  fi
done

ORG_TOTAL=$(echo $ORG_USERNAMES | wc -w | tr -d ' ')
echo ""
echo "✅ Done! @${USERNAME} now auto-reposts all events from ${ORG_TOTAL} wirmachen.wien orgs."
echo "   Visit ${SERVER}/@${USERNAME} to see the unified feed."
echo ""
