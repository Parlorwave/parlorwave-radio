"""The Newsroom screen, pinned at the source, and its two actions executed.

Two halves, like the rest of the panel's coverage.

EXECUTED: the integration's Newsroom commands run against the Home
Assistant harness, because what they do to the backend -- which route,
which method, what payload, and above all what they do NOT touch -- is
ordinary integration behaviour and the whole point of them.

PINNED AT THE SOURCE: the product rules the panel encodes. A browser is
not available here, and rules like "the Newsroom never calls an episode
title a headline" or "no publisher is named in shipped code" are rules
about what this file can possibly render.
"""

import asyncio
import re
import unittest
from pathlib import Path

from harness import FakeResponse, FakeTransport, coordinator_of, make_hass

import custom_components.parlorwave_radio as integration

ROOT = Path(__file__).resolve().parent.parent / "custom_components" / "parlorwave_radio"
PANEL = (ROOT / "panel" / "parlorwave-radio-panel.js").read_text()
NEWSROOM = PANEL[PANEL.index("  _renderNewsroom() {"):PANEL.index("\n  /* --- Station ---")]
DESK = NEWSROOM[NEWSROOM.index("  _renderNewsDesk(b) {"):
                NEWSROOM.index("  _renderNewsWire(b) {")]
STYLE = PANEL[PANEL.index("<style>"):PANEL.index("</style>")]
INIT = (ROOT / "__init__.py").read_text()
API = (ROOT / "api.py").read_text()

# A Newsroom answer of the shape the backend's view model produces.
VIEW = {
    "bulletins": {
        "enabled": True, "configured": True,
        "headline": "Bulletins are on",
        "detail": "The station airs a bulletin every hour at :30, between songs.",
        "source_name": "The Newsroom", "source_name_stored": "The Newsroom",
        "feed_url": "https://ex.org/p.xml",
        "target_minute": 30, "schedule_label": "Every hour at :30",
        "state_label": "Waiting for the next bulletin", "on_air": False,
        "latest": {"source": "The Newsroom", "item_title": "Episode 41",
                   "published_age": "18 minutes ago", "published_age_minutes": 18,
                   "duration": "5:31", "fresh": True},
        "next_window": {"at": "2026-08-14T14:30:00", "clock": "2:30 PM",
                        "label": "Next bulletin around 2:30 PM"},
        "last_result": None, "last_result_at": None, "trouble": None,
    },
    "headlines_in_breaks": {
        "status": "not_configured", "label": "Not configured",
        "detail": "The DJ can mention a news headline in a break, but only "
                  "from a written headline with a named source.",
        "allowed_in_breaks": False, "note": "Switching it on changes nothing.",
    },
    "advanced": {"automation": "watching", "state": "watching"},
}


class NewsTransport(FakeTransport):
    """The harness backend plus the three Newsroom routes."""

    def __init__(self, put_status=200, **kw):
        super().__init__(**kw)
        self.news_put_status = put_status
        self.bulletins = {"enabled": False, "source_name": "",
                          "schedule": {"target_minute": 30},
                          "publisher": {"source": "custom", "custom_feed_url": ""}}

    async def request(self, method, url, json=None, headers=None, timeout=None):
        path = "/" + url.split("//", 1)[-1].split("/", 1)[1].split("?", 1)[0]
        if path == "/news/status":
            self.calls.append({"method": method, "path": path, "json": json,
                               "headers": dict(headers or {})})
            return FakeResponse(200, {"ok": True, "news": {}, "newsroom": VIEW})
        if path == "/settings/bulletins":
            self.calls.append({"method": method, "path": path, "json": json,
                               "headers": dict(headers or {})})
            if self.news_put_status != 200:
                return FakeResponse(self.news_put_status,
                                    {"detail": "bulletins.publisher."
                                               "custom_feed_url must be an "
                                               "http(s) URL"})
            self.bulletins.update(json or {})
            return FakeResponse(200, {"ok": True, "section": "bulletins",
                                      "settings": self.bulletins})
        if path == "/news/feed/test":
            self.calls.append({"method": method, "path": path, "json": json,
                               "headers": dict(headers or {})})
            return FakeResponse(200, {"ok": True, "reachable": True,
                                      "parsed": True, "items": 12,
                                      "item_title": "Episode 41",
                                      "has_enclosure": True,
                                      "published_age_minutes": 18.0,
                                      "display_artist": "The Newsroom"})
        return await super().request(method, url, json=json, headers=headers,
                                     timeout=timeout)


