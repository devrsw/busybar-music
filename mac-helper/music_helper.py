#!/usr/bin/env python3
"""
Music helper for the BUSY Bar "Music" app.

The app runs on the BUSY Bar, but only the Mac can talk to the Music app,
so this tiny server answers the bar's requests:

  GET  /now         {"state": "playing|paused|stopped|off", "title", "artist",
                     "position", "duration" (seconds), "color" ("#RRGGBB" from the cover, or null)}
  GET  /now?lyrics=1 the same, plus "lyric": the line being sung, from lrclib.net
  POST /playpause
  POST /next, /previous
  GET  /playlists   ["Chill", "Road Trip", ...]
  POST /shuffle     {"name": "Road Trip"}  -> shuffle-play from a random song

It also writes its own address into the app's "Mac address" setting on the
bar, so nothing needs configuring. Only the bar (USB network 10.0.4.x) and
this Mac may connect by default. Standard library only.
"""

import colorsys
import json
import os
import re
import socket
import struct
import subprocess
import tempfile
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BAR = os.environ.get("BUSYBAR_HOST", "10.0.4.20")
PORT = int(os.environ.get("MUSIC_HELPER_PORT", "8765"))
APP_ID = "net.scottdevries.music"
# The bar over USB is 10.0.4.x; set MUSIC_HELPER_ALLOW (comma-separated prefixes) for a bar on Wi-Fi.
ALLOWED_PREFIXES = tuple(os.environ.get("MUSIC_HELPER_ALLOW", "10.0.4.,127.0.0.1").split(","))


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


# ------------------------------------------------------------ Apple Music --

def osascript(script, *args, timeout=10):
    try:
        out = subprocess.run(["osascript", "-e", script, *args],
                             capture_output=True, text=True, timeout=timeout)
        return out.stdout.rstrip("\n") if out.returncode == 0 else None
    except Exception:
        return None


NOW = r'''
if application "Music" is running then
  tell application "Music"
    set ps to player state as text
    if ps is "stopped" then return "stopped"
    try
      set t to current track
      return ps & tab & (name of t) & tab & (artist of t) & tab & (album of t) & tab & (player position as text) & tab & (duration of t as text)
    on error
      return ps
    end try
  end tell
else
  return "off"
end if
'''

PLAYLISTS = r'''
tell application "Music"
  set AppleScript's text item delimiters to linefeed
  return (name of every user playlist whose special kind is none) as text
end tell
'''

ARTWORK = r'''
on run argv
  tell application "Music"
    if (count of artworks of current track) is 0 then return "none"
    set d to raw data of artwork 1 of current track
  end tell
  set f to open for access POSIX file (item 1 of argv) with write permission
  try
    set eof f to 0
    write d to f
  end try
  close access f
  return "ok"
end run
'''

PLAYPAUSE = 'tell application "Music" to playpause'
NEXT = 'tell application "Music" to next track'
PREVIOUS = 'tell application "Music" to previous track'

SHUFFLE = r'''
on run argv
  tell application "Music"
    set shuffle enabled to true
    set shuffle mode to songs
    play user playlist (item 1 of argv)
    try
      next track
    end try
  end tell
end run
'''

_playlists_cache = (0.0, [])


def seconds(text):
    # AppleScript prints reals in the Mac's locale, e.g. "12,5".
    try:
        return round(float(text.replace(",", ".")), 1)
    except ValueError:
        return 0


def now_playing(with_lyrics=False):
    raw = osascript(NOW) or "off"
    state, title, artist, album, position, duration = (raw.split("\t") + [""] * 5)[:6]
    out = {"state": state, "title": title, "artist": artist,
           "position": seconds(position), "duration": seconds(duration), "color": None}
    if title:
        out["color"] = cover_color((artist, album or title))
        if with_lyrics:
            out["lyric"] = lyric_at((title, artist, album, round(out["duration"])), out["position"])
    return out


# ---------------------------------------------------------------- lyrics --
# Time-synced lyrics come from LRCLIB (https://lrclib.net), a free, open lyrics
# database: the Music app doesn't share Apple Music's lyrics with scripts. Only a
# song's title, artist, album and length are sent, once per song.

