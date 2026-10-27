/* QUEUE ENDED, EXECUTED.
 *
 * A finite Music Assistant queue can play to its end while MA's cursor still
 * names an old song with a leftover position and the speaker reports
 * "paused". Drawn as an ordinary pause, that invites the listener to press
 * Play on a queue that has nothing left, and MA then replays old
 * music. The backend now publishes the card state "ended" (decided from
 * MA's own evidence, never from idle or a stale elapsed alone); this file
 * pins what the screen does with it:
 *
 *   - the state line says Queue Ended, whatever the player entity claims;
 *   - no song, artist, artwork or progress is shown from the stale cursor
 *     or from the player's own lingering metadata;
 *   - the queue drawer keeps its history and says "Queue ended" instead of
 *     naming a song as playing now;
 *   - an ordinary pause, and playback after Play, are exactly as before;
 *   - presentation writes nothing: no service call, no websocket command.
 *
 *   node ha/tests/test_panel_queue_ended.mjs      (or scripts/test_panel.sh)
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL = join(HERE, "..", "custom_components", "parlorwave_radio",
                   "panel", "parlorwave-radio-panel.js");

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
await import(PANEL);
assert.ok(PanelClass, "the panel did not register its custom element");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* The speaker keeps its stale metadata and says "paused", exactly as a
 * cast group can after its queue finishes. */
function station({ card = null, player = "paused" } = {}) {
  const el = new PanelClass();
  el._render = () => {};
  el.writes = [];
  el._entityMap = { dj_enabled: "switch.dj", dj_status: "sensor.dj",
                    now_playing: "sensor.now", output: "select.out" };
  el._hass = {
    states: {
      "switch.dj": { state: "on", attributes: {} },
      "sensor.dj": { state: "waiting", attributes: { enabled: true } },
      "select.out": { state: "Den", attributes: { output_entity_id: "media_player.den" } },
      "media_player.den": {
        entity_id: "media_player.den", state: player,
        attributes: { friendly_name: "Den", supported_features: 16433,
                      media_title: "Slow Ferry",
                      media_artist: "Marlow Kites",
                      entity_picture: "/api/media_player_proxy/old.jpg" },
      },
    },
    callService: (...a) => { el.writes.push(["service", ...a]); return Promise.resolve(); },
    callWS: (...a) => { el.writes.push(["ws", ...a]); return Promise.resolve({}); },
  };
  if (card) el._hass.states["sensor.now"] = { state: card.state || "playing", attributes: card };
  return el;
}

const ENDED = { queue_id: "q", state: "ended", ended_basis: "final_item_played" };
const PAUSED_SONG = { kind: "music", title: "Slow Ferry", artist: "Marlow Kites",
                      state: "paused", elapsed: 260, duration: 465 };
const PLAYING_SONG = { ...PAUSED_SONG, state: "playing", elapsed: 3, elapsed_at: Date.now() / 1000 };

test("a finished queue says Queue Ended, whatever the speaker claims", () => {
  for (const player of ["paused", "idle", "playing", "off"]) {
    const bs = station({ card: ENDED, player })._broadcastState();
    assert.equal(bs.label, "Queue Ended", player);
    assert.equal(!!bs.lamp, false, player);
  }
});

test("no stale song, artist, artwork or progress is shown", () => {
  const el = station({ card: ENDED });
  const tr = el._track();
  assert.equal(tr.title, "Queue Ended");
  assert.ok(!String(tr.artist).includes("Marlow Kites"));
  assert.equal(tr.art, null);
  assert.equal(el._artUrl(), null);
  assert.equal(el._progress(), null, "a leftover elapsed time is not a position");
});

test("an ordinary pause is still Paused, with its song", () => {
  const el = station({ card: PAUSED_SONG });
  assert.equal(el._broadcastState().label, "Paused");
  assert.equal(el._track().title, "Slow Ferry");
  assert.ok(el._progress());
});

test("after Play the song is back and nothing says ended", () => {
  const el = station({ card: PLAYING_SONG, player: "playing" });
  assert.equal(el._broadcastState().label, "Playing");
  assert.equal(el._track().title, "Slow Ferry");
});

function drawer(el, data) {
  el._queue = { at: Date.now(), data: { ok: true, complete: true, ...data } };
  return el._renderQueue();
}
const music = (t, d = 200) => ({ kind: "music", title: t, artist: "A", duration_s: d });

test("the queue drawer keeps history and names nothing as playing now", () => {
  const html = drawer(station({ card: ENDED }), {
    ended: true, current: music("Slow Ferry"), recent: [music("One")],
    upcoming: [music("Two")], played_count: 1736, upcoming_count: 16, total: 1753 });
  assert.ok(html.includes("Queue ended"));
  assert.ok(!html.includes("Playing now"));
  assert.ok(!html.includes("1 playing now"));
  assert.ok(html.includes("A — One"), "history is preserved");
});

test("an ordinary queue drawer is unchanged", () => {
  const html = drawer(station({ card: PLAYING_SONG, player: "playing" }), {
    current: music("One"), recent: [], upcoming: [music("Two")] });
  assert.ok(html.includes("Playing now"));
  assert.ok(!html.includes("Queue ended"));
});

test("presenting an ended queue writes nothing", () => {
  const el = station({ card: ENDED });
  el._broadcastState();
  el._track();
  el._artUrl();
  drawer(el, { ended: true, current: music("X"), recent: [], upcoming: [] });
  assert.deepEqual(el.writes, []);
});

for (const [name, fn] of tests) {
  try { fn(); passed++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) {
    process.stdout.write(`  FAIL ${name}\n       ${e.message}\n`);
    process.exitCode = 1;
  }
}
process.stdout.write(`\n${passed}/${tests.length} panel queue-ended tests passed\n`);
