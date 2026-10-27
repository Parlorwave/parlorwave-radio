"""The Home Assistant half: structural contracts on context_publisher and the
options flow (no Home Assistant runtime in this harness), plus the client
method. What they pin: supported APIs only, event-driven + modest refresh,
nothing but the selected entities read, nothing but contract fields sent."""

import asyncio
import re
import sys
import unittest
from pathlib import Path

PKG = Path(__file__).resolve().parents[1] / "custom_components" / "parlorwave_radio"
sys.path.insert(0, str(PKG))
from api import RadioServiceClient  # noqa: E402

PUB = (PKG / "context_publisher.py").read_text()
#: The one function that reads a calendar description (the directive
#: voice line); every other description read is still banned.
_DIRECTIVE_VOICE_BODY = PUB[PUB.index("def _directive_voice(ev"):PUB.index("class ContextPublisher")]
FLOW = (PKG / "config_flow.py").read_text()
INIT = (PKG / "__init__.py").read_text()
CONST = (PKG / "const.py").read_text()


class PublisherContracts(unittest.TestCase):
    def test_uses_supported_home_assistant_apis_only(self):
        self.assertIn("async_track_state_change_event(", PUB)
        self.assertIn("async_track_time_interval(", PUB)
        self.assertIn('"weather", "get_forecasts"', PUB)
        self.assertIn('"calendar", "get_events"', PUB)
        self.assertIn("return_response=True", PUB)
        services = set(re.findall(r'async_call\(\s*"([a-z_]+)", "([a-z_]+)"', PUB))
        self.assertEqual(services, {("weather", "get_forecasts"), ("calendar", "get_events")})
        # never a state dump, never other domains. The ONE read of a
        # description is the directive voice line (announcement voices),
        # confined to _directive_voice and pinned separately below.
        scrubbed = (PUB.replace("never descriptions, locations, GPS,\npersons, presence", "")
                    .replace("(never descriptions, locations, GPS,", "")
                    .replace("bulletins are backend-owned", "")
                    .replace(_DIRECTIVE_VOICE_BODY, ""))
        for banned in ("async_all(", "states.async_entity_ids", "person.", "device_tracker",
                       "zone.", "latitude", "longitude", '"description"', '"location"', "attendees",
                       "tts.", "media_player", "rest_command", "news"):
            self.assertNotIn(banned, scrubbed, banned)

    def test_cadence_is_modest(self):
        m = re.search(r"CONTEXT_REFRESH_MINUTES = (\d+)", CONST)
        self.assertTrue(m and 5 <= int(m.group(1)) <= 30, "refresh between 5 and 30 minutes")
        self.assertIn("horizon crossings only", PUB)             # sun: not every elevation tick
        self.assertIn('old.attributes.get("temperature") != new.attributes.get("temperature")', PUB)

    def test_calendar_query_sends_only_summary_start_end(self):
        block = PUB[PUB.index("for ev in ((resp or {}).get(entity_id)"):]
        block = block[:block.index("self.status[\"calendar\"].update")]
        self.assertIn('events.append({"summary": summary, "start": ev.get("start")', block)
        self.assertIn('"end": ev.get("end")', block)
        self.assertNotIn("description", block); self.assertNotIn("location", block)

    def test_a_directive_voice_line_is_the_only_description_read(self):
        """A DIRECTIVE event's description may
        name the voice to read it with (`voice: Evening Reader`). Only that value
        leaves Home Assistant, only for directive events, and the loop
        itself never touches a description -- the DJ context contract is
        unchanged."""
        self.assertIn("def _directive_voice(ev", PUB)
        self.assertEqual(PUB.count('ev.get("description")'), 1)
        self.assertIn('ev.get("description")', _DIRECTIVE_VOICE_BODY)
        # the mirror of the backend's VOICE_LINE_RE and its bound
        self.assertIn(r'^[ \t]*voice[ \t]*:[ \t]*(?P<value>\S.*?)[ \t]*$', PUB)
        self.assertIn("_VOICE_REQUEST_MAX = 64", PUB)
        block = PUB[PUB.index("for ev in ((resp or {}).get(entity_id)"):]
        block = block[:block.index("self.status[\"calendar\"].update")]
        # read only on the directive branch, after the split
        start = block.index("_DIRECTIVE_RE.match(summary)")
        end = block.index("continue", start)
        directive = block[start:end]
        self.assertIn("voice = _directive_voice(ev)", directive)
        self.assertIn('announce[-1]["voice"] = voice', directive)
        self.assertNotIn("_directive_voice", block[end:])
        self.assertNotIn("_directive_voice", block[:start])
        # the helper itself, executed: value only, bounded, nothing else
        ns = {"re": __import__("re"), "Any": object}
        exec(PUB[PUB.index("_VOICE_LINE_RE = "):PUB.index("_ANNOUNCE_EVENT_CAP = 64")], ns)
        exec(_DIRECTIVE_VOICE_BODY, ns)
        fn = ns["_directive_voice"]
        self.assertEqual(fn({"description": "Bring the cake\nVoice:  Evening Reader \nthanks"}), "Evening Reader")
        self.assertEqual(fn({"description": "voice: custom_1"}), "custom_1")
        self.assertIsNone(fn({"description": "no directive here"}))
        self.assertIsNone(fn({"description": None}))
        self.assertIsNone(fn({}))
        self.assertIsNone(fn({"description": "voice:   "}))
        self.assertEqual(len(fn({"description": "voice: " + "x" * 500})), 64)

    def test_announce_directives_never_reach_dj_context(self):
        """A summary that begins with the word ANNOUNCE
        is an operator directive -- split out (WITH its source calendar,
        which is half its occurrence identity) and posted on its own
        route, never as a DJ 'upcoming event'."""
        block = PUB[PUB.index("for ev in ((resp or {}).get(entity_id)"):]
        block = block[:block.index("self.status[\"calendar\"].update")]
        self.assertIn("_DIRECTIVE_RE.match(summary)", block)
        self.assertIn('announce.append({"source": entity_id, "summary": summary', block)
        # the mirror stays word-bounded and case-insensitive
        self.assertIn(r'r"^\s*announce\b", re.IGNORECASE', PUB)
        # the sync carries per-source health and its own timestamp
        self.assertIn('"fetched_at": now.isoformat(), "sources": sources', PUB)
        self.assertIn("publish_announcements(observed)", PUB)

    def test_announce_publish_is_fenced_from_context(self):
        """A backend without the route (or any sync failure) degrades only
        the announcements status field -- the DJ context publish must not
        share its fate. With no calendars selected the sync states an
        explicit EMPTY selection, so deselection reaches the runtime."""
        body = PUB[PUB.index("async def _publish_announcements"):]
        self.assertIn("if self._stopped or observed is None:", body)
        self.assertIn("except (RadioServiceAuthError, RadioServiceConnectionError,", body)
        self.assertIn("except Exception as exc:  # noqa: BLE001", body)
        self.assertIn('astatus.update(ok=False', body)
        # no calendars selected -> an explicit empty selection
        block = PUB[PUB.index("if not self.calendar_entities:"):]
        block = block[:block.index("return None")]
        self.assertIn('"sources": {}', block)
        self.assertIn('"events": []', block)

    def test_announcements_client_methods(self):
        client = RadioServiceClient(None, "http://x")
        self.assertTrue(callable(client.publish_announcements))
        self.assertTrue(callable(client.announcements_status))
        import inspect
        src = inspect.getsource(type(client).publish_announcements)
        self.assertIn('"/announcements/observed"', src)
        src = inspect.getsource(type(client).announcements_status)
        self.assertIn('"/announcements/status"', src)

    def test_announcements_websocket_command(self):
        self.assertIn('"parlorwave_radio/announcements"', INIT)
        self.assertIn("announcements_status()", INIT)
        # the one integration-held fact rides along: which calendars
        self.assertIn('result["calendars"] = list(calendar.get("entities") or [])', INIT)

    def test_failures_never_raise_out_of_publish(self):
        body = PUB[PUB.index("async def async_publish"):]
        self.assertIn("except (RadioServiceAuthError, RadioServiceConnectionError, RadioServiceError)", body)
        self.assertIn("except Exception as exc:  # noqa: BLE001", body)
        self.assertIn('self.status.update(ok=False', body)

    def test_publish_tasks_are_entry_tracked_and_stop_is_final(self):
        self.assertIn("self.entry.async_create_background_task(", PUB)
        self.assertNotIn("hass.async_create_task(", PUB)
        self.assertIn("self._stopped = True", PUB[PUB.index("async def async_stop"):])
        body = PUB[PUB.index("async def async_publish"):]
        self.assertEqual(body.count("if self._stopped:\n"), 2, "checked before and after gathering")

    def test_wired_into_setup_and_unload(self):
        self.assertIn("ContextPublisher(hass, entry, client, coordinator)", INIT)
        self.assertIn("await coordinator.context_publisher.async_start()", INIT)
        self.assertIn("await publisher.async_stop()", INIT)
        self.assertIn("entry.add_update_listener(_async_options_updated)", INIT)