def setup(transport):
    hass, entry = make_hass(transport)
    asyncio.run(integration.async_setup_entry(hass, entry))
    return hass, entry


class FakeConnection:
    """What a websocket handler is allowed to do: answer once, or refuse."""

    def __init__(self):
        self.result = None
        self.error = None

    def send_result(self, _id, result):
        self.result = result

    def send_error(self, _id, code, message):
        self.error = (code, message)


def ws(hass, name, msg=None):
    """Invoke one REGISTERED websocket command exactly as Home Assistant
    would, and return what it answered."""
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


def ws_error(hass, name, msg=None):
    """The refusal a command produced, as (code, message)."""
    try:
        ws(hass, name, msg)
    except AssertionError as exc:
        return str(exc)
    raise AssertionError(f"{name} did not refuse")


# --- the three commands, executed ---------------------------------------------

class NewsroomCommands(unittest.TestCase):
    def test_the_three_commands_are_registered_in_the_product_namespace(self):
        setup(NewsTransport())
        for name in ("news_status", "news_save", "news_test"):
            self.assertIn(f'_command("parlorwave_radio/{name}"', INIT, name)

    def test_reading_the_newsroom_is_one_read_and_nothing_else(self):
        transport = NewsTransport()
        hass, _entry = setup(transport)
        before = len(transport.calls)
        out = ws(hass, "news_status")
        self.assertEqual(out["newsroom"]["bulletins"]["headline"],
                         "Bulletins are on")
        new = transport.calls[before:]
        self.assertEqual([c["path"] for c in new], ["/news/status"])
        self.assertEqual(new[0]["method"], "GET")

    def test_saving_writes_settings_and_touches_nothing_else(self):
        """Pressing Save must not become a network action against a
        publisher, and must never reach Music Assistant or a queue."""
        transport = NewsTransport()
        hass, entry = setup(transport)
        before = len(transport.calls)
        patch = {"enabled": True, "source_name": "The Newsroom",
                 "schedule": {"target_minute": 0},
                 "publisher": {"source": "custom",
                               "custom_feed_url": "https://ex.org/p.xml"}}
        ws(hass, "news_save", {"bulletins": patch})
        wrote = [c for c in transport.calls[before:]
                 if c["path"] == "/settings/bulletins"]
        self.assertEqual(len(wrote), 1)
        self.assertEqual(wrote[0]["method"], "PUT")
        self.assertEqual(wrote[0]["json"], patch)
        for call in transport.calls[before:]:
            self.assertNotIn("/news/fetch", call["path"])
            self.assertNotIn("/news/feed/test", call["path"])

    def test_the_panel_never_second_guesses_a_refusal(self):
        """The backend owns validation. A refusal travels with the
        backend's own words so there is one copy of the rules."""
        transport = NewsTransport(put_status=422)
        hass, entry = setup(transport)
        refusal = ws_error(hass, "news_save", {"bulletins": {"enabled": True}})
        self.assertIn("http(s) URL", refusal)

    def test_testing_a_feed_proves_the_draft_and_writes_nothing(self):
        transport = NewsTransport()
        hass, entry = setup(transport)
        before = len(transport.calls)
        draft = {"enabled": True, "publisher": {"source": "custom",
                                                "custom_feed_url": "https://ex.org/p.xml"}}
        out = ws(hass, "news_test", {"bulletins": draft})
        self.assertTrue(out["ok"])
        new = transport.calls[before:]
        self.assertEqual([c["path"] for c in new], ["/news/feed/test"])
        self.assertEqual(new[0]["json"], {"bulletins": draft})
        # settings are untouched: a test is not a save
        self.assertFalse(transport.bulletins["enabled"])


# --- navigation ----------------------------------------------------------------

class Navigation(unittest.TestCase):
    def test_newsroom_is_a_real_top_level_destination(self):
        self.assertIn(
            'const VIEWS = ["onair", "booth", "newsroom", "station", "settings"];',
            PANEL)
        labels = re.search(r"const VIEW_LABELS = \{(.*?)\}", PANEL, re.S).group(1)
        self.assertIn('newsroom: "Newsroom"', labels)
        self.assertIn("  _renderNewsroom(", PANEL)

    def test_the_newsroom_kept_its_place_when_station_arrived(self):
        """Station was added AFTER the Newsroom, in the navigation's own
        order -- the Newsroom neither moved nor absorbed it."""
        views = re.findall(r'"(\w+)"',
                           re.search(r"const VIEWS = \[[^\]]*\]", PANEL).group(0))
        self.assertEqual(views.index("newsroom") + 1, views.index("station"))
        self.assertLess(PANEL.index("  _renderNewsroom() {"),
                        PANEL.index("  _renderStation() {"))
        for absent in ("Coming soon", "coming soon"):
            self.assertNotIn(absent, PANEL, absent)