LRCLIB = "https://lrclib.net/api"
_lyrics = {}  # key -> [(start seconds, line)], [] when there are none, None while looking
_lyrics_failed = {}  # key -> when a lookup last failed; retried after LYRICS_RETRY_S
_lyrics_lock = threading.Lock()
LYRICS_RETRY_S = 300


def plain(text):
    """ASCII for the bar's fonts: accents dropped rather than whole letters."""
    text = text.replace("\u2019", "'").replace("\u2018", "'").replace("\u201c", '"').replace("\u201d", '"')
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    # Brackets left empty by dropped scripts (Korean, Japanese, ...), and the gaps they leave.
    text = re.sub(r"\(\s*\)|\[\s*\]", "", text)
    text = re.sub(r"\s+([,.!?])", r"\1", re.sub(r"\s+", " ", text))
    return text.strip(" ,")


def parse_lrc(lrc):
    lines = []
    for row in lrc.splitlines():
        stamps = []
        while row.startswith("[") and "]" in row:
            stamp, row = row[1:].split("]", 1)
            try:
                m, sec = stamp.split(":")
                stamps.append(int(m) * 60 + float(sec))
            except ValueError:
                break  # a tag like [ar:...], not a time
        lines += [(t, plain(row)) for t in stamps]
    return sorted(lines)


