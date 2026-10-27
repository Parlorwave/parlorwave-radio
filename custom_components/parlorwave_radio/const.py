"""Constants for the Parlorwave Radio integration."""

DOMAIN = "parlorwave_radio"

CONF_HOST = "host"
CONF_PORT = "port"
CONF_API_KEY = "api_key"
# The backend's own stable identity (GET /instance, and the Supervisor
# discovery payload). The config entry is keyed on THIS, never on the
# connection: a hostname, an address and an API key all legitimately change
# for one installation -- an add-on installed from a repository instead of
# locally answers to a different hostname, for instance.
CONF_INSTANCE_ID = "instance_id"

DEFAULT_PORT = 5005
DEFAULT_SCAN_INTERVAL_S = 10
# A finite break is a SHORT event -- ten to thirty seconds -- and the
# ordinary cadence is far too coarse to describe one. Polled every ten
# seconds, `on_air` can arrive most of the way through the break and still
# be reported ten seconds after the music comes back, and that is the state
# dashboards and automations act on. While the DJ says a
# break is imminent or airing the coordinator asks on THIS cadence instead,
# and returns to the ordinary one the moment the break window closes: no
# sleeps, no extra surface, and the fast rate only exists for the seconds
# the break does.
BREAK_WINDOW_SCAN_INTERVAL_S = 2
# The statuses that mean "a rendered break is inserted, about to air, or
# airing" (dj_engine._STATUS_LABELS). `ready` and `up_next` are in the
# window and not just `on_air`: entering fast polling only once the break
# is already airing would be too late to report its start promptly.
BREAK_WINDOW_STATUSES = ("ready", "up_next", "on_air")

# Values mirrored from the service's settings contract (settings.py). The
# backend remains the validator of record; these only shape the UI.
BREAK_LENGTHS = ["short", "normal", "long"]
# ONE minute is the smallest cadence the product offers, and the
# backend validator, this entity, the panel's spinner and the error copy
# all say so. Zero is deliberately NOT a value: "no breaks at all" is what
# the DJ switch is for, and a minimum of 0 advertised a setting the service
# then refused -- 0 and 0.5 were both rejected by a validator whose message
# said "between 0 and 240".
CADENCE_MIN = 1
CADENCE_MAX = 240

# Studio: the break-content toggles (settings.dj.content) with their
# friendly names. Personalities, chattiness levels, station feels and voices
# are NOT listed here: they arrive from GET /studio/catalog with friendly
# names attached, so a new profile or voice needs no integration change.
BREAK_CONTENT = {"weather": "Weather in breaks",
                 "calendar": "Calendar in breaks",
                 "news": "News in breaks"}
STUDIO_CATALOG_TTL_S = 300
# A shelf whose optional cloning engine is unreachable is retried on
# THIS interval rather than on every coordinator cycle -- often enough that
# a recovered engine is noticed promptly, rarely enough that a dead one is
# not asked ten times a minute.
VOICE_DEGRADED_TTL_S = 30
# A Home Assistant TTS voice is a tts.* entity, and the logical voice id is
# a pure function of that entity id (backend voice_library.ha_voice_id).
# The integration needs the mapping to watch the entity a voice speaks
# through; it is spelled out here rather than guessed per call site.
HA_VOICE_PREFIX = "ha_tts_"

# Sidebar panel. The path must not collide with any Lovelace dashboard or
# other integration: a taken path makes the native panel silently vanish
# (Home Assistant refuses to overwrite a registered panel).
PANEL_URL_PATH = "parlorwave-radio"
PANEL_TITLE = "ParlorWave Radio"
PANEL_STATIC_BASE = "/parlorwave_radio_panel"

