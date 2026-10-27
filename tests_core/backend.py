"""A Parlorwave Radio backend for REAL Home Assistant core tests.

Speaks the integration's documented transport seam (api.RadioServiceClient:
`request(method, url, json=, data=, headers=, timeout=)` -> an object with
`.status` and `async .json()`), so no aiohttp is mocked and the client's own
error mapping (connection refused, 401, 5xx) is what the integration sees.

The switches are the install lifecycle: `up` (the add-on is running and
answering), `api_key` (what it accepts), `instance_id` (which installation
answers at this address) and `version` (what /instance reports, or absent,
like every backend before version reporting existed).
"""

from __future__ import annotations

import json as _json
from typing import Any

INSTANCE = "f1e2d3c4b5a6978877665544332211aa"
ADDON_HOST = "local-parlorwave-radio"
ADDON_KEY = "k-from-addon"


class Response:
    def __init__(self, status: int, body: Any):
        self.status = status
        self._body = body

    async def json(self):
        return self._body

    async def read(self):
        return _json.dumps(self._body).encode("utf-8")


class FakeBackend:
    def __init__(self, *, instance_id: str = INSTANCE, api_key: str = ADDON_KEY,
                 version: str | None = None) -> None:
        self.instance_id = instance_id
        self.api_key = api_key
        self.version = version
        self.up = True
        self.calls: list[tuple[str, str]] = []
        self.dj = {"enabled": False,
                   "outputs": {"enabled": ["media_player.kitchen"],
                               "default_request_output": None,
                               "auto_adopt_playback": True}}
        self.problems: list[dict[str, Any]] = []

    # the injected "session": RadioServiceClient calls this
    async def request(self, method, url, json=None, data=None, headers=None,
                      timeout=None):
        path = "/" + url.split("//", 1)[-1].split("/", 1)[-1].split("?", 1)[0]
        if path == "//":
            path = "/"
        self.calls.append((method, path))
        if not self.up:
            raise ConnectionRefusedError("the add-on is not answering")
        if path == "/":
            return Response(200, {"status": "online", "auth": "required"})
        if (headers or {}).get("X-Api-Key") != self.api_key:
            return Response(401, {"detail": "invalid or missing API key"})
        if path == "/instance":
            body = {"ok": True, "instance_id": self.instance_id,
                    "service": "ParlorWave Radio", "deployment": "addon"}
            if self.version is not None:
                body["version"] = self.version
            return Response(200, body)
        if path == "/dj/status":
            return Response(200, {"ok": True,
                                  "dj": {"status": "idle", "enabled": False},
                                  "station": {"active": None}})
        if path == "/settings/dj" and method == "GET":
            return Response(200, {"ok": True, "section": "dj", "settings": self.dj})
        if path == "/outputs":
            return Response(200, {"ok": True, "outputs": [
                {"player_id": "media_player.kitchen", "name": "Kitchen",
                 "available": True}], "selected": None})
        if path == "/health/problems":
            return Response(200, {"ok": True, "problems": list(self.problems),
                                  "fatal": [], "instance_id": self.instance_id,
                                  "features": {"observer": {"running": True}}})
        return Response(200, {"ok": True, "settings": {}})

    def count(self, path: str) -> int:
        return sum(1 for _m, p in self.calls if p == path)
