from .frontend import DATA_PANELS


async def async_register_panel(hass, *, webcomponent_name, frontend_url_path,
                               module_url=None, js_url=None, html_url=None,
                               sidebar_title=None, sidebar_icon=None,
                               require_admin=False, embed_iframe=False,
                               config=None, trust_external=False,
                               config_panel_domain=None):
    panels = hass.data.setdefault(DATA_PANELS, {})
    if frontend_url_path in panels:
        # exactly what homeassistant.components.frontend does
        raise ValueError(f"Overwriting panel {frontend_url_path}")
    panels[frontend_url_path] = {"webcomponent_name": webcomponent_name,
                                 "module_url": module_url, "sidebar_title": sidebar_title}
