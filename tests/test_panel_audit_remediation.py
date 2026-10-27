"""Alpha.4 interface fixes: the source-level
contracts behind them. Behaviour is executed in test_panel_console.mjs
and test_panel_onair_interaction.mjs; these pin the shape that must not
drift back."""
import json
import re
import unittest
from pathlib import Path

# <repo>/tests in the public repository, <repo>/ha/tests here: the component
# sits beside this directory in both, and the public README is at the root
# of the public tree or under release/public/ in the source tree.
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
COMPONENT = ROOT / "custom_components" / "parlorwave_radio"
PANEL = (COMPONENT / "panel" / "parlorwave-radio-panel.js").read_text()
STYLE = PANEL[PANEL.index("<style>"):PANEL.index("</style>")]
_README = ROOT.parent / "release" / "public" / "integration" / "README.md"   # the source tree
if not _README.exists():
    _README = ROOT / "README.md"                                              # the public repository
README = _README.read_text()
STRINGS = json.loads((COMPONENT / "strings.json").read_text())
SWITCH = (COMPONENT / "switch.py").read_text()


def block(start, end):
    s = PANEL.index(start)
    return PANEL[s:PANEL.index(end, s)]


class AttentionIsSaidWherePeopleStand(unittest.TestCase):
    def test_the_step_that_needs_attention_is_read_from_the_readiness_document(self):
        b = block("  _attentionStep() {", "  _readyMode(r) {")
        self.assertIn('r.state !== "needs_attention"', b)
        self.assertIn("this._stepNeedsAttention(r, c)", b)
        # the step's own sentence; no problem code is translated here
        self.assertIn("detail: step.detail", b)
        for code in ("ma_unreachable", "ma_auth_rejected", "ma_token_missing"):
            self.assertNotIn(code, PANEL, code)

    def test_on_air_station_and_the_console_foot_consult_it(self):
        self.assertIn("const attention = this._attentionStep();",
                      block("  _broadcastState() {", "  _agoText(iso) {"))
        self.assertIn("const attention = this._attentionStep();",
                      block("  _renderConsole(dj, bs, hasEnabledOutputs) {", "  _audioMode(bs, na, player) {"))
        self.assertIn("const attention = this._attentionStep();",
                      block("  _stationTruthRows() {", "  _renderStationFollowing() {"))
        self.assertIn('bs.action === "settings"', block("  _renderOnAir() {", "  _renderLastBreak() {"))

    def test_the_request_line_asks_no_question_while_the_start_is_blocked(self):
        rl = block("  _renderRequestLine(d) {", "  _renderRequestLineCard() {")
        self.assertIn("if (r.confirm && !running && !sheet && !blocked) {", rl)
        self.assertIn('${unchecked ? "" : `<div class="hint" id="rl-say">', rl)


class TheDjSwitchWaitsForItsEcho(unittest.TestCase):
    def test_the_hold_is_bounded_and_never_optimistic(self):
        self.assertIn("const DJ_HOLD_MS = 15000;", PANEL)
        b = block("  _toggle(entity) {", "  _select(entity, option) {")
        self.assertIn("this._djHold = { want, from: entity.state, until: Date.now() + DJ_HOLD_MS };", b)
        self.assertIn("if (this._djHoldActive()) return;", b)
        self.assertIn("if (!ok) this._djHold = null;", b)
        self.assertIn("dj.state === h.want", b)
        self.assertIn("did not confirm within", b)
        # the LCD lamp and the knob read the same hold; the ticker settles an expired one
        self.assertIn("this._busy === dj.entity_id || this._djHoldActive()", block("  _lcdStatus(", "  _renderLcdStatus("))
        self.assertIn("if (this._djHold && Date.now() >= this._djHold.until)", block("  _tick() {", "  /* --- notices"))

    def test_the_integration_refreshes_immediately_after_a_write(self):
        write = SWITCH[SWITCH.index("    async def _write("):SWITCH.index("class DjEnabledSwitch")]
        self.assertIn("await self.coordinator.async_refresh()", write)
        self.assertNotIn("async_request_refresh", write)


class RefusalsAreSentences(unittest.TestCase):
    def test_no_catch_shows_the_service_words_as_they_came(self):
        for stale in ('this._setNotice(false, String((e && e.message) || e));',
                      'this._setNotice(false, (err && err.message) || String(err));',
                      'String((r && (r.message || r.reason)) || "no reason was given.")'):
            self.assertNotIn(stale, PANEL, stale)
        self.assertIn("_humanRefusal(raw) {", PANEL)
        self.assertIn("_refuse(prefix, raw) {", PANEL)

    def test_the_original_is_kept_for_support_and_no_host_is_named(self):
        self.assertIn('<details class="notice-more"><summary>Details for support</summary>', PANEL)
        self.assertIn("detail: opts.detail && opts.detail !== t", block("  _setNotice(ok, text, opts = {}) {", "  _armNotice(ms) {"))
        # every scheme the words show is a shape, never a host (PanelSafety)
        for m in re.finditer(r"https?://(.{0,3})", block("  _humanRefusal(raw) {", "  _refuse(prefix, raw) {")):
            self.assertTrue(m.group(1).startswith("\u2026"), m.group(0))


