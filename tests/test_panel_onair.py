"""The On Air screen, pinned at the source.

The panel is a browser component and its behaviour under a real browser is
checked by ha/tests/test_palette.mjs (the palette maths, executed) and by
looking at it. What this file holds is the product contract that a later
edit could quietly break without any test noticing: what the navigation is
called, that the room colour comes from the artwork and always has a floor,
that the station's state is described in broadcast words derived from real
backend state rather than invented, that the structured problems from the
backend stay visible and are not re-diagnosed here, and that nothing
internal -- a voice id, an old product name -- reaches a customer's eyes.
"""

import re
import unittest
from pathlib import Path

PANEL = (Path(__file__).resolve().parent.parent / "custom_components"
         / "parlorwave_radio" / "panel" / "parlorwave-radio-panel.js")
SRC = PANEL.read_text()
STYLE = SRC[SRC.index("<style>"):SRC.index("</style>")]


class Navigation(unittest.TestCase):
    def test_the_product_sections_are_on_air_booth_newsroom_station_settings(self):
        self.assertIn(
            'const VIEWS = ["onair", "booth", "newsroom", "station", "settings"];',
            SRC)
        labels = re.search(r"const VIEW_LABELS = \{(.*?)\}", SRC, re.S).group(1)
        for label in ('onair: "On Air"', 'booth: "Booth"',
                      'newsroom: "Newsroom"', 'station: "Station"',
                      'settings: "Settings"'):
            self.assertIn(label, labels, label)

    def test_no_unfinished_section_is_advertised(self):
        """An empty tab would be a promise, not a product: a section
        arrives with its screen. Every section in the navigation now has
        one, so the rule is checked against the navigation itself rather
        than by naming the one that was missing."""
        for absent in ("Coming soon", "coming soon"):
            self.assertNotIn(absent, SRC, absent)
        views = re.findall(r'"(\w+)"',
                           re.search(r"const VIEWS = \[[^\]]*\]", SRC).group(0))
        renders = {"onair": "_renderOnAir(", "booth": "_renderBooth(",
                   "newsroom": "_renderNewsroom(", "station": "_renderStation(",
                   "settings": "_renderDiagnostics("}
        for view in views:
            self.assertIn(renders[view], SRC, view)

    def test_the_masthead_carries_the_product_and_the_lamp(self):
        self.assertIn("ParlorWave <b>Radio</b>", SRC)
        self.assertIn("brand-lamp", SRC)
        self.assertIn('class="brand-lamp ${onAirNow ? "lit" : ""}"', SRC)

    def test_every_view_has_a_render(self):
        for fn in ("_renderOnAir", "_renderBooth", "_renderNewsroom",
                   "_renderStation", "_renderDiagnostics"):
            self.assertIn(f"  {fn}(", SRC, fn)
        # The retired screen name. "Studio" was the configuration screen
        # before Booth was, and its renderer kept the old name long after
        # the tab did -- which is how the not-loaded card ended up telling
        # customers about a screen that does not exist.
        self.assertNotIn("_renderStudio", SRC, "Studio is a retired screen name")
        self.assertNotIn("Studio", SRC, "Studio is a retired screen name")


class Branding(unittest.TestCase):
    def test_no_internal_or_retired_product_name_reaches_the_panel(self):
        low = SRC.lower()
        for banned in ("jarvis", "music brain", "musicbrain", "music_brain"):
            self.assertNotIn(banned, low, banned)

    def test_no_internal_identifier_is_rendered_raw(self):
        """dry_wit and jarvis_custom_1 are storage, not names. Both are
        translated through the existing helpers before they are shown."""
        for banned in ("dry_wit", "dry_jarvis", "custom_1\"", "ha_tts_"):
            self.assertNotIn(banned, SRC, banned)
        block = SRC[SRC.index("  _renderLastBreak() {"):SRC.index("  _renderDrawer() {")]
        self.assertIn("this._voiceName(voiceId)", block)
        self.assertIn("this._personaName(persona)", block)


class TheBreakOnAirOutranksTheLastOne(unittest.TestCase):
    """A listener hearing one break must not be reading the one before it.

    The panel had no choice: the only script the backend published was the
    last COMPLETED break, so On Air showed history while a new break was
    audibly playing. The card now takes the live break whenever the backend
    says one is on air, and says which it is showing."""

    BLOCK = SRC[SRC.index("  _renderLastBreak() {"):SRC.index("  _renderDrawer() {")]

    def test_the_live_break_is_preferred_for_every_displayed_field(self):
        for live, history in (("on_air_spoken", "last_spoken"),
                              ("on_air_break_voice", "last_break_voice"),
                              ("on_air_break_personality",
                               "last_break_personality"),
                              ("on_air_break_at", "last_break_at"),
                              ("on_air_break_topics", "last_break_topics")):
            with self.subTest(field=live):
                self.assertIn(f"live ? a.{live} : a.{history}", self.BLOCK)

    def test_on_air_is_the_backends_answer_and_never_the_panels_guess(self):
        """No optimistic frontend state: the card asks one published
        attribute, and does not infer 'on air' from a status string, a
        countdown reaching zero, or a timer of its own."""
        self.assertIn("const live = !!a.on_air_break;", self.BLOCK)
        for guessed in ("setTimeout", "Date.now()", 'status === "on_air"'):
            self.assertNotIn(guessed, self.BLOCK, guessed)

    def test_a_live_break_is_labelled_as_live_and_history_as_history(self):
        """Showing the last completed break is fine -- but only when it is
        clearly not the one playing."""
        self.assertIn('live ? "Speaking now"', self.BLOCK)
        self.assertIn("ago || (at ? this._localTime(at) : null)", self.BLOCK)

    def test_the_live_card_is_distinguishable_without_reading_the_words(self):
        self.assertIn('class="card lastbreak${live ? " live" : ""}"', self.BLOCK)
        self.assertIn(".lastbreak-when.onair", SRC)
        self.assertIn(".lastbreak.live blockquote.said", SRC)


class AlbumPalette(unittest.TestCase):
    def test_the_five_theme_properties_are_published_to_the_host(self):
        block = SRC[SRC.index("  _applyTheme(theme) {"):SRC.index("  // --- broadcast state")]
        for prop in ("--pw-art-accent", "--pw-art-bg", "--pw-art-bg-deep",
                     "--pw-art-glow", "--pw-art-muted"):
            self.assertIn(f'set("{prop}"', block, prop)
        self.assertIn("this.style.setProperty", block,
                      "the theme must outlive a shadow-DOM rebuild")

    def test_every_theme_property_has_a_house_fallback_in_css(self):
        """The interface is complete before any artwork is sampled."""
        for prop, fallback in (("--pw-art-bg", "#131313"),
                               ("--pw-art-bg-deep", "#090909"),
                               ("--pw-art-accent", "#e0853c"),
                               ("--pw-art-muted", "#b3b0ab")):
            self.assertRegex(STYLE, rf"var\(\s*{re.escape(prop)},\s*{re.escape(fallback)}\s*\)", prop)
        self.assertIn("HOUSE_THEME", SRC)

    def test_the_canvas_read_is_permitted_not_forced(self):
        """crossOrigin is what makes the read legal; a host that declines
        simply yields no theme. Nothing here weakens that boundary."""
        self.assertIn('img.crossOrigin = "anonymous";', SRC)
        for banned in ("no-cors", "proxy?url=", "/api/image_proxy", "corsproxy"):
            self.assertNotIn(banned, SRC, banned)

    def test_extraction_happens_on_artwork_change_and_is_cached(self):
        block = SRC[SRC.index("  _syncPalette() {"):SRC.index("  _extractTheme(url) {")]
        self.assertIn("if (key === this._artKey) return;", block,
                      "the same sleeve must not be sampled twice")
        self.assertIn("_paletteCache.get(key)", block)
        self.assertIn("ART_CACHE_MAX", SRC)
        self.assertIn("this._syncPalette();",
                      SRC[SRC.index("set hass(hass)"):SRC.index("  _ent(key) {")])
        render = SRC[SRC.index("  _render() {"):]
        self.assertNotIn("_syncPalette", render, "never sampled from a render")

    def test_every_failure_path_lands_on_the_house_theme(self):
        block = SRC[SRC.index("  _syncPalette() {"):SRC.index("  _applyTheme(theme) {")]
        self.assertIn("if (!url) { this._applyTheme(null); return; }", block)
        self.assertIn(".catch(() => { if (this._artKey === key) this._applyTheme(null); });", block)
        self.assertIn("const t = theme || HOUSE_THEME;", SRC)

    def test_the_lamp_is_never_album_derived(self):
        """A broadcast lamp that turns blue is not a broadcast lamp."""
        self.assertIn('const ON_AIR_LAMP = "#ff4133";', SRC)
        self.assertRegex(STYLE, r"--pw-lamp:\s*#ff4133;")
        self.assertNotRegex(STYLE, r"--pw-lamp:\s*var\(--pw-art")


