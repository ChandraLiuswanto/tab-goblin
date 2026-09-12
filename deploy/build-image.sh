#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
podman build -t "${TABGOBLIN_IMAGE:-localhost/tabgoblin-runtime:dev}" -f Containerfile .
