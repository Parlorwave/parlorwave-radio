"""A green "Ready" never outlives a failure the integration has seen.

Settings is built from the last /health/problems report, refreshed every
HEALTH_TTL_S seconds. Two ways that left "Ready" on the screen after the
integration already knew better:
  * a health read that FAILED kept the previous report, so a green verdict
    rode across the failure for as long as reads kept failing;
  * an add-on restarted with a new (or wrong) Music Assistant token answered
    again within the TTL, and the report from before the restart -- Ready --
    was shown for up to a minute.

The correction is narrow invalidation, not a new readiness model: the
report is forgotten whenever the integration KNOWS it may be wrong (the
service could not be read, refused the key, or failed a request on its own
side), Settings shows its existing "checking" state, and the next refresh
asks again instead of waiting out the TTL. A 4xx refusal of what somebody
asked for invalidates nothing.

An add-on restart is usually NOT seen failing: it takes a few seconds
and can fall between two 10 s polls. So the
integration also knows the report is out of date when the service process
started since (/dj/status service_started), or when this cycle's /outputs
read of Music Assistant disagrees with the report about Music Assistant.
"""

import asyncio
import unittest
from unittest import mock

import harness
import test_panel_settings as T  # the Settings suite's own report builders
from custom_components.parlorwave_radio import coordinator as coordinator_module
from custom_components.parlorwave_radio import readiness
from custom_components.parlorwave_radio.api import (RadioServiceAuthError,
                                                    RadioServiceClient,
                                                    RadioServiceConnectionError,
                                                    RadioServiceError)
from custom_components.parlorwave_radio.const import (DEFAULT_SCAN_INTERVAL_S,
                                                      HEALTH_TTL_S)
from custom_components.parlorwave_radio.coordinator import (
    ParlorwaveRadioCoordinator, is_service_failure, ma_disagrees, readiness_key)
from custom_components.parlorwave_radio.sensor import DjStatusSensor

GREEN = T.health()                         # an installation with nothing left to do
TOKEN_REJECTED = T.health([T.problem("ma_auth_rejected", "error", "music_assistant")])
MA_REFUSED = T.health([T.problem("ma_auth_rejected", "error", "music_assistant")],
                      music_assistant={"reachable": False})
MA_DOWN = T.health([T.problem("ma_unreachable", "error", "music_assistant")],
                   music_assistant={"reachable": False})


class Transport(harness.FakeTransport):
    """The harness backend, with a switchable outage and health answer, and
    the process start /dj/status reports (None: a backend from before it)."""

    def __init__(self):
        super().__init__(enabled=["media_player.den"], selected="media_player.den")
        self.dj["enabled"] = True
        self.down = False
        self.health_status = 200
        self.health = GREEN
        self.started = "2026-01-15T13:38:00+00:00"

    def restart(self, started, health, ma_ok):
        """The add-on restarted -- in the few seconds between two polls --
        and now answers from a new process with what it sees."""
        self.started, self.health, self.ma_ok = started, health, ma_ok

    async def request(self, method, url, json=None, headers=None, timeout=None):
        if self.down:
            raise OSError("connection refused")
        path = "/" + url.split("//", 1)[-1].split("/", 1)[1].split("?", 1)[0]
        if path == "/health/problems":
            self.calls.append({"method": method, "path": path, "json": json,
                               "headers": dict(headers or {})})
            return harness.FakeResponse(self.health_status, self.health)
        resp = await super().request(method, url, json=json, headers=headers,
                                     timeout=timeout)
        if path == "/dj/status" and self.started is not None:
            resp._data = dict(resp._data, service_started=self.started)
        return resp


class Clock:
    """time.monotonic for the coordinator alone, moved by hand."""

    def __init__(self):
        self.now = 1000.0

    def monotonic(self):
        return self.now


class Case(unittest.TestCase):

    def setUp(self):
        self.transport = Transport()
        self.hass, self.entry = harness.make_hass(self.transport)
        client = RadioServiceClient(self.transport, "http://radio.example:5005")
        self.coordinator = ParlorwaveRadioCoordinator(self.hass, client)

    def refresh(self):
        """One coordinator pass, as DataUpdateCoordinator runs it: on success
        the answer becomes `data`; on failure `data` keeps the last one."""
        try:
            self.coordinator.data = asyncio.run(
                self.coordinator._async_update_data())
            self.coordinator.last_update_success = True
        except Exception:  # noqa: BLE001 - UpdateFailed / ConfigEntryAuthFailed
            self.coordinator.last_update_success = False

    def state(self):
        return readiness.build(self.coordinator.data or {}, tts_entities=1,
                               connected=self.coordinator.last_update_success)["state"]

    def health_reads(self):
        return self.transport.count("GET", "/health/problems")


