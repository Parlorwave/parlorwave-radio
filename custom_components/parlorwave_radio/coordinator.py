"""One shared snapshot of the Parlorwave Radio service, on one clock.

Every entity and the panel read from this coordinator; nothing else in the
integration polls. The snapshot is a plain dict of the public surfaces so
entities stay dumb: {"dj_status", "dj_settings", "playback_settings",
"outputs", "now_playing"}. Partial failure of a secondary surface (outputs,
now-playing) degrades that key to None instead of marking the whole
integration unavailable -- but a dead backend marks everything unavailable
honestly via UpdateFailed.

Studio adds two more keys: "station_settings" (polled with the rest) and
"studio_catalog" (the friendly option lists, refreshed every few minutes
and otherwise carried forward, so a hiccup on the voice list never blanks
the selectors that were fine a moment ago).

Two things on this clock are deliberately NOT fixed intervals, because the
facts they describe do not move at a fixed rate:

  * the cadence itself (`scan_interval_for`). A finite break lasts seconds,
    so while one is imminent or airing the coordinator asks every couple of
    seconds and returns to the ordinary ten the moment it is over -- the
    difference between a dashboard that says `on_air` while the break is on
    the air and one that says it ten seconds after the music came back.
  * the voice shelf (`_voice_library_snapshot`). Its five-minute TTL is
    right for names and slots and far too slow for whether a provider is
    answering, so freshness is ALSO keyed on Home Assistant's own verdict
    about the tts.* entities the shelf names -- read locally, free, every
    cycle. A provider that blinks out and comes back is seen at once
    without polling the service any harder.
"""

from __future__ import annotations

import logging
import time
from datetime import timedelta
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import (DataUpdateCoordinator,
                                                      UpdateFailed)

from .api import (RadioServiceAuthError, RadioServiceClient,
                  RadioServiceConnectionError, RadioServiceError)
from .const import (BREAK_WINDOW_SCAN_INTERVAL_S, BREAK_WINDOW_STATUSES,
                    DEFAULT_SCAN_INTERVAL_S, DOMAIN, HA_VOICE_PREFIX,
                    HEALTH_TTL_S, STUDIO_CATALOG_TTL_S, VOICE_DEGRADED_TTL_S)

_LOGGER = logging.getLogger(__name__)


def ha_tts_entity_for(voice_id: str) -> str | None:
    """The tts.* entity a Home Assistant voice id speaks through, or None
    for a voice that is not one. The inverse of the backend's
    voice_library.ha_voice_id, and a pure function of the id -- which is
    why a selection stays meaningful while Home Assistant cannot be asked
    anything at all."""
    if not voice_id or not voice_id.startswith(HA_VOICE_PREFIX):
        return None
    rest = voice_id[len(HA_VOICE_PREFIX):]
    return f"tts.{rest}" if rest else None


def is_service_failure(exc: Exception) -> bool:
    """Did a request fail because of the SERVICE rather than the request?
    No answer, a refused key, or a failure of its own (no status, or 5xx).
    A 4xx refusal is about what was asked and says nothing about health."""
    if isinstance(exc, (RadioServiceConnectionError, RadioServiceAuthError)):
        return True
    status = getattr(exc, "status", 0) or 0
    return status == 0 or status >= 500


def ma_disagrees(outputs: Any, health: dict[str, Any] | None) -> bool:
    """Do this cycle's /outputs answer and the cached health report say
    different things about Music Assistant? /outputs answers ok only when
    Music Assistant listed its players just now; the report's
    music_assistant.reachable is its own probe, up to HEALTH_TTL_S old.
    Unknown on either side is no disagreement."""
    if not isinstance(outputs, dict) or "ok" not in outputs or not isinstance(health, dict):
        return False
    ma = (health.get("features") or {}).get("music_assistant")
    if not isinstance(ma, dict) or "reachable" not in ma:
        return False
    return bool(outputs.get("ok")) != bool(ma.get("reachable"))


