"""Shared entity base: one Parlorwave Radio device, coordinator-backed."""

from __future__ import annotations

from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import ParlorwaveRadioCoordinator


class ParlorwaveRadioEntity(CoordinatorEntity[ParlorwaveRadioCoordinator]):
    _attr_has_entity_name = True

    def __init__(self, coordinator: ParlorwaveRadioCoordinator, entry_id: str,
                 key: str) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry_id}_{key}"
        # The device card, which is customer-visible and was not written
        # for a customer. `manufacturer="DJ"` read as a vendor called DJ;
        # `configuration_url` pointed at the backend's own address on the
        # internal add-on network (http://local-parlorwave-radio:5005),
        # which no browser on the house network can open -- a "Visit
        # device" link that always fails, advertising an internal hostname
        # while it did. The add-on's configuration has no stable address
        # Home Assistant will give us, so the field is left unset rather
        # than filled with a link that cannot work.
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry_id)},
            name="ParlorWave Radio",
            manufacturer="ParlorWave",
            model="ParlorWave Radio",
        )


class CatalogGatedEntity(ParlorwaveRadioEntity):
    """An entity that can only do something on an installation with a local
    Parlorwave music catalog.

    Endless refill, station feel and artist rotation all shape music the
    STATION picks. An installation with no catalog picks nothing -- Music
    Assistant programmes, Parlorwave presents -- so these controls have
    nothing to act on. The Station screen already knows that and does not
    draw them; the device page and the automation editor did not, and
    offered four working-looking controls whose writes could never change
    what anybody heard.

    Unavailable, not removed: the entity id survives, so an automation
    written on an installation that later gains a catalog still resolves,
    and Home Assistant says plainly that the control cannot act right now.
    The verdict is the backend's published capability, read through the
    coordinator -- never re-derived here."""

    @property
    def available(self) -> bool:
        return super().available and bool(
            self.coordinator.music_catalog(self.coordinator.data or {}).get(
                "usable"))


def ma_entity_for(hass: HomeAssistant, player_id: str) -> str | None:
    """The Music Assistant integration's OWN entity for an MA player, or None.

    MA's HA entities differ from MA player ids (MA player
    'media_player.loft' is driven through HA entity
    'media_player.loft_speaker'), and sendspin/browser players
    only have an entity while their tab is open. The entity registry is the
    authoritative mapping: MA entities carry the MA player id inside their
    unique_id. Name heuristics are exactly what this replaces.
    """
    if not player_id:
        return None
    registry = er.async_get(hass)
    candidates = [e for e in registry.entities.values()
                  if e.platform == "music_assistant"
                  and e.domain == "media_player"
                  and player_id in (e.unique_id or "")]
    if len(candidates) == 1:
        return candidates[0].entity_id
    if player_id.startswith("media_player.") and not candidates:
        # Caller handed an HA entity that IS an MA entity already.
        entry = registry.async_get(player_id)
        if entry and entry.platform == "music_assistant":
            return player_id
    if candidates:
        # Prefer a non-disabled entry deterministically.
        enabled = [e for e in candidates if not e.disabled_by]
        return (enabled or candidates)[0].entity_id
    return None
