#!/usr/bin/env bash
# Copies the shared extension sources in extensions-shared/ into
# chrome-extension/ and firefox-extension/. With --check, only verifies that
# the copies are up to date.
set -euo pipefail
cd "$(dirname "$0")/.."

FILES=(
  "canonical.js:lib/canonical.js"
  "sync-core.js:lib/sync-core.js"
  "popup/popup.html:popup/popup.html"
  "popup/popup.css:popup/popup.css"
  "popup/popup.js:popup/popup.js"
)

status=0
for target in chrome-extension firefox-extension; do
  for pair in "${FILES[@]}"; do
    src="extensions-shared/${pair%%:*}"
    dst="$target/${pair##*:}"
    if [[ "${1:-}" == "--check" ]]; then
      if ! cmp -s "$src" "$dst"; then
        echo "out of date: $dst (run scripts/sync-extensions.sh)" >&2
        status=1
      fi
    else
      mkdir -p "$(dirname "$dst")"
      cp "$src" "$dst"
    fi
  done
done
exit "$status"
