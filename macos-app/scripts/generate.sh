#!/usr/bin/env bash
# Generates BookmarksSync.xcodeproj from project.yml (needs `brew install xcodegen`).
set -euo pipefail
cd "$(dirname "$0")/.."
xcodegen generate --quiet