class Artwork(unittest.TestCase):
    TRACK = SRC[SRC.index("  _track() {"):SRC.index("  _artUrl() {")]

    def test_the_browser_reachable_picture_is_preferred(self):
        """The service advertises an artwork URL built for Music
        Assistant's network; Home Assistant hands the browser one it can
        actually fetch. The service URL stays as the fallback."""
        line = self.TRACK[self.TRACK.index("art:"):]
        line = line[:line.index("\n      //")]
        self.assertLess(line.index("entity_picture"), line.index("art_url"))

    def test_music_metadata_comes_from_the_live_player_not_the_cycle(self):
        """The card arrives on the coordinator's cycle and the player is a
        live state. The card used to win unconditionally, so for the first
        seconds of every song the screen showed the previous one and the
        live value underneath was never reached."""
        self.assertIn('const live = kind === "music" && !!pa.media_title;',
                      self.TRACK)
        self.assertIn("live ? pa.media_title", self.TRACK)
        self.assertIn("live ? (pa.media_artist || null)", self.TRACK)

    def test_program_audio_still_comes_from_the_backend(self):
        """Music Assistant only knows it is playing a file; the backend
        knows a break is a break."""
        self.assertIn('kind === "music"', self.TRACK)
        self.assertIn("na.title || pa.media_title", self.TRACK)

    def test_the_artwork_element_is_keyed_on_the_track(self):
        """A browser reuses an <img> whose src string did not change, and
        two tracks can be served one artwork address."""
        block = SRC[SRC.index("    const art = artUrl"):]
        block = block[:block.index("`<div class=\"art art-empty\"")]
        self.assertIn("key=", block)
        self.assertIn("tr.uri", block)


class ReturningToOnAir(unittest.TestCase):
    BLOCK = SRC[SRC.index("  _rehydrateOnAir() {"):]
    BLOCK = BLOCK[:BLOCK.index("\n  }")]

    def test_arriving_asks_for_a_fresh_read(self):
        self.assertIn('callService("homeassistant", "update_entity"', self.BLOCK)
        self.assertIn('"now_playing"', self.BLOCK)

    def test_it_is_bounded_so_nav_cannot_become_a_poll_loop(self):
        self.assertIn("REHYDRATE_MIN_MS", self.BLOCK)
        self.assertIn("const REHYDRATE_MIN_MS =", SRC)

    def test_it_never_reaches_playback(self):
        """It asks Home Assistant to re-read entities and does nothing
        else. Matched on the calls themselves, not on loose words --
        "now_playing" is an entity key, not playback."""
        self.assertEqual(re.findall(r'callService\("(\w+)", "(\w+)"', self.BLOCK),
                         [("homeassistant", "update_entity")])
        for banned in ('"media_player"', "media_play", "media_pause",
                       "volume_set", "_svc(", "parlorwave_radio/"):
            self.assertNotIn(banned, self.BLOCK, banned)

    def test_a_refusal_does_not_interrupt_the_screen(self):
        self.assertIn(".catch(() => {})", self.BLOCK)

    def test_both_ways_into_on_air_rehydrate(self):
        """The nav buttons and the in-page links are two different
        handlers, and a fix in one of them is a fix in half the product."""
        self.assertEqual(SRC.count("this._rehydrateOnAir();"), 2)


class BroadcastLanguage(unittest.TestCase):
    STATES = SRC[SRC.index("  _broadcastState() {"):SRC.index("  _agoText(iso) {")]

    def test_the_states_are_the_words_a_listener_would_use(self):
        for label in ("Speaking now", "News", "DJ preparing", "DJ ready",
                      "DJ up next", "DJ standing by", "DJ off", "Playing",
                      "Paused", "Needs attention", "Needs setup"):
            self.assertIn(f'label: "{label}"', self.STATES, label)

    def test_first_run_needs_setup_links_to_settings(self):
        onair = SRC[SRC.index("  _renderOnAir() {"):SRC.index("  /* --- Rotary hardware knobs")]
        self.assertIn('bs.tone === "setup"', onair)
        self.assertIn('this._go("settings"', onair)
        console = SRC[SRC.index("  _renderConsole("):SRC.index("  /* IS AUDIO MOVING")]
        self.assertIn('r.state === "needs_setup"', console)
        self.assertIn('"Needs setup"', console)

    def test_no_engineering_word_survives_as_a_customer_state(self):
        for banned in ('label: "quiet"', 'label: "idle"', 'label: "up_next"',
                       'label: "on_air"', 'label: "waiting"', 'label: "ready"'):
            self.assertNotIn(banned, self.STATES, banned)

    def test_every_state_comes_from_published_backend_state(self):
        # `readiness.blockers` is the backend's health too -- translated
        # once, in the integration, rather than read raw in two places.
        for source in ("jv.state", "dj.state", "na.kind", "readiness.blockers"):
            self.assertIn(source, self.STATES, source)

    def test_no_countdown_is_invented(self):
        """The minutes line exists only where the engine publishes
        seconds_to_air."""
        onair = SRC[SRC.index("  _renderOnAir() {"):SRC.index("  _renderLastBreak() {")]
        self.assertIn("jvAttrs.seconds_to_air != null", onair)
        self.assertNotIn("setTimeout", onair)
        self.assertNotIn("Date.now() + ", onair)

    def test_problems_outrank_everything_else(self):
        self.assertLess(self.STATES.index("problems.length"),
                        self.STATES.index('label: "Speaking now"'))


class StructuredProblems(unittest.TestCase):
    """The banner above every screen renders the READINESS document.

    It used to render the service's own problems verbatim -- summaries
    written for whoever deploys the backend, naming environment variables,
    service URLs, HTTP status codes and the internal speech engines, across
    the top of all five screens. There is one customer-facing translation
    of health in this product (readiness.py, with tests) and the panel is
    handed its sentences."""

    BLOCK = SRC[SRC.index("  _renderProblems() {"):SRC.index("  // --- On Air")]

    def test_the_banner_renders_the_readiness_document(self):
        self.assertIn("this._readiness()", self.BLOCK)
        self.assertIn("r.blockers", self.BLOCK)
        self.assertIn("this._esc(b.title)", self.BLOCK)
        self.assertIn("this._esc(b.detail)", self.BLOCK)
        # not a live region: the persistent #sr-alert beside the stylesheet
        # announces blockers, once each
        self.assertNotIn('role="alert"', self.BLOCK)
        self.assertNotIn("aria-live", self.BLOCK)

    def test_the_service_own_words_never_reach_the_banner(self):
        for banned in ("p.summary", "p.action", "attributes.problems",
                       '"fatal"'):
            self.assertNotIn(banned, self.BLOCK, banned)

    def test_settings_is_not_told_twice(self):
        """Settings owns the verdict, the checklist and the To fix list.
        A banner repeating its first line three rows higher is the same
        problem said twice, in two registers."""
        self.assertIn('if (this._view === "settings") return "";', self.BLOCK)

    def test_the_stage_state_line_reads_the_same_verdict(self):
        """"Needs attention" on the stage and the banner above it must not
        be able to disagree -- and a fresh install, whose only outstanding
        item is a setup step, must turn neither of them red."""
        block = SRC[SRC.index("  _broadcastState() {"):SRC.index("  _agoText(iso) {")]
        self.assertIn("this._readiness()", block)
        self.assertIn("readiness.blockers", block)
        self.assertNotIn("jvAttrs.problems", block)

    def test_no_second_diagnosis_lives_in_the_panel(self):
        """Health is decided once, in the backend; translated once, in the
        integration. Neither vocabulary is restated here."""
        for banned in ("ma_unreachable", "ma_token_missing", "observer_not_running",
                       "tts_unconfigured", "tts_voice_unselected"):
            self.assertNotIn(banned, SRC, banned)


