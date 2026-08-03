#!/bin/bash
# Build Bellone for macOS with proper ad-hoc code-signing.
#
# electron-builder skips signing when no Apple Developer identity is present,
# which leaves the bundle with Identifier=Electron and unsealed resources.
# That breaks the Dock icon and Spotlight indexing. This script:
#   1. packages the app (unpacked) with electron-builder
#   2. ad-hoc signs the .app so Identifier=com.bellone.app and resources are sealed
#   3. repackages the signed app into the DMG + latest-mac.yml
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> 1/3 compile TypeScript"
npm run build

echo "==> 2/3 package app (unpacked) + ad-hoc codesign"
npx electron-builder --mac --dir --config.asar=false
APP="$ROOT/release/mac-arm64/Bellone.app"
[ -d "$APP" ] || { echo "app not found: $APP"; exit 1; }

# Sign helper frameworks/executables first, then the main bundle (bottom-up).
find "$APP/Contents/Frameworks" -name "*.app" -o -name "*.framework" -o -type f -perm +111 -name "*.dylib" 2>/dev/null | while read -r target; do
  codesign --force --sign - "$target" 2>/dev/null || true
done
codesign --force --deep --sign - "$APP"
echo "    signed: $(codesign -dv "$APP" 2>&1 | grep Identifier)"

echo "==> 3/3 repackage signed app into DMG"
npx electron-builder --mac --prepackaged "$APP"

echo "done: $(ls -lh "$ROOT/release/"*.dmg | awk '{print $NF, $5}')"
