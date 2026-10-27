/* Broadcast Diagnostics in the panel, EXECUTED.
 *
 * The REAL _render and the REAL bindings run under node against the same
 * markup-parsing fake shadow root as test_panel_settings_redesign.mjs (the
 * fake DOM below is that suite's, copied): every innerHTML assignment
 * builds fresh elements from the markup the panel produced, and a press
 * fires the listeners bound to THAT element.
 *
 * THE ANSWERS ARE REAL. Every websocket answer is one the backend's routes
 * gave (ha/tests/broadcast_diagnostics_api.py, generated through the real
 * routes and checked for drift by test_broadcast_diagnostics_ws.py); the
 * Settings screen around the card is the integration's own readiness
 * document (readiness_docs.py). A request the backend was never asked is
 * answered with nothing, and fails the suite.
 *
 * Pinned: the compact list carries no script and the record is read once,
 * on demand; null is UNKNOWN or NOT RECORDED and never a negative; a span
 * is marked only where it was recorded; recorded completion is told apart
 * from what a floor said it used; the history limit is stated; pages,
 * filters and refresh ask the backend, never the loaded rows; Air Check and
 * Break History open the record by its public id; markup in a record is
 * text; only administrators get a door.
 *
 *   node ha/tests/test_panel_broadcast_diagnostics.mjs
 *   PANEL_JS=<a copy of the panel> node ha/tests/test_panel_broadcast_diagnostics.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL = process.env.PANEL_JS
  ? resolve(process.env.PANEL_JS)
  : join(HERE, "..", "custom_components", "parlorwave_radio", "panel", "parlorwave-radio-panel.js");

// --- the answers, from python --------------------------------------------------
const python = (script, ...args) => spawnSync("python3", ["-B", join(HERE, script), ...args], {
  env: Object.assign({}, process.env, { PYTHONPATH: `${join(HERE, "..")}:${HERE}`,
                                        PYTHONDONTWRITEBYTECODE: "1" }),
  encoding: "utf8", maxBuffer: 1 << 26 });
const docs = python("readiness_docs.py", "ready");
if (docs.error && docs.error.code === "ENOENT") {
  process.stdout.write("SKIPPED: python3 is not installed, so no recorded answer can be read\n");
  process.exit(0);
}
assert.equal(docs.status, 0, `readiness_docs.py failed:\n${docs.stderr}`);
const READY = JSON.parse(docs.stdout).ready;
const fx = python("broadcast_diagnostics_api.py");
assert.equal(fx.status, 0, `broadcast_diagnostics_api.py failed:\n${fx.stderr}`);
const EXCHANGES = JSON.parse(fx.stdout);

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


// --- the recorded answers ------------------------------------------------------
const clone = (x) => structuredClone(x);
const byName = Object.fromEntries(EXCHANGES.map((e) => [e.name, e]));
const KEYS = ["limit", "kind", "before", "outcome", "reason"];
const listKey = (m) => JSON.stringify(KEYS.map((k) => (m[k] == null || m[k] === "" ? null : m[k])));
// `partial:1` is a second answer to the first page's request; asked for by name
const LISTS = new Map(EXCHANGES.filter((e) => e.kind === "list" && !e.name.startsWith("partial"))
  .map((e) => [listKey(e.params), e.body]));
const DETAILS = new Map(EXCHANGES.filter((e) => e.kind === "detail").map((e) => [e.params.opportunity_id, e]));
const idOf = (name) => byName[`detail:${name}`].params.opportunity_id;
const record = (name) => byName[`detail:${name}`].body;
const FIRST = byName["all:1"].body;
const unrecorded = [];

/* What the integration answers (api.py): the backend's body, unedited; a
 * record the backend answered 404 for is { ok: false, reason: "not_found" }. */
function diagAnswer(msg) {
  if (msg.type === "parlorwave_radio/broadcast_diagnostics_list") {
    const body = LISTS.get(listKey(msg));
    if (body) return body;
  } else {
    const e = DETAILS.get(msg.opportunity_id);
    if (e) return e.status === 404 ? { ok: false, reason: "not_found" } : e.body;
  }
  unrecorded.push(msg);
  return new Error(`the backend was never asked ${JSON.stringify(msg)}`);
}