class LifecycleTruth(unittest.TestCase):
    """The screen presents the backend's programme LIFECYCLE and
    infers nothing from a route, a title or the DJ switch.

    The behaviours are EXECUTED in test_panel_lifecycle.mjs; what this
    pins is the shape -- which facts each decision is allowed to read --
    so a later edit cannot quietly put a guess back."""

    STATES = SRC[SRC.index("  _broadcastState() {"):SRC.index("  _agoText(iso) {")]
    QUEUE = SRC[SRC.index("  _queueSeconds(items) {"):SRC.index("  /* `featured` is the public ref")]
    AUDIO = SRC[SRC.index("  _audioMode(bs, na, player) {"):SRC.index("  /* THE DJ CONTROL")]
    ONAIR = SRC[SRC.index("  _renderOnAir() {"):SRC.index("  /* IS AUDIO MOVING")]

    def test_speaking_now_is_the_engine_or_an_airing_lifecycle_never_a_route(self):
        self.assertIn('const airing = na.lifecycle === "airing";', self.STATES)
        self.assertIn('status === "on_air" || (na.kind === "dj" && airing)', self.STATES)
        self.assertIn('na.kind === "news" && airing', self.STATES)
        # the old inference: a card kind on its own lit the lamp
        self.assertNotIn('playing && na.kind === "dj")', self.STATES)
        self.assertNotIn('playing && na.kind === "news")', self.STATES)

    def test_the_dj_switch_is_never_read_as_speech(self):
        """dj.state is consulted for "DJ off" and for nothing before it."""
        off = self.STATES.index('dj.state === "off"')
        self.assertGreater(off, self.STATES.index('label: "Speaking now"'))
        self.assertGreater(off, self.STATES.index('label: "News"'))
        self.assertGreater(off, self.STATES.index('label: "Playing"'))

    def test_ready_and_up_next_are_two_words(self):
        """A rendered break waiting for the insertion gate is not in the
        queue; one Music Assistant holds as the next item is."""
        self.assertIn('if (status === "ready") {', self.STATES)
        self.assertIn('label: "DJ ready"', self.STATES)
        self.assertIn('if (status === "up_next") {', self.STATES)
        self.assertIn('label: "DJ up next"', self.STATES)
        self.assertNotIn('status === "ready" || status === "up_next"', self.STATES)

    def test_the_next_break_chip_is_the_engines_estimate_and_never_zero_minutes(self):
        self.assertIn("jvAttrs.seconds_to_air != null && !bs.lamp", self.ONAIR)
        self.assertIn("this._runWords(Math.max(0, jvAttrs.seconds_to_air))", self.ONAIR)
        self.assertNotIn("Math.round(jvAttrs.seconds_to_air / 60)", self.ONAIR)

    def test_the_audio_rule_asks_the_lamp_and_nothing_else(self):
        self.assertIn("const speaking = audible && !!(bs && bs.lamp);", self.AUDIO)
        self.assertNotIn('["dj", "news"].includes(na.kind)', self.AUDIO)

    def test_queue_rows_read_the_lifecycle_and_never_the_title(self):
        self.assertIn('["spent", "unknown"].includes(it.lifecycle)', self.QUEUE)
        self.assertIn('it.lifecycle === "airing"', self.QUEUE)
        self.assertIn('it.lifecycle === "spent"', self.QUEUE)
        for guessed in ("it.title ===", 'includes("DJ break")', "it.artist ===",
                        "duration_s <", "duration_s >", "it.uri", "/broadcast/audio/",
                        "/news/audio/"):
            self.assertNotIn(guessed, self.QUEUE, guessed)

    def test_a_spent_row_is_marked_and_keeps_its_finished_length(self):
        self.assertIn('dead ? " qspent" : ""', self.QUEUE)
        # A finished break/bulletin keeps MA's duration for the element as
        # it aired (same renderer as every other row); an "unknown"
        # lifecycle is vouched for by nothing and keeps no length. The
        # length shown is only ever MA's own duration_s -- never derived
        # from the clock, the ordering or a schedule.
        self.assertIn('it.lifecycle === "unknown" ? false : !!it.duration_s', self.QUEUE)
        self.assertIn("this._mmss(it.duration_s)", self.QUEUE)
        for invented in ("Date.now", "scheduled", "target_air_at", "new Date"):
            self.assertNotIn(invented, self.QUEUE, invented)
        # ...but a spent element's seconds still stay out of the run-time
        # arithmetic, which is about music yet to play.
        self.assertIn("if (it && this._queueDead(it)) continue;", self.QUEUE)
        self.assertIn(".qrow.qspent", STYLE)
        self.assertIn(".qtag", STYLE)

    def test_the_spent_row_is_neutral_not_alarming(self):
        block = STYLE[STYLE.index(".qrow.qspent"):STYLE.index(".qsum {")]
        self.assertNotRegex(block, r"#ff[0-4]|red|--pw-lamp|alert")

    def test_air_check_is_named_and_reads_only_the_engines_two_rows(self):
        block = SRC[SRC.index("  _renderLastBreak() {"):SRC.index("  _renderDrawer() {")]
        self.assertIn('aria-label="Air Check"', block)
        self.assertIn('<span class="lastbreak-label">Air Check</span>', block)
        # the queue drawer's data is never consulted: a queued future break
        # is not the Air Check, and a spent item cannot displace it
        for banned in ("this._queue", "upcoming", "lifecycle", "_track()"):
            self.assertNotIn(banned, block, banned)

    def test_presentation_never_writes(self):
        """None of the lifecycle presentation can reach a service, the
        websocket, or playback: it renders what it was handed."""
        for block in (self.STATES, self.QUEUE, self.AUDIO,
                      SRC[SRC.index("  _renderLastBreak() {"):SRC.index("  _renderDrawer() {")],
                      SRC[SRC.index("  _track() {"):SRC.index("  _artUrl() {")]):
            # call shapes, not prose: a comment may SAY what hygiene does
            for banned in ("callService", "callWS", "_ws(", "_svc(", "_toggle(",
                           "media_player", "queue/hygiene", "delete_queue",
                           "media_seek", "media_next", "play_index"):
                self.assertNotIn(banned, block, banned)


