"""The panel URL must name the bytes Home Assistant will actually serve.

Kept out of __init__ deliberately. This is the only place in the
integration that is allowed to look at the filesystem, and isolating it
keeps the contract that the integration never inspects paths to decide
what the backend is capable of (test_panel_station pins that by banning
filesystem calls in the lifecycle modules outright)."""

from __future__ import annotations

import gzip
import hashlib
import os

#: Suffixes aiohttp's static handler will serve INSTEAD of the plain file
#: when the request carries the matching Accept-Encoding. A browser always
#: offers gzip; curl does not unless asked, which is why a drifted sibling
#: can hide from every command-line check. `.br` is not substituted by every
#: aiohttp, but it is by some, and we never ship either -- so both are
#: foreign files and both are pruned.
PRECOMPRESSED_SUFFIXES = (".gz", ".br")
PANEL_FILE = "parlorwave-radio-panel.js"


def _decoded_bytes(path: str) -> bytes | None:
    """What a client actually receives for `path`, decoded. None if the file
    cannot be decoded at all -- which for a sibling we never ship is reason
    enough to treat it as foreign."""
    if path.endswith(".gz"):
        try:
            with gzip.open(path, "rb") as fh:
                return fh.read()
        except Exception:
            return None
    if path.endswith(".br"):
        try:
            import brotli  # not a dependency; absent means undecodable
        except ImportError:
            return None
        try:
            with open(path, "rb") as fh:
                return brotli.decompress(fh.read())
        except Exception:
            return None
    with open(path, "rb") as fh:
        return fh.read()


def panel_asset_version(root: str, name: str = PANEL_FILE) -> tuple[str, list[str]]:
    """Prune stale pre-compressed siblings of the panel, then version the URL
    by everything the static route can still serve for it.

    The failure this prevents: a URL versioned only by sha256 of the PLAIN
    `.js` does change on a deploy, and browsers do refetch -- into a stale
    `parlorwave-radio-panel.js.gz` left behind by a previous install. They
    get the OLD panel from the NEW URL, and then CACHE the old panel under
    the new URL. The version marker and the bytes behind it have no
    relationship at all, so neither a hard refresh nor a private window
    can help.

    The two halves do different jobs:

    * Pruning is what makes the served bytes correct. Nothing else does;
      a digest only ever changes a URL, it cannot change an answer.
    * Covering the servable SET in the digest is what keeps the marker
      honest, so `?v=` is a true function of what the route can answer
      rather than of one file it might not use. That is what stops a URL
      poisoned while a sibling was stale from being reused for repaired
      content: the poisoned URL was computed with the sibling present, the
      repaired one is not, so they cannot collide. It also keeps the failure
      visible when the sibling cannot be deleted at all.

    Returns (digest, removed) -- `removed` is for the caller to log.
    """
    plain = os.path.join(root, name)
    with open(plain, "rb") as fh:
        plain_bytes = fh.read()
    plain_sha = hashlib.sha256(plain_bytes).hexdigest()

    # Each entry is "<variant>:<sha of what that variant decodes to>". After a
    # successful prune every surviving sibling decodes to the plain file, so
    # this reduces to the plain digest plus the names present -- deterministic,
    # and independent of gzip level or mtime, which must not churn the URL.
    manifest = [f"{name}:{plain_sha}"]
    removed: list[str] = []
    for suffix in PRECOMPRESSED_SUFFIXES:
        sibling = plain + suffix
        if not os.path.exists(sibling):
            continue
        decoded = _decoded_bytes(sibling)
        if decoded == plain_bytes:
            manifest.append(f"{name}{suffix}:{plain_sha}")
            continue
        try:
            os.remove(sibling)
            removed.append(os.path.basename(sibling))
        except OSError as err:
            # Read-only config, or no permission. We cannot fix the bytes, but
            # the URL must not lie about them: fold the stale content into the
            # digest so it is at least distinct from the healthy one.
            stale = hashlib.sha256(decoded if decoded is not None
                                   else b"<undecodable>").hexdigest()
            manifest.append(f"{name}{suffix}:STALE:{stale}:{err.errno}")
    return hashlib.sha256("\n".join(manifest).encode()).hexdigest()[:12], removed


