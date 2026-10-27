"""Speak DJ breaks: its own switch, beside -- never instead of -- the DJ.

The backend keeps two settings: `dj.enabled` (the DJ runs at all) and
`dj.speech_enabled` (the DJ speaks its breaks). The integration must keep
them as two entities that read and write two different fields, name the
new one so nobody mistakes it for muting the music, and let the panel
reach it by its registry key.
"""

import asyncio
import unittest
from pathlib import Path

import harness  # noqa: F401  -- puts the fakes and the package on sys.path

from custom_components.parlorwave_radio import switch as switch_platform
from custom_components.parlorwave_radio.sensor import DjStatusSensor
from custom_components.parlorwave_radio.switch import (DjEnabledSwitch,
                                                       DjSpeechSwitch)

PANEL = (Path(__file__).resolve().parent.parent / "custom_components"
         / "parlorwave_radio" / "panel" / "parlorwave-radio-panel.js"
         ).read_text()


class _Client:
    base_url = "http://parlorwave.internal:5005"

    def __init__(self):
        self.writes = []

    async def set_dj_enabled(self, on):
        self.writes.append(("enabled", on))

    async def set_dj_speech_enabled(self, on):
        self.writes.append(("speech_enabled", on))


class StubCoordinator:
    def __init__(self, dj_settings=None, dj_status=None):
        self.last_update_success = True
        self.client = _Client()
        self.refreshes = 0
        self.data = {"dj_settings": dj_settings or {},
                     "dj_status": {"dj": dj_status or {}}}

    async def async_request_refresh(self):
        self.refreshes += 1

    async def async_refresh(self):
        self.refreshes += 1

    # what DjStatusSensor's attributes also read
    def enabled_outputs(self, data):
        return []

    def observer(self, data):
        return None

    def problems(self, data):
        return []

    def music_catalog(self, data):
        return None

    def station_name(self, data):
        return None


class TheSwitch(unittest.TestCase):
    def test_its_own_entity_beside_the_dj_switch(self):
        c = StubCoordinator()
        speech, power = DjSpeechSwitch(c, "entry1"), DjEnabledSwitch(c, "entry1")
        self.assertEqual(speech.unique_id, "entry1_dj_speech")
        self.assertEqual(power.unique_id, "entry1_dj_enabled")
        self.assertEqual(speech.name, "Speak DJ breaks")
        self.assertNotIn("mute", speech.name.lower())

    def test_reads_speech_enabled_independently_of_enabled(self):
        c = StubCoordinator({"enabled": True, "speech_enabled": False})
        self.assertIs(DjEnabledSwitch(c, "entry1").is_on, True)
        self.assertIs(DjSpeechSwitch(c, "entry1").is_on, False)
        c = StubCoordinator({"enabled": False, "speech_enabled": True})
        self.assertIs(DjEnabledSwitch(c, "entry1").is_on, False)
        self.assertIs(DjSpeechSwitch(c, "entry1").is_on, True)

    def test_an_older_service_without_the_field_is_unknown_not_a_guess(self):
        self.assertIsNone(DjSpeechSwitch(StubCoordinator({"enabled": True}),
                                         "entry1").is_on)

    def test_writes_only_the_speech_field(self):
        c = StubCoordinator({"enabled": True, "speech_enabled": True})
        sw = DjSpeechSwitch(c, "entry1")
        asyncio.run(sw.async_turn_off())
        asyncio.run(sw.async_turn_on())
        self.assertEqual(c.client.writes, [("speech_enabled", False),
                                           ("speech_enabled", True)])
        self.assertEqual(c.refreshes, 2)

    def test_not_gated_on_a_music_catalog(self):
        self.assertTrue(DjSpeechSwitch(StubCoordinator(), "entry1").available)

    def test_the_platform_registers_both(self):
        added = []

        class _Entry:
            entry_id = "entry1"

        class _Hass:
            data = {"parlorwave_radio": {"entry1": StubCoordinator()}}

        asyncio.run(switch_platform.async_setup_entry(
            _Hass(), _Entry(), lambda ents: added.extend(ents)))
        kinds = [type(e).__name__ for e in added]
        self.assertIn("DjEnabledSwitch", kinds)
        self.assertIn("DjSpeechSwitch", kinds)


class TheStatusSensor(unittest.TestCase):
    def test_publishes_speech_enabled_beside_enabled(self):
        c = StubCoordinator(dj_status={"enabled": True,
                                       "speech_enabled": False,
                                       "status": "speech_off"})
        s = DjStatusSensor(c, "entry1")
        self.assertEqual(s.native_value, "speech_off")
        attrs = s.extra_state_attributes
        self.assertIs(attrs["enabled"], True)
        self.assertIs(attrs["speech_enabled"], False)


class ThePanel(unittest.TestCase):
    def test_found_by_registry_key(self):
        self.assertIn('get _djSpeech() { return this._ent("dj_speech"); }',
                      PANEL)

    def test_it_sits_in_break_style_and_says_what_keeps_playing(self):
        start = PANEL.index("  _renderBreakStyle() {")
        body = PANEL[start:PANEL.index("\n  }\n", start)]
        self.assertIn('this._toggleRow("dj-speech", this._djSpeech,', body)
        hint = body[body.index('"dj-speech"'):]
        hint = hint[:hint.index(")}")]
        for word in ("news", "announcements", "music"):
            self.assertIn(word, hint)
        self.assertNotIn("mute", hint.lower())

    def test_the_dj_power_button_is_untouched(self):
        self.assertIn('on("dj-switch", () => this._toggle(this._dj));', PANEL)


if __name__ == "__main__":
    unittest.main()
