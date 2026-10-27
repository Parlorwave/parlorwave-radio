/* The album palette, executed.
 *
 * The panel is a browser component, but the half that decides what colour
 * a record gets -- and how far a generated colour may travel before it
 * stops being readable -- is deliberately pure, so it runs here under
 * plain node with no browser and no DOM. Everything below is about the
 * product rule, not the arithmetic: a sleeve tints the room, the room
 * stays legible, and nothing about this can take the panel down.
 *
 *   node ha/tests/test_palette.mjs        (or scripts/test_panel.sh)
 */

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The panel defines a custom element at import time; stub just enough of a
// browser for the module to evaluate. Nothing below touches the DOM.
globalThis.HTMLElement = class {};
globalThis.customElements = { get: () => true, define: () => {} };

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL = join(HERE, "..", "custom_components", "parlorwave_radio",
                   "panel", "parlorwave-radio-panel.js");
const { PW_PALETTE: P } = await import(PANEL);

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* A flat RGBA field of one colour, the shape getImageData hands over. */
function field(r, g, b, a = 255, n = 1024) {
  const d = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) { d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = a; }
  return d;
}

/* Two colours mixed in a given proportion, to prove the winner is chosen
 * by more than raw frequency. */
function mix(c1, c2, share1, n = 1024) {
  const d = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const c = i < n * share1 ? c1 : c2;
    d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255;
  }
  return d;
}

const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// --- a sleeve with a colour gets that colour ----------------------------
test("a saturated sleeve yields an accent in the same hue family", () => {
  for (const [name, rgb, hueLo, hueHi] of [
    ["blue", [24, 150, 240], 180, 250],
    ["red", [230, 70, 30], 0, 30],
    ["green", [40, 180, 80], 90, 160],
  ]) {
    const theme = P.themeFromPixels(field(...rgb));
    assert.equal(theme.source, "artwork", name);
    const { h, s } = P.rgbToHsl(...hexToRgb(theme.accent));
    assert.ok(h >= hueLo && h <= hueHi, `${name}: accent hue ${Math.round(h)} outside ${hueLo}-${hueHi}`);
    assert.ok(s > 0.4, `${name}: accent lost its saturation (${s.toFixed(2)})`);
  }
});

test("the room is derived from the sleeve and stays dark", () => {
  const theme = P.themeFromPixels(field(24, 150, 240));
  const bg = P.rgbToHsl(...hexToRgb(theme.bg));
  const deep = P.rgbToHsl(...hexToRgb(theme.bgDeep));
  assert.ok(bg.l < 0.15, `background too light: ${bg.l.toFixed(2)}`);
  assert.ok(deep.l < bg.l, "the deep background must be the darker of the two");
  assert.ok(Math.abs(bg.h - 210) < 40, "the room keeps the sleeve's hue");
});

// --- the readability contract -------------------------------------------
test("every generated accent clears the contrast floor against its own room", () => {
  // walk the hue circle at several saturations and lightnesses: no input
  // may produce an accent that cannot be seen on the room it comes with
  for (let h = 0; h < 360; h += 7) {
    for (const s of [0.2, 0.5, 0.85, 1]) {
      for (const l of [0.12, 0.3, 0.5, 0.75, 0.9]) {
        const [r, g, b] = P.hslToRgb(h, s, l);
        const theme = P.themeFromPixels(field(r, g, b));
        const ratio = P.contrastRatio(hexToRgb(theme.accent), hexToRgb(theme.bg));
        assert.ok(ratio >= P.ART_MIN_CONTRAST,
          `hsl(${h},${s},${l}) gave contrast ${ratio.toFixed(2)}`);
      }
    }
  }
});

test("cream body text stays readable on every generated room", () => {
  const TEXT = [244, 239, 230];             // --pw-text
  for (let h = 0; h < 360; h += 11) {
    const [r, g, b] = P.hslToRgb(h, 0.9, 0.5);
    const theme = P.themeFromPixels(field(r, g, b));
    const ratio = P.contrastRatio(TEXT, hexToRgb(theme.bg));
    assert.ok(ratio >= 4.5, `hue ${h}: body text contrast ${ratio.toFixed(2)}`);
  }
});

