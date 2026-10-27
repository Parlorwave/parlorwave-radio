"""The weather entity and the calendars, chosen inside ParlorWave Radio.

WHAT MOVED, AND WHAT DID NOT. The selection has always been the config
entry's options (CONF_WEATHER_ENTITY, CONF_CALENDAR_ENTITIES), written by
the options flow and read by the context publisher. That is still the one
store of record: the panel's Sources card writes the same options through
Home Assistant's own `async_update_entry`, so the options flow and the
screen cannot disagree, and nothing is migrated. What changed is where the
FORM is -- on the screen that is already about setup -- and what a change
costs: a restart of the context publisher instead of a reload of the whole
entry.

PINNED HERE: the inventory is names and availability only (no state, no
forecast, no event); nothing is ever selected for anybody; a chosen entity
that vanished is kept and reported; an entity Home Assistant does not have
cannot be introduced; each selector saves on its own; the write is applied
before the answer so the read that follows sees it live; the write is an
administrator's command; and the publisher restart is exactly one.
"""

import asyncio
import unittest

import harness
from harness import FakeTransport, make_hass
import custom_components.parlorwave_radio as integration


def setup(transport=None, options=None):
    hass, entry = make_hass(transport or FakeTransport(), options)
    asyncio.run(integration.async_setup_entry(hass, entry))
    hass.states.async_set("weather.home", "cloudy", {"friendly_name": "Home", "temperature": 14})
    hass.states.async_set("weather.cabin", "unavailable", {"friendly_name": "Cabin"})
    hass.states.async_set("calendar.book_club", "off", {"friendly_name": "Book Club",
                                                     "message": "Dentist", "description": "x"})
    hass.states.async_set("calendar.work", "on", {"friendly_name": "Work"})
    hass.states.async_set("calendar.old", "unknown", {"friendly_name": "Old"})
    return hass, entry


class FakeConnection:
    def __init__(self):
        self.result, self.error = None, None

    def send_result(self, _id, result):
        self.result = result

    def send_error(self, _id, code, message):
        self.error = (code, message)


def handler_for(hass, name):
    wanted = f"parlorwave_radio/{name}"
    for handler in hass.data.get("_fake_ws_commands", []):
        if handler.ws_schema.get("type") == wanted:
            return handler
    raise AssertionError(f"{wanted} is not registered")


def ws(hass, name, msg=None, settle_after=True):
    """Invoke one REGISTERED command the way Home Assistant does, and -- as
    Home Assistant would -- let the update listener the write schedules
    run in the same loop before the answer is looked at."""
    conn = FakeConnection()
    payload = {"id": 1, "type": f"parlorwave_radio/{name}"}
    payload.update(msg or {})

    async def run():
        await handler_for(hass, name)(hass, conn, payload)
        if settle_after:
            await hass.async_block_till_done()
    asyncio.run(run())
    if conn.error:
        raise AssertionError(f"{name} refused: {conn.error}")
    return conn.result


def refusal(hass, name, msg):
    try:
        ws(hass, name, msg)
    except AssertionError as exc:
        return str(exc)
    raise AssertionError(f"{name} did not refuse")


def by_id(rows):
    return {r["entity_id"]: r for r in rows}


