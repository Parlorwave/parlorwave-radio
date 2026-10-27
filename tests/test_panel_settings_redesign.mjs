/* The Settings screen (the Ready strip), EXECUTED.
 *
 * The REAL _render and the REAL bindings run under node against the same
 * markup-parsing fake shadow root as test_panel_station_redesign.mjs (the
 * fake DOM below is that suite's, copied): every innerHTML assignment
 * builds fresh elements from the markup the panel produced, a press fires
 * the listeners bound to THAT element, and a disabled control cannot be
 * pressed. Websocket calls are recorded by a fake hass.callWS.
 *
 * THE DOCUMENTS ARE REAL. Every readiness document here is built at test
 * time by readiness.py through the real `parlorwave_radio/readiness`
 * command (ha/tests/readiness_docs.py), so the screen is exercised with
 * the integration's own sentences for a first run, a partial setup, a
 * ready installation, one with warnings, one that went wrong (Music
 * Assistant unreachable, a voice unavailable, the DJ off, the speakers
 * unticked), a problem no step owns, and a service that has not answered.
 *
 *   node ha/tests/test_panel_settings_redesign.mjs
 *   PANEL_JS=<a copy of the panel> node ha/tests/test_panel_settings_redesign.mjs
 *
 * Without python3 the suite says so and skips: there is no honest way to
 * test this screen with documents nobody built. */
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

// ===========================================================================
// 1. WHICH PRESENTATION: the document's verdict, and nothing else
// ===========================================================================
const kindOf = (r) => (r.classList.contains("done") ? "done" : r.classList.contains("ck-attn") ? "attn"
  : r.classList.contains("ck-open") ? "open" : "other");
const chipKinds = (el) => qa(el, ".ready-chip").map((c) => ["done", "attn", "todo"].find((k) => c.classList.contains(k)));
/* Every functional setting is within reach: the speaker list (its card, or
 * inside the open speaker step) with exactly one Save, the Console, Extras
 * with every optional control, and the support details. */
function everyControl(el, label) {
  assert.equal(qa(el, "[data-spk]").length, 3, `${label}: the speaker list is out of reach`);
  assert.equal(count(page(el), 'id="spk-save"'), 1, `${label}: Save speakers is not drawn exactly once`);
  assert.ok(q(el, ".console-set") && qa(el, "[data-fp-choice]").length === 5 && byId(el, "btn-toggle-eyes"),
            `${label}: the Console is gone`);
  assert.ok(q(el, ".extras"), `${label}: Extras is gone`);
  for (const id of ["svc-ve-enabled", "svc-wr-enabled", "svc-save", "svc-wr-provider"]) {
    assert.equal(within(el, ".extras", `#${id}`).length, 1, `${label}: ${id} is not in Extras`);
  }
  // the weather and the calendars are in the everyday card, with the speakers
  for (const id of ["wx-save", "weather-test", "cal-save", "cal-test"]) {
    assert.equal(within(el, ".src-card", `#${id}`).length, 1, `${label}: ${id} is not in the Sources card`);
  }
  assert.ok(byId(el, "settings-advanced"), `${label}: no support details`);
}

test("the mode is the document's verdict alone: ready, checking, or one neutral incomplete state", () => {
  const el = mount("ready");
  const want = { first_run: "incomplete", speaker_next: "incomplete", partial: "incomplete",
                 pass3: "incomplete", pass2: "incomplete", pass1: "incomplete", pass0: "incomplete",
                 ready: "ready", ready_warnings: "ready", ma_unreachable: "incomplete",
                 voice_unavailable: "incomplete", dj_off: "incomplete", speakers_unticked: "incomplete",
                 observer_stopped: "incomplete", checking: "checking" };
  for (const [name, mode] of Object.entries(want)) assert.equal(el._readyMode(DOCS[name]), mode, name);
  assert.equal(el._readyMode(null), "checking");
  for (const complete of [0, 1, 2, 3, 4]) {
    assert.equal(el._readyMode(Object.assign(clone(DOCS.partial), { complete })), "incomplete",
                 `how many steps pass decided the presentation (${complete} of 4)`);
  }
});

