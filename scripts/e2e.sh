#!/usr/bin/env bash
# End-to-end check: starts the Worker locally with wrangler dev (local only,
# nothing is sent to Cloudflare, state lives in a temporary folder) and runs
# the extension engine and the macOS sync engine against it.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-8799}
STATE=$(mktemp -d)
LOG="$STATE/wrangler.log"

(cd worker && WRANGLER_SEND_METRICS=false exec npx wrangler dev --config test/wrangler.test.toml \
  --ip 127.0.0.1 --port "$PORT" --persist-to "$STATE" --show-interactive-dev-session=false >"$LOG" 2>&1) &
cleanup() {
  pkill -f "wrangler dev --config test/wrangler.test.toml" 2>/dev/null || true
  rm -rf "$STATE"
}
trap cleanup EXIT

for i in $(seq 1 90); do
  if curl -sf "http://127.0.0.1:$PORT/v2/health" >/dev/null; then break; fi
  if [[ $i == 90 ]]; then cat "$LOG"; echo "wrangler dev did not start" >&2; exit 1; fi
  sleep 1
done

export SYNC_E2E_URL="http://127.0.0.1:$PORT"
export SYNC_E2E_ADMIN_KEY="test-admin-key-with-enough-length"

echo "== extension engine"
node --test extensions-shared/test/e2e.test.mjs

echo "== macOS sync engine"
(cd macos-app && ./scripts/generate.sh && \
  TEST_RUNNER_SYNC_E2E_URL="$SYNC_E2E_URL" TEST_RUNNER_SYNC_E2E_ADMIN_KEY="$SYNC_E2E_ADMIN_KEY" \
  xcodebuild test -project BookmarksSync.xcodeproj -scheme BookmarksSyncCore -destination platform=macOS \
    -derivedDataPath build/DerivedData CODE_SIGNING_ALLOWED=NO \
    -only-testing:BookmarksSyncCoreTests/EndToEndTests 2>&1 | grep -E "Test Case|skipped|error:|TEST (SUCCEEDED|FAILED)"; test "${PIPESTATUS[0]}" -eq 0)

echo "End-to-end checks passed."
