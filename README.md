# ParlorWave Radio

**A radio station built on the music you already play.**

ParlorWave Radio turns a Music Assistant installation into a station: your
albums, your playlists, your queue — with a DJ talking between the tracks.
It tells you the time, mentions the weather, says what is coming next, and
reads news bulletins on the hour if you give it a feed. There is a broadcast
screen in your Home Assistant sidebar to watch it on.

ParlorWave Radio itself runs on your own hardware: no account, no
subscription, and no usage data sent to us or to anyone else. Out of the box
it talks only to your own Home Assistant and Music Assistant. What leaves
your network depends on what you choose, and goes only to the service you
chose:

- **The station's voice.** A Home Assistant voice speaks through the
  text-to-speech service you set up in Home Assistant, and that service
  decides where the words go. A local one, such as Piper, keeps them on your
  hardware. An online one sends the words of every break to its provider to
  be spoken: Home Assistant Cloud to Nabu Casa, Google Translate
  text-to-speech to Google, and any other online voice to whoever runs it.
  New Home Assistant installations include the Google Translate voice, so
  unless you choose another one, that is where the words go.
- **A voice engine** you add in Settings receives the words of each break,
  and any voice recordings you make in Booth.
- **A writing model** you add in Settings receives what a break is written
  from: the song that just played and the one coming up, the time, and the
  weather and calendar details you let the station use.
- **A Newsroom feed** is fetched from the address you gave it, and its
  bulletins from wherever the feed points.

If Music Assistant, a voice engine or a writing model runs on another
machine, these requests go to that machine, and from there wherever that
service sends them.