// ===========================================================================
// 2. A SETUP THAT IS NOT COMPLETE: the verdict, the four steps, every fix
// ===========================================================================
test("a brand-new installation: the verdict, all four steps open with their own fixes, and every control", () => {
  const el = mount("first_run");
  assert.match(text(outer(el, ".settings-desk")),
               /Not quite ready\. Next, connect Music Assistant\. 3 more steps after that\. 0 of 4 set up/);
  assert.equal(qa(el, ".ready-chip").length, 0, "the steps are said twice (chips and the list)");
  assert.deepEqual(rows(el).map(kindOf), ["open", "open", "open", "open"]);
  assert.match(text(rows(el)[0].outerHTML), /Settings › Apps › ParlorWave Radio › Configuration \(Add-ons before Home Assistant 2026\.10\)/);
  assert.match(rows(el)[0].outerHTML, /class="ck-tools"><table>/, "the Music Assistant step carries no server facts");
  assert.equal(within(el, ".ck", "[data-spk]").length, 3, "the speaker step does not carry the speaker list");
  assert.equal(within(el, ".ck", '[data-goto="settings"]').length, 0, "a step sends you to the page you are on");
  assert.match(text(rows(el)[2].outerHTML), /Add a text-to-speech integration/);
  assert.match(text(rows(el)[3].outerHTML), /Go to On Air/);
  assert.match(text(page(el)), /These four are everything ParlorWave Radio needs to work/);
  everyControl(el, "first run");
  assert.ok(!q(el, ".extras").open, "Extras opened by itself");
  assert.equal(byId(el, "ready-steps"), null);
});

test("when the speaker step is not done, the speaker list is inside it and Save sends one outputs_set", () => {
  const el = mount("speaker_next", { seed: { _speakers: { at: NOW, data: Object.assign(clone(SPEAKERS), { enabled: [] }) },
                                             _speakerDraft: [] } });
  assert.deepEqual(rows(el).map(kindOf), ["done", "open", "open", "open"]);
  assert.equal(within(el, ".ck", "[data-spk]").length, 3, "the speaker list is not in its step");
  assert.equal(q(el, ".spk-card"), null, "the speaker list is drawn twice");
  assert.match(text(page(el)), /With none selected the DJ has nowhere to speak\./);
  const den = q(el, `[data-spk="${DEN}"]`);
  den.checked = true;
  fire(den, "change");
  press(byId(el, "spk-save"));
  assert.deepEqual(ws(el, "outputs_set").map((c) => c.msg.enabled), [[DEN]]);
});

test("partway through: done steps are one quiet line and every step not done is open", () => {
  const el = mount("partial");
  assert.deepEqual(rows(el).map(kindOf), ["done", "done", "open", "open"]);
  assert.deepEqual(rows(el).map((r) => r.outerHTML.includes(">✓<")), [true, true, false, false],
                   "a done step lost its check, or an undone one gained one");
  assert.match(text(rows(el)[2].outerHTML), /Add a text-to-speech integration/);
  assert.match(text(rows(el)[3].outerHTML), /Go to On Air/);
  assert.match(text(outer(el, ".settings-desk")), /Next, give it a voice\. 1 more step after that\. 2 of 4 set up/);
  assert.equal(qa(el, ".ready-chip").length, 0, "chips beside the steps");
  everyControl(el, "partial");
});

// ===========================================================================
// 3. READY: one strip, the steps folded at once
// ===========================================================================
test("ready folds the steps into the strip at once; Show steps opens them and stays open across updates", () => {
  const el = mount("ready");
  const strip = outer(el, ".ready-strip");
  assert.match(strip, /<h2 class="ready-title">Ready\.<\/h2>/);
  assert.equal(q(el, ".ready-desc"), null, "a finished installation still shows the onboarding sentence");
  assert.equal(q(el, ".settings-desk"), null, "the setup hero is drawn on a ready installation");
  const chips = qa(el, ".ready-chip").map((c) => c.textContent);
  assert.deepEqual(chips, ["Music Assistant : done", "Speaker · Den : done", "Voice · Piper · Amy : done", "DJ on : done"]);
  assert.equal(rows(el).length, 0, "the steps did not fold away");
  const btn = byId(el, "ready-steps");
  assert.equal(btn.getAttribute("aria-expanded"), "false");
  assert.equal(btn.textContent, "Show steps");
  press(btn);
  assert.equal(rows(el).length, 4);
  assert.ok(rows(el).every((r) => r.classList.contains("done")));
  assert.equal(byId(el, "ready-steps").textContent, "Hide steps");
  rerender(el);
  assert.equal(rows(el).length, 4, "an ordinary update folded the steps again");
  press(byId(el, "ready-steps"));
  assert.equal(rows(el).length, 0);
  everyControl(el, "ready");
});