class TheKnobsExplainThemselves(unittest.TestCase):
    def test_captions_tooltips_and_the_whisper_share_one_vocabulary(self):
        console = block("  _renderConsole(dj, bs, hasEnabledOutputs) {", "  _audioMode(bs, na, player) {")
        dj = block("  _renderDjSwitch(dj, bs) {", "  _transportState() {")
        self.assertIn('class="knob-caption" aria-hidden="true">Volume · DJ</span>', dj)
        self.assertIn('class="knob-caption" aria-hidden="true">Tuning · Speakers</span>', console)
        self.assertIn(".knob-caption {", STYLE)
        self.assertNotIn("title=", dj)
        self.assertNotIn("title=", block("  _renderRightKnob(out, active) {", "  _renderCenterBadge() {"))
        for stale in ("2 click for power", "2 click for Setup", "1 click for Tune", "1 Click for volume"):
            self.assertNotIn(stale, PANEL, stale)

    def test_the_hint_counts_only_once_read_and_the_tablet_keeps_its_footer(self):
        hint = block("  _knobHint(which) {", "  _cancelHint() {")
        self.assertIn('this._showWhisper(text, "hint", KNOB_HINT_MS, () => {', hint)
        self.assertIn("this._cancelHint();", block("  _enterOutputMode(byPush = false) {", "  _resetOutputTimers("))
        self.assertIn("this._cancelHint();", block("  _enterStationMode() {", "  _stationStep("))
        tablet = STYLE[STYLE.index("@media (max-width: 900px)"):STYLE.index("@media (max-width: 560px)")]
        self.assertNotIn(".lcd-output .lcd-footer { display:none; }", tablet)


class NewsroomHeadlineAndLiveRegions(unittest.TestCase):
    def test_newsroom_save_refuses_an_address_less_source(self):
        save = block("  async _saveNews() {", "  /* Test Calendar.")
        self.assertLess(save.index("has no feed address"), save.index('this._busy = "news_save"'))

    def test_the_headline_switch_is_not_drawn(self):
        self.assertNotIn("mention a headline", PANEL)
        self.assertIn('_toggleRow("calendar"', block("  _renderBreakStyle() {", "  _voiceIdForName(name) {"))

    def test_live_regions_are_written_once_and_the_rebuilt_tree_has_none(self):
        self.assertIn('id="sr-status" class="visually-hidden" role="status" aria-live="polite" aria-atomic="true"', PANEL)
        self.assertIn('id="sr-alert" class="visually-hidden" role="alert" aria-live="assertive" aria-atomic="true"', PANEL)
        render = block("  _render() {", "    // wire events")
        self.assertIn("this._writeTree(markup, bs);", render)
        self.assertNotIn("aria-live", render)
        self.assertNotIn('role="alert"', render)
        self.assertNotIn('role="status"', render)
        writer = block("  _writeTree(markup, bs) {", "  _announce(bs) {")
        self.assertIn("app.innerHTML = markup;", writer)
        self.assertIn('root.innerHTML = `${PANEL_STYLE}${SR_REGIONS}<div id="pw-app">${markup}</div>`;', writer)
        self.assertEqual(PANEL.count("<style>"), 1, "one stylesheet, hoisted")


class TheReadmeTellsTheTruth(unittest.TestCase):
    def test_the_three_sentences(self):
        self.assertNotIn("nothing\nleaves the house.", README)
        # every optional service that receives something is named, and what it receives
        for told in ("Out of the box\nit talks only to your own Home Assistant and Music Assistant",
                     "keeps them on your\n  hardware", "Home Assistant Cloud to Nabu Casa, Google Translate\n  text-to-speech to Google",
                     "New Home Assistant installations include the Google Translate voice",
                     "A voice engine", "voice recordings you make in Booth",
                     "A writing model", "weather and calendar details", "A Newsroom feed"):
            self.assertIn(told, README)
        self.assertNotIn("chattiness", README)
        self.assertNotIn("Nothing else is touched.", README)
        self.assertIn("Nothing else is ever controlled.", README)
        desc = STRINGS["options"]["step"]["init"]["description"]
        self.assertIn("nothing else is ever controlled", desc)
        self.assertNotIn("observed", desc)


if __name__ == "__main__":
    unittest.main()
