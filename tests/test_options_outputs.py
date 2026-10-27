"""The DJ-enabled outputs option: GET /outputs choices map to the form,
the submit is exactly one narrow settings write, zero is valid, unknown
ids are dropped, and an unreachable inventory hides the field instead of
wiping the list. The allow-list is never stored in the entry."""

import unittest

import harness
from harness import FakeTransport, OUTPUTS, make_hass
from custom_components.parlorwave_radio.config_flow import (ParlorwaveRadioOptionsFlow,
                                                            output_choices)
from custom_components.parlorwave_radio.const import (CONF_CALENDAR_ENTITIES,
                                                      CONF_DJ_OUTPUTS, CONF_WEATHER_ENTITY)

DEN, UTILITY, WEB = "media_player.den", "00000000-aaaa", "ma_web123"


class Choices(unittest.TestCase):
    def test_inventory_maps_to_value_label_pairs_with_availability(self):
        choices, enabled = output_choices({"ok": True, "outputs": OUTPUTS},
                                          {"outputs": {"enabled": [DEN]}})
        self.assertEqual([c["value"] for c in choices], [DEN, UTILITY, WEB])
        self.assertEqual(choices[0]["label"], "Den")
        self.assertEqual(choices[1]["label"], "Utility room (unavailable)")
        self.assertEqual(enabled, [DEN])

    def test_an_enabled_id_missing_from_the_inventory_is_still_offered(self):
        choices, enabled = output_choices({"ok": True, "outputs": OUTPUTS[:1]},
                                          {"outputs": {"enabled": [DEN, "ghost"]}})
        self.assertEqual([c["value"] for c in choices], [DEN, "ghost"])
        self.assertIn("not reported", choices[1]["label"])

    def test_garbage_is_ignored(self):
        choices, enabled = output_choices({"outputs": [None, {}, {"player_id": DEN}, {"player_id": DEN}]}, {})
        self.assertEqual(choices, [{"value": DEN, "label": DEN}])
        self.assertEqual(enabled, [])


def field(form, key):
    for marker in form["data_schema"].schema:
        if getattr(marker, "schema", marker) == key:
            return marker, form["data_schema"].schema[marker]
    return None, None


class OptionsFlowTests(unittest.IsolatedAsyncioTestCase):
    async def flow(self, transport, loaded=True):
        hass, entry = make_hass(transport)
        if loaded:
            await hass.config_entries.async_setup(entry.entry_id)
        f = ParlorwaveRadioOptionsFlow()
        f.hass, f.config_entry = hass, entry
        return f, hass, entry

    async def test_the_form_offers_ma_outputs_with_the_current_selection(self):
        f, hass, entry = await self.flow(FakeTransport(enabled=[DEN, WEB]))
        form = await f.async_step_init()
        self.assertEqual(form["type"], "form")
        marker, sel = field(form, CONF_DJ_OUTPUTS)
        self.assertIsNotNone(marker)
        self.assertEqual(marker.description, {"suggested_value": [DEN, WEB]})
        self.assertTrue(sel.config["multiple"])
        self.assertEqual([o["value"] for o in sel.config["options"]], [DEN, UTILITY, WEB])
        for key in (CONF_WEATHER_ENTITY, CONF_CALENDAR_ENTITIES):
            self.assertIsNotNone(field(form, key)[0])

    async def test_submit_is_exactly_one_settings_write(self):
        t = FakeTransport(enabled=[DEN])
        f, hass, entry = await self.flow(t)
        before = len(t.calls)
        result = await f.async_step_init({CONF_DJ_OUTPUTS: [UTILITY, WEB],
                                          CONF_WEATHER_ENTITY: "weather.home",
                                          CONF_CALENDAR_ENTITIES: ["calendar.a"]})
        self.assertEqual(result["type"], "create_entry")
        writes = [c for c in t.calls[before:] if c["method"] != "GET"]
        self.assertEqual(writes, [{"method": "PUT", "path": "/settings/dj",
                                   "json": {"outputs": {"enabled": [UTILITY, WEB]}},
                                   "headers": {"X-Api-Key": "k"}}])
        self.assertEqual(t.dj["outputs"]["enabled"], [UTILITY, WEB], "persisted, multiple")
        self.assertIsNone(t.dj["outputs"]["default_request_output"], "selection untouched")
        # the entry's options hold the context sources ONLY
        self.assertEqual(result["data"], {CONF_WEATHER_ENTITY: "weather.home",
                                          CONF_CALENDAR_ENTITIES: ["calendar.a"]})

    async def test_zero_outputs_is_valid_and_written(self):
        t = FakeTransport(enabled=[DEN])
        f, *_ = await self.flow(t)
        result = await f.async_step_init({CONF_DJ_OUTPUTS: []})
        self.assertEqual(result["type"], "create_entry")
        self.assertEqual(t.dj["outputs"]["enabled"], [])

    async def test_only_offered_ma_output_ids_are_accepted(self):
        t = FakeTransport(enabled=[DEN])
        f, *_ = await self.flow(t)
        await f.async_step_init({CONF_DJ_OUTPUTS: [DEN, "media_player.tv_not_ma", ""]})
        self.assertEqual(t.dj["outputs"]["enabled"], [DEN])

    async def test_an_unreachable_inventory_hides_the_field_and_never_wipes(self):
        t = FakeTransport(enabled=[DEN, WEB], ma_ok=False)
        f, *_ = await self.flow(t)
        form = await f.async_step_init()
        self.assertIsNone(field(form, CONF_DJ_OUTPUTS)[0])
        self.assertIsNotNone(field(form, CONF_WEATHER_ENTITY)[0])
        result = await f.async_step_init({CONF_WEATHER_ENTITY: "weather.home"})
        self.assertEqual(result["type"], "create_entry")
        self.assertEqual([c for c in t.calls if c["method"] == "PUT"], [])
        self.assertEqual(t.dj["outputs"]["enabled"], [DEN, WEB])

    async def test_a_refused_write_shows_an_error_and_creates_nothing(self):
        t = FakeTransport(enabled=[DEN], put_status=422)
        f, *_ = await self.flow(t)
        result = await f.async_step_init({CONF_DJ_OUTPUTS: [WEB]})
        self.assertEqual(result["type"], "form")
        self.assertEqual(result["errors"], {"base": "outputs_write_failed"})
        self.assertEqual(t.dj["outputs"]["enabled"], [DEN])

    async def test_the_flow_works_while_the_entry_is_not_loaded(self):
        t = FakeTransport(enabled=[])
        f, *_ = await self.flow(t, loaded=False)
        form = await f.async_step_init()
        self.assertIsNotNone(field(form, CONF_DJ_OUTPUTS)[0])
        await f.async_step_init({CONF_DJ_OUTPUTS: [DEN]})
        self.assertEqual(t.dj["outputs"]["enabled"], [DEN])


if __name__ == "__main__":
    unittest.main()
