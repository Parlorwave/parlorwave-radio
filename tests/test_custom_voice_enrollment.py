"""Custom voice enrollment, on the Home Assistant side.

The recording travels browser -> this integration's authenticated view ->
the backend. The door is where a request that should never reach the
backend is stopped: one with no acknowledgement, one naming a field the
view does not know (a URL, a path, a slot), one whose replacement target
is not shaped like a voice. Those are EXECUTED against the view here.

The panel's rules about the microphone -- only Record opens it, and every
way away from the form closes it -- are EXECUTED under node
(test_panel_recorder.mjs). What is pinned here at the source is what a
browser run cannot vary: which call the microphone is reached through,
what the upload query can carry, and that the default-voice picker lists
only voices allowed for announcements.
"""

import asyncio
import re
import unittest
from pathlib import Path

from harness import BACKEND_SRC, CROSS_REPO, FakeTransport, coordinator_of, make_hass

import custom_components.parlorwave_radio as integration
from custom_components.parlorwave_radio.const import (DOMAIN, SERVICE_VOICE_UPLOAD,
                                                      VOICE_CONSENT_VERSION,
                                                      VOICE_SCOPES)
from custom_components.parlorwave_radio.http import VoiceSampleView
from custom_components.parlorwave_radio.select import VoiceSelect
from homeassistant.exceptions import HomeAssistantError

ROOT = Path(__file__).resolve().parent.parent / "custom_components" / "parlorwave_radio"
BACKEND = BACKEND_SRC
PANEL = (ROOT / "panel" / "parlorwave-radio-panel.js").read_text()
INIT = (ROOT / "__init__.py").read_text()


def method(name, until):
    """One method of the panel class, from its definition to the next."""
    start = PANEL.index(f"  {name}")
    return PANEL[start:PANEL.index(until, start + 1)]


class _Conn:
    def __init__(self):
        self.result, self.error = None, None

    def send_result(self, _id, result):
        self.result = result

    def send_error(self, _id, code, message):
        self.error = (code, message)


def ws(hass, name, msg=None):
    """One registered websocket command, run through its real handler."""
    wanted = f"parlorwave_radio/{name}"
    for handler in hass.data.get("_fake_ws_commands", []):
        if handler.ws_schema.get("type") == wanted:
            conn = _Conn()
            asyncio.run(handler(hass, conn, {"id": 1, "type": wanted,
                                             **(msg or {})}))
            if conn.error:
                raise AssertionError(f"{name} refused: {conn.error}")
            return conn.result
    raise AssertionError(f"{wanted} is not registered")


class _Binary:
    def __init__(self, status, payload):
        import json as _json
        self.status = status
        self.headers = {"Content-Type": "application/json"}
        self._body = _json.dumps(payload).encode()

    async def read(self):
        return self._body

    async def json(self):
        import json as _json
        return _json.loads(self._body)


