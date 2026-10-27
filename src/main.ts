import { device } from "@shared/device";
import { loadValues, type SettingsValues } from "@shared/settings";
import { generateXpm2, textWidth } from "@busy-app/busy-lib";
import manifest from "./appmeta/manifest.json";

/** The name the app draws under; the device clears elements by this id. */
const APP = manifest.id;

type Element = Parameters<typeof device.DisplayDraw>[0]["elements"][number];

/** How often the Mac helper is asked what's playing while it answers. */
const POLL_MS = 3 * 1000;
/** After a failed poll: 5 s, doubling to a minute. */
const RETRY_MS = 5 * 1000;
const MAX_BACKOFF_MS = 60 * 1000;
/** Now playing is dropped (clock only) when the helper hasn't answered for this long. */
const STALE_MS = 15 * 1000;
const PICKER_IDLE_MS = 15 * 1000;
const MAX_PLAYLISTS = 200;
/** A second START tap within this toggles lyrics instead of play/pause. */
const DOUBLE_TAP_MS = 400;
/** Knob clicks queued for skipping while one is being sent, each way. */
const MAX_SKIPS = 5;
const DEFAULT_MAC = "10.0.4.21:8765";

const WHITE = "#FFFFFFFF";
const DIM = "#FFFFFF80";
const LABEL = "#808080FF";
/** Text and progress color when the cover gives none. */
const RED = "#FA2D48FF";
/** The progress bar spans x 6–71, after the play/pause icon. */
const BAR_X = 6;
const BAR_W = 72 - BAR_X;

// Literal `font:` properties tell the build which glyph maps to bundle for textWidth().
const TINY = { font: "tiny" } as const;
const SMALL = { font: "small" } as const;
const XL = { font: "extra_large" } as const;

const PLAY_ICON = generateXpm2({
  palette: { "#": WHITE.slice(0, 7), ".": "none" },
  grid: ["#...", "##..", "###.", "##..", "#..."],
});
const PAUSE_ICON = generateXpm2({
  palette: { "#": WHITE.slice(0, 7), ".": "none" },
  grid: ["#.#", "#.#", "#.#", "#.#", "#.#"],
});

const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Printable ASCII only: the fonts are bitmap ASCII. Common typography is swapped for its plain form. */
const ascii = (text: string) =>
  text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E]/g, "")
    .trim();

interface Config {
  h24: boolean;
  /** host:port addresses of the Music helper on the Mac, Wi-Fi first; the helper keeps them current. */
  macs: string[];
  /** Sent with every request; the helper refuses requests without it. */
  key: string;
}

