#!/usr/bin/env bash
# Smoke test for the TabGoblin runtime image. Loopback only; never publishes off-host.
set -euo pipefail

IMAGE="${TABGOBLIN_IMAGE:-localhost/tabgoblin-runtime:dev}"
NAME="tabgoblin-smoke-$$"
VOLUME="tabgoblin-smoke-profile-$$"

cleanup() {
  podman rm -f "$NAME" >/dev/null 2>&1 || true
  podman volume rm -f "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

container_state() {
  podman inspect --format '{{.State.Status}}' "$NAME"
}

wait_for_stopped() {
  for _ in $(seq 1 20); do
    [ "$(container_state)" != running ] && return 0
    sleep 0.5
  done
  echo "FAIL: container remained healthy after a critical process died" >&2
  podman logs "$NAME" >&2 || true
  return 1
}

cdp_version() {
  curl -fsS --max-time 2 "http://127.0.0.1:$cdp_port/json/version"
}

wait_for_cdp() {
  for _ in $(seq 1 60); do
    version="$(cdp_version || true)"
    if grep -q webSocketDebuggerUrl <<<"$version"; then
      return 0
    fi
    sleep 1
  done
  echo "FAIL: CDP never became ready" >&2
  podman logs "$NAME" >&2
  return 1
}

assert_websocket() {
  local path handshake
  path="$(printf '%s' "$version" | sed -n 's/.*"webSocketDebuggerUrl"[[:space:]]*:[[:space:]]*"ws:\/\/[^/]*\([^\"]*\)".*/\1/p')"
  [ -n "$path" ] || { echo "FAIL: CDP version response has no WebSocket path" >&2; return 1; }
  # curl waits for WebSocket frames after a successful upgrade and then times out;
  # preserve the received headers so the 101 response is the assertion.
  handshake="$(curl --http1.1 -sS -i --max-time 3 \
    "http://127.0.0.1:$cdp_port$path" \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' 2>/dev/null || true)"
  grep -q '^HTTP/1.1 101 ' <<<"$handshake" \
    || { echo "FAIL: CDP WebSocket upgrade failed: $handshake" >&2; return 1; }
}

assert_vnc() {
  local greeting
  greeting="$(timeout 5 bash -c "exec 3<>/dev/tcp/127.0.0.1/$vnc_port; head -c 8 <&3")"
  case "$greeting" in
    "RFB 003."*) ;;
    *) echo "FAIL: no RFB greeting, got: $greeting" >&2; return 1 ;;
  esac
}

podman volume create "$VOLUME" >/dev/null
podman run --pull=never -d --name "$NAME" \
  -p 127.0.0.1::9222 -p 127.0.0.1::5900 \
  -v "$VOLUME:/profile:Z" \
  --shm-size=512m \
  "$IMAGE" >/dev/null

cdp_mapping="$(podman port "$NAME" 9222/tcp | head -1)"
vnc_mapping="$(podman port "$NAME" 5900/tcp | head -1)"
case "$cdp_mapping:$vnc_mapping" in
  127.0.0.1:[0-9]*:127.0.0.1:[0-9]*) ;;
  *) echo "FAIL: runtime ports are not both IPv4 loopback-only: $cdp_mapping / $vnc_mapping" >&2; exit 1 ;;
esac
cdp_port="${cdp_mapping##*:}"
vnc_port="${vnc_mapping##*:}"
case "$cdp_port:$vnc_port" in
  *[!0-9:]*|:*|*:) echo "FAIL: Podman did not report numeric loopback ports" >&2; exit 1 ;;
esac

echo "cdp=$cdp_mapping vnc=$vnc_mapping"

# The relay may listen to all container interfaces, but Chromium must remain private
# to the container loopback. Podman alone exposes the relay and VNC to host loopback.
wait_for_cdp
[[ "$version" == *"ws://127.0.0.1:$cdp_port/"* ]] \
  || { echo "FAIL: relay did not rewrite CDP WebSocket authority to the host loopback mapping" >&2; exit 1; }
assert_websocket
assert_vnc

listeners="$(podman exec "$NAME" sh -c "awk '\$4 == \"0A\" { print \$2 }' /proc/net/tcp")"
grep -qx '00000000:2406' <<<"$listeners" \
  || { echo "FAIL: relay is not listening on container port 9222" >&2; exit 1; }
grep -qx '0100007F:2407' <<<"$listeners" \
  || { echo "FAIL: Chromium CDP is not private to container loopback port 9223" >&2; exit 1; }

if ss -ltn | awk '{print $4}' | grep -qE "^(0\.0\.0\.0|\*|\[::\]):($cdp_port|$vnc_port)$"; then
  echo "FAIL: a runtime port is bound off-loopback on the host" >&2
  exit 1
fi

# Profile data survives a controlled container restart, including the supervised relay.
podman exec "$NAME" sh -c 'echo persisted > /profile/marker'
podman restart "$NAME" >/dev/null
wait_for_cdp
assert_websocket
assert_vnc
podman exec "$NAME" cat /profile/marker | grep -qx persisted \
  || { echo "FAIL: profile volume did not persist after restart" >&2; exit 1; }

# A dead relay or Chromium must stop the container rather than leave it falsely healthy.
podman exec "$NAME" pkill -f '[n]ginx: master'
wait_for_stopped
podman start "$NAME" >/dev/null
wait_for_cdp
podman exec "$NAME" pkill -f '[c]hromium'
wait_for_stopped

echo "PASS"
