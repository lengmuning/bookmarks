#!/usr/bin/env bash
# Runs every automated check in the repository.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== extension copies"
scripts/sync-extensions.sh --check

echo "== script syntax"
for f in extensions-shared/*.js extensions-shared/popup/*.js chrome-extension/background.js firefox-extension/background.js worker/public/admin/app.js; do
  node --check "$f"
done

echo "== extension tests"
node --test extensions-shared/test/*.test.mjs

echo "== worker"
(cd worker && npm run -s typecheck && npm test --silent)

if [[ -d macos-app ]]; then
  echo "== macOS app"
  (cd macos-app && ./scripts/test.sh)
fi
echo "All checks passed."