test("ready with warnings keeps its sentence and lists them under Worth a look", () => {
  const el = mount("ready_warnings");
  assert.match(text(outer(el, ".ready-desc")), /2 things are worth a look below\./);
  const warn = qa(el, ".problem-card").filter((e) => e.classList.contains("warning"));
  assert.equal(warn.length, 2);
  assert.match(text(page(el)), /Worth a look/);
  assert.match(text(page(el)), /None of these stops the station\./);
});

// ===========================================================================
// 4. AN ESTABLISHED INSTALLATION THAT WENT WRONG: the same screen, its fix open
// ===========================================================================
test("Music Assistant unreachable: the verdict says so, its step is open in amber, and every control stays", () => {
  const el = mount("ma_unreachable");
  assert.match(text(outer(el, ".settings-desk")), /Needs attention\. Music Assistant did not answer\./);
  assert.ok(q(el, ".ready-dot").classList.contains("bad"));
  assert.equal(qa(el, ".ready-chip").length, 0, "chips beside the steps");
  assert.deepEqual(rows(el).map(kindOf), ["attn", "done", "done", "done"]);
  assert.match(rows(el)[0].textContent, /^Music Assistant connected/);
  assert.match(rows(el)[0].outerHTML, /class="ck-tools"><table>/);
  assert.doesNotMatch(rows(el)[0].outerHTML, />✓</);
  everyControl(el, "Music Assistant unreachable");
});

test("a voice that stopped, the DJ off and the speakers unticked each open their own step, in their own tone", () => {
  const voice = mount("voice_unavailable");
  assert.deepEqual(rows(voice).map(kindOf), ["done", "done", "attn", "done"]);
  assert.match(text(rows(voice)[2].outerHTML), /^A voice to speak with .*Go to Booth/);
  const dj = mount("dj_off");
  assert.deepEqual(rows(dj).map(kindOf), ["done", "done", "done", "open"], "the DJ switched off reads as a fault");
  assert.equal(qa(dj, ".ready-chip").length, 0, "chips beside the steps");
  assert.match(text(rows(dj)[3].outerHTML), /^The DJ is switched on .*Go to On Air/);
  assert.match(text(outer(dj, ".settings-desk")), /Not quite ready\. Next, switch the DJ on\. It is the last one\./);
  const spk = mount("speakers_unticked");
  assert.deepEqual(rows(spk).map(kindOf), ["done", "open", "done", "done"]);
  assert.equal(within(spk, ".ck", "[data-spk]").length, 3, "the speaker list is not in its step");
  assert.equal(q(spk, ".spk-card"), null, "the speaker list is drawn twice");
  for (const [e, n] of [[voice, "voice"], [dj, "DJ off"], [spk, "speakers unticked"]]) everyControl(e, n);
});

test("a problem no step owns is said under To fix, beside four steps that pass", () => {
  const el = mount("observer_stopped");
  assert.deepEqual(rows(el).map(kindOf), ["done", "done", "done", "done"]);
  assert.match(text(outer(el, ".settings-desk")), /Needs attention\. Playback is not being followed\./);
  const fix = qa(el, ".problem-card").filter((e) => e.classList.contains("error"));
  assert.equal(fix.length, 1);
  assert.match(fix[0].textContent, /Playback is not being followed/);
  assert.match(text(page(el)), /To fix/);
  everyControl(el, "observer stopped");
});

test("while the service has not answered nothing is guessed: no chips, no steps, no meter", () => {
  const el = mount("checking");
  assert.match(text(outer(el, ".ready-strip")), /^Checking this installation… ParlorWave Radio has not answered yet\./);
  assert.ok(q(el, ".ready-strip").classList.contains("idle"));
  assert.equal(qa(el, ".ready-chip").length, 0);
  assert.equal(rows(el).length, 0);
  assert.equal(q(el, ".ready-meter"), null);
  everyControl(el, "checking");
  const wait = mount(null);
  assert.match(text(page(wait)), /Reading this installation…/);
  const failed = mount(null, { seed: { _ready: { at: NOW, data: null, error: true } } });
  assert.match(text(page(failed)), /Cannot read this installation\./);
});

