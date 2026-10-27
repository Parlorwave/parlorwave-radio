/* The Dial on the right knob and the Request Line, EXECUTED.
 *
 * Both start a station, so both are pinned by what they SEND:
 *
 *   1. The Dial: turning only browses (the first turn only opens the
 *      selector), one push asks, a separate later push starts -- exactly
 *      once, with a preset id, origin "dial" and the backend's dial_target,
 *      and nothing else. A double-click is still OUTPUT. Idle, the display
 *      goes back to the Mouth.
 *   2. The Request Line: the typed term becomes a music intent with origin
 *      request_line, on the station's own speaker (a switch) or a speaker
 *      the person picked -- never the house output, never a guess. The
 *      question names the term; the start sends exactly that term.
 *
 * The clock and the timers are the test's: Date.now and setTimeout are
 * replaced, so "a double-click can never confirm" and "the display returns
 * after 11 s" are run, not read.
 *
 *   node ha/tests/test_panel_dial_knob.mjs        (or scripts/test_panel.sh)
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL = join(HERE, "..", "custom_components", "parlorwave_radio",
                   "panel", "parlorwave-radio-panel.js");
const SRC = readFileSync(PANEL, "utf8");

// --- the smallest host ------------------------------------------------------
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
    this.innerHTML = "";
  }
  addEventListener() {}
  removeEventListener() {}
  getElementById() { return null; }
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
const winListeners = {};
globalThis.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
globalThis.window = {
  addEventListener(t, fn) { (winListeners[t] ||= []).push(fn); },
  removeEventListener() {},
  matchMedia: undefined,
};
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

/* THE CLOCK AND THE TIMERS belong to the test. */
let NOW = 1_000_000;
const realNow = Date.now;
Date.now = () => NOW;
let timers = [];
let timerId = 1;
globalThis.setTimeout = (fn, ms) => { const id = timerId++; timers.push({ id, at: NOW + (ms || 0), fn }); return id; };
globalThis.clearTimeout = (id) => { timers = timers.filter((t) => t.id !== id); };
function advance(ms) {
  const until = NOW + ms;
  for (;;) {
    const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    timers = timers.filter((t) => t !== due);
    NOW = due.at;
    due.fn();
  }
  NOW = until;
}
const settle = () => new Promise((r) => setImmediate(r));

await import(PANEL);
assert.ok(PanelClass, "the panel did not register its custom element");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const LOFT_SPEAKER = "media_player.loft_speaker";
const WEST_WING = "00000000-west-wing";
const PRESETS = [
  { id: "preset_1", label: "Nineties", kind: "music", query: "90s Rock", enabled: true,
    last_test: { query: "90s Rock", tracks: 25, artists: 11, viable: true, builder_revision: 2 } },
  { id: "preset_2", label: "Country 70s", kind: "music", query: "70s Country", enabled: true,
    last_test: { query: "70s Country", tracks: 4, artists: 1, viable: false, builder_revision: 2 } },
  { id: "preset_3", label: "Hidden", kind: "music", query: "Metal", enabled: false },
  { id: "preset_4", label: "All News", kind: "news", source: "all_news", enabled: true },
  { id: "preset_5", label: "Radio Heads", kind: "music", query: "Night Crossing", enabled: true,
    last_test: { query: "Night Crossing", tracks: 25, artists: 6, viable: true, builder_revision: 2 } },
];
const OFF = { ok: true, active: false, state: "off", last: { label: "Old",
  target: { queue_id: LOFT_SPEAKER, name: "Loft speaker" } },
  dial_target: { queue_id: LOFT_SPEAKER, name: "Loft speaker", source: "last_station" } };
const ON_AIR = { ok: true, active: true, state: "on_air",
  station: { preset_id: "preset_1", label: "Nineties", query: "90s Rock", origin: "dial",
             strategy: "genre", target: { queue_id: LOFT_SPEAKER, name: "Loft speaker" },
             started_at: "2026-09-27T20:00:00", runway: { owned: 14, ahead: {} },
             refill: { low_water: 8, max_batch: 12, last: null }, problem: "" },
  dial_target: { queue_id: LOFT_SPEAKER, name: "Loft speaker", source: "on_air" } };
