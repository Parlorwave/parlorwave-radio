"""The Station screen, and the capability it is built on.

Two halves, like the rest of the panel's coverage.

EXECUTED: the integration's side of the catalog capability -- what the
coordinator makes of the backend's health answer, and what the DJ status
sensor publishes for the panel to read. That is ordinary integration code
and its behaviour on a first poll, a missing key and a real answer is the
whole point of it.

PINNED AT THE SOURCE: the product rules the panel encodes. A browser is
not available here, and "a base installation is a supported operating
mode, not a degraded one" and "a control that cannot work is not offered"
are rules about what this file can possibly render.
"""

import asyncio
import re
import unittest
from pathlib import Path

from harness import FakeResponse, FakeTransport, coordinator_of, make_hass

import custom_components.parlorwave_radio as integration
from custom_components.parlorwave_radio.coordinator import ParlorwaveRadioCoordinator
from custom_components.parlorwave_radio.sensor import DjStatusSensor

ROOT = Path(__file__).resolve().parent.parent / "custom_components" / "parlorwave_radio"
PANEL = (ROOT / "panel" / "parlorwave-radio-panel.js").read_text()
STATION = PANEL[PANEL.index("  /* --- Station ---"):PANEL.index("  _renderDiagnostics() {")]
BASE = STATION[STATION.index("  _renderStationFollowing() {"):
               STATION.index("  /* CATALOG MODE.")]
ENABLED = STATION[STATION.index("  _renderStationProgramming() {"):]
# Both modes compose ONE page from shared helpers defined after
# _renderStationProgramming; CATALOG is that renderer's own body, and the
# helpers are sliced by name so a pin knows which part of the page it reads.
CATALOG = STATION[STATION.index("  _renderStationProgramming() {"):
                  STATION.index("  _renderStationDeck() {")]
DECK = STATION[STATION.index("  _renderStationDeck() {"):
               STATION.index("  _renderDeckPlate() {")]
PLATE = STATION[STATION.index("  _renderDeckPlate() {"):
                STATION.index("  _renderProgrammingCard() {")]
PROGRAMMING = STATION[STATION.index("  _renderProgrammingCard() {"):
                      STATION.index("  _renderStationAdvanced(inner) {")]
HOUSE_LINE = STATION[STATION.index("  _stationTruthRows() {"):
                     STATION.index("  /* BASE MODE.")]
REQUEST_LINE = PANEL[PANEL.index("  /* --- The Request Line"):
                     PANEL.index("  /* --- Dial Stations")]
STYLE = PANEL[PANEL.index("<style>"):PANEL.index("</style>")]


# --- the capability, executed through the integration -------------------------

class CatalogTransport(FakeTransport):
    """The harness backend with a settable features.catalog."""

    def __init__(self, catalog=None, **kw):
        super().__init__(**kw)
        self.catalog = catalog

    async def request(self, method, url, json=None, headers=None, timeout=None):
        path = "/" + url.split("//", 1)[-1].split("/", 1)[1].split("?", 1)[0]
        if path == "/health/problems":
            self.calls.append({"method": method, "path": path, "json": json,
                               "headers": dict(headers or {})})
            features = {"observer": {"running": True}}
            if self.catalog is not None:
                features["catalog"] = self.catalog
            return FakeResponse(200, {"ok": True, "problems": [], "fatal": [],
                                      "features": features})
        return await super().request(method, url, json=json, headers=headers,
                                     timeout=timeout)


def setup(transport):
    hass, entry = make_hass(transport)
    asyncio.run(integration.async_setup_entry(hass, entry))
    return hass, entry