class OptionsFlowContracts(unittest.TestCase):
    def test_native_domain_restricted_selectors(self):
        self.assertIn('selector.EntitySelectorConfig(domain="weather")', FLOW)
        self.assertIn('selector.EntitySelectorConfig(domain="calendar", multiple=True)', FLOW)
        self.assertIn("def async_get_options_flow", FLOW)
        self.assertIn("class ParlorwaveRadioOptionsFlow(config_entries.OptionsFlow)", FLOW)
        self.assertNotIn("weather.forecast_home", FLOW + PUB + CONST)   # no household default
        self.assertNotRegex(FLOW + PUB + CONST, r"[\"']calendar\.[a-z0-9_]+[\"']",
                            "no calendar entity is baked in")

    def test_nothing_selected_is_valid(self):
        self.assertIn("vol.Optional(CONF_WEATHER_ENTITY", FLOW)
        self.assertIn("vol.Optional(CONF_CALENDAR_ENTITIES", FLOW)
        self.assertIn('"not_configured" if not self.weather_entity else None', PUB)


class ClientContract(unittest.TestCase):
    def test_publish_context_posts_the_snapshot_to_the_existing_contract(self):
        seen = {}
        client = RadioServiceClient.__new__(RadioServiceClient)

        async def fake_call(method, path, json=None):
            seen.update(method=method, path=path, json=json); return {"ok": True}
        client._call = fake_call
        snap = {"clock": {"local_iso": "2026-09-14T20:46:00-07:00"}}
        asyncio.run(RadioServiceClient.publish_context(client, snap))
        self.assertEqual(seen, {"method": "POST", "path": "/dj/context", "json": snap})



