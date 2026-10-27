"""Fake config entries: the lifecycle a real core drives."""

from __future__ import annotations

import asyncio
from enum import Enum
from typing import Any


class ConfigEntryState(Enum):
    """The core's entry states (the subset this integration reads)."""
    NOT_LOADED = "not_loaded"
    LOADED = "loaded"
    SETUP_ERROR = "setup_error"
    SETUP_RETRY = "setup_retry"


class ConfigEntry:
    def __init__(self, entry_id: str, domain: str, data: dict, options: dict | None = None,
                 title: str = ""):
        self.entry_id = entry_id
        self.domain = domain
        self.data = dict(data)
        self.options = dict(options or {})
        self.title = title
        # every real entry carries one (None until a flow sets it)
        self.unique_id = None
        self.state = "not_loaded"
        self.platforms: list[str] = []
        self._update_listeners: list = []
        self._on_unload: list = []
        self._background_tasks: set[asyncio.Task] = set()

    def add_update_listener(self, listener):
        self._update_listeners.append(listener)
        return lambda: self._update_listeners.remove(listener)

    def async_on_unload(self, func):
        self._on_unload.append(func)

    def async_create_background_task(self, hass, target, name, eager_start=True):
        task = hass.async_create_task(target, name)
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)
        return task

    async def _async_process_on_unload(self):
        while self._on_unload:
            self._on_unload.pop()()
        for task in list(self._background_tasks):
            task.cancel()
        self._background_tasks.clear()


class ConfigEntries:
    def __init__(self, hass, integration):
        self.hass = hass
        self.integration = integration
        self._entries: dict[str, ConfigEntry] = {}
        self.reloads = 0

    def add(self, entry: ConfigEntry) -> None:
        self._entries[entry.entry_id] = entry

    def async_get_entry(self, entry_id):
        return self._entries.get(entry_id)

    def async_schedule_reload(self, entry_id: str) -> None:
        self.hass.async_create_task(self.async_reload(entry_id))

    async def async_setup(self, entry_id: str) -> bool:
        entry = self._entries[entry_id]
        ok = await self.integration.async_setup_entry(self.hass, entry)
        entry.state = "loaded" if ok else "setup_error"
        return ok

    async def async_unload(self, entry_id: str) -> bool:
        entry = self._entries[entry_id]
        ok = await self.integration.async_unload_entry(self.hass, entry)
        if ok:
            await entry._async_process_on_unload()
            entry.state = "not_loaded"
        return ok

    async def async_reload(self, entry_id: str) -> bool:
        self.reloads += 1
        if not await self.async_unload(entry_id):
            return False
        return await self.async_setup(entry_id)

    async def async_forward_entry_setups(self, entry, platforms):
        entry.platforms = list(platforms)

    async def async_unload_platforms(self, entry, platforms) -> bool:
        entry.platforms = []
        return True

    def async_update_entry(self, entry, *, data=None, options=None) -> bool:
        changed = False
        if options is not None and dict(options) != entry.options:
            entry.options = dict(options)
            changed = True
        if data is not None and dict(data) != entry.data:
            entry.data = dict(data)
            changed = True
        if changed:
            for listener in list(entry._update_listeners):
                self.hass.async_create_task(listener(self.hass, entry))
        return changed


class FlowHandler:
    hass = None

    def async_show_form(self, *, step_id, data_schema=None, errors=None,
                        description_placeholders=None, last_step=None):
        return {"type": "form", "step_id": step_id, "data_schema": data_schema,
                "errors": dict(errors or {})}

    def async_create_entry(self, *, title, data, **kw):
        return {"type": "create_entry", "title": title, "data": dict(data)}

    def async_abort(self, *, reason):
        return {"type": "abort", "reason": reason}


class AbortFlow(Exception):
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


class ConfigFlow(FlowHandler):
    context: dict = None

    def __init_subclass__(cls, domain=None, **kwargs):
        super().__init_subclass__(**kwargs)
        cls.domain = domain

    async def async_set_unique_id(self, unique_id):
        self.unique_id = unique_id

    def _async_current_entries(self, include_ignore=True):
        entries = getattr(self.hass, "config_entries", None)
        return list(entries._entries.values()) if entries is not None else []

    def _abort_if_unique_id_configured(self, updates=None, reload_on_update=True):
        """Mirror the core: an existing entry with this unique id aborts the
        flow (after applying `updates` to its data)."""
        entries = getattr(self.hass, "config_entries", None)
        if entries is None:
            return None
        for entry in entries._entries.values():
            if getattr(entry, "unique_id", None) == self.unique_id:
                if updates:
                    entry.data = {**entry.data, **updates}
                raise AbortFlow("already_configured")
        return None


class OptionsFlow(FlowHandler):
    config_entry: ConfigEntry | None = None