# --- the product rules, pinned -------------------------------------------------

class TheNewsroomIsHonest(unittest.TestCase):
    def test_an_episode_title_is_labelled_as_one_never_as_a_headline(self):
        """The title is shown, because a person needs to see the right feed
        was found. It is shown UNDER a tag that says what it is."""
        self.assertIn('class="wire-tag">Episode</span>', NEWSROOM)
        self.assertIn('class="wire-tag">Newest episode</span>', NEWSROOM)
        # The footer that explained the tag is gone; the tag is the
        # whole of the honesty, and it is still there.
        self.assertNotIn("It is not a reported headline", NEWSROOM)
        # and the word "headline" is never used for a bulletin's own title
        wire = NEWSROOM[NEWSROOM.index("  _renderNewsWire(b) {"):
                        NEWSROOM.index("  _renderNewsFeedForm(b) {")]
        self.assertNotIn("Headline", wire)

    def test_headlines_in_breaks_is_kept_but_not_drawn_in_alpha4(self):
        """No textual headline source ships, so the card is not on
        the screen. Its code is kept, still honest, for the release that
        ships one."""
        page = NEWSROOM[NEWSROOM.index("  _renderNewsroom() {"):
                        NEWSROOM.index("  _renderNewsDesk(b) {")]
        self.assertNotIn("_renderHeadlinesCard(", page)
        self.assertIn("  _renderHeadlinesCard(h) {", NEWSROOM)
        self.assertIn("Separate from the bulletins above", NEWSROOM)

    def test_the_desk_does_not_restate_its_own_chips_while_on(self):
        """The line "2 newsrooms. The station airs a bulletin every hour at
        :00 and :30" sat directly above chips saying exactly that."""
        self.assertIn('b.configured && (b.enabled || live) ? ""', DESK)

    def test_the_three_playback_promises_are_stated_where_it_matters(self):
        """The one fear this feature has to answer is 'will it interrupt my
        music'. It is answered on the screen, not in a manual."""
        for promise in ("Bulletins wait for a song to finish.",
                        "A track is never interrupted.",
                        "The music returns on its own."):
            self.assertIn(promise, NEWSROOM, promise)

    def test_a_failed_feed_test_says_the_music_was_not_touched(self):
        self.assertIn("the music was not\n        touched", NEWSROOM)

    def test_the_off_switch_promises_no_contact_at_all(self):
        self.assertIn("never contacts any\n              feed at all", NEWSROOM)

    def test_raw_lifecycle_state_is_only_reachable_under_advanced(self):
        self.assertIn("Advanced diagnostics", NEWSROOM)
        self.assertIn("_renderNewsAdvanced(", NEWSROOM)
        desk = DESK
        for enum in ("boundary_too_late", "bulletin_airing", "refreshing",
                     "armed", "publisher_audio"):
            self.assertNotIn(enum, desk, enum)

    def test_the_sentences_come_from_the_backend_not_from_here(self):
        """The panel renders b.headline / b.detail / b.state_label. If it
        started composing those itself there would be two copies of the
        lifecycle vocabulary, and one of them would be wrong."""
        for field in ("b.headline", "b.detail", "b.state_label",
                      "b.schedule_label", "b.trouble"):
            self.assertIn(field, NEWSROOM, field)