class Responsive(unittest.TestCase):
    def test_the_three_intended_widths_are_designed_for(self):
        self.assertIn("@media (max-width: 900px)", STYLE, "tablet")
        self.assertIn("@media (max-width: 560px)", STYLE, "phone")
        self.assertIn("max-width:1120px", STYLE.replace(" ", ""), "desktop measure")

    def test_the_phone_layout_stacks_and_keeps_touch_targets(self):
        phone = STYLE[STYLE.index("@media (max-width: 560px)"):]
        self.assertIn("min-height:44px", phone)
        self.assertRegex(phone, r"\.art-wrap \{ width:min\(\d+vw")
        self.assertIn("flex-direction:column", phone)

    def test_nothing_forces_the_page_wider_than_the_screen(self):
        self.assertNotRegex(STYLE, r"min-width:\s*[4-9]\d\dpx")
        self.assertIn("overflow-wrap:anywhere", STYLE)

    def test_the_phone_console_keeps_both_eyes_on_one_row(self):
        """<=560px: the two eyes share row one and the Mouth spans row two.

        The regression this pins: the phone block used to fall back to a
        single column in DOM order -- left eye, Mouth, right eye -- which
        put the Mouth BETWEEN the eyes. The arrangement is the tablet's,
        one hand sized, and the eyes must never wrap one above the other.
        """
        phone = STYLE[STYLE.index("@media (max-width: 560px)"):]
        deck = phone[phone.index(".console-deck"):]
        self.assertIn("grid-template-columns:1fr 1fr", deck.split("}")[0])
        self.assertIn(".console-dj { grid-column:1; grid-row:1;", phone)
        self.assertIn(".console-spk { grid-column:2; grid-row:1;", phone)
        self.assertIn(".console-deck .mouth { grid-column:1 / -1; grid-row:2;", phone)

    def test_the_phone_eyes_shrink_together_and_stay_equal(self):
        """One rule sizes BOTH eyes (they cannot diverge), it yields to the
        column instead of forcing a wrap, and nothing about it is JS."""
        phone = STYLE[STYLE.index("@media (max-width: 560px)"):]
        self.assertIn(".knob-housing { width:min(154px, 100%); height:auto; "
                      "aspect-ratio:1 / 1; }", phone)
        self.assertIn(".dj-switch, .right-knob {", phone)
        # the knobs keep a real touch target however far the eyes shrink
        self.assertIn(".dj-switch { min-height:44px; }", phone)
        self.assertIn(".right-knob { min-height:44px; }", phone)

    def test_the_tablet_console_rules_are_unchanged(self):
        """The <=900px arrangement this release models the phone on."""
        tablet = STYLE[STYLE.index("@media (max-width: 900px)"):
                       STYLE.index("@media (max-width: 560px)")]
        self.assertIn(".console-deck { grid-template-columns:1fr 1fr; gap:18px 24px;", tablet)
        self.assertIn(".console-deck .mouth { grid-column:1 / -1; grid-row:2; "
                      "width:100%; max-width:540px;", tablet)

    def test_the_desktop_console_grid_is_unchanged(self):
        self.assertIn("grid-template-columns:170px 1fr 170px", STYLE)


class Motion(unittest.TestCase):
    def test_the_palette_transition_is_a_fade_not_an_animation(self):
        """The room eases from one record to the next. Only the rules that
        carry album colour are in scope -- the lamp has its own timing."""
        for rule in (":host", ".stage-glow"):
            block = STYLE[STYLE.index(rule + " {"):]
            block = block[:block.index("}")]
            ms = re.search(r"transition:\s*background\s+(\d+)ms", block)
            self.assertTrue(ms, f"{rule} does not ease its background")
            self.assertTrue(600 <= int(ms.group(1)) <= 900,
                            f"{rule}: {ms.group(1)}ms is outside the intended range")

    def test_reduced_motion_is_honoured(self):
        self.assertIn("@media (prefers-reduced-motion: reduce)", STYLE)
        block = STYLE[STYLE.index("prefers-reduced-motion"):]
        self.assertIn("transition:none", block)
        self.assertIn("animation:none", block, "the on-air lamp stops pulsing too")


class Accessibility(unittest.TestCase):
    def test_state_is_never_carried_by_colour_alone(self):
        onair = SRC[SRC.index("  _renderOnAir() {"):SRC.index("  _renderLastBreak() {")]
        self.assertIn("state-label", onair)
        # the state line is text (not colour alone); what a screen reader
        # hears is the persistent #sr-status region, updated in place
        self.assertNotIn("aria-live", onair)
        self.assertIn('id="sr-status" class="visually-hidden" role="status" aria-live="polite"', SRC)

    def test_controls_are_labelled_and_expose_their_pressed_state(self):
        onair = SRC[SRC.index("  _renderOnAir() {"):SRC.index("  _renderThumbs(playing) {")]
        for aria in ('aria-label="Lyrics"', 'aria-pressed=',
                     'aria-label="Queue"'):
            self.assertIn(aria, onair, aria)
        # bounded by the next method itself, not by its comment: a comment
        # is prose and moves, and a moved boundary reads as a missing label
        thumbs = SRC[SRC.index("  _renderThumbs(playing) {"):
                     SRC.index("  _renderLastBreak() {")]
        self.assertIn('aria-label="I like this song"', thumbs)
        self.assertIn('aria-label="I dislike this song"', thumbs)
        self.assertIn('aria-current=', SRC, "the active section is announced")
        self.assertIn('aria-label="Sections"', SRC)

    def test_artwork_is_described_and_decoration_is_hidden(self):
        onair = SRC[SRC.index("  _renderOnAir() {"):SRC.index("  _renderLastBreak() {")]
        self.assertIn('alt="${this._esc(album || title || "Album artwork")}"', onair)
        self.assertIn('class="stage-glow" aria-hidden="true"', onair)
        self.assertIn('role="img" aria-label="No artwork"', onair)

    def test_focus_is_visible(self):
        self.assertIn("focus-visible", STYLE)
        self.assertRegex(STYLE, r"outline:2px solid var\(--pw-accent\)")


