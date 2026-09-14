# TabGoblin runtime deployment

## Build and verify

Use one stable checkout at `~/paseo-plugins/tab-goblin` for both the gateway user
service and the Paseo plugin. The service starts
`packages/gateway/dist/main.js`, and the plugin derives its MCP bridge from that
same checkout's `packages/mcp-bridge/dist/index.js`. Do not install the plugin as an
independent copy without its sibling `packages/` directory.

From a fresh checkout, install dependencies and build every generated artifact before
loading the plugin or enabling the service. `dist/` is intentionally not committed.

```bash
cd ~/paseo-plugins/tab-goblin
npm ci
npm run build
./deploy/build-image.sh
./deploy/test-image.sh
```

Configure Paseo to load `~/paseo-plugins/tab-goblin/plugin` from this checkout.
Paseo 0.8 compiles server plugins to a cached CJS bundle, so a bundled module filename
cannot identify that checkout. Set this required, absolute path in the environment of
the **Paseo server/daemon process** before loading or reloading the plugin:

```bash
export TABGOBLIN_INSTALL_ROOT="$HOME/paseo-plugins/tab-goblin"
```

Persist the same variable in the service manager, desktop launcher, or shell profile
that starts your Paseo daemon, then restart that daemon and reload TabGoblin. The
plugin validates that this path contains `plugin/paseo-plugin.json` and the built
`packages/mcp-bridge/dist/index.js`; it fails with an actionable error rather than
launching an unusable MCP command. If the checkout moves, rebuild it and update
`TABGOBLIN_INSTALL_ROOT`, the Paseo plugin location, and the gateway service
`WorkingDirectory` together.

The smoke test uses a dedicated temporary Podman volume and publishes CDP and RFB only
on `127.0.0.1`; it removes its test container and volume when it exits. It does not
contact a real account or mount a personal browser profile.

The image runs Chromium as an unprivileged container user with its browser sandbox
intact. Do not add `--no-sandbox`, privileged flags, host networking, or relaxed
seccomp options to make it start. If Chromium cannot start rootlessly, report the
specific Podman/Chromium failure as a deployment blocker.

The runtime expects a persistent per-workspace profile volume at `/profile` and a
separate staging volume at `/staging`, both mounted with SELinux-compatible labels
(such as `:Z`). CDP (9222) and RFB (5900) listen inside the container; publish both
only to host loopback. The gateway, not an exposed raw port, is the viewer boundary.
`TG_SCREEN` defaults to `1280x800x24`. Set `TG_VNC_PASSWORD_FILE` only to a readable
path inside the container when an additional VNC password is required.

Fedora Chromium keeps its DevTools socket on container loopback. Chromium therefore
uses private `127.0.0.1:9223`; a supervised in-container Nginx relay listens on
container port 9222, forwards HTTP/WebSocket CDP traffic, and rewrites discovery URLs
to Podman's loopback-published host port. This does not create a host listener beyond
Podman's explicit `127.0.0.1` publish rule. PID 1 stops the container if Chromium, the
relay, Xvfb, or VNC exits, rather than reporting a partially functioning runtime. On a
normal container stop, PID 1 asks Chromium's private CDP endpoint to close, waits a
bounded interval for its profile flush, and only then tears down the display.

## Gateway user service

Copy `tabgoblin-gateway.service` to `~/.config/systemd/user/`, reload user units,
then an operator may install and start it with:

```bash
install -Dm0644 deploy/tabgoblin-gateway.service ~/.config/systemd/user/tabgoblin-gateway.service
systemctl --user daemon-reload
systemctl --user enable --now tabgoblin-gateway.service
```

This is an operator action; the build and smoke-test scripts never enable services.
Confirm that the gateway itself listens only on loopback before exposing it through
Tailscale.

## Private Tailscale viewer (explicit operator consent required)

Tailscale Serve can terminate HTTPS for the viewer without making the gateway or
browser transports public. Obtain explicit operator consent before making these
persistent configuration changes. This procedure is for an operator; never use
Tailscale Funnel, publish a raw gateway/browser port, change firewall rules, or reset
unrelated Tailscale Serve or plugin settings. Run this as the user that owns the
user service and is authorized to change that node's Tailscale Serve configuration. If
Tailscale requires an elevation or approval, obtain it for the exact Serve command;
do not use broad `sudo` changes to the user service or plugin configuration.

### Run the procedure in a dedicated shell

The following command blocks deliberately share `origin` and `backup_dir`. Start a
dedicated Bash session and run every subsequent block in **that same session**, in
order. Do not paste the `set -euo pipefail` or `exit 1` guards into a regular
interactive shell: a failed mutation guard exits this dedicated shell, leaving the
parent shell untouched.

```bash
bash --noprofile --norc
```

The first successful backup is the **original** state. If a later mutation fails,
leaves the dedicated shell, or a diagnostic check fails, do not rerun the initial
backup block: it would capture already-mutated state. Keep the printed private backup
directory. In a new dedicated shell, rerun discovery only, then restore that original
path before retrying a targeted step:

