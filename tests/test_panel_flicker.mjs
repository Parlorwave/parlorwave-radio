/* The On Air flicker, EXECUTED.
 *
 * Home Assistant hands a panel a NEW hass object on every state change in
 * the home -- a power sensor, a light, anything -- and every one used to
 * rebuild this panel's whole shadow tree. Under a pointer that never
 * moved, the knob lost and re-ran its hover glow and its tooltip; the On
 * Air lamps restarted their pulse; the emblem was a new image. Separately,
 * the Queue drawer's 30 s re-read and the Lyrics drawer's re-read at each
 * track change drew a one-line "Reading..." / "Fetching..." in the
 * drawer's place, and the console below it jumped up the page and back.
 *
 * Pinned here:
 *   - an update that changes nothing on show KEEPS the tree: no rewrite,
 *     no rebinding, no second observer, the clock-driven spots painted;
 *   - anything on show that changed, a pending focus move, or any write to
 *     the screen made since the last render (a knob face turned by hand)
 *     still REBUILDS, as before;
 *   - the clock-driven spots (progress bar, its clock, the synced lyric,
 *     relative times) are the only writes that are not news;
 *   - without a MutationObserver nothing is kept (the old behaviour);
 *   - the Queue keeps its rows while they are re-read; the Lyrics drawer
 *     keeps its height while the next song's lyrics load.
 *
 * The visible effect needs a browser to see; this file has no layout
 * engine.
 *
 *   node ha/tests/test_panel_flicker.mjs      (or scripts/test_panel.sh)
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL = join(HERE, "..", "custom_components", "parlorwave_radio",
                   "panel", "parlorwave-radio-panel.js");

// --- a host that counts tree writes and can show a MutationObserver -------
class ClassList {
  constructor(...c) { this._s = new Set(c); }
  add(c) { this._s.add(c); }
  remove(c) { this._s.delete(c); }
  contains(c) { return this._s.has(c); }
  toggle(c, f) { const on = f === undefined ? !this._s.has(c) : !!f; if (on) this._s.add(c); else this._s.delete(c); return on; }
}
class FakeEl {
  constructor(id = null, parent = null, ...cls) {
    this.id = id; this.parentElement = parent; this.nodeType = 1; this.isConnected = true;
    this.classList = new ClassList(...cls);
    this.dataset = {}; this.attrs = {}; this.textContent = "";
    this.style = { width: "", setProperty() {}, removeProperty() {}, getPropertyValue() { return ""; } };
    this._html = ""; this.htmlWrites = 0;
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = v; this.htmlWrites++; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener() {}
  removeEventListener() {}
}
class FakeRoot extends FakeEl {
  constructor() { super(); this.byId = {}; this.agos = []; }
  set innerHTML(v) {
    // the first write builds the persistent #pw-app; later renders write into it
    this._html = v; this.htmlWrites++;
    if (v.includes('id="pw-app"') && !this.byId["pw-app"]) this.byId["pw-app"] = new FakeEl("pw-app", null);
  }
  get innerHTML() { return this._html; }
  getElementById(id) { return this.byId[id] || null; }
  querySelector() { return null; }
  querySelectorAll(sel) { return sel === ".pw-ago" ? this.agos : []; }
}
globalThis.HTMLElement = class {
  constructor() { this.style = { setProperty() {}, removeProperty() {}, getPropertyValue() { return ""; } }; }
  attachShadow() { this.shadowRoot = new FakeRoot(); return this.shadowRoot; }
};
class FakeMO {
  constructor(cb) { this.cb = cb; this.queue = []; this.targets = []; FakeMO.made++; FakeMO.last = this; }
  observe(t) { this.targets.push(t); }
  disconnect() { this.targets = []; }
  takeRecords() { const q = this.queue; this.queue = []; return q; }
}
FakeMO.made = 0;
let PanelClass = null;
globalThis.customElements = { get: () => undefined, define: (_n, c) => { PanelClass = c; } };
await import(PANEL);
assert.ok(PanelClass, "the panel did not register its custom element");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const states = (extra = {}, dj = "waiting") => ({
  "switch.dj": { entity_id: "switch.dj", state: "on", attributes: {} },
  "sensor.dj": { entity_id: "sensor.dj", state: dj, attributes: { enabled: true } },
  "select.out": { entity_id: "select.out", state: "Den", attributes: { output_entity_id: "media_player.den" } },
  "media_player.den": { entity_id: "media_player.den", state: "playing",
    attributes: { friendly_name: "Den", media_title: "Lost Bells", media_artist: "Cold Orchard" } },
  "sensor.now": { entity_id: "sensor.now", state: "playing",
    attributes: { kind: "music", title: "Lost Bells", artist: "Cold Orchard", state: "playing" } },
  ...extra,
});
const hassOf = (s) => ({ states: s, callService: () => Promise.resolve(), callWS: () => Promise.resolve({}) });

/* A panel on On Air with its entities known, counting the post-render steps
 * a kept tree must not run again. */
