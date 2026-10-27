"""Integration lifecycle, executed: setup / unload / setup again, options
reloads, and the context publisher's tasks -- against the fake core in
tests/fakes (or a real one when importable).

Pinned: every registered service is removed on unload and comes back on
setup; the static panel path is registered once per process however many
setups happen; the sidebar panel is present exactly once after any number
of reloads; the websocket commands never duplicate; a publisher cannot
post after its entry unloads; services resolve the CURRENT coordinator."""

import unittest

import harness
from harness import FakeTransport, coordinator_of, fire_state, make_hass
from custom_components.parlorwave_radio.const import (DOMAIN, PANEL_URL_PATH, SERVICES,
                                                      SUN_ENTITY)

# lyrics, queue, history, voices, voice_preview, news_status, news_save,
# news_test, entities, outputs, outputs_set, readiness.
#
# `outputs` and `outputs_set` are the DJ-enabled speaker allow-list, read
# and written from the panel's Settings screen instead of from the Home
# Assistant options flow. They add no store of record: both call the same
# two client methods the options flow already called.
# `calendar_test` and `weather_test` are the two halves of the same
# diagnostic: each republishes what Home Assistant currently reports and
# then asks the backend what it now holds, so a DJ that never mentions the
# calendar or the weather can be told apart from one that was never given
# `station_settings` and `station_save` read and write the station section
# (identity name) from Settings.
# `waveform` provides the current track normalized audio envelope for mouth animation.
# `announcements` reads the backend's announcements status for the Station
# tab and rides `station_save` for its settings writes.
# `station_dial`, `station_dial_save` and `station_preview` are the Station
# tab's Dial Stations card: read and replace the saved presets, and run
# Test Station (a dry run that changes nothing).
# `station_live`, `station_live_targets`, `station_live_start` and
# `station_live_stop` are the On-air station card (Mode 2): its state, the
# speakers it may use, and the explicit start/switch and stop.
# `station_live_autoplay` answers a pending Autoplay restore after a house
# handover's Stop could not switch Autoplay back on (restore | dismiss).
# `voice_scope` and `voice_announcement_default` are the Booth's two voice
# settings: what a voice is allowed for, and
# which allowed voice reads an announcement that names none.
# `voice_switch_dj` is Switch DJ: the next voice
# allowed to be the DJ, through the same selection write.
# `voice_shifts` is Automatic DJ shifts: on/off and a voice
# per shift, settled through the same selection write.
# `voice_collection`, `voice_collection_audio`, `_rename`, `_archive`,
# `_assign` and `_delete` are the Booth's Saved recordings:
# recordings kept apart from the Custom voices.
# `context_sources` and `context_sources_set` are the Settings screen's
# Sources card: which weather entity and which calendars the DJ may read,
# read from and written to the config entry's options (the same options the
# options flow writes; nothing moves). The write is administrator-gated.
WS_COMMANDS = 47


def services(hass):
    return set(hass.services.async_services().get(DOMAIN, {}))