const TARGETS = { ok: true, targets: [
  { queue_id: LOFT_SPEAKER, name: "Loft speaker", eligible: true },
  { queue_id: WEST_WING, name: "West wing group", eligible: false, house_output: true,
    message: "That speaker belongs to a speaker group" },
] };

/* A panel with the Dial and the on-air state loaded; every websocket call
 * is recorded and answered by `answer` (or never, by default). */
function panel({ live = OFF, answer = null } = {}) {
  timers = [];
  const el = new PanelClass();
  el.renders = 0;
  el._render = () => { el.renders++; };
  el._mouthStart = () => {};
  el._mouthStop = () => {};
  el._dial = { at: NOW, data: { presets: JSON.parse(JSON.stringify(PRESETS)), builder_revision: 2 } };
  el._live = { at: NOW, data: JSON.parse(JSON.stringify(live)) };
  el.calls = [];
  el._ws = (type, extra) => {
    el.calls.push([type, extra]);
    if (type === "parlorwave_radio/station_live_start") {
      return answer ? Promise.resolve(answer) : new Promise(() => {});
    }
    if (type === "parlorwave_radio/station_live") return Promise.resolve(el._live.data);
    if (type === "parlorwave_radio/station_dial") return Promise.resolve(el._dial.data);
    if (type === "parlorwave_radio/station_live_targets") return Promise.resolve(TARGETS);
    return Promise.resolve({});
  };
  el._setNotice = (ok, text) => { el._notice = { ok, text }; };
  el._clearNotice = () => { el._notice = null; };
  return el;
}
const starts = (el) => el.calls.filter(([t]) => t === "parlorwave_radio/station_live_start");

// ======================================================================
// 1. THE DIAL
// ======================================================================
test("the Dial lists only music stations that are on the Dial", () => {
  const el = panel();
  assert.deepEqual(el._dialStations().map((p) => p.id), ["preset_1", "preset_2", "preset_5"]);
});

test("rotation alone never starts a station, however far it turns", async () => {
  const el = panel();
  el._stationStep(1);
  assert.equal(el._stationMode, true, "the first turn opens the selector");
  assert.equal(el._stationIndex, 0, "...and only opens it");
  for (let i = 0; i < 40; i++) { el._stationStep(i % 3 ? 1 : -1); advance(100); }
  await settle();
  assert.equal(starts(el).length, 0);
  assert.equal(el._stationArmed, false);
});

test("push asks, a separate push starts, exactly once, with the id and nothing else", async () => {
  const el = panel();
  el._stationStep(1);                    // opens on the first station
  el._stationStep(1); el._stationStep(1);  // -> preset_5
  assert.equal(el._stationCandidate().id, "preset_5");
  el._stationPush();
  assert.equal(el._stationArmed, true, "the first push only asks");
  assert.equal(starts(el).length, 0);
  let html = el._renderStationLcd();
  assert.match(html, /PUSH AGAIN TO START/);
  assert.match(html, /→ Loft speaker/, "the display names the speaker it will start on");
  advance(150);
  el._stationPush();                     // the second half of a double-click
  assert.equal(starts(el).length, 0, "a double-click can never be the confirming push");
  advance(400);
  el._stationPush();
  assert.equal(starts(el).length, 1);
  assert.deepEqual(starts(el)[0][1], { target: LOFT_SPEAKER, preset_id: "preset_5", origin: "dial" });
  html = el._renderStationLcd();
  assert.match(html, /TUNING…/);
  for (let i = 0; i < 5; i++) { el._stationPush(); el._stationStep(1); advance(500); }
  assert.equal(starts(el).length, 1, "nothing more is sent while it is with the backend");
});

test("the answer is shown, then the Mouth comes back", async () => {
  const el = panel({ answer: { ok: true, opening_count: 25,
                               target: { queue_id: LOFT_SPEAKER, name: "Loft speaker" } } });
  el._stationStep(1); el._stationPush(); advance(500); el._stationPush();
  await settle();
  assert.equal(el._stationBusy, false);
  assert.match(el._renderStationLcd(), /ON AIR ✓/);
  assert.match(el._notice.text, /On air: "Nineties" on Loft speaker/);
  assert.ok(el.calls.some(([t]) => t === "parlorwave_radio/station_live"), "the card re-reads");
  advance(5000);
  assert.equal(el._stationMode, false);
});

