"""Settings, and the readiness model it renders.

Two halves, like the rest of the panel's coverage.

EXECUTED: the readiness view model (readiness.py) and the one websocket
command that serves it, run against the Home Assistant harness. That is
where every product rule on this screen actually lives -- what "ready"
means, which absences are faults and which are simply absences, which
screen owns which setting, and the promise that no token, key, path or
internal address can reach a browser. All of those are decidable
questions about a function, so they are asked of the function.

PINNED AT THE SOURCE: what the panel can possibly render. A browser is
not available here, so "Settings does not grow a second copy of Booth's
controls" and "the first-run state is designed for at three widths" are
checked against the file that would have to contain them.
"""

import asyncio
import json
import re
import unittest
from pathlib import Path

from harness import FakeResponse, FakeTransport, coordinator_of, make_hass

import custom_components.parlorwave_radio as integration
from custom_components.parlorwave_radio import readiness

ROOT = Path(__file__).resolve().parent.parent / "custom_components" / "parlorwave_radio"
PANEL = (ROOT / "panel" / "parlorwave-radio-panel.js").read_text()
SETTINGS = PANEL[PANEL.index("  /* --- Settings ---"):PANEL.index("  _render() {")]
DIAG = PANEL[PANEL.index("  _renderDiagnostics() {"):PANEL.index("  /* --- Settings ---")]
STYLE = PANEL[PANEL.index("<style>"):PANEL.index("</style>")]
SETTINGS_CSS = STYLE[STYLE.index("--- Settings:"):STYLE.index("--- notices")]


# --- a backend whose whole health answer is a fixture --------------------------

MA_URL = "http://music-assistant.local:8095"


def features(**over):
    base = {
        "music_assistant": {"configured": True, "reachable": True, "url": MA_URL,
                            "token_present": True, "players": 4},
        "writer": {"configured": True, "provider": "deterministic",
                   "fallback": None, "llm_reachable": None,
                   "llm": {"configured": False, "provider": None, "model": None}},
        "tts": {"configured": True, "providers": ["home_assistant"],
                "selected": {"provider": "home_assistant", "entity_id": "tts.piper",
                             "name": "Piper · Amy", "state": "healthy"}},
        "home_assistant": {"configured": True, "mode": "addon",
                           "url": "http://supervisor/core", "reachable": True},
        "audio": {"advertise_url": "http://172.30.33.2:5005",
                  "break_audio_base": "http://172.30.33.2:5005/broadcast/audio"},
        # A brand-new Home Assistant OS install: no local music catalog.
        "catalog": {"usable": False, "track_count": 0, "minimum_tracks": 5},
        "outputs": {"dj_enabled": True, "enabled": ["media_player.den"],
                    "selected": "media_player.den"},
        "observer": {"configured_mode": "authoritative", "active_mode": "authoritative",
                     "queue_mode": "auto", "running": True, "feeding": True,
                     "queue_id": "q-1", "target_reason": "selected_output",
                     "last_error": None},
    }
    for key, value in over.items():
        base[key] = {**base[key], **value} if isinstance(value, dict) else value
    return base


def health(problems=None, **over):
    return {"ok": not [p for p in (problems or [])
                       if p["severity"] in ("fatal", "error")],
            "checked_at": "2026-09-15T10:00:00+00:00",
            "instance_id": "f1e2d3c4b5a69788", "fatal": [],
            "problems": list(problems or []), "features": features(**over)}


def problem(code, severity, component, summary="a summary", action="an action"):
    return {"code": code, "severity": severity, "component": component,
            "summary": summary, "action": action}


#: the base voice shelf of an install with no optional voice engine
NO_ENGINE_VOICES = {"ok": True, "home_assistant": [{"voice_id": "ha_piper_amy"}],
                    "kokoro": [], "customs": [],
                    "cloning": {"configured": False, "reason": "unconfigured"}}

NO_FEED_NEWS = {"ok": True, "newsroom": {
    "bulletins": {"enabled": False, "configured": False,
                  "headline": "No news feed", "detail": "", "state_label": "Off"},
    "headlines_in_breaks": {"status": "not_configured"},
    "advanced": {"automation": "disabled"}}}

LIVE_FEED_NEWS = {"ok": True, "newsroom": {
    "bulletins": {"enabled": True, "configured": True,
                  "headline": "Bulletins are on", "detail": "",
                  "state_label": "Waiting for the next bulletin"},
    "headlines_in_breaks": {"status": "not_configured"},
    "advanced": {"automation": "watching"}}}


class SettingsTransport(FakeTransport):
    """The harness backend with a settable health report, voice shelf and
    newsroom, so a whole installation can be described as a fixture."""

    def __init__(self, report=None, voices=None, news=None, **kw):
        super().__init__(**kw)
        self.report = health() if report is None else report
        self.voices = NO_ENGINE_VOICES if voices is None else voices
        self.news = NO_FEED_NEWS if news is None else news
        out = (self.report.get("features") or {}).get("outputs") or {}
        self.dj = {"enabled": bool(out.get("dj_enabled")),
                   "outputs": {"enabled": list(out.get("enabled") or []),
                               "default_request_output": out.get("selected")}}

    async def request(self, method, url, json=None, headers=None, timeout=None):
        path = "/" + url.split("//", 1)[-1].split("/", 1)[1].split("?", 1)[0]
        if path in ("/health/problems", "/voices/library", "/news/status"):
            self.calls.append({"method": method, "path": path, "json": json,
                               "headers": dict(headers or {})})
            return FakeResponse(200, {"/health/problems": self.report,
                                      "/voices/library": self.voices,
                                      "/news/status": self.news}[path])
        return await super().request(method, url, json=json, headers=headers,
                                     timeout=timeout)


class FakeConnection:
    def __init__(self):
        self.result, self.error = None, None

    def send_result(self, _id, result):
        self.result = result

    def send_error(self, _id, code, message):
        self.error = (code, message)


def setup(transport, tts_entities=("tts.piper",)):
    hass, entry = make_hass(transport)
    asyncio.run(integration.async_setup_entry(hass, entry))
    for entity_id in tts_entities:
        hass.states.async_set(entity_id, "idle", {"friendly_name": "Piper"})
    return hass, entry


def ws(hass, name="readiness", msg=None):
    wanted = f"parlorwave_radio/{name}"
    for handler in hass.data.get("_fake_ws_commands", []):
        if handler.ws_schema.get("type") == wanted:
            conn = FakeConnection()
            payload = {"id": 1, "type": wanted}
            payload.update(msg or {})
            asyncio.run(handler(hass, conn, payload))
            if conn.error:
                raise AssertionError(f"{name} refused: {conn.error}")
            return conn.result
    raise AssertionError(f"{wanted} is not registered")


def doc(transport=None, tts_entities=("tts.piper",), **kw):
    """The Settings document, through the real command."""
    hass, _entry = setup(transport or SettingsTransport(**kw), tts_entities)
    return ws(hass)["readiness"]


# === the command ==============================================================

class TheCommand(unittest.TestCase):
    def test_settings_is_one_read_only_command_in_the_product_namespace(self):
        init = (ROOT / "__init__.py").read_text()
        self.assertIn('_command("parlorwave_radio/readiness"', init)
        transport = SettingsTransport()
        hass, _entry = setup(transport)
        before = len(transport.calls)
        ws(hass)
        new = transport.calls[before:]
        self.assertEqual([c["method"] for c in new], ["GET"] * len(new))
        self.assertEqual([c["path"] for c in new], ["/news/status"])

    def test_a_newsroom_that_cannot_be_read_does_not_take_the_screen_down(self):
        """The Newsroom is one optional row here. Failing to read it must
        never cost the screen that would have explained what else is
        wrong."""
        class NoNews(SettingsTransport):
            async def request(self, method, url, **kw):
                if "/news/status" in url:
                    return FakeResponse(500, {"detail": "no"})
                return await super().request(method, url, **kw)
        hass, _entry = setup(NoNews())
        r = ws(hass)["readiness"]
        self.assertEqual(r["state"], "ready")
        self.assertEqual([o["key"] for o in r["optional"]], ["catalog", "voice_engine"])


