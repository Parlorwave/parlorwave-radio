def websocket_command(schema):
    def deco(func):
        func.ws_schema = schema
        return func
    return deco


def async_response(func):
    return func


def async_register_command(hass, handler):
    hass.data.setdefault("_fake_ws_commands", []).append(handler)


def require_admin(func):
    """Home Assistant's administrator gate. The fake lets everything
    through; which commands carry it is pinned at the source."""
    func.requires_admin = True
    return func
