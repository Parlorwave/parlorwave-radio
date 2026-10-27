"""The console badge's artwork: the production wordmark and the
engraved station plate, as the panel carries them.

Source-level contracts over the panel, like the rest of the panel suite,
plus a real check of the two embedded assets: the wordmark SVG must be the
reference file in panel/brand/ byte for byte, must parse, must reference
nothing outside itself and carry nothing executable; the plate font must be
the reference woff2 and travel with its licence.
"""

from __future__ import annotations

import base64
import re
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

PANEL = Path(__file__).resolve().parents[1] / "custom_components" / "parlorwave_radio" / "panel" / "parlorwave-radio-panel.js"
BRAND = PANEL.parents[4] / "design" / "brand"   # the source tree only; absent from the public export
SRC = PANEL.read_text()
STYLE = SRC[SRC.index("<style>"):SRC.index("</style>")]
BADGE = SRC[SRC.index("  _renderCenterBadge() {"):SRC.index("  /* THE BROADCAST CONSOLE")]

SVG_NS = "{http://www.w3.org/2000/svg}"
ALLOWED = {"svg", "title", "defs", "linearGradient", "stop", "filter", "feMorphology", "feGaussianBlur",
           "feSpecularLighting", "feDistantLight", "feComposite", "feDiffuseLighting", "feTurbulence",
           "feColorMatrix", "feFlood", "feOffset", "feMerge", "feMergeNode", "g", "path"}


def embedded_svg() -> str:
    m = re.search(r"const PW_EMBLEM_SVG = `(.*?)`;", SRC, re.S)
    assert m, "the wordmark is embedded as PW_EMBLEM_SVG"
    return m.group(1)


def embedded_font() -> bytes:
    m = re.search(r'const PW_PLATE_FONT_B64 = "([A-Za-z0-9+/=]+)";', SRC)
    assert m, "the plate font is embedded as PW_PLATE_FONT_B64"
    return base64.b64decode(m.group(1))


class TheWordmarkIsTheProductionVector(unittest.TestCase):
    def test_the_embedded_svg_is_the_reference_file(self):
        ref = BRAND / "parlorwave-emblem.svg"
        if not ref.exists():
            self.skipTest("the reference artwork is not part of the public export")
        self.assertEqual(embedded_svg(), ref.read_text().rstrip("\n"))

    def test_it_is_well_formed_and_self_contained(self):
        root = ET.fromstring(embedded_svg())
        self.assertEqual(root.tag, SVG_NS + "svg")
        self.assertEqual(root.get("viewBox"), "0 0 520 150")
        self.assertEqual(root.get("role"), "img")
        ids = set()
        for el in root.iter():
            tag = el.tag.split("}")[-1]
            self.assertIn(tag, ALLOWED, f"<{tag}> has no place in the wordmark")
            for name, value in el.attrib.items():
                local = name.split("}")[-1]
                self.assertFalse(local.startswith("on"), f"event handler attribute {name}")
                self.assertNotIn("href", local, f"{name}: the wordmark references nothing")
                self.assertNotIn("http", value, f"{name}={value[:40]}: no external resource")
            if el.get("id"):
                self.assertTrue(el.get("id").startswith("pw-emblem-"), el.get("id"))
                ids.add(el.get("id"))
        for ref in re.findall(r"url\(#([^)]+)\)", embedded_svg()):
            self.assertIn(ref, ids, f"url(#{ref}) must resolve inside the SVG")
        self.assertNotIn("<script", embedded_svg())
        self.assertNotIn("`", embedded_svg())
        self.assertNotIn("${", embedded_svg())

    def test_it_is_mounted_as_a_data_image_not_text(self):
        self.assertIn('const PW_EMBLEM_URL = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(PW_EMBLEM_SVG);', SRC)
        self.assertIn('<img class="console-badge-emblem" src="${PW_EMBLEM_URL}" alt="" draggable="false">', BADGE)
        self.assertNotIn("console-badge-script", SRC)
        self.assertNotIn("Brush Script", BADGE)

    def test_the_sleeve_keeps_its_drawn_script(self):
        # the DJ sleeve still draws its own script
        self.assertIn('.art-dj-script {\n          font-family:"Brush Script MT"', STYLE)
        self.assertIn('<span class="art-dj-script">ParlorWave</span>', SRC)