test("a refusal is the backend's words, and nothing is retried", async () => {
  const el = panel({ answer: { ok: false, reason: "target_not_playing",
                               message: "Start something playing on that speaker first." } });
  el._stationStep(1); el._stationPush(); advance(500); el._stationPush();
  await settle();
  assert.match(el._renderStationLcd(), /NOT STARTED/);
  assert.match(el._notice.text, /Start something playing/);
  assert.equal(starts(el).length, 1);
});

test("turning away takes the question back", () => {
  const el = panel();
  el._stationStep(1); el._stationPush();
  assert.equal(el._stationArmed, true);
  el._stationStep(1);
  assert.equal(el._stationArmed, false);
  advance(1000); el._stationPush();
  assert.equal(starts(el).length, 0, "the push after a turn asks again");
});

test("a station Station Setup tested too thin cannot even be asked", () => {
  const el = panel();
  el._stationStep(1); el._stationStep(1);          // -> preset_2 (thin)
  assert.equal(el._stationCandidate().id, "preset_2");
  el._stationPush(); advance(500); el._stationPush();
  assert.equal(el._stationArmed, false);
  assert.equal(starts(el).length, 0);
  assert.match(el._renderStationLcd(), /Too thin to go live/);
  // a verdict on an older term is out of date: not thin -- it needs a retest
  el._dial.data.presets[1].query = "90s Rock";
  assert.equal(el._stationBlock(el._stationCandidate()), "Needs retest in Station Setup");
});

test("the Dial starts only a preset tested by THIS station builder", () => {
  const el = panel();
  const p = el._dial.data.presets[0];
  delete p.last_test.builder_revision;                      // tested before revisions
  el._stationStep(1);
  assert.equal(el._stationCandidate().id, "preset_1");
  el._stationPush(); advance(500); el._stationPush();
  assert.equal(starts(el).length, 0);
  assert.match(el._renderStationLcd(), /Needs retest in Station Setup/);
  p.last_test.builder_revision = 1;
  assert.equal(el._stationBlock(p), "Needs retest in Station Setup");
  delete p.last_test;
  assert.equal(el._stationBlock(p), "Test it in Station Setup first");
  // a retest stores the current revision and the preset is startable again
  p.last_test = { query: "90s Rock", tracks: 25, artists: 11, viable: true, builder_revision: 2 };
  assert.equal(el._stationBlock(p), "");
  el._stationPush(); advance(500); el._stationPush();
  assert.equal(starts(el).length, 1);
});

test("thin only from a CURRENT test; an older builder's thin needs a retest; untested needs a test", () => {
  const el = panel();
  const p = el._dial.data.presets[1];                        // preset_2: thin, this builder
  el._stationStep(1); el._stationStep(1);
  assert.equal(el._stationCandidate().id, "preset_2");
  assert.equal(el._stationBlock(p), "Too thin to go live");
  assert.match(el._renderStationLcd(), /Too thin to go live/);
  // the SAME thin verdict from an older builder is no verdict at all
  for (const rev of [undefined, 1]) {
    if (rev === undefined) delete p.last_test.builder_revision;
    else p.last_test.builder_revision = rev;
    assert.equal(el._stationBlock(p), "Needs retest in Station Setup", `revision ${rev}`);
    assert.match(el._renderStationLcd(), /Needs retest in Station Setup/);
    assert.doesNotMatch(el._renderStationLcd(), /Too thin/);
  }
  // the backend's own judgement outranks a record that looks current here
  p.last_test.builder_revision = 2;
  el._dial.data.test_states = { preset_2: "stale" };
  assert.equal(el._stationBlock(p), "Needs retest in Station Setup");
  delete el._dial.data.test_states;
  delete p.last_test;
  assert.equal(el._stationBlock(p), "Test it in Station Setup first");
  assert.match(el._renderStationLcd(), /Test it in Station Setup first/);
  el._stationPush(); advance(500); el._stationPush();
  assert.equal(starts(el).length, 0, "none of the three can even be asked");
});

