"""Dial Stations on the Station tab: source contracts.

The card's behaviour is EXECUTED in test_panel_dom.mjs (every branch, the
Test Station payload, Try again, Save). These pin where it lives, what it
may talk to, and that it stays setup rather than playback.
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
                  STATION.index("  /* --- Dial Stations")]
# Both modes render one page from shared helpers; the tiles are
# the Dial stage's (DECK), drawn by _renderStationDeck().
CATALOG = STATION[STATION.index("  _renderStationProgramming() {"):
                  STATION.index("  _renderStationDeck() {")]
DECK = STATION[STATION.index("  _renderStationDeck() {"):STATION.index("  _renderDeckPlate() {")]
LIVE = PANEL[PANEL.index("  /* --- On-air station (Station Programmer, Mode 2)"):
             PANEL.index("  /* --- Dial Stations")]
BLOCK = PANEL[PANEL.index("  /* --- Dial Stations"):
              PANEL.index("  /* HEALTH & DIAGNOSTICS.")]
STYLE = PANEL[PANEL.index("<style>"):PANEL.index("</style>")]
PHONE = STYLE[STYLE.index("@media (max-width: 560px)"):]


class WhereItLives(unittest.TestCase):
    def test_both_station_modes_show_it_in_the_dial_stage(self):
        """An installation can run in following mode: the preview reads
        Music Assistant's library, not a local catalog, so the card is not
        gated on one.

        The tiles are the Dial stage's, which
        both modes render first; Announcements is a Programming row below
        it, so the old 'after announcements' order is inverted on purpose."""
        self.assertIn("${this._renderDialStationsCard()}", DECK)
        for mode in (BASE, CATALOG):
            self.assertIn("${this._renderStationDeck()}", mode)
            self.assertLess(mode.index("${this._renderStationDeck()}"),
                            mode.index("${this._renderProgrammingCard()}"))

    def test_it_is_on_the_station_tab_only(self):
        # One call site, the Dial stage, drawn by both modes
        self.assertEqual(PANEL.count("this._renderDialStationsCard()"), 1)
        self.assertIn("${this._renderDialStationsCard()}", DECK)
        self.assertEqual(PANEL.count("this._renderStationDeck()"), 2)
        onair = PANEL[PANEL.index("  _renderOnAir("):PANEL.index("  /* --- Station ---")] \
            if "  _renderOnAir(" in PANEL else ""
        self.assertNotIn("dial-", onair)

    def test_a_refresh_never_replaces_a_preset_being_edited(self):
        demand = PANEL[PANEL.index("  _maybeRefreshDemandData() {"):
                       PANEL.index("  async _fetchSpeakers() {")]
        self.assertIn('this._view === "station" && !this._dialEdit', demand)


class SetupNotPlayback(unittest.TestCase):
    def test_it_says_it_is_not_on_air_twice(self):
        # The blanket "Setup · not on air" badge is gone -- the
        # Dial now lights the one station that IS on the air, so it would
        # be false there. A pressed tile's sheet says "Selected · not on the
        # air"; the preview and the editor still say nothing plays.
        self.assertIn("Selected · not on the air", LIVE)
        self.assertIn("Preview — not on air", BLOCK)
        self.assertIn("Nothing plays and nothing in the queue changes", BLOCK)

    def test_no_control_in_it_can_start_music(self):
        code = re.sub(r"/\*.*?\*/", "", BLOCK, flags=re.S)
        for banned in (">Play", "play_media", "callService", "media_player",
                       "start_station", "station_start"):
            self.assertNotIn(banned, code, banned)

    def test_label_and_term_are_separate_fields(self):
        self.assertIn('id="dial-label"', BLOCK)
        self.assertIn('id="dial-query"', BLOCK)
        self.assertIn('aria-label="Dial label"', BLOCK)
        self.assertIn('aria-label="Station term"', BLOCK)

    def test_all_news_is_named_as_a_type_but_not_offered(self):
        self.assertIn('<option value="news" disabled>', BLOCK)
        self.assertIn("not in this release", BLOCK)

    def test_it_uses_the_screens_words_not_internal_ones(self):
        low = BLOCK.lower()
        for banned in ("jarvis", "music brain", "llm", "ollama", "uri",
                       "station_id", "player_id", "queue_id", "coming soon"):
            self.assertNotIn(banned, low, banned)


class Responsive(unittest.TestCase):
    def test_tiles_fit_two_to_a_row_on_a_phone(self):
        # The rows became tiles -- a fluid grid that never forces
        # a width, two shrinkable columns on a phone, and the sheet's
        # actions wrapping to full width there.
        self.assertIn(".dial-tiles { display:grid; grid-template-columns:repeat(auto-fill, "
                      "minmax(186px, 1fr));", STYLE)
        self.assertIn(".dial-tiles { grid-template-columns:repeat(2, minmax(0, 1fr));", PHONE)
        self.assertIn(".sheet-acts button { flex:1 1 auto; }", PHONE)

    def test_nothing_in_it_can_push_the_page_sideways(self):
        for rule in re.findall(r"\.dial-[\w-]+[^{]*\{[^}]*\}", STYLE):
            self.assertNotRegex(rule, r"min-width:\s*[4-9]\d\dpx", rule)
            self.assertNotRegex(rule, r"white-space:\s*nowrap", rule)
        self.assertIn(".dial-tracks li { overflow-wrap:anywhere; }", STYLE)

    def test_the_console_geometry_is_untouched(self):
        self.assertNotIn(".dial", STYLE[STYLE.index(".console-deck"):
                                        STYLE.index(".console-deck") + 400])


class TheIntegration(unittest.TestCase):
    def test_three_commands_proxy_to_the_backend(self):
        self.assertIn('_command("parlorwave_radio/station_dial",', INIT)
        self.assertIn('_command("parlorwave_radio/station_dial_save",', INIT)
        self.assertIn('_command("parlorwave_radio/station_preview",', INIT)
        self.assertIn('{vol.Required("presets"): list}', INIT)
        self.assertIn('{vol.Required("intent"): dict, vol.Optional("count"): int,',
                      INIT)

    def test_a_preview_does_not_even_refresh_the_coordinator(self):
        block = INIT[INIT.index('_command("parlorwave_radio/station_dial",'):
                     INIT.index('_command("parlorwave_radio/station_preview",') + 400]
        self.assertNotIn("async_request_refresh", block)

    def test_the_client_routes_and_the_longer_wait(self):
        self.assertIn('self._call("GET", "/station/dial")', API)
        self.assertIn('self._call("PUT", "/station/dial", {"presets": presets})', API)
        self.assertIn('"/station/preview"', API)
        self.assertIn("timeout_s=60.0)", API)


if __name__ == "__main__":
    unittest.main()
