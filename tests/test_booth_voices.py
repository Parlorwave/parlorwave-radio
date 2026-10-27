"""Booth, the voice library, and Create a Voice.

Two halves, like the rest of the panel's coverage: the upload view is
EXECUTED against the Home Assistant harness (it is ordinary integration
code and its failure behaviour is the whole point of it), and the product
rules the panel encodes are pinned at the source, because a browser is not
available here and a rule like "an unconfigured engine shows no upload
button" is a rule about what the code can possibly render.
"""

import asyncio
import re
import unittest
from pathlib import Path

from harness import FakeTransport, coordinator_of, make_hass

import custom_components.parlorwave_radio as integration
from custom_components.parlorwave_radio.const import (MAX_SAMPLE_BYTES,
                                                      VOICE_CONSENT_VERSION,
                                                      VOICE_SAMPLE_URL)
from custom_components.parlorwave_radio.http import VoiceSampleView

ROOT = Path(__file__).resolve().parent.parent / "custom_components" / "parlorwave_radio"
PANEL = (ROOT / "panel" / "parlorwave-radio-panel.js").read_text()
BOOTH = PANEL[PANEL.index("  _renderBooth() {"):PANEL.index("\n  _personaName")]
STYLE = PANEL[PANEL.index("<style>"):PANEL.index("</style>")]


# --- the upload transport, executed -------------------------------------------

class FakeRequest:
    """Only what the view touches: the app mapping, the query, the body."""

    def __init__(self, hass, query, body=b""):
        self.app = {"hass": hass}
        self.query = query
        self.content_length = len(body)
        self._body = body

    async def read(self):
        return self._body


class VoiceTransport(FakeTransport):
    """The harness backend, plus the voice-create route and a settable
    answer for it."""

    def __init__(self, create=None, **kw):
        super().__init__(**kw)
        self.create = create or (200, {"ok": True, "voice_id": "custom_2",
                                       "name": "Radio Ray", "warnings": [],
                                       "slots_free": 1})
        self.bodies = []

    async def request(self, method, url, json=None, headers=None, timeout=None,
                      data=None):
        path = "/" + url.split("//", 1)[-1].split("/", 1)[1]
        if path.startswith("/voices/custom/create"):
            self.calls.append({"method": method, "path": path, "json": json,
                               "headers": dict(headers or {})})
            self.bodies.append(data)
            status, payload = self.create
            return _BinaryResponse(status, payload)
        if path.startswith("/voices/library"):
            return await super().request(method, url, json=json,
                                         headers=headers, timeout=timeout)
        return await super().request(method, url, json=json, headers=headers,
                                     timeout=timeout)


class _BinaryResponse:
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


def setup(transport):
    hass, entry = make_hass(transport)
    asyncio.run(_setup(hass, entry))
    return hass, entry


async def _setup(hass, entry):
    await integration.async_setup_entry(hass, entry)


#: The owner's acknowledgement and a chosen scope, as the panel sends them
#: with every recording (custom voice enrollment). The tests that are
#: ABOUT the acknowledgement post without it (ack=False).
ACK = {"authorized": "true", "consent_version": VOICE_CONSENT_VERSION,
       "scope": "dj"}


def post(hass, query, body=b"audio-bytes", ack=True):
    view = VoiceSampleView()
    query = {**ACK, **query} if ack else dict(query)
    return asyncio.run(view.post(FakeRequest(hass, query, body)))


