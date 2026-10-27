/* What the DJ may use: the weather entity and the calendars,
 * chosen on the panel beside the speakers, EXECUTED.
 *
 * The REAL _render and the REAL bindings run under node against the
 * markup-parsing fake shadow root test_panel_settings_redesign.mjs uses
 * (copied, as that suite copied Station's). Websocket calls are recorded by
 * a fake hass.callWS; the readiness documents are the real ones, built by
 * readiness.py through ha/tests/readiness_docs.py.
 *
 * Pinned: the three rows and where the speakers row goes while its step is
 * open; nothing drawn that cannot be trusted (loading, unreadable, empty);
 * a draft that lives in state and is written only by Save, one selector at
 * a time, the other travelling as null; the answer taken as the new truth;
 * a refusal leaving the draft alone; a poll never overwriting an edit; a
 * chosen calendar that vanished still ticked and said to be missing; the
 * warning BEFORE Save when unticking a calendar with announcements still to
 * air; Test disabled until what is on screen is saved; and the Station
 * tab's door landing on the calendars.
 *
 *   node ha/tests/test_panel_sources.mjs
 *   PANEL_JS=<a copy of the panel> node ha/tests/test_panel_sources.mjs */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL = process.env.PANEL_JS
  ? resolve(process.env.PANEL_JS)
  : join(HERE, "..", "custom_components", "parlorwave_radio", "panel", "parlorwave-radio-panel.js");

// --- the documents, from readiness.py ------------------------------------------
const py = spawnSync("python3", ["-B", join(HERE, "readiness_docs.py")], {
  env: Object.assign({}, process.env, { PYTHONPATH: `${join(HERE, "..")}:${HERE}`,
                                        PYTHONDONTWRITEBYTECODE: "1" }),
  encoding: "utf8", maxBuffer: 1 << 26 });
if (py.error && py.error.code === "ENOENT") {
  process.stdout.write("SKIPPED: python3 is not installed, so no readiness document can be built\n");
  process.exit(0);
}
assert.equal(py.status, 0, `readiness_docs.py failed:\n${py.stderr}`);
const DOCS = JSON.parse(py.stdout);

// --- a generic element, built from markup ------------------------------------
const camel = (s) => s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
const unesc = (s) => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const VOID = new Set(["input", "img", "br", "hr", "meta", "link", "source", "col", "wbr", "area"]);
// Focus is modelled only where a test asks for it (tracking()): focus() makes
// an element the root's activeElement, blur() and a rebuild drop it, as in a
// browser -- and a focused list or text box then holds renders back.
const TRACK = { on: false };

class ClassList {
  constructor(init = "") { this._s = new Set(String(init).split(/\s+/).filter(Boolean)); }
  add(...c) { c.forEach((x) => this._s.add(x)); }
  remove(...c) { c.forEach((x) => this._s.delete(x)); }
  contains(c) { return this._s.has(c); }
  toggle(c, f) {
    const on = f === undefined ? !this._s.has(c) : !!f;
    if (on) this._s.add(c); else this._s.delete(c);
    return on;
  }
}

