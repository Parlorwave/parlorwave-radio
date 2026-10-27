"""Broadcast Diagnostics in a REAL Home Assistant core: the two websocket
commands as the core registers, validates and gates them.

The stdlib suite (ha/tests/test_broadcast_diagnostics_ws.py) executes the
handlers with a fake core whose schema and administrator gate let everything
through. Here the core's own websocket_api decides: voluptuous refuses a
break token or an out-of-range page before the integration runs, and a
non-administrator is refused before the service is asked. The service is the
harness add-on answering, with its key, exactly what the backend's real
routes answered (ha/tests/broadcast_diagnostics_api.py).
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

from pytest_homeassistant_custom_component.common import MockConfigEntry
from homeassistant.config_entries import SOURCE_HASSIO, ConfigEntryState

from backend import ADDON_HOST, ADDON_KEY, INSTANCE, FakeBackend, Response
from custom_components.parlorwave_radio.const import DOMAIN

_spec = importlib.util.spec_from_file_location(
    "broadcast_diagnostics_api",
    Path(__file__).resolve().parents[1] / "tests" / "broadcast_diagnostics_api.py")
_api = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_api)
EXCHANGES = _api.EXCHANGES
#: the list and record answers by path (the auth and bad-cursor exchanges share
#: the first page's path, and `partial:1` is a second answer to it)
BY_PATH = {e["path"]: e for e in EXCHANGES
           if e["kind"] in ("list", "detail") and not e["name"].startswith("partial")}
NAMED = {e["name"]: e for e in EXCHANGES}


class DiagBackend(FakeBackend):
    """The harness add-on plus the two diagnostics routes, answered only for
    a request the backend really was asked, and only with the key."""

    def __init__(self):
        super().__init__()
        self.diag: list[str] = []

    async def request(self, method, url, json=None, data=None, headers=None, timeout=None):
        full = "/" + url.split("//", 1)[-1].split("/", 1)[-1]
        if not full.startswith("/dj/diagnostics/"):
            return await super().request(method, url, json=json, data=data,
                                         headers=headers, timeout=timeout)
        self.diag.append(full)
        if (headers or {}).get("X-Api-Key") != self.api_key:
            return Response(401, {"detail": "invalid or missing X-Api-Key"})
        e = BY_PATH.get(full)
        return Response(e["status"], e["body"]) if e else Response(599, {"detail": "unrecorded"})


@pytest.fixture
def diag(monkeypatch):
    b = DiagBackend()
    import custom_components.parlorwave_radio as pkg
    monkeypatch.setattr(pkg, "async_get_clientsession", lambda hass: b)
    return b


async def _installed(hass):
    entry = MockConfigEntry(domain=DOMAIN, title="ParlorWave Radio", unique_id=INSTANCE, version=1,
                            source=SOURCE_HASSIO,
                            data={"instance_id": INSTANCE, "host": ADDON_HOST, "port": 5005,
                                  "api_key": ADDON_KEY})
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED
    return entry


def _caller(client):
    n = 0

    async def ws(command, **extra):
        nonlocal n
        n += 1
        await client.send_json({"id": n, "type": f"parlorwave_radio/broadcast_diagnostics_{command}", **extra})
        return await client.receive_json()
    return ws


async def test_an_administrator_reads_the_list_the_cursor_and_a_record(hass, diag, hass_ws_client):
    await _installed(hass)
    ws = _caller(await hass_ws_client(hass))
    first = NAMED["all:1"]
    got = await ws("list", limit=25, kind="dj_break")
    assert got["success"], got
    assert got["result"] == first["body"]
    nxt = await ws("list", limit=25, kind="dj_break", before=first["body"]["next_before"])
    assert nxt["success"], nxt
    assert nxt["result"] == NAMED["all:2"]["body"]
    rec = NAMED["detail:genuine"]
    one = await ws("detail", opportunity_id=rec["params"]["opportunity_id"])
    assert one["success"], one
    assert one["result"] == rec["body"]
    missing = await ws("detail", opportunity_id="0123456789abcdef")
    assert missing["success"], missing
    assert missing["result"] == {"ok": False, "reason": "not_found"}
    assert diag.diag == [first["path"], NAMED["all:2"]["path"], rec["path"],
                         "/dj/diagnostics/opportunities/0123456789abcdef"]


async def test_the_core_refuses_a_token_and_an_unbounded_page_before_the_service_is_asked(
        hass, diag, hass_ws_client):
    await _installed(hass)
    ws = _caller(await hass_ws_client(hass))
    for command, extra in (("detail", {"opportunity_id": "0123456789abcdef0123456789abcdef"}),
                        ("detail", {"opportunity_id": "../../settings/dj"}),
                        ("detail", {}),
                        ("list", {"limit": 500}),
                        ("list", {"kind": "everything"})):
        got = await ws(command, **extra)
        assert not got["success"], (command, extra, got)
        assert got["error"]["code"] == "invalid_format", (command, extra, got)
    assert diag.diag == [], "the service was asked something the core should have refused"


async def test_both_commands_are_for_administrators(hass, diag, hass_ws_client,
                                                    hass_read_only_access_token):
    await _installed(hass)
    ws = _caller(await hass_ws_client(hass, hass_read_only_access_token))
    for command, extra in (("list", {"limit": 25}), ("detail", {"opportunity_id": "0123456789abcdef"})):
        got = await ws(command, **extra)
        assert not got["success"], got
        assert got["error"]["code"] == "unauthorized", got
    assert diag.diag == []