class UploadViewTests(unittest.TestCase):
    def test_the_view_is_registered_once_and_requires_auth(self):
        transport = VoiceTransport()
        hass, entry = setup(transport)
        views = hass.http.views
        self.assertIn(VOICE_SAMPLE_URL, [v.url for v in views])
        # EVERY view this integration registers is authenticated. Asserted
        # over the whole set rather than one index, so a view added later
        # cannot quietly arrive anonymous.
        for view in views:
            self.assertTrue(view.requires_auth,
                            f"{view.url} is an unauthenticated endpoint")
        before = len(views)
        # a second setup in the same process must not register them again --
        # a Home Assistant view, like a static path, cannot be removed
        _hass2, entry2 = make_hass(transport)
        entry2.entry_id = "entry2"
        hass.data.setdefault("parlorwave_radio", {})["entry2"] = coordinator_of(
            hass, entry)
        integration._register_views(hass)
        self.assertEqual(len(hass.http.views), before)

    def test_a_recording_is_forwarded_as_bytes_with_the_name_and_note(self):
        transport = VoiceTransport()
        hass, _entry = setup(transport)
        resp = post(hass, {"name": " Radio Ray ", "note": " calm, slower reader "},
                    b"RIFF-a-real-recording")
        self.assertEqual(resp.status, 200)
        self.assertTrue(resp.body["ok"])
        self.assertEqual(transport.bodies, [b"RIFF-a-real-recording"],
                         "the body must travel as bytes, never base64")
        call = next(c for c in transport.calls
                    if c["path"].startswith("/voices/custom/create"))
        self.assertIn("name=Radio+Ray", call["path"])
        self.assertIn("note=calm%2C+slower+reader", call["path"])

    def test_the_backend_credential_never_leaves_home_assistant(self):
        """The browser posts to Home Assistant; Home Assistant attaches the
        service key. The key exists on exactly one side of that line."""
        transport = VoiceTransport()
        hass, _entry = setup(transport)
        post(hass, {"name": "Ray"}, b"bytes")
        call = next(c for c in transport.calls
                    if c["path"].startswith("/voices/custom/create"))
        self.assertEqual(call["headers"].get("X-Api-Key"), "k")
        self.assertNotIn("api_key", PANEL)
        self.assertNotIn("X-Api-Key", PANEL)

    def test_an_unnamed_voice_is_refused_before_anything_is_sent(self):
        transport = VoiceTransport()
        hass, _entry = setup(transport)
        resp = post(hass, {"name": "   "}, b"bytes")
        self.assertEqual(resp.status, 400)
        self.assertEqual(resp.body["code"], "name_required")
        self.assertEqual(transport.bodies, [])

    def test_an_oversized_recording_is_refused_at_the_door(self):
        transport = VoiceTransport()
        hass, _entry = setup(transport)
        resp = post(hass, {"name": "Ray"}, b"x" * (MAX_SAMPLE_BYTES + 1))
        self.assertEqual(resp.status, 413)
        self.assertEqual(resp.body["code"], "sample_too_large")
        self.assertEqual(transport.bodies, [])

    def test_an_unavailable_engine_reaches_the_panel_intact(self):
        """The regression this exists for: the backend's structured,
        user-safe 503 must arrive at the browser as a sentence with its
        code, not as a RuntimeError, a bare 502, or a path and a status."""
        message = ("Custom voices need the optional ParlorWave Voice Engine, "
                   "which this installation has not got. Home Assistant and "
                   "built-in DJ voices are unaffected.")
        transport = VoiceTransport(create=(503, {
            "detail": {"code": "voice_engine_unavailable", "message": message}}))
        hass, _entry = setup(transport)
        resp = post(hass, {"name": "Ray"}, b"bytes")
        self.assertEqual(resp.status, 503)
        self.assertEqual(resp.body["code"], "voice_engine_unavailable")
        self.assertEqual(resp.body["message"], message)
        self.assertFalse(resp.body["ok"])
        for leak in ("DJ_TTS_URL", "RuntimeError", "Traceback", "502",
                     "/voices/custom", "http://"):
            self.assertNotIn(leak, str(resp.body), leak)

    def test_a_rejected_recording_keeps_the_backends_own_guidance(self):
        message = ("That recording is 3 seconds long. A voice needs about "
                   "10-30 seconds of speech (8 seconds is the minimum).")
        transport = VoiceTransport(create=(422, {
            "detail": {"code": "voice_refused", "message": message}}))
        hass, _entry = setup(transport)
        resp = post(hass, {"name": "Ray"}, b"bytes")
        self.assertEqual(resp.status, 422)
        self.assertEqual(resp.body["message"], message)

    def test_a_full_shelf_arrives_as_a_conflict_with_no_slot_in_it(self):
        message = ("This release holds 3 custom voices. Delete one to make "
                   "room for another.")
        transport = VoiceTransport(create=(409, {
            "detail": {"code": "voice_slots_full", "message": message}}))
        hass, _entry = setup(transport)
        resp = post(hass, {"name": "Fourth"}, b"bytes")
        self.assertEqual(resp.status, 409)
        self.assertEqual(resp.body["code"], "voice_slots_full")
        for banned in ("custom_1", "custom_2", "custom_3", "slot"):
            self.assertNotIn(banned, resp.body["message"], banned)

    def test_an_unreachable_service_says_so_without_naming_it(self):
        class Dead(VoiceTransport):
            async def request(self, method, url, **kw):
                if "/voices/custom/create" in url:
                    raise OSError("Connection refused to 198.51.100.4:5005")
                return await super().request(method, url, **kw)
        hass, _entry = setup(Dead())
        resp = post(hass, {"name": "Ray"}, b"bytes")
        self.assertEqual(resp.status, 502)
        self.assertEqual(resp.body["code"], "service_unreachable")
        for leak in ("198.51.100.4", "5005", "OSError", "Connection refused"):
            self.assertNotIn(leak, str(resp.body), leak)

    def test_a_service_refusal_keeps_the_backends_own_sentence(self):
        """Every voice mutation, not only the upload: a message the backend
        wrote for a person must not arrive wearing "delete failed:"."""
        src = (ROOT / "__init__.py").read_text()
        helper = src[src.index("def _voice_error("):]
        helper = helper[:helper.index("\n    async def")]
        self.assertIn("isinstance(exc, VoiceEngineError)", helper)
        self.assertIn("HomeAssistantError(str(exc))", helper)
        voices = src[src.index("    async def voice_rename"):
                     src.index("def _register_views(")]
        for what in ("rename", "delete", "upload", "tuning", "note"):
            self.assertIn(f'_voice_error("{what}", exc)', voices, what)
        # no voice handler raises its own prefixed message any more; the
        # station actions above keep theirs, which carry no customer copy
        self.assertNotIn("failed: {exc}", voices)

    def test_a_created_voice_refreshes_the_shelf_before_answering(self):
        """"Use this voice" writes through the Voice select entity, whose
        options are the shelf. Answering before the refresh would hand the
        panel a name Home Assistant does not list yet."""
        src = (ROOT / "http.py").read_text()
        body = src[src.index("    async def post"):]
        self.assertLess(body.index("invalidate_voice_library()"),
                        body.index("return self.json({\"ok\": True"))
        self.assertIn("async_request_refresh()", body)


