/* The two On Air behaviours that only exist in a browser, EXECUTED.
 *
 *   1. A lyric update must move the lyric pane and NOTHING else. The bug
 *      this pins was not subtle once found and was invisible to every
 *      source-level test: the active line was revealed with
 *      `scrollIntoView`, which scrolls every scrollable ancestor, and in a
 *      Home Assistant panel the outermost ancestor is the page. Each new
 *      lyric dragged the whole panel back down; somebody who scrolled up
 *      to reach the tabs was pulled away mid-reach, and turning Lyrics off
 *      was the only way to navigate.
 *
 *   2. The transport buttons must describe the PLAYER, not our hopes. A
 *      control the player cannot do is disabled and says why; the
 *      play/pause button follows the player's reported state.
 *
 * Both run under plain node against a small fake DOM. The fake is
 * deliberately hostile: its document and its ancestor elements record any
 * attempt to scroll or focus them, so "the page did not move" is asserted
 * rather than hoped for.
 *
 *   node ha/tests/test_panel_dom.mjs        (or scripts/test_panel.sh)
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL = join(HERE, "..", "custom_components", "parlorwave_radio",
                   "panel", "parlorwave-radio-panel.js");

// --- the smallest DOM these two behaviours need -------------------------
// Anything the panel touches that would be a PAGE-LEVEL movement is not
// stubbed out quietly: it is counted.
const pageMoves = [];

/* The DOM's classList, with the three methods the panel uses. */
class ClassList {
  constructor() { this._s = new Set(); }
  add(c) { this._s.add(c); }
  remove(c) { this._s.delete(c); }
  contains(c) { return this._s.has(c); }
  has(c) { return this._s.has(c); }          // the tests read it this way
}

class FakeEl {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.classList = new ClassList();
    this.dataset = {};
    // A real CSSStyleDeclaration, to the extent the panel uses one: the
    // album-palette code sets and clears custom properties on the host,
    // and a bare {} makes that a TypeError that looks like a panel bug.
    this.style = {
      _p: {},
      setProperty(k, v) { this._p[k] = v; },
      removeProperty(k) { delete this._p[k]; },
      getPropertyValue(k) { return this._p[k] ?? ""; },
    };
    this._listeners = {};
    this.scrollTop = 0;
    this.clientHeight = 0;
    this.scrollHeight = 0;
    this.offsetTop = 0;
    this.offsetHeight = 0;
  }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  removeEventListener() {}
  dispatch(type) { for (const fn of this._listeners[type] || []) fn({}); }
  // The two calls that can move the page. Neither may ever be reached.
  scrollIntoView() { pageMoves.push("scrollIntoView"); }
  focus() { pageMoves.push("focus"); }
  scrollTo(opts) {
    this.scrollTop = typeof opts === "object" ? opts.top : opts;
    this._scrolledTo = this.scrollTop;
    this.dispatch("scroll");
  }
  querySelector(sel) {
    const m = /\[data-li="(-?\d+)"\]/.exec(sel);
    if (m) return this.children.find((c) => c.dataset.li === m[1]) || null;
    if (sel === ".lyric-now") return this.children.find((c) => c.classList.has("lyric-now")) || null;
    return null;
  }
  querySelectorAll() { return []; }
}

/* A lyric pane with `n` lines of `h` pixels, shown `visible` pixels tall. */
function pane(n, h = 24, visible = 300) {
  const list = new FakeEl();
  list.clientHeight = visible;
  list.scrollHeight = n * h;
  for (let i = 0; i < n; i++) {
    const line = new FakeEl();
    line.dataset.li = String(i);
    line.offsetTop = i * h;
    line.offsetHeight = h;
    list.children.push(line);
  }
  return list;
}

globalThis.HTMLElement = class {
  constructor() {
    // The panel sets custom properties on ITSELF (the host element), so the
    // host needs the same style object its children get.
    this.style = {
      _p: {},
      setProperty(k, v) { this._p[k] = v; },
      removeProperty(k) { delete this._p[k]; },
      getPropertyValue(k) { return this._p[k] ?? ""; },
    };
  }
  attachShadow() {
    const root = new FakeEl();
    root.getElementById = (id) => root._byId?.[id] || null;
    root._byId = {};
    root.activeElement = null;
    this.shadowRoot = root;
    return root;
  }
};
// The panel class is not exported -- it is REGISTERED. So the element
// registry is stubbed to capture what the module defines, exactly the way
// a browser would learn about it, and the stub has to be in place before
// the module evaluates.
let PanelClass = null;
globalThis.customElements = { get: () => undefined, define: (_n, c) => { PanelClass = c; } };

const mod = await import(PANEL);
const { PW_LYRICS } = mod;
assert.ok(PanelClass, "the panel did not register its custom element");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* A panel instance with no Home Assistant behind it. `_render` is stubbed
 * because these tests are about what the two methods below do to the DOM,
 * not about markup -- the markup has its own source contracts. */
function panel() {
  const el = new PanelClass();
  el._render = () => {};
  return el;
}

// ======================================================================
// 1. the pure arithmetic
// ======================================================================
test("the wanted position anchors the line and never leaves the pane", () => {
  const f = PW_LYRICS.lyricScrollTop;
  // A line in the middle of a long song sits just BELOW centre: the lines
  // already sung stay visible above it. 600 - 300*0.55 + 12 = 447.
  assert.equal(f({ paneHeight: 300, contentHeight: 1200, lineTop: 600, lineHeight: 24 }), 447);
  assert.equal(PW_LYRICS.LYRIC_ANCHOR > 0.5 && PW_LYRICS.LYRIC_ANCHOR < 0.7, true,
               "the anchor is meant to be middle / lower-middle");
  // the first line cannot pull the pane above its top
  assert.equal(f({ paneHeight: 300, contentHeight: 1200, lineTop: 0, lineHeight: 24 }), 0);
  // the last line cannot pull it past the end
  assert.equal(f({ paneHeight: 300, contentHeight: 1200, lineTop: 1176, lineHeight: 24 }), 900);
  // content shorter than the pane never scrolls at all
  assert.equal(f({ paneHeight: 300, contentHeight: 120, lineTop: 96, lineHeight: 24 }), 0);
});

test("the pane moves only when the ACTIVE LINE changes, and only while following", () => {
  const f = PW_LYRICS.shouldAutoScroll;
  // the ordinary case: a new line, following on
  assert.equal(f({ line: 12, lastScrolledFor: 11, following: true }), true);
  // THE REGRESSION: a refresh does not change the active line, so a refresh
  // must not scroll. This is what made the pane a candidate for movement
  // once a second whether or not anything had happened.
  assert.equal(f({ line: 12, lastScrolledFor: 12, following: true }), false);
  // the reader has the pane: nothing moves it, new line or not
  assert.equal(f({ line: 12, lastScrolledFor: 11, following: false }), false);
  // before the first timed line there is nothing to follow
  assert.equal(f({ line: -1, lastScrolledFor: null, following: true }), false);
  assert.equal(f({ line: null, lastScrolledFor: null, following: true }), false);
  // the first line of a song still moves the pane
  assert.equal(f({ line: 0, lastScrolledFor: null, following: true }), true);
});

// ======================================================================
// 2. the DOM behaviour
// ======================================================================
test("a lyric update scrolls the pane and never the page", () => {
  pageMoves.length = 0;
  const el = panel();
  const list = pane(50);
  el.shadowRoot._byId["lyric-lines"] = list;
  el._drawer = "lyrics";
  el._lyrics = { data: { kind: "synced", lines: Array.from({ length: 50 }, (_, i) => ({ t: i * 3, text: `line ${i}` })) } };

  el._highlightLyric({ pos: 60, duration: 200 });     // line 20
  assert.equal(list.querySelector(".lyric-now").dataset.li, "20");
  assert.ok(list.scrollTop > 0, "the pane followed the song");
  assert.deepEqual(pageMoves, [],
    "nothing called scrollIntoView or focus -- those are what moved the page");

  el._highlightLyric({ pos: 90, duration: 200 });     // line 30
  assert.equal(list.querySelector(".lyric-now").dataset.li, "30");
  assert.deepEqual(pageMoves, []);
});

test("the highlight moves, and only one line ever carries it", () => {
  const el = panel();
  const list = pane(20);
  el.shadowRoot._byId["lyric-lines"] = list;
  el._drawer = "lyrics";
  el._lyrics = { data: { kind: "synced", lines: Array.from({ length: 20 }, (_, i) => ({ t: i, text: "x" })) } };
  for (const pos of [3, 7, 11, 2]) {
    el._highlightLyric({ pos, duration: 30 });
    const lit = list.children.filter((c) => c.classList.has("lyric-now"));
    assert.equal(lit.length, 1, `pos ${pos}: ${lit.length} lines highlighted`);
    assert.equal(lit[0].dataset.li, String(pos));
  }
});

/* --- the lyric pane belongs to whoever is holding it -------------------
 *
 * The failure: synced lyrics stopped following
 * the active line, and scrolling down snapped them back to the top over
 * and over. Both came from ONE thing -- assigning scrollTop to restore the
 * pane across a rebuild fires a scroll event, and the pane's listener read
 * that as the reader moving it by hand. Following switched itself off on
 * the first refresh, invisibly, and the only way back was for the song to
 * drift within one line of wherever the pane happened to be.
 *
 * These pin the behaviour wanted instead: follow on a line
 * CHANGE, stop dead on a real interaction, never resume by guesswork, and
 * come back when they press the control. */
function lyricPanel(lines = 80) {
  const el = panel();
  const list = pane(lines);
  el.shadowRoot._byId["lyric-lines"] = list;
  el._drawer = "lyrics";
  el._lyrics = { data: { kind: "synced",
    lines: Array.from({ length: lines }, (_, i) => ({ t: i, text: "x" })) } };
  el._bindLyricPane();
  return { el, list };
}

test("the active line advances and the pane follows it, never to the top", () => {
  const { el, list } = lyricPanel();
  el._highlightLyric({ pos: 40, duration: 100 });
  const first = list.scrollTop;
  assert.ok(first > 0, "the pane did not follow the song at all");

  el._highlightLyric({ pos: 50, duration: 100 });
  assert.ok(list.scrollTop > first, "the pane did not advance with the song");
  assert.equal(list.querySelector(".lyric-now").dataset.li, "50");
  assert.notEqual(list.scrollTop, 0, "the pane snapped back to the top");
});

test("a refresh does not move the pane, because the line did not change", () => {
  const { el, list } = lyricPanel();
  el._highlightLyric({ pos: 40, duration: 100 });
  const settled = list.scrollTop;
  list._scrolledTo = null;
  // the same second, and the next, and the one after: same active line
  el._highlightLyric({ pos: 40.2, duration: 100 });
  el._highlightLyric({ pos: 40.9, duration: 100 });
  assert.equal(list.scrollTop, settled);
  assert.equal(list._scrolledTo, null, "the pane was scrolled on a refresh");
});

test("a wheel, a touch or a pointer takes the pane immediately", () => {
  for (const how of ["wheel", "touchstart", "pointerdown"]) {
    const { el, list } = lyricPanel();
    el._highlightLyric({ pos: 40, duration: 100 });
    assert.equal(el._lyricFollow, true);
    list.dispatch(how);
    assert.equal(el._lyricFollow, false, `${how} did not suspend following`);
  }
});

test("a scroll we did not ask for is a person, and stops the follow", () => {
  const { el, list } = lyricPanel();
  el._highlightLyric({ pos: 40, duration: 100 });
  el._lyricAutoAt = 0;                 // well outside any animation window
  el._lyricAutoTop = null;
  list.scrollTop = 0;
  list.dispatch("scroll");
  assert.equal(el._lyricFollow, false);
});

test("once they have it, the song never takes the pane back by itself", () => {
  const { el, list } = lyricPanel();
  el._highlightLyric({ pos: 40, duration: 100 });
  list.dispatch("wheel");
  list.scrollTop = 0;                  // they read from the top
  // the song plays on, past the line they are looking at and away again
  for (const pos of [41, 42, 1, 2, 60]) el._highlightLyric({ pos, duration: 100 });
  assert.equal(list.scrollTop, 0, "the reader was yanked back");
  assert.equal(el._lyricFollow, false, "following resumed without being asked");
  // ...but the HIGHLIGHT still tracks the song, so the mark is right when
  // they come back to it.
  assert.equal(list.querySelector(".lyric-now").dataset.li, "60");
});

test("Follow lyrics resumes, and goes to the line the song is on NOW", () => {
  const { el, list } = lyricPanel();
  el._render = () => {};               // the control's own render is not the point
  el._highlightLyric({ pos: 10, duration: 100 });
  list.dispatch("wheel");
  list.scrollTop = 0;
  el._highlightLyric({ pos: 62, duration: 100 });   // song moved a long way on
  assert.equal(list.scrollTop, 0);

  el._resumeLyricFollow();
  assert.equal(el._lyricFollow, true);
  assert.ok(list.scrollTop > 0, "Follow lyrics did not move the pane");
  // it went to the CURRENT line, not to where they were when they left
  const wanted = PW_LYRICS.lyricScrollTop({
    paneHeight: list.clientHeight, contentHeight: list.scrollHeight,
    lineTop: 62 * 24, lineHeight: 24 });
  assert.equal(list.scrollTop, wanted);
});

test("the control appears only while following is off", () => {
  const el = panel();
  el._lyrics = { data: { kind: "synced", lines: [{ t: 0, text: "x" }] } };
  el._lyricFollow = true;
  assert.ok(!el._renderLyrics().includes("lyric-follow"),
            "offered a way back while already following");
  el._lyricFollow = false;
  const html = el._renderLyrics();
  assert.ok(html.includes('id="lyric-follow"'));
  assert.ok(html.includes("Follow lyrics"));
});

