"""DJ voice switching, on the Home Assistant side.

The current DJ lives in ONE place, the backend's dj.persona.voice. The
integration holds no copy: the Voice select reads the shelf the backend
answers with, Switch DJ is one argument-free websocket command that asks
the backend to move to the next voice, and an integration reload finds
whatever the backend says. Picking a voice BY NAME refuses a name two
voices answer to, rather than taking whichever came first.
"""

import asyncio
import unittest
from pathlib import Path

from harness import (BACKEND_SRC, CROSS_REPO, FakeResponse, FakeTransport,
                     coordinator_of, make_hass)
from test_custom_voice_enrollment import ws

import custom_components.parlorwave_radio as integration
from custom_components.parlorwave_radio.select import VoiceSelect
from homeassistant.exceptions import HomeAssistantError

ROOT = Path(__file__).resolve().parent.parent / "custom_components" / "parlorwave_radio"
INIT = (ROOT / "__init__.py").read_text()

#: the backend's lineup, in its rotation order
SHELF = [("lewis", "Lewis"), ("emma", "Emma"), ("custom_1", "Studio Ray")]


class VoiceBackend(FakeTransport):
    """The harness backend plus a voice shelf with a live selection:
    /voices/select and /voices/switch-dj change it, /voices/library
    reports it -- the backend is the only place it is kept."""

    def __init__(self, selected="lewis", **kw):
        super().__init__(**kw)
        self.selected = selected

    def library(self):
        name = dict(SHELF)[self.selected]
        return {"ok": True,
                "kokoro": [{"voice_id": v, "name": n, "available": True,
                            "scope": "dj"} for v, n in SHELF[:2]],
                "customs": [{"voice_id": "custom_1", "name": "Studio Ray",
                             "has_sample": True, "scope": "both"}],
                "home_assistant": [], "current": None,
                "selected": {"voice_id": self.selected},
                "dj": {"voice_id": self.selected, "name": name,
                       "in_force": True, "reason": None}}

    async def request(self, method, url, json=None, headers=None, timeout=None,
                      data=None):
        path = "/" + url.split("//", 1)[-1].split("/", 1)[1].split("?", 1)[0]
        if path == "/voices/library":
            self.calls.append({"method": method, "path": path, "json": json,
                               "headers": {}})
            return FakeResponse(200, self.library())
        if path == "/voices/switch-dj":
            self.calls.append({"method": method, "path": path, "json": json,
                               "headers": {}})
            ids = [v for v, _n in SHELF]
            previous = self.selected
            self.selected = ids[(ids.index(previous) + 1) % len(ids)]
            return FakeResponse(200, {"ok": True, "voice_id": self.selected,
                                      "name": dict(SHELF)[self.selected],
                                      "previous_voice_id": previous,
                                      "changed": True})
        if path == "/voices/select":
            self.calls.append({"method": method, "path": path, "json": json,
                               "headers": {}})
            self.selected = (json or {}).get("voice_id")
            return FakeResponse(200, {"ok": True, "voice_id": self.selected,
                                      "changed": True})
        return await super().request(method, url, json=json, headers=headers,
                                     timeout=timeout)


def setup(backend=None):
    backend = backend or VoiceBackend()
    hass, entry = make_hass(backend)
    asyncio.run(integration.async_setup_entry(hass, entry))
    return hass, entry, backend


def voice_entity(hass, entry):
    c = coordinator_of(hass, entry)
    asyncio.run(c.async_refresh())
    return VoiceSelect(c, entry.entry_id)


