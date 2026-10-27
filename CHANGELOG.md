# Changelog

## 0.1.0-alpha.4

The second public Alpha. It is a polish and reliability release on top of
0.1.0-alpha.3: calmer screens, a single-song request, a Newsroom that tells
the time right, a station that behaves when a queue runs out, one place to
choose what the DJ may use, and a record of why each break aired. Install the
add-on at the same version; the add-on's changelog lists the service
changes. If you are on 0.1.0-alpha.3, see "Updating from 0.1.0-alpha.3" in
the README: nothing has to be set up again.

The limitations at the end of this entry are part of the release.

**On Air**

- **A DJ chip** beside Speaker, Station and Next break names the voice the
  DJ is using. It follows Automatic DJ shifts, and says *Default voice* when
  the voice you chose cannot host and the station's default is speaking
  instead.
- **History no longer repeats the break shown in the Air Check.**
- **Queue Ended.** When a queue without Repeat plays to its end, On Air says
  *Queue Ended*, with no song, artwork or progress. Before, it showed an old
  song as paused half way through. Pressing Play to start the queue again
  starts a new station pass: the DJ talks again over music it has already
  hosted.
- The thumbs are hidden while there is no local catalogue to learn from
  (they could not do anything), with no divider left behind.
- The idle "Double-click …" hover hints over the console are gone; the
  gestures are unchanged and Settings still explains them.
- The ParlorWave wordmark on the nameplate is a little smaller, and its
  final *e* runs straight into the underline.
- **A problem is said where you are looking.** When something stops the
  station, such as Music Assistant not answering, On Air and Station say so
  in the same words as Settings, with **Open Settings**, instead of
  "standing by" or "start an album".
- **The DJ knob answers at once** and holds until the DJ has really changed,
  instead of showing its old state for several seconds.
- **The knobs are named** on the console (VOLUME · DJ, TUNING · SPEAKERS),
  with one vocabulary across captions, tooltips and hints.
- **A refusal is a sentence.** A refused request or save says why in plain
  words; the service's own message is kept under *Details for support*.
- **On Air no longer flickers.** It keeps its layout when only the progress
  moves, and open Queue and Lyrics drawers keep their place.

**Booth**

- **Music stories** is a new switch under Break style: short true stories
  about the artists you're hearing, from your Music Assistant library.
  Stories do not air in this release yet. The row says so, and keeps your
  choice for when they do.
- **Personality chips answer at once.** Pressing one changes the headline,
  the description and the pressed chip immediately. Two plain lines say what
  the **Next break** will be written as and what the **Last break** was
  written as. With an external writing model, its tone now follows the
  personality too.
- **Switch DJ is gone.** On Air names the DJ, and **Change voice** is the one
  manual control. The current DJ, its *Selected* badge and Preview stay.
- **Preview speaks a natural sentence** from a full-width box that you can
  edit, and the whole line is visible on a phone.
- **Each voice's "Used for" is a compact chip** that opens to the same three
  choices, so a grant can still be given and taken back. Nothing is granted
  by default.
- **Replace says which voice it is replacing** and takes you straight to
  Record, with a line of reading guidance: read naturally, it does not have
  to be word for word.

**Newsroom**

- **"Last aired" tells the right time.** On an installation west or east of
  UTC, a bulletin that aired twenty minutes ago read as hours old.
- **A feed added under Bulletin Sources counts as configured.** On a fresh
  install, the desk said *No feed configured* and Station said *No feed*
  while bulletins were airing.
- While bulletins are on, the desk no longer repeats what its chips say, and
  the *On the Wire* footer is gone.
- **Save refuses a source with no address** and keeps the row, instead of
  dropping it and saying the Newsroom was saved.

**Station**

