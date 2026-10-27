"""Switches: The DJ, whether it speaks, whether it tells music stories,
Endless Radio, and what breaks may draw on.

Three deliberately separate ideas the backend also keeps separate: whether
the DJ is RUNNING at all (settings.dj.enabled), whether it SPEAKS its
breaks (settings.dj.speech_enabled), and whether the MUSIC keeps itself
going (settings.playback.keep_radio_playing). Turning the DJ off must
never silence the station, and vice versa. Turning DJ speech off keeps the
DJ running -- planning, the station, requests -- and silences only its
breaks; news and announcements are not DJ breaks and keep their own
switches.

The break-content switches (settings.dj.content) decide which standing
context -- weather, calendar, news headlines -- the next break may mention.
They shape what the DJ says, never whether music plays."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.exceptions import HomeAssistantError

from .api import RadioServiceError
from .const import BREAK_CONTENT
from .entity import CatalogGatedEntity, ParlorwaveRadioEntity


async def async_setup_entry(hass, entry, async_add_entities):
    coordinator = hass.data["parlorwave_radio"][entry.entry_id]
    entities = [DjEnabledSwitch(coordinator, entry.entry_id),
                DjSpeechSwitch(coordinator, entry.entry_id),
                DjStoriesSwitch(coordinator, entry.entry_id),
                EndlessRadioSwitch(coordinator, entry.entry_id)]
    entities += [BreakContentSwitch(coordinator, entry.entry_id, key, name)
                 for key, name in BREAK_CONTENT.items()]
    entities.append(SameArtistSwitch(coordinator, entry.entry_id))
    async_add_entities(entities)


class _SettingsSwitch(ParlorwaveRadioEntity, SwitchEntity):
    async def _write(self, call, value: bool) -> None:
        try:
            await call(value)
        except RadioServiceError as exc:
            raise HomeAssistantError(str(exc)) from exc
        # Immediate, not debounced: the requested kind of refresh waits
        # out the coordinator's cooldown when a poll has just run, which left the
        # DJ switch showing its old state for up to ten seconds after a
        # write the service had already accepted.
        await self.coordinator.async_refresh()


class DjEnabledSwitch(_SettingsSwitch):
    _attr_name = "DJ"
    _attr_icon = "mdi:account-voice"

    def __init__(self, coordinator, entry_id: str) -> None:
        super().__init__(coordinator, entry_id, "dj_enabled")

    @property
    def is_on(self) -> bool | None:
        settings = self.coordinator.data.get("dj_settings") or {}
        value = settings.get("enabled")
        return bool(value) if value is not None else None

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self._write(self.coordinator.client.set_dj_enabled, True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._write(self.coordinator.client.set_dj_enabled, False)


class DjSpeechSwitch(_SettingsSwitch):
    """Speak DJ breaks. Separate from the DJ switch on purpose: off keeps
    the DJ's planning and the station running and only stops the DJ
    talking between songs. A missing value (a service from before this
    setting existed) reads as unknown, never as a guess."""

    _attr_name = "Speak DJ breaks"
    _attr_icon = "mdi:microphone-message"

    def __init__(self, coordinator, entry_id: str) -> None:
        super().__init__(coordinator, entry_id, "dj_speech")

    @property
    def is_on(self) -> bool | None:
        settings = self.coordinator.data.get("dj_settings") or {}
        value = settings.get("speech_enabled")
        return bool(value) if value is not None else None

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self._write(self.coordinator.client.set_dj_speech_enabled, True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._write(self.coordinator.client.set_dj_speech_enabled, False)


class DjStoriesSwitch(_SettingsSwitch):
    """Music stories: the listener's own preference (settings.dj.
    stories_enabled, on by default). It is NOT the rollout gate
    (dj.stories_rollout), which no entity exposes -- stories air only when
    both allow them. A service from before stories existed reports no
    value, and the switch reads unknown.

    So "on" alone does not mean stories air: `airing` says whether they can
    right now, as the service decides it (/dj/status `stories_active`). A
    service that does not report it gets no attribute rather than a guess."""

    _attr_name = "Music stories"
    _attr_icon = "mdi:book-music"

    def __init__(self, coordinator, entry_id: str) -> None:
        super().__init__(coordinator, entry_id, "dj_stories")

    @property
    def is_on(self) -> bool | None:
        settings = self.coordinator.data.get("dj_settings") or {}
        value = settings.get("stories_enabled")
        return bool(value) if value is not None else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        active = (self.coordinator.data.get("dj_status") or {}).get(
            "stories_active")
        return {"airing": active} if isinstance(active, bool) else {}

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self._write(self.coordinator.client.set_dj_stories_enabled, True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._write(self.coordinator.client.set_dj_stories_enabled,
                          False)


class EndlessRadioSwitch(CatalogGatedEntity, _SettingsSwitch):
    """Keeping the station playing means REFILLING it, which means picking
    music -- so it needs a local catalog to pick from. Unavailable without
    one; see entity.CatalogGatedEntity."""

    _attr_name = "Endless radio"
    _attr_icon = "mdi:infinity"

    def __init__(self, coordinator, entry_id: str) -> None:
        super().__init__(coordinator, entry_id, "endless_radio")

    @property
    def is_on(self) -> bool | None:
        settings = self.coordinator.data.get("playback_settings") or {}
        value = settings.get("keep_radio_playing")
        return bool(value) if value is not None else None

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self._write(self.coordinator.client.set_keep_radio_playing, True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._write(self.coordinator.client.set_keep_radio_playing, False)


class BreakContentSwitch(_SettingsSwitch):
    _attr_icon = "mdi:text-box-check"

    def __init__(self, coordinator, entry_id: str, key: str, name: str) -> None:
        super().__init__(coordinator, entry_id, f"content_{key}")
        self._key = key
        self._attr_name = name

    @property
    def is_on(self) -> bool | None:
        content = (self.coordinator.data.get("dj_settings") or {}).get(
            "content") or {}
        value = content.get(self._key)
        return bool(value) if value is not None else None

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self._write(
            lambda on: self.coordinator.client.set_break_content(self._key, on),
            True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._write(
            lambda on: self.coordinator.client.set_break_content(self._key, on),
            False)


class SameArtistSwitch(CatalogGatedEntity, _SettingsSwitch):
    """Allow the DJ to place two tracks by the same artist back to
    back in the AUTONOMOUS runway. Off spreads artists apart. A settings
    write only; never touches manual/adopted/album playback -- which is
    also why it is unavailable with no catalog: the autonomous runway is
    the only thing it shapes, and that runway does not exist."""

    _attr_name = "Back-to-back same artist"
    _attr_icon = "mdi:account-music"

    def __init__(self, coordinator, entry_id: str) -> None:
        super().__init__(coordinator, entry_id, "same_artist")

    @property
    def is_on(self) -> bool | None:
        sa = (self.coordinator.data.get("station_settings") or {}).get(
            "same_artist") or {}
        value = sa.get("enabled")
        return bool(value) if value is not None else None

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self._write(self.coordinator.client.set_same_artist_enabled,
                          True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._write(self.coordinator.client.set_same_artist_enabled,
                          False)
