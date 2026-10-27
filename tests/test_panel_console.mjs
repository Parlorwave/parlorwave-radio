/* The Broadcast Console, EXECUTED.
 *
 * The DJ control, the Mouth and the Air Check, driven the way the browser
 * drives them -- a real instance, the real methods, a fake page whose frame
 * clock and visibility are under the test's control. Three families:
 *
 *   1. the DJ control lights only for the CONFIRMED state, is honestly
 *      pending while a press is with the backend, and never turns red;
 *   2. the Mouth's state is the lifecycle's truth -- DJ enabled is not a voice, a
 *      spent break is not a voice -- and its loop is one, throttled,
 *      suspended when hidden, cancelled on teardown, and blind to the
 *      backend;
 *   3. the Air Check sits on the console and shows what the engine says.
 *
 *   node ha/tests/test_panel_console.mjs        (or scripts/test_panel.sh)
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL = join(HERE, "..", "custom_components", "parlorwave_radio",
                   "panel", "parlorwave-radio-panel.js");

// --- the smallest host the console needs ------------------------------------
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
    this.innerHTML = "";
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

/* THE PAGE: visibility and its listeners, counted. */
const doc = {
  visibilityState: "visible",
  _l: {},
  addEventListener(t, fn) { (this._l[t] ||= []).push(fn); },
  removeEventListener(t, fn) { this._l[t] = (this._l[t] || []).filter((f) => f !== fn); },
  dispatch(t) { for (const fn of [...(this._l[t] || [])]) fn({}); },
  listeners(t) { return (this._l[t] || []).length; },
};
globalThis.document = doc;
globalThis.window = { addEventListener() {}, removeEventListener() {}, matchMedia: undefined };
// the panel's 1 s progress ticker would keep node alive: it is not the point here
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
/* THE FRAME CLOCK: nothing runs unless the test pumps it. */
const frames = { queue: [], next: 1, cancelled: [] };
globalThis.requestAnimationFrame = (cb) => { const id = frames.next++; frames.queue.push({ id, cb }); return id; };
globalThis.cancelAnimationFrame = (id) => { frames.cancelled.push(id); frames.queue = frames.queue.filter((f) => f.id !== id); };
function pump(ts) { const q = frames.queue; frames.queue = []; for (const f of q) f.cb(ts); }
function pending() { return frames.queue.length; }
function resetFrames() { frames.queue = []; frames.cancelled = []; }

const mod = await import(PANEL);
const { PW_MOUTH } = mod;
assert.ok(PanelClass, "the panel did not register its custom element");
const SRC = readFileSync(PANEL, "utf8");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* A canvas that records what is drawn on it. */
function canvas(w = 600, h = 76) {
  const ctx = {
    calls: [], fillStyle: "", globalAlpha: 1, draws: 0, rects: [],
    clearRect() { this.draws++; },
    fillRect() {},
    beginPath() {}, fill() {},
    roundRect(x, y, w, h) { this.rects.push({ h, fill: this.fillStyle, alpha: this.globalAlpha }); },
  };
  return { clientWidth: w, clientHeight: h, width: 0, height: 0, getContext: () => ctx, ctx };
}