- **Play a song next.** The Request Line has a row for one song: type a
  title (and, if you like, the artist), press **Play next**, and that song
  from your Music Assistant library plays after the current one, on the
  speaker the DJ is on. The panel says *Up next* only once Music Assistant
  shows the song directly after the one playing. It says plainly when it
  did nothing, and why:
  - the speaker is paused (press play first) or nothing is playing;
  - a DJ break or the news is on the air or up next;
  - Music Assistant has already lined up the next song (ask again once it
    starts);
  - your previous request is still waiting to play;
  - there is more than one match. Several versions are listed, and
    *Title (Version)* chooses one;
  - the song is not in your library, or the library cannot be read.
- **Edit Station Name** is a button of its own, and *No Dial Station running*
  says what *No station on the air* meant.
- The roadmap and *About the Dial* are gone. Music source says what is true:
  Dial Stations and requests play from your Music Assistant library.
- **A Dial Station can take over the DJ's own speaker**, even one that
  belongs to speaker groups or that Music Assistant's Autoplay keeps
  topped up, as long as its queue plays in Flow mode and its groups are
  idle. Station lists the songs queued ahead; you tick the ones to remove,
  and the station waits as *Queued* behind any you keep. When the station
  stops, the speaker's Autoplay setting is put back; if it was changed in
  the meantime, Station asks instead of overwriting it.

**Settings**

- **Music Assistant Autoplay refilling with old breaks is reported**, with
  the fix: see Limitations.
- **Broadcast diagnostics**, for Home Assistant administrators, under
  *Support details*. For each DJ break it shows, from what the station
  recorded, whether the break aired as its writer wrote it, aired as the
  station's own line, or did not air, and why. **Inspect** on the Air Check
  and on a History row opens that break's record. Calendar event titles
  are masked, an announcement's message is withheld, and nothing that could
  play a break's audio is shown. A break written by the built-in writer
  reads *Accepted*.
- **Ready is shown only while it is true.** Settings no longer keeps a
  green *Ready* for up to a minute and a half after something changes. At
  Home Assistant's next check of the service, every ten seconds, it notices
  that the add-on restarted (after a new Music Assistant token is saved, for
  example) or that Music Assistant stopped answering or refused the token,
  and shows the problem with what to do. While it cannot get an answer, it
  says it is checking, or that the service is not answering. Once the
  problem is fixed, *Ready* comes back just as quickly.
- **Home Assistant 2026.10's names.** Instructions say *Settings → Apps* and
  the *App store*, as Home Assistant 2026.10 does, with the older *Add-ons*
  path alongside.
- **What the DJ may use.** One card chooses the speakers ParlorWave may DJ
  on, the weather entity and the calendars, each saved on its own. They are
  the same settings as the integration's options, and changing them no
  longer reloads the integration.
- **Unticking a calendar says what happens** to announcements already
  scheduled from it.
- **Setup is said once.** While setup is not complete, its four steps are
  listed under the verdict; once ready, they fold into the Ready strip. A
  readiness answer older than five minutes is never shown as *Ready*.
- **Settings no longer flashes or jumps** when it refreshes.

**Limitations of this Alpha**

- **Music Assistant 2.10.6, Flow mode, "smart" sample rate.** In Flow mode,
  Music Assistant fixes the stream's sample rate from the first item it
  plays. When a later item needs a higher rate, it ends that stream and opens
  a new one, which can be heard as a gap or a restart at the change. Songs of
  different sample rates are enough to cause it. ParlorWave's breaks and
  bulletins are ordinary MP3s and can be on either side of such a change. A
  possible workaround, per speaker: in that player's settings in Music
  Assistant, change the Flow mode sample rate from *Smart* to a fixed rate
  (for example *48000*), so that Music Assistant resamples everything
  instead of restarting. Which rate a speaker accepts depends on the player.
  ParlorWave Radio does not change this setting, and does not work around it.
- **Music Assistant Autoplay can refill a queue with old breaks.** Music
  Assistant picks what to add from the last items played, and ParlorWave's
  breaks and bulletins are among them. ParlorWave removes what it inserted,
  but the queue can run out of music. Settings warns when it happens. The
  remedy is to set that player's Autoplay mode in Music Assistant to your
  library or a playlist, or to switch Autoplay off.