# --- the Booth, pinned at the source ------------------------------------------

class CloningIsOptional(unittest.TestCase):
    """Custom voices need a component the base installation has not got.
    With no engine the Booth must not show anything that looks like it
    would work -- and must not show the empty storage slots either."""

    BLOCK = PANEL[PANEL.index("  _renderCustomVoices("):
                  PANEL.index("  _renderCreateVoice() {")]

    def test_the_offer_is_gated_on_what_the_backend_published(self):
        self.assertIn("this._voiceLib && this._voiceLib.cloning", self.BLOCK)
        for branch in ("!cloning.configured", 'cloning.reason === "unreachable"',
                       'cloning.reason === "slots_full"'):
            self.assertIn(branch, self.BLOCK, branch)

    def test_no_engine_shows_the_real_entry_point_disabled(self):
        """A paragraph with nothing to press reads as an unfinished
        prototype: a "My Voices / Custom Voices" heading, a sentence about
        recording a voice, and no control of any kind.

        The shape is now the same shape the working feature has -- the Add
        voice button, in its place -- but disabled, with one line saying
        what would switch it on. Pinned here because the two easy wrong
        answers are both regressions: deleting the section (the future
        entry point disappears) and enabling the button (the product
        promises something it cannot do)."""
        no_engine = self.BLOCK[self.BLOCK.index("if (!cloning.configured)"):]
        no_engine = no_engine[:no_engine.index("if (cloning.reason")]
        # the entry point is present, and it is inert
        self.assertIn("＋ Add voice", no_engine)
        self.assertIn("disabled", no_engine)
        self.assertIn('aria-disabled="true"', no_engine)
        # ...and it says what would make it work
        self.assertIn("ParlorWave Voice Engine", no_engine)
        self.assertIn("Home Assistant's own voices work without it", no_engine)
        # NAME THE SERVICE AND OPEN THE DOOR. The sentence used to stop at
        # "this release does not include", which was true of the ENGINE
        # and wrong about the product: since optional services shipped
        # there IS somewhere to point Parlorwave at one, and a flat
        # refusal gave the reader no way to know that. It still promises
        # nothing -- the button stays inert until the backend publishes
        # `configured`, which only a reachable engine produces.
        self.assertIn("Chatterbox-compatible", no_engine)
        self.assertIn("Optional\n        services", no_engine)
        self.assertIn('this._go("settings")', no_engine)

        # nothing that could start an enrolment is rendered
        for banned in ("<input", 'id="voice-create"', "create-file", "create-go"):
            self.assertNotIn(banned, no_engine, banned)
        # and no second heading above the shelf's own "My Voices"
        self.assertNotIn("Custom Voices", no_engine,
                         "one heading per shelf; the group head already names it")

    def test_an_unreachable_engine_also_says_where_its_address_lives(self):
        block = self.BLOCK[self.BLOCK.index('cloning.reason === "unreachable"'):]
        block = block[:block.index('cloning.reason === "slots_full"')]
        self.assertIn('this._go("settings")', block)
        self.assertIn("Optional", block)

    def test_the_create_button_exists_only_on_the_available_branch(self):
        self.assertEqual(self.BLOCK.count('id="voice-create"'), 1)
        offer = self.BLOCK[self.BLOCK.index('cloning.reason === "slots_full"'):]
        self.assertIn('id="voice-create"', offer,
                      "the button must come after every unavailable branch")

    def test_a_full_shelf_explains_itself_in_the_backends_words(self):
        full = self.BLOCK[self.BLOCK.index('cloning.reason === "slots_full"'):]
        full = full[:full.index('return `<div class="row clone-row">')]
        self.assertIn("this._esc(cloning.message)", full)
        self.assertNotIn("three slots", full)

    def test_the_base_speech_path_is_untouched_by_any_of_this(self):
        """Home Assistant and curated voices are rendered before the
        custom section and never inside its branches."""
        library = PANEL[PANEL.index("  _renderVoiceLibrary() {"):
                        PANEL.index("  _renderCustomVoices(")]
        self.assertIn('group("ha", haRows', library)
        self.assertIn('group("local", localRows', library)
        self.assertNotIn("cloning", library[:library.index('group("mine"')])


