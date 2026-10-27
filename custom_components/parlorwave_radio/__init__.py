"""Parlorwave Radio -- native Home Assistant integration for the the Parlorwave Radio service.

Structure: one config entry -> one RadioServiceClient (HA's shared aiohttp
session) -> one ParlorwaveRadioCoordinator -> switch/select/number/sensor entities
plus the domain services (const.SERVICES), plus the Parlorwave Radio sidebar panel.

Lifecycle: services, the websocket commands and the static panel path are
domain-global. Services are registered by the first entry and removed by
the last unload (every one of them: pinned by the lifecycle tests) and
resolve the live coordinator per call, so a reload never leaves a service
bound to a dead client. The static path and websocket commands cannot be
unregistered in Home Assistant, so they are registered exactly once per
process. The sidebar panel and the context publisher are per-setup and
torn down on unload; publisher work runs as entry-tracked background
tasks, cancelled with the entry.

No inference host is named or assumed anywhere in this integration: it
consumes the service's settings/status contract and nothing else, so where
the words come from stays a backend concern (pinned by a source-level test).
"""

from __future__ import annotations

import logging
from typing import Any
import voluptuous as vol

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import ConfigEntryError, HomeAssistantError
from homeassistant.helpers.aiohttp_client import async_get_clientsession
import homeassistant.helpers.config_validation as cv

from .api import RadioServiceClient, RadioServiceError, VoiceEngineError
from .const import (CONF_API_KEY, CONF_CALENDAR_ENTITIES, CONF_HOST, CONF_PORT,
                    CONF_WEATHER_ENTITY, DATA_STATIC_REGISTERED,
                    DATA_VERSION, DATA_VIEW_REGISTERED, ISSUE_ADDON_VERSION,
                    DATA_WS_REGISTERED, DOMAIN, PANEL_STATIC_BASE, PANEL_TITLE,
                    PANEL_URL_PATH, SERVICE_REQUEST, SERVICE_START_RADIO,
                    SERVICE_THUMBS_DOWN, SERVICE_THUMBS_UP, SERVICE_VOICE_DELETE,
                    SERVICE_VOICE_NOTE, SERVICE_VOICE_RENAME, SERVICE_VOICE_TUNING,
                    SERVICE_VOICE_UPLOAD, SERVICES, VOICE_CONSENT_VERSION,
                    VOICE_PREVIEW_MAX_CHARS, VOICE_SCOPES)
from .coordinator import ParlorwaveRadioCoordinator, is_service_failure
from .entity import ma_entity_for
from .panel_assets import PANEL_FILE, panel_asset_version

_LOGGER = logging.getLogger(__name__)
PLATFORMS = ["switch", "select", "number", "sensor"]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    base = f"http://{entry.data[CONF_HOST]}:{entry.data[CONF_PORT]}"
    client = RadioServiceClient(async_get_clientsession(hass), base,
                              entry.data.get(CONF_API_KEY, ""))
    coordinator = ParlorwaveRadioCoordinator(hass, client, entry)
    # the connection this client was built from: an entry update that
    # changes it needs a new client (a reload); one that does not, does not
    coordinator.connection = _connection_of(entry)
    await coordinator.async_config_entry_first_refresh()
    await _check_installation(hass, entry, client)

    _async_cleanup_orphaned_entities(hass, entry)

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    await _remember_version(hass)
    _register_services(hass)
    _register_websocket(hass)
    _register_views(hass)
    await _register_panel(hass)
    # Grounded context (weather / sun / calendar) is published by THIS
    # integration; no automation or rest_command outside it is needed.
    from .context_publisher import ContextPublisher
    coordinator.context_publisher = ContextPublisher(hass, entry, client, coordinator)
    await coordinator.context_publisher.async_start()
    entry.async_on_unload(entry.add_update_listener(_async_options_updated))
    return True