- **Play a song next** plays one song, from your Music Assistant library,
  on the DJ's speaker. It cannot choose between albums yet, and while one
  request waits, the next is refused. The waiting request is forgotten if
  the add-on restarts.
- **On Air redraws when Home Assistant sends an update**, so parts of it can
  flash briefly. Open lists and the History scroll position are kept.
- The add-on image is multi-architecture (amd64, aarch64); the aarch64 build
  was executed under QEMU emulation and has not been tested on a physical
  Raspberry Pi.
- **Updating from 0.1.0-alpha.3** passed when rehearsed with a staged copy
  of this release (Home Assistant OS 18.3, Home Assistant 2026.10.4, Music
  Assistant 2.10.8). The update from the published repositories, through
  HACS and the App store, cannot be verified until this release is
  published. Settings, devices and entities are kept, as in every update
  since 0.1.0-alpha.1.
- **The version notice in Repairs** compares the add-on and the integration
  when Home Assistant starts ParlorWave Radio. After updating only the
  add-on, it appears or clears at the next restart or **Reload**.
- **Broadcast diagnostics masks a calendar title as the event names it**,
  however its words are spaced. A title the DJ put in other words cannot be
  recognised.
- No music-knowledge pack and no curated voices ship. Pandora sources are not
  qualified. Listening to the station in the browser is not in this release.
- **Custom voices need a voice engine you run yourself**; none ships. They
  were tested with Chatterbox TTS API 2.1.0, and three are held at a time.
  Recording in the browser needs Home Assistant opened over https; otherwise
  choose a recording file.

## 0.1.0-alpha.3

The first public Alpha of ParlorWave Radio. It replaces the 0.1.0-alpha.1
development preview: everything that preview did is in this release,
together with everything since (0.1.0-alpha.2 was an internal release
candidate and was never published). Install the add-on at the same version;
the add-on's changelog lists the service changes. If you installed the
preview, see "Updating from the 0.1.0-alpha.1 preview" in the README.

Alpha still means the product works end to end and its shape may still
change. The limitations at the end of this entry are part of the release.

**Installing and updating**

- **Home Assistant 2026.9 or newer is required.** 0.1.0-alpha.1 declared
  2024.11; nothing older than 2026.9 has been tested, so the release no
  longer offers itself to older installations.
- **First run says what to do.** A fresh install opens on Settings when
  something is still missing, states in one line whether the installation is
  ready, and routes to where each remaining thing is done.
- **The *Discovered* card stays until the add-on answers.** If you confirm it
  while the add-on is still starting, the card says the service could not be
  reached; confirm again a moment later.
- **A rejected API key asks you to reauthenticate** instead of retrying
  forever. With the Home Assistant OS add-on, restarting the add-on sends its
  key again and the entry recovers by itself. If you reinstalled the add-on,
  it is a new installation: delete the old entry and confirm the newly
  discovered one.
- **A different installation at the same address is reported, not used.**
- **Mismatched add-on and integration releases are a Repairs issue** naming
  both versions. Development builds are never judged.
- **Settings says when ParlorWave Radio is not answering**, instead of showing
  the last good state as if it were current.
- **The manual setup form says where the API key is**: the one you configured,
  or the `api_key` file in the service's data directory. The key itself is
  never printed in a log.
- **The panel you installed is the panel you get.** A stale pre-compressed
  `.js.gz` sibling left behind by a previous install is removed at setup;
  before this, a browser could keep running the previous release while every
  command-line check said the new panel was in place.
- **Diagnostics download a fixed, reviewed set of fields**: no addresses, no
  keys, no provider details.
- **Upgrading cleans up after the old build.** The obsolete chattiness entity
  is removed from the entity registry on upgrade; a fresh install never
  creates it.
- Reloading the integration no longer leaves a coordinator listener running.

**On Air**