class EnrollTransport(FakeTransport):
    """The harness backend plus the three enrollment routes, each
    recording exactly what reached it."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.forwarded = []           # (path with query, body)
        self.answer = (200, {"ok": True, "voice_id": "custom_1", "name": "Evening Reader",
                             "scope": "announcement", "warnings": []})

    async def request(self, method, url, json=None, headers=None, timeout=None,
                      data=None):
        full = "/" + url.split("//", 1)[-1].split("/", 1)[1]
        path = full.split("?", 1)[0]
        if path == "/voices/custom/create" or path.endswith("/replace") \
                or path.endswith("/sample"):
            self.calls.append({"method": method, "path": path, "json": json,
                               "headers": dict(headers or {})})
            self.forwarded.append((full, data))
            return _Binary(*self.answer)
        if path in ("/voices/announcement-default",) or path.endswith("/scope"):
            self.calls.append({"method": method, "path": path, "json": json,
                               "headers": dict(headers or {})})
            return _Binary(200, {"ok": True, **(json or {})})
        return await super().request(method, url, json=json, headers=headers,
                                     timeout=timeout)


def setup():
    transport = EnrollTransport()
    hass, entry = make_hass(transport)
    asyncio.run(integration.async_setup_entry(hass, entry))
    return hass, entry, transport


class _Req:
    def __init__(self, hass, query, body=b"RIFF-a-take"):
        self.app = {"hass": hass}
        self.query = query
        self.content_length = len(body)
        self._body = body

    async def read(self):
        return self._body


def post(hass, query, body=b"RIFF-a-take"):
    return asyncio.run(VoiceSampleView().post(_Req(hass, query, body)))


ACK = {"authorized": "true", "consent_version": VOICE_CONSENT_VERSION}


class TheDoorAsksForTheAcknowledgement(unittest.TestCase):
    def test_no_acknowledgement_nothing_forwarded(self):
        hass, _e, transport = setup()
        for query in ({"name": "Evening Reader", "scope": "dj"},
                      {"name": "Evening Reader", "scope": "dj", "authorized": "false",
                       "consent_version": VOICE_CONSENT_VERSION},
                      {"name": "Evening Reader", "scope": "dj", "authorized": "yes",
                       "consent_version": VOICE_CONSENT_VERSION},
                      {"name": "Evening Reader", "scope": "dj", "authorized": "1",
                       "consent_version": VOICE_CONSENT_VERSION},
                      {"name": "Evening Reader", "scope": "dj", "authorized": "true"},
                      {"name": "Evening Reader", "scope": "dj", "authorized": "true",
                       "consent_version": "voice-permission-v0"},
                      {"replace": "custom_1", "authorized": "false"}):
            with self.subTest(query=query):
                resp = post(hass, query)
                self.assertEqual(resp.status, 422)
                self.assertEqual(resp.body["code"], "voice_authorization_required")
                self.assertIn("permission", resp.body["message"])
        self.assertEqual(transport.forwarded, [])

    @unittest.skipIf(BACKEND is None, CROSS_REPO)
    def test_the_door_and_the_backend_mean_the_same_sentence(self):
        self.assertTrue(BACKEND.is_dir(), f"the source tree has no backend at {BACKEND}")
        src = (BACKEND / "voice_library.py").read_text()
        version = re.search(r'^CONSENT_VERSION = "([^"]+)"', src, re.M).group(1)
        self.assertEqual(VOICE_CONSENT_VERSION, version)
        scopes = re.search(r'^VOICE_SCOPES = \(([^)]+)\)',
                           (BACKEND / "settings.py").read_text(), re.M).group(1)
        self.assertEqual(VOICE_SCOPES, tuple(s.strip().strip('"')
                                             for s in scopes.split(",")))

    @unittest.skipIf(BACKEND is None, CROSS_REPO)
    def test_the_booth_and_the_backend_call_the_same_take_clipped(self):
        """A take that touches full scale on only a few samples is not
        distorted: the Booth and the backend must agree on that."""
        backend = re.search(r"^CLIP_SAMPLE_COUNT = (\d+)",
                            (BACKEND / "voice_sample_check.py").read_text(), re.M)
        panel = re.search(r"^const TAKE_CLIP_SAMPLES = (\d+);", PANEL, re.M)
        self.assertEqual(int(panel.group(1)), int(backend.group(1)))

    @unittest.skipIf(BACKEND is None, CROSS_REPO)
    def test_the_engines_default_is_never_called_your_voice(self):
        """On a fresh install the engine's default must not sit under
        My Voices as "Your enrolled voice." It is not one."""
        src = (BACKEND / "voice_library.py").read_text()
        # the backend's row for the engine default carries no provider
        self.assertIn('"provider": "chatterbox" if asset else "",', src)
        # one group for it, read by the tile, the dropdown and the library
        self.assertIn('engine: ["Voice engine", "The voice engine\'s own voice. It speaks until you '
                      'choose another."]', PANEL)
        self.assertIn('if (cur && !cur.provider) return "engine";', PANEL)
        self.assertIn("[VOICE_GROUPS.engine[0], options.filter((o) => engineNames.has(o))]", PANEL)
        self.assertIn('${group("engine", engineRows)}', PANEL)
        self.assertIn("(lib.current && lib.current.provider ? row(lib.current, {", PANEL)


class TheDoorTakesAClosedSetOfFields(unittest.TestCase):
    def test_a_url_a_path_or_a_slot_is_refused_not_ignored(self):
        hass, _e, transport = setup()
        for extra in ({"url": "https://example.com/voice.wav"},
                      {"source_url": "https://example.com/voice.wav"},
                      {"path": "/config/www/voice.wav"},
                      {"file": "../../etc/passwd"},
                      {"slot": "custom_1"},
                      {"asset": "jarvis_custom_1"}):
            with self.subTest(extra=extra):
                resp = post(hass, {**ACK, "name": "Evening Reader", "scope": "dj", **extra})
                self.assertEqual(resp.status, 400)
                self.assertEqual(resp.body["code"], "unsupported_field")
        self.assertEqual(transport.forwarded, [])

    def test_scope_and_source_come_from_fixed_lists(self):
        hass, _e, transport = setup()
        self.assertEqual(post(hass, {**ACK, "name": "Evening Reader"}).body["code"],
                         "scope_required")
        self.assertEqual(post(hass, {**ACK, "name": "Evening Reader", "scope": "owner"})
                         .body["code"], "scope_required")
        self.assertEqual(post(hass, {**ACK, "name": "Evening Reader", "scope": "dj",
                                     "source": "url"}).body["code"],
                         "unsupported_field")
        self.assertEqual(transport.forwarded, [])

    def test_a_replacement_target_must_look_like_a_voice(self):
        hass, _e, transport = setup()
        for bad in ("../custom_1", "custom_1/../../x", "a.b", "custom 1",
                    "CUSTOM_1", "x" * 33, "http://x"):
            with self.subTest(bad=bad):
                resp = post(hass, {**ACK, "replace": bad})
                self.assertEqual(resp.status, 400)
                self.assertEqual(resp.body["code"], "unknown_voice")
        self.assertEqual(transport.forwarded, [])


class WhatReachesTheBackend(unittest.TestCase):
    def test_a_create_carries_the_acknowledgement_scope_and_source(self):
        hass, _e, transport = setup()
        resp = post(hass, {**ACK, "name": " Evening Reader ", "note": "calm, slower reader",
                           "scope": "announcement", "source": "recording",
                           "announcement_default": "true"}, b"RIFF-take")
        self.assertEqual(resp.status, 200, resp.body)
        (full, body), = transport.forwarded
        self.assertEqual(body, b"RIFF-take")
        self.assertTrue(full.startswith("/voices/custom/create?"))
        for part in ("name=Evening+Reader", "note=calm%2C+slower+reader", "authorized=true",
                     f"consent_version={VOICE_CONSENT_VERSION}",
                     "scope=announcement", "source=recording",
                     "announcement_default=true"):
            self.assertIn(part, full)
        # the credential is attached here, never by the browser
        self.assertEqual(transport.calls[-1]["headers"].get("X-Api-Key"), "k")

    def test_a_replace_goes_to_that_voice_and_keeps_its_name(self):
        hass, _e, transport = setup()
        resp = post(hass, {**ACK, "replace": "custom_2", "source": "recording"})
        self.assertEqual(resp.status, 200, resp.body)
        (full, _body), = transport.forwarded
        self.assertTrue(full.startswith("/voices/custom/custom_2/replace?"), full)
        self.assertNotIn("name=", full)
        self.assertNotIn("scope=", full, "no scope was chosen, none is sent")
        post(hass, {**ACK, "replace": "custom_2", "scope": "both"})
        self.assertIn("scope=both", transport.forwarded[-1][0])

    def test_a_refusal_keeps_the_backends_code_and_words(self):
        hass, _e, transport = setup()
        transport.answer = (422, {"detail": {
            "code": "voice_name_taken",
            "message": 'Another voice is already called "Evening Reader".'}})
        resp = post(hass, {**ACK, "name": "Evening Reader", "scope": "dj"})
        self.assertEqual(resp.status, 422)
        self.assertEqual(resp.body, {"ok": False, "code": "voice_name_taken",
                                     "message": 'Another voice is already called "Evening Reader".'})


class VoiceSettingsOverTheWebsocket(unittest.TestCase):
    def test_scope_and_default_are_two_separate_writes(self):
        hass, entry, transport = setup()
        c = coordinator_of(hass, entry)
        invalidated = []
        c.invalidate_voice_library = lambda: invalidated.append(True)
        ws(hass, "voice_scope", {"voice_id": "custom_1", "scope": "both"})
        ws(hass, "voice_announcement_default", {"voice_id": "custom_1"})
        ws(hass, "voice_announcement_default", {})
        sent = [(x["path"], x["json"]) for x in transport.calls
                if x["method"] == "POST" and x["path"].startswith("/voices/")]
        self.assertEqual(sent, [("/voices/custom_1/scope", {"scope": "both"}),
                                ("/voices/announcement-default",
                                 {"voice_id": "custom_1"}),
                                ("/voices/announcement-default",
                                 {"voice_id": ""})])
        self.assertEqual(len(invalidated), 3)

    def test_the_commands_are_bounded_and_named_as_writes(self):
        block = INIT[INIT.index('_command("parlorwave_radio/voice_scope"'):]
        block = block[:block.index("# --- Newsroom")]
        self.assertIn('vol.Required("scope"): vol.In(VOICE_SCOPES)', block)
        self.assertIn("vol.Length(min=1, max=64)", block)
        self.assertIn("All but eight are read-only", INIT)  # + Switch DJ, Automatic DJ shifts
        preview = INIT[INIT.index('_command("parlorwave_radio/voice_preview"'):]
        preview = preview[:preview.index("})")]
        self.assertIn('vol.Optional("text"): vol.All(', preview)
        self.assertIn("vol.Length(max=VOICE_PREVIEW_MAX_CHARS)", preview)

    def test_a_preview_line_travels_and_nothing_else_happens(self):
        hass, _e, transport = setup()

        async def binary(method, path, json=None, data=None, timeout_s=None):
            transport.calls.append({"method": method, "path": path,
                                    "json": json, "headers": {}})
            return 200, b"RIFF" + b"\0" * 200, "audio/wav"
        coordinator = next(iter(hass.data[DOMAIN].values()))
        coordinator.client._call_binary = binary
        before = len(transport.calls)
        out = ws(hass, "voice_preview", {"voice_id": "custom_1",
                                         "text": "Dinner is at 7."})
        self.assertEqual(out["content_type"], "audio/wav")
        made = transport.calls[before:]
        self.assertEqual([(m["method"], m["path"]) for m in made],
                         [("POST", "/voices/preview")])
        self.assertEqual(made[0]["json"], {"voice_id": "custom_1",
                                           "text": "Dinner is at 7."})


class TheAutomationServiceAsksToo(unittest.TestCase):
    def test_upload_without_authorized_is_refused_before_anything_is_sent(self):
        hass, _e, transport = setup()
        import base64
        sample = base64.b64encode(b"RIFF-take").decode()
        for data in ({"slot": "custom_1", "sample_b64": sample},
                     {"slot": "custom_1", "sample_b64": sample, "authorized": False}):
            with self.assertRaises(HomeAssistantError):
                asyncio.run(hass.services.async_call(DOMAIN, SERVICE_VOICE_UPLOAD,
                                                     data))
        self.assertEqual(transport.forwarded, [])
        asyncio.run(hass.services.async_call(
            DOMAIN, SERVICE_VOICE_UPLOAD,
            {"slot": "custom_1", "sample_b64": sample, "authorized": True}))
        (full, body), = transport.forwarded
        self.assertTrue(full.startswith("/voices/custom/custom_1/sample?"))
        self.assertIn("authorized=true", full)
        self.assertIn(f"consent_version={VOICE_CONSENT_VERSION}", full)
        self.assertEqual(body, b"RIFF-take")

    def test_the_field_is_documented(self):
        yaml = (ROOT / "services.yaml").read_text()
        block = yaml[yaml.index("voice_upload:"):]
        self.assertIn("authorized:", block)
        self.assertIn("I have permission to create and use this voice in "
                      "Parlorwave.", " ".join(block.split()))


class AnAnnouncementOnlyVoiceIsNotADJVoice(unittest.TestCase):
    def test_the_dj_picker_does_not_offer_it(self):
        lib = {"kokoro": [{"voice_id": "lewis", "name": "Lewis",
                           "scope": "announcement", "available": True},
                          {"voice_id": "bella", "name": "Bella", "scope": "dj",
                           "available": True}],
               "customs": [{"voice_id": "custom_1", "name": "Evening Reader",
                            "has_sample": True, "scope": "announcement"},
                           {"voice_id": "custom_2", "name": "Bar",
                            "has_sample": True, "scope": "both"},
                           {"voice_id": "custom_3", "name": "Studio Ray",
                            "has_sample": True}],
               "home_assistant": [{"voice_id": "ha_tts_piper", "name": "Piper",
                                   "scope": "announcement", "available": True}],
               "selected": {"voice_id": "bella"}}
        names = [i["name"] for i in VoiceSelect._shelved(lib)]
        self.assertEqual(names, ["Bella", "Bar", "Studio Ray"])


class ThePanelsRecorder(unittest.TestCase):
    """Source facts the executed node suite cannot vary."""

    def test_the_microphone_is_reached_from_one_place(self):
        self.assertEqual(PANEL.count("getUserMedia("), 1)
        start = method("async _recordStart()", "\n  /* ")
        self.assertIn("md.getUserMedia(", start)
        # and Record is the only way in
        self.assertEqual(len(re.findall(r"this\._recordStart\(\)", PANEL)), 1)
        self.assertIn('on("rec-start", () => this._recordStart());', PANEL)
        for opener in ("_openCreate() {", "_openReplace(voiceId) {"):
            body = method(opener, "\n  }\n")
            self.assertNotIn("_recordStart", body)
            self.assertNotIn("getUserMedia", body)

    def test_every_way_away_closes_it(self):
        self.assertIn("this._releaseMic();",
                      method("disconnectedCallback() {", "\n  }\n"))
        self.assertIn("this._micGuard();", method("_render() {", "\n    this._deferredRender = false;"))
        self.assertIn("this._recordStop()",
                      method("_onVisibilityChange() {", "\n  }\n"))
        guard = method("_micGuard() {", "\n  }\n")
        for cond in ('this._view !== "booth"', "!this._voicesOpen", "!this._create"):
            self.assertIn(cond, guard)
        release = method("_releaseMic(keep) {", "\n  }\n")
        self.assertIn("m.stopTracks()", release)
        self.assertIn("clearTimeout(m.cap)", release)

    def test_the_screen_says_the_microphone_is_on_in_words(self):
        take = method("_renderTake(c, cloning) {", "\n  _personaName")
        self.assertIn("<b>Microphone on</b>", take)
        self.assertIn('role="status" aria-live="polite"', take)
        self.assertIn('id="rec-stop"', take)
        self.assertIn('id="rec-clock"', take)

    def test_create_needs_the_acknowledgement_and_sends_nothing_else(self):
        can = method("_canSubmit(c) {", "\n  }\n")
        self.assertIn("!c.authorized", can)
        self.assertIn("!this._consent()", can)
        self.assertIn("c.take.block", can)
        submit = method("async _submitCreate() {", '\n  /* "Use this voice"')
        for key in ('authorized: "true"', "consent_version: consent.version",
                    "scope: c.scope", "source: c.take.source",
                    "params.replace = c.target"):
            self.assertIn(key, submit)
        for banned in ("slot", "url:", "path:", "file:"):
            self.assertNotIn(banned, submit)
        form = PANEL[PANEL.index("  _renderCreateVoice() {"):PANEL.index("\n  _personaName")]
        self.assertIn("this._esc(consent.text)", form, "the sentence is the backend's")
        self.assertIn('id="create-consent"', form)
        self.assertNotIn('type="url"', PANEL)

    def test_the_default_picker_lists_only_voices_allowed_for_announcements(self):
        body = method("_renderAnnouncementVoice(lib) {", "\n  /* --- custom voices")
        self.assertIn('.filter((v) => v.scope === "announcement" || v.scope === "both")',
                      body)
        self.assertIn("(not allowed for announcements)", body)
        self.assertIn("Choosing one here allows nothing", body)
        wire = PANEL[PANEL.index('getElementById("announce-voice")'):]
        wire = wire[:wire.index("// The preview line")]
        self.assertIn('"parlorwave_radio/voice_announcement_default"', PANEL)
        self.assertIn("opt.dataset.voice", wire)

    def test_each_custom_voice_shows_its_permission_scope_and_default(self):
        lib = PANEL[PANEL.index("  _renderVoiceLibrary() {"):PANEL.index("  _renderCustomVoices(")]
        self.assertIn("Permission not recorded", lib)
        self.assertIn("Permission recorded", lib)
        self.assertIn('data-vscope="${this._esc(v.voice_id)}"', lib)
        self.assertIn('data-vreplace="${c.voice_id}"', lib)
        self.assertIn("v.announcement_default ?", lib)
        # no fingerprint, asset or path on screen
        for banned in ("identity", "jarvis_", "sha256"):
            self.assertNotIn(banned, lib)


if __name__ == "__main__":
    unittest.main()