# Context publishing (options). The integration itself feeds weather /
# sun / calendar facts to the backend; nothing outside it is needed.
CONF_WEATHER_ENTITY = "weather_entity"
CONF_CALENDAR_ENTITIES = "calendar_entities"
# DJ-enabled outputs (options form field only -- the backend's
# settings.dj.outputs.enabled is the single store of record; the entry's
# options never carry a copy).
CONF_DJ_OUTPUTS = "dj_outputs"
# The health surface (GET /health/problems) rides a modest TTL: it performs
# live probes, so it is not polled on the entity cadence.
HEALTH_TTL_S = 60
# Process-wide registration guards (hass.data keys). Static paths cannot be
# unregistered in Home Assistant, so they are registered exactly once per
# process; the websocket commands likewise.
DATA_STATIC_REGISTERED = "parlorwave_radio_static_registered"
DATA_WS_REGISTERED = "parlorwave_radio_ws_registered"
DATA_VIEW_REGISTERED = "parlorwave_radio_view_registered"
# This integration's own version, read once from manifest.json and shown
# only under Settings' advanced disclosure (support detail).
DATA_VERSION = "parlorwave_radio_version"
#: Repairs issue: the add-on runs a different public release than this
#: integration (they are released together and must match).
ISSUE_ADDON_VERSION = "addon_version_mismatch"

# The voice-sample upload path. An AUTHENTICATED Home Assistant view (see
# http.py): the panel posts the recording's bytes to Home Assistant, and
# Home Assistant -- which holds the service credential -- forwards them.
# The browser never learns the backend's address or its API key, and there
# is no unauthenticated endpoint anywhere in this integration.
VOICE_SAMPLE_URL = "/api/parlorwave_radio/voice_sample"
# Listen Again streams a bulletin THROUGH Home Assistant. The browser
# never learns the backend's address and never holds its API key; the
# view attaches that on this side, exactly as the upload path does.
BULLETIN_AUDIO_URL = "/api/parlorwave_radio/bulletin_audio"
# The same bound the backend enforces, applied at the door so an oversized
# body is refused before Home Assistant buffers it.
MAX_SAMPLE_BYTES = 10 * 1024 * 1024
# Voice enrollment. A recording is stored only with the owner's
# acknowledgement that they may create and use the voice; the backend owns
# the sentence and publishes it with this version in the voice library
# (cloning.consent), and refuses any other. The door checks the same
# version so a request without it never reaches the backend at all.
VOICE_CONSENT_VERSION = "voice-permission-v1"
# What a voice may be used for (the backend's dj.voice_scopes values), and
# how a sample arrived. Checked at the door; the backend is the authority.
VOICE_SCOPES = ("dj", "announcement", "both")
VOICE_SAMPLE_SOURCES = ("recording", "file")
# The longest preview line an owner may type (backend PREVIEW_MAX_CHARS).
VOICE_PREVIEW_MAX_CHARS = 200
SUN_ENTITY = "sun.sun"
CONTEXT_REFRESH_MINUTES = 10        # safety refresh; state changes publish sooner
# How far ahead upcoming events are read. This was 6, which is comfortably
# more than the 20-150 minute window a TIMED event is announced in -- but an
# all-day event is announced on its own day or the day before, and at (say)
# nine in the morning tomorrow's all-day entry is 15 hours away. Six hours
# could not see it, so widening the backend's eligibility alone would have
# changed nothing. 36 covers "tomorrow" from any hour of the day.
#
# The event list stays capped at context_facts.MAX_EVENTS and is sorted
# soonest-first, so a wider horizon adds distant events only when there is
# room left after the near ones.
CALENDAR_HORIZON_HOURS = 36

SERVICE_REQUEST = "request"
SERVICE_START_RADIO = "start_radio_from_current"
SERVICE_THUMBS_UP = "thumbs_up"
SERVICE_THUMBS_DOWN = "thumbs_down"
SERVICE_VOICE_RENAME = "voice_rename"
SERVICE_VOICE_DELETE = "voice_delete"
SERVICE_VOICE_NOTE = "voice_note"
SERVICE_VOICE_TUNING = "voice_tuning"
SERVICE_VOICE_UPLOAD = "voice_upload"
# Every service this integration registers (domain-global: registered by
# the first entry, removed when the last entry unloads). Unload must remove
# exactly this set -- pinned by the lifecycle tests.
SERVICES = (SERVICE_REQUEST, SERVICE_START_RADIO, SERVICE_THUMBS_UP,
            SERVICE_THUMBS_DOWN, SERVICE_VOICE_RENAME, SERVICE_VOICE_DELETE,
            SERVICE_VOICE_NOTE, SERVICE_VOICE_TUNING, SERVICE_VOICE_UPLOAD)
