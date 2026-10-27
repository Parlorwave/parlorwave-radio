"""Publishes grounded context from Home Assistant to the backend.

The Home Assistant half of context_facts: reads the selected weather
entity, sun.sun and the selected calendars through supported Home
Assistant APIs, builds the snapshot with context_facts.build_snapshot and
posts it through the integration's own client (POST /dj/context). A
fresh install needs nothing outside this integration: no separate
automation and no REST helper.

Cadence: once at start, when the selected weather entity's condition or
temperature changes, when the sun crosses the horizon, and every
REFRESH_MINUTES regardless (calendars have no state to watch; a stopped
publisher must never leave the backend with old facts -- the backend also
expires them on its side). Every failure is caught, recorded in
`coordinator.context_status`, and never blocks the DJ: no weather / no
calendar is a normal operating state.

Privacy: only the selected entities are read; only the fields the
backend contract names are sent (never descriptions, locations, GPS,
persons, presence, or any other entity's state). The one exception is
deliberate and narrow: a directive event (ANNOUNCE ...) may carry a
`voice: <name>` line in its description, and that VALUE -- one bounded
string, never the description -- rides the announcement observation.
Ordinary calendar events are never read past
summary, start and end.

Announcements: an event whose summary begins with the word ANNOUNCE is
an operator DIRECTIVE, not calendar awareness. Those
events are split out of the DJ context entirely -- the DJ must never
read a directive aloud as an "upcoming event" -- and posted separately
to /announcements/observed with their source calendar and per-source
health, which is what the backend's occurrence identity and its
"deleted by the operator vs temporarily unreadable" rule are built
from. The prefix test mirrors backend announce_copy.DIRECTIVE_RE; the
backend parser stays authoritative for everything past the prefix.

Lifecycle: state-change publishes run as background tasks tracked by the
config entry (cancelled when the entry unloads), and async_stop marks the
publisher stopped so any publish already in flight -- past its awaits --
returns without posting. Nothing can publish against an unloaded entry.
"""

from __future__ import annotations

import logging
import re
from datetime import timedelta
from typing import Any

from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers.event import (async_track_state_change_event,
                                         async_track_time_interval)
from homeassistant.util import dt as dt_util

from . import context_facts
from .api import RadioServiceAuthError, RadioServiceConnectionError, RadioServiceError
from .const import (CALENDAR_HORIZON_HOURS, CONF_CALENDAR_ENTITIES,
                    CONF_WEATHER_ENTITY, CONTEXT_REFRESH_MINUTES, SUN_ENTITY)

_LOGGER = logging.getLogger(__name__)

#: Mirror of backend announce_copy.DIRECTIVE_RE -- the cheap routing test
#: only. Word-bounded: "Announcements committee" stays ordinary calendar.
_DIRECTIVE_RE = re.compile(r"^\s*announce\b", re.IGNORECASE)
#: Mirror of backend announce_copy.VOICE_LINE_RE: the one line of a
#: DIRECTIVE event's description that names the voice to read it with.
#: Only the value is sent; the backend decides what (if anything) it names.
_VOICE_LINE_RE = re.compile(r"^[ \t]*voice[ \t]*:[ \t]*(?P<value>\S.*?)[ \t]*$",
                            re.IGNORECASE | re.MULTILINE)
#: Mirror of backend announce_copy.MAX_VOICE_REQUEST_CHARS.
_VOICE_REQUEST_MAX = 64

#: The backend accepts at most this many directive events per sync
#: (announcements.SYNC_EVENT_CAP); soonest starts win.
_ANNOUNCE_EVENT_CAP = 64


def _directive_voice(ev: dict[str, Any]) -> str | None:
    """The `voice:` value of a DIRECTIVE event's description, bounded, or
    None. Called for directive events only: this is the sole place the
    integration looks at a description, and nothing of it but this one
    value ever leaves Home Assistant."""
    text = ev.get("description")
    if not isinstance(text, str):
        return None
    m = _VOICE_LINE_RE.search(text)
    if not m:
        return None
    value = " ".join(m.group("value").split())
    return value[:_VOICE_REQUEST_MAX] or None


