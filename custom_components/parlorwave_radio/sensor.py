"""Sensors: station identity, and honest DJ/break state.

Only claims the backend actually makes. The station sensor's state is the
seed the listener started from; the DJ status sensor's state is the DJ
engine's own status word, with the last spoken break and the next planned
air time as attributes when -- and only when -- the engine reports them."""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorEntity

from .entity import ParlorwaveRadioEntity
from .recorder import VOLATILE_ATTRIBUTES


async def async_setup_entry(hass, entry, async_add_entities):
    coordinator = hass.data["parlorwave_radio"][entry.entry_id]
    async_add_entities([StationSensor(coordinator, entry.entry_id),
                        DjStatusSensor(coordinator, entry.entry_id),
                        NowPlayingSensor(coordinator, entry.entry_id)])


class StationSensor(ParlorwaveRadioEntity, SensorEntity):
    _attr_name = "Station"
    _attr_icon = "mdi:radio"

    def __init__(self, coordinator, entry_id: str) -> None:
        super().__init__(coordinator, entry_id, "station")

    @property
    def native_value(self) -> str | None:
        station = self.coordinator.station(self.coordinator.data)
        if not station:
            return "none"
        return station.get("seed") or station.get("station_id", "")[:8]

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        station = self.coordinator.station(self.coordinator.data) or {}
        if not station:
            return {}
        return {
            "station_id": station.get("station_id"),
            "queue_id": station.get("queue_id"),
            "started": station.get("activated_at"),
            "refill_count": station.get("refill_count"),
            "last_replenished_at": station.get("last_replenished_at"),
            "tracks_generated": station.get("generated_count"),
        }


class DjStatusSensor(ParlorwaveRadioEntity, SensorEntity):
    _attr_name = "DJ status"
    _attr_icon = "mdi:account-voice"
    #: The countdown and the diagnostics are live state, not history --
    #: recorder.py says why. This is the attribute Home Assistant reads.
    _unrecorded_attributes = VOLATILE_ATTRIBUTES

    def __init__(self, coordinator, entry_id: str) -> None:
        super().__init__(coordinator, entry_id, "dj_status")

    @property
    def native_value(self) -> str | None:
        dj = (self.coordinator.data.get("dj_status") or {}).get("dj") or {}
        return dj.get("status")

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        dj = (self.coordinator.data.get("dj_status") or {}).get("dj") or {}
        last = dj.get("last_break") or {}
        current = dj.get("current_break")
        current = current if isinstance(current, dict) else {}
        # A break that is AUDIBLE right now, described in its own words
        # rather than the previous one's. If the only script published
        # were the last COMPLETED one, the panel would show the previous
        # break's script while a newer break is playing; these attributes
        # exist so On Air can say what is actually on air.
        on_air = current if current.get("on_air") else {}
        return {
            "enabled": dj.get("enabled"),
            "speech_enabled": dj.get("speech_enabled"),
            "next_break_at": dj.get("target_air_at"),
            "seconds_to_air": dj.get("estimated_seconds_to_air"),
            "current_break": current.get("state") or None,
            "on_air_break": bool(on_air),
            "on_air_break_at": on_air.get("air_start"),
            # A one-way public ref, the same one the program history gives
            # the break -- never the token.
            "on_air_break_id": on_air.get("id"),
            "on_air_break_kind": on_air.get("kind"),
            "on_air_break_topics": on_air.get("topics"),
            "on_air_break_personality": on_air.get("personality"),
            "on_air_break_voice": on_air.get("voice"),
            "on_air_break_voice_provider": on_air.get("voice_provider"),
            "on_air_spoken": (on_air.get("spoken_text") or "")[:500] or None,
            "last_break_at": last.get("air_start"),
            "last_break_id": last.get("id"),
            "last_break_kind": last.get("kind"),
            "last_break_topics": last.get("topics"),
            "last_break_personality": last.get("personality"),
            "last_break_voice": last.get("voice"),
            "last_break_voice_provider": last.get("voice_provider"),
            "last_spoken": (last.get("spoken_text") or "")[:500] or None,
            # what the integration is publishing for the DJ's grounded facts
            "context": self._context_summary(),
            # the allow-list, the observer, and the backend's own diagnosis:
            # a UI can say plainly why no break is coming
            "outputs_enabled": self.coordinator.enabled_outputs(self.coordinator.data),
            "observer": self.coordinator.observer(self.coordinator.data),
            "problems": self.coordinator.problems(self.coordinator.data),
            # what the Settings verdict depends on (coordinator.readiness_key):
            # the panel re-reads readiness when it changes, not only on a timer
            "readiness_key": self.coordinator.data.get("readiness_key"),
            # Whether the optional autonomous-programming features have a
            # local catalog to work from. Published beside the observer and
            # the allow-list because it belongs to the same question -- what
            # can this station honestly offer -- and because the panel must
            # never answer it by guessing.
            "catalog": self.coordinator.music_catalog(self.coordinator.data),
            "station_name": self.coordinator.station_name(self.coordinator.data),
        }

    def _context_summary(self) -> dict[str, Any]:
        st = getattr(self.coordinator, "context_status", None) or {}
        weather, cal = st.get("weather") or {}, st.get("calendar") or {}
        return {"published_at": st.get("published_at"), "ok": st.get("ok"),
                "error": st.get("error"),
                "weather": weather.get("state") or "not_configured",
                "weather_entity": weather.get("entity"),
                "calendars_selected": len(cal.get("entities") or []),
                "calendars_healthy": cal.get("healthy"),
                "calendars_failed": cal.get("failed"),
                "upcoming_events": cal.get("events"),
                "sun": (st.get("sun") or {}).get("available")}

class NowPlayingSensor(ParlorwaveRadioEntity, SensorEntity):
    """The Booth's Now Playing card data -- artwork URL, program kind
    (music / dj / news), album, and the elapsed-time basis the panel's
    local progress bar advances from. Small, bounded attributes only:
    lyrics and the queue deliberately live behind on-demand websocket
    commands, never in entity state.

    `lifecycle` travels with `kind`: for a dj/news item it is the
    backend's own word for what that item is to a listener right now --
    upcoming, airing, spent or unknown -- so the panel can tell a break
    that is speaking from a spent one the queue rewound onto, without
    inferring either from the route, the title or the DJ switch."""

    _attr_name = "Now Playing"
    _attr_icon = "mdi:album"
    #: `elapsed` / `elapsed_at` advance on every poll while music plays.
    _unrecorded_attributes = VOLATILE_ATTRIBUTES

    def __init__(self, coordinator, entry_id: str) -> None:
        super().__init__(coordinator, entry_id, "now_playing")

    @property
    def native_value(self):
        card = self.coordinator.data.get("now_card") or {}
        return card.get("state") or "idle"

    @property
    def extra_state_attributes(self):
        card = self.coordinator.data.get("now_card") or {}
        keys = ("kind", "lifecycle", "title", "artist", "album", "duration",
                "uri", "art_url", "elapsed", "elapsed_at", "state",
                "queue_item_id")
        return {k: card.get(k) for k in keys if card.get(k) is not None}

