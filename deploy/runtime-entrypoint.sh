#!/usr/bin/env bash
# One Chromium per profile directory. The PID 1 shell supervises all critical
# processes so a failed CDP relay or browser cannot leave a healthy container.
set -euo pipefail

SCREEN="${TG_SCREEN:-1280x800x24}"
PROFILE=/profile
NGINX_RUNTIME=/tmp/tabgoblin-nginx

if [[ ! "$SCREEN" =~ ^[1-9][0-9]*x[1-9][0-9]*x[1-9][0-9]*$ ]]; then
  echo "TG_SCREEN must be WIDTHxHEIGHTxDEPTH, got: $SCREEN" >&2
  exit 64
fi
WIDTH="${SCREEN%%x*}"
rest="${SCREEN#*x}"
HEIGHT="${rest%%x*}"

pids=()
# shellcheck disable=SC2317 # Invoked by the EXIT trap below.
cleanup() {
  trap - EXIT INT TERM
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait "${pids[@]}" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 143' INT TERM

Xvfb "$DISPLAY" -screen 0 "$SCREEN" -nolisten tcp &
xvfb_pid=$!
pids+=("$xvfb_pid")
for _ in $(seq 1 50); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
    display_ready=1
    break
  fi
  sleep 0.2
done
[ "${display_ready:-0}" = 1 ] || { echo "Xvfb did not become ready" >&2; exit 1; }

openbox --sm-disable &
openbox_pid=$!
pids+=("$openbox_pid")

# x11vnc listens only on the container network. Podman must publish it to 127.0.0.1
# on the host; the gateway is the only intended client and gates RFB input.
vnc_args=(
  -display "$DISPLAY" -forever -shared -noxdamage -rfbport 5900
)
if [ -n "${TG_VNC_PASSWORD_FILE:-}" ]; then
  [ -r "$TG_VNC_PASSWORD_FILE" ] || { echo "TG_VNC_PASSWORD_FILE is unreadable" >&2; exit 64; }
  vnc_args+=(-rfbauth "$TG_VNC_PASSWORD_FILE")
fi
x11vnc "${vnc_args[@]}" &
vnc_pid=$!
pids+=("$vnc_pid")

# A stale lock from a hard kill blocks startup. Only clear it when no Chromium is
# alive; never remove a lock from a live owner.
if [ -e "$PROFILE/SingletonLock" ] && ! pgrep -u "$(id -u)" -f '[c]hromium' >/dev/null 2>&1; then
  rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonCookie" "$PROFILE/SingletonSocket"
fi

# Chromium's current Fedora build binds DevTools to loopback. Keep that private on
# 9223 and proxy it through the supervised Nginx relay on container port 9222.
chromium-browser \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port=9223 \
  --remote-allow-origins=http://127.0.0.1 \
  --no-first-run --no-default-browser-check --disable-features=Translate \
  --window-position=0,0 --window-size="$WIDTH,$HEIGHT" \
  --start-maximized \
  about:blank &
chromium_pid=$!
pids+=("$chromium_pid")

mkdir -p "$NGINX_RUNTIME"/{client,proxy,fastcgi,scgi,uwsgi}
nginx -e /dev/stderr -p "$NGINX_RUNTIME" -c /etc/tabgoblin/cdp-relay.conf -g 'daemon off;' &
relay_pid=$!
pids+=("$relay_pid")

# Xvfb, VNC, Chromium, and the relay are all critical. If any exits, PID 1 exits
# after cleaning up the rest; Podman will never report a partially working runtime.
set +e
wait -n "$xvfb_pid" "$vnc_pid" "$chromium_pid" "$relay_pid"
status=$?
set -e
echo "critical runtime process exited; stopping container" >&2
exit "$status"