class ContextPublisher:
    def __init__(self, hass: HomeAssistant, entry, client, coordinator) -> None:
        self.hass = hass
        self.entry = entry
        self.client = client
        self.coordinator = coordinator
        self.weather_entity: str | None = entry.options.get(CONF_WEATHER_ENTITY) or None
        self.calendar_entities: list[str] = list(entry.options.get(CONF_CALENDAR_ENTITIES) or [])
        self._unsubs: list = []
        self._stopped = False
        self.status: dict[str, Any] = {
            "published_at": None, "ok": None, "error": None,
            "weather": {"entity": self.weather_entity,
                        "state": "not_configured" if not self.weather_entity else None},
            "calendar": {"entities": list(self.calendar_entities),
                         "healthy": 0, "failed": [], "events": 0},
            "announcements": {"observed": 0, "published_at": None,
                              "ok": None, "error": None},
            "sun": {"available": None},
        }
        self._observed_announcements: dict[str, Any] | None = None
        coordinator.context_status = self.status

    # --- lifecycle --------------------------------------------------------
    async def async_start(self) -> None:
        watched = [SUN_ENTITY] + ([self.weather_entity] if self.weather_entity else [])
        self._unsubs.append(async_track_state_change_event(
            self.hass, watched, self._on_state_change))
        self._unsubs.append(async_track_time_interval(
            self.hass, self._on_interval, timedelta(minutes=CONTEXT_REFRESH_MINUTES)))
        await self.async_publish()

    async def async_stop(self) -> None:
        self._stopped = True
        for unsub in self._unsubs:
            unsub()
        self._unsubs.clear()

    @property
    def stopped(self) -> bool:
        return self._stopped

    @callback
    def _on_state_change(self, event: Event) -> None:
        old, new = event.data.get("old_state"), event.data.get("new_state")
        if new is None:
            changed = True                      # entity removed: republish without it
        elif old is None:
            changed = True
        elif new.entity_id == SUN_ENTITY:
            changed = old.state != new.state    # horizon crossings only
        else:
            changed = (old.state != new.state
                       or old.attributes.get("temperature") != new.attributes.get("temperature"))
        if changed and not self._stopped:
            # entry-tracked: cancelled with the entry, never orphaned
            self.entry.async_create_background_task(
                self.hass, self.async_publish(), "parlorwave_radio context publish")

    async def _on_interval(self, _now) -> None:
        await self.async_publish()

    # --- gathering --------------------------------------------------------
    def _state_dict(self, entity_id: str) -> dict[str, Any] | None:
        st = self.hass.states.get(entity_id)
        if st is None:
            return None
        return {"state": st.state, "attributes": dict(st.attributes)}

    async def _forecast(self, kind: str) -> list[dict[str, Any]] | None:
        """weather.get_forecasts (supported, response-returning); None on
        any failure -- a missing forecast only removes the high/low."""
        try:
            resp = await self.hass.services.async_call(
                "weather", "get_forecasts", {"type": kind},
                target={"entity_id": self.weather_entity},
                blocking=True, return_response=True)
            return list(((resp or {}).get(self.weather_entity) or {}).get("forecast") or [])
        except Exception as exc:  # noqa: BLE001 - optional detail
            _LOGGER.debug("%s forecast unavailable for %s: %s", kind, self.weather_entity, exc)
            return None

    async def _calendar_events(self) -> list[dict[str, Any]] | None:
        """calendar.get_events for every selected calendar over the horizon
        (supported, response-returning). Per-calendar failures are recorded
        and skipped; None when no calendar is selected.

        The announcement observation always states the SELECTION: every
        selected calendar is in `sources` (healthy or failed), so the
        runtime can tell a deselected calendar -- whose pending
        announcements must not air -- from one that is merely unreadable.
        With none selected that is an explicit empty selection,
        never silence."""
        if not self.calendar_entities:
            self._observed_announcements = {
                "fetched_at": dt_util.now().isoformat(), "sources": {},
                "events": []}
            self.status["announcements"]["observed"] = 0
            return None
        now = dt_util.now()
        events: list[dict[str, Any]] = []
        announce: list[dict[str, Any]] = []
        sources: dict[str, str] = {}
        healthy, failed = 0, []
        for entity_id in self.calendar_entities:
            st = self.hass.states.get(entity_id)
            if st is None or st.state in ("unavailable", "unknown"):
                failed.append(entity_id)
                sources[entity_id] = "failed"
                continue
            try:
                resp = await self.hass.services.async_call(
                    "calendar", "get_events",
                    {"start_date_time": now.isoformat(),
                     "end_date_time": (now + timedelta(hours=CALENDAR_HORIZON_HOURS)).isoformat()},
                    target={"entity_id": entity_id}, blocking=True, return_response=True)
            except Exception as exc:  # noqa: BLE001 - one calendar, not the publish
                _LOGGER.debug("calendar %s query failed: %s", entity_id, exc)
                failed.append(entity_id)
                sources[entity_id] = "failed"
                continue
            healthy += 1
            sources[entity_id] = "healthy"
            for ev in ((resp or {}).get(entity_id) or {}).get("events") or []:
                if not isinstance(ev, dict):
                    continue
                summary = ev.get("summary")
                if isinstance(summary, str) and _DIRECTIVE_RE.match(summary):
                    # An operator directive, never DJ context. The source
                    # calendar travels with it: it IS the occurrence
                    # identity's strongest half.
                    announce.append({"source": entity_id, "summary": summary,
                                     "start": ev.get("start"),
                                     "end": ev.get("end")})
                    voice = _directive_voice(ev)
                    if voice:
                        announce[-1]["voice"] = voice
                    continue
                # ONLY these fields ever leave the calendar
                events.append({"summary": summary, "start": ev.get("start"),
                               "end": ev.get("end")})
        self.status["calendar"].update(healthy=healthy, failed=failed)
        announce.sort(key=lambda ev: str(ev.get("start") or ""))
        self._observed_announcements = {
            "fetched_at": now.isoformat(), "sources": sources,
            "events": announce[:_ANNOUNCE_EVENT_CAP]}
        self.status["announcements"]["observed"] = len(announce)
        return events

    async def build(self) -> dict[str, Any]:
        now = dt_util.now()
        weather = self._state_dict(self.weather_entity) if self.weather_entity else None
        daily = hourly = None
        if weather and weather["state"] not in context_facts.UNAVAILABLE_STATES:
            daily = await self._forecast("daily")
            hourly = await self._forecast("hourly")
            self.status["weather"]["state"] = "healthy"
        elif self.weather_entity:
            self.status["weather"]["state"] = "unavailable"
        sun = self._state_dict(SUN_ENTITY)
        self.status["sun"]["available"] = bool(sun and sun["state"] not in context_facts.UNAVAILABLE_STATES)
        events = await self._calendar_events()
        snap = context_facts.build_snapshot(
            now=now, timezone=self.hass.config.time_zone, sun=sun, weather=weather,
            daily_forecast=daily, hourly_forecast=hourly, calendar_events=events)
        self.status["calendar"]["events"] = len((snap.get("calendar") or {}).get("events") or [])
        return snap

    # --- publishing -------------------------------------------------------
    async def async_publish(self) -> None:
        """Gather and post. Never raises; the outcome lives in status. A
        stopped publisher posts nothing -- checked before gathering and
        again after it, because gathering awaits and unload may land in
        between."""
        if self._stopped:
            return
        try:
            snap = await self.build()
            if self._stopped:
                return
            await self.client.publish_context(snap)
            self.status.update(ok=True, error=None, published_at=dt_util.now().isoformat())
        except (RadioServiceAuthError, RadioServiceConnectionError, RadioServiceError) as exc:
            self.status.update(ok=False, error=f"{type(exc).__name__}: {exc}"[:200])
            _LOGGER.warning("context publish failed: %s", exc)
        except Exception as exc:  # noqa: BLE001 - never take the integration down
            self.status.update(ok=False, error=f"{type(exc).__name__}: {exc}"[:200])
            _LOGGER.warning("context publish failed unexpectedly", exc_info=True)
        await self._publish_announcements()

    async def _publish_announcements(self) -> None:
        """The announcement observation sync, fenced separately from the
        context publish: a backend without the route (an older build) or
        a failed sync degrades ONLY the announcements status field, never
        the DJ's context. With no calendar selected the sync is an explicit
        empty selection: the runtime withdraws what it was holding for the
        deselected calendars (never deletes it) -- an empty selection is
        not an observation that every event disappeared."""
        observed = self._observed_announcements
        if self._stopped or observed is None:
            return
        astatus = self.status.setdefault(
            "announcements", {"observed": 0, "published_at": None,
                              "ok": None, "error": None})
        try:
            await self.client.publish_announcements(observed)
            astatus.update(ok=True, error=None,
                           published_at=dt_util.now().isoformat())
        except (RadioServiceAuthError, RadioServiceConnectionError,
                RadioServiceError) as exc:
            astatus.update(ok=False, error=f"{type(exc).__name__}: {exc}"[:200])
            _LOGGER.debug("announcement publish failed: %s", exc)
        except Exception as exc:  # noqa: BLE001 - never take the integration down
            astatus.update(ok=False, error=f"{type(exc).__name__}: {exc}"[:200])
            _LOGGER.warning("announcement publish failed unexpectedly",
                            exc_info=True)
