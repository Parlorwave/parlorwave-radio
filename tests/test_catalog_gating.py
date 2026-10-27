"""Controls that cannot act are unavailable, not merely undrawn.

The Station screen already gets this right: with no local music catalog it
does not draw Endless Radio, station feel or artist rotation, because there
is nothing for them to shape -- Music Assistant programmes the music and
Parlorwave presents it.

The ENTITIES did not. All four existed, looked healthy, and accepted writes
on every installation, so the device page and the automation editor offered
four working-looking controls whose settings could never change what
anybody heard. One screen told the truth and the rest of Home Assistant
contradicted it.

The verdict is the backend's published capability (`features.catalog`, read
through `coordinator.music_catalog`) -- never re-derived, never guessed
from whether a station happens to be running.
"""

import unittest

import harness  # noqa: F401  -- puts the fakes and the package on sys.path

from custom_components.parlorwave_radio.coordinator import ParlorwaveRadioCoordinator
from custom_components.parlorwave_radio.select import (SameArtistFrequencySelect,
                                                       StationFeelSelect)
from custom_components.parlorwave_radio.switch import (DjEnabledSwitch,
                                                       EndlessRadioSwitch,
                                                       SameArtistSwitch)

FEELS = [{"id": "familiar", "name": "Familiar", "description": "safe picks"}]


class StubCoordinator:
    """Only what these entities read."""

    # the REAL verdict function, not a restatement of it
    music_catalog = staticmethod(ParlorwaveRadioCoordinator.music_catalog)


    def __init__(self, catalog=None, same_artist_on=True):
        self.last_update_success = True
        self.client = _Client()
        self.data = {
            "health": {"features": {"catalog": catalog}} if catalog else {},
            "studio_catalog": {"feels": FEELS},
            "playback_settings": {"keep_radio_playing": True},
            "station_settings": {"feel": "familiar",
                                 "same_artist": {"enabled": same_artist_on,
                                                 "frequency": "low"}},
            "dj_settings": {"enabled": True},
        }


class _Client:
    base_url = "http://parlorwave.internal:5005"


USABLE = {"usable": True, "track_count": 4000, "minimum_tracks": 5}
UNUSABLE = {"usable": False, "track_count": 0, "minimum_tracks": 5}
#: no health answer yet -- treated exactly like "no catalog", because a
#: control offered on a guess is the failure this contract exists to end
UNKNOWN = None


def entities(coordinator):
    return {
        "endless_radio": EndlessRadioSwitch(coordinator, "entry1"),
        "same_artist": SameArtistSwitch(coordinator, "entry1"),
        "same_artist_frequency": SameArtistFrequencySelect(coordinator, "entry1"),
        "station_feel": StationFeelSelect(coordinator, "entry1"),
    }


class CatalogGating(unittest.TestCase):
    def test_with_a_catalog_every_autonomous_control_is_available(self):
        for key, entity in entities(StubCoordinator(USABLE)).items():
            with self.subTest(entity=key):
                self.assertTrue(entity.available, key)

    def test_without_a_catalog_none_of_them_is(self):
        for key, entity in entities(StubCoordinator(UNUSABLE)).items():
            with self.subTest(entity=key):
                self.assertFalse(entity.available, key)

    def test_before_the_first_health_answer_none_of_them_is(self):
        for key, entity in entities(StubCoordinator(UNKNOWN)).items():
            with self.subTest(entity=key):
                self.assertFalse(entity.available, key)

    def test_the_gate_narrows_and_never_widens(self):
        """Station feel was already unavailable while its option list had
        not arrived, and the frequency while back-to-back was off. Adding
        the catalog gate must not have turned either of those into a yes."""
        no_options = StubCoordinator(USABLE)
        no_options.data["studio_catalog"] = {"feels": []}
        self.assertFalse(StationFeelSelect(no_options, "entry1").available)

        off = StubCoordinator(USABLE, same_artist_on=False)
        self.assertFalse(SameArtistFrequencySelect(off, "entry1").available)

    def test_a_dead_backend_still_takes_precedence(self):
        coordinator = StubCoordinator(USABLE)
        coordinator.last_update_success = False
        for key, entity in entities(coordinator).items():
            with self.subTest(entity=key):
                self.assertFalse(entity.available, key)

    def test_nothing_the_base_product_needs_is_gated(self):
        """The base installation is a complete installation. Whether the DJ
        speaks has nothing to do with whether this machine can pick music."""
        self.assertTrue(DjEnabledSwitch(StubCoordinator(UNUSABLE), "entry1").available)

    def test_the_entity_ids_are_unchanged(self):
        """Unavailable, not removed: an automation written on an
        installation that later gains a catalog must still resolve."""
        for key, entity in entities(StubCoordinator(UNUSABLE)).items():
            with self.subTest(entity=key):
                self.assertEqual(entity.unique_id, f"entry1_{key}")


class TheDeviceCard(unittest.TestCase):
    """What Home Assistant shows on the device page, which is customer-
    visible and was not written for a customer."""

    def _device_info(self):
        return DjEnabledSwitch(StubCoordinator(USABLE), "entry1").device_info

    def test_the_manufacturer_is_the_product_not_a_job_title(self):
        self.assertEqual(self._device_info()["manufacturer"], "ParlorWave")

    def test_no_unreachable_configuration_link_is_offered(self):
        """It pointed at the backend's own address on the internal add-on
        network, which no browser on the home network can open -- a "Visit
        device" link that always failed, advertising an internal hostname
        while it did. The add-on's configuration page has no stable address
        Home Assistant will give us, so the field is left unset."""
        info = self._device_info()
        self.assertIsNone(info.get("configuration_url"))
        self.assertNotIn("5005", repr(info))


class NoChattinessControl(unittest.TestCase):
    """Persona and airtime are decoupled.

    A Low/Normal/High entity would still write `dj.persona.chattiness`
    and the backend would still store it, but nothing in normal production
    reads it -- so the control would be a dial wired to nothing, offered
    on the device page and in every automation editor. The select platform
    therefore does not create one. The write path stays on the client for
    compatibility and debugging, which is not a customer surface.
    """

    def _created(self):
        import asyncio

        from custom_components.parlorwave_radio import select as select_mod

        made = []

        class Entry:
            entry_id = "entry1"

        hass = {"parlorwave_radio": {"entry1": StubCoordinator(USABLE)}}

        class Hass:
            data = hass

        asyncio.run(select_mod.async_setup_entry(
            Hass(), Entry(), lambda entities: made.extend(entities)))
        return made

    def test_the_select_platform_creates_no_chattiness_entity(self):
        made = self._created()
        self.assertTrue(made)
        names = [type(e).__name__ for e in made]
        self.assertNotIn("ChattinessSelect", names)
        for entity in made:
            self.assertNotIn("chattiness",
                             str(getattr(entity, "_attr_name", "")).lower())
            self.assertNotIn("chattiness", repr(entity.unique_id).lower())
        # the controls that ARE the Booth are all still here
        self.assertIn("PersonalitySelect", names)
        self.assertIn("VoiceSelect", names)
        self.assertIn("BreakLengthSelect", names)

    def test_the_module_defines_no_chattiness_entity_at_all(self):
        from custom_components.parlorwave_radio import select as select_mod
        self.assertFalse([n for n in dir(select_mod)
                          if "chattiness" in n.lower()])


if __name__ == "__main__":
    unittest.main()
