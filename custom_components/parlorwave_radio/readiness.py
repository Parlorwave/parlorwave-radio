"""Settings' view model: is this installation ready, and what is missing.

WHY THIS IS A MODULE AND NOT PANEL JAVASCRIPT. The same reason the
Newsroom's view model is one. The backend already knows, exactly, what is
wrong with an installation -- it publishes twenty-odd structured problem
codes with severities and components through `/health/problems`, and the
integration knows the rest (which outputs are enabled, which speech
entities exist in this Home Assistant, what the context publisher is
reading). Restating any of that in the browser would mean a second
diagnosis, in a language with no tests against the thing it diagnoses,
free to disagree with the service that actually refuses. So Settings is
built HERE, with tests, and the panel renders sentences.

It is also the boundary that makes "no secret ever renders" a property
rather than a hope. The panel is only ever handed this document, so a
token, an API key, a private filesystem path or an internal hostname
cannot reach a screen unless this file puts it there -- and `scrub`
below is applied to every piece of free text that comes from somewhere
else. The one address deliberately carried is the Music Assistant
endpoint, because "which Music Assistant am I pointed at" is a question
a setup screen exists to answer.

WHAT IT MAY NOT DO. It is a view. It performs no probe, opens no socket,
writes no setting and never raises: a readiness screen that can fail is a
readiness screen that lies.

THE THREE STATES, AND WHERE THEY COME FROM.

    ready            nothing authoritative is wrong and the four things a
                     station needs in order to work are all true
    needs setup      something has never been configured -- including one
                     of those four
    needs attention  something that WAS configured has stopped working

The split between the last two is per problem code (`_COPY`), because
"you have not done this yet" and "this broke" are different sentences to
a person even when they are the same severity to a service.

OPTIONAL IS NOT BROKEN. A local music catalog, a custom voice engine, an
external writing model and a news feed are capabilities this product is
complete without. None of them produces a problem in the backend and none
of them produces one here: they are reported as capabilities, with the
screen that owns them named, and they never move the overall state.
"""

from __future__ import annotations

import re
from typing import Any, Callable

# --- the routes a setup screen may send somebody to ---------------------------
#
# Tokens, not URLs and not prose: the panel decides whether a route is a
# link into Home Assistant or a jump to one of its own screens, and the
# ownership rule ("break style is Booth's, bulletins are the Newsroom's")
# is expressed once, here, rather than in copy that can drift from it.
# The Home Assistant options flow. It still exists and still works, but
# it is no longer where the DJ-enabled speakers are CHOSEN -- that is the
# Settings screen's own "Speakers Parlorwave may DJ on" card, which writes
# the same service setting. Nothing routes a person out of the panel for a
# setting the panel can edit.
WHERE_OPTIONS = "options"        # the integration's own Options flow
WHERE_SETTINGS = "settings"      # this panel's own Settings screen
WHERE_ADDON = "addon"            # the Parlorwave Radio add-on's Configuration
WHERE_HA_TTS = "ha_tts"          # Home Assistant's integrations page
WHERE_ONAIR = "onair"
WHERE_BOOTH = "booth"
WHERE_NEWSROOM = "newsroom"
WHERE_STATION = "station"

READY = "ready"
NEEDS_SETUP = "needs_setup"
NEEDS_ATTENTION = "needs_attention"
CHECKING = "checking"

SETUP, ATTENTION = "setup", "attention"
BLOCKER, WARNING = "blocker", "warning"

#: speech states `health.ha_tts_problems` reports for a selection that
#: cannot currently speak
SPEECH_BAD = {"unavailable", "missing", "unreachable", "auth_rejected",
              "unconfigured"}