function station({ dj = "on", status = "waiting", djAttrs = {}, card = null,
                   player = "playing" } = {}) {
  const el = new PanelClass();
  el._render = () => {};
  el.writes = [];
  el._entityMap = { dj_enabled: "switch.dj", dj_status: "sensor.dj",
                    now_playing: "sensor.now", output: "select.out" };
  el._hass = {
    states: {
      "switch.dj": { entity_id: "switch.dj", state: dj, attributes: {} },
      "sensor.dj": { state: status, attributes: { enabled: dj === "on", ...djAttrs } },
      "select.out": { entity_id: "select.out", state: "Den",
                      attributes: { output_entity_id: "media_player.den", options: ["Den", "Kitchen"] } },
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
const ROUTE_ONLY = { kind: "music", title: "DJ break", artist: "ParlorWave Radio", state: "playing" };
const RED = ["#ff4133", "rgba(255,65,51", "#ff6a5c", "--pw-lamp", "#ff5346"];

const djHtml = (el) => el._renderDjSwitch(el._dj, el._broadcastState());
const SR = /const SR_REGIONS = `([\s\S]*?)`;/.exec(SRC)[1];
const cls = (html) => /class="dj-switch([^"]*)"/.exec(html)[1].trim();
const tick = () => new Promise((r) => setTimeout(r, 0));

// ======================================================================
// 1. THE DJ CONTROL
// ======================================================================
test("backend-confirmed enabled is illuminated", () => {
  const html = djHtml(station({ dj: "on", card: MUSIC }));
  assert.equal(cls(html), "on");
  assert.ok(html.includes('aria-checked="true"') && html.includes("DJ ON"));
  assert.ok(html.includes("Between-song DJ enabled"));
});

test("backend-confirmed disabled is dark", () => {
  const html = djHtml(station({ dj: "off", card: MUSIC }));
  assert.equal(cls(html), "off");
  assert.ok(html.includes('aria-checked="false"') && html.includes("DJ OFF"));
  assert.ok(!html.includes('aria-busy="true"'));
});

test("a pending enable does NOT show confirmed ON before the state arrives", () => {
  const el = station({ dj: "off", card: MUSIC });
  el._hass.callService = () => new Promise(() => {});      // with the backend, forever
  el._toggle(el._dj);
  const html = djHtml(el);
  assert.equal(cls(html), "off pending", "the light must stay where it was confirmed");
  assert.ok(html.includes('aria-checked="false"'), "the switch state is the confirmed one");
  assert.ok(html.includes('aria-busy="true"') && html.includes("disabled"));
  assert.ok(html.includes("Switching on"));
  assert.equal(el.writes.length, 0, "the fake was replaced; nothing else was written");
});

test("a pending disable keeps the light ON until the backend says otherwise", () => {
  const el = station({ dj: "on", card: MUSIC });
  el._hass.callService = () => new Promise(() => {});
  el._toggle(el._dj);
  const html = djHtml(el);
  assert.equal(cls(html), "on pending");
  assert.ok(html.includes('aria-checked="true"') && html.includes("Switching off"));
});

test("a refused press returns to the authoritative state, with the refusal shown", async () => {
  const el = station({ dj: "off", card: MUSIC });
  el._hass.callService = () => Promise.reject(new Error("Service refused"));
  el._toggle(el._dj);
  assert.equal(cls(djHtml(el)), "off pending");
  await tick(); await tick();
  assert.equal(el._busy, null);
  assert.equal(cls(djHtml(el)), "off", "nothing optimistic survived the refusal");
  assert.ok(el._notice && el._notice.ok === false && /refused/.test(el._notice.text),
            "the existing error pattern carries the reason");
});

test("a successful press still waits for the entity: no ON until hass says ON", async () => {
  const el = station({ dj: "off", card: MUSIC });
  el._toggle(el._dj);                                        // resolves at once
  await tick(); await tick();
  assert.equal(el._busy, null);
  const c = cls(djHtml(el));
  assert.ok(c.startsWith("off"), "the service returned; the state has not");
  assert.ok(c.includes("pending"), "and the knob is still waiting for the entity");
  el._hass.states["switch.dj"].state = "on";                 // the update arrives
  assert.equal(cls(djHtml(el)), "on");
});

test("the enabled state uses no red, in markup or in style", () => {
  const html = djHtml(station({ dj: "on", card: MUSIC }));
  const css = SRC.slice(SRC.indexOf(".dj-switch {"), SRC.indexOf("/* --- the Mouth"));
  for (const r of RED) {
    assert.ok(!html.includes(r), r);
    assert.ok(!css.includes(r), r);
  }
  assert.ok(css.includes("240,162,74"), "amber");
});

test("an unavailable DJ is disabled and never assumed on", () => {
  const el = station({ dj: "unavailable", card: MUSIC });
  const html = djHtml(el);
  assert.ok(html.includes("DJ unavailable") && html.includes("disabled"));
  assert.ok(html.includes('aria-checked="false"'));
  const none = station({ card: MUSIC });
  delete none._hass.states["switch.dj"];
  assert.ok(djHtml(none).includes("DJ unavailable"));
});

test("before its entity map is read the DJ control says connecting, not that the service stopped answering", () => {
  const el = station({ card: MUSIC });
  el._entityMap = null;                    // first paint, or HA rebuilt a hidden panel
  const html = djHtml(el);
  assert.ok(html.includes("Connecting to ParlorWave Radio…"), html);
  assert.ok(!html.includes("not answering"), "a panel still loading claims the service is down");
  assert.ok(html.includes("disabled") && html.includes('aria-checked="false"'), "never assumed on");
  const gone = station({ dj: "unavailable", card: MUSIC });
  assert.ok(djHtml(gone).includes("ParlorWave Radio is not answering."), "a real outage still says so");
});

test("it is a keyboard-operable switch on one write path", () => {
  const html = djHtml(station({ card: MUSIC }));
  assert.ok(/<button[^>]*id="dj-switch"/.test(html));
  assert.ok(html.includes('role="switch"') && html.includes('aria-label="Between-song DJ"'));
  assert.ok(SRC.includes('on("dj-switch", () => this._toggle(this._dj));'));
  const el = station({ dj: "off", card: MUSIC });
  el._toggle(el._dj);
  assert.deepEqual(el.writes.map((w) => w.slice(0, 3)),
                   [["service", "switch", "turn_on"]]);
});

// ======================================================================
// 2. THE MOUTH'S STATE IS THE LIFECYCLE'S TRUTH
// ======================================================================
const mode = (opts) => station(opts)._mouthState().mode;
const { MOUTH_MUSIC, MOUTH_PROGRAM_VOICE, MOUTH_IDLE } = PW_MOUTH;

test("music + DJ enabled is MUSIC, never PROGRAM_VOICE", () => {
  assert.equal(mode({ dj: "on", status: "waiting", card: MUSIC }), MOUTH_MUSIC);
});
test("music + DJ disabled is MUSIC", () => {
  assert.equal(mode({ dj: "off", status: "off", card: MUSIC }), MOUTH_MUSIC);
});
test("a DJ break with lifecycle airing is PROGRAM_VOICE", () => {
  assert.equal(mode({ status: "on_air", card: DJ_AIRING }), MOUTH_PROGRAM_VOICE);
  // and the engine's status alone is enough, as it is for the state line
  assert.equal(mode({ status: "on_air", card: MUSIC }), MOUTH_PROGRAM_VOICE);
});
test("a bulletin with lifecycle airing is PROGRAM_VOICE", () => {
  assert.equal(mode({ status: "waiting", card: NEWS_AIRING }), MOUTH_PROGRAM_VOICE);
});
test("a spent break under the play head is MUSIC, not PROGRAM_VOICE", () => {
  assert.equal(mode({ dj: "on", status: "waiting", card: DJ_SPENT }), MOUTH_MUSIC);
  assert.equal(mode({ dj: "on", status: "waiting", card: { ...DJ_SPENT, lifecycle: "unknown" } }), MOUTH_MUSIC);
});
test("a route-shaped item the backend did not claim is not PROGRAM_VOICE", () => {
  assert.equal(mode({ dj: "on", status: "waiting", card: ROUTE_ONLY }), MOUTH_MUSIC);
  assert.equal(mode({ dj: "on", status: "waiting", card: { kind: "dj", title: "DJ break", state: "playing" } }), MOUTH_MUSIC);
});
test("idle playback is IDLE, and a paused voice is not speaking", () => {
  assert.equal(mode({ player: "idle", card: { ...MUSIC, state: "idle" } }), MOUTH_IDLE);
  assert.equal(mode({ player: "paused", card: { ...MUSIC, state: "paused" } }), MOUTH_IDLE);
  assert.equal(mode({ status: "on_air", player: "paused", card: DJ_AIRING }), MOUTH_IDLE);
});
test("the Mouth and the state line can never disagree", () => {
  for (const opts of [{ card: MUSIC }, { status: "on_air", card: DJ_AIRING },
                      { card: NEWS_AIRING }, { card: DJ_SPENT }, { player: "idle", card: { ...MUSIC, state: "idle" } }]) {
    const el = station(opts);
    const lamp = !!el._broadcastState().lamp;
    assert.equal(el._mouthState().mode === MOUTH_PROGRAM_VOICE, lamp, JSON.stringify(opts));
  }
});

// ======================================================================
// 3. THE PROCEDURAL SHAPE
// ======================================================================
const { mouthOpening, MOUTH_STILL, MOUTH_FRAME_MS } = PW_MOUTH;
const sample = (m, x = 0) => Array.from({ length: 600 }, (_, i) => mouthOpening(m, i / 30, x));
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

test("every opening is within 0..1, for every state, position and time", () => {
  for (const m of [MOUTH_MUSIC, MOUTH_PROGRAM_VOICE, MOUTH_IDLE]) {
    for (const x of [-1, -0.5, 0, 0.5, 1]) {
      for (const v of sample(m, x)) assert.ok(v >= 0 && v <= 1, `${m} ${x} ${v}`);
    }
  }
});
test("speech is more open than music, and idle is a resting line", () => {
  assert.ok(mean(sample(MOUTH_PROGRAM_VOICE)) > mean(sample(MOUTH_MUSIC)) + 0.15);
  assert.ok(mean(sample(MOUTH_MUSIC)) > mean(sample(MOUTH_IDLE)) + 0.1);
  assert.ok(sample(MOUTH_IDLE).every((v) => v === 0.06));
});
test("deterministic: the same instant draws the same picture", () => {
  assert.equal(mouthOpening(MOUTH_PROGRAM_VOICE, 4.321, 0.3), mouthOpening(MOUTH_PROGRAM_VOICE, 4.321, 0.3));
  assert.equal(mouthOpening(MOUTH_MUSIC, 9.87, -0.7), mouthOpening(MOUTH_MUSIC, 9.87, -0.7));
});
test("no flashing: no frame moves a segment by more than a bounded step", () => {
  for (const m of [MOUTH_MUSIC, MOUTH_PROGRAM_VOICE]) {
    for (const x of [-0.8, 0, 0.8]) {
      const s = sample(m, x);
      let worst = 0;
      for (let i = 1; i < s.length; i++) worst = Math.max(worst, Math.abs(s[i] - s[i - 1]));
      assert.ok(worst < 0.4, `${m} at ${x}: a ${worst.toFixed(2)} jump between frames`);
    }
  }
});
test("the still pictures are three distinct sizes in the right order", () => {
  assert.ok(MOUTH_STILL[MOUTH_IDLE] < MOUTH_STILL[MOUTH_MUSIC]);
  assert.ok(MOUTH_STILL[MOUTH_MUSIC] < MOUTH_STILL[MOUTH_PROGRAM_VOICE]);
});

// ======================================================================
// 4. THE LOOP: ONE, THROTTLED, SUSPENDED, CANCELLED, BLIND
// ======================================================================
function mounted(opts) {
  resetFrames();
  const el = station(opts);
  const c = canvas();
  el.shadowRoot._byId.mouth = c;
  el.connectedCallback();
  el._mouthStart();                          // what _render does last
  return { el, c };
}

test("starting the display queues exactly one frame", () => {
  const { el, c } = mounted({ card: MUSIC });
  assert.equal(pending(), 1);
  assert.equal(c.ctx.draws, 1, "the still picture is drawn at once");
  el.disconnectedCallback();
});

test("a rerender rebinds to the new canvas and never adds a second loop", () => {
  const { el } = mounted({ card: MUSIC });
  const first = frames.queue[0].id;
  const fresh = canvas();
  el.shadowRoot._byId.mouth = fresh;         // the tree was rebuilt
  el._mouthStart();
  el._mouthStart();
  el._mouthStart();
  assert.equal(pending(), 1, "one loop, however many renders");
  assert.ok(frames.cancelled.includes(first), "the old loop was cancelled, not abandoned");
  assert.equal(el._mouth.canvas, fresh);
  el.disconnectedCallback();
});

test("teardown cancels the loop and unregisters the visibility listener", () => {
  const { el } = mounted({ card: MUSIC });
  const id = frames.queue[0].id;
  assert.equal(doc.listeners("visibilitychange"), 1);
  el.disconnectedCallback();
  assert.equal(pending(), 0);
  assert.ok(frames.cancelled.includes(id));
  assert.equal(doc.listeners("visibilitychange"), 0);
  // a frame that was already in flight finds nothing to do and queues nothing
  pump(100);
  assert.equal(pending(), 0);
});

test("connect, disconnect, connect registers the visibility listener once", () => {
  const { el } = mounted({ card: MUSIC });
  el.disconnectedCallback();
  el.connectedCallback();
  assert.equal(doc.listeners("visibilitychange"), 1);
  el.disconnectedCallback();
  assert.equal(doc.listeners("visibilitychange"), 0);
});

test("a hidden page stops the frames; a visible one resumes them", () => {
  const { el, c } = mounted({ card: MUSIC });
  pump(0); pump(40);
  const drawn = c.ctx.draws;
  doc.visibilityState = "hidden";
  doc.dispatch("visibilitychange");
  assert.equal(pending(), 0, "hidden: no frame is queued");
  pump(80);                                  // nothing was queued; nothing runs
  assert.equal(c.ctx.draws, drawn, "hidden: nothing was drawn");
  doc.visibilityState = "visible";
  doc.dispatch("visibilitychange");
  assert.equal(pending(), 1, "visible again: one frame, not several");
  pump(120);
  assert.equal(c.ctx.draws, drawn + 1);
  el.disconnectedCallback();
});

test("a frame that lands while hidden draws nothing and queues nothing", () => {
  const { el, c } = mounted({ card: MUSIC });
  const before = c.ctx.draws;
  doc.visibilityState = "hidden";            // hidden between queue and frame
  pump(50);
  assert.equal(c.ctx.draws, before);
  assert.equal(pending(), 0);
  doc.visibilityState = "visible";
  el.disconnectedCallback();
});

test("the loop never exceeds 30 frames a second, whatever the display does", () => {
  const { el, c } = mounted({ card: DJ_AIRING, status: "on_air" });
  const start = c.ctx.draws;
  // a 120 Hz display: 120 frames in one second
  for (let i = 0; i < 120; i++) pump(i * (1000 / 120));
  const drawn = c.ctx.draws - start;
  assert.ok(drawn <= 31, `${drawn} draws in one second`);
  assert.ok(drawn >= 28, `${drawn} draws in one second: throttled too hard`);
  assert.equal(pending(), 1, "and it is still one loop");
  // a 60 Hz display, the ordinary case
  const at60 = c.ctx.draws;
  for (let i = 0; i < 60; i++) pump(2000 + i * (1000 / 60));
  assert.ok(c.ctx.draws - at60 <= 31 && c.ctx.draws - at60 >= 28, `${c.ctx.draws - at60} at 60 Hz`);
  assert.ok(PW_MOUTH.MOUTH_FPS <= 30);
  el.disconnectedCallback();
});

test("the frame makes zero backend calls and touches no DOM", () => {
  const { el, c } = mounted({ card: DJ_AIRING, status: "on_air" });
  let fetches = 0;
  globalThis.fetch = () => { fetches++; return Promise.resolve(); };
  el.shadowRoot.innerHTML = "<console/>";
  const html = el.shadowRoot.innerHTML;
  for (let i = 0; i < 90; i++) pump(i * 33.4);
  assert.equal(el.writes.length, 0, "a frame reached a service or the websocket");
  assert.equal(fetches, 0);
  assert.equal(el.shadowRoot.innerHTML, html, "a frame rewrote the tree");
  // no growth: every frame draws the same bounded number of segments
  const perFrame = c.ctx.rects.length / c.ctx.draws;
  assert.ok(perFrame <= PW_MOUTH.MOUTH_COLUMNS * 2 && perFrame >= PW_MOUTH.MOUTH_COLUMNS, perFrame);
  delete globalThis.fetch;
  el.disconnectedCallback();
});

test("idle draws one still picture and runs no loop at all", () => {
  const { el, c } = mounted({ player: "idle", card: { ...MUSIC, state: "idle" } });
  assert.equal(c.ctx.draws, 1);
  assert.equal(pending(), 0, "nothing moves: nothing to animate");
  el.disconnectedCallback();
});

test("a state change between renders swaps the loop cleanly", () => {
  const { el, c } = mounted({ dj: "on", status: "waiting", card: MUSIC });
  assert.equal(el._mouth.mode, MOUTH_MUSIC);
  pump(0); pump(40);
  el._hass.states["sensor.dj"].state = "on_air";
  el._hass.states["sensor.now"].attributes = DJ_AIRING;
  el.shadowRoot._byId.mouth = canvas();
  el._mouthStart();                          // the render after the update
  assert.equal(el._mouth.mode, MOUTH_PROGRAM_VOICE);
  assert.equal(pending(), 1);
  el._hass.states["sensor.dj"].state = "waiting";
  el._hass.states["sensor.now"].attributes = { ...MUSIC, state: "idle" };
  el._hass.states["media_player.den"].state = "idle";
  el.shadowRoot._byId.mouth = canvas();
  el._mouthStart();
  assert.equal(el._mouth.mode, MOUTH_IDLE);
  assert.equal(pending(), 0, "idle stopped the loop without a special reset");
  el.disconnectedCallback();
});

test("another screen stops the loop, and coming back starts it", () => {
  const { el } = mounted({ card: MUSIC });
  const id = frames.queue[0].id;
  delete el.shadowRoot._byId.mouth;          // Booth rendered: no canvas
  el._mouthStart();
  assert.equal(pending(), 0);
  assert.ok(frames.cancelled.includes(id));
  el.shadowRoot._byId.mouth = canvas();      // On Air again
  el._mouthStart();
  assert.equal(pending(), 1);
  el.disconnectedCallback();
});

test("the real render path starts the display without throwing when there is no canvas", () => {
  resetFrames();
  const el = new PanelClass();               // NOT stubbed: the real _render
  el._entityMap = {};
  el._view = "onair";
  el.hass = { states: {}, auth: { data: { access_token: "x" } },
              callWS: (m) => Promise.resolve(String(m.type).endsWith("/entities") ? { entities: {} } : { ok: true }),
              callService: () => Promise.resolve() };
  assert.ok(el.shadowRoot.innerHTML.includes('aria-label="Broadcast console"'));
  assert.ok(el.shadowRoot.innerHTML.includes('id="mouth"'));
  assert.equal(pending(), 0, "the fake tree has no canvas element to draw on");
});

// ======================================================================
// 4b. THE CLOCK SURVIVES A RE-RENDER
// ======================================================================
/* THE FLICKER WAS A CLOCK, NOT A WAVEFORM.
 *
 * Every Home Assistant state change anywhere in the home replaces this
 * shadow tree -- on a busy installation, about once a second -- and each
 * one rebuilds the canvas and calls _mouthStart again. The clock used to
 * be rebuilt with it, so the wave snapped back to phase zero perhaps
 * once a second and never reached the middle of a 3.6-8 s sway. Music
 * showed it as twitching; PROGRAM_VOICE hid it, because a 3.4 Hz syllable
 * completes inside the gap between two renders.
 *
 * EXECUTED the way the defect shows itself: drive the real
 * lifecycle at a render cadence and look at the phase actually drawn. */
function rerenderRun({ everyMs, ms = 12000, opts = { card: MUSIC } }) {
  const { el } = mounted(opts);
  const drawn = [];
  const real = el._mouthDraw.bind(el);
  el._mouthDraw = (t) => { drawn.push(t); real(t); };
  const FRAME = 1000 / 60;
  let next = everyMs;
  for (let ts = 0; ts <= ms; ts += FRAME) {
    if (ts >= next) {                       // a hass update: the tree is replaced
      el.shadowRoot._byId.mouth = canvas(); // a NEW canvas, as innerHTML= gives
      el._mouthStart();                     // what _render() does last
      next += everyMs;
    }
    pump(ts);
  }
  el.disconnectedCallback();
  return drawn;
}
const maxStep = (xs) => xs.slice(1).reduce(
  (m, v, i) => Math.max(m, Math.abs(v - xs[i])), 0);

test("a render every second no longer restarts the wave", () => {
  const churned = rerenderRun({ everyMs: 1000 });
  const quiet = rerenderRun({ everyMs: 1e9 });        // one render, ever
  assert.ok(Math.max(...churned) > 11,
            `the phase reached only ${Math.max(...churned).toFixed(2)}s`);
  assert.ok(Math.abs(Math.max(...churned) - Math.max(...quiet)) < 0.1,
            "a churned Mouth reaches the same phase as an undisturbed one");
});

test("the drawn motion is as smooth under churn as when left alone", () => {
  const open = (ts) => ts.map((t) => mouthOpening(MOUTH_MUSIC, t, 0));
  const quiet = maxStep(open(rerenderRun({ everyMs: 1e9 })));
  for (const everyMs of [1000, 300, 120]) {
    const step = maxStep(open(rerenderRun({ everyMs })));
    assert.ok(step <= quiet * 1.05,
              `a render every ${everyMs}ms stepped ${step.toFixed(4)} against ${quiet.toFixed(4)}`);
  }
});

test("a STATE change still starts its own motion from zero", () => {
  /* The phase is carried for continuity, not kept forever: going from
   * music to speech is a new thing happening and starts as one. */
  const { el } = mounted({ card: MUSIC });
  for (let ts = 0; ts <= 4000; ts += 1000 / 60) pump(ts);
  assert.ok(el._mouth.tSec > 3, "music had run for seconds");
  el._hass.states["sensor.dj"].state = "on_air";
  el._hass.states["sensor.now"].attributes = DJ_AIRING;
  el.shadowRoot._byId.mouth = canvas();
  el._mouthStart();
  assert.equal(el._mouth.mode, MOUTH_PROGRAM_VOICE);
  assert.equal(el._mouth.tSec, 0, "speech began mid-sway");
  assert.equal(el._mouth.t0, null, "and takes its origin from its first frame");
  el.disconnectedCallback();
});

test("the rebuild redraws the picture it was showing, not a zero-phase one", () => {
  const { el, c } = mounted({ card: MUSIC });
  for (let ts = 0; ts <= 2000; ts += 1000 / 60) pump(ts);
  const was = el._mouth.tSec;
  assert.ok(was > 1.5);
  const seen = [];
  const real = el._mouthDraw.bind(el);
  el._mouthDraw = (t) => { seen.push(t); real(t); };
  el.shadowRoot._byId.mouth = canvas();
  el._mouthStart();                          // the render
  assert.deepEqual(seen, [was], "the still picture is the one already on screen");
  el.disconnectedCallback();
});

test("a carried clock cannot outrun the frame clock", () => {
  /* The phase must remain a function of the frame timestamps, so a
   * throttled or backgrounded display stays in real time rather than
   * accumulating a debt it pays back in a rush. */
  const { el } = mounted({ card: MUSIC });
  for (let ts = 0; ts <= 3000; ts += 1000 / 60) pump(ts);
  el.shadowRoot._byId.mouth = canvas();
  el._mouthStart();
  pump(3016.7);
  assert.ok(el._mouth.tSec <= 3.1, `phase ${el._mouth.tSec} ran past the clock`);
  assert.ok(el._mouth.tSec >= 2.9, `phase ${el._mouth.tSec} fell behind the clock`);
  el.disconnectedCallback();
});

// ======================================================================
// 5. REDUCED MOTION
// ======================================================================
function reducedRects(opts) {
  globalThis.window.matchMedia = () => ({ matches: true });
  try {
    const { el, c } = mounted(opts);
    assert.equal(pending(), 0, "reduced motion: no loop");
    assert.equal(c.ctx.draws, 1, "reduced motion: one still picture");
    el.disconnectedCallback();
    return c.ctx.rects;
  } finally { globalThis.window.matchMedia = undefined; }
}
const tallest = (rects) => Math.max(...rects.map((r) => r.h));

test("reduced motion draws one still picture per state and no loop", () => {
  const music = reducedRects({ card: MUSIC });
  const voice = reducedRects({ card: DJ_AIRING, status: "on_air" });
  const idle = reducedRects({ player: "idle", card: { ...MUSIC, state: "idle" } });
  assert.ok(tallest(voice) > tallest(music) * 1.5, "speaking is visibly more open");
  assert.ok(tallest(music) > tallest(idle) * 2, "music is visibly more open than idle");
  assert.ok(voice.some((r) => r.fill === "#ffe6c0"), "speaking carries the cream core");
  assert.ok(!music.some((r) => r.fill === "#ffe6c0"));
});

test("reduced motion also keeps the accessible state and the frame class", () => {
  globalThis.window.matchMedia = () => ({ matches: true });
  try {
    const html = station({ card: DJ_AIRING, status: "on_air" })._renderMouth();
    assert.ok(html.includes("mouth-program-voice"));
    assert.ok(html.includes('aria-label="Broadcast display: ParlorWave speaking"'));
  } finally { globalThis.window.matchMedia = undefined; }
});

// ======================================================================
// 6. AIR CHECK ON THE CONSOLE
// ======================================================================
const HISTORY = { last_spoken: "That was the 13:50 break.", last_break_at: "2026-09-16T13:50:00-07:00" };
const LIVE = { on_air_break: true, on_air_spoken: "This is the 14:22 break.",
               on_air_break_at: "2026-09-16T14:22:00-07:00" };
function consoleOf(el) {
  const html = el._renderOnAir();
  const at = html.indexOf('aria-label="Broadcast console"');
  assert.ok(at > 0, "no console");
  return html.slice(at, html.indexOf("</section>", at));
}

test("the Air Check sits on the console, after the deck", () => {
  const c = consoleOf(station({ status: "waiting", djAttrs: HISTORY, card: MUSIC }));
  assert.ok(c.indexOf('aria-label="Air Check"') > c.indexOf('id="mouth"'));
  assert.ok(c.includes("13:50 break"));
});
test("an airing break is the Air Check, speaking now", () => {
  const c = consoleOf(station({ status: "on_air", djAttrs: { ...HISTORY, ...LIVE }, card: DJ_AIRING }));
  assert.ok(c.includes("14:22 break") && c.includes("Speaking now") && !c.includes("13:50 break"));
});
test("a queued future break is not the Air Check", () => {
  const c = consoleOf(station({ status: "up_next", djAttrs: HISTORY, card: MUSIC }));
  assert.ok(c.includes("13:50 break") && !c.includes("Speaking now"));
});
test("a spent stale item ahead cannot replace the true latest break", () => {
  const el = station({ status: "waiting", djAttrs: HISTORY, card: DJ_SPENT });
  el._queue = { at: Date.now(), data: { ok: true, complete: true, current: MUSIC, recent: [],
                upcoming: [{ kind: "dj", lifecycle: "spent", title: "DJ break" }] } };
  const c = consoleOf(el);
  assert.ok(c.includes("13:50 break") && !c.includes("Speaking now"));
  assert.equal(el._mouthState().mode, MOUTH_MUSIC);
});

// ======================================================================
// 7. ACCESSIBILITY
// ======================================================================
test("the Mouth is one decorative image with one concise state", () => {
  for (const [opts, label] of [[{ card: MUSIC }, "Music playing"],
                               [{ status: "on_air", card: DJ_AIRING }, "ParlorWave speaking"],
                               [{ card: NEWS_AIRING }, "ParlorWave speaking"],
                               [{ player: "idle", card: { ...MUSIC, state: "idle" } }, "Idle"]]) {
    const html = station(opts)._renderMouth();
    assert.ok(html.includes(`role="img"`) && html.includes(`aria-label="Broadcast display: ${label}"`), label);
    assert.ok(html.includes('<canvas id="mouth" class="mouth-canvas" aria-hidden="true">'));
    assert.ok(!html.includes("aria-live"));
    assert.equal((html.match(/aria-label=/g) || []).length, 1, "one name, not one per segment");
  }
});
test("the console and the Air Check have useful names", () => {
  const c = consoleOf(station({ djAttrs: HISTORY, card: MUSIC }));
  assert.ok(c.includes('aria-label="Broadcast console"'));
  assert.ok(c.includes('aria-label="Air Check"'));
  assert.ok(c.includes('aria-label="Active DJ speaker"'), "the speaker select kept its name");
  assert.ok(c.includes('data-select="select.out"'), "and its binding");
});

// ======================================================================
// 8. REAL MA WAVEFORM-DRIVEN BROADCAST MOUTH
// ======================================================================
const { waveformAmplitude, smoothAmplitude, mouthWaveformOpen, demoWaveformBins } = PW_MOUTH;

test("waveformAmplitude samples and interpolates 1800 bins across duration", () => {
  const bins = new Float32Array(1800);
  bins[0] = 0.1;
  bins[899] = 0.8;
  bins[900] = 0.8;
  bins[1799] = 0.4;
  assert.equal(Math.round(waveformAmplitude(bins, 0, 100) * 100), 10);
  assert.equal(Math.round(waveformAmplitude(bins, 50, 100) * 100), 80);
  assert.equal(Math.round(waveformAmplitude(bins, 100, 100) * 100), 40);
  // clamped & bounded
  assert.ok(Math.abs(waveformAmplitude(bins, -10, 100) - 0.1) < 1e-5);
  assert.ok(Math.abs(waveformAmplitude(bins, 150, 100) - 0.4) < 1e-5);
  assert.equal(waveformAmplitude(bins, 50, 0), null);
  assert.equal(waveformAmplitude(new Float32Array(0), 50, 100), null);
});

test("smoothAmplitude follows asymmetric attack (fast) and release (slow)", () => {
  // One frame at 30 FPS ~ 0.033s
  const dt = 0.033;
  // Attack: 0 to 1
  const stepAttack = smoothAmplitude(0.0, 1.0, dt);
  // Release: 1 to 0
  const stepRelease = 1.0 - smoothAmplitude(1.0, 0.0, dt);
  // Attack is faster than release
  assert.ok(stepAttack > stepRelease, `attack step (${stepAttack}) must be faster than release (${stepRelease})`);
  assert.ok(stepAttack > 0.5, "attack rises more than 50% in first frame (~35ms)");
  assert.ok(stepRelease < 0.4, "release falls less than 40% in first frame (~90ms)");
});

test("mouthWaveformOpen enforces silence deadband and monotonic aperture", () => {
  // Silence deadband below ~0.02
  assert.equal(mouthWaveformOpen(0.0), 0.0);
  assert.equal(mouthWaveformOpen(0.015), 0.0);
  assert.ok(mouthWaveformOpen(0.05) > 0.0);
  assert.equal(mouthWaveformOpen(1.0), 1.0);
  assert.ok(mouthWaveformOpen(0.8) > mouthWaveformOpen(0.3));
});

test("demoWaveformBins generates valid 1800-bin audio energy fixture", () => {
  const bins = demoWaveformBins(1800);
  assert.equal(bins.length, 1800);
  let hasSilence = false;
  let hasLoud = false;
  for (let i = 0; i < bins.length; i++) {
    assert.ok(bins[i] >= 0.0 && bins[i] <= 1.0, `bin ${i} out of bounds: ${bins[i]}`);
    if (bins[i] < 0.01) hasSilence = true;
    if (bins[i] > 0.7) hasLoud = true;
  }
  assert.ok(hasSilence, "fixture must contain quiet/silent passages");
  assert.ok(hasLoud, "fixture must contain energetic peaks");
});

test("demo mode toggle activates deterministic fixture and drives mouth", () => {
  const { el } = mounted({ card: MUSIC });
  pump(0);
  assert.equal(el._waveformDemo, false);

  el.toggleWaveformDemo(true);
  assert.equal(el._waveformDemo, true);
  assert.ok(el._waveform && el._waveform.queueItemId === "demo_waveform");
  assert.equal(el._waveform.bins.length, 1800);

  pump(100);
  assert.ok(typeof el._mouth.waveformOpen === "number");

  el.toggleWaveformDemo(false);
  assert.equal(el._waveformDemo, false);
  assert.equal(el._waveform, null);
  el.disconnectedCallback();
});

// ======================================================================
// 9. THE WAVEFORM MOUTH, LIVE: demand, identity, confirmation, retry,
//    clock, smoothing
// ======================================================================
/* Everything below goes through the panel's REAL paths: the hass setter
 * (which is how Home Assistant delivers every update), the demand refresh
 * it runs, the websocket request, the reply, the confirming look, and the
 * frame loop reading the playback clock. Earlier tests set el._waveform
 * by hand, and the real trigger -- gated on a view that does not exist --
 * shipped without ever sending a request. */
const { WAVEFORM_RETRY_MS, WAVEFORM_MAX_RETRIES, WAVEFORM_MAX_REFRESHES, SMOOTH_MAX_DT_S,
        WAVEFORM_CONFIRM_MS } = PW_MOUTH;
const flush = async () => { for (let i = 0; i < 20; i++) await null; };

/* Timers under the test's hand, on the same clock the panel reads. These
 * panels are never connected, so the only timers they set are the waveform
 * demand's. */
const timers = { q: [], next: 1 };
function fakeTimers() {
  const real = { st: globalThis.setTimeout, ct: globalThis.clearTimeout };
  timers.q = [];
  globalThis.setTimeout = (fn, ms) => { const id = timers.next++; timers.q.push({ id, fn, ms }); return id; };
  globalThis.clearTimeout = (id) => { timers.q = timers.q.filter((t) => t.id !== id); };
  return () => { globalThis.setTimeout = real.st; globalThis.clearTimeout = real.ct; timers.q = []; };
}
const nowS = () => Date.now() / 1000;
const BINS = (v) => Array.from({ length: 1800 }, () => v);
const RAMP = Array.from({ length: 1800 }, (_, i) => i / 1799);
const ok = (qid, bins = BINS(0.8), extra = {}) =>
  ({ ok: true, queue_item_id: qid, source: "music_assistant", sample_count: bins.length,
     duration_s: 180, stable: true, revision: 0, refresh_in_s: null, bins, ...extra });
const card = (qid, over = {}) => ({ ...MUSIC, queue_item_id: qid, elapsed: 100,
                                    elapsed_at: nowS(), duration: 180, ...over });

/* A panel on On Air whose websocket answers reply(msg); requests counted.
 * update() is one Home Assistant update: the setter, then what _render
 * does last. clk is the monotonic clock the frame, the clock and the
 * timers share; fire() runs the pending timers, advancing clk to each. */
function live({ qid = "A", over = {}, reply = () => ok(qid), player = "playing" } = {}) {
  resetFrames();
  const el = station({ card: card(qid, over), player });
  el._voiceLib = {};
  el.waveReqs = [];
  el.answer = reply;
  el._hass.callWS = (m) => {
    if (m.type !== "parlorwave_radio/waveform") return Promise.resolve({});
    el.waveReqs.push(m);
    const r = el.answer(m);
    return r instanceof Promise ? r : Promise.resolve(r);
  };
  const clk = { now: 1000 };
  el._perfNow = () => clk.now;
  el.shadowRoot._byId.mouth = canvas();
  const update = () => { el.hass = el._hass; el.shadowRoot._byId.mouth = canvas(); el._mouthStart(); };
  const frame = (ms = 33) => { clk.now += ms; pump(clk.now); };
  const setCard = (c) => { el._hass.states["sensor.now"] = { state: c.state || "playing", attributes: c }; };
  const fire = async () => {
    const due = timers.q; timers.q = [];
    for (const t of due) { clk.now += t.ms; t.fn(); }
    await flush();
    return due.map((t) => t.ms);
  };
  /* the ordinary arrival of an item: its first request, then its confirming look */
  const arrive = async () => { update(); await flush(); await fire(); };
  return { el, clk, update, frame, setCard, fire, arrive };
}
const wfPos = (el, clk) => {
  const wf = el._drawnWaveform();
  return wf ? el._waveformPosition(wf, clk.now) : null;
};

// --- 9a. the trigger ------------------------------------------------------
test("On Air requests the waveform through the real demand path", async () => {
  const restore = fakeTimers();
  try {
    const { el, update } = live();
    assert.equal(el._view, "onair", "the Broadcast Console lives on On Air");
    update();
    await flush();
    assert.equal(el.waveReqs.length, 1, "the hass update itself asked for the waveform");
    update(); update();
    await flush();
    assert.equal(el.waveReqs.length, 1, "hass updates do not add requests; the item's timers own it");
    el.disconnectedCallback();
  } finally { restore(); }
});

test("the whole chain: request -> reply -> confirmed -> the mouth draws it", async () => {
  const restore = fakeTimers();
  try {
    const { el, update, frame, fire } = live();
    update();
    frame();
    assert.equal(el._mouth.waveformOpen, null, "synthetic until the waveform is here");
    await flush();
    assert.equal(el._waveforms.get("A").queueItemId, "A", "stored under the item the reply names");
    frame();
    assert.equal(el._mouth.waveformOpen, null, "not drawn on one look at MA");
    const waits = await fire();
    assert.ok(waits[0] <= WAVEFORM_CONFIRM_MS + 50, `the confirming look comes soon: ${waits}`);
    assert.equal(el.waveReqs.length, 2);
    assert.ok(el._confirmed.has("A"));
    for (let i = 0; i < 10; i++) frame();
    assert.equal(el._mouth.waveform.queueItemId, "A", "the running mouth picked it up without a render");
    assert.ok(el._mouth.waveformOpen > 0.6, `loud bins open the mouth: ${el._mouth.waveformOpen}`);
    assert.equal(timers.q.length, 0, "a confirmed, stable waveform leaves nothing scheduled");
    el.disconnectedCallback();
  } finally { restore(); }
});

test("another view asks for nothing; choosing On Air asks at once", async () => {
  const restore = fakeTimers();
  try {
    const { el, update } = live();
    el._view = "booth";
    update();
    await flush();
    assert.equal(el.waveReqs.length, 0, "no Mouth on screen, no demand");
    el._view = "onair";
    el._maybeRefreshWaveform();
    await flush();
    assert.equal(el.waveReqs.length, 1);
    el.disconnectedCallback();
  } finally { restore(); }
});

// --- 9b. identity and confirmation: fail closed -------------------------------
test("a reply naming another item is filed under that item, never drawn as this one", async () => {
  const restore = fakeTimers();
  try {
    let n = 0;
    const { el, update, frame, fire } = live({ reply: () => (++n === 1 ? ok("OTHER", BINS(0.1)) : ok("A")) });
    update();
    await flush();
    assert.equal(el._waveforms.get("A"), undefined, "never stored under A");
    frame();
    assert.equal(el._mouth.waveformOpen, null, "never drawn");
    assert.equal(timers.q.length, 1, "A is looked at again");
    await fire();
    assert.equal(el.waveReqs.length, 2);
    for (let i = 0; i < 10; i++) frame();
    assert.equal(el._mouth.waveform.queueItemId, "A", "the correct reply attaches normally");
    assert.ok(el._mouth.waveformOpen > 0.6);
    el.disconnectedCallback();
  } finally { restore(); }
});

test("a reply that lands after the item changed cannot attach to either item", async () => {
  const restore = fakeTimers();
  try {
    const pendingA = {};
    const { el, update, setCard } = live();
    el.answer = () => (el.waveReqs.length === 1
      ? new Promise((r) => { pendingA.resolve = r; })
      : ok("B", BINS(0.3)));
    update();                                       // A requested, still in flight
    setCard(card("B"));
    update();                                       // B is on air now
    await flush();
    assert.equal(el._waveform.queueItemId, "B");
    pendingA.resolve(ok("A", BINS(0.9)));           // the late reply for A
    await flush();
    assert.equal(el._waveforms.get("A"), undefined, "A's late reply was dropped");
    assert.equal(el._waveform.queueItemId, "B");
    assert.equal(timers.q.length, 1, "only B's confirming look is scheduled");
    el.disconnectedCallback();
  } finally { restore(); }
});

test("a seek's transient item is never drawn, and the mouth relocates in ~1 s", async () => {
  const restore = fakeTimers();
  try {
    // A seek to 170 s in R. For a few hundred ms MA can call an old queue
    // item T (an earlier song) current at 200 s; the sensor catches it and
    // holds it for a 10 s refresh cooldown, and the first reply, read in
    // the same instant, agrees.
    const base = nowS();
    const { el, clk, update, frame, setCard, arrive } = live({ qid: "R", reply: () => ok("R", RAMP) });
    await arrive();
    for (let i = 0; i < 10; i++) frame();
    assert.equal(el._drawnWaveform().queueItemId, "R");
    setCard(card("T", { elapsed: 200, elapsed_at: base + 0.1 }));
    el.answer = () => ok("T", BINS(0.9), { elapsed: 200, elapsed_at: base + 0.15, state: "playing" });
    update();
    await flush();
    const drawn = new Set();
    for (let i = 0; i < 25; i++) { frame(); if (el._mouth.waveform) drawn.add(el._mouth.waveform.queueItemId); }
    assert.ok(!drawn.has("T"), "T was stored, but never drawn on one look");
    assert.equal(el._mouth.waveformOpen, null, "synthetic in the meantime");
    // the confirming look, a second later: MA is back on R at 171 s
    el.answer = () => ok("R", RAMP, { elapsed: 171, elapsed_at: base + 1.1, state: "playing" });
    assert.equal(timers.q.length, 1);
    const ms = timers.q[0].ms;
    assert.ok(ms <= WAVEFORM_CONFIRM_MS + 50, `the confirming look is due within a second: ${ms}`);
    timers.q[0].fn(); timers.q = [];
    await flush();
    frame();
    assert.equal(el._drawnWaveform().queueItemId, "R", "back on R without waiting for the sensor");
    assert.ok(Math.abs(wfPos(el, clk) - 171) < 0.2, `at MA's position, not 200 or 0: ${wfPos(el, clk)}`);
    assert.ok(!el._confirmed.has("T"));
    // the sensor catches up 10 s later with an older-or-equal view of R: no jump
    el.answer = () => new Promise(() => {});
    setCard(card("R", { elapsed: 171 + 9, elapsed_at: base + 1.1 + 9 }));
    const before = wfPos(el, clk);
    clk.now += 9000;
    update();
    frame();
    assert.ok(Math.abs(wfPos(el, clk) - (before + 9.033)) < 0.2, "the sensor's sample agrees; no jump");
    el.disconnectedCallback();
  } finally { restore(); }
});

test("an item MA contradicts is looked at again at the retry cadence, not hammered", async () => {
  const restore = fakeTimers();
  try {
    // the sensor holds a transient T for its 10 s cooldown; MA keeps naming R
    const { el, update, setCard, fire, arrive } = live({ qid: "R" });
    await arrive();
    el.answer = () => ok("R", BINS(0.5), { elapsed: 150, elapsed_at: nowS() + 5, state: "playing" });
    setCard(card("T", { elapsed: 200, elapsed_at: nowS() + 1 }));
    update();
    await flush();
    const waits = [];
    for (let i = 0; i < 8; i++) waits.push(...(await fire()));
    assert.ok(waits[0] <= WAVEFORM_CONFIRM_MS + 50, `one quick confirming look: ${waits}`);
    assert.ok(waits.slice(1).every((ms) => ms === WAVEFORM_RETRY_MS), `then the ordinary cadence: ${waits}`);
    assert.equal(waits.length, WAVEFORM_MAX_RETRIES, "and a bounded number of them");
    assert.equal(el._drawnWaveform().queueItemId, "R", "R, which MA kept naming, is what is drawn");
    el.disconnectedCallback();
  } finally { restore(); }
});

test("an item with no position is not drawn at a guess", async () => {
  const restore = fakeTimers();
  try {
    const { el, update, frame, setCard, arrive } = live();
    await arrive();
    el.answer = () => new Promise(() => {});
    setCard(card("T", { elapsed: undefined }));      // yesterday's transient: no elapsed at all
    update();
    frame();
    assert.equal(el._clock, null);
    assert.equal(el._mouth.waveformOpen, null);
    el.disconnectedCallback();
  } finally { restore(); }
});

// --- 9c. retry: the first-ever not_analyzed ----------------------------------
test("the first-ever not_analyzed retries, stays synthetic, then attaches", async () => {
  const restore = fakeTimers();
  try {
    let n = 0;
    const { el, update, frame, fire } = live({
      reply: () => (++n <= 2 ? { ok: false, reason: "not_analyzed", queue_item_id: "A" } : ok("A")) });
    update();
    await flush();
    assert.equal(timers.q.length, 1, "a panel that never had a waveform still schedules its look again");
    frame();
    assert.equal(el._mouth.waveformOpen, null, "the synthetic display carries on");
    assert.ok(pending() > 0, "and keeps moving");
    update(); update();
    await flush();
    assert.equal(el.waveReqs.length, 1, "hass updates do not add requests while a retry waits");
    await fire();                                     // the confirming look: still not analysed
    assert.ok(el._confirmed.has("A"));
    assert.deepEqual(timers.q.map((t) => t.ms), [WAVEFORM_RETRY_MS]);
    await fire();
    assert.equal(el.waveReqs.length, 3);
    for (let i = 0; i < 10; i++) frame();
    assert.equal(el._mouth.waveform.queueItemId, "A", "the real waveform took over");
    assert.equal(typeof el._mouth.waveformOpen, "number");
    el.disconnectedCallback();
  } finally { restore(); }
});

test("retries are bounded, per item, and cancelled by a new item and by teardown", async () => {
  const restore = fakeTimers();
  try {
    const { el, update, setCard, fire } = live();
    el.answer = () => ({ ok: false, reason: "not_analyzed",
                         queue_item_id: el._hass.states["sensor.now"].attributes.queue_item_id });
    update();
    await flush();
    for (let i = 0; i < 10; i++) await fire();
    assert.equal(el.waveReqs.length, 1 + WAVEFORM_MAX_RETRIES);
    for (let i = 0; i < 5; i++) update();
    await flush();
    assert.equal(el.waveReqs.length, 1 + WAVEFORM_MAX_RETRIES, "an exhausted item is not asked again");
    setCard(card("B"));
    update();
    await flush();
    assert.equal(el.waveReqs.length, 2 + WAVEFORM_MAX_RETRIES, "a new item starts its own demand");
    assert.equal(timers.q.length, 1);
    setCard(card("C"));
    update();
    await flush();
    assert.equal(timers.q.length, 1, "B's retry was cancelled, only C's waits");
    el.disconnectedCallback();
    assert.equal(timers.q.length, 0, "teardown cancels the timer");
    assert.equal(el._wfDemand, null);
  } finally { restore(); }
});

test("an unsettled waveform is re-read on the backend's cue, for the same item only", async () => {
  const restore = fakeTimers();
  try {
    let n = 0;
    const { el, update, setCard, fire } = live({
      reply: () => (++n < 3 ? ok("A", BINS(0.2 * n), { stable: false, refresh_in_s: 15, revision: n - 1 })
                            : ok("A", BINS(0.6), { stable: true, revision: 2 })) });
    update();
    await flush();
    await fire();                                     // the confirming look
    assert.equal(el._drawnWaveform().revision, 1, "the revised waveform replaced the early one");
    assert.deepEqual(timers.q.map((t) => t.ms), [15000]);
    await fire();
    assert.equal(el._drawnWaveform().stable, true);
    assert.equal(timers.q.length, 0, "settled: nothing more is scheduled");
    assert.equal(el.waveReqs.length, 3);
    el.answer = () => ok("B", BINS(0.4), { stable: false, refresh_in_s: 15 });
    setCard(card("B"));
    update();
    await flush();
    await fire();
    assert.deepEqual(timers.q.map((t) => t.ms), [15000]);
    el.answer = () => new Promise(() => {});
    setCard(card("C"));
    update();
    assert.equal(timers.q.length, 0, "B's refresh timer died with B");
    el.disconnectedCallback();
  } finally { restore(); }
  assert.ok(WAVEFORM_MAX_REFRESHES > 0);
});

// --- 9d. the playback clock --------------------------------------------------
test("position advances once, not twice, through ticks and re-renders", async () => {
  const restore = fakeTimers();
  try {
    const { el, clk, update, frame, arrive } = live();
    await arrive();
    const start = wfPos(el, clk);
    assert.ok(Math.abs(start - 101) < 0.2, `anchored at the sensor, one confirming second on: ${start}`);
    let last = start;
    for (let ms = 0; ms < 5000; ms += 33) {
      frame();
      if (ms % 1000 < 33) el._tick();                 // the 1 s progress ticker
      if (ms % 300 < 33) update();                    // unrelated HA updates
      const p = wfPos(el, clk);
      assert.ok(p >= last - 1e-9, `never jumps backward (${last} -> ${p})`);
      last = p;
    }
    assert.ok(Math.abs(last - (start + 5.0)) < 0.1, `5 s of playback moved it 5 s, not ${last - start}`);
    el.disconnectedCallback();
  } finally { restore(); }
});

test("pause stops the position; resume continues from where it stopped", async () => {
  const restore = fakeTimers();
  try {
    const { el, clk, update, frame, setCard, arrive } = live();
    await arrive();
    for (let i = 0; i < 30; i++) frame();             // ~1 s
    el._hass.states["media_player.den"].state = "paused";   // the player first
    update();
    const held = el._clockPosition(clk.now);
    clk.now += 8000;
    update();
    assert.ok(Math.abs(el._clockPosition(clk.now) - held) < 1e-9, "paused: no advance");
    setCard(card("A", { elapsed: held, elapsed_at: nowS(), state: "paused" }));
    update();                                         // then the sensor agrees
    el._hass.states["media_player.den"].state = "playing";
    update();                                         // resume: the sensor still says paused
    const from = wfPos(el, clk);
    let last = from;
    for (let ms = 0; ms < 10300; ms += 33) {          // a sensor lag of about ten seconds
      frame();
      if (ms % 300 < 33) update();
      const p = wfPos(el, clk);
      assert.ok(p >= last - 1e-9, `no replayed slice (${last} -> ${p})`);
      last = p;
    }
    assert.ok(Math.abs(from - held) < 0.05, "resumed from the paused position");
    assert.ok(Math.abs(last - (held + 10.3)) < 0.1, `and advanced with the audio: ${last - held}`);
    setCard(card("A", { elapsed: held + 10.3, elapsed_at: nowS() }));
    update();
    assert.ok(Math.abs(wfPos(el, clk) - last) < 0.1, "the late authority is a small correction");
    el.disconnectedCallback();
  } finally { restore(); }
});

test("an authoritative jump re-anchors at once; an older sample never does", async () => {
  const restore = fakeTimers();
  try {
    const base = nowS();
    const { el, clk, update, frame, setCard, arrive } = live({ over: { elapsed_at: base } });
    await arrive();
    for (let i = 0; i < 30; i++) frame();
    setCard(card("A", { elapsed: 200, elapsed_at: base + 2 }));   // a seek
    update();
    frame();
    assert.ok(Math.abs(wfPos(el, clk) - 200) < 0.1, `relocated: ${wfPos(el, clk)}`);
    setCard(card("A", { elapsed: 150, elapsed_at: base + 1 }));   // a sample from before it
    update();
    frame();
    assert.ok(wfPos(el, clk) > 199, "an older observation does not move the clock back");
    el.disconnectedCallback();
  } finally { restore(); }
});

test("the frame samples the waveform at the clock's position", async () => {
  const restore = fakeTimers();
  try {
    // silence before 100 s, full scale after: the drawn aperture says which side we are on
    const step = Array.from({ length: 1800 }, (_, i) => (i / 1799 * 180 >= 100.5 ? 1 : 0));
    const { el, frame, arrive } = live({ over: { elapsed: 89 }, reply: () => ok("A", step) });
    await arrive();                                   // confirmed at ~90 s
    for (let i = 0; i < 60; i++) frame();             // 2 s: at ~92 s, still silent
    assert.ok(el._mouth.waveformOpen < 0.02, `before the step: ${el._mouth.waveformOpen}`);
    for (let i = 0; i < 300; i++) frame();            // +10 s: ~102 s
    assert.ok(el._mouth.waveformOpen > 0.9, `after the step: ${el._mouth.waveformOpen}`);
    el.disconnectedCallback();
  } finally { restore(); }
});

test("a new item resets the envelope instead of carrying the old one", async () => {
  const restore = fakeTimers();
  try {
    const { el, update, frame, setCard, arrive } = live({ reply: () => ok("A", BINS(1.0)) });
    await arrive();
    for (let i = 0; i < 10; i++) frame();
    assert.ok(el._mouth.smoothedAmp > 0.5);
    el.answer = () => new Promise(() => {});
    setCard(card("B"));
    update();
    assert.equal(el._mouth.smoothedAmp, 0);
    assert.equal(el._mouth.waveform, null, "A's waveform is not drawn for B");
    frame();
    assert.equal(el._mouth.waveformOpen, null);
    el.disconnectedCallback();
  } finally { restore(); }
});

// --- 9e. smoothing: the call contract and frame-rate independence ------------
test("smoothAmplitude(current, target): attack ~35 ms up, release ~90 ms down", () => {
  const up = smoothAmplitude(0, 1, 0.035);
  const down = smoothAmplitude(1, 0, 0.090);
  assert.ok(Math.abs(up - (1 - Math.exp(-1))) < 1e-9, `one attack constant rises 63%: ${up}`);
  assert.ok(Math.abs(down - Math.exp(-1)) < 1e-9, `one release constant falls 63%: ${down}`);
  assert.ok(smoothAmplitude(0.5, 0.5, 0.033) === 0.5, "at target, it stays");
});

test("smoothing lands in the same place at 120, 30, 10 and 5 fps", () => {
  const run = (fps, target, from, seconds) => {
    let v = from;
    for (let i = 0; i < Math.round(seconds * fps); i++) v = smoothAmplitude(v, target, 1 / fps);
    return v;
  };
  for (const [from, target] of [[0, 1], [1, 0]]) {
    const ref = run(30, target, from, 0.2);
    for (const fps of [120, 10, 5]) {
      assert.ok(Math.abs(run(fps, target, from, 0.2) - ref) < 1e-9, `${fps} fps diverged`);
    }
  }
  assert.ok(SMOOTH_MAX_DT_S >= 0.2, "a 5 fps frame is not clipped");
});

// ======================================================================
// 10. THE MUSIC PRESENTATION: same signal, its own mapping
// ======================================================================
/* Under the speech mapping, music sat about two-thirds open and
 * read as one lens breathing. The MAPPING from smoothed amplitude to the
 * drawn aperture is now mode-aware; everything upstream of it -- demand,
 * identity, confirmation, the clock, the smoother -- is byte-identical
 * and covered by sections 8 and 9 above. */
const { musicWaveformOpen, MUSIC_SILENCE_GATE, MUSIC_CURVE_EXP, MUSIC_RIPPLE,
        mouthLens } = PW_MOUTH;

test("musicWaveformOpen: quiet closes, the median is mid-open, loud still opens", () => {
  // its own silence gate
  assert.equal(musicWaveformOpen(0.0, 0.0), 0.0);
  assert.equal(musicWaveformOpen(0.03, 0.03), 0.0);
  // a typical median music amplitude (0.62) no longer draws
  // ~0.69: it reads mid-open, and visibly less open than the speech curve
  const median = musicWaveformOpen(0.62, 0.62);
  assert.ok(median > 0.3 && median < 0.55, `median music opening: ${median}`);
  assert.ok(median < mouthWaveformOpen(0.62) - 0.15,
            "music must sit visibly less open than the speech mapping");
  // a genuinely quiet passage under a louder running level visibly closes
  assert.ok(musicWaveformOpen(0.25, 0.5) < 0.1);
  // loud passages still open wide, and never past full scale
  assert.ok(musicWaveformOpen(0.95, 0.8) > 0.85);
  assert.ok(musicWaveformOpen(1.0, 0.1) <= 1.0);
  // monotonic at a fixed running level
  assert.ok(musicWaveformOpen(0.8, 0.6) > musicWaveformOpen(0.5, 0.6));
});

test("musicWaveformOpen emphasises energy against the track's own level", () => {
  // the same instantaneous amplitude opens MORE above a quiet running
  // level (a transient) and LESS below a loud one (a lull)...
  const hit = musicWaveformOpen(0.6, 0.4);
  const steady = musicWaveformOpen(0.6, 0.6);
  const lull = musicWaveformOpen(0.6, 0.8);
  assert.ok(hit > steady && steady > lull, `${hit} / ${steady} / ${lull}`);
  // ...and at the track's own steady level the emphasis is exactly zero:
  // a constant signal draws the curve alone, nothing invented.
  const gated = (0.6 - MUSIC_SILENCE_GATE) / (1 - MUSIC_SILENCE_GATE);
  assert.ok(Math.abs(steady - Math.pow(gated, MUSIC_CURVE_EXP)) < 1e-12);
});

test("music and speech present the same amplitude differently; speech is untouched", async () => {
  const restore = fakeTimers();
  try {
    const music = live();                                    // MUSIC mode
    await music.arrive();
    for (let i = 0; i < 40; i++) music.frame();
    assert.equal(music.el._mouth.mode, MOUTH_MUSIC);
    const m = music.el._mouth;
    const musicOpen = m.waveformOpen;
    assert.ok(musicOpen < 0.72, `0.8 bins should not pin music near open: ${musicOpen}`);
    assert.ok(Math.abs(musicOpen - musicWaveformOpen(m.smoothedAmp, m.slowAmp)) < 1e-9,
              "the frame must draw exactly the exported music mapping");
    music.el.disconnectedCallback();

    const speech = live({ over: { kind: "dj", lifecycle: "airing", title: "DJ break" } });
    speech.el._hass.states["sensor.dj"].state = "on_air";
    await speech.arrive();
    for (let i = 0; i < 40; i++) speech.frame();
    assert.equal(speech.el._mouth.mode, MOUTH_PROGRAM_VOICE);
    const s = speech.el._mouth;
    // speech (DJ and news alike) keeps its settled mapping EXACTLY
    assert.ok(Math.abs(s.waveformOpen - mouthWaveformOpen(s.smoothedAmp)) < 1e-9,
              "the speech mapping changed; it is settled and must not");
    // and on the same 0.8 bins, music sits visibly less open than speech
    assert.ok(musicOpen < s.waveformOpen - 0.1,
              `${musicOpen} (music) vs ${s.waveformOpen} (speech)`);
    speech.el.disconnectedCallback();
  } finally { restore(); }
});

test("the music columns shimmer subtly with the envelope; speech columns do not", () => {
  const el = station({ card: MUSIC });
  // tall enough that the 1.5px minimum bar height never triggers, which
  // would otherwise dominate the near-silent comparison below
  const c = canvas(600, 300);
  const n = PW_MOUTH.MOUTH_COLUMNS;
  const xs = Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) / ((n - 1) / 2));
  const heights = (mode, wo, t) => {
    c.ctx.rects.length = 0;
    el._mouth = { canvas: c, mode, reduced: false, waveformOpen: wo,
                  accent: "ACCENT" };
    el._mouthDraw(t);
    return c.ctx.rects.filter((r) => r.fill === "ACCENT").map((r) => r.h);
  };
  // normalise away the lens shape, which varies the columns by design
  const norm = (hs) => hs.map((h, i) => h / (0.12 + 0.88 * mouthLens(xs[i])));
  const spread = (v) => Math.max(...v) - Math.min(...v);

  const mus = norm(heights(MOUTH_MUSIC, 0.75, 1.37));
  assert.equal(mus.length, n);
  assert.ok(spread(mus) > 0.01, "music columns move in lockstep: no shimmer");
  // SUBTLE: bounded by the declared depth of the ripple, well under the
  // synthetic-equalizer look this must never become
  const mean = mus.reduce((a, b) => a + b, 0) / mus.length;
  assert.ok(spread(mus) / mean < 2.2 * MUSIC_RIPPLE,
            `the shimmer overwhelms the real signal: ${spread(mus) / mean}`);

  // speech columns keep their settled uniform aperture exactly
  const sp = norm(heights(MOUTH_PROGRAM_VOICE, 0.75, 1.37));
  assert.ok(spread(sp) < 1e-9, `speech columns diverged: ${spread(sp)}`);

  // and the shimmer's depth FOLLOWS the envelope: near-silence barely moves
  const quiet = norm(heights(MOUTH_MUSIC, 0.08, 1.37));
  assert.ok(spread(quiet) < spread(mus) / 4,
            "a quiet passage shimmers as much as a loud one");
  el._mouth = null;
});

