"""context_facts: Home Assistant state -> the backend's /dj/context snapshot.
Pure module, pure tests; the shapes here are the ones Home Assistant's
weather/sun/calendar entities and response services actually produce."""

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "custom_components" / "parlorwave_radio"))
import context_facts as CF  # noqa: E402

TZ = timezone(timedelta(hours=-7))
NOW = datetime(2026, 9, 14, 20, 46, 0, tzinfo=TZ)
SUN = {"state": "above_horizon", "attributes": {
    "next_rising": "2026-09-15T06:52:00+00:00", "next_setting": "2026-09-15T00:14:00+00:00",
    "elevation": 12.3, "azimuth": 260.0, "rising": False}}
WEATHER = {"state": "partlycloudy", "attributes": {
    "temperature": 67.4, "temperature_unit": "°F", "humidity": 55, "pressure": 1012,
    "wind_speed": 4.1, "friendly_name": "Forecast Home"}}
DAILY = [{"datetime": "2026-09-14T07:00:00+00:00", "condition": "sunny", "temperature": 74.0, "templow": 52.0,
          "humidity": 40, "uv_index": 5}]
HOURLY = [{"datetime": (NOW + timedelta(hours=i)).isoformat(), "temperature": 67.0 - i, "condition": "clear"}
          for i in range(40)]
EVENTS = [{"summary": "Dentist", "start": "2026-09-14T21:30:00-07:00", "end": "2026-09-14T22:00:00-07:00",
           "description": "PRIVATE NOTES", "location": "123 Private St"},
          {"summary": "Trash night", "start": "2026-09-15", "end": "2026-09-16", "description": "x"}]


class Clock(unittest.TestCase):
    def test_clock_with_sun(self):
        c = CF.clock_section(NOW, "America/Los_Angeles", SUN)
        self.assertEqual(c, {"local_iso": NOW.isoformat(), "timezone": "America/Los_Angeles", "sun_up": True,
                             "next_rising": "2026-09-15T06:52:00+00:00", "next_setting": "2026-09-15T00:14:00+00:00"})

    def test_sun_unavailable_or_missing_keeps_the_clock(self):
        self.assertEqual(CF.clock_section(NOW, "UTC", None), {"local_iso": NOW.isoformat(), "timezone": "UTC"})
        self.assertEqual(CF.clock_section(NOW, "UTC", {"state": "unavailable", "attributes": {}}),
                         {"local_iso": NOW.isoformat(), "timezone": "UTC"})

    def test_day_night_transition(self):
        night = {**SUN, "state": "below_horizon"}
        self.assertFalse(CF.clock_section(NOW, "UTC", night)["sun_up"])
        self.assertTrue(CF.clock_section(NOW, "UTC", SUN)["sun_up"])

    def test_naive_sun_times_are_dropped(self):
        bad = {"state": "above_horizon", "attributes": {"next_rising": "2026-09-15T06:52:00", "next_setting": 5}}
        c = CF.clock_section(NOW, "UTC", bad)
        self.assertNotIn("next_rising", c); self.assertNotIn("next_setting", c)

    def test_naive_now_is_refused(self):
        with self.assertRaises(ValueError):
            CF.build_snapshot(now=datetime(2026, 9, 14, 20, 0), timezone="UTC")


class Weather(unittest.TestCase):
    def test_no_weather_entity_selected(self):
        self.assertIsNone(CF.weather_section(NOW, None))
        self.assertNotIn("weather", CF.build_snapshot(now=NOW, timezone="UTC"))

    def test_healthy_weather_with_temperature_and_condition(self):
        w = CF.weather_section(NOW, WEATHER)
        self.assertEqual(w, {"condition": "partlycloudy", "observed_at": NOW.isoformat(), "temperature": 67.4})

    def test_unavailable_weather_is_absent(self):
        for state in ("unavailable", "unknown", "", None):
            self.assertIsNone(CF.weather_section(NOW, {"state": state, "attributes": {"temperature": 60}}), state)

    def test_malformed_or_missing_attributes(self):
        self.assertEqual(CF.weather_section(NOW, {"state": "rainy", "attributes": {}}),
                         {"condition": "rainy", "observed_at": NOW.isoformat()})
        for bad in ("hot", None, True, 999, -300):
            w = CF.weather_section(NOW, {"state": "rainy", "attributes": {"temperature": bad}})
            self.assertNotIn("temperature", w, bad)
        w = CF.weather_section(NOW, {"state": "rainy", "attributes": {"temperature": "71.5"}})
        self.assertEqual(w["temperature"], 71.5)

    def test_forecast_high_low_and_bounded_hourly(self):
        w = CF.weather_section(NOW, WEATHER, DAILY, HOURLY)
        self.assertEqual((w["forecast_high"], w["forecast_low"]), (74.0, 52.0))
        self.assertEqual(len(w["hourly"]), CF.MAX_HOURLY)
        self.assertEqual(w["hourly"][0], {"time": HOURLY[0]["datetime"], "temperature": 67.0, "condition": "clear"})
        # a malformed forecast only removes the optional detail
        w = CF.weather_section(NOW, WEATHER, [{"temperature": "n/a"}], [{"datetime": "nope", "temperature": 1}, 5])
        self.assertNotIn("forecast_high", w); self.assertNotIn("hourly", w)
        self.assertEqual(w["condition"], "partlycloudy")

    def test_only_contract_fields_are_sent(self):
        w = CF.weather_section(NOW, WEATHER, DAILY, HOURLY)
        self.assertEqual(set(w), {"condition", "observed_at", "temperature", "forecast_high", "forecast_low", "hourly"})
        self.assertEqual(set(w["hourly"][0]), {"time", "temperature", "condition"})


