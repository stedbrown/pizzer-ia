#!/usr/bin/env bash
set -euo pipefail

: "${PIZZERIA_HEARTBEAT_URL:?missing PIZZERIA_HEARTBEAT_URL}"
: "${PIZZERIA_HEARTBEAT_TOKEN:?missing PIZZERIA_HEARTBEAT_TOKEN}"

if systemctl is-active --quiet asterisk 2>/dev/null || pgrep -x asterisk >/dev/null; then
  online=true
else
  online=false
fi

registrations="$(asterisk -rx 'pjsip show registrations' 2>/dev/null || true)"
if printf '%s' "$registrations" | grep -qiE 'sipcall.*Registered'; then
  sip_status=registered
elif printf '%s' "$registrations" | grep -qi 'sipcall'; then
  sip_status=unregistered
else
  sip_status=unknown
fi

version="$(asterisk -V 2>/dev/null | tr -cd '[:alnum:]. _-' | head -c 80 || true)"
checked_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
payload="$(printf '{\"asteriskOnline\":%s,\"sipRegistration\":\"%s\",\"version\":\"%s\",\"checkedAt\":\"%s\"}' "$online" "$sip_status" "$version" "$checked_at")"

curl --fail --silent --show-error \
  -H "content-type: application/json" \
  -H "x-heartbeat-token: ${PIZZERIA_HEARTBEAT_TOKEN}" \
  --data "$payload" \
  "$PIZZERIA_HEARTBEAT_URL/api/telephony/heartbeat"
