"""The shippable Home Assistant package carries the public identity only.

Everything under custom_components/parlorwave_radio is what a user installs.
Nothing in it may still say the retired product name or the backend's
internal package name -- in any spelling, and in code, strings,
translations, services, comments or the panel. `STALE` below is the whole
vocabulary; this prose deliberately does not spell the variants out, because
this file ships inside the public repository and a document that enumerates
the old names is a document that publishes them.

There is no exception: the manifest's documentation and issue URLs name
the public repository, and they are asserted below. Nothing here knows about the
export tooling -- release/tests/ covers that. This is about the package a
customer installs, wherever they install it from.
"""

import json
import re
import unittest
from pathlib import Path

PKG = Path(__file__).resolve().parents[1] / "custom_components" / "parlorwave_radio"
STALE = re.compile(r"jarvis|music ?brain", re.I)


class PublicIdentity(unittest.TestCase):
    def test_package_layout(self):
        self.assertTrue((PKG / "manifest.json").is_file())
        self.assertTrue((PKG / "panel" / "parlorwave-radio-panel.js").is_file())
        self.assertFalse((PKG.parent / "jarvis_dj").exists())

    def test_manifest_identity(self):
        m = json.loads((PKG / "manifest.json").read_text())
        self.assertEqual(m["domain"], "parlorwave_radio")
        self.assertEqual(m["name"], "ParlorWave Radio")
        self.assertTrue(m["config_flow"])
        # The public identity, and the four keys HACS requires of a custom
        # integration's manifest (codeowners, documentation, issue_tracker,
        # version). Each is a URL a stranger clicks, so it must name the
        # public repository.
        self.assertEqual(m["documentation"],
                         "https://github.com/parlorwave/parlorwave-radio")
        self.assertEqual(m["issue_tracker"],
                         "https://github.com/parlorwave/parlorwave-radio/issues")
        # The publisher is the organization, not the account that pushes
        # (ParlorWave Radio).
        self.assertEqual(m["codeowners"], ["@parlorwave"])
        self.assertTrue(m["version"])

    def test_no_stale_branding_anywhere_in_the_package(self):
        hits = []
        for path in sorted(PKG.rglob("*")):
            if not path.is_file() or "__pycache__" in path.parts:
                continue
            for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                if STALE.search(line):
                    hits.append(f"{path.relative_to(PKG)}:{n}: {line.strip()[:100]}")
        self.assertEqual(hits, [], "stale branding in the shippable package:\n  " + "\n  ".join(hits))

    def test_namespaces(self):
        src = (PKG / "__init__.py").read_text()
        self.assertIn('DOMAIN = "parlorwave_radio"', (PKG / "const.py").read_text())
        self.assertNotIn("jarvis_dj", src)
        ws = re.findall(r'_command\("([a-z_]+)/', src)
        self.assertTrue(ws and all(ns == "parlorwave_radio" for ns in ws), ws)
        js = (PKG / "panel" / "parlorwave-radio-panel.js").read_text()
        self.assertTrue(re.findall(r'_ws\("parlorwave_radio/', js))
        self.assertFalse(re.findall(r'_ws\("(?!parlorwave_radio/)', js))
        self.assertTrue(re.findall(r'_svc\("parlorwave_radio"', js))
        # The panel also calls Home Assistant's own core services: the
        # select/switch/number entities this integration owns, and
        # media_player for the four On Air transport buttons. media_player
        # is on this list ON PURPOSE -- it is how Music Assistant keeps
        # playback authority. Parlorwave Radio has no transport endpoint of
        # its own, so Next means Music Assistant's Next and the queue is
        # advanced by its owner. Only the product namespace may be anything
        # other than a core domain.
        domains = set(re.findall(r'_svc\("([a-z_]+)"', js))
        self.assertEqual(domains - {"select", "switch", "number", "media_player"},
                         {"parlorwave_radio"})
        self.assertIn('customElements.define("parlorwave-radio-panel"', js)
        self.assertIn("ParlorWave <b>Radio</b>", js, "the masthead wordmark")

    def test_customer_facing_text(self):
        for name in ("strings.json", "translations/en.json"):
            d = json.loads((PKG / name).read_text())
            self.assertEqual(d["config"]["step"]["user"]["title"], "Connect to ParlorWave Radio")
        self.assertIn('title="ParlorWave Radio"', (PKG / "config_flow.py").read_text())
        self.assertIn('name="ParlorWave Radio"', (PKG / "entity.py").read_text())
        const = (PKG / "const.py").read_text()
        self.assertIn('PANEL_URL_PATH = "parlorwave-radio"', const)
        self.assertIn('PANEL_TITLE = "ParlorWave Radio"', const)
        self.assertIn('PANEL_STATIC_BASE = "/parlorwave_radio_panel"', const)

    def test_unique_ids_carry_no_brand(self):
        # unique_id = f"{entry_id}_{key}"; every key is a plain feature name
        keys = set()
        for name in ("sensor.py", "switch.py", "number.py", "select.py"):
            keys.update(re.findall(r'super\(\).__init__\(coordinator, entry_id, "([a-z_]+)"', (PKG / name).read_text()))
        self.assertTrue(keys)
        for k in keys:
            self.assertNotRegex(k, r"jarvis|parlorwave", k)


if __name__ == "__main__":
    unittest.main()
