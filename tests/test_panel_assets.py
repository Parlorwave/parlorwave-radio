"""The panel URL must name the bytes Home Assistant will actually serve.

This file exists because of a failure no command line shows: a new panel
can be deployed, every command-line check can say it is in place, and the
browser can keep rendering the old one -- through a Core restart, a hard
refresh and a private window.

The static route is aiohttp's, and aiohttp answers a request that offers
`Accept-Encoding: gzip` with a pre-compressed sibling if one exists.
A stale `parlorwave-radio-panel.js.gz` from a previous install may still be
there. Browsers always offer gzip; curl does not unless asked -- so every
diagnostic says one thing and every browser sees another, from the same URL.

Pinned here: a stale or foreign sibling is removed, a matching one is left
alone, the digest is a true function of the servable set, and none of this
throws on a config directory it cannot write to."""

import gzip
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import harness  # noqa: F401  (puts custom_components + the fake core on the path)
from custom_components.parlorwave_radio.panel_assets import (
    PANEL_FILE, PRECOMPRESSED_SUFFIXES, panel_asset_version)

NEW = b"export class Panel { /* dev.2 */ }\n"
OLD = b"export class Panel { /* alpha.1 */ }\n"


class PanelAssetVersion(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.js = os.path.join(self.dir, PANEL_FILE)
        with open(self.js, "wb") as fh:
            fh.write(NEW)

    def gz(self, payload):
        with gzip.open(self.js + ".gz", "wb") as fh:
            fh.write(payload)

    def test_a_plain_panel_versions_cleanly_and_removes_nothing(self):
        digest, removed = panel_asset_version(self.dir)
        self.assertEqual(removed, [])
        self.assertRegex(digest, r"^[0-9a-f]{12}$")

    def test_the_digest_follows_the_panel_contents(self):
        before, _ = panel_asset_version(self.dir)
        with open(self.js, "wb") as fh:
            fh.write(OLD)
        after, _ = panel_asset_version(self.dir)
        self.assertNotEqual(before, after)

    def test_a_stale_sibling_is_removed(self):
        """The live bug, reduced: the .js is new, the .gz is last release."""
        self.gz(OLD)
        digest, removed = panel_asset_version(self.dir)
        self.assertEqual(removed, [PANEL_FILE + ".gz"])
        self.assertFalse(os.path.exists(self.js + ".gz"),
                         "the stale sibling would still be served to browsers")
        # and what is left is indistinguishable from a clean install
        clean, _ = panel_asset_version(self.dir)
        self.assertEqual(digest, clean)

    def test_a_matching_sibling_is_left_alone(self):
        """Serving a correct .gz is a bandwidth win, not a defect."""
        self.gz(NEW)
        _, removed = panel_asset_version(self.dir)
        self.assertEqual(removed, [])
        self.assertTrue(os.path.exists(self.js + ".gz"))

    def test_a_sibling_that_is_not_even_compressed_is_removed(self):
        with open(self.js + ".gz", "wb") as fh:
            fh.write(b"this is not a gzip stream")
        _, removed = panel_asset_version(self.dir)
        self.assertEqual(removed, [PANEL_FILE + ".gz"])

    def test_every_suffix_the_route_can_substitute_is_pruned(self):
        """We ship none of these, so any of them present is foreign."""
        for suffix in PRECOMPRESSED_SUFFIXES:
            with open(self.js + suffix, "wb") as fh:
                fh.write(b"foreign")
        _, removed = panel_asset_version(self.dir)
        self.assertEqual(sorted(removed),
                         sorted(PANEL_FILE + s for s in PRECOMPRESSED_SUFFIXES))

    def test_the_url_a_poisoned_cache_holds_is_not_the_repaired_url(self):
        """The reason the digest covers the whole servable set and not just
        the .js. While a stale sibling is being served, browsers cache the
        WRONG bytes under whatever `?v=` was current. If removing the
        sibling could leave that same `?v=`, the poisoned copy would never
        be refetched and the repair would be invisible -- which is exactly
        how this defect survived a Core restart."""
        self.gz(OLD)
        with mock.patch("os.remove", side_effect=OSError(13, "denied")):
            poisoned, removed = panel_asset_version(self.dir)
        self.assertEqual(removed, [], "the prune was supposed to fail here")
        repaired, removed = panel_asset_version(self.dir)
        self.assertEqual(removed, [PANEL_FILE + ".gz"])
        self.assertNotEqual(poisoned, repaired)

    def test_an_unwritable_directory_does_not_break_setup(self):
        """A panel that cannot prune must still register. Degraded, loudly,
        but a sidebar entry that fails to appear at all is worse."""
        self.gz(OLD)
        with mock.patch("os.remove", side_effect=OSError(13, "denied")):
            digest, removed = panel_asset_version(self.dir)
        self.assertEqual(removed, [])
        self.assertRegex(digest, r"^[0-9a-f]{12}$")
        self.assertTrue(os.path.exists(self.js + ".gz"))


class RegisteredUrl(unittest.IsolatedAsyncioTestCase):
    """The registration actually uses it -- proved through a real setup."""

    async def test_the_registered_module_url_carries_the_panel_digest(self):
        from harness import make_hass
        from custom_components.parlorwave_radio.const import PANEL_URL_PATH

        hass, entry = make_hass()
        self.assertTrue(await hass.config_entries.async_setup(entry.entry_id))
        url = hass.data["frontend_panels"][PANEL_URL_PATH]["module_url"]
        root = hass.config.path("custom_components", "parlorwave_radio", "panel")
        digest, _ = panel_asset_version(root)
        self.assertEqual(url, f"/parlorwave_radio_panel/{PANEL_FILE}?v={digest}")



class ThePanelIsSyntacticallyAModule(unittest.TestCase):
    """The CSS lives inside a JavaScript template literal, and a backtick
    typed into a CSS comment ENDS that literal -- which does not produce a
    slightly wrong stylesheet, it produces a panel that does not parse and
    a screen that is entirely blank.

    Rendering the thing catches it; a source-level test does not. So: the whole file is parsed as a
    module, and the style block is checked for the character that breaks
    it, on every run.
    """

    PANEL = (Path(__file__).resolve().parents[1] / "custom_components"
             / "parlorwave_radio" / "panel" / "parlorwave-radio-panel.js")

    def _style_block(self, src):
        start = src.index("      <style>")
        return src[start:src.index("      </style>", start)]

    def test_no_backtick_inside_the_style_template(self):
        src = self.PANEL.read_text(encoding="utf-8")
        block = self._style_block(src)
        self.assertNotIn("`", block,
                         "a backtick in the CSS ends the template literal "
                         "and the panel stops parsing entirely")

    def test_the_file_parses_as_an_es_module(self):
        """`node --check` alone is not this test: it reads the file as a
        SCRIPT, where the panel's own top-level `export` is already a
        syntax error, so it cannot distinguish a broken panel from a
        normal one."""
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not available in this environment")
        proc = subprocess.run(
            [node, "--input-type=module", "--check"],
            input=self.PANEL.read_bytes(),
            capture_output=True)
        self.assertEqual(proc.returncode, 0,
                         proc.stderr.decode("utf-8", "replace")[:800])

if __name__ == "__main__":
    unittest.main(verbosity=2)
