/* New custom voices are not offered in this release: the Booth, EXECUTED.
 *
 * The backend publishes cloning.reason "not_qualified" and refuses new
 * voices itself. The voice library's real render must then:
 *
 *   * show Add voice in its place, disabled, with the backend's sentence --
 *     whether or not an engine is configured -- and nothing that could
 *     start an enrollment;
 *   * offer no Replace on an existing voice (a new recording is an
 *     enrollment), while that voice is still listed, choosable,
 *     previewable and deletable -- including one from before the
 *     acknowledgement was asked, shown as "Permission not recorded";
 *   * and, for a backend that offers enrollment, render exactly as before.
 *
 *   node ha/tests/test_panel_voice_gate.mjs      (or scripts/test_panel.sh)
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL = join(HERE, "..", "custom_components", "parlorwave_radio",
                   "panel", "parlorwave-radio-panel.js");

class FakeEl {
  constructor() {
    this.dataset = {};
    this.style = { setProperty() {}, removeProperty() {}, getPropertyValue() { return ""; } };
    this.classList = { add() {}, remove() {}, contains() { return false; } };
  }
  addEventListener() {}
  removeEventListener() {}
  getElementById() { return null; }
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

const MESSAGE = "Making a voice from a recording is not available in this release " +
  "while it is still being tested. Voices already on this installation keep working.";
const CONSENT = { text: "I have permission to create and use this voice in Parlorwave.",
                  version: "voice-permission-v1" };

/* A library as the backend serves it: a voice from the 0.1.0-alpha.1
 * preview (no acknowledgement on record) chosen as the DJ, and one made in
 * the Booth with it. */
function library(cloning) {
  return {
    ok: true,
    kokoro: [], home_assistant: [],
    customs: [
      { voice_id: "custom_1", name: "Evening Reader", has_sample: true, scope: "both",
        authorization: { status: "granted", granted_at: "2026-09-29T18:00:00Z",
                         source: "recording" } },
      { voice_id: "custom_2", name: "Studio Ray", has_sample: true, scope: "dj",
        authorization: { status: "unrecorded", granted_at: null, source: null } },
      { voice_id: "custom_3", name: "", has_sample: false, scope: "dj",
        authorization: { status: "unrecorded", granted_at: null, source: null } },
    ],
    selected: { voice_id: "custom_2" },
    cloning: { consent: CONSENT, processing: "Custom voices are processed by your " +
               "configured ParlorWave voice engine.", ...cloning },
    preview: { max_chars: 200 },
  };
}

function booth(cloning) {
  const el = new PanelClass();
  el._hass = { states: {}, callWS: () => Promise.resolve({}),
               callService: () => Promise.resolve() };
  el._view = "booth";
  el._voicesOpen = true;
  el._voiceLib = library(cloning);
  return el;
}

const GATED = { configured: true, available: false, reason: "not_qualified", message: MESSAGE };

test("with an engine, Add voice is shown disabled with the backend's sentence", () => {
  const html = booth(GATED)._renderVoiceLibrary();
  assert.match(html, /<button class="ghost" disabled aria-disabled="true"\s+title="Not available in this release">＋ Add voice<\/button>/);
  assert.ok(html.includes(MESSAGE), "the backend's sentence is not shown");
  assert.ok(html.includes("Home Assistant's own voices work as usual."));
});

test("nothing that could start an enrollment is rendered", () => {
  const html = booth(GATED)._renderVoiceLibrary();
  for (const banned of ['id="voice-create"', "data-vreplace", "create-file", "create-go", "<input type=\"file\""]) {
    assert.ok(!html.includes(banned), `rendered ${banned}`);
  }
});

test("without an engine the answer is the same: no promise that one would help", () => {
  const html = booth({ ...GATED, configured: false })._renderVoiceLibrary();
  assert.ok(html.includes(MESSAGE));
  assert.ok(!html.includes("switches on by\n        itself"), "promised that an engine turns it on");
  assert.ok(!html.includes('id="voice-create"'));
});

test("existing voices stay: listed, choosable, previewable, deletable", () => {
  const html = booth(GATED)._renderVoiceLibrary();
  for (const id of ["custom_1", "custom_2"]) {
    assert.ok(html.includes(`data-preview="${id}"`), `${id} has no preview`);
    assert.ok(html.includes(`data-vdelete="${id}"`), `${id} has no delete`);
  }
  assert.ok(html.includes('data-vpick="Studio Ray"'), "the preview voice cannot be chosen");
  assert.ok(html.includes('data-vpick="Evening Reader"'));
  // the voice from before the question says so, and is not hidden for it
  assert.ok(html.includes("Permission not recorded"));
  assert.ok(html.includes("Permission recorded"));
  // an empty slot is still not a voice
  assert.ok(!html.includes('data-preview="custom_3"'));
});

test("a backend that offers enrollment renders exactly as before", () => {
  const html = booth({ configured: true, available: true, reason: "" })._renderVoiceLibrary();
  assert.ok(html.includes('id="voice-create"'));
  assert.ok(html.includes('data-vreplace="custom_1"'));
  assert.ok(html.includes('data-vreplace="custom_2"'));
  assert.ok(!html.includes(MESSAGE));
});

test("the gate is read in one place, from the backend's own words", () => {
  const el = booth(GATED);
  assert.equal(el._enrollmentOff(), true);
  el._voiceLib.cloning.reason = "unreachable";
  assert.equal(el._enrollmentOff(), false);
  el._voiceLib = null;
  assert.equal(el._enrollmentOff(), false);
});

for (const [name, fn] of tests) {
  try { await fn(); passed += 1; }
  catch (e) { console.error(`FAIL ${name}\n  ${e && e.stack || e}`); process.exitCode = 1; }
}
console.log(`${passed}/${tests.length} voice gate checks passed`);
