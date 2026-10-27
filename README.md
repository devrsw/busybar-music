# Music

Clock and Apple Music now playing, with play/pause and playlist shuffle

A JavaScript app for the BUSY Bar, generated from the BUSY JS app template. The bar can't reach the Music app itself, so a small helper on the Mac (`mac-helper/music_helper.py`, Python standard library only) answers its requests over the USB network.

## What it shows

Front (72×16):

| State | Screen |
|---|---|
| Nothing playing, or the Mac unreachable | large clock, centered, with `AM`/`PM` in 12-hour mode |
| Playing / paused | small clock (`4:46`, no AM/PM) and the song title on top (scrolls when long); play or pause icon and the track's progress bar below. The title and bar take the main color of the cover art, red when there's none |
| Lyrics (double-tap START) | the whole screen: the line being sung, centered on up to two lines in the cover's color. A line too long for two shows two rows at a time, spread over its time. The title, dimmed, before the first line and in instrumental breaks; `Lyrics...` while looking; `No lyrics` over the title when there are none |
| Picking a playlist | `SHUFFLE` · `3/23` · the playlist name under the knob |

## Controls

| Input | Action |
|---|---|
| **START** | Play / pause Apple Music (acts 0.4 s after the tap, to tell it from a double tap) |
| double-tap **START** | Show / hide lyrics |
| **Knob click** (OK) | Open the playlist picker · in the picker, shuffle-play the selected playlist from a random song |
| **Knob turn** | Right: next song · left: previous song · in the picker, choose a playlist |
| **BACK** | Close the picker · otherwise quit the app |

The picker closes by itself after 15 s without input.

## Setup

You need a Mac with Apple Music and a BUSY Bar (firmware API 27.12.0 or later) plugged in by USB.

### From a release

1. Download `busybar-music-<version>-mac.zip` from the [latest release](https://github.com/devrsw/busybar-music/releases/latest).
2. Unzip it and move the `busybar-music-<version>` folder where it can stay — the helper runs from it.
3. In Terminal, in that folder:

   ```sh
   bash install.sh             # app onto the bar + the helper as a login item, then launches the app
   bash install.sh uninstall   # removes both
   ```

The zip holds `install.sh`, `mac-helper/music_helper.py`, this README and the bar package (`dist/io.github.devrsw.music.tgz`). The release's `.tgz` on its own is just the bar app: without the helper it shows the clock and nothing else. No Node is needed; the helper needs Python 3 (`/opt/homebrew/bin/python3`, `/usr/local/bin/python3`, or Apple's `/usr/bin/python3` once the Xcode license is accepted).

### From a checkout

```sh
npm install
npm run build
bash install.sh
```

### What install.sh sets up

`install.sh` installs a LaunchAgent (`io.github.devrsw.busybar-music-helper`) that runs the helper at login and keeps it running; its log is `mac-helper/helper.log`. The first time, macOS asks to let `python3` control Music — allow it, or the bar can't read or control playback. macOS may also ask to let `python3` find devices on the local network; allowing it lets the helper keep the bar's **Mac helper** setting up to date if the Mac's USB address changes (System Settings → Privacy & Security → Local Network).

To move the folder later, run `bash install.sh uninstall` from the old place and `bash install.sh` from the new one.

The helper writes its own address into the app's **Mac helper** setting on the bar every minute, so nothing needs configuring as long as the bar is on USB.

| Setting | Default | |
|---|---|---|
| Time format | `12h` | `12h` or `24h`; picked up within a minute |
| Mac helper | `10.0.4.21:8765` | `IP:port` of the helper; set by the helper |

### Helper

| Endpoint | |
|---|---|
| `GET /now` | `{"state": "playing\|paused\|stopped\|off", "title", "artist", "position", "duration", "color"}` — seconds, and the cover's `#RRGGBB` |
| `GET /now?lyrics=1` | the same, plus `"lyric"`: `{"status": "ok", "index", "line", "since", "until"}` or `{"status": "loading" \| "none"}` |
| `POST /playpause` | |
| `POST /next`, `POST /previous` | skip a song |
| `GET /playlists` | your own playlists (not smart/system ones), cached 60 s |
| `POST /shuffle` `{"name"}` | shuffle on, play that playlist, skip to a random song |

