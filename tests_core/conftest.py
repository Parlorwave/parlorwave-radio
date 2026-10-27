"""Real Home Assistant core fixtures (pytest-homeassistant-custom-component).

Run through scripts/test_ha_core.sh, never with the stdlib harness in
ha/tests on the path: that directory carries a FAKE `homeassistant` package.
"""

from __future__ import annotations

from pathlib import Path

import pytest

# The test harness ships its own `custom_components` package (its testing
# config); this integration's lives in ha/custom_components.
import custom_components

_OURS = str(Path(__file__).resolve().parents[1] / "custom_components")
if _OURS not in list(custom_components.__path__):
    custom_components.__path__.append(_OURS)

from backend import FakeBackend  # noqa: E402


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    yield


@pytest.fixture(autouse=True)
def installation_layout(hass, tmp_path):
    """A config directory laid out like a real installation:
    <config>/custom_components/parlorwave_radio. The panel's static root is
    derived from it (hass.config.path), exactly as on Home Assistant OS."""
    (tmp_path / "custom_components").symlink_to(_OURS)
    hass.config.config_dir = str(tmp_path)
    yield


@pytest.fixture
def backend(monkeypatch):
    """One fake add-on, injected at the integration's transport seam."""
    b = FakeBackend()
    import custom_components.parlorwave_radio as pkg
    import custom_components.parlorwave_radio.config_flow as cf
    monkeypatch.setattr(pkg, "async_get_clientsession", lambda hass: b)
    monkeypatch.setattr(cf, "async_get_clientsession", lambda hass: b)
    return b