class El {
  constructor(tag, attrs, root, at, end) {
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.id = attrs.id || "";
    this.classList = new ClassList(attrs.class || "");
    this.dataset = {};
    for (const [k, v] of Object.entries(attrs)) if (k.startsWith("data-")) this.dataset[camel(k.slice(5))] = v;
    this.type = attrs.type || "";
    this.value = attrs.value != null ? attrs.value : "";
    this.checked = "checked" in attrs;
    this.disabled = "disabled" in attrs;
    this.hidden = "hidden" in attrs;
    this.open = "open" in attrs;
    this._root = root; this._at = at; this._end = end;
    this._ls = [];
    this.style = { setProperty() {}, removeProperty() {}, getPropertyValue() { return ""; } };
  }
  addEventListener(type, fn) { this._ls.push({ type, fn }); }
  removeEventListener(type, fn) { this._ls = this._ls.filter((l) => !(l.type === type && l.fn === fn)); }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  blur() { if (TRACK.on && this._root.activeElement === this) this._root.activeElement = null; }
  focus() { if (TRACK.on) this._root.activeElement = this; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
  /* The element's own markup, start tag to its matching end tag. */
  get outerHTML() {
    const body = this._root._body;
    const tag = this.tagName.toLowerCase();
    if (VOID.has(tag) || body[this._end - 2] === "/") return body.slice(this._at, this._end);
    const re = new RegExp(`<(/?)${tag}(?=[\\s>/])`, "gi");
    re.lastIndex = this._end;
    let depth = 1, m;
    while ((m = re.exec(body))) {
      if (m[1]) {
        depth -= 1;
        if (!depth) return body.slice(this._at, body.indexOf(">", m.index) + 1);
      } else if (body[body.indexOf(">", m.index) - 1] !== "/") {
        depth += 1;
      }
    }
    return body.slice(this._at);
  }
  get textContent() { return text(this.outerHTML); }
}

const TAG = /<([a-zA-Z][\w-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g;
const ATTR = /([^\s=>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parse(root) {
  const els = [];
  const body = root._body;
  for (const m of body.matchAll(TAG)) {
    const attrs = {};
    for (const a of m[2].matchAll(ATTR)) attrs[a[1]] = unesc(a[2] ?? a[3] ?? a[4] ?? "");
    els.push(new El(m[1], attrs, root, m.index, m.index + m[0].length));
  }
  // a <select>'s value is its selected option's -- the LAST one marked
  // selected, as a browser picks it -- else its first option's
  for (const sel of els.filter((e) => e.tagName === "SELECT")) {
    const end = body.indexOf("</select>", sel._at);
    const opts = els.filter((e) => e.tagName === "OPTION" && e._at > sel._at && e._at < end);
    const pick = opts.filter((o) => "selected" in o.attrs).pop() || opts[0];
    sel.value = pick ? pick.value : "";
    sel.options = opts;
  }
  return els;
}

function matches(el, sel) {
  return sel.split(",").map((s) => s.trim()).some((s) => {
    let m;
    if ((m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(s))) return m[1] in el.attrs && (m[2] == null || el.attrs[m[1]] === m[2]);
    if ((m = /^#([\w-]+)$/.exec(s))) return el.id === m[1];
    if ((m = /^\.([\w-]+)$/.exec(s))) return el.classList.contains(m[1]);
    if ((m = /^([a-z]+)$/.exec(s))) return el.tagName === m[1].toUpperCase();
    return false;
  });
}

class Root {
  constructor() { this.gen = 0; this._html = ""; this._body = ""; this._els = []; this._ls = []; this.activeElement = null; }
  addEventListener(type, fn) { this._ls.push({ type, fn }); }
  removeEventListener() {}
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v);
    this.gen += 1;
    this._body = this._html.replace(/<style>[\s\S]*?<\/style>/g, "");   // CSS is not markup
    this._els = parse(this);
    if (TRACK.on) this.activeElement = null;      // a rebuilt tree has lost focus
  }
  getElementById(id) { return this._els.find((e) => e.id === id) || null; }
  querySelectorAll(sel) { return this._els.filter((e) => matches(e, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

function text(html) {
  return unesc(String(html).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function fire(el, type, init = {}) {
  assert.ok(el, `no element to ${type}`);
  const ev = { type, target: el, currentTarget: el, key: "", defaultPrevented: false,
               preventDefault() { this.defaultPrevented = true; }, stopPropagation() {},
               composedPath() { return [el]; }, ...init };
  for (const l of el._ls.filter((x) => x.type === type)) l.fn.call(el, ev);
  return ev;
}
const describe = (e) => (e ? `<${e.tagName.toLowerCase()}${e.id ? ` id="${e.id}"` : ""}${
  Object.entries(e.dataset).map(([k, v]) => ` data-${k}="${v}"`).join("")}>` : "nothing");
/* A person's press: a disabled control cannot be pressed (as in a browser). */
function press(e) {
  assert.ok(e, "nothing to press");
  assert.ok(!e.disabled, `pressed a disabled control: ${describe(e)}`);
  fire(e, "click");
}
function type(e, value) {
  assert.ok(e, "no field to type into");
  assert.ok(!e.disabled, `typed into a disabled field: ${describe(e)}`);
  e.value = value;
  fire(e, "input");
}
/* A person can pick only an option that is offered, and not a disabled one. */
function choose(sel, value) {
  assert.ok(sel, "no list to choose from");
  const opt = sel.options.find((o) => o.value === value);
  assert.ok(opt, `no option ${value}`);
  assert.ok(!("disabled" in opt.attrs), `chose a disabled option ${value}`);
  sel.value = value;
  fire(sel, "change");
}

// --- the page ------------------------------------------------------------------
globalThis.HTMLElement = class {
  constructor() { this.style = { setProperty() {}, removeProperty() {}, getPropertyValue() { return ""; } }; }
  attachShadow() { this.shadowRoot = new Root(); return this.shadowRoot; }
};
let PanelClass = null;
globalThis.customElements = { get: () => undefined, define: (_n, c) => { PanelClass = c; } };
globalThis.window = { addEventListener() {}, removeEventListener() {}, matchMedia: undefined };
globalThis.document = { visibilityState: "visible", hidden: false, addEventListener() {}, removeEventListener() {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
const realNow = Date.now;
const NOW = Date.parse("2026-10-09T19:00:00Z");
Date.now = () => NOW;
// The notices' timers are recorded and never run: no 30 s wait at exit.
const timers = [];
let tid = 1;
globalThis.setTimeout = (fn, ms) => { const id = tid++; timers.push({ id, at: NOW + (ms || 0), fn }); return id; };
globalThis.clearTimeout = (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); };
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
const settle = () => new Promise((r) => setImmediate(r));
const unhandled = [];
process.on("unhandledRejection", (e) => { unhandled.push(e); });

await import(pathToFileURL(PANEL).href);
assert.ok(PanelClass, "the panel did not define its element");


// This browser's own storage (the faceplate and the eyes live there).
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null),
                            setItem: (k, v) => { store.set(k, String(v)); },
                            removeItem: (k) => { store.delete(k); } };

// --- fixtures: neutral rooms only ----------------------------------------------
const clone = (x) => structuredClone(x);
const DEN = "media_player.den", KITCHEN = "media_player.kitchen", PATIO = "media_player.patio";
const SPEAKERS = { ok: true, speakers: [{ id: DEN, name: "Den" }, { id: KITCHEN, name: "Kitchen" },
                                        { id: PATIO, name: "Patio" }],
                   enabled: [DEN], selected: DEN };
const SERVICES = { ok: true, section: "services",
  settings: { voice_engine: { enabled: false, base_url: "", voice: "", key_saved: false },
              writer: { enabled: false, provider: "compat", base_url: "", model: "", key_saved: false } },
  writer_providers: [{ id: "compat", label: "A compatible service" }] };
const SOURCES = { ok: true, pending: {},
  weather: { selected: "weather.home", live: "weather.home",
             entities: [{ entity_id: "weather.home", name: "Home", available: true, selected: true, missing: false }] },
  calendars: { selected: ["calendar.book_club"], live: ["calendar.book_club"],
               entities: [{ entity_id: "calendar.book_club", name: "Book Club", available: true, selected: true, missing: false, failed: false },
                          { entity_id: "calendar.work", name: "Work", available: true, selected: false, missing: false, failed: false }] } };
const BASE_ANSWERS = {
  "parlorwave_radio/outputs_set": { ok: true, enabled: [] },
  "parlorwave_radio/context_sources": SOURCES,
  "parlorwave_radio/outputs": SPEAKERS,
  "parlorwave_radio/services": SERVICES,
  "parlorwave_radio/services_save": { ok: true },
  "parlorwave_radio/service_test": { ok: true, detail: "It answered." },
  "parlorwave_radio/calendar_test": { selected: [], entities: [], published: false, state: "no_calendar_selected" },
  "parlorwave_radio/weather_test": { selected: null, entity: null, published: false, state: "no_weather_selected" },
};
const NEVER = Symbol("never answers");
function hassFor(calls, answers) {
  const states = {
    "switch.dj": { entity_id: "switch.dj", state: "on", attributes: { friendly_name: "ParlorWave Radio DJ" } },
    "select.out": { entity_id: "select.out", state: "Den",
      attributes: { friendly_name: "Active DJ speaker", options: ["Den", "Kitchen"], player_id: DEN } },
    "sensor.dj": { entity_id: "sensor.dj", state: "waiting", attributes: {
      enabled: true, station_name: "QPRW FM", observer: { running: true, queue_id: DEN },
      outputs_enabled: [DEN], catalog: { usable: false, known: true, track_count: 0 } } },
  };
  return {
    states, auth: { data: { access_token: "x" } },
    callService: (d, s, data) => { calls.push({ svc: `${d}.${s}`, data }); return Promise.resolve(); },
    callWS: (msg) => {
      calls.push({ ws: msg.type, msg });
      let a = answers[msg.type];
      if (typeof a === "function") a = a(msg);
      if (a === NEVER) return new Promise(() => {});
      if (a instanceof Error) return Promise.reject(a);
      return Promise.resolve(a === undefined ? { ok: true } : clone(a));
    },
  };
}
function mount(name, { seed = {}, answers = {} } = {}) {
  const el = new PanelClass();
  el.calls = [];
  el._entityMap = { dj_enabled: "switch.dj", output: "select.out", dj_status: "sensor.dj" };
  el._voiceLib = {};
  el._view = "settings";
  el._ready = name ? { at: NOW, data: { readiness: clone(DOCS[name]) } } : null;
  el._speakers = { at: NOW, data: clone(SPEAKERS) };
  el._speakerDraft = SPEAKERS.enabled.slice();
  el._services = clone(SERVICES);
  el._sources = { at: NOW, data: clone(SOURCES) };
  Object.assign(el, seed);
  el.hass = hassFor(el.calls, Object.assign({}, BASE_ANSWERS, answers));
  return el;
}
const rerender = (el) => { el.hass = el._hass; };
const root = (el) => el.shadowRoot;
const page = (el) => root(el).innerHTML.split("</style>").slice(1).join("</style>");
const q = (el, sel) => root(el).querySelector(sel);
const qa = (el, sel) => root(el).querySelectorAll(sel);
const byId = (el, id) => root(el).getElementById(id);
const outer = (el, sel) => { const e = q(el, sel); return e ? e.outerHTML : ""; };
const within = (el, containerSel, sel) => {
  const c = q(el, containerSel);
  if (!c) return [];
  const end = c._at + c.outerHTML.length;
  return qa(el, sel).filter((e) => e._at > c._at && e._at < end);
};
const ws = (el, t) => el.calls.filter((c) => c.ws && (!t || c.ws === `parlorwave_radio/${t}`));
const rows = (el) => qa(el, ".ck-row");
const count = (s, needle) => s.split(needle).length - 1;
const tracking = (fn) => async () => { TRACK.on = true; try { await fn(); } finally { TRACK.on = false; } };

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const READY = { "parlorwave_radio/readiness": () => ({ readiness: clone(DOCS.ready) }) };
const WX = (el, id) => qa(el, "[data-weather]").find((r) => r.dataset.weather === id);
const CAL = (el, id) => qa(el, "[data-cal]").find((c) => c.dataset.cal === id);
const tick = (box, on) => { box.checked = on; fire(box, "change"); };
const pickRadio = (radio) => { radio.checked = true; fire(radio, "change"); };
// the rows, by the spot each one is (the fake root knows no descendant selectors)
const labelsOf = (el) => qa(el, ".src-row").map((r) => ({ "sources-speakers": "Speakers ParlorWave may DJ on",
  "sources-weather": "Weather", "sources-calendars": "Calendars" })[r.dataset.focus]);
const tagsIn = (el, sel) => { const c = q(el, sel); return c ? qa(el, ".spk-tag").filter((t) => t._at > c._at && t._at < c._at + c.outerHTML.length).map((t) => t.textContent) : []; };
const rowOf = (el, which) => `[data-focus="sources-${which}"]`;
const notice = (el) => (q(el, ".notice") || {}).textContent || "";

// ===========================================================================
// 1. the card and its rows
// ===========================================================================
test("a ready installation: one card, three rows, the speakers first", () => {
  const el = mount("ready");
  assert.ok(q(el, ".src-card"), "no card");
  assert.deepEqual(labelsOf(el), ["Speakers ParlorWave may DJ on", "Weather", "Calendars"]);
  assert.equal(qa(el, "[data-spk]").length, 3);
  assert.equal(qa(el, "[data-weather]").length, 2, "None and Home");
  assert.equal(qa(el, "[data-cal]").length, 2);
  assert.ok(WX(el, "weather.home").checked);
  assert.ok(!WX(el, "").checked);
  assert.ok(CAL(el, "calendar.book_club").checked);
  assert.ok(!CAL(el, "calendar.work").checked);
  for (const id of ["wx-save", "cal-save", "spk-save"]) assert.ok(byId(el, id).disabled, `${id} lit with nothing changed`);
  assert.equal(byId(el, "wx-reset"), null); assert.equal(byId(el, "cal-reset"), null);
  assert.ok(!q(el, ".extras").outerHTML.includes("<h2>Context</h2>"));
});

test("while the speaker step is open the speakers row is inside the step and the card keeps the other two", () => {
  const el = mount("first_run");
  assert.deepEqual(labelsOf(el), ["Weather", "Calendars"]);
  assert.equal(count(page(el), 'id="spk-save"'), 1);
  assert.equal(qa(el, "[data-spk]").length, 3, "the speaker list is in the open step");
  assert.equal(within(el, ".ck", "[data-spk]").length, 3, "the speaker list is not in the steps");
});

// ===========================================================================
// 2. nothing drawn that cannot be trusted
// ===========================================================================
test("before the inventories are read: a sentence, no choices, no Save", () => {
  const el = mount("ready", { seed: { _sources: null, _srcDraft: null } });
  assert.deepEqual(labelsOf(el), ["Speakers ParlorWave may DJ on", "Weather", "Calendars"]);
  assert.match(outer(el, rowOf(el, "weather")), /Reading what Home Assistant has/);
  assert.equal(qa(el, "[data-weather]").length, 0);
  assert.equal(qa(el, "[data-cal]").length, 0);
  assert.equal(byId(el, "wx-save"), null); assert.equal(byId(el, "cal-save"), null);
});

test("when they could not be read nothing is offered to change, and it says nothing was altered", () => {
  const el = mount("ready", { seed: { _sources: { at: NOW, data: null } } });
  for (const which of ["weather", "calendars"]) {
    assert.match(outer(el, rowOf(el, which)), /could not be read just now/);
    assert.match(outer(el, rowOf(el, which)), /Nothing has been altered/);
  }
  assert.equal(qa(el, "[data-weather]").length + qa(el, "[data-cal]").length, 0);
  assert.equal(ws(el, "context_sources_set").length, 0);
});

test("a Home Assistant with no weather and no calendar: how to add one, and nothing to save", () => {
  const el = mount("ready", { seed: { _sources: { at: NOW, data: { ok: true, pending: {},
    weather: { selected: "", live: "", entities: [] }, calendars: { selected: [], live: [], entities: [] } } },
    _srcDraft: { weather: "", calendars: [] } } });
  assert.match(outer(el, rowOf(el, "weather")), /no weather integration yet/);
  assert.match(outer(el, rowOf(el, "weather")), /Add a weather integration/);
  assert.match(outer(el, rowOf(el, "calendars")), /no calendar yet/);
  assert.match(outer(el, rowOf(el, "calendars")), /Add a calendar integration/);
  assert.equal(byId(el, "wx-save"), null); assert.equal(byId(el, "cal-save"), null);
  assert.equal(qa(el, "[data-weather]").length + qa(el, "[data-cal]").length, 0);
});

// ===========================================================================
// 3. the weather: one choice, saved alone
// ===========================================================================
test("choosing another weather entity lights Save and Undo; nothing is written until Save", async () => {
  const el = mount("ready", { answers: Object.assign({ "parlorwave_radio/context_sources_set": (m) => ({
    ok: true, changed: true, pending: {},
    weather: { selected: m.weather, live: m.weather, entities: [
      { entity_id: "weather.home", name: "Home", available: true, selected: m.weather === "weather.home", missing: false },
      { entity_id: "weather.lake", name: "Lake", available: false, selected: m.weather === "weather.lake", missing: false }] },
    calendars: clone(SOURCES.calendars) }) }, READY) });
  el._sources.data.weather.entities.push({ entity_id: "weather.lake", name: "Lake", available: false, selected: false, missing: false });
  rerender(el);
  assert.deepEqual(tagsIn(el, rowOf(el, "weather")), ["Unavailable"]);
  pickRadio(WX(el, "weather.lake"));
  assert.ok(WX(el, "weather.lake").checked);
  assert.equal(byId(el, "wx-save").disabled, false);
  assert.ok(byId(el, "wx-reset"), "no Undo");
  assert.ok(byId(el, "weather-test").disabled, "Test offered on an unsaved choice");
  assert.equal(ws(el, "context_sources_set").length, 0, "written before Save");
  press(byId(el, "wx-reset"));
  assert.ok(WX(el, "weather.home").checked, "Undo did not restore the stored choice");
  assert.ok(byId(el, "wx-save").disabled);
  pickRadio(WX(el, "weather.lake"));
  press(byId(el, "wx-save"));
  const sent = ws(el, "context_sources_set");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].msg, { type: "parlorwave_radio/context_sources_set", weather: "weather.lake", calendars: null },
                   "the calendars did not travel as null");
  await settle(); await settle();
  assert.ok(WX(el, "weather.lake").checked, "the answer is the truth");
  assert.ok(byId(el, "wx-save").disabled, "Save stayed lit after a save");
  assert.equal(byId(el, "weather-test").disabled, false, "Test is back once saved");
  assert.match(notice(el), /Saved\. The DJ may mention the weather from Lake\./);
  assert.equal(ws(el, "readiness").length, 1, "the readiness document is read again");
  assert.ok(q(el, ".src-card"), "the screen blanked to Reading… after Save");
});

test("None is a choice: saving it sends an empty weather and the row says what that means", async () => {
  const el = mount("ready", { answers: Object.assign({ "parlorwave_radio/context_sources_set": (m) => ({
    ok: true, changed: true, pending: {}, calendars: clone(SOURCES.calendars),
    weather: { selected: "", live: "", entities: [
      { entity_id: "weather.home", name: "Home", available: true, selected: false, missing: false }] } }) }, READY) });
  pickRadio(WX(el, ""));
  assert.match(outer(el, rowOf(el, "weather")), /never mentions the weather/);
  press(byId(el, "wx-save"));
  assert.equal(ws(el, "context_sources_set")[0].msg.weather, "");
  await settle(); await settle();
  assert.ok(WX(el, "").checked);
  assert.match(notice(el), /will not mention the weather/);
});

// ===========================================================================
// 4. the calendars: any number, the warning before Save
// ===========================================================================
test("on a backend that keeps them, unticking says they STILL AIR, and how to cancel", () => {
  const el = mount("ready");
  el._sources.data.pending = { "calendar.book_club": 2 };
  rerender(el);
  assert.deepEqual(tagsIn(el, rowOf(el, "calendars")), ["2 scheduled"]);
  tick(CAL(el, "calendar.book_club"), false);
  const warn = q(el, ".src-warn");
  assert.ok(warn, "no warning");
  assert.match(warn.textContent, /Book Club has 2 announcements scheduled\. Unticking it does not cancel them: they still air\./);
  assert.match(warn.textContent, /press Undo, delete them in the calendar, press Test, and untick it after that/);
  assert.doesNotMatch(page(el), /cancels 2 announcements/, "promised a cancellation the backend does not make");
  assert.match(outer(el, rowOf(el, "calendars")), /no new announcements are picked up/);
  assert.doesNotMatch(page(el), /no announcement airs/, "promised silence over scheduled announcements");
  press(byId(el, "cal-reset"));
  assert.equal(byId(el, "cal-test").disabled, false, "the Test the sentence asks for is not available after Undo");
});

test("unticking a calendar with announcements still to air is said before Save, and goes away when it is ticked again", () => {
  const el = mount("ready");
  el._sources.data.pending = { "calendar.book_club": 2 };
  el._sources.data.deselect_cancels = true;          // a backend that says it cancels
  rerender(el);
  assert.deepEqual(tagsIn(el, rowOf(el, "calendars")), ["2 scheduled"]);
  assert.equal(q(el, ".src-warn"), null);
  tick(CAL(el, "calendar.book_club"), false);
  const warn = q(el, ".src-warn");
  assert.ok(warn, "no warning");
  assert.match(warn.textContent, /Unticking Book Club cancels 2 announcements from it that have not aired yet/);
  assert.match(outer(el, rowOf(el, "calendars")), /no new announcements are picked up/, "none ticked: said");
  assert.equal(ws(el, "context_sources_set").length, 0);
  tick(CAL(el, "calendar.book_club"), true);
  assert.equal(q(el, ".src-warn"), null, "the warning outlived the untick");
  assert.ok(byId(el, "cal-save").disabled, "back to the stored list, Save still lit");
});

test("Save sends the whole calendar list and nothing about the weather; the answer is the truth", async () => {
  const el = mount("ready", { answers: Object.assign({ "parlorwave_radio/context_sources_set": (m) => ({
    ok: true, changed: true, pending: {}, weather: clone(SOURCES.weather),
    calendars: { selected: m.calendars, live: m.calendars, entities: SOURCES.calendars.entities.map((r) =>
      Object.assign({}, r, { selected: m.calendars.includes(r.entity_id) })) } }) }, READY) });
  tick(CAL(el, "calendar.work"), true);
  assert.equal(byId(el, "cal-save").disabled, false);
  assert.ok(byId(el, "cal-test").disabled, "Test offered on an unsaved list");
  press(byId(el, "cal-save"));
  const sent = ws(el, "context_sources_set");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].msg, { type: "parlorwave_radio/context_sources_set", weather: null,
                                  calendars: ["calendar.book_club", "calendar.work"] });
  await settle(); await settle();
  assert.ok(CAL(el, "calendar.work").checked);
  assert.ok(byId(el, "cal-save").disabled);
  assert.match(notice(el), /Saved\. ParlorWave reads Book Club, Work\./);
  assert.equal(byId(el, "cal-test").disabled, false);
  press(byId(el, "cal-test"));
  assert.equal(ws(el, "calendar_test").length, 1);
});

test("a refused save keeps the draft on screen and says nothing changed", async () => {
  const el = mount("ready", { answers: { "parlorwave_radio/context_sources_set": new Error("backend: no") } });
  tick(CAL(el, "calendar.work"), true);
  press(byId(el, "cal-save"));
  await settle(); await settle();
  assert.ok(CAL(el, "calendar.work").checked, "the draft was thrown away");
  assert.equal(byId(el, "cal-save").disabled, false, "Save went dark on a refusal");
  assert.match(notice(el), /Those calendars were not saved\. Nothing has changed\./);
  assert.ok(!notice(el).includes("backend: no"), "the service's words reached the screen");
});

test("a poll cannot overwrite a half-made choice; it resumes once the choice is saved or undone", () => {
  const el = mount("ready");
  tick(CAL(el, "calendar.work"), true);
  el._sources.at = 0;                                  // stale: due for a re-read
  rerender(el);
  assert.equal(ws(el, "context_sources").length, 0, "re-read mid-edit");
  assert.ok(CAL(el, "calendar.work").checked);
  press(byId(el, "cal-reset"));
  rerender(el);
  assert.equal(ws(el, "context_sources").length, 1, "no re-read after Undo");
});

test("a chosen calendar that vanished stays ticked, is said to be missing, and may be dropped", async () => {
  const el = mount("ready", { answers: Object.assign({ "parlorwave_radio/context_sources_set": (m) => ({
    ok: true, changed: true, pending: {}, weather: clone(SOURCES.weather),
    calendars: { selected: m.calendars, live: m.calendars,
                 entities: SOURCES.calendars.entities.filter((r) => m.calendars.includes(r.entity_id) || !r.selected) } }) }, READY) });
  el._sources.data.calendars.selected.push("calendar.gone");
  el._sources.data.calendars.entities.push({ entity_id: "calendar.gone", name: "calendar.gone", available: false, selected: true, missing: true, failed: false });
  el._sources.data.calendars.entities[0].failed = true;
  el._srcDraft = null;
  rerender(el);
  assert.deepEqual(tagsIn(el, rowOf(el, "calendars")), ["Can't read", "Not found"]);
  assert.ok(CAL(el, "calendar.gone").checked, "a vanished calendar was unticked for the person");
  assert.ok(byId(el, "cal-save").disabled);
  tick(CAL(el, "calendar.gone"), false);
  press(byId(el, "cal-save"));
  assert.deepEqual(ws(el, "context_sources_set")[0].msg.calendars, ["calendar.book_club"]);
  await settle(); await settle();
  assert.equal(CAL(el, "calendar.gone"), undefined, "a dropped missing calendar is still listed");
});

test("the Test results' nothing-selected answers point at the row above, not at the gear", () => {
  const el = mount("ready", { seed: { _calTest: { result: { state: "no_calendar_selected" } },
                                      _weatherTest: { result: { state: "no_weather_selected" } } } });
  assert.match(outer(el, rowOf(el, "calendars")), /Tick one above and save/);
  assert.match(outer(el, rowOf(el, "weather")), /Choose one above and save/);
  assert.ok(!page(el).includes("integration's options"), "still sends somebody to the options flow");
});

test("in every state: each Save at most once, every id once", () => {
  for (const name of Object.keys(DOCS)) {
    const el = mount(name);
    const html = page(el);
    for (const id of ["wx-save", "cal-save", "spk-save"]) assert.ok(count(html, `id="${id}"`) <= 1, `${name}: ${id} drawn twice`);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids.filter((x, i) => ids.indexOf(x) !== i), [], `${name}: an id drawn twice`);
  }
});

// ===========================================================================
// 5. the Station tab's door
// ===========================================================================
test("the Station tab's Announcements row opens Settings on the calendars, never the options flow", tracking(() => {
  const el = mount("ready", { seed: { _view: "station", _annOpen: true,
    _announcements: { at: NOW, data: { ok: true, enabled: true, calendars: [], upcoming: [], recent: [],
                                        smart_rewriting: false, late_air_minutes: 40 } },
    _live: { at: NOW, data: { ok: true, active: false, state: "off", last: null, dial_target: null } },
    _dial: { at: NOW, data: { ok: true, presets: [], builder_revision: 2, max_presets: 12 } } } });
  const door = qa(el, "[data-goto-focus]").find((b) => b.dataset.gotoFocus === "sources-calendars");
  assert.ok(door, "no door to the calendars");
  assert.ok(!page(el).includes("Open integration options"), "the Announcements row still routes to the gear");
  press(door);
  assert.equal(el._view, "settings");
  assert.equal(root(el).activeElement && root(el).activeElement.dataset.focus, "sources-calendars",
               "focus did not land on the calendars row");
}));

// ===========================================================================
// 6. Truthfulness around Save, time and permission
// ===========================================================================
test("a Save never draws the stale screen while readiness is being read again", async () => {
  const el = mount("ready", { answers: Object.assign({ "parlorwave_radio/context_sources_set": (m) => ({
    ok: true, changed: true, pending: {}, calendars: clone(SOURCES.calendars),
    weather: { selected: "", live: "", entities: clone(SOURCES.weather.entities) } }) },
    { "parlorwave_radio/readiness": NEVER }) });
  pickRadio(WX(el, ""));
  press(byId(el, "wx-save"));
  await settle(); await settle();
  assert.equal(ws(el, "readiness").length, 1, "readiness is not read again after a Save");
  assert.ok(el._ready.loading, "the re-read should still be in flight");
  assert.doesNotMatch(page(el), /has not answered for a while/, "a successful Save drew the stale screen");
  assert.ok(q(el, ".src-card"), "the card vanished while readiness was re-read");
  assert.match(text(outer(el, ".ready-strip")), /^Ready\./);
});

test("the ticker alone takes Ready off the screen once the document ages out, and puts it back", () => {
  const el = mount("ready");
  assert.ok(q(el, ".ready-strip"));
  // no hass update arrives (Home Assistant's connection is gone): only the ticker runs
  el._ready = Object.assign({}, el._ready, { at: NOW - 6 * 60 * 1000, loading: true, loadingSince: NOW });
  el._tick();
  assert.equal(q(el, ".ready-strip"), null, "Ready. stayed on the screen over a stale document");
  assert.match(text(outer(el, ".settings-desk")), /has not answered for a while/);
  el._ready = { at: NOW, data: { readiness: clone(DOCS.ready) } };
  el._tick();
  assert.ok(q(el, ".ready-strip"), "a fresh document did not bring the screen back");
});

test("someone who is not an administrator sees the choice and who can change it, never a Save that cannot work", () => {
  const el = mount("ready");
  el._hass.user = { is_admin: false };
  rerender(el);
  for (const [row, save] of [["weather", "wx-save"], ["calendars", "cal-save"]]) {
    assert.equal(byId(el, save), null, `${save} drawn for a non-administrator`);
    assert.match(outer(el, rowOf(el, row)), /Only a Home Assistant administrator can change this/);
  }
  assert.ok(qa(el, "[data-weather]").every((r) => r.disabled));
  assert.ok(qa(el, "[data-cal]").every((c) => c.disabled));
  assert.ok(WX(el, "weather.home").checked && CAL(el, "calendar.book_club").checked, "the choice is not shown");
  assert.equal(byId(el, "cal-test").disabled, false, "Test is a read: anyone may run it");
  el._hass.user = { is_admin: true };
  rerender(el);
  assert.ok(byId(el, "wx-save") && byId(el, "cal-save"));
});

// ===========================================================================
// 7. A REFRESH NEVER BLANKS THE SCREEN
// ===========================================================================
// Settings re-reads readiness, the speakers and the sources every 30 s, all
// three at once; the first to answer renders while the others are still out.
// Drawing "Reading…" over data already held rewrote the whole tree twice per
// refresh, shrank the page for a frame and moved a scrolled screen.
const TESTED = {
  _calTest: { result: { state: "ok", entities: [{ name: "Book Club" }], backend: { enabled_in_settings: true,
    events: [{ start: "2026-10-09T20:00:00Z", summary: "Dentist", reason: "eligible_headsup" }],
    would_say: "Heads up, the dentist is at three." } } },
  _weatherTest: { result: { state: "ok", entity: { name: "Home" }, backend: { received: true,
    enabled_in_settings: true, condition: "cloudy", temperature: 61, would_say: "Cloudy and sixty-one." } } },
};
const age = (el) => { for (const k of ["_ready", "_speakers", "_sources"]) el[k].at = NOW - 31000; };

test("while the 30 s refresh is out the screen is exactly what it was: nothing blanks, nothing moves", () => {
  const el = mount("ready", { seed: clone(TESTED), answers: { "parlorwave_radio/outputs": NEVER,
    "parlorwave_radio/context_sources": NEVER, "parlorwave_radio/readiness": NEVER } });
  const before = page(el);
  assert.match(before, /Heads up, the dentist is at three/, "the seeded Test result is not on screen");
  age(el);
  rerender(el);                                   // a routine state update: the refresh starts and renders
  assert.equal(ws(el, "outputs").length, 1, "the speakers were not read again");
  assert.equal(ws(el, "context_sources").length, 1, "the sources were not read again");
  assert.ok(el._speakers.loading && el._sources.loading, "the reads should still be out");
  assert.doesNotMatch(page(el), /Reading your speakers|Reading what Home Assistant has/,
                      "a refresh drew the placeholder over data already held");
  assert.equal(page(el), before, "the screen changed while a refresh was out");
});

test("a refresh that brings the same answer leaves the screen as it was", async () => {
  const el = mount("ready", { seed: clone(TESTED), answers: READY });
  const before = page(el);
  age(el);
  rerender(el);
  await settle(); await settle();
  assert.equal(ws(el, "outputs").length, 1);
  assert.equal(ws(el, "context_sources").length, 1);
  assert.ok(!el._speakers.loading && !el._sources.loading);
  assert.equal(page(el), before, "the same answers drew a different screen");
});

test("the very first read still says it is reading, and a failed read still says so", () => {
  const first = mount("ready", { seed: { _speakers: { loading: true }, _sources: { loading: true } },
    answers: { "parlorwave_radio/outputs": NEVER, "parlorwave_radio/context_sources": NEVER } });
  assert.match(page(first), /Reading your speakers/);
  assert.match(outer(first, rowOf(first, "weather")), /Reading what Home Assistant has/);
  const failed = mount("ready", { seed: { _speakers: { at: NOW, data: null }, _sources: { at: NOW, data: null } } });
  assert.match(page(failed), /Music Assistant could not be read just now/);
  assert.match(outer(failed, rowOf(failed, "calendars")), /could not be read just now/);
});

test("no fetch completion threw anywhere in this suite", async () => {
  await settle();
  assert.deepEqual(unhandled, []);
});

// --- run -----------------------------------------------------------------------
let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); process.stdout.write(`  ok  ${name}\n`); }
  catch (e) { failed += 1; process.stdout.write(`  FAIL ${name}\n       ${String(e.message).split("\n").join("\n       ")}\n`); }
}
Date.now = realNow;
process.stdout.write(`${tests.length - failed}/${tests.length} Sources tests passed\n`);
process.exit(failed ? 1 : 0);
