#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if ! command -v opencode >/dev/null 2>&1; then
  echo "OpenCode не найден в PATH." >&2
  exit 1
fi

exec opencode "$@"
