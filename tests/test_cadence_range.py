"""One cadence range, said the same way everywhere.

The failure this pins: the Home Assistant number entity advertised a
minimum of 0, the backend's refusal said "between 0 and 240", and the
backend accepted neither 0 nor 0.5 -- 1 was the real floor, and it was the
one number none of those three surfaces named. A customer who typed the
minimum the control offered got an error quoting a range that included it.

The product rule: the minimum is ONE minute, everywhere. Zero is not a
quiet way to turn the DJ off -- `switch.parlorwave_radio_dj` already does
that, and a second, undocumented off switch hidden in a spinner is worse
than no setting at all.

This file holds the Home Assistant half (the entity, and the panel control
that draws itself from the entity's attributes). The backend half -- the
validator and the sentence it refuses with -- is pinned in the backend's
own test_settings.py, because that is where the authority lives.
"""

import re
import unittest
from pathlib import Path

import harness  # noqa: F401  -- puts the fakes and the package on sys.path

from custom_components.parlorwave_radio.const import CADENCE_MAX, CADENCE_MIN
from custom_components.parlorwave_radio.number import CadenceNumber

_PKG = Path(harness.HA_ROOT) / "custom_components" / "parlorwave_radio"


class StubCoordinator:
    last_update_success = True

    def __init__(self, cadence=12):
        self.data = {"dj_settings": {"programming":
                                     {"cadence_min_minutes": cadence}}}


class TheEntityOffersOnlyWhatTheServiceAccepts(unittest.TestCase):
    def setUp(self):
        self.entity = CadenceNumber(StubCoordinator(), "entry1")

    def test_the_floor_is_one_minute(self):
        self.assertEqual(1, CADENCE_MIN)
        self.assertEqual(1, self.entity.native_min_value)

    def test_the_ceiling_is_unchanged(self):
        self.assertEqual(240, CADENCE_MAX)
        self.assertEqual(240, self.entity.native_max_value)

    def test_zero_is_not_a_cadence(self):
        """Not because zero is meaningless, but because it already means
        something else and that something has its own switch."""
        self.assertGreater(self.entity.native_min_value, 0)

    def test_the_step_keeps_the_advertised_values_whole(self):
        """0.5 was rejected by the service for a reason nobody could see:
        the client sends int(value), so half a minute arrived as zero."""
        self.assertEqual(1, self.entity.native_step)

    def test_it_still_reports_what_the_service_stored(self):
        self.assertEqual(12.0, self.entity.native_value)


class ThePanelDrawsTheRangeItIsGiven(unittest.TestCase):
    """The spinner must never restate a bound. It reads min and max off the
    entity, so aligning the entity aligned the panel -- and this is what
    keeps it that way."""

    def setUp(self):
        self.js = (_PKG / "panel" / "parlorwave-radio-panel.js").read_text()
        self.row = self.js[self.js.index("_numberRow(key, entity, label)"):]
        self.row = self.row[:self.row.index("\n  /*")]

    def test_the_bounds_come_from_the_entity(self):
        self.assertIn('min="${entity.attributes.min}"', self.row)
        self.assertIn('max="${entity.attributes.max}"', self.row)

    def test_no_cadence_bound_is_written_into_the_row(self):
        """A literal range here would be a second opinion able to disagree
        with the service that actually refuses. (The voice-tuning sliders
        elsewhere in the panel DO carry literals; those bounds are the
        panel's own and have no backend validator behind them.)"""
        for literal in re.findall(r'(?:min|max)\s*=\s*"[^$][^"]*"', self.row):
            self.fail(f"the cadence row states a bound itself: {literal}")


class NoOtherSurfaceRestatesTheOldRange(unittest.TestCase):
    """The entity table in the integration's developer README is the last
    place the range is written down in prose.

    That README documents the source tree, not the product, so it does
    not travel into the public export while this suite does. The check therefore runs where the file is and stands aside
    where it is not, rather than being dropped and left to drift."""

    README = Path(harness.HA_ROOT) / "custom_components" / "README.md"

    def test_the_developer_readme_names_the_range_the_service_enforces(self):
        if not self.README.exists():
            self.skipTest("the developer README is not part of the "
                          "public export")
        row = [ln for ln in self.README.read_text().splitlines()
               if "cadence_min_minutes" in ln]
        self.assertTrue(row, "the README no longer documents the entity")
        self.assertIn("(1–240)", row[0])
        self.assertNotIn("(0–240)", row[0])


if __name__ == "__main__":
    unittest.main()
