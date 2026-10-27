#!/bin/bash
# Run from the unzipped busybar-music-<version>-mac.zip of a GitHub release, or from a
# checkout after `npm run build`:
# 1) finds your BUSY Bar on the Wi-Fi (Bonjour) or over USB
# 2) installs the "Music" app onto it
# 3) installs the small Music helper on this Mac (starts at login) and points the app at it
# 4) launches the app on the bar
#
#   bash install.sh                       install / update; asks which bar when it finds several
#   bash install.sh --name "My BUSY Bar"  pick the bar by (part of) its name
#   bash install.sh --password <pw>       the bar's HTTP API password, if Wi-Fi access has one
#   bash install.sh uninstall             remove the helper and the app
#
# An update reuses the bar, password and key from the last install.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ID="io.github.devrsw.music"
LABEL="io.github.devrsw.busybar-music-helper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
HELPER="$DIR/mac-helper/music_helper.py"

# What the last install chose, from the login item.
previous() { /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$1" "$PLIST" 2>/dev/null || true; }

ACTION=install NAME="" PASSWORD=""
while [ $# -gt 0 ]; do
  case "$1" in
    uninstall) ACTION=uninstall ;;
    --name) NAME="$2"; shift ;;
    --password) PASSWORD="$2"; shift ;;
    *) echo "Unknown option $1 (see the top of install.sh)"; exit 1 ;;
  esac
  shift
done
NAME="${NAME:-$(previous BUSYBAR_NAME)}"
PASSWORD="${PASSWORD:-$(previous BUSYBAR_PASSWORD)}"
export BUSYBAR_PASSWORD="$PASSWORD"
AUTH=()
[ -n "$PASSWORD" ] && AUTH=(-H "X-API-Token: $PASSWORD")
bar() { curl -4 -sf "${AUTH[@]}" "$@"; }

# The first python3 that runs: /usr/bin/python3 is a stub until the Xcode license is accepted.
PY=""
for p in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  [ -x "$p" ] && "$p" -c "" 2>/dev/null && { PY="$p"; break; }
done
[ -n "$PY" ] || { echo "No working python3 found (install one, e.g. brew install python)"; exit 1; }

if [ "$ACTION" = uninstall ]; then
  HOST="$(previous BUSYBAR_HOST)"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  for h in $HOST 10.0.4.20; do
    bar -m 5 -X POST "http://$h/api/apps/quit" >/dev/null 2>&1 || true
    bar -m 5 -X DELETE "http://$h/api/apps?app_id=$APP_ID" >/dev/null 2>&1 && break
  done
  echo "Removed."
  exit 0
fi

PKG="$DIR/dist/$APP_ID.tgz"
[ -f "$PKG" ] || { echo "No $PKG: run npm run build first, or use the -mac.zip from a GitHub release"; exit 1; }

echo "1/4  Looking for your BUSY Bar..."
FOUND="$("$PY" "$HELPER" --find "$NAME")" || exit 1
IFS=$'\t' read -r IP HOST NAME <<< "$FOUND"
echo "     $NAME ($HOST, $IP)"

echo "2/4  Installing the app on the bar..."
bar -m 5 "http://$IP/api/version" >/dev/null || {
  echo "     $NAME doesn't answer. If its Wi-Fi API access has a password, pass --password <pw>."; exit 1; }
STAGE=$(bar -m 60 -X POST "http://$IP/api/apps/stage" --data-binary "@$PKG")
INSTALL_KEY=$(printf '%s' "$STAGE" | "$PY" -c 'import sys,json; print(json.load(sys.stdin)["install_key"])')
bar -m 60 -X POST "http://$IP/api/apps/install?install_key=$INSTALL_KEY" >/dev/null
echo "     installed"

echo "3/4  Installing the Music helper on this Mac..."
echo "     (macOS may ask to let python3 control Music, and to find devices on the local network - allow both)"
/usr/bin/osascript -e 'tell application "Music" to get player state' >/dev/null 2>&1 || true
KEY="$(previous MUSIC_HELPER_KEY)"
[ -n "$KEY" ] || KEY="$("$PY" -c 'import secrets; print(secrets.token_urlsafe(18))')"
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$(xml "$PY")</string><string>$(xml "$HELPER")</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>BUSYBAR_NAME</key><string>$(xml "$NAME")</string>
    <key>BUSYBAR_HOST</key><string>$(xml "$HOST")</string>
    <key>BUSYBAR_PASSWORD</key><string>$(xml "$PASSWORD")</string>
    <key>MUSIC_HELPER_KEY</key><string>$KEY</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml "$DIR")/mac-helper/helper.log</string>
  <key>StandardErrorPath</key><string>$(xml "$DIR")/mac-helper/helper.log</string>
</dict></plist>
EOF
chmod 600 "$PLIST"  # it holds the helper key and the bar's password
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# The old helper takes a moment to unload; loading before it's gone fails.
for i in 1 2 3 4 5 6 7 8 9 10; do
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null && break
  [ "$i" = 10 ] && { echo "     couldn't start the helper (launchctl bootstrap)"; exit 1; }
  sleep 1
done
# Point the app at this Mac now, from this terminal: the login item keeps it current
# once macOS lets it on the local network.
ADDRS="$(BUSYBAR_NAME="$NAME" BUSYBAR_HOST="$HOST" MUSIC_HELPER_KEY="$KEY" "$PY" "$HELPER" --configure)"
echo "     the bar will reach this Mac at $ADDRS"

echo "4/4  Launching the app on the bar..."
bar -m 10 -X POST "http://$IP/api/apps/launch?app_id=$APP_ID" >/dev/null && echo "     running"
echo
echo "Done. Open it any time from the bar's APPS menu (\"Music\")."
echo "12/24-hour clock: the app's Time format setting (on the bar, or http://$IP -> Apps -> Music)."
