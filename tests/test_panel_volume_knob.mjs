/* The left knob and the Volume slider, EXECUTED.
 *
 * Four ways to change whole-home volume from On Air, driven the way a
 * browser drives them:
 *
 *   1. DRAG the left knob;
 *   2. the mouse WHEEL over it;
 *   3. STICKY TURN: one push engages turning, then the pointer anywhere on
 *      the page turns it, until Escape, a click elsewhere or another push;
 *   4. the Volume SLIDER.
 *
 * Plus the two other things the same knob does with a push: a double push
 * (DJ power) and a keyboard press.
 *
 * What is pinned is what the owner SEES and what Music Assistant is ASKED:
 * the knob's angle, the slider's value and the percentage beside it, and
 * every media_player / switch call -- step by step, with Home Assistant's
 * report of the new level arriving only when a test says it arrives.
 *
 * THIS IS A BASELINE, NOT A SPECIFICATION. It records the behaviour of the
 * panel as found, so that any later change to it is a decision
 * rather than an accident. Tests whose names start "KNOWN DEFECT" pin
 * behaviour believed to be wrong, and say why; tests whose names start
 * "AS FOUND" pin behaviour nobody has decided about yet. Fixing either means
 * changing that test on purpose, in the same commit as the fix.
 *
 * The left knob's volume hold fixed both KNOWN DEFECTs: wheel notches
 * and sticky-turn moves now step from the level last asked for, and the knob
 * keeps showing it while Home Assistant's reports catch up. Those tests now
 * pin the repaired behaviour and say "was a KNOWN DEFECT" in their
 * names, beside new ones for echoes, letting go and changes made elsewhere.
 *
 * The fake page is close to the real one exactly where it matters here:
 *
 *   - assigning innerHTML builds FRESH elements from the markup the panel
 *     actually produced (knob angle, slider value, percentage, classes),
 *     so a re-render shows up as the snap it is on screen;
 *   - window listeners are really added and really removed, so the knob's
 *     per-render rebinding is exercised rather than accumulated;
 *   - an event aimed at an element that a render has since replaced reaches
 *     only that element and never the window -- as in a browser, where a
 *     detached node is outside the document. (This is why the click that
 *     follows a push does not cancel the turning mode the push engaged: the
 *     push re-rendered, so the click lands on the old, detached knob.)
 *   - the clock and every timer belong to the test.
 *
 *   node ha/tests/test_panel_volume_knob.mjs        (or scripts/test_panel.sh)
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL = join(HERE, "..", "custom_components", "parlorwave_radio",
                   "panel", "parlorwave-radio-panel.js");

// --- listeners that can really be removed ---------------------------------
class Listeners {
  constructor() { this.all = []; }
  static capture(o) { return o === true || !!(o && o.capture); }
  add(type, fn, o) {
    const capture = Listeners.capture(o);
    if (this.all.some((l) => l.type === type && l.fn === fn && l.capture === capture && !l.gone)) return;
    this.all.push({ type, fn, capture, gone: false });
  }
  remove(type, fn, o) {
    const capture = Listeners.capture(o);
    for (const l of this.all) {
      if (l.type === type && l.fn === fn && l.capture === capture) l.gone = true;
    }
    this.all = this.all.filter((l) => !l.gone);
  }
  // a snapshot: a listener added during dispatch does not run in it
  of(type, capture) { return this.all.filter((l) => l.type === type && l.capture === capture); }
  count(type) { return this.all.filter((l) => l.type === type).length; }
}

class ClassList {
  constructor(init = "") { this._s = new Set(String(init).split(/\s+/).filter(Boolean)); }
  add(...c) { for (const x of c) this._s.add(x); }
  remove(...c) { for (const x of c) this._s.delete(x); }
  contains(c) { return this._s.has(c); }
  toggle(c, force) {
    const on = force === undefined ? !this._s.has(c) : !!force;
    if (on) this._s.add(c); else this._s.delete(c);
    return on;
  }
}

class El {
  constructor(tag, { id = null, cls = "", sel = {}, gen = 0 } = {}) {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.classList = new ClassList(cls);
    this.dataset = {};
    this.style = { transform: "", setProperty() {}, removeProperty() {}, getPropertyValue() { return ""; } };
    this.value = "";
    this.textContent = "";
    this.disabled = false;
    this.title = "";
    this.gen = gen;
    this._ls = new Listeners();
    this._sel = sel;
  }
  addEventListener(t, fn, o) { this._ls.add(t, fn, o); }
  removeEventListener(t, fn, o) { this._ls.remove(t, fn, o); }
  querySelector(s) { return this._sel[s] || null; }
  querySelectorAll() { return []; }
  getAttribute() { return null; }
  setAttribute() {}
  appendChild() {}
  remove() {}
  blur() {}
  focus() {}
}

/* The shadow root. Assigning innerHTML is a new generation of elements,
 * read back out of the markup the panel just produced. */
