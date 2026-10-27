/* The On Air screen presents the backend's programme LIFECYCLE,
 * EXECUTED.
 *
 * The screen used to decide two things from the shape of what it was
 * handed: a queue row whose route looked like ours was drawn as a DJ break
 * coming up, and a Now Playing card whose kind said dj lit the on-air lamp.
 * Both were true on a healthy queue and false the moment Music Assistant
 * rewound: an aired break's item sat ahead of the play head again, its URL
 * answering a second of silence, and the drawer promised a break that
 * would never speak.
 *
 * Every decision below is now made from the lifecycle word the backend
 * publishes with each item (now_playing.py: upcoming / airing / spent /
 * unknown) or from the DJ engine's own status, and from nothing else --
 * not the route, not the title, not the length, not the position, and
 * not whether the DJ switch is on.
 *
 *   node ha/tests/test_panel_lifecycle.mjs      (or scripts/test_panel.sh)
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL = join(HERE, "..", "custom_components", "parlorwave_radio",
                   "panel", "parlorwave-radio-panel.js");

// --- the smallest host the panel needs ---------------------------------------
class ClassList {
  constructor() { this._s = new Set(); }
  add(c) { this._s.add(c); }
  remove(c) { this._s.delete(c); }
  contains(c) { return this._s.has(c); }
}
class FakeEl {
  constructor() {
    this.classList = new ClassList();
    this.dataset = {};
    this.style = { setProperty() {}, removeProperty() {}, getPropertyValue() { return ""; } };
    this._byId = {};
  }
  addEventListener() {}
  removeEventListener() {}
  getElementById(id) { return this._byId[id] || null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
globalThis.HTMLElement = class {
  constructor() {
    this.style = { setProperty() {}, removeProperty() {}, getPropertyValue() { return ""; } };
  }
  attachShadow() { this.shadowRoot = new FakeEl(); return this.shadowRoot; }
};
let PanelClass = null;
globalThis.customElements = { get: () => undefined, define: (_n, c) => { PanelClass = c; } };
await import(PANEL);
assert.ok(PanelClass, "the panel did not register its custom element");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* EVERY WRITE IS COUNTED. The host records any attempt to call a service
 * or the websocket, so "presentation mutated nothing" is asserted rather
 * than assumed. */
function station({ dj = "on", status = "waiting", djAttrs = {}, card = null,
                   player = "playing" } = {}) {
  const el = new PanelClass();
  el._render = () => {};
  el.writes = [];
  el._entityMap = { dj_enabled: "switch.dj", dj_status: "sensor.dj",
                    now_playing: "sensor.now", output: "select.out" };
  el._hass = {
    states: {
      "switch.dj": { state: dj, attributes: {} },
      "sensor.dj": { state: status, attributes: { enabled: dj === "on", ...djAttrs } },
      "select.out": { state: "Den", attributes: { output_entity_id: "media_player.den" } },
      "media_player.den": {
        entity_id: "media_player.den", state: player,
        attributes: { friendly_name: "Den", supported_features: 16433,
                      media_title: "Lost Bells", media_artist: "Cold Orchard" },
      },
    },
    callService: (...a) => { el.writes.push(["service", ...a]); return Promise.resolve(); },
    callWS: (...a) => { el.writes.push(["ws", ...a]); return Promise.resolve({}); },
  };
  if (card) el._hass.states["sensor.now"] = { state: card.state || "playing", attributes: card };
  return el;
}

const MUSIC = { kind: "music", title: "Lost Bells", artist: "Cold Orchard", state: "playing" };
const DJ_AIRING = { kind: "dj", lifecycle: "airing", title: "DJ break", state: "playing" };
const DJ_SPENT = { kind: "dj", lifecycle: "spent", title: "DJ break", state: "playing" };
const NEWS_AIRING = { kind: "news", lifecycle: "airing", title: "News bulletin", state: "playing" };
const NEWS_SPENT = { kind: "news", lifecycle: "spent", title: "News bulletin", state: "playing" };