# === the verdict ==============================================================

class AFullyReadyBaseInstallation(unittest.TestCase):
    """Home Assistant OS, Music Assistant, one speaker, a Piper voice, the
    DJ on -- and no catalog, no voice engine, no writing model and no news
    feed. This is the product's intended shape, not a reduced one, and the
    screen has to say so without a single qualification."""

    def setUp(self):
        self.r = doc()

    def test_it_is_ready_with_nothing_to_fix(self):
        self.assertEqual(self.r["state"], "ready")
        self.assertEqual(self.r["headline"], "Ready.")
        self.assertEqual(self.r["blockers"], [])
        self.assertEqual(self.r["warnings"], [])

    def test_all_four_setup_steps_are_done_and_there_are_only_four(self):
        self.assertEqual((self.r["complete"], self.r["total"]), (4, 4))
        self.assertEqual([c["key"] for c in self.r["checklist"]],
                         ["music_assistant", "outputs", "speech", "dj"])
        self.assertTrue(all(c["done"] for c in self.r["checklist"]))

    def test_no_optional_capability_is_ever_a_setup_step(self):
        """The surest way to never tell a new owner they need a premium
        system is for the list of things they need not to know one
        exists."""
        keys = {c["key"] for c in self.r["checklist"]}
        for optional in ("catalog", "voice_engine", "newsroom", "writer", "llm"):
            self.assertNotIn(optional, keys, optional)

    def test_every_section_reports_and_names_where_it_is_changed(self):
        self.assertEqual(self.r["music_assistant"]["label"], "Connected")
        self.assertEqual(self.r["music_assistant"]["endpoint"], MA_URL)
        self.assertEqual(self.r["outputs"]["current"], "Den")
        # No route out of this section any more. The DJ-enabled speakers are
        # edited on this screen, and a "go and configure this" button
        # pointing at the page you are standing on is precisely the detour
        # that sends an installer off to Devices & services.
        self.assertIsNone(self.r["outputs"]["where"])
        self.assertEqual(self.r["speech"]["label"], "Ready")
        self.assertIn("Piper", self.r["speech"]["detail"])


class TheServiceRefusesTheKey(unittest.TestCase):
    """A refused key is not a silent service. After a reinstall on HA OS
    the add-on ANSWERS and refuses the old entry's key;
    Settings said "not answering" and sent people to start an add-on that
    was already running."""

    def test_a_refused_key_is_its_own_issue_with_the_way_out(self):
        d = readiness.build({}, connected=False, key_refused=True)
        self.assertEqual(d["state"], "needs_attention")
        first = d["blockers"][0]
        self.assertEqual((first["code"], first["where"]), ("service_key_refused", "options"))
        words = (first["title"] + " " + first["detail"]).lower()
        for needed in ("refuses", "reinstalled", "delete this", "newly discovered",
                       "restart the add-on"):
            self.assertIn(needed, words)
        self.assertNotIn("not answering", words)
        self.assertNotIn("service_unreachable", [b["code"] for b in d["blockers"]])

    def test_a_silent_service_is_still_not_answering(self):
        d = readiness.build({}, connected=False)
        self.assertEqual(d["blockers"][0]["code"], "service_unreachable")

    def test_a_refused_key_means_nothing_while_the_service_answers(self):
        d = readiness.build({}, connected=True, key_refused=True)
        self.assertNotIn("service_key_refused", [b["code"] for b in d["blockers"]])

    def test_the_command_tells_a_refused_key_from_a_silent_service(self):
        from homeassistant.exceptions import ConfigEntryAuthFailed
        hass, entry = setup(SettingsTransport())
        c = coordinator_of(hass, entry)
        c.last_update_success = False
        c.last_exception = ConfigEntryAuthFailed("The ParlorWave Radio service rejected the API key")
        self.assertEqual(ws(hass)["readiness"]["blockers"][0]["code"], "service_key_refused")
        c.last_exception = OSError("connection refused")
        self.assertEqual(ws(hass)["readiness"]["blockers"][0]["code"], "service_unreachable")
        c.last_update_success, c.last_exception = True, None
        codes = [b["code"] for b in ws(hass)["readiness"]["blockers"]]
        self.assertNotIn("service_key_refused", codes)
        self.assertNotIn("service_unreachable", codes)


class MusicAssistant(unittest.TestCase):
    def test_an_unreachable_server_needs_attention_not_setup(self):
        """It was configured and stopped answering. Telling somebody to
        set up a thing they already set up is how they take a working
        configuration apart."""
        r = doc(report=health([problem("ma_unreachable", "error", "music_assistant")],
                              music_assistant={"reachable": False}))
        self.assertEqual(r["state"], "needs_attention")
        self.assertEqual(r["headline"], "Needs attention.")
        self.assertIn("Music Assistant did not answer", r["detail"])
        self.assertEqual(r["music_assistant"]["label"], "Not answering")
        step = r["checklist"][0]
        self.assertFalse(step["done"])
        self.assertEqual(step["code"], "ma_unreachable")

    def test_no_server_at_all_is_setup_and_names_the_first_step(self):
        r = doc(report=health([problem("ma_url_missing", "fatal", "music_assistant")],
                              music_assistant={"reachable": False, "url": None,
                                               "token_present": False}))
        self.assertEqual(r["state"], "needs_setup")
        self.assertEqual(r["headline"], "Not quite ready.")
        self.assertIn("connect Music Assistant", r["detail"])
        self.assertEqual(r["music_assistant"]["rows"][0], ["Server", "Not set"])

    def test_the_token_is_reported_as_present_and_never_shown(self):
        """The add-on's real first-run state: an address, and a token that
        has not been pasted yet. The screen must be able to say which of
        the two is missing while never holding either."""
        r = doc(report=health([problem("ma_token_missing", "error", "music_assistant")],
                              music_assistant={"reachable": False, "token_present": False}))
        # NAMED FOR THE PRODUCT THAT ISSUES IT. An installer can paste a
        # HOME ASSISTANT long-lived token into this field; both products
        # issue something called a long-lived access token, and the add-on
        # lives inside Home Assistant. Every sentence about this token now
        # says which product it comes from.
        self.assertEqual(r["music_assistant"]["label"],
                         "Waiting for a Music Assistant token")
        self.assertEqual(r["music_assistant"]["rows"],
                         [["Server", MA_URL],
                          ["Music Assistant access token", "Not set"]])
        self.assertIn("not in Home Assistant", r["music_assistant"]["detail"])
        self.assertEqual(r["checklist"][0]["where"], readiness.WHERE_ADDON)
        ready = doc()
        self.assertIn(["Music Assistant access token", "Present"],
                      ready["music_assistant"]["rows"])


