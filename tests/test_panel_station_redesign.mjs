/* The Station screen (the Dial stage), EXECUTED.
 *
 * The REAL _render and the REAL bindings run under node against a generic
 * markup-parsing fake shadow root: every innerHTML assignment builds fresh
 * elements from the markup the panel has just produced (id, class, data-*,
 * value, checked, disabled, open, the selected option), and a press fires
 * the listeners the panel bound to THAT element. A disabled control cannot
 * be pressed, as in a browser. Websocket calls go through a fake
 * hass.callWS that records every message and answers from a table; the
 * clock is fake, so no notice timer keeps node alive.
 *
 * What this pins is what a source pin cannot see: which truth each line of
 * the stage tells (the house's playback, the station on the air, a station
 * merely selected), what a press on a tile opens, what goes over the wire
 * and what never does. The design is the Station spec; where a
 * kept product rule and the mockup disagree the rule is what is tested.
 *
 *   node ha/tests/test_panel_station_redesign.mjs
 *   PANEL_JS=<a copy of the panel> node ha/tests/test_panel_station_redesign.mjs
 *
 * (PANEL_JS runs the same tests against another copy of the panel, e.g. a
 * deliberately broken one, to prove a test can fail.) */
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL = process.env.PANEL_JS
  ? resolve(process.env.PANEL_JS)
  : join(HERE, "..", "custom_components", "parlorwave_radio", "panel", "parlorwave-radio-panel.js");

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

// --- fixtures: the backend's own shapes (station_live.status(), targets(),
// the Dial read) -- neutral rooms only ---------------------------------------------
const DEN = "media_player.den";            // the house's own DJ speaker (selected)
const KITCHEN = "media_player.kitchen";
const PATIO = "media_player.patio";
const GARAGE = "media_player.garage";
const WHOLE = "media_player.loft_group";   // a speaker group
const clone = (x) => structuredClone(x);
const iso = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();

const test_ = (q, tracks, artists, viable, rev = 2) => ({ query: q, at: iso(600), status: "ok",
  strategy: "genre", tracks, artists, viable, weak: viable ? "" : "pool_too_small", variant: 0,
  builder_revision: rev });
const PRESETS = [
  { id: "p1", label: "Nineties", kind: "music", query: "90s Rock", enabled: true,
    last_test: test_("90s Rock", 25, 11, true) },
  { id: "p2", label: "Night Crossing", kind: "music", query: "night crossing", enabled: true,
    last_test: test_("night crossing", 25, 6, true) },
  { id: "p3", label: "Saturday Rock", kind: "music", query: "classic rock 70s", enabled: true,
    last_test: test_("classic rock 70s", 25, 9, true, 1) },           // an older builder: stale
  { id: "p4", label: "Late Night Jazz", kind: "music", query: "jazz", enabled: true,
    last_test: test_("jazz", 4, 1, false) },                         // too thin
  { id: "p5", label: "Sunday Soul", kind: "music", query: "soul 60s", enabled: false },
  { id: "p6", label: "Morning Mix", kind: "music", query: "indie pop", enabled: true },
  { id: "p7", label: "All News", kind: "news", source: "all_news", enabled: true },
];
const DIAL = { ok: true, presets: PRESETS, builder_revision: 2, max_presets: 12,
  test_states: { p1: "current", p2: "current", p3: "stale", p4: "current", p5: "none",
                 p6: "none", p7: "none" },
  identities: { p1: "music|90s rock|0", p2: "music|night crossing|0", p3: "music|classic rock 70s|0",
                p4: "music|jazz|0", p5: "music|soul 60s|0", p6: "music|indie pop|0" } };

const STATION = { station_id: "st-1", status: "active", label: "Nineties", query: "90s Rock",
  kind: "music", preset_id: "p1", origin: "dial", variant: 0, identity: "music|90s rock|0",
  target: { queue_id: KITCHEN, name: "Kitchen" }, strategy: "genre", seed_artist: null,
  pool_tracks: 180, pool_artists: 40, opening_count: 25, switched_from: null,
  created_at: iso(48), started_at: iso(48), stopped_at: null, stopped_reason: null,
  runway: { at: iso(2), reason: "runway_healthy", owned: 14, playable: 16,
            ahead: { station: 14, manual: 1, preexisting: 1, break: 1, news: 0, announcement: 0, unknown: 0 } },
  refill: { count: 1, last_at: iso(20), last: { at: iso(20), ok: true, appended: 12 }, pending: null,
            low_water: 8, target: 20, max_batch: 12 },
  owned_known: true, witness_exact: true, generated_count: 37, problem: "" };
const RULES = { opening: 25, low_water: 8, target: 20, max_batch: 12, min_pool_tracks: 15,
                min_artists: 3, min_opening: 15 };
const ON_AIR = { ok: true, active: true, state: "on_air", legacy_station_active: false, rules: RULES,
  station: STATION, dial_target: { queue_id: KITCHEN, name: "Kitchen", source: "on_air" } };
const STARTING = { ok: true, active: false, state: "starting", legacy_station_active: false, rules: RULES,
  station: Object.assign({}, STATION, { status: "starting", started_at: null }),
  dial_target: { queue_id: KITCHEN, name: "Kitchen", source: "on_air" } };
const OFF = { ok: true, active: false, state: "off", legacy_station_active: false, rules: RULES,
  last: Object.assign({}, STATION, { status: "stopped", stopped_at: iso(30), stopped_reason: "stopped" }),
  dial_target: { queue_id: KITCHEN, name: "Kitchen", source: "last_station" } };
const UNKNOWN = { ok: false, active: false, state: "unknown", reason: "station_state_unreadable" };
// A Request Line station: no preset -- with the very term and identity of a
// saved one, so nothing but the preset id can tell them apart.
const RL_ON_AIR = Object.assign({}, ON_AIR, { station: Object.assign({}, STATION,
  { preset_id: null, origin: "request_line", label: "90s Rock" }) });
const TARGETS = { ok: true, targets: [
  { queue_id: KITCHEN, name: "Kitchen", provider: "cast", eligible: true, reason: "", message: "",
    dj_output: false, house_output: false, authorized: true },
  { queue_id: PATIO, name: "Patio", provider: "cast", eligible: true, reason: "", message: "",
    dj_output: true, house_output: false, authorized: true },
  { queue_id: DEN, name: "Den", provider: "cast", eligible: false, reason: "target_is_house_output",
    message: "That is the house DJ speaker.", dj_output: true, house_output: true, authorized: true },
  { queue_id: WHOLE, name: "Loft group", provider: "cast", eligible: false, reason: "target_is_group",
    message: "That output is a speaker group.", dj_output: true, house_output: false, authorized: true },
  { queue_id: GARAGE, name: "Garage", provider: "cast", eligible: false, reason: "target_unavailable",
    message: "That speaker is unavailable.", dj_output: false, house_output: false, authorized: true },
] };
const ANN = { ok: true, enabled: true, smart_rewriting: false, smart_available: false,
  late_air_minutes: 40, calendars: ["calendar.home_events"], calendars_failed: [],
  store_problem: false, config_problem: false,
  upcoming: [{ occurrence_id: "o1", payload: "Fish fry <tonight>", start: "2026-10-09T22:00:00Z",
               state: "scheduled", mode: "smart" }],
  recent: [{ occurrence_id: "o2", payload: "Bake sale", spoken_text: "The bake sale starts now",
             aired_at: iso(240), start: iso(240), state: "spent", origin: "deterministic" },
           { occurrence_id: "o3", payload: "", start: "2026-10-08", state: "invalid",
             invalid_reason: "empty_payload" }] };
// The readiness document's optional rows, in readiness.py's own shape.
const READY = { state: "ready", known: true, complete: 4, total: 4, headline: "Ready.", detail: "",
  checklist: [], blockers: [], warnings: [],
  optional: [
    { key: "catalog", label: "Local music catalog", badge: "Not in this release", tone: "off",
      detail: "", where: "station" },
    { key: "newsroom", label: "News bulletins", badge: "Enabled", tone: "on",
      detail: "A news podcast airs between songs on the schedule you set.", where: "newsroom" },
  ] };