// ======================================================================
// 1. DJ ENABLED IS NOT DJ SPEAKING
// ======================================================================
test("DJ enabled with music playing is Playing, never Speaking now", () => {
  const bs = station({ dj: "on", status: "waiting", card: MUSIC })._broadcastState();
  assert.equal(bs.label, "Playing");
  assert.equal(!!bs.lamp, false);
});

test("the engine's on_air status is Speaking now, with the lamp", () => {
  const bs = station({ status: "on_air", card: DJ_AIRING })._broadcastState();
  assert.equal(bs.label, "Speaking now");
  assert.equal(bs.lamp, true);
  assert.equal(bs.tone, "onair");
});

test("a card whose lifecycle is airing is Speaking now even if the switch was turned off mid-break", () => {
  // the switch is a standing arrangement; the break that is audible is a fact
  const bs = station({ dj: "off", status: "off", card: DJ_AIRING })._broadcastState();
  assert.equal(bs.label, "Speaking now");
  assert.equal(bs.lamp, true);
});

test("an airing bulletin is News, with the lamp", () => {
  const bs = station({ status: "waiting", card: NEWS_AIRING })._broadcastState();
  assert.equal(bs.label, "News");
  assert.equal(bs.lamp, true);
});

test("a spent break under the play head is NOT speaking -- it is a second of silence", () => {
  /* The rewind case: Music Assistant is on the tombstone of an aired
   * break. The card's kind is dj, the DJ is enabled, the player is
   * playing. None of that is speech. */
  for (const card of [DJ_SPENT, NEWS_SPENT,
                      { ...DJ_SPENT, lifecycle: "unknown" },
                      { kind: "dj", title: "DJ break", state: "playing" }]) {
    const bs = station({ dj: "on", status: "waiting", card })._broadcastState();
    assert.notEqual(bs.label, "Speaking now", JSON.stringify(card));
    assert.notEqual(bs.label, "News", JSON.stringify(card));
    assert.equal(!!bs.lamp, false, JSON.stringify(card));
  }
});

test("a queued future break is upcoming, not speaking", () => {
  const bs = station({ status: "up_next", card: MUSIC })._broadcastState();
  assert.equal(bs.label, "DJ up next");
  assert.equal(!!bs.lamp, false);
  const ready = station({ status: "ready", card: MUSIC })._broadcastState();
  assert.equal(ready.label, "DJ ready", "a rendered break is not yet in the queue");
  assert.equal(!!ready.lamp, false);
});

test("completion clears the speaking state with no help from the panel", () => {
  const el = station({ status: "on_air", card: DJ_AIRING });
  assert.equal(el._broadcastState().label, "Speaking now");
  // the next coordinator cycle: the engine says waiting, the card says music
  el._hass.states["sensor.dj"].state = "waiting";
  el._hass.states["sensor.now"].attributes = MUSIC;
  assert.equal(el._broadcastState().label, "Playing");
  assert.equal(!!el._broadcastState().lamp, false);
});

test("a title that says DJ break creates no programme state", () => {
  const card = { kind: "music", title: "DJ break", artist: "ParlorWave Radio", state: "playing" };
  const bs = station({ status: "waiting", card })._broadcastState();
  assert.equal(bs.label, "Playing");
  assert.equal(station({ card })._track().lifecycle, null);
});

// ======================================================================
// 2. THE AUDIO RULE FOLLOWS THE LAMP
// ======================================================================
test("the display speaks only when the state line lit the lamp", () => {
  const el = station({ status: "on_air", card: DJ_AIRING });
  const p = el._hass.states["media_player.den"];
  assert.equal(el._audioMode(el._broadcastState(), DJ_AIRING, p).mode, "speaking");
  const stale = station({ status: "waiting", card: DJ_SPENT });
  assert.equal(stale._audioMode(stale._broadcastState(), DJ_SPENT, p).mode, "music",
               "the display talked over a tombstone");
});

