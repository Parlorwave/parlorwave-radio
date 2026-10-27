"""What Home Assistant's recorder should NOT keep about these entities.

The DJ status and Now Playing sensors carry a few attributes that change
on every coordinator poll while the station is doing anything at all:
the seconds until the next break, the timestamp that says the same thing,
and the elapsed-time basis the panel's progress bar advances from. Every
such change is a new state row AND a new attributes row in the recorder
database -- on a Raspberry Pi that database is on the SD card -- and none
of it is history anyone reads back: nobody graphs "seconds to air".

**This module only names the set; it does not apply it.** Home Assistant
applies it from `Entity._unrecorded_attributes`, which `sensor.py` sets
from `VOLATILE_ATTRIBUTES` -- the entity publishes the names in its
`state_info`, and `StateAttributes.shared_attrs_bytes_from_event` drops
them before serialising. The attributes blob is then identical from one
poll to the next and the recorder reuses the row it already has.

The recorder's old `exclude_attributes` platform hook, which an earlier
draft of this file relied on, **no longer exists**: a `recorder.py` is
still imported, but only its statistics methods are read
(`INTEGRATION_PLATFORM_METHODS` in `homeassistant/components/recorder/
const.py`), and an `exclude_attributes` beside them is ignored in
silence -- no warning, nothing in the log, every volatile attribute
recorded exactly as before. Source-level checks stay green with it; only
the recorder's own rows show that it does nothing. Do not
reintroduce the hook.

The live state, the panel, automations and templates are unaffected;
only the history is smaller. The diagnostic structures (observer,
problems, catalog, the allow-list, the context publisher's status) are
excluded for the same reason: they are the current answer to "why is no
break coming", not a time series, and they are the largest part of the
attribute payload.

What stays recorded: the DJ's status word, what was said and when, the
Now Playing identity (title, artist, album, kind) and the station
identity -- the things a person might actually look for in History.
"""

from __future__ import annotations

#: Attributes that change with every poll, or are diagnostics rather
#: than history. Applied by sensor.py via `_unrecorded_attributes`.
VOLATILE_ATTRIBUTES: frozenset[str] = frozenset({
    # DJ status: the countdown and its timestamp twin (fast break polling)
    "seconds_to_air", "next_break_at",
    # DJ status: current diagnostics, republished each cycle
    "observer", "problems", "catalog", "outputs_enabled", "context", "readiness_key",
    # Now Playing: the progress-bar basis, new every poll while playing
    "elapsed", "elapsed_at",
})
