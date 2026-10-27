/* The On Air interaction redesign, EXECUTED.
 *
 * The design: halo knobs and an LCD header, with a compact speaker list
 * inside the LCD. What is pinned here:
 *
 *   - the knobs: a push is a push and a turn is a turn (dead zone, drag,
 *     circular drag, touch, a cancelled touch, a second finger), wheel and
 *     keyboard, the volume hold under bursts, the volume readout and
 *     the once-a-session hint;
 *   - the speaker list: opened by turning (no Dial stations) or the double
 *     push, ONE push confirms inside it, a quick pair never switches twice,
 *     5 s of idling closes it WITHOUT a change and every deliberate step
 *     restarts that time, Escape cancels, Enter confirms, a refusal and an
 *     unavailable select are told truthfully, long names stay whole;
 *   - the LCD header: the DJ and the speaker from the entities' own states;
 *   - cleanup: timers, intervals and window listeners.
 *
 * The harness is test_panel_volume_knob.mjs's fake page (the real panel,
 * the real render and the real knob binding), extended with knob geometry,
 * a speaker select the test controls, a session store and tracked
 * intervals. Pixel geometry -- the halos' real sizes, that they never meet
 * or cover the badge -- needs a real browser to check, not this file: it
 * has no layout engine.
 *
 *   node ha/tests/test_panel_onair_interaction.mjs   (or scripts/test_panel.sh)
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

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
    btn.getBoundingClientRect = () => RECTS.left;
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
    byId["right-knob"].getBoundingClientRect = () => RECTS.right;
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

  // the LCD's transient line, so an in-place update can be seen
  const wm = /<div class="lcd-whisper([^"]*)"[^>]*><span class="lcd-whisper-text">([^<]*)<\/span>/.exec(html);
  if (wm) {
    const text = new El("span", { cls: "lcd-whisper-text", gen });
    text.textContent = wm[2];
    q[".lcd-whisper"] = new El("div", { cls: "lcd-whisper" + wm[1], sel: { ".lcd-whisper-text": text }, gen });
  }
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
// Intervals never fire by themselves here (the countdown digits are read from
// the clock); they are TRACKED, so a test can prove every one is cleared.
const intervals = new Set();
let intervalSeq = 0;
globalThis.setInterval = () => { intervalSeq += 1; const id = 900000 + intervalSeq; intervals.add(id); return id; };
globalThis.clearInterval = (id) => { intervals.delete(id); };
// sessionStorage: a fake that can also be made to throw
let STORE = new Map();
let STORE_THROWS = false;
globalThis.sessionStorage = {
  getItem(k) { if (STORE_THROWS) throw new Error("denied"); return STORE.has(k) ? STORE.get(k) : null; },
  setItem(k, v) { if (STORE_THROWS) throw new Error("denied"); STORE.set(k, String(v)); },
};
// where the knobs are on the page (the real buttons are 104 px)
let RECTS = { left: { left: 50, top: 50, width: 104, height: 104 },
              right: { left: 650, top: 50, width: 104, height: 104 } };
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
const SRC_CSS = readFileSync(PANEL, "utf8");
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
      "sensor.dj": { entity_id: "sensor.dj", state: ha.status,
                     attributes: { enabled: ha.dj === "on", outputs_enabled: ["media_player.den"] } },
      "select.out": { entity_id: "select.out", state: ha.output,
                      attributes: { options: ha.options, output_entity_id: "media_player.den" } },
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
      if (service === "select_option" && ha.refuseSelect) {
        return Promise.reject(new Error("That speaker is not available."));
      }
      return ha.refuse && service === "volume_set"
        ? Promise.reject(new Error("The player refused the volume."))
        : Promise.resolve();
    },
    callWS: (msg) => {
      calls.push({ ws: msg.type, data: { ...msg } });
      if (ha.ws && ha.ws[msg.type]) return Promise.resolve(JSON.parse(JSON.stringify(ha.ws[msg.type])));
      return Promise.resolve({ ok: true });
    },
  };
}

/* A connected panel on On Air, rendered once with the player at `level`.
 * Home Assistant does NOT echo a write back by itself: `el.report(...)` is
 * the player's new state arriving, whenever the test decides it arrives. */
function mount({ level = 0.5, features = ALL_FEATURES, player = "playing", dj = "on", refuse = false,
                 output = "Den", options = ["Den", "Kitchen", "Patio"], status = "waiting",
                 refuseSelect = false, presets = [], ws = null } = {}) {
  timers = [];
  intervals.clear();
  STORE = new Map();
  STORE_THROWS = false;
  win._ls = new Listeners();
  const el = new PanelClass();
  ROOT = el.shadowRoot;
  el.calls = [];
  el._entityMap = { dj_enabled: "switch.dj", dj_status: "sensor.dj", output: "select.out" };
  el._ready = { at: NOW, data: { readiness: READY } };
  el._voiceLib = {};
  el._dial = { at: NOW, data: { presets, builder_revision: 2 } };
  if (ws && ws["parlorwave_radio/station_live"]) el._live = { at: NOW, data: JSON.parse(JSON.stringify(ws["parlorwave_radio/station_live"])) };
  el._live = { at: NOW, data: { ok: true, active: false, state: "off" } };
  el.connectedCallback();
  const ha = { level, features, player, dj, refuse, output, options, status, refuseSelect, ws };
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


// --- the right knob, the speaker list and the LCD ----------------------------
const rknob = (el) => el.shadowRoot.getElementById("right-knob");
const html = (el) => el.shadowRoot.innerHTML;
const selects = (el) => el.calls.filter((c) => c.svc === "select.select_option").map((c) => c.data.option);
const toggles = (el) => el.calls.filter((c) => c.svc === "switch.turn_on" || c.svc === "switch.turn_off");
const pressR = (el, x = 702, y = 102, init = {}) => { const b = rknob(el); fire(b, "pointerdown", { clientX: x, clientY: y, ...init }); return b; };
function pushR(el) { const b = pressR(el); lift(702, 102); fire(b, "click", { clientX: 702, clientY: 102 }); return b; }
const wheelR = (el, deltaY) => fire(rknob(el), "wheel", { deltaY });
const key = (k, target = win) => fire(target, "keydown", { key: k });
/* A name element's text, as its DOM text would read: a long name is drawn as
 * a head and a tail span (_nameParts), whose texts join back into the name. */
const textOf = (inner) => inner.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">").replace(/&quot;/g, '"');
const header = (el) => {
  const m = /<div class="lcd-status"[\s\S]*?<span class="lcd-status-dj ([^"]*)">[\s\S]*?<span class="lcd-status-text">([^<]*)<\/span>[\s\S]*?<span class="lcd-status-out ([^"]*)"><span class="lcd-status-text[^"]*" title="([^"]*)">((?:(?!<span class="lcd-lamp)[\s\S])*?)<\/span><span class="lcd-lamp/.exec(html(el));
  return m ? { dj: m[2], djCls: m[1], out: textOf(m[5]), outTitle: m[4], outCls: m[3] } : null;
};
const rows = (el) => [...html(el).matchAll(/<div class="lcd-row((?: [^"]*)?)">[\s\S]*?<span class="lcd-row-name[^"]*" title="([^"]*)">([\s\S]*?)<\/span>\s*<span class="lcd-row-tag">([^<]*)<\/span>/g)]
  .map((m) => ({ name: textOf(m[3]), title: m[2], split: m[3].includes("pw-name-tail"),
                 cand: m[1].includes("lcd-row-cand"), now: m[4] === "NOW", extra: m[1].includes("lcd-row-extra") }));
/* Open the speaker list the one way a pointer can: the right knob's double
 * push. Then pause past the opening run (OUTPUT_OPEN_RUN_MS, 350 ms), so the
 * next push is a separate gesture. Wheel up (a negative delta) is forward,
 * as it is louder on the left knob. */
const NEXT = -100;
const RUN_MS = 350;
const KNOB_DBL = 350;   // KNOB_DOUBLE_CLICK_MS
function dblR(el) { pushR(el); advance(150); pushR(el); }
function openList(el) { dblR(el); assert.equal(el._outputMode, true, "the list opened"); advance(RUN_MS + 50); }
const STATIONS = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, label: `Station ${i + 1}`,
  kind: "music", enabled: true }));