function readConfig(values: SettingsValues | null): Config {
  const v = values ?? {};
  const macs = (typeof v.mac_address === "string" ? v.mac_address : "")
    .split(",")
    .map((m) => m.trim().replace(/^https?:\/\//, "").replace(/\/+$/, ""))
    .filter((m) => m !== "");
  return {
    h24: v.time_format === "24h",
    macs: macs.length ? macs : [DEFAULT_MAC],
    key: typeof v.helper_key === "string" ? v.helper_key.trim() : "",
  };
}

type PlayerState = "playing" | "paused" | "stopped" | "off";

interface NowPlaying {
  state: PlayerState;
  title: string;
  /** Seconds into the track at `at` (ms), and its length; 0 when unknown. */
  position: number;
  duration: number;
  at: number;
  /** The cover's main color, `#RRGGBBAA`. */
  color: string;
  /** The line being sung, when lyrics were asked for. */
  lyric: Lyric | null;
}

type Lyric =
  | { status: "loading" }
  | { status: "none" }
  /** `index` -1 is before the first line; `since`/`until` are seconds from the line's start and to the next one. */
  | { status: "ok"; index: number; line: string; since: number; until: number };

function readLyric(raw: unknown): Lyric | null {
  const r = (raw && typeof raw === "object" ? raw : null) as Record<string, unknown> | null;
  if (!r) return null;
  if (r.status === "loading") return { status: "loading" };
  if (r.status === "none") return { status: "none" };
  if (r.status !== "ok") return null;
  return {
    status: "ok",
    index: typeof r.index === "number" ? r.index : -1,
    line: typeof r.line === "string" ? ascii(r.line) : "",
    since: typeof r.since === "number" && isFinite(r.since) ? Math.max(0, r.since) : 0,
    until: typeof r.until === "number" && isFinite(r.until) ? Math.max(0, r.until) : 0,
  };
}

/** Word-wraps `small` text into lines no wider than the screen; a word wider than that is split. */
function wrap(text: string): string[] {
  const fits = (t: string) => textWidth(t, SMALL.font) <= 72;
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(" ")) {
    if (!word) continue;
    const next = cur ? `${cur} ${word}` : word;
    if (fits(next)) {
      cur = next;
      continue;
    }
    if (cur) out.push(cur);
    cur = word;
    while (!fits(cur)) {
      let n = cur.length - 1;
      while (n > 1 && !fits(cur.slice(0, n))) n--;
      out.push(cur.slice(0, n));
      cur = cur.slice(n);
    }
  }
  if (cur) out.push(cur);
  return out;
}

function readNow(raw: unknown): NowPlaying {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const state = r.state === "playing" || r.state === "paused" || r.state === "stopped" ? r.state : "off";
  const num = (x: unknown) => (typeof x === "number" && isFinite(x) && x > 0 ? x : 0);
  const color = typeof r.color === "string" && /^#[0-9a-fA-F]{6}$/.test(r.color) ? `${r.color.toUpperCase()}FF` : RED;
  return {
    state,
    title: typeof r.title === "string" ? ascii(r.title) : "",
    position: num(r.position),
    duration: num(r.duration),
    at: Date.now(),
    color,
    lyric: readLyric(r.lyric),
  };
}

/** Seconds into the track now, counting on from the last poll while playing. */
function elapsed(n: NowPlaying): number {
  const s = n.state === "playing" ? n.position + (Date.now() - n.at) / 1000 : n.position;
  return Math.min(s, n.duration);
}

/** Clock text: "9:41" + "PM" in 12-hour, "21:41" in 24-hour. */
function clock(d: Date, h24: boolean): { time: string; suffix: string } {
  const h = d.getHours();
  const m = pad2(d.getMinutes());
  if (h24) return { time: `${pad2(h)}:${m}`, suffix: "" };
  return { time: `${h % 12 || 12}:${m}`, suffix: h < 12 ? "AM" : "PM" };
}

function main(): void {
  let config: Config = readConfig(null);
  let now: NowPlaying = readNow(null);
  let lastOk = 0;
  let failures = 0;

  let mode: "main" | "picker" = "main";
  /** Double-tap START: the whole screen shows the line being sung. */
  let lyrics = false;
  let playlists: string[] = [];
  let index = 0;
  let loading = false;

  let stopped = false;
  let polling = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let minuteTimer: ReturnType<typeof setTimeout> | null = null;
  let pickerTimer: ReturnType<typeof setTimeout> | null = null;
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  let tapTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- Mac helper ------------------------------------------------------------------------

  /** Which of the helper's addresses is in use: the next one is tried after a failure. */
  let macIndex = 0;
  const helper = (path: string) => `http://${config.macs[macIndex % config.macs.length]}${path}`;
  const keyHeader = (): Record<string, string> => (config.key ? { "X-Helper-Key": config.key } : {});

  async function getJson(path: string): Promise<unknown> {
    const res = await fetch(helper(path), { headers: keyHeader() });
    const status = Number(res.status);
    if (status < 200 || status >= 300) throw new Error(`${path}: HTTP ${status}`);
    return res.json();
  }

  async function post(path: string, body: object = {}): Promise<void> {
    const res = await fetch(helper(path), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...keyHeader() },
      body: JSON.stringify(body),
    });
    const status = Number(res.status);
    if (status < 200 || status >= 300) throw new Error(`${path}: HTTP ${status}`);
  }

  /** The app's settings: from the runtime's Settings global, or the HTTP API where that's missing. */
  async function settings(): Promise<SettingsValues | null> {
    const values = await loadValues();
    if (values) return values;
    const doc = await device.AppsSettingsGet({ app_id: APP });
    return (doc.values ?? null) as SettingsValues | null;
  }

  async function reloadConfig(): Promise<void> {
    const next = readConfig(await settings());
    const changed = next.h24 !== config.h24;
    if (next.macs.join(",") !== config.macs.join(",")) macIndex = 0;
    config = next;
    if (changed) redraw();
  }

  /** Polls the helper once, then schedules the next poll: steady while it answers, backing off when it doesn't. */
  async function poll(): Promise<void> {
    if (stopped || polling) return;
    polling = true;
    try {
      now = readNow(await getJson(lyrics ? "/now?lyrics=1" : "/now"));
      lastOk = Date.now();
      failures = 0;
    } catch (err) {
      // Reported once per run of failures, not on every retry.
      if (!failures) report(err);
      // Mac asleep, the helper not running, or this address gone (cable out, new Wi-Fi):
      // the clock carries on alone, and the next poll tries the helper's next address.
      // The helper rewrites the address setting when it moves.
      failures++;
      macIndex++;
      await reloadConfig().catch(report);
    } finally {
      polling = false;
    }
    redraw();
    // Each address gets a quick try before backing off.
    const missed = failures - config.macs.length + 1;
    schedulePoll(failures ? (missed > 0 ? Math.min(RETRY_MS * 2 ** (missed - 1), MAX_BACKOFF_MS) : 1000) : nextPoll());
  }

  /** Steady polling, or sooner when a lyric line is about to change (the helper keeps the timing). */
  function nextPoll(): number {
    const l = now.lyric;
    if (!lyrics || now.state !== "playing") return POLL_MS;
    if (!l || l.status === "loading") return 1000;
    if (l.status !== "ok") return POLL_MS;
    return Math.min(POLL_MS, Math.max(300, l.until * 1000 + 100));
  }

  function schedulePoll(ms: number): void {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (stopped) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void poll().catch(report);
    }, ms);
  }

  /** The clock only changes on the minute: redraw just after it turns, and pick up a 12/24h change then. */
  function scheduleMinute(): void {
    if (stopped) return;
    const ms = 60 * 1000 - (Date.now() % (60 * 1000)) + 50;
    minuteTimer = setTimeout(() => {
      minuteTimer = null;
      // Resend the whole frame: another app or a notification taking the screen can drop our elements.
      shown = new Map();
      redraw();
      void reloadConfig().catch(report);
      scheduleMinute();
    }, ms);
  }

  // ---- Front screen (72×16) --------------------------------------------------------------

  /** A left-aligned text line that scrolls only when it doesn't fit in `room`. */
  function line(id: string, text: string, color: string, x: number, y: number, room: number): Element {
    const el: Element = { id, type: "text", text: text || " ", ...SMALL, color, x, y };
    if (textWidth(text, SMALL.font) > room) {
      Object.assign(el, { width: room, scroll_rate: 900, scroll_start_delay: 2000, scroll_repeat_delay: 3000 });
    }
    return el;
  }

  /** Nothing playing: a large clock, centered, with AM/PM beside it. */
  function bigClock(): Element[] {
    const c = clock(new Date(), config.h24);
    const tw = textWidth(c.time, XL.font);
    const sw = c.suffix ? 2 + textWidth(c.suffix, TINY.font) : 0;
    const x = Math.floor((72 - tw - sw) / 2);
    // extra_large at y=1 puts its caps on rows 3–12; tiny at y=8 ends its caps on row 12 too.
    const out: Element[] = [{ id: "big", type: "text", text: c.time, ...XL, color: WHITE, x, y: 1 }];
    if (c.suffix) out.push({ id: "ampm", type: "text", text: c.suffix, ...TINY, color: DIM, x: x + tw + 2, y: 8 });
    return out;
  }

  /** Pixels of the progress bar that are filled. */
  const filled = () => (now.duration ? Math.round((elapsed(now) / now.duration) * BAR_W) : 0);

  /** When a lyric that needs more than two lines shows its next two; null when it fits. */
  let pageTurnAt: number | null = null;

  /** A `small` line centered across the screen. */
  function centered(id: string, text: string, color: string, y: number): Element {
    return { id, type: "text", text, ...SMALL, color, x: Math.max(0, Math.floor((72 - textWidth(text, SMALL.font)) / 2)), y };
  }

  /** One or two centered lines: `small` at y=3 lights rows 5–11, at y=-1/7 rows 1–7 and 9–15. */
  function twoLines(lines: string[], color: string): Element[] {
    if (lines.length === 1) return [centered("ly1", lines[0], color, 3)];
    return [centered("ly1", lines[0], color, -1), centered("ly2", lines[1], color, 7)];
  }

  /** Lyrics take the whole screen: the line being sung, centered on two lines. */
  function lyricsScreen(): Element[] {
    pageTurnAt = null;
    const l = now.lyric;
    if (!l || l.status === "loading") return twoLines(["Lyrics..."], LABEL);
    if (l.status === "none") {
      const title = textWidth(now.title, SMALL.font) > 72 ? line("ly2", now.title, now.color, 0, 7, 72) : centered("ly2", now.title, now.color, 7);
      return [centered("ly1", "No lyrics", LABEL, -1), title];
    }
    // Before the first line and in instrumental breaks: the song's title, dimmed.
    if (!l.line) return twoLines(wrap(now.title).slice(0, 2), now.color.slice(0, 7) + "80");
    const lines = wrap(l.line);
    const pages = Math.ceil(lines.length / 2);
    let page = 0;
    if (pages > 1) {
      // Longer lines show two rows at a time, spread evenly over the line's time.
      const start = now.at - l.since * 1000;
      const span = Math.max(1000, (l.since + l.until) * 1000);
      page = Math.min(pages - 1, Math.max(0, Math.floor(((Date.now() - start) / span) * pages)));
      if (page < pages - 1) pageTurnAt = start + ((page + 1) * span) / pages;
    }
    return twoLines(lines.slice(page * 2, page * 2 + 2), now.color);
  }

  /** Playing or paused: clock and song on top; play/pause and the track's progress below, in the cover's color. */
  function nowPlaying(): Element[] {
    const c = clock(new Date(), config.h24);
    const time = c.time;
    const tx = textWidth(time, SMALL.font) + 3;
    // `small` at y=-1 lights rows 1–7; the icon sits on rows 10–14 and the bar on 11–13.
    const out: Element[] = [
      line("clock", time, WHITE, 0, -1, tx),
      line("title", now.title, now.color, tx, -1, 72 - tx),
      { id: "state", type: "xpmbitmap", data: now.state === "paused" ? PAUSE_ICON : PLAY_ICON, x: 0, y: 10 },
      bar("track", BAR_X, BAR_W, now.color.slice(0, 7) + "40"),
    ];
    const w = filled();
    if (w > 0) out.push(bar("done", BAR_X, w, now.color, 1));
    return out;
  }

  function bar(id: string, x: number, width: number, color: string, z_index = 0): Element {
    return { id, type: "rectangle", x, y: 11, width, height: 3, fill: "solid", fill_colors: [color], border_width: 0, z_index };
  }

  function picker(): Element[] {
    if (loading) return [line("msg", "Playlists...", LABEL, 0, 3, 72)];
    if (!playlists.length) return [line("msg", "No playlists", LABEL, 0, 3, 72)];
    const count = `${index + 1}/${playlists.length}`;
    const cw = textWidth(count, SMALL.font);
    return [
      line("label", "SHUFFLE", LABEL, 0, -1, 72 - cw - 2),
      line("count", count, LABEL, 72 - cw, -1, cw),
      line("item", playlists[index], WHITE, 0, 7, 72),
    ];
  }

  function front(): Element[] {
    if (mode === "picker") return picker();
    const fresh = Date.now() - lastOk < STALE_MS;
    const active = fresh && (now.state === "playing" || now.state === "paused") && now.title;
    if (!active) return bigClock();
    return lyrics ? lyricsScreen() : nowPlaying();
  }

  // ---- Drawing: only changed elements are sent -------------------------------------------

  let shown = new Map<string, string>();
  let drawing = false;
  let redrawPending = false;

  async function draw(): Promise<void> {
    if (stopped) return;
    if (drawing) {
      redrawPending = true;
      return;
    }
    drawing = true;
    try {
      const elements = front();
      const next = new Map<string, string>();
      const changed: Element[] = [];
      for (const el of elements) {
        const json = JSON.stringify(el);
        next.set(el.id, json);
        if (shown.get(el.id) !== json) changed.push(el);
      }
      const removed = [...shown.keys()].filter((id) => !next.has(id));
      if (removed.length) await device.DisplayClear({ application_name: APP, element_ids: removed });
      if (changed.length) await device.DisplayDraw({ application_name: APP, priority: 50, elements: changed });
      shown = next;
    } catch (err) {
      // Screen state is unknown: resend everything next time.
      shown = new Map();
      throw err;
    } finally {
      drawing = false;
      if (redrawPending && !stopped) {
        redrawPending = false;
        void draw().catch(report);
      } else {
        scheduleProgress();
      }
    }
  }

  const redraw = () => void draw().catch(report);

  /** While a track plays, redraw when its progress bar next gains a pixel, or a long lyric turns its page. */
  function scheduleProgress(): void {
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = null;
    if (stopped || mode !== "main" || now.state !== "playing") return;
    let ms: number;
    if (lyrics && shown.has("ly1")) {
      if (pageTurnAt === null) return;
      ms = Math.max(200, pageTurnAt - Date.now() + 30);
    } else if (now.duration && shown.has("state")) {
      const next = ((filled() + 0.5) / BAR_W) * now.duration;
      ms = Math.max(1000, (next - elapsed(now)) * 1000 + 50);
    } else return;
    progressTimer = setTimeout(() => {
      progressTimer = null;
      redraw();
    }, ms);
  }

  // ---- Controls --------------------------------------------------------------------------

  async function playPause(): Promise<void> {
    // Flip the icon right away, holding the progress where it is; the poll just after confirms it.
    const at = Date.now();
    if (now.state === "playing") now = { ...now, state: "paused", position: elapsed(now), at };
    else if (now.state === "paused") now = { ...now, state: "playing", at };
    redraw();
    try {
      await post("/playpause");
    } finally {
      schedulePoll(500);
    }
  }

  let skips = 0;
  let skipping = false;

  /** Knob turns skip songs: queued while a skip is being sent, then sent one at a time. */
  async function skip(delta: number): Promise<void> {
    skips = Math.max(-MAX_SKIPS, Math.min(MAX_SKIPS, skips + delta));
    if (skipping) return;
    skipping = true;
    try {
      while (skips && !stopped) {
        const forward = skips > 0;
        skips += forward ? -1 : 1;
        await post(forward ? "/next" : "/previous");
      }
    } finally {
      skips = 0;
      skipping = false;
      schedulePoll(600);
    }
  }

  function touchPicker(): void {
    if (pickerTimer) clearTimeout(pickerTimer);
    pickerTimer = setTimeout(() => {
      pickerTimer = null;
      closePicker();
    }, PICKER_IDLE_MS);
  }

  function closePicker(): void {
    if (pickerTimer) clearTimeout(pickerTimer);
    pickerTimer = null;
    mode = "main";
    playlists = [];
    redraw();
  }

  async function openPicker(): Promise<void> {
    mode = "picker";
    loading = true;
    touchPicker();
    redraw();
    try {
      const list = await getJson("/playlists");
      playlists = Array.isArray(list)
        ? list.filter((n): n is string => typeof n === "string" && n !== "").slice(0, MAX_PLAYLISTS)
        : [];
    } catch (err) {
      playlists = [];
      report(err);
    } finally {
      loading = false;
    }
    if (mode !== "picker" || stopped) return;
    if (index >= playlists.length) index = 0;
    touchPicker();
    redraw();
  }

  async function shuffle(): Promise<void> {
    const name = playlists[index];
    closePicker();
    if (!name) return;
    try {
      // The helper sends the full name back to Music; the bar shows its ASCII form only.
      await post("/shuffle", { name });
    } finally {
      schedulePoll(1000);
    }
  }

  function quit(): void {
    stopped = true;
    for (const t of [pollTimer, minuteTimer, pickerTimer, progressTimer, tapTimer]) if (t) clearTimeout(t);
    pollTimer = minuteTimer = pickerTimer = progressTimer = tapTimer = null;
    const ids = [...shown.keys()];
    shown = new Map();
    if (ids.length) void device.DisplayClear({ application_name: APP, element_ids: ids }).catch(report);
    // The unbind is the last handle: schedule it so the input callback returns first.
    setTimeout(unbind, 0);
  }

  const unbind = listen("input", (event) => {
    if (stopped) return;
    if (event.key === "encoder") {
      // Right (clockwise) is the next song, left the previous one.
      if (mode === "main") {
        if (now.state === "playing" || now.state === "paused") void skip(event.delta).catch(report);
        return;
      }
      if (!playlists.length) return;
      index = (index + event.delta + playlists.length) % playlists.length;
      touchPicker();
      redraw();
      return;
    }
    if (event.action !== "short") return;
    if (event.key === "start") {
      // One tap plays/pauses once it's clear no second tap follows; two toggle lyrics.
      if (tapTimer) {
        clearTimeout(tapTimer);
        tapTimer = null;
        lyrics = !lyrics;
        now = { ...now, lyric: null };
        redraw();
        schedulePoll(0);
      } else {
        tapTimer = setTimeout(() => {
          tapTimer = null;
          void playPause().catch(report);
        }, DOUBLE_TAP_MS);
      }
    } else if (event.key === "ok") {
      if (mode === "main") void openPicker().catch(report);
      else if (!loading) void shuffle().catch(report);
    } else if (event.key === "back") {
      if (mode === "picker") closePicker();
      else quit();
    }
  });

  scheduleMinute();
  redraw();
  void reloadConfig()
    .catch(report)
    .then(() => poll())
    .catch(report);
}

main();