class TestCalendarCommand(unittest.TestCase):
    """Test Calendar: the diagnostic that says why calendar events are
    not reaching the breaks. Both halves of the path are reported, because
    they fail differently and were previously indistinguishable."""

    def test_the_command_is_registered_and_read_only(self):
        self.assertIn('_command("parlorwave_radio/calendar_test"', INIT)
        block = INIT[INIT.index("async def _calendar_test"):]
        block = block[:block.index('_command("parlorwave_radio/calendar_test"')]
        # It republishes (storing facts) and reads a diagnosis. It must not
        # plan, render, enqueue or touch transport.
        self.assertIn("publisher.async_publish()", block)
        self.assertIn("calendar_diagnosis()", block)
        for banned in ("break", "queue", "play", "enqueue", "speak", "render"):
            self.assertNotIn(banned, block.lower().replace("breaks simply", ""),
                             f"calendar_test reaches {banned}")

    def test_every_failure_mode_has_its_own_state(self):
        block = INIT[INIT.index("async def _calendar_test"):]
        block = block[:block.index('_command("parlorwave_radio/calendar_test"')]
        for state in ("no_calendar_selected", "calendar_unavailable",
                      "publish_failed", "backend_has_no_context", "ok"):
            self.assertIn(f'"{state}"', block,
                          f"no distinct state for {state}")

    def test_it_reports_the_publishers_own_calendar_list(self):
        """Not the config entry's copy: a diagnostic that consults a
        different list can say 'configured' about a calendar nothing is
        actually reading."""
        block = INIT[INIT.index("async def _calendar_test"):]
        block = block[:block.index('_command("parlorwave_radio/calendar_test"')]
        self.assertIn('getattr(publisher, "calendar_entities", None)', block)

    def test_the_client_method_is_a_plain_get(self):
        self.assertIn("async def calendar_diagnosis", (PKG / "api.py").read_text())
        api = (PKG / "api.py").read_text()
        block = api[api.index("async def calendar_diagnosis"):]
        self.assertIn('self._call("GET", "/dj/context/calendar")', block)