class Root {
  constructor() {
    this._ls = new Listeners();
    this.gen = 0;
    this._html = "";
    this._byId = {};
    this._q = {};
    this._qa = {};
    this.activeElement = null;
  }
  addEventListener(t, fn, o) { this._ls.add(t, fn, o); }
  removeEventListener(t, fn, o) { this._ls.remove(t, fn, o); }
  get innerHTML() { return this._html; }
  set innerHTML(html) {
    this._html = String(html);
    this.gen += 1;
    build(this, this._html);
  }
  getElementById(id) { return this._byId[id] || null; }
  querySelector(s) { return this._q[s] || null; }
  querySelectorAll(s) { return this._qa[s] || []; }
}

function openTag(html, at) {
  const start = html.lastIndexOf("<", at);
  return html.slice(start, html.indexOf(">", at) + 1);
}

function build(root, html) {
  const gen = root.gen;
  const byId = {}, q = {}, qa = {};
  const rotate = (re) => { const m = re.exec(html); return m ? `rotate(${m[1]}deg)` : ""; };

  // the left knob: the button, its rotating face and its LED ring
  const at = html.indexOf('id="dj-switch"');
  if (at >= 0) {
    const tag = openTag(html, at);
    const face = new El("span", { cls: "dj-face", gen });
    face.style.transform = rotate(/class="dj-face"[^>]*style="transform: rotate\((-?\d+(?:\.\d+)?)deg\);"/);
    const arc = new El("circle", { cls: "knob-arc-segment left-arc", gen });
    const btn = new El("button", { id: "dj-switch", cls: /class="([^"]*)"/.exec(tag)[1],
                                   sel: { ".dj-face": face, ".knob-arc-segment": arc }, gen });
    btn.disabled = /\sdisabled[\s>]/.test(tag);
    byId["dj-switch"] = btn;
    q["#dj-switch .dj-face"] = face;
    q["#dj-switch .knob-arc-segment"] = arc;
  }
  // the right knob, for completeness of the rebinding
  const rat = html.indexOf('id="right-knob"');
  if (rat >= 0) {
    const tag = openTag(html, rat);
    const face = new El("span", { cls: "knob-face", gen });
    face.style.transform = rotate(/class="knob-face"[^>]*style="transform: rotate\((-?\d+(?:\.\d+)?)deg\);"/);
    const arc = new El("circle", { cls: "knob-arc-segment right-arc", gen });
    byId["right-knob"] = new El("button", { id: "right-knob", cls: /class="([^"]*)"/.exec(tag)[1],
                                            sel: { ".knob-face": face, ".knob-arc-segment": arc }, gen });
    q["#right-knob .knob-face"] = face;
    q["#right-knob .knob-arc-segment"] = arc;
  }
  const housings = [];
  if (html.includes("left-knob-unit")) {
    q[".left-knob-unit .knob-housing"] = new El("div", { cls: "knob-housing", gen });
    housings.push(q[".left-knob-unit .knob-housing"]);
  }
  if (html.includes("right-knob-unit")) {
    q[".console-spk .knob-housing"] = new El("div", { cls: "knob-housing", gen });
    housings.push(q[".console-spk .knob-housing"]);
  }
  qa[".pw-knob-unit .knob-housing"] = housings;

  // the Volume row: slider, percentage, mute
  const range = /<input type="range" id="vol-range"([^>]*)>/.exec(html);
  if (range) {
    const el = new El("input", { id: "vol-range", gen });
    const v = /value="(-?\d+)"/.exec(range[1]);
    el.value = v ? v[1] : "";
    el.disabled = /\sdisabled\b/.test(range[1]);
    byId["vol-range"] = el;
  }
  const pct = /<span class="vol-pct">([^<]*)<\/span>/.exec(html);
  if (pct) {
    const el = new El("span", { cls: "vol-pct", gen });
    el.textContent = pct[1];
    q[".vol-pct"] = el;
  }
  if (html.includes('id="vol-mute"')) byId["vol-mute"] = new El("button", { id: "vol-mute", gen });

  root._byId = byId;
  root._q = q;
  root._qa = qa;
}

// --- the page around it -----------------------------------------------------
const win = {
  _ls: new Listeners(),
  addEventListener(t, fn, o) { this._ls.add(t, fn, o); },
  removeEventListener(t, fn, o) { this._ls.remove(t, fn, o); },
  matchMedia: undefined,
};
globalThis.window = win;
globalThis.document = {
  visibilityState: "visible", hidden: false,
  addEventListener() {}, removeEventListener() {},
  createElement: (t) => new El(t),
};
globalThis.HTMLElement = class {
  constructor() {
    this.style = { setProperty() {}, removeProperty() {}, getPropertyValue() { return ""; } };
  }
  attachShadow() { this.shadowRoot = new Root(); return this.shadowRoot; }
};
let PanelClass = null;
globalThis.customElements = { get: () => undefined, define: (_n, c) => { PanelClass = c; } };
// the 1 s progress ticker is not the point here
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
// the eye blink's interval: fixed, so a test can never meet it by chance
Math.random = () => 0.5;