class NoPublisherIsNamed(unittest.TestCase):
    """Nothing a customer installs may assume one newsroom."""

    SHIPPED = [p for p in sorted(ROOT.rglob("*"))
               if p.is_file() and "__pycache__" not in p.parts]
    OUTLETS = re.compile(r"\bNPR\b|\bBBC\b|\bCNN\b|\bReuters\b", re.I)

    def test_no_outlet_appears_anywhere_in_the_shippable_package(self):
        hits = []
        for path in self.SHIPPED:
            try:
                text = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            for n, line in enumerate(text.splitlines(), 1):
                if self.OUTLETS.search(line):
                    hits.append(f"{path.relative_to(ROOT)}:{n}: {line.strip()[:90]}")
        self.assertEqual(hits, [],
                         "a publisher is named in shipped code:\n  " + "\n  ".join(hits))

    def test_the_panel_offers_no_preset_feed(self):
        """The Newsroom asks for an address. It does not hand anybody a
        list of outlets, which would be a distribution decision this
        release has not made."""
        self.assertNotIn("builtin_sources", PANEL)
        # the only thing the panel may ever write as a bulletin source
        patch = PANEL[PANEL.index("  _newsPatch() {"):]
        patch = patch[:patch.index("\n  }")]
        self.assertIn('custom_feed_url', patch)
        self.assertEqual(set(re.findall(r'source:\s*"([a-z_]+)"', patch)),
                         {"custom"})

    def test_no_developer_testbench_is_linked(self):
        self.assertNotIn("/news/ui", PANEL)
        self.assertNotIn("/news/fetch", PANEL)


class TheScheduleIsAMinuteNotAnExpression(unittest.TestCase):
    def test_the_panel_offers_whole_minutes_of_one_hour_and_nothing_else(self):
        """Multi-source widened this from the hour and the half hour, because
        two newsrooms need two different minutes. It is still a MENU: a
        fixed set of minutes of every hour, with no expression to write."""
        block = PANEL[PANEL.index("const NEWS_SCHEDULES ="):]
        block = block[:block.index("}));") + 4]
        self.assertIn("length: 12", block)
        self.assertIn("i * 5", block)
        self.assertIn("Every hour at :", block)
        self.assertNotIn("input", block)

    def test_there_is_no_free_text_schedule(self):
        for absent in ("cron", "Cron", "every 10", "custom schedule"):
            self.assertNotIn(absent, NEWSROOM, absent)


class NewsroomLooksLikeTheRestOfTheProduct(unittest.TestCase):
    def test_it_uses_the_established_room_not_a_new_palette(self):
        self.assertIn("booth-hero", DESK)      # the accepted hero surface
        self.assertIn("stage-glow", DESK)      # the album-derived room light
        for rule in (".news-desk", ".wire", ".news-rules", ".news-test",
                     ".hl-row"):
            self.assertIn(rule, STYLE, rule)

    def test_every_newsroom_colour_is_a_house_or_album_token(self):
        block = STYLE[STYLE.index("--- Newsroom"):STYLE.index("--- notices")]
        literals = re.findall(r"#[0-9a-fA-F]{3,8}", block)
        # the two semantic status colours are allowed to be literal, like
        # the problem badges they match; nothing else may be
        # the two semantic status colours, the warning rail they match, and
        # the house ink that already sits on the accent everywhere else
        self.assertTrue(set(literals) <= {"#7cc47f", "#ffc94d", "#ffa726",
                                          "#1a1206"}, literals)
        self.assertIn("var(--pw-accent)", block)

    def test_it_stacks_on_a_phone(self):
        mobile = STYLE[STYLE.index("max-width: 560px"):]
        for rule in (".news-desk", ".news-rules", ".wire", ".hl-row"):
            self.assertIn(rule, mobile, rule)

    def test_motion_is_dropped_when_motion_is_unwelcome(self):
        reduced = STYLE[STYLE.index("prefers-reduced-motion"):]
        self.assertIn(".wire", reduced)


class PanelStateDoesNotShadowAnEntity(unittest.TestCase):
    """A field named like an entity getter takes the whole panel down.

    The Newsroom's first draft called its state `this._news`. The panel
    already had `get _news()` -- the Booth's "news in breaks" switch -- and
    a class body is strict mode, so assigning a field over a getter-only
    accessor THROWS in the constructor: the custom element never upgrades
    and the entire panel renders as nothing. It was caught by looking at
    the screen; this keeps it caught."""

    GETTERS = set(re.findall(r"^  get (_\w+)\(\)", PANEL, re.M))
    FIELDS = set(re.findall(r"^    this\.(_\w+) =", PANEL, re.M))

    def test_the_entity_getters_are_still_there(self):
        # if this ever empties, the test below stops proving anything
        self.assertIn("_news", self.GETTERS)
        self.assertGreater(len(self.GETTERS), 10)

    def test_no_constructor_field_shadows_a_getter(self):
        clash = sorted(self.GETTERS & self.FIELDS)
        self.assertEqual(clash, [],
                         "these panel fields shadow an accessor of the same "
                         "name and will throw in the constructor: " + repr(clash))

    def test_the_newsroom_state_is_named_for_the_desk(self):
        self.assertIn("this._newsdesk", PANEL)
        self.assertNotIn("this._news =", PANEL)