// ======================================================================
// 3. THE NEXT BREAK CHIP
// ======================================================================
test("the chip is the engine's estimate in honest units, and absent while speaking", () => {
  const soon = station({ status: "waiting", card: MUSIC, djAttrs: { seconds_to_air: 40 } });
  assert.ok(soon._renderOnAir().includes("in under a minute"), "40 seconds is not '0 min'");
  const later = station({ status: "waiting", card: MUSIC, djAttrs: { seconds_to_air: 130 } });
  assert.ok(later._renderOnAir().includes("in 2 min"));
  const none = station({ status: "waiting", card: MUSIC });
  assert.ok(!none._renderOnAir().includes("Next break"), "a chip with no estimate behind it");
  const live = station({ status: "on_air", card: DJ_AIRING, djAttrs: { seconds_to_air: 0 } });
  assert.ok(!live._renderOnAir().includes("Next break"),
            "'Next break in 0 min' while the break is on the air");
});

// ======================================================================
// 4. THE QUEUE DRAWER
// ======================================================================
function drawer(el, data) {
  el._queue = { at: Date.now(), data: { ok: true, complete: true, ...data } };
  return el._renderQueue();
}
const rowsOf = (html) => html.split('<div class="qrow').slice(1);
const music = (t, d = 200) => ({ kind: "music", title: t, artist: "A", duration_s: d });
const brk = (lifecycle, d = 22) => ({ kind: "dj", lifecycle, title: "DJ break",
                                      artist: "ParlorWave Radio", duration_s: d });
const news = (lifecycle, d = 300) => ({ kind: "news", lifecycle, title: "News bulletin",
                                        artist: "News", duration_s: d });

test("music displays as music, with its length", () => {
  const html = drawer(station(), { current: music("One"), recent: [], upcoming: [music("Two", 180)] });
  const [now, next] = rowsOf(html);
  assert.ok(now.includes("qnow") && now.includes("A — One"));
  assert.ok(next.includes("A — Two") && next.includes("3:00"));
  assert.ok(!next.includes("qspent") && !next.includes("qtag"));
});

test("a queued break is upcoming programme, drawn as before", () => {
  const html = drawer(station(), { current: music("One"), recent: [], upcoming: [brk("upcoming")] });
  const [, next] = rowsOf(html);
  assert.ok(next.includes("\u{1F399}") && next.includes("DJ break"));
  assert.ok(!next.includes("qspent") && !next.includes("finished"));
  assert.ok(next.includes("0:22"), "a real upcoming break keeps its length");
});

test("the airing break is the current row and says so", () => {
  const html = drawer(station(), { current: brk("airing"), recent: [], upcoming: [music("Two")] });
  const [now] = rowsOf(html);
  assert.ok(now.includes("qnow") && now.includes("speaking now"));
});

test("a spent break ahead of the play head is finished, never upcoming", () => {
  for (const it of [brk("spent"), news("spent"), brk("unknown")]) {
    const html = drawer(station(), { current: music("One"), recent: [], upcoming: [it, music("Two")] });
    const [, dead, next] = rowsOf(html);
    assert.ok(dead.includes("qspent"), JSON.stringify(it));
    assert.ok(dead.includes(it.lifecycle === "unknown" ? "status unknown" : "finished"));
    assert.ok(!next.includes("qspent"), "the styling leaked onto the song after it");
  }
});

