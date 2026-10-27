"""Real readiness documents for the panel's Settings tests.

Not a test module. The node suite test_panel_settings_redesign.mjs runs it
to get the documents the integration would really send, built by
readiness.py through the real `parlorwave_radio/readiness` command (the
same `doc()` the python Settings tests use), so the screen is exercised
with the model's own sentences and never with hand-written copies.

    PYTHONPATH=ha:ha/tests python3 -B ha/tests/readiness_docs.py [name ...]

prints one JSON object, name -> document.
"""
import json
import sys

sys.dont_write_bytecode = True

import test_panel_settings as T  # noqa: E402

H, P = T.health, T.problem
NO_VOICE = {"configured": False, "providers": [],
            "selected": {"provider": None, "entity_id": None, "name": None, "state": None}}

SCENARIOS = {
    # a brand-new installation: none of the four steps done
    "first_run": lambda: T.doc(tts_entities=(), **T.OneProblemIsStatedInOnePlace.FIRST_RUN),
    # Music Assistant answers; no speaker, no voice, the DJ off: the speaker
    # step is the first one not done
    "speaker_next": lambda: T.doc(tts_entities=(), report=H(
        [P("no_outputs_enabled", "warning", "outputs"), P("tts_unconfigured", "warning", "tts")],
        tts=NO_VOICE, outputs={"dj_enabled": False, "enabled": [], "selected": None})),
    # two of four done: the voice is next
    "partial": lambda: T.doc(tts_entities=(), report=H(
        [P("tts_unconfigured", "warning", "tts")], tts=NO_VOICE, outputs={"dj_enabled": False})),
    "ready": lambda: T.doc(),
    "ready_warnings": lambda: T.doc(report=H(
        [P("output_selection_not_enabled", "warning", "outputs"),
         P("advertise_url_loopback", "warning", "audio")],
        outputs={"enabled": ["media_player.den"], "selected": "ma_web123"})),
    # an established installation that went wrong
    "ma_unreachable": lambda: T.doc(report=H(
        [P("ma_unreachable", "error", "music_assistant")], music_assistant={"reachable": False})),
    "voice_unavailable": lambda: T.doc(report=H(
        [P("ha_tts_entity_unavailable", "error", "tts")],
        tts={"selected": {"provider": "home_assistant", "entity_id": "tts.piper",
                          "name": "Piper · Amy", "state": "unavailable"}})),
    "dj_off": lambda: T.doc(report=H(outputs={"dj_enabled": False})),
    "speakers_unticked": lambda: T.doc(report=H(
        [P("no_outputs_enabled", "error", "outputs")],
        outputs={"enabled": [], "selected": None})),
    # an ESTABLISHED installation losing its prerequisites one by one: four
    # passing (ready), then three, two, one and none -- the same
    # configuration as "ready" with each failure added on top of the last
    "pass3": lambda: T.doc(report=H(outputs={"dj_enabled": False})),
    "pass2": lambda: T.doc(report=H(
        [P("ha_tts_entity_unavailable", "error", "tts")],
        tts={"selected": {"provider": "home_assistant", "entity_id": "tts.piper",
                          "name": "Piper · Amy", "state": "unavailable"}},
        outputs={"dj_enabled": False})),
    "pass1": lambda: T.doc(report=H(
        [P("ha_tts_entity_unavailable", "error", "tts"),
         P("no_outputs_enabled", "warning", "outputs")],
        tts={"selected": {"provider": "home_assistant", "entity_id": "tts.piper",
                          "name": "Piper · Amy", "state": "unavailable"}},
        outputs={"dj_enabled": False, "enabled": [], "selected": None})),
    "pass0": lambda: T.doc(report=H(
        [P("ma_unreachable", "error", "music_assistant"),
         P("ha_tts_entity_unavailable", "error", "tts"),
         P("no_outputs_enabled", "warning", "outputs")],
        music_assistant={"reachable": False},
        tts={"selected": {"provider": "home_assistant", "entity_id": "tts.piper",
                          "name": "Piper · Amy", "state": "unavailable"}},
        outputs={"dj_enabled": False, "enabled": [], "selected": None})),
    # wrong, and no step owns it
    "observer_stopped": lambda: T.doc(report=H(
        [P("observer_not_running", "error", "observer")], observer={"running": False})),
    # the service has not answered yet
    "checking": lambda: T.doc(report={}),
}


def main(names):
    out = {}
    for name in names or list(SCENARIOS):
        out[name] = SCENARIOS[name]()
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main(sys.argv[1:])
