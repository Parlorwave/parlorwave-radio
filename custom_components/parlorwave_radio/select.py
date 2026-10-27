"""Selects: break length, the output NEW music targets, and the Studio
choices -- personality, voice, station feel.

OUTPUT CONTRACT (product behavior, pinned by test): choosing an output is
configuration for FUTURE actions -- new requests, the next Start Radio, DJ
speech permission. It performs a settings write and nothing else; an
already-running station keeps playing exactly where it is. No transport,
no queue mutation, no station teardown.

STUDIO CONTRACT (same pin): every Studio select is a settings write and
nothing else. Speech settings (personality, voice) reach the
next break the DJ writes; the station feel reaches the next refill. Nothing
already queued or playing changes hands. Options are the friendly names
the backend's catalog carries; raw ids never reach the UI."""

from __future__ import annotations

from typing import Any

from homeassistant.components.select import SelectEntity
from homeassistant.exceptions import HomeAssistantError

from .api import RadioServiceError
from .const import BREAK_LENGTHS, HA_VOICE_PREFIX
from .entity import CatalogGatedEntity, ParlorwaveRadioEntity, ma_entity_for


async def async_setup_entry(hass, entry, async_add_entities):
    coordinator = hass.data["parlorwave_radio"][entry.entry_id]
    # No chattiness select. Persona and airtime are decoupled:
    # the DJ talks the same amount whatever personality is
    # chosen, so a Low/Normal/High control would write a settings key that
    # changes nothing. The backend still accepts the key (api.set_chattiness)
    # for compatibility and debugging; it is not a customer control.
    async_add_entities([BreakLengthSelect(coordinator, entry.entry_id),
                        OutputSelect(coordinator, entry.entry_id),
                        PersonalitySelect(coordinator, entry.entry_id),
                        VoiceSelect(coordinator, entry.entry_id),
                        StationFeelSelect(coordinator, entry.entry_id),
                        SameArtistFrequencySelect(coordinator,
                                                  entry.entry_id)])


class BreakLengthSelect(ParlorwaveRadioEntity, SelectEntity):
    _attr_name = "Break length"
    _attr_icon = "mdi:timer-sand"
    _attr_options = BREAK_LENGTHS

    def __init__(self, coordinator, entry_id: str) -> None:
        super().__init__(coordinator, entry_id, "break_length")

    @property
    def current_option(self) -> str | None:
        prog = (self.coordinator.data.get("dj_settings") or {}).get(
            "programming") or {}
        value = prog.get("break_length")
        return value if value in BREAK_LENGTHS else None

    async def async_select_option(self, option: str) -> None:
        try:
            await self.coordinator.client.set_break_length(option)
        except RadioServiceError as exc:
            raise HomeAssistantError(str(exc)) from exc
        await self.coordinator.async_request_refresh()


