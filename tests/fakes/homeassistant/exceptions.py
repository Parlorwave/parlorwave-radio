class HomeAssistantError(Exception):
    pass


class ServiceNotFound(HomeAssistantError):
    pass


class ConfigEntryError(HomeAssistantError):
    """Setup failed for a reason a retry will not change."""


class ConfigEntryAuthFailed(ConfigEntryError):
    """The backend refused the stored credentials (starts reauth)."""


class ConfigEntryNotReady(HomeAssistantError):
    """Setup should be retried later."""
