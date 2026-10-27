"""The voice-sample upload path: one authenticated Home Assistant view.

WHY A VIEW AND NOT A SERVICE. Every other voice mutation rides a domain
service, and should: they carry a handful of small, schema-validated
fields. A recording does not. The base64 a service call needs inflates a
7 MB clip to ~9.4 MB of JSON, pushes it through the websocket connection
that also carries every state update in the house, and keeps the whole
thing in memory as a string at three separate layers. Home Assistant's own
answer for bytes is an authenticated view, so that is what this is.

WHAT IT DOES NOT DO, deliberately:

  * it is not anonymous -- `requires_auth` is Home Assistant's default and
    is left alone, so a caller needs the same credential the panel already
    holds to be looking at the panel at all;
  * it does not take a URL, a host, a path or a slot from the caller. The
    body is audio and the query carries a closed set of small fields (a
    name, a note, the owner's acknowledgement, a scope); any other field is
    refused. Everything else is the coordinator's;
  * it never reveals the backend. The service credential lives in the
    config entry and is attached by the client on the Home Assistant side;
    browser JavaScript posts to Home Assistant and learns nothing about
    what is behind it.

The refusal shape is the backend's own -- {"ok": false, "code", "message"}
with the status the backend chose -- so the panel has ONE error contract to
render whether the refusal came from here, from Home Assistant, or from
the voice engine three hops away.
"""

from __future__ import annotations

import logging
import re

from homeassistant.components.http import HomeAssistantView

from .api import RadioServiceError, VoiceEngineError
from .const import (BULLETIN_AUDIO_URL, DOMAIN, MAX_SAMPLE_BYTES,
                    VOICE_CONSENT_VERSION, VOICE_SAMPLE_SOURCES,
                    VOICE_SAMPLE_URL, VOICE_SCOPES)

_LOGGER = logging.getLogger(__name__)


class VoiceSampleView(HomeAssistantView):
    """POST a recording, get back the created (or replaced) voice, or a
    refusal.

    Voice enrollment adds three things at this door, each
    checked BEFORE a byte of the body is read:

      * the owner's acknowledgement -- `authorized=true` and the
        `consent_version` of the sentence the panel showed them. Without
        it nothing is forwarded; the backend checks it again;
      * a CLOSED set of query fields. A `url`, a `path`, a `slot` or any
        other key is refused, not ignored, so there is no way to hand this
        view anything to fetch or anywhere to write: the body is the only
        audio it will ever see;
      * what the voice is for (`scope`) and how the sample arrived
        (`source`), from fixed lists.

    `replace=<voice id>` puts the recording under an existing custom voice
    instead of creating one; the id is shape-checked here and the backend
    decides whether it names a voice that can be replaced.

    `library=true` keeps the recording in the Voice
    Library instead: a name and the acknowledgement, no scope, no slot."""

    url = VOICE_SAMPLE_URL
    name = "api:parlorwave_radio:voice_sample"
    # requires_auth defaults to True in Home Assistant. It is named here
    # only so that turning it off would have to be a deliberate edit to a
    # line that says what it is.
    requires_auth = True

    #: Every query field this view understands. Anything else is refused.
    FIELDS = frozenset({"name", "note", "authorized", "consent_version",
                        "scope", "source", "announcement_default", "replace",
                        "library"})

    async def post(self, request):
        hass = request.app["hass"]
        coordinator = next(iter((hass.data.get(DOMAIN) or {}).values()), None)
        if coordinator is None:
            return self.json({"ok": False, "code": "not_ready",
                              "message": "ParlorWave Radio is not set up."},
                             status_code=503)
        query = request.query
        unknown = sorted(set(query.keys()) - self.FIELDS)
        if unknown:
            return self._refuse(400, "unsupported_field",
                                "A voice is made from the recording sent "
                                "with this request, and nothing else.")
        if (query.get("authorized") or "").strip().lower() != "true" or \
                (query.get("consent_version") or "") != VOICE_CONSENT_VERSION:
            return self._refuse(422, "voice_authorization_required",
                                "Confirm that you have permission to create "
                                "and use this voice before it is saved.")
        replace = (query.get("replace") or "").strip()
        if replace and not _VOICE_ID_RE.fullmatch(replace):
            return self._refuse(400, "unknown_voice",
                                "That voice cannot be replaced.")
        library = (query.get("library") or "").strip().lower() == "true"
        if library and replace:
            return self._refuse(400, "unsupported_field",
                                "A recording goes to the Voice Library or "
                                "to a voice, not both.")
        name = (query.get("name") or "").strip()
        note = (query.get("note") or "").strip()
        scope = (query.get("scope") or "").strip()
        if not replace and not name:
            return self._refuse(400, "name_required", "Give the voice a name.")
        if not library and (scope or not replace) and scope not in VOICE_SCOPES:
            return self._refuse(400, "scope_required",
                                "Choose what the voice is for: the DJ, "
                                "announcements, or both.")
        source = (query.get("source") or "file").strip()
        if source not in VOICE_SAMPLE_SOURCES:
            return self._refuse(400, "unsupported_field",
                                "A sample is either a recording or a file.")
        make_default = (query.get("announcement_default") or "").strip().lower() == "true"
        # Bounded twice, for the two ways a body can be too big: a declared
        # length we can refuse before reading, and the read itself.
        if (request.content_length or 0) > MAX_SAMPLE_BYTES:
            return self._too_large()
        sample = await request.read()
        if len(sample) > MAX_SAMPLE_BYTES:
            return self._too_large()
        try:
            if library:
                result = await coordinator.client.voice_collection_import(
                    name, sample, consent_version=VOICE_CONSENT_VERSION,
                    source=source)
            elif replace:
                result = await coordinator.client.voice_replace(
                    replace, sample, consent_version=VOICE_CONSENT_VERSION,
                    scope=scope or None, source=source)
            else:
                result = await coordinator.client.voice_create(
                    name, note, sample, consent_version=VOICE_CONSENT_VERSION,
                    scope=scope, source=source,
                    announcement_default=make_default)
        except VoiceEngineError as exc:
            # The backend already phrased this for a person and chose the
            # status. Both travel unchanged.
            return self.json({"ok": False, "code": exc.code,
                              "message": str(exc)},
                             status_code=exc.status or 502)
        except RadioServiceError as exc:
            _LOGGER.warning("voice %s failed: %s",
                            "library import" if library
                            else "replace" if replace else "create", exc)
            return self.json(
                {"ok": False, "code": "service_unreachable",
                 "message": "ParlorWave Radio could not be reached. Check "
                            "that the service is running, then try again."},
                status_code=502)
        coordinator.invalidate_voice_library()
        await coordinator.async_request_refresh()
        return self.json({"ok": True, **result})

    def _refuse(self, status: int, code: str, message: str):
        return self.json({"ok": False, "code": code, "message": message},
                         status_code=status)

    def _too_large(self):
        return self.json(
            {"ok": False, "code": "sample_too_large",
             "message": f"That file is larger than "
                        f"{MAX_SAMPLE_BYTES // (1024 * 1024)} MB. A short MP3 "
                        f"or FLAC clip is well under it."},
            status_code=413)