def readiness_key(health: dict[str, Any] | None) -> str:
    """What the Settings verdict depends on in the health report, in a few
    characters: whether there is one, whether Music Assistant answered, and
    which problems it names. The panel re-reads readiness when this changes,
    rather than waiting for its own timer. No value from the report is in it
    beyond problem codes."""
    if not isinstance(health, dict) or "problems" not in health:
        return "unknown"
    ma = ((health.get("features") or {}).get("music_assistant") or {}).get("reachable")
    codes = sorted({str(p.get("code")) for p in health.get("problems") or [] if isinstance(p, dict)})
    return f"ma:{int(bool(ma))}|" + ",".join(codes)


def scan_interval_for(data: dict[str, Any] | None) -> timedelta:
    """How often to ask, given what the DJ last said it was doing.

    A pure function of the snapshot so the cadence rule can be asserted
    without a clock: inside the break window (a rendered break inserted,
    about to air, or airing) the fast interval, everywhere else the
    ordinary one. See const.BREAK_WINDOW_SCAN_INTERVAL_S for why."""
    dj = ((data or {}).get("dj_status") or {}).get("dj") or {}
    status = dj.get("status")
    seconds_to_air = dj.get("seconds_to_air")
    fast = (status in BREAK_WINDOW_STATUSES) or (
        seconds_to_air is not None and 0 <= seconds_to_air <= 12
    )
    return timedelta(seconds=BREAK_WINDOW_SCAN_INTERVAL_S if fast
                     else DEFAULT_SCAN_INTERVAL_S)



#: Home Assistant media_player services that START playback.
PLAY_SERVICES = frozenset({"media_play", "media_play_pause", "play_media"})


def listener_play_target(data: dict[str, Any] | None, user_id: str | None,
                         selected: str | None, entity: str | None) -> str | None:
    """The DJ output's queue id when this call_service event is a PERSON
    asking the DJ speaker to play, else None. Pure: only the event, who
    sent it and which speaker is ours."""
    data = data or {}
    if not user_id or not selected or data.get("domain") != "media_player":
        return None
    if data.get("service") not in PLAY_SERVICES:
        return None
    sd = data.get("service_data") or {}
    targets = sd.get("entity_id")
    if isinstance(targets, str):
        targets = [targets]
    if not isinstance(targets, (list, tuple)):
        return None
    return selected if any(t in (entity, selected) for t in targets if t) else None

class ParlorwaveRadioCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    def __init__(self, hass: HomeAssistant, client: RadioServiceClient,
                 entry=None) -> None:
        super().__init__(
            hass, _LOGGER, name=DOMAIN, config_entry=entry,
            update_interval=timedelta(seconds=DEFAULT_SCAN_INTERVAL_S))
        self.client = client
        self._catalog: dict[str, Any] | None = None
        self._catalog_at = 0.0
        self._voices: dict[str, Any] | None = None
        self._voices_at = 0.0
        # Home Assistant's own verdict on the tts.* entities the cached
        # shelf names, as it read at the moment that shelf was fetched.
        # A change here -- and nothing else -- means the shelf is out of
        # date before its TTL says so. See _ha_tts_availability.
        self._voices_states: dict[str, bool] | None = None
        self._health: dict[str, Any] | None = None
        self._health_at = 0.0
        # when the service process last answered as started (/dj/status):
        # a different value is a restart the polls did not catch failing
        self._service_started: str | None = None
        # filled by the context publisher: what it reads and how it went
        self.context_status: dict[str, Any] = {}
        self.context_publisher = None
        self._watched_player: str | None = None
        self._unsub_player = None
        self._stopped = False

    def _sync_play_request_listener(self) -> None:
        """Forward a PERSON's Play on the DJ speaker to the backend.

        Home Assistant's call_service event carries the user who asked;
        Music Assistant never says who started playback. Without this, a
        listener pressing Play seconds after a finite queue ended could not
        be told from MA re-opening a Flow by itself, and the DJ would treat
        their new pass as a replay (backend queue_end). A note only:
        nothing here calls a service or changes playback."""
        if getattr(self, "_unsub_calls", None) or getattr(self, "_stopped", False):
            return
        if not (self.hass and hasattr(self.hass, "bus")
                and hasattr(self.hass.bus, "async_listen")):
            return

        @callback
        def _on_call(event):
            try:
                selected = self.selected_output(self.data or {})
                from .entity import ma_entity_for
                entity = ma_entity_for(self.hass, selected) if selected else None
                target = listener_play_target(
                    event.data, getattr(getattr(event, "context", None),
                                        "user_id", None),
                    selected, entity)
                if target and hasattr(self.hass, "async_create_task"):
                    self.hass.async_create_task(self._send_listener_play(target))
            except Exception:  # noqa: BLE001 - a note, never a failure
                _LOGGER.debug("listener play note skipped", exc_info=True)

        try:
            self._unsub_calls = self.hass.bus.async_listen("call_service", _on_call)
        except Exception:  # noqa: BLE001
            self._unsub_calls = None

    async def _send_listener_play(self, queue_id: str) -> None:
        try:
            await self.client.listener_play(queue_id)
        except Exception:  # noqa: BLE001 - an old backend without the route
            _LOGGER.debug("listener play note not delivered", exc_info=True)

    def _sync_player_listener(self, player_id: str | None) -> None:
        if getattr(self, "_stopped", False):
            return          # a poll that outlived the entry may not resubscribe
        if player_id == getattr(self, "_watched_player", None):
            return
        if getattr(self, "_unsub_player", None):
            try:
                self._unsub_player()
            except Exception:
                pass
            self._unsub_player = None
        self._watched_player = player_id
        if player_id and self.hass and hasattr(self.hass, "bus"):
            try:
                from homeassistant.helpers.event import async_track_state_change_event
                @callback
                def _on_player_change(event):
                    if hasattr(self.hass, "async_create_task"):
                        self.hass.async_create_task(self.async_request_refresh())
                self._unsub_player = async_track_state_change_event(
                    self.hass, [player_id], _on_player_change)
            except Exception:
                self._unsub_player = None

    def async_stop(self) -> None:
        """Drop the selected-output listener, for good. Called from the
        entry's unload; safe to call again, and safe before any listener
        was ever installed."""
        self._stopped = True
        if getattr(self, "_unsub_calls", None):
            try:
                self._unsub_calls()
            except Exception:
                pass
            self._unsub_calls = None
        if getattr(self, "_unsub_player", None):
            try:
                self._unsub_player()
            except Exception:
                pass
            self._unsub_player = None
        self._watched_player = None

    async def _async_update_data(self) -> dict[str, Any]:
        # On any failure here the last health report is forgotten: whatever
        # answers next -- an add-on restarted with a new Music Assistant
        # token, a dependency that went away -- is not what it described.
        try:
            dj_status = await self.client.dj_status()
            dj_settings = (await self.client.dj_settings()).get("settings") or {}
            playback = (await self.client.playback_settings()).get("settings") or {}
        except RadioServiceAuthError as exc:
            # A refused key is not a moment that passes: retrying it as "not
            # ready" forever left nothing to fix it from. Home Assistant
            # stops the entry and starts reauthentication; on Home Assistant
            # OS the add-on's next announcement repairs it by itself.
            self.invalidate_health()
            raise ConfigEntryAuthFailed(str(exc)) from exc
        except RadioServiceConnectionError as exc:
            self.invalidate_health()
            raise UpdateFailed(str(exc)) from exc
        except RadioServiceError as exc:
            self.invalidate_health()
            raise UpdateFailed(f"The ParlorWave Radio service answered abnormally: {exc}") from exc

        # A restarted service is not the one the health report described: a
        # token pasted into the add-on restarts it in a few seconds, usually
        # between two polls, so no refresh fails and nothing else would tell.
        started = dj_status.get("service_started") if isinstance(dj_status, dict) else None
        if started and self._service_started and started != self._service_started:
            self.invalidate_health()
        self._service_started = started or self._service_started

        data: dict[str, Any] = {
            "dj_status": dj_status,
            "dj_settings": dj_settings,
            "playback_settings": playback,
            "outputs": None,
            "now_playing": None,
            "station_settings": None,
            "studio_catalog": None,
        }

        try:
            data["station_settings"] = (
                await self.client.station_settings()).get("settings") or {}
        except RadioServiceError:
            _LOGGER.debug("station settings unavailable this cycle")
        data["studio_catalog"] = await self._catalog_snapshot()

        # The Booth's Now Playing card (artwork, kind, elapsed basis)
        # and the voice library shelf. Both degrade to None, never fail
        # the update; the card is polled each cycle (it is one cheap MB
        # call), the shelf rides the catalog TTL.
        try:
            card = await self.client.now_playing_card()
            data["now_card"] = card.get("playing") if card.get("ok") else None
        except RadioServiceError:
            _LOGGER.debug("now-playing card unavailable this cycle")
            data["now_card"] = None
        data["voice_library"] = await self._voice_library_snapshot()

        # Secondary surfaces: degrade to None, never fail the update.
        try:
            data["outputs"] = await self.client.outputs()
        except RadioServiceError:
            _LOGGER.debug("outputs surface unavailable this cycle")
        # /outputs asks Music Assistant every cycle. When it and the health
        # report disagree about Music Assistant -- an outage, a refused token,
        # or the recovery from either -- the report is out of date: ask again
        # now rather than at the end of its TTL. At most once per ordinary
        # cycle, so a flapping server never turns this into a faster poll.
        if (ma_disagrees(data["outputs"], self._health)
                and time.monotonic() - self._health_at >= DEFAULT_SCAN_INTERVAL_S):
            self.invalidate_health()
        # The structured health surface (problems + observer/outputs facts)
        # on its own TTL: it performs live probes on the backend side.
        data["health"] = await self._health_snapshot()
        data["readiness_key"] = readiness_key(data["health"])

        player = self.selected_output(data)
        self._sync_player_listener(player)
        self._sync_play_request_listener()
        if player:
            try:
                session = await self.client.session_by_player(player)
                if session.get("ok"):
                    data["now_playing"] = session.get("session")
            except RadioServiceError:
                _LOGGER.debug("now-playing surface unavailable this cycle")
        # A break is a ten-to-thirty-second event; ask more often
        # while one is imminent or on the air, and only then.
        self.update_interval = scan_interval_for(data)
        return data

    async def _catalog_snapshot(self) -> dict[str, Any] | None:
        """The Studio catalog, refreshed every STUDIO_CATALOG_TTL_S seconds.
        A failed refresh keeps the last good copy (None only until the
        first success), and a catalog the backend itself marks degraded
        (voices unreachable) is retried on the next cycle."""
        now = time.monotonic()
        if self._catalog is not None and now - self._catalog_at < STUDIO_CATALOG_TTL_S:
            return self._catalog
        try:
            catalog = await self.client.studio_catalog()
        except RadioServiceError:
            _LOGGER.debug("studio catalog unavailable this cycle")
            return self._catalog
        if isinstance(catalog, dict) and catalog.get("ok"):
            voices = catalog.get("voices") or {}
            if not voices.get("ok") and self._catalog:
                # the speech service is unreachable right now: keep the
                # voices we last saw rather than blanking the selector
                catalog = dict(catalog, voices=self._catalog.get("voices"))
            self._catalog = catalog
            # only mark fresh when the voice list came through
            self._catalog_at = now if voices.get("ok") else 0.0
        return self._catalog

    async def _health_snapshot(self) -> dict[str, Any] | None:
        """GET /health/problems every HEALTH_TTL_S seconds; the last good
        answer is carried forward between refreshes, but never across a
        failed one: a verdict the service could not confirm is not shown as
        current (Settings then says it is checking -- readiness.CHECKING)."""
        now = time.monotonic()
        if self._health is not None and now - self._health_at < HEALTH_TTL_S:
            return self._health
        try:
            report = await self.client.health_problems()
        except RadioServiceError:
            _LOGGER.debug("health surface unavailable this cycle")
            self.invalidate_health()
            return None
        if isinstance(report, dict) and "problems" in report:
            self._health = report
            self._health_at = now
        else:
            self.invalidate_health()
        return self._health

    def invalidate_health(self) -> None:
        """Forget the health report, and the copy the last refresh handed
        out, so Settings says it is checking instead of keeping a "Ready"
        the integration has just seen fail, and the next refresh asks again
        rather than waiting out HEALTH_TTL_S. For the moments the
        integration KNOWS the report may be wrong: the service could not be
        read or refused the key, or answered a request with a failure of its
        own (see is_service_failure)."""
        self._health = None
        self._health_at = 0.0
        if isinstance(self.data, dict):
            self.data["health"] = None

    def invalidate_voice_library(self) -> None:
        """Forget the cached shelf so the NEXT refresh refetches it. Called
        after a voice write: the shelf rides a five-minute TTL for the
        idle case, and without this a freshly picked voice would show as
        the old one until that TTL ran out."""
        self._voices_at = 0.0
        self._voices_states = None

    def _ha_tts_availability(self, lib: dict[str, Any] | None
                             ) -> dict[str, bool] | None:
        """Which of the tts.* entities this shelf depends on Home Assistant
        calls available RIGHT NOW, read from its own state machine.

        The one fact that decides whether a Home Assistant voice can be
        offered is the one fact that changes fastest -- a Piper that
        restarts is unavailable for a few seconds -- and it was the only
        thing riding a five-minute cache. Home Assistant already knows it
        locally, for free, on every cycle, so the shelf's freshness is
        keyed on it: no extra polling of the service, no subscription to
        manage, and no churn, because the signature only moves when a
        provider's availability actually moves.

        The availability rule is the backend's own (`ha_tts._entity_record`:
        anything but the literal `unavailable`), so the two can never
        disagree about what they are looking at. Entities the shelf does
        not name are not watched; the selected voice is watched whether or
        not the shelf could list it."""
        states = getattr(self.hass, "states", None)
        if lib is None or states is None:
            return None
        entities = {v.get("entity_id") for v in (lib.get("home_assistant") or [])
                    if isinstance(v, dict) and v.get("entity_id")}
        for key in ("selected", "current"):
            entity = ha_tts_entity_for(((lib.get(key) or {})
                                        .get("voice_id") or ""))
            if entity:
                entities.add(entity)
        out: dict[str, bool] = {}
        for entity_id in sorted(entities):
            state = states.get(entity_id)
            out[entity_id] = state is not None and state.state != "unavailable"
        return out

    async def _voice_library_snapshot(self) -> dict[str, Any] | None:
        """The voice shelves.

        Refetched when the TTL expires, and -- the point of the rule --
        as soon as Home Assistant's verdict on any TTS entity the shelf
        depends on changes, in EITHER direction. A provider that blinked
        out and came back was previously invisible until the shelf's own
        five-minute clock happened to run out, and on a degraded answer
        the first snapshot after startup was kept for the life of the
        process: the customer's voice vanished from the picker and only a
        Home Assistant restart brought it back.

        A degraded answer (the optional cloning engine unreachable) no
        longer freezes the whole document. Exactly two things in the
        answer depend on that engine -- the custom slots' `has_sample` and
        the `cloning` capability block -- so those keep the last good copy
        and everything else is taken fresh."""
        now = time.monotonic()
        ttl = (STUDIO_CATALOG_TTL_S if (self._voices or {}).get("ok")
               else VOICE_DEGRADED_TTL_S)
        if (self._voices is not None and now - self._voices_at < ttl
                and self._ha_tts_availability(self._voices) == self._voices_states):
            return self._voices
        try:
            lib = await self.client.voices_library()
        except RadioServiceError:
            _LOGGER.debug("voice library unavailable this cycle")
            return self._voices
        if isinstance(lib, dict):
            if not lib.get("ok") and self._voices:
                lib = dict(lib, customs=self._voices.get("customs") or [],
                           cloning=self._voices.get("cloning"))
            self._voices = lib
            self._voices_at = now
            self._voices_states = self._ha_tts_availability(lib)
        return self._voices

    # --- shared accessors (one place to know the shapes) -----------------
    @staticmethod
    def selected_output(data: dict[str, Any]) -> str | None:
        outputs = (data.get("dj_settings") or {}).get("outputs") or {}
        selected = outputs.get("default_request_output")
        if selected:
            return selected
        enabled = outputs.get("enabled") or []
        return enabled[0] if enabled else None

    @staticmethod
    def problems(data: dict[str, Any]) -> list[dict[str, Any]]:
        """The backend's structured problems (code / severity / summary),
        bounded, for a sensor attribute or the panel."""
        health = data.get("health") or {}
        out = []
        for p in (health.get("problems") or [])[:12]:
            if isinstance(p, dict) and p.get("code"):
                out.append({"code": p.get("code"), "severity": p.get("severity"),
                            "summary": p.get("summary"), "action": p.get("action")})
        return out

    @staticmethod
    def observer(data: dict[str, Any]) -> dict[str, Any] | None:
        return ((data.get("health") or {}).get("features") or {}).get("observer")

    @staticmethod
    def music_catalog(data: dict[str, Any]) -> dict[str, Any]:
        """Can this installation programme music itself?

        The backend's own verdict (features.catalog), never re-derived
        here: an integration that guessed from a station being active, or
        from a file it can see, would be a second opinion able to disagree
        with the service that actually refuses. Until the first health
        answer arrives the honest report is "not usable, and we do not yet
        know" -- `known` false -- so a surface can stay quiet instead of
        promising a control that may not work.
        """
        features = (data.get("health") or {}).get("features") or {}
        catalog = features.get("catalog")
        if not isinstance(catalog, dict):
            return {"usable": False, "track_count": 0, "known": False}
        return {"usable": bool(catalog.get("usable")),
                "track_count": int(catalog.get("track_count") or 0),
                "minimum_tracks": catalog.get("minimum_tracks"),
                "known": True}

    @staticmethod
    def enabled_outputs(data: dict[str, Any]) -> list[str]:
        outputs = (data.get("dj_settings") or {}).get("outputs") or {}
        return [o for o in (outputs.get("enabled") or []) if o]

    @staticmethod
    def station_name(data: dict[str, Any]) -> str:
        st = (data or {}).get("station_settings") or {}
        ident = st.get("identity") or {}
        name = ident.get("name") if isinstance(ident, dict) else None
        if not name and isinstance(st.get("name"), str):
            name = st["name"]
        return str(name).strip() if name else "ParlorWave Radio"

    @staticmethod
    def station(data: dict[str, Any]) -> dict[str, Any] | None:
        return ((data.get("dj_status") or {}).get("station") or {}).get("active")

    @staticmethod
    def session(data: dict[str, Any]) -> dict[str, Any] | None:
        """The active playback session on the selected output, or None.

        Deliberately NOT the source of track title/artist: the panel binds
        the selected output's media_player entity for Now Playing, which
        Home Assistant already knows natively and in real time. The session
        contributes the DJ context (request, mode, queue depth)."""
        return data.get("now_playing")
