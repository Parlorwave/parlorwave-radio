"""New custom voices are not offered in this release: the integration's half.

The backend decides and refuses (voice_library.ENROLLMENT_QUALIFIED, reason
"not_qualified" in the library's `cloning` block, HTTP 403
`voice_enrollment_unavailable`). What the integration owes:

  * Settings does not call recording "Available" while the backend says it
    is not offered -- engine or no engine -- and still counts the voices
    that exist;
  * the refusal reaches a person in the backend's own sentence, through the
    Booth's create/replace view and through the voice_upload service;
  * a backend that predates the gate is described exactly as before.

The Booth's rendering is executed in test_panel_voice_gate.mjs.
"""

import asyncio
import unittest

# the harness (imported by these) provides the Home Assistant stand-in, so
# they come before anything from homeassistant
from test_booth_voices import VoiceTransport, post, setup as booth_setup
from test_custom_voice_enrollment import setup as enroll_setup
from test_panel_settings import doc

from custom_components.parlorwave_radio.const import DOMAIN, SERVICE_VOICE_UPLOAD
from homeassistant.exceptions import HomeAssistantError

MESSAGE = ("Making a voice from a recording is not available in this release "
           "while it is still being tested. Voices already on this installation "
           "keep working.")
REFUSAL = (403, {"detail": {"code": "voice_enrollment_unavailable",
                            "message": MESSAGE}})


def engine_row(voices):
    return next(o for o in doc(voices=voices)["optional"]
                if o["key"] == "voice_engine")


class SettingsSaysItIsNotInThisRelease(unittest.TestCase):
    def test_with_an_engine_and_no_voices(self):
        row = engine_row({"ok": True, "customs": [],
                          "cloning": {"configured": True, "reason": "not_qualified"}})
        self.assertEqual((row["badge"], row["tone"]), ("Not in this release", "off"))
        self.assertIn("not part of this release", row["detail"])
        self.assertNotIn("can be created", row["detail"])

    def test_existing_voices_are_still_counted_and_work(self):
        row = engine_row({"ok": True,
                          "customs": [{"voice_id": "custom_2", "has_sample": True}],
                          "cloning": {"configured": True, "reason": "not_qualified"}})
        self.assertEqual((row["badge"], row["tone"]), ("1 created", "on"))
        self.assertIn("keep working", row["detail"])

    def test_without_an_engine_it_does_not_promise_one(self):
        row = engine_row({"ok": True, "customs": [],
                          "cloning": {"configured": False, "reason": "not_qualified"}})
        self.assertEqual(row["badge"], "Not in this release")
        self.assertNotIn("Needs the optional", row["detail"])
        self.assertIn("Home Assistant's own voices work without it", row["detail"])

    def test_a_backend_from_before_the_gate_is_described_as_before(self):
        row = engine_row({"ok": True, "customs": [],
                          "cloning": {"configured": True, "available": True, "reason": ""}})
        self.assertEqual((row["badge"], row["tone"]), ("Available", "on"))
        self.assertEqual(row["detail"], "Voices can be created from a short recording.")
        row = engine_row({"ok": True, "customs": [],
                          "cloning": {"configured": False, "reason": "unconfigured"}})
        # no engine is not "not in this release": the engine is what is missing
        self.assertEqual((row["badge"], row["tone"]), ("Needs a voice engine", "off"))
        self.assertIn("Needs the optional ParlorWave voice engine", row["detail"])
        self.assertIn("Optional services", row["detail"])


class TheRefusalArrivesInTheBackendsWords(unittest.TestCase):
    def test_the_booth_view_relays_the_403_verbatim(self):
        hass, _entry = booth_setup(VoiceTransport(create=REFUSAL))
        resp = post(hass, {"name": "Evening Reader"}, b"a-take")
        self.assertEqual(resp.status, 403)
        self.assertEqual(resp.body, {"ok": False,
                                     "code": "voice_enrollment_unavailable",
                                     "message": MESSAGE})

    def test_the_voice_upload_service_raises_the_same_sentence(self):
        import base64
        hass, _entry, transport = enroll_setup()
        transport.answer = REFUSAL
        with self.assertRaises(HomeAssistantError) as ctx:
            asyncio.run(hass.services.async_call(
                DOMAIN, SERVICE_VOICE_UPLOAD,
                {"slot": "custom_1", "authorized": True,
                 "sample_b64": base64.b64encode(b"RIFF-take").decode()}))
        self.assertEqual(str(ctx.exception), MESSAGE)


if __name__ == "__main__":
    unittest.main()