class TheCuratedShelfIsShelvedNotDeleted(unittest.TestCase):
    """Seven curated voices are served by an optional engine this release
    does not ship. On an ordinary installation every one of them is
    unavailable, and an install without that engine would show all seven
    greyed out under a heading promising curated DJ voices -- which reads as a broken
    product rather than an absent option.

    The shelf is therefore not drawn when nothing on it can be used. The
    word for that is SHELVED: the provider, the voice ids, the name and
    delivery mappings, the availability probe and the tests over them all
    stay exactly where they are, and the shelf returns by itself the moment
    the engine answers."""

    LIB = PANEL[PANEL.index("  _renderVoiceLibrary() {"):
                PANEL.index("  _renderCustomVoices(")]

    def test_the_shelf_is_hidden_only_when_nothing_on_it_can_be_used(self):
        self.assertIn("const localShelved = allGone(lib.kokoro) && !localSelected;",
                      self.LIB)
        self.assertIn('${localShelved ? "" : group("local", localRows',
                      self.LIB)

    def test_a_selected_voice_is_never_hidden_even_when_unavailable(self):
        """The one exception, and it is not optional. Hiding the voice the
        station is set to use would leave somebody looking at a library
        that does not contain their own DJ."""
        self.assertIn(
            "const localSelected = (lib.kokoro || []).some((k) => k.voice_id === selected);",
            self.LIB)

    def test_the_rows_are_still_built_so_nothing_downstream_lost_a_voice(self):
        """Shelving is a rendering decision taken at the last moment. The
        rows are still constructed from the same shelf, so a returning
        engine needs no other change -- and `_voiceName` can still name a
        curated voice in break history while the shelf is hidden."""
        self.assertIn("const localRows = (lib.kokoro || []).map((k) => row(k, {",
                      self.LIB)
        self.assertIn("for (const k of lib.kokoro || [])", PANEL,
                      "history still resolves a curated voice's name")

    def test_nothing_about_the_provider_was_removed(self):
        """The panel keeps every curated-voice affordance it had: the
        delivery tuning row, its preview, and the group's own copy."""
        for kept in ("data-vtune", "data-vtune-preview", "data-vtune-save",
                     "tuneRow", "VOICE_GROUPS", "builtin_name"):
            self.assertIn(kept, PANEL, kept)
        self.assertIn("Curated DJ voices served by your ParlorWave voice engine.",
                      PANEL, "the shelf's own description is still there for when it returns")