const DEN = "media_player.den";
const SPEAKERS = { ok: true, speakers: [{ id: DEN, name: "Den" }], enabled: [DEN], selected: DEN };
const SERVICES = { ok: true, section: "services",
  settings: { voice_engine: { enabled: false, base_url: "", voice: "", key_saved: false },
              writer: { enabled: false, provider: "compat", base_url: "", model: "", key_saved: false } },
  writer_providers: [{ id: "compat", label: "A compatible service" }] };
const SOURCES = { ok: true, pending: {},
  weather: { selected: "weather.home", live: "weather.home",
             entities: [{ entity_id: "weather.home", name: "Home", available: true, selected: true, missing: false }] },
  calendars: { selected: [], live: [], entities: [] } };
const ADMIN = { name: "Owner", is_admin: true };

function hassFor(calls, answers, user, djAttrs) {
  const states = {
    "switch.dj": { entity_id: "switch.dj", state: "on", attributes: { friendly_name: "ParlorWave Radio DJ" } },
    "select.out": { entity_id: "select.out", state: "Den",
      attributes: { friendly_name: "Active DJ speaker", options: ["Den"], player_id: DEN } },
    "sensor.dj": { entity_id: "sensor.dj", state: "waiting", attributes: Object.assign({
      enabled: true, station_name: "QPRW FM", observer: { running: true, queue_id: DEN },
      outputs_enabled: [DEN], catalog: { usable: false, known: true, track_count: 0 } }, djAttrs || {}) },
  };
  return {
    states, user, auth: { data: { access_token: "x" } },
    callService: (d, s, data) => { calls.push({ svc: `${d}.${s}`, data }); return Promise.resolve(); },
    callWS: (msg) => {
      calls.push({ ws: msg.type, msg });
      let a = answers[msg.type];
      if (a === undefined && msg.type.startsWith("parlorwave_radio/broadcast_diagnostics_")) a = diagAnswer;
      if (typeof a === "function") a = a(msg);
      if (a && typeof a.then === "function") return a;
      if (a instanceof Error) return Promise.reject(a);
      return Promise.resolve(a === undefined ? { ok: true } : clone(a));
    },
  };
}
function mount({ view = "settings", user = ADMIN, answers = {}, seed = {}, djAttrs = null } = {}) {
  const el = new PanelClass();
  el.calls = [];
  el._entityMap = { dj_enabled: "switch.dj", output: "select.out", dj_status: "sensor.dj" };
  el._voiceLib = {};
  el._view = view;
  el._ready = { at: NOW, data: { readiness: clone(READY) } };
  el._speakers = { at: NOW, data: clone(SPEAKERS) };
  el._speakerDraft = SPEAKERS.enabled.slice();
  el._services = clone(SERVICES);
  el._sources = { at: NOW, data: clone(SOURCES) };
  Object.assign(el, seed);
  el.hass = hassFor(el.calls, answers, user, djAttrs);
  return el;
}
const root = (el) => el.shadowRoot;
const page = (el) => root(el).innerHTML.split("</style>").slice(1).join("</style>");
const q = (el, sel) => root(el).querySelector(sel);
const qa = (el, sel) => root(el).querySelectorAll(sel);
const byId = (el, id) => root(el).getElementById(id);
const outer = (el, sel) => { const e = q(el, sel); return e ? e.outerHTML : ""; };
const strip = ({ type, ...rest }) => rest;
const diagCalls = (el, t) => el.calls.filter((c) => c.ws === `parlorwave_radio/broadcast_diagnostics_${t}`)
  .map((c) => strip(c.msg));
const lastList = (el) => diagCalls(el, "list").at(-1);
const rowFor = (el, id) => outer(el, `[data-diag-row="${id}"]`);
/* an opportunity's whole markup: its row and, when open, its record */
const oppOf = (el, id) => (qa(el, ".diag-opp").find((o) => o.outerHTML.includes(`data-diag-row="${id}"`))
  || { outerHTML: "" }).outerHTML;