class KeptCapabilities(unittest.TestCase):
    ONAIR = SRC[SRC.index("  _renderOnAir() {"):SRC.index("  _renderThumbs(playing) {")]

    def test_what_on_air_owns_is_still_on_air(self):
        """On Air keeps the live radio and the two controls that are part
        of what is happening right now: whether the DJ speaks at all, and
        which speaker it follows."""
        for control in ("drawer-lyrics", "drawer-queue", "_renderDjSwitch(",
                        '_selectRow("output"'):
            self.assertIn(control, self.ONAIR, control)
        self.assertIn("history-toggle", SRC)
        self.assertIn("this._renderHistory(", SRC)

    def test_break_style_belongs_to_booth_and_to_booth_only(self):
        """Break length and cadence shape what a break IS -- Booth's
        question. They were on both screens, under two different labels
        ("Break length" against the raw option values here, "Short /
        Normal / Long" there; "Break cadence (min)" against "Minimum
        minutes between breaks"), writing the same two settings. Two
        screens that can write one value are two screens that can disagree
        about it."""
        booth = SRC[SRC.index("  _renderBreakStyle() {"):SRC.index("  _voiceIdForName(name) {")]
        for control in ('_selectRow("break-length"', '_numberRow("cadence"'):
            self.assertNotIn(control, self.ONAIR, control + " is still on On Air")
            self.assertIn(control, booth, control + " never reached Booth")

    def test_the_music_programming_controls_moved_to_station_exactly_once(self):
        """Start Radio, the request box and Endless Radio are Station's
        now. Duplicating a control is worse than moving it: two screens
        would disagree about what a setting means."""
        station = SRC[SRC.index("  _renderStation() {"):SRC.index("  _renderDiagnostics() {")]
        for control in ('id="start-radio"', 'id="request-input"',
                        'id="request-go"', '_toggleRow("endless"'):
            self.assertNotIn(control, self.ONAIR, control + " is still on On Air")
            self.assertIn(control, station, control + " never reached Station")
            self.assertEqual(1, SRC.count(control), control + " is on two screens")

    THUMBS = SRC[SRC.index("  _thumbsState(playing) {"):
                 SRC.index("  /* The five controls, in the order")]

    def test_thumbs_are_not_drawn_where_they_cannot_record_anything(self):
        """Taste-learning writes into the local ParlorWave catalog, and the
        verdict comes from the backend capability rather than from a guess
        about what is playing. They used to be drawn DISABLED with the
        reason when the answer was no; alpha.4
        hides them instead, because no shipped install has a catalog and
        two buttons that never work read as broken. The reason is kept in
        the code, and a catalog install still gets live thumbs."""
        self.assertIn("this._catalog()", self.THUMBS,
                      "the backend's verdict, not a guess")
        self.assertIn("hide: true", self.THUMBS)
        self.assertIn('if (st.hide) return "";', self.THUMBS)
        self.assertIn("${off ? \"disabled\" : \"\"}", self.THUMBS,
                      "with a catalog, the per-kind reasons still disable")
        self.assertIn('id="thumb-up"', self.THUMBS)
        self.assertIn('id="thumb-down"', self.THUMBS)
        for spelling in ('id="thumb-up"', 'id="thumb-down"'):
            self.assertEqual(1, SRC.count(spelling), spelling)

    def test_program_audio_is_not_rateable_and_the_reason_is_its_own(self):
        """A DJ break and a news bulletin are not music and have no
        standing to raise. Three different reasons a thumb has nowhere to
        go, and three different sentences -- 'needs a catalog' told to
        somebody listening to a bulletin would send them looking for the
        wrong thing."""
        self.assertIn("this._track().kind", self.THUMBS)
        self.assertIn("kind !== \"music\"", self.THUMBS)
        for sentence in ("A news bulletin cannot be rated",
                         "A DJ break cannot be rated",
                         "Nothing is playing to rate."):
            self.assertIn(sentence, self.THUMBS, sentence)

    def test_no_provider_feedback_is_invented_where_none_exists(self):
        """Verified against Music Assistant 2.10: no provider it
        serves advertises a feedback, rating or favourite feature, so
        there is nothing provider-native to borrow. The panel must not
        imply otherwise, and must not reach for MA's library edit as if it
        were a rating."""
        self.assertIn("Music Assistant does not offer a thumbs capability",
                      self.THUMBS)
        for banned in ("library_tracks_edit", "favourite", "favorite",
                       "add_to_library", "rating"):
            self.assertNotIn(banned, self.THUMBS, banned)

    def test_a_thumb_never_reports_a_success_the_catalog_did_not_take(self):
        """The backstop the screen cannot enforce: with a catalog present
        the song playing may still not be IN it. The service answers how
        many rows it changed, and the integration turns zero into a
        refusal, so a thumb that recorded nothing cannot show a green
        Done. Pinned on both sides, because either half alone is a lie."""
        # The panel says so where the capability is decided...
        rationale = SRC[SRC.index("  /* WHAT A THUMB CAN ACTUALLY REACH"):
                        SRC.index("  _thumbsState(playing) {")]
        self.assertIn("zero into a refusal the owner reads", rationale)
        # ...and the integration is what actually does it.
        init = (PANEL.parent.parent / "__init__.py").read_text()
        block = init[init.index("    def _feedback(action: str):"):
                     init.index("    hass.services.async_register(DOMAIN, SERVICE_REQUEST")]
        self.assertIn('result.get("updated_rows") == 0', block)
        self.assertIn("HomeAssistantError", block)
        self.assertIn("nothing to rate", block)

    def test_a_thumb_says_which_song_rather_than_Done(self):
        press = SRC[SRC.index("  _thumb(action) {"):
                    SRC.index("  _startRadio() {")]
        self.assertIn("noted for your station", press)
        self.assertIn("data.title", press)

    def test_transport_is_music_assistants_own_and_is_never_faked(self):
        """The four transport buttons are plain media_player calls on the
        Music Assistant player, so Music Assistant advances its own queue.
        Three things are pinned:

        1. Only those four services are called. In particular there is no
           media_seek anywhere -- a "restart the current track" built out
           of a seek to zero is exactly the invented semantic that was
           ruled out, and banning the service is how that stays ruled out.
        2. Which buttons are live is read from the entity's own
           supported_features, not assumed.
        3. The play/pause button follows the PLAYER's reported state."""
        allowed = {"media_previous_track", "media_next_track",
                   "media_play", "media_pause"}
        called = set(re.findall(r'this\._transport\("(\w+)"\)', SRC))
        self.assertEqual(called, allowed, called)
        for bit in ("MP_PREVIOUS_TRACK", "MP_NEXT_TRACK", "MP_PAUSE", "MP_PLAY"):
            self.assertIn(f"sf & {bit}", SRC, bit)
        self.assertIn("playing: p.state === \"playing\"", SRC,
                      "the button follows the player, not our last request")

    def test_nothing_in_the_panel_can_move_the_outer_page(self):
        """THE LYRICS BUG, pinned at the source as well as executed.

        `scrollIntoView` scrolls every scrollable ancestor until the
        element is visible, and inside a Home Assistant panel the outermost
        ancestor is the page. `focus()` does the same thing by a different
        route, and additionally takes the caret away from whatever the
        person was using. Neither may appear anywhere a lyric update can
        reach. The two `focus()` calls that remain are in the voice
        library, on a text box a person just pressed Edit on -- putting the
        caret where they asked for it -- and are unreachable from the
        ticker.

        ha/tests/test_panel_dom.mjs proves the same thing by running it."""
        live = re.sub(r"/\*.*?\*/", "", SRC, flags=re.S)       # drop comments
        self.assertNotIn("scrollIntoView", live,
                         "scrollIntoView is what dragged the page to the lyrics")
        lyric = live[live.index("_highlightLyric(pr) {"):live.index("_bindLyricPane() {")]
        self.assertNotIn("focus(", lyric)
        # the pane is the only thing addressed, and it is addressed by id
        self.assertIn('getElementById("lyric-lines")', lyric)
        self.assertIn("lyricScrollTop({", lyric)
        # The gate on MOVING the pane at all. It used to be
        # `shouldFollowLyric`, a proximity test consulted on every tick;
        # a rule asked once a second is a rule that eventually moves the
        # pane out from under a reader, so it is now asked only about a
        # CHANGE of line.
        self.assertIn("shouldAutoScroll({", lyric)
        # Every scroll in this region addresses the PANE and nothing else:
        # `list` is the element fetched by id above, and the only other
        # scrollable thing named would be a mistake.
        for call in ("scrollTo(", "scrollTop ="):
            self.assertEqual(lyric.count(call), lyric.count("list." + call),
                             f"{call} on something other than the pane")

    def test_the_lyric_pane_contains_its_own_scrolling(self):
        """The script half is above; this is the CSS half. A scroll that
        runs off either end of the pane must not chain into the Home
        Assistant page behind it."""
        self.assertIn("overscroll-behavior:contain", STYLE)
        lyrics_rule = STYLE[STYLE.index(".lyrics {"):]
        lyrics_rule = lyrics_rule[:lyrics_rule.index("}") + 1]
        self.assertIn("overflow-y:auto", lyrics_rule)
        self.assertIn("max-height", lyrics_rule)
        # and no blanket smooth scroll: putting the pane back after a
        # re-render must be instant, following the song may animate, and a
        # CSS rule cannot tell those apart.
        # (?<!over) so overscroll-behavior above does not match this
        self.assertIsNone(re.search(r"(?<!over)scroll-behavior", lyrics_rule),
                          lyrics_rule)

    def test_a_rebuild_keeps_the_readers_place_in_the_song(self):
        """Home Assistant pushes state every few seconds and the whole
        shadow tree is rebuilt. Somebody READING the lyrics must not be
        thrown to the top of the song each time."""
        render = SRC[SRC.index("  _render() {"):]
        self.assertIn("this._saveLyricScroll();", render)
        self.assertIn("this._restoreLyricScroll();", render)

    def test_the_panel_still_cannot_write_a_queue(self):
        """The invariant is about the queue's CONTENTS, and it is unchanged:
        nothing in this file may reorder it, add to it, empty it or seek
        inside a track. Asking Music Assistant to move to the next or
        previous track is not writing a queue -- it is the queue's owner
        doing what it does, which is the whole reason transport goes
        through media_player rather than through a Parlorwave endpoint."""
        for banned in ("media_seek", "queue_move", "clear_playlist", "play_media",
                       "media_stop", "shuffle_set", "repeat_set"):
            self.assertNotIn(banned, SRC, banned)