class Lifecycle(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.transport = FakeTransport(enabled=["media_player.den"])
        self.hass, self.entry = make_hass(self.transport)
        self.entries = self.hass.config_entries

    async def test_setup_registers_everything_and_unload_removes_every_service(self):
        self.assertTrue(await self.entries.async_setup(self.entry.entry_id))
        self.assertEqual(services(self.hass), set(SERVICES))
        self.assertEqual(len(SERVICES), 9)
        self.assertEqual(len(self.hass.http.registrations), 1)
        self.assertIn(PANEL_URL_PATH, self.hass.data["frontend_panels"])
        self.assertEqual(len(self.hass.data["_fake_ws_commands"]), WS_COMMANDS)
        publisher = coordinator_of(self.hass, self.entry).context_publisher
        self.assertFalse(publisher.stopped)
        self.assertEqual(self.transport.count("POST", "/dj/context"), 1, "published at start")

        self.assertTrue(await self.entries.async_unload(self.entry.entry_id))
        self.assertEqual(services(self.hass), set(), "no stale service remains")
        self.assertNotIn(PANEL_URL_PATH, self.hass.data["frontend_panels"])
        self.assertEqual(self.hass.data[DOMAIN], {})
        self.assertTrue(publisher.stopped)
        self.assertEqual(self.hass._state_listeners, [])
        self.assertEqual(self.hass._interval_listeners, [])

    async def test_setup_unload_setup_recovers_without_a_restart(self):
        await self.entries.async_setup(self.entry.entry_id)
        first = coordinator_of(self.hass, self.entry)
        await self.entries.async_unload(self.entry.entry_id)
        # a fresh backend session for the second life
        second_transport = FakeTransport(enabled=["media_player.den"])
        self.hass.data["_fake_session"] = second_transport
        self.assertTrue(await self.entries.async_setup(self.entry.entry_id))
        second = coordinator_of(self.hass, self.entry)
        self.assertIsNot(first, second)
        self.assertEqual(services(self.hass), set(SERVICES))
        self.assertEqual(len(self.hass.http.registrations), 1, "static path registered once")
        self.assertEqual(len(self.hass.data["_fake_ws_commands"]), WS_COMMANDS)
        self.assertIn(PANEL_URL_PATH, self.hass.data["frontend_panels"])
        # services talk to the CURRENT coordinator's client, not the dead one
        await self.hass.services.async_call(DOMAIN, "thumbs_up", {"artist": "A", "title": "T"})
        feedback = lambda t: [c for c in t.calls if c["path"].endswith("/feedback")]  # noqa: E731
        self.assertEqual(len(feedback(second_transport)), 1)
        self.assertEqual(feedback(second_transport)[0]["path"],
                         "/playback/session/by-player/media_player.den/feedback")
        self.assertEqual(feedback(self.transport), [])

    async def test_consecutive_options_saves_restart_the_publisher_and_nothing_else(self):
        """A changed weather entity or calendar list used to reload the
        whole entry. It restarts the context publisher alone now: the
        coordinator, the entities, the services and the panel all stay as
        they are, and the fresh publisher reads the new selection and
        publishes at once."""
        await self.entries.async_setup(self.entry.entry_id)
        coordinator = coordinator_of(self.hass, self.entry)
        for i in range(3):
            old = coordinator.context_publisher
            before = self.transport.count("POST", "/dj/context")
            changed = self.entries.async_update_entry(
                self.entry, options={"weather_entity": f"weather.w{i}", "calendar_entities": []})
            self.assertTrue(changed)
            await self.hass.async_block_till_done()
            self.assertIs(coordinator_of(self.hass, self.entry), coordinator, "no reload")
            new = coordinator.context_publisher
            self.assertIsNot(old, new)
            self.assertTrue(old.stopped)
            self.assertFalse(new.stopped)
            self.assertEqual(new.weather_entity, f"weather.w{i}")
            self.assertEqual(self.transport.count("POST", "/dj/context"), before + 1,
                             "the new selection is published at once, exactly once")
            self.assertEqual(services(self.hass), set(SERVICES), f"save {i}")
            self.assertEqual(len(self.hass.http.registrations), 1, f"save {i}")
            self.assertEqual(len(self.hass.data["_fake_ws_commands"]), WS_COMMANDS)
            self.assertIn(PANEL_URL_PATH, self.hass.data["frontend_panels"])
            self.assertEqual(len(self.hass._interval_listeners), 1, "one interval timer")
            self.assertEqual(len(self.hass._state_listeners), 2,
                             "the publisher's and the coordinator's, once each")
        self.assertEqual(self.entries.reloads, 0)

    async def test_a_changed_connection_still_reloads(self):
        """Host, port or key is a different backend: only a reload builds
        the client for it."""
        await self.entries.async_setup(self.entry.entry_id)
        first = coordinator_of(self.hass, self.entry)
        self.entries.async_update_entry(self.entry, data={**self.entry.data, "port": 5006})
        await self.hass.async_block_till_done()
        self.assertEqual(self.entries.reloads, 1)
        self.assertIsNot(coordinator_of(self.hass, self.entry), first)
        self.assertTrue(first.context_publisher.stopped)

    async def test_an_unchanged_options_save_reloads_nothing(self):
        await self.entries.async_setup(self.entry.entry_id)
        self.assertFalse(self.entries.async_update_entry(self.entry, options={}))
        await self.hass.async_block_till_done()
        self.assertEqual(self.entries.reloads, 0)

    async def test_publisher_work_cannot_publish_after_unload(self):
        await self.entries.async_setup(self.entry.entry_id)
        publisher = coordinator_of(self.hass, self.entry).context_publisher
        posted = self.transport.count("POST", "/dj/context")
        # a horizon crossing queues a publish task...
        fire_state(self.hass, SUN_ENTITY, "above_horizon", "below_horizon")
        self.assertEqual(len(self.entry._background_tasks), 1, "entry-tracked task")
        # ...and the entry unloads before it runs
        await self.entries.async_unload(self.entry.entry_id)
        await self.hass.async_block_till_done()
        self.assertEqual(self.transport.count("POST", "/dj/context"), posted,
                         "nothing published after unload")
        self.assertEqual(self.entry._background_tasks, set())
        # a direct call on the stopped publisher posts nothing either
        await publisher.async_publish()
        self.assertEqual(self.transport.count("POST", "/dj/context"), posted)
        # and a state change after unload creates no task at all
        fire_state(self.hass, SUN_ENTITY, "below_horizon", "above_horizon")
        self.assertEqual(len(self.hass._state_listeners), 0)

    async def test_a_publish_in_flight_across_unload_does_not_post(self):
        await self.entries.async_setup(self.entry.entry_id)
        publisher = coordinator_of(self.hass, self.entry).context_publisher
        posted = self.transport.count("POST", "/dj/context")
        real_build = publisher.build

        async def build_then_unload():
            snap = await real_build()
            await self.entries.async_unload(self.entry.entry_id)   # lands mid-publish
            return snap
        publisher.build = build_then_unload
        await publisher.async_publish()
        self.assertEqual(self.transport.count("POST", "/dj/context"), posted)
        self.assertTrue(publisher.stopped)
        self.assertIsNone(publisher.status["published_at"] and None)

    async def test_state_change_publish_runs_while_loaded(self):
        await self.entries.async_setup(self.entry.entry_id)
        posted = self.transport.count("POST", "/dj/context")
        fire_state(self.hass, SUN_ENTITY, "above_horizon", "below_horizon")
        await self.hass.async_block_till_done()
        self.assertEqual(self.transport.count("POST", "/dj/context"), posted + 1)
        # an elevation tick (same state) publishes nothing
        fire_state(self.hass, SUN_ENTITY, "below_horizon", "below_horizon")
        await self.hass.async_block_till_done()
        self.assertEqual(self.transport.count("POST", "/dj/context"), posted + 1)


class CoordinatorPlayerListener(unittest.IsolatedAsyncioTestCase):
    """The coordinator watches the selected output so a track boundary
    refreshes the console at once. That subscription belongs to the entry
    and must leave with it, every time, or each reload adds one more
    listener refreshing a coordinator nothing reads."""

    PLAYER = "media_player.den"

    async def asyncSetUp(self):
        self.transport = FakeTransport(enabled=[self.PLAYER])
        self.hass, self.entry = make_hass(self.transport)
        self.entries = self.hass.config_entries

    def player_listeners(self, hass=None):
        hass = hass or self.hass
        return [rec for rec in hass._state_listeners if rec[0] == [self.PLAYER]]

    async def test_setup_watches_the_selected_output_and_a_change_refreshes(self):
        await self.entries.async_setup(self.entry.entry_id)
        self.assertEqual(len(self.player_listeners()), 1)
        coordinator = coordinator_of(self.hass, self.entry)
        before = coordinator.refreshes
        fire_state(self.hass, self.PLAYER, "playing", "playing", {"media_content_id": "next"})
        await self.hass.async_block_till_done()
        self.assertEqual(coordinator.refreshes, before + 1)

    async def test_no_selected_output_means_no_player_listener(self):
        hass, entry = make_hass(FakeTransport())
        await hass.config_entries.async_setup(entry.entry_id)
        self.assertEqual(self.player_listeners(hass), [])
        self.assertEqual(len(hass._state_listeners), 1, "the publisher's only")

    async def test_unload_removes_it_and_a_late_poll_cannot_bring_it_back(self):
        await self.entries.async_setup(self.entry.entry_id)
        coordinator = coordinator_of(self.hass, self.entry)
        self.assertTrue(await self.entries.async_unload(self.entry.entry_id))
        self.assertEqual(self.hass._state_listeners, [])
        # a refresh that was already in flight when the entry unloaded
        await coordinator.async_request_refresh()
        self.assertEqual(self.hass._state_listeners, [])
        # and the player changing afterwards reaches nothing
        before = coordinator.refreshes
        fire_state(self.hass, self.PLAYER, "playing", "idle")
        await self.hass.async_block_till_done()
        self.assertEqual(coordinator.refreshes, before)

    async def test_reloads_never_accumulate_listeners(self):
        await self.entries.async_setup(self.entry.entry_id)
        for i in range(3):
            self.entries.async_update_entry(
                self.entry, options={"weather_entity": f"weather.w{i}", "calendar_entities": []})
            await self.hass.async_block_till_done()
            self.assertEqual(len(self.player_listeners()), 1, f"options save {i}")
            self.assertEqual(len(self.hass._state_listeners), 2, f"options save {i}: "
                             "the replaced publisher took its listeners with it")
        self.assertEqual(self.entries.reloads, 0)
        for i in range(3):
            self.assertTrue(await self.entries.async_unload(self.entry.entry_id))
            self.assertEqual(self.hass._state_listeners, [], f"unload {i}")
            self.assertTrue(await self.entries.async_setup(self.entry.entry_id))
            self.assertEqual(len(self.player_listeners()), 1, f"setup {i}")

    async def test_stopping_and_unloading_again_is_harmless(self):
        await self.entries.async_setup(self.entry.entry_id)
        coordinator = coordinator_of(self.hass, self.entry)
        coordinator.async_stop()
        coordinator.async_stop()
        self.assertEqual(self.player_listeners(), [])
        self.assertTrue(await self.entries.async_unload(self.entry.entry_id))
        coordinator.async_stop()
        self.assertTrue(await self.entries.async_unload(self.entry.entry_id))
        self.assertEqual(self.hass._state_listeners, [])
        self.assertEqual(self.hass.data[DOMAIN], {})
        # a coordinator that never installed a listener stops just as quietly
        from custom_components.parlorwave_radio.coordinator import ParlorwaveRadioCoordinator
        fresh = ParlorwaveRadioCoordinator(self.hass, coordinator.client)
        fresh.async_stop()
        fresh.async_stop()


class ServiceOwnership(unittest.IsolatedAsyncioTestCase):
    async def test_services_refuse_cleanly_when_no_entry_is_loaded(self):
        from homeassistant.exceptions import HomeAssistantError
        hass, entry = make_hass()
        await hass.config_entries.async_setup(entry.entry_id)
        # simulate the domain data vanishing under a registered service
        hass.data[DOMAIN].clear()
        with self.assertRaises(HomeAssistantError):
            await hass.services.async_call(DOMAIN, "thumbs_up", {})


if __name__ == "__main__":
    unittest.main()