test("no speaker yet: the Dial says where to pick one and starts nothing", () => {
  const el = panel({ live: Object.assign({}, OFF, { last: null, dial_target: null }) });
  el._stationStep(1); el._stationPush(); advance(500); el._stationPush();
  assert.equal(starts(el).length, 0);
  assert.match(el._renderStationLcd(), /Pick a speaker on the Station tab first/);
});

test("the station on air is marked and is not re-started by pushing", () => {
  const el = panel({ live: ON_AIR });
  el._stationStep(1);
  assert.equal(el._stationCandidate().id, "preset_1", "the selector opens on the station on air");
  const html = el._renderStationLcd();
  assert.match(html, /★/);
  assert.match(html, /On air now/);
  el._stationPush(); advance(500); el._stationPush();
  assert.equal(starts(el).length, 0);
  el._stationStep(1); el._stationStep(1);            // -> preset_5: a switch
  el._stationPush();
  assert.match(el._renderStationLcd(), /PUSH AGAIN TO SWITCH/);
});

test("a preset retuned since its station started is a NEW station: the Dial may switch to it", async () => {
  // preset_1 went on air as "90s Rock"; Station Setup has since retuned it
  // to "Night Crossing" and retested it. Same id, different station.
  const el = panel({ live: ON_AIR });
  el._live.data.station.identity = "music|90s rock|0";
  const p = el._dial.data.presets[0];
  p.query = "Night Crossing";
  p.last_test = { query: "Night Crossing", tracks: 25, artists: 6, viable: true,
                  variant: 0, builder_revision: 2 };
  el._dial.data.identities = { preset_1: "music|night crossing|0", preset_5: "music|night crossing|0" };
  el._stationStep(1);
  assert.equal(el._stationCandidate().id, "preset_1");
  assert.equal(el._stationBlock(p), "", "not 'On air now' merely because the id is the same");
  assert.doesNotMatch(el._renderStationLcd(), /★|On air now/);
  el._stationPush(); advance(500); el._stationPush();
  assert.equal(starts(el).length, 1);
  assert.deepEqual(starts(el)[0][1], { target: LOFT_SPEAKER, preset_id: "preset_1", origin: "dial" });
});

test("On air now means the saved station IS the one on air: the backend's identity decides", () => {
  const el = panel({ live: ON_AIR });
  const st = el._live.data.station;
  const p = el._dial.data.presets[0];
  st.identity = "music|90s rock|0";
  el._dial.data.identities = { preset_1: "music|90s rock|0" };
  assert.equal(el._stationBlock(p), "On air now");
  // re-approved on another draw of the same term: a different station
  el._dial.data.identities = { preset_1: "music|90s rock|1" };
  assert.equal(el._stationBlock(p), "");
  // another preset can never be "on air" by sharing a term
  el._dial.data.identities = { preset_1: "music|90s rock|0", preset_5: "music|90s rock|0" };
  assert.equal(el._stationBlock(el._dial.data.presets[4]), "");
  // a backend without identities: the id AND the term, so a retune still frees it
  delete el._dial.data.identities; delete st.identity;
  assert.equal(el._stationBlock(p), "On air now");
  p.query = "Night Crossing";
  p.last_test = { query: "Night Crossing", tracks: 25, artists: 6, viable: true, builder_revision: 2 };
  assert.equal(el._stationBlock(p), "");
});

test("idle, the selector returns to the Mouth; an unanswered question just goes away", () => {
  const el = panel();
  el._stationStep(1);
  advance(3000);
  assert.equal(el._stationPrompt, true);
  assert.match(el._renderStationLcd(), /PUSH TO CHOOSE/);
  el._stationPush();
  advance(11000);
  assert.equal(el._stationMode, false);
  assert.equal(el._stationArmed, false);
  assert.equal(starts(el).length, 0);
});

test("a double-click is always OUTPUT, and it drops the station question", () => {
  const el = panel();
  el._hass = { states: { "select.out": { state: "Den", attributes: { options: ["Den", "Kitchen"] } } } };
  el._entityMap = { output: "select.out" };
  el._stationStep(1); el._stationPush();
  el._enterOutputMode();
  assert.equal(el._outputMode, true);
  assert.equal(el._stationMode, false);
  assert.equal(el._stationArmed, false);
  el._stationStep(1);
  assert.equal(el._stationMode, false, "turning in OUTPUT browses speakers, not stations");
  el._cancelOutputMode();
  assert.equal(starts(el).length, 0);
});