/* THE CLOCK AND THE TIMERS belong to the test. */
let NOW = 1_000_000;
Date.now = () => NOW;
let timers = [];
let timerId = 1;
globalThis.setTimeout = (fn, ms) => { const id = timerId++; timers.push({ id, at: NOW + (ms || 0), fn }); return id; };
globalThis.clearTimeout = (id) => { timers = timers.filter((t) => t.id !== id); };
function advance(ms) {
  const until = NOW + ms;
  for (;;) {
    const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
    if (!due) break;
    timers = timers.filter((t) => t !== due);
    NOW = due.at;
    due.fn();
  }
  NOW = until;
}
const settle = () => new Promise((r) => setImmediate(r));

/* One event, dispatched the way the DOM does: capture from the window down,
 * the target, then bubbling back up. An element from an older render is
 * detached: its event reaches it and nothing else. */
let ROOT = null;
function fire(target, type, init = {}) {
  const connected = target === win || (ROOT && target.gen === ROOT.gen);
  const path = target === win ? [win] : connected ? [target, ROOT, win] : [target];
  const ev = {
    type, target, button: 0, detail: 1, clientX: 0, clientY: 0, deltaX: 0, deltaY: 0,
    ...init,
    defaultPrevented: false, _stop: false, _halt: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this._stop = true; },
    stopImmediatePropagation() { this._stop = true; this._halt = true; },
    composedPath() { return path; },
  };
  const phases = [];
  for (let i = path.length - 1; i >= 1; i--) phases.push([path[i], true]);
  phases.push([path[0], true], [path[0], false]);
  for (let i = 1; i < path.length; i++) phases.push([path[i], false]);
  let current = null;
  for (const [node, capture] of phases) {
    if (ev._stop && node !== current) break;
    current = node;
    for (const l of node._ls.of(type, capture)) {
      if (ev._halt) break;
      if (l.gone) continue;
      l.fn.call(node, ev);
    }
    if (ev._halt) break;
  }
  return ev;
}

await import(PANEL);
assert.ok(PanelClass, "the panel did not register its custom element");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// --- the installation -------------------------------------------------------
const READY = { state: "ready", blockers: [], complete: 6, total: 6,
                headline: "Ready.", detail: "" };
// 16445 = play | pause | previous | next | volume set | volume mute | ...
const ALL_FEATURES = 16445;

function hassFor(ha, calls) {
  return {
    states: {
      "switch.dj": { entity_id: "switch.dj", state: ha.dj, attributes: {} },
      "sensor.dj": { entity_id: "sensor.dj", state: "waiting",
                     attributes: { enabled: ha.dj === "on", outputs_enabled: ["media_player.den"] } },
      "select.out": { entity_id: "select.out", state: "Den",
                      attributes: { options: ["Den", "Kitchen"], output_entity_id: "media_player.den" } },
      "media_player.den": {
        entity_id: "media_player.den", state: ha.player,
        attributes: { friendly_name: "Den", supported_features: ha.features,
                      media_title: "Lost Bells", media_artist: "Cold Orchard",
                      volume_level: ha.level },
      },
    },
    auth: { data: { access_token: "x" } },
    callService: (domain, service, data) => {
      calls.push({ svc: `${domain}.${service}`, data: { ...data } });
      return ha.refuse && service === "volume_set"
        ? Promise.reject(new Error("The player refused the volume."))
        : Promise.resolve();
    },
    callWS: (msg) => { calls.push({ ws: msg.type }); return Promise.resolve({ ok: true }); },
  };
}

/* A connected panel on On Air, rendered once with the player at `level`.
 * Home Assistant does NOT echo a write back by itself: `el.report(...)` is
 * the player's new state arriving, whenever the test decides it arrives. */
function mount({ level = 0.5, features = ALL_FEATURES, player = "playing", dj = "on", refuse = false } = {}) {
  timers = [];
  win._ls = new Listeners();
  const el = new PanelClass();
  ROOT = el.shadowRoot;
  el.calls = [];
  el._entityMap = { dj_enabled: "switch.dj", dj_status: "sensor.dj", output: "select.out" };
  el._ready = { at: NOW, data: { readiness: READY } };
  el._voiceLib = {};
  el._dial = { at: NOW, data: { presets: [] } };
  el._live = { at: NOW, data: { ok: true, active: false, state: "off" } };
  el.connectedCallback();
  const ha = { level, features, player, dj, refuse };
  el.report = (patch = {}) => { Object.assign(ha, patch); el.hass = hassFor(ha, el.calls); };
  el.report();
  return el;
}