test("first-run with readiness incomplete shows Needs setup on console and right knob", () => {
  const el = station({ dj: "off", player: "idle", card: { state: "idle" } });
  el._ready = {
    data: {
      readiness: {
        state: "needs_setup",
        headline: "Needs setup",
        detail: "Choose which speakers ParlorWave may DJ on, pick a voice in the Booth, and turn the DJ on.",
        complete: 1,
        total: 4,
        blockers: [],
      },
    },
  };
  const bs = el._broadcastState();
  assert.equal(bs.label, "Needs setup");
  assert.equal(bs.tone, "setup");
  assert.equal(bs.detail, "1 of 4 setup steps done");

  const html = el._renderConsole(el._dj, bs, false);
  assert.ok(html.includes("Needs setup"), "right knob status shows Needs setup");
  assert.ok(html.includes("setup-callout console-foot"), "footer callout rendered");
  assert.ok(html.includes('data-goto="settings"'), "inlink to Settings rendered");
});

test("loading-state knob polish: disabled left knob remains visually solid with opacity 1 and its status unlit", () => {
  const el = station({ dj: "unavailable", player: "idle", card: { state: "idle" } });
  const bs = el._broadcastState();
  const html = el._renderConsole(null, bs, false);
  // the fabric carries no lamp; the LCD header says it, unlit.
  assert.ok(!/class="knob-led[ "]/.test(html) && !html.includes("knob-status"), "no lamp or label on the fabric");
  assert.ok(html.includes("lcd-status-dj lcd-tone-dim"), "the LCD header's DJ part is unlit");
  assert.ok(html.includes("DJ UNAVAILABLE"), "and says so");
  assert.ok(SRC.includes(".dj-switch:not(.pending):disabled { opacity:1; }"), "dj-switch disabled is solid opacity 1");
  assert.ok(!SRC.includes(".dj-switch:not(.pending):disabled { opacity:.55; }"), "no translucent 0.55 opacity");
});

