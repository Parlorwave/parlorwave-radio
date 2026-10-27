"""Fake http component: static path config and the view base class.

HomeAssistantView here carries only what the integration's own view code
touches -- the json() helper and the requires_auth default. Whether Home
Assistant ENFORCES requires_auth is Home Assistant's business and not
something this harness can or should prove; what it can prove is that the
integration never turns it off, and that the view behaves correctly once a
request reaches it.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class StaticPathConfig:
    url_path: str
    path: str
    cache_headers: bool = True


class FakeJsonResponse:
    def __init__(self, body, status: int):
        self.body = body
        self.status = status


class HomeAssistantView:
    url: str | None = None
    name: str | None = None
    #: Home Assistant's own default. An integration that wanted an open
    #: endpoint would have to set it False.
    requires_auth = True

    def json(self, result, status_code: int = 200, headers=None):
        return FakeJsonResponse(result, status_code)