class NoInternalIdentifierIsShown(unittest.TestCase):
    """Storage ids are how the wiring finds a row again. They are never
    something a person reads."""

    def test_no_slot_id_or_asset_name_is_rendered_as_text(self):
        for banned in ("custom_1", "custom_2", "custom_3", "jarvis_custom",
                       "ha_tts_", "chatterbox", "default_voice_1"):
            self.assertNotIn(banned, PANEL, banned)

    #: The two template forms that actually EMIT an id -- `${x.voice_id}`
    #: and `${this._esc(x.voice_id)}`. An id inside a comparison or passed
    #: to a helper emits nothing and is not in scope here.
    EMITS_ID = re.compile(
        r"""\$\{\s*(?:this\._esc\(\s*)?[A-Za-z_][\w.]*\.voice_id\s*\)?\s*\}""")

    def test_an_id_is_only_ever_emitted_into_a_data_attribute(self):
        """Ids are how the wiring finds a row again after a rebuild, so
        they are in the markup -- as attribute VALUES. An id emitted
        anywhere else would land between tags, where a person reads."""
        for block in (PANEL[PANEL.index("  _renderVoiceLibrary() {"):
                            PANEL.index("  _renderCustomVoices(")],
                      PANEL[PANEL.index("  _renderCreateVoice() {"):
                            PANEL.index("\n  _personaName")]):
            hits = list(self.EMITS_ID.finditer(block))
            self.assertTrue(hits, "nothing emitted an id at all -- check the slice")
            for match in hits:
                before = block[max(0, match.start() - 48):match.start()]
                self.assertRegex(
                    before, r'data-[a-z-]+="$',
                    f"an id is emitted outside a data attribute: "
                    f"...{before}{match.group(0)}")

    def test_the_entity_id_is_no_longer_shown_beside_a_voice(self):
        library = PANEL[PANEL.index("  _renderVoiceLibrary() {"):
                        PANEL.index("  _renderCustomVoices(")]
        self.assertNotIn("entity_id", library)

    def test_engineering_identifiers_still_live_in_settings(self):
        """They are not banned from the product -- they are banned from the
        Booth. The diagnostics view is where an installer looks."""
        diag = PANEL[PANEL.index("  _renderDiagnostics() {"):
                     PANEL.index("  _render() {")]
        self.assertIn("entity: ", diag)