// ======================================================================
// 1. A PUSH IS A PUSH, A TURN IS A TURN
// ======================================================================
test("left: travel inside the 4 px dead zone is a push, beyond it a turn that never also pushes", () => {
  const el = mount({ level: 0.5 });
  press(el, 100, 100); move(103, 100); lift(103, 100);
  assert.equal(el._knobTurning, "left", "a 3 px wobble is still a push (it engages sticky turning)");
  escape();
  const before = el._lastKnobClick.left;
  advance(1000);
  press(el, 100, 100); move(110, 100); move(130, 100); lift(130, 100);
  assert.equal(el._lastKnobClick.left, before, "the drag was never handed to the click path");
  assert.equal(el._knobTurning, null, "and letting go of it let go of the knob");
  assert.deepEqual(toggles(el), [], "no push of any kind switched the DJ");
});

test("right: a drag is a turn (the Dial), its release is never a push, and inside the list it only browses", async () => {
  const el = mount();
  pressR(el, 702, 102); move(712, 102); move(722, 102); move(742, 102); lift(742, 102);
  assert.equal(el._stationMode, true, "turning opened the Dial (empty here)");
  assert.equal(el._outputMode, false);
  assert.equal(el._knobTurning, null, "letting go of the turn let go of the knob");
  assert.deepEqual(selects(el), [], "turning switched nothing");
  el._cancelStationMode();
  openList(el);
  pressR(el, 702, 102); move(712, 102); move(722, 102); move(742, 102); lift(742, 102);
  assert.equal(el._outputMode, true);
  assert.deepEqual(selects(el), [], "a drag inside the list browses; its release confirms nothing");
  advance(600);
  pushR(el);
  await settle();
  assert.equal(selects(el).length, 1, "one separate push, one switch");
});

test("touch: a second finger on the other knob never moves this one", () => {
  const el = mount({ level: 0.5 });
  fire(knob(el), "pointerdown", { clientX: 100, clientY: 100, pointerId: 1 });
  fire(win, "pointermove", { clientX: 120, clientY: 100, pointerId: 1 });        // left: +10%
  fire(win, "pointermove", { clientX: 300, clientY: 100, pointerId: 2 });        // someone else's finger
  fire(win, "pointerup", { clientX: 300, clientY: 100, pointerId: 2 });          // ...lifted: not ours
  assert.equal(el._isDragging, true, "the first finger still holds the knob");
  fire(win, "pointerup", { clientX: 120, clientY: 100, pointerId: 1 });
  assert.deepEqual(asked(el).slice(-1), [0.6], "the level the first finger turned to, and only that");
});

test("touch: a cancelled gesture (the browser took it to scroll) ends with no push and no stuck listeners", () => {
  const el = mount({ level: 0.5 });
  const base = [win._ls.count("pointermove"), win._ls.count("pointerup"), win._ls.count("pointercancel")];
  fire(knob(el), "pointerdown", { clientX: 100, clientY: 100, pointerId: 7, pointerType: "touch" });
  fire(win, "pointercancel", { pointerId: 7 });
  assert.equal(el._knobTurning, null, "a cancel is never a push");
  assert.deepEqual([win._ls.count("pointermove"), win._ls.count("pointerup"), win._ls.count("pointercancel")], base);
  // and one cancelled mid-turn keeps the level the finger had reached
  fire(knob(el), "pointerdown", { clientX: 100, clientY: 100, pointerId: 8, pointerType: "touch" });
  fire(win, "pointermove", { clientX: 140, clientY: 100, pointerId: 8 });
  fire(win, "pointercancel", { pointerId: 8 });
  assert.equal(el._isDragging, false);
  assert.equal(el._knobTurning, null);
  assert.deepEqual(asked(el).slice(-1), [0.7], "the release write still goes out");
});

test("circular: a press out at the rim turning round the knob follows it; clockwise is louder", () => {
  const el = mount({ level: 0.5 });
  // centre (102, 102), radius 52: press at the 9 o'clock rim, go round to 12
  const cx = 102, cy = 102, r = 48;
  fire(knob(el), "pointerdown", { clientX: cx - r, clientY: cy });
  for (let a = 180; a <= 270; a += 15) {
    const t = a * Math.PI / 180;
    move(cx + r * Math.cos(t), cy + r * Math.sin(t));
  }
  lift(cx, cy - r);
  // 90 degrees of a 270-degree sweep: one third of the range
  assert.equal(asked(el).slice(-1)[0], 0.8333, "a quarter turn clockwise is +1/3");
});

test("circular: a press at the centre, or a drag straight out from the rim, stays linear", () => {
  const el = mount({ level: 0.5 });
  fire(knob(el), "pointerdown", { clientX: 102, clientY: 102 });      // the centre
  move(112, 102); move(122, 102);                                      // +20 px right = +10%
  lift(122, 102);
  assert.deepEqual(asked(el).slice(-1), [0.6]);
  advance(2000);
  el.report({ level: 0.6 });
  fire(knob(el), "pointerdown", { clientX: 150, clientY: 102 });      // the 3 o'clock rim
  move(160, 102); move(170, 102);                                      // straight out: radial
  lift(170, 102);
  assert.deepEqual(asked(el).slice(-1), [0.7], "radial movement is the linear rule, not a turn");
});

test("no geometry (a layout-less host): every drag is the linear one, as before", () => {
  const el = mount({ level: 0.5 });
  const saved = RECTS.left;
  RECTS.left = { left: 0, top: 0, width: 0, height: 0 };
  try {
    press(el, 100, 100); move(110, 90); lift(110, 90);
    assert.deepEqual(asked(el).slice(-1), [0.6]);
  } finally { RECTS.left = saved; }
});

// ======================================================================
// 2. WHEEL, KEYBOARD AND THE VOLUME HOLD
// ======================================================================
test("a rapid wheel burst adds up from the level asked for, late echoes never draw it back", () => {
  const el = mount({ level: 0.5 });
  for (let i = 0; i < 10; i++) wheel(el, -100);                 // +20%
  assert.deepEqual(shown(el), AT(54, 70));
  el.report({ level: 0.52 }); el.report({ level: 0.58 });       // the player catching up
  assert.deepEqual(shown(el), AT(54, 70), "late reports of its own writes do not draw it back");
  advance(200);
  assert.equal(asked(el).slice(-1)[0], 0.7);
});

