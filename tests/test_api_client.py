"""Parlorwave Radio service client contract tests -- no Home Assistant required.

The client is transport-injectable precisely so this file can run under the
repo's stdlib harness: a fake transport records every call and answers with
scripted responses. What these tests pin is the CONTRACT the integration
sends over the wire -- exact paths, exact patch bodies, auth header
behavior, and error mapping -- because those are the things a refactor
would silently break."""

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent
                       / "custom_components" / "parlorwave_radio"))

from api import (RadioServiceAuthError, RadioServiceClient,  # noqa: E402
                 RadioServiceConnectionError, RadioServiceError)


class FakeResponse:
    def __init__(self, status=200, data=None):
        self.status = status
        self._data = {"ok": True} if data is None else data

    async def json(self):
        if isinstance(self._data, Exception):
            raise self._data
        return self._data


class FakeTransport:
    def __init__(self, *responses):
        self.calls = []
        self._responses = list(responses) or [FakeResponse()]

    async def request(self, method, url, json=None, headers=None, timeout=None):
        self.calls.append({"method": method, "url": url, "json": json,
                           "headers": headers or {}})
        r = self._responses.pop(0) if len(self._responses) > 1 else self._responses[0]
        if isinstance(r, Exception):
            raise r
        return r


def run(coro):
    return asyncio.run(coro)


def client(transport, key=""):
    return RadioServiceClient(transport, "http://mb:5005", key)


class Identity(unittest.TestCase):
    def test_instance_is_one_authenticated_get(self):
        t = FakeTransport(FakeResponse(200, {"ok": True, "instance_id": "abc123",
                                             "deployment": "addon"}))
        body = run(client(t, key="sekrit").instance())
        self.assertEqual(len(t.calls), 1)
        self.assertEqual(t.calls[0]["method"], "GET")
        self.assertTrue(t.calls[0]["url"].endswith("/instance"))
        self.assertEqual(t.calls[0]["headers"].get("X-Api-Key"), "sekrit")
        self.assertEqual(body["instance_id"], "abc123")

    def test_a_rejected_key_raises_auth(self):
        t = FakeTransport(FakeResponse(401, {"detail": "no"}))
        with self.assertRaises(RadioServiceAuthError):
            run(client(t, key="wrong").instance())


class OutputsAndHealth(unittest.TestCase):
    def test_set_enabled_outputs_is_one_settings_put_that_replaces_the_list(self):
        t = FakeTransport()
        run(client(t).set_enabled_outputs(["media_player.den", " ma_web123 ", "media_player.den", ""]))
        self.assertEqual(len(t.calls), 1)
        self.assertEqual(t.calls[0]["method"], "PUT")
        self.assertTrue(t.calls[0]["url"].endswith("/settings/dj"))
        self.assertEqual(t.calls[0]["json"],
                         {"outputs": {"enabled": ["media_player.den", "ma_web123"]}})

    def test_set_enabled_outputs_empty_is_a_valid_write(self):
        t = FakeTransport()
        run(client(t).set_enabled_outputs([]))
        self.assertEqual(t.calls[0]["json"], {"outputs": {"enabled": []}})

    def test_health_problems_is_a_get(self):
        t = FakeTransport(FakeResponse(200, {"ok": True, "problems": [], "features": {}}))
        body = run(client(t).health_problems())
        self.assertEqual(t.calls[0]["method"], "GET")
        self.assertTrue(t.calls[0]["url"].endswith("/health/problems"))
        self.assertEqual(body["problems"], [])

    def test_current_waveform_is_a_get(self):
        t = FakeTransport(FakeResponse(200, {"ok": True, "bins": [0.1, 0.2]}))
        body = run(client(t).current_waveform("queue_1"))
        self.assertEqual(t.calls[0]["method"], "GET")
        self.assertTrue(t.calls[0]["url"].endswith("/broadcast/waveform/current?queue_id=queue_1"))
        self.assertTrue(body["ok"])

        # Without queue_id
        t2 = FakeTransport(FakeResponse(200, {"ok": True, "bins": []}))
        body2 = run(client(t2).current_waveform())
        self.assertTrue(t2.calls[0]["url"].endswith("/broadcast/waveform/current"))
        self.assertTrue(body2["ok"])


