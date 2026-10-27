"""Install, discovery and recovery on a REAL Home Assistant core.

Install reliability for the public alpha: every install, reinstall and
recovery scenario, driven through Home Assistant's own
config-flow manager, config-entry state machine, reauth machinery and
entity/device/issue registries. The add-on is the FakeBackend at the
integration's transport seam: `up`, `api_key`, `instance_id`, `version`.

Some tests here are the reproduced defects (red on the code before the
fixes); the rest pin behaviour that already held and must keep holding:
they are labelled "pin".
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from homeassistant.config_entries import (SOURCE_HASSIO, SOURCE_REAUTH,
                                          SOURCE_USER, ConfigEntryState)
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.service_info.hassio import HassioServiceInfo
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import (MockConfigEntry,
                                                          async_fire_time_changed)

from backend import ADDON_HOST, ADDON_KEY, INSTANCE

DOMAIN = "parlorwave_radio"
REPO_HOST = "a1b2c3d4-parlorwave-radio"


def announcement(**over) -> HassioServiceInfo:
    cfg = {"instance_id": INSTANCE, "host": ADDON_HOST, "port": 5005,
           "api_key": ADDON_KEY}
    cfg.update(over)
    return HassioServiceInfo(config=cfg, name="ParlorWave Radio",
                             slug="local_parlorwave_radio", uuid="u1")


def installed_entry(hass, *, api_key: str = ADDON_KEY, host: str = ADDON_HOST,
                    options: dict | None = None) -> MockConfigEntry:
    entry = MockConfigEntry(
        domain=DOMAIN, title="ParlorWave Radio", unique_id=INSTANCE, version=1,
        source=SOURCE_HASSIO,
        data={"instance_id": INSTANCE, "host": host, "port": 5005,
              "api_key": api_key},
        options=options or {})
    entry.add_to_hass(hass)
    return entry


async def discover(hass, **over):
    return await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": SOURCE_HASSIO}, data=announcement(**over))


async def setup(hass, entry) -> None:
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()


async def tick(hass, seconds: float = 15) -> None:
    """Advance the clock; wait for what it set off, including Home
    Assistant's setup retries, which run as background tasks."""
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=seconds))
    await hass.async_block_till_done(wait_background_tasks=True)


def registry_view(hass, entry):
    ents = er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)
    devs = dr.async_entries_for_config_entry(dr.async_get(hass), entry.entry_id)
    return sorted(e.entity_id for e in ents), len(devs)


def flows(hass, source=None):
    return [f for f in hass.config_entries.flow.async_progress_by_handler(DOMAIN)
            if source is None or f["context"].get("source") == source]


async def unload_all(hass):
    for entry in hass.config_entries.async_entries(DOMAIN):
        if entry.state is ConfigEntryState.LOADED:
            await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()


# --- 1. discovery and retry --------------------------------------------------

async def test_announcement_before_the_addon_answers_keeps_its_card(hass, backend):
    """DEFECT (first-install race). The add-on announces itself, but Home
    Assistant cannot reach it yet. The Supervisor never re-sends an
    unchanged announcement, so aborting here lost the card until the next
    Core restart. The card must stay, say why, and work once it answers."""
    backend.up = False
    result = await discover(hass)
    assert result["type"] is FlowResultType.FORM, result
    assert result["step_id"] == "hassio_confirm"
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    assert result["type"] is FlowResultType.FORM, "still not answering: stay"
    assert result["errors"] == {"base": "cannot_connect"}
    backend.up = True
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    assert result["type"] is FlowResultType.CREATE_ENTRY, result
    await hass.async_block_till_done()
    entry = hass.config_entries.async_entries(DOMAIN)[0]
    assert entry.state is ConfigEntryState.LOADED
    assert entry.unique_id == INSTANCE
    await unload_all(hass)


async def test_a_rejected_announced_key_still_aborts(hass, backend):
    """pin: a key the add-on itself rejects is not a timing problem."""
    backend.api_key = "something-else"
    result = await discover(hass)
    assert (result["type"], result["reason"]) == (FlowResultType.ABORT, "invalid_auth")