class TheDjSwitchIsAStudioControl(unittest.TestCase):
    """The Broadcast Console's DJ control: an illuminated push-button whose
    light means CONFIRMED enabled, in amber, and never "speaking now"."""

    BLOCK = SRC[SRC.index("  _renderDjSwitch(dj, bs) {"):]
    BLOCK = BLOCK[:BLOCK.index("  /* BREAK LENGTH AND CADENCE")]
    CSS = STYLE[STYLE.index(".dj-switch {"):STYLE.index("/* --- the Mouth")]
    #: the ON-AIR lamp's colour and its relatives. Red on this screen means
    #: one thing, and the console does not borrow it for "enabled".
    RED = ("#ff4133", "rgba(255,65,51", "#ff6a5c", "--pw-lamp", "#ff5346", "#ffb4a8")

    def test_it_is_illuminated_and_says_which_state_it_is_in(self):
        self.assertIn("DJ ON", self.BLOCK)
        self.assertIn("DJ OFF", self.BLOCK)
        self.assertIn("Between-song DJ enabled", self.BLOCK)
        self.assertIn(".dj-switch.on", STYLE)
        self.assertIn(".dj-switch-glow", STYLE)
        self.assertIn(".dj-switch.on .dj-face", STYLE, "the face is what lights")

    def test_its_light_is_amber_never_the_on_air_red(self):
        for red in self.RED:
            self.assertNotIn(red, self.CSS, red)
            self.assertNotIn(red, self.BLOCK, red)
        self.assertIn("240,162,74", self.CSS, "the console amber")

    def test_it_does_not_claim_the_dj_is_speaking_right_now(self):
        """A control that pulsed would read as "speaking now", which is the
        Mouth's job and must stay unambiguous. So the ON state glows and
        never animates, carries no lamp dot, and says in words that it is
        the arrangement."""
        self.assertNotIn('class="lamp"', self.BLOCK)
        self.assertIn("not a", self.BLOCK)
        self.assertIn("live indicator", self.BLOCK)
        for rule in self.CSS.split("}"):
            if ".dj-switch.on" in rule:
                self.assertNotIn("animation", rule, rule.strip()[:60])

    def test_illuminated_means_confirmed_and_pending_is_its_own_state(self):
        """The light follows the entity's own state; a press makes the
        control pending -- busy, disabled, light unchanged -- until Home
        Assistant reports the new state. Nothing here guesses the outcome."""
        self.assertIn('const on = dj && dj.state === "on";', self.BLOCK)
        # pending = the call in flight, OR the write waiting for the entity's
        # echo (otherwise the knob holds its OLD state for seconds)
        self.assertIn("const pending = !!(dj && (this._busy === dj.entity_id || this._djHoldActive()));", self.BLOCK)
        self.assertIn('${on ? "on" : "off"}${pending ? " pending" : ""}', self.BLOCK)
        self.assertIn('aria-checked="${on ? "true" : "false"}"', self.BLOCK)
        self.assertIn('aria-busy="${pending ? "true" : "false"}"', self.BLOCK)
        self.assertIn('${unavailable || pending ? "disabled" : ""}', self.BLOCK)
        for guessed in ("wanted", "optimistic", "_pendingOn", "!on ?"):
            self.assertNotIn(guessed, self.BLOCK, guessed)
        # the pending ring breathes; under reduced motion it does not
        self.assertIn(".dj-switch.pending .dj-face { animation:dj-pending", STYLE)
        reduced = STYLE[STYLE.rindex("prefers-reduced-motion"):]
        self.assertIn(".dj-switch.pending .dj-face { animation:none; }", reduced)

    def test_it_defers_to_the_display_while_a_break_is_on_air(self):
        self.assertIn("A break is on the air now", self.BLOCK)

    def test_it_is_a_real_switch_for_assistive_technology(self):
        self.assertIn('role="switch"', self.BLOCK)
        self.assertIn("aria-checked=", self.BLOCK)
        self.assertIn('aria-label="Between-song DJ"', self.BLOCK)
        self.assertIn(".dj-switch:focus-visible", STYLE)
        self.assertIn("<button", self.BLOCK, "a button is keyboard-operable by construction")

    def test_an_unavailable_dj_is_disabled_and_says_so(self):
        self.assertIn("DJ unavailable", self.BLOCK)
        self.assertIn("unavailable || pending ? \"disabled\"", self.BLOCK)

    def test_it_writes_the_same_entity_the_settings_pill_did(self):
        self.assertIn('on("dj-switch", () => this._toggle(this._dj));', SRC)
        self.assertEqual(SRC.count('id="dj-switch"'), 1, "one control, one write path")


