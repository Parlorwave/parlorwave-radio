"""Regression tests proving orphaned chattiness entity cleanup.

Proves:
  1. On upgrade, remove only the obsolete Parlorwave chattiness entity from
     the HA entity registry.
  2. Fresh installs must not create it.
  3. Cleanup must be idempotent (re-runs cause no errors, entity stays gone).
  4. Do not disturb any other Parlorwave entities (or foreign entities).
"""

from __future__ import annotations

import unittest

from harness import FakeTransport, make_hass
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entity_registry import RegistryEntry

from custom_components.parlorwave_radio import async_setup_entry
from custom_components.parlorwave_radio.const import DOMAIN


class TestChattinessCleanup(unittest.IsolatedAsyncioTestCase):
    async def test_upgrade_removes_obsolete_chattiness_entity(self):
        """1. On upgrade, remove only the obsolete Parlorwave chattiness entity from the registry."""
        hass, entry = make_hass(FakeTransport())
        registry = er.async_get(hass)

        # Pre-seed registry simulating state prior to the decoupling:
        # obsolete chattiness entity exists alongside valid Parlorwave and foreign entities
        chattiness_id = "select.parlorwave_radio_chattiness"
        personality_id = "select.parlorwave_radio_personality"
        speaker_id = "media_player.kitchen_speaker"

        registry.entities[chattiness_id] = RegistryEntry(
            unique_id=f"{entry.entry_id}_chattiness",
            entity_id=chattiness_id,
            config_entry_id=entry.entry_id,
            platform=DOMAIN,
        )
        registry.entities[personality_id] = RegistryEntry(
            unique_id=f"{entry.entry_id}_personality",
            entity_id=personality_id,
            config_entry_id=entry.entry_id,
            platform=DOMAIN,
        )
        registry.entities[speaker_id] = RegistryEntry(
            unique_id="kitchen_speaker_uid",
            entity_id=speaker_id,
            config_entry_id="different_entry",
            platform="music_assistant",
        )

        self.assertIsNotNone(registry.async_get(chattiness_id))
        self.assertIsNotNone(registry.async_get(personality_id))
        self.assertIsNotNone(registry.async_get(speaker_id))

        # Perform setup (upgrade path)
        await async_setup_entry(hass, entry)

        # Chattiness entity MUST be removed
        self.assertIsNone(
            registry.async_get(chattiness_id),
            "Obsolete chattiness entity was not removed from the registry on upgrade",
        )
        # Other entities MUST NOT be disturbed
        self.assertIsNotNone(
            registry.async_get(personality_id),
            "Valid ParlorWave personality entity was disturbed",
        )
        self.assertIsNotNone(
            registry.async_get(speaker_id),
            "Foreign entity was disturbed",
        )

    async def test_fresh_install_does_not_create_chattiness_entity(self):
        """2. Fresh installs must not create the chattiness entity."""
        hass, entry = make_hass(FakeTransport())
        registry = er.async_get(hass)

        # Fresh install has empty registry
        self.assertEqual(len(registry.entities), 0)

        await async_setup_entry(hass, entry)

        # Verify no entity with 'chattiness' in unique_id or entity_id was created
        chattiness_entities = [
            eid for eid, ent in registry.entities.items()
            if "chattiness" in getattr(ent, "unique_id", "").lower()
            or "chattiness" in eid.lower()
        ]
        self.assertEqual(
            chattiness_entities,
            [],
            f"Fresh install created obsolete chattiness entity: {chattiness_entities}",
        )

    async def test_cleanup_is_idempotent(self):
        """3. Cleanup must be idempotent (re-runs cleanly without error, entities stay intact)."""
        hass, entry = make_hass(FakeTransport())
        registry = er.async_get(hass)

        chattiness_id = "select.parlorwave_radio_chattiness"
        personality_id = "select.parlorwave_radio_personality"

        registry.entities[chattiness_id] = RegistryEntry(
            unique_id=f"{entry.entry_id}_chattiness",
            entity_id=chattiness_id,
            config_entry_id=entry.entry_id,
            platform=DOMAIN,
        )
        registry.entities[personality_id] = RegistryEntry(
            unique_id=f"{entry.entry_id}_personality",
            entity_id=personality_id,
            config_entry_id=entry.entry_id,
            platform=DOMAIN,
        )

        # First run removes it
        await async_setup_entry(hass, entry)
        self.assertIsNone(registry.async_get(chattiness_id))
        self.assertIsNotNone(registry.async_get(personality_id))

        # Second run (reboot / reload / re-setup) must succeed without error
        from custom_components.parlorwave_radio import _async_cleanup_orphaned_entities
        try:
            _async_cleanup_orphaned_entities(hass, entry)
        except Exception as exc:  # noqa: BLE001
            self.fail(f"Idempotent cleanup call raised unexpected exception: {exc}")

        self.assertIsNone(registry.async_get(chattiness_id))
        self.assertIsNotNone(registry.async_get(personality_id))

    async def test_do_not_disturb_any_other_parlorwave_entities(self):
        """4. Do not disturb any other Parlorwave entities (switches, sensors, numbers, selects)."""
        hass, entry = make_hass(FakeTransport())
        registry = er.async_get(hass)

        # Populate a comprehensive set of Parlorwave entities
        keys = [
            ("select", "break_length"),
            ("select", "voice"),
            ("select", "personality"),
            ("select", "station_feel"),
            ("switch", "dj_enabled"),
            ("switch", "endless_radio"),
            ("number", "cadence"),
            ("sensor", "station"),
            ("sensor", "now_playing"),
        ]

        expected_ids = set()
        for domain, key in keys:
            eid = f"{domain}.parlorwave_radio_{key}"
            registry.entities[eid] = RegistryEntry(
                unique_id=f"{entry.entry_id}_{key}",
                entity_id=eid,
                config_entry_id=entry.entry_id,
                platform=DOMAIN,
            )
            expected_ids.add(eid)

        # Also add obsolete chattiness
        chattiness_id = "select.parlorwave_radio_chattiness"
        registry.entities[chattiness_id] = RegistryEntry(
            unique_id=f"{entry.entry_id}_chattiness",
            entity_id=chattiness_id,
            config_entry_id=entry.entry_id,
            platform=DOMAIN,
        )

        await async_setup_entry(hass, entry)

        # Chattiness is gone
        self.assertIsNone(registry.async_get(chattiness_id))

        # Every other Parlorwave entity is preserved
        remaining_ids = set(registry.entities.keys())
        for eid in expected_ids:
            self.assertIn(
                eid,
                remaining_ids,
                f"ParlorWave entity {eid} was disturbed by chattiness cleanup",
            )


if __name__ == "__main__":
    unittest.main()
