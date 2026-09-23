#!/usr/bin/env bash
# Builds dist/safari-bookmarks-sync-{chrome,firefox}-<version>.zip for the
# Chrome Web Store and addons.mozilla.org. manifest.json is at the zip root.
set -euo pipefail
cd "$(dirname "$0")/.."
scripts/sync-extensions.sh --check
mkdir -p dist
for browser in chrome firefox; do
  dir="$browser-extension"
  version=$(python3 -c "import json;print(json.load(open('$dir/manifest.json'))['version'])")
  out="dist/safari-bookmarks-sync-$browser-$version.zip"
  rm -f "$out"
  (cd "$dir" && zip -qrX "../$out" . -x '.*' -x '*/.*')
  echo "$out"
done