class DjOutputs(unittest.TestCase):
    def test_no_enabled_speaker_is_a_setup_step_handled_on_this_screen(self):
        """It used to route to the integration's options flow. It does not
        any more, because the allow-list is edited here -- and the trip to
        Devices & services was the single worst thing about setting this
        product up: several plausible Parlorwave rows, a device page whose
        "Output" selector looks like speaker setup and is not, the real
        control behind an unannounced gear icon, and no way back."""
        r = doc(report=health([problem("no_outputs_enabled", "error", "outputs")],
                              outputs={"enabled": [], "selected": None}))
        self.assertEqual(r["state"], "needs_setup")
        step = next(c for c in r["checklist"] if c["key"] == "outputs")
        self.assertFalse(step["done"])
        self.assertEqual(step["where"], readiness.WHERE_SETTINGS)
        self.assertEqual(r["outputs"]["label"], "None enabled")
        self.assertEqual(r["outputs"]["speakers"], [])

    def test_enabled_speakers_and_the_current_one_are_different_facts(self):
        """The allow-list is what Parlorwave Radio MAY use; the current
        output is the one it IS using. A screen that blurs them is how an
        owner ends up enabling a speaker and wondering why nothing came
        out of it."""
        r = doc(report=health(outputs={"enabled": ["media_player.den", "ma_web123"],
                                       "selected": "ma_web123"}))
        names = [(s["name"], s["current"], s["available"]) for s in r["outputs"]["speakers"]]
        self.assertEqual(names, [("Den", False, True), ("Web (Chrome)", True, True)])
        self.assertEqual(r["outputs"]["current"], "Web (Chrome)")

    def test_a_speaker_music_assistant_cannot_see_is_shown_as_such(self):
        r = doc(report=health(outputs={"enabled": ["media_player.den", "00000000-aaaa"],
                                       "selected": "media_player.den"}))
        gone = next(s for s in r["outputs"]["speakers"] if s["name"] == "Utility room")
        self.assertFalse(gone["available"])
        self.assertTrue(gone["known"])

    def test_the_dj_being_off_is_the_last_setup_step_and_belongs_to_on_air(self):
        r = doc(report=health(outputs={"dj_enabled": False}))
        step = next(c for c in r["checklist"] if c["key"] == "dj")
        self.assertFalse(step["done"])
        self.assertEqual(step["where"], readiness.WHERE_ONAIR)
        self.assertEqual(r["state"], "needs_setup")


class Speech(unittest.TestCase):
    def test_no_speech_at_all_is_a_setup_step_pointing_at_home_assistant(self):
        r = doc(report=health([problem("tts_unconfigured", "warning", "tts")],
                              tts={"configured": False, "providers": [],
                                   "selected": {"provider": None, "entity_id": None,
                                                "name": None, "state": None}}),
                tts_entities=())
        self.assertEqual(r["speech"]["label"], "No voice yet")
        self.assertEqual(r["speech"]["where"], readiness.WHERE_HA_TTS)
        step = next(c for c in r["checklist"] if c["key"] == "speech")
        self.assertFalse(step["done"])
        self.assertEqual(r["state"], "needs_setup")

    def test_a_home_assistant_with_no_voice_installed_is_told_so_plainly(self):
        """The backend can only say it is allowed to reach Home Assistant.
        Whether anything there can actually speak is a question only Home
        Assistant can answer, and on a fresh Home Assistant OS the answer
        is no."""
        r = doc(tts_entities=())
        self.assertEqual(r["speech"]["label"], "No voice yet")
        self.assertIn("no text-to-speech engine", r["speech"]["detail"])
        self.assertEqual(r["state"], "needs_setup")

    def test_the_speech_row_names_the_engine_that_is_actually_on_air(self):
        """An installation can have Home Assistant speech AND a voice
        engine; the reader is asking which one speaks the voice they chose,
        not which ones exist. This row named Home Assistant whenever Home
        Assistant speech was present at all -- on a station whose every
        break came out of the voice engine."""
        r = doc(report=health([], tts={
            "configured": True, "providers": ["home_assistant", "chatterbox"],
            "selected": {"provider": "chatterbox", "entity_id": None,
                         "name": "Custom 1", "state": None}}))
        self.assertEqual(dict(r["speech"]["rows"])["Speech"],
                         "ParlorWave voice engine")

    def test_the_speech_row_still_names_home_assistant_when_it_speaks(self):
        r = doc(report=health([], tts={
            "configured": True, "providers": ["home_assistant", "chatterbox"],
            "selected": {"provider": "home_assistant", "entity_id": "tts.piper",
                         "name": "Piper \u00b7 Amy", "state": "idle"}}))
        self.assertEqual(dict(r["speech"]["rows"])["Speech"],
                         "Home Assistant text-to-speech")

    def test_a_voice_engine_installation_is_ready_not_broken(self):
        """The whole speech-row fix, at the level a person sees it: a station
        whose voice engine is configured and speaking reads Ready, and its
        fourth setup step is done. It used to read Needs attention, and
        'The chosen voice cannot speak on this installation', while the
        breaks were audibly playing."""
        r = doc(report=health([], tts={
            "configured": True, "providers": ["home_assistant", "chatterbox"],
            "selected": {"provider": "chatterbox", "entity_id": None,
                         "name": "Custom 1", "state": None}}))
        self.assertEqual(r["speech"]["state"], "ok")
        self.assertEqual(r["speech"]["label"], "Ready")
        step = next(c for c in r["checklist"] if c["key"] == "speech")
        self.assertTrue(step["done"])
        self.assertEqual(r["state"], "ready")

    def test_a_broken_voice_is_actionable_and_sends_you_to_booth(self):
        r = doc(report=health([problem("ha_tts_entity_unavailable", "error", "tts")],
                              tts={"selected": {"provider": "home_assistant",
                                                "entity_id": "tts.piper",
                                                "name": "Piper · Amy",
                                                "state": "unavailable"}}))
        self.assertEqual(r["state"], "needs_attention")
        self.assertEqual(r["speech"]["label"], "Cannot speak")
        step = next(c for c in r["checklist"] if c["key"] == "speech")
        self.assertEqual(step["where"], readiness.WHERE_BOOTH)
        self.assertIn("Booth", step["detail"])

    def test_the_speech_service_behind_a_voice_is_never_named(self):
        """Chatterbox and Kokoro are implementation. What a person owns is
        'the Parlorwave voice engine', and that is the only name for it
        that leaves this module."""
        r = doc(report=health(tts={"providers": ["kokoro"],
                                   "selected": {"provider": "kokoro", "entity_id": None,
                                                "name": "Nora", "state": None}}))
        text = repr(r)
        for internal in ("kokoro", "Kokoro", "chatterbox", "Chatterbox"):
            self.assertNotIn(internal, text, internal)
        self.assertTrue(r["speech"]["local_engine"])


class TheWriter(unittest.TestCase):
    """The base product writes every break itself. This is the one section
    where getting the tone wrong would misdescribe the product."""

    def test_no_model_is_not_a_problem_a_warning_or_a_setup_step(self):
        r = doc()
        self.assertEqual(r["writer"]["state"], "ok")
        self.assertEqual(r["writer"]["label"], "Ready")
        self.assertFalse(r["writer"]["llm_configured"])
        self.assertEqual(r["blockers"], [])
        self.assertEqual(r["warnings"], [])
        self.assertNotIn("writer", {c["key"] for c in r["checklist"]})

    def test_the_built_in_writer_is_described_as_the_product_not_a_fallback(self):
        built_in = doc()["writer"]["rows"][0]
        self.assertEqual(built_in["badge"], "Always available")
        self.assertEqual(built_in["tone"], "on")
        self.assertIn("This is the product, not a fallback", built_in["detail"])
        optional = doc()["writer"]["rows"][1]
        self.assertEqual(optional["badge"], "Not configured")
        self.assertIn("Optional.", optional["detail"])
        for word in ("degraded", "limited", "reduced", "unavailable", "missing"):
            self.assertNotIn(word, optional["detail"].lower(), word)

    def test_a_configured_model_that_stops_answering_says_nothing_is_missing(self):
        r = doc(report=health([problem("optional_writer_unavailable", "warning", "writer")],
                              writer={"provider": "ollama", "fallback": "deterministic",
                                      "llm_reachable": False,
                                      "llm": {"configured": True, "provider": "ollama",
                                              "model": "example-model"}}))
        # a warning, never a blocker, and it never moves the verdict
        self.assertEqual(r["state"], "ready")
        self.assertEqual([w["code"] for w in r["warnings"]],
                         ["optional_writer_unavailable"])
        self.assertIn("Nothing is missing from the broadcast",
                      r["warnings"][0]["detail"])
        self.assertEqual(r["writer"]["rows"][1]["badge"], "Not answering")