class SwitchDJOverTheWebsocket(unittest.TestCase):
    def test_one_argument_free_write_and_the_answer_names_the_new_dj(self):
        hass, entry, backend = setup()
        c = coordinator_of(hass, entry)
        invalidated = []
        real = c.invalidate_voice_library
        c.invalidate_voice_library = lambda: (invalidated.append(True), real())
        before = len(backend.calls)
        out = ws(hass, "voice_switch_dj")
        self.assertEqual((out["voice_id"], out["name"], out["changed"]),
                         ("emma", "Emma", True))
        writes = [(x["method"], x["path"], x["json"])
                  for x in backend.calls[before:] if x["method"] != "GET"]
        self.assertEqual(writes, [("POST", "/voices/switch-dj", None)])
        self.assertEqual(invalidated, [True])

    def test_the_voice_select_shows_the_new_dj_after_the_refresh(self):
        hass, entry, backend = setup()
        self.assertEqual(voice_entity(hass, entry).current_option, "Lewis")
        ws(hass, "voice_switch_dj")
        self.assertEqual(voice_entity(hass, entry).current_option, "Emma")
        ws(hass, "voice_switch_dj")
        self.assertEqual(voice_entity(hass, entry).current_option, "Studio Ray")
        ws(hass, "voice_switch_dj")
        self.assertEqual(voice_entity(hass, entry).current_option, "Lewis")

    def test_the_command_takes_nothing_and_is_named_as_a_write(self):
        block = INIT[INIT.index('_command("parlorwave_radio/voice_switch_dj"'):]
        block = block[:block.index("\n\n")]
        self.assertIn("c.client.voice_switch_dj()", block)
        self.assertIn("_voice_setting(", block)
        self.assertNotIn("vol.", block, "Switch DJ grew an argument")
        self.assertIn("All but eight are read-only", INIT)


class TheBackendIsTheOnlyCopy(unittest.TestCase):
    def test_an_integration_reload_finds_the_backends_selection(self):
        backend = VoiceBackend()
        hass, entry, _b = setup(backend)
        ws(hass, "voice_switch_dj")
        asyncio.run(integration.async_unload_entry(hass, entry))
        hass2, entry2, _b = setup(backend)        # same add-on, fresh HA side
        self.assertEqual(voice_entity(hass2, entry2).current_option, "Emma")

    def test_a_backend_restart_is_what_the_select_reports(self):
        """The add-on restarts with the selection on disk; the next
        refresh is all it takes."""
        hass, entry, backend = setup(VoiceBackend(selected="custom_1"))
        self.assertEqual(voice_entity(hass, entry).current_option, "Studio Ray")


class ChoosingByNameIsAmbiguitySafe(unittest.TestCase):
    def entity(self, lib):
        hass, entry, backend = setup()
        c = coordinator_of(hass, entry)
        c.data = {**(c.data or {}), "voice_library": lib}
        return VoiceSelect(c, entry.entry_id), backend

    def test_two_voices_answering_to_one_name_is_a_refusal(self):
        lib = VoiceBackend().library()
        lib["home_assistant"] = [{"voice_id": "ha_tts_emma", "name": "Emma",
                                  "entity_id": "tts.emma", "available": True,
                                  "scope": "dj"}]
        entity, backend = self.entity(lib)
        before = len(backend.calls)
        with self.assertRaises(HomeAssistantError) as ctx:
            asyncio.run(entity.async_select_option("Emma"))
        self.assertIn('More than one voice is called "Emma"', str(ctx.exception))
        self.assertEqual([x for x in backend.calls[before:]
                          if x["path"] == "/voices/select"], [])

    def test_a_unique_name_selects_by_its_id(self):
        entity, backend = self.entity(VoiceBackend().library())
        asyncio.run(entity.async_select_option("Studio Ray"))
        sent = [x["json"] for x in backend.calls if x["path"] == "/voices/select"]
        self.assertEqual(sent, [{"voice_id": "custom_1"}])

    def test_an_announcement_only_voice_is_not_an_option(self):
        lib = VoiceBackend().library()
        lib["customs"][0]["scope"] = "announcement"
        entity, _backend = self.entity(lib)
        self.assertNotIn("Studio Ray", entity.options)


class ThePanelSaysEveryReasonTheBackendGives(unittest.TestCase):
    @unittest.skipIf(BACKEND_SRC is None, CROSS_REPO)
    def test_the_reason_words_cover_exactly_the_backends_checks(self):
        import re
        self.assertTrue(BACKEND_SRC.is_dir(), f"the source tree has no backend at {BACKEND_SRC}")
        backend = (BACKEND_SRC / "voice_library.py").read_text()
        checks = set(re.findall(r'^CHECK_[A-Z_]+ = "([a-z_]+)"', backend, re.M))
        panel = (ROOT / "panel" / "parlorwave-radio-panel.js").read_text()
        block = panel[panel.index("const DJ_VOICE_NOT_IN_FORCE = {"):]
        block = block[:block.index("};")]
        words = set(re.findall(r"^  ([a-z_]+):", block, re.M))
        self.assertEqual(len(checks), 3)
        self.assertEqual(words, checks)


if __name__ == "__main__":
    unittest.main()