class TheCoordinatorRepublishesTheBackendsVerdict(unittest.TestCase):
    def test_a_usable_catalog_arrives_intact(self):
        hass, entry = setup(CatalogTransport(
            {"usable": True, "track_count": 3120, "minimum_tracks": 5}))
        cat = coordinator_of(hass, entry).music_catalog(
            coordinator_of(hass, entry).data)
        self.assertEqual({"usable": True, "track_count": 3120,
                          "minimum_tracks": 5, "known": True}, cat)

    def test_no_catalog_is_reported_as_no_catalog_not_as_unknown(self):
        hass, entry = setup(CatalogTransport(
            {"usable": False, "track_count": 0, "minimum_tracks": 5}))
        cat = coordinator_of(hass, entry).music_catalog(
            coordinator_of(hass, entry).data)
        self.assertFalse(cat["usable"])
        self.assertTrue(cat["known"])

    def test_a_backend_that_has_not_answered_yet_is_not_treated_as_capable(self):
        """Before the first health answer -- and on an older service that
        does not publish the key at all -- the honest report is 'no, and
        we do not know'. A control offered on a guess is the failure this
        whole contract exists to end."""
        for data in ({}, {"health": None}, {"health": {"features": {}}},
                     {"health": {"features": {"catalog": "yes"}}}):
            cat = ParlorwaveRadioCoordinator.music_catalog(data)
            self.assertFalse(cat["usable"], data)
            self.assertFalse(cat["known"], data)

    def test_the_integration_never_decides_this_for_itself(self):
        """No second opinion anywhere: not from a path, not from a file,
        not from whether a station happens to be running."""
        src = "".join((ROOT / name).read_text() for name in
                      ("coordinator.py", "sensor.py", "__init__.py", "api.py"))
        for banned in ("music_index", "/mnt/", "os.path.exists", "Path(",
                       "glob(", "listdir"):
            self.assertNotIn(banned, src, banned)


class TheSensorPublishesItForThePanel(unittest.TestCase):
    def test_the_dj_status_sensor_carries_the_catalog_beside_the_observer(self):
        hass, entry = setup(CatalogTransport(
            {"usable": True, "track_count": 40, "minimum_tracks": 5}))
        attrs = DjStatusSensor(coordinator_of(hass, entry),
                               entry.entry_id).extra_state_attributes
        self.assertEqual(True, attrs["catalog"]["usable"])
        self.assertEqual(40, attrs["catalog"]["track_count"])
        self.assertIn("observer", attrs)

    def test_it_is_published_even_when_there_is_no_catalog(self):
        """A UI must be able to tell 'no catalog' from 'not answered'; a
        key that vanishes says neither."""
        hass, entry = setup(CatalogTransport(
            {"usable": False, "track_count": 0, "minimum_tracks": 5}))
        attrs = DjStatusSensor(coordinator_of(hass, entry),
                               entry.entry_id).extra_state_attributes
        self.assertEqual({"usable": False, "track_count": 0,
                          "minimum_tracks": 5, "known": True}, attrs["catalog"])


class TheServiceRefusalReachesAPerson(unittest.TestCase):
    def test_a_sentence_the_backend_wrote_travels_verbatim(self):
        """Start Radio on an install with no catalog. The refusal is
        already written for a person; prefixing 'start radio refused:'
        onto a finished sentence would undo that work."""
        src = (ROOT / "__init__.py").read_text()
        block = src[src.index("    async def start_radio(call"):
                    src.index("    def _feedback(action")]
        self.assertIn('result.get("message")', block)
        self.assertLess(block.index('result.get("message")'),
                        block.index("start radio refused:"))


# --- the product rules, pinned -------------------------------------------------

class StationIsARealDestination(unittest.TestCase):
    def test_it_is_in_the_navigation_between_newsroom_and_settings(self):
        views = re.findall(r'"(\w+)"',
                           re.search(r"const VIEWS = \[[^\]]*\]", PANEL).group(0))
        self.assertEqual(["onair", "booth", "newsroom", "station", "settings"],
                         views)
        labels = re.search(r"const VIEW_LABELS = \{(.*?)\}", PANEL, re.S).group(1)
        self.assertIn('station: "Station"', labels)

    def test_the_shell_routes_to_it(self):
        self.assertIn('this._view === "station" ? this._renderStation()', PANEL)

    def test_it_uses_the_house_language_the_other_screens_use(self):
        """Same room: the hero, the glow, the cards. A new screen that
        invented its own vocabulary would read as a bolt-on.

        The hero is the Dial stage, and where the eyebrow, name and
        description were it carries the house's own approved emblem and the
        console's engraved plate -- drawn by the same pure helpers On Air
        uses, named by the on-air identity, in containers of its own (never
        the console badge's id or class, whose handlers would attach)."""
        for shared in ('class="booth-hero station-desk"', 'class="stage-glow"',
                       'class="card'):
            self.assertIn(shared, STATION, shared)
        self.assertIn('<img class="deck-emblem" src="${PW_EMBLEM_URL}" alt="" draggable="false">',
                      PLATE)
        self.assertIn("this._renderStationPlate(name, fit)", PLATE)
        self.assertIn("const name = this._stationIdentityName();", PLATE)
        for banned in ('id="console-badge"', 'class="console-badge', "_plateFit"):
            self.assertNotIn(banned, STATION, banned)