class OptionalCapabilities(unittest.TestCase):
    def test_no_local_catalog_is_a_capability_row_and_never_an_error(self):
        r = doc()
        catalog = next(o for o in r["optional"] if o["key"] == "catalog")
        self.assertEqual(catalog["badge"], "Not in this release")
        self.assertEqual(catalog["tone"], "off")
        self.assertEqual(catalog["where"], readiness.WHERE_STATION)
        self.assertIn("complete way to run the station", catalog["detail"])
        self.assertEqual(r["state"], "ready")
        self.assertEqual(r["blockers"] + r["warnings"], [])

    def test_no_voice_engine_is_a_capability_row_and_never_an_error(self):
        engine = next(o for o in doc()["optional"] if o["key"] == "voice_engine")
        # the feature is in this release; what is missing is the engine
        self.assertEqual(engine["badge"], "Needs a voice engine")
        self.assertEqual(engine["tone"], "off")
        self.assertEqual(engine["where"], readiness.WHERE_BOOTH)
        self.assertIn("work without it", engine["detail"])

    def test_no_news_feed_is_a_capability_row_and_never_an_error(self):
        news = next(o for o in doc()["optional"] if o["key"] == "newsroom")
        self.assertEqual(news["badge"], "No feed")
        self.assertEqual(news["where"], readiness.WHERE_NEWSROOM)
        self.assertIn("Nothing else depends on it", news["detail"])

    def test_a_configured_feed_says_ENABLED_and_never_ON_AIR(self):
        """"On air" is the product's word for something airing at this
        moment -- the masthead lamp, the state line on the stage. This row
        only says the feature is switched on and has a feed. Whether a
        bulletin is playing right now is the Newsroom's question, and
        readiness has no business answering it."""
        r = doc(news=LIVE_FEED_NEWS)
        news = next(o for o in r["optional"] if o["key"] == "newsroom")
        self.assertEqual(news["badge"], "Enabled")
        self.assertEqual(news["tone"], "on")
        self.assertEqual(news["where"], readiness.WHERE_NEWSROOM)
        # and the phrase is not reached by any other badge on the screen
        badges = ([o["badge"] for o in r["optional"]]
                  + [row["badge"] for row in r["writer"]["rows"]]
                  + [row["badge"] for row in r["context"]["rows"]]
                  + [r["music_assistant"]["label"], r["outputs"]["label"],
                     r["speech"]["label"]])
        for badge in badges:
            self.assertNotIn("air", str(badge).lower(), badge)

    def test_a_capability_that_is_present_is_reported_from_its_own_contract(self):
        r = doc(report=health(catalog={"usable": True, "track_count": 3120}),
                voices={"ok": True, "customs": [{"voice_id": "custom_1", "has_sample": True}],
                        "cloning": {"configured": True}})
        catalog = next(o for o in r["optional"] if o["key"] == "catalog")
        self.assertEqual(catalog["badge"], "3,120 tracks")
        engine = next(o for o in r["optional"] if o["key"] == "voice_engine")
        self.assertEqual(engine["badge"], "1 created")

    def test_settings_reports_optional_features_and_configures_none_of_them(self):
        for row in doc()["optional"]:
            self.assertIn(row["where"], (readiness.WHERE_STATION, readiness.WHERE_BOOTH,
                                         readiness.WHERE_NEWSROOM))


class Context(unittest.TestCase):
    def test_unset_context_is_unset_and_not_a_fault(self):
        rows = {r["label"]: r for r in doc()["context"]["rows"]}
        self.assertEqual(rows["Weather"]["badge"], "Not set")
        self.assertEqual(rows["Calendar"]["badge"], "Not set")
        self.assertNotIn("Weather", [b["title"] for b in doc()["blockers"]])

    def test_a_chosen_entity_is_named_by_its_friendly_name_and_nothing_else(self):
        hass, _entry = setup(SettingsTransport())
        hass.states.async_set("weather.home", "cloudy",
                              {"friendly_name": "Back Garden", "temperature": 14,
                                "latitude": 51.5, "longitude": -0.12})
        coordinator = hass.data["parlorwave_radio"][_entry.entry_id]
        coordinator.context_status = {
            "ok": True, "published_at": "2026-09-15T10:00:00",
            "weather": {"entity": "weather.home", "state": "healthy"},
            "calendar": {"entities": [], "healthy": 0, "failed": [], "events": 0},
            "sun": {"available": True}}
        rows = {r["label"]: r for r in ws(hass)["readiness"]["context"]["rows"]}
        self.assertEqual(rows["Weather"]["badge"], "Available")
        self.assertEqual(rows["Weather"]["detail"], "Back Garden")
        # nothing else about that entity travels
        text = repr(rows)
        for private in ("cloudy", "51.5", "-0.12", "temperature"):
            self.assertNotIn(private, text, private)

    def test_daylight_needs_no_configuration_and_says_so(self):
        rows = {r["label"]: r for r in doc()["context"]["rows"]}
        self.assertEqual(rows["Daylight"]["badge"], "Unavailable")


# === the promise that nothing secret renders ==================================

class NothingSecretCanReachAScreen(unittest.TestCase):
    SECRET = "not-a-real-token-abc123"
    PATHS = "/var/lib/parlorwave/secrets.yaml"
    PRIVATE = "http://198.51.100.3:11434/api/generate"

    def _loaded(self):
        return doc(report=health([
            problem("base_dir_unwritable", "fatal", "storage",
                    f"state directory {self.PATHS} is not writable",
                    "set MUSICBRAIN_BASE_DIR to a writable directory"),
            problem("ma_auth_rejected", "error", "music_assistant",
                    f"Music Assistant rejected the API token {self.SECRET}",
                    f"check MUSIC_ASSISTANT_TOKEN against {self.PRIVATE}"),
            problem("a_code_this_build_has_never_heard_of", "warning", "somewhere",
                    f"the thing at {self.PRIVATE} failed, token={self.SECRET}, "
                    f"see {self.PATHS}",
                    f"look in {self.PATHS}")],
            home_assistant={"url": "http://supervisor/core"}))

    def test_a_known_problem_is_retold_and_the_services_own_words_are_dropped(self):
        text = repr(self._loaded())
        for banned in (self.SECRET, self.PATHS, "198.51.100.3",
                       "MUSICBRAIN_BASE_DIR", "MUSIC_ASSISTANT_TOKEN",
                       "supervisor/core"):
            self.assertNotIn(banned, text, banned)

    def test_an_unknown_problem_is_still_shown_but_scrubbed_first(self):
        """An unrecognised code the customer cannot see at all is worse
        than one described awkwardly -- but it arrives through the
        scrubber, never raw."""
        r = self._loaded()
        unknown = next(w for w in r["warnings"]
                       if w["code"] == "a_code_this_build_has_never_heard_of")
        for banned in (self.SECRET, self.PATHS, "198.51.100.3", "token="):
            self.assertNotIn(banned, repr(unknown), banned)
        self.assertTrue(unknown["title"])

    def test_the_music_assistant_endpoint_is_the_one_deliberate_exception(self):
        """A setup screen exists to answer "which Music Assistant am I
        pointed at". Every other address is withheld."""
        r = doc()
        self.assertEqual(r["music_assistant"]["endpoint"], MA_URL)
        text = repr(r)
        self.assertNotIn("172.30.33.2", text, "the service's own address")
        self.assertNotIn("supervisor/core", text, "Home Assistant's internal URL")

    def test_the_scrubber_is_blunt_on_purpose(self):
        for raw, banned in (
                ("failed at http://198.51.100.4:5005/health", "198.51.100.4"),
                ("cannot read /data/parlorwave/api_key", "/data/parlorwave"),
                ("Bearer eyJhbGciOiJIUzI1NiJ9", "eyJhbGciOiJIUzI1NiJ9"),
                ("api_key=abcdef123456", "abcdef123456"),
                ("ma.example.lan:8095 refused", "ma.example.lan")):
            self.assertNotIn(banned, readiness.scrub(raw), raw)
        self.assertEqual(readiness.scrub(None), "")
        self.assertEqual(readiness.scrub("x" * 400), "x" * 240)