// --- what the owner sees, and what Music Assistant is asked ---------------
function shown(el) {
  const r = el.shadowRoot;
  const face = r.querySelector("#dj-switch .dj-face");
  const range = r.getElementById("vol-range");
  const pct = r.querySelector(".vol-pct");
  const m = face && /rotate\((-?\d+(?:\.\d+)?)deg\)/.exec(face.style.transform);
  return { deg: m ? Number(m[1]) : null,
           slider: range ? Number(range.value) : null,
           pct: pct ? pct.textContent : null };
}
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const asked = (el) => el.calls.filter((c) => c.svc === "media_player.volume_set")
  .map((c) => r4(c.data.volume_level));
const services = (el) => el.calls.filter((c) => c.svc).map((c) => c.svc);
const knob = (el) => el.shadowRoot.getElementById("dj-switch");
const slider = (el) => el.shadowRoot.getElementById("vol-range");

/* The knob's own picture of a level, from the markup it renders, so every
 * expectation below is a literal the owner would read off the screen. */
const AT = (deg, pct) => ({ deg, slider: pct, pct: `${pct}%` });

const press = (el, x = 100, y = 100) => { const b = knob(el); fire(b, "pointerdown", { clientX: x, clientY: y }); return b; };
const move = (x, y) => fire(win, "pointermove", { clientX: x, clientY: y });
const lift = (x = 100, y = 100) => fire(win, "pointerup", { clientX: x, clientY: y });
/* A push: down, up, and the click the browser sends to what was pressed. */
function push(el, x = 100, y = 100) {
  const b = press(el, x, y);
  lift(x, y);
  fire(b, "click", { clientX: x, clientY: y });
  return b;
}
const wheel = (el, deltaY) => fire(knob(el), "wheel", { deltaY });
const escape = () => fire(win, "keydown", { key: "Escape" });

// ======================================================================
// 0. WHAT IS DRAWN
// ======================================================================
test("knob, slider and percentage all show the player's reported level", () => {
  const el = mount({ level: 0.5 });
  assert.deepEqual(shown(el), AT(0, 50));
  el.report({ level: 0.73 });
  assert.deepEqual(shown(el), AT(62, 73));
  el.report({ level: 0 });
  assert.deepEqual(shown(el), AT(-135, 0));
  el.report({ level: 1 });
  assert.deepEqual(shown(el), AT(135, 100));
  assert.deepEqual(services(el), [], "drawing the level asks nothing");
});

// ======================================================================
// 1. DRAG
// ======================================================================
test("drag: a 4 px dead zone, then 0.5% per pixel; right and up are louder", () => {
  const el = mount({ level: 0.5 });
  press(el, 100, 100);
  move(103, 100);
  assert.deepEqual(shown(el), AT(0, 50), "inside the dead zone nothing turns");
  assert.equal(el._knobTurning, null);
  // 5 px is past it, and the pixels spent inside the dead zone count
  move(105, 100);
  assert.deepEqual(shown(el), AT(7, 53));
  assert.equal(el._knobTurning, "left");
  move(110, 100);
  assert.deepEqual(shown(el), AT(14, 55));
  assert.ok(knob(el).classList.contains("is-dragging"));
  move(120, 90);                     // 10 right + 10 up = 20 px
  assert.deepEqual(shown(el), AT(41, 65));
  move(110, 110);                    // 10 left + 20 down = -30 px
  assert.deepEqual(shown(el), AT(0, 50));
  assert.deepEqual(asked(el), [], "nothing is written inside the throttle window");
  lift(110, 110);
});

test("drag: writes are throttled to one per 120 ms, carrying the latest level", () => {
  const el = mount({ level: 0.5 });
  press(el);
  move(110, 100);                    // 0.55
  move(120, 100);                    // 0.60
  advance(119);
  assert.deepEqual(asked(el), []);
  advance(1);
  assert.deepEqual(asked(el), [0.6]);
  move(130, 100);                    // 0.65
  advance(120);
  assert.deepEqual(asked(el), [0.6, 0.65]);
  lift(130, 100);
});

test("drag: while the pointer is held, a report from Home Assistant does not move the knob", () => {
  const el = mount({ level: 0.5 });
  press(el);
  move(110, 100);
  move(120, 90);                     // 0.65
  advance(120);
  el.report({ level: 0.6 });         // a stale or clamped report, mid-drag
  assert.deepEqual(shown(el), AT(41, 65), "renders wait for the release");
  lift(120, 90);
});