test("grille instruction text removed: no static knob-action or knob-sub labels on grille face", () => {
  const el = station({ dj: "on", player: "playing", card: { state: "playing" } });
  const bs = el._broadcastState();
  const html = el._renderConsole(el._dj, bs, true);
  assert.ok(!html.includes("knob-sub"), "no knob-sub container");
  assert.ok(!html.includes("knob-action"), "no knob-action class");
  assert.ok(!html.includes("2-Click for power"), "no static 2-Click for power text");
  assert.ok(!html.includes("Turn for volume"), "no static Turn for volume text");
  assert.ok(!html.includes("2-Click for speaker"), "no static 2-Click for speaker text");
  assert.ok(!html.includes("Turn to tune"), "no static Turn to tune text");
});

test("knob hover help: one vocabulary across caption and tooltip, and no native title", () => {
  const el = station({ dj: "on", player: "playing", card: { state: "playing" } });
  const bs = el._broadcastState();
  const html = el._renderConsole(el._dj, bs, true);
  assert.ok(!/<button[^>]*id="dj-switch"[^>]*title=/.test(html), "the DJ knob has no native title");
  assert.ok(!/<button[^>]*id="right-knob"[^>]*title=/.test(html), "the right knob has no native title");
  assert.ok(html.includes('<span class="knob-caption" aria-hidden="true">Volume \u00b7 DJ</span>'), "left caption");
  assert.ok(html.includes('<span class="knob-caption" aria-hidden="true">Tuning \u00b7 Speakers</span>'), "right caption");
  assert.ok(html.includes("Turn: volume \u00b7 Push twice: DJ on/off"), "left knob tooltip text");
  assert.ok(html.includes("Turn: stations \u00b7 Push twice: speakers"), "right knob tooltip text");
  for (const stale of ["2 click for power", "2 click for Setup", "1 click for Tune"]) assert.ok(!html.includes(stale), stale);
});

