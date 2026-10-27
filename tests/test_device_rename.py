"""Renaming the Parlorwave Radio device must not empty the product.

THE DEFECT THIS EXISTS TO PREVENT. The panel used to find its entities by
reading `friendly_name` and matching the words "parlorwave radio" plus a
hint. Home Assistant composes that name from the DEVICE's name, and
renaming a device is one click on the device page -- a thing people do
routinely, to say "Kitchen radio" or just to tidy up. Afterwards nothing
matched: On Air lost the DJ switch and the speaker picker, Booth fell
through to its not-loaded card, Station lost its toggles -- and the card
that appeared told the owner their integration might need an update.

`unique_id` is the identity that cannot drift. entity.py mints it as
f"{entry_id}_{key}"; it survives device renames, entity renames, entity_id
changes and reloads. The registry is asked for the mapping and the panel
looks up by key.

This test renames the device AND the entities AND the entity_ids, then
proves every key each of the five screens needs still resolves.
"""

import re
import unittest
from pathlib import Path

from harness import make_hass
from test_panel_settings import FakeConnection, setup, ws

from custom_components.parlorwave_radio.const import DOMAIN

ROOT = Path(__file__).resolve().parent.parent / "custom_components" / "parlorwave_radio"
PANEL = (ROOT / "panel" / "parlorwave-radio-panel.js").read_text()

#: every feature key the integration mints a unique_id for, read from the
#: platform sources so a new entity cannot be forgotten here
def _feature_keys() -> set[str]:
    keys = set()
    for name in ("sensor.py", "switch.py", "number.py", "select.py"):
        src = (ROOT / name).read_text()
        keys.update(re.findall(
            r'super\(\).__init__\(coordinator, entry_id, "([a-z_]+)"', src))
        keys.update(re.findall(r'entry_id, f"content_\{key\}"', src)
                    and {f"content_{k}" for k in
                         re.findall(r'^BREAK_CONTENT = \{"(\w+)"',
                                    (ROOT / "const.py").read_text(), re.M)}
                    or set())
    src = (ROOT / "const.py").read_text()
    keys.update(f"content_{k}" for k in
                re.findall(r'"(\w+)": "[^"]*in breaks"', src))
    return keys


FEATURE_KEYS = _feature_keys()

#: getter -> registry key, read from the panel so the two cannot drift
GETTERS = dict(re.findall(r'get (_\w+)\(\) \{ return this\._ent\("(\w+)"\); \}',
                          PANEL))

#: the five screens, as the source ranges that render them, plus the two
#: shared pieces drawn above every one of them
SCREENS = {
    "On Air": ("  _renderOnAir() {", "  /* BREAK LENGTH AND CADENCE"),
    "Booth": ("  _renderBooth() {", "\n  _personaName"),
    "Newsroom": ("  _renderNewsroom() {", "  /* --- Station"),
    "Station": ("  _renderStation() {", "  _renderDiagnostics() {"),
    "Settings": ("  /* --- Settings ---", "  _render() {"),
    "the banner and the stage line": ("  _renderProblems() {", "  // --- On Air"),
}


class RegistryEntry:
    """What Home Assistant's registry hands back. Only the three fields the
    command reads; `name` deliberately absent, because it must not be."""

    def __init__(self, unique_id, entity_id, disabled_by=None):
        self.unique_id = unique_id
        self.entity_id = entity_id
        self.disabled_by = disabled_by


def populate(hass, entry, *, prefix="parlorwave_radio"):
    """Create one registry entry per feature, the way Home Assistant would."""
    from homeassistant.helpers import entity_registry as er
    registry = er.async_get(hass)
    domains = {"station": "sensor", "dj_status": "sensor", "now_playing": "sensor",
               "dj_enabled": "switch", "endless_radio": "switch",
               "same_artist": "switch", "content_weather": "switch",
               "content_calendar": "switch", "content_news": "switch",
               "cadence": "number"}
    for key in sorted(FEATURE_KEYS):
        domain = domains.get(key, "select")
        entity_id = f"{domain}.{prefix}_{key}"
        registry.entities[entity_id] = RegistryEntry(
            f"{entry.entry_id}_{key}", entity_id)
    return registry


