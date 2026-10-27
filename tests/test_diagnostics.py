"""Tests for Parlorwave Radio diagnostics platform.

Proves:
  1. The diagnostics output conforms to Home Assistant config entry standards.
  2. The positive allowlist prevents any sensitive or private information
     from leaking, even when coordinator or entry is seeded with hostile fixtures.
"""

from __future__ import annotations

import json
import unittest
from unittest.mock import MagicMock

from harness import make_hass
from custom_components.parlorwave_radio.const import DATA_VERSION, DOMAIN
from custom_components.parlorwave_radio.diagnostics import (
    async_get_config_entry_diagnostics,
)


class TestDiagnosticsAllowlist(unittest.IsolatedAsyncioTestCase):
    async def test_diagnostics_structure_and_safe_scalars(self):
        hass, entry = make_hass()
        hass.data[DATA_VERSION] = "0.1.0-alpha.1"

        coordinator = MagicMock()
        coordinator.last_update_success = True
        coordinator.data = {
            "health": {
                "instance_id": "SHOULD_NOT_LEAK_UUID",
                "features": {
                    "home_assistant": {"mode": "addon", "reachable": True},
                    "music_assistant": {"reachable": True, "url": "http://music.example.com:8095"},
                    "observer": {"running": True, "configured_mode": "fixed"},
                    "tts": {"providers": ["home_assistant"], "configured": True},
                    "audio": {"break_audio_base": True},
                    "writer": {"llm": {"configured": False}},
                },
                "problems": [],
            },
            "outputs": {
                "outputs": [
                    {"player_id": "player1", "name": "Living Room"},
                    {"player_id": "player2", "name": "Kitchen"},
                ]
            },
            "dj": {
                "outputs": {"enabled": ["player1"]}
            },
        }
        hass.data[DOMAIN] = {entry.entry_id: coordinator}

        diag = await async_get_config_entry_diagnostics(hass, entry)

        # Verify JSON serializable
        serialized = json.dumps(diag)
        self.assertIsInstance(serialized, str)

        # Check positive allowlist values
        self.assertEqual(diag["integration"]["version"], "0.1.0-alpha.1")
        self.assertEqual(diag["environment"]["run_mode"], "addon")
        self.assertTrue(diag["environment"]["backend_reachable"])
        self.assertTrue(diag["environment"]["music_assistant_reachable"])
        self.assertEqual(diag["outputs"]["eligible_output_count"], 2)
        self.assertEqual(diag["outputs"]["enabled_output_count"], 1)
        self.assertTrue(diag["speech"]["tts_available"])
        self.assertTrue(diag["speech"]["tts_configured"])
        self.assertTrue(diag["lifecycle"]["observer_running"])

    async def test_hostile_sensitive_fixture_leak_proof(self):
        """Seed entry and coordinator with hostile/sensitive data and prove NONE leaks."""
        hass, entry = make_hass()
        hass.data[DATA_VERSION] = "0.1.0-alpha.1"

        HOSTILE_SEEDS = [
            "SECRET_PASSWORD_123",
            "CONFIDENTIAL_API_KEY_999",
            "172.16.254.99",
            "music-assistant.internal.lan",
            "Living Room Sonos Arc",
            "Baby Nursery Speaker",
            "media_player.bedroom_sonos",
            "/opt/private_storage/secret_store.db",
            "Doctor Appointment with Dr. Jones",
            "Top Secret News Bulletin",
            "Marlow Kites - Left Turn",
            "USER_REQUEST_PLAY_COLD_ORCHARD",
            "INSTALLATION_UUID_SECRET_ABCD",
        ]

        coordinator = MagicMock()
        coordinator.last_update_success = True
        coordinator.data = {
            "health": {
                "instance_id": "INSTALLATION_UUID_SECRET_ABCD",
                "api_key": "CONFIDENTIAL_API_KEY_999",
                "features": {
                    "home_assistant": {
                        "mode": "addon",
                        "reachable": True,
                        "token": "SECRET_PASSWORD_123",
                    },
                    "music_assistant": {
                        "reachable": True,
                        "url": "http://music-assistant.internal.lan:8095/172.16.254.99",
                    },
                    "observer": {
                        "running": True,
                        "configured_mode": "fixed",
                        "database": "/opt/private_storage/secret_store.db",
                    },
                    "tts": {
                        "providers": ["home_assistant", "malicious_unregistered_engine"],
                    },
                    "calendar": {
                        "summary": "Doctor Appointment with Dr. Jones",
                    },
                    "news": {
                        "bulletin": "Top Secret News Bulletin",
                    },
                },
                "problems": [],
            },
            "outputs": {
                "outputs": [
                    {"player_id": "media_player.bedroom_sonos", "name": "Living Room Sonos Arc"},
                    {"player_id": "player_nursery", "name": "Baby Nursery Speaker"},
                ]
            },
            "dj": {
                "outputs": {"enabled": ["media_player.bedroom_sonos"]},
                "current_track": "Marlow Kites - Left Turn",
                "last_request": "USER_REQUEST_PLAY_COLD_ORCHARD",
            },
        }
        hass.data[DOMAIN] = {entry.entry_id: coordinator}

        diag = await async_get_config_entry_diagnostics(hass, entry)
        dumped = json.dumps(diag)

        for hostile_str in HOSTILE_SEEDS:
            self.assertNotIn(
                hostile_str,
                dumped,
                f"Hostile sensitive string leaked into diagnostics: {hostile_str}",
            )

    async def test_uncontacted_coordinator_is_safe(self):
        """When coordinator has not yet connected, diagnostics returns safe defaults."""
        hass, entry = make_hass()
        hass.data[DOMAIN] = {entry.entry_id: None}

        diag = await async_get_config_entry_diagnostics(hass, entry)
        self.assertFalse(diag["environment"]["backend_reachable"])
        self.assertEqual(diag["outputs"]["eligible_output_count"], 0)
        self.assertEqual(diag["outputs"]["enabled_output_count"], 0)
        self.assertFalse(diag["speech"]["tts_available"])
        self.assertEqual(diag["readiness"]["state"], "checking")

    def test_schema_contract_exact_positive_allowlist_fails_closed(self):
        """Schema contract test that fails closed if ANY unapproved key appears at any level."""
        import asyncio

        EXPECTED_SCHEMA = {
            "integration": {"version"},
            "environment": {"run_mode", "backend_reachable", "music_assistant_reachable"},
            "outputs": {"eligible_output_count", "enabled_output_count"},
            "speech": {"tts_available", "tts_configured"},
            "readiness": {"state", "complete_steps", "total_steps", "checklist", "active_problem_codes"},
            "lifecycle": {"observer_running"},
        }
        CHECKLIST_ITEM_KEYS = {"code", "done", "route"}

        hass, entry = make_hass()
        hass.data[DATA_VERSION] = "0.1.0-alpha.1"

        coordinator = MagicMock()
        coordinator.last_update_success = True
        # Seed coordinator with arbitrary upstream / future fields that MUST NOT leak
        coordinator.data = {
            "health": {
                "instance_id": "SHOULD_NOT_LEAK",
                "features": {
                    "home_assistant": {
                        "mode": "addon",
                        "reachable": True,
                        "token": "leak_token",
                        "extra_future_leak": "bad",
                    },
                    "music_assistant": {"reachable": True, "url": "http://music.example:8095"},
                    "observer": {"running": True, "configured_mode": "fixed", "leak": 123},
                    "tts": {"providers": ["home_assistant"], "configured": True, "extra": "leak"},
                    "audio": {"break_audio_base": True, "leak_url": "http://secret"},
                    "writer": {"llm": {"configured": True, "model": "secret_model"}},
                    "unapproved_future_component": {"status": "bad"},
                },
                "problems": [],
            },
            "outputs": {
                "outputs": [{"player_id": "p1", "name": "Living Room"}],
                "future_unapproved_field": "leak",
            },
            "dj": {
                "outputs": {"enabled": ["p1"]},
                "future_setting": True,
            },
        }
        hass.data[DOMAIN] = {entry.entry_id: coordinator}

        diag = asyncio.run(async_get_config_entry_diagnostics(hass, entry))

        # 1. Top-level keys must match EXACTLY
        self.assertEqual(
            set(diag.keys()),
            set(EXPECTED_SCHEMA.keys()),
            f"Top-level schema mismatch. Unexpected: {set(diag.keys()) - set(EXPECTED_SCHEMA.keys())}",
        )

        # 2. Each section's keys must match EXACTLY
        for section, expected_keys in EXPECTED_SCHEMA.items():
            actual_keys = set(diag[section].keys())
            self.assertEqual(
                actual_keys,
                expected_keys,
                f"Section '{section}' has schema drift. Extra: {actual_keys - expected_keys}, Missing: {expected_keys - actual_keys}",
            )

        # 3. Checklist items must match EXACTLY
        for item in diag["readiness"]["checklist"]:
            self.assertEqual(
                set(item.keys()),
                CHECKLIST_ITEM_KEYS,
                f"Checklist item has unapproved keys: {set(item.keys()) - CHECKLIST_ITEM_KEYS}",
            )


if __name__ == "__main__":
    unittest.main()