class TheBroadcastConsole(unittest.TestCase):
    """The DJ control, the Mouth and the speaker control on one deck,
    the Air Check on the strip beneath. The Mouth is procedural expression
    driven by the lifecycle's truth -- never audio analysis -- with one
    throttled loop that stops when there is nothing to show.

    Behaviour is EXECUTED in test_panel_console.mjs; these pin the shape."""

    CONSOLE = SRC[SRC.index("  _renderConsole(dj, bs, hasEnabledOutputs) {"):SRC.index("  /* IS AUDIO MOVING")]
    MOUTH = SRC[SRC.index("  // --- the Broadcast Console: the Mouth"):SRC.index("  /* AIR CHECK:")]
    PURE = SRC[SRC.index("const MOUTH_MUSIC ="):SRC.index("function roundRect(")]
    FRAME = MOUTH[MOUTH.index("  _mouthFrame(ts) {"):]
    CCSS = STYLE[STYLE.index(".console {"):STYLE.index(".svc {")]

    def test_one_object_with_the_three_controls_and_the_air_check(self):
        c = self.CONSOLE
        self.assertIn('aria-label="Broadcast console"', c)
        self.assertIn('this._selectRow("output"', c)
        deck = c[c.index('<section class="console"'):]
        order = [deck.index("this._renderDjSwitch(dj, bs)"), deck.index("this._renderMouth(dj, bs, hasEnabledOutputs)"),
                 deck.index("${speaker}"), deck.index("this._renderLastBreak()")]
        self.assertEqual(order, sorted(order), "DJ control, Mouth, speaker, then Air Check")
        # the speaker control is the SAME row, with the same binding
        self.assertIn('data-select=', SRC[SRC.index("  _selectRow("):SRC.index("  _numAsTyped(")])

    def test_the_stage_still_owns_the_record(self):
        """The console complements Now Playing; it does not repeat it."""
        for dup in ("track-title", "tr.title", "media_title", "class=\"art"):
            self.assertNotIn(dup, self.CONSOLE, dup)
            self.assertNotIn(dup, self.MOUTH, dup)

    def test_the_mouth_is_procedural_expression_never_analysis(self):
        for banned in ("AudioContext", "createAnalyser", "AnalyserNode",
                       "getByteFrequencyData", "getUserMedia", "MediaStream",
                       "decodeAudioData", "fetch(", "WebSocket", "callWS",
                       "callService", "_ws(", "_svc(", "Math.random"):
            self.assertNotIn(banned, self.MOUTH, banned)
            self.assertNotIn(banned, self.PURE, banned)
        self.assertNotIn("spectrum analy", SRC.lower())
        self.assertIn("never an audio analyser", SRC)

    def test_three_states_from_the_one_audio_rule(self):
        """One authority: the lamp, through _audioMode, so the Mouth and the
        state line cannot disagree -- DJ enabled alone is never a voice."""
        self.assertIn("this._audioMode(this._broadcastState(), na, p)", self.MOUTH)
        self.assertIn('m.mode === "speaking" ? MOUTH_PROGRAM_VOICE', self.MOUTH)
        self.assertIn('m.mode === "music" ? MOUTH_MUSIC : MOUTH_IDLE', self.MOUTH)
        self.assertNotIn("this._dj", self.MOUTH, "the switch is not consulted")
        self.assertNotIn("dj.state", self.MOUTH)
        for label in ("Music playing", "ParlorWave speaking", "Idle"):
            self.assertIn(f'"{label}"', self.PURE, label)

    def test_the_loop_is_one_throttled_and_torn_down(self):
        self.assertIn("const MOUTH_FPS = 30;", SRC)
        m = self.MOUTH
        start = m[m.index("  _mouthStart() {"):m.index("  _mouthStop() {")]
        self.assertLess(start.index("this._mouthStop();"),
                        start.index('getElementById("mouth")'),
                        "cancels before it binds")
        self.assertIn("cancelAnimationFrame(m.raf)", m)
        self.assertIn("if (!m || m.raf != null || typeof requestAnimationFrame", m,
                      "a queued frame is never queued twice")
        self.assertIn("ts - m.last >= MOUTH_FRAME_MS", self.FRAME)
        disconnect = SRC[SRC.index("  disconnectedCallback() {"):SRC.index("  set hass(hass) {")]
        self.assertIn("this._mouthStop();", disconnect)
        self.assertIn('document.removeEventListener("visibilitychange", this._onVisibility)', disconnect)
        connect = SRC[SRC.index("  connectedCallback() {"):SRC.index("  disconnectedCallback() {")]
        self.assertIn('document.addEventListener("visibilitychange", this._onVisibility)', connect)
        self.assertEqual(SRC.count("this._onVisibility = () =>"), 1, "one bound handler, made once")
        self.assertEqual(SRC.count("requestAnimationFrame("), 1, "one place queues a frame")

    def test_the_frame_reads_no_state_and_touches_no_dom(self):
        for banned in ("this._hass", "shadowRoot", "innerHTML", "_render(",
                       "callService", "callWS", "_ws(", "fetch(", "createElement",
                       "_broadcastState", "_nowCard", "_player"):
            self.assertNotIn(banned, self.FRAME, banned)

    def test_a_hidden_page_gets_no_frames(self):
        self.assertIn("if (this._mouthHidden()) return;", self.FRAME)
        vis = self.MOUTH[self.MOUTH.index("  _onVisibilityChange() {"):self.MOUTH.index("  _mouthDraw(t) {")]
        self.assertIn("if (this._mouthHidden()) { this._mouthStop(); return; }", vis)

    def test_reduced_motion_is_a_still_picture_per_state(self):
        self.assertIn("const reduced = !this._gentle();", self.MOUTH)
        self.assertIn("if (st.mode === MOUTH_IDLE || reduced) return;", self.MOUTH)
        still = re.search(r"const MOUTH_STILL = \{(.*?)\};", self.PURE, re.S).group(1)
        vals = [float(v) for v in re.findall(r": ([0-9.]+)", still)]
        self.assertEqual(len(vals), 3)
        self.assertEqual(vals, sorted(vals), "idle < music < voice, by size")
        self.assertEqual(len(set(vals)), 3, "the three states are told apart")

    def test_the_display_is_decorative_and_its_state_is_one_phrase(self):
        self.assertIn('role="img"', self.MOUTH)
        self.assertIn('aria-label="Broadcast display: ${this._esc(st.label)}"', self.MOUTH)
        self.assertIn('<canvas id="mouth" class="mouth-canvas" aria-hidden="true">', self.MOUTH)
        self.assertNotIn("aria-live", self.MOUTH, "the state line already announces")

    def test_console_colours_are_warm_never_red(self):
        for red in TheDjSwitchIsAStudioControl.RED:
            self.assertNotIn(red, self.CCSS, red)
        self.assertIn("#f0a24a", SRC)

    def test_it_reflows_for_a_tablet_and_a_phone(self):
        tablet = STYLE[STYLE.index("@media (max-width: 900px)"):STYLE.index("@media (max-width: 560px)")]
        self.assertIn(".console-deck { grid-template-columns:1fr 1fr", tablet)
        self.assertIn(".console-deck .mouth { grid-column:1 / -1", tablet)
        # the phone keeps the tablet's arrangement -- two eyes on row one,
        # the Mouth across row two -- one hand sized. (It used to fall
        # back to a single column in DOM order, which put the Mouth
        # BETWEEN the eyes; see Responsive for the full pin.)
        phone = STYLE[STYLE.index("@media (max-width: 560px)"):]
        self.assertIn(".console-deck { grid-template-columns:1fr 1fr;", phone)
        self.assertIn(".console-deck .mouth { grid-column:1 / -1", phone)
        self.assertIn(".dj-switch { min-height:44px; }", phone)

    def test_the_render_starts_the_loop_last(self):
        render = SRC[SRC.index("  _render() {"):SRC.index("if (!customElements.get(")]
        self.assertGreater(render.rindex("this._mouthStart();"), render.rindex("this._restoreLyricScroll();"))


class TheStageCarriesNoSecondDisplay(unittest.TestCase):
    """The small bar meter that used to sit beside the state line is GONE.

    It said exactly what the Mouth says, in the same three states, from
    the same rule -- two displays of one fact, the smaller of them on the
    record's card rather than on the station's console. The console is
    where the station describes itself, so the stage keeps the record and
    the Mouth keeps the station. This class exists so it cannot drift
    back: a second activity display on the stage is a decision, not an
    accident."""

    ONAIR = SRC[SRC.index("  _renderOnAir() {"):SRC.index("  /* IS AUDIO MOVING")]

    def test_the_meter_is_gone_from_markup_and_style(self):
        for gone in ("_renderMeter", '"meter "', "meter-bar", "@keyframes meter-sway",
                     "@keyframes meter-speak", "Station meter"):
            self.assertNotIn(gone, SRC, gone)
        for gone in (".meter {", ".meter-bar", ".meter.music", ".meter.speaking",
                     ".meter.idle"):
            self.assertNotIn(gone, STYLE, gone)

    def test_the_state_line_keeps_its_words_and_the_progress_bar_its_row(self):
        """What the meter sat beside is untouched: the stage still says what
        the station is doing, in words, above an unchanged progress row."""
        self.assertIn('class="state-line', self.ONAIR)
        self.assertIn("progress-fill", self.ONAIR)
        self.assertIn("progress-clock", self.ONAIR)

    def test_one_audio_rule_remains_and_the_mouth_is_its_only_reader(self):
        self.assertEqual(SRC.count("  _audioMode(bs, na, player) {"), 1)
        self.assertEqual(SRC.count("this._audioMode("), 1,
                         "the Mouth is the one display that reads it")


class TheMouthsClockSurvivesARerender(unittest.TestCase):
    """The flicker was a CLOCK, not a waveform.

    Every Home Assistant state change anywhere in the home replaces this
    shadow tree, on a busy installation about once a second. The canvas
    is rebuilt with it, and the animation clock used to be rebuilt too --
    so the wave restarted from phase zero before it had travelled. The
    motion maths is deliberately NOT touched by the fix and is pinned
    here as unchanged; what changed is that the phase is carried across a
    rebuild of the same state.

    Executed in test_panel_console.mjs (the phase actually reached, and
    that a state change still starts from zero)."""

    MOUTH = SRC[SRC.index("  // --- the Broadcast Console: the Mouth"):SRC.index("  /* AIR CHECK:")]
    START = MOUTH[MOUTH.index("  _mouthStart() {"):MOUTH.index("  _mouthStop() {")]
    FRAME = MOUTH[MOUTH.index("  _mouthFrame(ts) {"):MOUTH.index("  /* Page hidden:")]

    def test_the_phase_is_carried_only_when_the_state_is_the_same(self):
        self.assertIn("const prev = this._mouth;", self.START)
        self.assertIn("const keep = !!prev && prev.mode === st.mode", self.START)
        self.assertIn("t0: keep ? prev.t0 : null", self.START)
        self.assertIn("tSec: keep ? (prev.tSec || 0) : 0", self.START)

    def test_the_rebuild_redraws_at_the_carried_phase_not_at_zero(self):
        self.assertIn("this._mouthDraw(this._mouth.tSec);", self.START)
        self.assertNotIn("this._mouthDraw(0);", self.START)

    def test_the_frame_clock_is_still_the_frame_clock(self):
        """No timer, no accumulator: t0 remains a frame timestamp and the
        elapsed time is still read from the frame, so a slow or throttled
        display cannot make the Mouth drift ahead of real time."""
        self.assertIn("if (m.t0 == null) m.t0 = ts - m.tSec * 1000;", self.FRAME)
        self.assertIn("m.tSec = (ts - m.t0) / 1000;", self.FRAME)
        for banned in ("setInterval", "Date.now()", "+=", "performance.now"):
            self.assertNotIn(banned, self.FRAME, banned)

    def test_the_motion_maths_is_unchanged(self):
        """The waveforms are settled. If a future edit wants
        to retune them it must say so here rather than ride in on a fix."""
        speech = SRC[SRC.index("  if (mode === MOUTH_PROGRAM_VOICE) {"):
                     SRC.index("  if (mode === MOUTH_MUSIC) {")]
        self.assertIn("const phrase = 0.62 + 0.38 * Math.sin(TAU * t / 2.9);", speech)
        self.assertIn("0.62 + 0.25 * Math.sin(TAU * t * 3.4)", speech)
        music = SRC[SRC.index("  if (mode === MOUTH_MUSIC) {"):
                    SRC.index("  return 0.06;")]
        self.assertIn("0.27 + 0.10 * Math.sin(TAU * t / 3.6 + 1.4 * x)", music)
        self.assertIn("return 0.06;", SRC, "idle is still a resting line")