class OutputSelect(ParlorwaveRadioEntity, SelectEntity):
    """WHICH ENABLED SPEAKER THE DJ IS FOLLOWING NOW -- not which speakers
    it is allowed to use.

    The name matters, and "Output" was the wrong one. On the device page it
    sat alone above a list of every speaker in the house and read as the
    place where speakers are set up; a person could pick one there, believe
    setup was done, and never reach the allow-list at all. The allow-list
    is "Speakers Parlorwave may DJ on" and lives on the panel's Settings
    screen; this is "Active DJ speaker", and the two names now say which is
    which wherever either appears."""

    _attr_name = "Active DJ speaker"
    _attr_icon = "mdi:speaker"

    def __init__(self, coordinator, entry_id: str) -> None:
        super().__init__(coordinator, entry_id, "output")

    def _players(self) -> dict[str, str]:
        """player_id -> friendly name, for the speakers the DJ may use.

        FILTERED TO THE ALLOW-LIST. It used to be every player Music
        Assistant reports, which made "Speakers Parlorwave may DJ on"
        look like a suggestion: a speaker could be chosen here that the
        owner had deliberately not enabled, and a break would go to it.

        A player in the allow-list that Music Assistant is not currently
        reporting is still offered under its own id, because an output
        that is merely offline is not an output the owner un-chose -- and
        silently dropping it would look like the setting was lost.
        """
        outputs = self.coordinator.data.get("outputs") or {}
        allowed = set(self.coordinator.enabled_outputs(self.coordinator.data))
        named: dict[str, str] = {}
        for o in outputs.get("outputs") or []:
            if not isinstance(o, dict):
                continue
            pid = o.get("player_id") or o.get("queue_id") or ""
            if pid and pid in allowed:
                named[pid] = o.get("name") or pid
        for pid in allowed:
            named.setdefault(pid, pid)
        return named

    @property
    def options(self) -> list[str]:
        return sorted(n for n in self._players().values() if n)

    @property
    def current_option(self) -> str | None:
        selected = self.coordinator.selected_output(self.coordinator.data)
        if not selected:
            return None
        # selected may be an entity id or MA player id; match either.
        outputs = (self.coordinator.data.get("outputs") or {}).get("outputs") or []
        for o in outputs:
            if selected in (o.get("player_id"), o.get("queue_id"),
                            o.get("entity_id")):
                return o.get("name")
        return None

    @property
    def extra_state_attributes(self) -> dict[str, str | None]:
        """Where the selected output lives in HA, for Now Playing surfaces.

        The panel's Now Playing follows THIS entity, not the house station,
        so a private listen on a phone shows the phone. None when the output
        has no MA entity right now (a browser player whose tab is closed).
        """
        selected = self.coordinator.selected_output(self.coordinator.data)
        entity_id = ma_entity_for(self.hass, selected) if self.hass else None
        return {"player_id": selected, "output_entity_id": entity_id}

    async def async_select_option(self, option: str) -> None:
        allowed = set(self.coordinator.enabled_outputs(self.coordinator.data))
        outputs = (self.coordinator.data.get("outputs") or {}).get("outputs") or []
        target = next((o for o in outputs if o.get("name") == option), None)
        if target is None:
            # An allow-listed player Music Assistant is not reporting is
            # offered under its own id; selecting it must still work.
            if option in allowed:
                target = {"player_id": option}
            else:
                raise HomeAssistantError(f"unknown output: {option}")
        pid = target.get("player_id") or target.get("queue_id")
        if pid not in allowed:
            # Belt and braces with the backend's own invariant: a stale
            # browser, an automation or a voice command must not be able to
            # aim the DJ at a speaker it is not allowed on.
            raise HomeAssistantError(
                f"{option} is not one of the speakers ParlorWave Radio may "
                f"DJ on -- enable it in the integration's options first")
        # Settings write ONLY -- see the module contract above.
        try:
            # The PLAYER ID, not the entity id: the allow-list is a list of
            # Music Assistant player_ids, and the backend now refuses an
            # active speaker that is not in it.
            await self.coordinator.client.set_default_output(pid)
        except RadioServiceError as exc:
            raise HomeAssistantError(str(exc)) from exc
        await self.coordinator.async_request_refresh()


class _CatalogSelect(ParlorwaveRadioEntity, SelectEntity):
    """A select whose options are a catalog list's friendly names.

    Subclasses name the catalog list, read the stored id and write the
    chosen id. While the catalog has not arrived (backend just came up, or
    the list is unreachable) the entity has no options and is unavailable
    rather than offering a guess."""

    catalog_key = ""

    def _items(self) -> list[dict[str, Any]]:
        catalog = self.coordinator.data.get("studio_catalog") or {}
        items = catalog.get(self.catalog_key)
        if isinstance(items, dict):          # voices: {"ok", "voices", "error"}
            items = items.get("voices")
        return [i for i in items or [] if isinstance(i, dict) and i.get("name")]

    def _stored_id(self) -> str | None:
        raise NotImplementedError

    async def _write(self, item_id: str | None) -> None:
        raise NotImplementedError

    @property
    def available(self) -> bool:
        return super().available and bool(self._items())

    @property
    def options(self) -> list[str]:
        return [i["name"] for i in self._items()]

    @property
    def current_option(self) -> str | None:
        stored = self._stored_id()
        for i in self._items():
            if i.get("id") == stored:
                return i["name"]
        return None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Friendly descriptions per option, for the panel's hint line."""
        return {"descriptions": {i["name"]: i.get("description") or ""
                                 for i in self._items() if i.get("description")}}

    async def async_select_option(self, option: str) -> None:
        item = next((i for i in self._items() if i["name"] == option), None)
        if item is None:
            raise HomeAssistantError(f"unknown option: {option}")
        # Settings write ONLY -- see the module contract above.
        try:
            await self._write(item.get("id"))
        except RadioServiceError as exc:
            raise HomeAssistantError(str(exc)) from exc
        await self.coordinator.async_request_refresh()


