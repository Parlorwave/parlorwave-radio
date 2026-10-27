"""The Parlorwave Radio service API client.

Transport-injectable on purpose: Home Assistant hands in its shared aiohttp
session, and the unit tests hand in a fake with the same tiny surface
(`request(method, url, json=..., headers=..., timeout=...)` returning an
object with `.status` and `async .json()`). The client never imports Home
Assistant and never constructs a network stack of its own, so the contract
logic -- auth header, error mapping, the exact PUT patch bodies -- is
testable anywhere the backend test harness runs.

The client speaks the service's public contract only (settings sections,
status surfaces, station actions). It knows nothing about Music Assistant
or any particular inference host: capabilities arrive as data from
/settings/dj and /dj/status, which is what keeps those hosts optional --
and a source-level test bans any host's name from ever appearing here.
"""

from __future__ import annotations

from typing import Any


class RadioServiceError(Exception):
    """The backend answered, but with a failure."""

    #: the HTTP status of a refusal (0 when there was no answer to read one from)
    status = 0


class RadioServiceConnectionError(RadioServiceError):
    """The backend could not be reached at all."""


class RadioServiceAuthError(RadioServiceError):
    """The backend refused the API key."""


class VoiceEngineError(RadioServiceError):
    """A refusal the backend already phrased for a person, with its stable
    code alongside. str() is exactly what may be shown -- never wrapped in
    a path, a status, or another exception's text."""

    def __init__(self, message: str, *, code: str = "", status: int = 0):
        super().__init__(message)
        self.code = code
        self.status = status


def _detail_of(body: bytes):
    """The `detail` out of a JSON error body, or None. A body that is not
    JSON is not guessed at: it becomes None and the caller says so
    generically rather than showing a person a byte dump."""
    import json as _json
    try:
        payload = _json.loads(body.decode("utf-8"))
    except Exception:  # noqa: BLE001 - any non-JSON body
        return None
    return payload.get("detail") if isinstance(payload, dict) else None


def _refusal(path: str, status: int, detail) -> "RadioServiceError":
    """One refusal, in the words the backend chose.

    The service answers a structured {"code", "message"} for everything a
    person might see (voice mutations especially). When it does, the
    message IS the error -- prefixing it with a path and a status turns a
    sentence a customer can act on into a stack trace they cannot. A
    VoiceEngineError carries the code so a caller can branch without
    matching on prose.
    """
    if isinstance(detail, dict) and detail.get("message"):
        return VoiceEngineError(str(detail["message"]),
                                code=str(detail.get("code") or ""),
                                status=status)
    err = RadioServiceError(f"{path} answered {status}: {detail}" if detail
                            else f"{path} answered {status}")
    err.status = status
    return err


