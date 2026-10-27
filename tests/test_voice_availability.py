"""A voice whose provider blinks must come back on its own.

This is the one shape of this bug that a customer cannot
escape. Say the selected Home Assistant TTS voice is Piper and Piper's
Wyoming service restarts: the integration withholds it from
`select.parlorwave_radio_voice` -- correctly, a voice that cannot speak is
not a choice -- and the entity goes `unknown`. When Piper comes back, the
add-on's own `/voices/library` says so at once, yet without these fixes
the picker stays empty with no way to re-select the voice the customer
had been using, and only a restart of Home Assistant Core recovers it.

Two separate faults, and this file pins both:

  * the shelf's five-minute TTL was the ONLY thing that could refresh
    availability, which is the fastest-moving fact on it -- and on a
    degraded answer the very first snapshot after startup was kept for the
    life of the process, so the picker could never recover at all;
  * the SELECTED voice was filtered out along with the rest, so the one
    entry the customer needed to keep was the one that disappeared.

The fix keeps the architecture: the backend is still the only authority on
what the shelf contains, the integration still withholds voices that cannot
speak, and nothing polls the service any harder. Freshness is keyed on
Home Assistant's own verdict about the tts.* entities the shelf names --
local, free, and already read every cycle.
"""

import asyncio
import unittest

import harness

from custom_components.parlorwave_radio.const import (BREAK_WINDOW_SCAN_INTERVAL_S,
                                                      DEFAULT_SCAN_INTERVAL_S)
from custom_components.parlorwave_radio.coordinator import (ParlorwaveRadioCoordinator,
                                                            ha_tts_entity_for,
                                                            scan_interval_for)
from custom_components.parlorwave_radio.select import VoiceSelect

PIPER = "ha_tts_piper"


def library(*, piper_available=True, ok=True, piper_listed=True,
            selected=PIPER):
    """What GET /voices/library answers, in the shape voice_library.library
    really produces: `available` is live truth per voice, and `ok` is about
    the OPTIONAL cloning engine, never about Home Assistant."""
    return {
        "ok": ok,
        "kokoro": [{"voice_id": "kokoro_river", "name": "River",
                    "available": False}],       # no sidecar on a base install
        "customs": [{"voice_id": "custom_1", "name": "", "has_sample": False}],
        "cloning": {"available": ok},
        "home_assistant": ([{"voice_id": PIPER, "name": "Piper",
                             "entity_id": "tts.piper",
                             "available": piper_available}]
                           if piper_listed else []),
        "current": None,
        "selected": {"voice_id": selected, "source": "builtin",
                     "provider": "home_assistant"},
    }


class FakeClient:
    """Only the one call the shelf makes, and a count of it."""

    base_url = "http://parlorwave.internal:5005"

    def __init__(self, answer):
        self.answer = answer
        self.calls = 0

    async def voices_library(self):
        self.calls += 1
        return self.answer


class VoiceShelfCase(unittest.TestCase):
    def setUp(self):
        self.hass, self.entry = harness.make_hass()
        self.client = FakeClient(library())
        self.coordinator = ParlorwaveRadioCoordinator(self.hass, self.client)
        self.entity = VoiceSelect(self.coordinator, "entry1")

    def piper(self, state):
        """Home Assistant's own view of the TTS entity. A real tts.* entity
        carries the last-spoken timestamp, or the literal `unavailable`."""
        self.hass.states.async_set("tts.piper", state)

    def cycle(self, answer=None):
        """One coordinator pass over the shelf, then read the entity."""
        if answer is not None:
            self.client.answer = answer
        asyncio.run(self.coordinator._voice_library_snapshot())
        self.coordinator.data = {"voice_library": self.coordinator._voices}