# --- the one place the service's words become a person's ----------------------
#
# (title, detail, where, kind). The backend's own summary and action are
# written for whoever deploys the service: they name environment
# variables, URLs and, for one code, a filesystem path. None of that is
# shown. A code that is not listed here still reaches the screen, through
# `scrub`, because an unrecognised problem the customer cannot see at all
# is worse than one described awkwardly.
_COPY: dict[str, tuple[str, str, str | None, str]] = {
    # --- Music Assistant ---
    "ma_url_missing": (
        "Music Assistant is not connected",
        "ParlorWave Radio needs to know where your Music Assistant server "
        "is before it can follow anything you play.",
        WHERE_ADDON, SETUP),
    "ma_url_invalid": (
        "The Music Assistant address cannot be used",
        "It has to be a web address with a host name or IP, starting with "
        "http:// or https://.",
        WHERE_ADDON, SETUP),
    # THE TOKEN IS CREATED IN MUSIC ASSISTANT. Saying so in every sentence
    # that mentions it is not repetition -- pasting a HOME ASSISTANT
    # long-lived token into this field is an easy mistake
    # to make when both products issue a "long-lived access token" and the
    # add-on lives inside Home Assistant. Music Assistant's own wording is
    # used ("Profile > Access tokens", verified against MA 2.10) so the
    # sentence matches what is on the screen it sends people to.
    "ma_token_missing": (
        "Music Assistant needs an access token",
        "Open Music Assistant, go to Profile → Access tokens → Create new "
        "token, and paste it into the ParlorWave Radio add-on's "
        "Configuration tab. It must be created in Music Assistant; a Home "
        "Assistant token will not work.",
        WHERE_ADDON, SETUP),
    "ma_auth_rejected": (
        "Music Assistant refused the access token",
        "Music Assistant did not accept the token in the add-on's "
        "Configuration tab. The commonest reason is a Home Assistant token "
        "pasted there by mistake: this one has to be created in Music "
        "Assistant, under Profile → Access tokens.",
        WHERE_ADDON, ATTENTION),
    "ma_unreachable": (
        "Music Assistant did not answer",
        "Check that Music Assistant is running, and that this server can "
        "reach it over the network.",
        WHERE_ADDON, ATTENTION),
    # --- spoken audio delivery ---
    "advertise_url_missing": (
        "Music Assistant cannot collect the spoken breaks",
        "ParlorWave Radio renders each break as a short piece of audio that "
        "Music Assistant fetches. It does not yet know which address to "
        "offer it.",
        WHERE_ADDON, SETUP),
    "advertise_url_invalid": (
        "Music Assistant cannot collect the spoken breaks",
        "The address ParlorWave Radio offers for its own audio is not a "
        "usable web address.",
        WHERE_ADDON, SETUP),
    "advertise_url_loopback": (
        "Spoken breaks may not reach Music Assistant",
        "ParlorWave Radio is offering its audio on an address only this "
        "machine can reach. That works when Music Assistant runs here too; "
        "otherwise breaks will be silent.",
        WHERE_ADDON, ATTENTION),
    "base_dir_unwritable": (
        "ParlorWave Radio cannot save anything",
        "Its storage is not writable, so settings, voices and station "
        "history cannot be kept between restarts.",
        WHERE_ADDON, ATTENTION),
    # --- outputs ---
    "no_outputs_enabled": (
        "No speakers are enabled for the DJ",
        "Choose which speakers ParlorWave Radio is allowed to follow and "
        "talk on, under Speakers ParlorWave may DJ on. Nothing else it does "
        "can start until one is chosen.",
        WHERE_SETTINGS, SETUP),
    "output_selection_not_enabled": (
        "The current speaker is not one the DJ may use",
        "Either pick a different Active DJ speaker on On Air, or tick this "
        "one under Speakers ParlorWave may DJ on.",
        WHERE_SETTINGS, ATTENTION),
    "output_selection_missing": (
        "No current speaker has been picked",
        "Several speakers are DJ-enabled, so ParlorWave Radio does not know "
        "which one to follow. Pick one on On Air.",
        WHERE_ONAIR, SETUP),
    # --- speech ---
    "tts_unconfigured": (
        "There is no voice to speak with",
        "ParlorWave Radio speaks through Home Assistant's text-to-speech. "
        "Add a text-to-speech integration — Piper runs locally, Home "
        "Assistant Cloud is the hosted option — and a voice appears "
        "here on its own.",
        WHERE_HA_TTS, SETUP),
    "tts_voice_unselected": (
        "No voice has been chosen yet",
        "ParlorWave Radio speaks with one of the voices Home Assistant "
        "already has. Pick the one you want the DJ to use in Booth.",
        WHERE_BOOTH, SETUP),
    "tts_selected_provider_unconfigured": (
        "The chosen voice cannot speak on this installation",
        "It needs a speech service this installation does not have. Choose "
        "a Home Assistant voice in Booth instead.",
        WHERE_BOOTH, ATTENTION),
    "ha_unconfigured": (
        "The chosen voice needs Home Assistant speech",
        "The selected voice speaks through Home Assistant, but ParlorWave "
        "Radio has no access to it. Restart the add-on, or choose another "
        "voice in Booth.",
        WHERE_BOOTH, ATTENTION),
    "ha_auth_rejected": (
        "Home Assistant refused ParlorWave Radio's access",
        "Restart the ParlorWave Radio add-on so it is issued fresh access.",
        WHERE_ADDON, ATTENTION),
    "ha_unreachable": (
        "Home Assistant could not be reached",
        "ParlorWave Radio renders speech through Home Assistant and could "
        "not reach it. Breaks stay silent until it can.",
        WHERE_ADDON, ATTENTION),
    "ha_tts_entity_missing": (
        "The chosen voice no longer exists",
        "Whatever provided it has gone. Choose another voice in Booth.",
        WHERE_BOOTH, ATTENTION),
    "ha_tts_entity_unavailable": (
        "The chosen voice is unavailable",
        "Its text-to-speech integration is not running right now. Start it, "
        "or choose another voice in Booth.",
        WHERE_BOOTH, ATTENTION),
    # --- following playback ---
    "observer_not_running": (
        "Playback is not being followed",
        "ParlorWave Radio is not watching what Music Assistant plays, so no "
        "break can be scheduled. Restarting the add-on usually clears this.",
        WHERE_ADDON, ATTENTION),
    "observer_mode_invalid": (
        "Playback following is misconfigured",
        "ParlorWave Radio was told to follow playback in a way it does not "
        "understand, so it is not following anything.",
        WHERE_ADDON, SETUP),
    "observer_disabled": (
        "Playback following is switched off",
        "ParlorWave Radio has been told not to watch Music Assistant, so no "
        "break can be scheduled from what you play.",
        WHERE_ADDON, ATTENTION),
    # --- the optional writer: never written as damage ---
    "optional_writer_unavailable": (
        "The optional writing model is not answering",
        "Breaks are being written by the built-in writer instead, exactly as "
        "they are on an installation with no model at all. Nothing is "
        "missing from the broadcast.",
        None, ATTENTION),
    # --- announcements ---
    "announcement_store_unreadable": (
        "Announcements are on hold",
        "ParlorWave Radio cannot read its record of which announcements "
        "have already aired, so it is not airing any until the record is "
        "repaired or restored. Nothing that already aired can air twice.",
        WHERE_STATION, ATTENTION),
    "announcement_settings_unreadable": (
        "Announcements are on hold",
        "ParlorWave Radio cannot read its Station settings, so "
        "announcements are held off until those settings are saved again.",
        WHERE_STATION, ATTENTION),
}