function mount({ observer = true } = {}) {
  if (observer) globalThis.MutationObserver = FakeMO; else delete globalThis.MutationObserver;
  const el = new PanelClass();
  el._entityMap = { dj_enabled: "switch.dj", dj_status: "sensor.dj", now_playing: "sensor.now", output: "select.out" };
  el._entitiesLoading = true;          // no websocket: the map is given
  el._voiceLib = {};
  el._maybeRefreshDemandData = () => {};
  el.binds = 0;
  const bind = el._bindKnobControls.bind(el);
  el._bindKnobControls = () => { el.binds++; return bind(); };
  el.hass = hassOf(states());
  return el;
}
const app = (el) => el.shadowRoot.getElementById("pw-app");
const writes = (el) => el.shadowRoot.htmlWrites + (app(el) ? app(el).htmlWrites : 0);
const unrelated = (el, n) => { el.hass = hassOf(states({ "sensor.power": { entity_id: "sensor.power", state: String(n), attributes: {} } })); };

// ======================================================================
// 1. AN UPDATE THAT CHANGES NOTHING ON SHOW KEEPS THE TREE
// ======================================================================
test("unrelated hass updates keep the tree: no rewrite, no rebinding", () => {
  const el = mount();
  const w = writes(el), b = el.binds;
  for (let i = 0; i < 20; i++) unrelated(el, i);
  assert.equal(writes(el), w, "an update that changed nothing on show rewrote the tree");
  assert.equal(el.binds, b, "a kept tree was bound a second time (duplicate listeners)");
});

test("one observer for the panel's life, however many renders", () => {
  const before = FakeMO.made;
  const el = mount();
  for (let i = 0; i < 5; i++) { unrelated(el, i); el.hass = hassOf(states({}, i % 2 ? "on_air" : "waiting")); }
  assert.equal(FakeMO.made - before, 1);
});

test("a kept tree still has its clock-driven spots painted", () => {
  const el = mount();
  const root = el.shadowRoot;
  el._progress = () => ({ pos: 61, duration: 240 });
  unrelated(el, 0);                    // the bar appearing is a change: one rebuild
  const w = writes(el);
  root.byId["progress-clock"] = new FakeEl("progress-clock", app(el));
  root.byId["progress-fill"] = new FakeEl("progress-fill", app(el));
  unrelated(el, 1);
  assert.equal(writes(el), w, "the tree was rewritten");
  assert.equal(root.byId["progress-clock"].textContent, "1:01 / 4:00");
  assert.equal(root.byId["progress-fill"].style.width, "25.42%");
});

// ======================================================================
// 2. WHAT STILL REBUILDS
// ======================================================================
test("a change on show rebuilds (the DJ starts speaking)", () => {
  const el = mount();
  const w = writes(el);
  el.hass = hassOf(states({}, "on_air"));
  assert.equal(writes(el), w + 1);
});