const NEVER = Symbol("never answers");
function hassFor(calls, answers, over = {}) {
  const states = {
    "switch.dj": { entity_id: "switch.dj", state: over.dj || "on", attributes: {} },
    "switch.speech": { entity_id: "switch.speech", state: over.speech || "on", attributes: {} },
    "select.persona": { entity_id: "select.persona", state: "Smooth", attributes: {} },
    "select.voice": { entity_id: "select.voice", state: "Amy", attributes: {} },
    // the catalog-only programming entities exist on every install; base
    // mode must still offer none of them
    "switch.endless": { entity_id: "switch.endless", state: "on",
      attributes: { friendly_name: "ParlorWave Radio Endless Radio" } },
    "select.feel": { entity_id: "select.feel", state: "Balanced",
      attributes: { options: ["Familiar", "Balanced", "Adventurous"] } },
    "switch.same_artist": { entity_id: "switch.same_artist", state: "on",
      attributes: { friendly_name: "ParlorWave Radio Same artist" } },
    "select.same_artist_freq": { entity_id: "select.same_artist_freq", state: "Low",
      attributes: { options: ["Low", "Medium", "High"] } },
    "sensor.dj": { entity_id: "sensor.dj", state: "waiting", attributes: Object.assign({
      enabled: true, station_name: "QPRW FM", observer: { running: true, queue_id: DEN },
      outputs_enabled: [DEN], catalog: { usable: false, known: true, track_count: 0 } }, over.djAttrs || {}) },
    "sensor.station": { entity_id: "sensor.station", state: over.legacyStation || "none", attributes: {} },
    "select.out": { entity_id: "select.out", state: "Den", attributes: {
      options: ["Den", "Kitchen"], player_id: DEN, output_entity_id: DEN } },
    [DEN]: { entity_id: DEN, state: over.player || "playing", attributes: { friendly_name: "Den",
      supported_features: 16445, media_title: over.title || "Northern Line", media_artist: "The Lanterns",
      volume_level: 0.5 } },
  };
  return {
    states,
    auth: { data: { access_token: "x" } },
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
const BASE_ANSWERS = {
  "parlorwave_radio/station_live_targets": TARGETS,
  "parlorwave_radio/station_live_start": { ok: true, opening_count: 25,
    target: { queue_id: KITCHEN, name: "Kitchen" } },
  "parlorwave_radio/station_live_stop": { ok: true, message: "Stopped programming Kitchen." },
  "parlorwave_radio/station_live": ON_AIR,
  "parlorwave_radio/station_dial": DIAL,
  "parlorwave_radio/station_dial_save": (msg) => Object.assign(clone(DIAL), {
    presets: msg.presets.map((p, i) => Object.assign({ id: p.id || `new_${i}` }, p)) }),
  "parlorwave_radio/announcements": ANN,
  "parlorwave_radio/station_settings": { ok: true, settings: { identity: { name: "QPRW FM" } } },
  "parlorwave_radio/station_save": { ok: true },
  "parlorwave_radio/readiness": { readiness: READY },
};
const fresh = (extra = {}) => Object.assign({
  _dial: { at: NOW, data: clone(DIAL) },
  _live: { at: NOW, data: clone(OFF) },
  _announcements: { at: NOW, data: clone(ANN) },
  _stationSettings: { identity: { name: "QPRW FM" } }, _stationSettingsAt: NOW,
  _ready: { at: NOW, data: { readiness: clone(READY) } },
}, extra);
const live = (data, extra = {}) => Object.assign({ at: NOW, data: clone(data) }, extra);

function mount({ seed = {}, answers = {}, over = {}, view = "station", catalog = false } = {}) {
  const el = new PanelClass();
  el.calls = [];
  el._entityMap = { dj_enabled: "switch.dj", dj_speech: "switch.speech", dj_status: "sensor.dj",
                    output: "select.out", personality: "select.persona", voice: "select.voice",
                    station: "sensor.station", endless_radio: "switch.endless",
                    station_feel: "select.feel", same_artist: "switch.same_artist",
                    same_artist_frequency: "select.same_artist_freq" };
  el._voiceLib = {};
  Object.assign(el, fresh(seed));
  el._view = view;
  if (catalog) over = Object.assign({}, over, { djAttrs: Object.assign({},
    over.djAttrs || {}, { catalog: { usable: true, known: true, track_count: 900 } }) });
  el.hass = hassFor(el.calls, Object.assign({}, BASE_ANSWERS, answers), over);
  return el;
}
const rerender = (el) => { el.hass = el._hass; };      // an ordinary hass update
const root = (el) => el.shadowRoot;
const page = (el) => root(el).innerHTML.split("</style>").slice(1).join("</style>");
const q = (el, sel) => root(el).querySelector(sel);
const qa = (el, sel) => root(el).querySelectorAll(sel);
const byId = (el, id) => root(el).getElementById(id);
const tile = (el, id) => q(el, `[data-dial-pick="${id}"]`);
const outer = (el, sel) => { const e = q(el, sel); return e ? e.outerHTML : ""; };
/* The elements matching `sel` that lie inside the first `containerSel`. */
const within = (el, containerSel, sel) => {
  const c = q(el, containerSel);
  if (!c) return [];
  const end = c._at + c.outerHTML.length;
  return qa(el, sel).filter((e) => e._at > c._at && e._at < end);
};
const houseLine = (el) => { const e = q(el, ".st-truth"); return e ? e.textContent : ""; };
const airLine = (el) => outer(el, ".air-status");
const sheet = (el) => outer(el, ".air-form");
const editor = (el) => outer(el, ".dial-editor");
const ws = (el, t) => el.calls.filter((c) => c.ws && (!t || c.ws === `parlorwave_radio/${t}`));
const svc = (el) => el.calls.filter((c) => c.svc);
const payload = (c) => { const { type, ...rest } = c.msg; return rest; };
function idsOnce(el, label) {
  const ids = [...page(el).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  assert.deepEqual(dup, [], `${label}: an id rendered twice: ${dup.join(", ")}`);
}
/* Red, on this screen, is ON AIR: the on-air line's "on" state, a lit tile,
 * a lit sheet chip. */
const RED = /air-line on\b|class="preset[^"]*\bonair\b|sheet-chip lit/;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ===========================================================================
// 1. THE PAGE: one page in both modes, only Advanced differs
// ===========================================================================
test("both modes render one page: the Dial stage, the Request Line, Programming, then Advanced", () => {
  for (const catalog of [false, true]) {
    const h = page(mount({ catalog }));
    const at = ['<section class="booth-hero station-desk" aria-label="The Dial">',
                '<section class="card rl-card" aria-label="Request Line">',
                '<section class="card prog-card" aria-label="Programming">',
                '<details class="st-adv"'].map((s) => h.indexOf(s));
    assert.ok(at.every((i) => i >= 0), `a region is missing (catalog ${catalog}): ${at}`);
    assert.deepEqual(at, [...at].sort((a, b) => a - b), `regions out of order (catalog ${catalog})`);
    const deck = outer(mount({ catalog }), ".station-desk");
    for (const part of ['id="station-deck-plate"', 'class="st-truth"', 'aria-label="On-air station"',
                        'aria-label="Dial Stations"']) {
      assert.ok(deck.includes(part), `the Dial stage lacks ${part}`);
    }
  }
});

test("base mode offers no catalog tool; catalog mode offers each once, inside Advanced", () => {
  const base = mount();
  for (const sel of ["#start-radio", "#request-input", "#request-go", "[data-toggle]", "[data-select]"]) {
    assert.equal(qa(base, sel).length, 0, `base mode offers ${sel}`);
  }
  const cat = mount({ catalog: true });
  const adv = outer(cat, ".st-adv");
  for (const id of ["start-radio", "request-input", "request-go"]) {
    assert.equal(qa(cat, `#${id}`).length, 1, `${id} is not offered exactly once`);
    assert.ok(adv.includes(`id="${id}"`), `${id} is outside Advanced`);
  }
  assert.deepEqual(qa(cat, "[data-toggle]").map((t) => t.dataset.toggle), ["switch.endless", "switch.same_artist"],
                   "the station feel switches are not offered once each");
  assert.deepEqual(qa(cat, "[data-select]").map((t) => t.dataset.select), ["select.feel", "select.same_artist_freq"]);
  assert.deepEqual(within(cat, ".st-adv", "[data-toggle], [data-select]").length, 4, "a catalog control is outside Advanced");
  assert.equal(q(cat, ".st-adv").open, false, "Advanced opens by itself in catalog mode");
});

test("base mode's Advanced says where the music comes from, and no roadmap", () => {
  // Alpha.4: the "Not in this release" card and
  // the optional local-catalog entry were development notes, not station
  // facts, and the list contradicted the working Request Line and Dial.
  const el = mount();
  const adv = text(outer(el, ".st-adv"));
  assert.match(adv, /Music Assistant In use/);
  assert.match(adv, /Following Music Assistant: it chooses the music and keeps the queue; ParlorWave follows it\./);
  assert.match(adv, /Dial Stations and requests play from your Music Assistant library\. Music Assistant owns the queue\. ParlorWave preserves your music order, adding only finite DJ and news elements and what you ask for\./);
  assert.doesNotMatch(adv, /About the Dial|Stopping it only stops the programming/);
  assert.doesNotMatch(adv, /Not in this release/);
  assert.doesNotMatch(adv, /A local ParlorWave catalog|this release does not build one/);
  for (const item of ["Request a single song or a mood", "Endless Radio — keep the station playing on its own",
                      "Station feel and artist rotation"]) {
    assert.ok(!adv.includes(item), `roadmap item still listed: ${item}`);
  }
  assert.doesNotMatch(adv, /Needs a local catalog|Planned|never reorders/);
});

test("every Station id is rendered at most once, in every state", async () => {
  const states = [
    ["off", {}], ["on air", { _live: live(ON_AIR) }], ["starting", { _live: live(STARTING) }],
    ["unknown", { _live: live(UNKNOWN) }], ["error", { _live: live(ON_AIR, { error: true }) }],
    ["loading", { _live: { loading: true }, _dial: { loading: true }, _announcements: { loading: true } }],
    ["choosing", { _liveForm: { preset_id: "p2", target: KITCHEN, confirm: true },
                   _liveTargets: live(TARGETS) }],
    ["switching", { _live: live(ON_AIR), _liveForm: { preset_id: "p2", target: KITCHEN, confirm: false } }],
    ["editing", { _live: live(ON_AIR), _dialEdit: { id: "p1", label: "Nineties", query: "90s Rock",
                  kind: "music", enabled: true, last_test: null }, _dialConfirm: "p1" }],
    ["creating", { _dialEdit: { id: null, label: "", query: "", kind: "music", enabled: true, last_test: null } }],
    ["stop asked", { _live: live(ON_AIR), _liveStopAsk: true }],
    ["name and options open", { _stNameOpen: true, _annOpen: true, _stAdvOpen: true }],
  ];
  for (const catalog of [false, true]) {
    for (const [label, seed] of states) {
      const el = mount({ seed, catalog, answers: { "parlorwave_radio/station_live": NEVER,
        "parlorwave_radio/station_dial": NEVER, "parlorwave_radio/announcements": NEVER } });
      await settle();
      idsOnce(el, `${label}${catalog ? " (catalog)" : ""}`);
    }
  }
});

test("Station states the DJ and never switches it: no second DJ switch, doors to its owners", () => {
  let el = mount();
  assert.equal(qa(el, "#dj-switch").length, 0, "a DJ switch on Station");
  const dj = () => text(outer(el, '[aria-label="DJ breaks"]'));
  assert.match(dj(), /DJ breaks On · Smooth · Amy/);
  const djRow = outer(el, '[aria-label="DJ breaks"]');
  assert.match(djRow, /data-goto="booth"/);
  assert.doesNotMatch(djRow, /<input|<select|class="pill/, "the DJ row is a statement, not a control");
  el = mount({ over: { speech: "off" } });
  assert.match(dj(), /On · speech off · Smooth · Amy/);
  el = mount({ over: { dj: "off" } });
  assert.match(dj(), /Off · Smooth · Amy — switch it on with the left knob on On Air/);
  assert.match(outer(el, '[aria-label="DJ breaks"]'), /data-goto="onair"/);
  el = mount({ over: { dj: "unavailable" } });
  assert.match(dj(), /Unavailable/);
  assert.doesNotMatch(dj(), /left knob/);
  // the door is a jump within the panel
  el = mount();
  const door = within(el, '[aria-label="DJ breaks"]', "[data-goto]");
  assert.deepEqual(door.map((b) => b.dataset.goto), ["booth"]);
  press(door[0]);
  assert.equal(el._view, "booth");
});

test("the News row reads the readiness document already held, and reads nothing of the Newsroom's", async () => {
  let el = mount();
  assert.match(text(outer(el, '[aria-label="News bulletins"]')), /News bulletins Enabled/);
  assert.deepEqual(within(el, '[aria-label="News bulletins"]', "[data-goto]").map((b) => b.dataset.goto),
                   ["newsroom"]);
  const noNews = clone(READY); noNews.optional = noNews.optional.filter((o) => o.key !== "newsroom");
  el = mount({ seed: { _ready: { at: NOW, data: { readiness: noNews } } } });
  assert.match(text(outer(el, '[aria-label="News bulletins"]')), /Set up in the Newsroom/);
  el = mount({ seed: { _dial: null, _live: null, _announcements: null, _stationSettings: null, _ready: null } });
  await settle(); await settle();
  assert.deepEqual(ws(el).filter((c) => /news/.test(c.ws)), [], "Station polled the Newsroom");
});

// ===========================================================================
// 2. THE PLATE
// ===========================================================================
test("the plate is the station's on-air name, drawn as a picture of it, and Edit opens the name sheet", () => {
  let el = mount({ over: { legacyStation: "Evening Chill" } });
  const plate = byId(el, "station-deck-plate");
  assert.ok(plate, "no plate");
  assert.equal(plate.getAttribute("role"), "img");
  assert.equal(plate.getAttribute("aria-label"), "QPRW FM", "the plate is not the on-air identity");
  assert.ok(q(el, ".deck-emblem"), "the approved emblem is missing");
  assert.equal(qa(el, ".console-badge").length + qa(el, "#console-badge").length, 0,
               "the console's own badge (and its handlers) on Station");
  // without the published name, the stored one; never the legacy station sensor
  el = mount({ over: { legacyStation: "Evening Chill", djAttrs: { station_name: "" } },
               seed: { _stationSettings: { identity: { name: "KXRP Night" } } } });
  assert.equal(byId(el, "station-deck-plate").getAttribute("aria-label"), "KXRP Night");
  assert.equal(byId(el, "station-name-input"), null, "the name sheet is open by itself");
  const edit = byId(el, "station-name-edit");
  assert.equal(edit.textContent, "Edit Station Name", "the button says what it edits");
  assert.equal(edit.getAttribute("aria-expanded"), "false");
  press(edit);
  assert.ok(q(el, '[aria-label="Station identity"]'), "Edit did not open the name sheet");
  assert.equal(byId(el, "station-name-edit").getAttribute("aria-expanded"), "true");
  assert.equal(within(el, ".station-desk", "#station-name-input").length, 1, "the name sheet is not under the plate");
});

// ===========================================================================
// 3. THE HOUSE LINE: what Music Assistant is doing, from the observer only
// ===========================================================================
test("Following names the selected speaker and its song, only while the observer watches that speaker", () => {
  let el = mount();
  assert.equal(houseLine(el), "Following Music Assistant on Den · The Lanterns — Northern Line");
  const dot = q(el, ".st-dot");
  assert.ok(dot.classList.contains("live"), "the following dot is not the live (amber) one");
  assert.equal(dot.getAttribute("aria-hidden"), "true");
  el = mount({ over: { player: "paused" } });
  assert.match(houseLine(el), /on Den · The Lanterns — Northern Line/);
  el = mount({ over: { player: "idle" } });
  assert.equal(houseLine(el), "Following Music Assistant on Den", "a song is named while nothing plays");
});

test("another session's queue is never named as the selected speaker, nor given its song", () => {
  const away = { djAttrs: { observer: { running: true, queue_id: PATIO } } };
  let el = mount({ over: away });
  assert.equal(houseLine(el), "Following Music Assistant on a DJ-enabled speaker");
  // the speaker list, once read, names it -- still without a song
  el = mount({ over: away, seed: { _liveTargets: live(TARGETS) } });
  assert.equal(houseLine(el), "Following Music Assistant on Patio");
  // an id the list does not know is never shown raw
  el = mount({ over: { djAttrs: { observer: { running: true, queue_id: "ma_queue_7f3a" } } },
               seed: { _liveTargets: live(TARGETS) } });
  assert.equal(houseLine(el), "Following Music Assistant on a DJ-enabled speaker");
  assert.doesNotMatch(page(el).replace(/="[^"]*"/g, ""), /ma_queue_7f3a|media_player\./, "a raw id is on the screen");
});

test("the house line's other states: watching, not following, no health yet, no speaker", () => {
  let el = mount({ over: { djAttrs: { observer: { running: true, queue_id: null } } } });
  assert.equal(houseLine(el), "Watching for playback · Nothing is playing on a DJ-enabled speaker yet. "
    + "Start an album, playlist, station, or queue in Music Assistant.");
  assert.ok(q(el, ".st-dot").classList.contains("idle"));
  el = mount({ over: { djAttrs: { observer: { running: false, queue_id: DEN } } } });
  assert.equal(houseLine(el), "Not following playback · Music Assistant playback is not being observed right now");
  el = mount({ over: { djAttrs: { observer: undefined } } });
  assert.equal(q(el, ".st-truth"), null, "a house line before the first health answer");
  el = mount({ over: { djAttrs: { outputs_enabled: [] } } });
  assert.match(houseLine(el), /No DJ-enabled speaker yet\. Choose one in Settings/);
  assert.deepEqual(within(el, ".st-truth", "[data-goto]").map((b) => b.dataset.goto), ["settings"]);
  // the house line is the house's truth: a station on the air elsewhere never moves it
  el = mount({ seed: { _live: live(ON_AIR) } });
  assert.equal(houseLine(el), "Following Music Assistant on Den · The Lanterns — Northern Line");
  assert.doesNotMatch(houseLine(el), /Kitchen|Nineties|On air/);
});

// ===========================================================================
// 4. THE ON-AIR LINE: red only for a station on the air now
// ===========================================================================
test("the on-air line tells every state of its read, and is red only on the air", async () => {
  const cases = [
    ["not read yet", null, /Reading the on-air station…/],
    ["loading", { loading: true }, /Reading the on-air station…/],
    ["failed", { at: NOW, data: null, error: true }, /could not be read right now\. Nothing has changed; try again in a moment\./],
    ["failed, older answer kept", live(ON_AIR, { error: true }), /could not be read right now/],
    ["unknown", live(UNKNOWN), /could not be read right now/],
    ["starting", live(STARTING), /^Starting Nineties on Kitchen Starting: the songs were sent and are being confirmed\. Nothing will be sent twice\./],
    ["off", live(OFF), /^No Dial Station running · last: “Nineties” on Kitchen, stopped \S+/],
    ["on air", live(ON_AIR), /^On air Nineties on Kitchen · since \S+/],
  ];
  for (const [label, l, want] of cases) {
    const el = mount({ seed: { _live: l }, answers: { "parlorwave_radio/station_live": NEVER } });
    await settle();
    const line = airLine(el);
    assert.match(line, /aria-label="On-air station"/, label);
    assert.match(text(line), want, label);
    const onAir = label === "on air";
    assert.equal(/air-line on\b/.test(line), onAir, `${label}: red is for a station on the air now`);
    assert.equal(/\bOn air\b/.test(text(line)), onAir, `${label}: says On air`);
    if (!["off"].includes(label)) assert.doesNotMatch(text(line), /No Dial Station running/, `${label}: not known to be off`);
    if (label === "starting") {
      assert.match(line, /air-line starting/);
      assert.ok(byId(el, "air-open").disabled && byId(el, "air-stop").disabled, "Change/Stop while starting");
    }
    if (["off", "not read yet", "loading", "failed", "failed, older answer kept", "unknown"].includes(label)) {
      assert.equal(byId(el, "air-open"), null, `${label}: an entry button on the line`);
      assert.equal(byId(el, "air-stop"), null, `${label}: a Stop with nothing known on air`);
    }
    for (const lamp of qa(el, ".air-lamp")) assert.equal(lamp.getAttribute("aria-hidden"), "true");
  }
});

test("on the air the line keeps its facts: kind, term, runway, refill and where it was started", () => {
  let el = mount({ seed: { _live: live(ON_AIR) } });
  const t = text(airLine(el));
  assert.match(t, /Genre station · “90s Rock” · 14 station songs queued · last refill .+ added 12 songs · started from the Dial/);
  assert.ok(!byId(el, "air-open").disabled && !byId(el, "air-stop").disabled);
  const one = clone(ON_AIR); one.station.runway.owned = 1; one.station.refill.last.appended = 1;
  one.station.origin = "station_tab";
  el = mount({ seed: { _live: live(one) } });
  assert.match(text(airLine(el)), /1 station song queued · last refill .* added 1 song · started from the Station tab/);
  const sick = clone(ON_AIR); sick.station.problem = "target_not_isolated";
  el = mount({ seed: { _live: live(sick) } });
  assert.match(text(airLine(el)), /The speaker is now part of a group \(or unavailable\)/);
  assert.doesNotMatch(text(airLine(el)), /target_not_isolated/);
});

test("Stop asks first; Keep it on keeps it; Stop it sends the command and nothing else", async () => {
  const el = mount({ seed: { _live: live(ON_AIR) } });
  press(byId(el, "air-stop"));
  assert.equal(el._liveStopAsk, true);
  assert.match(text(airLine(el)), /Stop programming Kitchen\? Nothing more will be added\. What is already queued keeps playing\./);
  assert.equal(ws(el, "station_live_stop").length, 0, "the first press stopped it");
  press(byId(el, "air-stop-keep"));
  assert.equal(el._liveStopAsk, false);
  press(byId(el, "air-stop"));
  press(byId(el, "air-stop-confirm"));
  const stops = ws(el, "station_live_stop");
  assert.equal(stops.length, 1);
  assert.deepEqual(payload(stops[0]), {}, "Stop carries a payload");
  assert.deepEqual(svc(el), [], "a stop is never a service call");
  await settle(); await settle();
  assert.ok(ws(el, "station_live").length >= 1, "the station was not re-read after the stop");
});

test("Change opens the choose sheet on the first station fit to go live, on the station's own speaker", () => {
  const el = mount({ seed: { _live: live(ON_AIR) } });
  press(byId(el, "air-open"));
  assert.equal(el._liveForm.preset_id, "p2", "not the first viable station that is not on the air");
  assert.equal(el._liveForm.target, KITCHEN);
  assert.match(sheet(el), /aria-label="Change the on-air station"/);
  assert.ok(byId(el, "air-open").disabled, "Change stays pressable while its sheet is open");
});

// ===========================================================================
// 5. THE TILES: one caption each, and lit only for the station on the air
// ===========================================================================
test("each tile says one thing about its station, and only the station on the air is lit", () => {
  const el = mount({ seed: { _live: live(ON_AIR) } });
  const cap = (id) => text(tile(el, id).outerHTML);
  assert.equal(cap("p1"), "Nineties 90s Rock On air · Kitchen");
  assert.equal(cap("p2"), "Night Crossing night crossing Tested · 25 tracks · 6 artists");
  assert.equal(cap("p3"), "Saturday Rock classic rock 70s Needs retest");
  assert.equal(cap("p4"), "Late Night Jazz jazz Too thin to go live · 4 tracks · 1 artist");
  assert.equal(cap("p5"), "Sunday Soul soul 60s Off the Dial");
  assert.equal(cap("p6"), "Morning Mix indie pop Not tested yet");
  assert.match(cap("p7"), /^All News .*Not in this release$/);
  assert.deepEqual(qa(el, "[data-dial-pick]").filter((b) => b.classList.contains("onair"))
    .map((b) => b.dataset.dialPick), ["p1"], "lit tiles");
  assert.ok(tile(el, "p4").classList.contains("weak"));
  assert.ok(tile(el, "p5").classList.contains("off"));
  for (const b of qa(el, "[data-dial-pick]")) {
    assert.equal((b.outerHTML.match(/class="preset-state/g) || []).length, 1, `${b.dataset.dialPick}: one caption`);
    assert.equal((b.outerHTML.match(/Too thin to go live/g) || []).length, b.dataset.dialPick === "p4" ? 1 : 0);
    assert.ok(!b.disabled, `${b.dataset.dialPick} cannot be pressed`);
  }
  const stale = "Needs retest: the station builder or term has changed since it was tested";
  assert.equal(tile(el, "p3").getAttribute("title"), stale);
  assert.ok(tile(el, "p3").getAttribute("aria-label").includes(stale));
  assert.match(tile(el, "p3").outerHTML, />Needs retest</);
  assert.match(tile(el, "p1").outerHTML, /<span class="preset-lamp" aria-hidden="true">/);
  assert.equal(tile(el, "p1").getAttribute("aria-label"), "Nineties, 90s Rock, on the air on Kitchen");
  const add = byId(el, "dial-add");
  assert.ok(add && !add.disabled && add.getAttribute("aria-label") === "New station");
});

test("lit only by identity: the same preset retuned since its station started is not on the air", () => {
  const retuned = clone(DIAL);
  retuned.presets[0].query = "80s Rock"; retuned.identities.p1 = "music|80s rock|0";
  let el = mount({ seed: { _live: live(ON_AIR), _dial: live(retuned) } });
  assert.equal(qa(el, ".onair").length, 0, "a retuned preset reads as the station on the air");
  assert.match(text(airLine(el)), /^On air Nineties on Kitchen/, "the line still says what IS on the air");
  // re-approved on another draw: another identity, the same term
  const redrawn = clone(DIAL); redrawn.identities.p1 = "music|90s rock|1";
  el = mount({ seed: { _live: live(ON_AIR), _dial: live(redrawn) } });
  assert.equal(qa(el, ".onair").length, 0, "a re-approved draw reads as the station on the air");
});

test("a Request Line station lights no tile, even one with the very same term", () => {
  const el = mount({ seed: { _live: live(RL_ON_AIR) } });
  assert.match(text(airLine(el)), /^On air 90s Rock on Kitchen .*started from the Request Line/);
  assert.equal(qa(el, ".onair").length, 0);
  assert.doesNotMatch(outer(el, ".dial-tiles"), RED);
});

test("an answer that failed or is out of date lights nothing, even one that said on air", () => {
  for (const l of [live(ON_AIR, { error: true }), live(UNKNOWN), { loading: true }]) {
    const el = mount({ seed: { _live: l }, answers: { "parlorwave_radio/station_live": NEVER } });
    assert.doesNotMatch(page(el), RED);
    assert.equal(qa(el, ".onair").length, 0);
  }
  const el = mount({ seed: { _live: live(STARTING) } });
  assert.equal(qa(el, ".onair").length, 0, "a starting station is lit");
  assert.doesNotMatch(page(el), RED);
});

test("every name a person typed or the backend sent is shown as text, never as markup", async () => {
  const d = clone(DIAL);
  d.presets[1].label = 'Night <b id="x1">Crossing</b>';
  d.presets[1].query = 'night & "crossing"';
  const l = clone(ON_AIR);
  l.station.target.name = 'Kitchen <i id="x2">two</i>';
  l.station.query = '90s <u id="x3">Rock</u>';
  const el = mount({ seed: { _dial: live(d), _live: live(l) }, over: { title: 'Northern <em id="x4">Line</em>' } });
  press(tile(el, "p2")); await settle();
  for (const id of ["x1", "x2", "x3", "x4"]) assert.equal(byId(el, id), null, `markup from data became an element: #${id}`);
  assert.equal(text(tile(el, "p2").outerHTML).split(" Tested")[0], 'Night <b id="x1">Crossing</b> night & "crossing"');
  assert.match(houseLine(el), /Northern <em id="x4">Line<\/em>/);
  assert.match(text(airLine(el)), /On air Nineties on Kitchen <i id="x2">two<\/i>/);
  assert.match(text(sheet(el)), /^Night <b id="x1">Crossing<\/b> Selected · not on the air/);
});

// ===========================================================================
// 6. THE CHOOSE SHEET: selecting is not airing; two presses go on air
// ===========================================================================
test("off the air a tile press selects it: white ring, 'Selected · not on the air', nothing red, no speaker chosen", async () => {
  const el = mount();
  press(tile(el, "p2"));
  assert.deepEqual(el._liveForm, { preset_id: "p2", target: "", confirm: false });
  assert.equal(ws(el, "station_live_targets").length, 1, "the speakers were not read");
  await settle();
  const t = tile(el, "p2");
  assert.ok(t.classList.contains("picked"), "the selected tile wears no ring");
  assert.ok(!t.classList.contains("onair"), "the selected tile is lit as on the air");
  assert.equal(t.getAttribute("aria-expanded"), "true");
  assert.doesNotMatch(page(el), RED, "something reads as on the air");
  assert.match(text(sheet(el)), /^Night Crossing Selected · not on the air Edit/);
  assert.match(sheet(el), /aria-label="Start a station"/);
  assert.match(text(sheet(el)), /Tested · 25 tracks · 6 artists · passes the live-station rules/);
  const sel = byId(el, "air-target");
  assert.ok(sel, "no speaker list");
  assert.equal(sel.value, "", "a speaker was chosen for the person");
  assert.equal(sel.options[0].textContent, "Choose a speaker…");
  assert.ok(byId(el, "air-go").disabled, "Start is pressable before a speaker is chosen");
  assert.equal(within(el, ".station-desk", ".air-form").length, 1, "the sheet is not in the Dial stage");
  assert.ok(q(el, ".air-form")._at > q(el, ".dial-tiles")._at, "the sheet is not under the tiles");
});

test("the speaker list: single speakers offered; the house speaker and a group shown, disabled, with the backend's words", async () => {
  const el = mount();
  press(tile(el, "p2")); await settle();
  const sel = byId(el, "air-target");
  const offered = sel.options.filter((o) => !("disabled" in o.attrs) && o.value).map((o) => o.value);
  assert.deepEqual(offered, [KITCHEN, PATIO]);
  const refused = Object.fromEntries(sel.options.filter((o) => "disabled" in o.attrs).map((o) => [o.value, o.textContent]));
  assert.deepEqual(refused, { [DEN]: "Den — That is the house DJ speaker.",
                              [WHOLE]: "Loft group — That output is a speaker group." });
  assert.ok(!sel.options.some((o) => o.value === GARAGE), "an unrelated unavailable player is listed");
  assert.throws(() => choose(sel, WHOLE), /disabled option/);
  assert.match(text(sheet(el)), /A station plays on one speaker\. The house speaker can take one by handover: you see what it takes over before anything changes\. Speaker groups cannot take a station yet\./);
});

test("two presses start the station, and the wire carries exactly the station and the speaker", async () => {
  const el = mount();
  press(tile(el, "p2")); await settle();
  choose(byId(el, "air-target"), KITCHEN);
  assert.equal(el._liveForm.target, KITCHEN);
  press(byId(el, "air-go"));
  assert.equal(el._liveForm.confirm, true, "the first press did not ask");
  assert.equal(ws(el, "station_live_start").length, 0, "the first press started it");
  assert.match(text(sheet(el)), /This changes Kitchen's queue: .* Music Assistant's Autoplay is switched off for that speaker\./);
  assert.match(sheet(el), /<button id="air-confirm" >Go on air<\/button>/);
  press(byId(el, "air-back"));
  assert.equal(el._liveForm.confirm, false);
  assert.equal(ws(el, "station_live_start").length, 0);
  press(byId(el, "air-go"));
  press(byId(el, "air-confirm"));
  const starts = ws(el, "station_live_start");
  assert.equal(starts.length, 1);
  assert.deepEqual(payload(starts[0]), { target: KITCHEN, preset_id: "p2" });
  assert.deepEqual(svc(el), [], "a station start is never a service call");
  await settle(); await settle();
  assert.equal(el._liveForm, null, "the sheet outlived the start");
  assert.ok(ws(el, "station_live").length >= 1, "the station was not re-read after the start");
});

test("on the air a tile press is a switch, on the station's own speaker", async () => {
  const el = mount({ seed: { _live: live(ON_AIR) } });
  press(tile(el, "p2")); await settle();
  assert.equal(el._liveForm.target, KITCHEN, "a switch moved the speaker");
  assert.match(sheet(el), /aria-label="Change the on-air station"/);
  assert.match(text(sheet(el)), /On Kitchen \(a station changes where it is playing only by stopping it first\)\./);
  assert.equal(byId(el, "air-target"), null, "a switch offered another speaker");
  assert.match(text(sheet(el)), /^Night Crossing Selected · not on the air/);
  assert.doesNotMatch(sheet(el), /sheet-chip lit/, "the selected station's sheet is lit as on the air");
  assert.match(sheet(el), /<button id="air-go"[^>]*>Switch station<\/button>/);
  assert.ok(tile(el, "p1").classList.contains("onair") && !tile(el, "p1").classList.contains("picked"));
  assert.ok(tile(el, "p2").classList.contains("picked") && !tile(el, "p2").classList.contains("onair"));
  press(byId(el, "air-go"));
  assert.match(text(sheet(el)), /This replaces the current station's queued songs on Kitchen/);
  press(byId(el, "air-confirm"));
  assert.deepEqual(ws(el, "station_live_start").map(payload), [{ target: KITCHEN, preset_id: "p2" }]);
});

test("the lit tile opens its editor, never a second offer of itself", () => {
  const el = mount({ seed: { _live: live(ON_AIR) } });
  press(tile(el, "p1"));
  assert.equal(el._liveForm, null);
  assert.equal(el._dialEdit && el._dialEdit.id, "p1");
  assert.equal(q(el, ".air-form"), null, "a choose sheet for the station already on the air");
  assert.match(editor(el), /aria-label="Edit Dial station"/);
  assert.match(text(editor(el)), /^Nineties On air/);
  assert.match(editor(el), /class="sheet-chip lit"/);
  assert.equal(ws(el, "station_live_start").length, 0);
});

test("a thin station offers no start; All News offers nothing but Edit; neither is lit", async () => {
  const el = mount();
  press(tile(el, "p4")); await settle();
  assert.match(text(sheet(el)), /Too thin to go live · 4 tracks · 1 artist Test a broader term in Edit, or choose another station\./);
  for (const id of ["air-go", "air-target", "air-confirm"]) assert.equal(byId(el, id), null, `a thin station offers ${id}`);
  assert.ok(byId(el, "air-edit") && byId(el, "air-cancel"));
  press(tile(el, "p7")); await settle();
  assert.match(text(sheet(el)), /All News stations are not in this release\./);
  for (const id of ["air-go", "air-target", "air-confirm"]) assert.equal(byId(el, id), null, `All News offers ${id}`);
  assert.doesNotMatch(page(el), RED);
});

test("a stale, an untested and an off-the-Dial station may start from here, and say what they are", async () => {
  for (const [id, words] of [["p3", /Needs retest — the station builder or term has changed since it was tested\./],
                             ["p6", /Not tested yet\./], ["p5", /Not tested yet\./]]) {
    const el = mount();
    press(tile(el, id)); await settle();
    assert.match(text(sheet(el)), words, id);
    assert.doesNotMatch(text(sheet(el)), /passes the live-station rules|Too thin/, id);
    choose(byId(el, "air-target"), PATIO);
    press(byId(el, "air-go"));
    press(byId(el, "air-confirm"));
    assert.deepEqual(ws(el, "station_live_start").map(payload), [{ target: PATIO, preset_id: id }]);
  }
});

test("another tile re-aims the open sheet and keeps the person's speaker; the same tile closes it; Edit hands over", async () => {
  const el = mount();
  press(tile(el, "p2")); await settle();
  choose(byId(el, "air-target"), PATIO);
  const reads = ws(el, "station_live_targets").length;
  press(tile(el, "p6"));
  assert.equal(el._liveForm.preset_id, "p6");
  assert.equal(el._liveForm.target, PATIO, "re-aiming dropped the chosen speaker");
  assert.equal(ws(el, "station_live_targets").length, reads, "re-aiming read the speakers again");
  press(tile(el, "p6"));
  assert.equal(el._liveForm, null, "the same tile did not close its sheet");
  press(tile(el, "p2"));
  press(byId(el, "air-edit"));
  assert.equal(el._liveForm, null);
  assert.equal(el._dialEdit.id, "p2");
  assert.match(editor(el), /aria-label="Edit Dial station"/);
  assert.doesNotMatch(editor(el), /sheet-chip lit/, "a station off the air wears the On air chip");
  press(byId(el, "dial-cancel"));
  assert.equal(el._dialEdit, null);
  press(tile(el, "p2"));
  press(byId(el, "air-cancel"));
  assert.equal(el._liveForm, null);
  assert.equal(ws(el, "station_live_start").length, 0);
});

test("while the on-air state is unknown the sheet offers no start", async () => {
  for (const l of [live(OFF, { error: true }), live(UNKNOWN), { loading: true }]) {
    const el = mount({ seed: { _live: l }, answers: { "parlorwave_radio/station_live": NEVER } });
    press(tile(el, "p2")); await settle();
    assert.ok(q(el, ".air-form"), "no sheet for the pressed tile");
    for (const id of ["air-go", "air-target", "air-confirm"]) assert.equal(byId(el, id), null, `unknown state offers ${id}`);
    assert.match(text(sheet(el)), /Reading the on-air station…|so a station cannot start here yet/);
  }
});

test("while a Start Radio station runs no station can be started here, as the screen says", async () => {
  const legacy = Object.assign(clone(OFF), { legacy_station_active: true });
  const el = mount({ seed: { _live: live(legacy) } });
  assert.match(text(airLine(el)), /A Start Radio station is running, so a station cannot start here until it ends\./);
  const t = tile(el, "p2");
  if (!t.disabled) { press(t); await settle(); }
  for (const id of ["air-go", "air-confirm"]) {
    assert.ok(!byId(el, id), `the screen says no station can start here, yet it offers ${id}`);
  }
  assert.equal(ws(el, "station_live_start").length, 0);
});

test("while a station is starting no tile offers a second start", async () => {
  const el = mount({ seed: { _live: live(STARTING) } });
  for (const id of ["p2", "p1"]) {
    const t = tile(el, id);
    if (!t.disabled) { press(t); await settle(); }
    for (const b of ["air-go", "air-confirm"]) {
      assert.ok(!byId(el, b), `${id}: a start is offered while "Nothing will be sent twice" is being confirmed`);
    }
    if (el._liveForm) press(byId(el, "air-cancel"));
    if (el._dialEdit) press(byId(el, "dial-cancel"));
  }
});

// ===========================================================================
// 7. THE REQUEST LINE: its own card, one start flow at a time
// ===========================================================================
test("the Request Line is its own card under the stage, and its start is the one it always sent", async () => {
  const el = mount();
  const card = outer(el, ".rl-card");
  assert.match(card, /aria-label="Request Line"/);
  assert.match(card, /<button id="rl-go" >Start station<\/button>/);
  assert.match(text(card), /This starts a station\./);
  assert.doesNotMatch(text(card), /it does not queue a single song/);
  assert.equal(within(el, ".station-desk", "#rl-text").length, 0, "the Request Line is inside the Dial stage");
  assert.equal(within(el, ".rl-card", "#rl-text").length, 1);
  type(byId(el, "rl-text"), "  Night   Drive ");
  press(byId(el, "rl-go"));
  assert.equal(el._reqLine.confirm, true);
  assert.equal(ws(el, "station_live_start").length, 0, "the first press started it");
  await settle();
  const sel = byId(el, "rl-target");
  assert.deepEqual(sel.options.filter((o) => o.value).map((o) => o.value), [KITCHEN, PATIO],
                   "the Request Line offers a speaker that cannot take a station");
  assert.equal(sel.value, KITCHEN, "the last station's speaker is not offered first");
  press(byId(el, "rl-confirm"));
  assert.deepEqual(ws(el, "station_live_start").map(payload), [{ target: KITCHEN,
    intent: { kind: "music", origin: "request_line", label: "Night Drive", query: "Night Drive" } }]);
});

test("the Request Line waits, visibly, while the choose sheet is open or a stop is asked", () => {
  let el = mount();
  assert.ok(!byId(el, "rl-text").disabled && !byId(el, "rl-go").disabled);
  press(tile(el, "p2"));
  assert.ok(byId(el, "rl-text").disabled, "the box takes a second start while the sheet is open");
  assert.ok(byId(el, "rl-go").disabled, "Start station is pressable while the sheet is open");
  assert.match(text(outer(el, ".rl-card")), /Finish or cancel the station change above first\./);
  press(byId(el, "air-cancel"));
  assert.ok(!byId(el, "rl-go").disabled, "the Request Line stays blocked after the sheet closed");
  el = mount({ seed: { _live: live(ON_AIR) } });
  press(byId(el, "air-stop"));
  assert.ok(byId(el, "rl-go").disabled && byId(el, "rl-text").disabled, "a start while a stop is asked");
  press(byId(el, "air-stop-keep"));
  assert.ok(!byId(el, "rl-go").disabled);
});

test("the Request Line says it is unavailable while the on-air state is unknown", async () => {
  for (const l of [{ loading: true }, live(OFF, { error: true }), live(UNKNOWN)]) {
    const el = mount({ seed: { _live: l }, answers: { "parlorwave_radio/station_live": NEVER } });
    await settle();
    assert.equal(byId(el, "rl-text"), null, "a Request Line box with the on-air state unknown");
    assert.match(text(outer(el, ".rl-card")), /The Request Line is unavailable until the on-air station can be read\./);
  }
});

// ===========================================================================
// 8. CREATE, EDIT, REMOVE: setup only, one sheet at a time
// ===========================================================================
test("New station opens an empty sheet in place of the choose sheet, and saves a new preset without an id", async () => {
  const el = mount();
  press(tile(el, "p2"));
  press(byId(el, "dial-add"));
  assert.equal(el._liveForm, null, "the choose sheet stayed open beside the new one");
  assert.deepEqual(el._dialEdit, { id: null, label: "", query: "", kind: "music", enabled: true, last_test: null });
  assert.match(editor(el), /aria-label="New Dial station"/);
  assert.ok(byId(el, "dial-add").classList.contains("picked"));
  assert.ok(byId(el, "dial-test").disabled, "Test Station with no term");
  for (const b of qa(el, "[data-dial-pick]")) assert.ok(b.disabled, `${b.dataset.dialPick} pressable while creating`);
  assert.match(editor(el), /<option value="news" disabled>All News — not in this release<\/option>/);
  type(byId(el, "dial-label"), "Garage Rock");
  type(byId(el, "dial-query"), "garage rock");
  assert.ok(!byId(el, "dial-test").disabled, "a term did not enable Test Station");
  press(byId(el, "dial-save"));
  const saves = ws(el, "station_dial_save");
  assert.equal(saves.length, 1);
  const sent = saves[0].msg.presets;
  assert.deepEqual(sent.slice(0, 7).map((p) => p.id), PRESETS.map((p) => p.id), "the saved list lost its order or ids");
  assert.deepEqual(sent[7], { label: "Garage Rock", kind: "music", enabled: true, query: "garage rock" });
  assert.equal(ws(el, "station_live_start").length, 0);
  await settle(); await settle();
  assert.equal(el._dialEdit, null, "the sheet outlived the save");
  press(byId(el, "dial-add"));
  assert.ok(el._dialEdit);
  press(byId(el, "dial-add"));
  assert.equal(el._dialEdit, null, "New station again does not close its own sheet");
});

test("an edit keeps the preset's id and place; a retune without a test keeps its old record", async () => {
  let el = mount();
  press(tile(el, "p2")); press(byId(el, "air-edit"));
  type(byId(el, "dial-label"), "Quarry Light");
  press(byId(el, "dial-save"));
  let sent = ws(el, "station_dial_save")[0].msg.presets;
  assert.deepEqual(sent.map((p) => p.id), PRESETS.map((p) => p.id));
  assert.deepEqual(sent[1], { id: "p2", label: "Quarry Light", kind: "music", enabled: true,
                              query: "night crossing", last_test: PRESETS[1].last_test });
  el = mount();
  press(tile(el, "p2")); press(byId(el, "air-edit"));
  type(byId(el, "dial-query"), "quarry light");
  const box = byId(el, "dial-enabled"); box.checked = false; fire(box, "change");
  press(byId(el, "dial-save"));
  sent = ws(el, "station_dial_save")[0].msg.presets;
  assert.equal(sent[1].query, "quarry light");
  assert.equal(sent[1].enabled, false);
  assert.deepEqual(sent[1].last_test, PRESETS[1].last_test, "a retune lost the record that makes it read Needs retest");
});

test("Test Station from the sheet is a dry run of the term, and says so", async () => {
  const el = mount({ answers: { "parlorwave_radio/station_preview": { ok: true, status: "ok",
    summary: { total_tracks: 25, unique_artists: 11, category_matches: 25 },
    resolution: { strategy: "genre", genres: [{ name: "Rock" }], notes: [] }, live: { viable: true, reasons: [] },
    quality: [], tracks: [{ artist: "The Lanterns", title: "Northern Line", album: "Lamps", year: 1994 }],
    last_test: test_("garage rock", 25, 11, true) } } });
  press(byId(el, "dial-add"));
  type(byId(el, "dial-label"), "Garage Rock");
  type(byId(el, "dial-query"), "garage rock");
  press(byId(el, "dial-test"));
  assert.deepEqual(ws(el, "station_preview").map(payload), [{ intent: { origin: "station_tab", kind: "music",
    label: "Garage Rock", query: "garage rock" }, count: 25, variant: 0 }]);
  await settle(); await settle();
  assert.match(text(editor(el)), /Preview — not on air/);
  assert.match(text(editor(el)), /Nothing plays and nothing in the queue changes\./);
  assert.equal(ws(el, "station_live_start").length + svc(el).length, 0);
});

test("Remove asks first: Keep keeps it, Remove it saves the list without it", () => {
  const el = mount();
  press(tile(el, "p5")); press(byId(el, "air-edit"));
  assert.equal(q(el, "[data-dial-remove]"), null, "Remove did not ask first");
  press(q(el, '[data-dial-ask="p5"]'));
  assert.equal(el._dialConfirm, "p5");
  press(byId(el, "dial-remove-cancel"));
  assert.equal(el._dialConfirm, null);
  assert.equal(ws(el, "station_dial_save").length, 0);
  press(q(el, '[data-dial-ask="p5"]'));
  press(q(el, '[data-dial-remove="p5"]'));
  const saves = ws(el, "station_dial_save");
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0].msg.presets.map((p) => p.id), ["p1", "p2", "p3", "p4", "p6", "p7"]);
});

test("while a station is being edited every other tile waits, and New station waits", () => {
  const el = mount({ seed: { _live: live(ON_AIR) } });
  press(tile(el, "p1"));
  for (const b of qa(el, "[data-dial-pick]")) {
    assert.equal(b.disabled, b.dataset.dialPick !== "p1", `${b.dataset.dialPick} while p1 is being edited`);
  }
  assert.ok(byId(el, "dial-add").disabled, "New station would throw the edit away");
  assert.ok(byId(el, "air-open").disabled, "Change would open a second sheet");
  press(tile(el, "p1"));
  assert.equal(el._dialEdit, null, "the edited tile does not close its sheet");
});

test("New station waits at the Dial's limit and while the list is unread", () => {
  const full = clone(DIAL); full.max_presets = PRESETS.length;
  for (const d of [live(full), { at: NOW, data: null, error: true }, { loading: true }]) {
    const el = mount({ seed: { _dial: d }, answers: { "parlorwave_radio/station_dial": NEVER } });
    assert.ok(byId(el, "dial-add").disabled, "New station at the limit or over an unread list");
  }
});

// ===========================================================================
// 9. THE NAME SHEET
// ===========================================================================
test("the name sheet saves station.identity.name, refuses a bad name, and Done drops an unsaved draft", async () => {
  let stored = "QPRW FM";                       // the integration's station settings, as a store
  const el = mount({ answers: {
    "parlorwave_radio/station_save": (msg) => { stored = msg.station.identity.name; return { ok: true }; },
    "parlorwave_radio/station_settings": () => ({ ok: true, settings: { identity: { name: stored } } }) } });
  press(byId(el, "station-name-edit"));
  const input = () => byId(el, "station-name-input");
  assert.equal(input().getAttribute("maxlength"), "60");
  assert.equal(input().getAttribute("placeholder"), "ParlorWave Radio");
  type(input(), "Bad <name>");
  press(byId(el, "station-name-save"));
  assert.match(text(outer(el, ".name-sheet")), /Station name must not contain markup \(< or >\)\./);
  type(input(), "x".repeat(61));
  press(byId(el, "station-name-save"));
  assert.match(text(outer(el, ".name-sheet")), /at most 60 characters/);
  assert.equal(ws(el, "station_save").length, 0, "a bad name was sent");
  type(input(), "KXRP Night");
  press(byId(el, "station-name-save"));
  assert.deepEqual(ws(el, "station_save").map(payload), [{ station: { identity: { name: "KXRP Night" } } }]);
  await settle(); await settle();
  type(input(), "Half typed");
  assert.equal(el._stationDirty, true);
  press(byId(el, "station-name-done"));
  assert.equal(el._stNameOpen, false);
  assert.equal(el._stationDirty, false, "Done left an unsaved draft behind");
  assert.equal(el._stationDraft, "KXRP Night", "Done did not put the stored name back");
  assert.equal(input(), null, "Done did not close the sheet");
  assert.equal(ws(el, "station_save").length, 1, "Done saved the draft");
  // Reset is its own button and keeps the sheet open; Edit again closes it as Done does
  press(byId(el, "station-name-edit"));
  type(input(), "Another draft");
  press(byId(el, "station-name-reset"));
  assert.equal(el._stationDirty, false);
  assert.equal(input().value, "KXRP Night", "Reset did not put the stored name back");
  type(input(), "Yet another");
  press(byId(el, "station-name-edit"));
  assert.equal(input(), null, "Edit again did not close the sheet");
  assert.equal(el._stationDraft, "KXRP Night", "closing by Edit left the draft behind");
  assert.equal(ws(el, "station_save").length, 1);
  // an empty name is the house name
  press(byId(el, "station-name-edit"));
  type(input(), "   ");
  press(byId(el, "station-name-save"));
  assert.deepEqual(payload(ws(el, "station_save")[1]), { station: { identity: { name: "ParlorWave Radio" } } });
});

// ===========================================================================
// 10. ANNOUNCEMENTS: a row of Programming
// ===========================================================================
test("Announcements: the row's switch and Options write only their own key; a held state shows on the row", async () => {
  const held = Object.assign(clone(ANN), { store_problem: true, calendars_failed: ["calendar.porch"] });
  let el = mount({ seed: { _announcements: live(held) } });
  const row = () => text(outer(el, ".ann-row"));
  assert.match(row(), /Announcements Calendar entries that start with ANNOUNCE · watching home events · 1 coming up/);
  assert.match(row(), /nothing will air until it is repaired or restored/, "the held state is hidden behind Options");
  assert.match(row(), /Some calendars are unavailable/);
  el = mount();
  assert.equal(byId(el, "announce-smart"), null, "Options open by themselves");
  assert.equal(byId(el, "announce-options").getAttribute("aria-expanded"), "false");
  press(byId(el, "announce-options"));
  assert.equal(byId(el, "announce-options").getAttribute("aria-expanded"), "true");
  assert.match(row(), /Coming up .*Fish fry <tonight>/);
  assert.match(outer(el, ".ann-row"), /Fish fry &lt;tonight&gt;/, "a calendar entry was not escaped");
  assert.match(row(), /Last aired .*The bake sale starts now/);
  assert.match(row(), /Didn't air/);
  assert.match(row(), /Smart rewriting Experimental/);
  press(byId(el, "announce-enabled"));
  await settle(); await settle();
  press(byId(el, "announce-smart"));
  await settle(); await settle();
  choose(byId(el, "announce-late"), "60");
  await settle(); await settle();
  assert.deepEqual(ws(el, "station_save").map((c) => c.msg.station), [{ announcements: { enabled: false } },
    { announcements: { smart_rewriting: true } }, { announcements: { late_air_minutes: 60 } }]);
});

// ===========================================================================
// 11. ADVANCED: closed by default, and left as the person left it
// ===========================================================================
test("Advanced is closed by default and stays as the person left it across rebuilds", () => {
  const el = mount();
  assert.equal(q(el, ".st-adv").open, false, "Advanced opens by itself");
  const adv = q(el, ".st-adv");
  adv.open = true; fire(adv, "toggle");
  assert.equal(el._stAdvOpen, true);
  rerender(el);
  assert.equal(q(el, ".st-adv").open, true, "a rebuild closed Advanced");
  const again = q(el, ".st-adv");
  again.open = false; fire(again, "toggle");
  rerender(el);
  assert.equal(q(el, ".st-adv").open, false, "a rebuild reopened Advanced");
});

// ===========================================================================
// 12. ROBUSTNESS: every data shape a fetch can leave behind
// ===========================================================================
test("Station renders through the hass setter from every data shape a fetch can leave", async () => {
  const shapes = [
    { _dial: null, _live: null, _announcements: null, _stationSettings: null, _ready: null },
    { _dial: { loading: true }, _live: { loading: true }, _liveTargets: { loading: true },
      _announcements: { loading: true } },
    { _dial: live({ ok: true }), _live: live({ ok: true }), _liveTargets: live({ ok: true }),
      _announcements: live({ ok: true }), _stationSettings: {} },
    { _dial: { at: NOW, data: null, error: true }, _live: { at: NOW, data: null, error: true },
      _liveTargets: { at: NOW, data: null, error: true }, _announcements: { at: NOW, data: null, error: true } },
  ];
  for (const catalog of [false, true]) {
    for (const seed of shapes) {
      const el = mount({ seed, catalog, answers: { "parlorwave_radio/station_live": { ok: true },
        "parlorwave_radio/station_dial": { ok: true }, "parlorwave_radio/announcements": { ok: true },
        "parlorwave_radio/station_settings": { ok: true } } });
      await settle(); await settle();
      assert.match(page(el), /aria-label="The Dial"/);
      assert.match(page(el), /aria-label="On-air station"/);
      assert.doesNotMatch(page(el), RED);
      idsOnce(el, "robustness");
    }
  }
  assert.deepEqual(unhandled.map(String), [], "a render threw inside a fetch completion");
});

// ===========================================================================
// 12. QUESTIONS FOLLOW THE AIR, FOCUS FOLLOWS THE SHEETS
// ===========================================================================
const tracking = (fn) => async () => { TRACK.on = true; try { await fn(); } finally { TRACK.on = false; } };
const focused = (el) => root(el).activeElement;
const leave = (el) => { root(el).activeElement = null; rerender(el); };   // focus moves off the page
const airNow = (el, data) => { el.answer = data; return el._fetchLive(true).then(settle); };
function mountLive(data, extra = {}) {
  const el = mount(Object.assign({ seed: { _live: live(data) },
    answers: { "parlorwave_radio/station_live": () => el.answer } }, extra));
  el.answer = data;
  return el;
}
const ELSEWHERE = Object.assign(clone(ON_AIR), { station: Object.assign(clone(STATION), {
  station_id: "st-2", preset_id: "p6", label: "Morning Mix", query: "indie pop",
  identity: "music|indie pop|0", target: { queue_id: PATIO, name: "Patio" } }) });

test("a station that goes on the air elsewhere re-aims the open sheet and takes its question back", async () => {
  const el = mountLive(OFF);
  await airNow(el, OFF);
  press(tile(el, "p2")); await settle();
  choose(byId(el, "air-target"), PATIO);
  press(byId(el, "air-go"));
  assert.ok(byId(el, "air-confirm"), "the second press is not on the screen");
  await airNow(el, ON_AIR);                     // p1 goes on the air on Kitchen, from elsewhere
  assert.equal(byId(el, "air-confirm"), null, "the question asked about Patio outlived the change");
  assert.equal(el._liveForm.target, KITCHEN, "a switch would not go to the station's own speaker");
  assert.match(text(sheet(el)), /On Kitchen \(a station changes where it is playing only by stopping it first\)/);
  press(byId(el, "air-go"));
  assert.match(text(sheet(el)), /This replaces the current station's queued songs on Kitchen/);
  press(byId(el, "air-confirm"));
  assert.deepEqual(ws(el, "station_live_start").map(payload), [{ target: KITCHEN, preset_id: "p2" }],
                   "the confirm named one speaker and the start went to another");
});

test("a sheet opened with no speaker becomes a switch that can be pressed once a station is on the air", async () => {
  const el = mountLive(OFF);
  await airNow(el, OFF);
  press(tile(el, "p2")); await settle();
  await airNow(el, ON_AIR);
  assert.equal(el._liveForm.target, KITCHEN);
  assert.equal(byId(el, "air-go").disabled, false, "Switch station stayed disabled for good");
});

test("a station that stops leaves no speaker chosen, and a failed read never chooses one", async () => {
  const el = mountLive(ON_AIR);
  await airNow(el, ON_AIR);
  press(tile(el, "p2")); await settle();
  assert.equal(el._liveForm.target, KITCHEN);
  await airNow(el, OFF);
  assert.equal(el._liveForm.target, "", "the stopped station's speaker stayed chosen");
  assert.equal(byId(el, "air-target").value, "");
  assert.ok(byId(el, "air-go").disabled, "Start is offered with no speaker chosen");
  const el2 = mount({ seed: { _live: live(ON_AIR, { error: true }) },
                      answers: { "parlorwave_radio/station_live": NEVER } });
  press(tile(el2, "p2")); await settle();
  assert.equal(el2._liveForm.target, "", "an older answer kept by a failed read chose a speaker");
});

test("a Stop or Request Line question asked about one station is taken back when the air changes", async () => {
  const el = mountLive(ON_AIR);
  await airNow(el, ON_AIR);
  press(byId(el, "air-stop"));
  assert.ok(byId(el, "air-stop-confirm"));
  await airNow(el, ELSEWHERE);
  assert.equal(byId(el, "air-stop-confirm"), null, "a Stop asked about Kitchen stayed armed for Patio");
  await airNow(el, OFF);
  type(byId(el, "rl-text"), "Night Drive");
  press(byId(el, "rl-go")); await settle();
  assert.ok(byId(el, "rl-confirm"), "the Request Line did not ask");
  await airNow(el, ON_AIR);
  assert.equal(byId(el, "rl-confirm"), null, "an off-air question became a change of the station on air");
  assert.equal(ws(el, "station_live_start").length, 0);
  assert.equal(ws(el, "station_live_stop").length, 0);
});

test("the start sends only the question on the screen; its speaker is held while it is asked", async () => {
  const el = mount();
  press(tile(el, "p2")); await settle();
  choose(byId(el, "air-target"), KITCHEN);
  el._liveForm.confirm = false;
  await el._liveStart();
  assert.equal(ws(el, "station_live_start").length, 0, "a start went out with no question on the screen");
  press(byId(el, "air-go"));
  assert.ok(byId(el, "air-target").disabled, "the speaker can change under its own question");
  press(byId(el, "air-back"));
  assert.ok(!byId(el, "air-target").disabled, "Back did not free the speaker");
});

test("a speaker chosen while its list keeps focus enables the start at once; the Request Line names it", tracking(async () => {
  const el = mount();
  press(tile(el, "p2")); await settle();
  const sel = byId(el, "air-target");
  sel.focus();
  choose(sel, PATIO);
  assert.equal(byId(el, "air-target"), sel, "the page was rebuilt under a focused list");
  assert.equal(byId(el, "air-go").disabled, false, "Start waited for the list to lose focus");
  leave(el);
  assert.equal(byId(el, "air-go").disabled, false);
  press(byId(el, "air-cancel"));
  type(byId(el, "rl-text"), "Night Drive");
  press(byId(el, "rl-go")); await settle();
  assert.match(text(outer(el, ".rl-card")), /Start a “Night Drive” station on Kitchen\?/);
  const rs = byId(el, "rl-target");
  rs.focus();
  choose(rs, PATIO);
  assert.equal(byId(el, "rl-target"), rs, "the page was rebuilt under a focused list");
  assert.match(text(byId(el, "rl-say").innerHTML), /Start a “Night Drive” station on Patio\?/,
               "the question still names the speaker it no longer sends to");
  assert.equal(byId(el, "rl-confirm").disabled, false);
  leave(el);
  press(byId(el, "rl-confirm"));
  assert.equal(ws(el, "station_live_start")[0].msg.target, PATIO);
}));

test("while the on-air state is unknown the chip claims nothing; a Dial start in flight holds the sheet", async () => {
  const el = mount({ seed: { _live: live(ON_AIR, { error: true }) },
                     answers: { "parlorwave_radio/station_live": NEVER } });
  press(tile(el, "p2")); await settle();
  assert.match(text(sheet(el)), /^Night Crossing Selected Edit/);
  assert.doesNotMatch(text(sheet(el)), /not on the air/, "an unknown state was called off the air");
  assert.match(sheet(el), /aria-label="Start a station"/, "a stale answer named a switch");
  const el2 = mount();
  press(tile(el2, "p2")); await settle();
  choose(byId(el2, "air-target"), KITCHEN);
  press(byId(el2, "air-go"));
  el2._stationBusy = true; rerender(el2);
  assert.ok(byId(el2, "air-confirm").disabled, "Go on air is pressable while the Dial's start is with the backend");
  await el2._liveStart();
  assert.equal(ws(el2, "station_live_start").length, 0);
});

test("saving the station on the air never says nothing is playing it", async () => {
  const el = mount({ seed: { _live: live(ON_AIR) } });
  press(tile(el, "p1"));                          // the lit tile opens its editor
  type(byId(el, "dial-label"), "Nineties Gold");
  press(byId(el, "dial-save")); await settle(); await settle();
  assert.equal(el._notice.text, 'Saved "Nineties Gold" to the Dial.');
  press(tile(el, "p1"));
  type(byId(el, "dial-query"), "80s Rock");
  press(byId(el, "dial-save")); await settle(); await settle();
  assert.equal(el._notice.text, 'Saved "Nineties Gold" to the Dial. The station on the air keeps its old term until it is started again.');
  press(tile(el, "p2")); press(byId(el, "air-edit"));
  press(byId(el, "dial-save")); await settle(); await settle();
  assert.equal(el._notice.text, 'Saved "Night Crossing" to the Dial. Nothing is playing it yet.');
});

test("a tile that waits says why, in words beside it", () => {
  const el = mount();
  press(tile(el, "p2")); press(byId(el, "air-edit"));
  assert.match(text(page(el)), /Save or close this station to choose another\./);
  press(byId(el, "dial-cancel"));
  press(byId(el, "dial-add"));
  assert.match(text(page(el)), /Save or close the new station to choose another\./);
  press(byId(el, "dial-cancel"));
  assert.doesNotMatch(text(page(el)), /to choose another/);
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, label: `Station ${i}`,
    kind: "music", query: `term ${i}`, enabled: true }));
  const el2 = mount({ seed: { _dial: live(Object.assign(clone(DIAL), { presets: many })) } });
  assert.ok(byId(el2, "dial-add").disabled);
  assert.match(text(page(el2)), /The Dial holds 12 stations\. Remove one to add another\./);
});

test("focus goes into each sheet and question that opens, and back to what opened it", tracking(async () => {
  const el = mount();
  press(tile(el, "p2")); await settle();
  assert.equal(focused(el), q(el, ".air-form"), "the choose sheet opened without focus");
  press(byId(el, "air-cancel"));
  assert.equal(focused(el), tile(el, "p2"), "closing the sheet lost focus");
  press(tile(el, "p2")); await settle();
  choose(byId(el, "air-target"), KITCHEN);
  press(byId(el, "air-go"));
  assert.equal(focused(el).dataset.focus, "air-ask", "the question opened without focus");
  press(byId(el, "air-back"));
  assert.equal(focused(el), byId(el, "air-go"));
  tile(el, "p3").focus();
  rerender(el);
  assert.equal(focused(el), tile(el, "p3"), "an ordinary update dropped focus from a tile");
  press(byId(el, "station-name-edit"));
  assert.equal(focused(el), byId(el, "station-name-input"), "the name sheet opened without focus");
  root(el).activeElement = null;                  // the press on Done leaves the field first
  press(byId(el, "station-name-done"));
  assert.equal(focused(el), byId(el, "station-name-edit"));
  press(byId(el, "dial-add"));
  assert.equal(focused(el), byId(el, "dial-label"), "New station opened without focus");
  root(el).activeElement = null;
  press(byId(el, "dial-cancel"));
  assert.equal(focused(el), byId(el, "dial-add"));
  const lit = mount({ seed: { _live: live(ON_AIR) } });
  press(tile(lit, "p1"));
  assert.equal(focused(lit).dataset.focus, "dial-sheet", "the lit tile's editor opened without focus");
  press(byId(lit, "dial-cancel"));
  assert.equal(focused(lit), tile(lit, "p1"));
  press(byId(lit, "air-stop"));
  assert.equal(focused(lit).dataset.focus, "stop-ask");
  press(byId(lit, "air-stop-keep"));
  assert.equal(focused(lit), byId(lit, "air-stop"));
}));

test("Enter in the Request Line shows its question at once and moves focus to it", tracking(async () => {
  const el = mount();
  const box = byId(el, "rl-text");
  box.focus();
  type(box, "Night Drive");
  fire(box, "keydown", { key: "Enter" });
  await settle();
  assert.ok(byId(el, "rl-confirm"), "the question waited for the box to lose focus");
  assert.equal(focused(el).dataset.focus, "rl-ask");
  assert.equal(ws(el, "station_live_start").length, 0, "Enter started a station");
}));

test("the Station page has headings, and the house line's door is named by the word it shows", () => {
  const el = mount({ over: { djAttrs: { outputs_enabled: [] } } });
  const desk = outer(el, ".station-desk");
  assert.match(desk, /^<section[^>]*>\s*<h2 class="visually-hidden">QPRW FM<\/h2>/);
  assert.match(outer(el, ".rl-card"), /<h2 class="rl-title">Request Line<\/h2>/);
  assert.match(outer(el, ".st-truth"),
               /Choose one in <button type="button" class="inlink" data-goto="settings"\s+aria-label="Go to Settings">Settings<\/button>/);
  assert.match(houseLine(el), /No DJ-enabled speaker yet\. Choose one in Settings/);
});

test("no fetch completion threw anywhere in this suite", async () => {
  await settle(); await settle();
  assert.deepEqual(unhandled.map(String), [], "a render threw inside a fetch completion");
});

// ---------------------------------------------------------------------------
// --- alpha.4: one song, next ---------------------------------------------------
function mountSong(reply) {
  return mount({ seed: { _live: live(OFF) },
    answers: { "parlorwave_radio/station_live": () => OFF,
               "parlorwave_radio/request_song": reply } });
}

test("the Request Line plays one song next and says which", async () => {
  const el = mountSong(() => ({ action: "inserted_local_next", source: "ma_library",
                                track: { title: "Slow Ferry", artist: "Cold Orchard" } }));
  assert.ok(byId(el, "rl-song-title") && byId(el, "rl-song-artist") && byId(el, "rl-song-go"));
  assert.doesNotMatch(text(outer(el, ".air-request")), /does not queue a single song/);
  type(byId(el, "rl-song-title"), "  Slow Ferry ");
  type(byId(el, "rl-song-artist"), "Cold  Orchard");
  press(byId(el, "rl-song-go")); await settle();
  assert.deepEqual(ws(el, "request_song").map(payload), [{ title: "Slow Ferry", artist: "Cold Orchard" }],
                   "one request, trimmed, no speaker named by the panel");
  assert.equal(ws(el, "station_live_start").length, 0, "a song request never starts a station");
  assert.match(text(outer(el, ".rl-song")), /Up next: “Slow Ferry” by Cold Orchard\./);
  assert.equal(byId(el, "rl-song-title").value, "", "a played request clears the boxes");
});

test("a song request that is not exactly one song inserts nothing and says why", async () => {
  const replies = [
    [{ action: "none", result: { status: "ambiguous", candidates: [
        { title: "Slow Ferry", artist: "Cold Orchard" }, { title: "Slow Ferry", artist: "Ada Venn" }] } },
     /More than one artist has a song called “Slow Ferry” \(Cold Orchard; Ada Venn\)\. Add the artist\./],
    // An artist that was GIVEN is never asked for again
    [{ action: "none", result: { status: "ambiguous", ambiguity: "artist", query: { artist: "Cold", title: "Slow Ferry" },
        candidates: [{ title: "Slow Ferry", artist: "Cold Orchard" }, { title: "Slow Ferry", artist: "Cold Orchard Revival" }] } },
     /“Slow Ferry” matches more than one artist like “Cold” \(Cold Orchard; Cold Orchard Revival\)\. Type the artist's full name\./],
    [{ action: "none", result: { status: "ambiguous", ambiguity: "version", query: { artist: "Cold Orchard", title: "Slow Ferry" },
        candidates: [{ title: "Slow Ferry", artist: "Cold Orchard", album: "Northern Static", version: "" },
                     { title: "Slow Ferry", artist: "Cold Orchard", album: "Live at the Cinder Rooms", version: "Live" }] } },
     /more than one version of “Slow Ferry” by Cold Orchard: the plain recording \(Northern Static\); Live \(Live at the Cinder Rooms\)\. Type the version into the title to choose one, for example “Slow Ferry \(Live\)”\./],
    [{ action: "none", result: { status: "ambiguous", ambiguity: "album", query: { artist: "Cold Orchard", title: "Slow Ferry" },
        candidates: [{ title: "Slow Ferry", artist: "Cold Orchard", album: "Northern Static" },
                     { title: "Slow Ferry", artist: "Cold Orchard", album: "Gullwing" }] } },
     /“Slow Ferry” by Cold Orchard is on more than one album in your library \(Northern Static; Gullwing\)\. A request cannot choose between albums yet, so nothing was added\./],
    [{ action: "none", reason: "player_paused" }, /The DJ's speaker is paused\. Press play first/],
    [{ action: "none", reason: "next_already_buffered" }, /Music Assistant has already lined up the next song\. Ask again once it starts\./],
    [{ action: "none", reason: "queue_changed" }, /The queue changed while the request was being placed, so nothing was added\./],
    [{ action: "none", reason: "request_pending", pending: { title: "Quarry Light", artist: "Cold Orchard" } },
     /“Quarry Light” is still waiting to play next\. Ask for another song once it starts\./],
    [{ action: "none", result: { status: "local_not_found" } }, /“Slow Ferry” is not in your Music Assistant library\./],
    [{ action: "none", reason: "nothing_playing" }, /Nothing is playing on the DJ's speaker/],
    [{ action: "none", reason: "program_on_air" }, /The DJ or the news is on now or up next\. Ask again once it has played\./],
    [{ action: "none", reason: "insert_failed" }, /Music Assistant did not take the request\. Nothing was added\./],
    [{ action: "none", reason: "target_required" }, /more than one speaker/],
    [{ action: "none", reason: "library_unavailable" }, /could not be read/],
  ];
  for (const [reply, said] of replies) {
    const el = mountSong(() => reply);
    type(byId(el, "rl-song-title"), "Slow Ferry");
    press(byId(el, "rl-song-go")); await settle();
    const box = outer(el, ".rl-song");
    assert.match(text(box), said);
    assert.match(box, /notice err/);
    assert.equal(byId(el, "rl-song-title").value, "Slow Ferry", "a refused request keeps what was typed");
  }
});

test("an insert MA did not show directly after the current song never says Up next", async () => {
  const el = mountSong(() => ({ action: "inserted_unconfirmed", track: { title: "Slow Ferry", artist: "Cold Orchard" } }));
  type(byId(el, "rl-song-title"), "Slow Ferry");
  press(byId(el, "rl-song-go")); await settle();
  const said = text(outer(el, ".rl-song"));
  assert.match(said, /Added “Slow Ferry” by Cold Orchard, but Music Assistant may play another song first\./);
  assert.doesNotMatch(said, /Up next/);
});

test("an empty song request asks for a title and sends nothing", async () => {
  const el = mountSong(() => ({ action: "inserted_local_next", track: {} }));
  press(byId(el, "rl-song-go")); await settle();
  assert.equal(ws(el, "request_song").length, 0);
  assert.match(text(outer(el, ".rl-song")), /Type a song title first\./);
});

// ===========================================================================
// STATION HANDOVER, on the Station sheet.
// Den is the house speaker here, offered BY HANDOVER: the first press asks the
// backend (answered handover_required, nothing written), the sheet shows what
// would be taken over, and only a choice -- keep or replace -- starts it, with
// the token of exactly that picture.
// ===========================================================================
const TARGETS_HO = (() => {
  const t = clone(TARGETS);
  Object.assign(t.targets.find((x) => x.queue_id === DEN),
                { eligible: true, reason: "", message: "", handover: true });
  return t;
})();
// Eight songs ahead: Autoplay's and a person's look the same to ParlorWave,
// so all are listed and none is ticked; one is already loaded and one the DJ
// has announced -- those two can never be ticked at all.
const SONGS = Array.from({ length: 8 }, (_, i) => ({ queue_item_id: `q${i}`, title: `Song ${i}`,
  artist: i % 2 ? "Marlow Kites" : "Cold Orchard", duration_s: 225,
  status: i === 0 ? "loaded" : i === 3 ? "announced" : "removable" }));
const HANDOVER = { target: { queue_id: DEN, name: "Den" }, autoplay: true, restore_autoplay: true,
  music_ahead: 8, music_ahead_s: 1800, replaceable: 6, program_ahead: 1, songs: SONGS, songs_unlisted: 0,
  modes: ["keep", "replace"], expires_in_s: 300, token: "tok-1" };
function handoverStart(msg) {
  if (msg.target !== DEN) return { ok: true, opening_count: 25, target: { queue_id: msg.target, name: "Kitchen" } };
  if (!msg.handover) return { ok: false, reason: "handover_required", message: "Confirm the handover first.", handover: HANDOVER };
  const removed = (msg.handover.remove || []).length;
  return { ok: true, opening_count: 25, target: { queue_id: DEN, name: "Den" },
    runway: { before_station: { songs: 8 - removed, seconds: (8 - removed) * 225 } },
    handover: { mode: msg.handover.upcoming, music_ahead: 8, restore_autoplay: true, autoplay_before: true,
                removal_selected: removed,
                replaced: msg.handover.upcoming === "replace" ? { removed, buffered: 0, promised: 0 } : null } };
}
function mountHouse(start = handoverStart, extra = {}) {
  return mount({ answers: Object.assign({ "parlorwave_radio/station_live": OFF,
                                          "parlorwave_radio/station_live_targets": TARGETS_HO,
                                          "parlorwave_radio/station_live_start": start }, extra) });
}
async function askHouse(el) {
  press(tile(el, "p2")); await settle();
  choose(byId(el, "air-target"), DEN);
  press(byId(el, "air-go")); await settle(); await settle();
}
const boxes = (el) => qa(el, "[data-handpick]");
function tick(el, id) {
  const box = boxes(el).find((b) => b.dataset.handpick === id);
  assert.ok(box, `no box for ${id}`);
  assert.ok(!box.disabled, `box ${id} is disabled`);
  box.checked = !box.checked;
  fire(box, "change");
}

test("handover: the house speaker is offered by handover, and the first press only asks", async () => {
  const el = mountHouse();
  press(tile(el, "p2")); await settle();
  const opt = byId(el, "air-target").options.find((o) => o.value === DEN);
  assert.ok(!("disabled" in opt.attrs), "the house speaker is still refused");
  assert.equal(opt.textContent, "Den — house speaker, by handover");
  choose(byId(el, "air-target"), DEN);
  press(byId(el, "air-go")); await settle(); await settle();
  assert.deepEqual(ws(el, "station_live_start").map(payload), [{ target: DEN, preset_id: "p2" }],
                   "the question is the one start command, with no handover");
  const said = text(sheet(el));
  assert.match(said, /Hand Den over to this station\?/);
  assert.match(said, /Music Assistant's Autoplay is choosing the music on Den now\. The station switches Autoplay off for Den while it plays and switches it back on when you stop the station\./);
  assert.match(said, /8 songs are queued after the one playing now \(about 30 min\)\. They are kept: the station's songs are queued after them, so the station starts once they have played, in about 30 min from the end of the song playing now\./);
  assert.match(said, /Speaker groups and every other speaker stay as they are\. DJ breaks and news carry on\./);
  assert.match(sheet(el), /<button id="air-hand-keep" >Play them first<\/button>/);
  assert.match(sheet(el), /<button class="ghost" id="air-hand-choose" >Choose songs to remove…<\/button>/);
  assert.equal(byId(el, "air-hand-replace"), null, "removal is never one press away");
  assert.equal(el._liveForm.handover.token, "tok-1");
});

test("handover: Play them first keeps every song and says the station is queued, not on air", async () => {
  const el = mountHouse();
  await askHouse(el);
  press(byId(el, "air-hand-keep")); await settle(); await settle();
  const starts = ws(el, "station_live_start").map(payload);
  assert.equal(starts.length, 2);
  assert.deepEqual(starts[1], { target: DEN, preset_id: "p2", handover: { token: "tok-1", upcoming: "keep" } });
  assert.equal(el._liveForm, null);
  assert.match(el._notice.text, /^Queued: "Night Crossing" on Den\. The station starts after the 8 queued songs ahead of it \(about 30 min\)\. Autoplay is off while the station plays and comes back on when you stop it\.$/);
});

test("handover: removing songs lists them by name, ticks nothing, and spares loaded and announced ones", async () => {
  const el = mountHouse();
  await askHouse(el);
  press(byId(el, "air-hand-choose"));
  const said = text(sheet(el));
  for (const x of SONGS) assert.ok(said.includes(x.title), `${x.title} is not listed`);
  assert.match(said, /ParlorWave cannot tell which of these Autoplay added and which someone queued, so nothing is removed unless you tick it\./);
  assert.match(said, /Song 0 · Cold Orchard already loaded, it plays/);
  assert.match(said, /Song 3 · Marlow Kites the DJ announced it, it plays/);
  assert.deepEqual(boxes(el).map((b) => b.dataset.handpick), ["q1", "q2", "q4", "q5", "q6", "q7"]);
  assert.ok(boxes(el).every((b) => !b.checked), "a song was ticked for the person");
  assert.ok(byId(el, "air-hand-replace").disabled);
  assert.match(sheet(el), /Tick the songs to remove/);
  tick(el, "q2"); tick(el, "q5");
  assert.match(sheet(el), /Remove 2 songs and go on air/);
  press(byId(el, "air-hand-replace")); await settle(); await settle();
  assert.deepEqual(payload(ws(el, "station_live_start")[1]).handover,
                   { token: "tok-1", upcoming: "replace", remove: ["q2", "q5"] });
  assert.match(el._notice.text, /^On air|^Queued/);
  assert.match(el._notice.text, /2 queued songs removed\. The station starts after the 6 queued songs ahead of it/);
});

test("handover: Tick all ticks only what may go; Keep them all goes back and sends nothing", async () => {
  const el = mountHouse();
  await askHouse(el);
  press(byId(el, "air-hand-choose"));
  press(byId(el, "air-hand-all"));
  assert.deepEqual(el._liveForm.handoverRemove, ["q1", "q2", "q4", "q5", "q6", "q7"]);
  assert.match(sheet(el), /Remove 6 songs and go on air/);
  press(byId(el, "air-hand-none"));
  assert.deepEqual(el._liveForm.handoverRemove, []);
  tick(el, "q1");
  press(byId(el, "air-hand-unpick"));
  assert.deepEqual(el._liveForm.handoverRemove, [], "ticks survived Keep them all");
  assert.ok(byId(el, "air-hand-keep"), "back at the question");
  assert.equal(ws(el, "station_live_start").length, 1, "only the question was sent");
});

test("handover: a removal the queue overtook says which songs stayed", async () => {
  const el = mountHouse((msg) => {
    if (!msg.handover) return handoverStart(msg);
    const r = handoverStart(msg);
    r.handover.replaced = { removed: 1, buffered: 1, promised: 0 };
    r.runway.before_station = { songs: 7, seconds: 7 * 225 };
    return r;
  });
  await askHouse(el);
  press(byId(el, "air-hand-choose"));
  tick(el, "q1"); tick(el, "q2");
  press(byId(el, "air-hand-replace")); await settle(); await settle();
  assert.match(el._notice.text, /1 song of the 2 songs you ticked was removed; the others had moved on or were already loaded, so they stay\./);
});

test("handover: Back, or another speaker, takes the question back and sends nothing", async () => {
  const el = mountHouse();
  await askHouse(el);
  assert.ok(byId(el, "air-target").disabled, "the speaker changed under its own question");
  press(byId(el, "air-back"));
  assert.equal(el._liveForm.handover, null);
  assert.equal(el._liveForm.confirm, false);
  choose(byId(el, "air-target"), KITCHEN);
  press(byId(el, "air-go"));
  assert.equal(el._liveForm.handover, null, "the Den question came back for Kitchen");
  assert.match(text(sheet(el)), /This changes Kitchen's queue/);
  assert.equal(ws(el, "station_live_start").length, 1, "only the Den question was sent");
});

test("handover: a queue that changed under the question shows the new picture and unticks", async () => {
  let n = 0;
  const el = mountHouse((msg) => {
    if (!msg.handover) return handoverStart(msg);
    n += 1;
    return { ok: false, reason: "handover_changed", message: "That speaker's queue changed while the handover was being confirmed.",
             handover: Object.assign({}, HANDOVER, { music_ahead: 9, replaceable: 7, token: "tok-2" }) };
  });
  await askHouse(el);
  press(byId(el, "air-hand-choose"));
  tick(el, "q1");
  press(byId(el, "air-hand-replace")); await settle(); await settle();
  assert.equal(n, 1);
  assert.equal(el._liveForm.handover.token, "tok-2");
  assert.deepEqual(el._liveForm.handoverRemove, [], "an old tick carried into the new picture");
  assert.match(text(sheet(el)), /9 songs are queued/);
  assert.match(el._notice.text, /queue changed/);
});

test("handover: nothing queued ahead is one plain choice", async () => {
  const el = mountHouse((msg) => (!msg.handover
    ? { ok: false, reason: "handover_required", handover: Object.assign({}, HANDOVER,
        { music_ahead: 0, music_ahead_s: 0, replaceable: 0, songs: [] }) }
    : handoverStart(msg)));
  await askHouse(el);
  assert.match(text(sheet(el)), /Nothing else is queued after the song playing now: the station starts after it\./);
  assert.equal(byId(el, "air-hand-choose"), null);
  assert.match(sheet(el), /<button id="air-hand-keep" >Hand over and go on air<\/button>/);
});

test("handover: the Request Line never aims at the house speaker", async () => {
  const el = mountHouse();
  type(byId(el, "rl-text"), "Night Drive");
  press(byId(el, "rl-go")); await settle();
  const vals = byId(el, "rl-target").options.filter((o) => o.value).map((o) => o.value);
  assert.ok(!vals.includes(DEN), "the house speaker is offered by the Request Line");
});

test("handover: a station waiting behind kept songs says Queued, never On air", async () => {
  const onair = clone(ON_AIR);
  onair.station.target = { queue_id: DEN, name: "Den" };
  onair.station.handover = { mode: "keep", restore_autoplay: true, autoplay_before: true, music_ahead: 8 };
  onair.station.runway = Object.assign({}, onair.station.runway, { before_station: { songs: 5, seconds: 900 } });
  const el = mount({ seed: { _live: live(onair) } });
  const line = text(airLine(el));
  assert.match(line, /^Queued Nineties on Den/);
  assert.match(line, /Starts after 5 queued songs \(about 15 min\)\./);
  assert.doesNotMatch(airLine(el), /air-line on\b/, "a waiting station is lit red");
  assert.match(text(outer(el, '[data-dial-pick="p1"]')), /Queued · Den/);
  assert.ok(!tile(el, "p1").classList.contains("onair"), "a waiting station's tile is lit red");
  assert.doesNotMatch(outer(el, '[data-dial-pick="p1"]'), /preset-lamp/, "a waiting station's tile has the ON AIR lamp");
  assert.doesNotMatch(text(outer(el, '[data-dial-pick="p1"]')), /On air/);
});

test("handover: on the air it says so, and Stop says Autoplay comes back", async () => {
  const onair = clone(ON_AIR);
  onair.station.target = { queue_id: DEN, name: "Den" };
  onair.station.handover = { mode: "keep", restore_autoplay: true, autoplay_before: true, music_ahead: 8 };
  onair.station.runway = Object.assign({}, onair.station.runway, { before_station: { songs: 0, seconds: 0 } });
  const el = mount({ seed: { _live: live(onair) } });
  assert.match(text(airLine(el)), /^On air Nineties on Den/);
  assert.match(text(airLine(el)), /took over from Autoplay/);
  press(byId(el, "air-stop"));
  assert.match(text(airLine(el)), /What is already queued keeps playing\. Music Assistant's Autoplay comes back on for Den\./);
});

// A house handover's Stop could not switch Autoplay back on: the person
// decides; ParlorWave never does it later by itself.
function offWithDebt(state, extra = {}) {
  const off = clone(OFF);
  off.last.target = { queue_id: DEN, name: "Den" };
  off.last.autoplay_restore = Object.assign({ state, reason: "ma_unavailable", speaker: "Den",
    queue_id: DEN }, extra);
  return off;
}

test("autoplay: a pending restore asks the person, with both answers", async () => {
  const el = mount({ seed: { _live: live(offWithDebt("pending")) },
    answers: { "parlorwave_radio/station_live": offWithDebt("pending") } });
  const said = text(outer(el, ".air-status"));
  assert.match(said, /Autoplay is still off for Den\./);
  assert.match(said, /It was on before the station took over, but Music Assistant did not answer when the station stopped, so it was not switched back on\./);
  assert.match(said, /ParlorWave will not switch it on by itself now/);
  press(byId(el, "air-autoplay-restore")); await settle(); await settle();
  assert.deepEqual(ws(el, "station_live_autoplay").map(payload), [{ decision: "restore" }]);
  assert.deepEqual(svc(el), [], "never a service call");
});

test("autoplay: Leave it off sends dismiss; a refusal is said in words", async () => {
  const el = mount({ seed: { _live: live(offWithDebt("pending", { reason: "interrupted", manual_playback_since: true })) },
    answers: { "parlorwave_radio/station_live": offWithDebt("dismissed"),
               "parlorwave_radio/station_live_autoplay": { ok: false, reason: "superseded_by_station",
                 message: "A station is using that speaker now, so nothing was changed." } } });
  const said = text(outer(el, ".air-status"));
  assert.match(said, /ParlorWave restarted while the station was stopping/);
  assert.match(said, /Other music has been started there since\./);
  press(byId(el, "air-autoplay-dismiss")); await settle(); await settle();
  assert.deepEqual(ws(el, "station_live_autoplay").map(payload), [{ decision: "dismiss" }]);
  assert.match(el._notice.text, /A station is using that speaker now, so nothing was changed\./);
});

test("autoplay: nothing is asked once the question is settled", () => {
  for (const state of ["restored", "already_on", "on_again", "dismissed", "expired", "not_ours", "superseded_by_station"]) {
    const el = mount({ seed: { _live: live(offWithDebt(state)) } });
    assert.equal(byId(el, "air-autoplay-restore"), null, state);
  }
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) {
    process.stdout.write(`  FAIL ${name}\n       ${String(e && e.message).split("\n").slice(0, 6).join("\n       ")}\n`);
    process.exitCode = 1;
  }
}
Date.now = realNow;
process.stdout.write(`\n${passed}/${tests.length} Station redesign tests passed\n`);