test("keyboard on the focused left knob: arrows are notches, Page keys ten, from the level asked for", () => {
  const el = mount({ level: 0.5 });
  for (let i = 0; i < 5; i++) key("ArrowUp", knob(el));
  assert.deepEqual(shown(el), AT(27, 60), "five arrows, no report in between: 60%");
  key("PageDown", knob(el));
  assert.deepEqual(shown(el), AT(0, 50));
  key("ArrowLeft", knob(el));
  assert.deepEqual(shown(el), AT(-5, 48));
  advance(200);
  assert.equal(asked(el).slice(-1)[0], 0.48);
  assert.deepEqual(toggles(el), [], "arrows never switch the DJ");
});

test("the volume readout says the level on the LCD and goes after 1.2 s", () => {
  const el = mount({ level: 0.5 });
  wheel(el, -100);
  assert.equal(el._whisper.text, "VOLUME 52%");
  assert.ok(el.shadowRoot.querySelector(".lcd-whisper").classList.contains("visible"));
  advance(1199);
  assert.ok(el._whisper, "still there just before 1.2 s");
  advance(2);
  assert.equal(el._whisper, null);
  assert.ok(!el.shadowRoot.querySelector(".lcd-whisper").classList.contains("visible"), "taken down in place");
  el._render();
  assert.ok(!html(el).includes('class="lcd-whisper visible'), "and not drawn by the next render");
});

test("the first press of each knob explains it once a session; storage refused still means once", () => {
  const el = mount({ level: 0.5 });
  press(el); lift();
  assert.equal(el._whisper.text, "TURN FOR VOLUME · PUSH TWICE FOR DJ");
  assert.equal(STORE.get("parlorwave_knob_hint_left"), undefined, "not counted before it has been read");
  advance(3000);   // KNOB_HINT_MS
  assert.equal(STORE.get("parlorwave_knob_hint_left"), "1", "counted once it stayed up for its whole time");
  escape(); advance(5000);
  press(el); lift();
  assert.equal(el._whisper, null, "the second press says nothing");
  pressR(el); lift(702, 102);
  assert.equal(el._whisper.text, "TURN FOR STATIONS \u00b7 PUSH TWICE FOR SPEAKERS", "the right knob has its own, once");
  // a new panel in the same session: nothing
  const again = mount({ level: 0.5 });
  STORE.set("parlorwave_knob_hint_left", "1");
  press(again); lift();
  assert.equal(again._whisper, null);
  // storage that throws: once per panel instead of once per session
  const locked = mount({ level: 0.5 });
  STORE_THROWS = true;
  press(locked); lift(); escape(); advance(5000);
  press(locked); lift();
  assert.equal(locked._whisper, null, "shown at most once");
});

// ======================================================================
// 3. THE SPEAKER LIST
// ======================================================================
test("turning is ALWAYS the Dial: with zero, one and several stations; it never touches the speaker", () => {
  for (const n of [0, 1, 3]) {
    const el = mount({ presets: STATIONS(n) });
    wheelR(el, NEXT);
    assert.equal(el._stationMode, true, `${n} stations: the Dial opened`);
    assert.equal(el._outputMode, false, `${n} stations: not the speaker list`);
    wheelR(el, NEXT); wheelR(el, NEXT);
    assert.equal(el._stationIndex, n === 3 ? 2 : 0, `${n} stations: the turns move the Dial`);
    const lcd = html(el);
    if (n === 0) {
      assert.match(lcd, /No stations saved/);
      assert.match(lcd, /Push twice for speakers/);
    } else {
      assert.match(lcd, new RegExp(`STATION ${n === 3 ? 3 : 1}/${n}`));
    }
    assert.deepEqual(selects(el), [], "no speaker change from turning");
  }
});

test("the saved stations changing while the Dial is open: it follows the list, still never the speaker", () => {
  const el = mount({ presets: [] });
  wheelR(el, NEXT);
  assert.match(html(el), /No stations saved/);
  el._dial.data.presets = STATIONS(2);                          // the fetch came back with two
  el._render();
  assert.match(html(el), /Station 1/);
  wheelR(el, NEXT);
  assert.match(html(el), /Station 2/);
  el._dial.data.presets = STATIONS(1);                          // one deleted elsewhere
  el._render();
  assert.match(html(el), /Station 1/, "the pointer falls back onto what is left");
  el._dial.data.presets = [];
  el._render();
  assert.match(html(el), /No stations saved/);
  assert.equal(el._outputMode, false);
  assert.deepEqual(selects(el), []);
});

test("the double push opens the speaker list ON the current speaker, from every state", () => {
  for (const [label, prep] of [["normal", () => {}],
                               ["the Dial", (el) => { wheelR(el, NEXT); wheelR(el, NEXT); }],
                               ["an empty Dial", (el) => { wheelR(el, NEXT); }]]) {
    const el = mount({ presets: label === "the Dial" ? STATIONS(3) : [] });
    prep(el);
    advance(1000);
    dblR(el);
    assert.equal(el._outputMode, true, `from ${label}`);
    assert.equal(el._stationMode, false, `from ${label}: the list supersedes the Dial`);
    const r = rows(el);
    assert.deepEqual(r.map((x) => [x.name, x.cand, x.now]), [["Den", true, true], ["Kitchen", false, false], ["Patio", false, false]]);
    assert.deepEqual(selects(el), [], `from ${label}: opening changes nothing`);
  }
});

test("browsing the list: CURRENT stays on top marked NOW, the candidate is boxed", () => {
  const el = mount();
  openList(el);
  wheelR(el, NEXT);
  const r = rows(el);
  assert.deepEqual(r.map((x) => [x.name, x.cand, x.now]), [["Den", false, true], ["Kitchen", true, false], ["Patio", false, false]]);
  assert.ok(r[2].extra, "the third row is the one a phone leaves out");
  assert.deepEqual(selects(el), []);
  assert.match(html(el), /class="mouth-lcd-overlay lcd-output"/, "while choosing, the list covers the whole LCD");
});

test("the opening run never confirms, however long the clicking goes on; a separate push after a pause does", async () => {
  const el = mount();
  dblR(el);
  for (let i = 0; i < 10; i++) { advance(200); pushR(el); }      // 2 s of clicking at 5 per second
  await settle();
  assert.deepEqual(selects(el), [], "a continuous run of clicks is one gesture");
  wheelR(el, NEXT);
  advance(RUN_MS);                                               // a pause of 350 ms: separate
  pushR(el);
  await settle();
  assert.deepEqual(selects(el), ["Kitchen"]);
});

test("a genuinely separate push soon after opening is not swallowed", async () => {
  const el = mount();
  dblR(el);
  advance(RUN_MS);                                               // 350 ms after the opening push
  pushR(el);
  await settle();
  assert.equal(el._outputResult && el._outputResult.text, "NO CHANGE", "it confirmed (the current speaker)");
});

test("repeated pushes while a switch is with Home Assistant send it once", async () => {
  const el = mount();
  let release;
  el._hass.callService = (domain, service, data) => {
    el.calls.push({ svc: `${domain}.${service}`, data: { ...data } });
    return new Promise((r) => { release = r; });
  };
  openList(el); wheelR(el, NEXT); advance(600);
  pushR(el);
  for (let i = 0; i < 4; i++) { advance(500); pushR(el); key("Enter"); }
  release(); await settle(); await settle();
  assert.deepEqual(selects(el), ["Kitchen"]);
});