class TheFormSurvivesALiveScreen(unittest.TestCase):
    def test_the_name_box_seeds_from_what_is_stored_not_from_the_fallback(self):
        """`source_name` is the resolved LABEL and falls back to the feed
        host. Seeding the box from it would show a host the owner never
        typed, and the next Save would write it down as if they had."""
        form = PANEL[PANEL.index("  _newsForm() {"):]
        form = form[:form.index("\n  }")]
        self.assertIn("b.source_name_stored", form)
        self.assertNotIn("b.source_name ||", form)

    def test_the_draft_lives_in_state_not_in_the_dom(self):
        """The Newsroom re-reads itself every 20 seconds. A poll landing
        between two keystrokes must not put the stored value back under the
        cursor, so the boxes write into _newsDraft, exactly as Create a
        Voice does."""
        self.assertIn("this._newsDraft", PANEL)
        self.assertIn("_newsEdit(key, value)", PANEL)
        wiring = PANEL[PANEL.index('["news-name", "source_name"]'):]
        self.assertIn("this._newsEdit(key, input.value)", wiring[:600])

    def test_save_sends_the_source_list_built_in_one_place(self):
        self.assertIn("_newsPatch()", PANEL)
        block = PANEL[PANEL.index("async _saveNews("):]
        self.assertIn("this._newsPatch()", block[:700])

    def test_testing_one_source_proves_what_is_in_its_boxes(self):
        """Test answers for a single source, and for what is typed right
        now -- so an address can be checked BEFORE it is committed."""
        block = PANEL[PANEL.index("async _testNewsSource("):]
        self.assertIn("this._newsSourcePatch(id)", block[:700])
        patch = PANEL[PANEL.index("  _newsSourcePatch(id) {"):]
        patch = patch[:patch.index("\n  }")]
        self.assertIn("custom_feed_url", patch)
        self.assertIn("target_minute", patch)

    def test_removing_the_last_source_also_removes_the_feed(self):
        """An empty list beside a legacy address means 'not migrated yet'
        to the backend, so leaving the old fields would migrate the deleted
        feed straight back on the next read."""
        patch = PANEL[PANEL.index("  _newsPatch() {"):]
        patch = patch[:patch.index("\n  /* Test Feed answers")]
        self.assertIn("if (!sources.length)", patch)
        self.assertIn('custom_feed_url: ""', patch)

    def test_the_newsroom_is_only_polled_while_it_is_on_show(self):
        block = PANEL[PANEL.index("  _maybeRefreshDemandData() {"):]
        block = block[:block.index("  // --- Newsroom")]
        self.assertIn('this._view === "newsroom"', block)


class TheClientIsBounded(unittest.TestCase):
    def test_the_two_write_paths_are_named_and_nothing_else_was_added(self):
        methods = set(re.findall(r"async def (\w*news\w*)\(", API))
        self.assertEqual(methods, {"news_status", "save_news_settings",
                                   "test_news_feed", "news_history"})
        # news_history is a READ. The two writes are still the only two.
        block = API[API.index("async def news_history("):]
        self.assertIn('self._call("GET", f"/news/history', block[:400])

    def test_listen_again_reads_audio_and_cannot_reach_a_queue(self):
        block = API[API.index("async def bulletin_audio("):]
        block = block[:block.index("\n    async def ")]
        self.assertIn('"GET", f"/news/audio/', block)
        for banned in ("queue", "enqueue", "play_media", "insert"):
            self.assertNotIn(banned, block.lower())

    def test_saving_targets_the_settings_route_only(self):
        block = API[API.index("async def save_news_settings("):]
        self.assertIn('"PUT", "/settings/bulletins"', block[:900])
        self.assertNotIn("/news/fetch", block[:900])



