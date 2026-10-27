/* The Booth's "Music stories" row, EXECUTED through the real Break style
 * render: present under "Speak DJ breaks" when the integration has the
 * dj_stories switch, reading its state; absent -- not broken -- on an
 * integration without it, so a newer panel on an older integration shows
 * exactly what it showed before.
 *
 *   node ha/tests/test_panel_stories_row.mjs   (or scripts/test_panel.sh)
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

const sw = (id, state, name) => ({ entity_id: id, state,
  attributes: { friendly_name: `Parlorwave Radio ${name}` } });

function breakStyle(map, states) {
  const el = new PanelClass();
  el._entityMap = map;
  el._hass = { states };
  return el._renderBreakStyle();
}

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

test("the row sits under Speak DJ breaks and reads the switch", () => {
  const html = breakStyle({ dj_speech: "switch.speech", dj_stories: "switch.stories" }, {
    "switch.speech": sw("switch.speech", "on", "Speak DJ breaks"),
    "switch.stories": sw("switch.stories", "off", "Music stories"),
  });
  const speech = html.indexOf('data-toggle="switch.speech"');
  const stories = html.indexOf('data-toggle="switch.stories"');
  assert.ok(speech > 0 && stories > speech, "Music stories must follow Speak DJ breaks");
  assert.match(html, /<div class="label">Music stories<\/div>/);
  assert.match(html, /aria-label="Music stories: Off"/);
  assert.match(html, /Music Assistant/);
});

test("On is not airing: the row says so when the service reports stories cannot air", () => {
  const row = (state, attrs) => {
    const s = sw("switch.stories", state, "Music stories");
    Object.assign(s.attributes, attrs);
    return breakStyle({ dj_stories: "switch.stories" }, { "switch.stories": s });
  };
  const blocked = row("on", { airing: false });
  assert.match(blocked, /aria-label="Music stories: On"/);
  assert.match(blocked, /Not airing in this release yet/);
  assert.doesNotMatch(blocked, /Short true stories/);
  // airing, switched off, or a service that does not say: the usual line
  for (const [state, attrs] of [["on", { airing: true }], ["off", { airing: false }], ["on", {}]]) {
    const html = row(state, attrs);
    assert.match(html, /Short true stories/, `${state} ${JSON.stringify(attrs)}`);
    assert.doesNotMatch(html, /Not airing/);
  }
});

test("an integration without the switch shows no row and nothing else changes", () => {
  const states = { "switch.speech": sw("switch.speech", "on", "Speak DJ breaks") };
  const without = breakStyle({ dj_speech: "switch.speech" }, states);
  assert.doesNotMatch(without, /Music stories/);
  assert.match(without, /data-toggle="switch.speech"/);
});

console.log(`panel stories row: ${passed} passed`);
