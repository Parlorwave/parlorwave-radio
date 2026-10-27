"""What the recorder keeps about these entities, executed.

The DJ status sensor republishes a countdown every poll and the Now
Playing sensor republishes an elapsed-time basis; both are attributes,
and Home Assistant's recorder writes a new state row and a new
attributes row for every change it sees. On a Raspberry Pi that is the
SD card. `recorder.py` names the attributes that must not be recorded
and `sensor.py` declares them to Home Assistant through the entity's
`_unrecorded_attributes`; these tests prove the set is the right one --
that after stripping it, two consecutive polls that differ only in those
values serialise identically -- that nothing a person would look for in
History was stripped with them, and that the entities really do hand the
set to the recorder, which is the half that shipped broken.
"""

import asyncio
import copy
import unittest

from harness import FakeTransport, coordinator_of, make_hass

import custom_components.parlorwave_radio as integration
from custom_components.parlorwave_radio import recorder
from custom_components.parlorwave_radio.sensor import (DjStatusSensor,
                                                       NowPlayingSensor)


def setup():
    hass, entry = make_hass(FakeTransport())
    asyncio.run(integration.async_setup_entry(hass, entry))
    return hass, entry


def recorded(entity, attrs):
    """The attributes the recorder would serialise for this entity.

    Derived from the entity's own `state_info`, which is where Home
    Assistant reads the exclusion from -- not from VOLATILE_ATTRIBUTES
    directly. An earlier version of this helper stripped the module's
    set by hand, so it went on passing while the entities declared no
    exclusion at all and the recorder wrote every attribute.
    """
    excluded = entity.state_info["unrecorded_attributes"]
    return {k: v for k, v in attrs.items() if k not in excluded}


class TheMechanismHomeAssistantActuallyReads(unittest.TestCase):
    """The recorder takes the exclusion from the ENTITY, not from a hook.

    `recorder.py`'s `exclude_attributes` platform hook was removed from
    Home Assistant: a `recorder.py` is still imported but only its
    statistics methods are read (`INTEGRATION_PLATFORM_METHODS`), so an
    `exclude_attributes` beside them is ignored without a word in the
    log. Relying on it recorded every volatile attribute exactly as
    before, and only reading the recorder rows of a running installation
    shows it. These tests pin the mechanism that works.
    """

    def test_both_sensors_declare_the_set_to_the_recorder(self):
        hass, entry = setup()
        coordinator = coordinator_of(hass, entry)
        for cls in (DjStatusSensor, NowPlayingSensor):
            entity = cls(coordinator, entry.entry_id)
            self.assertEqual(
                entity.state_info["unrecorded_attributes"],
                recorder.VOLATILE_ATTRIBUTES,
                f"{cls.__name__} does not tell the recorder what to drop",
            )

    def test_the_removed_platform_hook_is_not_the_mechanism(self):
        self.assertFalse(
            hasattr(recorder, "exclude_attributes"),
            "exclude_attributes is dead in Home Assistant; a module that "
            "defines it looks like it works and silently does nothing",
        )

    def test_every_excluded_attribute_is_one_the_sensors_publish(self):
        hass, entry = setup()
        coordinator = coordinator_of(hass, entry)
        coordinator.data["now_card"] = {"kind": "music", "title": "One",
                                        "artist": "A", "elapsed": 12.0,
                                        "elapsed_at": "2026-09-17T20:00:00",
                                        "state": "playing"}
        published = set(DjStatusSensor(coordinator, entry.entry_id).extra_state_attributes)
        published |= set(NowPlayingSensor(coordinator, entry.entry_id).extra_state_attributes)
        self.assertEqual(recorder.VOLATILE_ATTRIBUTES - published, set(),
                         "an excluded attribute nobody publishes is a stale list")


class TwoPollsApart(unittest.TestCase):
    def test_a_countdown_tick_does_not_change_what_is_recorded(self):
        hass, entry = setup()
        coordinator = coordinator_of(hass, entry)
        dj = coordinator.data["dj_status"]["dj"]
        dj.update({"status": "scheduled", "target_air_at": "2026-09-17T20:05:00",
                   "estimated_seconds_to_air": 300})
        sensor = DjStatusSensor(coordinator, entry.entry_id)
        first = sensor.extra_state_attributes
        # ten seconds later: the same break, ten seconds closer, the
        # observer's last-poll facts republished
        dj.update({"target_air_at": "2026-09-17T20:05:00",
                   "estimated_seconds_to_air": 290})
        coordinator.data["health"] = copy.deepcopy(coordinator.data.get("health") or {})
        second = sensor.extra_state_attributes
        self.assertNotEqual(first, second, "the fixture did not tick")
        self.assertEqual(recorded(sensor, first), recorded(sensor, second))

    def test_progress_does_not_change_what_is_recorded_about_now_playing(self):
        hass, entry = setup()
        coordinator = coordinator_of(hass, entry)
        card = {"kind": "music", "title": "One", "artist": "A", "album": "L",
                "duration": 240.0, "elapsed": 12.0,
                "elapsed_at": "2026-09-17T20:00:00", "state": "playing",
                "queue_item_id": "qi-1"}
        coordinator.data["now_card"] = card
        sensor = NowPlayingSensor(coordinator, entry.entry_id)
        first = sensor.extra_state_attributes
        coordinator.data["now_card"] = {**card, "elapsed": 22.0,
                                        "elapsed_at": "2026-09-17T20:00:10"}
        second = sensor.extra_state_attributes
        self.assertNotEqual(first, second)
        self.assertEqual(recorded(sensor, first), recorded(sensor, second))

    def test_what_a_person_looks_for_in_history_is_still_recorded(self):
        hass, entry = setup()
        coordinator = coordinator_of(hass, entry)
        coordinator.data["dj_status"]["dj"].update({
            "status": "idle",
            "last_break": {"air_start": "2026-09-17T19:48:00", "kind": "cadence",
                           "spoken_text": "That was Ada with One.",
                           "personality": "warm", "voice": "piper_alba"}})
        coordinator.data["now_card"] = {"kind": "music", "title": "One",
                                        "artist": "A", "album": "L",
                                        "elapsed": 1.0, "elapsed_at": "x"}
        dj_sensor = DjStatusSensor(coordinator, entry.entry_id)
        dj = recorded(dj_sensor, dj_sensor.extra_state_attributes)
        now_sensor = NowPlayingSensor(coordinator, entry.entry_id)
        now = recorded(now_sensor, now_sensor.extra_state_attributes)
        for key in ("enabled", "last_break_at", "last_break_kind", "last_spoken",
                    "last_break_personality", "last_break_voice", "current_break"):
            self.assertIn(key, dj, key)
        for key in ("kind", "title", "artist", "album"):
            self.assertIn(key, now, key)


if __name__ == "__main__":
    unittest.main()