test("the Dial and the speaker list are independent: neither ever acts for the other", async () => {
  const el = mount({ presets: STATIONS(3) });
  wheelR(el, NEXT); wheelR(el, NEXT);                            // Dial on Station 2
  dblR(el);                                                      // the list replaces it
  assert.equal(el._stationMode, false);
  advance(400); wheelR(el, NEXT); advance(400); pushR(el);       // switch to Kitchen
  await settle();
  assert.deepEqual(selects(el), ["Kitchen"]);
  assert.equal(el.calls.filter((c) => c.ws === "parlorwave_radio/station_live_start").length, 0,
               "no station was started");
  advance(2000);
  wheelR(el, NEXT);                                              // turning again: the Dial, fresh
  assert.equal(el._stationMode, true);
  assert.equal(el._outputMode, false);
  assert.deepEqual(selects(el), ["Kitchen"], "and the Dial changed no speaker");
});

test("touch: a double tap opens the list and one later tap confirms, like the mouse", async () => {
  const el = mount();
  const tap = (id) => { const b = rknob(el);
    fire(b, "pointerdown", { clientX: 702, clientY: 102, pointerId: id, pointerType: "touch" });
    fire(win, "pointerup", { clientX: 702, clientY: 102, pointerId: id, pointerType: "touch" }); };
  tap(1); advance(150); tap(2);
  assert.equal(el._outputMode, true);
  advance(400);
  fire(rknob(el), "wheel", { deltaY: NEXT });
  advance(400); tap(3);
  await settle();
  assert.deepEqual(selects(el), ["Kitchen"]);
});

test("keyboard: arrows on the focused right knob browse the Dial; Enter opens the list; a held Enter is one press", async () => {
  const el = mount({ presets: STATIONS(2) });
  key("ArrowRight", rknob(el));
  assert.equal(el._stationMode, true, "arrows are the Dial's, as turning is");
  assert.equal(el._outputMode, false);
  key("Escape");
  assert.equal(el._stationMode, false);
  fire(rknob(el), "click", { detail: 0, clientX: 0, clientY: 0 });   // Enter's own click
  assert.equal(el._outputMode, true, "Enter/Space opens the speaker list");
  fire(win, "keydown", { key: "Enter", repeat: true });            // the key is still held
  await settle();
  assert.deepEqual(selects(el), [], "auto-repeat is not a confirmation");
  key("ArrowRight");
  key("Enter");
  await settle();
  assert.deepEqual(selects(el), ["Kitchen"]);
});

test("ONE push inside the list confirms; SWITCHED, then the display returns", async () => {
  const el = mount();
  openList(el); wheelR(el, NEXT);                                  // candidate: Kitchen
  advance(600);
  pushR(el);
  assert.equal(el._outputPending, "Kitchen");
  assert.match(html(el), /SWITCHING/);
  await settle();
  assert.deepEqual(selects(el), ["Kitchen"]);
  assert.match(html(el), /SWITCHED ✓/);
  assert.match(html(el), /mouth-lcd-overlay/, "the list still has the LCD");
  advance(1499);
  assert.equal(el._outputMode, true, "SWITCHED stays 1.5 s");
  advance(2);
  assert.equal(el._outputMode, false);
  assert.equal(header(el).out, "Den", "the header shows what HA says, not what was asked");
  el.report({ output: "Kitchen" });
  assert.equal(header(el).out, "Kitchen");
});

test("the click after the opening double push never confirms, and a quick pair never switches twice", async () => {
  const el = mount();
  pushR(el); advance(150); pushR(el);                             // double push: the list opens
  assert.equal(el._outputMode, true);
  advance(150); pushR(el);                                        // a third click, 150 ms later
  await settle();
  assert.deepEqual(selects(el), [], "part of the opening run");
  wheelR(el, NEXT); advance(600);                                  // Kitchen, a deliberate pause
  pushR(el); advance(120); pushR(el);                             // a quick pair
  assert.equal(el._knobTurning, null, "its second half engaged no sticky turn while the list was open");
  await settle();
  assert.deepEqual(selects(el), ["Kitchen"], "exactly one switch");
  advance(2000);
  assert.equal(el._outputMode, false);
  assert.equal(el._knobTurning, null, "nothing engaged the Dial or a sticky turn on the way out");
});

test("outside the list the double pushes are as before: right opens the list, left switches the DJ once", () => {
  const el = mount();
  pushR(el); advance(150); pushR(el);
  assert.equal(el._outputMode, true);
  el._cancelOutputMode();
  push(el); advance(150); push(el);
  assert.equal(toggles(el).length, 1);
  assert.equal(toggles(el)[0].svc, "switch.turn_off");
});

