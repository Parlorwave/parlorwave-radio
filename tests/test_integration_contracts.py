"""Structural pins for the integration -- runnable without Home Assistant.

Modules that import homeassistant cannot execute here, but their syntax,
manifests, service registry, and the product contracts encoded in their
SOURCE can still be held to account. The heavyweight pin is the output
selector: nothing in select.py or the client may reach a transport-capable
endpoint when an output is chosen."""

import ast
import json
import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "custom_components" / "parlorwave_radio"


class Manifest(unittest.TestCase):
    def setUp(self):
        self.m = json.loads((ROOT / "manifest.json").read_text())

    def test_required_fields(self):
        for key in ("domain", "name", "version", "config_flow", "iot_class",
                    "documentation"):
            self.assertIn(key, self.m)
        self.assertEqual("parlorwave_radio", self.m["domain"])
        self.assertTrue(self.m["config_flow"])

    def test_local_only_no_cloud(self):
        self.assertEqual("local_polling", self.m["iot_class"])
        self.assertEqual([], self.m["requirements"],
                         "keep the integration dependency-free")


class Sources(unittest.TestCase):
    def test_every_module_parses(self):
        for py in sorted(ROOT.glob("*.py")):
            ast.parse(py.read_text(), filename=str(py))

    def test_translations_match_strings(self):
        self.assertEqual(json.loads((ROOT / "strings.json").read_text()),
                         json.loads((ROOT / "translations/en.json").read_text()))

    def test_every_flow_outcome_has_words(self):
        """Every abort reason and form error the config flow can return is
        a sentence in strings.json -- an outcome without one reaches the
        customer as a bare code."""
        source = (ROOT / "config_flow.py").read_text()
        cut = source.index("class ParlorwaveRadioOptionsFlow")
        flow, options_flow = source[:cut], source[cut:]
        doc = json.loads((ROOT / "strings.json").read_text())
        strings = doc["config"]
        options_errors = set(re.findall(r'errors\["base"\] = "([a-z_]+)"', options_flow))
        self.assertLessEqual(options_errors, set(doc["options"]["error"]))
        aborts = set(re.findall(r'async_abort\(reason="([a-z_]+)"\)', flow))
        aborts |= set(re.findall(r'_FINAL = \(([^)]*)\)', flow)[0].replace('"', "")
                      .replace(" ", "").split(",")) - {""}
        errors = set(re.findall(r'errors\["base"\] = "([a-z_]+)"', flow))
        errors |= {"cannot_connect", "unknown"}       # _check_discovered's
        self.assertTrue(aborts and errors)
        self.assertLessEqual(aborts, set(strings["abort"]), aborts - set(strings["abort"]))
        self.assertLessEqual(errors, set(strings["error"]), errors - set(strings["error"]))
        for step in ("user", "hassio_confirm", "reauth_confirm"):
            self.assertIn(step, strings["step"])

    def test_the_manual_form_never_says_the_key_is_in_a_log(self):
        """The key is never printed (only the file it is stored in is
        named), so a form that sends people to the log for it is a dead
        end -- the one fallback when discovery has not worked."""
        words = json.dumps(json.loads((ROOT / "strings.json").read_text())
                           ["config"]["step"]["user"]).lower()
        self.assertNotRegex(words, r"shown in .*log")
        self.assertIn("never printed", words)

    def test_the_reauthentication_form_covers_a_reinstalled_addon(self):
        """A reinstalled add-on has a new identity AND a new key, so its old
        entry lands on this form, and restarting the add-on cannot help: the
        announcement is of the NEW installation. The form has to name that
        case and its way out, as well as the restart that does help when only
        the key changed."""
        for name in ("strings.json", "translations/en.json"):
            words = json.loads((ROOT / name).read_text())["config"]["step"][
                "reauth_confirm"]["description"].lower()
            with self.subTest(file=name):
                self.assertIn("reinstalled", words)
                self.assertIn("delete this entry", words)
                self.assertIn("newly discovered", words)
                self.assertIn("restart the add-on", words)

    def test_services_yaml_declares_all_registered_services(self):
        services = (ROOT / "services.yaml").read_text()
        const = (ROOT / "const.py").read_text()
        init = (ROOT / "__init__.py").read_text()
        names = re.findall(r'^SERVICE_[A-Z_]+ = "([a-z_]+)"', const, re.M)
        self.assertEqual(len(names), 9)
        self.assertEqual(set(names), set(re.findall(r"(?m)^([a-z_]+):", services)))
        # every registration uses a SERVICE_* constant and unload uses SERVICES
        self.assertNotRegex(init, r'async_register\(\s*DOMAIN, "')
        self.assertIn("for service in SERVICES:", init)


class TheWritingModelStaysOptional(unittest.TestCase):
    def test_no_inference_host_baked_in(self):
        # The integration consumes the service's contract; where the words
        # come from is a backend concern. No host, model, or provider name
        # may appear anywhere in the integration or panel.
        for path in list(ROOT.rglob("*.py")) + list(ROOT.rglob("*.js")):
            src = path.read_text().lower()
            for banned in ("ollama", "openai", "anthropic",
                           "llama", "11434"):
                self.assertNotIn(banned, src, f"{path.name} mentions {banned}")


class OutputSelectorNeverMovesPlayback(unittest.TestCase):
    """A product invariant, pinned at the source level."""

    TRANSPORT_TOKENS = ("play_media", "media_stop", "media_play",
                        "/station/from-current", "/station/replenish",
                        "play_pause", "volume", "enqueue", "clear_playlist")

    def test_select_module_touches_no_transport(self):
        src = (ROOT / "select.py").read_text()
        for token in self.TRANSPORT_TOKENS:
            self.assertNotIn(token, src,
                             f"select.py must not reference {token}")

    def test_client_output_write_is_single_settings_put(self):
        # AST-level: set_default_output's body contains exactly one _call,
        # and it is PUT /settings/dj.
        tree = ast.parse((ROOT / "api.py").read_text())
        fn = next(n for n in ast.walk(tree)
                  if isinstance(n, ast.AsyncFunctionDef)
                  and n.name == "set_default_output")
        calls = [n for n in ast.walk(fn) if isinstance(n, ast.Call)
                 and isinstance(n.func, ast.Attribute)
                 and n.func.attr == "_call"]
        self.assertEqual(1, len(calls))
        args = [a.value for a in calls[0].args
                if isinstance(a, ast.Constant)]
        self.assertEqual(["PUT", "/settings/dj"], args)