class TheInventory(unittest.TestCase):
    def test_every_weather_and_calendar_entity_is_offered_with_its_name_and_nothing_else(self):
        hass, _ = setup()
        out = ws(hass, "context_sources")
        self.assertTrue(out["ok"])
        w = by_id(out["weather"]["entities"])
        self.assertEqual(set(w), {"weather.home", "weather.cabin"})
        self.assertEqual(w["weather.home"], {"entity_id": "weather.home", "name": "Home",
                                             "available": True, "selected": False,
                                             "missing": False})
        self.assertFalse(w["weather.cabin"]["available"])
        c = by_id(out["calendars"]["entities"])
        self.assertEqual(set(c), {"calendar.book_club", "calendar.work", "calendar.old"})
        self.assertFalse(c["calendar.old"]["available"])
        for private in ("cloudy", "temperature", "14", "Dentist", "message", "description"):
            self.assertNotIn(private, repr(out), private)

    def test_the_lists_are_in_name_order(self):
        hass, _ = setup()
        out = ws(hass, "context_sources")
        self.assertEqual([r["name"] for r in out["calendars"]["entities"]],
                         ["Book Club", "Old", "Work"])

    def test_nothing_is_selected_for_anybody(self):
        hass, _ = setup()
        out = ws(hass, "context_sources")
        self.assertEqual(out["weather"]["selected"], "")
        self.assertEqual(out["calendars"]["selected"], [])
        self.assertFalse(any(r["selected"] for r in out["weather"]["entities"]))
        self.assertFalse(any(r["selected"] for r in out["calendars"]["entities"]))

    def test_the_selection_comes_from_the_entry_options_and_the_publisher_reads_it(self):
        hass, _ = setup(options={"weather_entity": "weather.home",
                                  "calendar_entities": ["calendar.work"]})
        out = ws(hass, "context_sources")
        self.assertEqual(out["weather"]["selected"], "weather.home")
        self.assertEqual(out["weather"]["live"], "weather.home")
        self.assertEqual(out["calendars"]["selected"], ["calendar.work"])
        self.assertEqual(out["calendars"]["live"], ["calendar.work"])
        self.assertTrue(by_id(out["weather"]["entities"])["weather.home"]["selected"])
        self.assertTrue(by_id(out["calendars"]["entities"])["calendar.work"]["selected"])

    def test_a_chosen_entity_that_vanished_is_still_listed_chosen_and_said_to_be_missing(self):
        hass, _ = setup(options={"weather_entity": "weather.gone",
                                  "calendar_entities": ["calendar.book_club", "calendar.gone"]})
        out = ws(hass, "context_sources")
        w = by_id(out["weather"]["entities"])["weather.gone"]
        self.assertEqual((w["selected"], w["missing"], w["available"]), (True, True, False))
        c = by_id(out["calendars"]["entities"])["calendar.gone"]
        self.assertEqual((c["selected"], c["missing"]), (True, True))
        self.assertFalse(by_id(out["calendars"]["entities"])["calendar.book_club"]["missing"])

    def test_a_calendar_the_publisher_could_not_read_is_flagged(self):
        hass, entry = setup(options={"calendar_entities": ["calendar.book_club", "calendar.work"]})
        coordinator = hass.data["parlorwave_radio"][entry.entry_id]
        coordinator.context_status["calendar"]["failed"] = ["calendar.work"]
        c = by_id(ws(hass, "context_sources")["calendars"]["entities"])
        self.assertTrue(c["calendar.work"]["failed"])
        self.assertFalse(c["calendar.book_club"]["failed"])

    def test_pending_announcements_are_counted_per_calendar_best_effort(self):
        class WithAnnouncements(FakeTransport):
            async def request(self, method, url, json=None, headers=None, timeout=None):
                if url.endswith("/announcements/status"):
                    return harness.FakeResponse(200, {"ok": True, "upcoming": [
                        {"id": "1", "source": "calendar.book_club", "state": "scheduled"},
                        {"id": "2", "source": "calendar.book_club", "state": "committed:ready"},
                        {"id": "3", "source": "calendar.work", "state": "scheduled"}]})
                return await super().request(method, url, json=json, headers=headers,
                                             timeout=timeout)
        hass, _ = setup(WithAnnouncements())
        out = ws(hass, "context_sources")
        # only SCHEDULED counts: the committed one is already with the player
        self.assertEqual(out["pending"], {"calendar.book_club": 1, "calendar.work": 1})
        self.assertIs(out["deselect_cancels"], False,
                      "a backend that does not say it cancels is read as one that keeps")

        class Silent(FakeTransport):
            async def request(self, method, url, json=None, headers=None, timeout=None):
                if url.endswith("/announcements/status"):
                    return harness.FakeResponse(503, {"detail": "no"})
                return await super().request(method, url, json=json, headers=headers,
                                             timeout=timeout)
        hass, _ = setup(Silent())
        out = ws(hass, "context_sources")
        self.assertTrue(out["ok"], "an unreadable announcements status does not fail the read")
        self.assertEqual(out["pending"], {})
        self.assertIs(out["deselect_cancels"], False)

    def test_only_a_backend_that_says_so_is_one_that_cancels_on_untick(self):
        """Announcements keep and air a scheduled
        occurrence whose calendar is unticked. Only `selection_enforced:
        true` -- exactly True -- makes the screen say unticking cancels."""
        def transport(flag):
            class T(FakeTransport):
                async def request(self, method, url, json=None, headers=None, timeout=None):
                    if url.endswith("/announcements/status"):
                        body = {"ok": True, "upcoming": [
                            {"id": "1", "source": "calendar.book_club", "state": "scheduled"},
                            {"id": "2", "source": "calendar.book_club", "state": "invalid"}]}
                        if flag is not None:
                            body["selection_enforced"] = flag
                        return harness.FakeResponse(200, body)
                    return await super().request(method, url, json=json, headers=headers,
                                                 timeout=timeout)
            return T()
        for flag, want in ((None, False), (False, False), ("true", False), (1, False), (True, True)):
            hass, _ = setup(transport(flag))
            out = ws(hass, "context_sources")
            self.assertIs(out["deselect_cancels"], want, repr(flag))
            self.assertEqual(out["pending"], {"calendar.book_club": 1}, "an invalid one never airs")
            wrote = ws(hass, "context_sources_set", {"calendars": ["calendar.work"]})
            self.assertIs(wrote["deselect_cancels"], want, f"the write's answer, {flag!r}")