test("a finished break or bulletin KEEPS its length beside the finished tag", () => {
  // The programme element's own duration answers "how long was that?" --
  // it does not disappear the moment the item is over. Same renderer,
  // same formatting as every other row's length.
  for (const [it, len] of [[brk("spent"), "0:22"], [news("spent"), "5:00"]]) {
    const html = drawer(station(), { current: music("One"), recent: [], upcoming: [it, music("Two")] });
    const [, dead] = rowsOf(html);
    assert.ok(dead.includes("finished"), JSON.stringify(it));
    assert.ok(dead.includes(len), `the finished length was dropped: ${dead}`);
  }
  // ...and in Earlier, where a completed element ordinarily lands.
  const html = drawer(station(), { current: music("One"), recent: [brk("spent")], upcoming: [] });
  const [earlier] = rowsOf(html);
  assert.ok(earlier.includes("finished") && earlier.includes("0:22"));
});

test("a lifecycle this build cannot name still shows no length", () => {
  const html = drawer(station(), { current: music("One"), recent: [], upcoming: [brk("unknown")] });
  const [, dead] = rowsOf(html);
  assert.ok(dead.includes("status unknown") && !dead.includes("0:22"),
            "an unvouched-for item was given a length");
});

test("a finished item MA reports no duration for fabricates none", () => {
  const it = { kind: "dj", lifecycle: "spent", title: "DJ break", artist: "ParlorWave Radio" };
  const html = drawer(station(), { current: music("One"), recent: [], upcoming: [it] });
  const [, dead] = rowsOf(html);
  assert.ok(dead.includes("finished"));
  assert.ok(/<span class="qtime"><\/span>/.test(dead), `a length was invented: ${dead}`);
});

test("upcoming, airing and music rows keep their existing length behaviour", () => {
  const html = drawer(station(), { current: brk("airing"), recent: [],
                                   upcoming: [brk("upcoming"), news("upcoming"), music("Two", 180)] });
  const [now, dj, nw, mus] = rowsOf(html);
  assert.ok(now.includes("speaking now") && now.includes("0:22"));
  assert.ok(dj.includes("0:22") && !dj.includes("finished"));
  assert.ok(nw.includes("5:00") && !nw.includes("finished"));
  assert.ok(mus.includes("3:00"));
});

test("upcoming news is upcoming, spent news is not", () => {
  const html = drawer(station(), { current: music("One"), recent: [],
                                   upcoming: [news("upcoming"), news("spent")] });
  const [, fresh, spent] = rowsOf(html);
  assert.ok(fresh.includes("\u{1F4F0}") && fresh.includes("News bulletin") && !fresh.includes("qspent"));
  assert.ok(fresh.includes("5:00"));
  assert.ok(spent.includes("qspent") && spent.includes("finished"));
});

test("a route the backend would not claim arrives as music and is drawn as music", () => {
  // the backend answers kind music with MA's own title for an unknown token;
  // the drawer has no way -- and no wish -- to promote it
  const it = { kind: "music", title: "DJ break", artist: "ParlorWave Radio", duration_s: 22 };
  const html = drawer(station(), { current: music("One"), recent: [], upcoming: [it] });
  const [, row] = rowsOf(html);
  assert.ok(row.includes("♪"), "a music note, not a microphone");
  assert.ok(!row.includes("qtag") && !row.includes("qspent"));
});

test("a spent item's seconds are left out of the run, not the whole total refused", () => {
  const el = station();
  assert.equal(el._queueSeconds([music("A", 100), brk("spent", 22), music("B", 100)]), 200);
  assert.equal(el._queueSeconds([music("A", 100), brk("upcoming", 22)]), 122);
  // a real missing length still refuses the total
  assert.equal(el._queueSeconds([music("A", 100), { kind: "music", title: "?" }]), null);
});