async def test_repeated_announcements_make_one_card(hass, backend):
    """pin: the Supervisor may hand the same message over more than once."""
    first = await discover(hass)
    second = await discover(hass)
    assert first["type"] is FlowResultType.FORM
    assert (second["type"], second["reason"]) == (FlowResultType.ABORT,
                                                  "already_in_progress")
    assert len(flows(hass, SOURCE_HASSIO)) == 1


async def test_a_repeated_announcement_after_install_changes_nothing(hass, backend):
    """pin: every add-on start re-announces; one entry, same entities."""
    entry = installed_entry(hass)
    await setup(hass, entry)
    before = registry_view(hass, entry)
    for _ in range(3):
        result = await discover(hass)
        assert (result["type"], result["reason"]) == (FlowResultType.ABORT,
                                                      "already_configured")
        await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED
    assert len(hass.config_entries.async_entries(DOMAIN)) == 1
    assert registry_view(hass, entry) == before
    await unload_all(hass)


async def test_integration_before_addon_recovers_on_announcement(hass, backend):
    """pin: the integration is set up while the add-on is still stopped
    (retry state); the add-on's announcement brings it up at once."""
    entry = installed_entry(hass)
    backend.up = False
    await setup(hass, entry)
    assert entry.state is ConfigEntryState.SETUP_RETRY
    backend.up = True
    result = await discover(hass)
    assert result["reason"] == "already_configured"
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED
    await unload_all(hass)


async def test_integration_before_addon_recovers_on_its_own_retry(hass, backend):
    """pin: even with no announcement, Home Assistant's own setup retry
    finds the add-on once it answers -- no Core restart."""
    entry = installed_entry(hass)
    backend.up = False
    await setup(hass, entry)
    assert entry.state is ConfigEntryState.SETUP_RETRY
    backend.up = True
    await tick(hass, 120)
    assert entry.state is ConfigEntryState.LOADED
    await unload_all(hass)


async def test_a_new_hostname_moves_the_same_entry(hass, backend):
    """pin: the same add-on installed from a repository answers to another
    hostname; the one entry follows it, nothing is duplicated."""
    entry = installed_entry(hass)
    await setup(hass, entry)
    before = registry_view(hass, entry)
    result = await discover(hass, host=REPO_HOST)
    assert result["reason"] == "already_configured"
    await hass.async_block_till_done()
    assert entry.data["host"] == REPO_HOST
    assert entry.state is ConfigEntryState.LOADED
    assert registry_view(hass, entry) == before
    await unload_all(hass)


# --- 2. availability and recovery --------------------------------------------

async def test_an_addon_restart_goes_unavailable_and_comes_back(hass, backend):
    """pin: entities say unavailable while the add-on is down and come back
    by themselves; nothing is re-created."""
    entry = installed_entry(hass)
    await setup(hass, entry)
    before = registry_view(hass, entry)
    probe = "sensor.parlorwave_radio_dj_status"
    assert hass.states.get(probe).state != "unavailable"
    backend.up = False
    await tick(hass)
    assert hass.states.get(probe).state == "unavailable"
    backend.up = True
    await tick(hass)
    assert hass.states.get(probe).state != "unavailable"
    assert registry_view(hass, entry) == before
    assert entry.state is ConfigEntryState.LOADED
    await unload_all(hass)


async def test_settings_say_when_the_service_is_not_answering(hass, backend,
                                                               hass_ws_client):
    """DEFECT. The readiness document was built from the last good snapshot,
    so while the add-on was down Settings went on describing a working
    installation. It must say the service is not answering, and recover."""
    entry = installed_entry(hass)
    await setup(hass, entry)
    client = await hass_ws_client(hass)

    async def readiness(n):
        await client.send_json({"id": n, "type": "parlorwave_radio/readiness"})
        msg = await client.receive_json()
        assert msg["success"], msg
        return msg["result"]["readiness"]

    up_doc = await readiness(1)
    assert not any(b["code"] == "service_unreachable" for b in up_doc["blockers"])
    backend.up = False
    await tick(hass)
    down_doc = await readiness(2)
    assert down_doc["state"] == "needs_attention", down_doc["state"]
    codes = [b["code"] for b in down_doc["blockers"]]
    assert codes and codes[0] == "service_unreachable", codes
    assert "answer" in (down_doc["headline"] + down_doc["detail"]).lower()
    backend.up = True
    await tick(hass)
    again = await readiness(3)
    assert not any(b["code"] == "service_unreachable" for b in again["blockers"])
    await unload_all(hass)