- **The Broadcast Console.**
  - The DJ switch, whole-home volume, the active DJ speaker, an Air Check and
    the Mouth, in one studio control.
  - The Mouth is driven by Music Assistant's own audio waveform for the item
    that is actually playing, confirmed before it is drawn.
  - The station meter is a synthetic activity display and is never labelled
    as anything else.
  - Both stop moving under prefers-reduced-motion.
- **A calmer, more forgiving console.**
  - The knobs accept a turn and a push the way a real radio does. Turning the
    right knob always tunes the Dial; the speaker list opens on a double push.
  - One LCD status line, with notices that go away by themselves.
  - Knob help, and a smoother first load.
- **A redesigned cabinet**: one recessed grille cloth, a raised metal
  nameplate with the ParlorWave wordmark, and an engraved station plate. A DJ
  break wears the radio's own face.
- **The break on air is the break shown**, labelled as on air; with nothing
  playing the card is history and says so. The countdown and the time it
  names are one calculation.
- **Track and artwork keep up with the music**, and returning to On Air asks
  for a fresh read.
- **Transport**: previous, play/pause and next, as Music Assistant player
  commands, beside thumbs. A control the player does not support is shown
  disabled with the reason. The volume knob steps from the level last asked
  for.
- **Lyrics no longer move the page.** The active line is followed inside the
  lyric pane; scrolling by hand pauses the follow; your place survives a
  refresh.
- **History keeps its scroll** across updates, finished breaks and bulletins
  show their real length, and the queue shows each programme item's
  lifecycle truthfully.
- **The console works on a phone**: the emblem is smaller, long speaker names
  keep their ending, and every opened menu is dark. The panel declares its
  colour scheme so menus, scrollbars and spinners match the room.

**Booth**

- **Three more personalities**: Sarcastic, Humorous and Energetic.
- **Custom voices.** With a Chatterbox-compatible voice engine you run
  yourself (added under Settings > Optional services), Booth makes a DJ voice
  from a 10–30 second recording, recorded in the browser or chosen as a WAV,
  MP3 or FLAC file, once you confirm you may use that person's voice.
  Preview it, make it the DJ, replace its recording, rename or delete it.
  Booth says whether each voice's permission was recorded.
- **Record first.** Booth shows a script to read aloud, a level meter and the
  microphone in use while recording, and a **Microphone** chooser once the
  browser can name its inputs. A silent or too-short take is refused before
  anything is sent; Listen, Record again or Use this recording. A new voice
  speaks a test line you can hear again before you make it the DJ.
- **Saved recordings.** Under My voices, the recordings your custom voices
  were made from, and the ones a replace or delete took away, are kept by
  the add-on: play, rename, use again as a custom voice, archive, and delete
  once archived and unused.
- A voice engine's own default voice is shown as the voice engine's, never
  under My Voices.
- **There is no voice to pick before the DJ can speak.** Until you choose
  one, the DJ speaks with your voice engine's default when one is
  configured, otherwise with one of your Home Assistant voices. A voice you
  choose becomes the DJ only after it has spoken a test phrase; one that
  cannot is refused with the reason, and the DJ stays as it was.
- **Switch DJ.** On Air names the DJ actually speaking. A voice that is
  missing, changed or withdrawn is never spoken; the station's default voice
  speaks instead.
- **DJ shifts.** The DJ voice can follow Morning (05–12), Afternoon (12–17)
  and Night (17–05). Off until you turn on Automatic DJ shifts in Booth;
  choosing a voice by hand holds until the next shift.
- Curated voices whose optional engine is absent are no longer shelved in
  front of you; a voice you selected is always shown, even when unavailable.
  "Add voice" is present and disabled, with the reason.

**Newsroom**

- **More than one source**, each with its own hourly schedule, its own test
  and its own record, plus a list of what actually aired and a Listen Again
  that plays in the browser only and never puts news back into the house.
- The add-on's changelog lists the bulletin fixes behind it, and the DJ's:
  the station frequency said the way radio says it, a news intro that never
  names a clock time it cannot keep, and model-written breaks that no longer
  skip the weather they owe.

**Station**