const done = async () => { await settle(); await settle(); };
const tap = async (e) => { press(e); await done(); };
const openSupport = (el) => tap(byId(el, "settings-advanced"));
const openRow = (el, id) => tap(q(el, `[data-diag-row="${id}"]`));
const tracking = (fn) => async () => { TRACK.on = true; try { await fn(); } finally { TRACK.on = false; } };
const AIR = (id) => ({ last_spoken: "That was Glory Box. Teardrop is next.",
                       last_break_at: "2026-10-26T15:33:50", last_break_id: id });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ===========================================================================
// 1. THE LIST: compact, the backend's order, no script
// ===========================================================================
test("opening Support details reads one page of DJ breaks and no record", async () => {
  const el = mount();
  assert.equal(diagCalls(el, "list").length, 0, "read before anyone asked");
  await openSupport(el);
  assert.deepEqual(diagCalls(el, "list"), [{ limit: 25, kind: "dj_break" }]);
  assert.equal(diagCalls(el, "detail").length, 0, "a record was read before a row was opened");
  assert.deepEqual(qa(el, "[data-diag-row]").map((b) => b.dataset.diagRow),
                   FIRST.items.map((i) => i.opportunity_id), "not the backend's rows in its order");
  assert.ok(byId(el, "diag-more"), "no way to older rows");
});

test("the compact list carries no script, and a closed row shows none", async () => {
  for (const e of EXCHANGES.filter((x) => x.kind === "list")) {
    for (const it of e.body.items) {
      assert.ok(!("smart_dj" in it) && !("aired_copy" in it) && !("pipeline" in it), e.name);
    }
    const blob = JSON.stringify(e.body);
    assert.ok(!blob.includes("raw_draft") && !blob.includes("final_text"), e.name);
  }
  const el = mount();
  await openSupport(el);
  assert.ok(outer(el, ".diag-list").length > 0);
  assert.ok(!outer(el, ".diag-list").includes("<blockquote"), "a script in a closed row");
  for (const words of ["went platinum", "That was Glory Box", "Teardrop carries"]) {
    assert.ok(!page(el).includes(words), words);
  }
});

