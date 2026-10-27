"""The DJ-enabled speaker allow-list, edited inside Parlorwave Radio.

WHY THIS MOVED, since nothing about the data did. The list has always
lived in the service, as `settings.dj.outputs.enabled`; the Home Assistant
options flow never stored a copy of it, it only read it over the API and
wrote it back. What lived in the options flow was the FORM -- and that
placement is what made setup fail:

    Settings said "Open integration options"
      -> Devices & services, where several plausible Parlorwave rows wait
      -> the obvious one opens the DEVICE page
      -> that page has an "Output" selector listing every speaker
      -> picking one there looks exactly like enabling a speaker
      -> it is not: it only chooses the active one
      -> the real control is behind a gear icon nothing mentions
      -> and there is no way back to where you started

A person could walk all of that and have enabled nothing. So the form is
now a card on the panel's own Settings screen, reachable without leaving
Parlorwave Radio, and the options flow keeps working unchanged for anybody
who opens it.

WHAT IS PINNED HERE. Because the store of record did not move there is no
schema migration to test -- and that absence is itself the claim worth
proving, so the first class below is about an EXISTING installation coming
through unchanged. After that: the states that break installations
(empty, a speaker that vanished from Music Assistant and came back,
several enabled at once) and the refusals that protect the list from being
wiped by a screen that could not read it.
"""

import asyncio
import unittest

import harness
from harness import FakeTransport, OUTPUTS, make_hass
import custom_components.parlorwave_radio as integration

DEN, UTILITY, WEB = "media_player.den", "00000000-aaaa", "ma_web123"


def setup(transport):
    hass, entry = make_hass(transport)
    asyncio.run(integration.async_setup_entry(hass, entry))
    return hass, entry


class FakeConnection:
    def __init__(self):
        self.result = None
        self.error = None

    def send_result(self, _id, result):
        self.result = result

    def send_error(self, _id, code, message):
        self.error = (code, message)


def ws(hass, name, msg=None):
    """Invoke one REGISTERED websocket command the way Home Assistant does."""
    wanted = f"parlorwave_radio/{name}"
    for handler in hass.data.get("_fake_ws_commands", []):
        if handler.ws_schema.get("type") == wanted:
            conn = FakeConnection()
            payload = {"id": 1, "type": wanted}
            payload.update(msg or {})
            asyncio.run(handler(hass, conn, payload))
            if conn.error:
                raise AssertionError(f"{name} refused: {conn.error}")
            return conn.result
    raise AssertionError(f"{wanted} is not registered")


class WokenTransport(FakeTransport):
    """The same backend, with the sleeping speaker awake. A SUBCLASS rather
    than a tweak to the shared OUTPUTS fixture: that list is module-level
    and every other test in the suite reads it, so mutating it would make
    this file's results depend on the order it ran in."""

    async def request(self, method, url, json=None, headers=None, timeout=None):
        resp = await super().request(method, url, json=json, headers=headers,
                                     timeout=timeout)
        data = getattr(resp, "_data", None) or {}
        for entry in (data.get("outputs") or []) if isinstance(data, dict) else []:
            if isinstance(entry, dict) and entry.get("player_id") == UTILITY:
                entry["available"] = True
        return resp


def ws_refusal(hass, name, msg=None):
    try:
        ws(hass, name, msg)
    except AssertionError as exc:
        return str(exc)
    raise AssertionError(f"{name} did not refuse")


# --- an installation that already worked keeps working ------------------------

