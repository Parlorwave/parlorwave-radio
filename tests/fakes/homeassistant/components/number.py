"""The slice of homeassistant.components.number these tests rely on.

Same rule as helpers/entity: real Home Assistant exposes each `_attr_x`
through a property `x`, and those properties are what the UI, the
automation editor and a `number.set_value` call all read. A fake that
omitted them made the advertised RANGE of a number entity untestable --
which is exactly the thing that turned out to disagree with the service.
"""

from homeassistant.helpers.entity import Entity


class NumberEntity(Entity):
    _attr_native_min_value = 0.0
    _attr_native_max_value = 100.0
    _attr_native_step = 1.0
    _attr_native_unit_of_measurement = None
    _attr_mode = None

    @property
    def native_min_value(self):
        return self._attr_native_min_value

    @property
    def native_max_value(self):
        return self._attr_native_max_value

    @property
    def native_step(self):
        return self._attr_native_step

    @property
    def native_unit_of_measurement(self):
        return self._attr_native_unit_of_measurement

    @property
    def mode(self):
        return self._attr_mode


class NumberMode:
    SLIDER = 'slider'
    BOX = 'box'