```bash
# Replace this with the original path printed by the initial backup block.
backup_dir='/absolute/path/printed/earlier'
if [ ! -f "$backup_dir/intended-origin" ] || [ ! -f "$backup_dir/serve-status-before.json" ]; then
  printf '%s\n' 'Original backup is missing or incomplete; stop and recover manually.' >&2
  exit 1
fi
if [ "$(cat "$backup_dir/intended-origin")" != "$origin" ]; then
  printf '%s\n' 'Current DNS origin differs from the original backup; stop.' >&2
  exit 1
fi
```

If the initial backup itself fails before any mutation, treat its directory as
incomplete and start the whole procedure again; do not treat it as an original backup.

### Discover and record the intended origin

Ask Tailscale for the local node's MagicDNS name rather than copying a hostname from
another installation. `Self.DNSName` conventionally ends in a dot; remove that dot and
use the resulting hostname with `https://` and **no trailing slash**:

```bash
set -euo pipefail
command -v jq >/dev/null
dns_name="$(tailscale status --json | jq -r '.Self.DNSName')"
if [ -z "$dns_name" ] || [ "$dns_name" = "null" ]; then
  printf '%s\n' 'Self.DNSName is unavailable; stop without changing configuration.' >&2
  exit 1
fi
host_name="${dns_name%.}"
if [ -z "$host_name" ]; then
  printf '%s\n' 'The derived MagicDNS hostname is empty; stop.' >&2
  exit 1
fi
origin="https://${host_name}"
printf 'Viewer origin: %s\n' "$origin"
```

Before changing anything, create an owner-restricted backup directory. Record the
existing Serve state and the current plugin **Viewer URL** there. First open the
plugin panel and **read** (do not edit) its Viewer URL; copy that exact value for the
prompt below. A blank value records an initially unset Viewer URL. Do not record
pairing codes, cookies, or other credentials.

```bash
if [ -z "${origin:-}" ]; then
  printf '%s\n' 'Missing origin; rerun discovery in this dedicated shell.' >&2
  exit 1
fi
if [ -n "${backup_dir:-}" ]; then
  printf '%s\n' 'An original backup is already selected; do not overwrite it.' >&2
  exit 1
fi
backup_dir="$(mktemp -d)"
chmod 700 "$backup_dir"
tailscale serve status --json > "$backup_dir/serve-status-before.json"
chmod 600 "$backup_dir/serve-status-before.json"
printf '%s\n' "$origin" > "$backup_dir/intended-origin"
chmod 600 "$backup_dir/intended-origin"
read -r -p 'Current TabGoblin Viewer URL: ' previous_viewer_url
printf '%s\n' "$previous_viewer_url" > "$backup_dir/plugin-viewer-url-before"
chmod 600 "$backup_dir/plugin-viewer-url-before"
printf 'Private backup directory: %s\n' "$backup_dir"
```

Inspect the complete saved JSON before proceeding:

```bash
jq . "$backup_dir/serve-status-before.json"
```

If it shows a different HTTPS handler on port 443, a path that would be replaced, or
another conflicting route, stop and report it; do not overwrite it. If the same
private endpoint is already configured, leave it alone, record that no Serve change
was made, and skip the later Serve command.

### Align the gateway and plugin settings

The gateway reads `TABGOBLIN_VIEWER_ORIGIN` as an exact allowed origin and retains its
loopback origin as well. Therefore the gateway environment value and the plugin's
**Viewer URL** must both equal `$origin` exactly—scheme and hostname included, with no
trailing slash.

Back up only this dedicated drop-in before replacing it; do not edit the main unit or
other drop-ins:

```bash
if [ -z "${origin:-}" ] || [ -z "${backup_dir:-}" ] || [ ! -d "$backup_dir" ]; then
  printf '%s\n' 'Missing origin or private backup; restart this dedicated procedure.' >&2
  exit 1
fi
dropin_dir="$HOME/.config/systemd/user/tabgoblin-gateway.service.d"
dropin="$dropin_dir/50-tailscale-viewer.conf"
if [ -e "$dropin" ]; then
  cp -p "$dropin" "$backup_dir/50-tailscale-viewer.conf.before"
else
  : > "$backup_dir/50-tailscale-viewer.conf.was-absent"
fi
chmod 600 "$backup_dir"/50-tailscale-viewer.conf.*
install -d -m 700 "$dropin_dir"
cat > "$dropin" <<EOF
[Service]
Environment=TABGOBLIN_VIEWER_ORIGIN=$origin
EOF
chmod 600 "$dropin"
systemctl --user daemon-reload
systemctl --user restart tabgoblin-gateway.service
```

In the TabGoblin plugin panel, set **only** **Viewer URL** to `$origin`. Preserve the
connection's socket path, pairing state, and every other setting. Do not edit a
settings database or replace the whole plugin configuration. Confirm that the
loopback gateway is listening before proceeding:

```bash
# This is diagnostic: preserve the session and original backup on failure.
set +e
ss -ltn | grep ':8931'
listen_status=$?
set -e
if [ "$listen_status" -ne 0 ]; then
  printf '%s\n' 'Gateway port 8931 is not listening; investigate before enabling Serve.' >&2
fi
```

With operator consent and only after confirming that no conflicting Serve endpoint
exists, expose the existing loopback listener privately to the tailnet:

```bash
if [ -z "${origin:-}" ] || [ -z "${backup_dir:-}" ] || [ ! -d "$backup_dir" ]; then
  printf '%s\n' 'Missing origin or private backup; restart this dedicated procedure.' >&2
  exit 1
fi
tailscale serve --bg --https=443 http://127.0.0.1:8931
```

### Validate the private deployment

These checks confirm the local configuration and HTTPS response; they do not prove
that a phone or other tailnet client can reach the viewer. Keep certificate validation
enabled.

```bash
if [ -z "${origin:-}" ]; then
  printf '%s\n' 'Missing origin; restart this dedicated procedure.' >&2
  exit 1
fi
# These are diagnostics: preserve the session and original backup on failure.
set +e
systemctl --user is-active tabgoblin-gateway.service
systemctl --user show tabgoblin-gateway.service \
  --property=Environment --property=ActiveState
curl --fail --show-error --max-time 20 http://127.0.0.1:8931/
tailscale serve status --json
curl --fail --show-error --max-time 20 "$origin/"
ss -ltn | grep ':8931'
podman ps --filter name=tabgoblin- --format '{{.Names}} {{.Ports}}'
set -e
```

A nonzero diagnostic result is a failed check to investigate, not an expected success.
First HTTPS certificate provisioning after enabling Serve can require waiting and
retrying the HTTPS `curl` after `tailscale serve status --json` shows the endpoint; do
not assume other service, listener, certificate, or transport failures are transient.

Inspect the service environment for `TABGOBLIN_VIEWER_ORIGIN=$origin`, the Serve JSON
for the HTTPS port-443 proxy to `http://127.0.0.1:8931`, and the `ss` output to ensure
the gateway's port 8931 listener is on loopback. Podman may choose ephemeral host ports
for CDP and VNC, so do not assume 9222 or 5900 are host ports: every mapping printed by
`podman ps` must bind `127.0.0.1`. If it prints no running `tabgoblin-` container, the
browser transport bindings were not verified. In the plugin panel, confirm the
generated viewer link begins with the same `$origin`; do not publish a link containing
a credential or pairing value.

### Roll back only this deployment

Use the private backup created above. Restore the previous plugin **Viewer URL** first
through the plugin panel, changing no other plugin fields. Then restore the dedicated
drop-in and restart the gateway:

```bash
if [ -z "${backup_dir:-}" ] || [ ! -d "$backup_dir" ]; then
  printf '%s\n' 'Missing private backup; do not attempt rollback commands.' >&2
  exit 1
fi
dropin_dir="$HOME/.config/systemd/user/tabgoblin-gateway.service.d"
dropin="$dropin_dir/50-tailscale-viewer.conf"
if [ -e "$backup_dir/50-tailscale-viewer.conf.before" ]; then
  install -Dm600 "$backup_dir/50-tailscale-viewer.conf.before" "$dropin"
elif [ -e "$backup_dir/50-tailscale-viewer.conf.was-absent" ]; then
  rm -f "$dropin"
else
  printf '%s\n' 'Missing drop-in backup; stop and recover it manually.' >&2
  exit 1
fi
systemctl --user daemon-reload
systemctl --user restart tabgoblin-gateway.service
```

If port 443 had no Serve endpoint before this procedure, remove only the endpoint
created here:

```bash
if [ -z "${backup_dir:-}" ] || [ ! -f "$backup_dir/serve-status-before.json" ]; then
  printf '%s\n' 'Missing saved Serve state; do not remove an endpoint.' >&2
  exit 1
fi
tailscale serve --https=443 off
```

If a port-443 endpoint existed before the procedure, it was a conflict and this
procedure should have stopped before changing it. Preserve that prior configuration:
do **not** run `off`, `tailscale serve reset`, or a broad saved-config restore. Report
the conflict and use the recorded pre-change state to obtain an operator-approved,
targeted recovery command if an earlier manual change must be undone.

## Profile-data warning

A profile volume contains cookies and other login material. Filesystem permissions
are not encryption at rest, and backups of the volume contain authenticated session
data. Use encrypted host storage where required, keep volumes owner-restricted, and
never mount, import, delete, or use a personal browser profile. The runtime holds an
exclusive file lock for its full lifetime. Do not start a second Podman container with
an active profile volume: its `:Z` mount can relabel that volume to the second
container's private MCS label before the runtime reaches the file-lock check. The
supervisor must prevent duplicate runs for an active volume. After a hard kill, the
next lock holder removes stale Chromium singleton links only after acquiring that lock.