test("center script logo: vintage mark centered above display with double-click toggle", () => {
  const el = station({ dj: "on", player: "playing", card: { state: "playing" } });
  const bs = el._broadcastState();

  // default: logo -- the production wordmark, as an image, named for assistive tech
  let html = el._renderConsole(el._dj, bs, true);
  assert.ok(html.includes('id="console-badge"'), "console badge rendered");
  assert.ok(html.includes('aria-label="ParlorWave"'), "default logo is named ParlorWave");
  assert.ok(html.includes('class="console-badge-emblem" src="data:image/svg+xml'), "the wordmark is the embedded vector");
  assert.ok(!html.includes("console-badge-plate"), "no plate in logo mode");

  // cycle to station name -- the engraved plate, the name live in it
  el._cycleCenterLogo();
  assert.equal(el._centerLogoMode, "station");
  html = el._renderConsole(el._dj, bs, true);
  const stationName = el._stationIdentityName();
  assert.ok(html.includes(`aria-label="${stationName}"`), "the button is named with the configured station name");
  assert.ok(html.includes(`<text class="pw-plate-ink" data-line="0"`), "the name is live text");
  assert.ok(html.includes(`>${stationName}</text>`), "shows configured station name");
  assert.ok(html.includes('class="console-badge-plate-body" src="data:image/svg+xml'), "the plate's metal is an image");
  assert.ok(!html.includes("console-badge-emblem"), "no wordmark in station mode");

  // cycle to hidden
  el._cycleCenterLogo();
  assert.equal(el._centerLogoMode, "hidden");
  html = el._renderConsole(el._dj, bs, true);
  assert.ok(html.includes("badge-hidden"), "badge-hidden class applied");
  assert.ok(html.includes('aria-label="Radio badge hidden"'), "hidden is said, not silent");

  // cycle back to logo
  el._cycleCenterLogo();
  assert.equal(el._centerLogoMode, "logo");
  html = el._renderConsole(el._dj, bs, true);
  assert.ok(html.includes('aria-label="ParlorWave"'), "cycled back to ParlorWave");
});