class AnExistingInstallationIsUnchanged(unittest.TestCase):
    """THE UPGRADE ACCEPTANCE TEST. An owner who has already enabled a
    speaker must still have it enabled afterwards, must see it ticked, and
    must not be asked to choose again."""

    def test_an_already_enabled_speaker_survives_and_is_shown_ticked(self):
        transport = FakeTransport(enabled=[DEN], selected=DEN)
        hass, _ = setup(transport)
        out = ws(hass, "outputs")
        self.assertTrue(out["ok"])
        self.assertEqual(out["enabled"], [DEN], "the stored list came through")
        self.assertEqual(out["selected"], DEN)
        self.assertEqual([s["id"] for s in out["speakers"]], [DEN, UTILITY, WEB])
        # ...and the service still holds exactly what it held before
        self.assertEqual(transport.dj["outputs"]["enabled"], [DEN])

    def test_reading_the_list_writes_nothing_at_all(self):
        """Opening Settings must not be able to change the configuration.
        The whole read is two GETs."""
        transport = FakeTransport(enabled=[DEN, WEB])
        hass, _ = setup(transport)
        before = len(transport.calls)
        ws(hass, "outputs")
        new = transport.calls[before:]
        self.assertEqual({c["method"] for c in new}, {"GET"})
        self.assertEqual(sorted(c["path"] for c in new),
                         ["/outputs", "/settings/dj"])
        self.assertEqual(transport.dj["outputs"]["enabled"], [DEN, WEB])

    def test_the_entry_options_never_hold_a_copy_of_the_list(self):
        """Two places that can store one value are two places that can
        disagree about it. The service is the only one."""
        transport = FakeTransport(enabled=[DEN])
        hass, entry = setup(transport)
        ws(hass, "outputs_set", {"enabled": [DEN, WEB]})
        self.assertNotIn("dj_outputs", entry.options)
        self.assertEqual(dict(entry.options), {})


# --- the states real installations reach --------------------------------------

class TheStatesThatBrokePeople(unittest.TestCase):
    def test_nothing_enabled_is_a_valid_state_and_is_readable(self):
        """A fresh installation has an empty list. That is a setup step,
        not a fault, and the screen has to be able to draw it."""
        transport = FakeTransport(enabled=[])
        hass, _ = setup(transport)
        out = ws(hass, "outputs")
        self.assertTrue(out["ok"])
        self.assertEqual(out["enabled"], [])
        self.assertEqual(len(out["speakers"]), 3, "the inventory is still offered")

    def test_every_speaker_can_be_turned_off_again(self):
        """Emptying the list deliberately is allowed -- the backend's own
        contract says so -- and it must actually reach the service."""
        transport = FakeTransport(enabled=[DEN, WEB])
        hass, _ = setup(transport)
        out = ws(hass, "outputs_set", {"enabled": []})
        self.assertEqual(out, {"ok": True, "enabled": []})
        self.assertEqual(transport.dj["outputs"]["enabled"], [])

    def test_several_speakers_can_be_enabled_at_once(self):
        transport = FakeTransport(enabled=[DEN])
        hass, _ = setup(transport)
        ws(hass, "outputs_set", {"enabled": [DEN, UTILITY, WEB]})
        self.assertEqual(transport.dj["outputs"]["enabled"], [DEN, UTILITY, WEB])
        self.assertEqual(ws(hass, "outputs")["enabled"], [DEN, UTILITY, WEB])

    def test_a_speaker_that_is_asleep_is_still_offered_and_stays_enabled(self):
        """UTILITY reports available: false. A speaker being asleep is not a
        speaker being gone, and it must not disappear from the list the
        owner configured."""
        transport = FakeTransport(enabled=[UTILITY])
        hass, _ = setup(transport)
        out = ws(hass, "outputs")
        row = next(s for s in out["speakers"] if s["id"] == UTILITY)
        self.assertIn("unavailable", row["name"])
        self.assertEqual(out["enabled"], [UTILITY])

    def test_a_speaker_music_assistant_stopped_reporting_is_not_dropped(self):
        """THE DISAPPEARANCE CASE. An enabled id the inventory no longer
        lists is still offered -- labelled as unreported -- so that saving
        the form cannot silently delete a speaker that is merely off at
        this moment. Rebuilding the list without it would be a permanent
        loss caused by a temporary absence."""
        transport = FakeTransport(enabled=[DEN, "ghost-player"])
        hass, _ = setup(transport)
        out = ws(hass, "outputs")
        ids = [s["id"] for s in out["speakers"]]
        self.assertIn("ghost-player", ids)
        self.assertIn("not reported", dict((s["id"], s["name"]) for s in out["speakers"])["ghost-player"])
        self.assertEqual(out["enabled"], [DEN, "ghost-player"])
        # and a save that keeps it ticked really does keep it
        ws(hass, "outputs_set", {"enabled": [DEN, "ghost-player"]})
        self.assertEqual(transport.dj["outputs"]["enabled"], [DEN, "ghost-player"])

    def test_a_speaker_that_comes_back_needs_no_repair(self):
        """It reappears in the inventory, it was never removed from the
        list, and nothing had to be re-selected -- no repair step, no
        "choose your speaker again" prompt."""
        transport = WokenTransport(enabled=[UTILITY])
        hass, _ = setup(transport)
        out = ws(hass, "outputs")
        row = next(s for s in out["speakers"] if s["id"] == UTILITY)
        self.assertNotIn("unavailable", row["name"])
        self.assertEqual(out["enabled"], [UTILITY])