test("unsynced lyrics have no pane to follow, so nothing can scroll them", () => {
  const el = panel();
  el._drawer = "lyrics";
  el._lyrics = { data: { kind: "plain", text: "a\nb\nc" } };
  const html = el._renderLyrics();
  assert.ok(!html.includes('id="lyric-lines"'),
            "an unsynced page must not be a followable pane");
  assert.ok(!html.includes("lyric-follow"));
  // and the follow path simply finds nothing to do
  el.shadowRoot._byId["lyric-lines"] = null;
  el._highlightLyric({ pos: 30, duration: 90 });
  assert.equal(el._lyricLine, null);
});

test("a re-render puts the pane and the highlight back", () => {
  const el = panel();
  const list = pane(60);
  el.shadowRoot._byId["lyric-lines"] = list;
  el._drawer = "lyrics";
  el._lyrics = { data: { kind: "synced", lines: Array.from({ length: 60 }, (_, i) => ({ t: i, text: "x" })) } };
  el._highlightLyric({ pos: 30, duration: 90 });
  const where = list.scrollTop;
  assert.ok(where > 0);
  el._saveLyricScroll();

  // Home Assistant pushes new state and the whole shadow tree is rebuilt:
  // a fresh pane, with no scroll position and no highlight on it.
  const rebuilt = pane(60);
  el.shadowRoot._byId["lyric-lines"] = rebuilt;
  assert.equal(rebuilt.scrollTop, 0);
  el._restoreLyricScroll();
  assert.equal(rebuilt.scrollTop, where, "the reader kept their place");
  assert.equal(rebuilt.querySelector(".lyric-now").dataset.li, "30");
});

test("a re-render keeps a MANUAL position, and is not mistaken for a person", () => {
  /* THE DEFECT, from both ends. Restoring the pane assigns scrollTop, which
   * fires a scroll event like any other -- and the listener that decides
   * "the reader has taken the pane" was hearing it. Following switched
   * itself off on the first refresh after the drawer opened, invisibly, and
   * from then on the song was never followed again. */
  const { el, list } = lyricPanel(60);
  el._highlightLyric({ pos: 30, duration: 90 });
  list.dispatch("wheel");                  // they take the pane
  list.scrollTop = 77;                     // and park it somewhere of theirs
  list.dispatch("scroll");
  assert.equal(el._lyricFollow, false);
  el._saveLyricScroll();
  assert.equal(el._lyricScrollTop, 77);

  const rebuilt = pane(60);
  el.shadowRoot._byId["lyric-lines"] = rebuilt;
  el._restoreLyricScroll();
  rebuilt.dispatch("scroll");              // the restore's OWN scroll event
  assert.equal(rebuilt.scrollTop, 77, "a refresh moved the reader");
  assert.equal(el._lyricFollow, false, "a refresh may not resume following");

  // And the same, from a pane that IS following: the restore must not be
  // the thing that turns following off.
  const { el: e2, list: l2 } = lyricPanel(60);
  e2._highlightLyric({ pos: 30, duration: 90 });
  e2._saveLyricScroll();
  assert.equal(e2._lyricFollow, true);
  const fresh = pane(60);
  e2.shadowRoot._byId["lyric-lines"] = fresh;
  e2._restoreLyricScroll();
  fresh.dispatch("scroll");
  assert.equal(e2._lyricFollow, true,
               "restoring the pane was read as the reader scrolling it");
  // ...and the song still moves it on the next line change.
  e2._highlightLyric({ pos: 44, duration: 90 });
  assert.equal(fresh.querySelector(".lyric-now").dataset.li, "44");
  assert.ok(fresh.scrollTop > 0);
});

test("a lyric update with no pane on screen does nothing at all", () => {
  pageMoves.length = 0;
  const el = panel();
  el._drawer = "lyrics";
  el._lyrics = { data: { kind: "synced", lines: [{ t: 0, text: "x" }] } };
  el._highlightLyric({ pos: 5, duration: 10 });        // no #lyric-lines
  el._drawer = null;
  el._highlightLyric({ pos: 5, duration: 10 });        // drawer closed
  assert.deepEqual(pageMoves, []);
});

// ======================================================================
// 3. transport
// ======================================================================
const ALL = 1 | 16 | 32 | 16384;      // pause | previous | next | play

function withPlayer(state, supported) {
  const el = panel();
  el._entityMap = { output: "select.out" };
  el._hass = {
    states: {
      "select.out": { state: "Den", attributes: { output_entity_id: "media_player.den" } },
      "media_player.den": {
        entity_id: "media_player.den", state,
        attributes: { friendly_name: "Den", supported_features: supported },
      },
    },
  };
  return el;
}

test("every transport button is offered only if the player says it can", () => {
  const t = withPlayer("playing", ALL)._transportState();
  assert.deepEqual(t.can, { prev: true, next: true, pause: true, play: true });

  // a player that can only go forwards
  const only = withPlayer("playing", 32)._transportState();
  assert.deepEqual(only.can, { prev: false, next: true, pause: false, play: false });

  // and one that advertises nothing
  const none = withPlayer("idle", 0)._transportState();
  assert.deepEqual(none.can, { prev: false, next: false, pause: false, play: false });
});

test("play/pause follows the player's own state, not our last press", () => {
  assert.equal(withPlayer("playing", ALL)._transportState().playing, true);
  assert.equal(withPlayer("paused", ALL)._transportState().playing, false);
  assert.equal(withPlayer("idle", ALL)._transportState().playing, false);

  const playingHtml = withPlayer("playing", ALL)._renderTransport(true);
  assert.ok(playingHtml.includes('id="tr-pause"'), "playing shows Pause");
  assert.ok(!playingHtml.includes('id="tr-play"'));
  const pausedHtml = withPlayer("paused", ALL)._renderTransport(true);
  assert.ok(pausedHtml.includes('id="tr-play"'), "paused shows Play");
  assert.ok(!pausedHtml.includes('id="tr-pause"'));
});

test("with no speaker selected every control is disabled and says so", () => {
  const el = panel();
  el._entityMap = {};
  el._hass = { states: {} };
  const t = el._transportState();
  assert.equal(t.player, null);
  assert.match(t.why, /No Music Assistant speaker/);
  const html = el._renderTransport(false);
  for (const id of ["tr-prev", "tr-next", "tr-play"]) {
    assert.ok(html.includes(`id="${id}"`), `${id} is still drawn`);
  }
  // the transport buttons are inert; with no catalog there are no thumbs
  assert.equal((html.match(/disabled/g) || []).length >= 3, true, html);
  assert.ok(!html.includes('id="thumb-up"'), "no thumbs without a catalog");
});

test("an unavailable speaker disables the controls rather than lying", () => {
  const el = withPlayer("unavailable", ALL);
  const t = el._transportState();
  assert.equal(t.unavailable, true);
  assert.match(t.why, /Den is unavailable/);
  assert.ok(el._renderTransport(false).includes("Den is unavailable"));
});

test("an unsupported control explains itself instead of failing silently", () => {
  const html = withPlayer("playing", 32)._renderTransport(true);   // next only
  assert.ok(html.includes("does not support previous track"),
            "the disabled button carries the reason");
  // the one it CAN do is live
  const next = html.slice(html.indexOf('id="tr-next"'));
  assert.ok(!next.slice(0, next.indexOf(">")).includes("disabled"));
});

test("thumbs are not drawn when there is no catalog (alpha.4)", () => {
  // no dj_status entity at all: the backend has published no catalog
  const el = withPlayer("playing", ALL);
  assert.equal(el._renderThumbs(true), "", "nothing to record into, nothing drawn");
  assert.ok(!el._renderTransport(true).includes('class="tsep"'),
            "no orphan divider where the thumbs used to be");
  const st = el._thumbsState(true);
  assert.equal(st.hide, true);
  assert.ok(st.why.includes("local ParlorWave music catalog"), "the reason is kept");
});

test("thumbs become live when the backend publishes a usable catalog", () => {
  const el = withPlayer("playing", ALL);
  el._entityMap.dj_status = "sensor.dj";
  el._hass.states["sensor.dj"] = {
    state: "idle", attributes: { catalog: { usable: true, track_count: 900 } },
  };
  const html = el._renderThumbs(true);
  const up = html.slice(html.indexOf('id="thumb-up"'));
  assert.ok(!up.slice(0, up.indexOf(">")).includes("disabled"),
            "a real catalog enables the thumb");
});

// ======================================================================
// 3b. THE DISPLAY MOVES ONLY WHILE AUDIO DOES
// ======================================================================
/* The little activity display must not keep swaying over a paused
 * speaker. It was driven by On Air's own `playing`, which deliberately
 * counts paused and buffering -- right for the transport buttons and the
 * progress bar, wrong for a thing whose whole meaning is motion.
 *
 * EXECUTED rather than read, because the defect was in WHICH of two
 * truths the mode was computed from, and both were present in the source.
 *
 * The bar meter this was written for has since been removed from the
 * stage; the rule it pins is the Mouth's now, and the rule is the point. */
function withAudio(playerState, cardState, kind) {
  const el = panel();
  el._entityMap = { output: "select.out" };
  el._hass = {
    states: {
      "select.out": { state: "Den", attributes: { output_entity_id: "media_player.den" } },
      "media_player.den": {
        entity_id: "media_player.den", state: playerState,
        attributes: { friendly_name: "Den", supported_features: 0 },
      },
    },
  };
  return el._audioMode({ lamp: kind === "onair" },
                       { state: cardState, kind: kind || "music" },
                       el._hass.states["media_player.den"]);
}

test("a paused speaker stops the display", () => {
  const m = withAudio("paused", "playing", "music");
  assert.equal(m.mode, "idle", "the display kept moving over a paused speaker");
});

test("a stopped speaker stops the display", () => {
  for (const state of ["idle", "off", "standby", "unavailable"]) {
    assert.equal(withAudio(state, "idle", "music").mode, "idle", state);
  }
});

test("playing moves it again, with no state of its own to get stuck", () => {
  assert.equal(withAudio("playing", "playing", "music").mode, "music");
  assert.equal(withAudio("buffering", "playing", "music").mode, "music");
  // paused -> playing -> paused, repeatedly: the answer is a function of
  // the two states and nothing else
  for (const [p, want] of [["paused", "idle"], ["playing", "music"],
                           ["paused", "idle"], ["playing", "music"]]) {
    assert.equal(withAudio(p, "playing", "music").mode, want, p);
  }
});

test("a break on air moves it differently, and a paused one not at all", () => {
  assert.equal(withAudio("playing", "playing", "onair").mode, "speaking");
  // the lamp is lit and the audio is not moving: still, not speaking
  assert.equal(withAudio("paused", "playing", "onair").mode, "idle");
});

test("the LAMP decides speech; a card kind of dj without it is not speaking", () => {
  /* A rewind can put a spent break's tombstone under the play head:
   * the card says kind dj, the audio is a second of silence, and the state
   * line -- which reads the lifecycle -- does not light the lamp. The rule
   * used to take the kind as proof of speech on its own, and talked over
   * the silence. It now asks the lamp and nothing else. */
  assert.equal(withAudio("playing", "playing", "dj").mode, "music");
  assert.equal(withAudio("playing", "playing", "news").mode, "music");
});

test("with no player entity the card answers for it", () => {
  const el = panel();
  el._entityMap = {};
  el._hass = { states: {} };
  assert.equal(el._audioMode(null, { state: "playing", kind: "music" }, null).mode,
               "music");
  assert.equal(el._audioMode(null, { state: "paused", kind: "music" }, null).mode,
               "idle");
});

// ======================================================================
// 3c. A THUMB IS OFFERED ONLY WHERE IT CAN LAND
// ======================================================================
function withCatalog(usable, kind) {
  const el = withPlayer("playing", ALL);
  el._entityMap.dj_status = "sensor.dj";
  el._entityMap.now_playing = "sensor.now";
  el._hass.states["sensor.dj"] = {
    state: "idle", attributes: { catalog: { usable, track_count: usable ? 900 : 0 } },
  };
  el._hass.states["sensor.now"] = { state: "playing", attributes: { kind } };
  return el;
}

test("a DJ break or a bulletin cannot be rated, and says so", () => {
  for (const [kind, word] of [["dj", "DJ break"], ["news", "news bulletin"]]) {
    const el = withCatalog(true, kind);
    const st = el._thumbsState(true);
    assert.equal(st.can, false, kind);
    assert.ok(st.why.includes(word), st.why);
    assert.ok(el._renderThumbs(true).includes("disabled"), kind);
  }
});

test("with a catalog and music playing the thumb is live", () => {
  const el = withCatalog(true, "music");
  assert.equal(el._thumbsState(true).can, true);
  assert.ok(el._renderTransport(true).includes('class="tsep"'), "the divider comes back with the thumbs");
  const html = el._renderThumbs(true);
  const up = html.slice(html.indexOf('id="thumb-up"'));
  assert.ok(!up.slice(0, up.indexOf(">")).includes("disabled"));
});

test("no catalog outranks everything, with the true reason", () => {
  const st = withCatalog(false, "music")._thumbsState(true);
  assert.equal(st.can, false);
  assert.equal(st.hide, true);
  assert.ok(st.why.includes("local ParlorWave music catalog"));
  assert.ok(st.why.includes("Music Assistant does not offer a thumbs capability"));
});