class SelectingTheSpeakerStartsNothing(unittest.TestCase):
    """A refusal about a speaker GROUP must never appear after switching
    outputs. The speaker selection must be, and is, one settings
    write: whatever the destination is doing (idle, playing, paused, a group,
    unavailable, already selected) it never starts, resumes or stops a
    station and never reaches a player. The group refusals live only in the
    station-start path (station_live), reached only by station_live_start."""

    def test_output_select_calls_only_the_settings_write_and_a_refresh(self):
        tree = ast.parse((ROOT / "select.py").read_text())
        cls = next(n for n in ast.walk(tree)
                   if isinstance(n, ast.ClassDef) and n.name == "OutputSelect")
        fn = next(n for n in cls.body
                  if isinstance(n, ast.AsyncFunctionDef) and n.name == "async_select_option")
        awaited = sorted({n.value.func.attr for n in ast.walk(fn)
                          if isinstance(n, ast.Await) and isinstance(n.value, ast.Call)
                          and isinstance(n.value.func, ast.Attribute)})
        self.assertEqual(awaited, ["async_request_refresh", "set_default_output"])
        src = ast.get_source_segment((ROOT / "select.py").read_text(), fn)
        for banned in ("station_live", "start_radio", "media_player", "play_media", "call_service"):
            self.assertNotIn(banned, src, banned)

    def test_station_starts_have_one_door_and_it_is_not_the_select(self):
        api = (ROOT / "api.py").read_text()
        self.assertEqual(api.count('"/station/live/start"'), 1)
        init = (ROOT / "__init__.py").read_text()
        self.assertIn('"parlorwave_radio/station_live_start"', init)
        self.assertNotIn("station_live_start", (ROOT / "select.py").read_text())


class StudioIsSettingsOnly(unittest.TestCase):
    """Product invariants, at the source level: configuration must never
    become transport. Every Studio write in the client is exactly one PUT to
    a settings section; the selects module is covered by the transport-token
    ban above (it now hosts the Studio selects too)."""

    STUDIO_WRITES = {"set_personality": "/settings/dj",
                     "set_chattiness": "/settings/dj",
                     "set_voice": "/settings/dj",
                     "set_break_content": "/settings/dj",
                     "set_station_feel": "/settings/station"}

    def test_every_studio_write_is_a_single_settings_put(self):
        tree = ast.parse((ROOT / "api.py").read_text())
        for name, path in self.STUDIO_WRITES.items():
            fn = next(n for n in ast.walk(tree)
                      if isinstance(n, ast.AsyncFunctionDef) and n.name == name)
            calls = [n for n in ast.walk(fn) if isinstance(n, ast.Call)
                     and isinstance(n.func, ast.Attribute)
                     and n.func.attr == "_call"]
            self.assertEqual(1, len(calls), name)
            args = [a.value for a in calls[0].args if isinstance(a, ast.Constant)]
            self.assertEqual(["PUT", path], args, name)

    def test_selects_are_catalog_driven_not_hard_coded(self):
        # Friendly names come from GET /studio/catalog; the integration
        # never bakes in a personality id or a voice asset name, and it
        # maps the chosen NAME back to the id before writing.
        src = (ROOT / "select.py").read_text()
        for banned in ("dry_wit", "dry_jarvis", "classic_fm", "late_night",
                       "familiar", "discovery"):
            self.assertNotIn(banned, src, f"select.py hard-codes {banned}")
        self.assertIn('i["name"] == option', src)
        self.assertIn("self._write(item.get(\"id\"))", src)
        self.assertIn("studio_catalog", src)

    def test_content_switches_are_settings_writes(self):
        src = (ROOT / "switch.py").read_text()
        self.assertIn("set_break_content", src)
        for token in OutputSelectorNeverMovesPlayback.TRANSPORT_TOKENS:
            self.assertNotIn(token, src)

    def test_coordinator_degrades_studio_surfaces_without_failing(self):
        src = (ROOT / "coordinator.py").read_text()
        self.assertIn("STUDIO_CATALOG_TTL_S", src)
        self.assertIn('"station_settings"', src)
        # a failed catalog refresh carries the last good copy forward
        self.assertIn("return self._catalog", src)
        # the two Studio reads sit AFTER the primary reads' UpdateFailed
        # block, so neither can mark the integration unavailable
        self.assertLess(src.index("raise UpdateFailed"),
                        src.index("station_settings()"))