class TheSelectedVoiceSurvivesItsProvider(VoiceShelfCase):
    """available -> unavailable -> available, which is the whole report."""

    def test_the_voice_returns_by_itself_when_the_provider_recovers(self):
        self.piper("2026-09-16T10:00:00+00:00")
        self.cycle()
        self.assertEqual(["Piper"], self.entity.options)
        self.assertEqual("Piper", self.entity.current_option)
        self.assertEqual([], self.entity.extra_state_attributes[
            "unavailable_options"])

        # Wyoming restarts. The entity goes unavailable in Home Assistant
        # and the backend reports the voice as unavailable with it.
        self.piper("unavailable")
        self.cycle(library(piper_available=False))
        self.assertEqual("Piper", self.entity.current_option,
                         "the selection is a stored preference, not a claim "
                         "about this second")
        self.assertIn("Piper", self.entity.options,
                      "the customer must be able to keep the voice they chose")
        self.assertEqual(["Piper"], self.entity.extra_state_attributes[
            "unavailable_options"], "and be told plainly that it cannot speak")
        self.assertTrue(self.entity.available)

        # Wyoming comes back.
        self.piper("2026-09-16T10:04:00+00:00")
        self.cycle(library(piper_available=True))
        self.assertEqual(["Piper"], self.entity.options)
        self.assertEqual("Piper", self.entity.current_option)
        self.assertEqual([], self.entity.extra_state_attributes[
            "unavailable_options"],
            "recovery is automatic -- no Home Assistant restart, no re-pick")

    def test_recovery_costs_exactly_one_extra_call_per_change(self):
        """Not by polling harder: the shelf is refetched when Home
        Assistant's verdict MOVES, and on no other cycle."""
        self.piper("2026-09-16T10:00:00+00:00")
        self.cycle()
        self.assertEqual(1, self.client.calls)
        for _ in range(20):                      # three minutes of idle cycles
            self.cycle()
        self.assertEqual(1, self.client.calls, "an idle cycle asks nothing")

        self.piper("unavailable")
        self.cycle(library(piper_available=False))
        self.assertEqual(2, self.client.calls)
        for _ in range(20):
            self.cycle()
        self.assertEqual(2, self.client.calls, "nor does a steady outage")

        self.piper("2026-09-16T10:04:00+00:00")
        self.cycle(library(piper_available=True))
        self.assertEqual(3, self.client.calls, "recovery is noticed at once")

    def test_a_voice_that_is_not_selected_is_still_withheld_while_it_is_down(self):
        """The exception is for the SELECTION, not a general amnesty: a
        voice nobody chose that cannot speak is not a choice."""
        self.piper("2026-09-16T10:00:00+00:00")
        self.cycle(library(piper_available=True, selected=PIPER))
        self.assertEqual(["Piper"], self.entity.options,
                         "the Kokoro shelf has no sidecar answering, and "
                         "the empty custom slot is not a voice")

    def test_the_amnesty_follows_the_selection_when_it_moves(self):
        self.piper("unavailable")
        self.cycle(library(piper_available=False, selected="kokoro_river"))
        self.assertEqual(["River"], self.entity.options)
        self.assertEqual("River", self.entity.current_option)
        self.assertEqual(["River"], self.entity.extra_state_attributes[
            "unavailable_options"])
        self.assertNotIn("Piper", self.entity.options,
                         "Piper is down and is no longer the selection")

    def test_a_selected_voice_the_library_cannot_name_is_still_offered(self):
        """Home Assistant unreachable from the backend: not even its own
        shelf comes back. The selection is still a valid choice, and it is
        named rather than shown as a raw id."""
        self.piper("unavailable")
        self.cycle(library(piper_listed=False, piper_available=False))
        self.assertEqual(["Piper"], self.entity.options)
        self.assertEqual("Piper", self.entity.current_option)
        self.assertEqual(["Piper"], self.entity.extra_state_attributes[
            "unavailable_options"])


class ADegradedAnswerDoesNotFreezeTheShelf(VoiceShelfCase):
    """`ok: false` describes the OPTIONAL cloning engine and nothing else.

    Keeping the last good copy on a degraded answer was right for the two
    fields that engine actually supplies and catastrophic for the rest: the
    whole document froze at the first snapshot after startup, so a Home
    Assistant voice that came back was never seen again."""

    def test_the_home_assistant_shelf_is_taken_fresh(self):
        self.piper("unavailable")
        self.cycle(library(ok=True, piper_available=False))
        self.piper("2026-09-16T10:04:00+00:00")
        self.cycle(library(ok=False, piper_available=True))
        self.assertEqual([], self.entity.extra_state_attributes[
            "unavailable_options"],
            "a cloning engine being down says nothing about Piper")

    def test_what_the_cloning_engine_supplies_keeps_its_last_good_value(self):
        good = library(ok=True)
        good["customs"] = [{"voice_id": "custom_1", "name": "Studio Ray",
                            "has_sample": True}]
        good["cloning"] = {"available": True, "slots_free": 2}
        self.piper("2026-09-16T10:00:00+00:00")
        self.cycle(good)
        self.assertIn("Studio Ray", self.entity.options)

        self.piper("unavailable")
        degraded = library(ok=False, piper_available=False)
        degraded["customs"] = [{"voice_id": "custom_1", "name": "Studio Ray",
                                "has_sample": None}]      # engine unreadable
        degraded["cloning"] = {"available": False}
        self.cycle(degraded)
        self.assertIn("Studio Ray", self.entity.options,
                      "an unreadable inventory is not proof a voice is gone")
        self.assertEqual({"available": True, "slots_free": 2},
                         self.coordinator._voices["cloning"])


