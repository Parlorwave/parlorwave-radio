"""Grounded context facts from Home Assistant state -- the pure half.

Parlorwave Radio owns the grounded context; Home Assistant is a FACT
SOURCE. This module turns already-read Home Assistant state (plain dicts,
never live objects) into exactly the snapshot the backend's
`POST /dj/context` contract accepts:

    clock     local_iso, timezone, sun_up, next_rising, next_setting
    weather   condition, temperature, observed_at, forecast_high,
              forecast_low, hourly[time, temperature, condition] (<= 36)
    calendar  events[summary, start, end] (<= 8), fetched_at

That is the whole contract; nothing more
is added. In particular NO description, location, attendees, GPS, person
or presence data, and never a news section (bulletins are backend-owned).

Pure: no Home Assistant imports, no I/O, no clock of its own (`now` is
supplied), so every rule is testable anywhere.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

UNAVAILABLE_STATES = ("unknown", "unavailable", "none", "")
MAX_HOURLY = 36
MAX_EVENTS = 8
MAX_SUMMARY = 200
TEMP_RANGE = (-100.0, 150.0)


def _num(value: Any) -> float | None:
    """A plausible temperature as float, else None (never a bool, never a
    string the provider forgot to convert)."""
    if isinstance(value, bool):
        return None
    if not isinstance(value, (int, float)):
        try:
            value = float(value)
        except (TypeError, ValueError):
            return None
    value = float(value)
    return value if TEMP_RANGE[0] <= value <= TEMP_RANGE[1] else None


def _aware_iso(value: Any) -> str | None:
    """An ISO timestamp string that parses timezone-aware, else None."""
    if isinstance(value, datetime):
        return value.isoformat() if value.tzinfo else None
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return value if parsed.tzinfo else None


def _any_iso(value: Any) -> str | None:
    """A date or datetime ISO string (calendar starts may be date-only for
    all-day events; the backend treats those as out of scope itself)."""
    if isinstance(value, datetime):
        return value.isoformat()
    if not isinstance(value, str) or not value:
        return None
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return value


def clock_section(now: datetime, timezone: str | None,
                  sun: dict[str, Any] | None) -> dict[str, Any]:
    """The station clock, plus sun facts when sun.sun is usable."""
    clock: dict[str, Any] = {"local_iso": now.isoformat()}
    if timezone:
        clock["timezone"] = str(timezone)[:64]
    state = (sun or {}).get("state")
    if sun and state not in UNAVAILABLE_STATES:
        clock["sun_up"] = state == "above_horizon"
        attrs = sun.get("attributes") or {}
        for key in ("next_rising", "next_setting"):
            iso = _aware_iso(attrs.get(key))
            if iso:
                clock[key] = iso
    return clock


def weather_section(now: datetime, weather: dict[str, Any] | None,
                    daily_forecast: list[dict[str, Any]] | None = None,
                    hourly_forecast: list[dict[str, Any]] | None = None
                    ) -> dict[str, Any] | None:
    """The weather facts, or None when no usable weather entity is given."""
    if not weather:
        return None
    state = weather.get("state")
    if not isinstance(state, str) or state in UNAVAILABLE_STATES:
        return None
    out: dict[str, Any] = {"condition": state[:60], "observed_at": now.isoformat()}
    temp = _num((weather.get("attributes") or {}).get("temperature"))
    if temp is not None:
        out["temperature"] = temp
    if daily_forecast:
        today = daily_forecast[0] if isinstance(daily_forecast[0], dict) else {}
        high, low = _num(today.get("temperature")), _num(today.get("templow"))
        if high is not None:
            out["forecast_high"] = high
        if low is not None:
            out["forecast_low"] = low
    rows = []
    for row in (hourly_forecast or [])[:MAX_HOURLY]:
        if not isinstance(row, dict):
            continue
        when, temp = _aware_iso(row.get("datetime")), _num(row.get("temperature"))
        if when is None or temp is None:
            continue
        entry = {"time": when, "temperature": temp}
        cond = row.get("condition")
        if isinstance(cond, str) and cond:
            entry["condition"] = cond[:60]
        rows.append(entry)
    if rows:
        out["hourly"] = rows
    return out


def calendar_section(now: datetime, events: list[dict[str, Any]] | None
                     ) -> dict[str, Any] | None:
    """Upcoming events as summary/start/end only, soonest first, at most
    MAX_EVENTS; events already over are dropped. None when no calendar is
    selected (events is None)."""
    if events is None:
        return None
    kept = []
    for ev in events:
        if not isinstance(ev, dict):
            continue
        summary = ev.get("summary")
        if not isinstance(summary, str) or not summary.strip():
            continue
        start = _any_iso(ev.get("start"))
        if start is None:
            continue
        entry: dict[str, Any] = {"summary": summary.strip()[:MAX_SUMMARY], "start": start}
        end = _any_iso(ev.get("end"))
        if end:
            try:
                end_dt = datetime.fromisoformat(end.replace("Z", "+00:00"))
                if end_dt.tzinfo and end_dt < now:
                    continue                    # already over
            except ValueError:
                pass
            entry["end"] = end
        kept.append(entry)
    kept.sort(key=lambda e: _chron(e["start"], now))
    return {"events": kept[:MAX_EVENTS], "fetched_at": now.isoformat()}


def _chron(start: str, now: datetime) -> datetime:
    """A comparable instant for sorting, across the three shapes one
    calendar can return at once: date-only (all-day), and datetimes in
    DIFFERENT UTC offsets -- one calendar can hold entries in different
    offsets (an event created while travelling, a shared calendar).
    Sorting the raw ISO STRINGS put a later instant first whenever the
    offsets differed, which mattered little at a six-hour horizon and
    matters at thirty-six, because the wrong events would be the ones
    kept by the MAX_EVENTS cap.

    All-day entries sort at midnight in the station's own zone -- the same
    date the backend announces them against."""
    try:
        dt = datetime.fromisoformat(start.replace("Z", "+00:00"))
    except ValueError:
        return now
    if dt.tzinfo is None:                 # date-only, or a naive datetime
        dt = dt.replace(tzinfo=now.tzinfo)
    return dt


def build_snapshot(*, now: datetime, timezone: str | None,
                   sun: dict[str, Any] | None = None,
                   weather: dict[str, Any] | None = None,
                   daily_forecast: list[dict[str, Any]] | None = None,
                   hourly_forecast: list[dict[str, Any]] | None = None,
                   calendar_events: list[dict[str, Any]] | None = None
                   ) -> dict[str, Any]:
    """The whole /dj/context payload from already-read state. `now` must
    be timezone-aware (the station clock is only meaningful with one)."""
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    snap: dict[str, Any] = {"clock": clock_section(now, timezone, sun)}
    w = weather_section(now, weather, daily_forecast, hourly_forecast)
    if w:
        snap["weather"] = w
    c = calendar_section(now, calendar_events)
    if c is not None:
        snap["calendar"] = c
    return snap