test("a thumb names the song rather than reporting a bare Done", () => {
  const el = withCatalog(true, "music");
  el._hass.states["media_player.den"].attributes.media_title = "Tin Lantern";
  el._hass.states["media_player.den"].attributes.media_artist = "Wren Hollis";
  const calls = [];
  el._svc = (d, s, data, key, okText) => { calls.push({ d, s, data, key, okText }); };
  el._thumb("thumbs_up");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].s, "thumbs_up");
  assert.equal(calls[0].data.title, "Tin Lantern");
  assert.ok(calls[0].okText.includes("Tin Lantern"),
            "the banner should say which song was rated");
  assert.ok(!/^Done/.test(calls[0].okText));
});

// ======================================================================
// 3d. THE QUEUE SUMMARY IS MA's ARITHMETIC, AND NEVER INVENTS A LENGTH
// ======================================================================
function withQueue(data) {
  const el = panel();
  el._queue = { at: Date.now(), data };
  return el;
}

const Q = {
  ok: true, complete: true, total: 42, played_count: 8, upcoming_count: 33,
  current: { kind: "music", title: "One", artist: "A", duration_s: 200 },
  recent: [{ kind: "music", title: "Zero", artist: "Z", duration_s: 180 }],
  upcoming: [{ kind: "music", title: "Two", artist: "B", duration_s: 240 },
             { kind: "music", title: "Three", artist: "C", duration_s: 120 }],
};

test("the counts describe the whole queue, not the rows on screen", () => {
  const html = withQueue(Q)._renderQueue();
  assert.ok(html.includes("8 earlier"), html);
  assert.ok(html.includes("1 playing now"));
  assert.ok(html.includes("33 still to come"));
  assert.ok(html.includes("42 items in this queue"));
  // ...and it says the list is a window onto them
  assert.ok(html.includes("and 31 more after these"), "the rest are accounted for");
});

test("a duration is summed only when every listed item reports one", () => {
  const el = withQueue(Q);
  assert.equal(el._queueSeconds(Q.upcoming), 360);
  // one item with no length refuses the whole total rather than under-reporting
  assert.equal(el._queueSeconds([{ duration_s: 240 }, { kind: "music" }]), null);
  assert.equal(el._queueSeconds([{ duration_s: 240 }, { duration_s: 0 }]), null);
  assert.equal(el._queueSeconds([]), null);
});

test("a queue with no durations still shows its counts and claims no time", () => {
  const bare = {
    ...Q,
    current: { kind: "music", title: "One", artist: "A" },
    upcoming: [{ kind: "music", title: "Two", artist: "B" }],
  };
  const html = withQueue(bare)._renderQueue();
  assert.ok(html.includes("8 earlier"));
  assert.ok(!/\bmin\b/.test(html), "a length was invented from nothing");
});

test("without MA's totals the summary says it is counting the list", () => {
  const partial = { ...Q, total: null, played_count: null, upcoming_count: null };
  const html = withQueue(partial)._renderQueue();
  assert.ok(html.includes("1 earlier"), html);
  assert.ok(html.includes("2 still to come"));
  assert.ok(html.includes("counted from what is listed below"));
});

test("an unreadable queue says so instead of drawing an empty summary", () => {
  assert.ok(withQueue({ ok: false, complete: false })._renderQueue()
            .includes("Queue unavailable"));
  assert.ok(panel()._renderQueue().includes("Reading the queue"));
});

test("whole minutes, and never a decimal of one", () => {
  const el = panel();
  assert.equal(el._runWords(0), "under a minute");
  assert.equal(el._runWords(59), "under a minute");
  assert.equal(el._runWords(360), "6 min");
  assert.equal(el._runWords(3600), "1 hr");
  assert.equal(el._runWords(3900), "1 hr 5 min");
  assert.equal(el._runWords(null), null);
});

// ======================================================================
// 3e. A SUCCESS GOES AWAY; A DIAGNOSTIC DOES NOT
// ======================================================================
test("a success and a recoverable error both expire; a critical error never does", () => {
  // Was: "an error never does". Failed actions that can
  // simply be retried to go by themselves (12 s, held while read); what
  // stays is what is marked critical, and the readiness banner.
  const el = panel();
  el._setNotice(true, "Saved.");
  assert.ok(el._noticeTimer, "a success must not sit on screen forever");
  assert.deepEqual({ ok: el._notice.ok, text: el._notice.text },
                   { ok: true, text: "Saved." });

  el._setNotice(false, "That failed because of X.");
  assert.ok(el._noticeTimer, "a recoverable error goes by itself");
  assert.equal(el._noticeMeta.ms, 12000);
  assert.equal(el._notice.ok, false);

  el._setNotice(false, "The house cannot work like this.", { critical: true });
  assert.equal(el._noticeTimer, null, "a critical error stays until dismissed");
});

test("a second notice replaces the first and does not leave its timer behind", () => {
  const el = panel();
  el._setNotice(true, "One.");
  const first = el._noticeTimer;
  el._setNotice(true, "Two.");
  assert.notEqual(el._noticeTimer, first);
  assert.equal(el._notice.text, "Two.");
});

test("dismissing clears the banner and its timer together", () => {
  const el = panel();
  el._setNotice(true, "Saved.");
  el._clearNotice();
  assert.equal(el._notice, null);
  assert.equal(el._noticeTimer, null);
});

test("the expiry actually fires, and only for the success", async () => {
  const el = panel();
  const real = globalThis.setTimeout;
  let armed = null;
  globalThis.setTimeout = (fn, ms) => { armed = { fn, ms }; return 7; };
  try {
    el._setNotice(true, "Saved.");
    assert.ok(armed && armed.ms >= 5000 && armed.ms <= 120000,
              `an unreasonable lifetime: ${armed && armed.ms}`);
    armed.fn();
    assert.equal(el._notice, null, "the banner outlived its own timer");
  } finally {
    globalThis.setTimeout = real;
  }
});

test("the dismissal is a real, described control on the rendered banner", () => {
  const el = new PanelClass();
  el._entityMap = {};
  el._view = "onair";
  el.hass = FAKE_HASS;
  el._setNotice(true, "Saved.");
  el._render();
  const html = el.shadowRoot.innerHTML;
  assert.ok(html.includes('id="notice-close"'), "no way to dismiss it by hand");
  assert.ok(html.includes("aria-label=\"Dismiss this message\""));
});

// ======================================================================
// 3g. A SUCCESS FLOATS AND MOVES NOTHING
// ======================================================================
/* The complaint this answers is not about the message, it is about the
 * PAGE. Saving a setting put a green block at the top of the document, so
 * everything below it jumped down by the height of the banner -- and
 * jumped back up thirty seconds later when it expired. The control that
 * had just been pressed moved out from under the cursor, twice, to say
 * that the press had worked.
 *
 * So: a success is drawn OUT OF FLOW, and an error is not. Both keep the
 * one mechanism, the one close control and the one 30 s rule (3e above). */
function rendered(setNotice) {
  const el = new PanelClass();
  el._entityMap = {};
  el._view = "onair";
  el.hass = FAKE_HASS;
  setNotice(el);
  el._render();
  return el;
}

test("a success is an overlay, and nothing on the page makes room for it", () => {
  const el = rendered((e) => e._setNotice(true, "Saved."));
  const html = el.shadowRoot.innerHTML;
  assert.ok(html.includes('class="toast-wrap"'), "the success did not float");
  // OUT OF FLOW, asserted as position rather than as a class name: the
  // toast markup must come after the page container closes, so it is a
  // sibling of .wrap and not a block inside it.
  const wrapEnd = html.lastIndexOf("</div>");
  assert.ok(html.indexOf('class="toast-wrap"') > html.indexOf('<div class="wrap">'),
            "the toast is not in the document at all");
  const beforeToast = html.slice(0, html.indexOf('class="toast-wrap"'));
  assert.ok(!/<div class="notice ok"/.test(beforeToast),
            "an in-flow success banner is still being drawn above the page");
  assert.ok(wrapEnd > 0);
  // And the rule that makes it an overlay is declared, not hoped for.
  assert.ok(/\.toast-wrap\s*{[^}]*position:\s*fixed/.test(html),
            "the toast is not fixed to the viewport");
  // It still carries the same close control the banner always had.
  assert.ok(html.includes('id="notice-close"'));
});

test("an error keeps its place in the page and does not float", () => {
  const el = rendered((e) => e._setNotice(false, "That failed."));
  const html = el.shadowRoot.innerHTML;
  assert.ok(!html.includes('class="toast-wrap"'),
            "a diagnostic floating over the controls it describes");
  assert.ok(html.includes('<div class="notice err"'), "the error was not drawn");
  assert.ok(html.includes('id="notice-close"'));
  assert.equal(el._noticeMeta.ms, 12000, "a recoverable error has its 12 s");
});

test("the toast is responsive rather than a fixed-width desktop card", () => {
  const el = rendered((e) => e._setNotice(true, "Saved."));
  const html = el.shadowRoot.innerHTML;
  assert.ok(/@media\s*\(max-width:\s*640px\)\s*{[^}]*\.toast-wrap/.test(html),
            "nothing changes about the toast on a phone-width screen");
});

/* Dismissal by pressing elsewhere. It must take the ELEMENT out of the
 * tree and NOT re-render: a full render on pointerdown replaces the button
 * under the finger between the press and its click, and the click then
 * lands on nothing -- the same hazard `_pointerHeld` exists for. */
function withToast(ok) {
  const el = panel();
  let removed = false;
  const wrap = new FakeEl();
  wrap.remove = () => { removed = true; };
  el._notice = { ok, text: "Saved." };
  el.shadowRoot.querySelector = (sel) => (sel === ".toast-wrap" ? wrap : null);
  let rerenders = 0;
  el._render = () => { rerenders += 1; };
  return { el, wrap, removed: () => removed, rerenders: () => rerenders };
}

test("a press somewhere else takes the success away", () => {
  const t = withToast(true);
  const elsewhere = new FakeEl();
  t.el._dismissToastOnOutsidePress({ composedPath: () => [elsewhere] });
  assert.ok(t.removed(), "the toast stayed put");
  assert.equal(t.el._notice, null);
  assert.equal(t.rerenders(), 0,
               "re-rendering on pointerdown loses the click that follows it");
});

test("a press ON the toast is not a press elsewhere", () => {
  const t = withToast(true);
  t.el._dismissToastOnOutsidePress({ composedPath: () => [t.wrap] });
  assert.ok(!t.removed(), "pressing the toast dismissed it before its own X could");
  assert.ok(t.el._notice);
});

test("clicking elsewhere never takes an error away", () => {
  const t = withToast(false);
  t.el._dismissToastOnOutsidePress({ composedPath: () => [new FakeEl()] });
  assert.ok(!t.removed(), "evidence disappeared because somebody clicked away");
  assert.ok(t.el._notice);
});

// ======================================================================
// 3h. ON THE WIRE LISTS EVERY NEWSROOM; RECENT BULLETINS IS SHORT
// ======================================================================
const WIRE_TWO = {
  configured: true,
  wire: [
    { id: "s1", source: "First Newsroom", schedule_label: "Every hour at :30",
      item_title: "An episode", published_age: "12 minutes ago",
      duration: "5:00", fresh: true, state: "fresh", state_label: "Fresh",
      error: null, last_aired_label: "Last aired 11:30" },
    { id: "s2", source: "Second Newsroom", schedule_label: "Every hour at :00",
      item_title: "", published_age: null, duration: null, fresh: null,
      state: "waiting", state_label: "Nothing collected yet",
      error: null, last_aired_label: "Not aired yet" },
  ],
};

test("both configured newsrooms are on the wire, holding or not", () => {
  const html = panel()._renderNewsWire(WIRE_TWO);
  assert.ok(html.includes("First Newsroom"));
  assert.ok(html.includes("Second Newsroom"),
            "a configured source is missing from the card that lists sources");
  assert.ok(html.includes("Nothing collected yet"),
            "the empty source is there but says nothing about itself");
  // Each row carries its OWN schedule, not the station's one minute.
  assert.ok(html.includes("Every hour at :30") && html.includes("Every hour at :00"));
});

test("only an airable episode reads as fresh", () => {
  const html = panel()._renderNewsWire(WIRE_TWO);
  // Exactly one of the two rows is warm: the one actually holding an
  // episode it could put on the air. Everything else -- stale, absent,
  // failed, unfinished -- is cold, because none of them is a bulletin.
  assert.equal((html.match(/vbadge cold/g) || []).length, 1);
  assert.equal((html.match(/class="wire quiet"/g) || []).length, 1);
  // Split on the ROW, not on every class that starts with "wire" -- the
  // body div inside each row is `wire-body`, with no space after it.
  const rows = html.split('<div class="wire ');
  assert.ok(rows[1].includes("First Newsroom") && !rows[1].includes("cold"));
  assert.ok(rows[2].includes("Second Newsroom") && rows[2].includes("cold"));
});

test("a source whose feed failed is shown with its reason, not omitted", () => {
  const html = panel()._renderNewsWire({
    configured: true,
    wire: [{ id: "s2", source: "Second Newsroom",
             schedule_label: "Every hour at :00", item_title: "",
             state: "error", state_label: "The last fetch failed",
             error: "Episode too long for a bulletin (44:07)",
             last_aired_label: "Not aired yet" }],
  });
  assert.ok(html.includes("Second Newsroom"));
  assert.ok(html.includes("Episode too long for a bulletin (44:07)"),
            "the one sentence worth reading was dropped");
});