# --- scrubbing ----------------------------------------------------------------
#
# Applied to every piece of free text that did not originate in this file.
# The patterns are deliberately blunt: a diagnostic sentence that loses a
# word is a small cost, a rendered token is not recoverable.
_SECRET_RE = re.compile(
    r"(?i)\b(?:bearer|token|api[\s_-]?key|password|secret|credential)s?\b"
    r"(?:\s*[:=]\s*|\s+)?\S*")
_URL_RE = re.compile(r"(?i)\b[a-z][a-z0-9+.\-]*://\S+")
_PATH_RE = re.compile(r"(?<![\w.~])/(?:[\w.@%+\-]+/)+[\w.@%+\-]*|"
                      r"(?<![\w.~])/[\w.@%+\-]{2,}(?=[\s,.;:)]|$)")
_HOSTPORT_RE = re.compile(r"(?i)\b(?:[a-z0-9\-]+\.)+[a-z0-9\-]+:\d{2,5}\b")
#: SCREAMING_SNAKE tokens -- the service's configuration vocabulary. Every
#: backend `action` string is written for whoever deploys the service, and
#: names one or more of them; none means anything to a customer, and
#: several name the product's internal module.
_ENVVAR_RE = re.compile(r"\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b")
_ELLIPSIS = "…"


def scrub(text: Any, limit: int = 240) -> str:
    """Free text with anything address-, path-, credential-, configuration-
    or internal-name shaped removed.

    This is the floor under the whole customer-facing health surface. A
    problem code this build has never heard of still reaches a screen --
    an invisible fault is worse than an awkward sentence -- and it arrives
    through here, so the set of things that CANNOT be rendered has to be a
    property of this function rather than of the codes enumerated above.

    Never raises and never returns None: a status surface that can fail is
    not a status surface."""
    try:
        out = str(text or "")
    except Exception:  # noqa: BLE001 - nothing here may throw
        return ""
    for pattern in (_SECRET_RE, _URL_RE, _HOSTPORT_RE, _PATH_RE, _ENVVAR_RE):
        out = pattern.sub(_ELLIPSIS, out)
    out = re.sub(r"\s{2,}", " ", out).strip()
    return out[:limit]


# --- small readers ------------------------------------------------------------

def _features(health: dict[str, Any] | None) -> dict[str, Any]:
    return ((health or {}).get("features") or {}) if isinstance(health, dict) else {}


def _problems(health: dict[str, Any] | None) -> list[dict[str, Any]]:
    raw = (health or {}).get("problems") if isinstance(health, dict) else None
    return [p for p in (raw or []) if isinstance(p, dict) and p.get("code")]


def _issue(problem: dict[str, Any]) -> dict[str, Any]:
    """One problem, in a person's words, with somewhere to go."""
    code = str(problem.get("code"))
    severity = str(problem.get("severity") or "")
    known = _COPY.get(code)
    if known:
        title, detail, where, kind = known
    else:
        # UNRECOGNISED. It stays visible -- a fault a customer cannot see at
        # all is worse than one described plainly -- but it is no longer
        # described in the SERVICE'S words. Those are written for whoever
        # deploys the service: they name engines, environment variables and
        # addresses, and this branch was the one path by which such a
        # string could reach a screen. Scrubbing it was pattern-matching a
        # vocabulary that grows; not rendering it is a property.
        #
        # The code still travels, and Settings' support details print it,
        # so a bug report can name the thing exactly.
        title = "ParlorWave Radio reported a problem"
        detail = ("This version has no description for it. The support "
                  "details at the bottom of this screen name it exactly.")
        where, kind = None, ATTENTION
    return {"code": code, "severity": BLOCKER if severity in ("fatal", "error") else WARNING,
            "title": title, "detail": detail, "where": where, "kind": kind}


# --- the sections -------------------------------------------------------------

