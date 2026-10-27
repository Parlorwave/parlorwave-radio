"""Diagnostics support for Parlorwave Radio.

POSITIVE ALLOWLIST ONLY.

This file builds the public diagnostic document exported when a user clicks
"Download Diagnostics" in Home Assistant. It is designed to be safely attached
to public GitHub issues without leaking:
  - installation IDs or persistent identifiers;
  - Music Assistant/backend URLs, hostnames, or IP addresses;
  - API keys, tokens, or credentials;
  - entity IDs, device IDs, or speaker names;
  - filesystem paths;
  - library, track, album, or artist names;
  - calendar or news titles/contents;
  - requests or any user-generated text.

Every field in the returned dictionary is explicitly constructed from safe
scalar primitives, booleans, counts, or static enumerated codes.
"""

from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DATA_VERSION, DOMAIN
from .readiness import build as build_readiness


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: ConfigEntry
) -> dict[str, Any]:
    """Return diagnostics for a config entry using an explicit allowlist."""
    coordinator = hass.data.get(DOMAIN, {}).get(entry.entry_id)
    version = hass.data.get(DATA_VERSION)

    coord_data = coordinator.data if coordinator and isinstance(coordinator.data, dict) else {}
    health = coord_data.get("health") if isinstance(coord_data.get("health"), dict) else {}
    features = health.get("features") if isinstance(health.get("features"), dict) else {}

    # Readiness provides standardized state & problem codes
    readiness = build_readiness(coord_data, version=version)

    # 1. Integration metadata (safe static scalars)
    diag: dict[str, Any] = {
        "integration": {
            "version": str(version) if version else "unknown",
        }
    }

    # 2. Run mode & reachability (strictly booleans & safe enums, NO URLs/hosts)
    ha_feature = features.get("home_assistant") if isinstance(features.get("home_assistant"), dict) else {}
    ma_feature = features.get("music_assistant") if isinstance(features.get("music_assistant"), dict) else {}
    run_mode = str(ha_feature.get("mode") or "")
    diag["environment"] = {
        "run_mode": run_mode if run_mode in ("addon", "external") else "unknown",
        "backend_reachable": bool(coordinator.last_update_success) if coordinator else False,
        "music_assistant_reachable": bool(ma_feature.get("reachable")),
    }

    # 3. Output counts (COUNTS ONLY, no entity_ids, no speaker names, no player_ids)
    raw_outputs = coord_data.get("outputs") if isinstance(coord_data.get("outputs"), dict) else {}
    output_list = raw_outputs.get("outputs") if isinstance(raw_outputs.get("outputs"), list) else []
    dj_settings = coord_data.get("dj") if isinstance(coord_data.get("dj"), dict) else {}
    dj_outputs = dj_settings.get("outputs") if isinstance(dj_settings.get("outputs"), dict) else {}
    enabled_outputs = dj_outputs.get("enabled") if isinstance(dj_outputs.get("enabled"), list) else []

    diag["outputs"] = {
        "eligible_output_count": len([o for o in output_list if isinstance(o, dict) and o.get("player_id")]),
        "enabled_output_count": len([e for e in enabled_outputs if e]),
    }

    # 4. Text-to-Speech status (booleans only, no provider lists, no voices, no speech text)
    tts_feature = features.get("tts") if isinstance(features.get("tts"), dict) else {}
    tts_providers = tts_feature.get("providers") if isinstance(tts_feature.get("providers"), list) else []
    safe_providers = [p for p in tts_providers if p in ("home_assistant", "chatterbox", "kokoro")]
    diag["speech"] = {
        "tts_available": bool(safe_providers),
        "tts_configured": bool(tts_feature.get("configured")),
    }

    # 5. Readiness state & problem codes (CODES ONLY, no user text, no entity ids)
    checklist = readiness.get("checklist") if isinstance(readiness.get("checklist"), list) else []
    safe_checklist = [
        {
            "code": str(step.get("code") or ""),
            "done": bool(step.get("done")),
            "route": str(step.get("where") or ""),
        }
        for step in checklist
        if isinstance(step, dict) and step.get("code")
    ]

    blockers = readiness.get("blockers") if isinstance(readiness.get("blockers"), list) else []
    safe_problem_codes = [
        str(b.get("code"))
        for b in blockers
        if isinstance(b, dict) and b.get("code")
    ]
    diag["readiness"] = {
        "state": str(readiness.get("state") or "unknown"),
        "complete_steps": int(readiness.get("complete") or 0),
        "total_steps": int(readiness.get("total") or 0),
        "checklist": safe_checklist,
        "active_problem_codes": safe_problem_codes,
    }

    # 6. Bounded lifecycle state (strictly boolean health state, no audio URLs, no model configs)
    observer_feature = features.get("observer") if isinstance(features.get("observer"), dict) else {}
    diag["lifecycle"] = {
        "observer_running": bool(observer_feature.get("running")),
    }

    return diag