class TheStationPlate(unittest.TestCase):
    def test_the_name_is_live_text_and_the_accessible_name(self):
        self.assertIn('aria-label="${this._esc(label)}"', BADGE)
        self.assertIn('const label = isHidden ? "Radio badge hidden" : (isStation ? station : "ParlorWave");', BADGE)
        self.assertIn('<span class="console-badge-plate" aria-hidden="true">', BADGE)
        self.assertIn('<text class="pw-plate-ink" data-line="${i}"', BADGE)
        self.assertIn("${line}</text>", BADGE)
        self.assertIn("const line = this._esc(f.lines[i] || \"\");", BADGE)
        # the metal is an image of geometry only: no name ever enters it
        plate = SRC[SRC.index("function plateBodyUrl("):SRC.index("/* The plate's lettering")]
        self.assertNotIn("<text", plate)
        self.assertIn("text-transform:uppercase;", STYLE[STYLE.index(".console-badge-plate-text text {"):])

    def test_fitting_measures_after_render_and_on_resize(self):
        render = SRC[SRC.index("  _render() {"):SRC.index("if (!customElements.get(")]
        self.assertGreater(render.rindex("this._fitCenterBadge();"), render.rindex("this._bindKnobControls();"))
        self.assertIn("getComputedTextLength", SRC)
        self.assertIn('window.addEventListener("resize", this._onBadgeResize);', SRC)
        self.assertIn('window.removeEventListener("resize", this._onBadgeResize);', SRC)
        self.assertIn("if (this._plateFit && this._plateFit.key === key) return;", SRC)

    def test_the_plate_font_is_a_woff2_subset_with_its_licence(self):
        font = embedded_font()
        self.assertEqual(font[:4], b"wOF2", "a WOFF2 container")
        self.assertLess(len(font), 20000, "a subset, not the whole family")
        self.assertEqual(int.from_bytes(font[8:12], "big"), len(font), "the WOFF2 header length matches the bytes")
        self.assertIn('new FontFace("ParlorWave Plate"', SRC)
        self.assertIn("SIL Open Font License, Version 1.1", SRC)
        # Jost's OFL.txt declares no Reserved Font Name. Its copyright line
        # names a host, which the panel may not; THIRD_PARTY_NOTICES.md and
        # the font's own name table carry it verbatim.
        self.assertIn("Copyright 2020 The Jost Project Authors", SRC)
        self.assertNotIn('Reserved Font Name "Jost"', SRC)
        self.assertIn("PERMISSION & CONDITIONS", SRC)
        # the subset and the licence texts are kept in the source tree, outside
        # the shippable package; the licence travels inside the panel itself
        source = BRAND / "parlorwave-plate.woff2"
        if source.exists():
            self.assertEqual(font, source.read_bytes(), "the embedded bytes are the built subset")
            for name in ("OFL-Jost.txt", "OFL-MrDafoe.txt", "NOTICE.md", "parlorwave-emblem.svg"):
                self.assertTrue((BRAND / name).exists(), name)

    def test_the_package_ships_no_file_beside_the_panel(self):
        # the public export copies panel/*.js only; nothing else may rely on the package dir
        self.assertEqual([p.name for p in PANEL.parent.iterdir() if p.is_file() and p.suffix != ".js" and "__pycache__" not in p.parts], [])


class ThePlaceOfTheBadge(unittest.TestCase):
    def test_desktop_cell_and_placement(self):
        badge = STYLE[STYLE.index(".console-badge {"):]
        head = badge.split("}")[0]
        self.assertIn("width:520px;", head)
        self.assertIn("aspect-ratio:520 / 150;", head)
        self.assertIn("top:73px;", head)
        self.assertIn("transform:translate(-50%, -48.67%);", head)
        self.assertIn("container-type:inline-size;", STYLE[STYLE.index(".console-faceplate {"):].split("}")[0])

    def test_tablet_sizes_to_the_gap_between_the_eyes(self):
        tablet = STYLE[STYLE.index("@media (max-width: 900px)"):STYLE.index("@media (max-width: 560px)")]
        self.assertIn(".console-badge { top:95px; width:270px;", tablet)
        self.assertIn("width:min(402px, calc((50cqw - 156px) * 1.337)); }", tablet)
        self.assertIn(".console-badge { top:91px; width:270px;", tablet)       # landscape phones
        self.assertNotIn("console-badge-script", tablet)

    def test_phone_keeps_the_mark_above_the_eyes(self):
        phone = STYLE[STYLE.index("@media (max-width: 560px)"):]
        self.assertIn(".console-badge { top:22px; width:189px; }", phone)
        # a two-line plate keeps the one-line type and is lifted clear of the rings
        self.assertIn(".console-badge.badge-two-line { top:18px; }", phone)
        self.assertIn("twoLine: { height: 80, size: 22, tracking: 2.2, baselines: [69.2, 96.2] }", SRC)
        self.assertIn('badge.classList.add("badge-two-line")', SRC)
        self.assertIn("@media (max-width: 390px) {\n          .console-badge { width:177px; }", phone)

    def test_hidden_mode_keeps_the_button_and_hides_the_face(self):
        self.assertIn(".console-badge.badge-hidden .console-badge-emblem,\n        .console-badge.badge-hidden .console-badge-plate {", STYLE)
        self.assertIn("this._cycleCenterLogo()", SRC)
        self.assertIn("parlorwave_logo_mode", SRC)


if __name__ == "__main__":
    unittest.main()