// ===========================================================================
// 5. EXTRAS, SUPPORT DETAILS AND THE CONSOLE
// ===========================================================================
test("Extras is closed by default, stays as it was left, and holds every optional control", async () => {
  const el = mount("ready");
  const ex = q(el, ".extras");
  assert.equal(ex.tagName, "DETAILS");
  assert.ok(!ex.open);
  assert.match(text(ex.outerHTML), /^Extras Optional services, the writing model, news feed and custom voices/);
  for (const id of ["svc-ve-enabled", "svc-wr-enabled", "svc-save", "svc-wr-provider"]) {
    assert.equal(within(el, ".extras", `#${id}`).length, 1, `${id} is not in Extras`);
  }
  assert.equal(within(el, ".extras", "[data-svctest]").length, 2);
  for (const h of ["Optional services", "Writing", "Optional capabilities"]) {
    assert.ok(ex.outerHTML.includes(`<h2>${h}</h2>`), `${h} is not in Extras`);
  }
  assert.ok(!ex.outerHTML.includes("<h2>Context</h2>"), "the weather and the calendars are not extras");
  ex.open = true; fire(ex, "toggle");
  rerender(el);
  assert.ok(q(el, ".extras").open, "Extras closed itself on an update");
  press(byId(el, "svc-ve-enabled"));
  press(byId(el, "svc-save"));
  const saves = ws(el, "services_save");
  assert.equal(saves.length, 1);
  assert.equal(saves[0].msg.services.voice_engine.enabled, true);
  assert.equal(saves[0].msg.services.voice_engine.key, null, "an untouched key was not left as it was");
  await settle(); await settle();
  press(q(el, '[data-svctest="voice_engine"]'));
  assert.equal(ws(el, "service_test")[0].msg.kind, "voice_engine");
  press(byId(el, "cal-test"));
  press(byId(el, "weather-test"));
  assert.equal(ws(el, "calendar_test").length, 1);
  assert.equal(ws(el, "weather_test").length, 1);
});

test("typing a new voice engine address is enough to switch Save on", async () => {
  // with the engine already on, changing
  // only its address left Save disabled -- typing never re-renders the form
  const el = mount("ready");
  q(el, ".extras").open = true; fire(q(el, ".extras"), "toggle");
  rerender(el);
  assert.ok(byId(el, "svc-save").disabled, "nothing changed yet");
  const box = byId(el, "svc-ve-url");
  box.value = "http://engine.example:4123/audio/speech";
  fire(box, "input");
  assert.equal(byId(el, "svc-save").disabled, false, "Save stayed off after the address changed");
  press(byId(el, "svc-save"));
  const saves = ws(el, "services_save");
  assert.equal(saves.length, 1);
  assert.equal(saves[0].msg.services.voice_engine.base_url, "http://engine.example:4123/audio/speech");
  await settle();
});

test("Booth's door to its optional services opens Extras on arrival", () => {
  const el = mount("ready");
  assert.ok(!q(el, ".extras").open);
  const door = q(el, "[data-goto]");
  door.dataset.goto = "settings";                  // a door to Settings, pressed on Booth
  el._view = "booth";
  press(door);
  assert.equal(el._view, "settings");
  assert.ok(q(el, ".extras").open, "the person arrived at a closed Extras");
});

test("Support details: a closed foot toggle holding Music Assistant, Speech and the diagnostics table", () => {
  const el = mount("ma_unreachable");
  const btn = byId(el, "settings-advanced");
  assert.equal(btn.textContent, "Support details");
  assert.equal(btn.getAttribute("aria-expanded"), "false");
  assert.equal(q(el, ".support"), null);
  press(btn);
  const sup = outer(el, ".support");
  const at = (s) => sup.indexOf(s);
  assert.ok(at("<h2>Music Assistant</h2>") > 0 && at("<h2>Speech</h2>") > at("<h2>Music Assistant</h2>")
            && at("<h2>Health &amp; diagnostics</h2>") > at("<h2>Speech</h2>"), "the drawer's sections are missing or out of order");
  assert.match(text(sup), /entity: ParlorWave Radio DJ switch\.dj/);
  assert.match(sup, /ma_unreachable/, "the drawer does not name the service's own code");
  assert.equal(byId(el, "settings-advanced").textContent, "Hide support details");
});

