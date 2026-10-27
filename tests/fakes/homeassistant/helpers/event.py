"""Fake event helpers: listeners are recorded on hass so a test can fire them."""


def async_track_state_change_event(hass, entity_ids, action):
    rec = (list(entity_ids), action)
    hass._state_listeners.append(rec)

    def unsub():
        if rec in hass._state_listeners:
            hass._state_listeners.remove(rec)
    return unsub


def async_track_time_interval(hass, action, interval, *, name=None, cancel_on_shutdown=None):
    rec = (action, interval)
    hass._interval_listeners.append(rec)

    def unsub():
        if rec in hass._interval_listeners:
            hass._interval_listeners.remove(rec)
    return unsub