def _music_assistant(features: dict[str, Any]) -> dict[str, Any]:
    ma = features.get("music_assistant") or {}
    endpoint = ma.get("url") or ""
    token = bool(ma.get("token_present"))
    reachable = bool(ma.get("reachable"))
    if reachable:
        state, label = "ok", "Connected"
        detail = "ParlorWave Radio can see your Music Assistant server."
    elif not endpoint:
        state, label = "setup", "Not connected"
        detail = "No Music Assistant server has been set yet."
    elif not token:
        state, label = "setup", "Waiting for a Music Assistant token"
        detail = ("The server address is set. Music Assistant still needs to "
                  "issue ParlorWave Radio an access token before it can be "
                  "read -- created in Music Assistant, not in Home Assistant.")
    else:
        state, label = "bad", "Not answering"
        detail = "The server is configured but did not respond."
    rows = [
        ["Server", endpoint or "Not set"],
        # Named for the product that ISSUES it, not for what it is. "Access
        # token" alone, on a screen inside Home Assistant, invites pasting
        # a Home Assistant token into it.
        ["Music Assistant access token", "Present" if token else "Not set"],
    ]
    if reachable:
        rows.append(["Players visible", str(ma.get("players") or 0)])
    return {"state": state, "label": label, "detail": detail, "rows": rows,
            "endpoint": endpoint, "token_present": token, "reachable": reachable,
            "where": WHERE_ADDON}


def _outputs(features: dict[str, Any], data: dict[str, Any]) -> dict[str, Any]:
    out = features.get("outputs") or {}
    enabled_ids = [o for o in (out.get("enabled") or []) if o]
    chosen = out.get("selected") or ""
    dj_on = bool(out.get("dj_enabled"))
    inventory = {}
    listing = (data.get("outputs") or {})
    for entry in (listing.get("outputs") or []) if isinstance(listing, dict) else []:
        if isinstance(entry, dict) and entry.get("player_id"):
            inventory[str(entry["player_id"])] = entry

    def _row(pid: str) -> dict[str, Any]:
        found = inventory.get(pid) or {}
        return {"name": str(found.get("name") or pid),
                "available": found.get("available") is not False,
                "known": bool(found),
                "current": pid == chosen or (not chosen and len(enabled_ids) == 1)}

    speakers = [_row(pid) for pid in enabled_ids]
    current = next((s["name"] for s in speakers if s["current"]), "")
    if not enabled_ids:
        state, label = "setup", "None enabled"
        detail = ("ParlorWave Radio will not follow or speak on any speaker "
                  "until you choose at least one.")
    elif chosen:
        state, label = "ok", f"{len(enabled_ids)} enabled"
        detail = f"{current} is the speaker ParlorWave Radio is following."
    elif len(enabled_ids) == 1:
        state, label = "ok", "1 enabled"
        detail = (f"{current} is the only DJ-enabled speaker, so that is the "
                  "one ParlorWave Radio follows.")
    else:
        state, label = "warn", f"{len(enabled_ids)} enabled"
        detail = ("No current speaker has been picked, so nothing is being "
                  "followed yet.")
    # No route: the allow-list is edited on the very screen this section is
    # rendered on. A "go and configure it" button pointing at the page you
    # are standing on is how the old options-flow detour started.
    return {"state": state, "label": label, "detail": detail,
            "speakers": speakers, "current": current, "dj_enabled": dj_on,
            "where": None}


def _speech(features: dict[str, Any], problems: list[dict[str, Any]],
            tts_entities: int) -> dict[str, Any]:
    tts = features.get("tts") or {}
    providers = [str(p) for p in (tts.get("providers") or [])]
    selected = tts.get("selected") or {}
    ha_speech = "home_assistant" in providers
    local_engine = any(p in providers for p in ("chatterbox", "kokoro"))
    bad = [p for p in problems
           if p["severity"] == BLOCKER and p["code"] in _SPEECH_CODES]
    unchosen = any(p["code"] == "tts_voice_unselected" for p in problems)
    voice = selected.get("name") or ""
    voice_state = str(selected.get("state") or "")

    if bad:
        state, label = "bad", "Cannot speak"
        detail = bad[0]["title"] + "."
    elif unchosen:
        # Nobody has picked a voice. The engines may be perfectly healthy;
        # what is missing is a choice, and a choice that has not been made
        # is setup, not damage.
        state, label = "setup", "No voice chosen"
        detail = ("Pick the voice the DJ speaks with in Booth. Home "
                  "Assistant's own voices are listed there.")
    elif not providers:
        state, label = "setup", "No voice yet"
        detail = ("ParlorWave Radio speaks through Home Assistant's "
                  "text-to-speech. Add one and a voice appears here.")
    elif ha_speech and not tts_entities:
        state, label = "setup", "No voice yet"
        detail = ("Home Assistant has no text-to-speech engine installed yet, "
                  "so there is no voice to speak with.")
    elif voice_state in SPEECH_BAD:
        state, label = "bad", "Cannot speak"
        detail = "The chosen voice is not usable right now."
    else:
        state, label = "ok", "Ready"
        detail = (f"Breaks are spoken by {voice}." if voice
                  else "ParlorWave Radio has a voice to speak with.")
    # WHAT SPEAKS IS WHAT THE CHOSEN VOICE ROUTES THROUGH. This row used to
    # name Home Assistant whenever Home Assistant speech existed at all,
    # even on an installation whose every break is spoken by the voice
    # engine -- the engines PRESENT, where the reader is asking which one
    # is on the air. The route is the answer when there is one; the
    # engines present are the fallback, for a station that has not chosen.
    speaks = _PROVIDER_WORDS.get(str(selected.get("provider") or ""))
    if not speaks:
        speaks = ("Home Assistant text-to-speech" if ha_speech
                  else ("ParlorWave voice engine" if local_engine
                        else "Not available"))
    rows = [["Speech", speaks]]
    if voice:
        rows.append(["Voice on air", voice])
    if ha_speech:
        rows.append(["Voices in Home Assistant",
                     str(tts_entities) if tts_entities else "None installed"])
    return {"state": state, "label": label, "detail": detail, "rows": rows,
            "home_assistant": ha_speech, "local_engine": local_engine,
            "voice": voice, "ok": state == "ok",
            "where": WHERE_BOOTH if (unchosen or state != "setup")
                     else WHERE_HA_TTS}