#: A voice id's shape: what the backend's shelves use. Anything with a
#: slash, a dot, a colon or a space is not a voice and never leaves here.
_VOICE_ID_RE = re.compile(r"[a-z0-9_]{1,32}")


class BulletinAudioView(HomeAssistantView):
    """GET one already-aired bulletin's audio, for Listen Again.

    WHY A VIEW. A bulletin is minutes of audio -- megabytes. The websocket
    carries every state update in the house and is the wrong pipe for it,
    and base64 would inflate it by a third on the way through. Home
    Assistant's answer for bytes is an authenticated view.

    WHAT IT IS NOT. It is not a way to reach the backend: the caller gives
    a token and nothing else -- no host, no path, no URL. The service
    address and its API key live in the config entry and are attached on
    this side, so browser JavaScript learns neither.

    It is also not a second way to put news on the air. This streams to
    the person looking at the panel. Nothing here touches Music Assistant,
    a queue or a player, and the deliberate known-retired behaviour of the
    backend's own audio route is passed through untouched -- a bulletin
    whose file is gone answers 410 here exactly as it does there.
    """

    url = BULLETIN_AUDIO_URL
    name = "api:parlorwave_radio:bulletin_audio"
    requires_auth = True

    async def get(self, request):
        hass = request.app["hass"]
        coordinator = next(iter((hass.data.get(DOMAIN) or {}).values()), None)
        if coordinator is None:
            return self.json({"ok": False, "code": "not_ready",
                              "message": "ParlorWave Radio is not set up."},
                             status_code=503)
        token = (request.query.get("token") or "").strip()
        # The token is the credential for the file it names, so it is
        # checked for SHAPE before it is used: anything that is not a plain
        # hex token cannot address a file, and must not be given the chance
        # to try.
        if not token or len(token) > 64 or not re.fullmatch(r"[0-9a-fA-F]+", token):
            return self.json({"ok": False, "code": "bad_token",
                              "message": "That bulletin cannot be played."},
                             status_code=400)
        # Imported here, not at module scope: this module is also read by
        # the integration's own tests, which stand in for Home Assistant
        # rather than installing its web stack. A view that cannot be
        # imported without aiohttp takes setup down with it.
        from aiohttp import web
        try:
            audio, ctype = await coordinator.client.bulletin_audio(token)
        except RadioServiceError as exc:
            _LOGGER.debug("listen again unavailable for %s: %s", token, exc)
            return self.json(
                {"ok": False, "code": "unavailable",
                 "message": "That bulletin is no longer available to play."},
                status_code=404)
        return web.Response(body=audio, content_type=ctype.split(";")[0]
                            or "audio/mpeg")