test("drag: release asks again for where it was let go, then shows the player's report", () => {
  const el = mount({ level: 0.5 });
  press(el);
  move(110, 100);
  move(120, 90);                     // 0.65
  advance(120);
  assert.deepEqual(asked(el), [0.65]);
  lift(120, 90);
  assert.deepEqual(asked(el), [0.65, 0.65], "the release writes once more");
  // The slider's documented rule ("the entity takes it back the moment it
  // lifts") applied to the knob: until the player reports, the last REPORT
  // is drawn, not the release point.
  assert.deepEqual(shown(el), AT(0, 50));
  el.report({ level: 0.65 });
  assert.deepEqual(shown(el), AT(41, 65));
});

test("drag: the level is clamped to 0..100%", () => {
  const el = mount({ level: 0.9 });
  press(el);
  move(160, 100);                    // +60 px = +30%
  assert.deepEqual(shown(el), AT(135, 100));
  advance(120);
  assert.deepEqual(asked(el), [1]);
  lift(160, 100);
  const low = mount({ level: 0.1 });
  press(low);
  move(40, 100);                     // -60 px
  assert.deepEqual(shown(low), AT(-135, 0));
  advance(120);
  assert.deepEqual(asked(low), [0]);
  lift(40, 100);
});

test("letting go of a drag lets go of the knob; later pointer moves turn nothing (was AS FOUND)", () => {
  // As found, the release KEPT turning mode, so any later mouse
  // movement anywhere on the page went on changing the volume at the sticky
  // gain: a gesture competing with the one that had just ended. The
  // redesign changes that on purpose: a drag is a turn, and the turn
  // ends when the pointer lets go. The single push's sticky mode is
  // untouched (section 3).
  const el = mount({ level: 0.5 });
  press(el);
  move(110, 100);
  move(120, 90);                     // 0.65
  lift(120, 90);
  el.report({ level: 0.65 });
  assert.equal(el._knobTurning, null, "the release let go of the knob");
  assert.ok(!knob(el).classList.contains("knob-turning"));
  const before = services(el).length;
  move(300, 300);
  move(310, 300);
  move(420, 120);
  assert.deepEqual(shown(el), AT(41, 65), "the knob stays where the drag left it");
  assert.equal(services(el).length, before, "and nothing more is asked of the player");
});

// ======================================================================
// 2. WHEEL
// ======================================================================
test("wheel: one notch is 2%; up is louder, down is quieter; it never engages turning", () => {
  const el = mount({ level: 0.5 });
  wheel(el, -100);
  assert.deepEqual(shown(el), AT(5, 52));
  assert.equal(el._knobTurning, null);
  advance(120);
  assert.deepEqual(asked(el), [0.52]);
  el.report({ level: 0.52 });
  wheel(el, 100);
  assert.deepEqual(shown(el), AT(0, 50));
  advance(120);
  assert.deepEqual(asked(el), [0.52, 0.5]);
});

test("wheel: the throttled write's render keeps the requested level on the knob", () => {
  const el = mount({ level: 0.5 });
  wheel(el, -100);
  assert.deepEqual(shown(el), AT(5, 52));
  advance(120);
  // _svc renders before it awaits; that render draws the held request
  assert.deepEqual(asked(el), [0.52]);
  assert.deepEqual(shown(el), AT(5, 52), "no snap back to the last report");
  el.report({ level: 0.52 });
  assert.deepEqual(shown(el), AT(5, 52));
});

test("wheel: notches between two reports add up (was a KNOWN DEFECT)", () => {
  /* Each notch steps from the level the knob last asked for, which is held
   * until Home Assistant's reports catch up. Three notches inside one
   * throttle window are one write, of all three. */
  const el = mount({ level: 0.5 });
  wheel(el, -100);
  wheel(el, -100);
  wheel(el, -100);
  assert.deepEqual(shown(el), AT(16, 56), "three notches show three");
  advance(120);
  assert.deepEqual(asked(el), [0.56], "and ask for all three, once");
  el.report({ level: 0.56 });
  wheel(el, -100);
  wheel(el, -100);
  advance(120);
  assert.deepEqual(asked(el), [0.56, 0.6]);
  assert.deepEqual(shown(el), AT(27, 60));
});

test("AS FOUND: with no volume support, the wheel turns the knob and asks nothing", () => {
  const el = mount({ level: 0.5, features: ALL_FEATURES & ~4 });
  assert.equal(slider(el), null, "the slider is replaced by its reason");
  assert.equal(shown(el).deg, 0);
  wheel(el, -100);
  assert.equal(shown(el).deg, 5, "the face still turns");
  advance(120);
  assert.deepEqual(asked(el), [], "nothing is sent to a player that cannot take it");
  assert.equal(shown(el).deg, 5, "and nothing turns it back");
});