def lrclib(path, params):
    url = "%s/%s?%s" % (LRCLIB, path, urllib.parse.urlencode(params))
    req = urllib.request.Request(url, headers={"User-Agent": "busybar-music (github.com/busy-app)"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise


def look_up(key):
    title, artist, album, duration = key
    lines = []
    try:
        # Music lists every artist ("K/DA, League of Legends Music & ...") and features in
        # the title, where LRCLIB often has only the first: after the exact match, search
        # looser, matching on length.
        first = re.split(r",|&| feat\.| ft\.| x ", artist)[0].strip()
        bare = re.sub(r"\s*[(\[](feat|ft|with)\.?\s[^)\]]*[)\]]", "", title, flags=re.I).strip()
        searches = [("get", {"track_name": title, "artist_name": artist, "album_name": album, "duration": duration}),
                    ("search", {"track_name": title, "artist_name": artist}),
                    ("search", {"track_name": bare, "artist_name": first}),
                    ("search", {"q": "%s %s" % (bare, first)})]
        hit, errors = None, 0
        for path, params in searches:
            try:
                found = lrclib(path, params)
            except Exception:
                errors += 1  # LRCLIB answers some requests with a 503; try the next
                continue
            found = [found] if isinstance(found, dict) else found or []
            hit = next((h for h in found if h.get("syncedLyrics")
                        and abs((h.get("duration") or 0) - duration) <= 3), None)
            if hit:
                break
        if errors == len(searches):
            raise RuntimeError("every request failed")
        if hit:
            lines = parse_lrc(hit["syncedLyrics"])
        log("lyrics for %r: %s" % (title, "%d lines" % len(lines) if lines else "none"))
    except Exception as exc:
        log("lyrics lookup failed for %r (%s)" % (title, exc))
        with _lyrics_lock:
            _lyrics[key] = []
            _lyrics_failed[key] = time.time()
        return
    with _lyrics_lock:
        _lyrics[key] = lines


def lyric_at(key, position):
    """{"status": "ok", "index", "line", "since", "until"} for the line sung at `position`,
    or {"status": "loading" | "none"}. `since` is seconds since the line started, `until`
    seconds to the next one."""
    with _lyrics_lock:
        if time.time() - _lyrics_failed.get(key, time.time()) > LYRICS_RETRY_S:
            del _lyrics[key], _lyrics_failed[key]
        if key not in _lyrics:
            if len(_lyrics) >= 32:
                _lyrics.clear()
                _lyrics_failed.clear()
            _lyrics[key] = None
            threading.Thread(target=look_up, args=(key,), daemon=True).start()
        lines = _lyrics.get(key)
    if lines is None:
        return {"status": "loading"}
    if not lines:
        return {"status": "none"}
    index = -1
    for i, (start, _) in enumerate(lines):
        if start > position:
            break
        index = i
    nxt = lines[index + 1][0] if index + 1 < len(lines) else key[3]
    since = position - lines[index][0] if index >= 0 else position
    return {"status": "ok", "index": index, "line": lines[index][1] if index >= 0 else "",
            "since": round(max(0, since), 2), "until": round(max(0, nxt - position), 2)}


# ----------------------------------------------------------- cover color --

_colors = {}
_colors_lock = threading.Lock()


def cover_color(key):
    """The cover's main color, worked out once per album."""
    with _colors_lock:
        if key in _colors:
            return _colors[key]
        color = None
        with tempfile.TemporaryDirectory() as tmp:
            art, bmp = os.path.join(tmp, "art"), os.path.join(tmp, "art.bmp")
            if osascript(ARTWORK, art) == "ok":
                done = subprocess.run(["sips", "-s", "format", "bmp", "-z", "32", "32", art, "--out", bmp],
                                      capture_output=True)
                if done.returncode == 0:
                    color = main_color(bmp)
        if len(_colors) >= 64:
            _colors.clear()
        _colors[key] = color
        return color


def main_color(path):
    """The cover's most common colorful hue, brightened to full LED strength.

    Off-white and grey backgrounds make dull LED text, so the biggest of twelve hue
    ranges wins over them when it covers at least 2% of the cover; an all-grey cover
    gives white.
    """
    data = open(path, "rb").read()
    offset, = struct.unpack_from("<I", data, 10)
    width, height = struct.unpack_from("<ii", data, 18)
    bpp, = struct.unpack_from("<H", data, 28)
    if bpp not in (24, 32):
        return None
    step = bpp // 8
    stride = (width * step + 3) // 4 * 4
    buckets = {}
    for y in range(abs(height)):
        row = offset + y * stride
        for x in range(width):
            b, g, r = data[row + x * step:row + x * step + 3]
            hi, lo = max(r, g, b), min(r, g, b)
            if hi < 50 or (hi - lo) / hi < 0.35:
                continue  # dark or greyish
            k = int(colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)[0] * 12) % 12
            n, sr, sg, sb = buckets.get(k, (0, 0, 0, 0))
            buckets[k] = (n + 1, sr + r, sg + g, sb + b)
    n, sr, sg, sb = max(buckets.values(), default=(0, 0, 0, 0))
    if n < 0.02 * width * abs(height):
        return "#FFFFFF"
    scale = 255 / max(sr, sg, sb)
    return "#%02X%02X%02X" % (round(sr * scale), round(sg * scale), round(sb * scale))


# ------------------------------------------------------------------ server --

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _allowed(self):
        if self.client_address[0].startswith(ALLOWED_PREFIXES):
            return True
        self._send(403, {"error": "forbidden"})
        return False

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return {}

    def do_GET(self):
        if not self._allowed():
            return
        url = urllib.parse.urlsplit(self.path)
        if url.path == "/now":
            self._send(200, now_playing("lyrics=1" in url.query))
        elif url.path == "/playlists":
            self._send(200, playlists())
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._allowed():
            return
        body = self._body()
        if self.path == "/playpause":
            osascript(PLAYPAUSE)
            self._send(200, {"result": "OK"})
        elif self.path in ("/next", "/previous"):
            osascript(NEXT if self.path == "/next" else PREVIOUS)
            self._send(200, {"result": "OK"})
        elif self.path == "/shuffle" and body.get("name"):
            log("shuffle-playing %r" % body["name"])
            osascript(SHUFFLE, str(body["name"]), timeout=30)
            self._send(200, {"result": "OK"})
        else:
            self._send(404, {"error": "not found"})


# --------------------------------------------- tell the bar where we are --

def my_ip_towards(host):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect((host, 80))
        return s.getsockname()[0]
    finally:
        s.close()


def bar_request(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request("http://%s%s" % (BAR, path), data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read() or b"{}")


def keep_bar_pointed_here():
    last = None
    while True:
        try:
            addr = "%s:%d" % (my_ip_towards(BAR), PORT)
            if addr != last:
                path = "/api/apps/settings?app_id=" + APP_ID
                doc = bar_request("GET", path)
                if doc.get("values", {}).get("mac_address") != addr:
                    doc["values"]["mac_address"] = addr
                    bar_request("PUT", path, doc)
                    log("told the bar to find me at %s" % addr)
                last = addr
        except Exception as exc:
            last = None
            log("can't reach the bar yet (%s)" % exc)
        time.sleep(60)


if __name__ == "__main__":
    threading.Thread(target=keep_bar_pointed_here, daemon=True).start()
    log("Music helper listening on port %d" % PORT)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
