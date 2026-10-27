"""Voice Library, on the Home Assistant side.

A recording reaches the Voice Library through the SAME authenticated upload
view a voice is made through (`library=true`), behind the same door: the
acknowledgement and the closed field list. It never names a slot and is never
both a library import and a replace. Putting a kept recording into a voice is a
websocket command that carries the acknowledgement too; deleting one repeats
its name. EXECUTED against the real view and the real registered handlers.
"""

import asyncio
import unittest

from test_custom_voice_enrollment import ACK, EnrollTransport, INIT, _Binary, _Conn, post

import custom_components.parlorwave_radio as integration
from custom_components.parlorwave_radio.const import VOICE_CONSENT_VERSION
from harness import make_hass

ENTRY = "0123456789abcdef"


class LibraryTransport(EnrollTransport):
    async def request(self, method, url, json=None, headers=None, timeout=None,
                      data=None):
        full = "/" + url.split("//", 1)[-1].split("/", 1)[1]
        path = full.split("?", 1)[0]
        if path.startswith("/voices/collection"):
            self.calls.append({"method": method, "path": path, "json": json})
            self.forwarded.append((full, data))
            return _Binary(200, {"ok": True, "id": ENTRY, "name": "Studio Ray",
                                 "in_slots": [], "created": True})
        return await super().request(method, url, json=json, headers=headers,
                                     timeout=timeout, data=data)


def setup():
    transport = LibraryTransport()
    hass, entry = make_hass(transport)
    asyncio.run(integration.async_setup_entry(hass, entry))
    return hass, transport


def ws_raw(hass, name, msg):
    wanted = f"parlorwave_radio/{name}"
    for handler in hass.data.get("_fake_ws_commands", []):
        if handler.ws_schema.get("type") == wanted:
            conn = _Conn()
            asyncio.run(handler(hass, conn, {"id": 1, "type": wanted, **msg}))
            return conn
    raise AssertionError(f"{wanted} is not registered")


class TheLibraryDoor(unittest.TestCase):
    def test_a_library_import_is_forwarded_with_its_name_and_acknowledgement(self):
        hass, transport = setup()
        resp = post(hass, {"library": "true", "name": "Studio Ray", "source": "file", **ACK})
        self.assertEqual(resp.status, 200)
        (full, body), = transport.forwarded
        self.assertTrue(full.startswith("/voices/collection/import?"), full)
        self.assertIn("name=Studio+Ray", full)
        self.assertIn(f"consent_version={VOICE_CONSENT_VERSION}", full)
        self.assertNotIn("scope", full)
        self.assertEqual(body, b"RIFF-a-take")

    def test_no_acknowledgement_nothing_forwarded(self):
        hass, transport = setup()
        resp = post(hass, {"library": "true", "name": "Studio Ray"})
        self.assertEqual(resp.status, 422)
        self.assertEqual(transport.forwarded, [])

    def test_library_and_replace_together_are_refused(self):
        hass, transport = setup()
        resp = post(hass, {"library": "true", "replace": "custom_1", "name": "G", **ACK})
        self.assertEqual(resp.status, 400)
        self.assertEqual(transport.forwarded, [])

    def test_a_slot_field_is_still_refused(self):
        hass, transport = setup()
        resp = post(hass, {"library": "true", "name": "G", "slot": "custom_1", **ACK})
        self.assertEqual(resp.status, 400)
        self.assertEqual(transport.forwarded, [])


class TheLibraryCommands(unittest.TestCase):
    def test_assign_carries_the_acknowledgement(self):
        hass, transport = setup()
        conn = ws_raw(hass, "voice_collection_assign", {
            "entry_id": ENTRY, "slot": "custom_3", "authorized": True,
            "consent_version": VOICE_CONSENT_VERSION})
        self.assertIsNone(conn.error)
        call, = [c for c in transport.calls if c["path"].endswith("/assign")]
        self.assertEqual(call["json"], {"slot": "custom_3", "authorized": True,
                                        "consent_version": VOICE_CONSENT_VERSION})

    def test_the_assign_schema_requires_the_acknowledgement(self):
        block = INIT[INIT.index('_command("parlorwave_radio/voice_collection_assign"'):]
        block = block[:block.index("_command(", 10)]
        self.assertIn('vol.Required("authorized"): True', block)
        self.assertIn('vol.Required("consent_version"): VOICE_CONSENT_VERSION', block)

    def test_delete_repeats_the_name(self):
        hass, transport = setup()
        ws_raw(hass, "voice_collection_delete", {"entry_id": ENTRY, "confirm": "Studio Ray"})
        call, = [c for c in transport.calls if c["path"].endswith("/delete")]
        self.assertEqual(call["json"], {"confirm": "Studio Ray"})

    def test_audio_is_returned_for_this_browser(self):
        hass, _t = setup()
        conn = ws_raw(hass, "voice_collection_audio", {"entry_id": ENTRY})
        self.assertIsNone(conn.error)
        self.assertIn("audio_b64", conn.result)


if __name__ == "__main__":
    unittest.main()
