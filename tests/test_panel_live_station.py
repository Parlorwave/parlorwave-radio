"""The On-air station card (Station Programmer, Mode 2): source contracts.

Its behaviour is EXECUTED in test_panel_dom.mjs (every branch, the two-step
start, the exact payload, stop). These pin where it lives, that it is
visibly LIVE and apart from the Dial's setup card, what it may talk to, and
the integration commands behind it.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "custom_components" / "parlorwave_radio"
PANEL = (ROOT / "panel" / "parlorwave-radio-panel.js").read_text()
INIT = (ROOT / "__init__.py").read_text()
API = (ROOT / "api.py").read_text()
STATION = PANEL[PANEL.index("  /* --- Station ---"):PANEL.index("  _renderDiagnostics() {")]
BASE = STATION[STATION.index("  _renderStationFollowing() {"):STATION.index("  /* CATALOG MODE.")]
ENABLED = STATION[STATION.index("  _renderStationProgramming() {"):
                  STATION.index("  /* --- On-air station (Station Programmer")]
# Both modes render one page from shared helpers; the on-air line
# is the status of the Dial stage (DECK), drawn by _renderStationDeck().
CATALOG = STATION[STATION.index("  _renderStationProgramming() {"):
                  STATION.index("  _renderStationDeck() {")]
DECK = STATION[STATION.index("  _renderStationDeck() {"):STATION.index("  _renderDeckPlate() {")]
LIVE = PANEL[PANEL.index("  /* --- On-air station (Station Programmer, Mode 2)"):
             PANEL.index("  /* --- One song, next (alpha.4)")]
SONG = PANEL[PANEL.index("  /* --- One song, next (alpha.4)"):
             PANEL.index("  /* --- Dial Stations")]
DIAL = PANEL[PANEL.index("  /* --- Dial Stations"):
             PANEL.index("  /* HEALTH & DIAGNOSTICS.")]
STYLE = PANEL[PANEL.index("<style>"):PANEL.index("</style>")]
PHONE = STYLE[STYLE.index("@media (max-width: 560px)"):]


def code(src: str) -> str:
    return re.sub(r"//.*$", "", re.sub(r"/\*.*?\*/", "", src, flags=re.S),
                  flags=re.M)


class WhereItLives(unittest.TestCase):
    def test_both_station_modes_show_it_in_the_dial_stage_above_the_tiles(self):
        # The page order: the on-air line is
        # the status of the Dial stage, above the tiles it lights; the stage
        # comes first in both modes and Announcements (a Programming row)
        # follows it.
        air = DECK.index("${this._renderOnAirStationCard()}")
        dial = DECK.index("${this._renderDialStationsCard()}")
        self.assertLess(air, dial)
        for mode in (BASE, CATALOG):
            self.assertLess(mode.index("${this._renderStationDeck()}"),
                            mode.index("${this._renderProgrammingCard()}"))

    def test_it_is_on_the_station_tab_only(self):
        # One call site, in the Dial stage, which only the two
        # Station mode renderers draw; nothing of it on On Air.
        self.assertEqual(PANEL.count("this._renderOnAirStationCard()"), 1)
        self.assertIn("${this._renderOnAirStationCard()}", DECK)
        self.assertEqual(PANEL.count("this._renderStationDeck()"), 2)
        for mode in (BASE, CATALOG):
            self.assertIn("${this._renderStationDeck()}", mode)
        onair = PANEL[PANEL.index("  _renderOnAir("):PANEL.index("  /* --- Station ---")]
        for banned in ("_renderOnAirStationCard", "_renderStationDeck", "_renderAirForm"):
            self.assertNotIn(banned, onair, banned)

    def test_the_setup_card_never_reaches_the_live_commands(self):
        for banned in ("station_live", "_liveStart", "_liveStop", "air-"):
            self.assertNotIn(banned, code(DIAL), banned)


class LiveAndUnmistakable(unittest.TestCase):
    def test_it_says_on_air_and_what_stop_means(self):
        self.assertIn('aria-label="On-air station"', LIVE)
        self.assertIn("On air", LIVE)
        # Stop's own second press says what stopping means, where
        # Stop is pressed (both modes). In alpha.4 that is the only
        # place it is said; About the Dial is gone.
        self.assertRegex(LIVE, r"Stop programming \$\{this\._esc\(where\)\}\? Nothing more\s+"
                               r"will be added\. What is already queued keeps playing\.")
        self.assertNotIn("About the Dial", BASE)

    def test_live_buttons_are_filled_where_test_station_is_quiet(self):
        # The presses that put a station on the air are FILLED (no class
        # before the id); every button of the Dial setup block is quiet
        # (classed: ghost, a tile, a sheet close). The off-air filled
        # entry is gone -- a tile press opens the choose sheet -- and
        # Change/Stop on the on-air line are ghost.
        for filled in ('<button id="air-go"', '<button id="air-confirm"',
                       '<button id="rl-go"', '<button id="rl-confirm"'):
            self.assertIn(filled, LIVE, filled)
        self.assertIn('<button class="ghost" id="dial-test"', DIAL)
        self.assertIn('<button class="ghost" id="dial-save"', DIAL)
        self.assertEqual(re.findall(r"<button(?![^>]*\bclass=)[^>]*>", DIAL), [])
        # and LIVE still looks live: the on-air line wears the lamp's red
        self.assertIn(".air-line.on .air-lamp { background:var(--pw-lamp);", STYLE)
        self.assertIn(".air-line.on .air-word { color:var(--pw-lamp); }", STYLE)

    def test_start_is_two_presses_and_stop_is_two_presses(self):
        binds = PANEL[PANEL.index('    on("air-open"'):PANEL.index('    on("air-stop-confirm"') + 80]
        go = binds[binds.index('on("air-go"'):binds.index('on("air-back"')]
        self.assertNotIn("_liveStart", go, "the first press must only ask")
        self.assertIn("confirm = true", go)
        self.assertIn('on("air-confirm", () => this._liveStart());', binds)
        self.assertIn('on("air-stop", () => { this._liveStopAsk = true;', binds)
        self.assertIn('on("air-stop-confirm", () => this._liveStop());', binds)

    def test_a_speaker_is_never_chosen_for_the_person(self):
        form = LIVE[LIVE.index("  _liveOpenForm(presetId) {"):LIVE.index("  async _liveStart(mode = null) {")]
        self.assertNotIn("eligible", form)
        self.assertNotIn("targets[0]", form)
        self.assertIn('Choose a speaker…', LIVE)

    def test_only_the_four_live_commands_and_no_transport(self):
        used = set(re.findall(r'_ws\("([^"]+)"', LIVE))
        self.assertEqual(used, {"parlorwave_radio/station_live",
                                "parlorwave_radio/station_live_targets",
                                "parlorwave_radio/station_live_start",
                                "parlorwave_radio/station_live_stop",
                                # the person's answer to a pending Autoplay
                                # restore -- writes that one flag, no transport
                                "parlorwave_radio/station_live_autoplay"})
        for banned in ("callService", "media_player.", "play_media",
                       "players/cmd", "media_play", "media_pause"):
            self.assertNotIn(banned, code(LIVE), banned)

    def test_its_colours_are_house_tokens(self):
        rules = "".join(re.findall(r"\.air-[\w-]+[^{]*\{[^}]*\}", STYLE))
        rules += "".join(re.findall(r"\.dial-(?:weak|row-weak|live|stale)[\w-]*[^{]*\{[^}]*\}",
                                    STYLE))
        self.assertTrue(set(re.findall(r"#[0-9a-fA-F]{3,8}", rules))
                        <= {"#7cc47f", "#ffa726", "#1a1206"})


class Responsive(unittest.TestCase):
    def test_actions_wrap_on_a_phone(self):
        self.assertIn(".air-acts button { flex:1 1 auto; }", PHONE)

    def test_nothing_in_it_can_push_the_page_sideways(self):
        for rule in re.findall(r"\.air-[\w-]+[^{]*\{[^}]*\}", STYLE):
            self.assertNotRegex(rule, r"min-width:\s*[4-9]\d\dpx", rule)
            self.assertNotRegex(rule, r"white-space:\s*nowrap", rule)


class TheDialFixes(unittest.TestCase):
    def test_the_cold_build_wait_is_stated_honestly(self):
        # A cold build can take tens of seconds: no maximum the backend cannot
        # guarantee is promised anywhere, only that the first one is slower.
        self.assertIn("Building station…", DIAL)
        self.assertIn("The first build after a restart can take\n        a little longer", DIAL)
        self.assertIn("The first build after a restart can take a little longer.", LIVE)
        for block in (DIAL, LIVE):
            self.assertNotRegex(block, r"\d+\s*[–-]\s*\d+\s+seconds")
            self.assertNotRegex(block, r"can take a few\s+seconds")

    def test_counts_are_pluralised_and_a_thin_preset_stays_thin(self):
        self.assertNotIn("${lt.tracks} tracks · ${lt.artists} artists", DIAL)
        self.assertIn('n(lt.artists, "artist")', DIAL)
        self.assertIn("Too thin to go live", DIAL)

    def test_an_edited_term_marks_the_preview_stale_at_once(self):
        bind = PANEL[PANEL.index('for (const [id, key] of [["dial-label", "label"]'):
                     PANEL.index('const dialEnabled = this.shadowRoot')]
        self.assertIn('classList.toggle("dial-stale", stale)', bind)
        self.assertIn("note.hidden = !stale", bind)
        self.assertIn(".dial-stale .dial-tracks", STYLE)


class TheIntegration(unittest.TestCase):
    def test_four_commands_and_start_requires_a_target(self):
        for cmd in ("station_live", "station_live_targets",
                    "station_live_start", "station_live_stop"):
            self.assertIn(f'_command("parlorwave_radio/{cmd}",', INIT)
        start = INIT[INIT.index('_command("parlorwave_radio/station_live_start",'):]
        start = start[:start.index("_command(", 10)]
        self.assertIn('vol.Required("target"): str', start)
        self.assertNotIn("default_request_output", start)

    def test_the_client_routes_and_the_longer_start_wait(self):
        self.assertIn('self._call("GET", "/station/live")', API)
        self.assertIn('self._call("GET", "/station/live/targets")', API)
        self.assertIn('"/station/live/start", body,', API)
        self.assertIn('self._call("POST", "/station/live/stop", {})', API)

    def test_the_command_comment_names_the_two_writers(self):
        self.assertIn("the on-air station's start and stop", INIT)

    def test_every_caller_shares_the_one_start_command(self):
        """The Station tab, the Request Line and the Dial: one websocket
        command, one client call, one backend route -- no caller has a
        start path of its own."""
        self.assertEqual(INIT.count("c.client.station_live_start("), 1)
        self.assertEqual(API.count('"/station/live/start"'), 1)
        # Four sends of the ONE command: the Station tab's start, its house
        # handover question (answered handover_required, writing nothing),
        # the Request Line and the Dial.
        self.assertEqual(PANEL.count('_ws("parlorwave_radio/station_live_start"'), 4)
        start = INIT[INIT.index('_command("parlorwave_radio/station_live_start",'):]
        start = start[:start.index("_command(", 10)]
        self.assertIn('vol.Optional("origin"): vol.In(("station_tab", "dial"))', start)
        self.assertIn("origin=m.get(\"origin\")", start)
        client = API[API.index("    async def station_live_start("):
                     API.index("    async def station_live_stop(")]
        self.assertIn('body["origin"] = origin', client)


class TheRequestLine(unittest.TestCase):
    """Its behaviour is EXECUTED in test_panel_dial_knob.mjs."""

    def test_it_lives_in_its_own_card_and_says_what_it_is(self):
        # Its own compact card under the Dial stage, still in the
        # Request Line block of the On-air region.
        self.assertIn('<section class="card rl-card" aria-label="Request Line">', LIVE)
        self.assertEqual(PANEL.count("this._renderRequestLineCard()"), 2)
        self.assertIn("? this._renderRequestLine(d) : \"\"}", LIVE)
        self.assertIn('aria-label="Request Line"', LIVE)
        # alpha.4: a single song has its own row (the One song, next block),
        # so the station row no longer says it cannot queue one
        self.assertNotIn("it does not queue a single song", LIVE)
        self.assertIn("this._renderSongRequest()", LIVE)
        self.assertIn("origin: \"request_line\"", LIVE)

    def test_one_song_next_is_its_own_block_and_never_starts_a_station(self):
        """alpha.4: one command, and nothing that starts a station, touches
        transport or names a speaker -- the backend picks the DJ's own."""
        used = set(re.findall(r'_ws\("([^"]+)"', SONG))
        self.assertEqual(used, {"parlorwave_radio/request_song"})
        for banned in ("station_live_start", "callService", "media_player.",
                       "play_media", "queue_id"):
            self.assertNotIn(banned, code(SONG), banned)
        self.assertIn('aria-label="Play a song next"', SONG)

    def test_it_is_not_the_old_song_request_box(self):
        rl = LIVE[LIVE.index("  /* --- The Request Line"):]
        for banned in ('"parlorwave_radio", "request"', "request-input", "Play it",
                       "station_preview", "_svc("):
            self.assertNotIn(banned, code(rl), banned)

    def test_it_never_reads_the_house_output(self):
        rl = LIVE[LIVE.index("  /* --- The Request Line"):]
        for banned in ("default_request_output", "this._output", "select.out"):
            self.assertNotIn(banned, code(rl), banned)

    def test_its_box_cannot_push_a_phone_sideways(self):
        # min-width:0 keeps it inside a phone; the 16em basis wraps the
        # button under the box there, so the example reads whole (at 390 px
        # a 12em basis cut the example short).
        self.assertIn(".air-request .row input { flex:1 1 16em; min-width:0;", STYLE)


if __name__ == "__main__":
    unittest.main()