# --- the refusals that protect a working configuration ------------------------

class NothingCanWipeTheListByAccident(unittest.TestCase):
    def test_an_unreadable_inventory_is_reported_and_not_an_empty_one(self):
        """"Music Assistant did not answer" and "you have no speakers" look
        identical once they are drawn as zero checkboxes, and saving that
        would erase a working installation. The read says which it is."""
        hass, _ = setup(FakeTransport(enabled=[DEN], ma_ok=False))
        out = ws(hass, "outputs")
        self.assertFalse(out["ok"])
        self.assertEqual(out["speakers"], [])
        self.assertEqual(out["reason"], "ma_unreachable")

    def test_a_write_is_refused_outright_when_the_inventory_is_unreadable(self):
        transport = FakeTransport(enabled=[DEN], ma_ok=False)
        hass, _ = setup(transport)
        self.assertIn("backend", ws_refusal(hass, "outputs_set", {"enabled": []}))
        self.assertEqual(transport.dj["outputs"]["enabled"], [DEN],
                         "the stored list is untouched by a refused write")

    def test_an_id_music_assistant_never_reported_cannot_be_introduced(self):
        """A stale browser, or anything else, may only choose from what the
        service just offered. Same filter the options flow applies."""
        transport = FakeTransport(enabled=[DEN])
        hass, _ = setup(transport)
        out = ws(hass, "outputs_set", {"enabled": [DEN, "not-a-player"]})
        self.assertEqual(out["enabled"], [DEN])
        self.assertEqual(transport.dj["outputs"]["enabled"], [DEN])

    def test_a_service_that_refuses_the_write_leaves_the_list_alone(self):
        transport = FakeTransport(enabled=[DEN, WEB], put_status=500)
        hass, _ = setup(transport)
        self.assertIn("backend", ws_refusal(hass, "outputs_set", {"enabled": [DEN]}))
        self.assertEqual(transport.dj["outputs"]["enabled"], [DEN, WEB])


# --- the write is a settings write and nothing else ---------------------------

class SavingTouchesNothingElse(unittest.TestCase):
    def test_saving_never_reaches_transport_a_queue_or_the_active_speaker(self):
        """Changing WHICH speakers are allowed must not move the music. An
        already-playing station keeps playing exactly where it is, and the
        active speaker is a separate setting this write never names."""
        transport = FakeTransport(enabled=[DEN], selected=DEN)
        hass, _ = setup(transport)
        before = len(transport.calls)
        ws(hass, "outputs_set", {"enabled": [DEN, WEB]})
        new = transport.calls[before:]
        writes = [c for c in new if c["method"] != "GET"]
        self.assertEqual([c["path"] for c in writes], ["/settings/dj"])
        body = writes[0]["json"]
        self.assertEqual(body, {"outputs": {"enabled": [DEN, WEB]}},
                         "exactly one narrow patch, naming only the allow-list")
        self.assertNotIn("default_request_output", body["outputs"])
        # ONE write, and it is the settings patch above. The coordinator's
        # refresh afterwards does read /playback/session/by-player -- that
        # is the ordinary status read every refresh makes, and reading is
        # not moving the music. What matters is that nothing else WRITES.
        self.assertEqual(len(writes), 1, [c["path"] for c in writes])
        self.assertEqual(transport.dj["outputs"]["default_request_output"], DEN,
                         "the active speaker is a different setting and is untouched")

    def test_a_save_refreshes_the_screen_that_asked_for_it(self):
        """A save that is not visible afterwards reads as a save that did
        not happen, so the coordinator re-reads before the answer goes back."""
        transport = FakeTransport(enabled=[])
        hass, _ = setup(transport)
        before = transport.count("GET", "/dj/status")
        ws(hass, "outputs_set", {"enabled": [DEN]})
        self.assertGreater(transport.count("GET", "/dj/status"), before)


if __name__ == "__main__":
    unittest.main()
