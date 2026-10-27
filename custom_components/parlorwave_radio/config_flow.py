"""Config flow: the backend's identity, and how to reach it.

IDENTITY is the backend's own instance id (GET /instance, and the Supervisor
discovery payload): one installation, one config entry, for the life of that
installation. CONNECTION -- host, port, API key -- is data, and all three
legitimately change: an add-on installed from a repository instead of
locally answers to a different hostname, a rebuilt add-on can take a
different address, and a reset key is re-announced. A changed connection for
a known instance updates that entry; it never creates a second one.

Validation is one authenticated call to the backend itself, which needs
neither Music Assistant nor a voice nor an output: a fresh add-on whose
Music Assistant token has not been pasted yet must still be able to become
a working config entry, and then say what is missing through its
diagnostics.

Options: the context sources (weather / calendars, stored in the entry's
options) and the DJ-enabled Music Assistant outputs -- the outputs
Parlorwave Radio may adopt playback on and DJ. That list is NOT stored in
the entry: the backend's settings.dj.outputs.enabled is the store of
record, read here from GET /outputs + GET /settings/dj and written through
one narrow client method. Nothing selected is a valid (diagnosed) state.
"""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import callback
from homeassistant.helpers import selector
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.service_info.hassio import HassioServiceInfo

from .api import (RadioServiceAuthError, RadioServiceClient,
                  RadioServiceConnectionError, RadioServiceError)
from .const import (CONF_API_KEY, CONF_CALENDAR_ENTITIES, CONF_DJ_OUTPUTS,
                    CONF_HOST, CONF_INSTANCE_ID, CONF_PORT, CONF_WEATHER_ENTITY,
                    DEFAULT_PORT, DOMAIN)

STEP_USER_SCHEMA = vol.Schema({
    vol.Required(CONF_HOST): str,
    vol.Required(CONF_PORT, default=DEFAULT_PORT): int,
    vol.Optional(CONF_API_KEY, default=""): str,
})
STEP_REAUTH_SCHEMA = vol.Schema({vol.Required(CONF_API_KEY): str})

#: Answers about an announced or stored backend that no retry can change: its
#: own key refused, or a different installation answering. Everything else
#: ("not answering yet", an odd answer) is worth asking again.
_FINAL = ("invalid_auth", "instance_mismatch")


class ParlorwaveRadioConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    def __init__(self) -> None:
        self._discovered: dict[str, Any] | None = None
        self._discovered_name: str = "ParlorWave Radio"

    @staticmethod
    @callback
    def async_get_options_flow(config_entry):
        return ParlorwaveRadioOptionsFlow()

    # --- Home Assistant OS: the add-on announces itself -----------------------
    async def async_step_hassio(self, discovery_info: HassioServiceInfo):
        """Supervisor discovery from the Parlorwave Radio add-on.

        The add-on publishes {instance_id, host, port, api_key} through the
        Supervisor's discovery API on every start (addon_bootstrap.py); Core
        hands it here. host is the add-on's internal hostname, reachable
        from Core without any published port; api_key is the add-on's
        persisted key. Nothing is typed, and nothing is stored until the
        user confirms.

        A known instance short-circuits: its stored connection is refreshed
        from the announcement (new hostname after a repository install, new
        address, re-announced key) and the flow aborts as configured -- one
        installation keeps one entry. A new instance is validated against
        the backend -- at announcement and again on confirmation -- and the
        identity it reports must be the one that was announced, so a
        confirmed entry is always the backend Core just spoke to."""
        cfg = dict(discovery_info.config or {})
        instance_id = str(cfg.get("instance_id") or "").strip()
        host = str(cfg.get("host") or "").strip()
        port = int(cfg.get("port") or DEFAULT_PORT)
        api_key = str(cfg.get("api_key") or "").strip()
        if not instance_id or not host or not api_key:
            return self.async_abort(reason="discovery_incomplete")
        await self.async_set_unique_id(instance_id)
        updates = {CONF_HOST: host, CONF_PORT: port, CONF_API_KEY: api_key}
        self._recover_rejected_entry(instance_id, updates)
        self._abort_if_unique_id_configured(updates=updates)
        self._discovered = {CONF_INSTANCE_ID: instance_id, CONF_HOST: host,
                            CONF_PORT: port, CONF_API_KEY: api_key}
        self._discovered_name = discovery_info.name or "ParlorWave Radio"
        self.context["title_placeholders"] = {"name": self._discovered_name}
        # Validated now when the add-on already answers -- but "not
        # answering YET" is not a verdict. The Supervisor hands an
        # announcement over once and never re-sends an unchanged one, so an
        # abort here was a lost card until the next Core restart (the
        # first-install race; publishing only after the service answers on
        # its own loopback narrowed it, it could not close it). The card
        # stays and the confirmation validates again. A refused key or a
        # different installation answering is final either way.
        error = await self._check_discovered()
        if error in _FINAL:
            return self.async_abort(reason=error)
        return await self.async_step_hassio_confirm()

    def _recover_rejected_entry(self, instance_id: str,
                                updates: dict[str, Any]) -> None:
        """A KNOWN installation whose entry stopped on a refused key
        (setup error, waiting for reauthentication) and whose add-on now
        announces a different connection: take it and set the entry up
        again. Home Assistant's own unique-id handling updates the data but
        reloads only loaded or retrying entries, which would leave this one
        waiting for a key nobody knows -- the add-on's key is never shown.
        The reload also closes the open reauthentication."""
        for entry in self._async_current_entries(include_ignore=False):
            if (getattr(entry, "unique_id", None) == instance_id
                    and entry.state is ConfigEntryState.SETUP_ERROR):
                if self.hass.config_entries.async_update_entry(
                        entry, data={**entry.data, **updates}):
                    self.hass.config_entries.async_schedule_reload(entry.entry_id)
                return

    async def _check_discovered(self) -> str | None:
        """None when the announced backend answers as the announced
        installation, else the reason (see _FINAL for which are final)."""
        d = self._discovered or {}
        client = RadioServiceClient(async_get_clientsession(self.hass),
                                    f"http://{d[CONF_HOST]}:{d[CONF_PORT]}",
                                    d[CONF_API_KEY])
        try:
            reported = await client.instance()
        except RadioServiceAuthError:
            return "invalid_auth"
        except RadioServiceConnectionError:
            return "cannot_connect"
        except RadioServiceError:
            return "unknown"
        if str(reported.get("instance_id") or "").strip() != d[CONF_INSTANCE_ID]:
            return "instance_mismatch"
        return None

    async def async_step_hassio_confirm(self, user_input: dict[str, Any] | None = None):
        """One confirmation, no fields. Validates again on submit, so a card
        shown while the add-on was still starting works once it answers."""
        errors: dict[str, str] = {}
        if user_input is not None and self._discovered is not None:
            error = await self._check_discovered()
            if error in _FINAL:
                return self.async_abort(reason=error)
            if error is None:
                return self.async_create_entry(title="ParlorWave Radio",
                                               data=dict(self._discovered))
            errors["base"] = error
        return self.async_show_form(
            step_id="hassio_confirm",
            description_placeholders={"addon": self._discovered_name},
            errors=errors)

    # --- a key the backend no longer accepts ---------------------------------
    async def async_step_reauth(self, entry_data: dict[str, Any]):
        """Started by Home Assistant when setup or a refresh gets the key
        refused (the coordinator raises ConfigEntryAuthFailed)."""
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(self, user_input: dict[str, Any] | None = None):
        """Ask for the key, validate it against THIS entry's backend, and
        keep the entry's identity: a key that opens a different
        installation is refused rather than re-pointing the entry. On Home
        Assistant OS the add-on's next start re-announces its key and ends
        this flow by itself (_recover_rejected_entry)."""
        entry = self._get_reauth_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            key = str(user_input.get(CONF_API_KEY) or "").strip()
            client = RadioServiceClient(
                async_get_clientsession(self.hass),
                f"http://{entry.data[CONF_HOST]}:{entry.data[CONF_PORT]}", key)
            try:
                reported = await client.instance()
            except RadioServiceAuthError:
                errors["base"] = "invalid_auth"
            except RadioServiceConnectionError:
                errors["base"] = "cannot_connect"
            except RadioServiceError:
                errors["base"] = "unknown"
            else:
                if str(reported.get("instance_id") or "").strip() != entry.unique_id:
                    return self.async_abort(reason="wrong_installation")
                return self.async_update_reload_and_abort(
                    entry, data_updates={CONF_API_KEY: key})
        return self.async_show_form(
            step_id="reauth_confirm", data_schema=STEP_REAUTH_SCHEMA,
            errors=errors,
            description_placeholders={"host": str(entry.data.get(CONF_HOST, ""))})

    async def async_step_user(self, user_input: dict[str, Any] | None = None):
        """The manual path (a backend that is not an add-on of this host).

        Identity comes from the backend itself, so an installation added by
        hand and one announced by the Supervisor are the same entry."""
        errors: dict[str, str] = {}
        if user_input is not None:
            base = f"http://{user_input[CONF_HOST]}:{user_input[CONF_PORT]}"
            client = RadioServiceClient(async_get_clientsession(self.hass),
                                      base, user_input.get(CONF_API_KEY, ""))
            try:
                # /instance is auth-protected (GET / is deliberately open),
                # so a wrong API key fails HERE, not on first use later --
                # and it needs nothing but the backend itself, so a service
                # whose Music Assistant token is still missing can be added.
                reported = await client.instance()
            except RadioServiceAuthError:
                errors["base"] = "invalid_auth"
            except RadioServiceConnectionError:
                errors["base"] = "cannot_connect"
            except RadioServiceError:
                errors["base"] = "unknown"
            else:
                instance_id = str(reported.get("instance_id") or "").strip()
                if not instance_id:
                    errors["base"] = "unknown"
                else:
                    await self.async_set_unique_id(instance_id)
                    self._abort_if_unique_id_configured(updates={
                        CONF_HOST: user_input[CONF_HOST],
                        CONF_PORT: user_input[CONF_PORT],
                        CONF_API_KEY: user_input.get(CONF_API_KEY, "")})
                    return self.async_create_entry(
                        title="ParlorWave Radio",
                        data={**user_input, CONF_INSTANCE_ID: instance_id})
        return self.async_show_form(step_id="user", data_schema=STEP_USER_SCHEMA,
                                    errors=errors)