**Cover color.** The helper exports the current track's artwork, shrinks it to 32×32 with `sips`, and picks the largest of twelve hue ranges among its colorful pixels, brightened to full strength for the LEDs. A hue needs at least 2% of the cover to beat grey and off-white backgrounds; an all-grey cover gives white. It's worked out once per album and cached.

**Lyrics.** The Music app doesn't share Apple Music's lyrics with scripts, so the helper looks up time-synced lyrics on [LRCLIB](https://lrclib.net), a free, open lyrics database — by title, artist, album and length (then looser searches: the first artist, the title without "(feat. ...)", matched on length), once per song (only while lyrics are on), cached for the last 32 songs and retried after 5 minutes when a lookup fails. Songs without synced lyrics there show `No lyrics`. Text the bar's ASCII fonts can't show (Korean, Japanese, ...) is dropped and accents are stripped. While lyrics are on and a song plays, the bar polls just after each line is due (at most every 300 ms, usually every 2–4 s) instead of every 3 s.

It only answers `10.0.4.x` (the bar over USB) and this Mac. For a bar on Wi-Fi, run it with `BUSYBAR_HOST=<bar ip>` and `MUSIC_HELPER_ALLOW=<bar ip>`.

**Requests.** The bar polls `/now` every 3 s while the helper answers, backing off from 5 s to a minute when it doesn't (Mac asleep, helper stopped), and shows the clock alone meanwhile. Between polls the bar counts the track position on by itself and redraws only when the progress bar gains a pixel (every few seconds for a typical song). The clock redraws once a minute; only changed elements are sent, plus the whole frame once a minute in case another app or a notification took the screen.

Icons are generated by `python3 scripts/icons.py`.

**Installing.** `npm run app:install` with busy-cli 0.6 failed against firmware 27.14.0 (the stage response closes early); `install.sh` uses `curl` for the same two calls and works.

## Getting started

```sh
npm install
npm run build         # build the app into dist/io.github.devrsw.music.tgz
npm run app:install   # install it on the BUSY Bar connected over USB
npm run app:run       # launch the installed app
```

The app's id is `io.github.devrsw.music`, set in `src/appmeta/manifest.json`. An id is `<namespace>.<app>`, at most 32 characters, made of Latin letters, digits, underscores, dashes, and dots, and not starting with a dot. If yours still says `app.example`, change it to your own namespace before publishing.

## Layout

`src/` is the app — everything in it is yours to edit.

The entry point is `src/main.ts` (or `src/main.js`). The name is fixed: the build turns it into `scripts/main.js`, the file the BUSY Bar starts. Any imported modules are emitted as separate files alongside it in `scripts/`, unless `npm run build -- --bundle` inlines them.

`src/main.ts` is run from top to bottom, not imported: it starts the app by calling `main()` at the end and must not export anything. Imported modules can use standard exports.

```
my-app/
├── src/                          the app
│   ├── main.ts                   the entry point: function main(), called at the end
│   ├── appmeta/
│   │   ├── manifest.json         id, name, version, api_version
│   │   ├── settings.json         the settings screen — optional
│   │   ├── icon_front_8x8.png    front icon, 8×8 color — optional
│   │   └── icon_back_11x11.png   back icon, 11×11 grayscale — optional
│   ├── images/
│   ├── animations/
│   └── sounds/
├── shared/                       app-level helpers, imported as @shared/*
```

Both icons are optional; without them a default is used.

## Resources

Anything in `src/` that isn't a source file is copied into the package, sorted by what the BUSY Bar can read:

| Extension | Destination |
| --- | --- |
| `.png` `.image` | `images/` |
| `.anim` | `animations/` |
| `.snd` | `sounds/` |
| anything else | `resources/` |

A file in `src/images`, `src/animations` or `src/sounds` keeps its folder as long as the BUSY Bar reads its format.

`images/`, `animations/` and `sounds/` hold only those formats. An image, animation or sound in another format — `.jpg`, `.gif`, `.svg`, `.wav`, `.mp3` and the like — goes to `resources/`, and the build warns that the device cannot read it.

Everything the app draws goes through the layout helpers in `@busy-app/busy-lib`: build a tree out of `row` / `column` / `stack`, hand it to `render()`, and send the result with `device.DisplayDraw()`. The screen is 72×16 pixels.

## Input

`listen("input", handler)` delivers the device keys: `ok`, `start` and `back` with a `press` / `release` / `short` / `long` / `repeat` action, and `encoder` with a `delta` of `1` or `-1`. It returns an unbind function.

Use `short` as the default action for a button press: it fires once, after a normal press and release. `press` fires immediately on key down and is followed by `short`, so handling `press` as a tap can react twice. Use `long` and `repeat` for hold gestures.

## Commands

| Command | Description |
| --- | --- |
| `npm run build` | empties `dist/` and builds the package into `dist/io.github.devrsw.music.tgz` |
| `npm run build -- --emit dir` | leaves the `io.github.devrsw.music/` folder instead of the `.tgz` |
| `npm run build -- --emit both` | leaves the folder and the `.tgz` |
| `npm run build -- --out <path>` | builds into `<path>` instead, replacing only this app's package there |
| `npm run build -- --tgz-name <name>` | names the `.tgz`, e.g. `"{id}-{version}.tgz"` |
| `npm run build -- --no-minify` | readable output, for debugging |
| `npm run build -- --bundle` | inlines every module into one `main.js` |
| `npm run build -- --addr <host>` | sets the BUSY Bar address the app connects to, `localhost` by default |
| `npm run typecheck` | type-checks the app |
| `npm run app:install` | installs `dist/io.github.devrsw.music.tgz` on the BUSY Bar; build it first with `npm run build` |
| `npm run app:uninstall` | removes the app from the BUSY Bar, keeping its settings |
| `npm run app:run` | launches the installed app |
| `npm run app:stop` | quits the running app |

The four `app:` commands talk to the BUSY Bar connected over USB. For a device connected over Wi-Fi, pass `--addr <host>` with its network IP address or hostname, and `--password <password>` if password protection is enabled:

```sh
npm run app:install -- --addr <host>
npm run app:install -- --addr <host> --password <password>
```

## Build output

The package folder is named after the app id:

```
dist/
└── io.github.devrsw.music/
    ├── appmeta/manifest.json
    ├── scripts/main.js
    └── images/ animations/ sounds/ resources/
```

By default the build packs that folder into `dist/io.github.devrsw.music.tgz`, with the folder itself at the root of the archive, and removes the folder; `--emit dir` keeps only the folder, `--emit both` keeps both. `--tgz-name` gives the archive another name; `{id}` and `{version}` in it are replaced with the manifest values.

## Releasing

Pushing a git tag matching the manifest `version` (e.g. `1.1.0`) builds the app and attaches `io.github.devrsw.music-<version>.tgz` and `busybar-music-<version>-mac.zip` (installer, helper and app) to a GitHub release, with install steps in the notes. The release notes open with the app's name, id, version and API version. The release fails when the tag differs from the manifest `version`.

## Manifest

`src/appmeta/manifest.json` carries the app's identity and a couple of knobs (see the [apps documentation](https://github.com/busy-app/busybar-firmware/blob/dev/documentation/JavaScript%20Applications.dox.md)):

| Field | Description |
| --- | --- |
| `format_version` | manifest format, `1` — required |
| `id` | up to 32 characters — required |
| `name` | display name — required |
| `version` | semver, e.g. `1.0.0` — required |
| `api_version` | minimum BUSY Bar HTTP API version the app needs, e.g. `27.12.0` — required |
| `description`, `author` | free form, default `""` |
| `heap_size_kib` | memory for the app heap, 1–512, default 128 |
| `debug` | when true, shown only in developer mode, default false |

Raise `heap_size_kib` if the app runs out of memory.

## Node version

The app builds on Node 24 — the version in `.nvmrc` and the range `engines` allows. Node 26 breaks the build and is excluded. With `fnm` or `nvm` installed, `fnm use` / `nvm use` picks the right one up from `.nvmrc`.

## Settings

To give the app a settings screen, add `src/appmeta/settings.json` describing the fields, then read the stored values:

```ts
import { loadValues } from "@shared/settings";

const values = await loadValues();
```

`loadValues()` returns `null` when nothing is stored yet — use the defaults.
