#!/usr/bin/env bash
set -euo pipefail

: "${PIZZERIA_HEARTBEAT_URL:?missing PIZZERIA_HEARTBEAT_URL}"
: "${PIZZERIA_HEARTBEAT_TOKEN:?missing PIZZERIA_HEARTBEAT_TOKEN}"

heartbeat_interval="${PIZZERIA_HEARTBEAT_INTERVAL_SECONDS:-25}"
next_heartbeat=0
next_rtp_summary=0
test_until=0
pjsip_logger=off
journal_cursor=""
rtp_active=false
last_online=""
last_sip=""

# A previous process killed without cleanup must never leave verbose SIP logging on.
asterisk -rx 'pjsip set logger off' >/dev/null 2>&1 || true

post_event() {
  local source="$1" level="$2" message="$3" checked_at payload
  checked_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  message="$(printf '%s' "$message" | tr -cd '[:alnum:] ._:%/@+(),=-' | head -c 500)"
  payload="$(printf '[{\"source\":\"%s\",\"level\":\"%s\",\"message\":\"%s\",\"timestamp\":\"%s\"}]' "$source" "$level" "$message" "$checked_at")"
  curl --fail --silent --show-error --connect-timeout 5 --max-time 15 --output /dev/null \
    -H "content-type: application/json" -H "x-heartbeat-token: ${PIZZERIA_HEARTBEAT_TOKEN}" \
    --data "$payload" "$PIZZERIA_HEARTBEAT_URL/api/telephony/events"
}

read_status() {
  if systemctl is-active --quiet asterisk 2>/dev/null || pgrep -x asterisk >/dev/null; then online=true; else online=false; fi
  registrations="$(asterisk -rx 'pjsip show registrations' 2>/dev/null || true)"
  if printf '%s' "$registrations" | grep -qiE 'sipcall.*Registered'; then sip_status=registered
  elif printf '%s' "$registrations" | grep -qi 'sipcall'; then sip_status=unregistered
  else sip_status=unknown; fi
  version="$(asterisk -V 2>/dev/null | tr -cd '[:alnum:]. _-' | head -c 80 || true)"
}

send_heartbeat() {
  local checked_at payload response expires_at
  read_status
  checked_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  payload="$(printf '{\"asteriskOnline\":%s,\"sipRegistration\":\"%s\",\"version\":\"%s\",\"checkedAt\":\"%s\"}' "$online" "$sip_status" "$version" "$checked_at")"
  response="$(curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
    -H "content-type: application/json" -H "x-heartbeat-token: ${PIZZERIA_HEARTBEAT_TOKEN}" \
    --data "$payload" "$PIZZERIA_HEARTBEAT_URL/api/telephony/heartbeat")"
  if printf '%s' "$response" | grep -q '"testMode":true'; then
    expires_at="$(printf '%s' "$response" | sed -n 's/.*"testModeExpiresAt":"\([^"]*\)".*/\1/p')"
    test_until="$(date -d "$expires_at" +%s 2>/dev/null || echo 0)"
  else
    test_until=0
  fi
  printf '%s heartbeat sent: asterisk=%s sip=%s version=%s test=%s\n' "$checked_at" "$online" "$sip_status" "$version" "$([[ $test_until -gt 0 ]] && echo on || echo off)"
  if [[ "$online" != "$last_online" ]]; then post_event ASTERISK "$([[ "$online" == true ]] && echo INFO || echo ERROR)" "$([[ "$online" == true ]] && echo 'Service online' || echo 'Service unavailable')"; last_online="$online"; fi
  if [[ "$sip_status" != "$last_sip" ]]; then
    if [[ "$sip_status" == registered ]]; then post_event SIPCALL INFO 'Registered'
    else post_event SIPCALL WARN "Registration $sip_status"; fi
    last_sip="$sip_status"
  fi
}

enable_test_logging() {
  journal_cursor="$(journalctl -u asterisk -n 0 --show-cursor --no-pager 2>/dev/null | sed -n 's/^-- cursor: //p')"
  asterisk -rx 'pjsip set logger on' >/dev/null
  pjsip_logger=on
  next_rtp_summary=0
  post_event ASTERISK INFO 'PJSIP logger enabled temporarily'
}

disable_test_logging() {
  if [[ "$pjsip_logger" == on ]]; then
    asterisk -rx 'pjsip set logger off' >/dev/null 2>&1 || true
    pjsip_logger=off
    rtp_active=false
  fi
}
stop_service() {
  disable_test_logging
  exit 0
}
trap disable_test_logging EXIT
trap stop_service TERM INT

collect_sip_events() {
  local output new_cursor line message source
  [[ -n "$journal_cursor" ]] || return 0
  output="$(journalctl -u asterisk --after-cursor "$journal_cursor" --show-cursor --no-pager -o cat 2>/dev/null || true)"
  new_cursor="$(printf '%s\n' "$output" | sed -n 's/^-- cursor: //p' | tail -n 1)"
  [[ -n "$new_cursor" ]] && journal_cursor="$new_cursor"
  while IFS= read -r line; do
    message=""; source=SIP
    case "$line" in
      *"REGISTER sip:"*) message='REGISTER observed'; source=SIPCALL ;;
      *"INVITE sip:"*) message='Incoming INVITE' ;;
      *"SIP/2.0 100 Trying"*) message='100 Trying' ;;
      *"SIP/2.0 180 Ringing"*) message='180 Ringing' ;;
      *"SIP/2.0 200 OK"*) message='200 OK' ;;
      *"ACK sip:"*) message='ACK observed' ;;
      *"BYE sip:"*) message='BYE observed' ;;
    esac
    [[ -n "$message" ]] && post_event "$source" INFO "$message"
  done < <(printf '%s\n' "$output" | sed '/^-- cursor: /d')
}

collect_rtp_summary() {
  local stats summary
  stats="$(asterisk -rx 'pjsip show channelstats' 2>/dev/null || true)"
  if printf '%s' "$stats" | grep -q 'No objects found'; then
    if [[ "$rtp_active" == true ]]; then post_event RTP INFO 'RTP stopped'; rtp_active=false; fi
    return
  fi
  summary="$(printf '%s\n' "$stats" | grep -Ev '^(BridgeId|=|Objects found:|[[:space:]]*$)' | head -n 1 || true)"
  [[ -n "$summary" ]] || return
  if [[ "$rtp_active" == false ]]; then post_event RTP INFO "RTP started $summary"; rtp_active=true
  else post_event RTP DEBUG "RTP summary $summary"; fi
}

while true; do
  now="$(date +%s)"
  if [[ "$now" -ge "$next_heartbeat" ]]; then send_heartbeat; next_heartbeat=$((now + heartbeat_interval)); fi
  if [[ "$test_until" -gt "$now" ]]; then
    [[ "$pjsip_logger" == on ]] || enable_test_logging
    collect_sip_events
    if [[ "$now" -ge "$next_rtp_summary" ]]; then collect_rtp_summary; next_rtp_summary=$((now + 30)); fi
  else
    disable_test_logging
  fi
  sleep 2
done