async def test_settings_say_the_key_is_refused_after_a_reinstall(hass, backend,
                                                                 hass_ws_client):
    """DEFECT. After a reinstall the add-on
    ANSWERS and refuses the old entry's key; Settings said "not answering"
    and sent people to start an add-on that was running. A refused key is its
    own issue, with the reinstall way out. (A stopped add-on still reads "not
    answering": test_settings_say_when_the_service_is_not_answering. After a
    refused key Home Assistant's coordinator stops polling until the entry is
    reauthenticated or replaced, so "refused" holds until the user acts.)"""
    entry = installed_entry(hass)
    await setup(hass, entry)
    client = await hass_ws_client(hass)

    async def readiness(n):
        await client.send_json({"id": n, "type": "parlorwave_radio/readiness"})
        msg = await client.receive_json()
        assert msg["success"], msg
        return msg["result"]["readiness"]

    backend.instance_id, backend.api_key = REINSTALLED_ID, REINSTALLED_KEY
    await tick(hass, 60)
    refused = await readiness(1)
    codes = [b["code"] for b in refused["blockers"]]
    assert codes and codes[0] == "service_key_refused", codes
    assert "service_unreachable" not in codes
    assert "reinstalled" in refused["blockers"][0]["detail"]
    assert refused["state"] == "needs_attention"
    await unload_all(hass)


# --- 3. credentials ----------------------------------------------------------

async def test_a_rejected_key_asks_for_reauthentication(hass, backend):
    """DEFECT. A key the backend rejects was retried forever as 'not ready',
    with nothing to fix it from. It must stop and ask (Home Assistant's
    reauthentication flow)."""
    entry = installed_entry(hass, api_key="stale-key")
    await setup(hass, entry)
    assert entry.state is ConfigEntryState.SETUP_ERROR, entry.state
    assert len(flows(hass, SOURCE_REAUTH)) == 1


async def test_reauthentication_with_the_right_key_recovers(hass, backend):
    entry = installed_entry(hass, api_key="stale-key")
    await setup(hass, entry)
    [flow] = flows(hass, SOURCE_REAUTH)
    result = await hass.config_entries.flow.async_configure(
        flow["flow_id"], {"api_key": "still-wrong"})
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "invalid_auth"}
    result = await hass.config_entries.flow.async_configure(
        flow["flow_id"], {"api_key": ADDON_KEY})
    assert (result["type"], result["reason"]) == (FlowResultType.ABORT,
                                                  "reauth_successful")
    await hass.async_block_till_done()
    assert entry.data["api_key"] == ADDON_KEY
    assert entry.state is ConfigEntryState.LOADED
    assert len(hass.config_entries.async_entries(DOMAIN)) == 1
    await unload_all(hass)


async def test_reauthentication_refuses_another_installation(hass, backend):
    """The key belongs to a backend that is not this entry's installation:
    refused, so an entry never silently changes whose station it is."""
    entry = installed_entry(hass, api_key="stale-key")
    await setup(hass, entry)
    backend.instance_id = "a-different-installation"
    [flow] = flows(hass, SOURCE_REAUTH)
    result = await hass.config_entries.flow.async_configure(
        flow["flow_id"], {"api_key": ADDON_KEY})
    assert (result["type"], result["reason"]) == (FlowResultType.ABORT,
                                                  "wrong_installation")
    assert entry.data["api_key"] == "stale-key"


