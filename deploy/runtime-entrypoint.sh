#!/usr/bin/env bash
# One Chromium per profile directory. PID 1 supervises all critical processes so a
# failed CDP relay or browser cannot leave a healthy container.
set -euo pipefail

SCREEN="${TG_SCREEN:-1280x800x24}"
PROFILE=/profile
PROFILE_LOCK="$PROFILE/.tabgoblin-runtime.lock"
NGINX_RUNTIME=/tmp/tabgoblin-nginx
xvfb_pid=""
openbox_pid=""
vnc_pid=""
chromium_pid=""
relay_pid=""

if [[ ! "$SCREEN" =~ ^[1-9][0-9]*x[1-9][0-9]*x[1-9][0-9]*$ ]]; then
  echo "TG_SCREEN must be WIDTHxHEIGHTxDEPTH, got: $SCREEN" >&2
  exit 64
fi
WIDTH="${SCREEN%%x*}"
rest="${SCREEN#*x}"
HEIGHT="${rest%%x*}"

# shellcheck disable=SC2317 # Invoked by cleanup(), which the EXIT trap invokes.
wait_for_exit() {
  local pid="$1" attempts="$2"
  for _ in $(seq 1 "$attempts"); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  return 1
}

# shellcheck disable=SC2317 # Invoked by cleanup(), which the EXIT trap invokes.
stop_gracefully() {
  local pid="$1" attempts="$2"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 0
  kill -TERM "$pid" 2>/dev/null || return 0
  wait_for_exit "$pid" "$attempts" || kill -KILL "$pid" 2>/dev/null || true
}

# shellcheck disable=SC2317 # Invoked by the EXIT trap below.
cleanup() {
  trap - EXIT INT TERM
  # Browser.close flushes Chromium's profile while its display is still available.
  # Only use TERM/KILL as a bounded fallback if CDP fails or it will not exit.
  if [ -n "$chromium_pid" ] && kill -0 "$chromium_pid" 2>/dev/null; then
    if /usr/local/bin/close-browser.py; then
      wait_for_exit "$chromium_pid" 50 || stop_gracefully "$chromium_pid" 30
    else
      stop_gracefully "$chromium_pid" 30
    fi
  fi
  stop_gracefully "$relay_pid" 10
  stop_gracefully "$vnc_pid" 10
  stop_gracefully "$openbox_pid" 10
  stop_gracefully "$xvfb_pid" 10
  wait "$chromium_pid" "$relay_pid" "$vnc_pid" "$openbox_pid" "$xvfb_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 143' INT TERM

# The descriptor-held flock is released on all container exits, including SIGKILL.
# Refuse a second container before touching the profile or its singleton entries.
if [ -L "$PROFILE_LOCK" ]; then
  echo "profile lock must not be a symlink" >&2
  exit 73
fi
exec 9>"$PROFILE_LOCK"
if ! flock -n 9; then
  echo "profile is already in use by another TabGoblin runtime" >&2
  exit 75
fi

# Under the exclusive profile guard, stale Chromium singleton symlinks from a hard
# kill are safe to remove. -L is required because dangling symlinks fail -e.
if [ -e "$PROFILE/SingletonLock" ] || [ -L "$PROFILE/SingletonLock" ] \
  || [ -e "$PROFILE/SingletonCookie" ] || [ -L "$PROFILE/SingletonCookie" ] \
  || [ -e "$PROFILE/SingletonSocket" ] || [ -L "$PROFILE/SingletonSocket" ]; then
  rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonCookie" "$PROFILE/SingletonSocket"
fi

Xvfb "$DISPLAY" -screen 0 "$SCREEN" -nolisten tcp &
xvfb_pid=$!
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

# Chromium's current Fedora build binds DevTools to loopback. Keep that private on
# 9223 and proxy it through the supervised Nginx relay on container port 9222.
chromium-browser \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port=9223 \
  --remote-allow-origins=http://127.0.0.1 \
  --password-store=basic \
  --no-first-run --no-default-browser-check --disable-features=Translate \
  --window-position=0,0 --window-size="$WIDTH,$HEIGHT" \
  --start-maximized \
  about:blank &
chromium_pid=$!

mkdir -p "$NGINX_RUNTIME"/{client,proxy,fastcgi,scgi,uwsgi}
nginx -e /dev/stderr -p "$NGINX_RUNTIME" -c /etc/tabgoblin/cdp-relay.conf -g 'daemon off;' &
relay_pid=$!

# Xvfb, VNC, Chromium, and the relay are all critical. If any exits, PID 1 exits
# after cleaning up the rest; Podman will never report a partially working runtime.
set +e
wait -n "$xvfb_pid" "$vnc_pid" "$chromium_pid" "$relay_pid"
status=$?
set -e
echo "critical runtime process exited; stopping container" >&2
exit "$status"
