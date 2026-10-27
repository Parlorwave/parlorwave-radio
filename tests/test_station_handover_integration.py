"""The house handover crosses the integration unchanged.

The panel's confirmed handover (the backend's token and keep/replace) is
one optional field of the ONE start command: the websocket schema admits
exactly those two keys, and the client puts exactly them in the body. The
integration decides nothing about it -- the backend checks the token
against the queue as it is now.
"""

import asyncio
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "custom_components" / "parlorwave_radio"
# The client module alone, as test_api_client loads it: no Home Assistant
# (or voluptuous) is needed to see what goes on the wire.
sys.path.insert(0, str(ROOT))
from api import RadioServiceClient  # noqa: E402
INIT = (ROOT / "__init__.py").read_text()


class Capture:
    def __init__(self):
        self.calls = []

    async def request(self, method, url, json=None, headers=None, timeout=None):
        self.calls.append({"method": method, "url": url, "json": json,
                           "timeout": timeout})

        class R:
            status = 200

            async def json(self_inner):
                return {"ok": False, "reason": "handover_required",
                        "handover": {"token": "t1"}}
        return R()


class TheClient(unittest.TestCase):
    def body(self, **kw):
        cap = Capture()
        client = RadioServiceClient(cap, "http://radio.example:5005")
        answer = asyncio.run(client.station_live_start("speaker_1", preset_id="p1", **kw))
        return cap.calls[0], answer

    def test_a_handover_is_sent_as_exactly_its_token_and_choice(self):
        call, answer = self.body(handover={"token": "t1", "upcoming": "replace",
                                           "remove": ["q1", "q2"], "extra": "dropped"})
        self.assertEqual(call["json"], {"target": "speaker_1", "preset_id": "p1",
                                        "handover": {"token": "t1", "upcoming": "replace",
                                                     "remove": ["q1", "q2"]}})
        self.assertTrue(call["url"].endswith("/station/live/start"))
        self.assertEqual(call["timeout"], 60.0)
        # a truthful refusal (the handover question) passes through intact
        self.assertEqual(answer["reason"], "handover_required")

    def test_no_handover_means_no_handover_key(self):
        call, _ = self.body()
        self.assertNotIn("handover", call["json"])


class TheSchema(unittest.TestCase):
    def test_the_start_command_admits_a_token_and_keep_or_replace_only(self):
        start = INIT[INIT.index('_command("parlorwave_radio/station_live_start",'):]
        start = start[:start.index("_command(", 10)]
        self.assertIn('handover=m.get("handover")', start)
        self.assertRegex(start, r'vol\.Optional\("handover"\): \{\s*'
                                r'vol\.Required\("token"\): vol\.All\(str, vol\.Length\(min=1, max=64\)\),\s*'
                                r'vol\.Required\("upcoming"\): vol\.In\(\("keep", "replace"\)\),')
        self.assertIn('vol.Optional("remove"): vol.All(', start)
        self.assertIn("vol.Length(max=64))}})", start)
        # still ONE start command: no handover command of its own
        # one start command; the fifth live command answers a pending
        # Autoplay restore and starts nothing
        self.assertEqual(len(re.findall(r'_command\("parlorwave_radio/station_live(?:_\w+)?"', INIT)), 5)


if __name__ == "__main__":
    unittest.main()
