#!/usr/bin/env bash
# Runs the BookmarksSyncCore unit tests.
set -euo pipefail
cd "$(dirname "$0")/.."
./scripts/generate.sh
xcodebuild test \
  -project BookmarksSync.xcodeproj \
  -scheme BookmarksSyncCore \
  -destination "platform=macOS" \
  -derivedDataPath build/DerivedData \
  CODE_SIGNING_ALLOWED=NO \
  -quiet