// --- honest failure ------------------------------------------------------
test("a sleeve with no usable hue keeps the house accent", () => {
  for (const grey of [[160, 160, 160], [90, 90, 92], [220, 218, 220]]) {
    const theme = P.themeFromPixels(field(...grey));
    assert.equal(theme.accent, P.HOUSE_THEME.accent,
      `grey ${grey} invented a colour: ${theme.accent}`);
    assert.equal(theme.source, "artwork-neutral");
  }
});

test("a colourless sleeve leaves a NEUTRAL room, never a brown one", () => {
  for (const grey of [[160, 160, 160], [90, 90, 92], [30, 30, 32], [210, 212, 210]]) {
    for (const key of ["bg", "bgDeep"]) {
      const [r, g, b] = hexToRgb(P.themeFromPixels(field(...grey))[key]);
      assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 2,
        `grey ${grey} tinted the ${key}: rgb(${r},${g},${b})`);
    }
  }
  const [hr, hg, hb] = hexToRgb(P.HOUSE_THEME.bg);
  assert.ok(Math.max(hr, hg, hb) - Math.min(hr, hg, hb) <= 2,
    `the house room is not neutral: ${P.HOUSE_THEME.bg}`);
});

test("a warm room is pulled back; a cool one is not", () => {
  // the same saturation at a warm hue and a cool one: the warm ROOM must
  // end up the less saturated of the two, while the accent stays vivid
  const warm = P.themeFromPixels(field(...P.hslToRgb(25, 0.9, 0.5)));
  const cool = P.themeFromPixels(field(...P.hslToRgb(205, 0.9, 0.5)));
  const sat = (hex) => P.rgbToHsl(...hexToRgb(hex)).s;
  assert.ok(sat(warm.bg) < sat(cool.bg),
    `warm room ${warm.bg} (${sat(warm.bg).toFixed(3)}) not damped against ` +
    `cool ${cool.bg} (${sat(cool.bg).toFixed(3)})`);
  const drop = 1 - sat(warm.bg) / sat(cool.bg);
  assert.ok(drop >= 0.15 && drop <= 0.25, `damping ${(drop * 100).toFixed(0)}% is outside 15-25%`);
  assert.ok(sat(warm.accent) > 0.6, `the warm accent lost its colour: ${warm.accent}`);
});

test("the damping is a band, not a cliff", () => {
  // every hue still produces a usable room, and the far side of the circle
  // is untouched
  const sat = (hex) => P.rgbToHsl(...hexToRgb(hex)).s;
  const cyan = P.themeFromPixels(field(...P.hslToRgb(190, 0.9, 0.5)));
  const green = P.themeFromPixels(field(...P.hslToRgb(130, 0.9, 0.5)));
  assert.ok(Math.abs(sat(cyan.bg) - sat(green.bg)) < 0.02,
    "hues outside the warm band should not be damped differently");
});

test("an accent is strengthened, never manufactured", () => {
  /* A mostly grey sleeve with a faint green cast carries just enough
   * tint to pass the floor, and a flat minimum would turn it into mint
   * green. What comes back must stay in the neighbourhood of
   * what was actually there. */
  const sat = (hex) => P.rgbToHsl(...hexToRgb(hex)).s;
  const faint = P.themeFromPixels(field(...P.hslToRgb(150, 0.13, 0.33)));
  assert.ok(sat(faint.accent) < 0.3,
    `a barely-tinted sleeve produced a vivid accent: ${faint.accent}`);
  // ...while a sleeve that is genuinely coloured still gets a vivid one
  const vivid = P.themeFromPixels(field(...P.hslToRgb(150, 0.85, 0.45)));
  assert.ok(sat(vivid.accent) > 0.7, `a vivid sleeve lost its colour: ${vivid.accent}`);
  // and the lift rises with the colour present, never falls
  let last = 0;
  for (const s of [0.13, 0.2, 0.3, 0.45, 0.7, 0.95]) {
    const got = sat(P.themeFromPixels(field(...P.hslToRgb(210, s, 0.45))).accent);
    assert.ok(got >= last - 0.01, `accent saturation went backwards at ${s}`);
    last = got;
  }
});