def _async_cleanup_orphaned_entities(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Remove obsolete Parlorwave entities (e.g. chattiness) from the entity registry.

    Chattiness was decoupled from personality in alpha; it is no longer an
    entity in select.py or number.py. On upgrade, any orphaned chattiness entity
    belonging to this config entry is purged from Home Assistant's entity
    registry so it does not persist as an unavailable ghost control.
    Fresh installs never create it. Cleanup is idempotent and leaves all other
    entities completely untouched.
    """
    try:
        from homeassistant.helpers import entity_registry as er
        registry = er.async_get(hass)
    except Exception:  # noqa: BLE001
        return

    chattiness_uid = f"{entry.entry_id}_chattiness"
    to_remove: set[str] = set()

    # Query registry by unique_id if supported
    if hasattr(registry, "async_get_entity_id"):
        for domain in ("select", "number"):
            try:
                eid = registry.async_get_entity_id(domain, DOMAIN, chattiness_uid)
                if eid:
                    to_remove.add(eid)
            except Exception:  # noqa: BLE001
                pass

    # Inspect registry entries for this entry or domain
    entries = []
    if hasattr(er, "async_entries_for_config_entry"):
        try:
            entries.extend(er.async_entries_for_config_entry(registry, entry.entry_id))
        except Exception:  # noqa: BLE001
            pass
    if hasattr(registry, "entities") and isinstance(registry.entities, dict):
        entries.extend(registry.entities.values())

    for ent in entries:
        uid = getattr(ent, "unique_id", None)
        eid = getattr(ent, "entity_id", None)
        cid = getattr(ent, "config_entry_id", None)
        plat = getattr(ent, "platform", None)

        if uid == chattiness_uid:
            if eid:
                to_remove.add(eid)
        elif uid == "chattiness" and (cid == entry.entry_id or plat == DOMAIN):
            if eid:
                to_remove.add(eid)

    for eid in to_remove:
        try:
            if hasattr(registry, "async_get") and not registry.async_get(eid):
                continue
            if hasattr(registry, "async_remove"):
                registry.async_remove(eid)
            elif hasattr(registry, "entities") and isinstance(registry.entities, dict):
                registry.entities.pop(eid, None)
            _LOGGER.info("Removed obsolete Parlorwave entity %s from entity registry", eid)
        except Exception:  # noqa: BLE001
            pass


async def _check_installation(hass: HomeAssistant, entry: ConfigEntry,
                              client: RadioServiceClient) -> None:
    """Is the backend answering at this entry's address the installation
    this entry belongs to, and on the same release? One authenticated call,
    after the first refresh proved it answers.

    A DIFFERENT installation is a stop, not a reconnection: the add-on was
    reinstalled (its data -- and so its identity -- is new) or another
    service took the address. Carrying on would show and control somebody
    else's station under this entry's devices. The newly installed add-on
    is discovered as its own entry; this one says what happened.

    A different RELEASE never stops anything; it is a Repairs issue."""
    try:
        reported = await client.instance()
    except RadioServiceError:
        return              # a backend from before /instance: nothing to compare
    answering = str(reported.get("instance_id") or "").strip()
    if answering and entry.unique_id and answering != entry.unique_id:
        raise ConfigEntryError(
            f"A different ParlorWave Radio installation now answers at "
            f"{entry.data.get(CONF_HOST)}. If the add-on was reinstalled, delete "
            f"this entry and confirm the newly discovered ParlorWave Radio.")
    await _remember_version(hass)
    _report_addon_version(hass, hass.data.get(DATA_VERSION) or "",
                          reported.get("version"))


def _is_development(version: str) -> bool:
    return "-dev" in version or version.startswith("0.0.0")


def version_mismatch(integration: str, addon: object) -> bool:
    """Should a release mismatch be reported? Only between two public
    releases: a backend from before version reporting (None) and any
    development build cannot be judged."""
    addon_v, own_v = str(addon or "").strip(), str(integration or "").strip()
    if not addon_v or not own_v:
        return False
    if _is_development(addon_v) or _is_development(own_v):
        return False
    return addon_v != own_v


def _report_addon_version(hass: HomeAssistant, integration: str,
                          addon: object) -> None:
    from homeassistant.helpers import issue_registry as ir
    if version_mismatch(integration, addon):
        ir.async_create_issue(
            hass, DOMAIN, ISSUE_ADDON_VERSION, is_fixable=False,
            severity=ir.IssueSeverity.WARNING,
            translation_key=ISSUE_ADDON_VERSION,
            translation_placeholders={"addon_version": str(addon).strip(),
                                      "integration_version": integration})
    else:
        ir.async_delete_issue(hass, DOMAIN, ISSUE_ADDON_VERSION)


async def _remember_version(hass: HomeAssistant) -> None:
    """This integration's own version, read once from its manifest.

    Support detail, shown only under the advanced disclosure in Settings.
    Read from the manifest rather than restated in a constant, so there is
    one version in this integration and not two that can disagree."""
    if hass.data.get(DATA_VERSION) is not None:
        return
    import json
    import os

    def _read() -> str:
        path = os.path.join(os.path.dirname(__file__), "manifest.json")
        with open(path, encoding="utf-8") as fh:
            return str(json.load(fh).get("version") or "")
    try:
        hass.data[DATA_VERSION] = await hass.async_add_executor_job(_read)
    except Exception:  # noqa: BLE001 - an unreadable manifest is not a failure
        hass.data[DATA_VERSION] = ""


def _coordinator(hass: HomeAssistant,
                 entry_id: str | None = None) -> ParlorwaveRadioCoordinator:
    """The live coordinator for a service call: the named entry's, else the
    first loaded one. Resolved per call, never captured at registration,
    so a reloaded entry's services always talk to the current client."""
    entries = hass.data.get(DOMAIN) or {}
    if entry_id and entry_id in entries:
        return entries[entry_id]
    for coordinator in entries.values():
        return coordinator
    raise HomeAssistantError("ParlorWave Radio is not set up")


def _connection_of(entry: ConfigEntry) -> dict[str, Any]:
    """The three facts a client is built from. A change to any of them is
    a different backend, and only a reload builds a new client."""
    return {CONF_HOST: entry.data.get(CONF_HOST),
            CONF_PORT: entry.data.get(CONF_PORT),
            CONF_API_KEY: entry.data.get(CONF_API_KEY, "")}


async def _async_options_updated(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """The entry was updated -- from the options flow, from the panel's
    Settings screen, or by a flow that re-pointed the connection.

    A changed CONNECTION (host, port, key) is a different backend and the
    entry is reloaded, exactly as before. A changed context selection --
    the weather entity, the calendars; the only things the options hold --
    restarts the context publisher and nothing else. It used to reload the
    whole entry for that too, which unloaded every entity, re-registered
    the panel, and re-ran the first refresh: with the add-on mid-restart
    that first refresh fails and the entry sits in retry, so choosing a
    calendar at the wrong moment took the whole integration down for a
    while. The publisher is the only thing that reads those options.

    Idempotent: the panel's write applies the new selection itself and this
    listener, which Home Assistant schedules afterwards, finds nothing left
    to do."""
    coordinator = (hass.data.get(DOMAIN) or {}).get(entry.entry_id)
    if coordinator is None or getattr(coordinator, "connection", None) != _connection_of(entry):
        await hass.config_entries.async_reload(entry.entry_id)
        return
    await _apply_context_options(hass, entry, coordinator)


async def _apply_context_options(hass: HomeAssistant, entry: ConfigEntry,
                                 coordinator: ParlorwaveRadioCoordinator) -> None:
    """Make the context publisher read what the entry's options now say.
    A publisher already reading exactly that is left alone (so a write
    followed by the scheduled listener restarts it once, not twice);
    otherwise the old one is stopped -- its state listeners and its timer
    with it -- and a fresh one starts and publishes at once."""
    from .context_publisher import ContextPublisher
    old = getattr(coordinator, "context_publisher", None)
    weather = entry.options.get(CONF_WEATHER_ENTITY) or None
    calendars = list(entry.options.get(CONF_CALENDAR_ENTITIES) or [])
    if (old is not None and not old.stopped
            and old.weather_entity == weather and old.calendar_entities == calendars):
        return
    if old is not None:
        await old.async_stop()
    publisher = ContextPublisher(hass, entry, coordinator.client, coordinator)
    coordinator.context_publisher = publisher
    await publisher.async_start()


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """A removed installation leaves no Repairs issue behind."""
    from homeassistant.helpers import issue_registry as ir
    ir.async_delete_issue(hass, DOMAIN, ISSUE_ADDON_VERSION)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if ok:
        coordinator = hass.data[DOMAIN].pop(entry.entry_id, None)
        publisher = getattr(coordinator, "context_publisher", None)
        if publisher is not None:
            await publisher.async_stop()
        if coordinator is not None:
            # the selected-output state listener is the entry's, and a
            # reload builds a fresh coordinator: stop this one or the old
            # listener keeps refreshing a coordinator nothing reads
            coordinator.async_stop()
        if not hass.data[DOMAIN]:
            for service in SERVICES:
                if hass.services.has_service(DOMAIN, service):
                    hass.services.async_remove(DOMAIN, service)
            _remove_panel(hass)
    return ok


# --- services -------------------------------------------------------------

REQUEST_SCHEMA = vol.Schema({
    vol.Required("request"): cv.string,
    vol.Optional("player"): cv.string,
    vol.Optional("count", default=30): vol.All(int, vol.Range(min=1, max=60)),
    vol.Optional("mode"): cv.string,
})
START_RADIO_SCHEMA = vol.Schema({
    vol.Optional("output"): cv.string,
    vol.Optional("count"): vol.All(int, vol.Range(min=1, max=30)),
})
FEEDBACK_SCHEMA = vol.Schema({
    vol.Optional("artist", default=""): cv.string,
    vol.Optional("title", default=""): cv.string,
    vol.Optional("path", default=""): cv.string,
    vol.Optional("player"): cv.string,
})


def _register_services(hass: HomeAssistant) -> None:
    if hass.services.has_service(DOMAIN, SERVICE_REQUEST):
        return

    def _player(call: ServiceCall, key: str = "player") -> str:
        coordinator = _coordinator(hass)
        player = call.data.get(key) or coordinator.selected_output(
            coordinator.data or {})
        if not player:
            raise HomeAssistantError(
                "no output selected -- set the ParlorWave Radio output first")
        return player

    def _ma_entity_for(player_id: str) -> str:
        """Service-side mapping: entity id or a clear HomeAssistantError.

        Shared logic lives in entity.ma_entity_for so the Output select can
        publish the same answer as an attribute for the panel's Now Playing.
        """
        entity_id = ma_entity_for(hass, player_id)
        if entity_id is None:
            raise HomeAssistantError(
                f"no Music Assistant entity found for output {player_id!r} -- "
                "is that output a Music Assistant player?")
        return entity_id

    async def request(call: ServiceCall) -> None:
        """The text-request flow, natively: the Parlorwave Radio service builds the
        session + station, then the returned tracks are enqueued through
        Music Assistant (replace on the first track, add for the rest)."""
        coordinator = _coordinator(hass)
        player = _player(call)
        try:
            result = await coordinator.client.request_station(
                call.data["request"], player, count=call.data["count"],
                mode=call.data.get("mode"))
        except RadioServiceError as exc:
            raise HomeAssistantError(f"request failed: {exc}") from exc
        tracks = result.get("queue") or []
        if not tracks:
            raise HomeAssistantError(
                result.get("queue_error") or "no tracks came back for that request")
        target_entity = _ma_entity_for(player)
        # Per-track tolerance, like the voice flow always had: one track MA
        # cannot resolve must not abort the batch (resolution loss is
        # normal). Only a fully empty enqueue is an error. "replace" applies
        # to the first track that actually lands, so a miss on track one
        # cannot wipe the queue without starting anything.
        landed = 0
        for track in tracks:
            try:
                await hass.services.async_call(
                    "music_assistant", "play_media",
                    {"media_id": track.get("title") or "",
                     "artist": track.get("artist") or "",
                     "media_type": "track",
                     "enqueue": "replace" if landed == 0 else "add",
                     "radio_mode": False},
                    target={"entity_id": target_entity}, blocking=True)
                landed += 1
            except Exception:  # noqa: BLE001 -- any single-track failure
                _LOGGER.debug("request: track did not enqueue: %s - %s",
                              track.get("artist"), track.get("title"))
        if not landed:
            raise HomeAssistantError(
                "none of the requested tracks could be enqueued")
        _LOGGER.info("request enqueued %d/%d tracks on %s", landed,
                     len(tracks), target_entity)
        await coordinator.async_request_refresh()

    async def start_radio(call: ServiceCall) -> None:
        coordinator = _coordinator(hass)
        try:
            result = await coordinator.client.start_radio_from_current(
                queue_id=call.data.get("output"), count=call.data.get("count"))
        except RadioServiceError as exc:
            raise HomeAssistantError(f"start radio failed: {exc}") from exc
        if not result.get("ok"):
            # A refusal the service already wrote for a person (an install
            # with no local music catalog, say) travels VERBATIM; anything
            # else keeps its machine-readable reason, which is all there is.
            raise HomeAssistantError(
                result.get("message")
                or f"start radio refused: {result.get('reason') or result.get('error')}")
        await coordinator.async_request_refresh()

    def _feedback(action: str):
        async def handler(call: ServiceCall) -> None:
            coordinator = _coordinator(hass)
            player = call.data.get("player") or coordinator.selected_output(
                coordinator.data or {})
            title = call.data.get("title", "")
            try:
                result = await coordinator.client.feedback(
                    action, artist=call.data.get("artist", ""),
                    title=title,
                    path=call.data.get("path", ""), player=player)
            except RadioServiceError as exc:
                raise HomeAssistantError(f"feedback failed: {exc}") from exc
            # A THUMB THAT CHANGED NOTHING IS NOT A THUMB. Taste learning
            # writes a track's standing into the local Parlorwave catalog,
            # and the service answers how many rows it changed. Zero means
            # the song that is playing is not in that catalog -- it came
            # from a provider Music Assistant serves, or there is no
            # catalog at all -- and there is nowhere for the rating to go.
            # Music Assistant has no feedback capability to fall back on
            # (verified against MA 2.10: no provider advertises a feedback,
            # rating or favourite feature), so the honest answer is to say
            # so. Reporting success here would be the panel showing a green
            # Done for a rating nothing recorded.
            if isinstance(result, dict) and result.get("updated_rows") == 0:
                raise HomeAssistantError(
                    (f"\u201c{title}\u201d is not in your ParlorWave music "
                     "catalog, so there is nothing to rate. Taste learning "
                     "only covers music the catalog holds.") if title else
                    ("That song is not in your ParlorWave music catalog, so "
                     "there is nothing to rate."))
        return handler

    hass.services.async_register(DOMAIN, SERVICE_REQUEST, request,
                                 schema=REQUEST_SCHEMA)
    hass.services.async_register(DOMAIN, SERVICE_START_RADIO, start_radio,
                                 schema=START_RADIO_SCHEMA)
    hass.services.async_register(DOMAIN, SERVICE_THUMBS_UP,
                                 _feedback("thumbs_up"), schema=FEEDBACK_SCHEMA)
    hass.services.async_register(DOMAIN, SERVICE_THUMBS_DOWN,
                                 _feedback("thumbs_down"), schema=FEEDBACK_SCHEMA)

    # --- Custom-voice management -------------------------------------------
    # Mutations ride services (auditable, schema-validated). The frontend
    # never names a path, an asset, or a backend URL. The RECORDING itself
    # does not come this way any more -- bytes belong in an authenticated
    # view (http.py), not in a base64 field on the websocket that also
    # carries every state update in the house -- but voice_upload stays
    # registered for automations that already use it.
    def _voice_error(what: str, exc: RadioServiceError) -> HomeAssistantError:
        """A refusal the backend already wrote for a person travels
        VERBATIM; anything else gets the context it needs to be debugged.
        Prefixing "delete failed:" onto a finished sentence would undo the
        work of writing one."""
        if isinstance(exc, VoiceEngineError):
            return HomeAssistantError(str(exc))
        return HomeAssistantError(f"{what} failed: {exc}")

    async def voice_rename(call: ServiceCall) -> None:
        coordinator = _coordinator(hass)
        try:
            await coordinator.client.voice_rename(call.data["voice_id"],
                                                  call.data["name"])
        except RadioServiceError as exc:
            raise _voice_error("rename", exc) from exc
        # the select entity lists voices BY NAME: its options just changed
        coordinator.invalidate_voice_library()
        await coordinator.async_request_refresh()

    async def voice_delete(call: ServiceCall) -> None:
        coordinator = _coordinator(hass)
        try:
            await coordinator.client.voice_delete(call.data["slot"])
        except RadioServiceError as exc:
            raise _voice_error("delete", exc) from exc
        await coordinator.async_request_refresh()

    async def voice_upload(call: ServiceCall) -> None:
        import base64
        try:
            sample = base64.b64decode(call.data["sample_b64"],
                                      validate=True)
        except Exception as exc:
            raise HomeAssistantError("sample_b64 is not valid base64") from exc
        if call.data.get("authorized") is not True:
            # the same acknowledgement the Booth asks for, and the same
            # refusal: nothing is stored without it
            raise HomeAssistantError(
                "Confirm that you have permission to create and use this "
                "voice (authorized: true) before it is saved.")
        coordinator = _coordinator(hass)
        try:
            await coordinator.client.voice_upload(
                call.data["slot"], sample,
                consent_version=VOICE_CONSENT_VERSION)
        except RadioServiceError as exc:
            raise _voice_error("upload", exc) from exc
        await coordinator.async_request_refresh()

    async def voice_tuning(call: ServiceCall) -> None:
        coordinator = _coordinator(hass)
        try:
            await coordinator.client.voice_tuning(call.data["voice_id"],
                                                  call.data["speed"],
                                                  call.data["pause"])
        except RadioServiceError as exc:
            raise _voice_error("tuning", exc) from exc
        coordinator.invalidate_voice_library()
        await coordinator.async_request_refresh()

    async def voice_note(call: ServiceCall) -> None:
        coordinator = _coordinator(hass)
        try:
            await coordinator.client.voice_note(call.data["voice_id"],
                                                  call.data["note"])
        except RadioServiceError as exc:
            raise _voice_error("note", exc) from exc
        await coordinator.async_request_refresh()

    slot_schema = vol.In(["custom_1", "custom_2", "custom_3"])
    # any shelved voice may be renamed; the backend refuses unknown ids
    hass.services.async_register(
        DOMAIN, SERVICE_VOICE_RENAME, voice_rename,
        schema=vol.Schema({vol.Required("voice_id"): cv.string,
                           vol.Required("name"): cv.string}))
    hass.services.async_register(
        DOMAIN, SERVICE_VOICE_DELETE, voice_delete,
        schema=vol.Schema({vol.Required("slot"): slot_schema}))
    # any shelved voice may carry a note; the backend refuses unknown ids
    hass.services.async_register(
        DOMAIN, SERVICE_VOICE_NOTE, voice_note,
        schema=vol.Schema({vol.Required("voice_id"): cv.string,
                           vol.Required("note"): cv.string}))
    # built-in voices only; the backend refuses a cloned voice
    hass.services.async_register(
        DOMAIN, SERVICE_VOICE_TUNING, voice_tuning,
        schema=vol.Schema({vol.Required("voice_id"): cv.string,
                           vol.Required("speed"): vol.Coerce(float),
                           vol.Required("pause"): vol.Coerce(float)}))
    hass.services.async_register(
        DOMAIN, SERVICE_VOICE_UPLOAD, voice_upload,
        schema=vol.Schema({vol.Required("slot"): slot_schema,
                           vol.Required("sample_b64"): cv.string,
                           # "I have permission to create and use this
                           # voice in Parlorwave." -- required, and only
                           # true will do
                           vol.Required("authorized"): cv.boolean}))


def _register_views(hass: HomeAssistant) -> None:
    """The authenticated upload view, once per process. Like static paths
    and websocket commands, a Home Assistant view cannot be unregistered,
    so it is registered once and resolves the live coordinator per request
    (never captured) -- a reloaded entry's uploads reach the current
    client."""
    if hass.data.get(DATA_VIEW_REGISTERED):
        return
    from .http import BulletinAudioView, VoiceSampleView
    hass.http.register_view(VoiceSampleView())
    hass.http.register_view(BulletinAudioView())
    hass.data[DATA_VIEW_REGISTERED] = True


# --- panel ----------------------------------------------------------------

async def _register_panel(hass: HomeAssistant) -> None:
    from homeassistant.components import frontend, panel_custom

    root = hass.config.path("custom_components", DOMAIN, "panel")
    # The static path is process-global and cannot be unregistered: register
    # it exactly once, whatever the number of setups (options-triggered
    # reloads, unload/setup cycles) this process sees.
    if not hass.data.get(DATA_STATIC_REGISTERED):
        try:
            from homeassistant.components.http import StaticPathConfig
            await hass.http.async_register_static_paths(
                [StaticPathConfig(PANEL_STATIC_BASE, root, cache_headers=False)])
        except ImportError:  # older cores
            hass.http.register_static_path(PANEL_STATIC_BASE, root,
                                           cache_headers=False)
        hass.data[DATA_STATIC_REGISTERED] = True
    if PANEL_URL_PATH in hass.data.get("frontend_panels", {}):
        # A Lovelace dashboard (or another integration) owns the path. Say
        # so: a silently missing sidebar entry is hard to diagnose.
        _LOGGER.warning("panel path %r is already registered; the Parlorwave Radio "
                        "sidebar panel was NOT added", PANEL_URL_PATH)
        return
    # The panel is loaded as an ES module from a fixed URL. The static path
    # sends no Cache-Control, so browsers apply heuristic caching and keep
    # an old script across deploys until a hard refresh -- a redeployed
    # panel that nobody sees. Version the URL by what the route can actually
    # serve, and prune anything that would answer with something else; see
    # panel_asset_version. File I/O belongs off the event loop.
    digest, removed = await hass.async_add_executor_job(panel_asset_version, root)
    for name in removed:
        _LOGGER.warning("removed stale pre-compressed panel asset %r: it did not "
                        "match %s and Home Assistant would have served it to every "
                        "browser that accepts compression", name, PANEL_FILE)
    await panel_custom.async_register_panel(
        hass,
        webcomponent_name="parlorwave-radio-panel",
        frontend_url_path=PANEL_URL_PATH,
        module_url=f"{PANEL_STATIC_BASE}/{PANEL_FILE}?v={digest}",
        sidebar_title=PANEL_TITLE,
        sidebar_icon="mdi:radio-tower",
        require_admin=False,
        embed_iframe=False,
    )


def _remove_panel(hass: HomeAssistant) -> None:
    from homeassistant.components import frontend
    try:
        frontend.async_remove_panel(hass, PANEL_URL_PATH)
    except Exception:  # panel already gone; unload must not fail on this
        _LOGGER.debug("panel already removed")

# --- On-demand Booth data over the HA websocket --------------------------------
# Lyrics, the queue view, program history, the voice shelves, voice
# preview and the Newsroom are DEMAND data: fetched when a drawer opens or
# a button is pressed, never polled into entity attributes (lyrics alone
# can be kilobytes). Each command proxies ONE bounded Parlorwave Radio
# service call through the config entry's client; the browser never holds a
# Parlorwave Radio service credential.
#
# All but eight are read-only. The exceptions are the Newsroom's save and
# feed test, the on-air station's start and stop, the two voice settings
# (a voice's scope and the default announcement voice), Switch DJ and
# Automatic DJ shifts, each named as such where it is registered. Only station_live_start can write
# to a queue -- one explicitly named, backend-proven isolated speaker --
# and no command here issues a transport action.

_WS_REGISTERED = DATA_WS_REGISTERED


def _ws_coordinator(hass: HomeAssistant) -> ParlorwaveRadioCoordinator | None:
    for coordinator in (hass.data.get(DOMAIN) or {}).values():
        return coordinator
    return None


def _key_refused(coordinator) -> bool:
    """Did the last refresh fail because the service REFUSED this entry's
    key (it answered: 401), rather than because it did not answer at all?
    The coordinator raises ConfigEntryAuthFailed for exactly that case and
    keeps it as its last_exception. A transport failure is anything else."""
    from homeassistant.exceptions import ConfigEntryAuthFailed
    return (not getattr(coordinator, "last_update_success", True)
            and isinstance(getattr(coordinator, "last_exception", None),
                           ConfigEntryAuthFailed))


def _register_websocket(hass: HomeAssistant) -> None:
    if hass.data.get(_WS_REGISTERED):
        return
    hass.data[_WS_REGISTERED] = True
    from homeassistant.components import websocket_api

    def _command(ws_type: str, fetch, extra_schema=None, admin: bool = False):
        """One command. `admin` puts Home Assistant's own administrator
        gate in front of it (websocket_api.require_admin): a write that
        changes the config entry is the options flow's kind of change, and
        the options flow is an administrator's page."""
        schema = {vol.Required("type"): ws_type}
        schema.update(extra_schema or {})

        async def handler(hass, connection, msg):
            coordinator = _ws_coordinator(hass)
            if coordinator is None:
                connection.send_error(msg["id"], "not_ready",
                                      "ParlorWave Radio is not set up")
                return
            try:
                result = await fetch(coordinator, msg)
            except RadioServiceError as exc:
                # a failure of the service itself is one Settings must not
                # keep calling Ready (coordinator.invalidate_health)
                if is_service_failure(exc):
                    coordinator.invalidate_health()
                connection.send_error(msg["id"], "backend", str(exc))
                return
            connection.send_result(msg["id"], result)
        handler = websocket_api.async_response(handler)
        if admin:
            handler = websocket_api.require_admin(handler)
        handler = websocket_api.websocket_command(schema)(handler)
        websocket_api.async_register_command(hass, handler)

    _command("parlorwave_radio/lyrics",
             lambda c, m: c.client.now_lyrics())
    _command("parlorwave_radio/queue",
             lambda c, m: c.client.now_queue(m.get("recent", 5),
                                             m.get("upcoming", 10)),
             {vol.Optional("recent"): int, vol.Optional("upcoming"): int})
    _command("parlorwave_radio/waveform",
             lambda c, m: c.client.current_waveform(m.get("queue_id")),
             {vol.Optional("queue_id"): str})
    _command("parlorwave_radio/history",
             lambda c, m: c.client.program_history(m.get("limit", 10)),
             {vol.Optional("limit"): int})
    # Broadcast Diagnostics (Settings, support details): why each DJ break
    # aired as written, aired as the station's own line, or did not air.
    # Read-only, and for administrators: it carries the drafts the station
    # refused, which the Air Check never shows. The id is the public 16-hex
    # one Air Check and Break History already carry, never a break's token.
    _command("parlorwave_radio/broadcast_diagnostics_list",
             lambda c, m: c.client.broadcast_diagnostics(
                 m.get("limit", 25), m.get("kind", "dj_break"), m.get("before"),
                 m.get("outcome"), m.get("reason")),
             {vol.Optional("limit"): vol.All(int, vol.Range(min=1, max=200)),
              vol.Optional("kind"): vol.In(["dj_break", "news_intro", "announcement", "all"]),
              vol.Optional("before"): str, vol.Optional("outcome"): str,
              vol.Optional("reason"): str},
             admin=True)
    _command("parlorwave_radio/broadcast_diagnostics_detail",
             lambda c, m: c.client.broadcast_diagnostic(m["opportunity_id"]),
             {vol.Required("opportunity_id"): vol.Match(r"^[0-9a-f]{16}$")},
             admin=True)
    _command("parlorwave_radio/voices",
             lambda c, m: c.client.voices_library())

    _command("parlorwave_radio/station_settings",
             lambda c, m: c.client.station_settings())

    async def _announcements(coordinator, msg):
        """The backend's announcements status, plus the one fact only this
        integration holds: WHICH calendars are being observed (the same
        selection the context publisher reads; there is no second
        selector)."""
        result = await coordinator.client.announcements_status()
        status = getattr(coordinator, "context_status", None) or {}
        calendar = status.get("calendar") or {}
        result["calendars"] = list(calendar.get("entities") or [])
        result["calendars_failed"] = list(calendar.get("failed") or [])
        return result
    _command("parlorwave_radio/announcements", _announcements)

    async def _station_save(coordinator, msg):
        result = await coordinator.client.save_station_settings(
            msg.get("station") or {})
        await coordinator.async_request_refresh()
        return result
    _command("parlorwave_radio/station_save", _station_save,
             {vol.Required("station"): dict})

    # Dial Stations. Configuration and a
    # dry run ONLY: none of the three reaches a player, a queue or the
    # coordinator's refresh -- a preview changes nothing there is to refresh.
    _command("parlorwave_radio/station_dial",
             lambda c, m: c.client.station_dial())
    _command("parlorwave_radio/station_dial_save",
             lambda c, m: c.client.save_station_dial(m.get("presets")),
             {vol.Required("presets"): list})
    _command("parlorwave_radio/station_preview",
             lambda c, m: c.client.station_preview(
                 m.get("intent"), m.get("count", 25), m.get("variant", 0)),
             {vol.Required("intent"): dict, vol.Optional("count"): int,
              vol.Optional("variant"): int})

    # The on-air station (Station Programmer, Mode 2). Two reads -- its state
    # and the speakers it may run on -- and the two commands that are NOT
    # read-only, named as such: START appends a station's opening runway to
    # the ONE speaker the request names (never an inferred one; the backend
    # proves it isolated first), and STOP ends programming and sends
    # nothing to Music Assistant. The target is required by the schema.
    # START is the one command for every way a station begins -- the
    # Station tab, the Request Line (an intent) and the Dial (a preset_id,
    # origin "dial") -- so no caller has a start path of its own.
    _command("parlorwave_radio/station_live",
             lambda c, m: c.client.station_live())
    _command("parlorwave_radio/station_live_targets",
             lambda c, m: c.client.station_live_targets())
    # `handover` is the house speaker's confirmed takeover: the token the
    # backend's handover_required answer gave, what happens to the songs
    # already queued there and, to replace any, each selected song's id. It
    # names nothing else and is checked again by the backend against the
    # queue as it is now.
    _command("parlorwave_radio/station_live_start",
             lambda c, m: c.client.station_live_start(
                 m["target"], preset_id=m.get("preset_id"),
                 intent=m.get("intent"), variant=m.get("variant"),
                 origin=m.get("origin"), handover=m.get("handover")),
             {vol.Required("target"): str, vol.Optional("preset_id"): str,
              vol.Optional("intent"): dict, vol.Optional("variant"): int,
              vol.Optional("origin"): vol.In(("station_tab", "dial")),
              vol.Optional("handover"): {
                  vol.Required("token"): vol.All(str, vol.Length(min=1, max=64)),
                  vol.Required("upcoming"): vol.In(("keep", "replace")),
                  # replace: the songs the person selected, each by id
                  vol.Optional("remove"): vol.All(
                      [vol.All(str, vol.Length(min=1, max=64))],
                      vol.Length(max=64))}})
    _command("parlorwave_radio/station_live_stop",
             lambda c, m: c.client.station_live_stop())
    # The person's answer to a pending Autoplay restore after a house
    # handover (restore | dismiss). Writes at most that one queue's flag.
    _command("parlorwave_radio/station_live_autoplay",
             lambda c, m: c.client.station_live_autoplay(m["decision"]),
             {vol.Required("decision"): vol.In(("restore", "dismiss"))})
    # alpha.4: the Request Line's single song -- ONE item, next, on the
    # speaker the DJ is on now (the backend resolves the speaker and the
    # song; nothing here names a queue).
    _command("parlorwave_radio/request_song",
             lambda c, m: c.client.request_song(m["title"], m.get("artist") or ""),
             {vol.Required("title"): vol.All(str, vol.Length(min=1, max=120)),
              vol.Optional("artist"): vol.All(str, vol.Length(max=120))})

    # A preview is audio for THIS browser and nothing else: the backend
    # synthesizes a line and hands the bytes back. It never reaches Music
    # Assistant, a queue, a break or an announcement. `text` is a short line
    # the owner typed (bounded here and again by the backend).
    async def _preview(coordinator, msg):
        audio, ctype = await coordinator.client.voice_preview(
            msg["voice_id"], msg.get("speed"), msg.get("pause"),
            msg.get("text"))
        import base64
        return {"content_type": ctype,
                "audio_b64": base64.b64encode(audio).decode("ascii")}
    _command("parlorwave_radio/voice_preview", _preview,
             {vol.Required("voice_id"): str,
              vol.Optional("speed"): vol.Coerce(float),
              vol.Optional("pause"): vol.Coerce(float),
              vol.Optional("text"): vol.All(
                  str, vol.Length(max=VOICE_PREVIEW_MAX_CHARS))})

    # NOT read-only, and named as such: the two voice SETTINGS the Booth
    # changes. What a voice is allowed for (dj / announcement / both) is
    # the owner's grant; which allowed voice reads an announcement that
    # names none is a preference that grants nothing. Neither reaches
    # playback. The select entity lists voices by name and scope, so both
    # invalidate the cached shelf.
    async def _voice_setting(coordinator, call):
        result = await call
        coordinator.invalidate_voice_library()
        await coordinator.async_request_refresh()
        return result
    _command("parlorwave_radio/voice_scope",
             lambda c, m: _voice_setting(c, c.client.voice_scope(
                 m["voice_id"], m["scope"])),
             {vol.Required("voice_id"): vol.All(str, vol.Length(min=1, max=64)),
              vol.Required("scope"): vol.In(VOICE_SCOPES)})
    _command("parlorwave_radio/voice_announcement_default",
             lambda c, m: _voice_setting(c, c.client.voice_announcement_default(
                 m.get("voice_id") or "")),
             {vol.Optional("voice_id"): vol.All(str, vol.Length(max=64))})
    # NOT read-only either: Switch DJ selects the next voice allowed to be
    # the DJ. It takes NO argument -- the backend decides the next voice
    # from its own lineup -- and it is the same dj.persona.voice write the
    # Voice select makes: nothing is spoken, no queue is touched, and the
    # next DJ break rendered uses the new voice. The select lists the
    # current voice by name, so the shelf is invalidated like the others.
    _command("parlorwave_radio/voice_switch_dj",
             lambda c, m: _voice_setting(c, c.client.voice_switch_dj()))

    # --- Voice Library ----------------------------------------------------
    # Recordings kept apart from the three Custom slots. Listing and playing
    # are read-only for playback (listing may copy a slot's recording in from
    # the voice engine). Rename / archive / delete change only the library.
    # Assign puts a kept recording into a slot -- the same acknowledged,
    # staged replace the Booth makes -- and keeps the slot's previous
    # recording first. Deleting names the recording, to be sure.
    _command("parlorwave_radio/voice_collection",
             lambda c, m: c.client.voice_collection())

    async def _collection_audio(coordinator, msg):
        audio, ctype = await coordinator.client.voice_collection_audio(
            msg["entry_id"])
        import base64
        return {"content_type": ctype,
                "audio_b64": base64.b64encode(audio).decode("ascii")}
    _entry = vol.All(str, vol.Length(min=16, max=16))
    _command("parlorwave_radio/voice_collection_audio", _collection_audio,
             {vol.Required("entry_id"): _entry})
    _command("parlorwave_radio/voice_collection_rename",
             lambda c, m: c.client.voice_collection_action(
                 m["entry_id"], "rename", {"name": m["name"]}),
             {vol.Required("entry_id"): _entry,
              vol.Required("name"): vol.All(str, vol.Length(min=1, max=40))})
    _command("parlorwave_radio/voice_collection_archive",
             lambda c, m: c.client.voice_collection_action(
                 m["entry_id"], "archive", {"archived": m["archived"]}),
             {vol.Required("entry_id"): _entry,
              vol.Required("archived"): bool})
    _command("parlorwave_radio/voice_collection_assign",
             lambda c, m: _voice_setting(c, c.client.voice_collection_action(
                 m["entry_id"], "assign",
                 {"slot": m["slot"], "authorized": True,
                  "consent_version": m["consent_version"]})),
             {vol.Required("entry_id"): _entry,
              vol.Required("slot"): vol.In(("custom_1", "custom_2",
                                            "custom_3")),
              # the owner's acknowledgement, as at the upload door
              vol.Required("authorized"): True,
              vol.Required("consent_version"): VOICE_CONSENT_VERSION})
    _command("parlorwave_radio/voice_collection_delete",
             lambda c, m: c.client.voice_collection_action(
                 m["entry_id"], "delete", {"confirm": m["confirm"]}),
             {vol.Required("entry_id"): _entry,
              vol.Required("confirm"): vol.All(str, vol.Length(min=1,
                                                               max=40))})

    # NOT read-only: Automatic DJ shifts -- on/off and a voice id per shift
    # ("" = unassigned). The backend refuses a voice not allowed for the
    # DJ; switching on, or changing the current shift's voice, settles the
    # current shift through the same selection write. Nothing is spoken
    # and no queue is touched.
    _command("parlorwave_radio/voice_shifts",
             lambda c, m: _voice_setting(c, c.client.voice_shifts(
                 {k: m[k] for k in ("enabled", "morning", "afternoon", "night")
                  if k in m})),
             {vol.Optional("enabled"): bool,
              vol.Optional("morning"): vol.All(str, vol.Length(max=64)),
              vol.Optional("afternoon"): vol.All(str, vol.Length(max=64)),
              vol.Optional("night"): vol.All(str, vol.Length(max=64))})

    # --- Newsroom ---------------------------------------------------------
    # The Newsroom's own three commands. Two of them are NOT read-only, and
    # that is deliberate and bounded: the bulletin settings are a nested
    # document (a feed URL, a name, a schedule minute) that no entity
    # platform models well, and the backend is the only validator either
    # way. Neither command can reach playback -- saving settings never
    # fetches or contacts Music Assistant, and testing a feed writes
    # nothing -- and the browser still never sees a service credential.

    _command("parlorwave_radio/news_status",
             lambda c, m: c.client.news_status())

    async def _news_save(coordinator, msg):
        result = await coordinator.client.save_news_settings(
            msg.get("bulletins") or {})
        # The Newsroom shows live state; a save that changed the schedule
        # or the source must not leave the screen describing the old one.
        await coordinator.async_request_refresh()
        return result
    _command("parlorwave_radio/news_save", _news_save,
             {vol.Required("bulletins"): dict})

    _command("parlorwave_radio/news_history",
             lambda c, m: c.client.news_history(m.get("limit", 20)),
             {vol.Optional("limit"): int})

    _command("parlorwave_radio/news_test",
             lambda c, m: c.client.test_news_feed(m.get("bulletins")),
             {vol.Optional("bulletins"): dict})

    # --- the two optional services ----------------------------------------
    # Reading, saving and testing a Chatterbox-compatible voice engine and
    # an external writing model. The save is a settings write and nothing
    # else; the test is one bounded probe. Neither can reach playback, and
    # the browser never holds a service credential -- it is stored in the
    # backend and never returned.

    async def _services_read(coordinator, _msg):
        """The settings, with the backend's credential vocabulary left
        behind. The panel learns only WHETHER a key is saved -- never the
        key, and never the word the store keeps it under."""
        data = await coordinator.client.services_settings()
        out = dict(data or {})
        # The backend answers {ok, section, settings:{...}, ...} like every
        # other settings route; the two service documents are INSIDE
        # `settings`, and reading them off the top level silently produced
        # an empty form with every box blank and every switch off.
        stored = dict(out.get("settings") or {})
        for kind in ("voice_engine", "writer"):
            cfg = dict(stored.get(kind) or {})
            cfg["key_saved"] = bool(cfg.pop("api_key_set", False))
            cfg.pop("api_key", None)
            stored[kind] = cfg
        out["settings"] = stored
        return out
    _command("parlorwave_radio/services", _services_read)

    _command("parlorwave_radio/services_status",
             lambda c, m: c.client.services_status())

    async def _services_save(coordinator, msg):
        # The panel speaks of a `key`; the backend stores an `api_key`. The
        # rename is deliberate and lives HERE: the panel is the one place a
        # credential must never look at home, and a source-level test bans
        # the backend's own vocabulary for a credential from appearing in
        # it at all.
        patch = {}
        for kind, cfg in (msg.get("services") or {}).items():
            if kind not in ("voice_engine", "writer"):
                continue
            cfg = dict(cfg or {})
            if "key" in cfg:
                cfg["api_key"] = cfg.pop("key")
            patch[kind] = cfg
        result = await coordinator.client.save_services_settings(patch)
        # A service switched on or off changes what Settings reports about
        # the station; a save that is not reflected reads as one that did
        # not happen.
        await coordinator.async_request_refresh()
        return result
    _command("parlorwave_radio/services_save", _services_save,
             {vol.Required("services"): dict})

    # THE BUTTON SITS UNDER THE ADDRESS FIELD, so it answers for that field:
    # the address (and a key, if one was typed rather than already saved)
    # travel with the request, are used for one call and are stored nowhere.
    # Testing before saving is the ordinary way a person finds out whether
    # what they just typed is right.
    def _test_override(msg):
        """What is on the screen, in the store's vocabulary.

        The browser says `key`, as it does everywhere else: the store's own
        word for a credential is not a word the panel is allowed to learn,
        and this is the one place the two meet -- the same translation
        services_save does."""
        out = {k: msg[k] for k in ("base_url", "provider", "model", "voice")
               if msg.get(k)}
        if msg.get("key"):
            out["api_key"] = msg["key"]
        return out or None

    _command("parlorwave_radio/service_test",
             lambda c, m: c.client.test_service(m["kind"], _test_override(m)),
             {vol.Required("kind"): vol.In(("voice_engine", "writer")),
              vol.Optional("base_url"): vol.All(cv.string, vol.Length(max=500)),
              vol.Optional("key"): vol.All(cv.string, vol.Length(max=500)),
              vol.Optional("provider"): vol.All(cv.string, vol.Length(max=60)),
              vol.Optional("model"): vol.All(cv.string, vol.Length(max=120)),
              vol.Optional("voice"): vol.All(cv.string, vol.Length(max=120))})

    # Finding a writing model: a short list of named addresses, tried in
    # order. Bounded on the backend and never a network scan.
    _command("parlorwave_radio/writer_find",
             # The protocol is whichever the BACKEND offered in
             # writer_providers; naming a default here would bake an
             # inference host into the integration.
             lambda c, m: c.client.find_writer(m.get("base_url") or "",
                                               m.get("provider") or ""),
             {vol.Optional("base_url"): vol.All(cv.string, vol.Length(max=500)),
              vol.Optional("provider"): vol.All(cv.string, vol.Length(max=60))})

    # --- Test Calendar -----------------------------------------------------
    # Answers ONE question honestly: what can Parlorwave see of this
    # calendar right now? Both halves of the path are reported, because
    # they fail differently and were previously indistinguishable --
    # Home Assistant may have no calendar selected or an unavailable one,
    # and the backend may simply never have received a snapshot.
    #
    # It republishes first, so the answer describes the calendar as it is
    # now rather than as it was up to ten minutes ago. Publishing stores
    # facts and nothing else: it plans no break, renders nothing and never
    # touches a queue. Event summaries come back for the screen because the
    # person who pressed the button owns the calendar; they are not logged.

    async def _calendar_test(coordinator, msg):
        publisher = getattr(coordinator, "context_publisher", None)
        # The publisher's OWN list, not the entry's: it is what actually
        # gets read every ten minutes, and a diagnostic that consults a
        # different copy can say "configured" about a calendar nothing is
        # reading.
        selected = list(getattr(publisher, "calendar_entities", None) or [])
        out: dict[str, object] = {"selected": selected, "entities": [],
                                  "published": False, "backend": None}
        if not selected:
            out["state"] = "no_calendar_selected"
            return out
        for entity_id in selected:
            state = hass.states.get(entity_id)
            out["entities"].append({
                "entity_id": entity_id,
                "name": (state.attributes.get("friendly_name")
                         if state else None) or entity_id,
                "available": bool(state is not None
                                  and state.state not in ("unavailable",
                                                          "unknown")),
            })
        if publisher is not None and not publisher.stopped:
            await publisher.async_publish()
            out["published"] = bool((publisher.status or {}).get("ok"))
            out["publish_error"] = (publisher.status or {}).get("error")
        out["backend"] = (await coordinator.client.calendar_diagnosis()
                          ).get("calendar")
        if not any(e["available"] for e in out["entities"]):
            out["state"] = "calendar_unavailable"
        elif not out["published"]:
            out["state"] = "publish_failed"
        elif not (out["backend"] or {}).get("received"):
            out["state"] = "backend_has_no_context"
        else:
            out["state"] = "ok"
        return out
    _command("parlorwave_radio/calendar_test", _calendar_test)

    async def _weather_test(coordinator, msg):
        """The same shape as the calendar test, for the other half of the
        context the DJ is given. Republish first, then ask the backend what
        it now holds -- the two fail differently and the answer has to say
        which: no entity chosen, the entity not reporting, the publish
        failing, the station holding no snapshot, or a working weather
        with the sentence a break would carry."""
        publisher = getattr(coordinator, "context_publisher", None)
        # The publisher's OWN entity, not the entry's: it is what actually
        # gets read, and a diagnostic that consults a different copy can
        # say "configured" about an entity nothing is reading.
        selected = getattr(publisher, "weather_entity", None) or None
        out: dict[str, object] = {"selected": selected, "entity": None,
                                  "published": False, "backend": None}
        if not selected:
            out["state"] = "no_weather_selected"
            return out
        state = hass.states.get(selected)
        available = bool(state is not None
                         and state.state not in ("unavailable", "unknown"))
        out["entity"] = {
            "entity_id": selected,
            "name": (state.attributes.get("friendly_name")
                     if state else None) or selected,
            "available": available,
        }
        if publisher is not None and not publisher.stopped:
            await publisher.async_publish()
            out["published"] = bool((publisher.status or {}).get("ok"))
            out["publish_error"] = (publisher.status or {}).get("error")
        out["backend"] = (await coordinator.client.weather_diagnosis()
                          ).get("weather")
        if not available:
            out["state"] = "weather_unavailable"
        elif not out["published"]:
            out["state"] = "publish_failed"
        elif not (out["backend"] or {}).get("received"):
            out["state"] = "backend_has_no_context"
        else:
            out["state"] = "ok"
        return out
    _command("parlorwave_radio/weather_test", _weather_test)

    # --- DJ-enabled speakers ----------------------------------------------
    # WHICH SPEAKERS PARLORWAVE RADIO MAY DJ ON, read and written from the
    # panel's own Settings screen.
    #
    # This moves no store of record. `settings.dj.outputs.enabled` in the
    # backend has always been the one copy of this list -- the integration's
    # options form never held it either, it only read it over the API and
    # wrote it back through set_enabled_outputs. The options form was simply
    # where the UI happened to be, and that placement is what sent people to
    # Devices & services, past a device page whose "Output" selector looks
    # like speaker setup and is not, to a gear icon nothing told them to
    # press. Two commands later the same two API calls are reachable from
    # the screen that is already about setup, and the options form keeps
    # working unchanged for anyone who goes there instead.
    #
    # Because the store did not move, there is nothing to migrate and no
    # state that can disagree with itself: an installation that already had
    # a speaker enabled still has it, and either surface shows what the
    # other one wrote.

    async def _outputs(coordinator, msg):
        from .config_flow import output_choices
        outputs = await coordinator.client.outputs()
        if not isinstance(outputs, dict) or not outputs.get("ok"):
            # Music Assistant could not be read. Say so; do NOT return an
            # empty inventory that a save could then write over the list.
            return {"ok": False, "reason": str(outputs.get("reason") or "unavailable"),
                    "speakers": [], "enabled": [], "selected": ""}
        dj = (await coordinator.client.dj_settings()).get("settings") or {}
        choices, enabled = output_choices(outputs, dj)
        return {"ok": True,
                "speakers": [{"id": c["value"], "name": c["label"]} for c in choices],
                "enabled": list(enabled),
                "selected": str(outputs.get("selected") or "")}
    _command("parlorwave_radio/outputs", _outputs)

    async def _outputs_set(coordinator, msg):
        """Write the allow-list. The ONE write path is the client method the
        options flow already used, so both surfaces reach the backend the
        same way. Ids are filtered against the inventory the backend just
        offered, exactly as the options flow filters them: a stale browser
        cannot introduce a player Music Assistant never reported."""
        from .config_flow import output_choices
        outputs = await coordinator.client.outputs()
        if not isinstance(outputs, dict) or not outputs.get("ok"):
            raise RadioServiceError("Music Assistant could not be read")
        dj = (await coordinator.client.dj_settings()).get("settings") or {}
        choices, _enabled = output_choices(outputs, dj)
        offered = {c["value"] for c in choices}
        chosen = [str(pid) for pid in (msg.get("enabled") or []) if str(pid) in offered]
        await coordinator.client.set_enabled_outputs(chosen)
        # The DJ status sensor carries the enabled list; a save that is not
        # reflected on screen reads as a save that did not happen.
        await coordinator.async_request_refresh()
        return {"ok": True, "enabled": chosen}
    _command("parlorwave_radio/outputs_set", _outputs_set,
             {vol.Required("enabled"): [str]})

    # --- the weather entity and the calendars ----------------------------
    # WHICH HOME ASSISTANT ENTITIES THE DJ MAY READ, chosen from the
    # panel's own Settings screen.
    #
    # The store of record is the config entry's OPTIONS (CONF_WEATHER_ENTITY
    # and CONF_CALENDAR_ENTITIES), exactly where the options flow has
    # always written them: nothing moves and nothing is copied, so the
    # options flow and this screen can never disagree. The write is Home
    # Assistant's own `async_update_entry(options=...)`, which is the one
    # supported way to change an entry's options from inside an
    # integration; it is gated as the options flow is (administrators).
    # The inventory is what Home Assistant currently has in the weather
    # and calendar domains -- names and availability only; no state, no
    # forecast, no event ever travels here.
    #
    # A selection is never made for anybody: a newly discovered calendar
    # is offered unticked, nothing selected is a valid state for both,
    # and an entity that was chosen and has since disappeared from Home
    # Assistant stays chosen (and is reported as missing) until a person
    # unticks it -- a stale selection is theirs to end, not this code's.

    def _entry_of(coordinator):
        for entry_id, c in (hass.data.get(DOMAIN) or {}).items():
            if c is coordinator:
                return hass.config_entries.async_get_entry(entry_id)
        return None

    def _context_inventory(coordinator, entry):
        options = entry.options if entry is not None else {}
        status = getattr(coordinator, "context_status", None) or {}
        publisher = getattr(coordinator, "context_publisher", None)
        weather_selected = str(options.get(CONF_WEATHER_ENTITY) or "")
        calendars_selected = [str(e) for e in (options.get(CONF_CALENDAR_ENTITIES) or []) if e]
        failed = {str(e) for e in ((status.get("calendar") or {}).get("failed") or [])}

        def row(state, entity_id, selected):
            name = (state.attributes.get("friendly_name") if state is not None else None) or entity_id
            return {"entity_id": entity_id, "name": str(name),
                    "available": bool(state is not None and state.state not in ("unavailable", "unknown")),
                    "selected": selected, "missing": state is None}

        def rows(domain, selected_ids):
            out = [row(st, st.entity_id, st.entity_id in selected_ids)
                   for st in hass.states.async_all(domain)]
            present = {r["entity_id"] for r in out}
            out.sort(key=lambda r: (r["name"].casefold(), r["entity_id"]))
            # chosen once, gone now: still listed, still chosen, said so
            out.extend(row(None, e, True) for e in selected_ids if e not in present)
            return out

        calendars = rows("calendar", calendars_selected)
        for r in calendars:
            r["failed"] = r["entity_id"] in failed
        return {
            "ok": True,
            "weather": {"selected": weather_selected,
                        "live": getattr(publisher, "weather_entity", None) or "",
                        "entities": rows("weather", [weather_selected] if weather_selected else [])},
            "calendars": {"selected": calendars_selected,
                          "live": list(getattr(publisher, "calendar_entities", None) or []),
                          "entities": calendars},
        }

    async def _pending_by_calendar(coordinator) -> tuple[dict[str, int], bool]:
        """(scheduled announcements per calendar, whether unticking a
        calendar cancels them). Best effort: a backend that cannot say is
        an empty answer, not a failed read.

        Only SCHEDULED occurrences count: a committed one is already with
        the player and an invalid one never airs, so neither is something
        unticking could cancel or keep.

        WHAT UNTICKING DOES DEPENDS ON THE BACKEND, and the screen must say
        the true one. The current backend
        keeps a scheduled occurrence whose calendar is no longer observed,
        and airs it. A backend that cancels them on deselection says so
        with `selection_enforced: true` in /announcements/status; anything
        else is read as keeping them. Erring that way is the safe direction: "they
        still air" about announcements that were in fact cancelled costs a
        person an unnecessary delete, the opposite costs an announcement
        nobody expected to hear."""
        try:
            status = await coordinator.client.announcements_status()
        except RadioServiceError:
            return {}, False
        if not isinstance(status, dict):
            return {}, False
        counts: dict[str, int] = {}
        for occ in status.get("upcoming") or []:
            if not isinstance(occ, dict) or occ.get("state") != "scheduled":
                continue
            source = str(occ.get("source") or "")
            if source:
                counts[source] = counts.get(source, 0) + 1
        return counts, status.get("selection_enforced") is True

    async def _context_sources(coordinator, msg):
        out = _context_inventory(coordinator, _entry_of(coordinator))
        out["pending"], out["deselect_cancels"] = await _pending_by_calendar(coordinator)
        return out
    _command("parlorwave_radio/context_sources", _context_sources)

    async def _context_sources_set(coordinator, msg):
        """Write the selection. `weather` (an entity id or "" for none) and
        `calendars` (a list) are each optional: a field left out, or sent
        as null, is left as it is, so the two selectors save independently.
        An entity that is not in Home Assistant is refused unless it is
        already chosen -- a stale browser cannot introduce one, and a
        chosen entity that has gone away may still be kept. The new
        selection is applied to the publisher before answering, so the
        read that follows sees it live."""
        entry = _entry_of(coordinator)
        if entry is None:
            raise RadioServiceError("ParlorWave Radio is not set up")
        options = dict(entry.options)
        current_weather = str(options.get(CONF_WEATHER_ENTITY) or "")
        current_calendars = [str(e) for e in (options.get(CONF_CALENDAR_ENTITIES) or []) if e]
        if msg.get("weather") is not None:
            want = str(msg["weather"]).strip()
            if want and (not want.startswith("weather.")
                         or (want != current_weather and hass.states.get(want) is None)):
                raise RadioServiceError("That weather entity is not in Home Assistant")
            options[CONF_WEATHER_ENTITY] = want
        if msg.get("calendars") is not None:
            want_list: list[str] = []
            for raw in msg["calendars"]:
                e = str(raw).strip()
                if not e or e in want_list:
                    continue
                if not e.startswith("calendar.") or (
                        e not in current_calendars and hass.states.get(e) is None):
                    raise RadioServiceError("That calendar is not in Home Assistant")
                want_list.append(e)
            options[CONF_CALENDAR_ENTITIES] = want_list
        changed = bool(hass.config_entries.async_update_entry(entry, options=options))
        if changed:
            await _apply_context_options(hass, entry, coordinator)
        out = _context_inventory(coordinator, entry)
        out["changed"] = changed
        out["pending"], out["deselect_cancels"] = await _pending_by_calendar(coordinator)
        return out
    _command("parlorwave_radio/context_sources_set", _context_sources_set,
             {vol.Optional("weather"): vol.Any(None, cv.string),
              vol.Optional("calendars"): vol.Any(None, [cv.string])},
             admin=True)

    # --- entity identity ---------------------------------------------------
    # WHICH ENTITY IS WHICH, answered by the registry instead of by reading
    # names off a screen.
    #
    # The panel used to find its entities by matching `friendly_name`
    # against the string "parlorwave radio" plus a hint. Home Assistant
    # composes that name from the DEVICE's name, which a person may change
    # in one click and which several people reasonably do -- and every
    # control on every screen disappeared when they did, because nothing
    # was called "Parlorwave Radio ..." any more.
    #
    # `unique_id` is the identity that cannot drift: entity.py mints it as
    # f"{entry_id}_{key}", it survives renames, reloads and entity-id
    # changes, and it is already the integration's own vocabulary. This
    # command publishes the key -> entity_id map from the entity registry
    # and nothing else. Read-only; no state, no attributes, no names.

    async def _entities(coordinator, msg):
        from homeassistant.helpers import entity_registry as er
        registry = er.async_get(hass)
        out: dict[str, str] = {}
        for entry_id in list((hass.data.get(DOMAIN) or {}).keys()):
            prefix = f"{entry_id}_"
            for entity in list(getattr(registry, "entities", {}).values()):
                unique_id = str(getattr(entity, "unique_id", "") or "")
                if not unique_id.startswith(prefix):
                    continue
                if getattr(entity, "disabled_by", None):
                    continue
                out[unique_id[len(prefix):]] = entity.entity_id
        return {"entities": out}
    _command("parlorwave_radio/entities", _entities)

    # --- Settings ---------------------------------------------------------
    # ONE read-only command, and the whole Settings screen. It returns the
    # readiness view model (readiness.py) rather than the health report:
    # the panel is handed sentences, never the service's own diagnostic
    # vocabulary, and a token, a key, a filesystem path or an internal
    # hostname cannot reach a browser because none of them is ever put in
    # the document. Nothing here writes, and nothing here can reach
    # playback.

    async def _readiness(coordinator, msg):
        from . import readiness
        news = None
        try:
            news = await coordinator.client.news_status()
        except RadioServiceError:
            # The Newsroom is one optional row on this screen. Failing to
            # read it must not fail the screen that would have explained
            # what else is wrong.
            _LOGGER.debug("newsroom status unavailable for Settings")
        ctx = getattr(coordinator, "context_status", None) or {}
        named = [ctx.get("weather", {}).get("entity")] + list(
            (ctx.get("calendar") or {}).get("entities") or [])
        return {"readiness": readiness.build(
            coordinator.data or {},
            # The snapshot outlives the service: while it is not answering
            # the last good answer must not be presented as the current one.
            connected=bool(getattr(coordinator, "last_update_success", True)),
            key_refused=_key_refused(coordinator),
            context=ctx,
            news=news,
            entity_names=readiness.entity_names_for(
                hass.states.get, [e for e in named if e]),
            tts_entities=_tts_entity_count(hass),
            version=hass.data.get(DATA_VERSION))}
    _command("parlorwave_radio/readiness", _readiness)


def _tts_entity_count(hass: HomeAssistant) -> int:
    """How many text-to-speech voices this Home Assistant actually has.

    The backend can say it is allowed to reach Home Assistant; only Home
    Assistant knows whether anything there can speak. A fresh Home
    Assistant OS install with no Piper and no Cloud has none, and that is
    the difference between "speech is configured" and "there is a voice",
    which is exactly what a first-run screen has to be able to say."""
    try:
        return sum(1 for state in hass.states.async_all()
                   if str(state.entity_id).startswith("tts."))
    except Exception:  # noqa: BLE001 - a count must never fail a status read
        return 0