class TheEntityMap(unittest.TestCase):
    def _map(self, hass):
        return ws(hass, "entities")["entities"]

    def test_the_command_publishes_every_feature_by_key(self):
        from test_panel_settings import SettingsTransport
        hass, entry = setup(SettingsTransport())
        populate(hass, entry)
        published = self._map(hass)
        self.assertEqual(set(published), FEATURE_KEYS)
        self.assertTrue(FEATURE_KEYS, "no feature keys were discovered at all")

    def test_renaming_the_device_changes_nothing(self):
        """The rename itself: every friendly_name stops saying Parlorwave,
        and the entity_ids move with it. Home Assistant does not rewrite
        unique_ids, so neither does the answer."""
        from test_panel_settings import SettingsTransport
        hass, entry = setup(SettingsTransport())
        populate(hass, entry)
        before = self._map(hass)

        from homeassistant.helpers import entity_registry as er
        registry = er.async_get(hass)
        renamed = {}
        for entity_id, item in list(registry.entities.items()):
            new_id = entity_id.replace("parlorwave_radio", "kitchen_wireless")
            item.entity_id = new_id
            renamed[new_id] = item
        registry.entities.clear()
        registry.entities.update(renamed)
        # and nothing anywhere is called Parlorwave any more
        for entity_id in registry.entities:
            hass.states.async_set(entity_id, "on",
                                  {"friendly_name": "Kitchen Wireless "
                                                    + entity_id.split("_")[-1]})

        after = self._map(hass)
        self.assertEqual(set(after), set(before), "a key disappeared")
        for key, entity_id in after.items():
            self.assertTrue(entity_id.startswith(("switch.kitchen_wireless",
                                                  "select.kitchen_wireless",
                                                  "sensor.kitchen_wireless",
                                                  "number.kitchen_wireless")),
                            f"{key} -> {entity_id}")
            self.assertIsNotNone(hass.states.get(entity_id))

    def test_a_disabled_entity_is_left_out_rather_than_offered(self):
        from test_panel_settings import SettingsTransport
        hass, entry = setup(SettingsTransport())
        registry = populate(hass, entry)
        registry.entities["switch.parlorwave_radio_endless_radio"].disabled_by = "user"
        self.assertNotIn("endless_radio", self._map(hass))

    def test_another_integrations_entities_are_not_claimed(self):
        from test_panel_settings import SettingsTransport
        hass, entry = setup(SettingsTransport())
        registry = populate(hass, entry)
        registry.entities["switch.someone_elses_dj"] = RegistryEntry(
            "other_entry_dj_enabled", "switch.someone_elses_dj")
        self.assertNotIn("switch.someone_elses_dj", self._map(hass).values())


class EveryScreenStillResolves(unittest.TestCase):
    """The product-level claim: after a rename, no screen goes blank."""

    def setUp(self):
        from test_panel_settings import SettingsTransport
        hass, entry = setup(SettingsTransport())
        populate(hass, entry, prefix="kitchen_wireless")
        self.published = ws(hass, "entities")["entities"]

    def _keys_used_by(self, screen):
        start, end = SCREENS[screen]
        block = PANEL[PANEL.index(start):PANEL.index(end)]
        used = set()
        for getter, key in GETTERS.items():
            if re.search(rf"this\.{getter}\b", block):
                used.add(key)
        return used

    def test_the_panel_reads_its_getters_from_the_registry_map(self):
        self.assertTrue(GETTERS, "no _ent getters found in the panel")
        self.assertEqual(set(GETTERS.values()) - FEATURE_KEYS, set(),
                         "the panel asks for a key no platform mints")

    def test_every_screen_resolves_every_entity_it_reads(self):
        for screen in SCREENS:
            with self.subTest(screen=screen):
                needed = self._keys_used_by(screen)
                missing = sorted(needed - set(self.published))
                self.assertEqual(missing, [],
                                 f"{screen} cannot resolve {missing} after a rename")

    def test_the_screens_really_do_read_entities(self):
        """Guards the test above from passing because a range came back
        empty and nothing was therefore required."""
        for screen in ("On Air", "Booth", "Station"):
            with self.subTest(screen=screen):
                self.assertTrue(self._keys_used_by(screen), screen)

    def test_no_screen_matches_a_name_to_find_an_entity(self):
        self.assertNotIn("_find(domain", PANEL)
        self.assertNotIn('startsWith("parlorwave radio")', PANEL)
        self.assertNotIn("friendly_name || \"\").toLowerCase()", PANEL)


if __name__ == "__main__":
    unittest.main()
