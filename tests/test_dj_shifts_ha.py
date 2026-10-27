"""DJ Shifts, on the Home Assistant side: one websocket command that
carries the switch and the three voices to the backend (which alone
validates and settles), no new entity, and a panel that shows the shift the
BACKEND says it is -- never one it works out from the browser's clock."""

import asyncio
import re
import unittest
from pathlib import Path

from harness import FakeResponse, FakeTransport, coordinator_of, make_hass
from test_custom_voice_enrollment import ws

import custom_components.parlorwave_radio as integration

ROOT = Path(__file__).resolve().parent.parent / "custom_components" / "parlorwave_radio"
INIT = (ROOT / "__init__.py").read_text()
PANEL = (ROOT / "panel" / "parlorwave-radio-panel.js").read_text()


class ShiftsBackend(FakeTransport):
    async def request(self, method, url, json=None, headers=None, timeout=None,
                      data=None):
        path = "/" + url.split("//", 1)[-1].split("/", 1)[1].split("?", 1)[0]
        if path == "/voices/shifts":
            self.calls.append({"method": method, "path": path, "json": json,
                               "headers": {}})
            return FakeResponse(200, {"ok": True, "shifts": {"enabled": True},
                                      "reconcile": None})
        return await super().request(method, url, json=json, headers=headers,
                                     timeout=timeout)


def setup():
    backend = ShiftsBackend()
    hass, entry = make_hass(backend)
    asyncio.run(integration.async_setup_entry(hass, entry))
    return hass, entry, backend


class TheCommand(unittest.TestCase):
    def test_it_forwards_only_what_was_sent_and_refreshes_the_shelf(self):
        hass, entry, backend = setup()
        c = coordinator_of(hass, entry)
        invalidated = []
        real = c.invalidate_voice_library
        c.invalidate_voice_library = lambda: (invalidated.append(True), real())
        ws(hass, "voice_shifts", {"enabled": True})
        ws(hass, "voice_shifts", {"night": "puck"})
        ws(hass, "voice_shifts", {"morning": ""})
        sent = [x["json"] for x in backend.calls if x["path"] == "/voices/shifts"]
        self.assertEqual(sent, [{"enabled": True}, {"night": "puck"},
                                {"morning": ""}])
        self.assertEqual(len(invalidated), 3)

    def test_it_is_bounded_named_as_a_write_and_adds_no_entity(self):
        block = INIT[INIT.index('_command("parlorwave_radio/voice_shifts"'):]
        block = block[:block.index("\n\n")]
        self.assertIn("_voice_setting(", block)
        self.assertIn('vol.Optional("enabled"): bool', block)
        self.assertEqual(block.count("vol.Length(max=64)"), 3)
        self.assertIn("All but eight are read-only", INIT)
        for platform in ("switch.py", "select.py", "sensor.py", "number.py"):
            self.assertNotIn("shift", (ROOT / platform).read_text().lower(),
                             platform)


class ThePanel(unittest.TestCase):
    def block(self):
        start = PANEL.index("  _renderShifts(dj) {")
        return PANEL[start:PANEL.index("\n  }\n", start) + 4]

    def test_the_shift_is_the_backends_never_the_browsers(self):
        block = self.block()
        for banned in ("new Date", "getHours", "Date.now", "toLocale",
                       "Intl.", "getTimezoneOffset"):
            self.assertNotIn(banned, block)
        self.assertIn("sh.current_shift", block)
        self.assertIn("sh.starts", block)

    def test_it_offers_only_the_djs_lineup_and_says_what_holds(self):
        block = self.block()
        self.assertIn("dj.lineup", block)
        self.assertIn("Manual override until ${title(sh.next_shift)} shift.", block)
        self.assertIn("will not host", block)
        self.assertNotIn("parlorwave_radio", block, "the Booth slice calls no service")

    def test_it_writes_through_one_command(self):
        start = PANEL.index("  async _setShifts(patch) {")
        body = PANEL[start:PANEL.index("  async _setAnnouncementVoice(", start)]
        code = re.sub(r"/\*[\s\S]*?\*/", "", body)
        self.assertEqual(re.findall(r'_ws\("([^"]+)"', code),
                         ["parlorwave_radio/voice_shifts"])
        for banned in ("callService", "media_player.", "play_media", "select_option"):
            self.assertNotIn(banned, code)


if __name__ == "__main__":
    unittest.main()