test("nothing to sample falls back to the house theme", () => {
  assert.equal(P.themeFromPixels(field(0, 0, 0)).source, "house", "all black");
  assert.equal(P.themeFromPixels(field(255, 255, 255)).source, "house", "all white");
  assert.equal(P.themeFromPixels(field(30, 120, 200, 0)).source, "house", "fully transparent");
  assert.equal(P.themeFromPixels(new Uint8ClampedArray(0)).source, "house", "no pixels");
  assert.equal(P.themeFrom(null).accent, P.HOUSE_THEME.accent, "no dominant colour");
});

test("malformed input returns the house theme instead of throwing", () => {
  for (const junk of [null, undefined, "not pixels", 42, {}]) {
    assert.equal(P.themeFromPixels(junk).source, "house", String(junk));
  }
});

test("every theme is complete: no missing custom property", () => {
  for (const data of [field(24, 150, 240), field(160, 160, 160), field(0, 0, 0)]) {
    const t = P.themeFromPixels(data);
    for (const k of ["accent", "bg", "bgDeep", "glow", "muted"]) {
      assert.ok(t[k], `missing ${k}`);
    }
    assert.match(t.accent, /^#[0-9a-f]{6}$/);
    assert.match(t.bg, /^#[0-9a-f]{6}$/);
  }
});

// --- not an average ------------------------------------------------------
test("opposite hues do not average into mud", () => {
  // half orange, half blue: an average is grey, which is the failure the
  // whole bucketing approach exists to avoid
  const theme = P.themeFromPixels(mix([240, 120, 20], [20, 90, 240], 0.55));
  const { s } = P.rgbToHsl(...hexToRgb(theme.accent));
  assert.ok(s > 0.4, `accent came out desaturated (${s.toFixed(2)}): that is mud`);
});

test("a large dull field loses to a smaller vivid one", () => {
  // 70% near-grey, 30% vivid: frequency alone would pick the grey
  const theme = P.themeFromPixels(mix([120, 118, 122], [235, 60, 40], 0.7));
  const { h, s } = P.rgbToHsl(...hexToRgb(theme.accent));
  assert.ok(s > 0.4 && (h < 30 || h > 330), `expected the red, got ${theme.accent}`);
});

test("the dominant colour reports what it actually found", () => {
  const dom = P.dominantFromPixels(mix([235, 60, 40], [10, 10, 10], 0.5));
  assert.ok(dom, "a half-black sleeve still has a colour");
  assert.ok(dom.share > 0.9, "black pixels are dropped, not counted");
  assert.ok(dom.sat > 0.5);
});

// --- bounded work --------------------------------------------------------
test("the working image stays tiny", () => {
  assert.ok(P.ART_SAMPLE <= 48, `${P.ART_SAMPLE}px working image is too big for a Pi`);
  assert.ok(P.ART_SAMPLE >= 16, "too small to be representative");
});

test("a full-size sleeve is handled in well under a frame", () => {
  const data = mix([240, 120, 20], [20, 90, 240], 0.5, P.ART_SAMPLE * P.ART_SAMPLE);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 50; i++) P.themeFromPixels(data);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 50;
  assert.ok(ms < 8, `${ms.toFixed(2)} ms per sleeve is too slow`);
});

// --- the real covers, when they are around -------------------------------
test("the recorded test covers produce their expected families", () => {
  const dir = process.env.PW_ART_DIR;
  if (!dir || !existsSync(join(dir, "blue.rgba"))) return;   // fixtures optional
  const expect = { blue: [180, 250], red: [0, 40], green: [90, 160] };
  for (const [name, [lo, hi]] of Object.entries(expect)) {
    const data = new Uint8ClampedArray(readFileSync(join(dir, `${name}.rgba`)));
    const { h } = P.rgbToHsl(...hexToRgb(P.themeFromPixels(data).accent));
    assert.ok(h >= lo && h <= hi, `${name}: hue ${Math.round(h)} outside ${lo}-${hi}`);
  }
  const mono = new Uint8ClampedArray(readFileSync(join(dir, "mono.rgba")));
  assert.equal(P.themeFromPixels(mono).accent, P.HOUSE_THEME.accent);
});

for (const [name, fn] of tests) {
  try { fn(); passed++; process.stdout.write(`  ok  ${name}\n`); }
  catch (e) {
    process.stdout.write(`  FAIL ${name}\n       ${e.message}\n`);
    process.exitCode = 1;
  }
}
process.stdout.write(`\n${passed}/${tests.length} palette tests passed\n`);