class OneProblemIsStatedInOnePlace(unittest.TestCase):
    """A first-run installation that lists "no speakers are enabled" as a
    fault beside the very step asking you to choose one reads as broken
    rather than as new -- which is the opposite of what is true. A problem
    a setup step is waiting on is said ON that step, with that step's
    route, and nowhere else."""

    FIRST_RUN = dict(report=health([
        problem("ma_token_missing", "error", "music_assistant"),
        problem("no_outputs_enabled", "warning", "outputs"),
        problem("tts_unconfigured", "warning", "tts")],
        music_assistant={"reachable": False, "token_present": False, "players": 0},
        tts={"configured": False, "providers": [],
             "selected": {"provider": None, "entity_id": None, "name": None,
                          "state": None}},
        outputs={"dj_enabled": False, "enabled": [], "selected": None}))

    def test_a_brand_new_installation_has_a_checklist_and_no_fault_list(self):
        r = doc(tts_entities=(), **self.FIRST_RUN)
        self.assertEqual((r["complete"], r["total"]), (0, 4))
        self.assertEqual(r["blockers"], [], "a first run is not a fault list")
        self.assertEqual(r["warnings"], [])
        self.assertEqual([c["code"] for c in r["checklist"] if c.get("code")],
                         ["ma_token_missing", "no_outputs_enabled", "tts_unconfigured"])

    def test_every_step_carries_the_problems_own_instruction_and_route(self):
        steps = {c["key"]: c for c in doc(tts_entities=(), **self.FIRST_RUN)["checklist"]}
        # Music Assistant 2.10's own wording for its own screen, so the
        # sentence matches what is in front of the person when they get
        # there -- and it says outright that the other product's token is
        # not the one, because that is the easy mistake to make.
        detail = steps["music_assistant"]["detail"]
        self.assertIn("Access tokens", detail)
        self.assertIn("Create new token", detail)
        self.assertIn("a Home Assistant token will not work", detail)
        self.assertEqual(steps["music_assistant"]["where"], readiness.WHERE_ADDON)
        self.assertEqual(steps["outputs"]["where"], readiness.WHERE_SETTINGS)
        self.assertEqual(steps["speech"]["where"], readiness.WHERE_HA_TTS)
        self.assertEqual(steps["dj"]["where"], readiness.WHERE_ONAIR)

    def test_the_verdict_names_the_next_step_and_leaves_the_how_to_the_step(self):
        r = doc(tts_entities=(), **self.FIRST_RUN)
        self.assertEqual(r["detail"],
                         "Next, connect Music Assistant. 3 more steps after that.")

    def test_a_problem_no_step_is_waiting_on_is_still_listed(self):
        """The rule is "said once", not "hidden". A problem with no setup
        step of its own -- the speaker chosen on On Air not being one the
        DJ may use -- has nowhere else to appear, so it appears."""
        r = doc(report=health([problem("output_selection_not_enabled", "warning", "outputs"),
                               problem("advertise_url_loopback", "warning", "audio")],
                              outputs={"enabled": ["media_player.den"],
                                       "selected": "ma_web123"}))
        self.assertEqual([w["code"] for w in r["warnings"]],
                         ["output_selection_not_enabled", "advertise_url_loopback"])
        self.assertEqual(r["state"], "ready", "warnings alone do not unmake a station")


class TheSupportDisclosure(unittest.TestCase):
    def test_it_carries_identity_versions_and_reachability(self):
        d = doc()["diagnostics"]
        rows = dict(d["rows"])
        self.assertEqual(rows["Installation ID"], "f1e2d3c4b5a69788")
        self.assertEqual(rows["Running as"], "Home Assistant add-on")
        self.assertEqual(rows["Music Assistant reachable"], "Yes")
        self.assertEqual(rows["Speech providers"], "Home Assistant text-to-speech")
        self.assertEqual(rows["Writer"], "Built-in")
        # Read, not typed. This row exists so a bug report names the build
        # the reporter is running; a version written out here is a second
        # place for it to be wrong, and the release number moves.
        manifest = json.loads((ROOT / "manifest.json").read_text())
        self.assertEqual(rows["Integration version"], manifest["version"])

    def test_the_service_problem_codes_travel_so_a_report_can_name_them(self):
        d = doc(report=health([problem("ma_unreachable", "error", "music_assistant")],
                              music_assistant={"reachable": False}))["diagnostics"]
        self.assertEqual([p["code"] for p in d["problems"]], ["ma_unreachable"])
        self.assertEqual(d["problems"][0]["severity"], "blocker")


# === what the panel can possibly render =======================================

class SettingsDoesNotOwnWhatAnotherScreenOwns(unittest.TestCase):
    """The rule the whole navigation rests on. Settings answers "is it
    ready and what is connected"; every setting a person changes belongs
    to the screen they change it on. Two screens that can write the same
    value are two screens that can disagree about it."""

    def test_no_owning_screens_control_is_rebuilt_here(self):
        for control in ("_toggleRow(", "_selectRow(", "_numberRow(",
                        'id="request-input"', 'id="start-radio"',
                        "data-toggle", "data-select", "data-number",
                        "this._voice", "this._personality", "this._chattiness",
                        "this._feel", "this._sameArtist", "this._breakLength",
                        "this._cadence", "this._endless",
                        'id="news-save"', 'id="news-url"', 'id="voice-create"'):
            self.assertNotIn(control, SETTINGS, control + " was rebuilt in Settings")

    def test_settings_writes_nothing_at_all(self):
        for write in ("_svc(", "callService", "_select(", "_toggle(",
                      "news_save", "voices_select", "play_media"):
            self.assertNotIn(write, SETTINGS, write)

    def test_it_routes_to_the_owning_screen_instead(self):
        routes = PANEL[PANEL.index("const SETTINGS_ROUTES"):PANEL.index("const KIND_ICON")]
        for owner in ("onair", "booth", "newsroom", "station", "options", "ha_tts", "addon"):
            self.assertIn(f"{owner}:", routes, owner)
        self.assertIn('data-goto=', SETTINGS)
        self.assertIn('this._view = b.dataset.goto', PANEL)

    def test_every_route_the_model_can_emit_has_somewhere_to_go(self):
        routes = PANEL[PANEL.index("const SETTINGS_ROUTES"):PANEL.index("const KIND_ICON")]
        for name in [v for k, v in vars(readiness).items() if k.startswith("WHERE_")]:
            self.assertIn(f"{name}:", routes, name)

    def test_the_add_ons_configuration_is_an_instruction_not_a_broken_link(self):
        """Home Assistant gives an add-on's configuration page no address
        this panel can rely on, so it is written out rather than linked to
        somewhere that may not exist."""
        routes = PANEL[PANEL.index("const SETTINGS_ROUTES"):PANEL.index("const KIND_ICON")]
        addon = routes[routes.index("addon:"):routes.index("onair:")]
        self.assertNotIn("href", addon)


