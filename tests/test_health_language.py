"""What a customer may be shown about this installation's health.

ONE TRANSLATION, AND THIS IS THE TEST OF IT. The backend publishes
twenty-odd structured problems written for whoever deploys the service:
they name environment variables, service URLs, HTTP status codes, a
filesystem path and the internal speech engines. `readiness.py` is the one
place those become a person's words, and every customer-facing health
surface -- Settings' verdict, its To fix list, and the banner above the
other four screens -- renders that document and nothing else.

So the property worth testing is not "this string is absent from that
file". It is: FEED THE MODEL THE WORST THING THE SERVICE CAN SAY, and walk
every string that comes out. A word-list check would pass a build that
grew a new leak through a code nobody had enumerated; this does not.
"""

import re
import unittest

from test_panel_settings import SettingsTransport, doc, features, health, problem

from custom_components.parlorwave_radio import readiness


#: Everything the backend legitimately says to an operator, in one problem.
#: Every fragment here appears verbatim in health.py or config.py today.
HOSTILE = [
    problem("some_code_this_build_has_never_heard_of", "error", "tts",
            summary="the selected voice speaks through chatterbox at "
                    "http://192.0.2.10:11434, which is not configured",
            action="set MUSICBRAIN_HA_URL and DJ_TTS_URL, check "
                   "/data/musicbrain/api_key, or run as the add-on"),
    problem("ma_unreachable", "error", "music_assistant",
            summary="Music Assistant at http://192.0.2.11:8095 did not "
                    "answer: timed out",
            action="check MUSIC_ASSISTANT_URL and MUSIC_ASSISTANT_TOKEN"),
    problem("observer_not_running", "error", "observer",
            summary="the Music Assistant observer is not running",
            action="check the service log; MA_OBSERVER_QUEUE must be 'auto'"),
    problem("optional_writer_unavailable", "warning", "writer",
            summary="the LLM writer at http://192.0.2.10:11434 is not "
                    "answering (connection refused)",
            action="check OLLAMA_URL and that the server is running"),
]

#: Shapes, not words. A leak is a shape.
FORBIDDEN = [
    ("an environment variable", re.compile(r"\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b")),
    # A scheme followed by something. "starting with http:// or https://"
    # is the copy teaching somebody what a web address looks like -- an
    # instruction, not an address -- and requiring a non-space after the
    # slashes is what tells the two apart.
    ("a URL", re.compile(r"[a-z][a-z0-9+.\-]*://[\w\[]", re.I)),
    ("an absolute path", re.compile(r"(?<![\w.~])/(?:[\w.@%+\-]+/)+")),
    ("a bare host:port", re.compile(r"\b(?:[a-z0-9\-]+\.)+[a-z0-9\-]+:\d{2,5}\b",
                                    re.I)),
    ("an internal speech engine", re.compile(r"\b(?:chatterbox|kokoro|ollama)\b",
                                             re.I)),
    ("the internal module name", re.compile(r"music[\s_-]?brain", re.I)),
    ("the retired product name", re.compile(r"\bjarvis\b", re.I)),
]

#: The one address the screen exists to show: "which Music Assistant am I
#: pointed at" is the question a setup screen answers. It is carried in
#: exactly two named places and nowhere else, and this test proves that by
#: excluding those two rather than by excluding the string.
ENDPOINT_FIELDS = {("music_assistant", "endpoint"),
                   ("music_assistant", "rows"),
                   ("diagnostics", "rows")}


def strings(node, path=()):
    """Every string in the document, with the path it sits at."""
    if isinstance(node, str):
        yield path, node
    elif isinstance(node, dict):
        for key, value in node.items():
            yield from strings(value, path + (str(key),))
    elif isinstance(node, (list, tuple)):
        for item in node:
            yield from strings(item, path)


