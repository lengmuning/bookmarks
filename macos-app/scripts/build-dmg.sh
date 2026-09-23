#!/usr/bin/env bash
# Release build signed with the Apple Development certificate of the team in
# project.yml, packaged as ../dist/Safari-Bookmarks-Sync-<version>.dmg.
set -euo pipefail
cd "$(dirname "$0")/.."
./scripts/generate.sh
xcodebuild \
  -project BookmarksSync.xcodeproj \
  -scheme BookmarksSync \
  -configuration Release \
  -derivedDataPath build/DerivedData \
  -quiet build
APP="build/DerivedData/Build/Products/Release/Safari Bookmarks Sync.app"
codesign --verify --deep --strict "$APP"
VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist")
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
mkdir -p ../dist
DMG="../dist/Safari-Bookmarks-Sync-$VERSION.dmg"
rm -f "$DMG"
hdiutil create -volname "Safari Bookmarks Sync" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
echo "$DMG"