// ======================================================================
// 3. STICKY TURN
// ======================================================================
test("sticky: one push engages turning and writes nothing; the first move only sets a baseline", () => {
  const el = mount({ level: 0.5 });
  push(el);
  assert.equal(el._knobTurning, "left");
  assert.ok(knob(el).classList.contains("knob-turning"), "the push re-rendered the knob as turning");
  assert.deepEqual(services(el), [], "a single push neither writes volume nor switches the DJ");
  move(300, 300);
  assert.deepEqual(shown(el), AT(0, 50));
  move(310, 300);                    // +10 px at 0.4% per pixel
  assert.deepEqual(shown(el), AT(11, 54));
  advance(120);
  assert.deepEqual(asked(el), [0.54]);
  el.report({ level: 0.54 });
  move(310, 290);                    // 10 px up is louder too (the move after a render counts)
  assert.deepEqual(shown(el), AT(22, 58));
});

test("sticky: turning accumulates from the level last asked for, and a write's render loses nothing (was a KNOWN DEFECT)", () => {
  /* Every move steps from the held request, not from the last report; the
   * throttled write's render draws that request; and the move baseline
   * survives the render, so the move after it still counts. */
  const el = mount({ level: 0.5 });
  push(el);
  move(300, 300);
  move(310, 300);
  assert.deepEqual(shown(el), AT(11, 54));
  move(320, 300);                    // another 10 px: 0.58
  assert.deepEqual(shown(el), AT(22, 58));
  move(330, 290);                    // 20 px in one event: 0.66
  assert.deepEqual(shown(el), AT(43, 66));
  advance(120);
  assert.deepEqual(asked(el), [0.66]);
  assert.deepEqual(shown(el), AT(43, 66), "the write's render keeps the requested level");
  move(340, 290);                    // the move after the render counts
  assert.deepEqual(shown(el), AT(54, 70));
  el.report({ level: 0.66 });        // the echo of the earlier write, mid-turn
  assert.deepEqual(shown(el), AT(54, 70), "an echo of an older write never draws the knob back");
  advance(120);
  assert.deepEqual(asked(el), [0.66, 0.7]);
  assert.equal(el._knobTurning, "left", "turning survives every render");
});

test("sticky: Escape lets go", () => {
  const el = mount({ level: 0.5 });
  push(el);
  escape();
  assert.equal(el._knobTurning, null);
  assert.ok(!knob(el).classList.contains("knob-turning"));
  move(300, 300);
  move(400, 300);
  advance(500);
  assert.deepEqual(shown(el), AT(0, 50));
  assert.deepEqual(asked(el), []);
});

test("sticky: a click anywhere else lets go", () => {
  const el = mount({ level: 0.5 });
  push(el);
  fire(win, "click", { clientX: 600, clientY: 400 });
  assert.equal(el._knobTurning, null);
  move(300, 300);
  move(400, 300);
  advance(500);
  assert.deepEqual(asked(el), []);
});

test("sticky: a later single push on the knob lets go", () => {
  const el = mount({ level: 0.5 });
  push(el);
  advance(400);                      // outside the 350 ms double-push window
  push(el);
  assert.equal(el._knobTurning, null);
  assert.deepEqual(services(el), [], "neither push wrote anything");
});

// ======================================================================
// 3b. THE HOLD: ECHOES, LETTING GO, AND CHANGES MADE ELSEWHERE
// ======================================================================
test("echoes: late and out-of-order reports of the knob's own writes never draw it backwards", () => {
  const el = mount({ level: 0.5 });
  wheel(el, -100); advance(120);     // asks 0.52
  wheel(el, -100); advance(120);     // asks 0.54
  wheel(el, -100); advance(120);     // asks 0.56
  assert.deepEqual(asked(el), [0.52, 0.54, 0.56]);
  assert.deepEqual(shown(el), AT(16, 56));
  el.report({ level: 0.54 });        // late
  assert.deepEqual(shown(el), AT(16, 56));
  el.report({ level: 0.52 });        // later still, and out of order
  assert.deepEqual(shown(el), AT(16, 56));
  advance(1500);                     // the turn is over; the report is still an older write of its own
  assert.deepEqual(shown(el), AT(16, 56), "an own echo is waited out");
  assert.ok(el._volHold, "still held");
  el.report({ level: 0.53 });        // 0.54 come back one point low (whole percents)
  assert.deepEqual(shown(el), AT(16, 56), "an echo within a point is still the knob's own");
  el.report({ level: 0.56 });        // the player agrees
  assert.equal(el._volHold, null, "agreement lets go");
  assert.deepEqual(shown(el), AT(16, 56));
  assert.deepEqual(asked(el), [0.52, 0.54, 0.56], "and nothing is written again");
});

test("echoes: a report that stays the knob's own is believed after VOLUME_HOLD_MAX_MS", () => {
  const el = mount({ level: 0.5 });
  wheel(el, -100);
  advance(120);                      // asks 0.52; the player never applies it
  advance(1500);
  assert.deepEqual(shown(el), AT(5, 52), "the report is still the starting level: waited out");
  advance(6000 - 1620 - 1);
  assert.deepEqual(shown(el), AT(5, 52));
  advance(1);
  assert.equal(el._volHold, null);
  assert.deepEqual(shown(el), AT(0, 50), "then the player is believed");
  assert.deepEqual(asked(el), [0.52]);
});