class TheCustomerFacingHealthDocument(unittest.TestCase):
    def _walk(self, document):
        found = []
        for path, text in strings(document):
            if any(path[:len(f)] == f for f in ENDPOINT_FIELDS):
                continue
            for label, pattern in FORBIDDEN:
                if pattern.search(text):
                    found.append(f"{'.'.join(path) or '(root)'}: {label} in "
                                 f"{text[:90]!r}")
        return found

    def test_the_worst_the_service_can_say_reaches_no_screen(self):
        document = doc(report=health(HOSTILE))
        leaks = self._walk(document)
        self.assertEqual(leaks, [], "customer-facing health text leaked:\n  "
                                    + "\n  ".join(leaks))

    def test_an_unrecognised_code_is_visible_but_does_not_speak_for_itself(self):
        """A fault a customer cannot see at all is worse than one described
        plainly -- but "described" must not mean "in the vocabulary of
        whoever deploys the service"."""
        document = doc(report=health(HOSTILE))
        codes = [b["code"] for b in document["blockers"]]
        self.assertIn("some_code_this_build_has_never_heard_of", codes)
        unknown = next(b for b in document["blockers"]
                       if b["code"] == "some_code_this_build_has_never_heard_of")
        self.assertNotIn("chatterbox", unknown["title"] + unknown["detail"])
        self.assertNotIn("MUSICBRAIN", unknown["title"] + unknown["detail"])
        # and the code still travels, so a bug report can name it
        self.assertIn("some_code_this_build_has_never_heard_of",
                      [p["code"] for p in document["diagnostics"]["problems"]])

    def test_every_phrase_this_build_ships_is_already_clean(self):
        """The copy table itself, independent of any fixture."""
        leaks = []
        for code, (title, detail, _where, _kind) in readiness._COPY.items():
            for label, pattern in FORBIDDEN:
                for text in (title, detail):
                    if pattern.search(text):
                        leaks.append(f"_COPY[{code}]: {label} in {text[:70]!r}")
        self.assertEqual(leaks, [], "\n  ".join(leaks))

    def test_the_music_assistant_endpoint_is_the_one_deliberate_exception(self):
        """Excluded above by PATH, so this test has to show it is really
        there -- otherwise the exclusion could be hiding a change of
        behaviour rather than describing one."""
        document = doc()
        self.assertTrue(document["music_assistant"]["endpoint"])
        rows = dict(document["music_assistant"]["rows"])
        self.assertIn("://", rows["Server"])

    def test_a_fresh_installation_is_setup_and_not_a_failure(self):
        """The state a stranger actually meets: the add-on is running, Home
        Assistant speech exists, and nobody has chosen a voice yet. That is
        four setup steps, not a fault -- and the word "chatterbox", which is
        the engine the router would fall back to, is not a fact about their
        installation."""
        document = doc(report=health(
            [problem("tts_voice_unselected", "warning", "tts",
                     summary="no DJ voice has been chosen yet; breaks cannot "
                             "be spoken until one is",
                     action="choose a voice in the ParlorWave Radio panel, "
                            "under Booth")],
            tts={"configured": True, "providers": ["home_assistant"],
                 "selected": {"provider": None, "entity_id": None,
                              "name": None, "state": None}},
            outputs={"dj_enabled": False, "enabled": [], "selected": None}))
        self.assertEqual(document["state"], readiness.NEEDS_SETUP)
        self.assertEqual(document["headline"], "Not quite ready.")
        # nothing is presented as broken
        self.assertEqual(document["blockers"], [])
        self.assertEqual(document["warnings"], [])
        # the speech step is waiting, and it sends you to Booth
        step = next(c for c in document["checklist"] if c["key"] == "speech")
        self.assertFalse(step["done"])
        self.assertEqual(step["where"], readiness.WHERE_BOOTH)
        self.assertEqual(document["speech"]["label"], "No voice chosen")
        self.assertEqual(self._walk(document), [])


if __name__ == "__main__":
    unittest.main()