test("a question is about ONE station; if the saved list changes under it, the next push asks again", async () => {
  const el = panel({ answer: { ok: true, target: { name: "Loft speaker" }, opening_count: 5 } });
  el._stationStep(1);                                   // the Dial opens on Nineties
  assert.equal(el._stationCandidate().id, "preset_1");
  el._stationPush();                                     // asks about Nineties
  assert.equal(el._stationArmed, true);
  // Station Setup reorders the list while the question stands
  el._dial.data.presets = [PRESETS[4], PRESETS[0], PRESETS[1]];
  assert.equal(el._stationCandidate().id, "preset_5", "the pointer now stands on another station");
  advance(500);
  el._stationPush();
  await settle();
  assert.equal(starts(el).length, 0, "the push asks about Radio Heads; it does not start it unasked");
  assert.equal(el._stationArmedId, "preset_5");
  advance(500);
  el._stationPush();
  await settle();
  assert.equal(starts(el).length, 1);
  assert.equal(starts(el)[0][1].preset_id, "preset_5", "and only a second push starts what was asked about");
});

test("turning opens the Dial even with no stations saved, and it says how to reach the speakers", () => {
  const el = panel();
  el._dial.data.presets = [];
  el._stationStep(1);
  assert.equal(el._stationMode, true, "an empty Dial still opens");
  assert.equal(el._outputMode, false, "turning never opens the speaker list");
  const lcd = el._renderStationLcd();
  assert.match(lcd, /No stations saved/);
  assert.match(lcd, /Push twice for speakers/);
  advance(3000);
  assert.equal(el._stationPrompt, false, "an empty Dial is never prompted to push to choose");
  el._stationPush();
  assert.equal(el._stationArmed, false, "a push on an empty Dial asks nothing");
  advance(10999);
  assert.equal(el._stationMode, true, "the push restarted its 11 s, as on any Dial");
  advance(2);
  assert.equal(el._stationMode, false, "and it closes like any Dial");
});

/* THE KNOB'S CLICK PATH, run: _knobClick is what a real release that was
 * not a turn calls, with the clock the test's. A human double-click is two
 * releases ~150 ms apart. */
function withOutput(el) {
  el._hass = { states: { "select.out": { state: "Den", attributes: { options: ["Den", "Kitchen"] } } } };
  el._entityMap = { output: "select.out" };
  el.selects = [];
  el._select = (...a) => { el.selects.push(a); };
  return el;
}
const click = (el, gap = 0) => { if (gap) advance(gap); el._knobClick("right"); };

test("THE INVARIANT: a click that becomes a double-click never also confirms a station", async () => {
  for (const armedFor of [450, 1000, 5000]) {
    const el = withOutput(panel());
    el._stationStep(1);                             // the selector: preset_1
    click(el);                                      // asks
    assert.equal(el._stationArmed, true);
    advance(armedFor);                              // armed well past the 400 ms floor
    click(el);                                      // first half of a double-click...
    click(el, 150);                                 // ...and its second half
    assert.equal(el._outputMode, true, "the pair is OUTPUT");
    assert.equal(el._stationArmed, false, "and the station question is gone");
    advance(3000); await settle();
    assert.equal(starts(el).length, 0, `armed ${armedFor} ms: OUTPUT did not also start a station`);
    assert.deepEqual(el.selects, [], "and no speaker changed");
  }
});

test("armed, a slow deliberate second push starts exactly once", async () => {
  const el = withOutput(panel());
  el._stationStep(1);
  click(el);                                        // asks
  click(el, 800);                                   // a separate, single push
  assert.equal(starts(el).length, 0, "held for the double-click window");
  assert.match(el._renderStationLcd(), /PUSH AGAIN TO START/);
  advance(400); await settle();
  assert.equal(starts(el).length, 1);
  assert.deepEqual(starts(el)[0][1], { target: LOFT_SPEAKER, preset_id: "preset_1", origin: "dial" });
  assert.equal(el._outputMode, false);
  advance(2000); await settle();
  assert.equal(starts(el).length, 1, "exactly once");
});