class VolumeBelongsToMusicAssistant(unittest.TestCase):
    STATE = SRC[SRC.index("  _volumeState() {"):SRC.index("  _setVolume(fraction) {")]
    SET = SRC[SRC.index("  _setVolume(fraction) {"):SRC.index("  _toggleMute() {")]
    RENDER = SRC[SRC.index("  _renderVolume() {"):SRC.index("  _transport(service) {")]

    def test_it_uses_the_players_own_supported_service(self):
        """Music Assistant owns the player entity, so volume_set on that
        entity IS Music Assistant's volume API -- the same route the
        transport buttons take. Nothing here reimplements a mixer."""
        self.assertIn('_svc("media_player", "volume_set"', self.SET)
        self.assertIn("volume_level", self.SET)
        for banned in ("parlorwave_radio/", "/settings/", "group_members",
                       "per-speaker", "mixer"):
            self.assertNotIn(banned, self.SET, banned)

    def test_support_is_read_from_the_player_never_assumed(self):
        self.assertIn("supported_features", self.STATE)
        self.assertIn("MP_VOLUME_SET", self.STATE)
        self.assertIn("const MP_VOLUME_SET = 4;", SRC)

    def test_an_unsupported_player_is_disabled_and_says_why(self):
        self.assertIn("does not support volume", self.RENDER)
        self.assertIn("v.can", self.RENDER)

    def test_no_speaker_means_no_slider_at_all(self):
        self.assertIn("if (!v.player) return \"\";", self.RENDER)

    def test_an_unavailable_speaker_is_named_rather_than_silently_dead(self):
        self.assertIn("unavailable", self.RENDER)
        self.assertIn("v.why", self.RENDER)

    def test_the_slider_shows_the_player_not_our_wish(self):
        """No optimistic local value: a command Music Assistant rejects or
        clamps must show the truth, not the number we asked for."""
        self.assertIn("volume_level", self.STATE)
        self.assertIn("this._volDrag", self.RENDER)
        # the drag value is CLEARED on commit, so the entity wins again
        block = SRC[SRC.index('vol.addEventListener("change"'):]
        self.assertIn("this._volDrag = null;", block[:300])

    def test_an_unreported_level_is_shown_as_unknown_not_as_silence(self):
        self.assertIn("level == null", self.RENDER)
        self.assertIn('"—"', self.RENDER)

    def test_it_follows_the_active_dj_speaker(self):
        """Changing the Active DJ speaker changes which volume is shown,
        because the state is derived from _player and nothing caches it."""
        self.assertIn("const p = this._player;", self.STATE)

    def test_the_slider_is_reachable_and_described(self):
        self.assertIn("aria-label=", self.RENDER)
        self.assertIn("aria-valuetext=", self.RENDER)
        self.assertIn('type="range"', self.RENDER)
        self.assertIn(".vol input[type=range]:focus-visible", STYLE)

    def test_mute_is_offered_only_when_the_player_offers_it(self):
        self.assertIn("canMute", self.RENDER)
        self.assertIn("MP_VOLUME_MUTE", self.STATE)


class ConsoleUxRefinements(unittest.TestCase):
    """The four On Air UX refinements:
    1. Loading state knob polish: disabled left knob remains visually solid with opacity 1 and LED off.
    2. Grille text removed: no static instructional text printed on lower grille face.
    3. Knob hover help: exact required text on hover/focus and title attributes.
    4. Center script logo: ParlorWave mark centered above display with double-click toggle.
    """

    CONSOLE = SRC[SRC.index("  _renderConsole(dj, bs, hasEnabledOutputs) {"):SRC.index("  /* IS AUDIO MOVING")]
    DJ_SWITCH = SRC[SRC.index("  _renderDjSwitch(dj, bs) {"):SRC.index("  /* BREAK LENGTH AND CADENCE")]

    def test_loading_state_knob_body_remains_visually_solid(self):
        self.assertIn(".dj-switch:not(.pending):disabled { opacity:1; }", STYLE)
        self.assertNotIn(".dj-switch:not(.pending):disabled { opacity:.55; }", STYLE)
        self.assertIn(".dj-switch:disabled { cursor:not-allowed; opacity:1; }", STYLE)

    def test_static_grille_instruction_text_is_removed(self):
        for banned in ("knob-sub", "knob-action", "2-Click for power", "Turn for volume",
                       "2-Click for speaker", "Turn to tune"):
            self.assertNotIn(banned, self.CONSOLE, banned)
            self.assertNotIn(banned, self.DJ_SWITCH, banned)

    def test_knobs_carry_required_hover_help_and_tooltips(self):
        # One vocabulary: the engraved caption, the hover/focus
        # tooltip and the first-press whisper say the same thing, and no
        # native title= doubles the tooltip.
        self.assertNotIn("title=", self.DJ_SWITCH)
        self.assertIn('<span class="knob-caption" aria-hidden="true">Volume \u00b7 DJ</span>', self.DJ_SWITCH)
        self.assertIn('Turn: volume \u00b7 Push twice: DJ on/off', self.DJ_SWITCH)
        self.assertNotIn('title="1 click for Tune', SRC)
        self.assertIn('<span class="knob-caption" aria-hidden="true">Tuning \u00b7 Speakers</span>', self.CONSOLE)
        self.assertIn('Turn: stations \u00b7 Push twice: speakers', self.CONSOLE)
        for stale in ("2 click for power", "2 click for Setup", "1 click for Tune"):
            self.assertNotIn(stale, SRC, stale)
        # Hover/focus tooltip style, and the caption's
        self.assertIn(".knob-tooltip {", STYLE)
        self.assertIn(".knob-caption {", STYLE)
        self.assertIn(".pw-knob-unit:hover .knob-tooltip", STYLE)
        self.assertIn(".pw-knob-unit:focus-within .knob-tooltip", STYLE)

    def test_center_script_logo_badge_is_centered_and_interactive(self):
        self.assertIn("this._renderCenterBadge()", self.CONSOLE)
        self.assertIn('id="console-badge"', SRC)
        self.assertIn("ParlorWave", SRC)
        self.assertIn(".console-badge {", STYLE)
        # The wordmark is the production vector, mounted as an image;
        # the station name is engraved live on a brass plate (test_panel_badge)
        self.assertIn('class="console-badge-emblem"', SRC)
        self.assertIn("encodeURIComponent(PW_EMBLEM_SVG)", SRC)
        self.assertIn(".console-badge-plate-text text {", STYLE)
        # the DJ sleeve keeps its own drawn script
        self.assertIn(".art-dj-script {", STYLE)
        self.assertIn("font-family:\"Brush Script MT\"", STYLE)
        # Interactive cycling: logo -> station -> hidden
        self.assertIn("this._cycleCenterLogo()", SRC)
        self.assertIn("parlorwave_logo_mode", SRC)


if __name__ == "__main__":
    unittest.main()