class CreateAVoice(unittest.TestCase):
    FORM = PANEL[PANEL.index("  _renderCreateVoice() {"):
                 PANEL.index("\n  _personaName")]
    FLOW = PANEL[PANEL.index("  _openCreate() {"):PANEL.index("  // --- actions")]

    def test_the_form_asks_for_a_name_a_note_and_a_recording(self):
        self.assertIn('id="create-name"', self.FORM)
        self.assertIn('id="create-note"', self.FORM)
        self.assertIn('id="create-file"', self.FORM)
        self.assertIn("(optional)", self.FORM, "the note is not required")
        self.assertIn('accept=".wav,.mp3,.flac', self.FORM)
        self.assertNotIn("slot", self.FORM, "no storage slot is ever offered")

    def test_the_guidance_is_the_backends_and_names_the_bounds_it_enforces(self):
        self.assertIn("cloning.recommended", self.FORM)
        self.assertIn("10–30 seconds of one person speaking clearly", self.FORM)
        self.assertIn("no music, no other voices, little background noise",
                      self.FORM)
        self.assertIn("WAV, MP3 or FLAC.", self.FORM)

    def test_the_privacy_line_states_a_fact_and_claims_nothing_more(self):
        self.assertIn("cloning.processing || PRIVACY_COPY", self.FORM)
        copy = re.search(r"const PRIVACY_COPY =\s*\n?\s*\"([^\"]+)\"", PANEL)
        self.assertTrue(copy, "the privacy line is not a named constant")
        self.assertEqual(
            copy.group(1),
            "Custom voices are processed by your configured ParlorWave voice engine.")
        for banned in ("100% local", "never leaves", "fully private",
                       "on-device", "offline"):
            self.assertNotIn(banned.lower(), PANEL.lower(), banned)
        # and nothing anywhere infers privacy from an address
        for banned in ("192.168", "127.0.0.1", "10.0.0", "isPrivate",
                       "localhost"):
            self.assertNotIn(banned, PANEL, banned)

    def test_the_steps_run_create_then_audition_then_optionally_use(self):
        """The cloned voice speaks once, the
        audio is kept for "Hear it again", and "Use this voice" is offered
        only after it has spoken -- never for a voice that could not."""
        submit = self.FLOW[self.FLOW.index("async _submitCreate()"):]
        submit = submit[:submit.index("  /* \"Use this voice\"")]
        self.assertLess(submit.index("fetch("), submit.index("_fetchVoiceLib()"))
        self.assertLess(submit.index("_fetchVoiceLib()"),
                        submit.index("this._audition(c, out.voice_id)"))
        done = self.FORM[self.FORM.index("if (c.done)"):]
        self.assertIn("is ready", done)
        self.assertIn('data-audition="${this._esc(c.done.voice_id)}"', done)
        self.assertIn('id="audition-play"', done)
        self.assertIn('data-vuse="${this._esc(c.done.name)}"', done)
        self.assertIn("Use this voice", done)
        self.assertIn('!replacing && a.state === "ready"', done)

    def test_a_refusal_is_shown_where_it_happened_in_the_words_it_came_in(self):
        # uploadRefusal keeps the view's/service's/engine's own message and
        # words only what arrived without one (Home Assistant's 401);
        # test_panel_recorder.mjs executes both halves.
        self.assertIn("c.error = uploadRefusal(resp.status, out);", self.FLOW)
        refusal = PANEL[PANEL.index("function uploadRefusal(status, body) {"):]
        refusal = refusal[:refusal.index("\n}")]
        self.assertLess(refusal.index("if (said) return said;"), refusal.index("401"))
        self.assertIn('<div class="notice err">${this._esc(c.error)}</div>',
                      self.FORM)

    def test_the_draft_survives_a_render(self):
        """The same rule the note and rename boxes follow: what is typed
        lives in state, so a coordinator poll between two keystrokes cannot
        put an empty box back under the cursor."""
        wire = PANEL[PANEL.index('for (const [id, key] of [["create-name"'):]
        wire = wire[:wire.index("const file =")]
        self.assertIn("this._create[key] = input.value", wire)
        self.assertIn('input.addEventListener("input"', wire)

    def test_warnings_are_shown_and_never_block(self):
        done = self.FORM[self.FORM.index("if (c.done)"):]
        self.assertIn("c.done.warnings", done)
        self.assertIn('class="notice warn"', done)
        self.assertIn("Use this voice", done, "a warning does not gate the voice")

    def test_deleting_a_voice_asks_first(self):
        library = PANEL[PANEL.index("  _renderVoiceLibrary() {"):
                        PANEL.index("  _renderCustomVoices(")]
        self.assertIn("this._confirmDelete === c.voice_id", library)
        self.assertIn("Delete this voice?", library)
        wire = PANEL[PANEL.index('querySelectorAll("[data-vdelete]")'):]
        wire = wire[:wire.index('querySelectorAll("[data-vuse]")')]
        self.assertIn("this._confirmDelete = b.dataset.vdelete", wire)
        self.assertIn('"voice_delete"', wire)
        self.assertIn("this._fetchVoiceLib()", wire)


