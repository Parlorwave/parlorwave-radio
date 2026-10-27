"""A person's Play on the DJ speaker reaches the backend as a NOTE.

Music Assistant never says who started playback, so a listener pressing Play
seconds after a finite queue ended could not be told from MA re-opening a
Flow by itself. Home Assistant's call_service event says who asked. The
coordinator forwards exactly that -- a PERSON's play/play_pause/play_media
aimed at the DJ speaker -- and nothing else: not an automation (no user),
not another speaker, not volume or stop. It calls no service itself.
"""

import asyncio
import unittest
from types import SimpleNamespace
from unittest import mock

import harness  # noqa: F401  -- puts the fakes and the package on sys.path

from homeassistant.core import EventBus  # noqa: E402

from custom_components.parlorwave_radio import coordinator as C  # noqa: E402
from custom_components.parlorwave_radio import entity as E  # noqa: E402

QID = "0c0ffee0-test-0000-0000-wholehouse01"
ENT = "media_player.test_group_speaker"


def call(service, target=ENT, domain="media_player"):
    return {"domain": domain, "service": service,
            "service_data": {"entity_id": target}}


class TargetTests(unittest.TestCase):

    def test_a_persons_play_on_the_dj_speaker(self):
        for service in ("media_play", "media_play_pause", "play_media"):
            self.assertEqual(C.listener_play_target(call(service), "user-1", QID, ENT),
                             QID, service)
        self.assertEqual(C.listener_play_target(call("media_play", [ENT, "x"]),
                                                "user-1", QID, ENT), QID)

    def test_everything_else_is_not_a_listeners_play(self):
        cases = {
            "automation (no user)": (call("media_play"), None),
            "another speaker": (call("media_play", "media_player.den"), "u"),
            "volume": (call("volume_set"), "u"),
            "stop": (call("media_stop"), "u"),
            "another domain": (call("turn_on", domain="light"), "u"),
            "no target": ({"domain": "media_player", "service": "media_play",
                           "service_data": {}}, "u"),
        }
        for name, (data, user) in cases.items():
            self.assertIsNone(C.listener_play_target(data, user, QID, ENT), name)
        self.assertIsNone(C.listener_play_target(call("media_play"), "u", None, ENT))


class CoordinatorTests(unittest.TestCase):

    def coordinator(self):
        co = object.__new__(C.ParlorwaveRadioCoordinator)
        sent, tasks = [], []

        class Client:
            async def listener_play(self, queue_id):
                sent.append(queue_id)
                return {"ok": True}

        co.client = Client()
        co.data = {"dj_settings": {"outputs": {"default_request_output": QID}}}
        co.hass = SimpleNamespace(bus=EventBus(),
                                  async_create_task=lambda c: tasks.append(c))
        co._stopped = False
        return co, sent, tasks

    def deliver(self, co, data, user="user-1"):
        for event_type, listener in list(co.hass.bus.listeners):
            if event_type == "call_service":
                listener(SimpleNamespace(data=data,
                                         context=SimpleNamespace(user_id=user)))

    def test_play_pressed_in_home_assistant_is_forwarded_once(self):
        co, sent, tasks = self.coordinator()
        with mock.patch.object(E, "ma_entity_for", lambda hass, pid: ENT):
            co._sync_play_request_listener()
            co._sync_play_request_listener()           # subscribes once
            self.assertEqual(len(co.hass.bus.listeners), 1)
            self.deliver(co, call("media_play"))
            self.deliver(co, call("media_play"), user=None)   # an automation
            self.deliver(co, call("volume_set"))
        for t in tasks:
            asyncio.run(t)
        self.assertEqual(sent, [QID])

    def test_unload_drops_the_listener(self):
        co, _, _ = self.coordinator()
        co._unsub_player = None
        co._watched_player = None
        co._sync_play_request_listener()
        self.assertEqual(len(co.hass.bus.listeners), 1)
        co.async_stop()
        self.assertEqual(co.hass.bus.listeners, [])


if __name__ == "__main__":
    unittest.main()