class Timed(Case):
    """A Case on a hand-moved clock, so HEALTH_TTL_S is real and the polls
    land where a real installation's do: every DEFAULT_SCAN_INTERVAL_S."""

    def setUp(self):
        super().setUp()
        self.clock = Clock()
        patcher = mock.patch.object(coordinator_module, "time", self.clock)
        patcher.start()
        self.addCleanup(patcher.stop)

    def poll(self, seconds=DEFAULT_SCAN_INTERVAL_S):
        self.clock.now += seconds
        self.refresh()

    def key(self):
        return self.coordinator.data.get("readiness_key")

    def blockers(self):
        """Every problem the verdict names: its blockers, and the setup
        steps that took a problem as their own (an unreachable Music
        Assistant is said on its step)."""
        doc = readiness.build(self.coordinator.data, tts_entities=1)
        return ([b["code"] for b in doc["blockers"]]
                + [s["code"] for s in doc["checklist"] if s.get("code")])


class AFailedHealthReadKeepsNoVerdict(Case):

    def test_ready_does_not_ride_across_a_failed_read(self):
        self.refresh()
        self.assertEqual(self.state(), readiness.READY)
        self.coordinator._health_at = 0.0          # the TTL has run out
        self.transport.health_status = 500
        self.refresh()
        self.assertEqual(self.state(), readiness.CHECKING)
        self.transport.health_status = 200
        self.refresh()
        self.assertEqual(self.state(), readiness.READY)

    def test_a_malformed_answer_is_not_kept_as_the_old_one(self):
        self.refresh()
        self.coordinator._health_at = 0.0
        self.transport.health = {"ok": True}       # no "problems"
        self.refresh()
        self.assertEqual(self.state(), readiness.CHECKING)


class ARestartedServiceIsAskedAgain(Case):

    def test_a_new_token_after_a_restart_is_seen_at_once_not_after_the_ttl(self):
        self.refresh()
        self.assertEqual(self.state(), readiness.READY)
        reads = self.health_reads()
        # the add-on restarts with a token Music Assistant refuses; well
        # inside HEALTH_TTL_S it answers again
        self.transport.down = True
        self.refresh()
        self.assertEqual(self.state(), readiness.NEEDS_ATTENTION)
        self.assertIsNone(self.coordinator.data["health"],
                          "the report from before the outage is still handed out")
        self.transport.down = False
        self.transport.health = TOKEN_REJECTED
        self.refresh()
        self.assertEqual(self.health_reads(), reads + 1, "health was not asked again")
        self.assertEqual(self.state(), readiness.NEEDS_ATTENTION)
        codes = [b["code"] for b in readiness.build(self.coordinator.data, tts_entities=1)["blockers"]]
        self.assertIn("ma_auth_rejected", codes)

    def test_an_ordinary_refresh_still_rides_the_ttl(self):
        self.refresh()
        reads = self.health_reads()
        self.refresh()
        self.refresh()
        self.assertEqual(self.health_reads(), reads, "the TTL is the normal cadence")


class ACommandThatFailsOnTheServiceSide(Case):

    def test_only_a_service_failure_invalidates(self):
        def refusal(status):
            err = RadioServiceError(f"/x answered {status}")
            err.status = status
            return err
        for exc, failed in ((RadioServiceConnectionError("no answer"), True),
                            (RadioServiceAuthError("key refused"), True),
                            (RadioServiceError("error 502 on /x"), True),    # no status: 5xx / unreadable
                            (refusal(503), True),
                            (refusal(422), False),
                            (refusal(404), False)):
            with self.subTest(exc=str(exc)):
                self.assertIs(is_service_failure(exc), failed)

    def test_invalidation_shows_checking_and_asks_again(self):
        self.refresh()
        reads = self.health_reads()
        self.coordinator.invalidate_health()
        self.assertEqual(self.state(), readiness.CHECKING)
        self.refresh()
        self.assertEqual(self.health_reads(), reads + 1)
        self.assertEqual(self.state(), readiness.READY)


class ARestartNoPollSaw(Timed):
    """A wrong token saved: the add-on restarts in a few seconds, between
    two polls, so no refresh fails, and the report from the process before
    it would be shown as Ready for a minute or more.
    The process's start time on /dj/status is what tells."""

    def test_a_wrong_token_restart_is_seen_at_the_next_poll(self):
        self.poll()
        self.poll()                                  # the report is 10 s into its TTL
        self.assertEqual(self.state(), readiness.READY)
        self.transport.restart("2026-01-15T13:39:02+00:00", MA_REFUSED, ma_ok=False)
        self.poll()
        self.assertEqual(self.state(), readiness.NEEDS_ATTENTION)
        self.assertIn("ma_auth_rejected", self.blockers())

    def test_the_restart_alone_is_enough(self):
        """Music Assistant still answers /outputs here, so only the new
        start time can tell the report is from another process."""
        self.poll()
        reads = self.health_reads()
        self.transport.restart("2026-01-15T13:39:02+00:00", TOKEN_REJECTED, ma_ok=True)
        self.poll()
        self.assertEqual(self.health_reads(), reads + 1, "health was not asked again")
        self.assertIn("ma_auth_rejected", self.blockers())

    def test_the_right_token_is_ready_at_the_next_poll(self):
        self.transport.restart("2026-01-15T13:38:00+00:00", MA_REFUSED, ma_ok=False)
        self.poll()
        self.assertEqual(self.state(), readiness.NEEDS_ATTENTION)
        self.transport.restart("2026-01-15T13:40:30+00:00", GREEN, ma_ok=True)
        self.poll()
        self.assertEqual(self.state(), readiness.READY)

    def test_a_backend_from_before_the_start_time_keeps_the_ttl(self):
        self.transport.started = None
        self.poll()
        reads = self.health_reads()
        self.transport.health = TOKEN_REJECTED       # restarted unseen: nothing can tell
        self.poll()
        self.assertEqual(self.health_reads(), reads)
        self.assertEqual(self.state(), readiness.READY)


