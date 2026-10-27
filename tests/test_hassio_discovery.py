"""Supervisor discovery, and what the config entry is keyed on.

The add-on announces {instance_id, host, port, api_key}; Core dispatches it
to async_step_hassio. IDENTITY is the instance id: one backend, one entry,
however its connection changes. A hostname is NOT identity -- the same
add-on answers to `local-...` when it is installed from a local directory
and to a repository-prefixed name when it is installed from a repository,
which is precisely what publishing does to every existing install.

Also pinned: the announced identity is checked against the backend that
actually answers, a bad key or an unreachable add-on aborts honestly, and
validation needs nothing but the backend itself -- a fresh add-on whose
Music Assistant token has not been pasted yet must still become an entry.
"""

import unittest

import harness
from harness import FakeResponse, FakeTransport, make_hass
from homeassistant.config_entries import AbortFlow, ConfigEntry
from homeassistant.helpers.service_info.hassio import HassioServiceInfo
from custom_components.parlorwave_radio.config_flow import ParlorwaveRadioConfigFlow
from custom_components.parlorwave_radio.const import (CONF_API_KEY, CONF_HOST,
                                                      CONF_INSTANCE_ID, CONF_PORT,
                                                      DOMAIN)

INSTANCE = "f1e2d3c4b5a6978877665544332211aa"
LOCAL_HOST = "local-parlorwave-radio"
REPO_HOST = "a1b2c3d4-parlorwave-radio"


def announce(**over):
    config = {"instance_id": INSTANCE, "host": LOCAL_HOST, "port": 5005,
              "api_key": "k-from-addon", "ip_address": "172.30.33.2"}
    config.update(over)
    return HassioServiceInfo(config=config, name="ParlorWave Radio",
                             slug="local_parlorwave_radio", uuid="abc")


class RejectingTransport(FakeTransport):
    def __init__(self, status):
        super().__init__()
        self._status = status

    async def request(self, method, url, json=None, headers=None, timeout=None):
        self.calls.append({"method": method, "url": url, "path": url.split(":5005")[-1],
                           "headers": dict(headers or {})})
        if self._status == "down":
            raise ConnectionError("refused")
        return FakeResponse(self._status, {"detail": "no"})


class Base(unittest.IsolatedAsyncioTestCase):
    async def flow(self, transport=None, entries=()):
        hass, entry = make_hass(transport or FakeTransport())
        hass.config_entries._entries.clear()      # a fresh install by default
        for e in entries:
            hass.config_entries.add(e)
        f = ParlorwaveRadioConfigFlow()
        f.hass, f.context = hass, {}
        return f, hass

    def existing(self, instance_id=INSTANCE, host=LOCAL_HOST, api_key="old-key"):
        entry = ConfigEntry("e1", DOMAIN, {CONF_HOST: host, CONF_PORT: 5005,
                                           CONF_API_KEY: api_key,
                                           CONF_INSTANCE_ID: instance_id})
        entry.unique_id = instance_id
        return entry


class FirstDiscovery(Base):
    async def test_announced_backend_is_validated_then_confirmed(self):
        t = FakeTransport()
        f, hass = await self.flow(t)
        form = await f.async_step_hassio(announce())
        self.assertEqual((form["type"], form["step_id"]), ("form", "hassio_confirm"))
        self.assertEqual(f.unique_id, INSTANCE, "identity, not the connection")
        # validated against the backend, with the announced key
        self.assertEqual(t.calls[0]["path"], "/instance")
        self.assertEqual(t.calls[0]["headers"].get("X-Api-Key"), "k-from-addon")
        result = await f.async_step_hassio_confirm({})
        self.assertEqual(result["type"], "create_entry")
        self.assertEqual(result["data"], {CONF_INSTANCE_ID: INSTANCE, CONF_HOST: LOCAL_HOST,
                                          CONF_PORT: 5005, CONF_API_KEY: "k-from-addon"})

    async def test_validation_needs_nothing_but_the_backend(self):
        """No Music Assistant, no voice, no output: a first-run add-on whose
        token has not been pasted yet still becomes a config entry."""
        t = FakeTransport(enabled=[], ma_ok=False)
        f, _ = await self.flow(t)
        form = await f.async_step_hassio(announce())
        self.assertEqual(form["step_id"], "hassio_confirm")
        result = await f.async_step_hassio_confirm({})
        self.assertEqual(result["type"], "create_entry")
        # the announcement and the confirmation each ask the backend who it
        # is (the confirmation may come much later); nothing else is asked
        self.assertEqual({c["path"] for c in t.calls}, {"/instance"},
                         "the backend only, and not Music Assistant")

    async def test_a_rejected_key_aborts_before_any_form(self):
        f, _ = await self.flow(RejectingTransport(401))
        result = await f.async_step_hassio(announce())
        self.assertEqual((result["type"], result["reason"]), ("abort", "invalid_auth"))

    async def test_an_unreachable_addon_keeps_its_card(self):
        """Not answering YET is not a verdict: the Supervisor hands an
        announcement over once, so an abort here was a lost card until the
        next Core restart. The card stays; confirming says why it cannot
        finish yet, and confirms once the add-on answers (pinned end to end
        on a real core: tests_core/test_install_lifecycle.py)."""
        t = RejectingTransport("down")
        f, hass = await self.flow(t)
        form = await f.async_step_hassio(announce())
        self.assertEqual((form["type"], form["step_id"]), ("form", "hassio_confirm"))
        result = await f.async_step_hassio_confirm({})
        self.assertEqual((result["type"], result["errors"]),
                         ("form", {"base": "cannot_connect"}))
        self.assertEqual(hass.config_entries._entries, {}, "nothing stored")

    async def test_an_incomplete_announcement_aborts_without_network(self):
        for missing in ({"instance_id": ""}, {"host": ""}, {"api_key": ""}):
            t = FakeTransport()
            f, _ = await self.flow(t)
            result = await f.async_step_hassio(announce(**missing))
            self.assertEqual((result["type"], result["reason"]),
                             ("abort", "discovery_incomplete"), missing)
            self.assertEqual(t.calls, [])

    async def test_an_announcement_the_backend_disowns_aborts(self):
        """The message must belong to the backend that answered, or the
        entry would be keyed on an identity nobody holds."""
        t = FakeTransport(instance_id="someone-else")
        f, _ = await self.flow(t)
        result = await f.async_step_hassio(announce())
        self.assertEqual((result["type"], result["reason"]), ("abort", "instance_mismatch"))


