import logging

_LOGGER = logging.getLogger(__name__)
DATA_PANELS = "frontend_panels"


def async_remove_panel(hass, frontend_url_path, *, warn_if_unknown=True):
    panels = hass.data.setdefault(DATA_PANELS, {})
    if frontend_url_path not in panels:
        if warn_if_unknown:
            _LOGGER.warning("Removing unknown panel %s", frontend_url_path)
        return
    del panels[frontend_url_path]