class AuthAndErrors(unittest.TestCase):
    def test_api_key_header_sent_when_configured(self):
        t = FakeTransport()
        run(client(t, key="sekrit").dj_status())
        self.assertEqual("sekrit", t.calls[0]["headers"].get("X-Api-Key"))

    def test_no_auth_header_when_unconfigured(self):
        t = FakeTransport()
        run(client(t).dj_status())
        self.assertNotIn("X-Api-Key", t.calls[0]["headers"])

    def test_network_failure_maps_to_connection_error(self):
        t = FakeTransport(OSError("connection refused"))
        with self.assertRaises(RadioServiceConnectionError):
            run(client(t).dj_status())

    def test_401_maps_to_auth_error(self):
        t = FakeTransport(FakeResponse(401, {"detail": "no"}))
        with self.assertRaises(RadioServiceAuthError):
            run(client(t, key="wrong").dj_status())

    def test_5xx_maps_to_error(self):
        t = FakeTransport(FakeResponse(500, {}))
        with self.assertRaises(RadioServiceError):
            run(client(t).dj_status())

    def test_422_maps_to_error_with_detail(self):
        t = FakeTransport(FakeResponse(422, {"detail": "cadence out of range"}))
        with self.assertRaises(RadioServiceError) as ctx:
            run(client(t).set_cadence_minutes(9999))
        self.assertIn("cadence out of range", str(ctx.exception))

    def test_truthful_refusal_passes_through(self):
        # {ok: false, reason} on 200/409-style answers is DATA, not an
        # exception: Start Radio refusals must reach the caller intact.
        t = FakeTransport(FakeResponse(200, {"ok": False, "reason": "no_current_track"}))
        out = run(client(t).start_radio_from_current())
        self.assertEqual({"ok": False, "reason": "no_current_track"}, out)


class WriteBodies(unittest.TestCase):
    """The exact patches: partial, nested, and nothing else."""

    def _one(self, coro):
        t = FakeTransport()
        run(coro(client(t)))
        return t.calls[0]

    def test_dj_enabled_patch(self):
        c = self._one(lambda cl: cl.set_dj_enabled(False))
        self.assertEqual(("PUT", "http://mb:5005/settings/dj",
                          {"enabled": False}),
                         (c["method"], c["url"], c["json"]))

    def test_dj_speech_patch_is_its_own_key(self):
        # never the DJ power key: the two switches write different fields
        c = self._one(lambda cl: cl.set_dj_speech_enabled(False))
        self.assertEqual(("PUT", "http://mb:5005/settings/dj",
                          {"speech_enabled": False}),
                         (c["method"], c["url"], c["json"]))

    def test_dj_stories_patch_is_the_preference_only(self):
        # the listener's switch: never the rollout gate
        c = self._one(lambda cl: cl.set_dj_stories_enabled(False))
        self.assertEqual(("PUT", "http://mb:5005/settings/dj",
                          {"stories_enabled": False}),
                         (c["method"], c["url"], c["json"]))

    def test_endless_radio_patch(self):
        c = self._one(lambda cl: cl.set_keep_radio_playing(True))
        self.assertEqual(("PUT", "http://mb:5005/settings/playback",
                          {"keep_radio_playing": True}),
                         (c["method"], c["url"], c["json"]))

    def test_cadence_patch_is_nested(self):
        c = self._one(lambda cl: cl.set_cadence_minutes(15))
        self.assertEqual({"programming": {"cadence_min_minutes": 15}}, c["json"])

    def test_break_length_patch_is_nested(self):
        c = self._one(lambda cl: cl.set_break_length("short"))
        self.assertEqual({"programming": {"break_length": "short"}}, c["json"])

    def test_output_selection_is_a_settings_write_and_nothing_else(self):
        # THE product invariant: choosing an output must never touch
        # transport. One call, PUT /settings/dj, nested outputs patch.
        t = FakeTransport()
        run(client(t).set_default_output("media_player.kitchen"))
        self.assertEqual(1, len(t.calls))
        call = t.calls[0]
        self.assertEqual("PUT", call["method"])
        self.assertEqual("http://mb:5005/settings/dj", call["url"])
        self.assertEqual(
            {"outputs": {"default_request_output": "media_player.kitchen"}},
            call["json"])