class MusicAssistantStopsAndStarts(Timed):
    """Music Assistant stopped: Ready could stay for a minute or more while
    the integration's own /outputs read -- Music Assistant, every cycle --
    was already failing."""

    def test_an_outage_is_seen_at_the_next_poll(self):
        self.poll()
        self.poll()
        self.transport.health, self.transport.ma_ok = MA_DOWN, False
        self.poll()
        self.assertEqual(self.state(), readiness.NEEDS_ATTENTION)
        self.assertIn("ma_unreachable", self.blockers())

    def test_the_recovery_is_ready_without_waiting_out_the_ttl(self):
        self.transport.health, self.transport.ma_ok = MA_DOWN, False
        self.poll()
        self.poll()
        self.assertEqual(self.state(), readiness.NEEDS_ATTENTION)
        self.transport.health, self.transport.ma_ok = GREEN, True
        self.poll()
        self.assertEqual(self.state(), readiness.READY)

    def test_a_steady_installation_keeps_the_ttl(self):
        self.poll()
        reads = self.health_reads()
        for _ in range(HEALTH_TTL_S // DEFAULT_SCAN_INTERVAL_S - 1):
            self.poll()
        self.assertEqual(self.health_reads(), reads, "a healthy report was asked again early")
        self.poll()
        self.assertEqual(self.health_reads(), reads + 1)

    def test_a_flapping_server_is_never_asked_faster_than_the_ordinary_cycle(self):
        """Near a break the coordinator polls every 2 s. A server that comes
        and goes on every one of those still costs at most one health read
        per DEFAULT_SCAN_INTERVAL_S."""
        self.poll()
        reads = self.health_reads()
        for i in range(30):                          # 60 s of 2 s polls
            down = i % 2 == 0
            self.transport.health = MA_DOWN if down else GREEN
            self.transport.ma_ok = not down
            self.poll(2)
        self.assertLessEqual(self.health_reads() - reads, 60 // DEFAULT_SCAN_INTERVAL_S)


class TheKeyThePanelWatches(Timed):

    def test_it_moves_with_the_verdict_and_only_then(self):
        self.assertEqual(readiness_key(GREEN), "ma:1|")
        self.assertEqual(readiness_key(MA_REFUSED), "ma:0|ma_auth_rejected")
        self.assertEqual(readiness_key(None), "unknown")
        self.poll()
        green = self.key()
        self.poll()
        self.assertEqual(self.key(), green)
        self.transport.health, self.transport.ma_ok = MA_DOWN, False
        self.poll()
        self.assertEqual(self.key(), "ma:0|ma_unreachable")

    def test_unknown_on_either_side_is_no_disagreement(self):
        for outputs, health in ((None, GREEN), ({"ok": False}, None),
                                ({"reason": "x"}, GREEN), ({"ok": False}, {"problems": []})):
            with self.subTest(outputs=outputs, health=health):
                self.assertFalse(ma_disagrees(outputs, health))
        self.assertTrue(ma_disagrees({"ok": False}, GREEN))
        self.assertTrue(ma_disagrees({"ok": True}, MA_DOWN))

    def test_the_dj_status_sensor_publishes_it(self):
        hass, entry = T.setup(T.SettingsTransport())
        attrs = DjStatusSensor(harness.coordinator_of(hass, entry),
                               entry.entry_id).extra_state_attributes
        self.assertEqual(attrs["readiness_key"], "ma:1|")


class ARefusedInputChangesNothing(unittest.TestCase):
    """A 4xx answer to what somebody asked for says nothing about health:
    the report, the key and the next poll's cost are all as they were."""

    def test_a_refused_save_keeps_the_verdict(self):
        class Refusing(T.SettingsTransport):
            async def request(self, method, url, json=None, headers=None, timeout=None):
                if method == "PUT" and "/settings/station" in url:
                    return harness.FakeResponse(422, {"detail": "a name is required"})
                return await super().request(method, url, json=json, headers=headers,
                                             timeout=timeout)
        hass, entry = T.setup(Refusing())
        coordinator = harness.coordinator_of(hass, entry)
        key = coordinator.data["readiness_key"]
        with self.assertRaises(AssertionError):      # T.ws raises on a refusal
            T.ws(hass, "station_save", {"station": {"name": ""}})
        self.assertIsNotNone(coordinator.data["health"])
        self.assertEqual(coordinator.data["readiness_key"], key)
        self.assertEqual(T.ws(hass)["readiness"]["state"], readiness.READY)


if __name__ == "__main__":
    unittest.main()