test("idle, a double-click is OUTPUT and starts nothing", async () => {
  const el = withOutput(panel());
  click(el); click(el, 150);
  assert.equal(el._outputMode, true);
  assert.equal(el._stationMode, false);
  advance(2000); await settle();
  assert.equal(starts(el).length, 0);
  assert.deepEqual(el.selects, []);
});

test("click noise never starts twice, and never starts from a pair", async () => {
  // a burst of clicks 120 ms apart while armed: every pair is a double-click
  const a = withOutput(panel());
  a._stationStep(1); click(a); advance(1000);
  for (let i = 0; i < 8; i++) click(a, 120);
  advance(3000); await settle();
  assert.equal(starts(a).length, 0);
  assert.deepEqual(a.selects, [], "OUTPUT on the current speaker changes nothing");
  // a bouncing confirmation (two releases 10 ms apart) counts once
  const b = withOutput(panel());
  b._stationStep(1); click(b); advance(1000);
  click(b); click(b, 10);
  advance(1000); await settle();
  assert.equal(starts(b).length, 1);
  // slow pushes while that start is with the backend send nothing more
  for (let i = 0; i < 4; i++) click(b, 700);
  advance(2000); await settle();
  assert.equal(starts(b).length, 1);
  // a single push inside the 400 ms floor after asking is no confirmation
  const c = withOutput(panel());
  c._stationStep(1); click(c); click(c, 380);
  advance(2000); await settle();
  assert.equal(starts(c).length, 0);
  assert.equal(c._stationArmed, true, "the question still stands");
});

test("turning inside the held window takes the confirmation back", async () => {
  const el = withOutput(panel());
  el._stationStep(1); click(el); click(el, 1000);  // held
  advance(100); el._stationStep(1);                // turned away in time
  advance(2000); await settle();
  assert.equal(starts(el).length, 0);
  assert.equal(el._stationArmed, false);
});

test("the keyboard: arrows browse, Enter asks and confirms, Escape leaves", () => {
  const el = panel();
  el.connectedCallback();
  const key = (k) => { for (const fn of winListeners.keydown || []) fn({ key: k, preventDefault() {}, composedPath: () => [{ tagName: "BUTTON" }] }); };
  el._stationStep(1);
  key("ArrowRight");
  assert.equal(el._stationCandidate().id, "preset_2");
  key("ArrowLeft");
  key("Enter");
  assert.equal(el._stationArmed, true);
  advance(500);
  key("Enter");
  assert.equal(starts(el).length, 1);
  assert.equal(starts(el)[0][1].preset_id, "preset_1");
  const typing = { key: "Enter", preventDefault() { throw new Error("stole a key from a text box"); },
                   composedPath: () => [{ tagName: "INPUT" }] };
  for (const fn of winListeners.keydown || []) fn(typing);
  el.disconnectedCallback && el.disconnectedCallback();
});

