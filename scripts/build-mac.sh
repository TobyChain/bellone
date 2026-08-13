#!/bin/bash
# Build Bellone for macOS with stable code-signing (noteone-dev cert).
#
# electron-builder skips signing when no Apple Developer identity is present,
# which leaves the bundle with Identifier=Electron and unsealed resources.
# That breaks the Dock icon and Spotlight indexing. This script:
#   1. packages the app (unpacked) with electron-builder
#   2. signs the .app with the stable noteone-dev cert so macOS TCC
#      permissions (Notifications) persist across rebuilds
#   3. repackages the signed app into the DMG + latest-mac.yml
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CERT="noteone-dev"
# Self-signed certs don't show in `find-identity -v` (invalid trust chain) but
# codesign accepts them by name. Only fall back to ad-hoc if signing actually fails.
try_sign() {
  codesign --force --sign "$CERT" "$1" 2>/dev/null && return 0
  echo "signing with '$CERT' failed; using ad-hoc" >&2
  codesign --force --sign - "$1"
}

echo "==> 1/3 compile TypeScript"
npm run build

echo "==> 2/3 package app (unpacked) + codesign"
npx electron-builder --mac --dir --config.asar=false
APP="$ROOT/release/mac-arm64/Bellone.app"
[ -d "$APP" ] || { echo "app not found: $APP"; exit 1; }

# Sign helper frameworks/executables first, then the main bundle (bottom-up).
find "$APP/Contents/Frameworks" -name "*.app" -o -name "*.framework" -o -type f -perm +111 -name "*.dylib" 2>/dev/null | while read -r target; do
  try_sign "$target" 2>/dev/null || true
done
try_sign "$APP"
echo "    signed: $(codesign -dv "$APP" 2>&1 | grep Identifier) cert=$CERT"

echo "==> 3/3 repackage signed app into DMG"
npx electron-builder --mac --prepackaged "$APP"

echo "done: $(ls -lh "$ROOT/release/"*.dmg | awk '{print $NF, $5}')"