class NoSecondDiagnosisLivesInTheBrowser(unittest.TestCase):
    def test_the_panel_holds_no_problem_code_and_no_service_setting(self):
        low = PANEL.lower()
        for banned in ("ma_unreachable", "ma_token_missing", "tts_unconfigured",
                       "no_outputs_enabled", "observer_not_running",
                       "optional_writer_unavailable", "music_assistant_url",
                       "musicbrain_", "supervisor_token", "ollama",
                       # a credential's own vocabulary never reaches the
                       # panel: the integration renames it on both paths
                       "api_key", "x-api-key"):
            self.assertNotIn(banned, low, banned)

    def test_settings_names_no_speech_or_inference_implementation(self):
        """`lib.kokoro` is a shelf key the Booth reads and has its own
        rules about. Settings never touches either: the speech service
        BEHIND A VOICE, and the server behind a writing model, are
        implementation and have no name on this screen.

        ONE NARROWING, and it is deliberate. The optional-services card
        asks a person to point the station at a speech service they have
        to go and obtain, and "a compatible speech service" is not enough
        to shop for -- so that card, and only that card, may name the
        compatibility it speaks. It still names no implementation behind
        a working voice, no model, no server and no address.
        """
        low = SETTINGS.lower()
        card = low[low.index("_renderoptionalservices()"):
                   low.index("/* capabilities some installations have")]
        rest = low.replace(card, "")
        for banned in ("kokoro", "chatterbox", "piper", "ollama", "llm",
                       "gguf", "supervisor"):
            self.assertNotIn(banned, rest, banned)
        # and the card itself names ONLY the compatibility, never a
        # product to run, a model, or a host
        for banned in ("kokoro", "piper", "ollama", "gguf", "supervisor",
                       "11434", "openai"):
            self.assertNotIn(banned, card, banned)
        # "writing model" is the customer's phrase for the optional
        # enhancement and is allowed; a model's NAME is not.
        self.assertNotIn("model:", low)

    def test_the_sentences_come_from_the_integration_not_from_here(self):
        """The panel renders r.headline / c.detail / i.title. If it ever
        composes one of those itself there are two vocabularies again."""
        for rendered in ("this._esc(r.headline)", "this._esc(r.detail)",
                         "this._esc(c.detail)", "this._esc(i.title)",
                         "this._esc(row.detail"):
            self.assertIn(rendered, SETTINGS, rendered)

    def test_a_failed_read_shows_a_settled_sentence_not_the_services_words(self):
        fetch = PANEL[PANEL.index("async _fetchReadiness()"):
                      PANEL.index("  async _fetchNews()")]
        self.assertIn("error: true", fetch)
        self.assertNotIn("e.message", fetch)


class SettingsLooksLikeTheRestOfTheProduct(unittest.TestCase):
    def test_it_uses_the_established_room_not_a_new_palette(self):
        self.assertIn("booth-hero", SETTINGS)
        self.assertIn("stage-glow", SETTINGS)
        for rule in (".settings-desk", ".ready-meter", ".ck-row", ".set-badge",
                     ".cap-row", ".spk-row"):
            self.assertIn(rule, STYLE, rule)

    def test_every_settings_colour_is_a_house_or_album_token(self):
        literals = re.findall(r"#[0-9a-fA-F]{3,8}", SETTINGS_CSS)
        self.assertTrue(set(literals) <= {"#7cc47f", "#ffc94d", "#ffa726", "#1a1206"},
                        literals)
        self.assertIn("var(--pw-accent)", SETTINGS_CSS)

    def test_the_three_intended_widths_are_designed_for(self):
        self.assertIn("max-width:1120px", STYLE.replace(" ", ""), "1440")
        tablet = STYLE[STYLE.index("max-width: 900px"):STYLE.index("max-width: 560px")]
        self.assertIn(".settings-desk", tablet, "768")
        phone = STYLE[STYLE.index("max-width: 560px"):]
        for rule in (".settings-desk", ".ready-meter", ".ck-row", ".cap-row"):
            self.assertIn(rule, phone, rule + " at 390")

    def test_the_first_run_state_keeps_its_weight_on_a_phone(self):
        """Four undone steps is the state a new owner actually sees. The
        route out of each one has to fit on one hand -- under the row it
        belongs to, never squeezed into a two-word column beside it."""
        phone = STYLE[STYLE.index("max-width: 560px"):]
        block = phone[phone.index(".ck-row"):]
        self.assertIn("grid-column:1 / -1", block)
        self.assertIn("white-space:normal", block)

    def test_an_undone_step_is_an_empty_ring_and_never_a_cross(self):
        """It has not been done yet. That is not the same as having gone
        wrong, and a first-run screen full of red crosses says the
        opposite of what is true."""
        mark = STYLE[STYLE.index(".ck-mark"):STYLE.index(".ck-body")]
        self.assertIn("background:transparent", mark)
        self.assertNotIn("#ff", mark.lower())
        self.assertIn('${c.done ? "\\u2713" : ""}'.replace("\\u2713", "✓"), SETTINGS)


class TheScreenIsBuiltInTheIntendedOrder(unittest.TestCase):
    def test_the_verdict_comes_first_and_the_telemetry_last(self):
        # The verdict, the steps and what is wrong first; then the
        # everyday cards; then Extras (every optional section, in its old
        # order); the support drawer last, holding the Music Assistant and
        # Speech details ahead of the engineering table.
        body = SETTINGS[SETTINGS.index("  _renderSettings() {"):
                        SETTINGS.index("  _renderStationIdentityCard() {")]
        # The everyday card is "What the DJ may use": the speakers, the
        # weather entity and the calendars, chosen in place. The weather and
        # the calendars left Extras for it: they are not extras.
        order = [body.index(f"this.{fn}(") for fn in
                 ("_renderReadyHero", "_renderSetupChecklist", "_renderIssues",
                  "_renderSources", "_renderFaceplateSetting", "_renderExtras",
                  "_renderDiagnostics")]
        self.assertEqual(order, sorted(order))
        sources = SETTINGS[SETTINGS.index("  _renderSources(r) {"):
                           SETTINGS.index("  _srcTag(row, pending) {")]
        inside = [sources.index(f"this.{fn}(") for fn in
                  ("_renderSpeakerPicker", "_renderWeatherPicker", "_renderCalendarPicker")]
        self.assertEqual(inside, sorted(inside))
        extras = SETTINGS[SETTINGS.index("  _renderExtras(r) {"):
                          SETTINGS.index("  _renderOptionalServices() {")]
        inner = [extras.index(f"this.{fn}(") for fn in
                 ("_renderOptionalServices", "_renderWriter", "_renderOptional")]
        self.assertEqual(inner, sorted(inner))
        self.assertNotIn("_renderContext", SETTINGS, "the Context card is the Sources card now")
        drawer = DIAG[DIAG.index("this._readyAdvanced ? `"):]
        telemetry = [drawer.index(x) for x in
                     ("this._renderMusicAssistant(", "this._renderSpeech(",
                      "<h2>Health &amp; diagnostics</h2>")]
        self.assertEqual(telemetry, sorted(telemetry))

    def test_the_support_details_are_closed_until_asked_for(self):
        self.assertIn("this._readyAdvanced ? `", DIAG)
        self.assertIn("this._readyAdvanced = false", PANEL)

    def test_nothing_is_rendered_before_the_installation_has_answered(self):
        waiting = SETTINGS[SETTINGS.index("_renderSettingsWaiting() {"):
                           SETTINGS.index("_renderReadyHero(r) {")]
        self.assertIn("Reading this installation", waiting)
        for verdict in ("Ready.", "Not quite ready.", "Needs attention."):
            self.assertNotIn(verdict, waiting, verdict)