test("the Console card switches the faceplate and the eyes", () => { try {
  const el = mount("ready");
  press(q(el, '[data-fp-choice="tweed"]'));
  assert.equal(el._faceplate, "tweed");
  assert.equal(q(el, '[data-fp-choice="tweed"]').getAttribute("aria-pressed"), "true");
  assert.equal(q(el, '[data-fp-choice="midnight"]').getAttribute("aria-pressed"), "false");
  assert.equal(byId(el, "btn-toggle-eyes").textContent, "On");
  press(byId(el, "btn-toggle-eyes"));
  assert.equal(store.get("parlorwave_eye_expressions"), "false");
  assert.equal(byId(el, "btn-toggle-eyes").textContent, "Off");
  assert.equal(byId(el, "btn-toggle-eyes").getAttribute("aria-pressed"), "false");
} finally { store.clear(); } });

// ===========================================================================
// 6. IN EVERY STATE
// ===========================================================================
test("in every state: Save speakers at most once, every id once, and no problem code on the screen", () => {
  for (const name of Object.keys(DOCS)) {
    const el = mount(name);
    const html = page(el);
    assert.ok(count(html, 'id="spk-save"') <= 1, `${name}: Save speakers drawn twice`);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids.filter((x, i) => ids.indexOf(x) !== i), [], `${name}: an id drawn twice`);
    for (const p of (DOCS[name].diagnostics || {}).problems || []) {
      assert.ok(!html.includes(p.code), `${name}: the code ${p.code} is on the screen`);
    }
    assert.match(html, /id="settings-advanced"/, `${name}: no support details`);
  }
});

test("a focused control keeps focus across the rebuild it causes", tracking(() => {
  const el = mount("ready");
  byId(el, "ready-steps").focus();
  press(byId(el, "ready-steps"));
  assert.equal(root(el).activeElement, byId(el, "ready-steps"), "Show steps lost focus");
  const box = q(el, `[data-spk="${KITCHEN}"]`);
  box.focus(); box.checked = true; fire(box, "change");
  assert.equal(root(el).activeElement, q(el, `[data-spk="${KITCHEN}"]`), "a speaker box lost focus");
}));

// ===========================================================================
// 7. FOUR, THREE, TWO, ONE, NONE: an established installation losing its
//    prerequisites, live and across reloads, with no history to lean on
// ===========================================================================
const DOWN = [["ready", 4], ["pass3", 3], ["pass2", 2], ["pass1", 1], ["pass0", 0]];
const answer = (el, name) => { el._ready = { at: NOW, data: { readiness: clone(DOCS[name]) } }; rerender(el); };

test("from four passing to none: every failing step opens, the rest stay quiet, and no control is taken away", () => {
  const el = mount("ready");
  for (const [name, passing] of DOWN) {
    answer(el, name);
    if (passing === 4) {
      assert.equal(rows(el).length, 0, "ready did not fold the steps");
    } else {
      assert.equal(el._readyMode(DOCS[name]), "incomplete", name);
      assert.equal(rows(el).length, 4, `${name}: the four steps are not all shown`);
      assert.equal(rows(el).filter((r) => r.classList.contains("done")).length, passing, name);
      assert.equal(rows(el).filter((r) => r.classList.contains("ck-open")).length, 4 - passing,
                   `${name}: a failing step is not open`);
      assert.match(text(outer(el, ".settings-desk")), new RegExp(`${passing} of 4 set up`));
    }
    // the chips are the Ready summary's; an unfinished setup has the list
    assert.equal(chipKinds(el).length, passing === 4 ? 4 : 0, `${name}: chips beside the steps`);
    everyControl(el, name);
  }
  // amber only where the step's own problem stops the station
  answer(el, "pass1");
  assert.deepEqual(rows(el).map(kindOf), ["done", "open", "attn", "open"]);
  answer(el, "pass0");
  assert.deepEqual(rows(el).map(kindOf), ["attn", "open", "attn", "open"]);
});