class TheLibraryReadsAsOneThing(unittest.TestCase):
    """Decisions from the visual pass, kept as rules rather than as
    memories of a screenshot."""

    LIBRARY = PANEL[PANEL.index("  _renderVoiceLibrary() {"):
                    PANEL.index("  _renderCustomVoices(")]

    def test_one_row_never_carries_two_meanings_of_delete(self):
        """A My Voices row can clear a NOTE and delete a VOICE. Those must
        not look alike: one is a stroke of text, the other removes a
        recording that cannot be got back."""
        self.assertIn('data-vnote-clear="${id}" title="Clear this note">✕', self.LIBRARY)
        self.assertIn('data-vdelete="${c.voice_id}"', self.LIBRARY)
        self.assertIn('aria-label="Delete this voice">Delete', self.LIBRARY)
        self.assertNotIn("🗑", self.LIBRARY, "a bin glyph cannot mean two things")

    def test_a_row_says_nothing_the_group_head_already_said(self):
        """Nine rows of 'No note yet.' under a heading about voices is the
        loudest thing on the screen and says nothing."""
        # checked on what is RENDERED: the filler text and the argument
        # that carried it are both gone, comments about why notwithstanding
        self.assertNotIn("notePlaceholder", PANEL)
        self.assertNotIn("${this._esc(fallback)}", PANEL)
        self.assertNotIn('desc: "Curated DJ voice', PANEL)
        self.assertNotIn('desc: "Home Assistant', PANEL)
        self.assertIn("row(h, {})", self.LIBRARY, "a plain HA row carries no extras")
        # a row description survives only where it carries a per-voice fact
        self.assertIn("Speed ${fx(k.speed)} · pause ${fx(k.pause)}", self.LIBRARY)
        self.assertIn("opts.desc ?", self.LIBRARY)

    def test_every_row_action_is_a_word(self):
        """Emoji do not take a colour, so an emoji cannot carry a state or
        a severity. The ones that remain are decoration beside a word."""
        for action in (">▶ Preview<", ">Tune<", ">Delete<"):
            self.assertIn(action.replace(">", "").replace("<", ""), self.LIBRARY, action)
        self.assertNotIn("⚙", PANEL)

    def test_a_voice_that_cannot_be_used_says_so_beside_its_name(self):
        """On an install where no Parlorwave voice engine exists, all seven
        curated voices come back unavailable. The word belongs
        next to the name: alone in the actions column it has nothing to
        attach to, and at phone width that column spans the row, so it
        read as a heading for the voice underneath."""
        self.assertIn('${gone ? "vgone" : ""}', self.LIBRARY)
        self.assertIn('<div class="vdesc">Unavailable right now</div>', self.LIBRARY)
        # and nothing is offered on a row that cannot act
        self.assertIn('${gone ? "" : preview(v.voice_id) + (opts.extra || "")}',
                      self.LIBRARY)
        self.assertNotIn('<span class="hint">unavailable</span>', self.LIBRARY)
        style = PANEL[PANEL.index("<style>"):PANEL.index("</style>")]
        self.assertIn(".vrow.vgone .label", style)

    def test_a_group_with_nothing_in_it_stops_advertising_an_engine(self):
        """On the same install, "Curated DJ voices served by your
        Parlorwave voice engine" would sit above seven dead rows, though
        there is no such engine. A group head describes what is usable, or
        it states the plain fact -- it never guesses WHY, because the panel
        is told availability, not cause."""
        self.assertIn("const allGone = (list)", self.LIBRARY)
        self.assertIn('every((v) => v.available === false)', self.LIBRARY)
        self.assertIn('gone ? "None of these are available right now."', self.LIBRARY)
        self.assertIn("allGone(lib.home_assistant)", self.LIBRARY)
        self.assertIn("allGone(lib.kokoro)", self.LIBRARY)
        for guess in ("not configured", "unreachable", "install", "engine is"):
            head = self.LIBRARY[self.LIBRARY.index("const group = (key"):]
            head = head[:head.index("</div>` : \"\";")]
            self.assertNotIn(guess, head, guess)

    def test_an_owners_own_words_are_never_shouted(self):
        """Section labels are small caps. A name the owner typed is not a
        section label."""
        done = PANEL[PANEL.index("if (c.done)"):]
        done = done[:done.index("const consent = this._consent();")]
        self.assertIn('class="create-done-head"', done)
        self.assertNotIn('class="create-head"', done)
        style = PANEL[PANEL.index("<style>"):PANEL.index("</style>")]
        head = style[style.index(".create-done-head {"):]
        self.assertNotIn("uppercase", head[:head.index("}")])