test("every wire state renders, including the shapes a half-answer makes", () => {
  const states = ["fresh", "stale", "waiting", "error", "no_feed", "who-knows"];
  for (const state of states) {
    const html = panel()._renderNewsWire({
      configured: true, wire: [{ id: "x", source: "N", state }] });
    assert.equal(typeof html, "string", state);
  }
  // No sources at all, and a backend that answered no list.
  assert.ok(panel()._renderNewsWire({ configured: true, wire: [] })
                   .includes("On the wire"));
  assert.ok(panel()._renderNewsWire({ configured: false }).includes("On the wire"));
});

const HIST_LATEST = [
  { id: "e2", source_id: "s1", source_name: "First", result: "aired",
    item_title: "latest one", aired_at: "2026-09-17T11:30:00", token: "t2",
    duration_s: 300, listen_again: true },
  { id: "e9", source_id: "s2", source_name: "Second", result: "skipped",
    reason: "boundary_too_late", scheduled_for: "2026-09-17T13:00:00",
    listen_again: false },
];
const HIST_ALL = HIST_LATEST.concat([
  { id: "e1", source_id: "s1", source_name: "First", result: "aired",
    item_title: "older one", token: "t1", listen_again: false },
  { id: "e0", source_id: "s1", source_name: "First", result: "aired",
    item_title: "oldest one", token: "t0", listen_again: false },
]);

function histPanel() {
  const el = panel();
  el._newsHistory = { latest: HIST_LATEST, rows: HIST_ALL };
  return el;
}

test("recent bulletins leads with one row per newsroom", () => {
  const html = histPanel()._renderNewsHistory();
  const lead = html.slice(0, html.indexOf("<details"));
  assert.ok(lead.includes("latest one"));
  assert.ok(lead.includes("Second"), "a source with no airing lost its row");
  assert.ok(!lead.includes("older one"),
            "the long list is still being shown by default");
});

test("the rest of the record is behind a closed disclosure", () => {
  const el = histPanel();
  const html = el._renderNewsHistory();
  assert.ok(html.includes("<details"), "there is no disclosure at all");
  assert.ok(!/<details[^>]*\sopen/.test(html), "History opens by default");
  const more = html.slice(html.indexOf("<details"));
  assert.ok(more.includes("older one") && more.includes("oldest one"));
  // The headline rows are not repeated inside it.
  assert.ok(!more.includes("latest one"));
  assert.ok(more.includes("History (2)"), "the disclosure does not say how much");
});

/* A FOLD MUST LOOK LIKE A FOLD. `display:flex` on a <summary> removes the
 * browser's own disclosure triangle, and the row then reads as a caption
 * nobody thinks to press -- which is how the rest of the record becomes
 * unreachable without anything looking broken. Caught by looking at it. */
test("the fold looks like something to press", () => {
  const el = rendered((e) => {
    e._view = "newsroom";
    e._newsHistory = { latest: HIST_LATEST, rows: HIST_ALL };
  });
  const css = el.shadowRoot.innerHTML;
  assert.ok(/summary\s*{[^}]*display:\s*flex/.test(css),
            "this test is pinning a rule that is no longer there");
  assert.ok(/summary::before\s*{[^}]*content/.test(css),
            "flex removed the disclosure triangle and nothing replaced it");
  assert.ok(/\[open\]\s*>\s*summary::before\s*{[^}]*rotate/.test(css),
            "the marker does not say whether the fold is open");
});

test("the news desk says what to do only when there is something to do", () => {
  const el = panel();
  const on = el._renderNewsDesk({ configured: true, enabled: true,
    headline: "Bulletins are on", detail: "2 newsrooms. The station airs a bulletin",
    schedule_label: "Every hour at :00 and :30", state_label: "Waiting" });
  assert.ok(on.includes("Bulletins are on") && !on.includes("2 newsrooms"));
  const live = el._renderNewsDesk({ configured: true, enabled: false, on_air: true,
    headline: "Bulletins are on", detail: "restated", state_label: "On air" });
  assert.ok(live.includes('class="lamp"') && !live.includes("restated"));
  const off = el._renderNewsDesk({ configured: true, enabled: false,
    headline: "Bulletins are off", detail: "Switch bulletins on and the station will air one" });
  assert.ok(off.includes("Switch bulletins on"), "the off state lost its instruction");
  const none = el._renderNewsDesk({ configured: false, headline: "No feed configured",
    detail: "Add one below and test it." });
  assert.ok(none.includes("Add one below"));
});

/* A station stamp is naive and station-local: its wall clock is
 * what it says, in whatever zone the browser happens to be, and the same
 * rule draws every Newsroom clock. A stamp read as UTC was hours off. */
test("a bulletin's aired clock is the station's own wall clock", () => {
  const html = histPanel()._renderNewsHistory();
  assert.ok(html.includes("Aired 11:30 AM"), html);
  assert.ok(html.includes("due 1:00 PM"), "a missed slot lost its clock");
  const el = panel();
  assert.equal(el._histClock("2026-10-15T23:30:00"), "11:30 PM");
  assert.equal(el._histClock("2026-10-16T00:05:00"), "12:05 AM");
  assert.equal(el._histClock("not a time"), "");
});

