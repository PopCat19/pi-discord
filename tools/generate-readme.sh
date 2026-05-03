#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
{
  hash="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  date="$(date -u +%Y%m%d)"
  for f in "$REPO_ROOT/readme_manifest"/*.md; do cat "$f"; echo; done
  echo "<!-- generated: ${date}-${hash} -->"
} > "$REPO_ROOT/README.md"
echo "Generated README.md"
