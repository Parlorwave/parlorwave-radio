class RegistryEntry:
    def __init__(self, unique_id, entity_id, disabled_by=None, config_entry_id=None, platform="parlorwave_radio", domain=None):
        self.unique_id = unique_id
        self.entity_id = entity_id
        self.disabled_by = disabled_by
        self.config_entry_id = config_entry_id
        self.platform = platform
        self.domain = domain or (entity_id.split(".", 1)[0] if "." in entity_id else "")


class _Registry:
    def __init__(self):
        self.entities = {}

    def async_get(self, entity_id):
        return self.entities.get(entity_id)

    def async_remove(self, entity_id):
        self.entities.pop(entity_id, None)

    def async_get_entity_id(self, domain, platform, unique_id):
        for entity_id, entry in self.entities.items():
            if getattr(entry, "unique_id", None) == unique_id:
                if getattr(entry, "platform", None) == platform or entity_id.startswith(f"{domain}."):
                    return entity_id
        return None


def async_get(hass):
    return hass.data.setdefault("_fake_entity_registry", _Registry())


def async_entries_for_config_entry(registry, config_entry_id):
    return [
        e for e in getattr(registry, "entities", {}).values()
        if getattr(e, "config_entry_id", None) == config_entry_id
    ]

