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
APP_ID="app.busybar-music"
LABEL="app.busybar-music.helper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
HELPER="$DIR/mac-helper/music_helper.py"
# The login item runs a copy from here: macOS doesn't let login items read Downloads,
# Desktop or Documents, where the unzipped folder often is.
RUN_DIR="$HOME/Library/Application Support/busybar-music"
LOG="$HOME/Library/Logs/busybar-music-helper.log"
# Names before 1.2.1, replaced (keeping the bar, password and key) on install.
OLD_APP_ID="io.github.devrsw.music"
OLD_LABEL="io.github.devrsw.busybar-music-helper"
OLD_PLIST="$HOME/Library/LaunchAgents/$OLD_LABEL.plist"

# What the last install chose, from the login item (or the one before 1.2.1).
# Empty on a first install: PlistBuddy reports a missing file or key on stdout, so its output
# only counts when it succeeds.
previous() {
  local plist value
  for plist in "$PLIST" "$OLD_PLIST"; do
    [ -f "$plist" ] && value="$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$1" "$plist" 2>/dev/null)" \
      && { printf '%s' "$value"; return 0; }
  done
  return 0
}

# Removes the login item and app installed under the names before 1.2.1.
remove_old() {
  launchctl bootout "gui/$(id -u)/$OLD_LABEL" 2>/dev/null || true
  rm -f "$OLD_PLIST"
  # `|| true`: under set -e a failure at the end of an && chain stops the script.
  [ -n "$1" ] && { bar -m 5 -X DELETE "http://$1/api/apps?app_id=$OLD_APP_ID" >/dev/null 2>&1 || true; }
  return 0
}

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
  rm -f "$PLIST" "$LOG"
  rm -rf "$RUN_DIR"
  for h in $HOST 10.0.4.20; do
    bar -m 5 -X POST "http://$h/api/apps/quit" >/dev/null 2>&1 || true
    if bar -m 5 -X DELETE "http://$h/api/apps?app_id=$APP_ID" >/dev/null 2>&1; then
      remove_old "$h"
      break
    fi
  done
  remove_old ""
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
mkdir -p "$HOME/Library/LaunchAgents" "$RUN_DIR" "$(dirname "$LOG")"
cp "$HELPER" "$RUN_DIR/music_helper.py"
: > "$LOG"  # a fresh log, so the checks below read only this run
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$(xml "$PY")</string><string>$(xml "$RUN_DIR/music_helper.py")</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>BUSYBAR_NAME</key><string>$(xml "$NAME")</string>
    <key>BUSYBAR_HOST</key><string>$(xml "$HOST")</string>
    <key>BUSYBAR_PASSWORD</key><string>$(xml "$PASSWORD")</string>
    <key>MUSIC_HELPER_KEY</key><string>$KEY</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG")</string>
</dict></plist>
EOF
chmod 600 "$PLIST"  # it holds the helper key and the bar's password
OLD_HELPER=""
[ -f "$OLD_PLIST" ] && OLD_HELPER=yes
remove_old ""  # the old login item, now its choices are copied: it holds the helper's port
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
# Up means listening and refusing a request without the key.
UP=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  [ "$(curl -s -o /dev/null -m 2 -w '%{http_code}' http://127.0.0.1:8765/now || true)" = 403 ] && { UP=yes; break; }
  sleep 1
done
if [ -z "$UP" ]; then
  echo "     the helper didn't start. The end of its log ($LOG):"
  tail -n 6 "$LOG" 2>/dev/null | sed 's/^/       /'
  exit 1
fi
echo "     helper running"
if [ -n "$OLD_HELPER" ] || bar -m 5 "http://$IP/api/apps/settings?app_id=$OLD_APP_ID" >/dev/null 2>&1; then
  bar -m 5 -X POST "http://$IP/api/apps/quit" >/dev/null 2>&1 || true
  remove_old "$IP"
  echo "     removed the older Music app and helper (io.github.devrsw.*)"
fi

echo "4/4  Launching the app on the bar..."
LAUNCH="$(curl -4 -s "${AUTH[@]}" -m 10 -X POST "http://$IP/api/apps/launch?app_id=$APP_ID" || true)"
case "$LAUNCH" in
  *'"OK"'*)
    echo "     running"
    # The helper logs the bar's first request; without one the bar can't reach this Mac.
    echo "     waiting for the bar to reach this Mac..."
    REACHED=""
    for i in $(seq 1 20); do
      grep -q "the bar at .* is connected" "$LOG" 2>/dev/null && { REACHED=yes; break; }
      sleep 1
    done
    if [ -n "$REACHED" ]; then
      echo "     connected"
    else
      echo "     the bar can't reach this Mac at $ADDRS."
      if /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>/dev/null | grep -q enabled; then
        echo "     The macOS firewall is on: allow python3 to accept incoming connections"
        echo "     (System Settings -> Network -> Firewall -> Options; add $PY if it isn't listed),"
        echo "     then run bash install.sh again."
      else
        echo "     Check the Mac and the bar are on the same network (a guest Wi-Fi may keep them apart)."
      fi
    fi
    ;;
  *priority*) echo "     not now: something with higher priority (a BUSY session?) has the screen; open Music from the APPS menu later" ;;
  *) echo "     the bar didn't start it (${LAUNCH:-no answer}); open Music from the APPS menu" ;;
esac
echo
echo "Done. Open it any time from the bar's APPS menu (\"Music\")."
echo "12/24-hour clock: the app's Time format setting (on the bar, or http://$IP -> Apps -> Music)."
