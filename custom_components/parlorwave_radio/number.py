"""Number: break cadence in minutes (settings.dj.programming)."""

from __future__ import annotations

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.exceptions import HomeAssistantError

from .api import RadioServiceError
from .const import CADENCE_MAX, CADENCE_MIN
from .entity import ParlorwaveRadioEntity


async def async_setup_entry(hass, entry, async_add_entities):
    coordinator = hass.data["parlorwave_radio"][entry.entry_id]
    async_add_entities([CadenceNumber(coordinator, entry.entry_id)])


class CadenceNumber(ParlorwaveRadioEntity, NumberEntity):
    _attr_name = "Break cadence"
    _attr_icon = "mdi:metronome"
    _attr_native_min_value = CADENCE_MIN
    _attr_native_max_value = CADENCE_MAX
    _attr_native_step = 1
    _attr_native_unit_of_measurement = "min"
    _attr_mode = NumberMode.BOX

    def __init__(self, coordinator, entry_id: str) -> None:
        super().__init__(coordinator, entry_id, "cadence")

    @property
    def native_value(self) -> float | None:
        prog = (self.coordinator.data.get("dj_settings") or {}).get(
            "programming") or {}
        value = prog.get("cadence_min_minutes")
        return float(value) if isinstance(value, (int, float)) else None

    async def async_set_native_value(self, value: float) -> None:
        try:
            await self.coordinator.client.set_cadence_minutes(int(value))
        except RadioServiceError as exc:
            raise HomeAssistantError(str(exc)) from exc
        await self.coordinator.async_request_refresh()
