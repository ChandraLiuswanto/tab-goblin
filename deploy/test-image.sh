#!/usr/bin/env bash
# Smoke test for the TabGoblin runtime image. Loopback only; never publishes off-host.
set -euo pipefail

IMAGE="${TABGOBLIN_IMAGE:-localhost/tabgoblin-runtime:dev}"
NAME="tabgoblin-smoke-$$"
VOLUME="tabgoblin-smoke-profile-$$"
COOKIE_FIXTURE=$'import os\nfrom http.server import BaseHTTPRequestHandler, ThreadingHTTPServer\nfrom pathlib import Path\n\nnonce = os.environ["TG_FIXTURE_NONCE"]\ncookie_name = os.environ["TG_COOKIE_NAME"]\nset_marker = Path(os.environ["TG_SET_MARKER"])\ncheck_marker = Path(os.environ["TG_CHECK_MARKER"])\n\nclass Handler(BaseHTTPRequestHandler):\n    protocol_version = "HTTP/1.1"\n    def send_text(self, status, body, headers=()):\n        self.send_response(status)\n        for name, value in headers:\n            self.send_header(name, value)\n        self.send_header("Content-Length", str(len(body)))\n        self.end_headers()\n        self.wfile.write(body)\n        self.wfile.flush()\n    def do_GET(self):\n        if self.path == "/ready":\n            return self.send_text(200, nonce.encode())\n        if self.path == "/set":\n            self.send_text(200, b"set", (("Set-Cookie", f"{cookie_name}=present; Max-Age=3600; Path=/; SameSite=Lax"),))\n            set_marker.write_text(nonce)\n            return\n        if self.path.startswith("/check-"):\n            cookie = self.headers.get("Cookie", "")\n            marker = Path("/tmp/tg-cookie-check-" + self.path[len("/check-"):])\n            marker.write_text("present" if f"{cookie_name}=present" in cookie else "missing")\n            return self.send_text(200, b"checked")\n        self.send_error(404)\n    def log_message(self, *args):\n        pass\n\nThreadingHTTPServer(("127.0.0.1", 18080), Handler).serve_forever()'

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

set_ports() {
  cdp_mapping="$(podman port "$NAME" 9222/tcp | head -1)"
  vnc_mapping="$(podman port "$NAME" 5900/tcp | head -1)"
  case "$cdp_mapping:$vnc_mapping" in
    127.0.0.1:[0-9]*:127.0.0.1:[0-9]*) ;;
    *) echo "FAIL: runtime ports are not both IPv4 loopback-only: $cdp_mapping / $vnc_mapping" >&2; return 1 ;;
  esac
  cdp_port="${cdp_mapping##*:}"
  vnc_port="${vnc_mapping##*:}"
  case "$cdp_port:$vnc_port" in
    *[!0-9:]*|:*|*:) echo "FAIL: Podman did not report numeric loopback ports" >&2; return 1 ;;
  esac
}

start_runtime() {
  podman run --pull=never -d --name "$NAME" \
    -p 127.0.0.1::9222 -p 127.0.0.1::5900 \
    -v "$VOLUME:/profile:Z" \
    --shm-size=512m \
    "$IMAGE" >/dev/null
  set_ports
  echo "cdp=$cdp_mapping vnc=$vnc_mapping"
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

assert_discovery_websockets() {
  local endpoint discovery urls url path handshake
  for endpoint in /json /json/list /json/version; do
    discovery="$(curl -fsS "http://127.0.0.1:$cdp_port$endpoint")"
    urls="$(grep -oE 'ws://[^" ]+' <<<"$discovery" || true)"
    [ -n "$urls" ] || { echo "FAIL: $endpoint returned no WebSocket URL" >&2; return 1; }
    while IFS= read -r url; do
      case "$url" in
        "ws://127.0.0.1:$cdp_port/"*) ;;
        *) echo "FAIL: $endpoint leaked an unusable WebSocket authority: $url" >&2; return 1 ;;
      esac
      path="${url#ws://127.0.0.1:"$cdp_port"}"
      handshake="$(curl --http1.1 -sS -i --max-time 3 \
        "http://127.0.0.1:$cdp_port$path" \
        -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
        -H 'Sec-WebSocket-Version: 13' \
        -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' 2>/dev/null || true)"
      grep -q '^HTTP/1.1 101 ' <<<"$handshake" \
        || { echo "FAIL: $endpoint target WebSocket upgrade failed" >&2; return 1; }
    done <<<"$urls"
  done
}

assert_vnc() {
  local greeting
  greeting="$(timeout 5 bash -c "exec 3<>/dev/tcp/127.0.0.1/$vnc_port; head -c 8 <&3")"
  case "$greeting" in
    "RFB 003."*) ;;
    *) echo "FAIL: no RFB greeting, got: $greeting" >&2; return 1 ;;
  esac
}

wait_for_fixture_ready() {
  local nonce="$1"
  for _ in $(seq 1 30); do
    ready="$(podman exec "$NAME" python3 -c $'from urllib.request import urlopen\nprint(urlopen("http://127.0.0.1:18080/ready", timeout=1).read().decode())' 2>/dev/null || true)"
    [ "$ready" = "$nonce" ] && return 0
    sleep 0.2
  done
  echo "FAIL: cookie fixture did not become ready" >&2
  return 1
}