// ======================================================================
// 5. THE REGRESSION-SHAPED CASE, END TO END
// ======================================================================
test("music A / spent break X / music B / music C, rewound: X is dead before hygiene and gone after", () => {
  /* Before the rewind: A, X (aired), B, C -- the head is on C. Music
   * Assistant regresses to A: X is ahead again. The backend classifies X
   * from its dj_breaks row (completed) on the first read; hygiene has not
   * run. */
  const el = station({ dj: "on", status: "waiting", card: MUSIC });
  const before = drawer(el, {
    total: 4, played_count: 0, upcoming_count: 3,
    current: music("A"), recent: [],
    upcoming: [brk("spent"), music("B"), music("C")],
  });
  const [, x, b, c] = rowsOf(before);
  assert.ok(x.includes("qspent") && x.includes("finished"), "X was drawn as a break coming up");
  assert.ok(!b.includes("qspent") && !c.includes("qspent"));
  assert.ok(before.includes("3 still to come"), "MA's own count is kept: X is still in the queue");
  assert.ok(before.includes("about 7 min"), "the run counts B and C, not X's silence");
  assert.equal(el._broadcastState().label, "Playing", "a dead item ahead does not set speaking");

  /* Hygiene removes X. The next read simply lacks it; nothing in the panel
   * is reset, cleared or special-cased. */
  const after = drawer(el, {
    total: 3, played_count: 0, upcoming_count: 2,
    current: music("A"), recent: [],
    upcoming: [music("B"), music("C")],
  });
  assert.ok(!after.includes("qspent") && !after.includes("finished"));
  assert.ok(after.includes("2 still to come") && after.includes("about 7 min"));
  assert.equal(el.writes.length, 0, "presentation reached a service or the websocket");
});

// ======================================================================
// 6. AIR CHECK
// ======================================================================
const HISTORY = { last_spoken: "That was the 13:50 break.", last_break_at: "2026-09-16T13:50:00-07:00" };
const LIVE = { on_air_break: true, on_air_spoken: "This is the 14:22 break.",
               on_air_break_at: "2026-09-16T14:22:00-07:00" };

test("Air Check is the airing break, from the engine's own row", () => {
  const html = station({ status: "on_air", djAttrs: { ...HISTORY, ...LIVE } })._renderLastBreak();
  assert.ok(html.includes("Air Check") && html.includes("Speaking now"));
  assert.ok(html.includes("14:22 break") && !html.includes("13:50 break"));
});

test("a completed break becomes the recent Air Check", () => {
  const html = station({ status: "waiting", djAttrs: HISTORY })._renderLastBreak();
  assert.ok(html.includes("Air Check") && html.includes("13:50 break"));
  assert.ok(!html.includes("Speaking now") && !html.includes("lastbreak live"));
});

test("a queued future break and a spent stale item are neither of them the Air Check", () => {
  // up_next: the engine publishes no on_air_break; a spent item ahead in the
  // queue is not a row the engine publishes here at all
  const el = station({ status: "up_next", djAttrs: HISTORY, card: MUSIC });
  el._queue = { at: Date.now(), data: { ok: true, complete: true, current: music("A"),
                recent: [], upcoming: [brk("upcoming"), brk("spent")] } };
  const html = el._renderLastBreak();
  assert.ok(html.includes("13:50 break"), "the legitimate recent break was displaced");
  assert.ok(!html.includes("Speaking now"));
});

// ======================================================================
// 7. NO MUTATION
// ======================================================================
test("rendering On Air, the drawer and Air Check writes nothing anywhere", () => {
  const el = station({ status: "on_air", card: DJ_SPENT, djAttrs: { ...HISTORY, ...LIVE, seconds_to_air: 0 } });
  el._queue = { at: Date.now(), data: { ok: true, complete: true, current: brk("spent"),
                recent: [brk("spent")], upcoming: [brk("spent"), music("B")] } };
  el._drawer = "queue";
  el._renderOnAir();
  el._renderQueue();
  el._renderLastBreak();
  el._broadcastState();
  el._track();
  assert.deepEqual(el.writes, []);
});

for (const [name, fn] of tests) {
  try { fn(); passed++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) {
    process.stdout.write(`  FAIL ${name}\n       ${e.message}\n`);
    process.exitCode = 1;
  }
}
process.stdout.write(`\n${passed}/${tests.length} panel lifecycle tests passed\n`);