class OneInstallationOneEntry(Base):
    async def test_a_repository_install_updates_the_entry_it_does_not_add_one(self):
        """The packaging migration: the same add-on, installed from a
        repository instead of locally, answers to a different hostname."""
        entry = self.existing(host=LOCAL_HOST, api_key="old-key")
        t = FakeTransport()
        f, hass = await self.flow(t, entries=[entry])
        with self.assertRaises(AbortFlow) as ctx:
            await f.async_step_hassio(announce(host=REPO_HOST, api_key="new-key"))
        self.assertEqual(ctx.exception.reason, "already_configured")
        self.assertEqual(len(hass.config_entries._entries), 1, "no second entry")
        self.assertEqual(entry.data[CONF_HOST], REPO_HOST, "connection follows")
        self.assertEqual(entry.data[CONF_API_KEY], "new-key")
        self.assertEqual(entry.unique_id, INSTANCE, "identity does not")
        self.assertEqual(t.calls, [], "no network before the known-instance check")

    async def test_a_changed_key_alone_updates_the_same_entry(self):
        entry = self.existing(api_key="old-key")
        f, hass = await self.flow(entries=[entry])
        with self.assertRaises(AbortFlow):
            await f.async_step_hassio(announce(api_key="rotated"))
        self.assertEqual(entry.data[CONF_API_KEY], "rotated")
        self.assertEqual(entry.data[CONF_HOST], LOCAL_HOST)
        self.assertEqual(len(hass.config_entries._entries), 1)

    async def test_a_changed_port_updates_the_same_entry(self):
        entry = self.existing()
        f, hass = await self.flow(entries=[entry])
        with self.assertRaises(AbortFlow):
            await f.async_step_hassio(announce(port=5999))
        self.assertEqual(entry.data[CONF_PORT], 5999)
        self.assertEqual(len(hass.config_entries._entries), 1)

    async def test_a_different_backend_is_genuinely_a_second_entry(self):
        entry = self.existing(instance_id="a-different-installation")
        t = FakeTransport()
        f, hass = await self.flow(t, entries=[entry])
        form = await f.async_step_hassio(announce())
        self.assertEqual(form["step_id"], "hassio_confirm")
        result = await f.async_step_hassio_confirm({})
        self.assertEqual(result["type"], "create_entry")
        self.assertEqual(f.unique_id, INSTANCE)
        self.assertEqual(entry.data[CONF_HOST], LOCAL_HOST, "the other entry is untouched")


class ManualPath(Base):
    async def test_a_hand_added_backend_is_keyed_on_the_same_identity(self):
        """Added by hand and announced by the Supervisor must be ONE entry."""
        t = FakeTransport()
        f, hass = await self.flow(t)
        result = await f.async_step_user({CONF_HOST: "radio.lan", CONF_PORT: 5005,
                                          CONF_API_KEY: "typed"})
        self.assertEqual(result["type"], "create_entry")
        self.assertEqual(f.unique_id, INSTANCE)
        self.assertEqual(result["data"][CONF_INSTANCE_ID], INSTANCE)
        self.assertEqual([c["path"] for c in t.calls], ["/instance"])

    async def test_the_same_backend_added_twice_by_hand_is_refused(self):
        entry = self.existing(host="radio.lan")
        f, hass = await self.flow(entries=[entry])
        with self.assertRaises(AbortFlow) as ctx:
            await f.async_step_user({CONF_HOST: "radio-moved.lan", CONF_PORT: 5005,
                                     CONF_API_KEY: "typed"})
        self.assertEqual(ctx.exception.reason, "already_configured")
        self.assertEqual(entry.data[CONF_HOST], "radio-moved.lan")
        self.assertEqual(len(hass.config_entries._entries), 1)

    async def test_a_bad_key_stays_on_the_form(self):
        f, _ = await self.flow(RejectingTransport(401))
        result = await f.async_step_user({CONF_HOST: "radio.lan", CONF_PORT: 5005,
                                          CONF_API_KEY: "wrong"})
        self.assertEqual(result["type"], "form")
        self.assertEqual(result["errors"], {"base": "invalid_auth"})


if __name__ == "__main__":
    unittest.main()
