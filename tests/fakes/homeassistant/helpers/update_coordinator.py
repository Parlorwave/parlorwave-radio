class UpdateFailed(Exception):
    pass


class DataUpdateCoordinator:
    def __class_getitem__(cls, item):
        return cls

    def __init__(self, hass, logger, *, name, update_interval=None, **kwargs):
        self.hass = hass
        self.logger = logger
        self.name = name
        self.update_interval = update_interval
        self.data = {}
        self.refreshes = 0
        # the real coordinator's own flag; entities read it through
        # CoordinatorEntity.available
        self.last_update_success = True

    async def _async_update_data(self):
        return {}

    async def async_config_entry_first_refresh(self):
        self.data = await self._async_update_data()
        self.refreshes += 1

    async def async_request_refresh(self):
        self.data = await self._async_update_data()
        self.refreshes += 1

    async_refresh = async_request_refresh


class CoordinatorEntity:
    hass = None

    def __class_getitem__(cls, item):
        return cls

    def __init__(self, coordinator):
        self.coordinator = coordinator

    @property
    def available(self) -> bool:
        return bool(getattr(self.coordinator, "last_update_success", True))