class TestWeatherCommand(unittest.TestCase):
    """The other half of the context the DJ is given, and the same
    diagnostic shape. A station that never mentions the weather looks
    identical whether no entity was chosen, the entity stopped reporting,
    the publish failed, or the reading went too old to state -- and only
    the last of those looks healthy everywhere else."""

    def block(self):
        b = INIT[INIT.index("async def _weather_test"):]
        return b[:b.index('_command("parlorwave_radio/weather_test"')]

    def code(self):
        """The block with its prose taken out. What the handler REACHES is
        a fact about its statements; the docstring above them is where it
        is allowed to say the word 'break'."""
        block = self.block()
        body = block[block.index('"""', block.index('"""') + 3) + 3:]
        return "\n".join(l for l in body.splitlines()
                          if not l.lstrip().startswith("#"))

    def test_the_command_is_registered_and_read_only(self):
        self.assertIn('_command("parlorwave_radio/weather_test"', INIT)
        block = self.block()
        self.assertIn("publisher.async_publish()", block)
        self.assertIn("weather_diagnosis()", block)
        for banned in ("break", "queue", "play", "enqueue", "speak", "render"):
            self.assertNotIn(banned, self.code().lower(),
                             f"weather_test reaches {banned}")

    def test_every_failure_mode_has_its_own_state(self):
        block = self.block()
        for state in ("no_weather_selected", "weather_unavailable",
                      "publish_failed", "backend_has_no_context", "ok"):
            self.assertIn(f'"{state}"', block, f"no distinct state for {state}")

    def test_it_reports_the_publishers_own_entity(self):
        """Not the config entry's copy: a diagnostic that consults a
        different one can say 'configured' about an entity nothing is
        actually reading."""
        self.assertIn('getattr(publisher, "weather_entity", None)', self.block())

    def test_the_client_method_is_a_plain_get(self):
        api = (PKG / "api.py").read_text()
        self.assertIn("async def weather_diagnosis", api)
        block = api[api.index("async def weather_diagnosis"):]
        self.assertIn('self._call("GET", "/dj/context/weather")', block)


class ThumbsNeverClaimARatingTheCatalogRefused(unittest.TestCase):
    """Taste learning writes a track's standing into the local Parlorwave
    catalog. With a catalog present the song playing may still not be IN
    it -- it can come from any provider Music Assistant serves -- and the
    service answers how many rows it changed. Zero rows is a rating that
    did not happen, and the panel showed a green Done for it.

    Music Assistant has nothing to fall back on: verified against 2.10.3,
    no provider it serves advertises a feedback, rating or favourite
    feature, so the honest answer is to refuse and say why."""

    def block(self):
        b = INIT[INIT.index("    def _feedback(action: str):"):]
        return b[:b.index("    hass.services.async_register(DOMAIN, SERVICE_REQUEST")]

    def test_zero_rows_changed_is_reported_as_a_refusal(self):
        block = self.block()
        self.assertIn('result.get("updated_rows") == 0', block)
        self.assertIn("HomeAssistantError", block)
        self.assertIn("nothing to rate", block)

    def test_the_refusal_names_the_song_when_it_knows_it(self):
        block = self.block()
        self.assertIn("catalog", block)
        self.assertIn("Taste learning", block)

    def test_no_music_assistant_capability_is_reached_for_instead(self):
        # The CODE, not the prose: the comment above it names the features
        # Music Assistant does not have, which is the point of it.
        code = "\n".join(l for l in self.block().splitlines()
                         if not l.lstrip().startswith("#"))
        for banned in ("library_tracks_edit", "add_to_library", "favourite",
                       "favorite", "media_player."):
            self.assertNotIn(banned, code, banned)


if __name__ == "__main__":
    unittest.main()