class BoothLooksLikeOnAir(unittest.TestCase):
    """The accepted Parlorwave language, applied -- not re-invented. Every
    surface added here paints with the same tokens On Air established, and
    On Air itself is untouched."""

    def test_new_surfaces_use_the_house_tokens_only(self):
        # The Newsroom's own block was added between the Booth's and the
        # notices; this slice is the BOOTH's, so it stops where the
        # Newsroom starts.
        booth_css = STYLE[STYLE.index("/* --- Booth: who is on the mic"):
                          STYLE.index("/* --- Newsroom: a small control desk")]
        colours = re.findall(r"#[0-9a-fA-F]{3,8}", booth_css)
        self.assertEqual(colours, ["#1a1206"],
                         "a Booth surface invented a colour outside the palette")
        for token in ("var(--pw-accent)", "var(--pw-surface)", "var(--pw-line)",
                      "var(--pw-dim)", "var(--pw-text)"):
            self.assertIn(token, booth_css, token)

    def test_the_booth_hero_borrows_the_stage_glow_not_a_new_one(self):
        self.assertIn('<div class="stage-glow" aria-hidden="true"></div>', BOOTH)

    def test_the_three_widths_are_designed_for(self):
        phone = STYLE[STYLE.index("@media (max-width: 560px)"):]
        tablet = STYLE[STYLE.index("@media (max-width: 900px)"):
                       STYLE.index("@media (max-width: 560px)")]
        self.assertIn(".booth-hero", tablet)
        for rule in (".booth-hero", ".vnow", ".create-field", ".vrow"):
            self.assertIn(rule, phone, rule)
        self.assertIn("flex-direction:column", phone)

    def test_reduced_motion_covers_the_new_accent_carriers(self):
        block = STYLE[STYLE.index("prefers-reduced-motion"):]
        for rule in (".booth-desc", ".vnow", ".vrow.vsel", ".vbadge"):
            self.assertIn(rule, block, rule)

    def test_on_air_was_not_redesigned(self):
        """Its render is still its own, and the Booth never reaches into
        it. Kept as a tripwire: the Booth has no business there.

        Start Radio and the request box are not named here -- they live
        on their own Station screen, and pinning them to On Air would make
        this tripwire fight that layout. That they
        exist exactly once, on Station, is pinned in test_panel_onair.py."""
        onair = PANEL[PANEL.index("  _renderOnAir() {"):
                      PANEL.index("  _renderThumbs(playing) {")]
        for kept in ('class="stage"', 'id="drawer-lyrics"', 'id="drawer-queue"',
                     "_renderDrawer()"):
            self.assertIn(kept, onair, kept)
        for booth_only in ("booth-hero", "vnow", "create-", "cloning"):
            self.assertNotIn(booth_only, onair, booth_only)


if __name__ == "__main__":
    unittest.main()