async def test_a_reannounced_key_recovers_without_the_user(hass, backend):
    """pin (and must survive the reauth change): the add-on's key changed;
    its next announcement carries the new one and the entry comes back by
    itself, even while it is waiting for reauthentication."""
    entry = installed_entry(hass, api_key="stale-key")
    await setup(hass, entry)
    assert entry.state is not ConfigEntryState.LOADED
    result = await discover(hass)
    assert result["reason"] == "already_configured"
    await hass.async_block_till_done()
    assert entry.data["api_key"] == ADDON_KEY
    assert entry.state is ConfigEntryState.LOADED
    assert flows(hass, SOURCE_REAUTH) == [], "a solved reauth is not left open"
    await unload_all(hass)


async def test_the_manual_form_reports_each_failure_and_then_succeeds(hass, backend):
    """pin: the classic host/port/key path."""
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": SOURCE_USER})
    backend.up = False
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {"host": "radio.lan", "port": 5005, "api_key": ADDON_KEY})
    assert result["errors"] == {"base": "cannot_connect"}
    backend.up = True
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {"host": "radio.lan", "port": 5005, "api_key": "nope"})
    assert result["errors"] == {"base": "invalid_auth"}
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {"host": "radio.lan", "port": 5005, "api_key": ADDON_KEY})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    await unload_all(hass)


async def test_a_different_installation_at_the_address_stops_the_entry(hass, backend):
    """The add-on was reinstalled (new data, new identity) but the stored key
    still opens it -- or another service took the address. The entry must
    not carry on as somebody else's station: it stops and says why, without
    asking for a key that would not help."""
    backend.instance_id = "a-reinstalled-installation"
    entry = installed_entry(hass)
    await setup(hass, entry)
    assert entry.state is ConfigEntryState.SETUP_ERROR, entry.state
    assert "different ParlorWave Radio installation" in (entry.reason or "")
    assert flows(hass, SOURCE_REAUTH) == []
    assert registry_view(hass, entry) == ([], 0), "nothing set up under it"


REINSTALLED_ID, REINSTALLED_KEY = "f00dfeedf00dfeedf00dfeedf00dfeed", "k-from-the-reinstalled-addon"


async def test_a_reinstalled_addon_asks_for_its_key_and_is_a_new_card(hass, backend):
    """The add-on keeps its identity AND its key in /data, and an uninstall
    deletes /data, so a reinstall answers at the same hostname with a new
    identity and a new key. The old entry is refused (reauthentication), the
    new installation is its own card, and the old entry is never re-pointed,
    not even by the new add-on announcing itself again. After a reload it
    stops on the refused key, never on "different installation". Delete +
    confirm gives back the same entity ids."""
    old = installed_entry(hass)
    await setup(hass, old)
    first = registry_view(hass, old)
    backend.up = False                                  # uninstalled
    await tick(hass, 60)
    backend.instance_id, backend.api_key, backend.up = REINSTALLED_ID, REINSTALLED_KEY, True
    await tick(hass, 60)
    assert old.state is ConfigEntryState.LOADED
    assert len(flows(hass, SOURCE_REAUTH)) == 1
    card = await discover(hass, instance_id=REINSTALLED_ID, api_key=REINSTALLED_KEY)
    assert (card["type"], card["step_id"]) == (FlowResultType.FORM, "hassio_confirm")
    again = await discover(hass, instance_id=REINSTALLED_ID, api_key=REINSTALLED_KEY)
    assert again["reason"] == "already_in_progress"
    assert old.data["api_key"] == ADDON_KEY, "the old entry is never re-pointed"
    await hass.config_entries.async_reload(old.entry_id)
    await hass.async_block_till_done(wait_background_tasks=True)
    assert old.state is ConfigEntryState.SETUP_ERROR, old.state
    assert "different" not in (old.reason or "")
    await hass.config_entries.async_remove(old.entry_id)
    await hass.async_block_till_done()
    assert flows(hass, SOURCE_REAUTH) == [], "deleting the entry closes its reauthentication"
    [card] = flows(hass, SOURCE_HASSIO)
    done = await hass.config_entries.flow.async_configure(card["flow_id"], {})
    await hass.async_block_till_done()
    assert done["type"] is FlowResultType.CREATE_ENTRY
    [new] = hass.config_entries.async_entries(DOMAIN)
    assert (new.unique_id, new.state) == (REINSTALLED_ID, ConfigEntryState.LOADED)
    assert registry_view(hass, new) == first, "the same entity ids, no _2"
    await unload_all(hass)