class StudioWriteBodies(unittest.TestCase):
    """Studio is settings-only. Each write is ONE partial PUT to a settings
    section; the backend deep-merges, so siblings (the other persona keys,
    the voice ref) are never sent and never clobbered."""

    def _one(self, coro):
        t = FakeTransport()
        run(coro(client(t)))
        self.assertEqual(1, len(t.calls))
        return t.calls[0]

    def test_personality_patch(self):
        c = self._one(lambda cl: cl.set_personality("late_night"))
        self.assertEqual(("PUT", "http://mb:5005/settings/dj",
                          {"persona": {"profile": "late_night"}}),
                         (c["method"], c["url"], c["json"]))

    def test_chattiness_patch_and_null_means_follow_personality(self):
        c = self._one(lambda cl: cl.set_chattiness("low"))
        self.assertEqual({"persona": {"chattiness": "low"}}, c["json"])
        c = self._one(lambda cl: cl.set_chattiness(None))
        self.assertEqual({"persona": {"chattiness": None}}, c["json"])

    def test_voice_patch_and_empty_means_service_default(self):
        c = self._one(lambda cl: cl.set_voice("al_cynical"))
        self.assertEqual({"persona": {"voice": {"refs": {
            "chatterbox_voice": "al_cynical"}}}}, c["json"])
        c = self._one(lambda cl: cl.set_voice(""))
        self.assertEqual({"persona": {"voice": {"refs": {
            "chatterbox_voice": ""}}}}, c["json"])

    def test_break_content_patch(self):
        c = self._one(lambda cl: cl.set_break_content("weather", False))
        self.assertEqual(("PUT", "http://mb:5005/settings/dj",
                          {"content": {"weather": False}}),
                         (c["method"], c["url"], c["json"]))

    def test_station_feel_is_a_station_settings_write_and_nothing_else(self):
        c = self._one(lambda cl: cl.set_station_feel("discovery"))
        self.assertEqual(("PUT", "http://mb:5005/settings/station",
                          {"feel": "discovery"}),
                         (c["method"], c["url"], c["json"]))

    def test_unknown_voice_refusal_surfaces_the_backend_detail(self):
        t = FakeTransport(FakeResponse(
            422, {"detail": "voice 'nope' is not offered by the TTS service"}))
        with self.assertRaises(RadioServiceError) as ctx:
            run(client(t).set_voice("nope"))
        self.assertIn("not offered", str(ctx.exception))

    def test_studio_read_paths(self):
        t = FakeTransport()
        run(client(t).station_settings())
        run(client(t).studio_catalog())
        self.assertEqual(["http://mb:5005/settings/station",
                          "http://mb:5005/studio/catalog"],
                         [c["url"] for c in t.calls])
        self.assertEqual({"GET"}, {c["method"] for c in t.calls})