test("a write to the screen since the last render is put right by the next update", () => {
  const el = mount();
  const w = writes(el);
  const face = new FakeEl(null, new FakeEl("dj-switch", app(el)), "dj-face");
  FakeMO.last.queue.push({ type: "attributes", attributeName: "style", target: face });
  unrelated(el, 1);
  assert.equal(writes(el), w + 1, "a hand-turned knob face was left showing after an update");
  unrelated(el, 2);
  assert.equal(writes(el), w + 1, "the rebuilt tree was not settled");
});

test("a change delivered by the observer itself also marks the tree", () => {
  const el = mount();
  const w = writes(el);
  el._treeDirtyCheck({ type: "childList", target: app(el) });
  unrelated(el, 1);
  assert.equal(writes(el), w + 1);
});

test("the clock-driven spots are not news: progress, its clock, the lyric pane, relative times", () => {
  const el = mount();
  const w = writes(el);
  const lines = new FakeEl("lyric-lines", app(el));
  const ago = new FakeEl(null, new FakeEl(null, app(el)), "pw-ago");
  for (const target of [new FakeEl("progress-fill", app(el)), new FakeEl("progress-clock", app(el)),
                        new FakeEl(null, lines, "lyric"), ago,
                        { nodeType: 3, parentElement: ago }]) {
    FakeMO.last.queue.push({ type: "attributes", target });
  }
  unrelated(el, 1);
  assert.equal(writes(el), w);
});

test("a pending focus move is never skipped", () => {
  const el = mount();
  const w = writes(el);
  el._focusNext = { id: "drawer-queue" };
  unrelated(el, 1);
  assert.equal(writes(el), w + 1);
});

test("without a MutationObserver nothing is kept: every update rebuilds, as before", () => {
  const el = mount({ observer: false });
  const w = writes(el);
  unrelated(el, 1); unrelated(el, 2);
  assert.equal(writes(el), w + 2);
  globalThis.MutationObserver = FakeMO;
});

// ======================================================================
// 3. THE RENDER KEY
// ======================================================================
test("the key ignores the clock-driven values and nothing else", () => {
  const el = mount();
  const a = `<div id="progress-fill" style="width:13.15%"></div><span id="progress-clock" class="progress-clock">0:32 / 4:00</span>`
          + `<span class="pw-ago" data-at="2026-01-15T15:00:00">2 min ago</span><b>Song 1</b>`;
  const b = a.replace("13.15%", "14.00%").replace("0:32", "0:34").replace("2 min ago", "3 min ago");
  assert.equal(el._treeKey(a), el._treeKey(b));
  assert.notEqual(el._treeKey(a), el._treeKey(b.replace("Song 1", "Song 2")));
  assert.notEqual(el._treeKey(a), el._treeKey(a.replace('data-at="2026-01-15T15:00:00"', 'data-at="2026-01-15T15:05:00"')));
});

test("a relative time is live text the ticker keeps true", () => {
  const el = mount();
  const iso = new Date(Date.now() - 61000).toISOString();
  const html = el._liveAgo(iso);
  assert.match(html, /^<span class="pw-ago" data-at="[^"]+">1 min ago<\/span>$/);
  const span = new FakeEl(null, app(el), "pw-ago");
  span.attrs["data-at"] = new Date(Date.now() - 181000).toISOString();
  span.textContent = "1 min ago";
  el.shadowRoot.agos = [span];
  el._paintLive();
  assert.equal(span.textContent, "3 min ago");
});

// ======================================================================
// 4. THE DRAWERS KEEP THEIR PLACE
// ======================================================================
const QDATA = { ok: true, complete: true, current: { kind: "music", title: "One", artist: "A", duration_s: 200 },
                recent: [], upcoming: [{ kind: "music", title: "Two", artist: "B", duration_s: 210 }] };

test("the Queue keeps its rows while they are re-read", () => {
  const el = mount();
  el._queue = { at: Date.now() - 31000, data: QDATA };
  el._hass.callWS = () => new Promise(() => {});      // the re-read is still out
  el._fetchQueue();
  assert.equal(el._queue.loading, true);
  assert.equal(el._queue.standIn, true);
  const html = el._renderQueue();
  assert.doesNotMatch(html, /Reading the queue/);
  assert.match(html, /Two/);
});