start_cookie_fixture() {
  local nonce="$1" cookie_name="$2" set_marker="$3" check_marker="$4"
  podman exec -d \
    --env "TG_FIXTURE_NONCE=$nonce" --env "TG_COOKIE_NAME=$cookie_name" \
    --env "TG_SET_MARKER=$set_marker" --env "TG_CHECK_MARKER=$check_marker" \
    "$NAME" python3 -c "$COOKIE_FIXTURE" >/dev/null
  wait_for_fixture_ready "$nonce"
}

open_cookie_path() {
  local path="$1" url encoded_url
  url="http://localhost:18080/$path"
  encoded_url="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$url")"
  target="$(curl -fsS -X PUT "http://127.0.0.1:$cdp_port/json/new?$encoded_url")"
  grep -Fq "\"url\": \"$url\"" <<<"$target" \
    || { echo "FAIL: CDP did not create the requested fixture target" >&2; return 1; }
  target_id="$(sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' <<<"$target")"
  [ -n "$target_id" ] || { echo "FAIL: CDP target has no id" >&2; return 1; }
  curl -fsS "http://127.0.0.1:$cdp_port/json/activate/$target_id" >/dev/null
}

wait_for_set_marker() {
  local marker="$1" nonce="$2"
  for _ in $(seq 1 30); do
    if [ "$(podman exec "$NAME" cat "$marker" 2>/dev/null || true)" = "$nonce" ]; then
      return 0
    fi
    sleep 0.2
  done
  echo "FAIL: cookie fixture did not serve /set" >&2
  return 1
}

wait_for_check_result() {
  local marker="$1"
  for _ in $(seq 1 30); do
    fixture_check_result="$(podman exec "$NAME" cat "$marker" 2>/dev/null || true)"
    case "$fixture_check_result" in
      present|missing) return 0 ;;
    esac
    sleep 0.2
  done
  echo "FAIL: cookie fixture did not complete its unique /check" >&2
  return 1
}

podman volume create "$VOLUME" >/dev/null
start_runtime

# The relay may listen to all container interfaces, but Chromium must remain private
# to the container loopback. Podman alone exposes the relay and VNC to host loopback.
wait_for_cdp
[[ "$version" == *"ws://127.0.0.1:$cdp_port/"* ]] \
  || { echo "FAIL: relay did not rewrite CDP WebSocket authority to the host loopback mapping" >&2; exit 1; }
assert_websocket
assert_discovery_websockets
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

# Exercise the same descriptor-held profile guard without mounting the active
# volume into another private-MCS container, which would relabel it away from the
# primary runtime. The probe exits before it can start any child processes.
podman exec -d "$NAME" sh -c \
  '/usr/local/bin/runtime-entrypoint.sh >/tmp/tg-profile-lock-probe.log 2>&1; printf "%s" "$?" >/tmp/tg-profile-lock-probe.status' \
  >/dev/null
for _ in $(seq 1 20); do
  if podman exec "$NAME" test -f /tmp/tg-profile-lock-probe.status; then
    break
  fi
  sleep 0.2
done
[ "$(podman exec "$NAME" cat /tmp/tg-profile-lock-probe.status 2>/dev/null || true)" = 75 ] \
  || { echo "FAIL: live-profile lock probe did not reject a second runtime" >&2; exit 1; }
podman exec "$NAME" grep -qx 'profile is already in use by another TabGoblin runtime' /tmp/tg-profile-lock-probe.log \
  || { echo "FAIL: live-profile lock probe failed for an unexpected reason" >&2; exit 1; }

# An immediate restart must preserve an actual HTTP Set-Cookie, not merely a file.
cookie_name="tg_smoke_$$_$RANDOM"
set_nonce="set_$RANDOM"
check_nonce_before="check_before_$RANDOM"
set_marker="/tmp/tg-cookie-set-$set_nonce"
check_marker_before="/tmp/tg-cookie-check-$check_nonce_before"
start_cookie_fixture "$set_nonce" "$cookie_name" "$set_marker" "$check_marker_before"
open_cookie_path set
wait_for_set_marker "$set_marker" "$set_nonce"
open_cookie_path "check-$check_nonce_before"
wait_for_check_result "$check_marker_before"
[ "$fixture_check_result" = present ] \
  || { echo "FAIL: cookie fixture could not observe its newly set cookie" >&2; exit 1; }
podman restart "$NAME" >/dev/null
wait_for_cdp
check_nonce_after="check_after_$RANDOM"
check_marker_after="/tmp/tg-cookie-check-$check_nonce_after"
start_cookie_fixture "$check_nonce_after" "$cookie_name" "$set_marker" "$check_marker_after"
open_cookie_path "check-$check_nonce_after"
wait_for_check_result "$check_marker_after"
[ "$fixture_check_result" = present ] \
  || { echo "FAIL: cookie set immediately before restart was not persisted (fixture result: $fixture_check_result)" >&2; exit 1; }
assert_discovery_websockets
assert_vnc

# SIGKILL leaves Chromium singleton symlinks. Recreate with the same volume and
# require the guarded stale-lock cleanup to restore CDP readiness.
podman kill -s KILL "$NAME" >/dev/null
wait_for_stopped
podman rm "$NAME" >/dev/null
start_runtime
wait_for_cdp
assert_discovery_websockets

# A dead relay or Chromium must stop the container rather than leave it falsely healthy.
podman exec "$NAME" pkill -f '[n]ginx: master'
wait_for_stopped
podman start "$NAME" >/dev/null
wait_for_cdp
podman exec "$NAME" pkill -f '[c]hromium'
wait_for_stopped

echo "PASS"