test("only a single push can ask or start; turning code never does", () => {
  // The binding hands a release that was not a turn to _knobClick -- once,
  // and only after the drag check -- and never reaches a station itself.
  const bind = SRC.slice(SRC.indexOf("  _bindKnobControls() {"));
  assert.equal([...bind.matchAll(/this\._knobClick\(which\)/g)].length, 1);
  assert.doesNotMatch(bind, /_stationPush|_stationClick|_dialStart/);
  const up = bind.slice(bind.indexOf("const onUp = () => {"),
                        bind.indexOf('window.addEventListener("pointermove", onMove);'));
  assert.ok(up.indexOf("if (isDragging) {") < up.indexOf("this._knobClick(which)"),
            "a drag is a turn, never a click");
  const wheel = bind.slice(bind.indexOf('btn.addEventListener("wheel"'), bind.indexOf('btn.addEventListener("pointerdown"'));
  assert.match(wheel, /_stationStep/);
  assert.doesNotMatch(wheel, /_stationPush|_stationClick|_knobClick|_dialStart/);
  // In the click: a double-click never pushes, and a single click reaches
  // the station through ONE call, in the station-selector branch.
  const click = SRC.slice(SRC.indexOf("  _knobClick(which) {"), SRC.indexOf("  async _dialStart(p) {"));
  const dbl = click.slice(0, click.indexOf("this._lastKnobClick[which] = now;"));
  assert.doesNotMatch(dbl, /_stationPush|_stationClick|_dialStart/, "a double-click never pushes");
  assert.equal([...click.matchAll(/this\._stationClick\(\)/g)].length, 1, "one call site");
  assert.doesNotMatch(click, /_stationPush\(|_dialStart/);
  const single = click.slice(click.indexOf('} else if (which === "right" && this._stationMode) {'));
  assert.ok(single.indexOf("this._stationClick()") < single.indexOf("} else {"));
});

test("the Dial holds a preset id and no station logic", () => {
  const block = SRC.slice(SRC.indexOf("  /* --- The Dial: saved stations on the right knob"),
                          SRC.indexOf("  _setCadence(value) {"));
  const code = block.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const used = new Set([...code.matchAll(/_ws\("([^"]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...used], ["parlorwave_radio/station_live_start"]);
  for (const banned of ["query:", "intent", "station_preview", "tracks", "uri", "resolve",
                        "default_request_output", "callService"]) {
    assert.ok(!code.includes(banned), `the Dial code mentions ${banned}`);
  }
});

// ======================================================================
// 2. THE REQUEST LINE
// ======================================================================
test("off air: it asks with the term and a speaker, then sends exactly that term", async () => {
  const el = panel();
  let html = el._renderRequestLine(el._liveData());
  assert.match(html, /aria-label="Request Line"/);
  assert.match(html, />Start station</);
  assert.match(html, /starts a station\./);
  assert.doesNotMatch(html, /it does not queue a single song/);
  el._reqAsk();
  assert.equal(el._reqLine.confirm, false, "an empty box asks nothing");
  assert.match(el._reqLine.result.text, /Type an artist or a genre first/);
  el._reqLine.text = "  Cold   Orchard ";
  el._reqAsk();
  assert.equal(el._reqLine.confirm, true);
  assert.equal(el._reqLine.asked, "Cold Orchard");
  assert.ok(el.calls.some(([t]) => t === "parlorwave_radio/station_live_targets"));
  await settle();
  html = el._renderRequestLine(el._liveData());
  assert.match(html, /Start a “Cold Orchard” station on Loft speaker\?/);
  assert.match(html, /value="media_player.loft_speaker"\s+selected/,
               "the backend's dial_target is offered first");
  assert.doesNotMatch(html, /value="00000000-west-wing"/, "the house output is never offered");
  assert.match(html, /<button id="rl-confirm" >Go on air</);
  assert.equal(starts(el).length, 0, "asking sends nothing");
  el._reqStart();
  assert.equal(starts(el).length, 1);
  assert.deepEqual(starts(el)[0][1], { target: LOFT_SPEAKER, intent: {
    kind: "music", origin: "request_line", label: "Cold Orchard", query: "Cold Orchard" } });
  html = el._renderRequestLine(el._liveData());
  assert.match(html, /Building station “Cold Orchard”…/);
  assert.match(html, /The first build after a restart can take a little longer\./);
  el._reqStart();
  assert.equal(starts(el).length, 1, "one press, one start");
});

test("text changed after the question is never what goes on air", async () => {
  const el = panel();
  el._reqLine.text = "Cold Orchard"; el._reqAsk(); await settle();
  el._reqLine.text = "Marlow Bay";
  el._reqStart();
  assert.equal(starts(el).length, 0);
  assert.equal(el._reqLine.confirm, false, "it asks again");
});

test("the house output is never a Request Line target, even as the last speaker", async () => {
  const el = panel({ live: Object.assign({}, OFF, { dial_target: { queue_id: WEST_WING, name: "West wing group" } }) });
  el._reqLine.text = "90s Rock"; el._reqAsk(); await settle();
  assert.equal(el._reqTargetFor(el._liveData()), "");
  assert.match(el._renderRequestLine(el._liveData()), /<button id="rl-confirm" disabled>/);
  el._reqStart();
  assert.equal(starts(el).length, 0);
});

test("on air it is a switch on the station's own speaker", async () => {
  const el = panel({ live: ON_AIR, answer: { ok: true, opening_count: 25,
    target: { queue_id: LOFT_SPEAKER, name: "Loft speaker" },
    station: { strategy: "artist_radio", seed_artist: "Marlow Bay" } } });
  let html = el._renderRequestLine(el._liveData());
  assert.match(html, />Change station</);
  el._reqLine.text = "Marlow Bay"; el._reqAsk();
  assert.ok(!el.calls.some(([t]) => t === "parlorwave_radio/station_live_targets"),
            "a switch never looks for another speaker");
  html = el._renderRequestLine(el._liveData());
  assert.match(html, /Change the station on Loft speaker to “Marlow Bay”\?/);
  el._reqStart();
  assert.equal(starts(el)[0][1].target, LOFT_SPEAKER);
  await settle();
  assert.equal(el._reqLine.text, "", "a started term leaves the box");
  assert.match(el._reqLine.result.text, /On air: Artist station · Marlow Bay on Loft speaker/);
});

test("the Request Line's 'On air' line is history once that station is not on air", async () => {
  const el = panel({ live: ON_AIR, answer: { ok: true, station_id: "st-marlow-bay", opening_count: 25,
    target: { queue_id: LOFT_SPEAKER, name: "Loft speaker" },
    station: { strategy: "artist_radio", seed_artist: "Marlow Bay" } } });
  el._reqLine.text = "Marlow Bay"; el._reqAsk(); el._reqStart(); await settle();
  const onAir = (id) => {
    el._live.data = JSON.parse(JSON.stringify(ON_AIR));
    el._live.data.station.station_id = id;
  };
  onAir("st-marlow-bay");
  assert.match(el._renderRequestLine(el._liveData()), /On air: Artist station · Marlow Bay/);
  el._live.data = JSON.parse(JSON.stringify(OFF));              // stopped
  assert.doesNotMatch(el._renderRequestLine(el._liveData()), /On air:/,
                      "a stopped station is not still announced in green");
  onAir("st-from-the-dial");                                    // replaced from elsewhere
  assert.doesNotMatch(el._renderRequestLine(el._liveData()), /On air:/);
  // a refusal is not a claim about the present: it stays until the next try
  el._reqLine.result = { ok: false, text: "The station did not start: too thin." };
  el._live.data = JSON.parse(JSON.stringify(OFF));
  assert.match(el._renderRequestLine(el._liveData()), /The station did not start: too thin\./);
});

test("a refusal keeps the term and says why", async () => {
  const el = panel({ answer: { ok: false, reason: "station_too_thin",
                               message: "Only 4 songs in the library fit this station." } });
  el._reqLine.text = "70s Country"; el._reqAsk(); await settle(); el._reqStart(); await settle();
  assert.equal(el._reqLine.text, "70s Country");
  assert.equal(el._reqLine.confirm, false);
  const html = el._renderRequestLine(el._liveData());
  assert.match(html, /notice err rl-result/);
  assert.match(html, /Only 4 songs in the library fit this station/);
});

test("what is typed survives a re-render", () => {
  const el = panel();
  el._reqLine.text = "Progressive <Rock>";
  const html = el._renderRequestLine(el._liveData());
  assert.match(html, /value="Progressive &lt;Rock&gt;"/);
});

test("a Start Radio station or a start in flight blocks it, visibly", () => {
  const el = panel({ live: Object.assign({}, OFF, { legacy_station_active: true }) });
  const html = el._renderRequestLine(el._liveData());
  assert.match(html, /<button id="rl-go" disabled>/);
  assert.match(html, /A Start Radio station is running/);
});

test("the on-air card shows where a station came from", () => {
  const el = panel({ live: ON_AIR });
  el._esc = el._esc || ((s) => String(s));
  const html = el._renderOnAirStationCard();
  assert.match(html, /started from the Dial/);
  // The Request Line is its own card under the Dial stage, offered
  // while the on-air state is known; the on-air line carries no second copy.
  const rl = el._renderRequestLineCard();
  assert.match(rl, /aria-label="Request Line"/);
  assert.match(rl, /id="rl-text"/);
  assert.doesNotMatch(html, /id="rl-text"/);
});

for (const [name, fn] of tests) {
  try { await fn(); passed++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) {
    process.stdout.write(`  FAIL ${name}\n       ${e.message}\n`);
    process.exitCode = 1;
  }
}
Date.now = realNow;
process.stdout.write(`\n${passed}/${tests.length} panel Dial/Request Line tests passed\n`);