def output_choices(outputs: dict[str, Any], dj_settings: dict[str, Any]
                   ) -> tuple[list[dict[str, str]], list[str]]:
    """(choices, currently enabled) for the DJ-enabled outputs selector.

    Pure, so the mapping is testable without Home Assistant. Choices are
    the Music Assistant outputs GET /outputs offers (already filtered to
    radio-capable providers, and always including the configured ids even
    when momentarily unavailable). An enabled id the inventory somehow
    omits is still offered, so saving the form can never silently drop it."""
    enabled = [o for o in ((dj_settings or {}).get("outputs") or {}).get("enabled") or [] if o]
    choices: list[dict[str, str]] = []
    seen: set[str] = set()
    for o in (outputs or {}).get("outputs") or []:
        if not isinstance(o, dict) or not o.get("player_id"):
            continue
        pid = str(o["player_id"])
        if pid in seen:
            continue
        seen.add(pid)
        label = str(o.get("name") or pid)
        if o.get("available") is False:
            label += " (unavailable)"
        choices.append({"value": pid, "label": label})
    for pid in enabled:
        if pid not in seen:
            seen.add(pid)
            choices.append({"value": pid, "label": f"{pid} (not reported by Music Assistant)"})
    return choices, enabled


class ParlorwaveRadioOptionsFlow(config_entries.OptionsFlow):
    """Context sources (which weather entity and calendars the integration
    may read) and the DJ-enabled outputs. Native selectors; nothing
    selected is a valid state for every field."""

    def _client(self) -> RadioServiceClient:
        coordinator = (self.hass.data.get(DOMAIN) or {}).get(self.config_entry.entry_id)
        if coordinator is not None:
            return coordinator.client
        data = self.config_entry.data
        return RadioServiceClient(async_get_clientsession(self.hass),
                                  f"http://{data[CONF_HOST]}:{data[CONF_PORT]}",
                                  data.get(CONF_API_KEY, ""))

    async def _outputs(self, client: RadioServiceClient
                       ) -> tuple[list[dict[str, str]], list[str], bool]:
        """(choices, enabled, available). Not available when the backend or
        Music Assistant cannot be read: the field is then left out of the
        form rather than offered empty, so a save can never wipe the list."""
        try:
            outputs = await client.outputs()
            dj = (await client.dj_settings()).get("settings") or {}
        except RadioServiceError:
            return [], [], False
        if not isinstance(outputs, dict) or not outputs.get("ok"):
            return [], [], False
        choices, enabled = output_choices(outputs, dj)
        return choices, enabled, True

    async def async_step_init(self, user_input: dict[str, Any] | None = None):
        errors: dict[str, str] = {}
        client = self._client()
        choices, enabled, outputs_ok = await self._outputs(client)
        if user_input is not None:
            if outputs_ok and CONF_DJ_OUTPUTS in user_input:
                offered = {c["value"] for c in choices}
                chosen = [str(pid) for pid in (user_input.get(CONF_DJ_OUTPUTS) or [])
                          if str(pid) in offered]
                try:
                    await client.set_enabled_outputs(chosen)
                except RadioServiceError:
                    errors["base"] = "outputs_write_failed"
            if not errors:
                return self.async_create_entry(title="", data={
                    CONF_WEATHER_ENTITY: user_input.get(CONF_WEATHER_ENTITY) or "",
                    CONF_CALENDAR_ENTITIES: list(user_input.get(CONF_CALENDAR_ENTITIES) or []),
                })
        current = self.config_entry.options
        fields: dict[Any, Any] = {
            vol.Optional(CONF_WEATHER_ENTITY,
                         description={"suggested_value": current.get(CONF_WEATHER_ENTITY) or None}):
                selector.EntitySelector(selector.EntitySelectorConfig(domain="weather")),
            vol.Optional(CONF_CALENDAR_ENTITIES,
                         description={"suggested_value": list(current.get(CONF_CALENDAR_ENTITIES) or [])}):
                selector.EntitySelector(selector.EntitySelectorConfig(domain="calendar", multiple=True)),
        }
        if outputs_ok:
            fields[vol.Optional(CONF_DJ_OUTPUTS,
                                description={"suggested_value": list(enabled)})] = (
                selector.SelectSelector(selector.SelectSelectorConfig(
                    options=choices, multiple=True,
                    mode=selector.SelectSelectorMode.LIST)))
        return self.async_show_form(step_id="init", data_schema=vol.Schema(fields),
                                    errors=errors)