def _persona(coordinator) -> dict[str, Any]:
    return (coordinator.data.get("dj_settings") or {}).get("persona") or {}


class PersonalitySelect(_CatalogSelect):
    _attr_name = "Personality"
    _attr_icon = "mdi:drama-masks"
    catalog_key = "personas"

    def __init__(self, coordinator, entry_id: str) -> None:
        super().__init__(coordinator, entry_id, "personality")

    def _stored_id(self) -> str | None:
        return _persona(self.coordinator).get("profile")

    async def _write(self, item_id: str | None) -> None:
        await self.coordinator.client.set_personality(item_id)


class VoiceSelect(_CatalogSelect):
    """Options come from the VOICE LIBRARY: the curated built-in voices,
    named custom slots that actually hold a sample,
    the customer's own Home Assistant TTS voices,
    and -- always -- the voice that is currently SELECTED.

    Ids are logical voice ids and the write goes through /voices/select,
    which touches dj.persona.voice ONLY. Which PROVIDER speaks is resolved
    by the backend registry from the id; this entity never names a
    provider, an asset, or a voice id.

    AVAILABILITY. A voice whose provider cannot be reached is
    withheld rather than offered -- a shelf entry that cannot speak is not
    a choice. The SELECTED voice is the one exception, and it is the whole
    point: a Piper that restarts is unavailable for a few seconds, and
    when its own voice fell out of the list with it the entity went
    `unknown` with nothing in the picker to put it back. A selection is a
    stored preference, not a claim about this second, so it is always
    offered and always current_option. `unavailable_options` says which
    listed voices cannot speak right now, for a surface that wants to mark
    one rather than hide it."""

    _attr_name = "Voice"
    _attr_icon = "mdi:microphone"

    def __init__(self, coordinator, entry_id: str) -> None:
        super().__init__(coordinator, entry_id, "voice")

    def _library(self) -> dict[str, Any]:
        return self.coordinator.data.get("voice_library") or {}

    @staticmethod
    def _shelved(lib: dict[str, Any]) -> list[dict[str, Any]]:
        """Every voice the library names that may be the DJ's, each with
        whether it can speak right now. An `available` the backend did not
        state is not a refusal: only an explicit False withholds a voice.

        A voice the owner allowed for ANNOUNCEMENTS ONLY is not a DJ voice
        -- the backend refuses it as one -- so it is not offered here
        (a voice the household recorded for its own announcements reads
        those; it does not host the station)."""
        dj = lambda v: v.get("scope") != "announcement"  # noqa: E731
        out: list[dict[str, Any]] = [
            {"id": k["voice_id"], "name": k["name"],
             "available": k.get("available") is not False}
            for k in lib.get("kokoro") or [] if dj(k)]
        # An empty storage slot is not a voice; has_sample None means the
        # engine could not be asked, which is not proof of a recording.
        out += [{"id": c["voice_id"], "name": c["name"], "available": True}
                for c in lib.get("customs") or []
                if c.get("has_sample") and dj(c)]
        # the Home Assistant shelf: the customer's own TTS voices (Piper,
        # Cloud, ...), the base tier's only speech -- offered like any other
        out += [{"id": h["voice_id"], "name": h["name"],
                 "available": h.get("available") is not False}
                for h in lib.get("home_assistant") or [] if dj(h)]
        current = lib.get("current") or {}
        if current.get("voice_id"):
            out.append({"id": current["voice_id"], "name": current["name"],
                        "available": current.get("available") is not False})
        return out

    @staticmethod
    def _fallback_name(voice_id: str) -> str:
        """A readable name for a selected voice the library could not name
        at all -- Home Assistant unreachable, so not even its own shelf
        came back. Never the raw id: `ha_tts_piper` reads as Piper."""
        stem = voice_id[len(HA_VOICE_PREFIX):] if voice_id.startswith(
            HA_VOICE_PREFIX) else voice_id
        return (stem or voice_id).replace("_", " ").strip().title()

    def _items(self) -> list[dict[str, Any]]:
        lib = self._library()
        selected = self._stored_id() or ""
        items: list[dict[str, Any]] = []
        seen: set[str] = set()
        for item in self._shelved(lib):
            if item["id"] in seen or not (item["available"]
                                          or item["id"] == selected):
                continue
            seen.add(item["id"])
            items.append(item)
        if selected and selected not in seen:
            # Nothing named it: still offered, so the customer can keep it.
            items.append({"id": selected,
                          "name": self._fallback_name(selected),
                          "available": False})
        return items

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"unavailable_options": [i["name"] for i in self._items()
                                        if not i["available"]]}

    def _stored_id(self) -> str | None:
        lib = self._library()
        return (lib.get("selected") or {}).get("voice_id") or ""

    async def async_select_option(self, option: str) -> None:
        """Options are NAMES, and a name is a courtesy: the backend keeps
        the names it owns unique, but a Home Assistant voice's name is
        Home Assistant's and can match another voice's at any time. Two
        voices answering to the chosen name is a refusal, never a pick --
        the same rule a calendar event's `voice:` request follows."""
        matches = {i["id"] for i in self._items() if i["name"] == option}
        if len(matches) > 1:
            raise HomeAssistantError(
                f'More than one voice is called "{option}". Rename one in '
                "the voice library, then choose again.")
        await super().async_select_option(option)

    async def _write(self, item_id: str | None) -> None:
        await self.coordinator.client.voices_select(item_id or "")
        # the base class refreshes next; make that refresh actually refetch
        self.coordinator.invalidate_voice_library()