class TheEntityMappingIsAPureFunction(unittest.TestCase):
    """Which tts.* entity a voice speaks through must be derivable with
    Home Assistant unreachable -- it is how a selection stays meaningful."""

    def test_a_home_assistant_voice_id_names_its_entity(self):
        self.assertEqual("tts.piper", ha_tts_entity_for("ha_tts_piper"))
        self.assertEqual("tts.home_assistant_cloud",
                         ha_tts_entity_for("ha_tts_home_assistant_cloud"))

    def test_nothing_else_is_mistaken_for_one(self):
        for voice_id in ("", "kokoro_river", "custom_1", "ha_tts_", "legacy_voice"):
            self.assertIsNone(ha_tts_entity_for(voice_id), voice_id)


class TheBreakWindowHasItsOwnCadence(unittest.TestCase):
    """A finite break lasts seconds; a ten-second poll described it
    with a ten-second error in both directions, so `on_air` arrived most of
    the way through the break and was still being reported after the music
    came back. The cadence is a pure function of what the DJ last said, so
    the rule is asserted here without a clock anywhere near it."""

    @staticmethod
    def snapshot(status):
        return {"dj_status": {"dj": {"status": status, "enabled": True}}}

    def test_the_fast_cadence_covers_the_whole_break_window(self):
        for status in ("ready", "up_next", "on_air"):
            self.assertEqual(BREAK_WINDOW_SCAN_INTERVAL_S,
                             scan_interval_for(self.snapshot(status)).total_seconds(),
                             status)

    def test_everything_else_keeps_the_ordinary_cadence(self):
        for status in ("off", "idle", "waiting", "warming", "preparing"):
            self.assertEqual(DEFAULT_SCAN_INTERVAL_S,
                             scan_interval_for(self.snapshot(status)).total_seconds(),
                             status)

    def test_a_missing_or_malformed_snapshot_is_the_ordinary_cadence(self):
        for data in (None, {}, {"dj_status": None}, {"dj_status": {}},
                     {"dj_status": {"dj": None}}, {"dj_status": {"dj": {}}}):
            self.assertEqual(DEFAULT_SCAN_INTERVAL_S,
                             scan_interval_for(data).total_seconds(), repr(data))

    def test_the_fast_window_opens_before_the_break_airs_and_shuts_after(self):
        """The transition sequence a real break walks, in order. Entering
        the fast cadence only at `on_air` would already be too late to
        report the start of the break promptly."""
        walk = ["waiting", "preparing", "ready", "up_next", "on_air", "waiting"]
        seconds = [scan_interval_for(self.snapshot(s)).total_seconds() for s in walk]
        self.assertEqual([DEFAULT_SCAN_INTERVAL_S, DEFAULT_SCAN_INTERVAL_S,
                          BREAK_WINDOW_SCAN_INTERVAL_S, BREAK_WINDOW_SCAN_INTERVAL_S,
                          BREAK_WINDOW_SCAN_INTERVAL_S, DEFAULT_SCAN_INTERVAL_S],
                         seconds)


class TheCoordinatorActuallyChangesItsOwnClock(unittest.TestCase):
    """The rule above only helps if the coordinator applies it. This runs
    the REAL _async_update_data against the harness's backend and reads the
    interval it leaves behind."""

    class Transport(harness.FakeTransport):
        status = "idle"

        async def request(self, method, url, json=None, headers=None, timeout=None):
            path = "/" + url.split("//", 1)[-1].split("/", 1)[1].split("?", 1)[0]
            if path == "/dj/status" and method == "GET":
                self.calls.append({"method": method, "path": path,
                                   "json": json, "headers": dict(headers or {})})
                return harness.FakeResponse(200, {
                    "ok": True,
                    "dj": {"status": self.status, "enabled": True},
                    "station": {"active": None}})
            return await super().request(method, url, json=json,
                                         headers=headers, timeout=timeout)

    def setUp(self):
        from custom_components.parlorwave_radio.api import RadioServiceClient
        self.transport = self.Transport()
        self.hass, self.entry = harness.make_hass(self.transport)
        client = RadioServiceClient(self.transport, "http://radio.example:5005")
        self.coordinator = ParlorwaveRadioCoordinator(self.hass, client)

    def interval_after(self, status):
        self.transport.status = status
        asyncio.run(self.coordinator._async_update_data())
        return self.coordinator.update_interval.total_seconds()

    def test_the_clock_speeds_up_for_the_break_and_slows_down_after_it(self):
        self.assertEqual(DEFAULT_SCAN_INTERVAL_S, self.interval_after("waiting"))
        self.assertEqual(BREAK_WINDOW_SCAN_INTERVAL_S, self.interval_after("up_next"))
        self.assertEqual(BREAK_WINDOW_SCAN_INTERVAL_S, self.interval_after("on_air"))
        self.assertEqual(DEFAULT_SCAN_INTERVAL_S, self.interval_after("waiting"),
                         "and it must come back down, or a station that has "
                         "played one break polls fast for ever")


if __name__ == "__main__":
    unittest.main()
