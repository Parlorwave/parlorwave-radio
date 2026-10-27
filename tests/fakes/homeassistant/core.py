"""Fake core: hass, services, states, config."""

from __future__ import annotations

import asyncio
import os
from typing import Any

from .exceptions import ServiceNotFound


def callback(func):
    return func


class State:
    def __init__(self, entity_id: str, state: str, attributes: dict | None = None):
        self.entity_id = entity_id
        self.state = state
        self.attributes = dict(attributes or {})


class Event:
    def __init__(self, event_type: str, data: dict | None = None):
        self.event_type = event_type
        self.data = dict(data or {})


class ServiceCall:
    def __init__(self, domain: str, service: str, data: dict | None = None):
        self.domain = domain
        self.service = service
        self.data = dict(data or {})


class ServiceRegistry:
    def __init__(self, hass):
        self._hass = hass
        self._services: dict[tuple[str, str], Any] = {}
        self.calls: list[tuple[str, str, dict]] = []

    def has_service(self, domain: str, service: str) -> bool:
        return (domain, service) in self._services

    def async_register(self, domain, service, func, schema=None, supports_response=None):
        self._services[(domain, service)] = func

    def async_remove(self, domain, service):
        if (domain, service) not in self._services:
            raise KeyError((domain, service))   # real HA logs a warning; here it is loud
        del self._services[(domain, service)]

    def async_services(self):
        out: dict[str, dict[str, Any]] = {}
        for (domain, service), func in self._services.items():
            out.setdefault(domain, {})[service] = func
        return out

    async def async_call(self, domain, service, data=None, blocking=False,
                         target=None, return_response=False):
        self.calls.append((domain, service, dict(data or {})))
        func = self._services.get((domain, service))
        if func is None:
            raise ServiceNotFound(f"{domain}.{service}")
        return await func(ServiceCall(domain, service, data))


class EventBus:
    """The real core's event bus, reduced to what the integration uses. It
    watches the selected output through the helpers in helpers/event.py,
    and listens directly for ONE event type: call_service, to notice a
    person asking the DJ speaker to play (coordinator
    _sync_play_request_listener). The coordinator checks that hass HAS a
    bus first, as a core without one is a core that has not started."""

    def __init__(self):
        self.fired: list[Event] = []

    def async_fire(self, event_type: str, event_data: dict | None = None):
        self.fired.append(Event(event_type, event_data))

    def async_listen(self, event_type: str, listener):
        """Subscribe; returns the unsubscribe callable, like the real bus.
        Listeners are kept in `listeners` so a test can deliver an event."""
        self.listeners = getattr(self, "listeners", [])
        entry = (event_type, listener)
        self.listeners.append(entry)

        def _unsub():
            if entry in self.listeners:
                self.listeners.remove(entry)
        return _unsub


class StateMachine:
    def __init__(self):
        self._states: dict[str, State] = {}

    def get(self, entity_id: str) -> State | None:
        return self._states.get(entity_id)

    def async_set(self, entity_id: str, state: str, attributes: dict | None = None):
        self._states[entity_id] = State(entity_id, state, attributes)

    def async_all(self, domain_filter=None):
        states = list(self._states.values())
        if domain_filter is None:
            return states
        wanted = {domain_filter} if isinstance(domain_filter, str) else set(domain_filter)
        return [s for s in states if s.entity_id.split(".", 1)[0] in wanted]


class Config:
    def __init__(self, root: str):
        self._root = root
        self.time_zone = "America/Los_Angeles"

    def path(self, *parts: str) -> str:
        return os.path.join(self._root, *parts)


class FakeHttp:
    """Static paths are process-global and cannot be unregistered in Home
    Assistant; the fake counts every registration call. Views are the same
    shape of thing, and are kept so a test can look at what was registered
    and drive its handler directly."""

    def __init__(self):
        self.registrations: list[list] = []
        self.views: list = []

    def register_view(self, view):
        self.views.append(view)

    async def async_register_static_paths(self, configs):
        self.registrations.append(list(configs))

    def register_static_path(self, url_path, path, cache_headers=True):
        self.registrations.append([(url_path, path, cache_headers)])


class HomeAssistant:
    def __init__(self, root: str):
        self.data: dict[str, Any] = {}
        self.services = ServiceRegistry(self)
        self.states = StateMachine()
        self.bus = EventBus()
        self.config = Config(root)
        self.http = FakeHttp()
        self.config_entries = None          # set by the harness
        self._tasks: list[asyncio.Task] = []
        self._state_listeners: list = []
        self._interval_listeners: list = []

    def async_create_task(self, target, name=None, eager_start=False):
        task = asyncio.get_running_loop().create_task(target)
        self._tasks.append(task)
        return task

    async def async_add_executor_job(self, func, *args):
        return func(*args)

    async def async_block_till_done(self):
        for _ in range(50):
            pending = [t for t in self._tasks if not t.done()]
            if not pending:
                return
            await asyncio.sleep(0)
        raise AssertionError("tasks never settled: %r" % pending)
