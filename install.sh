#!/bin/bash
# Run from the unzipped busybar-music-<version>-mac.zip of a GitHub release, or from a
# checkout after `npm run build`:
# 1) installs the "Music" app onto the BUSY Bar (USB, 10.0.4.20)
# 2) installs the small Music helper on this Mac (starts at login)
# 3) launches the app on the bar
#
#   bash install.sh             install / update everything
#   bash install.sh uninstall   remove the helper and the app
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
BAR="${BUSYBAR_HOST:-10.0.4.20}"
APP_ID="io.github.devrsw.music"
LABEL="io.github.devrsw.busybar-music-helper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# The first python3 that runs: /usr/bin/python3 is a stub until the Xcode license is accepted.
PY=""
for p in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  [ -x "$p" ] && "$p" -c "" 2>/dev/null && { PY="$p"; break; }
done

if [ "$1" = "uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  curl -s -X POST "http://$BAR/api/apps/quit" >/dev/null || true
  curl -s -X DELETE "http://$BAR/api/apps?app_id=$APP_ID" >/dev/null || true
  echo "Removed."
  exit 0
fi

PKG="$DIR/dist/$APP_ID.tgz"
[ -f "$PKG" ] || { echo "No $PKG: run npm run build first, or use the -mac.zip from a GitHub release"; exit 1; }

[ -n "$PY" ] || { echo "No working python3 found (install one, e.g. brew install python)"; exit 1; }

echo "1/3  Installing the app on the BUSY Bar at $BAR..."
curl -sf -m 5 "http://$BAR/api/version" >/dev/null || { echo "Can't reach the bar at $BAR - is it plugged in by USB?"; exit 1; }
STAGE=$(curl -sf -m 60 -X POST "http://$BAR/api/apps/stage" --data-binary "@$PKG")
KEY=$(printf '%s' "$STAGE" | "$PY" -c 'import sys,json; print(json.load(sys.stdin)["install_key"])')
curl -sf -m 60 -X POST "http://$BAR/api/apps/install?install_key=$KEY" >/dev/null
echo "     installed"

echo "2/3  Installing the Music helper on this Mac..."
echo "     (macOS may ask to let python3 control Music - click OK)"
/usr/bin/osascript -e 'tell application "Music" to get player state' >/dev/null 2>&1 || true
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$PY</string><string>$DIR/mac-helper/music_helper.py</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>BUSYBAR_HOST</key><string>$BAR</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/mac-helper/helper.log</string>
  <key>StandardErrorPath</key><string>$DIR/mac-helper/helper.log</string>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 3
tail -n 3 "$DIR/mac-helper/helper.log" 2>/dev/null | sed 's/^/     /'

echo "3/3  Launching the app on the bar..."
curl -sf -m 10 -X POST "http://$BAR/api/apps/launch?app_id=$APP_ID" >/dev/null && echo "     running"
echo
echo "Done. Open it any time from the bar's APPS menu (\"Music\")."
echo "12/24-hour clock: the app's Time Format setting (bar settings or http://$BAR)."