class TheSourceListOnScreen(unittest.TestCase):
    """Zero, one and two sources are three different screens, and the
    factory state is the blank one."""

    def test_zero_sources_is_a_blank_state_naming_no_publisher(self):
        block = PANEL[PANEL.index("  _renderNewsFeedForm(b) {"):]
        block = block[:block.index("  _renderNewsSource(r, i, rows) {")]
        self.assertIn("No bulletin sources yet", block)
        self.assertIn("+ Add bulletin source", block)
        # A blank Newsroom must not suggest somebody else's newsroom.
        for publisher in ("NPR", "BBC", "npr.org", "bbc.co.uk"):
            self.assertNotIn(publisher, block, publisher)

    def test_a_source_row_says_what_it_is_and_what_it_last_did(self):
        block = PANEL[PANEL.index("  _renderNewsSource(r, i, rows) {"):]
        block = block[:block.index("  _renderNewsSourceEditor(r) {")]
        self.assertIn("Every hour at :", block)
        self.assertIn("last_aired_label", block)
        self.assertIn("No feed address yet", block)
        for action in ("srctest", "srcedit", "srcoff", "srcdel"):
            self.assertIn(action, block, action)

    def test_two_sources_on_one_minute_say_which_one_wins(self):
        """The backend resolves a shared boundary by configured order. The
        screen has to say so, or the second source looks broken."""
        block = PANEL[PANEL.index("  _renderNewsSource(r, i, rows) {"):]
        block = block[:block.index("  _renderNewsSourceEditor(r) {")]
        self.assertIn("const clash =", block)
        self.assertIn("j < i", block)
        self.assertIn("takes the boundary", block)

    def test_a_disabled_source_is_shown_as_disabled_not_hidden(self):
        block = PANEL[PANEL.index("  _renderNewsSource(r, i, rows) {"):]
        block = block[:block.index("  _renderNewsSourceEditor(r) {")]
        self.assertIn('"Enabled" : "Disabled"', block)
        self.assertIn('src ${r.enabled ? "" : "off"}', block)


class TheHistoryOnScreen(unittest.TestCase):
    def test_an_empty_record_is_an_ordinary_state(self):
        block = PANEL[PANEL.index("  _renderNewsHistory() {"):]
        block = block[:block.index("  _renderHistRow(r) {")]
        self.assertIn("Nothing yet", block)
        self.assertNotIn("error", block.split("h.error")[-1][:200].lower()
                         .replace("could not be read", ""))

    def test_an_aired_row_shows_the_time_it_ACTUALLY_went_out(self):
        block = PANEL[PANEL.index("  _renderHistRow(r) {"):]
        block = block[:block.index("  _histClock(iso) {")]
        self.assertIn("r.aired_at || r.scheduled_for", block)
        self.assertIn("Aired", block)

    def test_a_skip_says_it_was_skipped_and_why(self):
        block = PANEL[PANEL.index("  _renderHistRow(r) {"):]
        block = block[:block.index("  _histClock(iso) {")]
        self.assertIn("Skipped", block)
        self.assertIn("Did not run", block)
        self.assertIn("r.reason", block)

    def test_listen_again_is_offered_only_when_the_backend_says_it_exists(self):
        block = PANEL[PANEL.index("  _renderHistRow(r) {"):]
        block = block[:block.index("  _histClock(iso) {")]
        self.assertIn("r.listen_again", block)
        # and an aired bulletin whose audio is gone SAYS so rather than
        # offering a button that fails
        self.assertIn("No longer available", block)

    def test_listen_again_plays_locally_and_never_reaches_the_house(self):
        block = PANEL[PANEL.index("  async _listenAgain(token) {"):]
        block = block[:block.index("  async _testCalendar() {")]
        self.assertIn("new Audio(", block)
        self.assertIn("URL.createObjectURL", block)
        for banned in ("media_player", "play_media", "queue", "enqueue",
                       "parlorwave_radio/request", "_svc("):
            self.assertNotIn(banned, block,
                             f"listen again reaches {banned}")
        # the screen promises exactly that, where a person reads it
        hist = PANEL[PANEL.index("  _renderNewsHistory() {"):]
        hist = hist[:hist.index("  _renderHistRow(r) {")]
        self.assertIn("this browser only", hist)

    def test_the_browser_never_learns_the_backend(self):
        block = PANEL[PANEL.index("  async _listenAgain(token) {"):]
        block = block[:block.index("  async _testCalendar() {")]
        self.assertIn("BULLETIN_AUDIO_PATH", block)
        self.assertIn("this._authHeaders()", block)
        for banned in ("5005", "http://", "X-Api-Key", "api_key"):
            self.assertNotIn(banned, block, banned)

    def test_a_failed_play_re_reads_rather_than_leaving_a_dead_button(self):
        block = PANEL[PANEL.index("  async _listenAgain(token) {"):]
        block = block[:block.index("  async _testCalendar() {")]
        self.assertIn("this._fetchNewsHistory()", block)

if __name__ == "__main__":
    unittest.main(verbosity=2)