class WhichModeIsShownIsNeverGuessed(unittest.TestCase):
    def test_the_only_input_is_the_backends_published_capability(self):
        chooser = STATION[STATION.index("  _renderStation() {"):
                          STATION.index("  _stationTruthRows() {")]
        self.assertIn("this._catalog().usable", chooser)
        reader = STATION[STATION.index("  _catalog() {"):
                         STATION.index("  _stationTruthRows() {")]
        self.assertIn("this._djStatus.attributes.catalog", reader)

    def test_an_unanswered_capability_shows_the_base_screen(self):
        reader = STATION[STATION.index("  _catalog() {"):
                         STATION.index("  _stationTruthRows() {")]
        self.assertIn("return { usable: false, track_count: 0, known: false };",
                      reader)

    def test_nothing_else_is_ever_read_as_a_catalog_signal(self):
        """Not a filesystem path, not a music_index, not 'a station is
        active', not unrelated health state."""
        for banned in ("music_index", "/mnt/", "LIBRARY_SOURCE", "play_history"):
            self.assertNotIn(banned, PANEL, banned)
        chooser = STATION[STATION.index("  _renderStation() {"):
                          STATION.index("  _catalog() {")]
        for banned in ("this._station", "problems", "observer"):
            self.assertNotIn(banned, chooser, banned)


class BaseModeIsASupportedMode(unittest.TestCase):
    def test_it_says_where_music_comes_from_and_what_to_do(self):
        # The hero names the STATION (on its plate), not the
        # source. What Music Assistant is doing is the house line under the
        # plate -- and on a fresh install, where nothing plays yet, it says
        # what to do there, visibly, rather than only inside the collapsed
        # Advanced. Where the music comes from is still said, in its own
        # section (Advanced > Music source).
        self.assertIn("Watching for playback", HOUSE_LINE)
        self.assertIn("Start an album, ", HOUSE_LINE)
        self.assertIn('"playlist, station, or queue in Music Assistant."', HOUSE_LINE)
        self.assertIn("_stationName()", BASE)
        self.assertIn("<h2>Music source</h2>", BASE)
        self.assertIn("ParlorWave follows it", BASE)
        # The things Parlorwave puts around the record are the rows of the
        # Programming card both modes render.
        self.assertIn('<div class="label">DJ breaks</div>', PROGRAMMING)
        self.assertIn('<div class="label">News bulletins</div>', PROGRAMMING)
        self.assertIn("${this._renderAnnouncementsCard()}", PROGRAMMING)
        self.assertIn("${this._renderProgrammingCard()}", BASE)

    def test_it_states_that_music_assistant_keeps_the_queue(self):
        # The sentence is not in the hero's rows but in its own note under
        # Advanced > Music source, phrases kept.
        note = BASE[BASE.index("st-queue-note"):]
        note = note[:note.index("</div>")]
        self.assertIn("Music Assistant owns the queue", note)
        # NOT "never reorders what you queued". That was absolute and it was
        # not true -- Parlorwave inserts a finite break, inserts a bulletin,
        # and plays a song the listener asked for. The rule it was reaching
        # for is the narrower one.
        self.assertNotIn("never reorders", STATION)
        self.assertIn("preserves your music order", note)
        self.assertIn("finite DJ and news elements", note)

    def test_its_live_lines_come_from_published_state_only(self):
        rows = STATION[STATION.index("  _stationTruthRows() {"):
                       STATION.index("  /* BASE MODE.")]
        for source in ("jvAttrs.observer", "jvAttrs.outputs_enabled",
                       "this._player"):
            self.assertIn(source, rows, source)
        self.assertIn("Following Music Assistant", rows)

    def test_it_is_not_written_as_a_fallback_or_an_apology(self):
        for banned in ("degraded", "limited", "unfortunately", "sorry",
                       "not supported", "Upgrade", "upgrade", "unavailable mode",
                       "basic mode", "Coming soon", "coming soon"):
            self.assertNotIn(banned, STATION, banned)

    def test_the_screen_is_not_empty_it_says_what_parlorwave_contributes(self):
        """A supported mode gets a screen with something ON it. Three
        real contributions, each pointing at the screen that owns it --
        and the pointer is a DOOR, not an instruction. The panel owns all
        five screens, so naming one in a sentence and leaving the reader
        to go and find it is work this component can do in one press."""
        # The contributions are the Programming card's rows, which
        # both modes render; each points at the screen that owns it, and
        # the DJ row's door to On Air (where its switch is) says so when
        # the DJ is off.
        self.assertIn('<section class="card prog-card" aria-label="Programming">',
                      PROGRAMMING)
        for contribution in ('<div class="label">DJ breaks</div>',
                             '<div class="label">News bulletins</div>',
                             "${this._renderAnnouncementsCard()}"):
            self.assertIn(contribution, PROGRAMMING, contribution)
        for door in ('this._go("booth")', 'this._go("newsroom")',
                     'this._go("onair", "On Air")'):
            self.assertIn(door, PROGRAMMING, door)
        for mode in (BASE, CATALOG):
            self.assertIn("${this._renderProgrammingCard()}", mode)

    def test_the_unavailable_tools_are_neither_offered_nor_listed(self):
        # alpha.4: the "Not in this release"
        # roadmap card is gone. Its list contradicted the working Request
        # Line and the endless Dial, and no shipped install has the catalog
        # it talked about. Nothing that needs one is offered, and nothing
        # sends anybody looking for one.
        self.assertNotIn("Not in this release", BASE)
        self.assertNotIn("is not part of this release", BASE)
        self.assertNotIn("Needs a local catalog", BASE)
        self.assertNotIn("This installation does not have one", BASE)
        for control in ('id="start-radio"', 'id="request-go"',
                        'id="request-input"', "_toggleRow(", "_selectRow("):
            self.assertNotIn(control, BASE, control + " is offered in base mode")

    def test_no_public_catalog_setup_is_promised(self):
        """This release ships no importer, no scanner and no Lidarr. A
        screen that told a person how to get a catalog would be promising
        one."""
        for banned in ("Lidarr", "lidarr", "import", "Import", "scan", "Scan",
                       "/mnt", "music_index", "folder", "Folder", "directory"):
            self.assertNotIn(banned, STATION, banned)