class TheSpeakerPickerIsOnThisScreen(unittest.TestCase):
    """The panel half of moving the allow-list in. What the COMMANDS do is
    ha/tests/test_panel_speakers.py; this is what the screen may draw."""

    PANEL = (Path(__file__).resolve().parent.parent / "custom_components"
             / "parlorwave_radio" / "panel" / "parlorwave-radio-panel.js").read_text()
    PICKER = PANEL[PANEL.index("  _renderSpeakerPicker("):
                   PANEL.index("  /* CAPABILITY, not plumbing.")]

    def test_the_card_asks_the_question_instead_of_naming_the_setting(self):
        self.assertIn('<div class="label">Speakers ParlorWave may DJ on</div>', self.PANEL)
        # and it no longer sends anybody to Devices & services for it
        self.assertNotIn("Devices &amp; services", self.PANEL)
        self.assertNotIn("Devices & services", self.PANEL)

    def test_an_unreadable_inventory_draws_no_checkboxes(self):
        """Zero checkboxes and "Music Assistant did not answer" look the
        same once drawn, and saving the first would wipe a working list."""
        self.assertIn("if (!s.data || s.data.ok === false)", self.PICKER)
        self.assertIn("cannot be changed from here", self.PICKER)
        self.assertIn("Nothing has been altered.", self.PICKER)

    def test_nothing_is_written_until_save_is_pressed(self):
        self.assertIn('id="spk-save"', self.PICKER)
        self.assertIn("dirty ?", self.PICKER)
        save = self.PANEL[self.PANEL.index("  async _saveSpeakers() {"):]
        self.assertIn('this._ws("parlorwave_radio/outputs_set"', save)

    def test_a_poll_cannot_untick_a_box_mid_edit(self):
        """Settings re-reads itself every thirty seconds. A refresh landing
        between two clicks must not put the stored list back."""
        self.assertIn('if (this._view === "settings" && !this._speakersDirty)',
                      self.PANEL)

    def test_an_empty_selection_is_allowed_and_says_what_it_means(self):
        self.assertIn("the DJ has nowhere to speak", self.PICKER)

    def test_the_two_concepts_are_named_apart_everywhere(self):
        """The allow-list and the active speaker were both called
        "Output" -- on the device page, that ambiguity is what made a
        person think they had finished setting up."""
        self.assertIn("Active DJ speaker", self.PANEL)
        select = (Path(__file__).resolve().parent.parent / "custom_components"
                  / "parlorwave_radio" / "select.py").read_text()
        self.assertIn('_attr_name = "Active DJ speaker"', select)
        self.assertNotIn('_attr_name = "Output"', select)



class TestCalendarOnSettings(unittest.TestCase):
    """PINNED AT THE SOURCE: Test Calendar lives on the calendars row of the
    What-the-DJ-may-use card (it was the Context card inside Extras), and
    the result it renders can say every distinct thing the command can
    report. A browser is not available here, so what the panel could
    possibly render is checked against the file that would contain it."""

    def test_the_button_and_its_handler_exist(self):
        self.assertIn('id="cal-test"', PANEL)
        self.assertIn('on("cal-test", () => this._testCalendar());', PANEL)
        self.assertIn('this._ws("parlorwave_radio/calendar_test")', PANEL)

    def test_the_result_renders_every_state_the_command_returns(self):
        block = PANEL[PANEL.index("_renderCalTest()"):]
        block = block[:block.index("async _fetchLyrics")]
        for state in ("no_calendar_selected", "calendar_unavailable",
                      "publish_failed", "backend_has_no_context"):
            self.assertIn(state, block, f"Test Calendar cannot show {state}")
        # the useful answers, not only the failures
        self.assertIn("No upcoming events", block)
        self.assertIn("would say", block)

    def test_an_all_day_event_is_never_given_an_invented_clock_time(self):
        """The backend's fact text says '(all day, no set time)' for exactly
        this reason; the screen must not undo it by printing a time."""
        block = PANEL[PANEL.index("_calWhen(ev)"):]
        block = block[:block.index("_renderCalTest()")]
        allday = block[block.index("if (ev.all_day)"):block.index("const when =")]
        self.assertIn("all day", allday)
        self.assertNotIn("toLocaleTimeString", allday)

    def test_the_weather_has_the_same_bounded_test_the_calendar_has(self):
        """The other half of the context a break is given. Same shape,
        same card, same read-only promise -- republish what Home Assistant
        reports, then say what the station now holds."""
        self.assertIn('this._ws("parlorwave_radio/weather_test")', PANEL)
        self.assertIn('id="weather-test"', PANEL)
        block = PANEL[PANEL.index("_renderWeatherTest()"):]
        block = block[:block.index("  async _fetchLyrics()")]
        for state in ("no_weather_selected", "weather_unavailable",
                      "publish_failed", "backend_has_no_context"):
            self.assertIn(state, block, state)
        self.assertIn("Nothing was changed, and the music was not", block)

    def test_a_reading_too_old_to_state_is_its_own_answer(self):
        """The case this test exists for: a station that HAS weather but
        cannot use it looks healthy from every other surface. Everything
        upstream is fine and the DJ still says nothing."""
        block = PANEL[PANEL.index("_renderWeatherTest()"):]
        block = block[:block.index("  async _fetchLyrics()")]
        self.assertIn('b.reason === "stale"', block)
        self.assertIn("too old to use", block)
        self.assertIn("recovers by itself", block)
        self.assertIn('b.reason === "no_weather_in_snapshot"', block)

    def test_the_test_shows_what_is_held_and_never_a_raw_payload(self):
        """'What Parlorwave is actually receiving' means the facts, not
        the document: when the snapshot arrived, what the station thinks
        the local time is, the conditions, and the sentence a break would
        carry. No entity id, no path, no JSON."""
        block = PANEL[PANEL.index("  _contextHeld(b) {"):]
        block = block[:block.index("  _renderCalTest() {")]
        self.assertIn("captured_at", block)
        self.assertIn("station_time", block)
        for banned in ("JSON.stringify", "entity_id", "api_key", "token"):
            self.assertNotIn(banned, block, banned)

    def test_the_calendar_test_tells_no_events_from_no_calendar(self):
        """The distinction the whole screen exists for, said in words: a
        calendar that reads and holds nothing in the window is a SUCCESS,
        and reads as one."""
        block = PANEL[PANEL.index("  _renderCalTest() {"):
                      PANEL.index("  /* THE WEATHER RESULT.")]
        good = block[block.index("if (!events.length)"):]
        self.assertIn('news-test good', good)
        self.assertIn("No upcoming events in the window", good)
        self.assertIn("would not mention the calendar", good)
        # and an event carries the reason it would or would not be used
        self.assertIn("_calReasonWords(ev.reason)", block)

    def test_every_event_reason_is_words_and_never_a_code(self):
        block = PANEL[PANEL.index("  _calReasonWords(reason) {"):
                      PANEL.index("  /* WHAT THE STATION IS HOLDING")]
        for code in ("eligible_headsup", "already_announced", "already_started",
                     "beyond_allday_lead", "outside_window"):
            self.assertIn(code, block, code)
        self.assertIn("can be mentioned", block)
        self.assertIn("too far ahead to mention yet", block)
        # an unrecognised code shows NO flag rather than printing itself
        self.assertIn("|| null;", block)

    def test_it_says_when_the_dj_is_not_allowed_to_use_the_calendar(self):
        """A calendar that reads perfectly and a DJ forbidden to mention it
        are different answers, and the screen gives the second one."""
        block = PANEL[PANEL.index("_renderCalTest()"):]
        block = block[:block.index("async _fetchLyrics")]
        self.assertIn("enabled_in_settings", block)
        self.assertIn("not currently allowed to mention the calendar", block)

    def test_the_screen_promises_only_what_is_actually_sent(self):
        block = PANEL[PANEL.index("_renderCalTest()"):]
        block = block[:block.index("async _fetchLyrics")]
        self.assertIn("Only the title and time of an event", block)
        for banned in ("description", "location", "attendee"):
            self.assertNotIn(banned, block.lower())