test("each state draws the same after a browser reload: nothing is remembered and nothing is guessed", () => {
  store.clear();
  const live = mount("ready");
  for (const [name] of DOWN.concat([["pass2", 2], ["ready", 4]])) {
    answer(live, name);
    const fresh = mount(name);              // a new page: no component state, empty browser storage
    assert.equal(page(fresh), page(live), `${name}: a reload draws it differently`);
  }
  assert.deepEqual([...store.keys()], [], "readiness left something in browser storage");
});

test("when the last failing step passes again it folds straight back into Ready", () => {
  const el = mount("pass0");
  answer(el, "ready");
  assert.equal(rows(el).length, 0);
  assert.equal(byId(el, "ready-steps").textContent, "Show steps");
  assert.equal(q(el, ".settings-desk"), null);
});

test("with no history at all, zero of four on a new and on an established installation are drawn alike", () => {
  const shape = (el) => ({
    cards: ["settings-desk", "ready-strip", "spk-card", "console-set", "extras", "support-foot"].filter((c) => q(el, "." + c)),
    rows: rows(el).map(kindOf).map((k) => (k === "attn" ? "open" : k)),
    chips: qa(el, ".ready-chip").length,
    ids: [...page(el).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]).sort() });
  const fresh = mount("first_run"), est = mount("pass0");
  assert.deepEqual(shape(fresh), shape(est));
  // reached from nothing: before any answer, and after a failed read
  for (const before of [null, { at: NOW, data: null, error: true }]) {
    const el = mount(null, { seed: { _ready: before }, answers: { "parlorwave_radio/readiness": NEVER } });
    answer(el, "pass0");
    assert.equal(page(el), page(est), "the page depends on what came before it");
  }
});

test("on a phone the meter's bar keeps its height in the stacked meter", () => {
  const src = readFileSync(PANEL, "utf8");
  const style = src.slice(src.indexOf("<style>"), src.indexOf("</style>"));
  const phone = style.slice(style.indexOf("@media (max-width: 560px)"));
  const rule = (phone.match(/\.ready-bar \{[^}]*\}/) || [""])[0];
  assert.match(rule, /flex:none/, "a growing bar in a column meter collapses to no height");
});

// ===========================================================================
// 8. A STALE DOCUMENT IS NOT A VERDICT
// ===========================================================================
test("a readiness document older than five minutes is not shown as Ready, and is read again", () => {
  const el = mount("ready");
  assert.match(text(outer(el, ".ready-strip")), /^Ready\./);
  el._ready.at = NOW - 6 * 60 * 1000;         // ten missed re-reads
  rerender(el);
  assert.equal(q(el, ".ready-strip"), null, "Ready. over a dead connection");
  assert.match(text(outer(el, ".settings-desk")), /has not answered for a while/);
  assert.doesNotMatch(page(el), /Ready\./);
  assert.ok(ws(el, "readiness").length >= 1, "no re-read");
});

test("a readiness read that hangs is given up on after a minute, so the next re-read can happen", () => {
  const el = mount("ready", { answers: { "parlorwave_radio/readiness": NEVER } });
  el._ready.at = NOW - 60 * 1000; rerender(el);
  assert.equal(ws(el, "readiness").length, 1);
  assert.ok(el._ready.loading);
  el._ready.at = NOW - 90 * 1000; rerender(el);
  assert.equal(ws(el, "readiness").length, 1, "re-read while a read is still in flight");
  el._ready.loadingSince = NOW - 61 * 1000; rerender(el);
  assert.equal(ws(el, "readiness").length, 2, "a hung read pinned the screen");
  assert.match(text(outer(el, ".ready-strip")), /^Ready\./, "the document in hand stays on show meanwhile");
});

test("no fetch completion threw anywhere in this suite", async () => {
  await settle(); await settle();
  assert.deepEqual(unhandled.map(String), [], "a render threw inside a fetch completion");
});

// ---------------------------------------------------------------------------
let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) {
    process.stdout.write(`  FAIL ${name}\n       ${String(e && e.message).split("\n").slice(0, 6).join("\n       ")}\n`);
    process.exitCode = 1;
  }
}
Date.now = realNow;
process.stdout.write(`\n${passed}/${tests.length} Settings redesign tests passed\n`);