_SPEECH_CODES = {"tts_unconfigured", "tts_voice_unselected",
                 "tts_selected_provider_unconfigured",
                 "ha_unconfigured", "ha_auth_rejected", "ha_unreachable",
                 "ha_tts_entity_missing", "ha_tts_entity_unavailable"}


def _register_speech_codes() -> None:
    """Whatever stops speech working is exactly what the speech step is
    waiting for -- imported from one set rather than listed twice."""
    _STEP_CODES["speech"] = set(_SPEECH_CODES)


def _writer(features: dict[str, Any], problems: list[dict[str, Any]]) -> dict[str, Any]:
    """The base product writes every break without any model at all.

    That is the fact this card exists to state. An installation with no
    external writer is not running in a reduced mode and is never
    described as one: the optional model is an enhancement that some
    installations add, and its absence is written the way the absence of
    a second car is written."""
    writer = features.get("writer") or {}
    llm = writer.get("llm") or {}
    configured = bool(llm.get("configured"))
    reachable = writer.get("llm_reachable")
    down = any(p["code"] == "optional_writer_unavailable" for p in problems)
    if not configured:
        opt_state, opt_label = "off", "Not configured"
        opt_detail = ("Optional. An external writing model can be pointed at "
                      "ParlorWave Radio to give breaks more variety. Nothing "
                      "needs it.")
    elif down or reachable is False:
        opt_state, opt_label = "warn", "Not answering"
        opt_detail = ("The model is configured but silent, so the built-in "
                      "writer is doing the writing. The broadcast is "
                      "unaffected.")
    else:
        opt_state, opt_label = "on", "Connected"
        opt_detail = "Breaks are written by the model, with the built-in writer behind it."
    return {
        "state": "ok", "label": "Ready",
        "detail": "Every break ParlorWave Radio speaks is written on this machine.",
        "rows": [
            {"label": "Built-in writer", "badge": "Always available", "tone": "on",
             "detail": "Writes every break with no model, no account and no "
                       "internet connection. This is the product, not a fallback."},
            {"label": "External writing model", "badge": opt_label,
             "tone": opt_state, "detail": opt_detail},
        ],
        "llm_configured": configured,
    }


def _context(context: dict[str, Any], entity_names: dict[str, str]) -> dict[str, Any]:
    """What the DJ is allowed to know about the world.

    Readiness only. WHICH of these the DJ actually mentions in a break is
    a Booth decision and is not repeated here, and no entity's state or
    detail travels: a name and a verdict is the whole surface."""
    ctx = context or {}
    weather = ctx.get("weather") or {}
    calendar = ctx.get("calendar") or {}
    rows: list[dict[str, Any]] = []

    w_entity = weather.get("entity") or ""
    w_state = str(weather.get("state") or ("not_configured" if not w_entity else ""))
    if not w_entity:
        rows.append({"label": "Weather", "badge": "Not set", "tone": "off",
                     "detail": "No weather entity has been chosen."})
    elif w_state == "unavailable":
        rows.append({"label": "Weather", "badge": "Unavailable", "tone": "warn",
                     "detail": f"{entity_names.get(w_entity, w_entity)} is not "
                               "reporting right now."})
    else:
        rows.append({"label": "Weather", "badge": "Available", "tone": "ok",
                     "detail": entity_names.get(w_entity, w_entity)})

    selected = [e for e in (calendar.get("entities") or []) if e]
    failed = [e for e in (calendar.get("failed") or []) if e]
    if not selected:
        rows.append({"label": "Calendar", "badge": "Not set", "tone": "off",
                     "detail": "No calendar has been chosen."})
    elif failed:
        rows.append({"label": "Calendar", "badge": "Partly unavailable", "tone": "warn",
                     "detail": f"{len(failed)} of {len(selected)} chosen calendars "
                               "could not be read."})
    else:
        names = ", ".join(entity_names.get(e, e) for e in selected[:3])
        more = f" and {len(selected) - 3} more" if len(selected) > 3 else ""
        rows.append({"label": "Calendar", "badge": "Available", "tone": "ok",
                     "detail": names + more})

    sun = (ctx.get("sun") or {}).get("available")
    rows.append({"label": "Daylight", "badge": "Available" if sun else "Unavailable",
                 "tone": "ok" if sun else "warn",
                 "detail": "Sunrise and sunset come from Home Assistant; nothing "
                           "to configure." if sun
                           else "Home Assistant is not reporting the sun right now."})

    published = ctx.get("published_at")
    error = scrub(ctx.get("error"), 160) if ctx.get("ok") is False else ""
    # The weather entity and the calendars are chosen on the panel's own
    # Settings screen now (its Sources card writes the same entry options
    # the options flow does), so the route stays on the screen.
    return {"rows": rows, "published_at": published, "error": error,
            "where": WHERE_SETTINGS}