class CatalogModeOffersTheAutonomousTools(unittest.TestCase):
    def test_every_moved_control_is_here(self):
        for control in ('id="start-radio"', 'id="request-input"',
                        'id="request-go"', '_toggleRow("endless"',
                        '_selectRow("feel"', '_toggleRow("same-artist"',
                        '_selectRow("same-artist-freq"'):
            self.assertIn(control, ENABLED, control)

    def test_none_of_them_is_duplicated_on_another_screen(self):
        """Two screens with the same setting eventually disagree about
        what it means."""
        for control in ('id="start-radio"', 'id="request-input"',
                        'id="request-go"', '_toggleRow("endless"',
                        '_selectRow("feel"', '_toggleRow("same-artist"'):
            self.assertEqual(1, PANEL.count(control), control)

    def test_the_active_station_is_described_from_station_data(self):
        for source in ("this._station", "sa.refill_count", "sa.tracks_generated",
                       "sa.started"):
            self.assertIn(source, ENABLED, source)

    def test_it_promises_only_what_start_radio_actually_does(self):
        """The one invariant a person must be able to trust: pressing it
        never interrupts the song that is playing."""
        self.assertIn("The song playing now is never interrupted", ENABLED)
        self.assertIn("only what comes after it", ENABLED)

    def test_the_preferences_state_when_they_apply(self):
        self.assertIn("next\n        batch of tracks the station picks", ENABLED)
        self.assertIn("nothing already queued or playing", ENABLED)
        self.assertIn("music you queued yourself in Music\n        Assistant",
                      ENABLED)

    def test_this_screen_is_not_a_second_on_air(self):
        """No duplicate player, no duplicate queue or lyrics, no break
        controls. On Air is the live radio; Station is where the music
        comes from."""
        for banned in ("_renderDrawer", "drawer-lyrics", "drawer-queue",
                       'class="art', "progress-fill", "_renderLastBreak",
                       "thumb-up", 'break/force', '_toggleRow("dj"',
                       '_numberRow("cadence"', '_selectRow("break-length"'):
            self.assertNotIn(banned, STATION, banned)