class OptionalServicesAreConfiguredHere(unittest.TestCase):
    """Sections 6 and 7: a Chatterbox-compatible voice engine and an
    external writing model become configuration instead of environment
    variables. They are two capabilities, not one, and neither is
    required."""

    CARD = PANEL[PANEL.index("  _renderOptionalServices() {"):
                 PANEL.index("  /* CAPABILITIES SOME INSTALLATIONS HAVE.")]

    def test_they_are_two_independent_cards(self):
        self.assertIn("_renderVoiceEngine(", self.CARD)
        self.assertIn("_renderWriterService(", self.CARD)
        self.assertIn("svc-ve-enabled", self.CARD)
        self.assertIn("svc-wr-enabled", self.CARD)

    def test_each_says_what_happens_without_it(self):
        """Absent is the NORMAL state and must never read as a fault."""
        self.assertIn("complete without both of these", self.CARD)
        self.assertIn("not a fallback", self.CARD)
        self.assertIn("never skipped waiting for it", self.CARD)

    def test_each_can_be_tested_separately(self):
        self.assertIn('data-svctest="${this._esc(kind)}"', self.CARD)
        self.assertIn('this._testService(b.dataset.svctest)', PANEL)

    def test_every_refusal_the_backend_can_return_has_a_sentence(self):
        for reason in ("not_configured", "disabled", "unreachable",
                       "timed_out", "refused_credential", "bad_response",
                       "http_error"):
            self.assertIn(reason, self.CARD, reason)

    def test_a_failed_test_says_the_station_is_unaffected(self):
        self.assertIn("The station is unaffected", self.CARD)

    def test_the_provider_list_comes_from_the_backend(self):
        """Naming a protocol here would bake an inference host into the
        integration, which is a standing invariant."""
        self.assertIn("_writerProviders()", self.CARD)
        block = PANEL[PANEL.index("  _writerProviders() {"):]
        block = block[:block.index("\n  }")]
        self.assertIn("writer_providers", block)


class AKeyIsNeverInTheBrowser(unittest.TestCase):
    CARD = PANEL[PANEL.index("  _renderOptionalServices() {"):
                 PANEL.index("  /* CAPABILITIES SOME INSTALLATIONS HAVE.")]

    def test_the_field_says_whether_a_key_is_saved_never_shows_one(self):
        block = PANEL[PANEL.index("  _svcKeyField(id, x) {"):
                      PANEL.index("  _renderSvcTest(kind) {")]
        self.assertIn("Configured", block)
        self.assertIn("never shown again", block)
        # a row of dots standing in for a value this browser does not have
        # would be a lie about what it holds
        self.assertNotIn("••", block)
        self.assertNotIn("*****", block)

    def test_the_box_is_a_password_field_that_autofill_will_not_touch(self):
        block = PANEL[PANEL.index("  _svcKeyField(id, x) {"):
                      PANEL.index("  _renderSvcTest(kind) {")]
        self.assertIn('type="password"', block)
        self.assertIn('autocomplete="new-password"', block)

    def test_null_means_leave_it_and_empty_means_clear_it(self):
        block = PANEL[PANEL.index("  _svcPatch() {"):
                      PANEL.index("  async _saveServices() {")]
        self.assertIn("LEAVE THE STORED KEY", block)
        self.assertIn("key: x.key", block)
        clear = PANEL[PANEL.index('data-svcclear]'):]
        self.assertIn('"key", "");', clear[:800])

    def test_the_draft_is_dropped_once_it_has_been_sent(self):
        block = PANEL[PANEL.index("  async _saveServices() {"):
                      PANEL.index("  async _testService(kind) {")]
        self.assertIn("this._svcDraft = null;", block)

    def test_the_panel_never_learns_the_stores_own_word_for_a_key(self):
        self.assertNotIn("api_key", PANEL)
        self.assertIn("key_saved", PANEL)


class TheStationIdentityCard(unittest.TestCase):
    """The on-air station name control and its websocket contract.

    The card RENDERS on the Station screen (both modes -- see
    test_panel_station.py); Settings no longer draws it. The control ids,
    validation, max length and save path are unchanged by the move."""

    def test_settings_does_not_render_the_identity_card(self):
        block = PANEL[PANEL.index("  _renderSettings() {"):
                      PANEL.index("  _renderStationIdentityCard() {")]
        self.assertNotIn("_renderStationIdentityCard", block,
                         "the duplicate Settings copy is back")

    def test_station_identity_card_markup(self):
        block = PANEL[PANEL.index("  _renderStationIdentityCard() {"):
                      PANEL.index("  _renderFaceplateSetting() {")]
        self.assertIn('id="station-name-input"', block)
        self.assertIn('maxlength="60"', block)
        self.assertIn('placeholder="ParlorWave Radio"', block)
        self.assertIn('id="station-name-save"', block)
        self.assertIn('id="station-name-reset"', block)

    def test_station_settings_and_save_websocket_commands(self):
        class StationTransport(SettingsTransport):
            def __init__(self, **kw):
                super().__init__(**kw)
                self.saved_patch = None

            async def request(self, method, url, json=None, headers=None, timeout=None):
                if "/settings/station" in url:
                    if method == "GET":
                        return FakeResponse(200, {
                            "ok": True,
                            "settings": {
                                "identity": {"name": "ParlorWave Radio"},
                                "feel": "balanced",
                            }
                        })
                    if method == "PUT":
                        self.saved_patch = json
                        return FakeResponse(200, {
                            "ok": True,
                            "settings": {
                                "identity": json.get("identity", {}),
                                "feel": "balanced",
                            }
                        })
                return await super().request(method, url, json=json, headers=headers, timeout=timeout)

        transport = StationTransport()
        hass, _entry = setup(transport)

        # Test station_settings read
        res = ws(hass, "station_settings")
        self.assertIn("settings", res)
        self.assertEqual(res["settings"]["identity"]["name"], "ParlorWave Radio")

        # Test station_save
        res = ws(hass, "station_save", msg={"station": {"identity": {"name": "QPRW FM"}}})
        self.assertIn("settings", res)
        self.assertEqual(res["settings"]["identity"]["name"], "QPRW FM")
        self.assertEqual(transport.saved_patch, {"identity": {"name": "QPRW FM"}})


if __name__ == "__main__":
    unittest.main(verbosity=2)