class StudioPanel(unittest.TestCase):
    def setUp(self):
        self.js = (ROOT / "panel" / "parlorwave-radio-panel.js").read_text()
        start = self.js.index("_renderBooth()")
        self.studio = self.js[start:self.js.index("\n  _personaName", start)]

    def test_the_product_sections(self):
        """On Air / Booth / Newsroom / Station / Settings -- the whole
        product map, every one of them with a screen behind it."""
        self.assertIn(
            'const VIEWS = ["onair", "booth", "newsroom", "station", "settings"];',
            self.js)

    def test_booth_answers_its_three_questions_in_order(self):
        """Who is on the mic, what do they sound like, and how do their
        breaks go. All three are about the DJ, which is what the Booth is
        for. What the station PLAYS between the breaks is a different
        question and it has its own screen."""
        for heading in (">On the mic<", "<h2>Voice</h2>", "<h2>Break style</h2>"):
            self.assertIn(heading, self.studio, heading)
        order = [self.studio.index(h) for h in
                 (">On the mic<", "<h2>Voice</h2>", "<h2>Break style</h2>")]
        self.assertEqual(order, sorted(order), "the Booth cards are out of order")

    def test_no_control_was_lost_in_the_rearranging(self):
        for control in ("this._personality", "this._voice",
                        "this._cadence", "this._breakLength",
                        "this._weather", "this._calendar"):
            self.assertIn(control, self.studio, control)
        # "The DJ may mention a headline" is not drawn.
        # No headline source ships, so the switch could never do anything,
        # and the one card that said so was removed in alpha.4.
        self.assertNotIn("this._news", self.studio)
        self.assertNotIn("mention a headline", self.studio)

    def test_the_booth_offers_no_chattiness_control(self):
        """Persona and airtime are decoupled. Choosing a
        personality is choosing a VOICE; nothing on this screen -- and
        nothing anywhere in the panel -- lets a person set Low/Normal/High,
        because the DJ now talks the same amount whatever is chosen."""
        self.assertNotIn("chattiness", self.js.lower())
        self.assertNotIn("Chattiness", self.js)

    def test_the_personality_hint_does_not_promise_a_cadence_change(self):
        """The copy used to say chattiness 'never makes breaks longer or
        more frequent than the cadence allows', which told a customer that
        the control on that card was about how often the DJ speaks."""
        hint = self.studio[self.studio.index(">On the mic<"):]
        hint = hint[:hint.index("_renderVoiceCard")]
        # one short line, and still no cadence promise
        self.assertIn("not how often or how long they talk", hint)
        self.assertNotIn("cadence and break length", hint)

    def test_the_programming_controls_live_on_station_and_only_there(self):
        """Station feel and artist rotation shape what the station PICKS,
        which only an installation with a local catalog can do at all.
        They belong beside that capability, not in the Booth -- and in one
        place only, so two screens can never disagree about a setting."""
        station = self.js[self.js.index("  _renderStation() {"):
                          self.js.index("  _renderDiagnostics() {")]
        for control in ("this._feel", "this._sameArtist", "this._sameArtistFreq",
                        "this._endless"):
            self.assertNotIn(control, self.studio, control + " is still in the Booth")
            self.assertIn(control, station, control + " never reached Station")
        self.assertNotIn("<h2>Station feel</h2>", self.studio)

    def test_booth_is_not_a_settings_table(self):
        """The personality has a name and a sentence at the top of the
        screen, and the voice on the air is a tile -- neither is a row in
        a grid of labels."""
        self.assertIn("booth-name", self.studio)
        self.assertIn("booth-desc", self.studio)
        self.assertIn('class="vnow"', self.studio)

    def test_studio_has_no_transport_or_action_controls(self):
        # No parlorwave_radio.* action services, no Start Radio, no thumbs, no
        # request box: Studio is configuration only.
        for banned in ("parlorwave_radio", "start-radio", "start_radio", "thumb",
                       "request-input", "callService", "play_media"):
            self.assertNotIn(banned, self.studio)

    def test_studio_states_its_apply_semantics(self):
        self.assertIn("next break the DJ writes", self.studio)

    def test_station_states_its_apply_semantics(self):
        """The sentence that used to sit under the Booth's programming
        card travels with the controls it describes."""
        station = self.js[self.js.index("  _renderStation() {"):
                          self.js.index("  _renderDiagnostics() {")]
        self.assertIn("next\n        batch of tracks the station picks", station)
        self.assertIn("nothing already queued or playing", station)

    def test_booth_shows_loading_and_unavailable_states(self):
        self.assertIn("Booth controls have not loaded yet", self.studio)
        self.assertIn("Unavailable right now", self.js)
        # The screen has been called Booth for two milestones; only this
        # card still said Studio, which is a screen the product does not
        # have. It is also the card a customer sees when something is
        # already wrong.
        self.assertNotIn("Studio", self.js)

    def test_entities_are_found_by_identity_not_by_name(self):
        """Home Assistant composes `friendly_name` from the DEVICE's name,
        which a person may change in one click. Matching on it meant every
        control on every screen vanished when they did. `unique_id` --
        minted by entity.py as f"{entry_id}_{key}" -- cannot be renamed,
        and the registry is asked for the mapping."""
        block = self.js[self.js.index("  _ent(key) {"):]
        block = block[:block.index("\n  }")]
        self.assertIn("this._entityMap && this._entityMap[key]", block)
        self.assertNotIn("friendly_name", block)
        # nothing may match a name to find an entity any more
        self.assertNotIn("_find(domain", self.js)
        self.assertNotIn('startsWith("parlorwave radio")', self.js)
        # the map is the registry's, fetched over the product namespace
        self.assertIn('this._ws("parlorwave_radio/entities")', self.js)
        init = (ROOT / "__init__.py").read_text()
        self.assertIn('_command("parlorwave_radio/entities", _entities)', init)
        self.assertIn("unique_id.startswith(prefix)", init)

    def test_the_live_view_kept_its_shape(self):
        """Renamed to On Air and restyled -- the DJ's own controls are
        still there and the last break is still shown. The music-programming
        card moved to Station whole; see
        test_the_programming_controls_live_on_station_and_only_there."""
        onair = self.js[self.js.index("  _renderOnAir() {"):self.js.index("  /* BREAK LENGTH AND CADENCE")]
        # The DJ controls card became the Broadcast Console: the same
        # switch, the same speaker select and the same Air Check, on one
        # deck under the stage rather than on two cards beneath it.
        for kept in ('aria-label="Broadcast console"', "this._output",
                     "this._renderLastBreak()", "this._renderDjSwitch(dj, bs)"):
            self.assertIn(kept, onair, kept)
        # break style is Booth's; see
        # test_panel_onair.KeptCapabilities.test_break_style_belongs_to_booth
        for moved in ("this._breakLength", "this._cadence"):
            self.assertNotIn(moved, onair, moved)
        last = self.js[self.js.index("  _renderLastBreak() {"):]
        self.assertIn("last_spoken", last)
        self.assertIn("history-toggle", last)

    def test_panel_parses_when_node_is_available(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node not on PATH")
        p = subprocess.run([node, "--check",
                            str(ROOT / "panel" / "parlorwave-radio-panel.js")],
                           capture_output=True, text=True, timeout=30)
        self.assertEqual(0, p.returncode, p.stderr)


class RequestFlowFidelity(unittest.TestCase):
    def test_enqueue_replaces_first_landed_then_adds(self):
        # The ported voice-flow semantic: the first track that actually
        # lands replaces the queue, the rest append. Losing this silently
        # would double-queue music.
        src = (ROOT / "__init__.py").read_text()
        self.assertIn('"replace" if landed == 0 else "add"', src)

    def test_single_track_failures_do_not_abort_the_request(self):
        # MA raises on tracks it cannot resolve;
        # the legacy flow tolerated that per-track and so must we. Only a
        # fully empty enqueue may error.
        src = (ROOT / "__init__.py").read_text()
        self.assertIn("except Exception:", src)
        self.assertIn("if not landed:", src)

    def test_request_service_calls_music_assistant_not_musicbrain_for_playback(self):
        src = (ROOT / "__init__.py").read_text()
        self.assertIn('"music_assistant", "play_media"', src)

    def test_request_resolves_target_through_the_entity_registry(self):
        # The MA service acts only on the MA
        # integration's own entities, which differ from MA player ids. The
        # enqueue target must come from _ma_entity_for (entity registry),
        # never be the raw selected output.
        src = (ROOT / "__init__.py").read_text()
        self.assertIn("def _ma_entity_for", src)
        self.assertIn('e.platform == "music_assistant"',
                      (ROOT / "entity.py").read_text())
        self.assertIn("target_entity = _ma_entity_for(player)", src)
        self.assertIn('target={"entity_id": target_entity}', src)
        self.assertNotIn('target={"entity_id": player}', src)


class NowPlayingFollowsSelectedOutput(unittest.TestCase):
    # A private listen on a phone must SHOW the phone. Now Playing is
    # anchored to the selected output, not the station queue and not a
    # hard-coded room player.
    def test_output_select_publishes_its_media_player_entity(self):
        src = (ROOT / "select.py").read_text()
        self.assertIn("def extra_state_attributes", src)
        self.assertIn('"output_entity_id": entity_id', src)
        self.assertIn("ma_entity_for(self.hass, selected)", src)

    def test_panel_prefers_selected_output_over_station_queue(self):
        js = (ROOT / "panel" / "parlorwave-radio-panel.js").read_text()
        player = js[js.index("get _player()"):]
        player = player[:player.index("\n  }")]
        self.assertLess(player.index("output_entity_id"),
                        player.index("queue_id"))
        self.assertNotIn("basement", js.lower())


class PanelSafety(unittest.TestCase):
    def setUp(self):
        self.js = (ROOT / "panel" / "parlorwave-radio-panel.js").read_text()

    def test_panel_never_calls_the_backend_directly(self):
        """Everything flows through Home Assistant: its services, its
        states, its websocket, and -- for a recording, which is bytes and
        does not belong in a service call -- its own authenticated view.
        What must never appear is the BACKEND: no host, no port, no key."""
        for banned in ("XMLHttpRequest", ":5005", "X-Api-Key", "api_key"):
            self.assertNotIn(banned, self.js, banned)
        # A URL SCHEME is not a call. The Newsroom asks a person for a feed
        # address, so it shows the shape of one; what it may never do is
        # name a real host, which is what a direct call would need. Every
        # scheme in the panel must therefore be followed by an ellipsis.
        # The one exception is not a URL at all: the SVG namespace NAME on
        # the badge artwork. An XML namespace is an identifier the
        # parser compares as a string; nothing is ever fetched from it.
        for match in re.finditer(r"https?://(.{0,12})", self.js):
            if match.group(0) == "http://www.w3.org/2":
                continue
            self.assertTrue(match.group(1).startswith("\u2026"),
                            "the panel names a host: " + match.group(0))
        self.assertNotRegex(self.js, r"http://www\.w3\.org/(?!2000/svg\b)",
                            "the only namespace the panel names is SVG's")

    def test_the_only_fetch_is_the_integrations_own_authenticated_view(self):
        """One fetch, to a path this integration owns, carrying the Home
        Assistant credential this browser session already has. A second
        fetch, or one to any other path, has to be argued for here."""
        const = re.search(r'const VOICE_SAMPLE_PATH = "([^"]+)";', self.js)
        self.assertTrue(const, "the upload path is not a named constant")
        self.assertEqual(const.group(1), "/api/parlorwave_radio/voice_sample")
        # TWO fetches now: the voice-sample upload and Listen Again. The
        # contract was never "exactly one" -- it is that EVERY fetch goes
        # to a path this integration owns and carries the Home Assistant
        # credential, so it is asserted over all of them rather than by
        # counting to one.
        calls = re.findall(r"fetch\(\s*([^,]+)", self.js)
        self.assertGreaterEqual(len(calls), 1)
        for call in calls:
            self.assertRegex(call, r"(VOICE_SAMPLE_PATH|BULLETIN_AUDIO_PATH)",
                             f"fetch to something other than our own view: {call}")
        self.assertEqual(self.js.count("this._authHeaders()"), len(calls))
        auth = self.js[self.js.index("_authHeaders() {"):]
        auth = auth[:auth.index("\n  }")]
        self.assertIn("this._hass && this._hass.auth", auth)
        self.assertIn("access_token", auth)
        # each path constant is the const module's too -- one spelling
        self.assertIn(
            'BULLETIN_AUDIO_PATH = "/api/parlorwave_radio/bulletin_audio"',
            self.js)
        self.assertIn(
            'BULLETIN_AUDIO_URL = "/api/parlorwave_radio/bulletin_audio"',
            (ROOT / "const.py").read_text())
        self.assertIn('VOICE_SAMPLE_URL = "/api/parlorwave_radio/voice_sample"',
                      (ROOT / "const.py").read_text())

    def test_panel_escapes_untrusted_text(self):
        self.assertIn("_esc(", self.js)
        # spoken text and titles go through the escaper
        self.assertIn("this._esc(spoken)", self.js, "the spoken break is escaped")
        self.assertIn('this._esc(title || (playing ? "" : "Nothing playing"))', self.js)
        self.assertIn("this._esc(artUrl)", self.js, "the artwork URL is escaped")

    def test_panel_defines_the_registered_webcomponent(self):
        self.assertIn('customElements.define("parlorwave-radio-panel"', self.js)
        init = (ROOT / "__init__.py").read_text()
        self.assertIn('webcomponent_name="parlorwave-radio-panel"', init)


class PanelPathDoesNotCollideWithLegacyDashboard(unittest.TestCase):
    """The permanent public sidebar path. It must never collide with a
    Lovelace dashboard path: Home Assistant refuses to overwrite a
    registered panel, and the native panel silently vanishes."""

    def test_the_panel_path_is_the_public_product_path(self):
        const = (ROOT / "const.py").read_text()
        self.assertIn('PANEL_URL_PATH = "parlorwave-radio"', const)
        self.assertIn('PANEL_TITLE = "ParlorWave Radio"', const)

    def test_taken_path_is_logged_not_silent(self):
        init = (ROOT / "__init__.py").read_text()
        guard = init.index('if PANEL_URL_PATH in hass.data.get("frontend_panels"')
        body = init[guard:guard + 500]
        self.assertIn("_LOGGER.warning", body.split("return")[0])




_JD = Path(__file__).resolve().parents[1] / "custom_components" / "parlorwave_radio"


class VoicePickReflectsImmediately(unittest.TestCase):
    """The shelf rides a five-minute TTL for the idle case. A voice pick
    must not wait it out: the entity busts the cache right after the write
    so the base-class refresh refetches, and the picker shows the new voice
    on the next poll instead of snapping back to the old one."""

    def test_voice_write_invalidates_the_shelf_cache(self):
        src = (_JD / "select.py").read_text()
        write = src[src.index("class VoiceSelect"):]
        write = write[write.index("async def _write"):]
        write = write[:write.index("\n\n")]
        self.assertIn("voices_select(", write)
        self.assertIn("invalidate_voice_library()", write)
        self.assertLess(write.index("voices_select("),
                        write.index("invalidate_voice_library()"))

    def test_coordinator_defines_the_invalidation(self):
        src = (_JD / "coordinator.py").read_text()
        body = src[src.index("def invalidate_voice_library(self)"):]
        body = body[:body.index("async def _voice_library_snapshot")]
        self.assertIn("self._voices_at = 0.0", body)


class EveryVoiceCanBePreviewed(unittest.TestCase):
    """The manager offers a Preview for the curated voices and the owner's
    enrolled voice, not only the Chatterbox shelf; and the picker carries a
    Preview for whatever is selected. Preview is the websocket
    parlorwave_radio/voice_preview -- never a transport call."""

    def test_the_library_renders_every_shelf_as_one_of_three_groups(self):
        js = (_JD / "panel" / "parlorwave-radio-panel.js").read_text()
        mgr = js[js.index("_renderVoiceLibrary() {"):]
        mgr = mgr[:mgr.index("_personaName(")]
        for needle in ("lib.home_assistant", "lib.kokoro", "lib.customs",
                       "lib.current", 'group("ha"', 'group("local"',
                       'group("mine"', 'type="radio" name="dj-voice"',
                       "preview(v.voice_id)"):
            self.assertIn(needle, mgr, needle)
        for label in ("Home Assistant Voices", "ParlorWave / Local Voices",
                      "My Voices"):
            self.assertIn(label, js, label)
        # the owner's recordings are not a product shelf
        self.assertNotIn("lib.builtins", mgr)
        self.assertNotIn("House voice", mgr)
        # an empty storage slot is not a voice and is never drawn as one
        self.assertIn("filter((c) => c.has_sample)", mgr)
        self.assertNotIn("Use custom voice", js)

    def test_the_selected_voice_is_obvious_without_relying_on_colour(self):
        js = (_JD / "panel" / "parlorwave-radio-panel.js").read_text()
        mgr = js[js.index("_renderVoiceLibrary() {"):]
        mgr = mgr[:mgr.index("_personaName(")]
        self.assertIn('<span class="vbadge">Selected</span>', mgr)
        self.assertIn('${on ? "vsel" : ""}', mgr)
        style = js[js.index("<style>"):js.index("</style>")]
        self.assertIn(".vbadge", style)
        self.assertRegex(style, r"\.vrow\.vsel \{[^}]*box-shadow")

    def test_checking_a_box_selects_and_refreshes_the_shelf(self):
        """The box goes through the same entity write the picker used, and
        the shelf is refetched afterwards -- the step whose absence left the
        check on the old voice while the store had already moved."""
        js = (_JD / "panel" / "parlorwave-radio-panel.js").read_text()
        wire = js[js.index('querySelectorAll("[data-vpick]")'):]
        wire = wire[:wire.index('querySelectorAll("[data-preview]")')]
        self.assertIn('"change"', wire)
        self.assertIn("this._select(this._voice, r.dataset.vpick)", wire)
        self.assertIn(".then(() => this._fetchVoiceLib())", wire)
        self.assertNotIn("dblclick", js)

    def test_define_survives_a_second_module_execution(self):
        js = (_JD / "panel" / "parlorwave-radio-panel.js").read_text()
        self.assertIn('if (!customElements.get("parlorwave-radio-panel"))', js)

    def test_radio_clicks_do_not_defer_rendering(self):
        js = (_JD / "panel" / "parlorwave-radio-panel.js").read_text()
        head = js[js.index("  _render() {"):][:700]
        self.assertIn('"radio"', head)
        self.assertIn('"checkbox"', head)

    def test_render_is_deferred_while_a_control_has_focus(self):
        js = (_JD / "panel" / "parlorwave-radio-panel.js").read_text()
        head = js[js.index("  _render() {"):][:600]
        self.assertIn("activeElement", head)
        self.assertIn('"SELECT"', head)
        self.assertIn('"INPUT"', head)
        self.assertIn("_deferredRender = true", head)
        self.assertIn('addEventListener("focusout"', js)

    def test_the_voice_on_the_air_is_named_and_previewable(self):
        js = (_JD / "panel" / "parlorwave-radio-panel.js").read_text()
        tile = js[js.index("_voiceNowTile() {"):]
        tile = tile[:tile.index("  _voiceNote(")]
        self.assertIn("data-preview=", tile)
        self.assertIn("_voiceIdForName(", tile)
        self.assertIn("this._voiceGroupOf(id)", tile,
                      "the tile says which shelf the voice came from")
        self.assertIn("key ? VOICE_GROUPS[key][0] : null", tile,
                      "a shelf nobody claims is left unsaid, not guessed")
        for banned in ("play_media", "media_seek", "media_pause", "media_stop",
                       "select_option"):
            self.assertNotIn(banned, tile)


class PanelScriptIsCacheBusted(unittest.TestCase):
    """A redeployed panel must reach browsers on a normal reload. The
    static path deliberately sends no cache headers, so the module URL
    carries a version derived from the bytes the route can actually serve
    -- which is not the same thing as the bytes of one file on disk. See
    panel_assets."""

    def test_module_url_is_versioned_by_the_panel_digest(self):
        src = (_JD / "__init__.py").read_text()
        reg = src[src.index("async_register_panel("):]
        reg = reg[:reg.index(")\n")]
        self.assertIn("{PANEL_FILE}?v={digest}", reg)
        # the read happens off the event loop, or HA logs a blocking-call
        # traceback against the integration on every start
        self.assertIn("async_add_executor_job(panel_asset_version, root)", src)

    def test_the_digest_covers_every_variant_the_route_may_substitute(self):
        """aiohttp answers an Accept-Encoding: gzip request with a `.gz`
        sibling if one is there. A digest taken over the plain file alone
        advertises a version the server may not be serving."""
        src = (_JD / "panel_assets.py").read_text()
        self.assertIn("hashlib.sha256", src)
        self.assertIn('PRECOMPRESSED_SUFFIXES = (".gz", ".br")', src)
        # root is a str from hass.config.path(); never Path-divide it
        self.assertIn("os.path.join(root, name)", src)
        self.assertNotIn("root / ", src)

    def test_a_mismatched_sibling_is_removed_rather_than_merely_noticed(self):
        """A version marker cannot change what is served; only deleting the
        impostor can."""
        src = (_JD / "panel_assets.py").read_text()
        self.assertIn("os.remove(sibling)", src)


class VoiceNotesAreTheOwnersOwn(unittest.TestCase):
    """A note is the owner's reminder, saved through one service, refetched
    into the shelf, and never anything the writer or a provider sees."""

    def test_service_is_registered_with_voice_id_and_note(self):
        src = (_JD / "__init__.py").read_text()
        self.assertIn('DOMAIN, SERVICE_VOICE_NOTE, voice_note', src)
        reg = src[src.index('SERVICE_VOICE_NOTE, voice_note'):][:260]
        self.assertIn('vol.Required("voice_id")', reg)
        self.assertIn('vol.Required("note")', reg)
        self.assertIn('coordinator.client.voice_note(call.data["voice_id"]', src)
        self.assertIn("voice_note:", (_JD / "services.yaml").read_text())

    def test_client_posts_to_the_note_endpoint(self):
        self.assertIn('f"/voices/{voice_id}/note"', (_JD / "api.py").read_text())

    def test_panel_shows_the_note_and_edits_it_inline(self):
        js = (_JD / "panel" / "parlorwave-radio-panel.js").read_text()
        mgr = js[js.index("_renderVoiceLibrary() {"):]
        mgr = mgr[:mgr.index("_personaName(")]
        for needle in ("noteLine(v.voice_id, v.note)",
                       'data-vnote-input="${id}"', 'maxlength="80"',
                       'data-vnote-clear="${id}"', "this._noteDraft"):
            self.assertIn(needle, mgr)
        wire = js[js.index("const saveNote ="):]
        wire = wire[:wire.index('querySelectorAll("[data-vrename]")')]
        self.assertIn('"voice_note"', wire)
        self.assertIn("this._fetchVoiceLib()", wire)
        # Delete is the same service with an empty note -- no second path.
        self.assertIn('saveNote(b.dataset.vnoteClear, "")', wire)
        self.assertIn("this._noteDraft = inp.value", wire)

    def test_panel_never_rebuilds_the_dom_under_a_press(self):
        # A render between pointerdown and click replaced the Save button
        # and put the stored note back in the box; the second save was lost.
        js = (_JD / "panel" / "parlorwave-radio-panel.js").read_text()
        render = js[js.index("_render() {"):]
        render = render[:render.index("this._writeTree(markup, bs)")]
        self.assertIn("if (this._pointerHeld) { this._deferredRender = true; return; }", render)
        self.assertIn('addEventListener("pointerdown"', js)
        self.assertIn('window.addEventListener("pointerup", this._onRelease)', js)
        # The shadow root's focusout hook is attached once (constructor),
        # never per render. (The notice banner, a fresh
        # element each render, also listens for focus to hold its clock;
        # that is not the hook this pins.)
        self.assertEqual(js.count('this.shadowRoot.addEventListener("focusout"'), 1)
        ctor = js[js.index("  constructor() {"):js.index("  connectedCallback() {")]
        self.assertIn('this.shadowRoot.addEventListener("focusout"', ctor)


class AnyVoiceCanWearTheOwnersName(unittest.TestCase):
    """Built-ins rename like the custom slots: one service, keyed by voice
    id, through one backend path. The select entity lists voices by name,
    so a rename invalidates its cached options."""

    def test_service_takes_a_voice_id_not_a_slot(self):
        src = (_JD / "__init__.py").read_text()
        reg = src[src.index('DOMAIN, SERVICE_VOICE_RENAME'):]
        reg = reg[:reg.index("))")]
        self.assertIn('vol.Required("voice_id"): cv.string', reg)
        self.assertNotIn("slot", reg)
        handler = src[src.index("async def voice_rename"):src.index("async def voice_delete")]
        self.assertIn('coordinator.client.voice_rename(call.data["voice_id"]', handler)
        self.assertIn("coordinator.invalidate_voice_library()", handler)
        yaml = (_JD / "services.yaml").read_text()
        block = yaml[yaml.index("voice_rename:"):yaml.index("voice_delete:")]
        self.assertIn("voice_id:", block)
        self.assertNotIn("slot:", block)

    def test_client_posts_to_the_rename_endpoint(self):
        self.assertIn('f"/voices/{voice_id}/rename"', (_JD / "api.py").read_text())

    def test_panel_renames_built_ins_inline_and_can_put_the_name_back(self):
        js = (_JD / "panel" / "parlorwave-radio-panel.js").read_text()
        mgr = js[js.index("_renderVoiceLibrary() {"):]
        mgr = mgr[:mgr.index("_personaName(")]
        for needle in ('nameLine(v.voice_id, v.name, opts.builtin || "")',
                       "builtin: k.builtin_name", 'maxlength="40"',
                       'data-vrename-reset="${id}"', "this._nameDraft"):
            self.assertIn(needle, mgr)
        wire = js[js.index("const saveName ="):]
        wire = wire[:wire.index('querySelectorAll("[data-vdelete]")')]
        self.assertIn('"voice_rename", { voice_id: id, name }', wire)
        self.assertIn('saveName(b.dataset.vrenameReset, "")', wire)
        self.assertIn("this._fetchVoiceLib()", wire)


class BuiltInsCanBeTunedByEar(unittest.TestCase):
    """Speed and sentence pause for a built-in voice: one service keyed by
    voice id, a preview that can carry unsaved values, and a panel row of
    sliders whose draft never rebuilds under a drag."""

    def test_service_and_client(self):
        src = (_JD / "__init__.py").read_text()
        reg = src[src.index('DOMAIN, SERVICE_VOICE_TUNING'):]
        reg = reg[:reg.index("))")]
        for needle in ('vol.Required("voice_id"): cv.string',
                       'vol.Required("speed"): vol.Coerce(float)',
                       'vol.Required("pause"): vol.Coerce(float)'):
            self.assertIn(needle, reg)
        handler = src[src.index("async def voice_tuning"):src.index("async def voice_note")]
        self.assertIn("coordinator.invalidate_voice_library()", handler)
        api = (_JD / "api.py").read_text()
        self.assertIn('f"/voices/{voice_id}/tuning"', api)
        self.assertIn("voice_tuning:", (_JD / "services.yaml").read_text())

    def test_preview_can_carry_unsaved_delivery(self):
        src = (_JD / "__init__.py").read_text()
        cmd = src[src.index('_command("parlorwave_radio/voice_preview"'):]
        cmd = cmd[:cmd.index("})")]
        self.assertIn('vol.Optional("speed"): vol.Coerce(float)', cmd)
        self.assertIn('vol.Optional("pause"): vol.Coerce(float)', cmd)
        self.assertIn('msg["voice_id"], msg.get("speed"), msg.get("pause")', src)

    def test_panel_tunes_with_sliders_and_previews_the_draft(self):
        js = (_JD / "panel" / "parlorwave-radio-panel.js").read_text()
        mgr = js[js.index("_renderVoiceLibrary() {"):]
        mgr = mgr[:mgr.index("_personaName(")]
        for needle in ('type="range" min="0.7" max="1.3"', 'type="range" min="0.5" max="2.5"',
                       'data-vtune-preview="${k.voice_id}"', 'data-vtune-save="${k.voice_id}"'):
            self.assertIn(needle, mgr)
        # only the built-in rows carry the knob: My Voices never see it
        mine = mgr[mgr.index("const mineRows ="):]
        self.assertNotIn("data-vtune", mine)
        wire = js[js.index('querySelectorAll("[data-vtune]")'):]
        wire = wire[:wire.index('querySelectorAll("[data-vdelete]")')]
        self.assertIn('"voice_tuning", { voice_id: t.id, speed: t.speed, pause: t.pause }', wire)
        self.assertIn("this._previewVoice(this._tune.id, { speed: this._tune.speed, pause: this._tune.pause })", wire)
        # a drag updates the readout in place, never through _render
        drag = wire[wire.index('"[data-vtune-speed],[data-vtune-pause]"'):wire.index('"[data-vtune-preview]"')]
        self.assertNotIn("this._render()", drag)


class AlphaUiReadiness(unittest.TestCase):
    """Product invariants for the alpha UI:
    Home Assistant TTS visibility, authoritative problem presentation,
    DJ Scripting telemetry without inference terms, empty-catalog guards,
    and mobile accessibility."""

    def setUp(self):
        self.js = (_JD / "panel" / "parlorwave-radio-panel.js").read_text()

    def test_ha_voices_visible_and_grouped_in_picker(self):
        row = self.js[self.js.index("_voiceRow() {"):]
        row = row[:row.index("_renderVoiceLibrary() {")]
        # the dropdown groups by the SAME three customer-facing shelves the
        # library uses, from the one table both read
        self.assertIn("VOICE_GROUPS.ha[0]", row)
        self.assertIn("VOICE_GROUPS.local[0]", row)
        self.assertIn("VOICE_GROUPS.mine[0]", row)
        self.assertIn("<optgroup", row)
        self.assertIn('data-select="${e.entity_id}"', row)
        self.assertIn('aria-label="DJ Voice"', row)

    def test_ha_voices_in_the_library(self):
        mgr = self.js[self.js.index("_renderVoiceLibrary() {"):]
        mgr = mgr[:mgr.index("_personaName(")]
        self.assertIn("lib.home_assistant", mgr)
        self.assertIn('group("ha", haRows', mgr)
        # the shelf is described once, on its group head -- not repeated
        # under every voice filed beneath it
        self.assertIn("Home Assistant Voices", self.js)
        self.assertIn("Speech from your Home Assistant server. No extra hardware needed.",
                      self.js)
        self.assertIn("lib.home_assistant", self.js[self.js.index("_voiceIdForName(name) {"):])
        self.assertIn("lib.home_assistant", self.js[self.js.index("_voiceName(assetOrId) {"):])

    def test_problems_banner_contract(self):
        probs = self.js[self.js.index("_renderProblems() {"):]
        probs = probs[:probs.index("_renderOnAir() {")]
        # The banner itself is rebuilt with the tree, so it is NOT a live
        # region any more (one that is destroyed and re-created on every
        # update is announced as new each time). The alert lives beside the
        # stylesheet, once, and _announce changes only its text.
        self.assertNotIn("aria-live", probs)
        self.assertNotIn('role="alert"', probs)
        self.assertIn('id="sr-alert" class="visually-hidden" role="alert" aria-live="assertive"', self.js)
        announce = self.js[self.js.index("_announce(bs) {"):self.js.index("  _render() {")]
        self.assertIn("r.blockers", announce)
        self.assertIn("b.title", announce)
        # The readiness document's blockers, in its words -- not the
        # service's own problem list. One health translation, in
        # readiness.py, rendered by Settings and by this banner alike.
        self.assertIn("this._readiness()", probs)
        self.assertIn("r.blockers", probs)
        self.assertNotIn("p.severity", probs)
        # Problems banner is wired into _render layout
        render = self.js[self.js.index("  _render() {"):]
        render = render[:render.index("this.shadowRoot.querySelectorAll")]
        self.assertIn("${this._renderProblems()}", render)

    def test_settings_is_the_readiness_screen_and_diagnostics_is_its_drawer(self):
        """Settings used to BE the diagnostics table. It is now a setup and
        readiness screen, and the engineering table is one closed
        disclosure at the bottom of it -- so the sections a person needs
        are what the screen is made of, and the telemetry is what they can
        open when somebody asks them to."""
        settings = self.js[self.js.index("  _renderSettings() {"):]
        for section in ("<h2>Setup</h2>", "<h2>Music Assistant</h2>",
                        # Named for what a person does there, not for what
                        # the service calls it. "DJ outputs" is the
                        # setting's name; "Speakers ParlorWave may DJ on"
                        # is the question, and this card now answers it in
                        # place instead of routing to the options flow.
                        # ...and the weather entity and the
                        # calendars beside it, under one heading.
                        "<h2>What the DJ may use</h2>",
                        '<div class="label">Speakers ParlorWave may DJ on</div>',
                        "<h2>Speech</h2>",
                        "<h2>Writing</h2>",
                        "<h2>Optional capabilities</h2>",
                        "<h2>Health &amp; diagnostics</h2>"):
            self.assertIn(section, self.js, section)
        for renderer in ("_renderReadyHero", "_renderSetupChecklist",
                         "_renderIssues", "_renderDiagnostics"):
            self.assertIn(f"this.{renderer}(", settings, renderer)
        # closed by default, and its own button
        diag = self.js[self.js.index("_renderDiagnostics() {"):]
        diag = diag[:diag.index("  /* --- Settings ---")]
        self.assertIn('id="settings-advanced"', diag)
        self.assertIn("this._readyAdvanced ?", diag)
        self.assertIn("this._readyAdvanced = false", self.js)

    def test_catalog_controls_are_offered_only_where_they_can_work(self):
        """They live on Station now, behind the backend's own capability:
        fully enabled when a local catalog exists, and replaced by a
        sentence saying where music comes from instead when it does not.
        Never rendered-but-broken, and never guessed at."""
        station = self.js[self.js.index("  _renderStation() {"):
                          self.js.index("  _renderDiagnostics() {")]
        enabled = station[station.index("  _renderStationProgramming() {"):]
        self.assertIn('id="start-radio"', enabled)
        self.assertNotIn('id="start-radio" disabled', enabled)
        self.assertIn('id="request-input" type="text"', enabled)
        self.assertIn('id="request-go"', enabled)
        self.assertNotIn('id="request-go" disabled', enabled)
        base = station[station.index("  _renderStationFollowing() {"):
                       station.index("  _renderStationProgramming() {")]
        for offered in ('id="start-radio"', 'id="request-go"', "_toggleRow("):
            self.assertNotIn(offered, base, offered)
        self.assertIn("Following Music Assistant", base)
        # alpha.4: base mode no longer lists the catalog tools at all
        self.assertNotIn("Not in this release", base)

    def test_accessibility_and_responsive_css(self):
        # bounded by the next method, not by its comment: a comment is prose,
        # it moves, and a moved boundary reads here as a missing aria-label
        onair = self.js[self.js.index("  _renderOnAir() {"):
                        self.js.index("  _renderLastBreak() {")]
        for control, label in (("thumb-up", "I like this song"),
                               ("thumb-down", "I dislike this song"),
                               ("drawer-lyrics", "Lyrics"),
                               ("drawer-queue", "Queue")):
            self.assertIn(f'id="{control}"', onair, control)
            self.assertIn(f'aria-label="{label}"', onair, label)
        self.assertIn('id="history-toggle"', self.js)
        self.assertIn('aria-label="Break history"', self.js)
        self.assertIn('@media (max-width: 560px)', self.js)
        self.assertIn('button { min-height:44px; }', self.js)


if __name__ == "__main__":
    unittest.main()
