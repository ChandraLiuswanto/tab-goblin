#!/usr/bin/env bash
set -euo pipefail

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/tab-goblin" && pwd)
skills_root=${AGENTS_SKILLS_DIR:-"$HOME/.agents/skills"}
destination="$skills_root/tab-goblin"
destination_skill="$destination/SKILL.md"

if [[ -e "$destination_skill" ]] && ! cmp -s "$source_dir/SKILL.md" "$destination_skill"; then
  echo "Refusing to overwrite a different skill: $destination_skill" >&2
  exit 1
fi

mkdir -p -- "$destination"
if [[ ! -e "$destination_skill" ]]; then
  cp -- "$source_dir/SKILL.md" "$destination_skill"
fi
printf '%s\n' "$destination_skill"
