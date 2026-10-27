"""Harness smoke: the integration installs from a Supervisor announcement on a
real Home Assistant core and comes up loaded, with one device."""

from homeassistant.config_entries import SOURCE_HASSIO, ConfigEntryState
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.helpers.service_info.hassio import HassioServiceInfo

from backend import ADDON_HOST, ADDON_KEY, INSTANCE

DOMAIN = "parlorwave_radio"


def announcement(**over):
    cfg = {"instance_id": INSTANCE, "host": ADDON_HOST, "port": 5005,
           "api_key": ADDON_KEY}
    cfg.update(over)
    return HassioServiceInfo(config=cfg, name="ParlorWave Radio",
                             slug="local_parlorwave_radio", uuid="u1")


async def test_discovered_addon_installs_and_loads(hass, backend):
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": SOURCE_HASSIO}, data=announcement())
    assert result["type"] is FlowResultType.FORM, result
    assert result["step_id"] == "hassio_confirm"
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    assert result["type"] is FlowResultType.CREATE_ENTRY, result
    await hass.async_block_till_done()
    entry = hass.config_entries.async_entries(DOMAIN)[0]
    assert entry.state is ConfigEntryState.LOADED
    devices = dr.async_entries_for_config_entry(dr.async_get(hass), entry.entry_id)
    entities = er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)
    assert len(devices) == 1
    assert len(entities) > 5
    await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