// --- the badge's artwork ---------------------------------------------------
test("badge: the logo mode is remembered, and a station name change reaches the plate", () => {
  const store = {};
  const saved = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  try {
    const el = station({ dj: "on", player: "playing", card: { state: "playing" },
                         djAttrs: { station_name: "Deep Tracks 97.5" } });
    const bs = el._broadcastState();
    el._setCenterLogoMode("station");
    assert.equal(store.parlorwave_logo_mode, "station", "the mode is persisted where the constructor reads it");
    let html = el._renderConsole(el._dj, bs, true);
    assert.ok(html.includes('aria-label="Deep Tracks 97.5"'), "the configured name, exactly");
    assert.ok(html.includes('>Deep Tracks 97.5</text>'), "engraved as configured; uppercase is the stylesheet's");
    // the backend renames the station: the next render carries the new name
    el._hass.states["sensor.dj"].attributes.station_name = "Late Night Vinyl";
    html = el._renderConsole(el._dj, bs, true);
    assert.ok(html.includes('aria-label="Late Night Vinyl"'), "renamed");
    assert.ok(!html.includes("Deep Tracks"), "the old name is gone");
    // no configured name at all: the fallback identity, never an empty plate
    delete el._hass.states["sensor.dj"].attributes.station_name;
    html = el._renderConsole(el._dj, bs, true);
    assert.ok(html.includes('aria-label="ParlorWave Radio"'), "the identity fallback");
  } finally {
    if (saved === undefined) delete globalThis.localStorage; else globalThis.localStorage = saved;
  }
});