class Calendar(unittest.TestCase):
    def test_no_calendar_selected(self):
        self.assertIsNone(CF.calendar_section(NOW, None))
        self.assertNotIn("calendar", CF.build_snapshot(now=NOW, timezone="UTC"))

    def test_no_upcoming_events_is_an_empty_list(self):
        self.assertEqual(CF.calendar_section(NOW, []), {"events": [], "fetched_at": NOW.isoformat()})

    def test_next_event_keeps_only_summary_start_end(self):
        c = CF.calendar_section(NOW, EVENTS)
        self.assertEqual(c["events"][0], {"summary": "Dentist", "start": "2026-09-14T21:30:00-07:00",
                                          "end": "2026-09-14T22:00:00-07:00"})
        for ev in c["events"]:
            self.assertEqual(set(ev) - {"end"}, {"summary", "start"})
            self.assertNotIn("description", ev); self.assertNotIn("location", ev)

    def test_all_day_event_passes_as_a_date(self):
        c = CF.calendar_section(NOW, EVENTS)
        self.assertEqual(c["events"][1], {"summary": "Trash night", "start": "2026-09-15", "end": "2026-09-16"})

    def test_multiple_calendars_merge_sorted_and_capped(self):
        many = [{"summary": f"E{i}", "start": (NOW + timedelta(minutes=30 * (12 - i))).isoformat()} for i in range(12)]
        c = CF.calendar_section(NOW, many)
        self.assertEqual(len(c["events"]), CF.MAX_EVENTS)
        starts = [e["start"] for e in c["events"]]
        self.assertEqual(starts, sorted(starts))

    def test_finished_events_and_junk_are_dropped(self):
        events = [{"summary": "Over", "start": (NOW - timedelta(hours=2)).isoformat(), "end": (NOW - timedelta(hours=1)).isoformat()},
                  {"summary": "", "start": NOW.isoformat()}, {"summary": "No start"}, "junk",
                  {"summary": "Ongoing", "start": (NOW - timedelta(minutes=10)).isoformat(), "end": (NOW + timedelta(minutes=50)).isoformat()}]
        c = CF.calendar_section(NOW, events)
        self.assertEqual([e["summary"] for e in c["events"]], ["Ongoing"])

    def test_rollover_the_next_event_is_first(self):
        events = [{"summary": "Later", "start": (NOW + timedelta(hours=3)).isoformat()},
                  {"summary": "Soon", "start": (NOW + timedelta(minutes=40)).isoformat()}]
        self.assertEqual(CF.calendar_section(NOW, events)["events"][0]["summary"], "Soon")


class WholeSnapshot(unittest.TestCase):
    def test_matches_the_contract_the_backend_validates(self):
        snap = CF.build_snapshot(now=NOW, timezone="America/Los_Angeles", sun=SUN, weather=WEATHER,
                                 daily_forecast=DAILY, hourly_forecast=HOURLY, calendar_events=EVENTS)
        self.assertEqual(set(snap), {"clock", "weather", "calendar"})
        self.assertNotIn("news", snap)
        self.assertEqual(set(snap["clock"]), {"local_iso", "timezone", "sun_up", "next_rising", "next_setting"})

    def test_nothing_selected_is_a_valid_clock_only_snapshot(self):
        snap = CF.build_snapshot(now=NOW, timezone="UTC")
        self.assertEqual(snap, {"clock": {"local_iso": NOW.isoformat(), "timezone": "UTC"}})



class CalendarHorizonAndOrder(unittest.TestCase):
    """The two things that decide WHICH events survive to the backend: how
    far ahead they are read, and the order the MAX_EVENTS cap applies to."""

    def test_the_horizon_reaches_tomorrow_from_any_hour(self):
        """An all-day event is announced on its own day or the day before,
        so at nine in the morning tomorrow's entry is 15 hours out. The old
        six-hour horizon could not see it, and widening the backend's
        eligibility alone would therefore have changed nothing."""
        import const
        self.assertGreaterEqual(const.CALENDAR_HORIZON_HOURS, 30)

    def test_mixed_offsets_and_all_day_entries_sort_chronologically(self):
        """One calendar can carry two UTC offsets at once.
        Sorting the raw ISO strings put a later instant first whenever they
        differed -- which decides who survives the cap at a wide horizon."""
        events = [
            # 12:00 at -07:00 is 19:00 UTC ...
            {"summary": "Pacific", "start": "2026-09-14T12:00:00-07:00"},
            # ... and 12:00 at -04:00 is 16:00 UTC: the same wall clock, earlier
            {"summary": "Eastern", "start": "2026-09-14T12:00:00-04:00"},
            {"summary": "All day", "start": "2026-09-14", "end": "2026-09-15"},
        ]
        got = [e["summary"] for e in CF.calendar_section(
            datetime(2026, 9, 14, 6, 0, tzinfo=TZ), events)["events"]]
        self.assertEqual(got, ["All day", "Eastern", "Pacific"])

    def test_the_cap_keeps_the_soonest_events(self):
        far = [{"summary": f"Far {i}",
                "start": f"2026-09-2{i}T10:00:00-07:00"} for i in range(9)]
        near = {"summary": "Soon", "start": "2026-09-14T21:00:00-07:00"}
        kept = CF.calendar_section(NOW, far + [near])["events"]
        self.assertEqual(len(kept), CF.MAX_EVENTS)
        self.assertEqual(kept[0]["summary"], "Soon")

    def test_an_unreadable_start_does_not_break_the_sort(self):
        events = [{"summary": "Bad", "start": "not-a-date"},
                  {"summary": "Good", "start": "2026-09-14T21:00:00-07:00"}]
        kept = CF.calendar_section(NOW, events)["events"]
        self.assertEqual([e["summary"] for e in kept], ["Good"])

if __name__ == "__main__":
    unittest.main()