class StationFeelSelect(CatalogGatedEntity, _CatalogSelect):
    """How adventurous the station's own picks are -- which only means
    something where the station picks. `_CatalogSelect` here is the
    OPTION-LIST base (the friendly names from /studio/catalog); the local
    MUSIC catalog is the separate capability CatalogGatedEntity reads, and
    the feels list arrives whether or not this installation has one."""

    _attr_name = "Station feel"
    _attr_icon = "mdi:tune-variant"
    catalog_key = "feels"

    def __init__(self, coordinator, entry_id: str) -> None:
        super().__init__(coordinator, entry_id, "station_feel")

    def _stored_id(self) -> str | None:
        return (self.coordinator.data.get("station_settings") or {}).get("feel")

    async def _write(self, item_id: str | None) -> None:
        await self.coordinator.client.set_station_feel(item_id)


class SameArtistFrequencySelect(CatalogGatedEntity, SelectEntity):
    """How often the autonomous runway may place same-artist
    doubles. Only meaningful while the Back-to-back same artist switch is
    on, and only on an installation with a local catalog; a settings write
    only."""

    _attr_name = "Same artist frequency"
    _attr_icon = "mdi:account-multiple"
    _attr_options = ["Low", "Medium", "High"]

    def __init__(self, coordinator, entry_id: str) -> None:
        super().__init__(coordinator, entry_id, "same_artist_frequency")

    def _sa(self) -> dict:
        return (self.coordinator.data.get("station_settings") or {}).get(
            "same_artist") or {}

    @property
    def available(self) -> bool:
        # Disabled (unavailable) when back-to-back is off -- the frequency
        # has no effect then.
        return super().available and bool(self._sa().get("enabled"))

    @property
    def current_option(self) -> str | None:
        value = self._sa().get("frequency")
        return value.title() if value in ("low", "medium", "high") else None

    async def async_select_option(self, option: str) -> None:
        try:
            await self.coordinator.client.set_same_artist_frequency(
                option.lower())
        except RadioServiceError as exc:
            raise HomeAssistantError(str(exc)) from exc
        await self.coordinator.async_request_refresh()