test("after the turn, a change made elsewhere shows as soon as it arrives, and the next notch starts there", () => {
  const el = mount({ level: 0.5 });
  wheel(el, -100);
  advance(120);
  el.report({ level: 0.52 });
  advance(1500);
  assert.equal(el._volHold, null, "the player agreed and the turn is over");
  el.report({ level: 0.3 });         // someone turned it down in Music Assistant
  assert.deepEqual(shown(el), AT(-54, 30));
  wheel(el, -100);
  assert.deepEqual(shown(el), AT(-49, 32));
  advance(120);
  assert.deepEqual(asked(el), [0.52, 0.32]);
});

test("a change made elsewhere during the turn waits for the turn to end, then is believed", () => {
  const el = mount({ level: 0.5 });
  wheel(el, -100);
  wheel(el, -100);                   // 0.54
  advance(120);
  el.report({ level: 0.3 });         // not one of the knob's own levels
  assert.deepEqual(shown(el), AT(11, 54), "while turning, the owner's request is what shows");
  advance(1500 - 120 - 1);
  assert.deepEqual(shown(el), AT(11, 54), "held for VOLUME_HOLD_MS after the last step");
  advance(1);
  assert.equal(el._volHold, null);
  assert.deepEqual(shown(el), AT(-54, 30), "then the player's own level");
});

test("sticky: after Escape the requested level stays until the player agrees, then the player wins", () => {
  const el = mount({ level: 0.5 });
  push(el);
  move(300, 300);
  move(310, 300);
  move(320, 300);                    // 0.58
  advance(120);
  assert.deepEqual(asked(el), [0.58]);
  escape();
  assert.equal(el._knobTurning, null);
  assert.deepEqual(shown(el), AT(22, 58), "letting go does not draw the knob back");
  el.report({ level: 0.57 });        // a whole-percent player, one point low
  assert.deepEqual(shown(el), AT(22, 58));
  advance(1500);
  assert.equal(el._volHold, null, "within a point is agreement");
  assert.deepEqual(shown(el), AT(19, 57), "and the player's own report is drawn");
  move(400, 400);
  move(500, 400);
  advance(500);
  assert.deepEqual(asked(el), [0.58], "moves after letting go turn nothing");
});

test("a refused write lets go of the held level at once", async () => {
  const el = mount({ level: 0.5, refuse: true });
  wheel(el, -100);
  advance(120);
  assert.deepEqual(asked(el), [0.52]);
  assert.deepEqual(shown(el), AT(5, 52), "while the write is out");
  await settle();
  assert.equal(el._volHold, null);
  assert.equal(el._notice && el._notice.ok, false, "the refusal is shown");
  assert.deepEqual(shown(el), AT(0, 50), "and the player's level is drawn, not the refused one");
});

test("no volume support, or an unavailable player: nothing is held and nothing is written", () => {
  const off = mount({ level: 0.5, features: ALL_FEATURES & ~4 });
  wheel(off, -100);
  assert.equal(off._volHold, null, "nothing can be asked, so nothing is held");
  push(off);
  move(300, 300);
  move(320, 300);
  advance(2000);
  assert.equal(off._volHold, null);
  assert.deepEqual(asked(off), []);
  const gone = mount({ level: 0.5, player: "unavailable" });
  wheel(gone, -100);
  assert.equal(gone._volHold, null);
  advance(2000);
  assert.equal(gone._volHold, null);
  assert.deepEqual(asked(gone), []);
  // a player that goes away mid-turn takes the hold with it
  const mid = mount({ level: 0.5 });
  wheel(mid, -100);
  mid.report({ player: "unavailable" });
  assert.equal(mid._volHold, null);
  advance(120);
  assert.deepEqual(asked(mid), [], "the pending write is not sent to an unavailable player");
});

test("a drag straight after wheel notches starts from the level shown; its release keeps the drag's rule", () => {
  const el = mount({ level: 0.5 });
  wheel(el, -100);
  wheel(el, -100);                   // shows 0.54, held
  press(el, 100, 100);
  move(110, 100);                    // +10 px from 0.54
  assert.deepEqual(shown(el), AT(24, 59));
  assert.equal(el._volHold, null, "the drag owns the level now");
  advance(120);
  assert.deepEqual(asked(el), [0.59], "the notches' level, superseded inside the window, is never sent");
  lift(110, 100);
  assert.deepEqual(asked(el), [0.59, 0.59]);
  assert.deepEqual(shown(el), AT(0, 50), "as before: on release the last report is drawn");
});

