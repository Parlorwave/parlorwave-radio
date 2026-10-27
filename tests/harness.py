"""Executable Home Assistant harness for the integration lifecycle tests.

The repo's test image has no Home Assistant; tests/fakes provides just
enough of the core's surface (config entries, services, panels, static
paths, event helpers, selectors) for the integration's OWN code to run:
async_setup_entry / async_unload_entry / the options flow / the context
publisher. What these tests prove is what the integration does with that
surface -- registrations, removals, tasks, writes -- not Home Assistant's
internals. The real core is used only if it is importable."""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
HA_ROOT = HERE.parent                      # ha/  -> custom_components.parlorwave_radio

#: The backend's source. It sits beside the integration only in the SOURCE
#: repository (<repo>/ha/tests -> <repo>/backend/music_brain). The public
#: integration repository ships this suite as <repo>/tests with no backend,
#: and there two levels up is the directory ABOVE the clone: somebody else's
#: files. Cross-repository contracts read the backend through this name; it
#: is None only in the public tree, where they skip and say why.
PRIVATE_TREE = HA_ROOT.name == "ha" and (HA_ROOT.parent / "release" / "export.py").is_file()
BACKEND_SRC = HA_ROOT.parent / "backend" / "music_brain" if PRIVATE_TREE else None
CROSS_REPO = ("a contract between the integration and the backend: checked in the "
              "source repository, where both live")
try:
    import homeassistant  # noqa: F401  (a real core, if present)
except ImportError:
    sys.path.insert(0, str(HERE / "fakes"))
if str(HA_ROOT) not in sys.path:
    sys.path.insert(0, str(HA_ROOT))

from homeassistant.config_entries import ConfigEntries, ConfigEntry  # noqa: E402
from homeassistant.core import Event, HomeAssistant, State  # noqa: E402

import custom_components.parlorwave_radio as integration  # noqa: E402
from custom_components.parlorwave_radio.const import DOMAIN  # noqa: E402

OUTPUTS = [
    {"player_id": "media_player.den", "name": "Den", "provider": "hass_players",
     "type": "player", "available": True, "state": "idle"},
    {"player_id": "00000000-aaaa", "name": "Utility room", "provider": "chromecast",
     "type": "player", "available": False, "state": "idle"},
    {"player_id": "ma_web123", "name": "Web (Chrome)", "provider": "sendspin",
     "type": "player", "available": True, "state": "idle"},
]


class FakeResponse:
    def __init__(self, status=200, data=None):
        self.status = status
        self._data = {"ok": True} if data is None else data

    async def json(self):
        return self._data


class FakeTransport:
    """The backend as the client sees it: routes by (method, path); keeps
    a live dj-settings document so a write is visible to the next read."""

    def __init__(self, enabled=None, selected=None, ma_ok=True, put_status=200,
                 instance_id="f1e2d3c4b5a6978877665544332211aa"):
        self.calls: list[dict] = []
        self.instance_id = instance_id
        self.dj = {"enabled": False,
                   "outputs": {"enabled": list(enabled or []),
                               "default_request_output": selected,
                               "auto_adopt_playback": True}}
        self.ma_ok = ma_ok
        self.put_status = put_status

    def count(self, method, path):
        return sum(1 for c in self.calls if c["method"] == method and c["path"] == path)

    async def request(self, method, url, json=None, headers=None, timeout=None):
        path = url.split("//", 1)[-1].split("/", 1)[1]
        path = "/" + path.split("?", 1)[0]
        self.calls.append({"method": method, "path": path, "json": json,
                           "headers": dict(headers or {})})
        if path == "/instance":
            return FakeResponse(200, {"ok": True, "instance_id": self.instance_id,
                                      "service": "ParlorWave Radio",
                                      "deployment": "addon"})
        if path == "/outputs":
            if not self.ma_ok:
                return FakeResponse(200, {"ok": False, "reason": "ma_unreachable"})
            return FakeResponse(200, {"ok": True, "outputs": [dict(o) for o in OUTPUTS],
                                      "selected": self.dj["outputs"]["default_request_output"]})
        if path == "/settings/dj" and method == "GET":
            return FakeResponse(200, {"ok": True, "section": "dj", "settings": self.dj})
        if path == "/settings/dj" and method == "PUT":
            if self.put_status != 200:
                return FakeResponse(self.put_status, {"detail": "refused"})
            outputs = (json or {}).get("outputs") or {}
            if "enabled" in outputs:
                self.dj["outputs"]["enabled"] = list(outputs["enabled"])
            return FakeResponse(200, {"ok": True, "section": "dj", "settings": self.dj})
        if path == "/health/problems":
            return FakeResponse(200, {"ok": True, "problems": [], "fatal": [],
                                      "features": {"observer": {"running": True}}})
        if path == "/dj/status":
            return FakeResponse(200, {"ok": True, "dj": {"status": "idle", "enabled": False},
                                      "station": {"active": None}})
        return FakeResponse(200, {"ok": True, "settings": {}})


def make_hass(transport: FakeTransport | None = None, options: dict | None = None):
    hass = HomeAssistant(str(HA_ROOT))
    hass.config_entries = ConfigEntries(hass, integration)
    transport = transport or FakeTransport()
    hass.data["_fake_session"] = transport
    entry = ConfigEntry("entry1", DOMAIN,
                        {"host": "radio.example", "port": 5005, "api_key": "k",
                         "instance_id": transport.instance_id},
                        options or {})
    hass.config_entries.add(entry)
    return hass, entry


def fire_state(hass, entity_id, old, new, attributes=None):
    """Deliver a state_changed event to every listener watching entity_id."""
    old_state = State(entity_id, old, attributes) if old is not None else None
    new_state = State(entity_id, new, attributes) if new is not None else None
    ev = Event("state_changed", {"entity_id": entity_id, "old_state": old_state,
                                  "new_state": new_state})
    for entities, action in list(hass._state_listeners):
        if entity_id in entities:
            action(ev)


def coordinator_of(hass, entry):
    return hass.data[DOMAIN][entry.entry_id]
