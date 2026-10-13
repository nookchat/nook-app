#!/usr/bin/env bash
#
# Builds the iOS app for the App Store, and with --upload sends it to App Store Connect.
#
#   1. It stops when NOOK_URL is set, because that ships a build that opens a dev server.
#   2. It runs `cap sync ios`, so the Xcode project matches capacitor.config.ts.
#   3. It checks that the synced config opens the home site.
#   4. It sets the version from package.json, and a build number from the time, which only goes up.
#   5. It archives the App scheme in Release, and exports a signed .ipa into ios/output/.
#   6. With --upload, it sends the .ipa to App Store Connect, for TestFlight and review.
#
# Usage:
#   scripts/ios-release.sh            archive and export the .ipa
#   scripts/ios-release.sh --upload   then upload it
#
# Signing and the upload use an App Store Connect API key. ASC_KEY_ID and ASC_ISSUER_ID choose
# another key; the issuer ID is at the top of App Store Connect, Users and Access, Integrations.
# The key file must be ~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8.
set -euo pipefail

HOME_URL="https://www.nookchat.app"
TEAM_ID="743WM69T3V"
PROJECT="ios/App/App.xcodeproj"
OUT="ios/App/output"
ARCHIVE="$OUT/App.xcarchive"

UPLOAD=0
for arg in "$@"; do
  case "$arg" in
    --upload) UPLOAD=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."

step() { printf '\n\033[1;36m> %s\033[0m\n' "$1"; }
die() { printf '\n\033[1;31mx %s\033[0m\n' "$1" >&2; exit 1; }

[[ -z "${NOOK_URL:-}" ]] || die "NOOK_URL is set ($NOOK_URL). A release opens $HOME_URL. Run: unset NOOK_URL"

ASC_KEY_ID="${ASC_KEY_ID:-5T3U5DDDLD}"
ASC_ISSUER_ID="${ASC_ISSUER_ID:-bf9215fe-5a82-4d72-a0d4-70dda86f8661}"
KEY="$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8"
[[ -f "$KEY" ]] || die "There is no key at $KEY."
AUTH=(-authenticationKeyPath "$KEY" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")

step "Syncing Capacitor"
npx cap sync ios

step "Checking that the app opens $HOME_URL"
SYNCED=$(plutil -extract server.url raw -o - ios/App/App/capacitor.config.json)
[[ "$SYNCED" == "$HOME_URL" ]] || die "The synced config opens $SYNCED, not $HOME_URL."

VERSION=$(node -p "require('./package.json').version")
BUILD=$(date -u +%Y%m%d%H%M)
echo "   version $VERSION, build $BUILD"

step "Archiving"
rm -rf "$ARCHIVE"
mkdir -p "$OUT"
xcodebuild archive \
  -project "$PROJECT" \
  -scheme App \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates \
  "${AUTH[@]}" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  MARKETING_VERSION="$VERSION" \
  CURRENT_PROJECT_VERSION="$BUILD"

step "Exporting the signed .ipa"
cat > "$OUT/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>destination</key><string>$([[ "$UPLOAD" == "1" ]] && echo upload || echo export)</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>uploadSymbols</key><true/>
  <key>signingStyle</key><string>automatic</string>
</dict>
</plist>
PLIST
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$OUT/ExportOptions.plist" \
  -exportPath "$OUT" \
  -allowProvisioningUpdates \
  "${AUTH[@]}"

if [[ "$UPLOAD" == "1" ]]; then
  echo "   Uploaded. App Store Connect takes 5 to 30 minutes to process it. Then it shows in TestFlight."
else
  echo "   The .ipa is in $OUT. Run again with --upload to send it to App Store Connect."
fi
