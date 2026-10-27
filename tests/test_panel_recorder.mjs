/* Custom voice enrollment: recording in the Booth, EXECUTED.
 *
 * Two halves.
 *
 *   1. The pure functions the recorder is built from (PW_RECORDER): the
 *      WAV the browser writes, the measurements of a take, the verdict the
 *      review step gives, which container is asked for, and the words a
 *      refused microphone turns into.
 *
 *   2. The microphone's LIFECYCLE, driven through a real panel instance
 *      whose browser is fake and counts everything: getUserMedia calls,
 *      live tracks, recorder state. The promise under test is the one the
 *      Booth makes on screen -- the microphone turns on only when Record
 *      is pressed, and every way away from the form turns it off -- plus
 *      what a Create actually sends and what a preview actually asks for.
 *
 *   node ha/tests/test_panel_recorder.mjs      (or scripts/test_panel.sh)
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL = join(HERE, "..", "custom_components", "parlorwave_radio",
                   "panel", "parlorwave-radio-panel.js");

// --- the smallest host the panel needs ---------------------------------------
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
const { PW_RECORDER: R } = await import(PANEL);
assert.ok(PanelClass, "the panel did not register its custom element");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const flush = () => new Promise((r) => setTimeout(r, 0));

// ======================================================================
// 1. THE PURE PARTS
// ======================================================================
test("the WAV is canonical 16-bit mono PCM at the given rate", () => {
  const wav = R.encodeWav16(Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2]), 24000);
  const dv = new DataView(wav.buffer);
  const str = (o, n) => String.fromCharCode(...wav.slice(o, o + n));
  assert.equal(wav.length, 44 + 7 * 2);
  assert.equal(str(0, 4), "RIFF");
  assert.equal(dv.getUint32(4, true), 36 + 14);
  assert.equal(str(8, 4), "WAVE");
  assert.equal(str(12, 4), "fmt ");
  assert.equal(dv.getUint32(16, true), 16);
  assert.equal(dv.getUint16(20, true), 1, "PCM");
  assert.equal(dv.getUint16(22, true), 1, "mono");
  assert.equal(dv.getUint32(24, true), 24000);
  assert.equal(dv.getUint32(28, true), 48000, "byte rate");
  assert.equal(dv.getUint16(32, true), 2, "block align");
  assert.equal(dv.getUint16(34, true), 16, "bits");
  assert.equal(str(36, 4), "data");
  assert.equal(dv.getUint32(40, true), 14);
  const s = (i) => dv.getInt16(44 + i * 2, true);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(s),
                   [0, 16384, -16384, 32767, -32768, 32767, -32768]);
  assert.equal(R.RECORD_SAMPLE_RATE, 24000);
});

test("several channels become one by averaging", () => {
  assert.deepEqual(Array.from(R.downmixToMono([Float32Array.from([1, 0.5]),
                                              Float32Array.from([0, 0.5])])),
                   [0.5, 0.5]);
  assert.deepEqual(Array.from(R.downmixToMono([Float32Array.from([0.25])])), [0.25]);
  assert.equal(R.downmixToMono([]).length, 0);
});

const sine = (secs, level, rate = 24000) =>
  Float32Array.from({ length: Math.round(secs * rate) },
                    (_, i) => level * Math.sin(2 * Math.PI * 180 * i / rate));

test("a take is measured, not scored", () => {
  const m = R.measureTake(sine(2, 0.5), 24000);
  assert.ok(Math.abs(m.seconds - 2) < 1e-9);
  assert.ok(Math.abs(m.peakDb - 20 * Math.log10(0.5)) < 0.01, m.peakDb);
  assert.equal(m.silentFraction, 0);
  const quiet = R.measureTake(new Float32Array(24000), 24000);
  assert.equal(quiet.peakDb, -Infinity);
  assert.equal(quiet.silentFraction, 1);
});

test("the review step blocks what no engine can use and warns about the rest", () => {
  const verdict = (secs, level) => R.takeProblem(R.measureTake(sine(secs, level), 24000), 8, 45);
  assert.equal(R.takeProblem(R.measureTake(new Float32Array(0), 24000), 8, 45).code, "empty");
  assert.equal(R.takeProblem(R.measureTake(new Float32Array(24000 * 10), 24000), 8, 45).code, "empty");
  const short = verdict(5, 0.4);
  assert.equal(short.code, "too_short"); assert.equal(short.block, true);
  assert.match(short.message, /5 seconds long\. Record at least 8 seconds/);
  assert.equal(verdict(46, 0.4).code, "too_long");
  assert.equal(verdict(12, 0.4), null, "a good take is simply fine");
  const q = verdict(12, 0.02);
  assert.equal(q.code, "too_quiet"); assert.equal(q.block, false);
  const hot = verdict(12, 1.0);
  assert.equal(hot.code, "clipping"); assert.equal(hot.block, false);
  // a browser's gain touching full scale for an instant is not distortion
  // (a handful of samples at 0 dBFS in a take of several seconds)
  const touch = Float32Array.from(sine(12, 0.6));
  [1000, 90000, 200000].forEach((i) => { touch[i] = 1.0; });
  assert.equal(R.takeProblem(R.measureTake(touch, 24000), 8, 45), null);
  assert.equal(R.TAKE_CLIP_SAMPLES, 2000, "the backend's CLIP_SAMPLE_COUNT");
  const gappy = Float32Array.from(sine(12, 0.4).map((v, i) => (i % 24000 < 19000 ? 0 : v)));
  assert.equal(R.takeProblem(R.measureTake(gappy, 24000), 8, 45).code, "mostly_silence");
  assert.equal(R.TAKE_SILENCE_DB, -40, "the backend's silence floor");
});

test("the recorder asks for the first container the browser can make", () => {
  assert.equal(R.recorderMimeType((t) => true), "audio/webm;codecs=opus");
  assert.equal(R.recorderMimeType((t) => t === "audio/mp4"), "audio/mp4");
  assert.equal(R.recorderMimeType(() => false), "");
  assert.equal(R.recorderMimeType(undefined), "");
  assert.equal(R.recorderMimeType(() => { throw new Error("old"); }), "");
});

test("a refused microphone is said in words a person can act on", () => {
  assert.match(R.micRefusal({ name: "NotAllowedError" }), /blocked/);
  assert.match(R.micRefusal({ name: "SecurityError" }), /blocked/);
  assert.match(R.micRefusal({ name: "NotFoundError" }), /No microphone was found/);
  assert.match(R.micRefusal({ name: "NotReadableError" }), /Another app/);
  assert.match(R.micRefusal(new Error("weird")), /could not be started/);
  for (const msg of [R.micRefusal({ name: "NotAllowedError" }), R.MIC_NEEDS_SECURE,
                     R.MIC_UNSUPPORTED]) {
    assert.doesNotMatch(msg, /Error|DOMException|undefined/);
    assert.match(msg, /recording file/, "there is always the file path");
  }
  // a browser that has no capture path at all says so, as MediaRecorder's absence does
  assert.equal(R.micRefusal({ name: "NotSupportedError" }), R.MIC_UNSUPPORTED);
  assert.equal(R.clockOf(7.9), "0:07");
  assert.equal(R.clockOf(65), "1:05");
});

// ======================================================================
// 2. THE MICROPHONE, THROUGH A REAL PANEL
// ======================================================================
const CONSENT = { text: "I have permission to create and use this voice in Parlorwave.",
                  version: "voice-permission-v1" };

function browser({ deny = null, secure = true, slow = false } = {}) {
  const b = { asked: 0, live: 0, recorders: [], fetches: [], pending: null };
  class Track { constructor() { this.on = true; b.live += 1; }
                stop() { if (this.on) { this.on = false; b.live -= 1; } } }
  class Stream { constructor() { this.tracks = [new Track()]; }
                 getTracks() { return this.tracks; } }
  globalThis.window = {
    isSecureContext: secure,
    AudioContext: class {
      constructor(opts) { this.rate = (opts && opts.sampleRate) || 48000; }
      async decodeAudioData() {
        const data = sine(12, 0.4, this.rate);
        return { numberOfChannels: 1, sampleRate: this.rate, getChannelData: () => data };
      }
      close() {}
    },
    addEventListener() {}, removeEventListener() {},
  };
  const gum = async () => {
    b.asked += 1;
    if (deny) { const e = new Error("denied"); e.name = deny; throw e; }
    if (slow) return new Promise((resolve) => { b.pending = () => resolve(new Stream()); });
    return new Stream();
  };
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices: { getUserMedia: gum } }, configurable: true, writable: true });
  globalThis.MediaRecorder = class {
    static isTypeSupported(t) { return t === "audio/webm;codecs=opus"; }
    constructor(stream, opts) { this.stream = stream; this.mimeType = opts && opts.mimeType;
                                this.state = "inactive"; b.recorders.push(this); }
    start() { this.state = "recording"; }
    stop() {
      if (this.state === "inactive") return;
      this.state = "inactive";
      setTimeout(() => {
        if (this.ondataavailable) this.ondataavailable({ data: new Blob([new Uint8Array(4096)]) });
        if (this.onstop) this.onstop();
      }, 0);
    }
  };
  globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  globalThis.Audio = class { constructor(url) { this.url = url; }
                             addEventListener() {} play() { return Promise.resolve(); } pause() {} };
  globalThis.fetch = async (url, init) => {
    b.fetches.push({ url, init });
    // the service answers with the use the form asked for
    const scope = new URLSearchParams(String(url).split("?")[1] || "").get("scope") || "announcement";
    return { ok: true, json: async () => ({ ok: true, voice_id: "custom_1", name: "Evening Reader",
                                            scope, warnings: [] }) };
  };
  return b;
}

function booth(b) {
  const el = new PanelClass();
  el.renders = 0;
  // The real _render's first act, and nothing else: this suite is about
  // the microphone, not the markup.
  el._render = function () { this.renders += 1; this._micGuard(); };
  el.ws = [];
  el._hass = {
    states: {},
    auth: { data: { access_token: "browser-session-token" } },
    callWS: (msg) => { el.ws.push(msg);
      return Promise.resolve(msg.type === "parlorwave_radio/voice_preview"
        ? { content_type: "audio/wav", audio_b64: btoa("RIFF....") } : {}); },
    callService: () => Promise.resolve(),
  };
  el._view = "booth";
  el._voicesOpen = true;
  el._voiceLib = { cloning: { configured: true, available: true, consent: CONSENT,
                              min_seconds: 8, max_seconds: 45 },
                   customs: [{ voice_id: "custom_2", name: "Studio Ray", has_sample: true,
                               scope: "both" }],
                   preview: { max_chars: 200 } };
  el._fetchVoiceLib = async () => {};
  return el;
}

async function recording(opts) {
  const b = browser(opts);
  const el = booth(b);
  el._openCreate();
  await el._recordStart();
  return { b, el };
}

test("opening the form, or a replacement, asks for no microphone", async () => {
  const b = browser();
  const el = booth(b);
  el._openCreate();
  el._openReplace("custom_2");
  el._render();
  assert.equal(b.asked, 0);
  assert.equal(el._mic, null);
  assert.equal(el._create.rec.state, "idle");
});

test("Record asks once, and the form says it is recording", async () => {
  const { b, el } = await recording();
  assert.equal(b.asked, 1);
  assert.equal(b.live, 1);
  assert.equal(el._create.rec.state, "recording");
  assert.equal(b.recorders[0].state, "recording");
  assert.equal(b.recorders[0].mimeType, "audio/webm;codecs=opus");
  await el._recordStart();                       // a second press is not a second mic
  assert.equal(b.asked, 1);
  el._releaseMic();
});

test("Stop turns the microphone off and keeps the take, as a 24 kHz WAV", async () => {
  const { b, el } = await recording();
  el._recordStop();
  assert.equal(b.live, 0, "a track is still live");
  assert.equal(el._mic, null);
  await flush(); await flush();
  const take = el._create.take;
  assert.ok(take, "the take was lost");
  assert.equal(take.source, "recording");
  assert.equal(take.block, false);
  assert.ok(Math.abs(take.seconds - 12) < 0.01);
  const bytes = new Uint8Array(await take.blob.arrayBuffer());
  const dv = new DataView(bytes.buffer);
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), "RIFF");
  assert.equal(dv.getUint32(24, true), R.RECORD_SAMPLE_RATE);
  assert.equal(take.blob.type, "audio/wav");
  assert.equal(el._create.rec.state, "ready");
});

for (const [how, away] of [
  ["leaving the Booth", (el) => { el._view = "onair"; el._render(); }],
  ["closing the voice library", (el) => { el._voicesOpen = false; el._render(); }],
  ["Cancel", (el) => el._closeCreate()],
  ["Record again", (el) => { el._discardTake(); el._releaseMic(); }],
  ["the panel going away", (el) => el.disconnectedCallback()],
]) {
  test(`${how} turns the microphone off and keeps nothing`, async () => {
    const { b, el } = await recording();
    const c = el._create;
    away(el);
    assert.equal(b.live, 0, "a track is still live");
    assert.equal(el._mic, null);
    await flush(); await flush();
    assert.equal(c.take, null, "a take was kept from an abandoned recording");
  });
}

test("a hidden page stops recording (and keeps what was said)", async () => {
  const { b, el } = await recording();
  el._mouthHidden = () => true; el._mouthStop = () => {};
  globalThis.document.hidden = true;
  el._onVisibilityChange();
  assert.equal(b.live, 0);
  await flush(); await flush();
  assert.ok(el._create.take);
});

test("the recording cap stops it by itself", async () => {
  const b = browser();
  const el = booth(b);
  el._voiceLib.cloning.max_seconds = 0.01;
  el._openCreate();
  await el._recordStart();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(b.live, 0);
  assert.equal(el._mic, null);
});

test("a form closed while the browser was asking never records", async () => {
  const b = browser({ slow: true });
  const el = booth(b);
  el._openCreate();
  const asking = el._recordStart();
  await flush();
  el._closeCreate();
  b.pending();
  await asking;
  assert.equal(b.live, 0, "the late stream was left running");
  assert.equal(b.recorders.length, 0);
});

test("a refused microphone is said, and nothing records", async () => {
  const { b, el } = await recording({ deny: "NotAllowedError" });
  assert.equal(b.live, 0);
  assert.equal(el._mic, null);
  assert.equal(el._create.rec.state, "error");
  assert.match(el._create.rec.error, /blocked/);
});

test("without a secure connection the browser is not even asked", async () => {
  const { b, el } = await recording({ secure: false });
  assert.equal(b.asked, 0);
  assert.equal(el._create.rec.error, R.MIC_NEEDS_SECURE);
});

test("Create stays locked until take, acknowledgement, name and use", async () => {
  const { el } = await recording();
  el._recordStop(); await flush(); await flush();
  const c = el._create;
  assert.equal(el._canSubmit(c), false);
  c.authorized = true; c.name = "Evening Reader"; c.scope = "announcement";
  assert.equal(el._canSubmit(c), false, "the recording was not chosen to be used");
  el._useTake();
  assert.equal(c.take.used, true);
  c.name = ""; c.scope = null;
  assert.equal(el._canSubmit(c), false, "no name");
  c.name = "Evening Reader";
  assert.equal(el._canSubmit(c), false, "no use chosen");
  c.scope = "announcement";
  assert.equal(el._canSubmit(c), true);
  c.authorized = false;
  assert.equal(el._canSubmit(c), false, "the acknowledgement was not required");
  c.authorized = true;
  el._voiceLib.cloning.consent = undefined;
  assert.equal(el._canSubmit(c), false, "no sentence to acknowledge");
});

test("Create sends the take with the acknowledgement and nothing else", async () => {
  const { b, el } = await recording();
  el._recordStop(); await flush(); await flush();
  el._useTake();
  Object.assign(el._create, { authorized: true, name: " Evening Reader ", note: "calm, slower reader",
                              scope: "announcement", makeDefault: true });
  const blob = el._create.take.blob;
  await el._submitCreate();
  assert.equal(b.fetches.length, 1);
  const { url, init } = b.fetches[0];
  const [path, query] = url.split("?");
  assert.equal(path, "/api/parlorwave_radio/voice_sample");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(query)),
    { authorized: "true", consent_version: "voice-permission-v1", scope: "announcement",
      source: "recording", name: "Evening Reader", note: "calm, slower reader", announcement_default: "true" });
  assert.equal(init.method, "POST");
  assert.equal(init.body, blob, "something other than the take was sent");
  assert.deepEqual(init.headers, { authorization: "Bearer browser-session-token" });
  // hearing it is the last step: one preview, nothing else asked
  await flush();
  assert.deepEqual(el.ws.map((m) => m.type), ["parlorwave_radio/voice_preview"]);
  assert.equal(el.ws[0].voice_id, "custom_1");
});

test("a replacement names the voice, not a name, and asks again", async () => {
  const b = browser();
  const el = booth(b);
  el._openReplace("custom_2");
  assert.equal(el._create.scope, "both", "the current use is shown");
  assert.equal(el._create.authorized, false, "the acknowledgement is asked again");
  await el._recordStart(); el._recordStop(); await flush(); await flush();
  el._useTake();
  el._create.authorized = true;
  assert.equal(el._canSubmit(el._create), true);
  await el._submitCreate();
  const q = Object.fromEntries(new URLSearchParams(b.fetches[0].url.split("?")[1]));
  assert.deepEqual(q, { authorized: "true", consent_version: "voice-permission-v1",
                        scope: "both", source: "recording", replace: "custom_2" });
});

test("a preview asks for the owner's line and nothing else", async () => {
  const b = browser();
  const el = booth(b);
  el._previewText = "  Dinner is at 7 tonight.  ";
  await el._previewVoice("custom_1");
  assert.deepEqual(el.ws, [{ type: "parlorwave_radio/voice_preview",
                             voice_id: "custom_1", text: "Dinner is at 7 tonight." }]);
  el._previewText = "";
  await el._previewVoice("custom_1");
  assert.deepEqual(el.ws[1], { type: "parlorwave_radio/voice_preview", voice_id: "custom_1" });
  assert.equal(b.fetches.length, 0);
});

// ======================================================================
// 3. RECORD FIRST, UPLOAD SECOND
// ======================================================================
test("the guide under the clock follows the backend's bounds", () => {
  assert.equal(R.recordGuide(0, 8, 20), "Keep reading: at least 8 more seconds.");
  assert.equal(R.recordGuide(7.2, 8, 20), "Keep reading: at least 1 more second.");
  assert.match(R.recordGuide(9, 8, 20), /^Good\. Keep going to about 20 seconds\.$/);
  assert.match(R.recordGuide(21, 8, 20), /plenty.*Stop/);
  const words = R.RECORD_SCRIPT.split(/\s+/).length;
  assert.ok(words >= 50 && words <= 80, `the script is ${words} words: about 20 seconds aloud`);
  assert.ok(R.RECORD_GOOD_SECONDS >= 10 && R.RECORD_GOOD_SECONDS <= 30, "inside the 10-30 s advice");
});

test("a chosen file is what its first bytes say, as the backend decides", () => {
  const bytes = (s, at = 0) => { const a = new Uint8Array(16); [...s].forEach((c, i) => { a[at + i] = c.charCodeAt(0); }); return a; };
  const wav = bytes("RIFF"); "WAVE".split("").forEach((c, i) => { wav[8 + i] = c.charCodeAt(0); });
  assert.equal(R.sniffAudio(wav), "wav");
  assert.equal(R.sniffAudio(bytes("fLaC")), "flac");
  assert.equal(R.sniffAudio(bytes("ID3")), "mp3");
  assert.equal(R.sniffAudio(Uint8Array.from([0xff, 0xfb, 0x90, 0x64])), "mp3");
  assert.equal(R.sniffAudio(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3])), "webm");
  assert.equal(R.sniffAudio(bytes("OggS")), "ogg");
  assert.equal(R.sniffAudio(bytes("ftyp", 4)), "mp4");
  assert.equal(R.sniffAudio(bytes("<htm")), "");
  for (const k of ["webm", "ogg", "mp4"]) {
    const p = R.fileProblem(k, null);
    assert.equal(p.block, true); assert.match(p.message, /browser format.*WAV, MP3 or FLAC/);
  }
  assert.equal(R.fileProblem("", null).block, true);
  assert.equal(R.fileProblem("wav", null), null, "unmeasured is not a problem");
  const short = R.fileProblem("mp3", { seconds: 3, peakDb: -6, silentFraction: 0.1 }, 8, 45);
  assert.equal(short.block, true);
  assert.equal(short.message, "That file is 3 seconds long. A voice needs at least 8 seconds of speech.");
  const quiet = R.fileProblem("flac", { seconds: 12, peakDb: -6, silentFraction: 0.9 }, 8, 45);
  assert.equal(quiet.block, false);
  assert.match(quiet.message, /^Most of that file is silence/);
});

test("the recording comes first: nothing else is asked until it is chosen", async () => {
  const { el } = await recording();
  let html = el._renderCreateVoice();
  assert.ok(html.includes('id="rec-script"'), "the words to read are shown while recording");
  assert.ok(html.includes('id="rec-guide"'));
  el._recordStop(); await flush(); await flush();
  html = el._renderCreateVoice();
  assert.ok(html.includes('id="take-use"') && html.includes("Use this recording"));
  for (const later of ['id="create-consent"', 'id="create-name"', 'id="create-go"']) {
    assert.ok(!html.includes(later), `${later} before the recording was chosen`);
  }
  el._useTake();
  html = el._renderCreateVoice();
  for (const later of ['id="create-consent"', 'id="create-name"', 'id="create-go"']) {
    assert.ok(html.includes(later), `${later} missing once the recording was chosen`);
  }
  assert.ok(html.includes("✓ Your recording"), "the chosen take is shown as chosen");
  // and before anything: Record is the big button, upload the quiet way in
  const fresh = booth(browser());
  fresh._openCreate();
  html = fresh._renderCreateVoice();
  assert.ok(html.indexOf('id="rec-start"') < html.indexOf('id="create-file"'));
  assert.ok(html.includes('class="rec-big"'));
  assert.ok(html.includes("Good evening, and welcome back."));
});

test("a chosen file is checked here, and nothing is sent until Create", async () => {
  const b = browser();
  const el = booth(b);
  el._openCreate();
  const head = new Uint8Array(64); "RIFF".split("").forEach((c, i) => { head[i] = c.charCodeAt(0); });
  "WAVE".split("").forEach((c, i) => { head[8 + i] = c.charCodeAt(0); });
  el._chooseFile(new File([head], "reader-sample.wav", { type: "audio/wav" }));
  assert.equal(el._create.take.checking, true);
  el._useTake();
  assert.equal(el._create.take.used, false, "not while it is being checked");
  for (let i = 0; i < 5; i++) await flush();
  const t = el._create.take;
  assert.equal(t.checking, false);
  assert.equal(t.block, false);
  assert.ok(Math.abs(t.seconds - 12) < 0.5, "measured like a recording");
  el._useTake();
  assert.equal(t.used, true);
  assert.equal(b.fetches.length, 0);
  Object.assign(el._create, { authorized: true, name: "Evening Reader", scope: "dj" });
  await el._submitCreate();
  assert.equal(b.fetches[0].init.body, t.blob, "the file is sent as chosen");
  // a browser-format file is refused before anything is measured or sent
  el._openCreate();
  el._chooseFile(new File([Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])], "take.webm"));
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(el._create.take.block, true);
  el._useTake();
  assert.equal(el._create.take.used, false, "a refused file cannot be used");
});

test("the cloned voice must speak before it is offered as the DJ", async () => {
  const { el } = await recording();
  el._recordStop(); await flush(); await flush();
  el._useTake();
  Object.assign(el._create, { authorized: true, name: "Evening Reader", scope: "dj" });
  await el._submitCreate();
  for (let i = 0; i < 3; i++) await flush();
  const c = el._create;
  assert.equal(c.audition.state, "ready");
  assert.ok(c.audition.url, "the audition is kept for Hear it again");
  let html = el._renderCreateVoice();
  assert.ok(html.includes('data-vuse="Evening Reader"'), "a voice that spoke is offered");
  const asked = el.ws.length;
  el._playAudition(); el._stopAudition();
  assert.equal(el.ws.length, asked, "Hear it again does not ask the engine again");
  // the same voice, but the engine could not speak with it
  el._hass.callWS = (msg) => { el.ws.push(msg);
    return Promise.reject(new Error("The ParlorWave Voice Engine is not answering.")); };
  await el._audition(c, "custom_1");
  assert.equal(c.audition.state, "error");
  html = el._renderCreateVoice();
  assert.ok(!html.includes("data-vuse"), "a voice that could not speak is never offered as the DJ");
  assert.ok(html.includes("not answering") && html.includes("Try again"));
});

test("Use this voice keeps the form, and says why, when the DJ could not change", async () => {
  const { el } = await recording();
  el._recordStop(); await flush(); await flush();
  el._useTake();
  Object.assign(el._create, { authorized: true, name: "Evening Reader", scope: "dj" });
  await el._submitCreate();
  for (let i = 0; i < 3; i++) await flush();
  Object.defineProperty(el, "_voice", { configurable: true,
    get: () => ({ entity_id: "select.parlorwave_radio_voice", attributes: { options: ["Evening Reader"] } }) });
  el._clearNotice = () => {};
  el._setNotice = (ok, text) => { el._notice = { ok, text }; };
  el._hass.callService = () => Promise.reject(
    new Error("Evening Reader was not made the DJ: the ParlorWave Voice Engine is not answering. The DJ is unchanged."));
  await el._useVoice("Evening Reader");
  assert.ok(el._create, "the form stays where the refusal happened");
  assert.match(el._create.useError, /^Evening Reader was not made the DJ/);
  el._hass.callService = () => Promise.resolve();
  await el._useVoice("Evening Reader");
  assert.equal(el._create, null);
  assert.match(el._notice.text, /^Evening Reader is now your DJ/);
});

// ======================================================================
// 3. REAL-BROWSER FAILURES (Windows desktop, Edge and Chrome)
// ======================================================================
// A. A browser can "record" with the microphone allowed and play back
//    silence. B. A file that measures and plays fine can still meet
//    "That recording could not be used." if Home Assistant refuses the
//    upload with 401 (a 30-minute access token, gone stale) before our view
//    runs. C. Coming back to the page can find On Air, the form and the take
//    gone: Home Assistant rebuilds a custom panel after five hidden minutes.

const noise = (secs, level, rate = 24000) =>
  Float32Array.from({ length: Math.round(secs * rate) }, (_, i) => level * ((i * 7919) % 200 / 100 - 1));

test("A: a take with no speech in it is BLOCKED, not warned about", () => {
  // the wrong (or a muted) microphone: room hiss at about -55 dBFS for 12 s
  const hiss = R.measureTake(noise(12, 0.0018), 24000);
  assert.ok(hiss.voicedSeconds < R.TAKE_SPEECH_MIN_S);
  const p = R.takeProblem(hiss, 8, 45);
  assert.equal(p.code, "silent"); assert.equal(p.block, true);
  assert.match(p.message, /^No speech reached the microphone/);
  assert.match(p.message, /under Record/, "it points at the chooser");
  // one second of voice in twelve is still nothing to clone from
  const blip = Float32Array.from(sine(12, 0.4).map((v, i) => (i < 24000 ? v : 0)));
  assert.equal(R.takeProblem(R.measureTake(blip, 24000), 8, 45).code, "silent");
  // a quiet but real voice keeps its warning, as before
  assert.equal(R.takeProblem(R.measureTake(sine(12, 0.02), 24000), 8, 45).code, "too_quiet");
  assert.ok(R.measureTake(sine(12, 0.4), 24000).voicedSeconds > 11.9);
  // a file says it about a file
  const f = R.fileProblem("mp3", hiss, 8, 45);
  assert.equal(f.code, "silent"); assert.equal(f.block, true);
  assert.match(f.message, /^That file is almost silent/);
});

test("A: the live meter's arithmetic", () => {
  assert.equal(R.frameLevelDb(new Float32Array(64)), -Infinity);
  assert.equal(Math.round(R.frameLevelDb(Float32Array.from([0, -0.5, 0.25]))), -6);
  assert.equal(R.meterPercent(-Infinity), 0);
  assert.equal(R.meterPercent(-70), 0);
  assert.equal(R.meterPercent(-30), 50);
  assert.equal(R.meterPercent(3), 100);
});

test("A: the review step says which microphone, and what it heard", () => {
  const line = R.takeDiagnosis({ label: "Default - Microphone (Webcam)", rate: 48000,
                                 mime: "audio/webm;codecs=opus", peakDb: -57.4, voicedSeconds: 0 });
  assert.equal(line, "Recorded from “Default - Microphone (Webcam)” · 48 kHz · webm;codecs=opus"
    + " · loudest -57 dB · speech heard 0.0 s");
  assert.match(R.takeDiagnosis({ peakDb: -Infinity }), /no sound at all/);
  assert.match(R.takeDiagnosis({ muted: true }), /muted/);
  assert.equal(R.takeDiagnosis({}), "");
  assert.match(R.liveSilenceWords({ label: "USB Mic" }), /^No sound is reaching “USB Mic”/);
  assert.match(R.liveSilenceWords({ label: "USB Mic", muted: true }), /reports “USB Mic” as muted/);
});

function liveBrowser({ label = "Default - Microphone (Webcam)", frame = 0, devices = null,
                       goneExact = false } = {}) {
  const b = browser();
  b.constraints = [];
  const gum = navigator.mediaDevices.getUserMedia;
  navigator.mediaDevices.getUserMedia = async (c) => {
    b.constraints.push(c);
    if (goneExact && c.audio.deviceId) { const e = new Error("gone"); e.name = "OverconstrainedError"; throw e; }
    const s = await gum(c);
    s.tracks[0].label = label;
    s.tracks[0].getSettings = () => ({ sampleRate: 48000 });
    return s;
  };
  navigator.mediaDevices.enumerateDevices = async () => devices || [
    { kind: "audioinput", deviceId: "default", label },
    { kind: "audioinput", deviceId: "usb-1", label: "Microphone (USB Desk Mic)" },
    { kind: "audiooutput", deviceId: "spk", label: "Speakers" },
  ];
  const Base = window.AudioContext;
  window.AudioContext = class extends Base {
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() {
      return { fftSize: 2048, getFloatTimeDomainData(a) { a.fill(frame); } };
    }
  };
  return b;
}

test("A: while recording, silence is said on the spot, with the device's name", async () => {
  const b = liveBrowser({ frame: 0 });
  const el = booth(b);
  el._openCreate();
  await el._recordStart();
  assert.equal(el._mic.input.label, "Default - Microphone (Webcam)");
  assert.ok(el._mic.meter, "a meter is open on the live stream");
  el._recordTick();
  assert.equal(el._mic.warn, "", "not before three seconds");
  el._mic.startedAt -= (R.LIVE_SILENCE_AFTER_S + 1) * 1000;
  el._recordTick();
  assert.match(el._mic.warn, /^No sound is reaching “Default - Microphone \(Webcam\)”/);
  const html = el._renderCreateVoice();
  assert.ok(html.includes("Microphone: Default - Microphone (Webcam)"));
  assert.ok(html.includes('id="rec-level"') && html.includes('id="rec-warn"'));
  el._recordStop(); await flush(); await flush();
  assert.match(el._create.take.diag, /^Recorded from “Default - Microphone \(Webcam\)” · 48 kHz/);
});

test("A: sound arriving keeps the warning away and moves the meter", async () => {
  const b = liveBrowser({ frame: 0.3 });
  const el = booth(b);
  el._openCreate();
  await el._recordStart();
  el._mic.startedAt -= 5000;
  el._recordTick();
  assert.equal(el._mic.warn, "");
  assert.ok(el._mic.levelPct > 80);
  el._releaseMic();
  assert.equal(b.live, 0);
});

test("A: the chooser lists named microphones, and Record opens the one chosen", async () => {
  const b = liveBrowser();
  const el = booth(b);
  el._openCreate();
  await flush(); await flush();
  assert.deepEqual(el._micDevices.map((d) => d.id), ["default", "usb-1"], "inputs only, named only");
  const html = el._renderCreateVoice();
  assert.ok(html.includes('id="rec-device"') && html.includes("Microphone (USB Desk Mic)"));
  R.BOOTH_SESSION.micDeviceId = "usb-1";
  await el._recordStart();
  assert.deepEqual(b.constraints.at(-1), { audio: { channelCount: 1, deviceId: { exact: "usb-1" } } });
  el._releaseMic();
  R.BOOTH_SESSION.micDeviceId = "";
});

test("A: a chosen microphone that has gone falls back to the browser's, once", async () => {
  const b = liveBrowser({ goneExact: true });
  const el = booth(b);
  el._openCreate();
  R.BOOTH_SESSION.micDeviceId = "unplugged";
  await el._recordStart();
  assert.equal(b.constraints.length, 2);
  assert.deepEqual(b.constraints[1], { audio: { channelCount: 1 } });
  assert.equal(R.BOOTH_SESSION.micDeviceId, "");
  assert.equal(el._create.rec.state, "recording");
  el._releaseMic();
});

test("A: no unnamed chooser before the browser has been allowed the microphone", async () => {
  const b = liveBrowser({ devices: [{ kind: "audioinput", deviceId: "x", label: "" },
                                    { kind: "audioinput", deviceId: "y", label: "" }] });
  const el = booth(b);
  el._openCreate();
  await flush(); await flush();
  assert.ok(!el._renderCreateVoice().includes('id="rec-device"'));
});

async function readyToSend(b, auth) {
  const el = booth(b);
  el._hass.auth = auth;
  el._openReplace("custom_2");
  await el._recordStart();
  el._recordStop(); await flush(); await flush();
  el._useTake();
  el._create.authorized = true;
  return el;
}

test("B: a stale access token is refreshed BEFORE the upload (hass.fetchWithAuth's rule)", async () => {
  const b = browser();
  let refreshed = 0;
  const auth = { data: { access_token: "stale" }, expired: true,
                 async refreshAccessToken() { refreshed += 1; this.data = { access_token: "fresh" }; this.expired = false; } };
  const el = await readyToSend(b, auth);
  await el._submitCreate();
  assert.equal(refreshed, 1);
  assert.equal(b.fetches.length, 1);
  assert.deepEqual(b.fetches[0].init.headers, { authorization: "Bearer fresh" });
  assert.ok(el._create.done, "the replace went through");
});

test("B: a 401 anyway is retried once with a forced refresh", async () => {
  const b = browser();
  const ok = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls += 1;
    if (calls === 1) { b.fetches.push({ url, init }); return { ok: false, status: 401, json: async () => { throw new Error("401: Unauthorized"); } }; }
    return ok(url, init);
  };
  let refreshed = 0;
  const auth = { data: { access_token: "skewed" }, expired: false,
                 async refreshAccessToken() { refreshed += 1; this.data = { access_token: "fresh" }; } };
  const el = await readyToSend(b, auth);
  await el._submitCreate();
  assert.equal(refreshed, 1);
  assert.equal(b.fetches.length, 2);
  assert.deepEqual(b.fetches[1].init.headers, { authorization: "Bearer fresh" });
  assert.equal(b.fetches[1].init.body, b.fetches[0].init.body, "the same take, re-sent");
  assert.ok(el._create.done);
});

test("B: a refusal Home Assistant made says what it was, never just 'could not be used'", async () => {
  const b = browser();
  globalThis.fetch = async (url, init) => {
    b.fetches.push({ url, init });
    return { ok: false, status: 401, json: async () => { throw new Error("not json"); } };
  };
  const el = await readyToSend(b, { data: { access_token: "x" } });  // nothing to refresh with
  await el._submitCreate();
  assert.equal(b.fetches.length, 1, "no retry without a way to refresh");
  assert.match(el._create.error, /^Home Assistant did not accept this page's sign-in/);
  assert.equal(R.uploadRefusal(422, { message: "Confirm that you have permission." }),
               "Confirm that you have permission.", "our view's own words still win");
  assert.match(R.uploadRefusal(413, {}), /larger than Home Assistant accepts/);
  assert.match(R.uploadRefusal(502, {}), /did not answer Home Assistant/);
  assert.equal(R.uploadRefusal(418, {}), "That recording could not be used: Home Assistant answered 418.");
});

test("C: Home Assistant rebuilding the panel resumes the Booth with the same draft and take", async () => {
  const b = browser();
  const el = booth(b);
  el._openReplace("custom_2");
  await el._recordStart();
  el._recordStop(); await flush(); await flush();
  const draft = el._create;
  assert.ok(draft.take, "a take was made");
  el.disconnectedCallback();            // five hidden minutes: HA removes the element
  const next = new PanelClass();        // ...and builds a new one when the tab is back
  assert.equal(next._view, "booth");
  assert.equal(next._voicesOpen, true);
  assert.equal(next._create, draft, "the same draft, take and all");
  assert.equal(new PanelClass()._view, "onair", "taken once, not forever");
});

test("C: a panel left from anywhere but the Booth comes back as it always did", () => {
  const b = browser();
  const el = booth(b);
  el._view = "station";
  el.disconnectedCallback();
  const next = new PanelClass();
  assert.equal(next._view, "onair");
  assert.equal(next._create, null);
});

// ----------------------------------------------------------------------
for (const [name, fn] of tests) {
  try { await fn(); passed += 1; }
  catch (e) { console.error(`FAIL ${name}\n  ${e && e.stack || e}`); process.exitCode = 1; }
}
console.log(`${passed}/${tests.length} recorder checks passed`);