> ### ⚠️ This is an Alpha release
>
> `0.1.0-alpha.4` — the second public Alpha of ParlorWave Radio.
>
> It works end to end, and the whole product is here. But it has been run on
> a small number of installations, the shape of some screens will still
> change, and an update may reset a setting. Install it on a Home Assistant
> you are willing to tinker with. Bug reports are genuinely wanted:
> [open an issue](https://github.com/parlorwave/parlorwave-radio/issues).

---

## What it needs

Four things, and nothing else:

| | |
|---|---|
| **Home Assistant OS**, Home Assistant 2026.9 or newer | hosts the add-on and this integration |
| **[Music Assistant](https://music-assistant.io/)** | **required.** It owns the music: your library, the queue, the players |
| **A Home Assistant text-to-speech voice** | speaks the breaks — [Piper](https://www.home-assistant.io/integrations/piper/) keeps the words local; an online voice (Home Assistant Cloud, Google Translate and others) sends each break's words to its provider |
| **The built-in writer** | writes every break, on this machine, with no model to install |

**Music Assistant is required.** ParlorWave Radio does not play music itself;
it puts a station around the music Music Assistant is already playing.

It does **not** require any of these:

- a local music catalogue
- an external or local language model
- a custom or local voice engine
- a GPU
- a news feed
- an account, a subscription or an internet service

An installation with none of those is a *complete* installation. Each is an
optional capability that adds something, and the product says so plainly
rather than treating its absence as a fault.

---

## The five screens

ParlorWave Radio adds one panel to your Home Assistant sidebar, with five
screens. Every setting belongs to exactly one of them.

| Screen | Answers |
|---|---|
| **On Air** | *What is playing, and what is my station doing?* Live playback and broadcast state, the DJ switch, the current output, lyrics, the queue, break history. |
| **Booth** | *What should my station sound like?* Personality, voice, break length and cadence, and what the DJ is allowed to talk about. With your own voice engine, custom voices recorded in the browser and the saved recordings they were made from. |
| **Newsroom** | *What does it say about the world?* Scheduled audio bulletins from a podcast feed you supply. |
| **Station** | *Where does my music come from?* Music programming: Dial Stations, the Request Line and a single song played next, all from your Music Assistant library. |
| **Settings** | *Is it ready, and what is connected?* Setup and readiness in one line, and a route to wherever each thing is fixed. |

---

## Install

ParlorWave Radio is two pieces, and they install in this order:

1. the **add-on** — the backend service, from its own add-on repository;
2. the **integration** — this repository, the entities and the sidebar panel.

### 1. Add the add-on repository

Home Assistant → **Settings → Apps → App store → ⋮ → Repositories**,
and add:

```
https://github.com/parlorwave/parlorwave-radio-addon
```

Home Assistant 2026.10 renamed add-ons to *apps* and the Add-on Store to the
*App store*. On an older Home Assistant the same path is **Settings → Add-ons →
Add-on Store → ⋮ → Repositories**, and wherever this README says **Settings →
Apps**, read **Settings → Add-ons**.

### 2. Install and start the ParlorWave Radio add-on

It appears in the store under **ParlorWave Radio**. Install it — a prebuilt
image is downloaded, so nothing is compiled on your machine — then
**Start** it.

### 3. Give it a Music Assistant token

In **Music Assistant → Profile → Access tokens**, create a token. It is a
Music Assistant token, not a Home Assistant one. Paste it into the add-on's
**Configuration** tab and restart the add-on.

The Music Assistant URL there already points at the Music Assistant add-on on
the same machine; change it only if yours is somewhere else.

### 4. Install this integration

**With HACS** (recommended):

HACS → **⋮ → Custom repositories** → add
`https://github.com/parlorwave/parlorwave-radio` with type **Integration**.
Then find **ParlorWave Radio** in HACS, download it, and restart Home
Assistant.

**Without HACS:** download the [latest
release](https://github.com/parlorwave/parlorwave-radio/releases), copy the
`custom_components/parlorwave_radio` folder into your Home Assistant
`config/custom_components/` directory, and restart Home Assistant.

### 5. Confirm the discovered integration

**Settings → Devices & services** now shows **ParlorWave Radio** as
*Discovered*. Press **Configure** and confirm.

There is no host, port or key to type: the add-on announced its address and
key through the Supervisor.

It does not matter that the add-on announced itself before this integration
existed. Home Assistant asks the Supervisor for every outstanding
announcement each time it starts, and you have just restarted it.

If you installed the integration first and the add-on afterwards, the card
appears as soon as the add-on has started — no restart needed. If pressing
**Submit** says the service could not be reached, the add-on is still
starting: wait until its log says it is answering, and press **Submit**
again. The card stays until you do.

### 6. Choose the DJ-enabled outputs

In the ParlorWave Radio panel, open **Settings → Speakers ParlorWave may DJ on**,
and check the Music Assistant speakers ParlorWave Radio is allowed to adopt
playback on and DJ over. Nothing else is ever controlled.

*(Alternatively, press **Configure** on the ParlorWave Radio card in Home
Assistant **Settings → Devices & services**).*

### 7. Make sure you have a Home Assistant voice

The DJ speaks through Home Assistant's own text-to-speech. If **Settings →
Devices & services → Entities** has no `tts.*` entity, add one — the
[Piper](https://www.home-assistant.io/integrations/piper/) add-on is the
usual local choice, and Home Assistant Cloud works too.

> If no voice integration is installed, Booth displays *No voice yet* and
> Settings flags a setup step for speech. Once a `tts.*` entity is present,
> ParlorWave discovers it automatically.

### 8. Choose a voice in Booth (optional)

The DJ already speaks with one of the voices your Home Assistant offers. To
use another, open **ParlorWave Radio** in the sidebar → **Booth** and choose
it; it becomes the DJ once it has spoken a test phrase.

**Custom voices (optional).** With a Chatterbox-compatible voice engine that
you run yourself (none ships), add it under **Settings → Optional services**.
Booth can then make a DJ voice from a 10–30 second recording of a voice you
have permission to use: read the script on screen into your microphone, or
choose a WAV, MP3 or FLAC file. Recording in the browser needs Home Assistant
opened over https. The recordings are kept under **Saved recordings** in
Booth, in the add-on's data directory.

### 9. Switch the DJ on

**On Air** → the **DJ** switch.

### 10. Start music in Music Assistant

Play an album, a playlist or a station on one of the DJ-enabled outputs.
ParlorWave Radio adopts that playback and starts putting a station around it.

> At any point, open **Settings** in the panel. It states in one line whether
> the installation is ready and lists exactly what is still missing, with a
> route to where each thing is done.

---

## Updating

**With HACS:** HACS tells you when a new version is available; download it and
restart Home Assistant.

**Without HACS:** replace `config/custom_components/parlorwave_radio/` with
the folder from the new release and restart Home Assistant.

**Update the add-on too.** The integration and the add-on are released
together and share a version number. Home Assistant offers the add-on update
under **Settings → Apps → ParlorWave Radio**. Keep them on the same
version: if they differ, **Settings → Repairs** says which versions are
installed and which one to update. That comparison is made when Home Assistant starts ParlorWave Radio — at a
restart, or when you reload it under **Settings → Devices & services →
ParlorWave Radio → ⋮ → Reload**. After updating only the add-on, the notice
appears or clears at the next restart or reload, not at once.

Updating keeps the same device, the same entities and the same settings —
nothing has to be set up again.

Your settings live in the add-on's own data directory, not in the
integration, so updating the integration never loses them.

### Updating from 0.1.0-alpha.3

Nothing has to be set up again. Update both pieces to the same version:

- **Add-on:** **Settings → Apps → ParlorWave Radio → Update** ("back up
  before update" on). If the store has not noticed the update yet, use
  **Check for updates** in its menu.
- **Integration:** in HACS, open **ParlorWave Radio**, download the update,
  and restart Home Assistant. Then reload the ParlorWave Radio page in your
  browser so it runs the new panel.

Until both are on the same version, **Settings → Repairs** says which one to
update. It compares them when Home Assistant starts ParlorWave Radio, so a
notice left over after you update the add-on clears at the next restart, or
at once with **Reload** under **Settings → Devices & services → ParlorWave
Radio → ⋮**.

### Updating from the 0.1.0-alpha.1 preview

0.1.0-alpha.1 was a development preview. These repositories were started
again with a fresh history at the same addresses, so an installation of the
preview updates in place:

- **Home Assistant 2026.9 or newer is required.** On an older Home
  Assistant, HACS does not offer this release; update Home Assistant first.
- **Add-on:** under **Settings → Apps → ParlorWave Radio**, update it to
  this release ("back up before update" on). It keeps its data and identity,
  so the integration keeps working.
  - If the App store has not noticed the update yet, use **Check for
    updates** in its menu.
  - If **Settings → Repairs** reports a problem with the ParlorWave Radio add-on
    repository, accept the suggested fix: it downloads the repository again.
- **Integration:** in HACS, open **ParlorWave Radio**, use **Update
  information** in its menu, download this release and restart Home
  Assistant. The device and entities stay as they are.

---

## Known limitations

The full list is at the end of this release's entry in the
[CHANGELOG](CHANGELOG.md). Two of them are Music Assistant settings worth
knowing about before you start:

- **Flow mode and the "smart" sample rate (Music Assistant 2.10.6).** In Flow
  mode, Music Assistant fixes the stream's sample rate from the first item it
  plays, and when a later item needs a higher rate it ends the stream and
  opens a new one. That can be heard as a gap or a restart, between songs or
  around a DJ break. A possible workaround, per speaker: in that player's
  settings in Music Assistant, change the Flow mode sample rate from *Smart*
  to a fixed rate such as *48000*, so Music Assistant resamples instead of
  restarting. Which rates a speaker accepts depends on the player.
  ParlorWave Radio leaves this setting alone.
- **Autoplay.** Music Assistant's Autoplay chooses what to add from the last
  items played, and ParlorWave's breaks and bulletins are among them, so it
  can refill a queue with old breaks instead of music. Settings warns when it
  happens. Set that player's Autoplay mode to your library or a playlist, or
  switch Autoplay off.

---

## If something is not working

| What you see | What it means and what to do |
|---|---|
| No *Discovered* card after installing both | Make sure the add-on is **started**. Then restart Home Assistant once: it asks the Supervisor for every outstanding announcement when it starts. |
| The card says the service could not be reached | The add-on is still starting. Wait a moment and press **Submit** again. |
| Settings → Devices & services asks to **re-authenticate** ParlorWave Radio | The service no longer accepts the stored key. **If you reinstalled the add-on**, it is a new installation with a new key: delete the old ParlorWave Radio entry and confirm the newly discovered one. Otherwise, restart the add-on: it sends its key again and the integration reconnects by itself. |
| *A different ParlorWave Radio installation now answers* | Another ParlorWave Radio installation is answering at the old entry's address, for example a service you run yourself that was rebuilt with the same API key. Delete the old entry and add or confirm the new one. |
| The panel says *ParlorWave Radio is not answering* | The add-on is stopped or restarting. Everything reconnects by itself within seconds of it answering again. |

---

## Removing it

1. **Settings → Devices & services → ParlorWave Radio → ⋮ → Delete.** This
   removes the entities, the device and the sidebar panel.
2. Remove the integration files — in HACS, or by deleting
   `config/custom_components/parlorwave_radio/` — and restart Home Assistant.
3. **Settings → Apps → ParlorWave Radio → Uninstall.** This deletes the
   add-on's data directory, which is where your stations, settings,
   recorded breaks and saved voice recordings live.
4. Optionally remove the add-on repository under **App store → ⋮ →
   Repositories** (**Add-on Store** before Home Assistant 2026.10).

Nothing is left behind in Music Assistant: ParlorWave Radio never rebuilds
or takes ownership of a queue somebody built, and it owns no media. While
it is running it adds finite DJ breaks and bulletins between tracks, and
plays the songs a listener asks for; removing it removes those and leaves
the music exactly as Music Assistant had it.

---

## Support

- **Issues and bug reports:**
  <https://github.com/parlorwave/parlorwave-radio/issues>
- **The add-on** (the backend service):
  <https://github.com/parlorwave/parlorwave-radio-addon>

When reporting a problem, the **Settings** screen in the panel and the
add-on's log between them usually say what is wrong; both are worth quoting.

This integration is **not** in the HACS default store. Install it as a custom
repository, as described above.

---

## Licence

This integration is Apache License 2.0 — see [LICENSE](LICENSE) and
[NOTICE](NOTICE). It has no third-party dependencies of its own.

The add-on's published image is a different artefact and contains software
under other licences, several of them copyleft. Every component, its exact
version, and exact URLs for its corresponding source are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