test("5 s of idling closes the list with NO change; every deliberate step restarts the 5 s", () => {
  const el = mount();
  openList(el);
  advance(4000); wheelR(el, NEXT);                                 // Kitchen at 4 s: restart
  advance(4900);
  assert.equal(el._outputMode, true, "8.9 s after opening, 4.9 s after the last step");
  assert.match(html(el), /lcd-countdown-num">5s/);              // the render after the step
  advance(101);
  assert.equal(el._outputMode, false, "closed at 5 s idle");
  assert.deepEqual(selects(el), [], "a timeout never switches");
  assert.equal(header(el).out, "Den");
  assert.equal(el._knobTurning, null);
});

test("Escape cancels; Enter confirms; the button's own click never acts a second time", async () => {
  const el = mount();
  openList(el); wheelR(el, NEXT);
  key("Escape");
  assert.equal(el._outputMode, false);
  assert.deepEqual(selects(el), []);
  // keyboard: Enter on the focused right knob opens the list (no blind switch)
  fire(rknob(el), "click", { detail: 0, clientX: 0, clientY: 0 });
  assert.equal(el._outputMode, true);
  assert.deepEqual(selects(el), [], "it opens the list; it does not switch");
  key("ArrowRight");
  advance(600);
  key("Enter");
  fire(rknob(el), "click", { detail: 0, clientX: 0, clientY: 0 });   // the button's own default action
  await settle();
  assert.deepEqual(selects(el), ["Kitchen"], "one switch for one Enter");
});

test("assistive technology hears the list: the focused right knob's name is the list's sentence", () => {
  const el = mount();
  assert.match(html(el), /id="right-knob"\s+type="button" aria-label="Active DJ speaker: Den\. Enter opens the speaker list; arrow keys browse the saved stations\."/);
  openList(el); wheelR(el, NEXT);
  assert.match(html(el), /aria-label="Speaker list: Kitchen, 2 of 3\. Now on Den\. Push or Enter to switch, Escape to cancel\."/);
});

test("a refusal is told truthfully and the actual speaker stays", async () => {
  const el = mount({ refuseSelect: true });
  openList(el); wheelR(el, NEXT); advance(600);
  pushR(el);
  await settle(); await settle();
  assert.deepEqual(selects(el), ["Kitchen"]);
  assert.match(html(el), /NOT SWITCHED/);
  assert.match(html(el), /That speaker is not available\. · still Den/);
  advance(2999);
  assert.equal(el._outputMode, true, "a refusal stays long enough to read");
  advance(2);
  assert.equal(el._outputMode, false);
  assert.equal(header(el).out, "Den");
  assert.deepEqual(selects(el), ["Kitchen"], "and is never retried");
});

test("an unavailable speaker select: the list says so and a push changes nothing", async () => {
  const el = mount({ output: "unavailable" });
  openList(el);
  assert.match(html(el), /SPEAKER CHOICE UNAVAILABLE/);
  advance(600); pushR(el); await settle();
  assert.deepEqual(selects(el), [], "nothing is asked of Home Assistant");
  assert.match(html(el), /NOT SWITCHED/);
  advance(3100);
  assert.equal(header(el).out, "SPEAKER UNAVAILABLE");
});

test("a long speaker name is shown whole to assistive technology and clipped, never cut, on screen", () => {
  const long = "The Upstairs Hallway And Landing Speaker Group";
  const el = mount({ options: ["Den", long], output: long });
  assert.equal(header(el).out, long, "the header carries the whole name (CSS ellipsis clips it)");
  openList(el);
  const r = rows(el);
  assert.equal(r[0].name, long);
  assert.equal(r[0].title, long, "and its title is the whole name");
  assert.match(html(el), new RegExp(`aria-label="Speaker selection: ${long}, 2 of 2\\.`));
  assert.match(SRC_CSS, /\.lcd-row-name \{[^}]*text-overflow:ellipsis/);
  assert.match(SRC_CSS, /\.lcd-status-text \{[^}]*text-overflow:ellipsis/);
});

// ======================================================================
// 3b. THE DIAL'S PUSHES AT REAL POINTER TIMINGS (pre-deploy verification)
// ======================================================================
/* Two startable stations (tested on the current builder, viable) and a
 * speaker the Dial aims at; the panel's own refetches get the same answers. */
const VIABLE = [
  { id: "p1", label: "Nineties", kind: "music", query: "90s Rock", enabled: true,
    last_test: { query: "90s Rock", tracks: 25, artists: 11, viable: true, builder_revision: 2 } },
  { id: "p2", label: "Night Crossing", kind: "music", query: "Night Crossing", enabled: true,
    last_test: { query: "Night Crossing", tracks: 25, artists: 6, viable: true, builder_revision: 2 } },
];
const LIVE = { ok: true, active: false, state: "off",
  dial_target: { queue_id: "media_player.den", name: "Den", source: "last_station" } };
const dialMount = () => mount({ presets: VIABLE, ws: {
  "parlorwave_radio/station_dial": { presets: VIABLE, builder_revision: 2 },
  "parlorwave_radio/station_live": LIVE,
  "parlorwave_radio/station_live_start": { ok: true, target: { name: "Den" }, opening_count: 5 } } });
const dialStarts = (el) => el.calls.filter((c) => c.ws === "parlorwave_radio/station_live_start");
/* A press and release the way each pointer delivers it: a mouse also gets the
 * browser's click (swallowed by the knob's capture guard), a finger does not. */
function release(el, kind, id) {
  const b = rknob(el);
  fire(b, "pointerdown", { clientX: 702, clientY: 102, pointerId: id, pointerType: kind });
  fire(win, "pointerup", { clientX: 702, clientY: 102, pointerId: id, pointerType: kind });
  if (kind === "mouse") fire(b, "click", { clientX: 702, clientY: 102 });
}

test("Dial: a single push asks, a separate later push starts the station shown, exactly once", async () => {
  for (const kind of ["mouse", "touch"]) {
    const el = dialMount();
    wheelR(el, NEXT);                                            // the Dial, on Nineties
    await settle();
    release(el, kind, 1);                                        // asks
    assert.equal(el._stationArmed, true, `${kind}: the first push asks`);
    assert.match(html(el), /PUSH AGAIN TO START/);
    advance(800);
    release(el, kind, 2);                                        // a deliberate second push
    assert.equal(dialStarts(el).length, 0, `${kind}: held for the double-push window`);
    advance(KNOB_DBL + 10); await settle(); await settle();
    assert.equal(dialStarts(el).length, 1, `${kind}: started`);
    assert.equal(dialStarts(el)[0].data.preset_id, "p1", `${kind}: the station shown`);
    for (let i = 0; i < 3; i++) { advance(600); release(el, kind, 10 + i); }
    advance(2000); await settle();
    assert.equal(dialStarts(el).length, 1, `${kind}: never twice`);
    assert.deepEqual(selects(el), [], `${kind}: and no speaker change`);
  }
});

test("Dial: a double push opens the speaker list and its first push starts nothing, at every human timing", async () => {
  for (const kind of ["mouse", "touch"]) {
    for (const armed of [false, true]) {
      for (const gap of [40, 90, 150, 220, 300, 340]) {
        const el = dialMount();
        wheelR(el, NEXT); await settle();
        if (armed) { release(el, kind, 1); advance(900); }        // a question already standing
        release(el, kind, 2); advance(gap); release(el, kind, 3);
        const tag = `${kind}, ${armed ? "asked" : "not asked"}, ${gap} ms`;
        assert.equal(el._outputMode, true, `${tag}: the pair is the speaker list`);
        assert.equal(el._stationMode, false, `${tag}: the Dial gave way`);
        advance(3000); await settle(); await settle();
        assert.equal(dialStarts(el).length, 0, `${tag}: no station started`);
        assert.deepEqual(selects(el), [], `${tag}: and no speaker changed`);
      }
    }
  }
});

test("Dial: two pushes just too far apart for a pair are two pushes, and the second is too soon to start", async () => {
  for (const kind of ["mouse", "touch"]) {
    for (const gap of [KNOB_DBL + 10, 390]) {
      const el = dialMount();
      wheelR(el, NEXT); await settle();
      release(el, kind, 1); advance(gap); release(el, kind, 2);
      advance(3000); await settle();
      assert.equal(el._outputMode, false, `${kind} ${gap} ms: not a pair`);
      assert.equal(dialStarts(el).length, 0, `${kind} ${gap} ms: a push under 400 ms after asking is no confirmation`);
      assert.equal(el._stationArmed, true, `${kind} ${gap} ms: the question still stands`);
    }
  }
});

test("Dial: a bouncing release counts once; a turn during the held confirmation takes it back", async () => {
  const el = dialMount();
  wheelR(el, NEXT); await settle();
  release(el, "mouse", 1); advance(800);
  release(el, "mouse", 2); advance(10); release(el, "mouse", 3);   // a 10 ms bounce
  advance(KNOB_DBL + 10); await settle(); await settle();
  assert.equal(dialStarts(el).length, 1, "the bounce is one push");
  const again = dialMount();
  wheelR(again, NEXT); await settle();
  release(again, "touch", 1); advance(800);
  release(again, "touch", 2); advance(100);
  wheelR(again, NEXT);                                              // turned away while held
  advance(2000); await settle();
  assert.equal(dialStarts(again).length, 0);
});

// ======================================================================
// 3c. OPENING THE LIST ON THE SPEAKER ALREADY PLAYING
// ======================================================================
test("opening the list on the current speaker and confirming it never sends a change, by any path", async () => {
  // pointer: open, then a deliberate separate push on the current speaker
  let el = mount();
  openList(el); pushR(el); await settle();
  assert.deepEqual(selects(el), [], "push on the current speaker");
  assert.match(html(el), /NO CHANGE/);
  // browse away and back, then push
  el = mount();
  openList(el); wheelR(el, NEXT); wheelR(el, -NEXT); advance(400); pushR(el); await settle();
  assert.deepEqual(selects(el), [], "browsed away and back");
  // keyboard: Enter opens, Enter confirms the current speaker
  el = mount();
  fire(rknob(el), "click", { detail: 0, clientX: 0, clientY: 0 });
  key("Enter"); await settle();
  assert.deepEqual(selects(el), [], "Enter on the current speaker");
  // opening, idling out, Escape: nothing either
  el = mount();
  openList(el); advance(6000); await settle();
  el2: { const e2 = mount(); openList(e2); key("Escape"); await settle(); assert.deepEqual(selects(e2), []); }
  assert.deepEqual(selects(el), [], "timed out");
});

// ======================================================================
// 3d. LONG SPEAKER NAMES KEEP THEIR ENDINGS
// ======================================================================
/* In a browser, two 50-character names differing only in their last word
 * were cut to the SAME visible characters on a 360 px phone -- current and
 * candidate indistinguishable, with no tooltip on a touch screen. The head now yields
 * to an ellipsis and the tail stays whole, in the same boxes. */
test("a long name splits into a shrinking head and a whole tail; short names are untouched", () => {
  const el = mount();
  const parts = (n) => el._nameParts(n);
  assert.deepEqual(parts("Den"), { head: "Den", tail: "" });
  assert.deepEqual(parts("Upstairs Hallway And Landing Ceiling Speakers Left"),
                   { head: "Upstairs Hallway And Landing Ceiling ", tail: "Speakers Left" });
  assert.deepEqual(parts("Upstairs Hallway And Landing Ceiling Speakers Right"),
                   { head: "Upstairs Hallway And Landing Ceiling ", tail: "Speakers Right" });
  assert.deepEqual(parts("Kitchen Left"), { head: "Kitchen ", tail: "Left" },
                   "the tail takes the last word, and the word before only while it stays short");
  assert.deepEqual(parts("Living Room Supercalifragilisticexpialidocious"),
                   { head: "Living Room Supercalifragilisticex", tail: "pialidocious" },
                   "a last word longer than 16 keeps its last 12 characters");
  for (const n of ["Den", "Kitchen Left", "A B C D E F G H", "Upstairs Hallway And Landing Ceiling Speakers Left",
                   "Living Room Supercalifragilisticexpialidocious", "Ünïcødé  double  spaces"]) {
    const p = parts(n);
    assert.equal(p.head + p.tail, n, `nothing is lost from ${n}`);
  }
});

test("long names: both rows and the header keep their distinguishing endings; text, title and names are whole", () => {
  const L = "Upstairs Hallway And Landing Ceiling Speakers Left";
  const R = "Upstairs Hallway And Landing Ceiling Speakers Right";
  const el = mount({ options: ["Den", L, R], output: L });
  assert.equal(header(el).out, L, "the header's text is the whole name");
  assert.equal(header(el).outTitle, L);
  assert.match(html(el), /<span class="pw-name-tail">Speakers Left<\/span>/);
  dblR(el); advance(RUN_MS + 50); wheelR(el, NEXT);
  const r = rows(el);
  assert.deepEqual(r.slice(0, 2).map((x) => [x.name, x.title, x.split, x.now, x.cand]),
                   [[L, L, true, true, false], [R, R, true, false, true]]);
  assert.match(html(el), /<span class="pw-name-tail">Speakers Right<\/span>/);
  assert.match(html(el), new RegExp(`aria-label="Speaker selection: ${R}, 3 of 3\\. Now on ${L}\\.`));
  assert.match(SRC_CSS, /\.pw-name-head \{[^}]*text-overflow:ellipsis/);
  assert.match(SRC_CSS, /\.pw-name-tail \{ flex:none; white-space:pre; \}/);
});

test("a one-word name keeps exactly the markup it had", () => {
  const el = mount();
  openList(el);
  assert.match(html(el), /<span class="lcd-row-name" title="Den">Den<\/span>/);
  assert.ok(!html(el).includes('class="pw-name-tail"'), "no split for names that are one word");
});

// ======================================================================
// 4. THE LCD HEADER: THE ENTITIES' OWN STATES
// ======================================================================
test("the header: DJ ON / DJ OFF / unavailable from the switch, the speaker from the select", () => {
  let el = mount({ dj: "on" });
  assert.deepEqual([header(el).dj, header(el).out], ["DJ ON", "Den"]);
  assert.match(header(el).djCls, /lcd-tone-on/);
  el.report({ dj: "off" });
  assert.equal(header(el).dj, "DJ OFF");
  assert.match(header(el).djCls, /lcd-tone-off/);
  el = mount({ dj: "unavailable" });
  assert.equal(header(el).dj, "DJ UNAVAILABLE");
  el = mount({ output: "unknown" });
  assert.equal(header(el).out, "NO SPEAKER CHOSEN");
});

test("the header: SPEAKING only when the station says a voice is on the air", () => {
  const el = mount({ dj: "on", status: "on_air" });
  assert.equal(header(el).dj, "DJ SPEAKING");
  assert.match(header(el).djCls, /lcd-tone-air/);
  el.report({ status: "up_next" });
  assert.equal(header(el).dj, "DJ ON", "a break waiting in the queue is not speech");
  const pure = (label) => el._lcdStatus({ entity_id: "switch.dj", state: "on" }, { lamp: true, label }, true).left.text;
  assert.equal(pure("News"), "NEWS");
  assert.equal(pure("Announcement"), "ANNOUNCEMENT");
});

test("a change in flight keeps the real value and only marks it pending", () => {
  const el = mount({ dj: "on" });
  el._busy = "switch.dj";
  el._render();
  assert.equal(header(el).dj, "DJ ON", "not the value asked for");
  assert.match(header(el).djCls, /lcd-pending/);
  el._busy = "select.out";
  el._render();
  assert.match(header(el).outCls, /lcd-pending/);
  assert.equal(header(el).out, "Den");
});

test("the fabric carries no status: no lamps, no labels; the hover help is unchanged", () => {
  const el = mount();
  const h = html(el);
  assert.ok(!h.includes("knob-status"), "no status label under either knob");
  assert.ok(!/class="knob-led[ "]/.test(h), "no lamp beside either knob");
  assert.equal((h.match(/class="knob-halo"/g) || []).length, 2, "each knob has its invisible halo");
  assert.ok(!/<button[^>]*id="dj-switch"[^>]*title=/.test(h), "no native title on the DJ knob");
  assert.ok(h.includes("Turn: volume \u00b7 Push twice: DJ on/off"));
  assert.ok(h.includes("Turn: stations \u00b7 Push twice: speakers"));
  assert.ok(h.includes('class="console-out controls visually-hidden"'), "the speaker select stays for assistive technology");
});