test("the Queue does not present old rows as current, nor rows it never had", () => {
  const el = mount();
  el._hass.callWS = () => new Promise(() => {});
  el._queue = { at: Date.now() - 10 * 60000, data: QDATA };
  el._fetchQueue();
  assert.equal(el._queue.standIn, false);
  assert.match(el._renderQueue(), /Reading the queue/);
  el._queue = null;
  el._fetchQueue();
  assert.equal(el._queue.standIn, false);
  assert.match(el._renderQueue(), /Reading the queue/);
});

test("the answer replaces the stand-in", async () => {
  const el = mount();
  const fresh = { ...QDATA, upcoming: [{ kind: "music", title: "Three", artist: "C", duration_s: 180 }] };
  el._queue = { at: Date.now() - 31000, data: QDATA };
  el._hass.callWS = () => Promise.resolve(fresh);
  await el._fetchQueue();
  assert.equal(el._queue.loading, undefined);
  assert.match(el._renderQueue(), /Three/);
  assert.doesNotMatch(el._renderQueue(), /Two/);
});

test("the Lyrics drawer keeps its height while the next song's lyrics load", () => {
  const el = mount();
  el._lyrics = { forUri: "library://track/2", loading: true };
  el._lyricHoldPx = 341;
  assert.match(el._renderLyrics(), /<div class="drawer" style="box-sizing:border-box;min-height:341px">/);
  el._lyricHoldPx = 0;
  assert.match(el._renderLyrics(), /^<div class="drawer"><div class="hint">Fetching lyrics/);
});

test("the height held is the lyric pane's drawer, measured before the read", async () => {
  const el = mount();
  const drawer = new FakeEl(null, app(el), "drawer"); drawer.offsetHeight = 341;
  const pane = new FakeEl(null, drawer, "lyrics"); pane.closest = (s) => (s === ".drawer" ? drawer : null);
  el.shadowRoot.querySelector = (s) => (s === ".lyrics" ? pane : null);
  el._drawer = "lyrics";
  el._hass.callWS = () => new Promise(() => {});      // the read never answers: we look mid-read
  el._fetchLyrics();
  assert.equal(el._lyricHoldPx, 341);
  assert.equal(el._lyrics.loading, true);
});

// ======================================================================
// 7. A PANEL TAKEN OFF THE PAGE AND PUT BACK REBUILDS ONCE
// ======================================================================
// disconnectedCallback stops the Mouth and drops the knobs' window
// listeners; only a render's post-write steps start them again. The first
// update after a reconnect must therefore rebuild even when nothing on show
// changed, or the console comes back with a still Mouth and dead knob drags.
test("the first update after a reconnect rebuilds; later ones keep the tree", () => {
  const w0 = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  let el = null;
  try {
    el = mount();
    unrelated(el, 1);
    let starts = 0;
    const start = el._mouthStart.bind(el);
    el._mouthStart = () => { starts++; return start(); };
    el.disconnectedCallback();
    el.connectedCallback();
    clearInterval(el._ticker);
    const w = writes(el), b = el.binds;
    unrelated(el, 2);
    assert.equal(writes(el), w + 1, "the first update after a reconnect kept a stopped tree");
    assert.equal(el.binds, b + 1, "the knobs were not bound again after a reconnect");
    assert.equal(starts, 1, "the Mouth was not started again after a reconnect");
    unrelated(el, 3);
    assert.equal(writes(el), w + 1, "a later update that changed nothing rewrote the tree");
  } finally {
    if (el) el.disconnectedCallback();      // no timer may outlive the test
    if (w0 === undefined) delete globalThis.window; else globalThis.window = w0;
  }
});

// ----------------------------------------------------------------------
for (const [name, fn] of tests) {
  try { await fn(); passed++; }
  catch (e) { console.error(`FAIL: ${name}\n  ${e && e.stack || e}`); process.exitCode = 1; }
}
console.log(`${passed}/${tests.length} panel flicker tests passed`);