test("a recent naive stamp reads as minutes, never as hours", () => {
  const el = panel();
  const pad = (n) => String(n).padStart(2, "0");
  const t = new Date(Date.now() - 20 * 60000);
  const naive = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${
    pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
  assert.equal(el._agoText(naive), "20 min ago");
  assert.equal(el._agoText(new Date(Date.now() - 5 * 60000).toISOString()), "5 min ago");
});

test("the disclosure stays open across the panel's own rebuilds", () => {
  const el = histPanel();
  el._histOpen = true;
  assert.ok(/<details[^>]*\sopen/.test(el._renderNewsHistory()),
            "a list the owner opened closes itself on the next poll");
});

test("listen again follows the audio and never the row", () => {
  const html = histPanel()._renderNewsHistory();
  const rows = html.split('<div class="hist-row');
  const withButton = rows.filter((r) => r.includes("data-listen="));
  assert.equal(withButton.length, 1,
               "an offer to replay a recording the station no longer has");
  assert.ok(withButton[0].includes("latest one"));
  // An aired row whose audio is gone says so instead of offering nothing.
  assert.ok(html.includes("No longer available"));
});

test("an older backend that answers only the long list still reads well", () => {
  const el = panel();
  el._newsHistory = { rows: HIST_ALL };          // no `latest` key at all
  const html = el._renderNewsHistory();
  const lead = html.slice(0, html.indexOf("<details") + 1 || html.length);
  assert.ok(lead.includes("latest one"), "the card came out empty");
  assert.ok(!html.includes("<details"),
            "everything was folded away behind a disclosure");
});

test("recent bulletins survives a backend that answered only half of it", () => {
  for (const h of [{}, { rows: [] }, { latest: [] },
                   { latest: HIST_LATEST }, { rows: HIST_ALL },
                   { error: "no" }]) {
    const el = panel();
    el._newsHistory = h;
    assert.equal(typeof el._renderNewsHistory(), "string", JSON.stringify(h));
  }
});

// ======================================================================
// 3f. THE TWO DIAGNOSTIC CARDS ACTUALLY RENDER
// ======================================================================
/* These are new render paths reached only after a button is pressed, so
 * "every screen renders" below never touches them: Settings renders with
 * `_calTest` and `_weatherTest` unset, and both helpers return "" for
 * that. A throw in one of them takes the whole panel to a black screen
 * from inside Home Assistant's own update cycle, which is exactly how a
 * blank panel ships past a green source suite.
 *
 * So every branch of both is EXECUTED here, including the shapes a
 * half-answered backend produces. */
function withTests(cal, weather) {
  const el = panel();
  el._calTest = cal;
  el._weatherTest = weather;
  return el;
}

const HELD = {
  captured_at: new Date().toISOString(),
  station_time: "2026-09-17T11:22:00-07:00",
  enabled_in_settings: true,
};

test("every calendar-test branch renders without throwing", () => {
  const cases = [
    { running: true },
    { error: "the backend said no" },
    { result: { state: "no_calendar_selected" } },
    { result: { state: "calendar_unavailable", entities: [{ name: "Family" }] } },
    { result: { state: "publish_failed", publish_error: "timeout" } },
    { result: { state: "backend_has_no_context" } },
    { result: { state: "ok", entities: [{ name: "Family" }],
                backend: { ...HELD, events: [], would_say: null } } },
    { result: { state: "ok", entities: [{ name: "Family" }],
                backend: { ...HELD, would_say: "Work starts in an hour.",
                  events: [
                    { summary: "Work", start: "2026-09-17T18:00:00-07:00",
                      reason: "eligible_headsup", minutes_away: 60 },
                    { summary: "Bins", start: "2026-09-18", all_day: true,
                      reason: "beyond_allday_lead" },
                    { summary: "?", reason: "a_code_nobody_has_seen" },
                  ] } } },
    // a backend that answered half a document
    { result: { state: "ok", backend: {} } },
    { result: {} },
  ];
  for (const c of cases) {
    const html = withTests(c, null)._renderCalTest();
    assert.equal(typeof html, "string", JSON.stringify(c));
  }
  assert.equal(withTests(null, null)._renderCalTest(), "",
               "no result means no card at all");
});

test("an unrecognised event reason shows no flag rather than its own code", () => {
  const html = withTests({ result: { state: "ok", entities: [{ name: "F" }],
    backend: { ...HELD, events: [{ summary: "X", start: "2026-09-17T18:00:00-07:00",
                                   reason: "a_code_nobody_has_seen" }] } } },
    null)._renderCalTest();
  assert.ok(!html.includes("a_code_nobody_has_seen"),
            "an internal reason code reached the screen");
  assert.ok(html.includes("X"), "the event itself is still listed");
});

test("a calendar that reads and holds nothing says so as a success", () => {
  const html = withTests({ result: { state: "ok", entities: [{ name: "Family" }],
    backend: { ...HELD, events: [], would_say: null } } }, null)._renderCalTest();
  assert.ok(html.includes("news-test good"), "an empty calendar read as a fault");
  assert.ok(html.includes("No upcoming events"));
  assert.ok(html.includes("received"), "it says what the station is holding");
});

test("every weather-test branch renders without throwing", () => {
  const cases = [
    { running: true },
    { error: "the backend said no" },
    { result: { state: "no_weather_selected" } },
    { result: { state: "weather_unavailable", entity: { name: "Home" } } },
    { result: { state: "publish_failed", publish_error: "timeout" } },
    { result: { state: "backend_has_no_context", entity: { name: "Home" } } },
    { result: { state: "ok", entity: { name: "Home" },
                backend: { ...HELD, reason: "no_weather_in_snapshot" } } },
    { result: { state: "ok", entity: { name: "Home" },
                backend: { ...HELD, reason: "ok", weather_present: true,
                  fresh: true, condition: "partly_cloudy", temperature: 71.4,
                  forecast_high: 84, forecast_low: 60,
                  would_say: "It is 71 and partly cloudy.",
                  daylight: "Sunset is in two hours." } } },
    { result: { state: "ok", entity: { name: "Home" },
                backend: { ...HELD, reason: "stale", weather_present: true,
                  fresh: false, condition: "sunny", temperature: 70,
                  weather_age_minutes: 195, would_say: null } } },
    { result: { state: "ok", backend: {} } },
    { result: {} },
  ];
  for (const c of cases) {
    const html = withTests(null, c)._renderWeatherTest();
    assert.equal(typeof html, "string", JSON.stringify(c));
  }
  assert.equal(withTests(null, null)._renderWeatherTest(), "");
});

test("a stale reading is shown as a fault and is never quoted", () => {
  const html = withTests(null, { result: { state: "ok", entity: { name: "Home" },
    backend: { ...HELD, reason: "stale", weather_present: true, fresh: false,
               condition: "sunny", temperature: 70, weather_age_minutes: 195,
               would_say: null } } })._renderWeatherTest();
  assert.ok(html.includes("news-test bad"), "a stale reading read as healthy");
  assert.ok(html.includes("too old to use"));
  assert.ok(html.includes("3 hr 15 min"), "it says how old");
  assert.ok(!html.includes("In a break right now it would say"),
            "a reading too old to state must not be quoted");
});

test("a usable reading quotes the sentence a break would carry", () => {
  const html = withTests(null, { result: { state: "ok", entity: { name: "Home" },
    backend: { ...HELD, reason: "ok", weather_present: true, fresh: true,
               condition: "partly_cloudy", temperature: 71.4, forecast_high: 84,
               would_say: "It is 71 and partly cloudy." } } })._renderWeatherTest();
  assert.ok(html.includes("news-test good"));
  assert.ok(html.includes("It is 71 and partly cloudy."));
  assert.ok(html.includes("partly cloudy"), "the condition reads as words");
  assert.ok(html.includes("71"), "and the temperature is rounded, not raw");
  assert.ok(!html.includes("71.4"));
});

test("a DJ forbidden to mention it is said, and is not a failure", () => {
  const off = { ...HELD, enabled_in_settings: false, reason: "ok",
                weather_present: true, fresh: true, temperature: 70,
                would_say: "It is 70." };
  const html = withTests(null, { result: { state: "ok", entity: { name: "Home" },
    backend: off } })._renderWeatherTest();
  assert.ok(html.includes("news-test good"), "a Booth switch is not a fault");
  assert.ok(html.includes("not currently allowed to mention the weather"));
});

// ======================================================================
// 4. the break card shows the break that is ON AIR
// ======================================================================
/* A newer break audibly playing must not be shown with the text of the
 * break before it. EXECUTED here rather than read, because the defect is in
 * which of two attribute families the rendered card actually draws from --
 * a thing you can only see by rendering it. */
function withBreak(attrs) {
  const el = panel();
  el._entityMap = { dj_status: "sensor.dj" };
  el._hass = { states: { "sensor.dj": { state: "on_air", attributes: attrs } } };
  el._historyOpen = false;
  el._voiceLib = null;
  return el;
}

const HISTORY = {
  last_spoken: "That was the 13:50 break.",
  last_break_at: "2026-09-16T13:50:00-07:00",
  last_break_personality: "dry_wit",
  last_break_topics: ["weather"],
};
const LIVE = {
  on_air_break: true,
  on_air_spoken: "It's 2:22 and this is the break you are hearing.",
  on_air_break_at: "2026-09-16T14:22:00-07:00",
  on_air_break_personality: "dry_wit",
  on_air_break_topics: ["next track"],
};

test("a break on air is what the card shows, not the last completed one", () => {
  const html = withBreak({ ...HISTORY, ...LIVE })._renderLastBreak();
  assert.ok(html.includes("this is the break you are hearing"),
            "the live script is missing");
  assert.ok(!html.includes("That was the 13:50 break"),
            "the PREVIOUS break's text is still on screen -- the live bug");
  assert.ok(html.includes("Speaking now"), "the card does not say it is live");
  assert.ok(html.includes("next track") && !html.includes("weather"),
            "the topics came from the wrong break");
});

test("with nothing on air the card is history, and reads as history", () => {
  const html = withBreak(HISTORY)._renderLastBreak();
  assert.ok(html.includes("That was the 13:50 break"));
  assert.ok(!html.includes("Speaking now"),
            "history must not be dressed up as live");
  assert.ok(!html.includes("lastbreak live"),
            "the live styling leaked onto a finished break");
});

/* The On Air chips named the speaker, station and next break but
 * not who would host it. */
test("the DJ chip names the voice that hosts the next break", () => {
  const el = panel();
  el._entityMap = { voice: "select.voice" };
  const set = (state) => { el._hass = { states: { "select.voice": { state, attributes: {} } } }; };
  set("Margaret");
  assert.equal(el._djChipName(), "Margaret");
  // a shift writes the same selection: the chip follows it on the next state
  set("Night Owl");
  assert.equal(el._djChipName(), "Night Owl");
  // the backend says this voice cannot host: breaks use the default voice
  el._voiceLib = { dj: { name: "Night Owl", in_force: false, reason: "voice_missing" } };
  assert.equal(el._djChipName(), "Default voice");
  // ...but a newer pick is not tarred with the old voice's problem
  set("Margaret");
  assert.equal(el._djChipName(), "Margaret");
  // no picker yet: the library's answer, then nothing at all
  set("unavailable");
  el._voiceLib = { dj: { name: "Margaret", in_force: true } };
  assert.equal(el._djChipName(), "Margaret");
  el._voiceLib = null;
  assert.equal(el._djChipName(), null);
  assert.equal(el._chip("DJ", null), "");
});

/* One break can be the Air Check AND the first History row. */
test("history is everything the Air Check is not already showing", () => {
  const rows = [
    { id: "aaaa", type: "dj_break", at: "2026-09-16T13:50:00", text: "That was the 13:50 break." },
    { id: "nnnn", type: "news_bulletin", at: "2026-09-16T13:30:00", text: "16/09/2026 18:30 GMT" },
    { id: "bbbb", type: "dj_break", at: "2026-09-16T13:20:00", text: "That was the 13:50 break." },
  ];
  const el = withBreak({ ...HISTORY, last_break_id: "aaaa" });
  el._historyOpen = true;
  el._history = { at: Date.now(), data: { history: rows } };
  const hist = (h) => h.slice(h.indexOf('class="history"'));
  let h = hist(el._renderLastBreak());
  assert.equal((h.match(/class="hrow"/g) || []).length, 2, h);
  assert.ok(h.includes("18:30 GMT"), "the news row went with the break");
  // matched by ref, not by words: an EARLIER break with the same script stays
  assert.ok(h.includes("13:20") || h.includes("1:20"), h);
  // live, the on-air break is the featured one
  el._hass.states["sensor.dj"].attributes = { ...HISTORY, ...LIVE, last_break_id: "nnnn",
                                               on_air_break_id: "bbbb" };
  h = hist(el._renderLastBreak());
  assert.equal((h.match(/class="hrow"/g) || []).length, 2, h);
  assert.ok(h.includes("18:30 GMT"));
  // an older backend publishes no ref and nothing is dropped
  el._hass.states["sensor.dj"].attributes = HISTORY;
  assert.equal((hist(el._renderLastBreak()).match(/class="hrow"/g) || []).length, 3);
  // the featured one alone is not "no announcements"
  el._history = { at: Date.now(), data: { history: [rows[0]] } };
  el._hass.states["sensor.dj"].attributes = { ...HISTORY, last_break_id: "aaaa" };
  assert.ok(el._renderLastBreak().includes("Nothing earlier yet."));
});

test("a break on air with no script yet still says it is on air", () => {
  const html = withBreak({ ...HISTORY, on_air_break: true })._renderLastBreak();
  assert.ok(html.includes("Speaking now"));
  assert.ok(!html.includes("That was the 13:50 break"),
            "an empty live break fell back to the previous one's words");
});

test("the card never invents on-air from anything but the backend's answer", () => {
  // status says on_air, but the break attributes do not: the panel must
  // not promote history on the strength of a status string.
  const el = withBreak(HISTORY);
  el._hass.states["sensor.dj"].state = "on_air";
  const html = el._renderLastBreak();
  assert.ok(!html.includes("On air now"),
            "the panel guessed at on-air instead of being told");
});

// ======================================================================
// 4. EVERY SCREEN ACTUALLY RENDERS
// ======================================================================
/* The gap that lets a blank panel ship.
 *
 * Everything above this point either calls one render helper directly or
 * stubs `_render` out entirely (see `panel()`), and every other panel test
 * in the repository reads the SOURCE. So the one method that runs on every
 * single update -- `_render`, reached through the public `hass` setter --
 * was never executed by anything.
 *
 * The defect this catches: `on("dj-switch", …)` placed nine lines ABOVE
 * `const on = …` in that method. `const` is hoisted but not initialised,
 * so it threw a temporal-dead-zone ReferenceError out of the hass setter
 * on every render. Home Assistant sets `hass` from inside its own update
 * cycle, so the exception took the whole panel down to a black screen --
 * while a syntax check passed, the digest matched, and the source tests
 * were all green.
 *
 * These drive the real thing: a real instance, the real `_render`, the
 * public setter, once per screen. Anything thrown is a failure. */
function liveEl() {
  const el = new PanelClass();          // NOT panel(): _render must be real
  el._entityMap = {};
  return el;
}

const FAKE_HASS = {
  states: {},
  auth: { data: { access_token: "x" } },
  callWS: (m) => Promise.resolve(
    String(m.type).endsWith("/entities") ? { entities: {} } : { ok: true }),
  callService: () => Promise.resolve(),
};

for (const view of ["onair", "booth", "newsroom", "station", "settings"]) {
  test(`${view} renders through the public hass setter without throwing`, () => {
    const el = liveEl();
    el._view = view;
    el.hass = FAKE_HASS;                // the path Home Assistant itself uses
    assert.ok(el.shadowRoot.innerHTML.length > 0,
              `${view} rendered nothing at all`);
  });
}

test("a second update re-renders, which is where the bindings run", () => {
  // The first pass can succeed while a later one throws: the bindings
  // block runs after the markup is assigned, and half of it is conditional
  // on what that markup contains.
  const el = liveEl();
  for (const view of ["onair", "settings", "newsroom", "station", "booth",
                      "onair"]) {
    el._view = view;
    el.hass = FAKE_HASS;
  }
  assert.ok(el.shadowRoot.innerHTML.length > 0);
});

// ======================================================================
// 6. THE BREAK HISTORY LIST KEEPS ITS PLACE ACROSS REBUILDS
// ======================================================================
/* The defect: open History on On Air, scroll down,
 * and every routine hass update snapped the list back to the top --
 * because the setter re-renders, _render replaces shadowRoot.innerHTML
 * wholesale, and the fresh .history element starts at scrollTop 0. The
 * lyric pane already survives this; History now does too.
 *
 * The fake here does what a browser does on innerHTML assignment: the
 * .history element (and the toggle button) are NEW OBJECTS after every
 * render, their scrollTop reset to 0. Anything that survives, survives
 * because the panel carried it. */
function historyPanel() {
  const el = liveEl();
  el._view = "onair";
  el._historyOpen = true;
  el._history = { at: Date.now(), data: { history: Array.from(
    { length: 20 }, (_, i) => ({ type: "dj_break",
      at: "2026-09-26T12:00:00-07:00", text: `Break number ${i}.` })) } };
  const root = el.shadowRoot;
  let hist = null;
  Object.defineProperty(root, "innerHTML", {
    get() { return this._html || ""; },
    set(v) {
      this._html = v;
      hist = v.includes('class="history"') ? new FakeEl() : null;
      root._byId = v.includes('id="history-toggle"')
        ? { "history-toggle": new FakeEl("button") } : {};
    },
  });
  root.querySelector = (sel) => (sel === ".history" ? hist : null);
  return { el, hist: () => hist,
           toggle: () => root._byId["history-toggle"] };
}

test("History scroll survives repeated hass updates", () => {
  const { el, hist } = historyPanel();
  el.hass = FAKE_HASS;
  const first = hist();
  assert.ok(first, "History never rendered");
  assert.equal(first.scrollTop, 0, "a fresh list starts at the top");
  first.scrollTop = 140;                       // the reader scrolls down
  for (let i = 0; i < 4; i++) {
    el.hass = FAKE_HASS;                       // a routine Home Assistant update
    assert.notEqual(hist(), first, "the fake did not rebuild the element");
    assert.equal(hist().scrollTop, 140,
                 `update ${i + 1} threw the reader back to the top`);
  }
  // Scrolling further between updates is kept too: the position carried
  // is wherever the READER left it, not wherever we last put it.
  hist().scrollTop = 260;
  el.hass = FAKE_HASS;
  assert.equal(hist().scrollTop, 260);
});

test("closing History on purpose forgets the place; reopening starts fresh", () => {
  const { el, hist, toggle } = historyPanel();
  el.hass = FAKE_HASS;
  hist().scrollTop = 200;
  el.hass = FAKE_HASS;
  assert.equal(hist().scrollTop, 200);
  toggle().dispatch("click");                  // the real close handler
  assert.equal(el._historyOpen, false);
  assert.equal(hist(), null, "a closed History still rendered its list");
  assert.equal(el._historyScrollTop, 0, "the stored place outlived the close");
  toggle().dispatch("click");                  // reopen, freshly
  assert.equal(el._historyOpen, true);
  assert.ok(hist(), "reopening did not render the list");
  assert.equal(hist().scrollTop, 0, "a reopened History must start at the top");
});

test("the History restore assigns one element's scrollTop and moves no page", () => {
  const { el, hist } = historyPanel();
  el.hass = FAKE_HASS;
  hist().scrollTop = 90;
  pageMoves.length = 0;
  el.hass = FAKE_HASS;
  assert.equal(hist().scrollTop, 90);
  assert.deepEqual(pageMoves, [], "restoring History moved something else");
});

test("no helper in _render is used above its own declaration", () => {
  /* The static half of the same bug, so it is named rather than merely
   * caught: a `const` arrow declared in `_render` and called earlier in
   * the same method is a ReferenceError at runtime and looks perfectly
   * ordinary in review. */
  const src = readFileSync(PANEL, "utf8");
  const lines = src.split("\n");
  const start = lines.findIndex((l) => /^\s*_render\(\)\s*\{/.test(l));
  assert.ok(start >= 0, "could not find _render");
  let depth = 0, end = -1;
  for (let i = start; i < lines.length; i++) {
    depth += (lines[i].match(/\{/g) || []).length;
    depth -= (lines[i].match(/\}/g) || []).length;
    if (i > start && depth <= 0) { end = i; break; }
  }
  const body = lines.slice(start, end + 1);
  for (const m of body.join("\n").matchAll(/const (\w+) = \(/g)) {
    const name = m[1];
    const decl = body.findIndex((l) => l.includes(`const ${name} = (`));
    const used = body.findIndex((l, i) =>
      i < decl && new RegExp(`(?<![.\\w])${name}\\(`).test(l));
    assert.equal(used, -1,
      `_render calls ${name}() on line ${start + used + 1}, before its ` +
      `declaration on line ${start + decl + 1} -- a temporal dead zone`);
  }
});

// ======================================================================
// 3g. DIAL STATIONS (Station tab): setup and Test Station, never playback
// ======================================================================
/* Every branch of the card is EXECUTED, and the two actions that talk to
 * the backend are driven with a capturing _ws: Test Station must send a
 * dry-run intent, Try again must advance the draw, and Save must send the
 * label and the term as separate fields. The websocket call is made before
 * each method's first await, so capture is synchronous. */
const DIAL_PRESETS = [
  { id: "preset_1", label: "Evening Drive", kind: "music", query: "Cold Orchard",
    enabled: true, last_test: { query: "Cold Orchard", at: "x", status: "ok",
    strategy: "artist_radio", tracks: 25, artists: 11 } },
  { id: "preset_2", label: "Old", kind: "music", query: "90s rock", enabled: false },
  { id: "preset_3", label: "All News", kind: "news", source: "all_news", enabled: true },
];
const OK_PREVIEW = {
  ok: true, dry_run: true, status: "ok",
  summary: { total_tracks: 1, unique_artists: 1, seed_matches: 0,
             related_matches: 0, category_matches: 1, duplicates_rejected: 2 },
  resolution: { strategy: "genre", genres: [{ name: "Country" }],
                era: { label: "1970s" }, notes: ["a note"],
                warnings: [{ code: "short", message: "Only one track." }],
                roster: [{ artist: "Somebody" }] },
  quality: [], tracks: [{ position: 1, artist: "Somebody", title: "Song",
                          album: "LP", year: 1972, why: "Country · 1970s" }],
  last_test: { query: "70s country", at: "x", status: "ok", strategy: "genre",
               tracks: 1, artists: 1 },
};

function dialPanel(calls) {
  const el = panel();
  el._dial = { at: Date.now(), data: { presets: DIAL_PRESETS, max_presets: 12 } };
  el._clearNotice = () => {};
  el._setNotice = () => {};
  el._ws = (type, extra) => { calls.push([type, extra]); return new Promise(() => {}); };
  return el;
}

test("every Dial Stations branch renders, and none offers playback", () => {
  const edit = { id: "preset_1", label: "Evening Drive", query: "70s country",
                 kind: "music", enabled: true };
  const states = [
    [null, null, null], [{ loading: true }, null, null],
    [{ at: 1, data: null, error: true }, null, null],
    [{ at: 1, data: { presets: [] } }, null, null],
    [{ at: 1, data: { presets: [], problem: "dial_settings_invalid" } }, null, null],
    [{ at: 1, data: { presets: DIAL_PRESETS } }, null, null],
    [{ at: 1, data: { presets: DIAL_PRESETS } }, edit, null],
    [{ at: 1, data: { presets: DIAL_PRESETS } }, edit, { running: true, query: "x" }],
    [{ at: 1, data: { presets: DIAL_PRESETS } }, edit, { error: "boom", query: "x" }],
    [{ at: 1, data: { presets: DIAL_PRESETS } }, edit,
     { result: { ok: false, status: "ambiguous", message: "two things",
                 resolution: { notes: ["n"], candidates: ["A", "B"] } }, query: "x" }],
    [{ at: 1, data: { presets: DIAL_PRESETS } }, edit,
     { result: OK_PREVIEW, query: "70s country", variant: 0 }],
    [{ at: 1, data: { presets: DIAL_PRESETS } }, edit,
     { result: Object.assign({}, OK_PREVIEW, { resolution: {} , summary: {} }),
       query: "something else", variant: 0 }],
  ];
  for (const [dial, ed, t] of states) {
    const el = panel();
    el._dial = dial; el._dialEdit = ed; el._dialTest = t;
    const html = el._renderDialStationsCard();
    assert.match(html, /aria-label="Dial Stations"/);
    // No blanket "Setup · not on air" badge -- the Dial lights
    // the one station that IS on the air. With nothing on the air nothing
    // here may read as on the air, and an open editor says nothing plays.
    assert.doesNotMatch(html, /\bonair\b|On air|sheet-chip lit/, "nothing is on the air, yet the Dial says so");
    if (ed) assert.match(html, /Nothing plays and nothing in the queue changes/);
    assert.doesNotMatch(html, /\bPlay\b/, "the Dial card must never offer playback");
    if (t && !t.running) assert.match(html, /Preview — not on air/);
  }
  const el = panel();
  el._dial = { at: 1, data: { presets: DIAL_PRESETS } };
  el._dialEdit = edit; el._dialTest = { result: OK_PREVIEW, query: "70s country" };
  const html = el._renderDialStationsCard();
  assert.match(html, /1 track · 1 artist</, "singular counts read as singular");
  assert.match(html, /news-test bad dial-preview/, "a warned preview wears the caution edge");
  assert.match(html, /id="dial-label"/);
  assert.match(html, /id="dial-query"/);
  assert.match(html, /<option value="news" disabled>/, "All News is shown, not offered");
  const stale = panel();
  stale._dial = el._dial; stale._dialEdit = edit;
  stale._dialTest = { result: OK_PREVIEW, query: "80s pop" };
  assert.match(stale._renderDialStationsCard(), /station term has changed/);
});

test("Test Station sends a dry-run intent, and Try again advances the draw", () => {
  const calls = [];
  const el = dialPanel(calls);
  el._dialEdit = { id: null, label: "Saturday Rock", query: "90s alternative rock",
                   kind: "music", enabled: true };
  el._dialRunTest(false);
  assert.equal(calls.length, 1);
  const [type, body] = calls[0];
  assert.equal(type, "parlorwave_radio/station_preview");
  assert.deepEqual(body.intent, { origin: "station_tab", kind: "music",
                                  label: "Saturday Rock", query: "90s alternative rock" });
  assert.equal(body.variant, 0);
  assert.equal(el._busy, "dial_test");
  el._busy = null;
  el._dialTest = { result: OK_PREVIEW, query: "90s alternative rock", variant: 0 };
  el._dialRunTest(true);
  assert.equal(calls[1][1].variant, 1, "Try again is the next draw");
  // a changed term starts again from the first draw
  el._busy = null;
  el._dialTest = { result: OK_PREVIEW, query: "90s alternative rock", variant: 1 };
  el._dialEdit.query = "90s grunge";
  el._dialRunTest(true);
  assert.equal(calls[2][1].variant, 0);
  // nothing to test: nothing sent
  el._dialEdit.query = "   ";
  el._dialRunTest(false);
  assert.equal(calls.length, 3);
});

test("Save sends label and term as separate fields and keeps ids", () => {
  const calls = [];
  const el = dialPanel(calls);
  el._dialStartEdit("preset_2");
  el._dialEdit.label = "Saturday Rock";
  el._dialEdit.query = "70s country";
  el._dialTest = { result: OK_PREVIEW, query: "70s country", variant: 0 };
  el._dialSave();
  const [type, body] = calls[0];
  assert.equal(type, "parlorwave_radio/station_dial_save");
  const saved = body.presets;
  assert.deepEqual(saved.map((p) => p.id), ["preset_1", "preset_2", "preset_3"],
                   "order and ids are kept; the edited one stays in place");
  assert.equal(saved[1].label, "Saturday Rock");
  assert.equal(saved[1].query, "70s country");
  assert.equal(saved[1].enabled, false);
  assert.deepEqual(saved[1].last_test, OK_PREVIEW.last_test);
  assert.equal(saved[2].source, "all_news");
  assert.equal(saved[2].query, undefined, "a news preset is never sent as a search");
  // a preview of a DIFFERENT term is not recorded as this preset's test
  const calls2 = [];
  const el2 = dialPanel(calls2);
  el2._dialStartEdit(null);
  el2._dialEdit.label = "New";
  el2._dialEdit.query = "Metal";
  el2._dialTest = { result: OK_PREVIEW, query: "70s country" };
  el2._dialSave();
  const added = calls2[0][1].presets[3];
  assert.equal(added.id, undefined, "a new preset's id is the backend's to mint");
  assert.equal(added.last_test, undefined);
  // an empty label or term is refused before anything is sent
  const calls3 = [];
  const el3 = dialPanel(calls3);
  el3._dialStartEdit(null);
  el3._dialEdit.query = "Metal";
  el3._dialSave();
  assert.equal(calls3.length, 0);
});

test("a retune without a new test keeps the old record, so it reads 'Needs retest'", () => {
  const calls = [];
  const el = dialPanel(calls);
  el._dialStartEdit("preset_1");                 // tested as "Cold Orchard"
  el._dialEdit.query = "Wren Hollis";            // retuned, not retested
  el._dialSave();
  const saved = calls[0][1].presets[0];
  assert.equal(saved.query, "Wren Hollis");
  assert.deepEqual(saved.last_test, DIAL_PRESETS[0].last_test,
                   "the stored record is kept: it names its own term, so the backend judges it stale");
  // ...and a test of some OTHER term is still never recorded as this preset's
  const calls2 = [];
  const el2 = dialPanel(calls2);
  el2._dialStartEdit("preset_1");
  el2._dialEdit.query = "Wren Hollis";
  el2._dialTest = { result: OK_PREVIEW, query: "70s country" };
  el2._dialSave();
  assert.deepEqual(calls2[0][1].presets[0].last_test, DIAL_PRESETS[0].last_test);
  // what the list then says, as the backend judges it
  el._dial.data = { presets: [Object.assign({}, DIAL_PRESETS[0], { query: "Wren Hollis" })],
                    builder_revision: 2, test_states: { preset_1: "stale" }, max_presets: 12 };
  el._dialEdit = null;
  const html = el._renderDialStationsCard();
  assert.match(html, />Needs retest</);
  assert.doesNotMatch(html, /Not tested yet/);
});

test("the Dial block talks to three websocket commands and no others", () => {
  const src = readFileSync(PANEL, "utf8");
  const block = src.slice(src.indexOf("  /* --- Dial Stations"),
                          src.indexOf("  /* HEALTH & DIAGNOSTICS."));
  const used = new Set([...block.matchAll(/_ws\("([^"]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...used].sort(), ["parlorwave_radio/station_dial",
    "parlorwave_radio/station_dial_save", "parlorwave_radio/station_preview"]);
  const code = block.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /callService|media_player|play_media|players\/cmd/);
});

// ======================================================================
// 3h. ON-AIR STATION (Station tab, Mode 2): live, two-step, never implicit
// ======================================================================
const LOFT_SPEAKER = "media_player.loft_speaker";
const LIVE_PRESETS = [
  { id: "preset_1", label: "Evening Drive", kind: "music", query: "Cold Orchard",
    enabled: true, last_test: { query: "Cold Orchard", at: "x", status: "ok",
    strategy: "artist_radio", tracks: 25, artists: 11, viable: true, weak: "",
    variant: 2, builder_revision: 2 } },
  { id: "preset_2", label: "Country 70s", kind: "music", query: "70s country",
    enabled: true, last_test: { query: "70s country", at: "x", status: "ok",
    strategy: "genre", tracks: 4, artists: 1, builder_revision: 2 } },
  { id: "preset_3", label: "Untested", kind: "music", query: "Metal", enabled: true },
  { id: "preset_4", label: "All News", kind: "news", source: "all_news", enabled: true },
];
const TARGETS = { ok: true, targets: [
  { queue_id: LOFT_SPEAKER, name: "Loft speaker", eligible: true, reason: "",
    message: "", dj_output: true, house_output: false },
  { queue_id: "west_wing", name: "West wing group", eligible: false,
    reason: "target_in_group", message: "That speaker belongs to a speaker group.",
    dj_output: true, house_output: true },
  { queue_id: "tv", name: "Guest TV", eligible: false, reason: "target_unavailable",
    message: "unavailable", dj_output: false, house_output: false },
] };
const ON_AIR = { ok: true, active: true, state: "on_air",
  rules: { min_opening: 15, min_artists: 3 },
  station: { station_id: "abc", status: "active", label: "Evening Drive",
    query: "Cold Orchard", kind: "music", preset_id: "preset_1",
    strategy: "artist_radio", target: { queue_id: LOFT_SPEAKER, name: "Loft speaker" },
    started_at: "2026-09-27T20:00:00",
    runway: { at: "2026-09-27T20:30:00", reason: "runway_healthy", owned: 14,
              playable: 16, ahead: { station: 14, manual: 1, preexisting: 1,
              break: 1, news: 0, announcement: 0, unknown: 0 } },
    refill: { count: 1, last_at: "2026-09-27T20:25:00", low_water: 8, target: 20,
              max_batch: 12, pending: null,
              last: { at: "2026-09-27T20:25:00", ok: true, appended: 12 } },
    problem: "" } };

function livePanel(calls) {
  const el = panel();
  el._dial = { at: Date.now(), data: { presets: LIVE_PRESETS, builder_revision: 2 } };
  el._clearNotice = () => {};
  el._setNotice = () => {};
  el._ws = (type, extra) => { calls.push([type, extra]); return new Promise(() => {}); };
  return el;
}

test("every on-air branch renders, speaks the screen's words, and never starts on its own", () => {
  const off = { ok: true, active: false, state: "off", last: null };
  const lastOff = Object.assign({}, off, { last: { label: "Old", target: { name: "Den" },
                                                  stopped_at: "2026-09-27T19:00:00" } });
  const exhausted = JSON.parse(JSON.stringify(ON_AIR));
  exhausted.station.problem = "candidates_exhausted";
  const starting = Object.assign({}, ON_AIR, { active: false, state: "starting" });
  const form = { preset_id: "preset_1", target: LOFT_SPEAKER, confirm: false };
  const states = [
    [null, null, null, false], [{ loading: true }, null, null, false],
    [{ at: 1, data: { ok: false } }, null, null, false],
    [{ at: 1, data: off }, null, null, false],
    [{ at: 1, data: lastOff }, null, null, false],
    [{ at: 1, data: Object.assign({}, off, { legacy_station_active: true }) }, null, null, false],
    [{ at: 1, data: ON_AIR }, null, null, false],
    [{ at: 1, data: ON_AIR }, null, null, true],
    [{ at: 1, data: exhausted }, null, null, false],
    [{ at: 1, data: starting }, null, null, false],
    [{ at: 1, data: off }, form, null, false],
    [{ at: 1, data: off }, form, { loading: true }, false],
    [{ at: 1, data: off }, form, { at: 1, data: null, error: true }, false],
    [{ at: 1, data: off }, form, { at: 1, data: TARGETS }, false],
    [{ at: 1, data: off }, Object.assign({}, form, { confirm: true }), { at: 1, data: TARGETS }, false],
    [{ at: 1, data: ON_AIR }, Object.assign({}, form, { preset_id: "preset_3", confirm: true }), null, false],
  ];
  for (const [live, f, targets, stopAsk] of states) {
    const el = livePanel([]);
    el._live = live; el._liveForm = f ? Object.assign({}, f) : null;
    el._liveTargets = targets; el._liveStopAsk = stopAsk;
    // The old card is split into the on-air line (the Dial stage's
    // status), the choose sheet under a pressed tile, and the Request
    // Line's own card. The word ban covers all three, as it covered the
    // card that held them.
    const line = el._renderOnAirStationCard();
    assert.match(line, /aria-label="On-air station"/);
    const html = line + (el._liveForm ? el._renderAirForm(el._liveData()) : "")
      + el._renderRequestLineCard();
    const low = html.toLowerCase();
    for (const word of ["queue_id", "station_id", "player_id", "uri", "jarvis dj",
                        "llm", "music brain", "candidates_exhausted"]) {
      assert.ok(!low.includes(word), `internal word on screen: ${word}`);
    }
  }
  const el = livePanel([]);
  el._live = { at: 1, data: off };
  let html = el._renderOnAirStationCard();
  // Off the air the line carries no entry button (a tile press
  // opens the choose sheet), and nothing asks yet.
  assert.match(html, /No Dial Station running/);
  assert.doesNotMatch(html, /id="air-open"/, "an off-air entry button: the tiles start stations now");
  assert.doesNotMatch(html, /air-confirm/);
  el._liveForm = Object.assign({}, form); el._liveTargets = { at: 1, data: TARGETS };
  html = el._renderAirForm(el._liveData());
  assert.match(html, /<button id="air-go"/, "the live press is a FILLED button");
  assert.doesNotMatch(html, /id="air-confirm"/, "a first press only asks");
  assert.match(html, /value="west_wing"[^>]*disabled/, "the house output is never offered");
  assert.doesNotMatch(html, /value="tv"/, "unrelated unavailable players are not listed");
  // the pressed tile IS the station now: a thin one, and All News, offer
  // no speaker and no start
  el._liveForm = Object.assign({}, form, { preset_id: "preset_2" });
  html = el._renderAirForm(el._liveData());
  assert.match(html, /too thin to go live/i);
  assert.doesNotMatch(html, /id="air-go"|id="air-target"|id="air-confirm"/, "a thin preset can be started");
  el._liveForm = Object.assign({}, form, { preset_id: "preset_4" });
  html = el._renderAirForm(el._liveData());
  assert.match(html, /All News stations are not in this release/);
  assert.doesNotMatch(html, /id="air-go"|id="air-target"|id="air-confirm"/, "All News can go live");
  el._liveForm = Object.assign({}, form, { confirm: true });
  html = el._renderAirForm(el._liveData());
  assert.match(html, /<button id="air-confirm"/);
  assert.match(html, /Go on air/);
  assert.match(html, /Autoplay is switched off/);
  el._live = { at: 1, data: ON_AIR }; el._liveForm = null;
  html = el._renderOnAirStationCard();
  assert.match(html, /Evening Drive/);
  assert.match(html, /on Loft speaker/);
  assert.match(html, /14 station songs queued/);
  assert.match(html, /added 12 songs/);
  assert.match(html, /id="air-stop"/);
  el._live = { at: 1, data: exhausted };
  assert.match(el._renderOnAirStationCard(), /Waiting for songs/);
});

test("Start sends exactly the chosen station and speaker; Stop sends nothing else", () => {
  const calls = [];
  const el = livePanel(calls);
  el._live = { at: 1, data: { ok: true, active: false, state: "off" } };
  el._liveForm = { preset_id: "", target: LOFT_SPEAKER, confirm: true };
  el._liveStart();
  assert.equal(calls.length, 0, "no station chosen: nothing is sent");
  el._liveForm = { preset_id: "preset_1", target: "", confirm: true };
  el._liveStart();
  assert.equal(calls.length, 0, "no speaker chosen: nothing is sent");
  el._liveForm = { preset_id: "preset_1", target: LOFT_SPEAKER, confirm: true };
  el._liveStart();
  assert.deepEqual(calls[0], ["parlorwave_radio/station_live_start",
                              { target: LOFT_SPEAKER, preset_id: "preset_1" }]);
  assert.equal(el._busy, "live_start");
  el._busy = null;
  el._liveStop();
  assert.equal(calls[1][0], "parlorwave_radio/station_live_stop");
  assert.equal(calls[1][1], undefined);
  // opening the form reads the speakers and preselects nothing implicit
  const c2 = [];
  const el2 = livePanel(c2);
  el2._live = { at: 1, data: { ok: true, active: false, state: "off" } };
  el2._liveOpenForm();
  assert.equal(c2[0][0], "parlorwave_radio/station_live_targets");
  assert.equal(el2._liveForm.target, "", "a speaker is never chosen for the person");
  assert.equal(el2._liveForm.preset_id, "preset_1", "the first station fit to go live");
  // a switch keeps the speaker the station is already on
  const el3 = livePanel([]);
  el3._live = { at: 1, data: ON_AIR };
  el3._liveOpenForm();
  assert.equal(el3._liveForm.target, LOFT_SPEAKER);
  assert.notEqual(el3._liveForm.preset_id, "preset_1", "not the station already on air");
});

test("a thin saved station stays thin on the Dial, and counts read in English", () => {
  const el = livePanel([]);
  assert.equal(el._dialViable(LIVE_PRESETS[0]), true);
  assert.equal(el._dialViable(LIVE_PRESETS[1]), false, "a record without a verdict, by its counts");
  assert.equal(el._dialViable(LIVE_PRESETS[2]), null);
  assert.equal(el._dialViable({ last_test: { tracks: 25, artists: 11, viable: false,
                                             builder_revision: 2 } }),
               false, "the stored verdict wins");
  const html = el._renderDialStationsCard();
  assert.match(html, /4 tracks · 1 artist\b/);
  assert.doesNotMatch(html, /\b1 artists/);
  assert.match(html, /Too thin to go live/);
  assert.equal((html.match(/Too thin to go live/g) || []).length, 1);
});

test("a test by an older station builder is neither tested nor thin: it needs a retest", () => {
  const el = livePanel([]);
  const old = { id: "preset_7", label: "Old Thin", kind: "music", query: "70s country",
                enabled: true, last_test: { query: "70s country", at: "x", status: "ok",
                strategy: "genre", tracks: 4, artists: 1, viable: false, weak: "pool_too_small",
                variant: 3 } };                        // no builder_revision: revision 1
  const newer = Object.assign({}, old, { id: "preset_8",
    last_test: Object.assign({}, old.last_test, { builder_revision: 1 }) });
  el._dial = { at: 1, data: { presets: [old, newer], builder_revision: 2 } };
  for (const p of [old, newer]) {
    assert.equal(el._dialTestState(p), "stale");
    assert.equal(el._dialViable(p), null, "an obsolete verdict is not a verdict");
  }
  // the backend's judgement wins over the panel's own reading
  el._dial.data.test_states = { preset_7: "current" };
  assert.equal(el._dialTestState(old), "current");
  delete el._dial.data.test_states;
  const html = el._renderDialStationsCard();
  assert.doesNotMatch(html, /Too thin to go live/);
  assert.equal((html.match(/>Needs retest</g) || []).length, 2);
  assert.match(html, /the station builder or term has changed since it was tested/);
  assert.match(html, /70s country/, "the configured term is still shown");
  assert.doesNotMatch(html, /dial-row-weak/);
  el._live = { at: 1, data: { ok: true, active: false, state: "off" } };
  // The pressed tile's sheet says it (the preset list is gone)
  el._liveForm = { preset_id: "preset_7", target: "", confirm: false };
  const sheet = el._renderAirForm(el._live.data);
  assert.match(sheet, /Old Thin/);
  assert.match(sheet, /Needs retest — the station builder or term has changed since it was tested/);
  assert.doesNotMatch(sheet, /Too thin to go live|passes the live-station rules/,
                      "a stale verdict reads as thin or as tested");
  assert.match(sheet, /id="air-go"/, "the Station tab may start a stale station; the backend re-runs the live rule");
});

test("a preview is honest about its wait, its verdict and its staleness", () => {
  const el = livePanel([]);
  const edit = { id: "preset_2", label: "Country 70s", query: "70s country",
                 kind: "music", enabled: true };
  el._dialEdit = Object.assign({}, edit);
  el._dialTest = { running: true, query: "70s country" };
  let html = el._renderDialStationsCard();
  assert.match(html, /Building station…/);
  assert.match(html, /can take\s+a little longer/);
  assert.doesNotMatch(html, /\d+\s*[–-]\s*\d+\s+seconds/, "no maximum is promised");
  assert.doesNotMatch(html, /a few\s+seconds/);
  const thin = Object.assign({}, OK_PREVIEW, { live: { viable: false, reasons: [
    { code: "pool_too_small", message: "Only 4 songs fit." }] } });
  el._dialTest = { result: thin, query: "70s country", variant: 0 };
  html = el._renderDialStationsCard();
  assert.match(html, /Too thin to go live/);
  assert.match(html, /Only 4 songs fit/);
  assert.match(html, /id="dial-stale-note"[^>]*hidden/, "fresh: the stale note is hidden");
  assert.doesNotMatch(html, /dial-preview dial-stale/);
  el._dialEdit.query = "80s pop";
  html = el._renderDialStationsCard();
  assert.match(html, /dial-preview dial-stale/, "stale: the whole preview is marked");
  assert.doesNotMatch(html, /id="dial-stale-note"[^>]*hidden/);
  assert.match(html, /Out of date/);
  assert.match(html, /id="dial-retry" disabled/, "Try again cannot redraw an old term");
  const ok = Object.assign({}, OK_PREVIEW, { live: { viable: true, reasons: [] } });
  el._dialEdit.query = "70s country";
  el._dialTest = { result: ok, query: "70s country", variant: 0 };
  assert.match(el._renderDialStationsCard(), /Passes the live-station rules/);
});

test("the on-air block talks to five websocket commands and no transport", () => {
  const src = readFileSync(PANEL, "utf8");
  const block = src.slice(src.indexOf("  /* --- On-air station (Station Programmer, Mode 2)"),
                          src.indexOf("  /* --- One song, next (alpha.4)"));
  const used = new Set([...block.matchAll(/_ws\("([^"]+)"/g)].map((m) => m[1]));
  // the fifth answers a pending Autoplay restore (restore | dismiss)
  assert.deepEqual([...used].sort(), ["parlorwave_radio/station_live",
    "parlorwave_radio/station_live_autoplay",
    "parlorwave_radio/station_live_start", "parlorwave_radio/station_live_stop",
    "parlorwave_radio/station_live_targets"]);
  const code = block.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /callService|media_player\.|play_media|players\/cmd/);
});

// ======================================================================
// 9. THE CURRENT DJ AND SWITCH DJ
// ======================================================================
const DJ_LIB = (dj) => ({
  selected: { voice_id: dj.voice_id }, kokoro: [
    { voice_id: "lewis", name: "Lewis" }, { voice_id: "emma", name: "Emma" }],
  customs: [{ voice_id: "custom_1", name: "Studio Ray", has_sample: true }],
  home_assistant: [], current: null,
  dj: Object.assign({ in_force: true, reason: null,
                      speaking_name: dj.name, lineup: [] }, dj),
});

function boothPanel(dj, speech = "on") {
  const el = panel();
  el._entityMap = { voice: "select.voice", dj_speech: "switch.speak" };
  el._hass = { states: {
    "select.voice": { entity_id: "select.voice", state: dj.name,
                      attributes: { options: ["Lewis", "Emma", "Studio Ray"] } },
    "switch.speak": { entity_id: "switch.speak", state: speech, attributes: {} },
  } };
  el._voiceLib = DJ_LIB(dj);
  return el;
}

const plain = (html) => String(html).replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&")
  .replace(/\s+/g, " ").trim();

/* The dropdown changed the headline only once it lost focus, and
 * "Last break was written as Classic FM" sat under Sarcastic unexplained. */
test("a personality press shows at once, and next and last are two facts", async () => {
  const el = panel();
  el._entityMap = { personality: "select.persona", dj_status: "sensor.dj" };
  const persona = (state) => ({ entity_id: "select.persona", state, attributes: {
    options: ["Dry Wit", "Classic FM", "Sarcastic"],
    descriptions: { "Dry Wit": "Deadpan.", "Classic FM": "Warm and unhurried.",
                    "Sarcastic": "Sharper than Dry Wit and enjoys it." } } });
  el._hass = { states: { "select.persona": persona("Classic FM"),
    "sensor.dj": { state: "idle", attributes: { last_break_personality: "classic_fm" } } } };
  let html = el._renderMicCard();
  assert.match(html, /class="booth-name">Classic FM</);
  assert.match(html, /data-persona="Classic FM"\s+aria-pressed="true"/);
  assert.match(html, /data-persona="Sarcastic"\s+aria-pressed="false"/);
  assert.doesNotMatch(html, /<select/, "the dropdown is still there");
  assert.doesNotMatch(html, /Personality is the DJ's voice and manner/, "the dense paragraph is back");
  assert.match(plain(html), /Next break: Classic FM · selected for the next break the DJ writes/);
  assert.match(plain(html), /Last break: written as Classic FM/);
  // the press: the headline, the description and the pressed chip move NOW
  let release;
  el._svc = (d, s, data) => { el._calls = [d, s, data]; return new Promise((r) => { release = r; }); };
  const pending = el._pickPersona("Sarcastic");
  html = el._renderMicCard();
  assert.match(html, /class="booth-name">Sarcastic</);
  assert.match(html, /Sharper than Dry Wit/);
  assert.match(html, /data-persona="Sarcastic"\s+aria-pressed="true"/);
  assert.match(plain(html), /Next break: Sarcastic · saving…/);
  // and the last break is still what it really was
  assert.match(plain(html), /Last break: written as Classic FM/);
  assert.deepEqual(el._calls, ["select", "select_option",
                               { entity_id: "select.persona", option: "Sarcastic" }]);
  release(true); await pending;
  el._hass.states["select.persona"] = persona("Sarcastic");
  assert.match(plain(el._renderMicCard()), /Next break: Sarcastic · selected for the next break/);
  assert.equal(el._personaPick, null);
  // a refused write gives the screen back to the saved state
  el._svc = async () => false;
  await el._pickPersona("Dry Wit");
  assert.match(el._renderMicCard(), /class="booth-name">Sarcastic</);
});

/* The old line was clipped in a one-line box. */
test("the preview line is whole, multiline and editable before Preview", async () => {
  const el = panel();
  const PHRASE = "You're listening to ParlorWave Radio. There's more great music ahead. Ready? Let's get back to it.";
  const lib = { preview: { default_text: PHRASE, max_chars: 200 } };
  let html = el._renderPreviewLine(lib);
  assert.match(html, /<textarea id="voice-preview-text" rows="3" maxlength="200"/);
  assert.ok(html.includes(`>You're listening to ParlorWave Radio. There's more great music ahead. Ready? Let's get back to it.</textarea>`),
            "the untouched box does not hold the phrase Preview will speak");
  assert.match(html, /<label class="label" for="voice-preview-text">Preview line<\/label>/);
  // untouched, Preview sends no text: the backend speaks the phrase shown
  const sent = [];
  el._ws = async (t, a) => { sent.push(a); throw new Error("no audio here"); };
  el._setNotice = () => {};
  await el._previewVoice("lewis");
  assert.deepEqual(sent[0], { voice_id: "lewis" });
  // the owner's own words are kept, and cleared means empty, not refilled
  el._previewText = "Good evening, Margaret.";
  assert.ok(el._renderPreviewLine(lib).includes(">Good evening, Margaret.</textarea>"));
  await el._previewVoice("lewis");
  assert.deepEqual(sent[1], { voice_id: "lewis", text: "Good evening, Margaret." });
  el._previewText = "";
  assert.ok(el._renderPreviewLine(lib).includes("></textarea>"));
  // a focused textarea holds a re-render back like a text input does
  const src = readFileSync(PANEL, "utf8");
  assert.match(src, /active\.tagName === "TEXTAREA"/);
});

/* A "Used for" dropdown on every row made the library very tall.
 * One chip per row now SAYS the grant and opens to change it -- grant and
 * withdraw alike -- and nothing widens a grant on its own. */
test("each voice's grant is a compact chip that still grants and withdraws", async () => {
  const el = panel();
  el._entityMap = { voice: "select.voice" };
  el._hass = { states: { "select.voice": { entity_id: "select.voice", state: "Lewis",
                                           attributes: { options: ["Lewis", "Emma"] } } } };
  el._voiceLib = { kokoro: [], home_assistant: [
      { voice_id: "lewis", name: "Lewis", scope: "dj", available: true },
      { voice_id: "emma", name: "Emma", scope: "both", available: true },
      { voice_id: "ann", name: "Ann", available: true } ],
    customs: [], selected: { voice_id: "lewis" }, current: null };
  const html = el._renderVoiceLibrary();
  assert.doesNotMatch(html, /<select data-vscope/, "the per-row dropdown is back");
  const chip = (id) => html.slice(html.indexOf(`data-vrole="${id}"`), html.indexOf("</details>", html.indexOf(`data-vrole="${id}"`)));
  assert.match(plain(chip("lewis")), /Used for: The DJ /);
  assert.match(plain(chip("emma")), /Used for: DJ and announcements /);
  // a voice nobody scoped is The DJ -- never quietly both
  assert.match(plain(chip("ann")), /Used for: The DJ /);
  // all three choices are there, so a grant can be withdrawn as well as given
  for (const sc of ["dj", "announcement", "both"]) {
    assert.match(chip("emma"), new RegExp(`data-vscope="emma" data-scope="${sc}"`));
  }
  // the DJ's own voice cannot be made announcements only (the backend agrees)
  assert.match(chip("lewis"), /data-scope="announcement" aria-pressed="false"\s+disabled/);
  assert.doesNotMatch(chip("emma"), /data-scope="announcement"[^>]*disabled/);
  // closed until opened, and an opened one survives a rebuild
  assert.doesNotMatch(chip("emma"), /data-vrole="emma" open/);
  el._vroleOpen = "emma";
  assert.match(el._renderVoiceLibrary(), /data-vrole="emma" open/);
  // one write per change, through the one command
  const calls = [];
  el._ws = async (t, a) => { calls.push([t, a]); return {}; };
  el._fetchVoiceLib = async () => {};
  await el._setVoiceScope("emma", "dj");
  assert.deepEqual(calls, [["parlorwave_radio/voice_scope", { voice_id: "emma", scope: "dj" }]]);
});

/* Replace opened its form under the whole library with no visible
 * response, and "Read this aloud" read as a strict test. */
test("Replace says whose recording and moves focus to Record in its form", () => {
  const el = panel();
  el._voiceLib = { customs: [{ voice_id: "custom_2", name: "Night Owl", scope: "both", has_sample: true }] };
  el._releaseMic = () => {};
  el._listMicrophones = () => {};
  el._openReplace("custom_2");
  assert.deepEqual(el._focusNext, { id: "rec-start" }, "focus does not go to the form");
  assert.equal(el._create.mode, "replace");
  assert.equal(el._create.scope, "both", "the grant was changed by opening Replace");
  el._consent = () => ({});
  el._cloning = () => ({});
  const src = readFileSync(PANEL, "utf8");
  assert.ok(src.includes("Replace the recording for “${this._esc(c.name || \"this voice\")}”"));
  assert.ok(src.includes("Read naturally. It doesn’t have to be word-for-word.\n        If you make a mistake, keep going—or re-record."));
  // an unknown voice opens nothing
  el._create = null;
  el._openReplace("custom_9");
  assert.equal(el._create, null);
});

/* Hovering the console threw up "Double-click for
 * station name" / "Double-click to change grille fabric" over the badge.
 * The gestures stay; the idle tooltips go (Settings still explains them). */
test("the console shows no double-click tooltips while idle", () => {
  const src = readFileSync(PANEL, "utf8");
  assert.doesNotMatch(src, /title="[^"]*Double-click|\.title = `[^`]*Double-click/);
  assert.match(src, /id="console-badge"/);
  assert.match(src, /Double-click open/, "Settings lost the one place that explains the gesture");
});

/* Switch DJ cycled the eligible voices in an order nobody
 * chose. The tile keeps the current DJ, the Selected badge and Preview;
 * Change voice is the one deliberate way to pick. */
test("the Booth names the current DJ and offers no cycling Switch DJ", () => {
  const html = boothPanel({ voice_id: "lewis", name: "Lewis",
                            next: { voice_id: "emma", name: "Emma" } })._voiceNowTile();
  assert.match(html, /class="vnow-eyebrow">Current DJ</);
  assert.match(html, /class="vnow-name">Lewis</);
  assert.match(html, /class="vbadge">Selected</);
  assert.match(html, /data-preview="lewis"/);
  assert.doesNotMatch(html, /data-switch-dj|Switch DJ|next up/);
  assert.doesNotMatch(html, /vnow-standin/, "an in-force DJ needs no explanation");
  const src = readFileSync(PANEL, "utf8");
  assert.doesNotMatch(src, /voice_switch_dj|data-switch-dj/, "a Switch DJ path is still in the panel");
});

test("a DJ that is not in force says why and what speaks instead", () => {
  const html = boothPanel({ voice_id: "custom_1", name: "Studio Ray", in_force: false,
                            reason: "voice_identity_changed",
                            speaking_name: "Service default",
                            next: { voice_id: "lewis", name: "Lewis" } })._voiceNowTile();
  assert.match(html, /class="vnow-name">Studio Ray</, "the choice is still shown as the choice");
  assert.match(html, /Not on the air: it now holds a different recording than the one you chose\. DJ breaks use the service default voice until you choose a DJ again/);
  for (const reason of ["voice_missing", "voice_authorization_withdrawn"]) {
    const h = boothPanel({ voice_id: "custom_1", name: "Studio Ray", in_force: false,
                           reason, speaking_name: "Service default" })._voiceNowTile();
    assert.doesNotMatch(h, /cannot be used as the DJ right now/, reason + " has no words");
  }
});

test("with Speak DJ breaks off the tile says the new DJ waits for it", () => {
  const html = boothPanel({ voice_id: "emma", name: "Emma",
                            next: { voice_id: "custom_1", name: "Studio Ray" } }, "off")._voiceNowTile();
  assert.match(html, /DJ breaks are off\. This voice is heard when Speak DJ breaks is back on\./);
});

test("an off-shelf legacy DJ is still named and previewable", () => {
  const legacy = boothPanel({ voice_id: "legacy_voice_1", name: "Legacy Voice",
                              next: { voice_id: "lewis", name: "Lewis" } })._voiceNowTile();
  assert.match(legacy, /class="vnow-name">Legacy Voice</);
  assert.doesNotMatch(legacy, /vnow-standin/, "an in-force legacy voice needs no warning");
});

// ======================================================================
// 10. AUTOMATIC DJ SHIFTS
// ======================================================================
const SHIFTS = (over) => Object.assign({
  enabled: true, clock_known: true, current_shift: "afternoon", next_shift: "night",
  starts: { morning: "05:00", afternoon: "12:00", night: "17:00" },
  assignments: {
    morning: { voice_id: "lewis", name: "Lewis", problem: null },
    afternoon: { voice_id: "emma", name: "Emma", problem: null },
    night: { voice_id: "custom_1", name: "Studio Ray", problem: null } },
  override: false, pending: false }, over || {});
const SHIFT_DJ = (sh) => ({ voice_id: "emma", name: "Emma", in_force: true,
  lineup: [{ voice_id: "lewis", name: "Lewis" }, { voice_id: "emma", name: "Emma" },
           { voice_id: "custom_1", name: "Studio Ray" }], next: null, shifts: sh });

test("the shifts card states the station's shift and its boundaries", () => {
  const html = panel()._renderShifts(SHIFT_DJ(SHIFTS()));
  assert.match(html, /Automatic DJ shifts/);
  assert.match(html, /data-shifts-toggle[\s\S]*?>On</);
  assert.match(html, /Afternoon shift\./);
  assert.match(html, /5 AM–12 PM/);
  assert.match(html, /12 PM–5 PM/);
  assert.match(html, /5 PM–5 AM/);
  assert.match(html, /Afternoon · now/);
  assert.match(html, /<select data-shift="night"[\s\S]*?value="custom_1" selected>Studio Ray</);
});

test("an override says until when, and a pending boundary says what happens", () => {
  const over = panel()._renderShifts(SHIFT_DJ(SHIFTS({ override: true })));
  assert.match(over, /Afternoon shift\. Manual override until Night shift\./);
  const pend = panel()._renderShifts(SHIFT_DJ(SHIFTS({ current_shift: "night",
    next_shift: "morning", pending: true })));
  assert.match(pend, /Night shift\. Its DJ takes over with the next DJ pass\./);
  const blind = panel()._renderShifts(SHIFT_DJ(SHIFTS({ clock_known: false,
    current_shift: null })));
  assert.match(blind, /Waiting for the station clock from Home Assistant\./);
  const off = panel()._renderShifts(SHIFT_DJ(SHIFTS({ enabled: false })));
  assert.match(off, /Off\. The DJ is whoever you choose\./);
  assert.doesNotMatch(off, /· now/);
});

test("a shift whose voice cannot host says so, and is not offered as a choice", () => {
  const sh = SHIFTS();
  sh.assignments.night = { voice_id: "custom_2", name: "Stranger",
                           problem: "voice_identity_changed" };
  sh.assignments.morning = { voice_id: "lewis", name: "Lewis", problem: "voice_unavailable" };
  const html = panel()._renderShifts(SHIFT_DJ(sh));
  assert.match(html, /Stranger will not host: it now holds a different recording than the one you chose\./);
  assert.match(html, /Lewis will not host: it cannot speak right now\./);
  assert.match(html, /value="custom_2" selected disabled>Stranger</);
});

test("a shift choice and the switch write through the one shifts command", async () => {
  const el = panel();
  const calls = [];
  el._ws = async (type, extra) => { calls.push([type, extra]); return { ok: true }; };
  el._fetchVoiceLib = async () => {};
  await el._setShifts({ night: "lewis" });
  await el._setShifts({ enabled: false });
  assert.deepEqual(calls, [["parlorwave_radio/voice_shifts", { night: "lewis" }],
                           ["parlorwave_radio/voice_shifts", { enabled: false }]]);
  assert.equal(el._shiftsBusy, false);
});

// Awaited, so a test that returns a promise is judged on how it settles
// rather than counted as passed the moment it starts.
for (const [name, fn] of tests) {
  try { await fn(); passed++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) {
    process.stdout.write(`  FAIL ${name}\n       ${e.message}\n`);
    process.exitCode = 1;
  }
}
process.stdout.write(`\n${passed}/${tests.length} panel DOM tests passed\n`);
