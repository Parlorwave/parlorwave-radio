/* "Ready." must not outlive what the integration already knows (without
 * this, Ready can stay green for a minute or more after a wrong Music
 * Assistant token, an add-on restart or an outage). The panel re-reads the
 * readiness document every SETTINGS_MAX_AGE_MS as before -- and AT ONCE when
 * the DJ status sensor's readiness_key changes, which the integration moves
 * when the verdict's inputs change. EXECUTED through _maybeRefreshDemandData,
 * the check every Home Assistant state update runs.
 *
 *   node ha/tests/test_panel_readiness_refresh.mjs   (or scripts/test_panel.sh)
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL = join(HERE, "..", "custom_components", "parlorwave_radio",
                   "panel", "parlorwave-radio-panel.js");

class FakeRoot {
  addEventListener() {}
  removeEventListener() {}
  getElementById() { return null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
globalThis.HTMLElement = class {
  constructor() { this.style = { setProperty() {}, removeProperty() {}, getPropertyValue() { return ""; } }; }
  attachShadow() { this.shadowRoot = new FakeRoot(); return this.shadowRoot; }
};
let PanelClass = null;
globalThis.customElements = { get: () => undefined, define: (_n, c) => { PanelClass = c; } };
await import(PANEL);
assert.ok(PanelClass, "the panel did not register its custom element");

const SENSOR = "sensor.parlorwave_radio_dj_status";

function panel() {
  const el = new PanelClass();
  el._entityMap = { dj_status: SENSOR };
  el._view = "onair";
  el.reads = 0;
  el._render = () => {};
  el._ws = async (type) => {
    if (type === "parlorwave_radio/readiness") el.reads++;
    return { readiness: { state: "ready" } };
  };
  return el;
}

function sensor(el, key, state = "waiting") {
  const attributes = key === undefined ? {} : { readiness_key: key };
  el._hass = { states: { [SENSOR]: { entity_id: SENSOR, state, attributes } } };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ok  ${name}`); };

await test("an unchanged key waits for the timer, as before", async () => {
  const el = panel();
  sensor(el, "ma:1|");
  el._maybeRefreshDemandData(); await settle();
  assert.equal(el.reads, 1, "the first read");
  for (let i = 0; i < 5; i++) { el._maybeRefreshDemandData(); await settle(); }
  assert.equal(el.reads, 1, "a fresh document with the same key is not read again");
});

await test("a changed key reads again at once, however fresh the document", async () => {
  const el = panel();
  sensor(el, "ma:1|");
  el._maybeRefreshDemandData(); await settle();
  sensor(el, "ma:0|ma_auth_rejected");                 // a token Music Assistant refuses
  el._maybeRefreshDemandData(); await settle();
  assert.equal(el.reads, 2);
  sensor(el, "ma:1|");                                  // and the recovery, just as fast
  el._maybeRefreshDemandData(); await settle();
  assert.equal(el.reads, 3);
});

await test("the sensor going unavailable (the service not answering) reads again", async () => {
  const el = panel();
  sensor(el, "ma:1|");
  el._maybeRefreshDemandData(); await settle();
  sensor(el, "ma:1|", "unavailable");
  el._maybeRefreshDemandData(); await settle();
  assert.equal(el.reads, 2);
});

await test("a change while a read is out is asked again once it lands", async () => {
  const el = panel();
  sensor(el, "ma:1|");
  let release;
  el._ws = async (type) => {
    if (type !== "parlorwave_radio/readiness") return {};   // only the readiness read is held
    el.reads++;
    await new Promise((r) => { release = r; });
    return { readiness: { state: "ready" } };
  };
  el._maybeRefreshDemandData();
  sensor(el, "ma:0|ma_unreachable");                    // changes while the first read is out
  el._maybeRefreshDemandData();                         // in flight: no second call yet
  assert.equal(el.reads, 1);
  release(); await settle(); await settle();
  el._ws = async (type) => { if (type === "parlorwave_radio/readiness") el.reads++; return {}; };
  el._maybeRefreshDemandData(); await settle();
  assert.equal(el.reads, 2, "the answer was for the old key");
});

await test("an integration without the key keeps the timer alone", async () => {
  const el = panel();
  sensor(el, undefined);
  el._maybeRefreshDemandData(); await settle();
  for (let i = 0; i < 3; i++) { el._maybeRefreshDemandData(); await settle(); }
  assert.equal(el.reads, 1);
  assert.equal(el._readinessKey(), undefined);
});

/* A page load reads readiness before the entity map has arrived, so that
 * first document cannot say which key it answered for. Without this case,
 * a Settings screen opened moments before a refused token keeps green
 * Ready, and one opened just after a restart keeps "Checking this
 * installation", after the integration has the answer -- until the 30 s
 * timer. */
function freshPage(key, state) {
  const el = panel();
  el._view = "settings";
  el._entityMap = null;                                 // the page has just loaded
  sensor(el, key, state);
  return el;
}

await test("Settings opened just before a refused token reads the refusal at once", async () => {
  const el = freshPage("ma:1|");
  el._maybeRefreshDemandData(); await settle();
  assert.equal(el.reads, 1, "the first read, before the entity map");
  assert.equal(el._ready.key, undefined);
  el._entityMap = { dj_status: SENSOR };                // the entity map arrives
  el._maybeRefreshDemandData(); await settle();
  assert.equal(el.reads, 2, "the keyless document is read once more");
  assert.equal(el._ready.key, "ma:1|");
  for (let i = 0; i < 3; i++) { el._maybeRefreshDemandData(); await settle(); }
  assert.equal(el.reads, 2, "once: no further reads while nothing changes");
  sensor(el, "ma:0|ma_auth_rejected");
  el._maybeRefreshDemandData(); await settle();
  assert.equal(el.reads, 3, "the refusal is read at once, not on the timer");
});

await test("Settings opened just after a restart follows the service as it comes back", async () => {
  const el = freshPage("ma:1|", "unavailable");          // the service is not answering yet
  el._maybeRefreshDemandData(); await settle();
  el._entityMap = { dj_status: SENSOR };
  el._maybeRefreshDemandData(); await settle();
  assert.equal(el.reads, 2);
  assert.equal(el._ready.key, "");
  sensor(el, "ma:0|ma_auth_rejected");                  // it answers: Music Assistant refuses the token
  el._maybeRefreshDemandData(); await settle();
  assert.equal(el.reads, 3);
  sensor(el, "ma:1|");                                  // the token is fixed
  el._maybeRefreshDemandData(); await settle();
  assert.equal(el.reads, 4);
});

await test("an integration without the key costs no extra read after a page load", async () => {
  const el = freshPage(undefined);
  el._maybeRefreshDemandData(); await settle();
  el._entityMap = { dj_status: SENSOR };
  for (let i = 0; i < 3; i++) { el._maybeRefreshDemandData(); await settle(); }
  assert.equal(el.reads, 1);
});

await test("a refused input leaves the key, and so the reads, alone", async () => {
  const el = panel();
  el._view = "settings";
  sensor(el, "ma:1|");
  el._maybeRefreshDemandData(); await settle();
  const ws = el._ws;
  el._ws = async (type, msg) => {
    if (type === "parlorwave_radio/station_save") throw new Error("refused");
    return ws(type, msg);
  };
  el._stationDraft = "Kitchen Radio";
  await el._saveStationIdentity(); await settle();
  for (let i = 0; i < 3; i++) { el._maybeRefreshDemandData(); await settle(); }
  assert.equal(el.reads, 1);
  assert.equal(el._ready.key, "ma:1|");
});

console.log(`panel readiness refresh: ${passed} passed`);