class Responsive(unittest.TestCase):
    def test_the_stations_own_rules_exist_at_all_three_widths(self):
        self.assertIn(".station-desk", STYLE)
        tablet = STYLE[STYLE.index("@media (max-width: 900px)"):
                       STYLE.index("@media (max-width: 560px)")]
        self.assertIn(".station-desk", tablet)
        phone = STYLE[STYLE.index("@media (max-width: 560px)"):]
        self.assertIn(".station-desk", phone)
        # alpha.4: the roadmap list and its styles are gone entirely
        self.assertNotIn(".st-off", STYLE)
        # The Dial's tiles have rules of their own at 360, in the
        # existing narrow block after the console badge's
        narrow = STYLE[STYLE.index("@media (max-width: 390px) {\n          .console-badge { width:177px; }"):]
        narrow = narrow[:narrow.index("\n        }")]
        self.assertIn(".preset {", narrow)

    def test_five_sections_still_fit_on_one_line_on_a_phone(self):
        """A section label that wraps to two lines reads as two sections.
        Station made the navigation five wide; the phone rule was
        tightened to match."""
        phone = STYLE[STYLE.index("@media (max-width: 560px)"):]
        nav = phone[phone.index("nav button {"):]
        self.assertIn("white-space:nowrap", nav[:nav.index("}")])

    def test_nothing_on_this_screen_can_push_the_page_sideways(self):
        for rule in (".st-detail", ".st-row"):
            block = STYLE[STYLE.index(rule + " {"):]
            block = block[:block.index("}")]
            self.assertNotRegex(block, r"min-width:\s*[4-9]\d\dpx", rule)
        self.assertIn(".st-detail { color:var(--pw-muted); overflow-wrap:anywhere; }",
                      STYLE)
        # The text wraps rather than widening its box, and its grids
        # let a column shrink.
        for rule in (".preset-label", ".preset-term", ".air-text"):
            block = STYLE[STYLE.index(rule + " {"):]
            self.assertIn("overflow-wrap:anywhere", block[:block.index("}")], rule)
        for rule in (".sheet-grid", ".prog-row", ".st-adv-body"):
            block = STYLE[STYLE.index(rule + " {"):]
            block = block[:block.index("}")]
            self.assertIn("minmax(0, 1fr)", block, rule)
            self.assertNotRegex(block, r"min-width:\s*[4-9]\d\dpx", rule)


class Accessibility(unittest.TestCase):
    def test_the_two_modes_label_their_regions(self):
        # One page in both modes, so one set of labelled regions --
        # the Dial stage, the Request Line, Programming -- drawn by the same
        # helpers from both mode renderers (only Advanced differs).
        self.assertIn('<section class="booth-hero station-desk" aria-label="The Dial">', DECK)
        self.assertIn('<section class="card rl-card" aria-label="Request Line">', REQUEST_LINE)
        self.assertIn('<section class="card prog-card" aria-label="Programming">', PROGRAMMING)
        for mode in (BASE, CATALOG):
            for helper in ("${this._renderStationDeck()}", "${this._renderRequestLineCard()}",
                           "${this._renderProgrammingCard()}", "${this._renderStationAdvanced(`"):
                self.assertIn(helper, mode, helper)

    def test_state_is_never_carried_by_colour_alone(self):
        """The live dot has a word beside it, always."""
        rows = STATION[STATION.index("  _stationTruthRows() {"):
                       STATION.index("  /* BASE MODE.")]
        self.assertIn('class="st-dot ${this._esc(r.tone)}" aria-hidden="true"', rows)
        self.assertIn('class="st-label"', rows)
        # The lamps -- the on-air line's, a lit tile's, a sheet chip's
        # -- are decoration beside a word, never the only signal.
        lamps = re.findall(r'<span class="(?:air|preset)-lamp"[^>]*>', STATION)
        self.assertTrue(lamps)
        for lamp in lamps:
            self.assertIn('aria-hidden="true"', lamp, lamp)
        # Starting, Queued (a handover station waiting behind kept songs) or
        # On air: always a word beside the lamp.
        self.assertIn('<span class="air-word">${starting ? "Starting" : waiting ? "Queued" : "On air"}</span>', STATION)
        self.assertIn("No Dial Station running", STATION)

    def test_decoration_is_hidden_and_controls_are_labelled(self):
        self.assertIn('class="stage-glow" aria-hidden="true"', STATION)
        self.assertIn('aria-label="Start a station from this song"', ENABLED)
        self.assertIn('aria-label="Music request"', ENABLED)
        for icon in re.findall(r'<span class="st-(?:icon|offmark)"[^>]*>', STATION):
            self.assertIn('aria-hidden="true"', icon, icon)


class NothingInternalReachesTheScreen(unittest.TestCase):
    def test_no_internal_or_retired_product_name(self):
        low = STATION.lower()
        for banned in ("jarvis", "music brain", "musicbrain", "music_brain"):
            self.assertNotIn(banned, low, banned)

    def test_no_raw_identifier_is_turned_into_text(self):
        """`obs.queue_id` is read ONCE, and only as a yes/no -- is the
        observer attached to a queue at all. Nothing here renders an id:
        the speaker is named by its friendly name, exactly as On Air
        names it."""
        self.assertIn("obs.running\n        ? (obs.queue_id", STATION)
        self.assertIn("(p.attributes.friendly_name || p.entity_id)", STATION)
        for banned in ("this._esc(obs.queue_id", "${obs.queue_id",
                       "detail: obs.queue_id", "station_id", "player_id"):
            self.assertNotIn(banned, STATION, banned)