test("badge: a station name with markup characters is escaped everywhere it appears", () => {
  const el = station({ dj: "on", player: "playing", card: { state: "playing" },
                       djAttrs: { station_name: 'Rock & Roll "Classics" <3' } });
  el._setCenterLogoMode("station");
  const html = el._renderConsole(el._dj, el._broadcastState(), true);
  assert.ok(html.includes('aria-label="Rock &amp; Roll &quot;Classics&quot; &lt;3"'), "the accessible name is escaped");
  assert.ok(html.includes('>Rock &amp; Roll &quot;Classics&quot; &lt;3</text>'), "the engraving is escaped");
  assert.ok(!html.includes("<3"), "no raw markup reaches the tree");
  assert.ok(!decodeURIComponent(html.match(/console-badge-plate-body" src="([^"]+)"/)[1]).includes("Rock"),
            "the name never enters the plate's image");
});

test("badge: the plate's metal is a pure function of the fitted size and carries no text", () => {
  const el = station({});
  const a = el._plateBodyUrl(345, 52), b = el._plateBodyUrl(345, 52), c = el._plateBodyUrl(224, 52);
  assert.equal(a, b, "cached");
  assert.notEqual(a, c);
  const svg = decodeURIComponent(a.replace(/^data:image\/svg\+xml;charset=utf-8,/, ""));
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 150">'));
  assert.ok(svg.includes('width="345" height="52" rx="5" fill="url(#pw-plate-brass)"'), "the plate at the fitted width");
  assert.ok(svg.includes('filter="url(#pw-plate-finish)"') && svg.includes('filter="url(#pw-plate-screw)"'), "the finish and the screws");
  assert.ok(!svg.includes("<text"), "no text in the metal");
  assert.ok(!svg.includes("<script") && !svg.includes("href"), "nothing executable, nothing external");
});

test("badge: fitting a name tightens, then shrinks, then wraps, and never truncates", () => {
  const el = station({});
  // a stand-in for the browser's measurement: proportional to the glyphs and the tracking
  const measure = (text, size, tracking) => text.length * (size * 0.62 + tracking);
  const short = el._fitPlateName("QPRW FM", measure, 1, 10);
  assert.deepEqual(short.lines, ["QPRW FM"]);
  assert.equal(short.size, 22); assert.equal(short.tracking, 3.2); assert.equal(short.overflow, false);
  assert.equal(short.width, 224, "never narrower than the smallest plate");
  const mid = el._fitPlateName("Deep Tracks 97.5", measure, 1, 10);
  assert.deepEqual(mid.lines, ["Deep Tracks 97.5"]);
  assert.ok(mid.width > 224 && mid.width <= 440, "the plate grows with the name");
  const long = el._fitPlateName("The Saturday Night Jazz Lounge", measure, 1, 10);
  assert.equal(long.lines.join(" "), "The Saturday Night Jazz Lounge", "the whole name, always");
  assert.ok(long.size < 22 || long.lines.length === 2, "it gave something up to fit");
  assert.equal(long.overflow, false);
  // on a phone the type may not shrink under the legible floor: two lines come first
  const phone = el._fitPlateName("The Saturday Night Jazz Lounge", measure, 160 / 440, 8);
  assert.equal(phone.lines.length, 2, "two lines on a phone");
  assert.deepEqual(phone.lines, ["The Saturday", "Night Jazz Lounge"], "split where the longer line is shortest");
  assert.equal(phone.size, 22, "two lines keep the one-line type size");
  assert.equal(phone.tracking, 2.2); assert.equal(phone.height, 80);
  assert.deepEqual(phone.baselines, [69.2, 96.2]);
  // a single word that cannot wrap is reported, not cut
  const word = "Supercalifragilisticexpialidociousradiostation";
  const one = el._fitPlateName(word, measure, 1, 10);
  assert.deepEqual(one.lines, [word]);
  assert.equal(one.overflow, true);
  assert.equal(one.width, 440, "the plate stops at the badge zone");
});

test("badge: the remembered fit paints first, so a routine update does not reflow the plate", () => {
  const el = station({ dj: "on", player: "playing", card: { state: "playing" },
                       djAttrs: { station_name: "Late Night Vinyl" } });
  el._setCenterLogoMode("station");
  el._plateFit = { key: "x", name: "Late Night Vinyl",
                   fit: { lines: ["Late Night", "Vinyl"], size: 20, tracking: 2.2, width: 300, height: 80, baselines: [66.5, 91.5] } };
  const html = el._renderConsole(el._dj, el._broadcastState(), true);
  assert.ok(html.includes('data-line="0" x="260" y="66.5" font-size="20" letter-spacing="2.2">Late Night</text>'));
  assert.ok(html.includes('data-line="1" x="260" y="91.5" font-size="20" letter-spacing="2.2">Vinyl</text>'));
  assert.ok(decodeURIComponent(html.match(/console-badge-plate-body" src="([^"]+)"/)[1]).includes('width="300" height="80"'));
  assert.ok(html.includes('class="console-badge badge-station badge-two-line"'), "the badge says its plate runs to two lines");
  // a different name ignores the stale fit
  el._hass.states["sensor.dj"].attributes.station_name = "QPRW";
  const fresh = el._renderConsole(el._dj, el._broadcastState(), true);
  assert.ok(fresh.includes('font-size="22" letter-spacing="3.2">QPRW</text>'), "the standard setting until measured");
  assert.ok(fresh.includes('data-line="1" x="260" y="82.5" font-size="22" letter-spacing="3.2"></text>'), "an empty second line");
  assert.ok(fresh.includes('class="console-badge badge-station"'), "one line: no two-line flag");
});

test("badge: without a browser to measure in, fitting is a no-op and the render stays whole", () => {
  const { el } = mounted({ card: { state: "playing" } });
  el._render = Object.getPrototypeOf(el)._render;   // the real render, not the fixture's stub
  el._centerLogoMode = "station";
  el._render();
  assert.doesNotThrow(() => el._fitCenterBadge());
  assert.ok(el.shadowRoot.innerHTML.includes('id="console-badge"'));
  el.disconnectedCallback();
});

// --- a DJ break's sleeve ---------------------------------------------------
// Music Assistant carries no image for a break, so its sleeve is always the
// fallback. It wears the console's own face instead of a placeholder glyph,
// and it stays a drawn element: no URL, so the album palette never reads it.

test("a DJ break with no artwork wears the console's face, not a placeholder", () => {
  const el = station({ card: DJ_AIRING });
  el._faceplate = "tweed";
  const html = el._renderOnAir();
  assert.ok(html.includes('class="art art-dj" data-fp="tweed"'), "the cabinet finish in use");
  assert.ok(html.includes("art-dj-cloth console-fp-tweed"), "the grille cloth in use");
  assert.ok(html.includes('role="img" aria-label="DJ break"'), "described as what it is");
  assert.ok(!html.includes("art-empty"), "no placeholder");
  assert.ok(!html.includes('<img class="art"'), "not an image");
  assert.equal(el._artUrl(), null, "no artwork URL, so no palette extraction");
});

test("a DJ break that does carry artwork still shows it", () => {
  const el = station({ card: { ...DJ_AIRING, art_url: "http://ma.example/imageproxy/x" } });
  const html = el._renderOnAir();
  assert.ok(html.includes('<img class="art"'), "real artwork wins");
  assert.ok(!html.includes("art-dj"), "no drawn sleeve over it");
});

test("music and news without artwork are unchanged by the DJ sleeve", () => {
  const music = station({ card: MUSIC })._renderOnAir();
  assert.ok(music.includes('class="art art-empty" role="img" aria-label="No artwork"'), "music keeps its placeholder");
  assert.ok(!music.includes("art-dj"), "music never wears the DJ sleeve");
  const news = station({ card: NEWS_AIRING })._renderOnAir();
  assert.ok(news.includes('<img class="art"'), "news keeps its own artwork");
  assert.ok(!news.includes("art-dj"), "news never wears the DJ sleeve");
});


// ======================================================================
// 9. ALPHA.4 FIXES: attention, the DJ hold, words for refusals,
//    the Save guard, live regions in place
// ======================================================================
const ATTENTION = {
  state: "needs_attention", known: true, headline: "Needs attention.", blockers: [], complete: 0, total: 4,
  checklist: [{ key: "music_assistant", label: "Music Assistant connected", done: false, code: "ma_unreachable",
                detail: "Music Assistant did not answer. Check that Music Assistant is running, and that this server can reach it over the network.",
                where: "addon" },
              { key: "outputs", label: "A speaker the DJ may use", done: false }],
  diagnostics: { problems: [{ code: "ma_unreachable", severity: "blocker" }] },
};
const withReadiness = (el, r) => { el._ready = { at: Date.now(), data: { readiness: r } }; return el; };

test("a Music Assistant outage reaches the state line, in the step's own words, with the way to Settings", () => {
  const el = withReadiness(station({ dj: "off", player: "idle" }), ATTENTION);
  const bs = el._broadcastState();
  assert.equal(bs.label, "Needs attention");
  assert.equal(bs.tone, "alert");
  assert.ok(bs.detail.startsWith("Music Assistant did not answer"));
  assert.equal(bs.action, "settings");
  const html = el._renderOnAir();
  assert.ok(html.includes('data-goto="settings"') && html.includes("Open Settings"), "a door to Settings on the state line");
  // a merely unfinished setup (no attention) is unchanged: DJ off says DJ off
  const calm = withReadiness(station({ dj: "off", player: "idle" }), { ...ATTENTION, state: "needs_setup", diagnostics: { problems: [] } });
  assert.equal(calm._broadcastState().label, "Needs setup", "an unfinished setup keeps its own, calmer word");
});

test("the console foot names the step that needs attention, not the speakers", () => {
  const el = withReadiness(station({ dj: "off", player: "idle" }), ATTENTION);
  const foot = el._renderConsole(el._dj, el._broadcastState(), false);
  assert.ok(foot.includes("<b>Needs attention.</b>"), "needs attention first");
  assert.ok(foot.includes("Music Assistant did not answer"));
  assert.ok(!foot.includes("No speakers are enabled for the DJ."), "not the speakers, which cannot be chosen until MA answers");
  const calm = withReadiness(station({ dj: "off", player: "idle" }), { ...ATTENTION, state: "needs_setup", headline: "Not quite ready.", diagnostics: { problems: [] } });
  const foot2 = calm._renderConsole(calm._dj, calm._broadcastState(), false);
  assert.ok(foot2.includes("Not quite ready.") && foot2.includes("Open Settings to finish setup"), "needs_setup keeps its own words");
});

test("Station says 'Needs attention' instead of 'start an album in Music Assistant'", () => {
  const el = withReadiness(station({ dj: "off", player: "idle", djAttrs: { observer: { running: true, queue_id: null }, outputs_enabled: [] } }), ATTENTION);
  const rows = el._stationTruthRows();
  assert.ok(rows.includes("Needs attention") && rows.includes("Music Assistant did not answer"));
  assert.ok(!rows.includes("Watching for playback"), "no 'start an album' advice over an outage");
  const fine = station({ dj: "on", player: "idle", djAttrs: { observer: { running: true, queue_id: null }, outputs_enabled: [] } });
  assert.ok(fine._stationTruthRows().includes("Watching for playback"), "and it is back once MA answers");
});

test("the DJ knob stays pending after the call returns, until the entity echoes; a second push is refused", async () => {
  const el = station({ dj: "off", player: "playing", card: MUSIC });
  el._toggle(el._dj);
  await tick();
  assert.equal(el.writes.length, 1, "one write");
  assert.ok(el._djHold && el._djHold.want === "on", "held for 'on'");
  let html = djHtml(el);
  assert.ok(cls(html).includes("pending") && html.includes('aria-busy="true"') && html.includes("disabled"), "pending with the light unchanged");
  assert.ok(html.includes('aria-checked="false"'), "never optimistic");
  el._toggle(el._dj);
  await tick();
  assert.equal(el.writes.length, 1, "the second push during the hold writes nothing");
  // the echo settles it
  el._hass.states["switch.dj"].state = "on";
  html = djHtml(el);
  assert.equal(cls(html), "on");
  assert.equal(el._djHold, null, "hold released on the echo");
  el._clearNotice();
});

test("a hold that runs out gives up and says so once; a refused write releases it", async () => {
  const el = station({ dj: "on", player: "playing", card: MUSIC });
  el._toggle(el._dj);
  await tick();
  el._djHold.until = Date.now() - 1;
  const html = djHtml(el);
  assert.equal(cls(html), "on", "no longer pending");
  assert.equal(el._djHold, null);
  assert.ok(el._notice && !el._notice.ok && el._notice.text.includes("did not confirm") && el._notice.text.includes("DJ ON"), el._notice && el._notice.text);
  el._clearNotice();
  const refused = station({ dj: "on", player: "playing", card: MUSIC });
  refused._hass.callService = () => Promise.reject(new Error("/settings/dj answered 503: busy"));
  refused._toggle(refused._dj);
  await tick(); await tick();
  assert.equal(refused._djHold, null, "a refused write holds nothing");
  assert.equal(cls(djHtml(refused)), "on");
  refused._clearNotice();
});

test("a refusal is shown as a sentence; the original travels as the notice's detail", () => {
  const el = station({});
  const h = el._humanRefusal(new Error("/settings/bulletins answered 422: bulletins.sources[0].feed_url must be an http(s) URL"));
  assert.equal(h.text, "The feed address must start with http://… or https://…");
  assert.ok(h.detail.startsWith("/settings/bulletins answered 422"));
  assert.equal(el._humanRefusal("/settings/bulletins answered 422: bulletins.sources[0].target_minute must be 0-59").text, "Choose a schedule from the list.");
  assert.equal(el._humanRefusal("/news/settings answered 500: boom").text, "ParlorWave Radio could not make that change just now. Try again in a moment.");
  const other = el._humanRefusal("/settings/dj answered 422: cadence must be a number");
  assert.ok(other.text.startsWith("ParlorWave Radio refused the change: cadence must be a number"));
  assert.ok(!other.text.includes("/settings") && !other.text.includes("422"), "no path, no status");
  assert.equal(el._humanRefusal("That change was not saved.").detail, null, "a plain sentence needs no detail");
  el._refuse("", "/settings/bulletins answered 422: bulletins.sources[0].feed_url must be an http(s) URL");
  assert.equal(el._notice.text, "The feed address must start with http://… or https://…");
  assert.ok(el._notice.detail.includes("feed_url"));
  el._clearNotice();
});

test("a request refused for want of a speaker, or a station code, is said in words", () => {
  const el = station({});
  assert.ok(el._songSay({ ok: false, reason: "no_output_configured" }, "Lost Bells").text.startsWith("No speaker is enabled for the DJ yet."));
  const unknown = el._songSay({ ok: false, reason: "queue_locked_by_owner" }, "Lost Bells").text;
  assert.ok(unknown.includes("queue locked by owner") && !unknown.includes("queue_locked_by_owner"), unknown);
  assert.ok(el._liveProblem("station_state_unreadable").startsWith("The station's state could not be read."));
  assert.ok(el._liveProblem("maintenance_failed").includes("could not add songs"));
  assert.ok(!el._liveProblem("never_seen_code").includes("never_seen_code"));
});

test("Newsroom Save refuses a source with no address instead of dropping it under a success", async () => {
  const el = station({});
  el._newsdesk = { at: Date.now(), data: { newsroom: { bulletins: { enabled: true, sources: [] } } } };
  el._newsSrcDraft = [{ id: "", name: "City Desk", feed_url: "", enabled: true, target_minute: 30 }];
  await el._saveNews();
  assert.equal(el.writes.length, 0, "nothing written");
  assert.ok(el._notice && !el._notice.ok && el._notice.text.startsWith("City Desk has no feed address"), el._notice && el._notice.text);
  assert.equal(el._newsSrcDraft.length, 1, "the typed row is kept");
  el._clearNotice();
  el._newsSrcDraft = [{ id: "", name: "City Desk", feed_url: "https://…/city.xml", enabled: true, target_minute: 30 }];
  await el._saveNews();
  assert.ok(el.writes.some((w) => JSON.stringify(w).includes("parlorwave_radio/news_save")), "a complete source is written");
  el._clearNotice();
});

test("the live regions are written once beside the stylesheet, and their text changes only when the message does", () => {
  const el = station({ dj: "on", player: "playing", card: MUSIC });
  const writes = { "sr-status": [], "sr-alert": [] };
  const node = (id) => ({ set textContent(t) { writes[id].push(t); }, get textContent() { return writes[id].at(-1) || ""; } });
  const nodes = { "sr-status": node("sr-status"), "sr-alert": node("sr-alert") };
  el.shadowRoot = { getElementById: (id) => nodes[id] || null, innerHTML: "" };
  el._view = "onair";
  const bs = el._broadcastState();
  el._announce(bs); el._announce(bs); el._announce(bs);
  assert.deepEqual(writes["sr-status"], ["Playing · Den"], "said once, not once per render");
  assert.deepEqual(writes["sr-alert"], [], "no alert, nothing said");
  el._notice = { ok: true, text: "Done." };
  el._announce(bs); el._announce(bs);
  assert.deepEqual(writes["sr-status"], ["Playing · Den", "Done."], "a success is news once");
  el._notice = null;
  el._announce(bs);
  assert.deepEqual(writes["sr-status"], ["Playing · Den", "Done."], "its going away is not");
  el._notice = { ok: false, text: "The feed address must start with http://… or https://…" };
  el._announce(bs);
  assert.deepEqual(writes["sr-alert"], ["The feed address must start with http://\u2026 or https://\u2026"]);
  el._notice = null;
  // the markup the tree writer emits carries no live region of its own
  const html = el._renderOnAir() + el._renderProblems();
  assert.ok(!html.includes("aria-live") && !html.includes('role="alert"'), "the rebuilt tree is not a live region");
  assert.ok(SR.includes('id="sr-status"') && SR.includes('id="sr-alert"') && SR.includes('aria-atomic="true"'));
});

test("the Request Line asks no question while the speakers could not be checked", () => {
  const el = station({});
  el._reqLine = { text: "90s Rock", asked: "90s Rock", confirm: true, result: null };
  el._liveTargets = { at: Date.now(), error: true };
  const html = el._renderRequestLine({});
  assert.ok(html.includes("The speakers could not be checked"), "the refusal is said");
  assert.ok(!html.includes("Start a \u201c90s Rock\u201d station"), "no question over it");
  assert.ok(!html.includes('id="rl-confirm"') && html.includes('id="rl-back"'), "only Back");
  el._liveTargets = { at: Date.now(), data: { ok: true, targets: [{ queue_id: "q1", name: "Den", eligible: true }] } };
  const asked = el._renderRequestLine({});
  assert.ok(asked.includes("Start a \u201c90s Rock\u201d station") && asked.includes('id="rl-confirm"'), "and the question returns once they can be");
});

for (const [name, fn] of tests) {
  try { await fn(); passed++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) {
    process.stdout.write(`  FAIL ${name}\n       ${e.message}\n`);
    process.exitCode = 1;
  }
}
process.stdout.write(`\n${passed}/${tests.length} panel console tests passed\n`);