class Actions(unittest.TestCase):
    def test_request_station_body(self):
        t = FakeTransport(FakeResponse(200, {"ok": True, "session": {}, "queue": []}))
        run(client(t).request_station("90s road trip",
                                      "media_player.den", count=25,
                                      mode="road_trip"))
        c = t.calls[0]
        self.assertEqual("POST", c["method"])
        self.assertTrue(c["url"].endswith("/playback/session"))
        self.assertEqual({"request": "90s road trip",
                          "player": "media_player.den", "queue": True,
                          "count": 25, "mode": "road_trip"}, c["json"])

    def test_start_radio_targets_from_current(self):
        t = FakeTransport()
        run(client(t).start_radio_from_current(queue_id="media_player.den",
                                               count=12))
        c = t.calls[0]
        self.assertTrue(c["url"].endswith("/station/from-current"))
        self.assertEqual({"queue_id": "media_player.den", "count": 12},
                         c["json"])

    def test_feedback_prefers_player_scoped_route(self):
        t = FakeTransport()
        run(client(t).feedback("thumbs_up", artist="Cold Orchard",
                               title="Night Crossing", player="media_player.den"))
        c = t.calls[0]
        self.assertTrue(c["url"].endswith(
            "/playback/session/by-player/media_player.den/feedback"))
        self.assertEqual({"action": "thumbs_up", "artist": "Cold Orchard",
                          "title": "Night Crossing"}, c["json"])

    def test_request_song_names_no_speaker(self):
        """alpha.4: the backend picks the DJ's speaker itself."""
        t = FakeTransport()
        run(client(t).request_song("Slow Ferry", artist="Cold Orchard"))
        c = t.calls[0]
        self.assertTrue(c["url"].endswith("/request/song"))
        self.assertEqual({"title": "Slow Ferry", "artist": "Cold Orchard"}, c["json"])
        run(client(t).request_song("Slow Ferry"))
        self.assertEqual({"title": "Slow Ferry"}, t.calls[1]["json"])

    def test_feedback_falls_back_to_global_route(self):
        t = FakeTransport()
        run(client(t).feedback("thumbs_down", artist="X", title="Y"))
        self.assertTrue(t.calls[0]["url"].endswith("/feedback"))



class VoiceRenameClient(unittest.TestCase):
    def test_voice_rename_posts_voice_id_in_path_and_name_in_body(self):
        seen = {}
        client = RadioServiceClient.__new__(RadioServiceClient)

        async def fake_call(method, path, json=None):
            seen.update(method=method, path=path, json=json)
            return {"ok": True}
        client._call = fake_call
        asyncio.run(RadioServiceClient.voice_rename(client, "george", "calm, slower reader"))
        self.assertEqual(seen, {"method": "POST", "path": "/voices/george/rename",
                                "json": {"name": "calm, slower reader"}})


class VoiceTuningClient(unittest.TestCase):
    def test_voice_tuning_posts_both_values(self):
        seen = {}
        client = RadioServiceClient.__new__(RadioServiceClient)

        async def fake_call(method, path, json=None):
            seen.update(method=method, path=path, json=json)
            return {"ok": True}
        client._call = fake_call
        asyncio.run(RadioServiceClient.voice_tuning(client, "george", 0.9, 1.4))
        self.assertEqual(seen, {"method": "POST", "path": "/voices/george/tuning",
                                "json": {"speed": 0.9, "pause": 1.4}})

    def test_preview_sends_delivery_only_when_given(self):
        seen = []
        client = RadioServiceClient.__new__(RadioServiceClient)

        async def fake_binary(method, path, json=None, timeout_s=None):
            seen.append(json)
            return 200, b"RIFF", "audio/wav"
        client._call_binary = fake_binary
        asyncio.run(RadioServiceClient.voice_preview(client, "george"))
        asyncio.run(RadioServiceClient.voice_preview(client, "george", 0.9, 1.4))
        self.assertEqual(seen, [{"voice_id": "george"},
                               {"voice_id": "george", "speed": 0.9, "pause": 1.4}])


class VoiceNoteClient(unittest.TestCase):
    def test_voice_note_posts_voice_id_in_path_and_note_in_body(self):
        seen = {}
        client = RadioServiceClient.__new__(RadioServiceClient)

        async def fake_call(method, path, json=None):
            seen.update(method=method, path=path, json=json)
            return {"ok": True}
        client._call = fake_call
        asyncio.run(RadioServiceClient.voice_note(client, "george", "calm, slower reader"))
        self.assertEqual(seen, {"method": "POST", "path": "/voices/george/note",
                                "json": {"note": "calm, slower reader"}})

if __name__ == "__main__":
    unittest.main()