class TheWrite(unittest.TestCase):
    def test_choosing_writes_the_entry_options_and_restarts_only_the_publisher(self):
        hass, entry = setup()
        coordinator = hass.data["parlorwave_radio"][entry.entry_id]
        old = coordinator.context_publisher
        before = hass.data["_fake_session"].count("POST", "/dj/context")
        out = ws(hass, "context_sources_set", {"weather": "weather.home",
                                               "calendars": ["calendar.book_club"]})
        self.assertTrue(out["ok"] and out["changed"])
        self.assertEqual(entry.options, {"weather_entity": "weather.home",
                                         "calendar_entities": ["calendar.book_club"]})
        self.assertIs(hass.data["parlorwave_radio"][entry.entry_id], coordinator, "no reload")
        self.assertEqual(hass.config_entries.reloads, 0)
        new = coordinator.context_publisher
        self.assertIsNot(new, old)
        self.assertTrue(old.stopped)
        self.assertEqual((new.weather_entity, new.calendar_entities),
                         ("weather.home", ["calendar.book_club"]))
        # the answer already describes the new selection, live
        self.assertEqual(out["weather"]["live"], "weather.home")
        self.assertEqual(out["calendars"]["live"], ["calendar.book_club"])
        self.assertEqual(hass.data["_fake_session"].count("POST", "/dj/context"), before + 1,
                         "published once, by the new publisher")

    def test_the_scheduled_update_listener_then_finds_nothing_to_do(self):
        """Home Assistant schedules the entry's update listener after the
        write. The write applied the selection itself, so the listener
        must neither restart the publisher again nor reload."""
        hass, entry = setup()
        coordinator = hass.data["parlorwave_radio"][entry.entry_id]
        seen = {}

        async def run():
            conn = FakeConnection()
            await handler_for(hass, "context_sources_set")(
                hass, conn, {"id": 1, "type": "parlorwave_radio/context_sources_set",
                             "weather": "weather.home"})
            seen["applied"] = coordinator.context_publisher
            seen["posts"] = hass.data["_fake_session"].count("POST", "/dj/context")
            await hass.async_block_till_done()        # the listener runs here
        asyncio.run(run())
        self.assertIs(coordinator.context_publisher, seen["applied"], "restarted a second time")
        self.assertEqual(hass.data["_fake_session"].count("POST", "/dj/context"), seen["posts"])
        self.assertEqual(hass.config_entries.reloads, 0)

    def test_each_selector_saves_on_its_own(self):
        hass, entry = setup(options={"weather_entity": "weather.home",
                                      "calendar_entities": ["calendar.book_club"]})
        ws(hass, "context_sources_set", {"calendars": ["calendar.work"]})
        self.assertEqual(entry.options["weather_entity"], "weather.home", "weather untouched")
        self.assertEqual(entry.options["calendar_entities"], ["calendar.work"])
        ws(hass, "context_sources_set", {"weather": "", "calendars": None})
        self.assertEqual(entry.options["weather_entity"], "")
        self.assertEqual(entry.options["calendar_entities"], ["calendar.work"], "calendars untouched")

    def test_nothing_selected_is_a_valid_state_for_both(self):
        hass, entry = setup(options={"weather_entity": "weather.home",
                                      "calendar_entities": ["calendar.book_club"]})
        out = ws(hass, "context_sources_set", {"weather": "", "calendars": []})
        self.assertTrue(out["changed"])
        self.assertEqual(entry.options, {"weather_entity": "", "calendar_entities": []})
        pub = hass.data["parlorwave_radio"][entry.entry_id].context_publisher
        self.assertIsNone(pub.weather_entity)
        self.assertEqual(pub.calendar_entities, [])

    def test_an_unchanged_write_changes_nothing_and_restarts_nothing(self):
        hass, entry = setup(options={"weather_entity": "weather.home", "calendar_entities": []})
        before = hass.data["parlorwave_radio"][entry.entry_id].context_publisher
        out = ws(hass, "context_sources_set", {"weather": "weather.home", "calendars": []})
        self.assertFalse(out["changed"])
        self.assertIs(hass.data["parlorwave_radio"][entry.entry_id].context_publisher, before)

    def test_an_entity_home_assistant_does_not_have_cannot_be_introduced(self):
        hass, entry = setup()
        self.assertIn("not in Home Assistant", refusal(hass, "context_sources_set",
                                                        {"weather": "weather.nowhere"}))
        self.assertIn("not in Home Assistant", refusal(hass, "context_sources_set",
                                                        {"calendars": ["calendar.nowhere"]}))
        # nor the wrong kind of entity, whether or not it exists
        self.assertIn("not in Home Assistant", refusal(hass, "context_sources_set",
                                                        {"weather": "calendar.book_club"}))
        self.assertIn("not in Home Assistant", refusal(hass, "context_sources_set",
                                                        {"calendars": ["weather.home"]}))
        self.assertEqual(entry.options, {}, "a refused write wrote nothing")

    def test_a_chosen_entity_that_vanished_may_be_kept_and_may_be_dropped(self):
        hass, entry = setup(options={"weather_entity": "weather.gone",
                                      "calendar_entities": ["calendar.gone", "calendar.book_club"]})
        # kept: the person did not touch it
        out = ws(hass, "context_sources_set", {"calendars": ["calendar.gone", "calendar.work"]})
        self.assertEqual(out["calendars"]["selected"], ["calendar.gone", "calendar.work"])
        # dropped: the person unticked it
        out = ws(hass, "context_sources_set", {"weather": "", "calendars": ["calendar.work"]})
        self.assertEqual(entry.options, {"weather_entity": "", "calendar_entities": ["calendar.work"]})
        self.assertNotIn("calendar.gone", by_id(out["calendars"]["entities"]))

    def test_duplicates_and_blanks_are_dropped_from_a_calendar_list(self):
        hass, entry = setup()
        ws(hass, "context_sources_set", {"calendars": ["calendar.book_club", "", "calendar.book_club"]})
        self.assertEqual(entry.options["calendar_entities"], ["calendar.book_club"])

    def test_the_write_is_an_administrators_command_and_the_read_is_not(self):
        hass, _ = setup()
        self.assertTrue(getattr(handler_for(hass, "context_sources_set"), "requires_admin", False))
        self.assertFalse(getattr(handler_for(hass, "context_sources"), "requires_admin", False))
        init = (harness.HA_ROOT / "custom_components" / "parlorwave_radio" / "__init__.py").read_text()
        self.assertIn("websocket_api.require_admin(handler)", init)
        block = init[init.index('_command("parlorwave_radio/context_sources_set"'):]
        self.assertIn("admin=True)", block[:block.index("\n\n")])

    def test_the_options_flow_still_writes_the_same_store(self):
        """Both surfaces write CONF_WEATHER_ENTITY / CONF_CALENDAR_ENTITIES on
        the entry; the panel reads back what the flow wrote and the flow's
        form shows what the panel wrote."""
        hass, entry = setup()

        async def flow_saves():
            hass.config_entries.async_update_entry(
                entry, options={"weather_entity": "weather.cabin",
                                "calendar_entities": ["calendar.work"]})
            await hass.async_block_till_done()
        asyncio.run(flow_saves())
        out = ws(hass, "context_sources")
        self.assertEqual(out["weather"]["selected"], "weather.cabin")
        self.assertEqual(out["calendars"]["selected"], ["calendar.work"])
        self.assertEqual(out["weather"]["live"], "weather.cabin")
        flow = (harness.HA_ROOT / "custom_components" / "parlorwave_radio" / "config_flow.py").read_text()
        self.assertIn("CONF_WEATHER_ENTITY: user_input.get(CONF_WEATHER_ENTITY)", flow)


if __name__ == "__main__":
    unittest.main()