def _optional(features: dict[str, Any], voices: dict[str, Any] | None,
              news: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Capabilities some installations have. None of them is a fault.

    Each says what it is, whether this installation has it, and which
    screen owns it -- never a control, because the control lives there."""
    catalog = features.get("catalog") or {}
    # The voice engine's OWN capability block -- the same one the Booth
    # reads to decide whether Create a Voice is offered at all. Deriving
    # it from the speech providers instead would be a second opinion able
    # to disagree with the screen that owns the feature.
    cloning = ((voices or {}).get("cloning") or {})
    engine = bool(cloning.get("configured"))
    custom = len([v for v in ((voices or {}).get("customs") or [])
                  if isinstance(v, dict) and v.get("has_sample")])
    # A service that does not offer NEW voices in this release says so in
    # the same block; the row must not then call recording "Available".
    # Voices that already exist still count and still work.
    enroll = cloning.get("reason") != "not_qualified"

    tracks = int(catalog.get("track_count") or 0)
    has_catalog = bool(catalog.get("usable"))
    items = [{
        "key": "catalog",
        "label": "Local music catalog",
        "badge": f"{tracks:,} tracks" if has_catalog else "Not in this release",
        "tone": "on" if has_catalog else "off",
        "detail": ("ParlorWave Radio can pick music itself: stations from a "
                   "song, requests, and endless refill."
                   if has_catalog else
                   "Building one is not part of this release. Music Assistant "
                   "programmes the music and ParlorWave Radio presents it, "
                   "which is a complete way to run the station."),
        "where": WHERE_STATION,
    }, {
        "key": "voice_engine",
        "label": "Custom voices",
        # Without an engine the feature is not missing from the release --
        # the ENGINE is not bundled -- so the badge says what it needs.
        "badge": (f"{custom} created" if engine and custom
                  else "Available" if engine and enroll
                  else "Not in this release" if not enroll
                  else "Needs a voice engine"),
        "tone": "on" if engine and (custom or enroll) else "off",
        "detail": ("Voices can be created from a short recording."
                   if engine and enroll else
                   "Making a voice from a recording is not part of this "
                   "release. Voices you already have keep working, and Home "
                   "Assistant's own voices work without it."
                   if not enroll else
                   "Needs the optional ParlorWave voice engine: a speech "
                   "service you run yourself, not bundled with ParlorWave "
                   "Radio. Add its address under Optional services. Home "
                   "Assistant's own voices work without it."),
        "where": WHERE_BOOTH,
    }]

    bulletins = ((news or {}).get("newsroom") or {}).get("bulletins") or {}
    if news is not None:
        on = bool(bulletins.get("enabled"))
        configured = bool(bulletins.get("configured"))
        items.append({
            "key": "newsroom",
            "label": "News bulletins",
            # ENABLED, not ON AIR. "On air" is the product's word for
            # something that is airing at this moment -- the lamp in the
            # masthead, the state line on the stage. This row only says
            # the feature is switched on and has a feed; whether a
            # bulletin is playing right now is the Newsroom's question,
            # not a readiness one.
            "badge": "Enabled" if on and configured else (
                "Configured, off" if configured else "No feed"),
            "tone": "on" if on and configured else "off",
            "detail": ("A news podcast airs between songs on the schedule you set."
                       if configured else
                       "Point the Newsroom at a news podcast feed and bulletins "
                       "air between songs. Nothing else depends on it."),
            "where": WHERE_NEWSROOM,
        })
    return items


#: which setup step a problem belongs to. A problem that has a step is
#: SAID ON THAT STEP and nowhere else: a first-run installation that lists
#: "no speakers are enabled" as a fault beside the step asking you to
#: choose one reads as broken rather than as new, which is the opposite of
#: what is true.
_STEP_CODES: dict[str, set[str]] = {
    "music_assistant": {"ma_url_missing", "ma_url_invalid", "ma_token_missing",
                        "ma_auth_rejected", "ma_unreachable"},
    "outputs": {"no_outputs_enabled"},
    "speech": set(),          # filled from _SPEECH_CODES below
}


def _adopt(step: dict[str, Any], issues: list[dict[str, Any]]) -> dict[str, Any]:
    """Give an unfinished step the problem's own instruction, and mark the
    problem as spoken for."""
    if step["done"]:
        return step
    codes = _STEP_CODES.get(step["key"]) or set()
    found = next((i for i in issues if i["code"] in codes), None)
    if found is None:
        return step
    return {**step, "detail": found["detail"], "where": found["where"],
            "code": found["code"]}


def _checklist(ma: dict[str, Any], outputs: dict[str, Any],
               speech: dict[str, Any]) -> list[dict[str, Any]]:
    """The four things a station needs, and nothing else.

    This is the whole first-run path. Every optional capability is
    deliberately absent from it: a new installation must never be told it
    needs a catalog, a voice engine, a writing model or a news feed, and
    the surest way to guarantee that is for this list not to know they
    exist."""
    return [
        {"key": "music_assistant",
         "label": "Music Assistant connected",
         "next": "connect Music Assistant",
         "done": ma["reachable"],
         "detail": (ma["detail"] if not ma["reachable"]
                    else "ParlorWave Radio follows what you play there."),
         "where": None if ma["reachable"] else WHERE_ADDON},
        {"key": "outputs",
         "label": "A speaker the DJ may use",
         "next": "choose a speaker",
         "done": bool(outputs["speakers"]),
         "detail": (f"{outputs['current']} — chosen from "
                    f"{len(outputs['speakers'])} enabled."
                    if outputs["speakers"] and outputs["current"]
                    else "Choose which speakers ParlorWave Radio may follow "
                         "and talk on." if not outputs["speakers"]
                    else "Enabled, but none is currently picked."),
         "where": None if outputs["speakers"] else WHERE_SETTINGS},
        {"key": "speech",
         "label": "A voice to speak with",
         "next": "give it a voice",
         "done": speech["ok"],
         "detail": speech["detail"],
         "where": None if speech["ok"] else speech["where"]},
        {"key": "dj",
         "label": "The DJ is switched on",
         "next": "switch the DJ on",
         "done": outputs["dj_enabled"],
         "detail": ("Breaks are scheduled between songs."
                    if outputs["dj_enabled"] else
                    "ParlorWave Radio is set up but silent. Switch the DJ on "
                    "from On Air."),
         "where": None if outputs["dj_enabled"] else WHERE_ONAIR},
    ]


def _headline(state: str, remaining: list[dict[str, Any]],
              blockers: list[dict[str, Any]], warnings: int) -> tuple[str, str]:
    if state == CHECKING:
        return ("Checking this installation…",
                "ParlorWave Radio has not answered yet. Nothing is wrong with "
                "that on a service that has only just started.")
    if state == NEEDS_ATTENTION:
        first = next(b for b in blockers if b["kind"] == ATTENTION)
        rest = len(blockers) - 1
        return ("Needs attention.",
                first["title"] + ". " + first["detail"] if not rest else
                f"{first['title']}, and {rest} other "
                f"{'thing' if rest == 1 else 'things'} to fix. "
                f"{first['detail']}")
    if state == NEEDS_SETUP:
        if remaining:
            # The HOW is on the step itself, immediately below this. The
            # verdict says which thing is next and how much is left, and
            # then gets out of the way.
            step = remaining[0]
            more = (f" {len(remaining) - 1} more step"
                    f"{'s' if len(remaining) > 2 else ''} after that."
                    if len(remaining) > 1 else
                    " It is the last one.")
            return ("Not quite ready.", f"Next, {step['next']}.{more}")
        first = blockers[0]
        return ("Not quite ready.", first["title"] + ". " + first["detail"])
    if warnings:
        return ("Ready.",
                "Everything the station needs is in place. "
                f"{warnings} thing{'s are' if warnings > 1 else ' is'} worth a "
                "look below.")
    return ("Ready.",
            "Everything the station needs is in place. Play something in "
            "Music Assistant and ParlorWave Radio takes it from there.")


# --- the document -------------------------------------------------------------

#: The service itself is not answering Home Assistant (the coordinator's
#: last refresh failed). Not a backend problem code: the backend cannot
#: report that it is unreachable, so the integration says it.
SERVICE_UNREACHABLE = "service_unreachable"
_SERVICE_UNREACHABLE = {
    "code": SERVICE_UNREACHABLE, "severity": BLOCKER,
    "title": "ParlorWave Radio is not answering",
    "detail": ("Home Assistant cannot reach the ParlorWave Radio service, so "
               "what this screen shows is from before it stopped answering. "
               "Check that the add-on is started; everything reconnects by "
               "itself within seconds of it answering again."),
    "where": WHERE_ADDON, "kind": ATTENTION}

#: The service IS answering, but refuses the key this entry holds (the
#: coordinator's last refresh raised ConfigEntryAuthFailed). On Home Assistant
#: OS that is almost always a REINSTALLED add-on: a reinstall replaces /data,
#: so the add-on comes back with a new identity and a new key, and this entry
#: is never re-pointed at it. "Not answering"
#: would be wrong there: it would send people to start an add-on that is running.
#: The route is the integration's page in Devices & services, where both the
#: stale entry and the newly discovered card are.
SERVICE_KEY_REFUSED = "service_key_refused"
_SERVICE_KEY_REFUSED = {
    "code": SERVICE_KEY_REFUSED, "severity": BLOCKER,
    "title": "ParlorWave Radio no longer accepts this connection's key",
    "detail": ("The ParlorWave Radio service is answering, but it refuses the "
               "key Home Assistant has for it. If you reinstalled the add-on, "
               "it is a new installation: delete this ParlorWave Radio entry "
               "and confirm the newly discovered one. Otherwise, restart the "
               "add-on: it sends its key again and this reconnects by itself."),
    "where": WHERE_OPTIONS, "kind": ATTENTION}


def build(data: dict[str, Any] | None = None, *,
          context: dict[str, Any] | None = None,
          news: dict[str, Any] | None = None,
          entity_names: dict[str, str] | None = None,
          tts_entities: int = 0,
          version: str | None = None,
          connected: bool = True,
          key_refused: bool = False) -> dict[str, Any]:
    """The whole Settings screen, as data. Pure, bounded, and never raising.

    `connected` is whether the service answered the integration's last
    refresh. The snapshot is carried across a failed refresh (so a blip
    never blanks a screen), which is exactly why it cannot be read as the
    current state while the service is down: the verdict then leads with
    that, instead of describing a working installation.

    `key_refused` says WHY the refresh failed: the service answered and
    refused this entry's key. It only matters while not connected, and it
    replaces "not answering" with what is true and what to do."""
    data = data or {}
    health = data.get("health")
    known = isinstance(health, dict) and "problems" in health
    features = _features(health)
    _register_speech_codes()
    issues = [_issue(p) for p in _problems(health)]
    if not connected:
        issues.insert(0, dict(_SERVICE_KEY_REFUSED if key_refused
                              else _SERVICE_UNREACHABLE))
    all_blockers = [i for i in issues if i["severity"] == BLOCKER]

    ma = _music_assistant(features)
    outputs = _outputs(features, data)
    speech = _speech(features, issues, tts_entities)
    writer = _writer(features, issues)
    checklist = [_adopt(step, issues)
                 for step in _checklist(ma, outputs, speech)]
    remaining = [c for c in checklist if not c["done"]]
    # A problem a setup step has taken over is not listed a second time.
    spoken = {c["code"] for c in remaining if c.get("code")}
    blockers = [i for i in all_blockers if i["code"] not in spoken]
    warnings = [i for i in issues
                if i["severity"] == WARNING and i["code"] not in spoken]

    if not connected:
        state = NEEDS_ATTENTION
    elif not known:
        state = CHECKING
    elif any(b["kind"] == ATTENTION for b in all_blockers):
        state = NEEDS_ATTENTION
    elif all_blockers or remaining:
        state = NEEDS_SETUP
    else:
        state = READY
    headline, detail = _headline(state, remaining, all_blockers, len(warnings))

    return {
        "known": known,
        "state": state,
        "headline": headline,
        "detail": detail,
        "checklist": checklist,
        "complete": len(checklist) - len(remaining),
        "total": len(checklist),
        "blockers": blockers,
        "warnings": warnings,
        "music_assistant": ma,
        "outputs": outputs,
        "speech": speech,
        "writer": writer,
        "context": _context(context or {}, entity_names or {}),
        "optional": _optional(features, data.get("voice_library"), news),
        "diagnostics": _diagnostics(health, features, data, version, issues),
    }


def _diagnostics(health: dict[str, Any] | None, features: dict[str, Any],
                 data: dict[str, Any], version: str | None,
                 issues: list[dict[str, Any]]) -> dict[str, Any]:
    """Support detail, for a bug report.

    Identity, versions and reachability -- the things somebody helping
    would ask for. No token, no key, no filesystem path, and no address
    except the Music Assistant endpoint the screen already shows above."""
    ha = features.get("home_assistant") or {}
    observer = features.get("observer") or {}
    tts = features.get("tts") or {}
    writer = features.get("writer") or {}
    catalog = features.get("catalog") or {}
    audio = features.get("audio") or {}
    ma = features.get("music_assistant") or {}
    rows: list[list[str]] = []

    def add(key: str, value: Any) -> None:
        if value not in (None, "", []):
            rows.append([key, str(value)])

    add("Installation ID", (health or {}).get("instance_id"))
    add("Integration version", version)
    add("Running as", {"addon": "Home Assistant add-on",
                       "external": "Separate service"}.get(ha.get("mode") or "", "Unknown"))
    add("Home Assistant reachable", _yesno(ha.get("reachable")))
    add("Music Assistant", ma.get("url"))
    add("Music Assistant reachable", _yesno(ma.get("reachable")))
    add("Music Assistant players", ma.get("players"))
    add("Break audio offered", _yesno(bool(audio.get("break_audio_base"))))
    add("Following playback", _yesno(observer.get("running")))
    add("Playback follow mode", observer.get("configured_mode"))
    add("Speech providers", ", ".join(_PROVIDER_WORDS.get(p, "Other")
                                      for p in (tts.get("providers") or [])) or "None")
    add("Writer", "Built-in + external model"
        if (writer.get("llm") or {}).get("configured") else "Built-in")
    add("Local catalog tracks", catalog.get("track_count"))
    add("Health last checked", (health or {}).get("checked_at"))
    add("Observer last error", scrub((observer or {}).get("last_error"), 160))
    return {"rows": rows,
            "problems": [{"code": i["code"], "severity": i["severity"],
                          "title": i["title"], "detail": i["detail"]}
                         for i in issues]}


_PROVIDER_WORDS = {"home_assistant": "Home Assistant text-to-speech",
                   "chatterbox": "ParlorWave voice engine",
                   "kokoro": "ParlorWave voice engine"}


def _yesno(value: Any) -> str | None:
    if value is None:
        return None
    return "Yes" if value else "No"


def entity_names_for(states_get: Callable[[str], Any],
                     entity_ids: list[str]) -> dict[str, str]:
    """Friendly names for exactly the entities Settings names, and no
    others. A helper so the websocket handler never hands the view model a
    whole state machine to rummage through."""
    out: dict[str, str] = {}
    for entity_id in entity_ids:
        if not entity_id:
            continue
        try:
            state = states_get(entity_id)
        except Exception:  # noqa: BLE001
            state = None
        name = ""
        if state is not None:
            name = str((getattr(state, "attributes", None) or {}).get("friendly_name") or "")
        out[entity_id] = name or entity_id
    return out
