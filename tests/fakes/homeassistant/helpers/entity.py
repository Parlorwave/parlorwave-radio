"""The slice of homeassistant.helpers.Entity these tests rely on.

Real Home Assistant exposes `_attr_x` through a property `x`; that
indirection is what the entity registry and the device page read, so a fake
that omitted it made those surfaces untestable. Only the three attributes
the integration sets are modelled.

`_unrecorded_attributes` is modelled the way real Home Assistant does it,
mangled name and all: a subclass sets it, `__init_subclass__` folds it
into `__combined_unrecorded_attributes`, and the entity hands that to the
recorder through `state_info`. A fake that merely stored the frozenset
would let a test pass while the recorder recorded everything -- which is
a defect that is easy to ship unseen, so the combining is modelled
rather than assumed.
"""


class Entity:
    _attr_unique_id = None
    _attr_name = None
    _attr_device_info = None
    _attr_icon = None

    _entity_component_unrecorded_attributes: frozenset[str] = frozenset()
    _unrecorded_attributes: frozenset[str] = frozenset()
    # set automatically by __init_subclass__, as in real Home Assistant
    __combined_unrecorded_attributes: frozenset[str] = (
        _entity_component_unrecorded_attributes | _unrecorded_attributes
    )

    def __init_subclass__(cls, **kwargs) -> None:
        super().__init_subclass__(**kwargs)
        cls.__combined_unrecorded_attributes = (
            cls._entity_component_unrecorded_attributes | cls._unrecorded_attributes
        )

    @property
    def state_info(self):
        """What EntityPlatform publishes for the recorder to read."""
        return {"unrecorded_attributes": self.__combined_unrecorded_attributes}

    @property
    def unique_id(self):
        return self._attr_unique_id

    @property
    def name(self):
        return self._attr_name

    @property
    def device_info(self):
        return self._attr_device_info

    @property
    def icon(self):
        return self._attr_icon

    @property
    def available(self) -> bool:
        return True