class TheStationReadsAsAStation(unittest.TestCase):
    """A bounded reorganisation, not a redesign. The sections
    are the ones a listener would look for, unavailable things say WHY,
    and nothing implies a local catalog is required."""

    def test_the_sections_are_in_station_order(self):
        # The Dial stage, the Request Line,
        # Programming, then Advanced, in both modes; inside the stage, the
        # plate and the two status lines, the tiles, then the one sheet;
        # inside base mode's Advanced, where the music comes from, what a
        # Dial station is, and what is not in this release.
        for mode in (BASE, CATALOG):
            order = ["${this._renderStationDeck()}", "${this._renderRequestLineCard()}",
                     "${this._renderProgrammingCard()}", "${this._renderStationAdvanced(`"]
            at = [mode.index(x) for x in order]
            self.assertEqual(at, sorted(at), "the station's sections are out of order")
        order = ["${this._renderDeckPlate()}", "${this._stationTruthRows()}",
                 "${this._renderOnAirStationCard()}", "${this._renderDialStationsCard()}",
                 "this._renderAirForm(this._liveData())"]
        at = [DECK.index(x) for x in order]
        self.assertEqual(at, sorted(at), "the Dial stage is out of order")
        # alpha.4: base mode's Advanced is Music source alone.
        self.assertIn("<h2>Music source</h2>", BASE)
        self.assertNotIn("About the Dial", BASE)

    def test_both_modes_name_the_same_surfaces(self):
        """Each mode having its own vocabulary made Station read as
        two screens: the base screen listed station feel as one bullet in a
        list of things that do not work, while the catalog screen called
        the same thing 'How it programs'. One name, in both modes, in the
        same place in the reading order.

        Every surface but Advanced is the same helper in both
        modes, and Advanced names station feel by the one name -- the
        catalog screen's section, base mode's row of what is not in this
        release."""
        # alpha.4: base mode no longer names station feel at all -- it is a
        # catalog-mode control, and the roadmap row that named it is gone
        self.assertNotIn("Station feel", BASE)
        self.assertIn("<h2>Station feel</h2>", CATALOG)
        self.assertIn("<summary>Advanced</summary>", STATION)
        for helper in ("${this._renderStationDeck()}", "${this._renderRequestLineCard()}",
                       "${this._renderProgrammingCard()}", "${this._renderStationAdvanced(`"):
            self.assertIn(helper, BASE, helper)
            self.assertIn(helper, CATALOG, helper)

    def test_nothing_is_named_twice_across_the_two_sections(self):
        """A screen that says the same thing in two places invites the
        reader to wonder what the difference is. alpha.4: base mode names
        station feel and artist rotation nowhere (they are catalog-mode
        controls); catalog mode gives them one section."""
        self.assertEqual(0, BASE.count("Station feel"))
        self.assertEqual(0, BASE.lower().count("artist rotation"))
        self.assertEqual(1, CATALOG.count("<h2>Station feel</h2>"))

    def test_station_feel_is_not_offered_in_base_mode(self):
        """While Music Assistant chooses the music there is nothing for
        station feel to act on, so base mode renders no control for it --
        the whole-screen ban on _selectRow / _toggleRow still holds."""
        self.assertIn("it chooses the music and keeps the queue", BASE)
        for control in ("_selectRow(", "_toggleRow(", "<select", "<input"):
            self.assertNotIn(control, BASE, control)

    def test_music_source_names_only_the_source_in_use(self):
        """alpha.4: Music source says where the music comes from -- Music
        Assistant, in use -- and no longer advertises an optional local
        catalog that no shipped install has and this release cannot build."""
        block = BASE[BASE.index("<h2>Music source</h2>"):]
        self.assertIn("In use", block)
        self.assertIn("Music Assistant", block)
        self.assertNotIn("A local ParlorWave catalog", block)
        self.assertNotIn("Optional", block)

    def test_the_source_rows_say_who_owns_the_music_and_the_queue(self):
        block = BASE[BASE.index("<h2>Music source</h2>"):]
        self.assertIn("chooses the music and keeps the queue", block)
        self.assertIn("ParlorWave follows it", block)

    def test_the_station_names_itself_when_it_has_a_name(self):
        block = STATION[STATION.index("  _stationName() {"):
                        STATION.index("  _stationTruthRows() {")]
        for empty in ("none", "unknown", "unavailable"):
            self.assertIn(empty, block, empty)
        self.assertIn("Following Music Assistant", BASE)

    def test_requests_are_explained_rather_than_merely_absent(self):
        # A request for a STATION is offered in both modes -- the Request
        # Line card -- and says what it is and that it goes in after the
        # song playing now.
        self.assertIn("${this._renderRequestLineCard()}", BASE)
        self.assertRegex(REQUEST_LINE, r"added after the song playing\s+now")

    def test_the_queue_note_is_on_the_screen_not_only_in_a_row(self):
        # A sentence of its own, never only a row; it sits with the hero's
        # rows in Advanced > Music source.
        self.assertIn("st-queue-note", BASE)
        note = BASE[BASE.index("st-queue-note"):]
        note = note[:note.index("</div>")]
        self.assertIn("Music Assistant owns the queue.", note)
        self.assertIn("ParlorWave preserves your music order", note)
        self.assertNotIn("owns the queue", HOUSE_LINE)