- **The Station Programmer.**
  - Name a station, and Test Station is a real dry run.
  - Dial presets, and Start Station on one speaker you name, with Stop.
  - The Request Line and the console's dial start stations through the same
    builder.
  - A station identity card holds the on-air name.
  - The Dial has its own stage, with one sheet for a station's
    settings and its own Request Line.
- **Announcements**: a card that enables calendar-driven announcements and
  shows what is scheduled and what aired. An announcement can name a saved
  voice: write `voice: <name>` in the calendar event's description, and that
  voice reads it if you have allowed it for announcements.
- **Station says something true about the queue.** ParlorWave inserts finite
  DJ and news elements and plays what a listener asks for; it never rebuilds
  or reorders the music you queued.

**Settings**

- **One verdict and a Ready strip.** Settings states in one line whether the
  installation is ready; the Ready strip folds away once everything is in
  place, and an incomplete installation is shown as one neutral state, never
  guessed to be a first run.
- **The speakers ParlorWave Radio may DJ on are chosen here**, on a card,
  instead of in the integration's options (which still work). "Output" is now
  "Active DJ speaker" and offers only speakers the DJ may use.
- **Optional services live under Extras**, not in environment variables: a
  Chatterbox-compatible voice engine and an external writing model, each
  with a bounded Test Connection, each optional, and neither ever showing a
  saved credential back to a browser. Changing only the voice engine's
  address now switches Save on.
- **DJ speech can be turned off without turning off the DJ**, with the
  **Speak DJ breaks** switch. Hosting goes quiet; announcements and the Booth
  keep speaking.
- **Test Calendar and Test Weather** report what the station can actually see
  and why each event or reading would or would not reach a break.
- A quiet support drawer holds the diagnostics someone helping you would ask
  for. Every screen name in help text opens that screen; service icons ship
  in `icons.json`; whole-minute settings no longer render as `5.0`.

**Limitations of this Alpha**

- The add-on image is multi-architecture (amd64, aarch64); the aarch64 build
  was executed under QEMU emulation and has not been tested on a physical
  Raspberry Pi.
- The update from the 0.1.0-alpha.1 preview was rehearsed on Home Assistant
  OS by replacing the integration's files the way HACS does, not through
  HACS itself; the add-on's update through the add-on store has not been
  rehearsed (it needs a published version).
- No music-knowledge pack and no curated voices ship. Pandora sources are not
  qualified. Listening to the station in the browser is not in this release.
- **Custom voices need a voice engine you run yourself**; none ships.
  Saved recordings stay in the add-on's data directory until you delete
  them or uninstall the add-on. They
  were tested with Chatterbox TTS API 2.1.0, and three are held at a time.
  Recording in the browser needs Home Assistant opened over https; otherwise
  choose a recording file. A voice uploaded with the 0.1.0-alpha.1 preview
  was stored before the permission step existed; it keeps working, and Booth
  says "Permission not recorded" beside it.

## 0.1.0-alpha.1 (development preview)

First public Alpha of the ParlorWave Radio Home Assistant integration.

- Installs from HACS as a custom repository, or by hand.
- Finds the ParlorWave Radio add-on by itself: the add-on announces its
  address and key through Supervisor discovery, so setup is one confirmation
  with nothing to type. A manual host/port/key form remains for a backend
  that runs elsewhere.
- The config entry is keyed on the backend's installation id rather than its
  address, so a backend that moves, is rebuilt or regenerates its key keeps
  one entry.
- Adds the **ParlorWave Radio** sidebar panel with five screens: On Air,
  Booth, Newsroom, Station and Settings.
- Adds the DJ switch, the voice, personality, break-length and cadence
  controls, and the station, DJ status and now-playing sensors.
- Publishes grounded weather, sun and calendar facts to the backend from
  entities you choose, so the DJ can mention them. Nothing selected is a
  valid state.
- Options flow chooses the DJ-enabled Music Assistant outputs — the only
  speakers ParlorWave Radio may adopt playback on.

Alpha means the product works end to end and its shape may still change.
