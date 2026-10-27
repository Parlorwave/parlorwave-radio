"""Music stories: the listener's own switch, and never the rollout gate.

The backend keeps two story settings: `dj.stories_enabled` (the listener
wants stories; on by default) and `dj.stories_rollout` (the temporary
rollout gate). The integration exposes ONLY the first, as its own
entity beside "Speak DJ breaks", writing only its own field; the panel
reaches it by registry key and hides the row on an integration without it.
"""

import asyncio
import unittest
from pathlib import Path

import harness  # noqa: F401  -- puts the fakes and the package on sys.path

from custom_components.parlorwave_radio import switch as switch_platform
from custom_components.parlorwave_radio.switch import (DjSpeechSwitch,
                                                       DjStoriesSwitch)
from test_dj_speech_switch import StubCoordinator

PANEL = (Path(__file__).resolve().parent.parent / "custom_components"
         / "parlorwave_radio" / "panel" / "parlorwave-radio-panel.js"
         ).read_text()
SWITCH_SRC = (Path(__file__).resolve().parent.parent / "custom_components"
              / "parlorwave_radio" / "switch.py").read_text()


class TheSwitch(unittest.TestCase):

    def coordinator(self, dj_settings=None):
        c = StubCoordinator(dj_settings)
        writes = c.client.writes

        async def set_dj_stories_enabled(on):
            writes.append(("stories_enabled", on))
        c.client.set_dj_stories_enabled = set_dj_stories_enabled
        return c

    def test_its_own_entity(self):
        sw = DjStoriesSwitch(self.coordinator(), "entry1")
        self.assertEqual(sw.unique_id, "entry1_dj_stories")
        self.assertEqual(sw.name, "Music stories")

    def test_reads_the_preference_not_the_gate(self):
        c = self.coordinator({"stories_enabled": True,
                              "stories_rollout": False})
        self.assertIs(DjStoriesSwitch(c, "entry1").is_on, True)
        c = self.coordinator({"stories_enabled": False,
                              "stories_rollout": True})
        self.assertIs(DjStoriesSwitch(c, "entry1").is_on, False)

    def test_an_older_service_reads_unknown(self):
        self.assertIsNone(DjStoriesSwitch(self.coordinator({"enabled": True}),
                                          "entry1").is_on)

    def test_airing_is_the_services_verdict_not_the_preference(self):
        """On does not mean stories air: `airing` is /dj/status
        `stories_active`, and a service that does not report it gets no
        attribute rather than a guess."""
        c = self.coordinator({"stories_enabled": True,
                              "stories_rollout": False})
        sw = DjStoriesSwitch(c, "entry1")
        self.assertEqual(sw.extra_state_attributes, {})
        c.data["dj_status"]["stories_active"] = False
        self.assertIs(sw.is_on, True)
        self.assertEqual(sw.extra_state_attributes, {"airing": False})
        c.data["dj_status"]["stories_active"] = True
        self.assertEqual(sw.extra_state_attributes, {"airing": True})

    def test_writes_only_the_preference(self):
        c = self.coordinator({"stories_enabled": True})
        sw = DjStoriesSwitch(c, "entry1")
        asyncio.run(sw.async_turn_off())
        asyncio.run(sw.async_turn_on())
        self.assertEqual(c.client.writes, [("stories_enabled", False),
                                           ("stories_enabled", True)])

    def test_no_entity_exposes_the_rollout_gate(self):
        self.assertNotIn("stories_rollout\")", SWITCH_SRC)
        self.assertNotIn('get("stories_rollout', SWITCH_SRC)

    def test_registered_beside_the_speech_switch(self):
        added = []

        class _Entry:
            entry_id = "entry1"

        class _Hass:
            data = {"parlorwave_radio": {"entry1": StubCoordinator()}}

        asyncio.run(switch_platform.async_setup_entry(
            _Hass(), _Entry(), lambda ents: added.extend(ents)))
        kinds = [type(e).__name__ for e in added]
        self.assertEqual(kinds.index("DjStoriesSwitch"),
                         kinds.index("DjSpeechSwitch") + 1)
        self.assertIsInstance(added[kinds.index("DjSpeechSwitch")],
                              DjSpeechSwitch)


class ThePanel(unittest.TestCase):

    def test_found_by_registry_key(self):
        self.assertIn('get _djStories() { return this._ent("dj_stories"); }',
                      PANEL)

    def test_it_sits_under_speak_dj_breaks(self):
        start = PANEL.index("  _renderBreakStyle() {")
        body = PANEL[start:PANEL.index("\n  }\n", start)]
        self.assertLess(body.index('"dj-speech"'), body.index('"dj-stories"'))
        hint = body[body.index('"dj-stories"'):]
        hint = hint[:hint.index(")}")]
        self.assertIn("Music Assistant", hint)
        self.assertNotIn("`", hint)


if __name__ == "__main__":
    unittest.main()