class StationIdentityLivesOnTheStationScreen(unittest.TestCase):
    """The Station Name control belongs to the screen called Station.

    Relocated here from Settings. It is the SAME
    card, the same control ids and the same save path -- one render
    helper, called from both Station modes, so the two can never drift --
    and it appears in BOTH modes because a station has a name whether or
    not it programs its own music."""

    # The card is the name sheet under the plate of the Dial
    # stage -- one helper, which both modes render, behind the plate's Edit.
    def test_the_identity_card_renders_in_following_mode(self):
        self.assertIn('${this._stNameOpen ? this._renderStationIdentityCard() : ""}', DECK)
        self.assertIn("${this._renderStationDeck()}", BASE)

    def test_the_identity_card_renders_in_programming_mode(self):
        self.assertIn('${this._stNameOpen ? this._renderStationIdentityCard() : ""}', DECK)
        self.assertIn("${this._renderStationDeck()}", CATALOG)

    def test_settings_no_longer_renders_a_second_copy(self):
        settings = PANEL[PANEL.index("  _renderSettings() {"):
                         PANEL.index("  _renderStationIdentityCard() {")]
        self.assertNotIn("_renderStationIdentityCard", settings,
                         "Station Name is on two screens at once")

    def test_the_save_contract_is_unchanged(self):
        # the one write path, and the one key it writes
        save = PANEL[PANEL.index("  async _saveStationIdentity() {"):
                     PANEL.index("  _resetStationIdentity() {")]
        self.assertIn('parlorwave_radio/station_save', save)
        self.assertIn("station: { identity: { name: want } }", save)
        # save, reset and Enter still bind to the same control ids
        self.assertIn('on("station-name-save", () => this._saveStationIdentity());',
                      PANEL)
        self.assertIn('on("station-name-reset", () => this._resetStationIdentity());',
                      PANEL)
        self.assertIn('this._saveStationIdentity();', PANEL)

    def test_the_station_screen_reads_the_stored_name_on_demand(self):
        # the demand fetch follows the card to its new screen, and never
        # refreshes over a half-typed draft
        demand = PANEL[PANEL.index("  _maybeRefreshDemandData() {"):
                       PANEL.index("  async _fetchSpeakers() {")]
        self.assertIn('this._view === "station" && !this._stationDirty', demand)
        self.assertIn("_fetchStationSettings", demand)