// ===========================================================================
// 2. NULL IS UNKNOWN
// ===========================================================================
test("null is UNKNOWN: an expired row's delivery is never drawn as 'Not aired'", async () => {
  const el = mount();
  await openSupport(el);
  const expired = rowFor(el, idOf("expired"));
  assert.equal(record("expired").aired_to_room, null);
  assert.match(expired, /Airing UNKNOWN/);
  assert.doesNotMatch(expired, /Not aired/);
  assert.match(rowFor(el, idOf("silent")), /Airing UNKNOWN/);
  assert.match(rowFor(el, idOf("queue")), /Not aired/);
  assert.match(rowFor(el, idOf("news")), /Not aired/);
  // a live row is "In progress": planned, preparing, queued or on the air -- not "waiting"
  assert.match(rowFor(el, idOf("pending")), /In progress/);
  assert.doesNotMatch(rowFor(el, idOf("pending")), /[Ww]aiting/);
  assert.match(rowFor(el, idOf("accepted")), />Aired</);
  assert.match(rowFor(el, idOf("cut")), /Aired · cut short/);
  // DJ speech off records no obligations, and no planner decision named the songs
  const off = rowFor(el, idOf("speech_off"));
  assert.match(off, /Obligations not evaluated/);
  assert.equal((off.match(/diag-unknown">UNKNOWN</g) || []).length, 2, "the songs either side");
});

test("a stage that left no record says NOT RECORDED, and a silent planner rendered nothing", async () => {
  const el = mount();
  await openSupport(el);
  for (const n of ["silent", "expired"]) await openRow(el, idOf(n));
  const silent = oppOf(el, idOf("silent"));
  assert.equal((silent.match(/NOT RECORDED/g) || []).length, 3, "render, insert and completion");
  assert.match(silent, /Nothing was rendered: the planner stayed silent\./);
  assert.match(silent, /No draft: the model chose silence\./);
  const expired = oppOf(el, idOf("expired"));
  assert.match(expired, /Nothing refused it; whether it reached the room was not recorded/);
  // a stage with a recorded state and no detail is not a stage without a record
  assert.match(expired, /audio_ready<\/span><\/div>\s*<div class="diag-step-detail">No further detail was recorded\./);
  assert.match(expired, /diag-unknown">UNKNOWN</, "a delivery nobody recorded");
});

// ===========================================================================
// 3. THE RECORD, ON DEMAND
// ===========================================================================
test("opening a row reads its record once; closing and reopening reads nothing more", async () => {
  const el = mount();
  await openSupport(el);
  const id = idOf("genuine");
  await openRow(el, id);
  assert.deepEqual(diagCalls(el, "detail"), [{ opportunity_id: id }]);
  assert.equal(q(el, `[data-diag-row="${id}"]`).getAttribute("aria-expanded"), "true");
  const body = oppOf(el, id);
  assert.match(body, /Original Smart DJ draft/);
  assert.match(body, /Copy rendered for air/);
  assert.match(body, /That was Glory Box\. It's 10:10\. Here's Teardrop\./);
  assert.match(body, /Recorded when it was rendered: the delivery line says whether it aired\./);
  await openRow(el, id);
  assert.ok(!oppOf(el, id).includes("Original Smart DJ draft"), "closing left the record on show");
  await openRow(el, id);
  assert.equal(diagCalls(el, "detail").length, 1, "the record was read twice");
});

test("a span is marked only where it was recorded; otherwise NOT RECORDED, never guessed", async () => {
  const el = mount();
  await openSupport(el);
  for (const n of ["genuine", "guard", "bookkeeping", "accepted", "silent"]) await openRow(el, idOf(n));
  const g = oppOf(el, idOf("genuine"));
  assert.match(g, /<mark class="diag-mark">went platinum in 1994<\/mark>/);
  assert.match(g, /recorded in planner_decision\.claim/);
  const guard = oppOf(el, idOf("guard"));
  assert.match(guard, /NOT RECORDED/);
  assert.match(guard, /category only; the guard records no span/);
  assert.match(guard, /unauthorized_transition/);
  assert.ok(!guard.includes("<mark"), "a guard refusal marked words");
  const bk = oppOf(el, idOf("bookkeeping"));
  assert.match(bk, /NOT RECORDED/);
  assert.match(bk, /no span was recorded/);
  assert.ok(!bk.includes("<mark"), "words were found for a refusal that recorded none");
  for (const n of ["accepted", "silent"]) assert.ok(!oppOf(el, idOf(n)).includes("Offending words"), n);
});

test("recorded completion is told apart from what a floor said it used", async () => {
  const el = mount();
  await openSupport(el);
  for (const n of ["genuine", "bookkeeping", "calendar"]) await openRow(el, idOf(n));
  const g = oppOf(el, idOf("genuine"));
  assert.match(g, /in aired copy · coverage not recorded/);
  assert.match(g, /aired\.writer\.required_facts_used/);
  assert.match(g, /older record shape/);
  assert.doesNotMatch(g, /diag-cell ok">confirmed/, "a floor's own word drawn as a confirmed delivery");
  const b = oppOf(el, idOf("bookkeeping"));
  assert.match(b, /newer record shape/);
  assert.match(b, /diag-cell ok">confirmed</);
  assert.match(b, /diag-cell danger">not delivered</);
  assert.match(b, /completed\.delivered/);
  const c = oppOf(el, idOf("calendar"));
  assert.match(c, /\[calendar event\]/);
  assert.match(c, /event evt_882/);
  assert.match(c, /a calendar title was masked/);
});

test("no break token and no calendar title reaches the screen, open or closed", async () => {
  const el = mount();
  await openSupport(el);
  for (const it of FIRST.items.slice(0, 13)) await openRow(el, it.opportunity_id);
  assert.equal(diagCalls(el, "detail").length, 13);
  assert.equal(/\b[0-9a-f]{32}\b/.test(page(el)), false, "a 32-hex token on the screen");
  assert.ok(!page(el).includes("Hendersons"), "a calendar title on the screen");
  // no part of a token either: no `break_ref` in any answer, no "log ref" on the screen
  assert.ok(!JSON.stringify(EXCHANGES).includes("break_ref"), "an answer carries a token prefix");
  assert.ok(!page(el).includes("log ref"), "a token prefix on the screen");
  assert.ok(!/\/data\/|https?:\/\//.test(outer(el, ".diag")), "a path or a URL on the screen");
});

test("markup inside a record is text: escaped, never built", async () => {
  const id = idOf("genuine");
  const evil = clone(record("genuine"));
  evil.smart_dj.raw_draft = 'Before <img src=x onerror="alert(1)"> after';
  evil.rejection.offending_span = '<img src=x onerror="alert(1)">';
  evil.aired_copy.final_text = "<script>alert(2)</script> & more";
  evil.tracks.ending = "<b>bold</b>";
  evil.rejection.reason_code = '"><svg onload=alert(3)>';
  // and a draft with markup and no recorded span: the unmarked path
  const guardId = idOf("guard");
  const plain = clone(record("guard"));
  plain.smart_dj.raw_draft = 'Plain <iframe src="x"></iframe> draft';
  const el = mount({ answers: { "parlorwave_radio/broadcast_diagnostics_detail":
    (m) => (m.opportunity_id === id ? evil : m.opportunity_id === guardId ? plain : diagAnswer(m)) } });
  await openSupport(el);
  await openRow(el, id);
  await openRow(el, guardId);
  assert.ok(outer(el, ".diag").includes("Plain &lt;iframe src=&quot;x&quot;&gt;&lt;/iframe&gt; draft"));
  assert.equal(qa(el, "iframe").length, 0, "a draft built an element");
  el._diagInspect(id);             // the linked record draws its own header from the record
  await done();
  const html = outer(el, ".diag");
  for (const raw of ["<img src=x", "<script>alert", "<b>bold", "<svg onload"]) assert.ok(!html.includes(raw), raw);
  assert.ok(html.includes('<mark class="diag-mark">&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</mark>'));
  assert.ok(html.includes("&lt;script&gt;alert(2)&lt;/script&gt; &amp; more"));
  assert.ok(html.includes("&lt;b&gt;bold&lt;/b&gt;"));
});

// ===========================================================================
// 4. PAGES, FILTERS AND REFRESH ARE THE BACKEND'S
// ===========================================================================
test("Load older continues from the cursor, appends, and says where the history ends", async () => {
  const el = mount();
  await openSupport(el);
  await tap(byId(el, "diag-more"));
  const second = byName["all:2"].body;
  assert.deepEqual(lastList(el), { limit: 25, kind: "dj_break", before: FIRST.next_before });
  assert.equal(qa(el, "[data-diag-row]").length, FIRST.items.length + second.items.length);
  assert.ok(q(el, `[data-diag-row="${second.items[0].opportunity_id}"]`));
  assert.equal(byId(el, "diag-more"), null);
  assert.match(text(outer(el, ".diag")), second.scan.complete
    ? /That is everything the station still holds\./ : /Older history exists beyond what one read covers\./);
});

test("an outcome pill re-reads from the newest with that outcome; Not aired holds no UNKNOWN", async () => {
  const el = mount();
  await openSupport(el);
  await tap(q(el, '[data-diag-outcome="fallback"]'));
  assert.deepEqual(lastList(el), { limit: 25, kind: "dj_break", outcome: "fallback" });
  assert.equal(qa(el, "[data-diag-row]").length, byName["outcome=fallback:1"].body.items.length);
  assert.ok(qa(el, ".diag-badge").every((b) => b.textContent === "Fallback · floor"));
  assert.equal(q(el, ".diag-summary"), null, "a summary of a filtered list reads like a rate");
  assert.equal(q(el, '[data-diag-outcome="fallback"]').getAttribute("aria-pressed"), "true");
  await tap(q(el, '[data-diag-outcome="no_break_aired"]'));
  assert.ok(qa(el, "[data-diag-row]").length > 0);
  assert.ok(qa(el, ".diag-aired").every((t) => t.textContent === "Not aired"), "UNKNOWN counted as not aired");
  await tap(q(el, '[data-diag-outcome=""]'));
  assert.deepEqual(lastList(el), { limit: 25, kind: "dj_break" });
  assert.ok(q(el, ".diag-summary"));
});

test("a reason chip filters by the reason as listed, a scrubbed one included", async () => {
  const el = mount();
  await openSupport(el);
  await tap(q(el, '[data-diag-reason="guard_rejected"]'));
  assert.deepEqual(lastList(el), { limit: 25, kind: "dj_break", reason: "guard_rejected" });
  assert.equal(qa(el, "[data-diag-row]").length, byName["reason=guard_rejected:1"].body.items.length);
  await tap(byId(el, "diag-reason-clear"));
  assert.deepEqual(lastList(el), { limit: 25, kind: "dj_break" });
  const scrubbed = "stale_context: [redacted-path]";
  await tap(q(el, `[data-diag-reason="${scrubbed}"]`));
  const want = byName[`reason=${scrubbed}:1`].body.items.length;
  assert.ok(want > 0, "the backend found nothing for the reason it lists");
  assert.equal(qa(el, "[data-diag-row]").length, want);
});

test("the kind pills ask for news intros and announcements; a program says what it is", async () => {
  const el = mount();
  await openSupport(el);
  await tap(q(el, '[data-diag-kind="news_intro"]'));
  assert.deepEqual(lastList(el), { limit: 25, kind: "news_intro" });
  const rows = qa(el, "[data-diag-row]");
  assert.equal(rows.length, byName["kind=news_intro:1"].body.items.length);
  assert.ok(rows.length && rows.every((r) => /News intro/.test(r.outerHTML) && />Program</.test(r.outerHTML)));
  await tap(q(el, '[data-diag-kind="announcement"]'));
  assert.match(text(outer(el, ".diag")), /Nothing in the history read matches\./);
});

test("the history limit is stated, and a read that ran out says older history exists", async () => {
  const el = mount();
  await openSupport(el);
  const note = text(outer(el, ".diag-window"));
  assert.match(note, /Not the whole history\./);
  assert.match(note, /newest 8 MiB of the break record \(about five days\)/);
  assert.doesNotMatch(note, /reached the oldest|stopped at its limit/, "a full page described as the end of history");
  const part = mount({ answers: { "parlorwave_radio/broadcast_diagnostics_list": byName["partial:1"].body } });
  await openSupport(part);
  const said = text(outer(part, ".diag-window"));
  assert.match(said, /newest 16 KiB of the break record, and/);
  assert.doesNotMatch(said, /about five days/, "five days is the 8 MiB budget's reach, not this one's");
  assert.match(said, /stopped at its limit at Oct 26 · 2:10 PM: older history exists and was not read\./);
});

test("Refresh re-reads only the records on show, one after another, and closes rows it dropped", async () => {
  const el = mount();
  await openSupport(el);
  const near = idOf("genuine");
  await openRow(el, near);
  await tap(byId(el, "diag-more"));
  const far = byName["detail:accepted@oldest"].params.opportunity_id;   // on the second page
  assert.ok(byName["all:2"].body.items.some((i) => i.opportunity_id === far));
  await openRow(el, far);
  const before = diagCalls(el, "detail").length;
  await tap(byId(el, "diag-refresh"));
  await done();
  assert.deepEqual(diagCalls(el, "detail").slice(before), [{ opportunity_id: near }],
                   "a record off the first page was re-read");
  assert.equal(el._diagOpen.has(far), false);
});

test("a record read that Refresh overtook is dropped, not drawn over the newer one", async () => {
  const id = idOf("genuine");
  let release, first = true;
  const slow = new Promise((r) => { release = r; });
  const el = mount({ answers: { "parlorwave_radio/broadcast_diagnostics_detail": (m) => {
    if (m.opportunity_id === id && first) { first = false; return slow; }
    return diagAnswer(m);
  } } });
  await openSupport(el);
  await openRow(el, id);                       // the first read hangs
  await tap(byId(el, "diag-refresh"));         // the second answers at once
  const stale = clone(record("genuine"));
  stale.aired_copy.final_text = "AN OLDER ANSWER";
  release(stale);
  await done();
  assert.ok(!oppOf(el, id).includes("AN OLDER ANSWER"), "the overtaken read won");
  assert.match(oppOf(el, id), /That was Glory Box\. It's 10:10\. Here's Teardrop\./);
});

test("Inspect reads the record again every time: the break on the air is still changing", async () => {
  const id = idOf("pending");
  const el = mount();
  el._diagInspect(id);
  await done();
  el._diagInspect(id);
  await done();
  assert.deepEqual(diagCalls(el, "detail"), [{ opportunity_id: id }, { opportunity_id: id }]);
  assert.match(text(outer(el, "#diag-linked")), /it has not finished yet \(its row is still live\)/);
});

test("Inspect shows the record even before the installation's own answer has arrived", async () => {
  const el = mount({ seed: { _ready: null } });
  el._diagInspect(idOf("accepted"));
  await done();
  assert.match(page(el), /Reading this installation/, "not the waiting screen");
  assert.match(outer(el, "#diag-linked"), /That was Glory Box\. It's ten past ten\. Teardrop is next\./);
});

test("Refresh starts again from the newest and re-reads the records on show", async () => {
  const el = mount();
  await openSupport(el);
  const id = idOf("genuine");
  await openRow(el, id);
  await tap(byId(el, "diag-more"));
  await tap(byId(el, "diag-refresh"));
  assert.deepEqual(lastList(el), { limit: 25, kind: "dj_break" });
  assert.equal(qa(el, "[data-diag-row]").length, FIRST.items.length, "Refresh kept the older page");
  assert.equal(diagCalls(el, "detail").length, 2, "the open record was not re-read");
  assert.match(oppOf(el, id), /Original Smart DJ draft/);
});

test("an answer a newer read has overtaken is dropped", async () => {
  let release;
  const slow = new Promise((r) => { release = r; });
  const el = mount({ answers: { "parlorwave_radio/broadcast_diagnostics_list":
    (m) => (m.outcome === "fallback" ? slow : diagAnswer(m)) } });
  await openSupport(el);
  press(q(el, '[data-diag-outcome="fallback"]'));
  await tap(q(el, '[data-diag-outcome="accepted"]'));
  release(clone(byName["outcome=fallback:1"].body));
  await done();
  assert.equal(qa(el, "[data-diag-row]").length, byName["outcome=accepted:1"].body.items.length);
  assert.ok(qa(el, ".diag-badge").every((b) => b.textContent === "Accepted"), "the stale answer won");
});

test("a failed read is one settled sentence with Try again; no row is invented", async () => {
  let fail = true;
  const el = mount({ answers: { "parlorwave_radio/broadcast_diagnostics_list": (m) => (fail
    ? new Error("/dj/diagnostics/opportunities answered 500 at /data/x") : diagAnswer(m)) } });
  await openSupport(el);
  const card = text(outer(el, ".diag"));
  assert.match(card, /could not be read just now/);
  assert.doesNotMatch(card, /answered 500|\/data\//, "the service's own words on the screen");
  assert.equal(q(el, "[data-diag-row]"), null);
  fail = false;
  await tap(byId(el, "diag-retry"));
  assert.equal(qa(el, "[data-diag-row]").length, FIRST.items.length);
});

test("a service without diagnostics says so, and offers nothing it cannot read", async () => {
  const el = mount({ answers: { "parlorwave_radio/broadcast_diagnostics_list": { ok: false, reason: "unsupported" } } });
  await openSupport(el);
  assert.match(text(outer(el, ".diag")), /does not provide broadcast diagnostics/);
  assert.equal(q(el, "[data-diag-row]"), null);
  assert.equal(q(el, ".diag-window"), null);
});

// ===========================================================================
// 5. FROM ON AIR, BY THE PUBLIC ID
// ===========================================================================
test("Inspect on the Air Check opens Settings, support details and that break's record", tracking(async () => {
  const id = idOf("calendar");
  const el = mount({ view: "onair", djAttrs: AIR(id) });
  const link = q(el, `[data-diag-inspect="${id}"]`);
  assert.ok(link, "no Inspect on the Air Check");
  assert.match(link.textContent, /Inspect in diagnostics/);
  await tap(link);
  assert.equal(el._view, "settings");
  assert.equal(el._readyAdvanced, true);
  assert.deepEqual(diagCalls(el, "detail"), [{ opportunity_id: id }]);
  assert.equal(diagCalls(el, "list").length, 1);
  const linked = outer(el, "#diag-linked");
  assert.match(linked, /Opened from On Air/);
  assert.match(linked, /\[calendar event\]/);
  assert.equal((root(el).activeElement || {}).id, "diag-linked", "the record was not brought into view");
  await tap(byId(el, "diag-linked-close"));
  assert.equal(byId(el, "diag-linked"), null);
}));

test("Break History offers Inspect for DJ breaks, intros and announcements, never a bulletin", async () => {
  const older = byName["detail:accepted@oldest"].params.opportunity_id;
  assert.ok(!FIRST.items.some((i) => i.opportunity_id === older), "the older break is on the first page");
  const history = [
    { type: "dj_break", id: older, at: "2026-10-26T10:04:50", text: "That was Glory Box." },
    { type: "news_bulletin", id: "aaaaaaaaaaaaaaaa", at: "2026-10-26T10:00:00", text: "News" },
    { type: "news_intro", id: idOf("intro"), at: "2026-10-26T15:38:30", text: "Here's the news." },
    { type: "announcement", id: "bbbbbbbbbbbbbbbb", at: "2026-10-26T09:00:00", text: "Dinner is ready." }];
  const el = mount({ view: "onair", djAttrs: AIR(idOf("accepted")),
                     seed: { _historyOpen: true, _history: { at: NOW, data: { ok: true, history } } } });
  for (const id of [older, idOf("intro"), "bbbbbbbbbbbbbbbb"]) assert.ok(q(el, `[data-diag-inspect="${id}"]`), id);
  assert.equal(q(el, '[data-diag-inspect="aaaaaaaaaaaaaaaa"]'), null, "a bulletin is not a DJ opportunity");
  await tap(q(el, `[data-diag-inspect="${older}"]`));
  assert.deepEqual(diagCalls(el, "detail"), [{ opportunity_id: older }]);
  assert.match(outer(el, "#diag-linked"), /That was Glory Box\. It's ten past ten\. Teardrop is next\./,
               "a break outside the loaded page was not found by its id");
});

test("an id the history does not hold is 'not in the history read', never 'did not air'", async () => {
  const el = mount();
  el._diagInspect("0123456789abcdef");
  await done();
  const linked = text(outer(el, "#diag-linked"));
  assert.match(linked, /No record of #01234567 in the history read\./);
  assert.match(linked, /That is not evidence that it did not air\./);
  assert.doesNotMatch(linked, /Not aired/);
});

test("someone who is not an administrator is offered no door and causes no read", async () => {
  for (const user of [{ name: "Guest", is_admin: false }, null]) {
    const el = mount({ user });
    await openSupport(el);
    assert.equal(el.calls.filter((c) => /broadcast_diagnostics/.test(c.ws || "")).length, 0);
    assert.match(text(outer(el, ".diag")), /For Home Assistant administrators/);
    const air = mount({ view: "onair", user, djAttrs: AIR(idOf("accepted")) });
    assert.equal(q(air, "[data-diag-inspect]"), null, "an Inspect door for a non-administrator");
  }
});

test("with the card open and rows expanded, every id is drawn once", async () => {
  const el = mount();
  await openSupport(el);
  for (const n of ["genuine", "guard", "calendar"]) await openRow(el, idOf(n));
  el._diagInspect(idOf("cut"));
  await done();
  const ids = [...page(el).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids.filter((x, i) => ids.indexOf(x) !== i), []);
});

test("no completion threw, and every request was one the backend was asked", async () => {
  await done();
  assert.deepEqual(unhandled.map(String), [], "a render threw inside a fetch completion");
  assert.deepEqual(unrecorded, [], "the panel asked something the backend never answered");
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
process.stdout.write(`\n${passed}/${tests.length} Broadcast Diagnostics panel tests passed\n`);