# --- 4. upgrade and restart --------------------------------------------------

async def test_an_existing_installation_upgrades_in_place(hass, backend):
    """pin: an entry and entities from an earlier release (the same entry
    shape since 0.1.0-alpha.1) come up with the SAME entity ids, its
    options intact, and the retired chattiness control removed."""
    entry = installed_entry(hass, options={"weather_entity": "weather.home",
                                           "calendar_entities": ["calendar.events"]})
    reg = er.async_get(hass)
    kept = reg.async_get_or_create("switch", DOMAIN, f"{entry.entry_id}_dj_enabled",
                                   config_entry=entry,
                                   suggested_object_id="parlorwave_radio_dj")
    ghost = reg.async_get_or_create("select", DOMAIN, f"{entry.entry_id}_chattiness",
                                    config_entry=entry,
                                    suggested_object_id="parlorwave_radio_chattiness")
    await setup(hass, entry)
    assert entry.state is ConfigEntryState.LOADED
    ids, devices = registry_view(hass, entry)
    assert devices == 1
    assert reg.async_get(ghost.entity_id) is None, "retired control removed"
    if kept.unique_id in {e.unique_id for e in er.async_entries_for_config_entry(
            reg, entry.entry_id)}:
        assert kept.entity_id in ids, "an existing entity keeps its id"
    assert not any(i.endswith("_2") for i in ids), ids
    assert entry.options["calendar_entities"] == ["calendar.events"]
    await unload_all(hass)


async def test_a_core_restart_keeps_one_device_and_the_same_entities(hass, backend):
    """pin: unload + set up again, as a Core restart does, twice."""
    entry = installed_entry(hass)
    await setup(hass, entry)
    before = registry_view(hass, entry)
    for _ in range(2):
        await hass.config_entries.async_unload(entry.entry_id)
        await hass.async_block_till_done()
        await setup(hass, entry)
        assert entry.state is ConfigEntryState.LOADED
        assert registry_view(hass, entry) == before
    await unload_all(hass)


# --- 5. add-on / integration compatibility ------------------------------------

def _integration_version() -> str:
    import json
    from pathlib import Path
    manifest = (Path(__file__).resolve().parents[1] / "custom_components" /
                DOMAIN / "manifest.json")
    return json.loads(manifest.read_text())["version"]


async def test_a_mismatched_addon_release_is_reported(hass, backend):
    """The integration and the add-on are released together and must match;
    an add-on left on another release is a Repairs issue, not silence."""
    backend.version = "0.1.0-alpha.1"
    entry = installed_entry(hass)
    await setup(hass, entry)
    assert entry.state is ConfigEntryState.LOADED, "a mismatch never blocks"
    issue = ir.async_get(hass).async_get_issue(DOMAIN, "addon_version_mismatch")
    assert issue is not None
    assert issue.translation_placeholders["addon_version"] == "0.1.0-alpha.1"
    assert issue.translation_placeholders["integration_version"] == _integration_version()
    backend.version = _integration_version()
    # The documented timing (README "Update the add-on too", the issue's own
    # text): the versions are compared when Home Assistant STARTS the entry.
    # An updated add-on alone -- the coordinator reconnecting to it -- does
    # not clear the notice; a restart or a reload does.
    await hass.data[DOMAIN][entry.entry_id].async_refresh()
    await hass.async_block_till_done()
    assert ir.async_get(hass).async_get_issue(DOMAIN, "addon_version_mismatch") is not None
    await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert ir.async_get(hass).async_get_issue(DOMAIN, "addon_version_mismatch") is None
    await unload_all(hass)


@pytest.mark.parametrize("reported", [None, "0.1.0-alpha.1-dev.3", "0.0.0-dev"])
async def test_unknown_or_development_versions_raise_nothing(hass, backend, reported):
    """A backend from before version reporting, or a development build,
    cannot be judged: nothing is raised."""
    backend.version = reported
    entry = installed_entry(hass)
    await setup(hass, entry)
    assert entry.state is ConfigEntryState.LOADED
    assert ir.async_get(hass).async_get_issue(DOMAIN, "addon_version_mismatch") is None
    await unload_all(hass)