class AnnouncementsCard(unittest.TestCase):
    """Announcements on the Station tab: one card, both modes, the
    documented settings, and the operator's words -- never lifecycle
    jargon."""

    CARD = PANEL[PANEL.index("  _renderAnnouncementsCard() {"):
                 PANEL.index("  _renderFaceplateSetting() {")]

    def test_the_card_renders_in_both_station_modes(self):
        # A row of the Programming card, which both modes render
        # below the Dial stage -- so still beneath Identity.
        self.assertIn("${this._renderAnnouncementsCard()}", PROGRAMMING)
        self.assertIn("this._renderStationIdentityCard()", DECK)
        for mode in (BASE, CATALOG):
            self.assertIn("${this._renderProgrammingCard()}", mode)
            self.assertLess(mode.index("${this._renderStationDeck()}"),
                            mode.index("${this._renderProgrammingCard()}"))

    def test_the_three_settings_and_their_save_path(self):
        for control in ('id="announce-enabled"', 'id="announce-smart"',
                        'id="announce-late"'):
            self.assertIn(control, self.CARD)
        save = PANEL[PANEL.index("  async _saveAnnouncementsSetting(patch) {"):
                     PANEL.index("  async _fetchReadiness() {")]
        self.assertIn('parlorwave_radio/station_save', save)
        self.assertIn("station: { announcements: patch }", save)
        # each control writes exactly its own key
        self.assertIn("{ enabled: !d.enabled }", PANEL)
        self.assertIn("{ smart_rewriting: !d.smart_rewriting }", PANEL)
        self.assertIn("{ late_air_minutes: Number(lateSel.value) }", PANEL)

    def test_upcoming_and_last_aired_have_their_sections(self):
        for section in ("Coming up", "Last aired", "Didn't air"):
            self.assertIn(section, self.CARD)
        # mode is a label a person can read, and Exact is its own word
        self.assertIn('"Exact"', PANEL)
        self.assertIn('"Smart"', PANEL)

    def test_no_internal_lifecycle_jargon_reaches_the_operator(self):
        status = PANEL[PANEL.index("  _announceStatus(o) {"):
                       PANEL.index("  _announceModeWord(o) {")]
        # every committed:* row state resolves to a sentence, with a
        # catch-all before the raw state could ever show
        for word in ("Scheduled", "Aired", "Expired unaired",
                     "Waiting for a song change", "Queued to air",
                     "On the air", "Preparing"):
            self.assertIn(word, status)
        for jargon in ("tombstone", "occurrence_id", "payload_sha",
                       "reconcile"):
            self.assertNotIn(jargon, self.CARD)

    def test_the_screen_reads_announcements_on_demand(self):
        demand = PANEL[PANEL.index("  _maybeRefreshDemandData() {"):
                       PANEL.index("  async _fetchSpeakers() {")]
        self.assertIn("_fetchAnnouncements", demand)
        fetch = PANEL[PANEL.index("  async _fetchAnnouncements("):
                      PANEL.index("  async _saveAnnouncementsSetting(")]
        self.assertIn('this._ws("parlorwave_radio/announcements")', fetch)

    def test_history_and_queue_name_announcements(self):
        self.assertIn('announcement: ["📣", "Announcement"]', PANEL)
        self.assertIn('announcement: "📣"', PANEL)
        # Air Check history shows the Exact/Smart/deterministic origin
        self.assertIn('exact: "Exact", smart: "Smart"', PANEL)

    def test_everything_shown_is_escaped(self):
        # operator payloads and spoken copy are untrusted text
        for interpolation in ("o.payload", "o.spoken_text"):
            self.assertNotIn("${" + interpolation, self.CARD.replace(
                "${this._esc(o.payload", "").replace(
                "${this._esc(o.spoken_text", ""))

    def test_smart_rewriting_is_marked_experimental_and_off_by_default(self):
        # Plain ANNOUNCE airs deterministic copy unless an operator opts
        # in; the control stays visible but says what it is
        self.assertIn('Smart rewriting <span class="badge">Experimental</span>',
                      self.CARD)
        self.assertIn("Off by default.", self.CARD)
        self.assertIn('id="announce-smart"', self.CARD)

    def test_a_held_announcements_state_is_said_plainly(self):
        # an unreadable record or settings document holds announcements
        # closed; the card says so instead of looking merely empty
        self.assertIn("d.store_problem || d.config_problem", self.CARD)
        self.assertIn("nothing will air until it is repaired or restored",
                      self.CARD)
        self.assertIn("announcements are held off until they are saved "
                      "again", self.CARD)

    def test_an_unconfirmed_airing_is_described_honestly(self):
        # Handed to the player but never seen on air (a short line can play
        # between two checks): not replayed, and neither "Aired" nor
        # "Didn't air" -- the card says exactly what is known.
        status = PANEL[PANEL.index("  _announceStatus(o) {"):
                       PANEL.index("  _announceModeWord(o) {")]
        self.assertIn('o.expire_reason === "unconfirmed_after_insert"',
                      status)
        self.assertIn("Sent to air, playback not confirmed", status)
        self.assertLess(status.index("unconfirmed_after_insert"),
                        status.index('"Expired unaired"'))
        # listed with what was sent to air, never under "Didn't air"
        self.assertIn('|| o.expire_reason === "unconfirmed_after_insert"',
                      self.CARD)
        self.assertIn("filter((o) => !sentToAir(o))", self.CARD)


if __name__ == "__main__":
    unittest.main()