test("a selector covers the LCD header instead of drawing under it", () => {
  assert.match(SRC_CSS, /\.mouth-lcd-overlay \{ position:absolute; inset:0; z-index:4;/);
  assert.match(SRC_CSS, /\.mouth\.in-output-mode \.lcd-status, \.mouth\.in-station-mode \.lcd-status,\s*\.mouth\.in-output-mode \.lcd-whisper, \.mouth\.in-station-mode \.lcd-whisper \{ visibility:hidden; \}/);
});

test("the halos: about 1.6x the knob, never wider than the knob's own column", () => {
  assert.match(SRC_CSS, /\.pw-knob-unit \{ container-type:inline-size; \}/);
  assert.match(SRC_CSS, /\.knob-halo \{[^}]*width:min\(160%, calc\(100cqw - 8px\)\)/);
  assert.match(SRC_CSS, /\.knob-halo \{[^}]*touch-action:pan-y/);
  assert.match(SRC_CSS, /\.dj-face, \.knob-face \{ touch-action:none; \}/);
});

test("the badge answers on its metal only, so its transparent cell never takes a knob's click", () => {
  const el = mount();
  const h = html(el);
  const m = /<span class="console-badge-hit" aria-hidden="true" style="left:([\d.]+)%; top:([\d.]+)%; width:([\d.]+)%; height:([\d.]+)%;">/.exec(h);
  assert.ok(m, "the wordmark mode has a hit area");
  // the wordmark's ink (65, 30, 379 x 86 in the 520 x 150 cell) scaled by
  // 0.79 about the centre, reaching 9 units lower to cover it where it is
  // lowered and on a phone, where it is not, plus 4 units
  assert.deepEqual(m.slice(1).map(Number), [19.61, 23.63, 59.12, 56.63]);
  assert.match(SRC_CSS, /\.console-badge \{ pointer-events:none; \}/);
  assert.match(SRC_CSS, /\.console-badge-hit \{ position:absolute; pointer-events:auto;/);
  // a station plate: the hit area is the plate, whatever its fitted width
  el._centerLogoMode = "station";
  el._render();
  const p = /<span class="console-badge-hit" aria-hidden="true" style="left:([\d.]+)%; top:([\d.]+)%; width:([\d.]+)%; height:([\d.]+)%;">/.exec(html(el));
  assert.ok(p, "the plate mode has one too");
  const [left, top, width, height] = p.slice(1).map(Number);
  assert.ok(Math.abs(left + width / 2 - 50) < 0.01, "centred on the plate");
  assert.ok(height < 50 && top > 25, "no taller than the plate and its margin");
});

// ======================================================================
// 5. CLEANUP
// ======================================================================
test("leaving the page mid-choice clears every timer and interval and closes the list", async () => {
  const el = mount();
  openList(el); wheelR(el, NEXT);
  wheel(el, -100);                                                // a readout is up too
  assert.ok(intervals.size >= 2, "the 1 s ticker and the countdown digits");
  el.disconnectedCallback();
  assert.equal(intervals.size, 0, "every interval cleared");
  assert.equal(el._outputMode, false);
  assert.equal(el._whisper, null);
  const due = timers.length;
  advance(20000);
  assert.deepEqual(selects(el), [], "nothing fired after leaving");
  assert.equal(win._ls.count("pointermove"), 0);
  assert.equal(win._ls.count("keydown"), 0);
  assert.ok(due >= 0);
});

test("an answer that arrives after the panel left draws nothing and arms nothing", async () => {
  const el = mount();
  let release;
  el._hass.callService = () => new Promise((r) => { release = r; });
  openList(el); wheelR(el, NEXT); advance(600);
  pushR(el);
  el.disconnectedCallback();
  release();
  await settle(); await settle();
  assert.equal(el._outputResult, null);
  assert.equal(timers.filter((t) => t.at > NOW).length, 0, "no close timer was left behind");
});

test("gestures leave no window listeners behind", () => {
  const el = mount();
  const base = ["pointermove", "pointerup", "pointercancel"].map((t) => win._ls.count(t));
  press(el); move(120, 100); lift(120, 100);
  pressR(el); lift(702, 102);
  escape(); el._cancelOutputMode && el._cancelOutputMode();
  assert.deepEqual(["pointermove", "pointerup", "pointercancel"].map((t) => win._ls.count(t)), base);
});

// ======================================================================
// 6. NOTICES, AND OUTPUT VERSUS STATION
// ======================================================================
const banner = (el) => { el._render(); return /<div class="notice err[^"]*" id="notice-banner"/.test(html(el)); };

test("a recoverable error goes by itself after 12 s; a success keeps its 30 s; a critical one stays", () => {
  const el = mount();
  el._setNotice(false, "That change was not saved.");
  assert.ok(banner(el));
  advance(11999);
  assert.ok(banner(el), "still there just before 12 s");
  advance(2);
  assert.ok(!banner(el), "gone at 12 s");
  el._setNotice(true, "Saved.");
  assert.equal(el._noticeMeta.ms, 30000, "a success toast keeps its own time");
  el._setNotice(false, "The station store cannot be read.", { critical: true });
  advance(600000);
  assert.ok(banner(el), "a critical error is still there ten minutes later");
  assert.match(html(el), /notice err notice-critical/);
  assert.match(html(el), /id="notice-close"/, "and can always be dismissed");
});

test("pointer or focus on the banner holds its clock; leaving gives it the rest, at least 3 s", () => {
  const el = mount();
  el._setNotice(false, "That change was not saved.");
  advance(5000);
  el._holdNotice(true);                       // the owner is reading it
  advance(60000);
  assert.ok(banner(el), "held while read");
  el._holdNotice(false);
  advance(6999);
  assert.ok(banner(el), "the 7 s it had left");
  advance(2);
  assert.ok(!banner(el));
  el._setNotice(false, "Another failure.");
  advance(11500);
  el._holdNotice(true); el._holdNotice(false);  // brushed past at the last moment
  advance(2999);
  assert.ok(banner(el), "at least 3 s to read it after a hold");
  advance(2);
  assert.ok(!banner(el));
  const src = SRC_CSS.slice(SRC_CSS.indexOf('const banner = this.shadowRoot.getElementById("notice-banner");'));
  for (const ev of ["mouseenter", "mouseleave", "focusin", "focusout"]) assert.ok(src.slice(0, 600).includes(`"${ev}"`), ev);
});

test("the same error again is one banner with a count, and its 12 s start again; a different one replaces it", () => {
  const el = mount();
  el._setNotice(false, "That speaker is unavailable.");
  advance(4000);
  el._setNotice(false, "That speaker is unavailable.");
  advance(4000);
  el._setNotice(false, "That speaker is unavailable.");
  assert.equal(el._noticeMeta.count, 3);
  el._render();
  assert.equal((html(el).match(/id="notice-banner"/g) || []).length, 1, "one banner, not three");
  assert.match(html(el), /<span class="notice-count" aria-label="3 times">×3<\/span>/);
  advance(11999);
  assert.ok(banner(el), "12 s from the LAST repeat");
  advance(2);
  assert.ok(!banner(el));
  el._setNotice(false, "One thing.");
  el._setNotice(false, "Another thing.");
  assert.equal(el._notice.text, "Another thing.");
  assert.equal(el._noticeMeta.count, 1);
});

test("leaving the page takes the notice clock with it", () => {
  const el = mount();
  el._setNotice(false, "That change was not saved.");
  el.disconnectedCallback();
  assert.equal(el._noticeTimer, null);
});

/* The speaker list writes ONE setting; it never starts, stops or moves a
 * station, never touches a player, whatever the destination is doing. */
const stationCalls = (el) => el.calls.filter((c) => c.ws && /station_live_(start|stop)/.test(c.ws));
const playerCalls = (el) => el.calls.filter((c) => c.svc && c.svc.startsWith("media_player."));
test("confirming a speaker is a settings write only: idle, playing, grouped, already selected, unavailable", async () => {
  const cases = [
    ["an idle speaker", { player: "idle" }, ["Kitchen"]],
    ["a playing speaker", { player: "playing" }, ["Kitchen"]],
    ["a speaker group", { options: ["Den", "West wing group", "Patio"] }, ["West wing group"]],
    ["a paused speaker", { player: "paused" }, ["Kitchen"]],
  ];
  for (const [label, opts, want] of cases) {
    const el = mount(opts);
    openList(el); wheelR(el, NEXT); advance(600); pushR(el);
    await settle();
    assert.deepEqual(selects(el), want, `${label}: one select_option`);
    assert.deepEqual(stationCalls(el), [], `${label}: no station started or stopped`);
    assert.deepEqual(playerCalls(el).filter((c) => c.svc !== "media_player.volume_set"), [], `${label}: no player touched`);
  }
  const same = mount();
  openList(same); pushR(same); await settle();
  assert.deepEqual(selects(same), [], "already selected: nothing is sent");
  const gone = mount({ output: "unavailable" });
  openList(gone); advance(600); pushR(gone); await settle();
  assert.deepEqual([selects(gone), stationCalls(gone)], [[], []], "unavailable: nothing is sent");
});

test("a refused speaker switch says it was a speaker switch, and that no station was touched", async () => {
  const el = mount({ refuseSelect: true });
  openList(el); wheelR(el, NEXT); advance(600); pushR(el);
  await settle(); await settle();
  assert.equal(el._notice.text,
    "The DJ speaker was not switched to Kitchen: That speaker is not available. No station was started or stopped.");
  assert.deepEqual(stationCalls(el), []);
});

/* The Dial aims at the STATION's speaker (on air, else the last station's),
 * never the selected DJ speaker. When the backend's own speaker check says
 * that speaker cannot take a station, the Dial says so before any push. */
const GROUP_TARGETS = { ok: true, targets: [
  { queue_id: "media_player.den", name: "Den", eligible: false, reason: "target_is_group",
    message: "That output is a speaker group. A station can only run on a single, ungrouped speaker in this release." }] };
const dialWith = (targets) => mount({ presets: VIABLE, ws: {
  "parlorwave_radio/station_dial": { presets: VIABLE, builder_revision: 2 },
  "parlorwave_radio/station_live": LIVE,
  "parlorwave_radio/station_live_targets": targets,
  "parlorwave_radio/station_live_start": { ok: false, reason: "target_is_group",
    message: "That output is a speaker group. A station can only run on a single, ungrouped speaker in this release." } } });

test("the Dial reads the speaker verdicts when it opens, and a speaker group is refused BEFORE any push", async () => {
  const el = dialWith(GROUP_TARGETS);
  wheelR(el, NEXT); await settle(); await settle();
  assert.ok(el.calls.some((c) => c.ws === "parlorwave_radio/station_live_targets"), "the read-only verdicts were read");
  assert.match(html(el), /Den is a speaker group/, "the Dial says why, naming the speaker");
  release(el, "mouse", 1); advance(800); release(el, "mouse", 2); advance(1000); await settle();
  assert.equal(el._stationArmed, false, "a push asks nothing");
  assert.deepEqual(stationCalls(el), [], "and nothing is sent to be refused");
  assert.deepEqual(selects(el), [], "and the speaker selection is untouched");
});

test("with no verdict to read, the backend decides as before, and its refusal names the operation", async () => {
  const el = dialWith(null);
  el._hass.callWS = ((orig) => (msg) => msg.type === "parlorwave_radio/station_live_targets"
    ? Promise.reject(new Error("no answer")) : orig(msg))(el._hass.callWS);
  wheelR(el, NEXT); await settle(); await settle();
  release(el, "mouse", 1); advance(800); release(el, "mouse", 2);
  advance(KNOB_DBL + 10); await settle(); await settle();
  assert.equal(stationCalls(el).length, 1, "the start went to the backend");
  assert.equal(el._notice.text, 'The Dial did not start "Nineties" on Den: That output is a speaker group. '
    + "A station can only run on a single, ungrouped speaker in this release. The DJ speaker selection was not changed.");
  assert.equal(el._noticeMeta.ms, 12000, "a recoverable refusal");
  assert.deepEqual(selects(el), []);
});

test("an eligible speaker: the Dial asks and starts exactly as before", async () => {
  const el = dialWith({ ok: true, targets: [{ queue_id: "media_player.den", name: "Den", eligible: true, reason: null }] });
  el._hass.callWS = ((orig) => (msg) => msg.type === "parlorwave_radio/station_live_start"
    ? (el.calls.push({ ws: msg.type, data: { ...msg } }), Promise.resolve({ ok: true, target: { name: "Den" }, opening_count: 5 }))
    : orig(msg))(el._hass.callWS);
  wheelR(el, NEXT); await settle(); await settle();
  assert.doesNotMatch(html(el), /cannot take a station|is a speaker group/);
  release(el, "mouse", 1); advance(800); release(el, "mouse", 2);
  advance(KNOB_DBL + 10); await settle(); await settle();
  assert.equal(stationCalls(el).length, 1);
  assert.deepEqual(selects(el), []);
});

test("every speaker reason has a short LCD line that names the speaker", () => {
  const el = mount();
  for (const [reason, words] of [["target_is_group", "is a speaker group"], ["target_grouped", "is grouped right now"],
                                 ["target_in_group", "belongs to a speaker group"], ["target_is_house_output", "is the house DJ speaker"],
                                 ["target_unavailable", "is unavailable"], ["something_new", "cannot take a station"]]) {
    assert.equal(el._dialTargetWhy({ reason }, "Loft speaker"), `Loft speaker ${words}`);
  }
});

test("the emblem is 21% smaller and 6% of its cell lower, in the code and the CSS alike; the plate is untouched", () => {
  // 0.88 at first, then a further tenth smaller
  assert.match(SRC_CSS, /const PW_EMBLEM_SCALE = 0\.79;/);
  assert.match(SRC_CSS, /const PW_EMBLEM_DROP = 0\.06;/);
  assert.match(SRC_CSS, /\.console-badge-emblem \{ transform:translateY\(6%\) scale\(\.79\); transform-origin:50% 50%; \}/);
  assert.doesNotMatch(SRC_CSS, /\.console-badge-plate \{[^}]*scale\(/, "the station plate keeps its size");
  const phone = SRC_CSS.slice(SRC_CSS.indexOf("@media (max-width: 560px)"));
  assert.match(phone.slice(0, phone.indexOf("@media (prefers-reduced-motion")),
               /\.console-badge-emblem \{ transform:scale\(\.79\); \}/, "a phone: smaller, not lower");
});

// ----------------------------------------------------------------------

// ======================================================================
// THE KNOB HINT: it counts only once it has
// been read. The first dragged pixel used to paint over it, and the
// right knob's first detent hid it, and either marked it done for the
// session -- so the one explanation of the gestures was never seen.
// ======================================================================
test("a hint painted over by the volume whisper, or hidden by the Dial, is not counted and returns", () => {
  const el = mount({ level: 0.5 });
  press(el); lift();
  assert.equal(el._whisper.text, "TURN FOR VOLUME · PUSH TWICE FOR DJ");
  el._showWhisper("VOLUME 52%", "volume", 1200);           // what the first dragged pixel does
  advance(5000);
  assert.equal(el._hinted.left, false, "overwritten before it was read: not counted");
  assert.equal(STORE.get("parlorwave_knob_hint_left"), undefined);
  press(el); lift();
  assert.equal(el._whisper.text, "TURN FOR VOLUME · PUSH TWICE FOR DJ", "offered again");
  advance(3000);
  assert.equal(el._hinted.left, true, "read in full this time");
  // the right knob: a selector opening over the hint takes it down uncounted
  pressR(el); lift(702, 102);
  assert.equal(el._whisper.text, "TURN FOR STATIONS · PUSH TWICE FOR SPEAKERS");
  el._cancelHint();
  assert.equal(el._whisper, null);
  advance(5000);
  assert.equal(el._hinted.right, false, "hidden before it was read: not counted");
  assert.equal(STORE.get("parlorwave_knob_hint_right"), undefined);
});

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
console.log(`${passed}/${tests.length} On Air interaction tests passed`);