test("the slider takes over from a held knob level", () => {
  const el = mount({ level: 0.5 });
  wheel(el, -100);
  advance(120);                      // asks 0.52, held
  const s = slider(el);
  s.value = "70";
  fire(s, "input");
  assert.equal(el._volHold, null, "the slider owns the level now");
  assert.deepEqual(shown(el), AT(54, 70));
  fire(s, "change");
  assert.deepEqual(asked(el), [0.52, 0.7]);
  assert.deepEqual(shown(el), AT(0, 50), "as before: on release the last report is drawn");
});

test("disconnecting lets go of a held level and its timer", () => {
  const el = mount({ level: 0.5 });
  wheel(el, -100);
  assert.ok(el._volHold);
  el.disconnectedCallback();
  assert.equal(el._volHold, null);
  assert.equal(el._volHoldTimer, null);
});

// ======================================================================
// 4. DOUBLE PUSH AND KEYBOARD
// ======================================================================
test("AS FOUND: a double push switches the DJ once and leaves turning engaged by its first half", () => {
  const el = mount({ level: 0.5, dj: "on" });
  push(el);
  advance(200);                      // inside 350 ms, outside the 30 ms bounce
  push(el);
  assert.deepEqual(el.calls.filter((c) => c.svc).map((c) => [c.svc, c.data.entity_id]),
                   [["switch.turn_off", "switch.dj"]]);
  assert.equal(el._knobTurning, "left", "the second push does not take back what the first engaged");
});

test("double push: two pushes inside the bounce floor are one push", () => {
  const el = mount({ level: 0.5, dj: "on" });
  push(el);
  advance(20);
  push(el);
  assert.deepEqual(services(el), []);
  assert.equal(el._knobTurning, null, "the second push, counted as single, let go again");
});

test("AS FOUND: the keyboard switches the DJ in one press; a pointer click on the knob never does", () => {
  const el = mount({ level: 0.5, dj: "on" });
  // Enter or Space on a button is a click with no pointer: detail 0, at 0,0
  fire(knob(el), "click", { detail: 0, clientX: 0, clientY: 0 });
  assert.deepEqual(services(el), ["switch.turn_off"]);
  assert.equal(el._knobTurning, null, "the keyboard never engages turning");
  const ptr = mount({ level: 0.5, dj: "on" });
  fire(knob(ptr), "click", { detail: 1, clientX: 100, clientY: 100 });
  assert.deepEqual(services(ptr), [], "the capture guard swallows a pointer click");
});

// ======================================================================
// 5. THE VOLUME SLIDER
// ======================================================================
test("slider: moving it shows the finger's value on the knob and the percentage, and asks nothing", () => {
  const el = mount({ level: 0.5 });
  const s = slider(el);
  s.value = "70";
  fire(s, "input");
  assert.equal(shown(el).deg, 54);
  assert.equal(shown(el).pct, "70%");
  assert.deepEqual(asked(el), []);
});

test("slider: a report while it is held does not take the value back", () => {
  const el = mount({ level: 0.5 });
  const s = slider(el);
  s.value = "70";
  fire(s, "input");
  el.report({ level: 0.5 });         // a routine update, no pointer held
  assert.deepEqual(shown(el), AT(54, 70));
});

test("slider: letting go asks once, at once, then shows the player's report until the next one", () => {
  const el = mount({ level: 0.5 });
  const s = slider(el);
  s.value = "70";
  fire(s, "input");
  fire(s, "change");
  assert.deepEqual(asked(el), [0.7], "no throttle on the slider");
  // THE SLIDER SHOWS THE PLAYER, NOT OUR WISH (the panel's own rule)
  assert.deepEqual(shown(el), AT(0, 50));
  el.report({ level: 0.7 });
  assert.deepEqual(shown(el), AT(54, 70));
  advance(1000);
  assert.deepEqual(asked(el), [0.7], "and nothing is sent again later");
});

// ======================================================================
// 6. THE REBINDING ITSELF
// ======================================================================
test("every render rebinds the knob's window listeners without piling them up", () => {
  const el = mount({ level: 0.5 });
  const counts = () => [win._ls.count("pointermove"), win._ls.count("click"), win._ls.count("keydown")];
  const first = counts();
  for (let i = 0; i < 5; i++) el.report({ level: 0.5 });
  assert.deepEqual(counts(), first);
  el.disconnectedCallback();
  assert.equal(win._ls.count("pointermove"), 0);
  assert.equal(win._ls.count("click"), 0);
});

// ----------------------------------------------------------------------
for (const [name, fn] of tests) {
  try {
    await fn();
    await settle();
    passed++;
  } catch (e) {
    console.error(`FAIL: ${name}\n${e.stack || e}`);
    process.exitCode = 1;
  }
}
console.log(`${passed}/${tests.length} left knob / volume tests passed`);