# --- 5. the weather entity and the calendars, chosen from the panel -----------

async def test_the_sources_are_chosen_from_the_panel_without_a_reload(hass, backend,
                                                                      hass_ws_client):
    """Settings. The panel reads which weather and calendar
    entities Home Assistant has and writes the selection to the config
    entry's OPTIONS -- the same keys the options flow writes -- through
    Home Assistant's own update. On a real core: the write lands in
    entry.options, the entry is NOT reloaded (it stays LOADED with the same
    coordinator; only the context publisher restarts), the update listener
    the core schedules afterwards finds nothing to do, nothing is selected
    for anybody, and an entity Home Assistant does not have is refused."""
    hass.states.async_set("weather.home", "cloudy", {"friendly_name": "Home"})
    hass.states.async_set("calendar.book_club", "off", {"friendly_name": "Book Club"})
    entry = installed_entry(hass)
    await setup(hass, entry)
    coordinator = hass.data[DOMAIN][entry.entry_id]
    first_publisher = coordinator.context_publisher
    client = await hass_ws_client(hass)
    n = 0

    async def ws(kind, **extra):
        nonlocal n
        n += 1
        await client.send_json({"id": n, "type": f"parlorwave_radio/{kind}", **extra})
        return await client.receive_json()

    read = await ws("context_sources")
    assert read["success"], read
    inv = read["result"]
    assert [e["entity_id"] for e in inv["weather"]["entities"]] == ["weather.home"]
    assert [e["entity_id"] for e in inv["calendars"]["entities"]] == ["calendar.book_club"]
    assert inv["weather"]["selected"] == "" and inv["calendars"]["selected"] == []
    assert not any(e["selected"] for e in inv["weather"]["entities"])

    wrote = await ws("context_sources_set", weather="weather.home", calendars=["calendar.book_club"])
    assert wrote["success"], wrote
    assert wrote["result"]["changed"] is True
    assert wrote["result"]["weather"]["live"] == "weather.home"
    await hass.async_block_till_done()            # the core's update listener runs
    assert entry.options == {"weather_entity": "weather.home",
                             "calendar_entities": ["calendar.book_club"]}
    assert entry.state is ConfigEntryState.LOADED
    assert hass.data[DOMAIN][entry.entry_id] is coordinator, "the entry was reloaded"
    assert coordinator.context_publisher is not first_publisher
    assert first_publisher.stopped
    assert coordinator.context_publisher.calendar_entities == ["calendar.book_club"]
    assert not coordinator.context_publisher.stopped

    again = await ws("context_sources_set", weather="weather.nowhere")
    assert not again["success"], again
    assert entry.options["weather_entity"] == "weather.home", "a refused write wrote"

    cleared = await ws("context_sources_set", weather="", calendars=None)
    assert cleared["success"], cleared
    await hass.async_block_till_done()
    assert entry.options == {"weather_entity": "", "calendar_entities": ["calendar.book_club"]}
    assert coordinator.context_publisher.weather_entity is None
    assert entry.state is ConfigEntryState.LOADED
    await unload_all(hass)


async def test_the_sources_write_is_an_administrators_command(hass, backend,
                                                             hass_ws_client,
                                                             hass_read_only_access_token):
    """The options flow is an administrator's page; so is the write that
    changes the same options. The read is for anybody who can open the panel."""
    entry = installed_entry(hass)
    await setup(hass, entry)
    hass.states.async_set("weather.home", "cloudy", {"friendly_name": "Home"})
    client = await hass_ws_client(hass, hass_read_only_access_token)
    await client.send_json({"id": 1, "type": "parlorwave_radio/context_sources"})
    read = await client.receive_json()
    assert read["success"], read
    await client.send_json({"id": 2, "type": "parlorwave_radio/context_sources_set",
                            "weather": "weather.home"})
    wrote = await client.receive_json()
    assert not wrote["success"], wrote
    assert wrote["error"]["code"] == "unauthorized", wrote
    assert entry.options.get("weather_entity", "") == ""
    await unload_all(hass)