class RadioServiceClient:
    def __init__(self, transport, base_url: str, api_key: str = "",
                 timeout_s: float = 10.0) -> None:
        self._transport = transport
        self._base = base_url.rstrip("/")
        self._api_key = (api_key or "").strip()
        self._timeout_s = timeout_s

    @property
    def base_url(self) -> str:
        return self._base

    async def _call(self, method: str, path: str,
                    json: dict[str, Any] | None = None,
                    timeout_s: float | None = None) -> dict[str, Any]:
        headers = {}
        if self._api_key:
            # Never sent unless configured; never logged; never stored in
            # any state object the frontend can read.
            headers["X-Api-Key"] = self._api_key
        try:
            resp = await self._transport.request(
                method, f"{self._base}{path}", json=json, headers=headers,
                timeout=timeout_s or self._timeout_s)
        except RadioServiceError:
            raise
        except Exception as exc:  # aiohttp/network errors, by design broad
            raise RadioServiceConnectionError(
                f"The ParlorWave Radio service unreachable at {self._base}: {exc}") from exc
        if resp.status == 401:
            raise RadioServiceAuthError("The ParlorWave Radio service rejected the API key")
        if resp.status >= 500:
            raise RadioServiceError(f"The ParlorWave Radio service error {resp.status} on {path}")
        try:
            data = await resp.json()
        except Exception as exc:
            raise RadioServiceError(f"non-JSON answer on {path}") from exc
        if isinstance(data, dict) and data.get("ok") is False and resp.status < 400:
            # Truthful refusals ({ok: false, reason/error}) pass through for
            # callers that expect them; hard 4xx becomes an exception below.
            return data
        if resp.status >= 400:
            raise _refusal(path, resp.status,
                           data.get("detail") if isinstance(data, dict) else data)
        return data

    async def _call_binary(self, method: str, path: str,
                           json: dict[str, Any] | None = None,
                           data: bytes | None = None,
                           timeout_s: float | None = None
                           ) -> tuple[int, bytes, str]:
        """One call whose ANSWER (or body) is raw bytes: voice preview
        audio out, voice sample upload in. Same auth posture as _call."""
        headers = {}
        if self._api_key:
            headers["X-Api-Key"] = self._api_key
        if data is not None:
            headers["Content-Type"] = "application/octet-stream"
        try:
            resp = await self._transport.request(
                method, f"{self._base}{path}", json=json, data=data,
                headers=headers, timeout=timeout_s or self._timeout_s)
        except RadioServiceError:
            raise
        except Exception as exc:
            raise RadioServiceConnectionError(
                f"The ParlorWave Radio service unreachable at {self._base}: {exc}") from exc
        body = await resp.read()
        if resp.status == 401:
            raise RadioServiceAuthError("The ParlorWave Radio service rejected the API key")
        if resp.status >= 400:
            raise _refusal(path, resp.status, _detail_of(body))
        return resp.status, body, resp.headers.get("Content-Type", "")

    # --- read surfaces --------------------------------------------------
    async def instance(self) -> dict[str, Any]:
        """The backend's stable identity: {"instance_id", ...}.

        Authenticated, so a successful call also proves the API key. The
        config flow keys its entry on the id this returns."""
        return await self._call("GET", "/instance")

    async def ping(self) -> dict[str, Any]:
        return await self._call("GET", "/")

    async def dj_status(self) -> dict[str, Any]:
        return await self._call("GET", "/dj/status")

    async def dj_settings(self) -> dict[str, Any]:
        return await self._call("GET", "/settings/dj")

    async def playback_settings(self) -> dict[str, Any]:
        return await self._call("GET", "/settings/playback")

    async def outputs(self) -> dict[str, Any]:
        return await self._call("GET", "/outputs")

    async def health_problems(self) -> dict[str, Any]:
        """GET /health/problems: structured problems + feature facts."""
        return await self._call("GET", "/health/problems")

    async def observer_status(self) -> dict[str, Any]:
        return await self._call("GET", "/observer/status")

    async def news_status(self) -> dict[str, Any]:
        return await self._call("GET", "/news/status")

    async def news_history(self, limit: int = 20) -> dict[str, Any]:
        """What the Newsroom actually did, newest first. Read-only."""
        return await self._call("GET", f"/news/history?limit={int(limit)}")

    async def bulletin_audio(self, token: str) -> tuple[bytes, str]:
        """One already-aired bulletin's own audio, for Listen Again.

        The backend route is public by design -- Music Assistant fetches it
        itself and cannot send a key, so the token IS the credential and
        resolves only to the file it owns. It is fetched through this
        client anyway so the browser never needs the backend's address."""
        _status, body, ctype = await self._call_binary(
            "GET", f"/news/audio/{token}.mp3")
        return body, ctype or "audio/mpeg"

    # --- the two optional services ---------------------------------------
    # A credential typed on the panel travels Home Assistant -> here ->
    # the backend and is stored there. It never comes back: every read
    # returns null beside an `api_key_set` boolean, so no browser, no
    # screenshot and no bug report ever holds one.

    async def services_settings(self) -> dict[str, Any]:
        return await self._call("GET", "/settings/services")

    async def save_services_settings(self, patch: dict[str, Any]) -> dict[str, Any]:
        """Persist the optional-service settings.

        Passed through verbatim so the BACKEND stays the one validator --
        an unreachable address, an unknown provider or a service switched
        on with nowhere to reach comes back as its own refusal, in its own
        words. A null api_key means LEAVE THE STORED ONE."""
        return await self._call("PUT", "/settings/services", patch)

    async def services_status(self) -> dict[str, Any]:
        """What each service IS. Makes no network call of its own."""
        return await self._call("GET", "/services/status")

    async def test_service(self, kind: str,
                           override: dict[str, Any] | None = None) -> dict[str, Any]:
        """Test Connection. One bounded attempt; renders no speech, writes
        no break and cannot reach a queue or a player.

        `override` is the address (and, if one was typed, the key) shown on
        the screen right now, so the button under the field answers for the
        field. It is passed through for the one call and never stored."""
        return await self._call("POST", f"/services/{kind}/test",
                                json=override or None)

    async def find_writer(self, base_url: str = "",
                          provider: str = "") -> dict[str, Any]:
        """Look for a writing model at a short list of named addresses.
        Bounded and read-only; never a network scan."""
        return await self._call("POST", "/services/writer/find",
                                json={"base_url": base_url, "provider": provider})

    async def calendar_diagnosis(self) -> dict[str, Any]:
        """What the backend can see of the calendar, and why each event
        would or would not reach a break. Read-only: it selects no topic
        and commits no suppression marks."""
        return await self._call("GET", "/dj/context/calendar")

    async def weather_diagnosis(self) -> dict[str, Any]:
        """What the backend holds of the weather, and what a break started
        now would say about it. Read-only on both sides."""
        return await self._call("GET", "/dj/context/weather")

    # --- Newsroom: the two things that screen can do ----------------------
    # Both are bounded and neither can reach playback. Saving is a settings
    # write and nothing else -- the backend refuses to fetch, download or
    # contact Music Assistant on a save. Testing is a reachability and
    # parse check that writes nothing at all.

    async def save_news_settings(self, patch: dict[str, Any]) -> dict[str, Any]:
        """Persist the Newsroom's bulletin settings.

        The patch is passed through verbatim so the BACKEND stays the one
        validator: an unknown key, an unsupported schedule minute or a
        malformed feed URL comes back as its own refusal with its own
        message, which the panel shows. Nothing here second-guesses it,
        because a second copy of the rules is a second set of bugs."""
        return await self._call("PUT", "/settings/bulletins", patch)

    async def test_news_feed(self, bulletins: dict[str, Any] | None = None) -> dict[str, Any]:
        """Prove a feed is reachable and usable, without saving it.

        Passing the draft settings means Test Feed answers for what is in
        the boxes right now, so a person can check an address BEFORE
        committing it to the station."""
        payload: dict[str, Any] = {}
        if bulletins is not None:
            payload["bulletins"] = bulletins
        return await self._call("POST", "/news/feed/test", payload)

    async def station_settings(self) -> dict[str, Any]:
        return await self._call("GET", "/settings/station")

    async def save_station_settings(self, patch: dict[str, Any]) -> dict[str, Any]:
        return await self._call("PUT", "/settings/station", patch)

    async def station_dial(self) -> dict[str, Any]:
        """The saved Dial Stations (presets) and the station kinds."""
        return await self._call("GET", "/station/dial")

    async def save_station_dial(self, presets: list[Any]) -> dict[str, Any]:
        """Replace the Dial preset list. Saving a preset starts nothing."""
        return await self._call("PUT", "/station/dial", {"presets": presets})

    async def station_live(self) -> dict[str, Any]:
        """The on-air station (Mode 2), from the backend's durable state:
        whether one is running, where, and how its runway stands."""
        return await self._call("GET", "/station/live")

    async def station_live_targets(self) -> dict[str, Any]:
        """Which speakers a station may run on, and why the others may not."""
        return await self._call("GET", "/station/live/targets")

    async def request_song(self, title: str, artist: str = "") -> dict[str, Any]:
        """ONE song, next, on the speaker the DJ is on now (alpha.4 Request
        Line). The backend picks that speaker itself and resolves the song in
        the Music Assistant library; this never starts a station."""
        body: dict[str, Any] = {"title": title}
        if artist:
            body["artist"] = artist
        return await self._call("POST", "/request/song", body, timeout_s=60.0)

    async def station_live_start(self, target: str, preset_id: str | None = None,
                                 intent: dict[str, Any] | None = None,
                                 variant: int | None = None,
                                 origin: str | None = None,
                                 handover: dict[str, Any] | None = None
                                 ) -> dict[str, Any]:
        """START (or switch) a station on ONE named speaker. The target is
        always explicit. The Station tab, the Request Line and the Dial all
        come through here; `origin` says which one pressed start on a saved
        preset. The first artist station after a backend restart reads the
        library's relations first -- hence the longer wait."""
        body: dict[str, Any] = {"target": target}
        if preset_id:
            body["preset_id"] = preset_id
        if origin:
            body["origin"] = origin
        if intent is not None:
            body["intent"] = intent
        if variant is not None:
            body["variant"] = variant
        if handover is not None:
            # the house speaker's confirmed takeover (token + keep/replace)
            body["handover"] = {"token": handover["token"],
                                "upcoming": handover["upcoming"]}
            if handover.get("remove"):
                body["handover"]["remove"] = list(handover["remove"])
        return await self._call("POST", "/station/live/start", body,
                                timeout_s=60.0)

    async def station_live_autoplay(self, decision: str) -> dict[str, Any]:
        """Answer a PENDING Autoplay restore (restore | dismiss) left by the
        last station's Stop."""
        return await self._call("POST", "/station/live/autoplay",
                                {"decision": decision})

    async def station_live_stop(self) -> dict[str, Any]:
        """STOP programming. The speaker keeps playing what is queued."""
        return await self._call("POST", "/station/live/stop", {})

    async def station_preview(self, intent: dict[str, Any], count: int = 25,
                              variant: int = 0) -> dict[str, Any]:
        """Test Station: a dry run of the station builder. Changes nothing.
        The first preview of an artist station reads Music Assistant's
        similar-artist data for the whole library, which is slow on a
        large one -- hence the longer wait."""
        return await self._call("POST", "/station/preview",
                                {"intent": intent, "count": count,
                                 "variant": variant}, timeout_s=60.0)

    async def studio_catalog(self) -> dict[str, Any]:
        """What Studio may offer: personalities, station feels and the
        voices the speech service currently has -- ids paired with
        friendly names. The backend owns the lists; the integration never
        hard-codes a voice or a profile. (The payload also still carries a
        deprecated `chattiness` list that no entity reads.)"""
        return await self._call("GET", "/studio/catalog")

    async def replenish_eligibility(self) -> dict[str, Any]:
        return await self._call("GET", "/station/replenish/eligibility")

    async def session_by_player(self, entity_id: str) -> dict[str, Any]:
        return await self._call("GET", f"/playback/session/by-player/{entity_id}")

    # --- writes: settings (partial patches; backend validates the merge) --
    async def set_dj_enabled(self, enabled: bool) -> dict[str, Any]:
        return await self._call("PUT", "/settings/dj", {"enabled": bool(enabled)})

    async def set_dj_speech_enabled(self, on: bool) -> dict[str, Any]:
        return await self._call("PUT", "/settings/dj",
                                {"speech_enabled": bool(on)})

    async def set_dj_stories_enabled(self, on: bool) -> dict[str, Any]:
        return await self._call("PUT", "/settings/dj",
                                {"stories_enabled": bool(on)})

    async def set_keep_radio_playing(self, on: bool) -> dict[str, Any]:
        return await self._call("PUT", "/settings/playback",
                                {"keep_radio_playing": bool(on)})

    async def set_cadence_minutes(self, minutes: int) -> dict[str, Any]:
        return await self._call(
            "PUT", "/settings/dj",
            {"programming": {"cadence_min_minutes": int(minutes)}})

    async def set_break_length(self, value: str) -> dict[str, Any]:
        return await self._call("PUT", "/settings/dj",
                                {"programming": {"break_length": value}})

    # Studio: speech settings (reach the NEXT rendered break; nothing that
    # is already queued or playing is touched) and the programming feel
    # (reaches the NEXT station refill only). All partial settings PUTs.
    async def set_personality(self, profile_id: str) -> dict[str, Any]:
        return await self._call("PUT", "/settings/dj",
                                {"persona": {"profile": profile_id}})

    async def set_chattiness(self, level: str | None) -> dict[str, Any]:
        """DEPRECATED, COMPATIBILITY/DEBUG ONLY. Persona and airtime are
        decoupled: the backend still accepts and persists
        this key, but nothing in normal production reads it, so writing it
        changes no break. No entity calls this; it is kept as the seam a
        developer or a research harness can drive deliberately."""
        return await self._call("PUT", "/settings/dj",
                                {"persona": {"chattiness": level}})

    # --- Voice library / Booth surfaces ----------------------------------
    async def voices_library(self) -> dict[str, Any]:
        return await self._call("GET", "/voices/library")

    async def voices_select(self, voice_id: str) -> dict[str, Any]:
        # The service proves the voice speaks before it becomes the DJ (one
        # short phrase through that voice), so this waits as long as a
        # preview does rather than the read surfaces' ten seconds.
        return await self._call("POST", "/voices/select",
                                {"voice_id": voice_id}, timeout_s=45.0)

    async def voice_shifts(self, patch: dict[str, Any]) -> dict[str, Any]:
        """Automatic DJ shifts: `enabled` and/or a voice id per shift
        ("" = unassigned). The backend validates and settles; a voice newly
        assigned first proves it speaks, so this waits as long as a preview
        does for each."""
        return await self._call("POST", "/voices/shifts", patch, timeout_s=90.0)

    async def voice_switch_dj(self) -> dict[str, Any]:
        """"Switch DJ": the backend selects the next voice allowed to be
        the DJ (the same write as voices_select) and names it. The voice
        first proves it speaks, so this waits as long as a preview does."""
        return await self._call("POST", "/voices/switch-dj", timeout_s=45.0)

    async def voice_rename(self, voice_id: str, name: str) -> dict[str, Any]:
        return await self._call("POST", f"/voices/{voice_id}/rename",
                                {"name": name})

    async def voice_tuning(self, voice_id: str, speed: float,
                           pause: float) -> dict[str, Any]:
        return await self._call("POST", f"/voices/{voice_id}/tuning",
                                {"speed": speed, "pause": pause})

    async def publish_context(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        """The grounded context snapshot (clock / weather / calendar) the
        integration gathered from Home Assistant, to the backend's existing
        strictly validated ingestion contract."""
        return await self._call("POST", "/dj/context", snapshot)

    async def publish_announcements(self, observed: dict[str, Any]
                                    ) -> dict[str, Any]:
        """The ANNOUNCE-prefixed calendar events currently visible on the
        selected calendars, with per-source health -- the observation the
        backend reconciles into durable announcement occurrences."""
        return await self._call("POST", "/announcements/observed", observed)

    async def announcements_status(self) -> dict[str, Any]:
        """Read-only: settings, sync freshness, upcoming and recent
        announcement occurrences, for the Station tab."""
        return await self._call("GET", "/announcements/status")

    async def voice_note(self, voice_id: str, note: str) -> dict[str, Any]:
        return await self._call("POST", f"/voices/{voice_id}/note",
                                {"note": note})

    async def voice_delete(self, slot: str) -> dict[str, Any]:
        return await self._call("DELETE", f"/voices/custom/{slot}")

    async def voice_upload(self, slot: str, sample: bytes, *,
                           consent_version: str) -> dict[str, Any]:
        """The per-slot primitive the automation service uses. The caller
        has already required the owner's acknowledgement; it travels on."""
        from urllib.parse import urlencode
        query = urlencode({"authorized": "true",
                           "consent_version": consent_version,
                           "source": "file"})
        status, body, _ctype = await self._call_binary(
            "POST", f"/voices/custom/{slot}/sample?{query}", data=sample,
            timeout_s=60.0)
        import json as _json
        try:
            return _json.loads(body.decode("utf-8"))
        except Exception as exc:
            raise RadioServiceError("voice upload answered non-JSON") from exc

    async def voice_create(self, name: str, note: str, sample: bytes, *,
                           consent_version: str, scope: str,
                           source: str = "file",
                           announcement_default: bool = False
                           ) -> dict[str, Any]:
        """Create a custom voice from a recording. The backend picks the
        storage; this client neither sends a slot nor shows the one that
        comes back to anything but the panel's own preview/select wiring.
        Only ever called after the door checked the acknowledgement, which
        travels on with the version the owner was shown."""
        from urllib.parse import urlencode
        query = urlencode({"name": name, "note": note, "authorized": "true",
                           "consent_version": consent_version,
                           "scope": scope, "source": source,
                           "announcement_default":
                           "true" if announcement_default else "false"})
        status, body, _ctype = await self._call_binary(
            "POST", f"/voices/custom/create?{query}", data=sample,
            timeout_s=120.0)
        return self._voice_json(body, "creating that voice")

    async def voice_replace(self, voice_id: str, sample: bytes, *,
                            consent_version: str, scope: str | None = None,
                            source: str = "file") -> dict[str, Any]:
        """A new recording under an existing custom voice (new identity,
        same name). Same acknowledgement as create."""
        from urllib.parse import quote, urlencode
        params = {"authorized": "true", "consent_version": consent_version,
                  "source": source}
        if scope:
            params["scope"] = scope
        status, body, _ctype = await self._call_binary(
            "POST",
            f"/voices/custom/{quote(voice_id, safe='')}/replace?"
            f"{urlencode(params)}", data=sample, timeout_s=120.0)
        return self._voice_json(body, "replacing that voice")

    # --- Voice Library: recordings kept apart from the Custom slots -------
    async def voice_collection(self) -> dict[str, Any]:
        """The kept recordings. Listing first keeps each slot's current
        recording (a download from the voice engine when it is new), so it
        waits longer than the read surfaces' ten seconds."""
        return await self._call("GET", "/voices/collection", timeout_s=60.0)

    async def voice_collection_audio(self, entry_id: str) -> tuple[bytes, str]:
        from urllib.parse import quote
        status, body, ctype = await self._call_binary(
            "GET", f"/voices/collection/{quote(entry_id, safe='')}/audio",
            timeout_s=30.0)
        return body, ctype

    async def voice_collection_import(self, name: str, sample: bytes, *,
                                      consent_version: str,
                                      source: str = "file") -> dict[str, Any]:
        from urllib.parse import urlencode
        query = urlencode({"name": name, "authorized": "true",
                           "consent_version": consent_version,
                           "source": source})
        status, body, _ctype = await self._call_binary(
            "POST", f"/voices/collection/import?{query}", data=sample,
            timeout_s=60.0)
        return self._voice_json(body, "saving that recording")

    async def voice_collection_action(self, entry_id: str, action: str,
                                      payload: dict[str, Any]
                                      ) -> dict[str, Any]:
        """rename / archive / assign / delete. Assign is a slot replace
        (upload, speak, swap), so it waits as long as a replace does."""
        from urllib.parse import quote
        # binary call: a 5xx keeps the backend's own sentence (_refusal)
        status, body, _ctype = await self._call_binary(
            "POST", f"/voices/collection/{quote(entry_id, safe='')}/{action}",
            json=payload, timeout_s=120.0 if action == "assign" else 15.0)
        return self._voice_json(body, "changing that recording")

    @staticmethod
    def _voice_json(body: bytes, doing: str) -> dict[str, Any]:
        import json as _json
        try:
            return _json.loads(body.decode("utf-8"))
        except Exception as exc:
            raise RadioServiceError(
                "The ParlorWave Radio service answered unexpectedly while "
                f"{doing}.") from exc

    async def voice_scope(self, voice_id: str, scope: str) -> dict[str, Any]:
        """What a voice is allowed for: dj, announcement or both."""
        from urllib.parse import quote
        return await self._call("POST",
                                f"/voices/{quote(voice_id, safe='')}/scope",
                                {"scope": scope})

    async def voice_announcement_default(self, voice_id: str
                                         ) -> dict[str, Any]:
        """Which authorized voice reads an announcement that names none
        ("" = the station's DJ voice). Grants nothing."""
        return await self._call("POST", "/voices/announcement-default",
                                {"voice_id": voice_id})

    async def voice_preview(self, voice_id: str, speed: float | None = None,
                            pause: float | None = None,
                            text: str | None = None) -> tuple[bytes, str]:
        payload: dict[str, Any] = {"voice_id": voice_id}
        if speed is not None:
            payload["speed"] = speed
        if pause is not None:
            payload["pause"] = pause
        if text:
            payload["text"] = text
        _status, body, ctype = await self._call_binary(
            "POST", "/voices/preview", json=payload, timeout_s=45.0)
        return body, ctype or "audio/wav"

    async def now_playing_card(self) -> dict[str, Any]:
        return await self._call("GET", "/now/playing")

    async def now_lyrics(self) -> dict[str, Any]:
        return await self._call("GET", "/now/lyrics")

    async def listener_play(self, queue_id: str) -> dict[str, Any]:
        """Tell the backend a PERSON asked this queue's speaker to play (a
        note for its end-of-queue tracker; it changes no playback)."""
        return await self._call("POST", "/playback/listener_play",
                                json={"queue_id": queue_id})

    async def now_queue(self, recent: int = 5,
                        upcoming: int = 10) -> dict[str, Any]:
        return await self._call(
            "GET", f"/now/queue?recent={int(recent)}&upcoming={int(upcoming)}")

    async def current_waveform(self, queue_id: str | None = None) -> dict[str, Any]:
        """Read-only: normalized waveform for the currently playing track/program."""
        path = f"/broadcast/waveform/current?queue_id={queue_id}" if queue_id else "/broadcast/waveform/current"
        return await self._call("GET", path)

    async def program_history(self, limit: int = 10) -> dict[str, Any]:
        return await self._call("GET", f"/program/history?limit={int(limit)}")

    async def broadcast_diagnostics(self, limit: int = 25, kind: str = "dj_break",
                                    before: str | None = None, outcome: str | None = None,
                                    reason: str | None = None) -> dict[str, Any]:
        """Broadcast Diagnostics: one page of compact opportunity rows, newest
        first (read-only). A service without the route says so as
        {ok: false, reason: "unsupported"} rather than as a failure."""
        from urllib.parse import urlencode
        query = {"limit": int(limit), "kind": kind, "before": before,
                 "outcome": outcome, "reason": reason}
        path = "/dj/diagnostics/opportunities?" + urlencode(
            {k: v for k, v in query.items() if v not in (None, "")})
        try:
            return await self._call("GET", path)
        except RadioServiceError as exc:
            if exc.status == 404:
                return {"ok": False, "reason": "unsupported"}
            raise

    async def broadcast_diagnostic(self, opportunity_id: str) -> dict[str, Any]:
        """Everything recorded about one opportunity, by its public 16-hex
        id (never the break's token). An id the history read does not hold
        is {ok: false, reason: "not_found"}: that is not evidence that the
        break did not air."""
        import re
        if not re.fullmatch(r"[0-9a-f]{16}", opportunity_id or ""):
            raise RadioServiceError("not an opportunity id")
        try:
            return await self._call("GET", f"/dj/diagnostics/opportunities/{opportunity_id}")
        except RadioServiceError as exc:
            if exc.status == 404:
                return {"ok": False, "reason": "not_found"}
            raise

    async def set_voice(self, voice_id: str) -> dict[str, Any]:
        """'' = the speech service's default voice. The backend validates
        the id against the live voice list and refuses unknown ones."""
        return await self._call(
            "PUT", "/settings/dj",
            {"persona": {"voice": {"refs": {"chatterbox_voice": voice_id}}}})

    async def set_break_content(self, key: str, on: bool) -> dict[str, Any]:
        return await self._call("PUT", "/settings/dj",
                                {"content": {key: bool(on)}})

    async def set_station_feel(self, feel_id: str) -> dict[str, Any]:
        """Programming preference for future refills. CONTRACT (pinned):
        a settings write and nothing else -- the active queue, the station
        identity and playback are never touched by choosing a feel."""
        return await self._call("PUT", "/settings/station", {"feel": feel_id})

    async def set_same_artist_enabled(self, on: bool) -> dict[str, Any]:
        """Back-to-back same-artist programming: a station settings
        write only -- governs the autonomous runway, never manual/adopted
        playback."""
        return await self._call("PUT", "/settings/station",
                                {"same_artist": {"enabled": bool(on)}})

    async def set_same_artist_frequency(self, level: str) -> dict[str, Any]:
        return await self._call("PUT", "/settings/station",
                                {"same_artist": {"frequency": level}})

    async def set_default_output(self, player_id: str | None) -> dict[str, Any]:
        """Select the output NEW sessions / Start Radio will target.

        CONTRACT (pinned by test): this is a settings write and nothing
        else. It must never call a transport, queue, or station endpoint --
        an already-playing station is never teleported by changing the
        selector. The backend applies the choice to new actions only (and
        to the read-only observer's watch target).
        """
        return await self._call(
            "PUT", "/settings/dj",
            {"outputs": {"default_request_output": player_id}})

    async def set_enabled_outputs(self, player_ids: list[str]) -> dict[str, Any]:
        """Write the DJ-enabled output allow-list (settings.dj.outputs.enabled):
        the Music Assistant outputs Parlorwave Radio may adopt playback on
        and DJ. Exactly one settings write; the list replaces wholesale
        (the backend contract), an empty list is valid. Never a transport
        call, and never a touch on default_request_output or the active
        station -- the backend keeps following an already-active station
        whatever this list becomes."""
        ids = []
        for pid in player_ids or []:
            pid = str(pid or "").strip()
            if pid and pid not in ids:
                ids.append(pid)
        return await self._call("PUT", "/settings/dj",
                                {"outputs": {"enabled": ids}})

    # --- actions ---------------------------------------------------------
    async def start_radio_from_current(self, queue_id: str | None = None,
                                       count: int | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {}
        if queue_id:
            body["queue_id"] = queue_id
        if count:
            body["count"] = count
        return await self._call("POST", "/station/from-current", body)

    async def request_station(self, request: str, player: str,
                              count: int = 30,
                              mode: str | None = None) -> dict[str, Any]:
        """The live text-request path: create a playback session whose queue
        is a freshly built station. The caller (HA service layer) enqueues
        the returned tracks (replace on the first, add for the rest). This
        client never talks to Music Assistant itself."""
        body: dict[str, Any] = {"request": request, "player": player,
                                "queue": True, "count": count}
        if mode:
            body["mode"] = mode
        return await self._call("POST", "/playback/session", body)

    async def feedback(self, action: str, *, artist: str = "",
                       title: str = "", path: str = "",
                       player: str | None = None) -> dict[str, Any]:
        body = {"action": action, "artist": artist, "title": title,
                "path": path}
        body = {k: v for k, v in body.items() if v}
        if player:
            return await self._call(
                "POST", f"/playback/session/by-player/{player}/feedback", body)
        return await self._call("POST", "/feedback", body)
