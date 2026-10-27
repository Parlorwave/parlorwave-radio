/* Parlorwave Radio panel — On Air + Booth + Newsroom + Station + Settings.
 *
 * Plain web component, no build step, no external deps. Entity states for
 * standing data, parlorwave_radio.* services for actions, and a few
 * parlorwave_radio/* websocket commands for DEMAND data — lyrics, the queue view,
 * program history, the voice shelves, voice preview — fetched when a drawer
 * opens, never polled into entities. The panel holds no secrets and talks
 * to no backend directly. On Air answers "what is my radio doing right
 * now?"; Booth answers "what should my station sound like?"; Newsroom
 * answers "is my station carrying news, and from where?"; Station answers
 * "where does my music come from?"; Settings is configuration and
 * engineering state. Queue and history are READ ONLY surfaces by design:
 * nothing in this file can reorder, skip or delete anything.
 *
 * The room lighting follows the record. On Air derives a small theme from
 * the current album artwork (see the palette section below) and the
 * interface picks it up through --pw-art-* custom properties. It is
 * decoration with a floor: extraction never blocks a render, never repeats
 * for artwork already seen, and any failure leaves the Parlorwave house
 * palette in place.
 */

const VIEWS = ["onair", "booth", "newsroom", "station", "settings"];
const VIEW_LABELS = { onair: "On Air", booth: "Booth", newsroom: "Newsroom",
                      station: "Station", settings: "Settings" };
// The only two schedules the station offers. Both are broadcast
// conventions; the backend refuses anything else, and there is deliberately
// no free-text cron here.
/* The minutes a bulletin may be scheduled for. Every five minutes, which
 * covers the broadcast conventions people actually use without becoming a
 * cron expression -- there is deliberately no "every N minutes", no
 * per-day rule and no syntax to get wrong. */
const NEWS_SCHEDULES = Array.from({ length: 12 }, (_, i) => ({
  minute: i * 5,
  label: `Every hour at :${String(i * 5).padStart(2, "0")}`,
}));
// How long a Newsroom answer is worth showing before it is re-read.
/* The shortest gap between two "I just arrived at On Air" reads, so
 * flicking between screens cannot become a poll loop. */
const REHYDRATE_MIN_MS = 3000;
const NEWS_MAX_AGE_MS = 20000;
const SETTINGS_MAX_AGE_MS = 30000;
// A readiness document older than this is not shown as the current state
// of the installation. The screen re-reads every SETTINGS_MAX_AGE_MS; ten
// misses in a row means Home Assistant or the service has stopped
// answering, and "Ready." over a dead connection is the one thing this
// screen must never say.
const READY_STALE_MS = 5 * 60 * 1000;
// A readiness read that has not answered in this long is given up on, so
// a hung call cannot pin the screen to its last document for ever.
const READY_READ_TIMEOUT_MS = 60 * 1000;
// The Queue drawer re-reads itself every 30 s while open. The rows it already
// shows stay on screen during that read -- a one-line "Reading the queue" in
// their place would collapse the drawer and throw the console up the page and
// back. Rows older than this are not shown as current.
const QUEUE_SHOW_WHILE_READING_MS = 120000;
/* The Dial's confirming push must come at least this long after the push
 * that asked, so the second half of a double-click can never start a
 * station; and a start's answer stays on the display this long. */
const DIAL_CONFIRM_MIN_MS = 400;
const DIAL_RESULT_MS = 5000;
/* Two knob clicks this close are ONE double-click (OUTPUT); closer than the
 * bounce floor they are one press, counted once. A click that would CONFIRM
 * a station start is held for the double-click window, so a click that
 * turns out to be the first half of a double-click never starts anything. */
const KNOB_DOUBLE_CLICK_MS = 350;
const KNOB_BOUNCE_MS = 30;
/* --- the console's gestures and timers, named ----------------------------
 * Every value here is the one the console already used; naming them
 * changes no behaviour. They are grouped by the control that uses them.
 * Values that happen to be equal stay separate unless the code already
 * says they are one rule. (The right knob's two selectors used to share
 * their idle timing; now the speaker selector has its own
 * 5 s timeout and the Dial keeps its prompt and 11 s.)
 *
 * The left knob is whole-home volume. Its face shows a level as an angle
 * on a 270-degree sweep: 0% is -135 degrees, 50% is 0, 100% is +135. */
const KNOB_ANGLE_MIN_DEG = -135;
const KNOB_ANGLE_SWEEP_DEG = 270;
/* What the left knob assumes while the player has reported no level. */
const KNOB_FALLBACK_LEVEL = 0.5;
/* A press must travel further than this before it is a drag, not a push. */
const KNOB_DRAG_DEAD_ZONE_PX = 4;
/* Volume per pixel of pointer travel, right and up being louder: dragging
 * the left knob, and turning it in sticky mode after a push. */
const KNOB_DRAG_VOLUME_PER_PX = 0.005;
const KNOB_STICKY_VOLUME_PER_PX = 0.004;
/* Volume per wheel notch over the left knob. */
const KNOB_WHEEL_VOLUME_STEP = 0.02;
/* While the left knob turns, volume writes go out at most this often and
 * carry the latest level. (A drag's release and the slider's release each
 * write at once.) */
const VOLUME_WRITE_THROTTLE_MS = 120;
/* After a wheel notch or a sticky-turn move, the left knob shows the level
 * that was set -- for at least VOLUME_HOLD_MS after the last step,
 * whatever Home Assistant reports meanwhile, because its reports of the
 * knob's own earlier writes arrive late and out of order. After that the
 * player's report wins as soon as it agrees, or says something the knob
 * never asked for. A report that is still one of the knob's own older
 * levels is waited out, but never beyond VOLUME_HOLD_MAX_MS. A report
 * within VOLUME_ECHO_TOLERANCE of a level counts as that level: a player
 * may keep only whole percents, rounding either way. */
const VOLUME_HOLD_MS = 1500;
const VOLUME_HOLD_MAX_MS = 6000;
const VOLUME_ECHO_TOLERANCE = 0.011;
/* The right knob turns freely: degrees per pixel of drag or sticky travel,
 * degrees per wheel notch, and the rotation a drag or a sticky turn needs
 * for one step through the speakers or the Dial stations. */
const KNOB_TURN_DEG_PER_PX = 1.5;
const KNOB_WHEEL_ANGLE_DEG = 15;
const KNOB_DETENT_DEG = 25;
/* How long a knob's LED-ring position marker stays lit after it moves. */
const KNOB_PULSE_MS = 850;
/* The Dial (saved stations): idle this long, the display prompts; idle
 * this long, it gives up and the Mouth returns. Both restart on every step. */
const SELECTOR_PROMPT_MS = 3000;
const SELECTOR_TIMEOUT_MS = 11000;
/* The OUTPUT (speaker) selector, as designed. Idle OUTPUT_TIMEOUT_MS after the last deliberate interaction
 * it closes and changes nothing. The pushes that opened the list, and any
 * push following the last of them closer than OUTPUT_OPEN_RUN_MS, are ONE
 * run of clicking and never a confirmation; the first push after a pause at
 * least that long is a separate gesture and confirms. The knob picture: the arc its
 * speakers are spread over on entry and the rotation per step. How long
 * the answer stays on the display: SWITCHED (or no change), and a refusal,
 * which needs long enough to be read. */
const OUTPUT_TIMEOUT_MS = 5000;
const OUTPUT_OPEN_RUN_MS = KNOB_DOUBLE_CLICK_MS;
const OUTPUT_SPREAD_DEG = 120;
const OUTPUT_STEP_DEG = 30;
const OUTPUT_CONFIRMED_MS = 1500;
const OUTPUT_REFUSED_MS = 3000;
/* The LCD's one transient line under the header: the volume
 * readout after the left knob moves, and the once-a-session hint the first
 * time a knob is pressed or focused. */
const VOLUME_READOUT_MS = 1200;
const KNOB_HINT_MS = 3000;
//: how long the DJ switch stays pending after a write, waiting for the entity's echo
const DJ_HOLD_MS = 15000;
/* The left knob from the keyboard while it has focus: arrows step like a
 * wheel notch, Page Up / Page Down step ten times as far. */
const KNOB_KEY_VOLUME_PAGE = 0.10;
/* A drag is CIRCULAR -- the knob follows the pointer round its centre --
 * when the press starts at least this far out from the centre, as a share
 * of the knob face's radius, and its first movement runs more round the
 * knob than towards or away from it. Every other drag is the linear one
 * (right and up are more). */
const KNOB_CIRCULAR_MIN_RADIUS = 0.45;
/* Double-clicks on the console's surfaces, each with its own window: the
 * grille (faceplate fabric), the centre badge (logo mode) and the Mouth
 * (display mode). Two clicks closer than the bounce floor are one click.
 * The knobs use KNOB_DOUBLE_CLICK_MS and KNOB_BOUNCE_MS above. */
const FACEPLATE_DOUBLE_CLICK_MS = 500;
const BADGE_DOUBLE_CLICK_MS = 500;
const MOUTH_DOUBLE_CLICK_MS = 450;
const SURFACE_BOUNCE_MS = 40;

/* The wordmark inside its cell: drawn at
 * PW_EMBLEM_SCALE of the approved size and lowered by PW_EMBLEM_DROP of the
 * cell's height (9 px at the desktop's 150 px cell), so it scales with every
 * breakpoint -- except a phone's, where the badge sits in the strip above
 * the knobs and lowering it would put the script among their tick marks:
 * there it is only made smaller. The cell, its placement and the station plate are unchanged;
 * the CSS for .console-badge-emblem says the same two numbers (pinned). */
const PW_EMBLEM_SCALE = 0.79;
const PW_EMBLEM_DROP = 0.06;

/* --- the badge's artwork ------------------------------------------------
 * The ParlorWave wordmark is the approved production vector: one outline of ten contours with its aged-brass finish as
 * an SVG filter, carried here verbatim and mounted as a data: image, so its
 * ids (pw-emblem-*) live in their own document and cannot collide with
 * anything in this shadow root or in a second panel. The lettering was
 * outlined and joined from Mr Dafoe (SIL Open Font License 1.1, Alejandro
 * Paul / Sudtipos); no font is embedded for it, and its attribution is in
 * THIRD_PARTY_NOTICES.md. The cell is 520 x 150 units with the
 * ink at x 65-444, y 30-117; everything below positions by that cell. The
 * final e has no separate up-flick: its stroke turns straight
 * into the underline. */
const PW_EMBLEM_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 150" width="520" height="150" role="img" aria-label="ParlorWave">
 <title>ParlorWave</title>
 <!-- ParlorWave emblem, production outline. Built by build_emblem.py from the final design.
      Lettering outlined and unioned from Mr Dafoe (SIL OFL 1.1, Sudtipos / Alejandro Paul)
      with enlarged capitals, opened spacing, a drawn swash and 2.2 px thickening; finish = SVG filter. -->
<defs>
  <linearGradient id="pw-emblem-brass" gradientUnits="userSpaceOnUse" x1="0" y1="36" x2="0" y2="124">
   <stop offset="0" stop-color="#dcc493"/><stop offset=".3" stop-color="#c3a064"/><stop offset=".52" stop-color="#8e6831"/>
   <stop offset=".62" stop-color="#a98446"/><stop offset=".84" stop-color="#cdb07a"/><stop offset="1" stop-color="#9a7a42"/>
  </linearGradient>
  <filter id="pw-emblem-finish" x="-10%" y="-35%" width="120%" height="170%" color-interpolation-filters="sRGB">
   <feMorphology in="SourceAlpha" operator="dilate" radius="0.8" result="body"/>
   <feGaussianBlur in="body" stdDeviation="1.6" result="hm"/>
   <feSpecularLighting in="hm" surfaceScale="6.5" specularConstant="0.5" specularExponent="14" lighting-color="#efdcb8" result="sp1"><feDistantLight azimuth="225" elevation="46"/></feSpecularLighting>
   <feComposite in="sp1" in2="body" operator="in" result="sp1c"/>
   <feSpecularLighting in="hm" surfaceScale="6.5" specularConstant="0.22" specularExponent="9" lighting-color="#e8c288" result="sp2"><feDistantLight azimuth="50" elevation="28"/></feSpecularLighting>
   <feComposite in="sp2" in2="body" operator="in" result="sp2c"/>
   <feDiffuseLighting in="hm" surfaceScale="6.5" diffuseConstant="1.06" lighting-color="#ffffff" result="df"><feDistantLight azimuth="225" elevation="56"/></feDiffuseLighting>
   <feTurbulence type="fractalNoise" baseFrequency="0.55" numOctaves="2" seed="7" result="nz1"/>
   <feColorMatrix in="nz1" type="matrix" values="0.16 0 0 0 0.9  0.16 0 0 0 0.9  0.16 0 0 0 0.9  0 0 0 0 1" result="grain"/>
   <feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="1" seed="2" result="nz2"/>
   <feColorMatrix in="nz2" type="matrix" values="0.2 0 0 0 0.88 0.2 0 0 0 0.88 0.2 0 0 0 0.88 0 0 0 0 1" result="mottle"/>
   <feComposite in="SourceGraphic" in2="body" operator="in" result="base"/>
   <feComposite in="base" in2="grain" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="b1"/>
   <feComposite in="b1" in2="mottle" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="b2"/>
   <feComposite in="b2" in2="df" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="shaded"/>
   <feComposite in="shaded" in2="sp1c" operator="arithmetic" k1="0" k2="1" k3="0.55" k4="0" result="l1"/>
   <feComposite in="l1" in2="sp2c" operator="arithmetic" k1="0" k2="1" k3="0.45" k4="0" result="l2"/>
   <feComposite in="l2" in2="body" operator="in" result="emblem"/>
   <feGaussianBlur in="body" stdDeviation="0.8" result="aob"/><feOffset in="aob" dx="0.3" dy="1.2" result="aoo"/>
   <feFlood flood-color="#1a0e04" flood-opacity="0.9" result="aoc"/><feComposite in="aoc" in2="aoo" operator="in" result="ao"/>
   <feGaussianBlur in="body" stdDeviation="2.2" result="shb"/><feOffset in="shb" dx="1.6" dy="3.2" result="sho"/>
   <feFlood flood-color="#000000" flood-opacity="0.55" result="shc"/><feComposite in="shc" in2="sho" operator="in" result="sh"/>
   <feMerge><feMergeNode in="sh"/><feMergeNode in="ao"/><feMergeNode in="emblem"/></feMerge>
  </filter>
 </defs>
 <g filter="url(#pw-emblem-finish)">
  <path id="pw-emblem-outline" fill="url(#pw-emblem-brass)" fill-rule="nonzero" d="M135.78 91.67 136.05 89.57Q135.66 89.97 135.23 90.41Q133.64 92.04 129.88 94.72Q125.9 97.54 123.27 97.54Q123.16 97.54 123.06 97.52Q122.61 97.43 121.97 97.22Q121.12 96.94 120 95.64Q118.83 94.27 118.83 91.88Q118.83 89.55 122.05 85.19Q125.11 81.04 129.36 77.06Q133.64 73.05 138.88 70.1Q144.26 67.07 148.35 67.07Q148.38 67.07 148.41 67.07Q149.98 67.16 151 68.6Q151.5 68.36 152 68.36Q152.98 68.36 154.02 69.39Q154.58 69.59 155.1 70.06Q155.91 70.8 155.91 72.05Q155.91 73.28 154.54 74.49Q152.96 76.45 150.86 78.92Q148.74 81.42 147.83 82.52Q146.94 83.59 145.98 84.93Q145.69 85.33 145.45 85.7Q152.12 81.99 163.6 73.66Q162.68 72.7 162.26 71.72Q161.94 70.98 161.94 70.53Q161.94 68.33 163.54 67.53Q164.76 66.92 167.22 66.92Q168.32 66.92 172.66 69.09Q176.53 71.02 177.37 71.02Q178.3 71.02 180.11 70.43Q182.25 69.73 183.6 69.73Q185.24 69.73 186.09 70.59Q186.14 70.64 186.19 70.7Q188.31 73.5 188.31 74.4Q188.31 75.51 187.34 76.18L184.23 78.35Q181.63 80.16 179.14 82.04Q176.7 83.89 174.56 86.18Q173.49 87.32 173.02 88.15Q177.96 86.61 196.46 73.67Q199.51 69.29 203.48 64.92Q207.78 60.2 214.38 55.5Q220.98 50.78 228.48 47.84Q228.51 47.83 228.54 47.82Q229.85 47.39 230.94 47.39Q232.32 47.39 233.4 48.53Q234.3 49.46 234.68 50.48L235.04 51.19Q235.15 51.42 235.15 51.68Q235.15 53.85 229.47 60.1Q223.86 66.32 216.52 71.97Q209.22 77.59 202.95 81.56Q198.37 84.57 198.37 87.63Q198.37 88.88 198.56 88.88Q200.76 88.88 207.91 84.56Q213.85 80.96 218.94 77.37Q224.75 70.72 233.31 67.52Q233.5 67.45 233.7 67.45Q234.88 67.45 235.57 68.08L235.66 68.18L235.69 68.07Q236.45 67.54 237.6 67.49Q238.92 67.43 240.15 68.74Q241.71 70.04 241.71 71.97Q241.71 75.78 238.6 81.18Q240.16 80.57 242.38 79.3Q246.85 76.75 250.21 74.21L250.61 73.89Q249.52 72.82 249.05 71.72Q248.73 70.98 248.73 70.53Q248.73 68.33 250.33 67.53Q251.55 66.92 254.01 66.92Q255.11 66.92 259.44 69.09Q263.32 71.02 264.16 71.02Q265.08 71.02 266.89 70.43Q269.04 69.73 270.39 69.73Q272.02 69.73 272.88 70.59Q272.93 70.64 272.98 70.7Q275.1 73.5 275.1 74.4Q275.1 75.51 274.13 76.18L271.02 78.35Q268.41 80.16 265.92 82.04Q263.49 83.89 261.35 86.18Q260.28 87.32 259.81 88.14Q264.17 86.78 279.2 76.48Q281.87 71.8 285.42 67.06Q289.42 61.71 297.11 54.02Q304.77 46.36 314.27 39.25Q307.48 40.38 293.97 48.11Q278.3 57.1 274.78 62.64Q274.24 64.08 272.96 64.08Q271.3 64.08 271.3 61.6Q271.3 59.89 273.88 56.07Q276.35 52.41 281.01 48.23Q285.62 44.08 291.3 40.35Q297.04 36.59 304.58 34.11Q312.16 31.62 319.6 31.62Q319.8 31.62 319.99 31.69Q320.72 31.96 321.86 32.37Q323.15 32.84 325.16 34.26Q327.51 35.92 327.51 37.59Q327.51 39.09 326.79 39.95Q326.74 40.01 326.69 40.06Q319.63 46.48 310.87 55.56Q302.13 64.62 297.47 70.65L293.06 76.41Q324.4 54.28 335.36 44.83Q335.96 44.13 336.9 44.13Q337.94 44.13 338.46 44.89Q338.56 45.06 340.03 46.39Q341.95 48.15 341.95 49.32Q341.95 50.51 341.03 51.29Q332.01 59.86 322.61 72.83Q313.55 85.32 313.34 92.03Q315.08 91.67 321.07 87.3Q327.84 82.36 336.49 74.76Q345.13 67.17 354.79 56.14Q364.41 45.16 370.51 34.78Q371.31 33.09 371.75 31.99Q372.49 30.14 374.2 30.14Q375.92 30.14 377.25 33.56Q378.38 36.47 378.38 38.7Q378.38 42.29 370.8 52.24Q363.4 61.95 353.52 72.3Q343.6 82.67 332.48 90.78Q321.15 99.04 314.45 99.04Q311.03 99.04 307.73 96.41Q304.33 93.69 304.33 87.82Q304.33 80.91 308.43 73.67Q308.66 73.26 308.91 72.86Q293.69 86.17 287.64 91.11Q280.06 97.3 278.38 97.3Q276.52 97.3 275.38 95.55Q275.03 95.12 274.63 94.64Q274.22 94.13 274.03 93.89L273.66 93.43Q273.52 93.25 273.47 93.2Q273.23 92.97 273.17 92.64Q273.05 92.07 273.05 91.04Q273.05 89.93 273.76 88L273.85 87.76Q271.04 89.97 267.99 92.14Q260.14 97.7 256.37 97.7Q249.95 97.7 249.95 91.28Q249.95 88.03 252.09 85.05Q253.77 82.71 258.4 79.13Q257.9 79 257.35 78.84Q255.75 78.37 254.82 77.72Q252.76 79.51 248.72 82.92Q248.69 82.94 248.66 82.97Q247.23 84.02 245.04 84.02L245 84.02Q239.22 87.82 235.29 87.82Q234.93 87.82 234.36 87.74Q225.69 97.62 219.18 97.62Q219.1 97.62 219.02 97.61Q214.35 96.92 213.03 94.12Q212.3 92.75 212.3 90.74Q212.3 90.13 212.38 89.49Q204.34 95.8 200.25 97.04Q200.24 97.04 200.22 97.05Q198.71 97.47 197.12 97.47Q195.52 97.47 194.55 97.2Q193.5 96.92 192.34 96.02Q192.32 96.01 192.3 95.99Q189.94 93.99 189.94 87.7Q189.94 86.65 190.43 85.03Q186.14 88.63 181.2 92.14Q173.35 97.7 169.58 97.7Q163.16 97.7 163.16 91.28Q163.16 88.03 165.3 85.05Q166.99 82.71 171.61 79.13Q171.11 79 170.56 78.84Q168.96 78.37 168.03 77.72Q165.98 79.51 161.93 82.92Q161.9 82.94 161.87 82.97Q160.5 83.97 158.44 84.01Q156.07 86.01 153.03 88.45Q149.93 90.94 147.47 92.7Q141.33 97.09 139.54 97.09Q137.5 97.09 136.57 95.69Q135.78 94.5 135.78 91.81Q135.78 91.74 135.78 91.67ZM131.64 35.16Q135.82 37.5 138.5 41.49Q141.22 45.54 141.22 50.56Q141.22 55.7 135.02 62.09Q129 68.3 120.42 72.66Q111.77 77.06 105.29 77.06Q99.34 77.06 96.24 72.75Q81.86 92.12 79.61 96.73Q79.67 97.21 79.67 97.9Q79.67 99.87 77.56 99.87Q76.07 99.87 74.13 97.83Q72.22 95.81 72.22 92.24Q72.22 91.24 72.33 90.6Q73.22 84.19 89.48 66.11Q105.66 48.12 112.91 44.17Q112.93 44.16 112.94 44.15Q114.65 43.3 115.64 43.3Q116.68 43.3 117.72 43.91Q119.04 44.69 119.04 45.96Q119.04 47.06 118.35 47.75Q111.49 54.9 110.12 56.44L99.74 68.49Q103.12 68.3 108.62 66.45Q114.85 64.36 120.94 61.22Q126.96 58.12 131.35 53.95Q135.52 50 135.52 46.79Q135.52 44.61 130.55 43.35Q124.89 41.91 118.36 41.91Q111.82 41.91 104.22 43.77Q96.6 45.63 90.96 48.34Q85.27 51.06 80.73 54.02Q76.22 56.95 73.95 59.13Q72.89 60.14 72.39 60.69Q73.2 60.47 74.64 60.01Q83.73 57.01 92.46 51.91Q93.36 51.4 93.89 51.4Q95.22 51.4 95.22 52.73Q95.22 53.33 93.84 55.14Q92.66 56.7 90.6 58.91Q88.53 61.11 86.09 63.18Q83.59 65.3 80.47 66.78Q77.25 68.32 74.2 68.32Q70.99 68.32 67.98 65.81Q64.86 63.22 64.86 58.8Q64.86 54.49 68.99 49.58Q72.95 44.86 79.39 40.63Q85.82 36.4 95.36 33.5Q104.9 30.6 113.99 30.6Q123.19 30.6 131.62 35.15ZM415.66 97.47Q408.7 97.47 408.7 89.22Q408.7 84.36 412.85 79.01Q416.89 73.8 422.38 70.46Q427.96 67.07 432.38 67.07Q434.63 67.07 436.51 68.81Q438.42 70.58 438.42 72.43Q438.42 75.43 434.47 78.91Q430.79 82.17 426.75 84.17Q422.6 86.22 421.09 86.22Q419.38 86.22 418.47 84.85Q418.44 84.85 418.39 84.85L418.52 84.98Q418.14 85.41 417.59 86.33Q416.53 88.09 416.53 89.03Q416.53 89.37 416.61 89.49Q419.48 89.45 422.63 88.53L422.91 86.82Q423.06 85.93 423.96 85.9Q430.09 85.67 434.68 87.06L435.14 87.1Q435.34 87.12 435.51 87.2L435.6 87.24Q435.8 87.34 435.94 87.49Q441.34 89.48 443.07 93.42Q444.91 97.63 441.78 101.94Q434.73 111.7 411.94 112.6L223.52 116.6Q223.07 116.61 222.74 116.29Q222.41 115.98 222.4 115.52Q222.39 115.08 222.69 114.75Q223 114.43 223.44 114.4L411.84 104.4Q431.11 103.75 434.68 99.23Q435.13 98.66 435.02 98.19Q434.88 97.59 434 96.95Q431.7 95.27 426.29 94.47Q419.99 97.47 415.66 97.47ZM365.04 91.67 365.3 89.57Q364.92 89.97 364.49 90.41Q362.9 92.04 359.13 94.72Q355.16 97.54 352.53 97.54Q352.42 97.54 352.31 97.52Q351.87 97.43 351.23 97.22Q350.37 96.94 349.26 95.64Q348.08 94.27 348.08 91.88Q348.08 89.55 351.3 85.19Q354.36 81.04 358.62 77.06Q362.89 73.05 368.14 70.1Q373.52 67.07 377.61 67.07Q377.64 67.07 377.67 67.07Q379.24 67.16 380.25 68.6Q380.76 68.36 381.26 68.36Q382.24 68.36 383.28 69.39Q383.84 69.59 384.36 70.06Q385.17 70.8 385.17 72.05Q385.17 73.28 383.8 74.49Q382.21 76.45 380.12 78.92Q377.99 81.42 377.09 82.52Q376.2 83.59 375.23 84.93Q374.95 85.33 374.71 85.7Q381.94 81.68 394.84 72.21L396.05 71Q397.88 68.82 399.22 68.82Q400.24 68.82 401.63 69.3Q403.58 69.97 403.58 71.55Q403.58 72.81 402.5 73.89Q394.73 81.96 391.23 88.43Q390.99 88.94 390.85 89.31Q392.3 88.49 395.49 85.73Q400.24 81.62 404.85 75.74Q409.29 70.06 409.67 66.37Q409.69 64.03 411.15 64.03Q412.04 64.03 412.64 65.2Q414.45 68.18 414.45 70.6Q414.45 75.02 409.11 81.56Q403.93 87.91 397.39 92.59Q390.68 97.39 386.49 97.39Q381.55 97.39 381.55 92.49Q381.55 90.65 382.79 88.04Q382.54 88.24 382.29 88.45Q379.19 90.94 376.73 92.7Q370.59 97.09 368.79 97.09Q366.76 97.09 365.82 95.69Q365.03 94.5 365.03 91.81Q365.03 91.74 365.04 91.67ZM223.16 84.93Q220.89 88.76 220.51 90.45Q222.33 90.01 224.98 87.64Q227.57 85.33 228.17 84.34Q227.36 83.42 226.52 81.78Q226.32 81.38 226.15 81.06Q224.51 82.8 223.16 84.93ZM361.06 85.76Q362.01 85.04 363.28 84.03Q367.93 80.33 372.09 76.62L373.51 75.37Q372.04 76.12 370.27 77.39Q365.72 80.63 362.42 84.23Q361.65 85.07 361.06 85.76ZM131.81 85.76Q132.75 85.04 134.02 84.03Q138.67 80.33 142.83 76.62L144.26 75.37Q142.79 76.12 141.01 77.39Q136.47 80.63 133.16 84.23Q132.39 85.07 131.81 85.76ZM210.37 69.54Q212.73 67.44 216.15 64.12Q218.2 62.12 219.79 60.54Q217.77 62.31 215.39 64.56Q212.47 67.33 210.37 69.54ZM234.08 75.85Q233.92 76.01 233.75 76.18Q231.89 78.01 231.7 78.55Q231.79 78.71 231.95 78.96Q231.98 79.01 232.01 79.05Q232.62 78.63 233.67 76.63Q233.89 76.21 234.08 75.85ZM424.26 78.35Q425.33 77.64 426.66 76.64Q429.18 74.75 430.3 73.66Q428.65 74.55 425.87 76.95Q424.98 77.72 424.26 78.35Z"/>
 </g>
</svg>`;
const PW_EMBLEM_URL = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(PW_EMBLEM_SVG);

/* The station plate: the same aged brass, engraved with the configured
 * station name. The metal (plate, border groove, two slotted screws) is a
 * data: image sized to the measured name; the name itself stays live SVG
 * text in the shadow root, so the configured string is never baked into an
 * image and is always the full value. Geometry is the 520 x 150 badge cell
 * the wordmark shares. */
const PW_PLATE = {
  centerX: 260, centerY: 75, height: 52, radius: 5, pad: 48, minWidth: 224, zoneMax: 440,
  groove: { inset: 8, radius: 3 },
  screw: { inset: 14, r: 4.6, slot: [7.2, 1.4], angles: [25, -40] },
  text: { size: 22, tracking: 3.2, baseline: 82.5, minTracking: 1.6, minSize: 16 },
  twoLine: { height: 80, size: 22, tracking: 2.2, baselines: [69.2, 96.2] },
  floorPx: { hiDpi: 8, loDpi: 10 },
};
const PW_PLATE_DEFS = `<defs><linearGradient id="pw-plate-brass" gradientUnits="userSpaceOnUse" x1="0" y1="48" x2="0" y2="102"><stop offset="0" stop-color="#efd59d"/><stop offset=".42" stop-color="#d4ad66"/><stop offset=".56" stop-color="#ab7d3a"/><stop offset=".8" stop-color="#dbb873"/><stop offset="1" stop-color="#c39a52"/></linearGradient><filter id="pw-plate-finish" x="-10%" y="-40%" width="120%" height="180%" color-interpolation-filters="sRGB"><feMorphology in="SourceAlpha" operator="dilate" radius="0.5" result="body"/><feGaussianBlur in="body" stdDeviation="1.5" result="hm"/><feSpecularLighting in="hm" surfaceScale="6" specularConstant="0.7" specularExponent="18" lighting-color="#fff1d2" result="sp1"><feDistantLight azimuth="225" elevation="46"/></feSpecularLighting><feComposite in="sp1" in2="body" operator="in" result="sp1c"/><feSpecularLighting in="hm" surfaceScale="6" specularConstant="0.3" specularExponent="9" lighting-color="#ffd08c" result="sp2"><feDistantLight azimuth="50" elevation="28"/></feSpecularLighting><feComposite in="sp2" in2="body" operator="in" result="sp2c"/><feDiffuseLighting in="hm" surfaceScale="6" diffuseConstant="1.15" lighting-color="#ffffff" result="df"><feDistantLight azimuth="225" elevation="56"/></feDiffuseLighting><feTurbulence type="fractalNoise" baseFrequency="0.012 0.7" numOctaves="2" seed="4" result="nz"/><feColorMatrix in="nz" type="matrix" values="0.3 0 0 0 0.85  0.3 0 0 0 0.85  0.3 0 0 0 0.85  0 0 0 0 1" result="brush"/><feComposite in="SourceGraphic" in2="body" operator="in" result="base"/><feComposite in="base" in2="brush" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="b1"/><feComposite in="b1" in2="df" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="shaded"/><feComposite in="shaded" in2="sp1c" operator="arithmetic" k1="0" k2="1" k3="0.8" k4="0" result="l1"/><feComposite in="l1" in2="sp2c" operator="arithmetic" k1="0" k2="1" k3="0.6" k4="0" result="l2"/><feComposite in="l2" in2="body" operator="in" result="plate"/><feGaussianBlur in="body" stdDeviation="0.8" result="aob"/><feOffset in="aob" dx="0.3" dy="1.2" result="aoo"/><feFlood flood-color="#1a0e04" flood-opacity="0.9" result="aoc"/><feComposite in="aoc" in2="aoo" operator="in" result="ao"/><feGaussianBlur in="body" stdDeviation="2.2" result="shb"/><feOffset in="shb" dx="1.6" dy="3.2" result="sho"/><feFlood flood-color="#000000" flood-opacity="0.55" result="shc"/><feComposite in="shc" in2="sho" operator="in" result="sh"/><feMerge><feMergeNode in="sh"/><feMergeNode in="ao"/><feMergeNode in="plate"/></feMerge></filter><filter id="pw-plate-screw" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceAlpha" stdDeviation="0.9" result="hm"/><feSpecularLighting in="hm" surfaceScale="3" specularConstant="0.8" specularExponent="18" lighting-color="#fff1d2" result="sp"><feDistantLight azimuth="225" elevation="48"/></feSpecularLighting><feComposite in="sp" in2="SourceAlpha" operator="in" result="spc"/><feDiffuseLighting in="hm" surfaceScale="3" diffuseConstant="1.1" lighting-color="#ffffff" result="df"><feDistantLight azimuth="225" elevation="56"/></feDiffuseLighting><feComposite in="SourceGraphic" in2="df" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="shaded"/><feComposite in="shaded" in2="spc" operator="arithmetic" k1="0" k2="1" k3="0.8" k4="0" result="lit"/><feComposite in="lit" in2="SourceAlpha" operator="in" result="head"/><feGaussianBlur in="SourceAlpha" stdDeviation="0.6" result="shb"/><feOffset in="shb" dx="0.4" dy="0.8" result="sho"/><feFlood flood-color="#000000" flood-opacity="0.6" result="shc"/><feComposite in="shc" in2="sho" operator="in" result="sh"/><feMerge><feMergeNode in="sh"/><feMergeNode in="head"/></feMerge></filter></defs>`;
const plateBodyCache = new Map();
function plateBodyUrl(width, height) {
  const key = Number(width).toFixed(1) + "x" + Number(height).toFixed(1);
  const hit = plateBodyCache.get(key);
  if (hit) return hit;
  const P = PW_PLATE, W = Number(width), H = Number(height);
  const x = P.centerX - W / 2, y = P.centerY - H / 2, cy = P.centerY;
  const gi = P.groove.inset, gr = P.groove.radius;
  const sx = [x + P.screw.inset, x + W - P.screw.inset];
  const sw = P.screw.slot[0], sh = P.screw.slot[1];
  const f = (n) => Number(n.toFixed(1));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 150">' + PW_PLATE_DEFS
    + '<g filter="url(#pw-plate-finish)"><rect x="' + f(x) + '" y="' + f(y) + '" width="' + f(W) + '" height="' + f(H)
    + '" rx="' + P.radius + '" fill="url(#pw-plate-brass)"/></g>'
    + '<g fill="none" stroke-width="1"><rect x="' + f(x + gi) + '" y="' + f(y + gi) + '" width="' + f(W - 2 * gi) + '" height="' + f(H - 2 * gi)
    + '" rx="' + gr + '" stroke="#5a3a12" stroke-opacity=".55"/>'
    + '<rect x="' + f(x + gi + 0.6) + '" y="' + f(y + gi + 0.8) + '" width="' + f(W - 2 * gi) + '" height="' + f(H - 2 * gi)
    + '" rx="' + gr + '" stroke="#fff0cc" stroke-opacity=".35"/></g>'
    + '<g filter="url(#pw-plate-screw)">' + sx.map((c) => '<circle cx="' + f(c) + '" cy="' + cy + '" r="' + P.screw.r + '" fill="#c9a155"/>').join("") + '</g>'
    + '<g fill="#2a1808">' + sx.map((c, i) => '<rect x="' + f(c - sw / 2) + '" y="' + f(cy - sh / 2) + '" width="' + sw + '" height="' + sh
      + '" transform="rotate(' + P.screw.angles[i] + ' ' + f(c) + ' ' + cy + ')"/>').join("") + '</g></svg>';
  const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  plateBodyCache.set(key, url);
  return url;
}

/* The plate's lettering: Jost at weight 600, a Latin subset (9.4 KB woff2),
 * registered once per document as "ParlorWave Plate" through the FontFace
 * API -- an @font-face rule inside a shadow root is not applied, and a
 * data: font needs no network, so the plate looks the same on every
 * installation and in the screenshot harness. The subset keeps the font's
 * own copyright and licence records; the licence is also reproduced here,
 * below.
 *
 * Jost declares no Reserved Font Name, so the subset keeps its name. This
 * Font Software is licensed under the SIL Open Font License, Version 1.1,
 * reproduced in full below as the licence requires of every copy of the
 * Font Software:
 *
 * Copyright 2020 The Jost Project Authors (the project's address, which
 * this file may not name as it names no host, is in the font's own
 * copyright record and in THIRD_PARTY_NOTICES.md)
 *
 * This Font Software is licensed under the SIL Open Font License, Version 1.1.
 * This license is copied below; it is also published, with a FAQ, by SIL
 * at scripts.sil.org/OFL.
 *
 *
 * -----------------------------------------------------------
 * SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
 * -----------------------------------------------------------
 *
 * PREAMBLE
 * The goals of the Open Font License (OFL) are to stimulate worldwide
 * development of collaborative font projects, to support the font creation
 * efforts of academic and linguistic communities, and to provide a free and
 * open framework in which fonts may be shared and improved in partnership
 * with others.
 *
 * The OFL allows the licensed fonts to be used, studied, modified and
 * redistributed freely as long as they are not sold by themselves. The
 * fonts, including any derivative works, can be bundled, embedded,
 * redistributed and/or sold with any software provided that any reserved
 * names are not used by derivative works. The fonts and derivatives,
 * however, cannot be released under any other type of license. The
 * requirement for fonts to remain under this license does not apply
 * to any document created using the fonts or their derivatives.
 *
 * DEFINITIONS
 * "Font Software" refers to the set of files released by the Copyright
 * Holder(s) under this license and clearly marked as such. This may
 * include source files, build scripts and documentation.
 *
 * "Reserved Font Name" refers to any names specified as such after the
 * copyright statement(s).
 *
 * "Original Version" refers to the collection of Font Software components as
 * distributed by the Copyright Holder(s).
 *
 * "Modified Version" refers to any derivative made by adding to, deleting,
 * or substituting -- in part or in whole -- any of the components of the
 * Original Version, by changing formats or by porting the Font Software to a
 * new environment.
 *
 * "Author" refers to any designer, engineer, programmer, technical
 * writer or other person who contributed to the Font Software.
 *
 * PERMISSION & CONDITIONS
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of the Font Software, to use, study, copy, merge, embed, modify,
 * redistribute, and sell modified and unmodified copies of the Font
 * Software, subject to the following conditions:
 *
 * 1) Neither the Font Software nor any of its individual components,
 * in Original or Modified Versions, may be sold by itself.
 *
 * 2) Original or Modified Versions of the Font Software may be bundled,
 * redistributed and/or sold with any software, provided that each copy
 * contains the above copyright notice and this license. These can be
 * included either as stand-alone text files, human-readable headers or
 * in the appropriate machine-readable metadata fields within text or
 * binary files as long as those fields can be easily viewed by the user.
 *
 * 3) No Modified Version of the Font Software may use the Reserved Font
 * Name(s) unless explicit written permission is granted by the corresponding
 * Copyright Holder. This restriction only applies to the primary font name as
 * presented to the users.
 *
 * 4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
 * Software shall not be used to promote, endorse or advertise any
 * Modified Version, except to acknowledge the contribution(s) of the
 * Copyright Holder(s) and the Author(s) or with their explicit written
 * permission.
 *
 * 5) The Font Software, modified or unmodified, in part or in whole,
 * must be distributed entirely under this license, and must not be
 * distributed under any other license. The requirement for fonts to
 * remain under this license does not apply to any document created
 * using the Font Software.
 *
 * TERMINATION
 * This license becomes null and void if any of the above conditions are
 * not met.
 *
 * DISCLAIMER
 * THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
 * OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
 * COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
 * INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
 * DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
 * OTHER DEALINGS IN THE FONT SOFTWARE.
 */
const PW_PLATE_FONT_B64 = "d09GMgABAAAAACTQAA8AAAAAWWwAACRzAAO1wwAAAAAAAAAAAAAAAAAAAAAAAAAAGhYbiRgcMAZgP1NUQVREAINuEQgKgZA47lwBNgIkA4YoC4MWAAQgBYZeByAb80Ul7NiLAhsHEDzbc6IoWaPR7P+vkzdGPeohthKXgifkwLQwmecFf+iFHDYM4zsaksjXvEaWVUrk++fe5adW1F5WJZWa7laOT40OuRCSwl3dd4TGPsklgsb+N7v3PnhTjURCFAudJhatQiVTElWraSN6oonWf8Pz2+wB2pigEvVpiZRIqRQQxZ6iIGbM3blw00XH1aJ1u3mL8qoW7S4i9r+qJj6L/R4+JV/tBcCnCJ/hTvl0qZ1cpdW1X6ttWDJMyZqYqbPwp8ihGkKgMkw8jEsDIMGR2xNQAGBwTknoO3EjrzRpwBFgOQWgZf3/bZrfvvEsaIOeoJxqfU50jhSC3klF1AE13Z37RtK8uTvRSB4nGo1Bq5DWDggCspdkZYTrkzMOfAKUvR+07E8caD8QlwQlcNF0v6KibX5Rfd/2K/vCkR5ShQwbd5BFVNaPr/bNfw1je/vN3O6UIEFExK7xfdw1ZjbrSLpfmn8Br1n6CboI/ZJECGCdxCmYoZtNMbBJuhQwXO9LZ3o6AAn88FFPCSBcDvd5RhgGCgSY4wvgJJLTnMTNx/FWypCuTwq8eCL0z8+zbptHgKR3Ho2fsDbQE1gzmeFjzUL05+Cj02PvqEOsRdOpUojzx7o5X8xIJijaL77VLgIZUxmwROpI0tLMxQTiP/wL2ViLCA1n0e+GDOAnZiNiehsdnW9aBnZ5HeuilLHNC+SoAbGNNZqOqia+rY5nbt9TP1dtXEj/+0WfCg8hFbBemmQoaCnwiJAgLBm4uHKJyeVRUSHSMCOxcWHx8OIJKiEQUk8kIkKnWRu9Tl1MevWy6DfAapZZ7Gaby2GtTdy22ipgr72K7XdA0GGHlbrkPuWGJwJwLAjJ4qRCQkBDQ8DDQ4IwIbCxIXBxpRCTSCUllaBAgRRycgkUFOKQIVQWSexawB4lmOIBU4KQC5WDqzADTG1U4OoUmLACV09JHqW0dS0SteL4ydp0SNRJyU5FPAFRAsjxkfG22S4OoMQ5QKlOHYTjgBvKpHtAMt+Jl8KUuFUYXGVCupbhThpCVFIQKT4AB44FQoKcKidLKQfKpFKK90g4ExOYYoZYbpPTI9OUKJHEarlrOZ0S/MoIOUFKOrBNAhTRFSlxS8swOY4lqlCSzVESzSVkGHIcxW11QoKcLMcTfNvLzpQDBpyRtLMVjXNROfpcT7QVYNIERtJebUxYoK6Wiwd6Sw8CTr3onCYJWn/yG8AArNHzwhUOeGTM3hkEy4vBNJLBs9zG8q4TgD3nSko6C9IGZAemrp9r6oNVF4XbYAQwMjNrjLW6JzLAwEM0c87VGtpA45cSlzsf2BaZEJIIqcz2Yk8ipbQyk5X8Iaq3b30PEbVde1BSSEP+hh4D+HrNsJcsezRL1sMZgMEADpnQf+XGbuusdtYaR6y11LIm6Bx6/91Zf4Ai2GR1n5Kalo5C5+TiCUQSGWKx8zlcnlgiLZAvn+e5P1FjMltt7nOGXCSVUtl+Br48XN8Q2bs+v1rbOlcuivzdHgrQzHIjX+3fjJvX3rpx9PNLOLPdKfPetnz//E7vdf95JSUrkBmZWdl5GCxOSaHS6Azm8Ue+QCiSqbu0On2hwdhtsTucLp8/UNxTXllVXTPj2HO0MdbUDtynAwxsvjABxC2M3AZyF9i0AGDnQ9CfZoexQkylOAnG4OiBAyXsL5gJnrSfBIwTr9NmSM3mxR4OhEnoBNeSEbOktZyAp5XwUyK4kCYbbzjGmhgVR97EPxJxM5SheKg1YADVfC2Z8U21xdmK1QuzH2WYCY+gHRYLanMryQnAj/xoCCNWpcKQvOTH2axDgR+rCOoxoHV9Cp+6y4XkM1c6iQTCiFXqNTwBFGV3zjJEi7IZ6JZQQXFjoygtyySZWvxixCq4gr+LoLVIx852jylJ+9esS7SZE+HInOSxSmGduhAeGbGKN+bgnIBDAjDSJqA6WMv495zEdQ1VRDWuJze79FUbrXROVm/UR0Wd5SBSYB1OVXWJjGPm3Y75gHGQiMAjlflvPIh24hciJ/r1Ox51lI8qBz2P8v4HOuOQYFdMua13vJ7tuiRBpE0SBujH4FaghPJIjpB4MI00rPAUiiSpk4sySkjwWja7TWHcOY456qp0s28P31e/5Nn5sUvunowT7ayIPc3yEHPezxTTWj1ZEfR60mXX7EXGmxJcMcvkWneQgBvhzjsSxsKxqycZ5gmzddcHtlcsHR/CPAlfToVbfcDSzyIITViyGo44H+BWnaVBKQ4ThI08iU9ac9S8tSDE+2ubVQeQcdA9MBvGZsC3H1l0efOBrE2AZ4tkiWCkZvEpKknqFHlaG7YsH6v51ipoqym/LsR6YQFrYIkXMZPOXWEpVp4ugGR4VSRFNtrETDMZrRg/eBk0J0SN2VvF68/gcidiphQwCy4ur8DK0Dg27epU3A0WlVcW4k9WpYN2hZu3f4mcoSq6OShQvoiEmvQYxNfv9Zfrcqq7zqX+TglJITfqH9Xbrqh/DC+8RrHqAtiOoy4mf3X3t2FJBVbqFAaV7S3zpJu/fUIehcTZFtPfvVr07HoLYv5a7uZQOpVw6al8+3HiVXiTceqc9c7gRj8JJI01mmXzDc4AVg8XUKI8XBRlfzQPgHvBW+aFU9PLAl6V4d8Fvlo6xd0zQvGUjyQx0JkdKJtaaOvflJCSbN8k0gXgZZKUAE+nMXMgBxpJpvaVoYted379OHsav5c/Gf6n481lOwmnQi2oOsyitpn3ME6vFWbxY6qOfszrYUcb2GjH3Ykl4+x6nyk9U12f2Hd/yJNW9gFVotFNLutQCclXrvGZtx3U6I48YaThb15c1E2/8TwsK4+tW/6zioQnNsy6B7H8PG3eJaXX+2keHKszMB3qmfvl3SvzapdY+ubf8jA/PaoJszAlmAz0kv5CpE44POudg7ZkRvf5qpsDVnssUdeBqetUr/gYH1PdROLq2aqevKBbN3PDY+Q5SQ310NSoqoiiBvbcyMpetnl9zRKgqHZ96anAQTceHIY7W9rRDdcoGoce+6lhgQDHqasnCa40aXnQvmcxPlx3bWyQI+QRXkdjhzkuQCvGD560fDWdKhQ1q4vfZ7rcirrdPDtf46mUSGGw2vp3QXqVmtH6lpkBfEI4j3k7djBCplZpktUTvwEtXTZ5bpVWeY4kV/RCcuspMwIZqacckVEXaNJQ30jNWYIn9Dw/0uVOqNzPTwm6vFj9uMhdagQJrXzLzUgcbaDaAunVol5wTI2NHTiAjnkb3mGR+HLiReqo0tMrHGOYhvKKTTKzGb6ji0hKCRh+QZsATbhgcB6+h4vo6XsA5LKnzBOH0kFKD4ogq7yICHwVCsWlsLppRWFXbAzX+PgfnW8V46W7tyP0E8C1x0pyyfvPEJ9vXRONflgS57XVbRwsipHrhkxsKcjsriKDTrPw2iDRQz2U72bG87M3kCN15KIxfKOmaLzcmxnYmV+7RR62jf14+GyTXcqCMGgRdeI0Ob49oBjRmuzsze8DpnslCXB2n3j5kXwzF5pPNLC8ouS+VMcXQdm8YuRhWRxeT2F6a0bm8zyUGQYd+dlAqAU25TBB5X0YFpEut1Z1hEXKhxB720c3JhhrxXjGGszm2XEyLPorWobZ7Jlt1ZCDbjEWgEe3vcKYruOLP8nRFuZ4Z0oYOy9iy4U+9oCnAIzLcuoZblpXAd/RRyoAPoGTNYChy79qm1ImBF539K8njzEHVWXk1TS1gKUTcWpc+ye4E5tZRpky2Y/T0etml17GJtViRjWLYeIxg1O+f8bLUbTxeZrhMCYM6/j6NKq9Ydh5t+zpE3xDFtpCJ4DTcRliiRODPOZWDdYU7dUepqqV6DBmeYVLXtFhOewFVWorwCPx40/f40+HepOqSgfwmcQG7MHqs3wYhpz6mVdo2FAdSgaYyQogSQic8mv7Qp/fFjksMaIcJimoYcWD3KQwIyJPBiVnmI+YhC3XV+DKthNYz46FU3iaXMNbi557xVnOP/8ZZLQMfHGO4MoOk6F3D/PCU7F6ox+efbmDrHPmA9M4GSciJH20rJvEQzEkRqLxCpGGdzb7yTj4ZLh+mN2fUxVlM0waM8ZH/VvCGZq4MAIpNxNUIFFoc6g0E0SgVJJ0y4i5JNQOyWmXezVyviKJRB7mfF8WW206VHdK1ZlLCTyrSaEuhCkZcN88yOybDCPhA+cS6TGqczPk6SRt9wNfXW6fFRUXDz4ayM1WJy6ob9W9zcj8jL+ZKjzobaxvLLQtbmGobfn+169cunmvIviSw32v1giOjy9XVz6K4IRLjDpq1RubGY3BxMXQ5lObtvexc1kFVt6KAM3s6J2CLd3Ghzcqnv28Xp0459NTj1/E8+fTr/u3rUB5JN7NUKNnzLkFyE3sMW8+WhPYPfv1eduaxHtdqnH40yPHF0f/v9Xnud0tvT4ZspcXZ6Q2tbDH4VrNbldh3QotzMc8MT2TPBe9irhrUGuiJhMguFtbTVmrRQ1VDyMklVW+StTvosugmJVAWMzWolKmEwzbb4Lnod2DYc6f7uq/FQ5+k0iFApWO0pWnEy/yUvgxZ0X20VS6xKMeh7pJd0jptXuEUyMO+8gl0LKR/Ga98V70qnU6uUCGZ/meBHjisO+Q9VPGBNOqt4wX71cO7ROhCKt0LlU+A9GwaBERjHOfRQkmV4WRuKE7RaHxiHr0Ca5JhckQlYI36daMxID7SLV1sITgjKvRUHp604Cn6oNUTStQyoFJvcDnW2TKkS7zkFFCfo6JH5jNKRMRev/wj0JBSe4QS7L7nDYl4/xDAA/keKFEpSy0DcoI4xumYO8O0TppED8agveFxMDzkUgoJsnSD92Lprznif63fb7e02Ok/3Gpu52lf8fnoUM/ns3OvU5mvUJqtkyqGVzL/u9VzvEQvCTfNelfi4lWXMlczfkrst8peyvXLvTUTxo0oTBDh/HEfGv3D1/cycp5Zz4JQ8D8Ub1iSxX5cwrlJjlBzn2OwFEYIHZjLp9VXhCpkFi0IpFNKxHbFEoXqyjvHAp1Mw9zY+pxFpyun21rZmrcMq3GS58ctq8m/izqzzeUWQs4TqegOke6vGgu/g6bjqOnraNXf+YVNrNxox+Su8HFGps+GpVrJV7sN827d0cYXv8iaSQsXxAICACK5fe20LOavzmzJNqRR7C+sfYD/tqz0PmWU4nYNFT2HlxmFWHr9C4GebCISjrYi0p8L1w0ANzjE2smqsY79pVWbWttFdCuHWtGlgsCmI+pxWo19I/DdMHyEXAoPBS+hddmgXfQW4WcWDJx8lqYnp1Yb2es33kx+9WzRqG/FwcDyir21JWX6VZ3C7qSktk7yJ9ToFVikH+azCwKDupVw6rVwkFhFXYinyo7ETdX5iSbc7nGRo2mzeHUNseUheZq5fYh24/lth6WI7BYGq1VjgUC8oWR8CJZIDSqq2zjLIf7KsAsKXwe/EDCxMqJqCA3zNXZ5LNnJ9Y7FsMLWfuzqLDYdgaUO/bUlZfrzs1aOymhrqXcpEBSpEPJP01m3n5gdXsa/2EZsmhcF2oJyST8dcMngv15mDWNFl078RfVze98XdQL2b9XHhjOKwTTi27ZYzhv0frYA/plyDPXA9348Z8+ergknUUfqPRBoywpVozCNJ3DE9nWbr3hi7vZOW+uTccQk/4E52vMilhYYzTJpCxmNsuBGaHttsHkk401NIzJAwEqqW+Qj/n80vMDarTA7xsraAgrFjSzp3/mWbOa24k/S0uzwDd4dHWa1YU7vsJgWk6PbQ6mYwlJTerSv2G3zvFPkxnc/qWvnFDMXKoySqQSo1S1dGhpsE+mi1isugZNBZeO2K+M1b9vtkajot1iVkQblEZDTKNt3WDzycciDQvl/sDohyxbXi9Ft2+fZyjYaSkAX1vftx5+apX1j9JzaCmz6QEEPWhiLu1ZF+xVfARMZqBP8uA6sOjrqL0uEOwQGUQhglXO8kn5BAv1Kd5opebicBs4FEzTZ506tMFSxzMbmwTakFbCsK0ykBY9NpASIWYVl/HCGb9sQrNSc2FeErCNf6Jn1dgLwxS1SixHYanUf7Lyba3eodfjfmnfLrNxD91IXXVs1EOLUhe0vqx56qrnf33t+tCLrVKT9FkJaPjlwvX9duKjewC8nXTl47c+3nj8EOPJvdt3bzOfHAKXxmfdHbz7xgfF3zS9sfLvJX+/Md30STF4b3wDdj12749boNXUHzcDIm3bdOcfd176h1ys5hWr8cPKkB4F/j0kXsA7vuLw+LHhtaS1g0ODiTc7h/B75zcMNliRExsnQNwcX7XPJtDlledrLIpYWG00SlAes1g0Cu21G8w+OWqv5PePyiN9fqAHZrV54R8m4aI/gG98Yu6E6Jel+ev+Y9D/W5+/tH9psLdA12Cx6ur1KzG4FGxdgcbNIDFMqL3arZ+bsnihGq9ZyDM4IS7HQ0zl/QM9+HNUjkArfmfD2u2UnLx551HcYZtQaqiCNIYYVQK2LsrxriblnzhZuOTMTwxVBU1ilnBfdlHEIg/lAe835n0pGUPAsD84sHcFxPyZLG64YSWk1UepVFIiTprXgd2ZuCLNA/vaLR3Uf3ZpWdM6mY48YpQlxUxoTFhGymTnXDTxgOZ1ep++HXdZzXsr9D8SW3UikawVS6xandRaxXk3PSb+lgep/yJHYu+haa+uJaJQq8pV0ha3S9pqLJW6fkB1raPufPxKKrGDy+FwO4jUlXiwe5qleYtB6H50arTPg5E6+zSmVofd1AbLKcUbSv/oqUs9JMakps6OA/NC5yqvJmLTUdm7cZmVhC1B0YCOSt7Ql75U7AkkcgT5D8Oja40qVOpylaTV5Za0GEutMpvoWkY9+fid0OwC0M6vJkxycMBAM3RRRZe4zMAbggycgcIk311JTYzI+Fz/tnhEskvR1CL3eDrV2haXU9vSqQEtN7bhshOciliL0mONCXWlm/B5aVZ1W6fOaygn32nsop7QPSRRq78XY5mfaiHKxpd0qKx1kt34hnbZOoluPPheD0hy4xvft49MSPtywNxup7SnXZDXLZ6+SC6wM2l22cBwBe5YUQZyCdipUVa3SvymTompvfSt4beE/OUUmuJO2sJkj64pKlOpy+WSZpdb0lSuUKuiMl3TqIeD2Q7lrhIWUjjsNiK0HQOQ4/H2oRzIw4xwVVCRlSWXO6X0MgWOWLEBny8EquGYAPX7tLT3p2ZPAfvtbH/7hS+jFezmL4ISDfz6fR4GP/FjdvXgnyYz84C48wfK+7ui7vz0a0SZnU1zirOGf8Gtqs3MaAeI90jkMPJQ4dULd9K2fJ72yIA4WwZ7gy8YSlLRn1KhgzX23MiSCmRPMsvw1DCGpC7A0P8XYuYd3q4R0JSHGWMGfdXFYgvbZhuZGsEsbx27EEzeno0DJW8q5K8IyD1SVkjxy9KvTonzctghpswWGr6468LeHSFjCMmVlGm7qa1H43QK6PV2h6mV9midb2elzqFS56SyWCldeER1pVSz6b8KtVHVbdyvvG8UlM06XVdWrt2eu0vbxK9fKgrGXq4/BzOwmZ2vkT0FmeyfJjNLBRfvHho59M+kT9cWUag1IY2gze0StKuh0X9h7aPefOzyQFt+IL8tvxwLtty9mh0Zmi7qd40qVLpSDb/d5ea3GUOnjdJto0Wj+22HAtD2L9WLt+dMzRmzqNvfn8TSzZL8EoUUSsdi0K+C0A69f5OB48eKfRUeKyf4xHvv8VhG1txcyAItUfpKV5lRLIGLcDaf23j0H9yJpmz0aRz63UwQ97yd0D61s224DVw9gRljFvtrisVmdsg2b2oehtg8RmCLQEehg/iSAsztlsmfnh8rVPC32uN1+3N+hOUVfP4fttJrlZGBR3zGv3GRI6wFsOf/LOlcF9r99QKI54+/XklfS3/09eLoizHqPCjyPyi7XbOgasG6Vx6c+nZddHVs9coT3x5+AH67vXBV609r21dd3N6bPMqOIYOrUFnj0qPGS5VhYvu01/hfapr8v3Ri4M7v8vgAaEnleUmfUJ0ceoA2xGjKRFMunWWw1GpvhFnobZepInbtCJBy9v4BEXaNEAncK5eZGEyJZkgTweJiC/FZKtgdWjjtmgZ8nByIaT9OPVKrcAX7DQxDN5VsgNgM3a1k08w4RIqjoKleaeF7sUfNyCa/wiGux3EE5RqEM5dznq3XX/TlcTXlTLFFUNjgbK5guYnUJwLyjhW4OFdq6fq3tvEvQgzK1yO0+AR0RwIQpLn7jMYeFwdTJa7zxBq7/qm2xAc8Vp+quOpouKNPX6OSRc1uQ0+PwdVN7/6Kyfy7m0YP/81kftX9xnpbe5ytA1CmnebWHrXD0aM2tzpd5hbao+UlJ4t/jE4/xmdxuEe18CiXoRlNdac3GHDx7pcjX/5z12v4DA5mZ47moL++SYmtJrAP02i/0+hx0CwiMwedhe7q78SiejJ36F+l9fPJEAZkm2V2k0LhMMnkDqNCYTcaZSQqDichkSQ4HBUcr5GhQjPEFEg8AxWS0b0gSq8lBZ223bPLg6Hhcuvuzk4BtULBGtp/HYAt/iBXsvSGxADQ0vmMU6+ckYWVTJL7+xnMwtI+m2bQvYzzromB6xr/EIUXB14FqcL3Ur7dr5LJShulTmtMpq7WjrJGOKSgDIumEzLIzINFPRJ9lVbGdflELTkGD2NFqxIDjSdAlPIX1BV8mt+or6GBjKhu1sr0v/d9Qzx/dO1EGJgfO9SNtQoV+cj2/JWol4drF0sN6M8ITAOugclCf8Mn/n5wkaljyi2KEA3SWrxXxa8AF35kEXYxGLsILDYu6Ylb/uOHOR+zyguKHd1DardbAA9EsZQWHPeQ2Qzhlk0PEwFR5sfItvjHqcCbLaBbvvPlcbnQvwsVAqU2EOHp9HgvNYFRK665H4frr8DhYwNY7MDgDq6A6bLKygkSiSxkkbFcAhnX4xCXvQkAhfKrWEYmvptKJKQ+JNIeJBGISe+AyVss/G4GYzd+XhfyUc7VVbfdQdHiRY/+F7zEHsEFgq+cYQIMNuB7oy26KRGiIA0sqcSez3DwS1nLKbm77mRij8wE658KXdhdkNBuNuk9VrkfQ8Tit+RmaUSY3P/txRY550MfRiogrfDkEL1E4ipSKc1rYYCe8cTxUOL4670NuEDJK2eYQ/Z2Z2TTudSRc8ejkfJ96h9Lr2//7tqA743W6KE/IMq/RpZEapuFUsLaLt8Sxy+zsuvaPhU5J3M6Y+FZpWBL3ZfandFNZ8cO649U7NP8sM21ycFkEHfh/e73gfVkT3dPzqR3p4dFBZpO9V9z58hxNV0D0i7ZX3Pm5qWdYNH1Wqg/1V6wc6CgMzB3zu4KusD9zdGe6S+ne6JgZvNhyd91o7fn0poCNANhm2RS9eqnMz55TTUp3r59b2iBJlruDtQiKN65okyMFpetiHdCYDEftSJvNKyYaiQsF6++cG3G9YkwyTIjgVp8UN5y9EEStORz2bVvWcON+RtiOFYIF5u99v7eJUd3FnyKFb93UPao+/B4xeHxHvnjBMn7R6QfAyxOJPAHhNICv5DvF0n4Pr+gQBoQCHyt4pysX3Nzn2XloLOf5ub+kl0ZFQt8tUI+sZjv7/e3itgvK5/mIcF/4/PTJqBrnK8sjShzS8fz3RuU4N0rit+ro7+D5nEEqhqjRYo9xC5Q8KESeODrz/lUp/6IkH3BSZoB1/4mYyf/OHk2lvQEX1VMVdfe4Um2b9xX1j55IOllv7CBF712Lz8WxjywpJ8U4FZTfqDRH1KoD+i078Hc9jJ4be7MvyAVgmg/BD28/gcw8/VHvHivueG694kLMQWgZJzwoDFldy+Avt4J3oGgO2Ffg1+/Itxn9zkL0L/Zf6jvgj2/EF/2s7Vk1LFYfG0oLNdWaiXMIosyRBRpqoh2xR+VtkM+npDZdP/eI1Ltt0gi3aXTvgHnrhOX+docw1qv0FboTqetdB/cewhEavl/l+D0OG5+8TycuRikX581PmdoHCSsz/py7peg4TRsLuzYXNhcwC2kDnTmZq96hGXvn4UmXGsmiqm2UyyeXcSttXIIjjYWu0gsrT1c2ODdvLGs099OvEn33ajMkRV36lRdXjO7y13cJjCrQ0y1kRAS6fBmd1rqHRMyISOO9HkT7st9hvUiCmTEzaTUmHSc/pKaWQp/aIWuqVW5CjwYCAys797o8JAJ5fS8nzNQxIsvO28YoS6aWagzlrcKDY4hcaO/pIFSbvjfXlJkKKHz6I4pAoSvndo1NL49QOFwXaVCnb6CL/bw6akfgl6+xX+614FmcXwkD5/cVngmdtgmwqEDDCObZc/omWbRZadc8qopWAry7U3ZWVW2n9ZZfWnvBwlShjnL/AWLKd+AZF0oHs7LcRUM0LiOrN7HVOZGE41zZvIgKu2Dszk54p8BOe3rbovF0r2JqY+JdTNsVl1tTAzccERAdYpjH6zhZvpw+uUbGWMZwID4uffnz3/+6efT+yYXTIKvkqAXVNzlqP+/T6EwjtDl6rBoQARGk/Yeik4gcOgBtooWA3Xkr56/3NIb/JdsGJ7z3ycl/306B8yDGWaDfco+eecNmJ0tdXdfqLfHkMNeTmI2NYxXzpual+gTVghAZlCCOBJJq2N/Ig61fU77z7QZ0HpzDcdibhZriiUSun31i+YKM3kLhLfsobAe4FubbMWBQKtIX9Qp0lYVCokW8dPUnU7CdUqesIdM/toL/mLEr29PWL/5TZZ2ki5xcvljfT6M0NX7sQOo5RLW6b4xfrdAQr+klo4OsrpPDmDqru6vBg29XDLJvCVIVxQ28XQlWobs6+dugpgU0pfB7w/V0W1nnrdQ7WwqdPAqnkg+M4kj9q25BfC/h+sW1dUjk75otQ4WSHZLuN5GkLvWrWq26ttadWZLi46DVpu+NWgxt+oWHbTSP62hUmu+oNO/yKd9CniZtGraz5I6/Owjx6/lfT9tpq5h/LAB5C/43vl98vUnzifn04v4bQG1LPTfCpQLnW/rlvsbuKNFzZ59S2pr8l052cv/C8kCan47+N9fvnzgMNx1GD4ANh7I4SajPNi0gxf+YW0iMLDKX3bkJhFzWuOYoiRUAiqNMqezvyWXt1wVN56XxgHKlWHziGZldDDNZ2nvbgfEudA+G9AgzuTAeXPpl1rLMQw5sIpJWhhxpgGV9F5giZk1HO17TN4je926awJDRKEOGw3qel2iQXBtXZ39EY/5nvZYvpnfVRzs4BuNAoDSyVzsLjcVyefX1c0v8HhHCvgEREUJ4Ho98+FPsqDT33a+ce75C1/uC+2DHCXUYTJpNrXEUuEqdmqVxQ5XxWd35ZdEnFVLtBNrjfGCGOE3l6SDIe1wrb93//TzmserHzevnl4zDbJKZXaLQuGwyOQOs0JhN08TLXhCAZGUPt2b5j6Ie/nKHejPyu75cD4CgHH/qfmr+toM7f8kBOJLjPc3oSEA+PZ95/UXXywLQFLuCnBkif7NU990Epg6NrP7277Jr0AO5kvWl+DIgzw9iy6mypZcwDDJQT1j/6bChuT8U6V8cQfFH0Uw27umJ/4cYfWBgebpQrnoyZZBOJW1fVtbgVaUhO5nT2gtucjqi1E6sB9sdYnURe7PkE5xRy56A/xNBrim5yNW0uUro9TyWKByoSw22IYgb0gGUCP54nOVpOJt9Lqe5BevnksXODAMtuxb4YUaQKiHOotmjCFnYMIUz62Je8yv8/8+mv/lJyC/5t9553/IqI98tMC1gaRUuQchcSA7uVCdj51vbG4/dEtJu0Fm27A6d0wxIxmy2VLyUC6jsKmGHhDcaGR618A3GQAfuAMObGObDMTNPYhKmRmD6PTK35aii9BGA1x4zPlNFDXboKR5bIOSopC3Lq6fKRqeFMr/GuynHOszLkEYaA1puLJmGcUcFofIDgccYPqZKUUCUUdo63QeIrqKsX3dX0JviYJ20nRuzYHN49GJ8J2FLLStoKgJobf9hA6i5H+iFuJlkBa32zTgz8+UeZlpULDzu9n3jQpNtg+4YIA3AglHVe23Xa23BwJskQyAO8AsBJPkSAgu3fEQAs+lUByMb0PxcIkLJcCEFEoLJfLD0xU0dDQYAOu6JJQKMrtBEHrLD3xgRCk9zqzTXbqGeppjTX0UiSg7lJJGigrXAPXSjr+niJYONSw6xn4VTa3T00vErgcWXZWjFkY31lx8O/vrBQ2d7cLmjkhU0O3pF4JWqW+T+M5Q1zMhVE3kgygOIja847Zwj1SgEIs0GhMcTdOJz4tRp0ZxQ1HjovnsUTooct5EMBJq9ipsRu4QQRKNTxpMGJhWFG0qGmrR4Z1oJJj9vt0eSigUrXScHiWf5/YO0XZPNePVNsvEPPOtddeaMSNOeMBQswct6DHK4NbBAmq6xsAMWqaOb0vtwe1t2E9ElxG9hnplSLDt3/BjQp/Nw58oi+5/IlhEOwvT+cZtEWdf2A0V7z0i7BOI/zy5N0kPAA==";
const plateFontState = { ready: false, promise: null };
function ensurePlateFont(onReady) {
  if (!plateFontState.promise) {
    if (typeof FontFace === "undefined" || typeof document === "undefined" || !document.fonts) {
      plateFontState.promise = Promise.resolve(false);
    } else {
      try {
        const face = new FontFace("ParlorWave Plate",
          "url(data:font/woff2;base64," + PW_PLATE_FONT_B64 + ")",
          { weight: "600", style: "normal", display: "swap" });
        plateFontState.promise = face.load().then((loaded) => {
          document.fonts.add(loaded);
          plateFontState.ready = true;
          return true;
        }, () => false);
      } catch (_) {
        plateFontState.promise = Promise.resolve(false);
      }
    }
  }
  if (onReady) plateFontState.promise.then((ok) => { if (ok) onReady(); });
}
/* How long the Mouth's display-mode label stays up after a double-click.
 * The .mouth-toast fade in the stylesheet runs for the same 1.4 s. */
const MOUTH_TOAST_MS = 1400;
/* Where a setup step is actually performed. The integration decides WHICH
 * route a step belongs to (ownership is a product rule, and it is written
 * down once, beside the readiness model); this only knows how to travel to
 * one. Three kinds: a Home Assistant page, another Parlorwave screen, and
 * the add-on's own configuration -- which Home Assistant gives no stable
 * address, so it is an instruction rather than a link that could 404. */
const SETTINGS_ROUTES = {
  options: { href: "/config/integrations/integration/parlorwave_radio",
             label: "Open integration options" },
  ha_tts: { href: "/config/integrations/dashboard",
            label: "Add a text-to-speech integration" },
  ha_weather: { href: "/config/integrations/dashboard",
                label: "Add a weather integration" },
  ha_calendar: { href: "/config/integrations/dashboard",
                 label: "Add a calendar integration" },
  // Home Assistant 2026.10 calls add-ons "apps"; older ones still say Add-ons
  addon: { label: "Settings \u203a Apps \u203a ParlorWave Radio \u203a Configuration (Add-ons before Home Assistant 2026.10)" },
  onair: { view: "onair", label: "Go to On Air" },
  booth: { view: "booth", label: "Go to Booth" },
  newsroom: { view: "newsroom", label: "Go to Newsroom" },
  station: { view: "station", label: "Go to Station" },
  settings: { view: "settings", label: "Go to Settings" },
};
const KIND_ICON = { music: "♪", dj: "🎙", news: "📰", announcement: "📣" };
const NEWS_ART_URL = "data:image/webp;base64,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";

const FACEPLATES = [
  { id: "midnight", label: "Midnight Black" },
  { id: "tweed",    label: "Walnut Tweed" },
  { id: "heather",  label: "Heather Gray" },
  { id: "linen",    label: "Sand Linen" },
  { id: "retro",    label: "Retro Pattern" },
];

const MOUTH_VISUALS = ["waves", "eq", "robot", "dial"];
const MOUTH_VISUAL_LABELS = {
  waves: "Classic Wave",
  eq: "Graphic EQ",
  robot: "Sci-Fi Robot",
  dial: "Analog Tuner",
};

/* --- the Broadcast Console's Mouth ---------------------------------------
 *
 * A PROCEDURAL BROADCAST-EXPRESSION DISPLAY, and never an audio analyser.
 * No sample, no spectrum and no level reaches this panel -- Music Assistant
 * plays the audio on a speaker elsewhere in the house -- so what the Mouth
 * shows is an EXPRESSION of the station's state, drawn from facts the
 * screen already holds: whether audio is moving, and whether a programme
 * voice of ours is on the air. Three states, decided by the same rule as
 * the state line (see _broadcastState and _audioMode):
 *
 *   MUSIC          audio is moving and nobody of ours is speaking
 *   PROGRAM_VOICE  a DJ break or a bulletin is authoritatively airing
 *   IDLE           nothing is moving
 *
 * DJ ENABLED IS NOT PROGRAM_VOICE. The DJ control beside the Mouth is a
 * standing arrangement; the Mouth articulates only while the backend says
 * a voice is on the air, through the backend's lifecycle word for the item.
 *
 * The motion is deterministic -- a few slow sines of time and position, no
 * randomness, no per-frame change of brightness -- and the shape is a
 * horizontal lens of vertical segments: what a mouth is when it is a
 * display and not a face. */
const MOUTH_MUSIC = "music";
const MOUTH_PROGRAM_VOICE = "program_voice";
const MOUTH_IDLE = "idle";
const MOUTH_LABELS = { [MOUTH_MUSIC]: "Music playing",
                       [MOUTH_PROGRAM_VOICE]: "ParlorWave speaking",
                       [MOUTH_IDLE]: "Idle" };
const MOUTH_FPS = 30;                     // the ceiling, enforced per frame
const MOUTH_FRAME_MS = 1000 / MOUTH_FPS;
const MOUTH_COLUMNS = 33;                 // odd: there is a centre segment
const MOUTH_AMBER = "#f0a24a";            // console lamp amber. Fixed on
const MOUTH_CREAM = "#ffe6c0";            // purpose: never album-derived,
                                          // so it can never be red
const TAU = Math.PI * 2;

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
/* The lens: how much of the full opening a column at x (-1..1) may use. */
function mouthLens(x) { return Math.sqrt(Math.max(0, 1 - x * x)); }

/* How open the Mouth is at column position x (-1..1), t seconds in, for a
 * state: 0..1. Pure, so a test can execute exactly what a frame draws. */
function mouthOpening(mode, t, x) {
  if (mode === MOUTH_PROGRAM_VOICE) {
    // speech-shaped: syllables at a talking rate under a slower phrase
    // envelope, opening most at the centre, with a moving articulation
    const phrase = 0.62 + 0.38 * Math.sin(TAU * t / 2.9);
    const syllables = 0.62 + 0.25 * Math.sin(TAU * t * 3.4)
                    + 0.15 * Math.sin(TAU * t * 5.1 + 0.8)
                    + 0.05 * Math.sin(TAU * t * 1.3);
    const shape = 1 - 0.35 * Math.abs(x) + 0.15 * Math.sin(TAU * t * 2.2 + 3 * x);
    return clamp01(0.12 + 0.85 * phrase * syllables * shape);
  }
  if (mode === MOUTH_MUSIC) {
    // alive, and quieter than speech: a slow sway travelling across
    return clamp01(0.27 + 0.10 * Math.sin(TAU * t / 3.6 + 1.4 * x)
                        + 0.06 * Math.sin(TAU * t / 2.1 - 2.3 * x)
                        + 0.05 * Math.sin(TAU * t / 5.3));
  }
  return 0.06;                            // idle: a resting line
}
/* The still picture of each state -- reduced motion, and the first frame:
 * one lens at three openings, so the states are told apart by size and
 * brightness with no motion at all. */
const MOUTH_STILL = { [MOUTH_IDLE]: 0.06, [MOUTH_MUSIC]: 0.32,
                      [MOUTH_PROGRAM_VOICE]: 0.74 };
const MOUTH_ALPHA = { [MOUTH_IDLE]: 0.42, [MOUTH_MUSIC]: 0.82,
                      [MOUTH_PROGRAM_VOICE]: 1 };

/* Continuous waveform sample lookup with linear interpolation. */
function waveformAmplitude(bins, elapsed, duration) {
  if (!bins || !bins.length || !duration || duration <= 0) return null;
  const progress = clamp01(elapsed / duration);
  const idxFloat = progress * (bins.length - 1);
  const i = Math.floor(idxFloat);
  const f = idxFloat - i;
  const v0 = bins[i];
  const v1 = (i + 1 < bins.length) ? bins[i + 1] : v0;
  return (1 - f) * v0 + f * v1;
}

/* Asymmetric attack/release envelope follower for organic lip motion.
 * Attack is rapid (~35ms) to catch plosives/vowels; release is slower (~90ms)
 * to prevent visual jitter and unnatural fluttering.
 *
 * smoothAmplitude(CURRENT, TARGET, dt): the value drawn last frame, the
 * value the waveform asks for now, and the seconds between the two. It
 * used to be declared (target, current) while every caller passed
 * (current, target), which chose the attack constant on the way DOWN and
 * weighted the step the wrong way round -- right-ish at 30 fps only by
 * coincidence. alpha = 1 - exp(-dt/tau) is the exact solution of a first
 * order follower over dt, so N frames of dt land where one frame of N*dt
 * does: the motion is the same at any frame cadence. dt is bounded so a
 * resumed tab does not spend one enormous step. */
const SMOOTH_MAX_DT_S = 0.25;
function smoothAmplitude(current, target, dtSec, attackMs = 35, releaseMs = 90) {
  const dt = Math.max(0.001, Math.min(SMOOTH_MAX_DT_S, dtSec || 0.033));
  const tau = ((target > current) ? attackMs : releaseMs) / 1000.0;
  const alpha = 1.0 - Math.exp(-dt / tau);
  return current + alpha * (target - current);
}

/* Maps smoothed amplitude through silence deadband and perceptual curve.
 * This is the SPEECH mapping (DJ breaks and news bulletins), and it is
 * deliberately left alone: phrase gaps close, the
 * motion is natural, and news now carries real MA waveforms through the
 * same path. */
function mouthWaveformOpen(smoothedAmp, silenceGate = 0.02) {
  if (smoothedAmp <= silenceGate) return 0.0;
  const gated = (smoothedAmp - silenceGate) / (1.0 - silenceGate);
  return clamp01(Math.pow(gated, 0.75));
}

/* The MUSIC mapping. Presentation only -- the request, identity, position
 * and smoothing pipeline behind it is untouched.
 *
 * Mastered music sits near the top of its own waveform for most of a
 * track, and through the speech curve (x^0.75, which LIFTS the middle)
 * the lens read as one breath stuck ~0.69 open. Two changes, both to the
 * drawn aperture and neither to the data:
 *
 *  - a steeper curve (x^1.6) EXPANDS the dynamics downward: a track's
 *    louder passages still open wide, its quieter ones now visibly close
 *    instead of hovering, and the median settles mid-open;
 *  - the aperture is emphasised against the track's own recent level
 *    (`slowAmp`, a ~1.4 s follower of the same amplitude): a transient
 *    above the running level opens further, a lull below it closes
 *    further, so the lens reacts to musical energy rather than to the
 *    absolute number. At the track's own steady level the emphasis is
 *    exactly zero, so a constant signal draws the curve alone.
 */
const MUSIC_SILENCE_GATE = 0.04;
const MUSIC_CURVE_EXP = 1.6;
const MUSIC_DYNAMICS = 0.9;           // emphasis per unit of relative swing
const MUSIC_DYNAMICS_MIN = -0.5;      // a lull may close at most half
const MUSIC_DYNAMICS_MAX = 0.6;       // a hit may add at most 60%
const MUSIC_SLOW_MS = 1400;           // the running-level follower's tau
function musicWaveformOpen(smoothedAmp, slowAmp, silenceGate = MUSIC_SILENCE_GATE) {
  if (smoothedAmp <= silenceGate) return 0.0;
  const gated = (smoothedAmp - silenceGate) / (1.0 - silenceGate);
  const base = Math.pow(gated, MUSIC_CURVE_EXP);
  const level = Math.max(slowAmp || 0, 0.10);
  const swing = (smoothedAmp - (slowAmp || 0)) / level;
  const emphasis = Math.min(MUSIC_DYNAMICS_MAX,
                            Math.max(MUSIC_DYNAMICS_MIN, MUSIC_DYNAMICS * swing));
  return clamp01(base * (1 + emphasis));
}

/* How much the music columns shimmer around the drawn aperture: a subtle
 * travelling variation whose DEPTH follows the real envelope (silence
 * shimmers not at all), drawn in _drawWaves. It is a presentation of the
 * one real amplitude, never a second signal. */
const MUSIC_RIPPLE = 0.14;

/* --- the waveform's demand and its playback clock -----------------------
 *
 * A not-yet-analysed item (or a reply for some other item) is asked again
 * WAVEFORM_RETRY_MS later, at most WAVEFORM_MAX_RETRIES times, and only
 * while the same item is still the one playing. A waveform the backend
 * calls unsettled ("stable: false") is re-read when the backend says a
 * new answer is possible, within the bounds below, again only for the same
 * item. Nothing here polls on the frame clock. */
const WAVEFORM_RETRY_MS = 3000;
const WAVEFORM_MAX_RETRIES = 4;
const WAVEFORM_REFRESH_MIN_MS = 5000;
const WAVEFORM_REFRESH_MAX_MS = 60000;
const WAVEFORM_MAX_REFRESHES = 30;
const WAVEFORM_DEMO_KEY = "demo_waveform";
/* An item is drawn only after two looks at MA this far apart name it (after
 * a seek, MA can keep naming the stale item for a few hundred ms); the confirming
 * look is never sooner than WAVEFORM_CONFIRM_MIN_MS after the last. */
const WAVEFORM_CONFIRM_MS = 1000;
const WAVEFORM_CONFIRM_MIN_MS = 250;
const WAVEFORM_CONFIRM_MARGIN_MS = 50;
const WAVEFORMS_HELD = 4;
const WAVEFORM_KEYS_REMEMBERED = 32;
/* An authoritative sample is "elapsed" as of the server's wall-clock
 * "elapsed_at". Ageing it to "now" is the one place the wall clock is
 * read, once per sample; a browser clock skewed against the server can
 * therefore move the anchor by at most this much, never the interpolation. */
const CLOCK_MAX_AGE_S = 30;

/* Deterministic test waveform for visual test harness / synthetic evaluation. */
function demoWaveformBins(sampleCount = 1800) {
  const bins = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const p = i / (sampleCount - 1);
    if (p < 0.15) {
      bins[i] = 0.0;
    } else if (p < 0.40) {
      const ramp = (p - 0.15) / 0.25;
      bins[i] = Math.pow(Math.sin(ramp * Math.PI * 0.5), 2) * 0.85;
    } else if (p < 0.80) {
      const speechTime = (p - 0.40) * 10;
      const pulse = Math.pow(Math.sin(speechTime * 8), 4) * 0.75 + Math.sin(speechTime * 17) * 0.2;
      bins[i] = clamp01(Math.max(0.05, pulse));
    } else {
      const decay = (p - 0.80) / 0.20;
      bins[i] = Math.max(0.0, 0.7 * (1 - decay) * Math.exp(-decay * 3));
    }
  }
  return Array.from(bins);
}

function roundRect(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill();
  } else {
    ctx.fillRect(x, y, w, h);
  }
}

/* How long a SUCCESS notice stays on screen. Long enough to be read after
 * looking away from the press, short enough that it never becomes part of
 * the furniture. Errors do not expire at all -- see _setNotice. */
const NOTICE_TTL_MS = 30000;
/* A FAILED ACTION's banner: a recoverable error
 * -- an action that was refused or failed and can simply be tried again --
 * goes by itself after NOTICE_RECOVERABLE_MS, paused while the pointer is
 * on it or it has focus, and can be closed at once. The same message again
 * while it is up is counted, not stacked. A notice marked critical stays
 * until dismissed; the readiness banner (_renderProblems) keeps every
 * unresolved problem of the installation on screen regardless. On resume
 * a paused banner gets at least NOTICE_RESUME_MIN_MS to be read. */
const NOTICE_RECOVERABLE_MS = 12000;
const NOTICE_RESUME_MIN_MS = 3000;

/* Home Assistant's MediaPlayerEntityFeature bits, for the four transport
 * controls On Air offers. They are part of the media_player contract and
 * are named here rather than guessed at a call site; a player that does
 * not set its bit gets a disabled button that says so. */
/* A list of ids, defensively: every caller here is handling something a
 * websocket answered, and "no answer yet" must read as an empty list
 * rather than throw inside a render. */
function list_of(v) { return Array.isArray(v) ? v.filter(Boolean).map(String) : []; }

/* Whether two allow-lists mean the same thing. Order is not part of the
 * meaning, so a redraw that happens to sort differently is not an edit. */
function sameIds(a, b) {
  const x = list_of(a).slice().sort();
  const y = list_of(b).slice().sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

const MP_PAUSE = 1;
const MP_PREVIOUS_TRACK = 16;
const MP_NEXT_TRACK = 32;
const MP_PLAY = 16384;
/* media_player.SUPPORT_VOLUME_SET / _MUTE. Read from the PLAYER, never
 * assumed: a group, a browser player and an AirPlay speaker do not all
 * offer the same things. */
const MP_VOLUME_SET = 4;
const MP_VOLUME_MUTE = 8;
const HISTORY_TYPE = { dj_break: ["🎙", "DJ break"], news_intro: ["🎙", "News intro"],
                       news_bulletin: ["📰", "News"],
                       announcement: ["📣", "Announcement"] };

/* --- Broadcast Diagnostics: the backend's words, in the owner's --------
 * One table per enum the diagnostics routes answer with. A value a table
 * does not know (a stage added later) is shown as it came, never guessed
 * at; null is UNKNOWN or NOT RECORDED, never a negative. */
const DIAG_PAGE = 25;
const DIAG_OUTCOMES = [["", "All"], ["accepted", "Accepted"], ["fallback", "Fallback"],
                       ["rejected", "Rejected"], ["suppressed", "Suppressed"],
                       ["delivery_failure", "Delivery failure"], ["no_break_aired", "Not aired"]];
const DIAG_KINDS = [["dj_break", "DJ breaks"], ["news_intro", "News intros"],
                    ["announcement", "Announcements"], ["all", "Everything"]];
const DIAG_BADGE = { accepted: ["Accepted", "ok"], fallback: ["Fallback · floor", "warn"],
                     rejected: ["Rejected · silent", "muted"], suppressed: ["Suppressed", "muted"],
                     delivery_failure: ["Delivery failure", "danger"], program: ["Program", "muted"],
                     unknown: ["Unknown", "unknown"] };
const DIAG_STAGES = { pre_planner_gate: "Before the planner", planner_decision: "Planner decision",
  writer_generation: "Writer generation", planner_guard: "Planner guard",
  planner_validate: "Planner validation", render_required_hosting: "Render: owed hosting",
  render_writer_guard: "Render: writer guard", render_writer: "Render: writer",
  program_arbitration: "Program arbitration", queue_insert_gate: "Queue insert gate",
  on_air_playthrough: "On-air playthrough", passed_all: "Passed every check" };
/* the stages whose refusal could have recorded the words it refused */
const DIAG_SPAN_STAGES = ["planner_validate", "planner_guard", "render_required_hosting",
                          "render_writer_guard", "render_writer"];
const DIAG_DELIVERY = { completed: "completed on air", cut: "cut short on air", revoked: "revoked",
  missed: "missed", failed: "failed", insert_failed: "insert failed", suppressed: "suppressed",
  pending: "not finished: its row is still live" };
const DIAG_DELIVERED = { confirmed: ["confirmed", "ok"],
  aired_coverage_not_recorded: ["in aired copy · coverage not recorded", "unknown"],
  cut: ["cut short", "danger"], not_delivered: ["not delivered", "danger"],
  not_due: ["not due", "muted"] };
const DIAG_OBLIGATIONS = { station_time: ["Clock", "Time (station clock)"],
                           weather: ["Weather", "Weather"], calendar: ["Calendar", "Calendar"] };
const DIAG_WRITERS = { smart_planner: "Smart DJ", deterministic_fallback: "Station floor",
                       template_line: "Template line", deterministic_primary: "Built-in writer",
                       story_prepared: "Music story" };
const DIAG_SHAPES = {
  pre_9dd863e: "older record shape: no delivery verdict of the station's own; on a floor break, the aired words are read from the facts the floor says it used",
  "9dd863e": "newer record shape: the station's own delivery verdict" };

/* --- the voice library's three shelves, in the customer's words --------
 * The backend groups voices by which engine serves them; a person groups
 * them by where they came from. This is that translation, and the ONLY
 * place it happens -- the dropdown and the library both read it, so the
 * two can never disagree about where a voice lives. */
const VOICE_GROUPS = {
  ha: ["Home Assistant Voices",
       "Speech from your Home Assistant server. No extra hardware needed."],
  local: ["ParlorWave / Local Voices",
          "Curated DJ voices served by your ParlorWave voice engine."],
  mine: ["My Voices", "Voices made from your own recordings."],
  // the voice engine's own default sample: never the owner's voice
  engine: ["Voice engine", "The voice engine's own voice. It speaks until you choose another."],
};

/* The one thing this panel may say about where a recording is processed.
 * It is a statement of fact -- the engine the owner configured gets the
 * audio -- and deliberately NOT a privacy claim: a service on a private
 * address is still a service, and nothing in a hostname proves otherwise.
 * The backend sends the same sentence in cloning.processing; this is the
 * fallback for a shelf that has not arrived yet, never a second opinion. */
const PRIVACY_COPY =
  "Custom voices are processed by your configured ParlorWave voice engine.";

/* Where a recording is POSTED: an authenticated Home Assistant view owned
 * by this integration (custom_components/parlorwave_radio/http.py). Home
 * Assistant holds the service credential and forwards the bytes; this
 * script never learns the backend's address and never holds a key. */
const VOICE_SAMPLE_PATH = "/api/parlorwave_radio/voice_sample";
const BULLETIN_AUDIO_PATH = "/api/parlorwave_radio/bulletin_audio";
const MAX_SAMPLE_MB = 10;

/* --- Custom Voice Enrollment: recording in the Booth ---------------------
 * The microphone is opened by ONE thing: a press of Record. It is closed
 * by Stop, by Discard or Record again, by Cancel, by the recording cap, by
 * leaving the Booth, by the page being hidden, and by the panel going
 * away -- whichever comes first. Opening the Booth never asks for it.
 *
 * What the browser records (WebM/Ogg/MP4, whichever it can) is decoded and
 * written out as a 16-bit mono WAV at the voice engine's own rate IN THIS
 * BROWSER, before anything is sent, so the upload is the same WAV the
 * file path always accepted. Nothing is uploaded until Create voice. The
 * functions below are pure (no DOM, no audio APIs) so the rules they
 * encode are executed by ha/tests/test_panel_recorder.mjs rather than
 * read. */
const RECORD_SAMPLE_RATE = 24000;
/* What the Booth asks a person to read while the microphone is on: about
 * twenty seconds at an ordinary pace, a spread of sounds, nothing personal,
 * and the kind of thing a DJ says -- so the take sounds like the job. */
const RECORD_SCRIPT = "Good evening, and welcome back. It's a quiet night " +
  "here, and the music is still playing. Coming up, a few songs you might " +
  "remember, a quick look at the weather, and the news at the top of the " +
  "hour. If you're just tuning in, thanks for spending some time with us. " +
  "Stay right where you are: there's plenty more on the way.";
/* Where the guide beside the clock says "that is plenty": inside the
 * backend's own 10-30 second advice. */
const RECORD_GOOD_SECONDS = 20;
/* Why the chosen DJ voice is not the one a break would use
 * (voice_library.dj_voice_in_force), in words. */
const DJ_VOICE_NOT_IN_FORCE = {
  voice_missing: "its recording is gone",
  voice_identity_changed: "it now holds a different recording than the one you chose",
  voice_authorization_withdrawn: "it is no longer allowed to be the DJ",
};

/* The three DJ shifts (dj_context.SHIFTS) in words, and the one reason a
 * shift's voice can fail that is not a voice check: it cannot speak now. */
const DJ_SHIFT_LABELS = { morning: "Morning", afternoon: "Afternoon", night: "Night" };
const DJ_SHIFT_PROBLEMS = { voice_unavailable: "it cannot speak right now" };

/* What a voice may be used for (the backend's dj.voice_scopes), in words.
 * The value written back is always the token. */
const VOICE_SCOPE_LABELS = {
  dj: "The DJ",
  announcement: "Announcements",
  both: "DJ and announcements",
};
/* The level under which a stretch of a take counts as quiet room rather
 * than a voice -- the same -40 dB floor the backend's silence check uses. */
const TAKE_SILENCE_DB = -40;
/* How many samples may sit at full scale before a take is called clipped --
 * the backend's own CLIP_SAMPLE_COUNT (voice_sample_check). A browser's
 * automatic gain touches full scale for an instant on most takes; that is
 * not distortion, and one sample must never earn a warning. */
const TAKE_CLIP_SAMPLES = 2000;
/* A take with less speech than this in it (50 ms windows above the silence
 * floor, added up), or whose loudest moment is below TAKE_SILENT_PEAK_DB, is
 * SILENT and is blocked, not merely warned about. Edge and Chrome on a
 * Windows desktop can "record" with the microphone allowed and capture
 * nothing; a warning would let that take go on to the engine.
 * A quiet but real voice (about -34 dBFS) still passes with a warning. */
const TAKE_SPEECH_MIN_S = 1.5;
const TAKE_SILENT_PEAK_DB = -45;
/* While recording: this long with nothing near speech level, and the Booth
 * says so on the spot rather than after Stop. */
const LIVE_SILENCE_AFTER_S = 3;
const LIVE_SILENCE_DB = -50;

/* The Booth's work in progress, kept by the MODULE rather than the element.
 * Home Assistant takes a custom panel off the page once its tab has been
 * hidden for five minutes (suspendWhenHidden; on Windows a browser window
 * fully covered by another counts as hidden) and builds a NEW element when
 * the tab comes back. Every field of the old one goes with it: coming back
 * to On Air would find the form and the take gone. The
 * module is loaded once per page, so the next element picks the work up
 * from here. `saved` is filled by disconnectedCallback and taken, once, by
 * the next constructor; `micDeviceId` is the microphone the person chose. */
const BOOTH_SESSION = { saved: null, micDeviceId: "" };

/* The container a MediaRecorder is asked for: the first this browser says
 * it can make, or "" to let it choose. `supports` is
 * MediaRecorder.isTypeSupported (absent on old engines). */
function recorderMimeType(supports) {
  const wanted = ["audio/webm;codecs=opus", "audio/webm",
                  "audio/ogg;codecs=opus", "audio/mp4"];
  if (typeof supports !== "function") return "";
  for (const t of wanted) {
    try { if (supports(t)) return t; } catch (e) { /* not this one */ }
  }
  return "";
}

/* Several channels to one, by averaging. One channel passes through. */
function downmixToMono(channels) {
  const list = (channels || []).filter(Boolean);
  if (!list.length) return new Float32Array(0);
  if (list.length === 1) return Float32Array.from(list[0]);
  const n = Math.min(...list.map((c) => c.length));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (const c of list) sum += c[i];
    out[i] = sum / list.length;
  }
  return out;
}

/* What can be MEASURED about a take, for the review step: its length, its
 * loudest moment, and how much of it sits below the silence floor (in
 * 50 ms windows). Measurements, not a quality score. */
function measureTake(samples, rate) {
  const n = samples ? samples.length : 0;
  const seconds = rate > 0 ? n / rate : 0;
  let peak = 0, fullScale = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
    if (v >= 0.999) fullScale += 1;
  }
  const win = Math.max(1, Math.round((rate || 1) * 0.05));
  let windows = 0, quiet = 0, voiced = 0;
  for (let start = 0; start < n; start += win) {
    const end = Math.min(n, start + win);
    let sq = 0;
    for (let i = start; i < end; i++) sq += samples[i] * samples[i];
    const rms = Math.sqrt(sq / Math.max(1, end - start));
    const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    windows += 1;
    if (db < TAKE_SILENCE_DB) quiet += 1;
    else voiced += end - start;
  }
  return {
    seconds,
    peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
    silentFraction: windows ? quiet / windows : 1,
    voicedSeconds: rate > 0 ? voiced / rate : 0,
    fullScale,
  };
}

/* The loudest sample of one analyser frame, in dBFS (-Infinity for none). */
function frameLevelDb(frame) {
  let peak = 0;
  const n = frame ? frame.length : 0;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(frame[i]);
    if (v > peak) peak = v;
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/* The live meter's width, 0-100 %, for a level in dBFS: -60 dB and below is
 * empty, 0 dB is full. */
function meterPercent(db) {
  if (!(db > -60)) return 0;
  return Math.round(Math.min(100, (db + 60) / 60 * 100));
}

/* What the browser actually recorded, in one line the owner can read (and
 * read back to us): which microphone, at what rate, in what container, how
 * loud, and how much speech was heard. Every part is optional. */
function takeDiagnosis(d) {
  const x = d || {};
  const parts = [];
  if (x.label) parts.push(`Recorded from “${x.label}”`);
  if (x.rate) parts.push(`${Math.round(x.rate / 100) / 10} kHz`);
  if (x.mime) parts.push(String(x.mime).replace(/^audio\//, ""));
  if (x.peakDb !== undefined) {
    parts.push(x.peakDb === -Infinity ? "no sound at all"
      : `loudest ${Math.round(x.peakDb)} dB`);
  }
  if (x.voicedSeconds !== undefined) {
    parts.push(`speech heard ${(Math.round(x.voicedSeconds * 10) / 10).toFixed(1)} s`);
  }
  if (x.muted) parts.push("the system reported the microphone muted");
  return parts.join(" · ");
}

/* Said WHILE recording, once LIVE_SILENCE_AFTER_S has passed with nothing
 * near speech level (or at once when the system reports the track muted). */
function liveSilenceWords(input) {
  const x = input || {};
  const which = x.label ? `“${x.label}”` : "the microphone";
  if (x.muted) {
    return `The system reports ${which} as muted. Press Stop, unmute it or choose another microphone under Record, then record again.`;
  }
  return `No sound is reaching ${which}. If you are speaking, press Stop, then choose another microphone under Record or check its input level.`;
}

/* Why Home Assistant did not take a recording, in words. The upload view
 * answers every refusal of its own as {message}; anything else (a 401 from
 * Home Assistant's sign-in check, a proxy's 413, a 502) reaches here with no
 * message of ours, and "could not be used" said nothing about which. */
function uploadRefusal(status, body) {
  const said = body && typeof body.message === "string" && body.message.trim();
  if (said) return said;
  if (status === 401 || status === 403) {
    return "Home Assistant did not accept this page's sign-in, so nothing was sent. Reload the page, then try again.";
  }
  if (status === 413) {
    return "That recording is larger than Home Assistant accepts. A shorter clip, or an MP3, is well under the limit.";
  }
  if (status === 502 || status === 503 || status === 504) {
    return "ParlorWave Radio did not answer Home Assistant. Check that the service is running, then try again.";
  }
  return status ? `That recording could not be used: Home Assistant answered ${status}.`
    : "That recording could not be used.";
}

/* The review step's verdict on a take, from the backend's own bounds.
 * `block` problems keep Create disabled (there is nothing a voice engine
 * could do with them); `warn` ones are said, and the backend -- which
 * measures again -- has the final word. */
function takeProblem(m, minSeconds, maxSeconds) {
  const secs = Math.round((m && m.seconds) || 0);
  if (!m || !(m.seconds > 0.5) || m.peakDb === -Infinity) {
    return { block: true, code: "empty",
             message: "Nothing was recorded. Check that the right microphone is selected, then record again." };
  }
  if ((m.voicedSeconds !== undefined && m.voicedSeconds < TAKE_SPEECH_MIN_S)
      || m.peakDb < TAKE_SILENT_PEAK_DB) {
    return { block: true, code: "silent",
             message: "No speech reached the microphone: the take is almost silent. Choose the microphone you are speaking into (under Record) and check its input level, then record again." };
  }
  if (m.seconds < minSeconds) {
    return { block: true, code: "too_short",
             message: `That take is ${secs} seconds long. Record at least ${minSeconds} seconds of speech.` };
  }
  if (m.seconds > maxSeconds + 0.5) {
    return { block: true, code: "too_long",
             message: `That take is ${secs} seconds long. Keep it under ${maxSeconds} seconds.` };
  }
  if (m.silentFraction > 0.7) {
    return { block: false, code: "mostly_silence",
             message: "Most of that take is silence. Speak continuously for the whole recording." };
  }
  if (m.peakDb < -30) {
    return { block: false, code: "too_quiet",
             message: "That take is very quiet. Move closer to the microphone and record again." };
  }
  if (m.fullScale !== undefined ? m.fullScale > TAKE_CLIP_SAMPLES : m.peakDb > -0.1) {
    return { block: false, code: "clipping",
             message: "That take reaches full volume and may be distorted. A little further from the microphone is usually better." };
  }
  return null;
}

/* The line under the clock while recording, from the seconds so far and
 * the backend's minimum. */
function recordGuide(elapsed, minSeconds, goodSeconds) {
  const e = Math.max(0, Number(elapsed) || 0);
  if (e < minSeconds) {
    const left = Math.max(1, Math.ceil(minSeconds - e));
    return `Keep reading: at least ${left} more second${left === 1 ? "" : "s"}.`;
  }
  if (e < goodSeconds) return `Good. Keep going to about ${goodSeconds} seconds.`;
  return "That is plenty. Press Stop when you finish the sentence.";
}

/* What a chosen file IS, from its first bytes -- the same rule the backend
 * applies (magic bytes, never the file name): "wav", "mp3", "flac", a
 * browser container ("webm", "ogg", "mp4"), or "" for anything else. */
function sniffAudio(head) {
  const b = head || [];
  const at = (i, s) => [...s].every((ch, k) => b[i + k] === ch.charCodeAt(0));
  if (at(0, "RIFF") && at(8, "WAVE")) return "wav";
  if (at(0, "fLaC")) return "flac";
  if (at(0, "ID3") || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return "mp3";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
  if (at(0, "OggS")) return "ogg";
  if (at(4, "ftyp")) return "mp4";
  return "";
}

/* The review step's verdict on a CHOSEN FILE: the take's rules (same bounds,
 * same block/warn split), said about a file rather than a take, and a file
 * that is not WAV, MP3 or FLAC refused before it is measured. */
function fileProblem(kind, m, minSeconds, maxSeconds) {
  if (kind === "webm" || kind === "ogg" || kind === "mp4") {
    return { block: true, code: "unsupported_format",
             message: "That file is in a browser format (WebM, Ogg or MP4). Choose a WAV, MP3 or FLAC file, or record here instead." };
  }
  if (!kind) {
    return { block: true, code: "not_audio",
             message: "That file is not a WAV, MP3 or FLAC recording. Choose another file, or record here instead." };
  }
  if (!m) return null;
  const p = takeProblem(m, minSeconds, maxSeconds);
  if (!p) return null;
  const secs = Math.round(m.seconds || 0);
  const words = {
    empty: "That file has no sound in it. Choose another recording.",
    silent: "That file is almost silent: there is no speech in it to make a voice from. Choose another recording.",
    too_short: `That file is ${secs} seconds long. A voice needs at least ${minSeconds} seconds of speech.`,
    too_long: `That file is ${secs} seconds long. Choose one under ${maxSeconds} seconds, or trim it.`,
    mostly_silence: "Most of that file is silence. A voice needs continuous speech.",
    too_quiet: "That file is very quiet. A louder recording will make a better voice.",
    clipping: "That file reaches full volume and may be distorted.",
  };
  return { ...p, message: words[p.code] || p.message };
}

/* Float samples in [-1, 1] -> a canonical 16-bit PCM mono WAV. */
function encodeWav16(samples, rate) {
  const n = samples ? samples.length : 0;
  const bytes = new Uint8Array(44 + n * 2);
  const dv = new DataView(bytes.buffer);
  const ascii = (off, str) => { for (let i = 0; i < str.length; i++) bytes[off + i] = str.charCodeAt(i); };
  ascii(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); ascii(8, "WAVE");
  ascii(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ascii(36, "data"); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] || 0));
    dv.setInt16(44 + i * 2, v < 0 ? Math.round(v * 32768) : Math.round(v * 32767), true);
  }
  return bytes;
}

/* 7.4 -> "0:07". */
function clockOf(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/* Why the microphone did not open, in words a person can act on. The
 * browser's own error names are mapped, never shown. */
function micRefusal(err) {
  const name = (err && err.name) || "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return "Microphone access was blocked. Allow the microphone for Home Assistant in your browser, then press Record again, or choose a recording file instead.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") {
    return "No microphone was found. Connect one and press Record again, or choose a recording file instead.";
  }
  if (name === "NotReadableError" || name === "AbortError" || name === "TrackStartError") {
    return "The microphone could not be started. Another app may be using it.";
  }
  if (name === "NotSupportedError") return MIC_UNSUPPORTED;
  return "The microphone could not be started. You can choose a recording file instead.";
}
const MIC_NEEDS_SECURE = "This browser only allows the microphone on a secure (https) connection to Home Assistant. You can choose a recording file instead.";
const MIC_UNSUPPORTED = "This browser cannot record audio here. You can choose a recording file instead.";

/* The break-length entity stores the backend's own tokens. A screen shows
 * words; the value written back is still the token, so the settings
 * contract is untouched by the spelling on the button. */
const BREAK_LENGTH_LABELS = { short: "Short", normal: "Normal", long: "Long" };

/* --- the Parlorwave house palette -------------------------------------
 * Deep charcoal room, warm cream type, one restrained broadcast amber.
 * Every album-derived theme is a departure FROM this, and every failure
 * is a return TO it. Kept as data so the fallback is one object, not a
 * scattering of literals. */
const HOUSE_THEME = {
  accent: "#e0853c",            // broadcast amber: the one warm thing
  bg: "#131313",                // neutral charcoal -- the room is not brown
  bgDeep: "#090909",
  glow: "rgba(224,133,60,.22)",
  muted: "#b3b0ab",
  source: "house",
};
const ON_AIR_LAMP = "#ff4133";  // the lamp is always broadcast red, never album-derived

/* Palette extraction constants. The working image is deliberately tiny:
 * 32x32 is 1024 samples, which is plenty to find a dominant colour and
 * cheap enough for a Raspberry Pi browser. */
const ART_SAMPLE = 32;
const ART_CACHE_MAX = 24;
const ART_DARK_FLOOR = 0.09;    // below this a pixel is "the dark of the sleeve"
const ART_LIGHT_CEIL = 0.93;    // above it, paper white
const ART_SAT_FLOOR = 0.12;     // below it, no usable hue: keep the house accent
const ART_MIN_CONTRAST = 3.0;   // accent vs its own background (WCAG non-text)
const ART_WARM_CENTRE = 25;     // degrees: the middle of the orange band
const ART_WARM_SPAN = 75;       // how far the damping reaches either side
const ART_WARM_DAMPING = 0.22;  // how much warm ROOMS are pulled back
/* An accent may be STRENGTHENED, never manufactured. The minimum
 * saturation an accent is lifted to ramps in with the saturation actually
 * present, between the floor where a hue starts counting and the point
 * where the sleeve is unambiguously coloured. A mostly grey sleeve with a
 * faint green cast has just enough tint to pass the floor, and a flat
 * minimum would turn it into mint. */
const ART_ACCENT_SAT_MIN = 0.18;    // what a barely-tinted sleeve earns
const ART_ACCENT_SAT_FULL = 0.45;   // what an unambiguously coloured one earns
const ART_SAT_CONFIDENT = 0.40;     // where the ramp reaches full

/* --- album palette: pure maths -----------------------------------------
 * No DOM in here on purpose. The panel feeds it a pixel array and gets a
 * theme back, which means the interesting half (what counts as a usable
 * colour, and how far a generated colour may travel before it stops being
 * readable) is testable without a browser. Exported for exactly that.
 */

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb;
  if (h < 60) rgb = [c, x, 0]; else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x]; else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c]; else rgb = [c, 0, x];
  return rgb.map((v) => Math.round((v + m) * 255));
}

function hex(rgb) {
  return "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v)))
    .toString(16).padStart(2, "0")).join("");
}

/* WCAG relative luminance and contrast ratio: the only honest way to keep
 * a generated colour readable instead of hoping. */
function relLuminance(r, g, b) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrastRatio(a, b) {
  const la = relLuminance(a[0], a[1], a[2]), lb = relLuminance(b[0], b[1], b[2]);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/* One prominent, USABLE colour from a small RGBA array.
 *
 * Not an average: averaging a sleeve returns mud, because opposite hues
 * cancel. Pixels are dropped when they carry no useful colour (transparent,
 * the near-black of a dark sleeve, paper white), grouped into coarse
 * hue/saturation/lightness buckets so "several blues" count as one blue,
 * and the winning bucket is the one that is both COMMON and USABLE --
 * frequency weighted by how saturated it is and how close its lightness
 * sits to the middle, where a colour can still be seen against a dark
 * room. Returns null when a sleeve genuinely offers nothing (all black,
 * all white, fully transparent). */
function dominantFromPixels(data, opts) {
  const o = opts || {};
  const darkFloor = o.darkFloor == null ? ART_DARK_FLOOR : o.darkFloor;
  const lightCeil = o.lightCeil == null ? ART_LIGHT_CEIL : o.lightCeil;
  const buckets = new Map();
  let considered = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 128) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const { h, s, l } = rgbToHsl(r, g, b);
    if (l < darkFloor || l > lightCeil) continue;
    considered++;
    const key = `${Math.floor(h / 15)}:${Math.min(2, Math.floor(s * 3))}:${Math.min(3, Math.floor(l * 4))}`;
    let bk = buckets.get(key);
    if (!bk) { bk = { n: 0, r: 0, g: 0, b: 0 }; buckets.set(key, bk); }
    bk.n++; bk.r += r; bk.g += g; bk.b += b;
  }
  if (!considered) return null;
  let best = null, bestScore = -1;
  for (const bk of buckets.values()) {
    const r = bk.r / bk.n, g = bk.g / bk.n, b = bk.b / bk.n;
    const { s, l } = rgbToHsl(r, g, b);
    // usefulness peaks mid-lightness; a colour at either extreme cannot
    // carry a progress bar against a dark room
    const useful = Math.max(0.15, 1 - Math.abs(l - 0.5) * 1.4);
    const score = (bk.n / considered) * (0.35 + 0.65 * s) * useful;
    if (score > bestScore) { bestScore = score; best = { r, g, b, s, l, share: bk.n / considered }; }
  }
  if (!best) return null;
  return { rgb: [Math.round(best.r), Math.round(best.g), Math.round(best.b)],
           sat: best.s, lum: best.l, share: best.share };
}

/* A theme from one colour: an accent that stays readable, a room two
 * shades darker than the record, and a glow. The clamps are the product
 * rule -- the room changes, the contract that the interface stays legible
 * does not. A sleeve with no usable hue keeps the house accent and still
 * tints the room, which is why a black-and-white cover feels different
 * from a blue one without pretending to have a colour it does not. */
/* How warm a hue is, 1 at the centre of the orange band and 0 outside it.
 *
 * Warm tints read heavier than cool ones at the same saturation: a blue
 * room at 30% still looks like light on a wall, an orange room at 30%
 * looks like brown paint. The ROOM is damped across that band so a warm
 * record changes the lighting instead of repainting the interface. The
 * accent is never damped -- a red sleeve should still give a red progress
 * bar. */
function warmth(h) {
  const diff = Math.abs((((h - ART_WARM_CENTRE) % 360) + 540) % 360 - 180);
  return Math.max(0, 1 - diff / ART_WARM_SPAN);
}

function themeFrom(dominant) {
  if (!dominant || !dominant.rgb) return Object.assign({}, HOUSE_THEME);
  const [r, g, b] = dominant.rgb;
  const { h, s } = rgbToHsl(r, g, b);
  const colourful = s >= ART_SAT_FLOOR;
  // the room: album-derived, damped where the hue is warm, and always deep
  // enough to read cream on. With no usable hue it is neutral charcoal --
  // a sleeve that has no colour must not tint the room brown.
  const damp = 1 - ART_WARM_DAMPING * warmth(h);
  const roomHue = colourful ? h : 0;
  const bgRgb = hslToRgb(roomHue, colourful ? Math.min(0.32, s * 0.55) * damp : 0, 0.075);
  const deepRgb = hslToRgb(roomHue, colourful ? Math.min(0.24, s * 0.4) * damp : 0, 0.038);
  let accentRgb;
  if (colourful) {
    // the lift a weak hue is allowed grows with the hue that is there
    const lift = ART_ACCENT_SAT_MIN + (ART_ACCENT_SAT_FULL - ART_ACCENT_SAT_MIN)
      * Math.min(1, (s - ART_SAT_FLOOR) / (ART_SAT_CONFIDENT - ART_SAT_FLOOR));
    const accentS = Math.max(lift, Math.min(0.95, s * 1.15));
    let accentL = Math.max(0.5, Math.min(0.68, dominant.lum || 0.56));
    accentRgb = hslToRgb(h, accentS, accentL);
    // walk it lighter until it clears the contrast floor against its room
    for (let i = 0; i < 12 && contrastRatio(accentRgb, bgRgb) < ART_MIN_CONTRAST; i++) {
      accentL = Math.min(0.82, accentL + 0.03);
      accentRgb = hslToRgb(h, accentS, accentL);
    }
  } else {
    accentRgb = [224, 133, 60];     // the house amber: an honest "no hue here"
  }
  const mutedRgb = hslToRgb(roomHue, colourful ? Math.min(0.25, s * 0.4) * damp : 0.02, 0.7);
  return {
    accent: hex(accentRgb),
    bg: hex(bgRgb),
    bgDeep: hex(deepRgb),
    glow: `rgba(${accentRgb[0]},${accentRgb[1]},${accentRgb[2]},.22)`,
    muted: hex(mutedRgb),
    source: colourful ? "artwork" : "artwork-neutral",
    contrast: Math.round(contrastRatio(accentRgb, bgRgb) * 100) / 100,
  };
}

function themeFromPixels(data) {
  try {
    return themeFrom(dominantFromPixels(data));
  } catch (e) {
    return Object.assign({}, HOUSE_THEME);
  }
}

/* --- synced lyrics: following the song without moving the page ----------
 *
 * THE BUG THIS REPLACES. The active line used to be revealed with
 * `element.scrollIntoView({block:"center"})`. That call is not scoped to
 * the lyric pane: it scrolls EVERY scrollable ancestor until the element
 * is in view, and inside a Home Assistant panel the outermost of those is
 * the page itself. So each new lyric -- one every few seconds -- dragged
 * the whole panel back down to the lyric pane. A person who scrolled up
 * to reach the tabs was pulled away from them mid-reach, and the only way
 * to navigate was to turn Lyrics off.
 *
 * The replacement is arithmetic on ONE element's scrollTop. Nothing
 * outside the pane can move, because nothing outside the pane is
 * addressed, and no element is ever focused to reveal it.
 *
 * Kept pure (no DOM, no browser) so the rules below are executed by
 * ha/tests/test_lyrics.mjs rather than merely described.
 */

/* How long a smooth scroll is allowed to take. Scroll events inside this
 * window after an auto-scroll are the animation, not a reader. */
const LYRIC_SMOOTH_MS = 700;

/* WHERE THE ACTIVE LINE SITS in the pane, as a fraction of its height.
 * Just below the middle: the lines already sung stay visible above it,
 * which is what a reader glancing back wants, and the next few are still
 * on screen below. Dead centre reads as slightly too high in a short pane
 * and 0.5 is the only other number anyone would reach for, so the choice
 * is written down rather than left as a literal in the arithmetic. */
const LYRIC_ANCHOR = 0.55;

/* Where the pane must be scrolled to put `line` at the anchor, clamped to
 * the pane's own travel. Returns an integer scrollTop and never a negative
 * one; a pane taller than its content yields 0. */
function lyricScrollTop({ paneHeight, contentHeight, lineTop, lineHeight,
                          anchor = LYRIC_ANCHOR }) {
  const travel = Math.max(0, contentHeight - paneHeight);
  const placed = lineTop - (paneHeight * anchor) + (lineHeight / 2);
  return Math.round(Math.min(travel, Math.max(0, placed)));
}

/* WHEN TO MOVE THE PANE AT ALL, and the answer is: almost never.
 *
 * The rule this replaces tried to be clever. Following stopped while the
 * reader was parked away from the song and resumed by itself once the song
 * caught up -- no button, no stuck state. It was wrong for two
 * reasons that only a running panel shows:
 *
 *   * it was consulted on EVERY tick, so the pane was a candidate for
 *     movement once a second whether or not anything had changed; and
 *   * "the song caught up" is indistinguishable from "the reader is still
 *     reading three lines further down", so it took the pane back off them
 *     without being asked.
 *
 * The rule now: move ONLY when following is on AND the active line is not
 * the line we last moved for. A refresh does not change the active line, so
 * a refresh does not scroll. Following is turned off by the reader touching
 * the pane and back on by the reader pressing Follow lyrics -- both
 * deliberate, neither guessed at.
 */
function shouldAutoScroll({ line, lastScrolledFor, following }) {
  if (!following) return false;
  if (line == null || line < 0) return false;
  return line !== lastScrolledFor;
}

export const PW_PALETTE = {
  rgbToHsl, hslToRgb, hex, relLuminance, contrastRatio,
  dominantFromPixels, themeFrom, themeFromPixels,
  HOUSE_THEME, ART_SAMPLE, ART_SAT_FLOOR, ART_MIN_CONTRAST,
};

export const PW_LYRICS = { lyricScrollTop, shouldAutoScroll, LYRIC_ANCHOR };
export const PW_RECORDER = { recorderMimeType, downmixToMono, measureTake,
                             takeProblem, encodeWav16, clockOf, micRefusal,
                             RECORD_SAMPLE_RATE, TAKE_SILENCE_DB, TAKE_CLIP_SAMPLES,
                             VOICE_SCOPE_LABELS, MIC_NEEDS_SECURE,
                             MIC_UNSUPPORTED, RECORD_SCRIPT, RECORD_GOOD_SECONDS,
                             recordGuide, sniffAudio, fileProblem,
                             TAKE_SPEECH_MIN_S, TAKE_SILENT_PEAK_DB, frameLevelDb,
                             meterPercent, takeDiagnosis, liveSilenceWords, uploadRefusal,
                             BOOTH_SESSION, LIVE_SILENCE_AFTER_S, LIVE_SILENCE_DB };
export const PW_MOUTH = { mouthOpening, mouthLens, MOUTH_STILL, MOUTH_ALPHA,
                          MOUTH_MUSIC, MOUTH_PROGRAM_VOICE, MOUTH_IDLE,
                          MOUTH_LABELS, MOUTH_FPS, MOUTH_FRAME_MS, MOUTH_COLUMNS,
                          waveformAmplitude, smoothAmplitude, mouthWaveformOpen, demoWaveformBins,
                          musicWaveformOpen, MUSIC_SILENCE_GATE, MUSIC_CURVE_EXP,
                          MUSIC_SLOW_MS, MUSIC_RIPPLE,
                          WAVEFORM_RETRY_MS, WAVEFORM_MAX_RETRIES, WAVEFORM_REFRESH_MIN_MS,
                          WAVEFORM_MAX_REFRESHES, SMOOTH_MAX_DT_S, WAVEFORM_CONFIRM_MS };

/* THE STYLESHEET, ONCE. It has no interpolation, so it is parsed once per
 * panel and never again: the tree a render rebuilds is the document
 * INSIDE #pw-app, not the stylesheet or the two live regions beside it. */
const PANEL_STYLE = `
      <style>
        /* --- Parlorwave house palette -----------------------------------
         * A dark control room, warm cream type, one broadcast amber. The
         * --pw-art-* properties are set on the HOST when a sleeve yields a
         * theme; every rule below names a house value as its fallback, so
         * the interface is complete and readable before any artwork is
         * sampled and stays that way if none ever is. */
        :host {
          display:block;
          /* EVERY NATIVE CONTROL IN THIS PANEL IS DARK, declared once.
             An opened <select> menu is drawn by the BROWSER, not by page
             CSS -- no selector reaches inside a popup, which is why the
             closed control matched the room and the open one was a white
             sheet with grey text. What the browser does honour is the
             color-scheme property, and it was never set, so every popup,
             every scrollbar and every spinner fell back to light.

             Declared on :host so it inherits to the whole shadow tree and
             a control added later is dark by construction rather than by
             being remembered. The checkbox rule below found the same bug
             one control at a time; this is that fix, generalised. */
          color-scheme:dark;
          --pw-bg: var(--pw-art-bg, #131313);
          --pw-bg-deep: var(--pw-art-bg-deep, #090909);
          --pw-accent: var(--pw-art-accent, #e0853c);
          --pw-glow: var(--pw-art-glow, rgba(224,133,60,.22));
          --pw-muted: var(--pw-art-muted, #b3b0ab);
          --pw-text: #f4efe6;
          --pw-dim: #9d958a;
          --pw-surface: rgba(255,255,255,.05);
          --pw-surface-2: rgba(255,255,255,.08);
          --pw-line: rgba(255,255,255,.10);
          --pw-lamp: #ff4133;
          color:var(--pw-text);
          background:
            radial-gradient(120% 80% at 50% -10%, var(--pw-glow), transparent 60%),
            linear-gradient(180deg, var(--pw-bg) 0%, var(--pw-bg-deep) 100%);
          background-attachment:fixed;
          min-height:100%;
          font-family:var(--paper-font-body1_-_font-family, "Inter", system-ui, sans-serif);
          transition:background 800ms ease;
        }
        .wrap { max-width:1120px; margin:0 auto; padding:14px 18px 40px; }
        * { box-sizing:border-box; }

        /* --- masthead ---------------------------------------------------- */
        header { display:flex; align-items:center; gap:16px; padding:10px 2px 18px; flex-wrap:wrap; }
        .brand { display:flex; align-items:center; gap:10px; flex:1; min-width:0; }
        .brand-name { font-size:1.05em; letter-spacing:.18em; text-transform:uppercase;
                      color:var(--pw-dim); white-space:nowrap; }
        .brand-name b { color:var(--pw-text); font-weight:600; }
        .brand-lamp { width:9px; height:9px; border-radius:50%; flex:none;
                      background:rgba(255,255,255,.16); box-shadow:none; transition:background 500ms, box-shadow 500ms; }
        .brand-lamp.lit { background:var(--pw-lamp); box-shadow:0 0 10px var(--pw-lamp); }
        nav { display:flex; gap:4px; flex-wrap:wrap; }
        nav button { background:none; border:none; color:var(--pw-dim); font-size:.95em;
                     letter-spacing:.06em; text-transform:uppercase; padding:10px 14px;
                     min-height:44px; cursor:pointer; border-radius:10px; }
        nav button:hover { color:var(--pw-text); background:var(--pw-surface); }
        nav button.active { color:var(--pw-text); background:var(--pw-surface-2);
                     box-shadow:inset 0 -2px 0 var(--pw-accent); transition:box-shadow 700ms ease; }
        nav button:focus-visible, button:focus-visible, select:focus-visible,
        input:focus-visible, label:focus-visible { outline:2px solid var(--pw-accent); outline-offset:2px; }

        /* --- the stage (On Air) ------------------------------------------ */
        .stage { position:relative; border-radius:20px; padding:22px; margin-bottom:16px;
                 background:var(--pw-surface); border:1px solid var(--pw-line); overflow:hidden; }
        .stage-glow { position:absolute; inset:-40% 30% 40% -20%; pointer-events:none;
                 background:radial-gradient(closest-side, var(--pw-glow), transparent 70%);
                 transition:background 800ms ease; }
        .stage-grid { position:relative; display:grid; grid-template-columns:minmax(0,340px) minmax(0,1fr);
                 gap:30px; align-items:center; }
        .art-wrap { position:relative; aspect-ratio:1/1; width:100%; }
        .art { width:100%; height:100%; border-radius:14px; object-fit:cover; display:block;
               box-shadow:0 18px 40px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.06); }
        .art-empty { display:flex; align-items:center; justify-content:center; font-size:3em;
               background:rgba(255,255,255,.04); color:var(--pw-dim); }
        /* A DJ break's sleeve: the radio's own face (see _renderDjArt). The
           cabinet finish and the cloth come from the console's faceplate
           rules; the script is the badge's brass. Sizes follow the tile,
           with a fixed size first for a browser without container units. */
        .art-dj { position:relative; overflow:hidden; box-sizing:border-box;
                  container-type:inline-size; border:2px solid rgba(255,255,255,.08); }
        .art-dj-cloth { position:absolute; inset:8%; border-radius:12px;
                        display:flex; flex-direction:column; align-items:center;
                        justify-content:center; gap:7%; }
        .art-dj-script { font-size:2.3rem; font-size:13cqw; padding:0 .12em; white-space:nowrap; }
        /* an engraved appliance plate: brushed brass, two pins, letters cut
           in, raised off the cloth on the same light as the script */
        .art-dj-plate { position:relative; font-size:.78rem; font-size:4.4cqw; font-weight:700;
                        letter-spacing:.32em; text-transform:uppercase; white-space:nowrap;
                        padding:.5em 1.7em .5em 2em; border-radius:3px; color:#3a2410;
                        text-shadow:0 1px 0 rgba(255,236,200,.55);
                        background:linear-gradient(180deg, #f6dca6 0%, #d9a65c 48%, #a8722e 52%, #e2b670 100%);
                        box-shadow:inset 0 1px 0 rgba(255,246,225,.7), inset 0 -1px 0 rgba(70,36,6,.6),
                                   0 2px 1px rgba(0,0,0,.6), 0 5px 8px rgba(0,0,0,.45); }
        .art-dj-plate::before, .art-dj-plate::after {
                        content:""; position:absolute; top:50%; width:.42em; height:.42em;
                        margin-top:-.21em; border-radius:50%;
                        background:radial-gradient(circle at 35% 35%, #fff4d8 0%, #b98a46 55%, #5a3812 100%);
                        box-shadow:0 0 0 1px rgba(70,36,6,.45); }
        .art-dj-plate::before { left:.6em; }
        .art-dj-plate::after { right:.6em; }
        .stage-meta { min-width:0; }

        .state-line { display:flex; align-items:center; gap:9px; flex-wrap:wrap;
               font-size:.8em; letter-spacing:.16em; text-transform:uppercase; color:var(--pw-dim);
               margin-bottom:10px; }
        .state-label { color:var(--pw-text); font-weight:600; }
        .state-line.onair .state-label { color:var(--pw-lamp); }
        .state-line.alert .state-label { color:#ffb4a8; }
        .state-line.setup .state-label { color:var(--pw-accent); }
        .state-line.setup .state-action { letter-spacing:.08em; }
        .state-line.setup .state-action button { font-weight:600; text-transform:none; letter-spacing:normal; }
        .state-detail { color:var(--pw-dim); letter-spacing:.08em; }
        .state-detail::before { content:"· "; }
        .lamp { width:9px; height:9px; border-radius:50%; background:var(--pw-lamp);
               box-shadow:0 0 10px var(--pw-lamp); flex:none; animation:pulse 2.4s ease-in-out infinite; }
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.45; } }

        /* the record's name, not a section heading: overrides the h2 rule
           it shares a tag with, so it stays sentence case and full weight */
        h2.track-title { font-size:2.1em; line-height:1.12; font-weight:600; margin:0 0 6px;
               overflow-wrap:anywhere; letter-spacing:-.01em; text-transform:none;
               color:var(--pw-text); }
        .track-sub { color:var(--pw-muted); font-size:1.05em; margin-bottom:16px; overflow-wrap:anywhere;
               transition:color 700ms ease; }
        .track-album { color:var(--pw-dim); }
        .progress { display:flex; align-items:center; gap:12px; margin:0 0 14px; }
        .progress-bar { flex:1; height:4px; border-radius:3px; overflow:hidden; background:rgba(255,255,255,.12); }
        #progress-fill { height:100%; background:var(--pw-accent); transition:width 1s linear, background 700ms ease; }
        .progress-clock { color:var(--pw-dim); font-size:.8em; white-space:nowrap;
               font-variant-numeric:tabular-nums; }
        .facts { display:flex; flex-wrap:wrap; gap:7px; margin-bottom:16px; }
        .chip { background:var(--pw-surface); border:1px solid var(--pw-line); border-radius:999px;
                padding:5px 12px; font-size:.82em; color:var(--pw-muted); transition:color 700ms ease; }
        .chip b { color:var(--pw-dim); font-weight:500; letter-spacing:.05em;
                text-transform:uppercase; font-size:.85em; margin-right:5px; }
        /* A reference to one of our own screens, inside our own prose. It
           reads as part of the sentence and behaves as a button. */
        .spk-pick { display:flex; align-items:center; gap:10px; padding:9px 4px; min-height:44px;
                    cursor:pointer; border-radius:8px; }
        .spk-pick:hover { background:var(--pw-surface); }
        /* color-scheme is inherited from :host now (that is the global fix
           this rule's own bug led to); accent-color still has to be said,
           because it paints the CHECKED fill and has no house default. */
        .spk-pick input { width:18px; height:18px; flex:none;
                          accent-color:var(--pw-accent); }
        .inlink { background:none; border:none; padding:0; font:inherit; cursor:pointer;
                  color:var(--pw-accent); text-decoration:underline;
                  text-underline-offset:2px; transition:color 700ms ease; }
        .inlink:hover { color:var(--pw-text); }
        .stage-actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
        /* The transport cluster sits with the record it controls. A
           disabled control stays VISIBLE and keeps its tooltip -- the
           reason a button cannot be pressed is information. */
        .transport { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
        .tsep { width:1px; height:22px; background:var(--pw-line); margin:0 4px; flex:none; }
        .transport .icon { font-size:1.05em; }
        .transport .icon:disabled { opacity:.32; cursor:not-allowed; }

        /* --- the Broadcast Console -----------------------------------------
           ONE OBJECT under the stage: the DJ control, the Mouth and the
           speaker control on one deck, the Air Check on the strip beneath.
           A chassis rather than a card -- a shade darker than the room,
           with a bezel line and a lip of light along its top -- so the
           controls read as mounted on it, not floating in it.

           Its lamps are AMBER. Red on this screen means one thing, ON AIR,
           and the console never borrows it for "enabled": a lit DJ control
           is a standing arrangement, and the colour says so. */
        /* --- the Broadcast Console Cabinet & Swappable Grille Faceplates --- */
        .console { position:relative; border-radius:24px; margin-bottom:16px;
                   overflow:hidden;
                   background:linear-gradient(180deg, #181716 0%, #121110 50%, #0d0c0b 100%);
                   border:2px solid rgba(255,255,255,.08);
                   box-shadow:0 16px 40px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.10);
                   transition:background .4s ease, border-color .4s ease, box-shadow .4s ease; }

        /* Outer Cabinet wood/chassis finishes matching the design */
        .console[data-fp="midnight"], .art-dj[data-fp="midnight"] {
          background:linear-gradient(180deg, #1a1918 0%, #121110 50%, #0a0908 100%);
          border-color:#2a2826;
          box-shadow:0 16px 40px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.10);
        }
        .console[data-fp="tweed"], .art-dj[data-fp="tweed"] {
          background:linear-gradient(180deg, #543620 0%, #3b2314 45%, #24140a 100%);
          border-color:#6e4628;
          box-shadow:0 16px 40px rgba(0,0,0,.65), inset 0 1px 1px rgba(255,215,170,.3), inset 0 -2px 4px rgba(0,0,0,.8);
        }
        .console[data-fp="heather"], .art-dj[data-fp="heather"] {
          background:linear-gradient(180deg, #2c3038 0%, #1c1e24 50%, #121316 100%);
          border-color:#3e4450;
          box-shadow:0 16px 40px rgba(0,0,0,.55), inset 0 1px 1px rgba(255,255,255,.18);
        }
        .console[data-fp="linen"], .art-dj[data-fp="linen"] {
          background:linear-gradient(180deg, #503722 0%, #382415 50%, #24150a 100%);
          border-color:#69482c;
          box-shadow:0 16px 40px rgba(0,0,0,.6), inset 0 1px 1px rgba(255,225,185,.25);
        }
        .console[data-fp="retro"], .art-dj[data-fp="retro"] {
          background:linear-gradient(180deg, #4c2915 0%, #341a0d 50%, #200f06 100%);
          border-color:#66381c;
          box-shadow:0 16px 40px rgba(0,0,0,.6), inset 0 1px 1px rgba(255,210,160,.25);
        }

        /* Inset Acoustic Grille Faceplate (The physical fabric grille cloth)
           ONE RECESSED SURFACE, lit from above. The cloth is stretched
           behind the cabinet's opening, so every edge tucks under the wood:
           the top trim throws the deepest shadow, the sides and the bottom a
           shallower one. Nothing is cast OUTWARD -- a drop shadow under the
           cloth is what made its lower half read as a raised panel sitting
           on the wood. Outside the opening, the lower trim's lip catches the
           light and the upper one is in shade. */
        .console-faceplate { position:relative; width:calc(100% - 24px); margin:12px auto 0;
                             border-radius:16px; overflow:hidden; user-select:none;
                             container-type:inline-size;
                             transition:background .4s ease, box-shadow .4s ease; }
        .console-faceplate, .art-dj-cloth {
                             box-shadow:inset 0 5px 14px rgba(0,0,0,.85),
                                        inset 0 -4px 9px rgba(0,0,0,.55),
                                        inset 5px 0 10px -5px rgba(0,0,0,.6),
                                        inset -5px 0 10px -5px rgba(0,0,0,.6),
                                        inset 0 0 0 1.5px rgba(0,0,0,.65),
                                        0 1px 0 rgba(255,236,210,.13),
                                        0 -1px 0 rgba(0,0,0,.5); }

        /* 1. Midnight Black: Dark woven acoustic cloth */
        .console-faceplate.console-fp-midnight, .art-dj-cloth.console-fp-midnight {
          background-color:#121110;
          background-image:radial-gradient(circle at 50% 15%, rgba(255,255,255,.05) 0%, transparent 65%),
                           repeating-linear-gradient(0deg, rgba(255,255,255,.04) 0, rgba(255,255,255,.04) 1px, transparent 1px, transparent 3px),
                           repeating-linear-gradient(90deg, rgba(0,0,0,.4) 0, rgba(0,0,0,.4) 1px, transparent 1px, transparent 3px);
        }

        /* 2. Walnut Tweed: Authentic vintage guitar amp / radio diagonal woven tweed cloth */
        .console-faceplate.console-fp-tweed, .art-dj-cloth.console-fp-tweed {
          background-color:#483422;
          background-image:repeating-linear-gradient(45deg, rgba(218,170,115,.48) 0, rgba(218,170,115,.48) 2px, transparent 2px, transparent 6px),
                           repeating-linear-gradient(-45deg, rgba(145,100,60,.42) 0, rgba(145,100,60,.42) 2px, transparent 2px, transparent 6px),
                           repeating-linear-gradient(90deg, rgba(0,0,0,.35) 0, rgba(0,0,0,.35) 1px, transparent 1px, transparent 3px),
                           radial-gradient(ellipse at 50% 20%, rgba(255,215,150,.18) 0%, transparent 70%);
        }

        /* 3. Heather Gray: Real salt-and-pepper woven textile acoustic cloth */
        .console-faceplate.console-fp-heather, .art-dj-cloth.console-fp-heather {
          background-color:#363942;
          background-image:repeating-linear-gradient(0deg, rgba(255,255,255,.22) 0, rgba(255,255,255,.22) 1.5px, transparent 1.5px, transparent 4px),
                           repeating-linear-gradient(90deg, rgba(0,0,0,.45) 0, rgba(0,0,0,.45) 1.5px, transparent 1.5px, transparent 4px),
                           radial-gradient(circle at 50% 50%, rgba(210,220,235,.25) 1px, transparent 1px),
                           radial-gradient(ellipse at 50% 15%, rgba(255,255,255,.10) 0%, transparent 65%);
          background-size:auto, auto, 4px 4px, auto;
        }

        /* 4. Sand Linen: Natural warm oatmeal / cream woven linen acoustic cloth */
        .console-faceplate.console-fp-linen, .art-dj-cloth.console-fp-linen {
          background-color:#635443;
          background-image:repeating-linear-gradient(0deg, rgba(238,222,198,.48) 0, rgba(238,222,198,.48) 1.5px, transparent 1.5px, transparent 5px),
                           repeating-linear-gradient(90deg, rgba(60,48,35,.50) 0, rgba(60,48,35,.50) 1.5px, transparent 1.5px, transparent 5px),
                           radial-gradient(ellipse at 50% 20%, rgba(255,245,225,.20) 0%, transparent 70%);
        }

        /* 5. Retro Pattern: 1970s vintage plaid checkered acoustic grille cloth */
        .console-faceplate.console-fp-retro, .art-dj-cloth.console-fp-retro {
          background-color:#3b2516;
          background-image:repeating-linear-gradient(0deg, rgba(240,162,74,.42) 0, rgba(240,162,74,.42) 2px, transparent 2px, transparent 16px),
                           repeating-linear-gradient(90deg, rgba(240,162,74,.42) 0, rgba(240,162,74,.42) 2px, transparent 2px, transparent 16px),
                           repeating-linear-gradient(0deg, rgba(82,98,58,.35) 4px, rgba(82,98,58,.35) 8px, transparent 8px, transparent 16px),
                           repeating-linear-gradient(90deg, rgba(82,98,58,.35) 4px, rgba(82,98,58,.35) 8px, transparent 8px, transparent 16px),
                           repeating-linear-gradient(0deg, rgba(0,0,0,.60) 0, rgba(0,0,0,.60) 3px, transparent 3px, transparent 8px);
        }
        .console-deck { display:grid; align-items:start; justify-content:space-between; justify-items:center; gap:20px;
                        grid-template-columns:170px 1fr 170px;
                        max-width:1020px; margin:0 auto;
                        padding:24px 24px 22px; }
        .console-dj, .console-spk { min-width:0; }
        .pw-knob-unit { display:flex; flex-direction:column; align-items:center;
                        text-align:center; width:170px; position:relative; }

        /* --- the knobs' reach. An invisible halo about 1.6 times the
           visible knob, part of the button, so hovering or pressing it lights
           the knob exactly as the knob itself does. Never wider than the
           knob's own column (the unit is the container), so the two halos
           never meet, even at 360 px. Its outer ring lets a vertical swipe
           scroll the page on a touch screen; the visible knob takes every
           direction. Nothing is drawn: the knobs look exactly as before. */
        .pw-knob-unit { container-type:inline-size; }
        .knob-halo { position:absolute; left:50%; top:50%; z-index:0;
                     width:160%; width:min(160%, calc(100cqw - 8px));
                     height:auto; aspect-ratio:1 / 1; border-radius:50%;
                     transform:translate(-50%, -50%); background:transparent;
                     touch-action:pan-y; }
        .dj-switch, .right-knob { touch-action:pan-y; }
        .dj-face, .knob-face { touch-action:none; }

        .knob-housing { position:relative; width:154px; height:154px; flex:none;
                        display:flex; align-items:center; justify-content:center;
                        transform-origin:center center;
                        transform:scaleY(var(--eye-scale-y, 1));
                        transition:transform .32s cubic-bezier(0.25, 1, 0.5, 1); }
        .knob-housing.eye-blinking {
          transform:scaleY(0.06) !important;
          transition:transform .06s ease-in !important;
        }
        .knob-ticks { position:absolute; inset:0; width:100%; height:100%;
                      pointer-events:none; overflow:visible; z-index:3;
                      filter:drop-shadow(0 1px 2px rgba(0,0,0,.8)); }
        .knob-ticks line { stroke-linecap:round; transition:stroke .3s ease, opacity .3s ease; }
        .knob-ticks .tick-minor { stroke:var(--pw-accent); opacity:.38; stroke-width:1.25px; }
        .knob-ticks .tick-major { stroke:var(--pw-accent); opacity:.75; stroke-width:1.75px; }
        .knob-ticks.dim .tick-minor { stroke:rgba(255,255,255,.12); opacity:1; }
        .knob-ticks.dim .tick-major { stroke:var(--pw-accent); opacity:.30; }
        .knob-led-ring { fill:none; stroke:var(--pw-accent); stroke-width:3.5px; opacity:1;
                         filter:drop-shadow(0 0 2px #ffffff) drop-shadow(0 0 6px var(--pw-accent)) drop-shadow(0 0 14px var(--pw-accent)) drop-shadow(0 0 24px var(--pw-glow));
                         transition:stroke .3s ease, stroke-width .3s ease, filter .3s ease, opacity .3s ease; }
        .knob-ticks.dim .knob-led-ring { stroke:var(--pw-accent); opacity:.35; stroke-width:2px; filter:drop-shadow(0 0 4px var(--pw-accent)); }
        .knob-housing.pip-active .knob-led-ring,
        .knob-housing:hover .knob-led-ring {
          stroke-width:4px;
          filter:drop-shadow(0 0 4px #ffffff) drop-shadow(0 0 10px var(--pw-accent)) drop-shadow(0 0 20px var(--pw-accent)) drop-shadow(0 0 32px var(--pw-glow));
        }

        /* ENGRAVED, LIKE A RADIO'S: one quiet caption under each knob names
           what it does, so neither gesture has to be guessed on a screen
           with no hover. The hover tooltip above it says the same words. */
        .knob-caption { margin-top:6px; font-family:var(--pw-mono, "SF Mono", "Fira Code", monospace, sans-serif);
                        font-size:.6rem; font-weight:700; letter-spacing:.18em; text-transform:uppercase;
                        color:rgba(240,162,74,.6); text-shadow:0 1px 0 rgba(0,0,0,.85);
                        white-space:nowrap; pointer-events:none; }
        .knob-tooltip {
          position:absolute;
          bottom:-4px;
          left:50%;
          transform:translateX(-50%) translateY(4px);
          background:rgba(18,15,12,.94);
          color:#f5f0e8;
          border:1px solid rgba(240,162,74,.35);
          border-radius:6px;
          padding:4px 9px;
          font-size:.74em;
          font-weight:600;
          letter-spacing:.02em;
          white-space:nowrap;
          pointer-events:none;
          opacity:0;
          visibility:hidden;
          transition:opacity .2s ease, transform .2s ease, visibility .2s;
          box-shadow:0 4px 12px rgba(0,0,0,.85), 0 0 8px rgba(240,162,74,.18);
          z-index:20;
        }
        .pw-knob-unit:hover .knob-tooltip,
        .pw-knob-unit:focus-within .knob-tooltip {
          opacity:1;
          visibility:visible;
          transform:translateX(-50%) translateY(0);
        }

        /* --- Center Script Logo / Badge on Radio Face ---
           The wordmark is the approved production vector, mounted in the
           520 x 150 badge cell it was designed in; station mode puts the
           engraved brass plate in the same cell. The cell is scaled as a
           whole per breakpoint -- bevel, grain and shadow scale with it,
           as a smaller cast badge would -- and is placed by the lettering's
           centre, 73/150 of the cell's height, so the top offset names where
           the middle of the mark sits on the cloth. At desktop that puts the
           cell flush with the cloth's top edge, above the display. */
        .console-badge {
          position:absolute;
          top:73px;
          left:50%;
          width:520px;
          aspect-ratio:520 / 150;
          transform:translate(-50%, -48.67%);
          z-index:6;
          cursor:pointer;
          user-select:none;
          border-radius:8px;
          outline:none;
          transition:opacity .3s ease, filter .3s ease;
        }
        /* The badge answers only on its metal (.console-badge-hit,
           sized in _renderCenterBadge); the rest of its cell lets the
           pointer through to the knobs. Focus and keys are unchanged. */
        .console-badge { pointer-events:none; }
        .console-badge-hit { position:absolute; pointer-events:auto; border-radius:8px; cursor:pointer; }
        .console-badge:focus-visible {
          outline:2px solid var(--pw-accent);
          outline-offset:3px;
        }
        .console-badge.badge-hidden .console-badge-emblem,
        .console-badge.badge-hidden .console-badge-plate {
          opacity:0;
          visibility:hidden;
        }
        .console-badge-emblem, .console-badge-plate,
        .console-badge-plate-body, .console-badge-plate-text {
          position:absolute; inset:0; width:100%; height:100%; display:block; pointer-events:none;
        }
        .console-badge-emblem, .console-badge-plate { transition:opacity .25s ease, filter .25s ease; }
        /* PW_EMBLEM_SCALE and PW_EMBLEM_DROP: 21% smaller, 6% of the cell lower */
        .console-badge-emblem { transform:translateY(6%) scale(.79); transform-origin:50% 50%; }
        .console-badge-plate-text { overflow:visible; }
        /* the engraving: dark enamel with the lit lower edge of the groove
           beneath it; uppercase is presentation, the name is the full
           configured value (it is the button's accessible name) */
        .console-badge-plate-text text {
          font-family:"ParlorWave Plate", Jost, Futura, "Avenir Next", "Century Gothic", "Trebuchet MS", sans-serif;
          font-weight:600;
          text-transform:uppercase;
          text-anchor:middle;
        }
        .console-badge-plate-text .pw-plate-hi { fill:#fff0cc; fill-opacity:.5; }
        .console-badge-plate-text .pw-plate-ink { fill:#1c1106; }
        .console-badge:hover .console-badge-emblem,
        .console-badge:hover .console-badge-plate {
          filter:drop-shadow(0 0 8px rgba(240,162,74,.45));
        }
        /* the DJ sleeve keeps its own drawn script */
        .art-dj-script {
          font-family:"Brush Script MT", "Segoe Script", "Snell Roundhand", "Apple Chancery", "Lucida Calligraphy", cursive, serif;
          font-weight:600;
          font-style:italic;
          letter-spacing:.03em;
          line-height:1.15;
          color:#f5c278;
          background:linear-gradient(180deg, #fffaf0 0%, #ffe3ad 20%, #f2b660 42%,
                                     #93591b 50%, #c4832f 58%, #f6cd86 80%, #fff0d2 100%);
          -webkit-background-clip:text;
          background-clip:text;
          -webkit-text-fill-color:transparent;
          filter:drop-shadow(0 -1px 0 rgba(255,244,222,.45))
                 drop-shadow(0 1px 0 rgba(58,28,4,.95))
                 drop-shadow(0 2px 1px rgba(0,0,0,.75))
                 drop-shadow(0 5px 6px rgba(0,0,0,.6));
        }

        .console-out { display:flex; align-items:center; margin:0; }
        .console-out .control { display:flex; align-items:center; padding:0; margin:0; border:none; background:transparent; }
        .console-out .label, .console-out .hint { display:none; }
        .console-out select { height:24px; line-height:22px; padding:0 20px 0 8px; border-radius:6px;
                              background:rgba(0,0,0,.5); border:1px solid rgba(255,255,255,.14);
                              box-shadow:inset 0 1px 3px rgba(0,0,0,.7);
                              color:var(--pw-dim); font-family:inherit; font-size:.92em; font-weight:700;
                              letter-spacing:.08em; text-transform:uppercase; cursor:pointer;
                              max-width:145px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
                              outline:none; appearance:none; -webkit-appearance:none;
                              background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 8 5'%3E%3Cpath fill='%23f0a24a' opacity='0.75' d='M0 0l4 4 4-4z'/%3E%3C/svg%3E");
                              background-repeat:no-repeat; background-position:right 6px center;
                              transition:border-color .2s ease, color .2s ease, box-shadow .2s ease, background-color .2s ease; }
        .console-out select:hover:not(:disabled) { border-color:rgba(240,162,74,.6); color:#ffd38f;
                                                  background-color:rgba(240,162,74,.08);
                                                  box-shadow:0 0 8px rgba(240,162,74,.25), inset 0 1px 3px rgba(0,0,0,.7); }
        .console-out select:focus-visible { outline:2px solid var(--pw-accent); outline-offset:2px; }

        .console-foot { margin:0 22px 18px; }
        .console .setup-callout.console-foot { margin-top:0; }
        .console .lastbreak { border-radius:0; border:none; border-top:1px solid rgba(255,255,255,.07);
                              margin:12px 0 0; padding:16px 22px 18px;
                              background:rgba(0,0,0,.35); }

        /* --- the DJ control: a push-button face with a lamp behind its cap.
           Illuminated when ENABLED, never pulsing: a pulse here would read
           as "speaking now", which is the Mouth's job. */
        .dj-switch { position:relative; width:104px; height:104px; border-radius:50%;
                     border:2px solid #282624; padding:0; margin:0; outline:none; cursor:pointer;
                     background:conic-gradient(from 180deg at 50% 50%,
                                  #1c1b19 0deg, #383633 45deg, #181715 90deg, #353330 135deg,
                                  #1b1a18 180deg, #383633 225deg, #181715 270deg, #353330 315deg, #1c1b19 360deg);
                     box-shadow:0 6px 18px rgba(0,0,0,.85),
                                inset 0 1px 1.5px rgba(255,255,255,.22),
                                inset 0 -2px 5px rgba(0,0,0,.8);
                     transition:transform .08s ease, box-shadow .3s ease, border-color .3s ease;
                     display:flex; align-items:center; justify-content:center; }
        .dj-switch:hover:not(:disabled) { border-color:var(--pw-accent);
                                          box-shadow:0 6px 20px rgba(0,0,0,.9), 0 0 12px var(--pw-glow),
                                                     inset 0 1px 1.5px rgba(255,255,255,.3); }
        .dj-switch:active:not(:disabled) { transform:translateY(1px) scale(.98); }
        .dj-switch:disabled { cursor:not-allowed; opacity:1; }
        .dj-switch:not(.pending):disabled { opacity:1; }
        .dj-switch.pending:disabled { opacity:1; cursor:progress; }
        .dj-switch-glow { position:absolute; inset:-4px; border-radius:50%; opacity:0;
                          transition:opacity .3s ease; pointer-events:none;
                          background:radial-gradient(circle, var(--pw-glow, rgba(240,162,74,.28)) 0%, transparent 70%); }
        .dj-switch.on { border-color:#282624; }
        .dj-switch.on .dj-switch-glow { opacity:0; }
        .dj-face { position:relative; width:100%; height:100%; border-radius:50%;
                   display:flex; align-items:center; justify-content:center;
                   transition:transform .08s ease, box-shadow .3s ease; }
        .dj-face-cap { font-size:.82em; font-weight:700; letter-spacing:.12em;
                       color:var(--pw-dim); transition:color .3s ease, text-shadow .3s ease; }
        .dj-switch.on .dj-face { box-shadow:none; }
        .knob-indicator-svg { position:absolute; top:50%; left:50%; width:154px; height:154px;
                              margin-top:-77px; margin-left:-77px; pointer-events:none;
                              overflow:visible; z-index:4; }
        .knob-arc-segment { fill:none; stroke:#0c0b0a; stroke-width:4.5px; stroke-linecap:round;
                            stroke-dasharray:24 330; stroke-dashoffset:-252px;
                            opacity:0;
                            filter:drop-shadow(0 0 2px #ffffff) drop-shadow(0 0 6px var(--pw-accent));
                            transition:opacity 1.6s ease-out, filter 1.6s ease-out; }
        .knob-arc-segment.active {
          opacity:1;
          stroke:#0c0b0a;
          filter:drop-shadow(0 0 3px #ffffff) drop-shadow(0 0 8px var(--pw-accent)) drop-shadow(0 0 16px var(--pw-glow));
          transition:opacity .06s ease-out, filter .06s ease-out;
        }
        .right-knob { position:relative; width:104px; height:104px; border-radius:50%;
                      border:2px solid #282624; padding:0; margin:0; outline:none; cursor:pointer;
                      background:conic-gradient(from 180deg at 50% 50%,
                                   #1c1b19 0deg, #383633 45deg, #181715 90deg, #353330 135deg,
                                   #1b1a18 180deg, #383633 225deg, #181715 270deg, #353330 315deg, #1c1b19 360deg);
                      box-shadow:0 6px 18px rgba(0,0,0,.85),
                                 inset 0 1px 1.5px rgba(255,255,255,.22),
                                 inset 0 -2px 5px rgba(0,0,0,.8);
                      transition:transform .08s ease, box-shadow .3s ease, border-color .3s ease;
                      display:flex; align-items:center; justify-content:center; }
        .right-knob:hover:not(:disabled) { border-color:var(--pw-accent);
                                           box-shadow:0 6px 20px rgba(0,0,0,.9), 0 0 12px var(--pw-glow),
                                                      inset 0 1px 1.5px rgba(255,255,255,.3); }
        .right-knob:active:not(:disabled) { transform:translateY(1px) scale(.98); }
        .knob-face { position:relative; width:100%; height:100%; border-radius:50%;
                     display:flex; align-items:center; justify-content:center;
                     transition:transform .08s ease; }
        .dj-switch.knob-turning, .right-knob.knob-turning {
          border-color:var(--pw-accent) !important;
          box-shadow:0 0 0 2.5px var(--pw-accent), 0 0 20px var(--pw-glow), inset 0 0 12px var(--pw-glow) !important;
          cursor:grab;
        }
        .dj-switch.knob-turning.is-dragging, .right-knob.knob-turning.is-dragging {
          cursor:grabbing;
        }
        .is-dragging .dj-face, .is-dragging .knob-face { transition:none !important; }
        .visually-hidden { position:absolute; width:1px; height:1px; padding:0; margin:-1px;
                           overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
        .dj-switch-body { display:flex; flex-direction:column; gap:3px; position:relative; min-width:0; }
        .dj-switch-word { font-size:.98em; font-weight:700; letter-spacing:.13em; text-transform:uppercase; color:var(--pw-dim); }
        .dj-switch-sub { color:var(--pw-muted); font-size:.8em; letter-spacing:.02em; }
        .dj-switch.pending .dj-face { animation:dj-pending 1.2s ease-in-out infinite; }
        @keyframes dj-pending {
          0%,100% { box-shadow:0 0 0 2px var(--pw-glow), 0 3px 8px rgba(0,0,0,.5); }
          50%     { box-shadow:0 0 0 6px var(--pw-glow), 0 3px 8px rgba(0,0,0,.5); }
        }
        .dj-switch-note { margin-top:6px; font-size:.76em; }
        .dj-switch:focus-visible, .right-knob:focus-visible { outline:2px solid var(--pw-accent);
                                                             outline-offset:4px; }

        /* --- the Mouth: a dark glass window; the display is drawn inside.
           The window is the same in every state; only what is drawn on it
           changes, plus a faint amber halo while a voice is on the air. */
        .mouth { position:relative; width:100%; max-width:580px; height:96px; box-sizing:border-box;
                 border-radius:14px; overflow:hidden; cursor:pointer; user-select:none;
                 background:linear-gradient(180deg, #090807, #131210 55%, #0a0908);
                 border:1px solid rgba(255,255,255,.07);
                 box-shadow:inset 0 3px 12px rgba(0,0,0,.95),
                            inset 0 1px 2px rgba(0,0,0,.9),
                            0 4px 12px rgba(0,0,0,.7),
                            0 0 0 1.5px rgba(0,0,0,.8);
                 margin-top:132px;
                 transition:border-color .5s ease, box-shadow .5s ease; }
        .mouth:hover { border-color:rgba(255,255,255,.16); }
        .mouth::after { content:""; position:absolute; inset:0; pointer-events:none;
                        background:linear-gradient(180deg, rgba(255,255,255,.05), transparent 40%); }
        /* The LCD header takes the top of the window; the display is
           drawn in the rest, so nothing it draws runs under the words. */
        .mouth { --lcd-head:22px; }
        .mouth-canvas { position:absolute; left:0; top:var(--lcd-head); display:block;
                        width:100%; height:calc(100% - var(--lcd-head)); }
        .lcd-status { position:absolute; top:0; left:0; right:0; height:var(--lcd-head); z-index:2;
                      box-sizing:border-box; padding:0 14px;
                      display:flex; align-items:center; justify-content:space-between; gap:12px;
                      font-family:var(--pw-mono, "SF Mono", "Fira Code", monospace, sans-serif);
                      font-size:.66rem; font-weight:700; letter-spacing:.14em; text-transform:uppercase;
                      color:var(--pw-accent); pointer-events:none;
                      border-bottom:1px solid rgba(255,255,255,.05); }
        .lcd-status > span { display:flex; align-items:center; gap:6px; min-width:0; }
        .lcd-status-dj { flex:none; }
        .lcd-status-out { flex:1 1 auto; justify-content:flex-end; }
        .lcd-status-text { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        /* A long speaker name keeps its ending (_nameParts): inside the SAME
           box, the head yields to an ellipsis and the tail stays whole. */
        .pw-name { display:flex; min-width:0; overflow:hidden; }
        .pw-name-head { flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:pre; }
        .pw-name-tail { flex:none; white-space:pre; }
        .lcd-lamp { width:6px; height:6px; border-radius:50%; flex:none; background:rgba(240,162,74,.22); }
        .lcd-tone-on .lcd-lamp { background:var(--pw-accent); box-shadow:0 0 6px var(--pw-accent); }
        .lcd-tone-off, .lcd-tone-dim { color:rgba(240,162,74,.72); }
        .lcd-tone-air { color:#ff7a66; }
        .lcd-tone-air .lcd-lamp { background:#ff4a36; box-shadow:0 0 6px #ff4a36, 0 0 12px rgba(255,74,54,.55); }
        .lcd-pending .lcd-lamp { animation:lcd-pending 1s ease-in-out infinite; }
        @keyframes lcd-pending { 0%, 100% { opacity:1; } 50% { opacity:.25; } }
        .lcd-whisper { position:absolute; left:0; right:0; bottom:5px; z-index:3;
                       display:flex; justify-content:center; pointer-events:none;
                       opacity:0; transition:opacity .18s ease; }
        .lcd-whisper.visible { opacity:1; }
        .lcd-whisper-text { max-width:calc(100% - 24px); box-sizing:border-box; padding:1px 9px; border-radius:6px;
                            white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
                            background:rgba(10,8,6,.9); border:1px solid rgba(240,162,74,.25);
                            font-family:var(--pw-mono, "SF Mono", "Fira Code", monospace, sans-serif);
                            font-size:.6rem; font-weight:700; letter-spacing:.12em; color:var(--pw-accent); }
        .lcd-whisper-volume .lcd-whisper-text { font-size:.68rem; }
        .mouth-toast { position:absolute; top:calc(var(--lcd-head) + 6px); right:12px;
                       background:rgba(14,12,10,.88); color:var(--pw-accent, #f0a24a);
                       font-family:var(--pw-mono, "SF Mono", "Fira Code", monospace, sans-serif);
                       font-size:.65rem; font-weight:700; letter-spacing:.12em; text-transform:uppercase;
                       padding:3px 8px; border-radius:4px; border:1px solid var(--pw-accent, #f0a24a);
                       pointer-events:none; box-shadow:0 0 10px rgba(0,0,0,.8);
                       animation:mouthToastFade 1.4s ease-out forwards; z-index:10; }
        @keyframes mouthToastFade {
          0%   { opacity:0; transform:translateY(-4px); }
          15%  { opacity:1; transform:translateY(0); }
          75%  { opacity:1; }
          100% { opacity:0; transform:translateY(-2px); }
        }
        .mouth-program-voice { border-color:var(--pw-accent);
                               box-shadow:inset 0 2px 10px rgba(0,0,0,.7),
                                          0 0 18px var(--pw-glow); }
        .mouth.in-output-mode { border-color:var(--pw-accent);
                                box-shadow:inset 0 2px 10px rgba(0,0,0,.8),
                                           0 0 16px var(--pw-glow); }
        .mouth.in-output-mode .mouth-canvas { display:none; }
        .mouth.in-station-mode { border-color:var(--pw-accent);
                                 box-shadow:inset 0 2px 10px rgba(0,0,0,.8),
                                            0 0 16px var(--pw-glow); }
        .mouth.in-station-mode .mouth-canvas { display:none; }
        .lcd-station-note { color:var(--pw-accent); }
        .lcd-station-where { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .lcd-confirm-badge.lcd-refused { background:rgba(255,167,38,.16); border-color:#ffa726;
                                         color:#ffa726; box-shadow:none; }
        /* A selector covers the whole window, header included: the header and
           the transient line sit under it and are hidden while it is open. */
        .mouth.in-output-mode .lcd-status, .mouth.in-station-mode .lcd-status,
        .mouth.in-output-mode .lcd-whisper, .mouth.in-station-mode .lcd-whisper { visibility:hidden; }
        .mouth-lcd-overlay { position:absolute; inset:0; z-index:4; display:flex; flex-direction:column;
                             justify-content:space-between; padding:8px 16px;
                             background:radial-gradient(ellipse at center, rgba(16,14,12,.95) 0%, #0d0b09 80%);
                             color:var(--pw-accent);
                             font-family:var(--pw-mono, "SF Mono", "Fira Code", monospace, sans-serif);
                             user-select:none; }
        .lcd-header { display:flex; align-items:center; justify-content:space-between;
                      font-size:.72em; font-weight:700; letter-spacing:.14em; color:var(--pw-accent); opacity:.85; }
        .lcd-header-dot { display:inline-block; width:5px; height:5px; border-radius:50%;
                          background:var(--pw-accent); margin-right:5px; box-shadow:0 0 6px var(--pw-accent); }
        .lcd-browser { display:flex; flex-direction:column; align-items:center; justify-content:center;
                       gap:2px; flex:1; }
        .lcd-candidate-curr { display:flex; align-items:center; justify-content:center; gap:12px;
                              font-size:.95em; font-weight:700; color:#fff;
                              text-shadow:0 0 10px var(--pw-glow); cursor:pointer; max-width:95%; }
        .lcd-curr-text { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:380px; }
        .lcd-star { color:var(--pw-accent); font-size:1.1em; margin-right:4px; text-shadow:0 0 8px var(--pw-accent); }
        .lcd-confirm-badge { display:inline-block; margin-top:4px; padding:2px 10px; font-size:.74em;
                             font-weight:700; letter-spacing:.1em; border-radius:12px;
                             background:rgba(124,196,127,.2); border:1px solid #7cc47f; color:#7cc47f;
                             box-shadow:0 0 10px rgba(124,196,127,.4); }
        .lcd-footer { text-align:center; font-size:.68em; letter-spacing:.1em; color:var(--pw-accent); opacity:.7; }
        /* The speaker list: CURRENT on top marked NOW, the
           CANDIDATE boxed, the next one dim; a countdown in the header and a
           draining bar along the bottom. */
        .lcd-output { padding:5px 14px 6px; justify-content:flex-start; gap:3px; }
        .lcd-output .lcd-header { flex:none; }
        .lcd-pos { opacity:.7; margin-left:4px; letter-spacing:.08em; }
        .lcd-countdown-num { font-variant-numeric:tabular-nums; }
        .lcd-rows { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; justify-content:center; gap:2px; }
        .lcd-row { display:flex; align-items:center; gap:8px; height:17px; min-width:0; padding:0 8px;
                   box-sizing:border-box; border:1px solid transparent; border-radius:5px;
                   font-size:.74rem; letter-spacing:.04em; color:rgba(240,162,74,.72); }
        .lcd-row-cand { border-color:var(--pw-accent); background:rgba(240,162,74,.10); color:#fff;
                        font-weight:700; box-shadow:0 0 8px var(--pw-glow); }
        .lcd-row-mark { flex:none; width:10px; color:var(--pw-accent); font-size:.78em; }
        .lcd-row-name { flex:1 1 auto; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .lcd-row-tag { flex:none; font-size:.6rem; font-weight:700; letter-spacing:.16em; color:var(--pw-accent); }
        .lcd-output .lcd-footer { flex:none; font-size:.56rem; line-height:10px; }
        .lcd-countdown-bar { position:absolute; left:0; bottom:0; width:100%; height:2px;
                             background:var(--pw-accent); transform-origin:left center;
                             animation-name:lcd-countdown; animation-timing-function:linear;
                             animation-fill-mode:forwards; }
        @keyframes lcd-countdown { from { transform:scaleX(1); } to { transform:scaleX(0); } }
        .lcd-result { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; align-items:center;
                      justify-content:center; gap:2px; text-align:center; }
        .lcd-result-word { font-size:.9rem; font-weight:700; letter-spacing:.14em; color:var(--pw-accent); }
        .lcd-confirmed .lcd-result-word { color:#7cc47f; text-shadow:0 0 10px rgba(124,196,127,.45); }
        .lcd-result-word.lcd-refused { color:#ffa726; }
        .lcd-result-detail { max-width:100%; font-size:.68rem; letter-spacing:.06em; color:#fff; opacity:.85;
                             white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .confirm-prompt { color:var(--pw-accent); font-weight:700; animation:pulse-confirm 1s ease-in-out infinite; }
        @keyframes pulse-confirm { 0%, 100% { opacity:1; } 50% { opacity:.4; } }
        .svc { border:1px solid var(--pw-line); border-radius:12px;
               padding:14px 16px; margin:12px 0;
               background:rgba(255,255,255,.02); }
        .svc-head { display:flex; align-items:center; gap:12px;
                    justify-content:space-between; }
        .svc-name { font-weight:600; font-size:1.02em; }
        .svc-key { flex-wrap:wrap; }
        .svc-key input { flex:1 1 12rem; min-width:0; }
        /* A saved key is a STATE, not a value: the panel does not have the
           key and must not draw a row of dots pretending that it does. */
        .svc-badge { font-size:.76em; letter-spacing:.08em;
                     text-transform:uppercase; color:#7cc47f;
                     border:1px solid #7cc47f; border-radius:20px;
                     padding:3px 9px; flex:none; }
        .cal-list { margin:10px 0 4px; display:flex; flex-direction:column; gap:6px; }
        .cal-row { display:flex; gap:10px; align-items:baseline; flex-wrap:wrap;
                   font-size:.92em; }
        .cal-when { color:var(--pw-dim); min-width:9ch; }
        .cal-what { color:var(--pw-text); }
        /* A reason that is NOT "can be mentioned" is information, not a
           fault: it reads quietly rather than as a warning. */
        .cal-flag.muted { background:transparent; border:1px solid var(--pw-line);
                          color:var(--pw-muted); }
        .cal-flag { color:var(--pw-accent); font-size:.82em; letter-spacing:.04em;
                    text-transform:uppercase; }
        .src-list { display:flex; flex-direction:column; gap:12px; margin:12px 0; }
        .src { border:1px solid var(--pw-line); border-radius:12px;
               padding:12px 14px; background:rgba(255,255,255,.02); }
        .src.off { opacity:.62; }
        .src-head { display:flex; gap:10px; align-items:baseline; flex-wrap:wrap; }
        .src-name { font-weight:600; }
        .src-when { color:var(--pw-muted); font-size:.9em; }
        .src-state { margin-left:auto; font-size:.76em; letter-spacing:.08em;
                     text-transform:uppercase; color:var(--pw-dim); }
        .src-url { color:var(--pw-dim); font-size:.84em; margin-top:4px;
                   overflow-wrap:anywhere; }
        .src-url.dim { font-style:italic; }
        .src-last { color:var(--pw-muted); font-size:.84em; margin-top:4px; }
        .src-note { margin-top:8px; color:var(--pw-accent); font-size:.84em; }
        .src-actions { margin-top:10px; flex-wrap:wrap; }
        .src-edit { margin-top:12px; padding-top:12px;
                    border-top:1px solid var(--pw-line); }
        button.small { padding:5px 10px; font-size:.86em; }
        button.danger { color:#ffa726; }
        .empty-state { padding:10px 0; }
        .hist { display:flex; flex-direction:column; gap:10px; margin:10px 0 12px; }
        .hist-row { display:flex; gap:12px; align-items:center;
                    padding-bottom:10px; flex-wrap:wrap;
                    border-bottom:1px solid var(--pw-line); }
        .hist-row:last-child { border-bottom:0; padding-bottom:0; }
        .hist-row.miss { opacity:.72; }
        .hist-main { flex:1 1 14rem; min-width:0; }
        .hist-src { font-weight:600; font-size:.94em; }
        .hist-title { color:var(--pw-text); font-size:.9em; margin-top:2px;
                      overflow-wrap:anywhere; }
        .hist-meta { color:var(--pw-muted); font-size:.85em; margin-top:3px; }
        .hist-why { color:var(--pw-dim); font-size:.8em; margin-top:3px; }
        .hist-gone { color:var(--pw-dim); font-size:.8em; }
        /* The rest of the record, closed. A disclosure, not a second list:
           it must look like one line until somebody asks for it. */
        .hist-more { margin:2px 0 12px; }
        /* display:flex on a <summary> removes the browser's own
           disclosure triangle, and a fold with no marker reads as a
           caption rather than as something to press. So the marker is
           drawn here instead of being lost: one caret, rotated when the
           fold is open, and the row is still a full 32px target. */
        .hist-more > summary { cursor:pointer; color:var(--pw-muted);
                font-size:.85em; letter-spacing:.06em; padding:6px 2px;
                min-height:32px; display:flex; align-items:center; gap:8px;
                list-style:none; }
        .hist-more > summary::-webkit-details-marker { display:none; }
        .hist-more > summary::before { content:"\u203a"; display:inline-block;
                font-size:1.25em; line-height:1; transform:rotate(0deg);
                transition:transform 140ms ease; opacity:.8; }
        .hist-more[open] > summary::before { transform:rotate(90deg); }
        @media (prefers-reduced-motion: reduce) {
          .hist-more > summary::before { transition:none; }
        }
        .hist-more > summary:hover { color:var(--pw-text); }
        .hist-more > summary:focus-visible { outline:2px solid var(--pw-accent);
                outline-offset:2px; border-radius:6px; }
        .hist-more[open] > summary { color:var(--pw-text); }
        .hist-more .hist { margin-top:4px; }
        table.news-facts { margin-top:10px; }
        table.news-facts td:first-child { width:52%; }

        /* headlines in breaks: a capability row, not a switch */
        .hl-row { display:flex; gap:13px; align-items:flex-start; flex-wrap:wrap; }
        .hl-status { flex:none; font-size:.7em; letter-spacing:.1em; text-transform:uppercase;
                font-weight:700; padding:4px 9px; border-radius:6px; white-space:nowrap; }
        .hl-status.off { background:var(--pw-surface-2); color:var(--pw-dim);
                box-shadow:inset 0 0 0 1px var(--pw-line); }
        .hl-status.on { background:var(--pw-accent); color:#1a1206; }
        .hl-body { flex:1; min-width:180px; color:var(--pw-muted); font-size:.92em;
                line-height:1.55; }

        .vol { display:flex; align-items:center; gap:10px; margin:10px 0 2px; }
        .vol input[type=range] { flex:1 1 auto; min-width:0; accent-color:var(--pw-accent);
                                 height:22px; }
        .vol input[type=range]:focus-visible { outline:2px solid var(--pw-accent);
                                               outline-offset:3px; }
        .vol-pct { color:var(--pw-muted); font-size:.85em; min-width:3.4ch;
                   text-align:right; font-variant-numeric:tabular-nums; }
        /* A WORD, NOT AN EMOJI. A speaker glyph is emoji-presentation: it
           renders as a colour picture on one platform, an outline on
           another and a tofu box where the font is absent -- and the
           difference between the muted and unmuted glyph is a diagonal
           line four pixels long. The state is legible at any size and in
           any font as a word. */
        .vol-mute.on { color:#ffa726; border-color:#ffa726; }
        .vol-off { color:var(--pw-dim); font-size:.86em; gap:8px; }
        .vol-label { letter-spacing:.06em; text-transform:uppercase;
                     font-size:.78em; color:var(--pw-dim); flex:none; }

        /* --- the last thing the station said ----------------------------- */
        .lastbreak-head { display:flex; align-items:center; gap:9px; flex-wrap:wrap;
                margin-bottom:10px; font-size:.82em; letter-spacing:.1em; text-transform:uppercase; }
        .lastbreak-label { color:var(--pw-dim); }
        .lastbreak-label::after { content:"\u00b7"; margin-left:9px; }
        .lastbreak-who { color:var(--pw-text); font-weight:600; }
        .lastbreak-when, .mic { color:var(--pw-dim); }
        /* the live break is the one being heard: say so in colour as well
           as in words, so the card cannot be mistaken for history */
        .lastbreak-when.onair { color:var(--pw-accent); font-weight:600; }
        .lastbreak.live blockquote.said { border-left-width:3px; }
        .lastbreak-topics { color:var(--pw-dim); font-size:.82em; margin-top:8px; }
        blockquote.said { margin:0; padding:2px 0 2px 16px; border-left:2px solid var(--pw-accent);
                font-size:1.12em; line-height:1.55; color:var(--pw-text); font-style:italic;
                transition:border-color 700ms ease; }

        /* --- cards ------------------------------------------------------- */
        .card { background:var(--pw-surface); border:1px solid var(--pw-line); border-radius:16px;
                padding:18px; margin-bottom:14px; }
        .card.secondary { background:rgba(255,255,255,.028); }
        h2 { font-size:.78em; margin:0 0 12px; color:var(--pw-dim); text-transform:uppercase;
             letter-spacing:.14em; font-weight:600; }

        /* --- controls ---------------------------------------------------- */
        .row { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; align-items:center; }
        .row.tight { margin-top:6px; }
        .spacer { flex:1; }
        input[type=text], input[type=password] { flex:1; min-width:180px; padding:11px 13px; border-radius:11px;
                border:1px solid var(--pw-line); background:rgba(0,0,0,.25); color:var(--pw-text); font-size:1em; }
        input[type=text]::placeholder, input[type=password]::placeholder { color:var(--pw-dim); }
        .small-input { min-width:120px !important; flex:0 1 160px !important;
                padding:7px 10px !important; font-size:.85em !important; }
        button { border:none; border-radius:11px; padding:11px 15px; font-size:.92em; min-height:40px;
                 background:var(--pw-accent); color:#1a1206; font-weight:600; cursor:pointer;
                 transition:background 700ms ease, opacity .2s; }
        button:disabled { opacity:.35; cursor:default; }
        button.ghost, label.ghost, a.ghost { background:var(--pw-surface-2); color:var(--pw-text); font-weight:500;
                 border:1px solid var(--pw-line); }
        button.ghost:hover:not(:disabled), a.ghost:hover { background:rgba(255,255,255,.13); }
        button.ghost.on { border-color:var(--pw-accent); color:var(--pw-text);
                 box-shadow:inset 0 0 0 1px var(--pw-accent); transition:box-shadow 700ms ease; }
        button.icon { background:var(--pw-surface-2); border:1px solid var(--pw-line);
                 font-size:1.05em; min-width:46px; }
        .small { padding:7px 11px; font-size:.85em; border-radius:9px; min-height:36px; }
        .tiny-btn { padding:6px 11px; font-size:.75em; min-height:34px; letter-spacing:.08em; }
        .danger { color:#ff8a80; }
        label.filebtn { display:inline-block; cursor:pointer; padding:7px 11px; border-radius:9px; font-size:.85em; }
        .pill { min-width:64px; background:var(--pw-surface-2); color:var(--pw-text);
                border:1px solid var(--pw-line); }
        /* configuration is secondary here: "on" reads as lit, not as the
           loudest thing on the screen. The word still says which it is. */
        .pill.on { background:rgba(255,255,255,.07); color:var(--pw-accent);
                border-color:var(--pw-accent); transition:color 700ms ease, border-color 700ms ease; }
        select, input[type=number] { padding:9px 11px; border-radius:9px; min-height:40px;
                border:1px solid var(--pw-line); background:rgba(0,0,0,.25);
                color:var(--pw-text); font-size:.92em; max-width:240px;
                /* Restated on the control itself, not only inherited: Home
                   Assistant themes the page around this panel and a light
                   theme setting color-scheme on an ancestor would otherwise
                   reach in and relight every menu. */
                color-scheme:dark; }
        /* Honoured by engines that let a popup's rows be painted at all;
           where it is ignored, color-scheme above has already made the
           popup dark. Both, because neither is universal on its own. */
        select option { background:#16161a; color:var(--pw-text); }
        select:focus-visible, input:focus-visible { outline:2px solid var(--pw-accent);
                outline-offset:2px; }
        .controls .control { display:flex; justify-content:space-between; align-items:center;
                             gap:12px; padding:11px 0; border-bottom:1px solid var(--pw-line);
                             flex-wrap:wrap; }
        .controls .control > div:first-child { flex:1; min-width:160px; }
        .controls .control:last-child { border-bottom:none; }
        .label { font-weight:500; }
        .hint { color:var(--pw-dim); font-size:.84em; margin-top:8px; line-height:1.5; }

        /* --- drawers: lyrics / queue / history ---------------------------- */
        .drawer { margin-top:16px; border-top:1px solid var(--pw-line); padding-top:12px; }
        /* THE LYRIC PANE IS THE ONLY THING THAT SCROLLS WHEN A LYRIC
           CHANGES. overscroll-behavior:contain stops a scroll that runs
           off either end of this pane from continuing into the Home
           Assistant page behind it (scroll chaining), which is the other
           half of "lyrics must not move the page" -- the script half is
           that nothing calls scrollIntoView or focus. scroll-behavior is
           deliberately NOT set here: following the song asks for smooth
           per call, while putting the pane back after a re-render must be
           instant, and a CSS rule cannot tell those two apart. */
        .lyrics { max-height:300px; overflow-y:auto; padding:6px 2px;
                  overscroll-behavior:contain; }
        .lyrics.plain { white-space:pre-wrap; font-size:.95em; line-height:1.55; color:var(--pw-muted); }
        .lyric { padding:3px 6px; color:var(--pw-dim); font-size:1.0em; line-height:1.5;
                 border-radius:6px; transition:color .3s, background .3s; }
        .lyric-now { color:var(--pw-text); font-weight:600; background:var(--pw-surface-2); }
        .lyrics:focus-visible { outline:2px solid var(--pw-accent); outline-offset:2px;
                border-radius:8px; }

        /* --- the way back to the song ------------------------------------
         * Drawn only while following is OFF, and over the bottom of the
         * pane rather than beside it: a control that appears and disappears
         * must not change the height of anything, or the lyrics would jump
         * exactly when somebody is reading them. Small, quiet, and a real
         * 32px target. */
        .lyric-drawer { position:relative; }
        .lyric-follow {
          position:absolute; right:12px; bottom:10px; z-index:2;
          min-height:32px; padding:5px 12px; border-radius:999px;
          font-size:.8em; letter-spacing:.04em; cursor:pointer;
          color:var(--pw-text);
          background:linear-gradient(rgba(255,167,38,.16), rgba(255,167,38,.16)),
                     rgba(22,24,28,.9);
          border:1px solid var(--pw-accent);
          box-shadow:0 4px 14px rgba(0,0,0,.4);
          backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px);
        }
        .lyric-follow:hover { background:linear-gradient(rgba(255,167,38,.26),
                     rgba(255,167,38,.26)), rgba(22,24,28,.94); }
        .lyric-follow:focus-visible { outline:2px solid var(--pw-accent);
                outline-offset:2px; }
        .qhead { color:var(--pw-dim); font-size:.75em; text-transform:uppercase;
                 letter-spacing:.12em; margin:12px 0 5px; }
        .qrow { display:flex; gap:10px; padding:6px; border-radius:8px; align-items:baseline; }
        .qrow.qnow { background:var(--pw-surface-2); font-weight:600; }
        .qicon { flex:none; width:1.4em; text-align:center; color:var(--pw-dim); }
        .qname { overflow-wrap:anywhere; }
        /* A programme item that will not speak: present, because it is in
           the queue, and plainly not upcoming. Neutral, not alarming --
           a finished break is an ordinary thing, not an error. */
        .qrow.qspent { color:var(--pw-dim); }
        .qrow.qspent .qicon { opacity:.55; }
        .qtag { color:var(--pw-dim); font-size:.72em; text-transform:uppercase;
                letter-spacing:.1em; margin-left:8px; white-space:nowrap; }
        .qrow.qnow .qtag { color:var(--pw-accent); }
        /* An announcement row's meta (when · Exact/Smart · status) is a
           sentence, not a one-word tag: its own line, free to wrap on a
           phone rather than clip at the card's edge. */
        .qtag.antag { display:block; margin-left:0; margin-top:2px;
                      white-space:normal; }
        /* The queue summary: the counts at heading weight, then the
           quieter lines that qualify them. */
        .qsum { padding:2px 2px 10px; border-bottom:1px solid var(--pw-line);
                margin-bottom:8px; }
        .qsum-counts { font-weight:600; overflow-wrap:anywhere; }
        .qsum-sub { color:var(--pw-muted); font-size:.85em; margin-top:2px;
                    overflow-wrap:anywhere; }
        /* The per-item time is a right-hand column that is often EMPTY --
           Music Assistant does not always report a duration -- so it
           reserves no width it is not using and never pushes a title
           sideways. */
        .qtime { color:var(--pw-muted); font-variant-numeric:tabular-nums;
                 flex:none; margin-left:auto; padding-left:10px; }
        .qmore { color:var(--pw-muted); font-size:.85em; padding:6px 2px 0; }
        .history { margin-top:12px; max-height:340px; overflow-y:auto; }
        .hrow { padding:10px 6px; border-bottom:1px solid var(--pw-line); }
        .hrow:last-child { border-bottom:none; }
        .hmeta { color:var(--pw-dim); font-size:.78em; margin-bottom:4px;
                 letter-spacing:.06em; text-transform:uppercase; }
        .htext { font-size:.95em; line-height:1.5; color:var(--pw-muted); }

        /* --- Booth: who is on the mic ------------------------------------- */
        /* The same room as the stage, one step quieter: this is a screen
           you configure from, not one you leave running. */
        .booth-hero { position:relative; border-radius:20px; padding:22px; margin-bottom:14px;
                background:var(--pw-surface); border:1px solid var(--pw-line); overflow:hidden; }
        .booth-hero-body { position:relative; }
        .booth-eyebrow { font-size:.78em; letter-spacing:.14em; text-transform:uppercase;
                color:var(--pw-dim); margin-bottom:8px; }
        h2.booth-name { font-size:1.9em; line-height:1.15; font-weight:600; margin:0 0 6px;
                text-transform:none; letter-spacing:-.01em; color:var(--pw-text);
                overflow-wrap:anywhere; }
        .booth-desc { color:var(--pw-muted); font-size:1.02em; margin-bottom:14px;
                transition:color 700ms ease; }
        .persona-chips { display:flex; flex-wrap:wrap; gap:8px; margin:4px 0 12px; }
        .persona-chip { min-height:40px; padding:7px 15px; border-radius:999px;
                background:var(--pw-surface-2); color:var(--pw-text); border:1px solid var(--pw-line);
                font-size:.9em; }
        .persona-chip.on { background:rgba(255,255,255,.07); color:var(--pw-accent);
                border-color:var(--pw-accent); font-weight:600; }
        .persona-facts { display:flex; flex-direction:column; gap:2px; margin-bottom:6px; }

        /* --- voices (Booth) ----------------------------------------------- */
        .voices { margin-top:12px; }
        .ghost.tiny { padding:0 6px; font-size:.85em; line-height:1.4; min-height:0; }
        /* The voice that is on the air, said in words and shown as a tile.
           The accent edge is decoration; the badge is the statement. */
        .vnow { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:12px;
                padding:13px 15px; border-radius:13px; background:var(--pw-surface-2);
                border-left:3px solid var(--pw-accent); transition:border-color 700ms ease; }
        .vnow-body { flex:1; min-width:140px; }
        .vnow-name { font-size:1.2em; font-weight:600; overflow-wrap:anywhere; }
        .vnow-meta { color:var(--pw-dim); font-size:.85em; margin-top:2px; overflow-wrap:anywhere; }
        .vnow-eyebrow { color:var(--pw-dim); font-size:.7em; letter-spacing:.14em; text-transform:uppercase;
                font-weight:600; margin-bottom:2px; }
        .vnow-standin { color:var(--pw-text); font-size:.85em; margin-top:6px; overflow-wrap:anywhere; }
        .vbadge { font-size:.68em; letter-spacing:.1em; text-transform:uppercase; font-weight:700;
                padding:3px 8px; border-radius:6px; background:var(--pw-accent); color:#1a1206;
                white-space:nowrap; transition:background 700ms ease; }
        .vgroup { margin-bottom:18px; }
        .vgroup:last-child { margin-bottom:0; }
        .vc-sub { margin:2px 0 10px 34px; padding:10px 12px; border-left:2px solid var(--pw-line);
          display:flex; flex-direction:column; gap:8px; }
        .vc-sub label { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
        .vgroup-head { padding:4px 2px 8px; border-bottom:1px solid var(--pw-line); margin-bottom:4px; }
        .vgroup-name { font-size:.78em; letter-spacing:.14em; text-transform:uppercase;
                color:var(--pw-text); font-weight:600; }
        .vgroup-note { color:var(--pw-dim); font-size:.82em; margin-top:3px; }
        .vrow { display:grid; grid-template-columns:24px minmax(120px,1fr) minmax(0,2fr) auto;
                align-items:center; gap:12px; padding:11px 6px; border-bottom:1px solid var(--pw-line); }
        .vrow:last-child { border-bottom:none; }
        .vrow.vsel { background:var(--pw-surface-2); border-radius:10px;
                box-shadow:inset 3px 0 0 var(--pw-accent); transition:box-shadow 700ms ease; }
        .vrow.vgone .label { color:var(--pw-dim); font-weight:400; }
        .vpick { display:flex; align-items:center; justify-content:center; cursor:pointer; }
        .vpick input { width:18px; height:18px; cursor:pointer; margin:0; accent-color:var(--pw-accent); }
        .vname, .vnote { min-width:0; }
        .vdesc { color:var(--pw-dim); font-size:.82em; margin-top:2px; }
        .vnote-line { display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:.9em;
                color:var(--pw-muted); }
        .vactions { display:flex; gap:6px; align-items:center; flex-wrap:wrap; justify-content:flex-end; }
        .vrow.vtune { grid-template-columns:24px 1fr; padding-top:0; }
        .vtune-body label { display:flex; align-items:center; gap:10px; margin:6px 0; font-size:.9em; }
        .vtune-body input[type=range] { flex:1; min-width:120px; accent-color:var(--pw-accent); }
        .vtune-body b { min-width:2.6em; text-align:right; font-variant-numeric:tabular-nums; }

        /* --- custom voices: the optional capability ------------------------ */
        /* Adding a voice is ONE affordance in ONE place, whether or not
           the engine that would do it is present. Disabled it keeps its
           shape and its explanation; enabled, nothing moves. A disabled
           control is dimmed but never hidden -- and it keeps its tooltip,
           because the reason it cannot be pressed is the information. */
        .clone-row { margin-top:12px; align-items:flex-start; gap:12px; }
        .clone-row button[disabled] { opacity:.45; cursor:not-allowed; }
        .clone-row .hint { flex:1; min-width:220px; }
        .create { margin-top:12px; padding:16px; border-radius:13px;
                background:rgba(0,0,0,.22); border:1px solid var(--pw-line); }
        .create-head { font-size:.78em; letter-spacing:.14em; text-transform:uppercase;
                color:var(--pw-text); font-weight:600; margin-bottom:12px; }
        /* A name the person chose is never shouted in small caps: this
           heading carries THEIR words, not a section label. */
        .create-done-head { font-size:1.2em; font-weight:600; margin-bottom:10px;
                overflow-wrap:anywhere; }
        .create-field { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:10px; }
        .create-label { flex:0 0 96px; color:var(--pw-muted); font-size:.9em; }
        .create-field input[type=text] { flex:1; min-width:180px; }
        .create-file { color:var(--pw-dim); font-size:.85em; overflow-wrap:anywhere; }
        .notice.warn { background:rgba(255,193,7,.13); border:1px solid rgba(255,193,7,.3); }

        /* --- enrollment: record, confirm, name, choose ------------------- */
        .create-step { padding:10px 0 12px; border-top:1px solid var(--pw-line); }
        .create-head + .create-step, .notice + .create-step { border-top:none; padding-top:0; }
        .create-step-head { display:flex; align-items:center; gap:8px; font-weight:600;
                color:var(--pw-text); margin-bottom:8px; }
        .create-num { display:inline-flex; align-items:center; justify-content:center;
                width:20px; height:20px; border-radius:50%; font-size:.78em; font-weight:600;
                border:1px solid var(--pw-line); color:var(--pw-dim); }
        .create-choice { display:flex; align-items:flex-start; gap:8px; margin:4px 0; cursor:pointer; }
        .create-choice input { margin-top:3px; accent-color:var(--pw-accent); }
        .create-consent span { color:var(--pw-text); }
        .create-scope { display:flex; flex-wrap:wrap; gap:4px 18px; }
        .take { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:6px; }
        .take-what { color:var(--pw-muted); overflow-wrap:anywhere; }
        /* The microphone is ON: said in words, in the lamp colour, with a
           running clock and Stop beside it. The dot pulses; under reduced
           motion it holds still and the words still say it. */
        .rec-live { display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:10px 12px;
                border-radius:10px; border:1px solid var(--pw-lamp); background:var(--pw-surface); }
        .rec-dot { width:12px; height:12px; border-radius:50%; background:var(--pw-lamp);
                flex:none; animation:rec-pulse 1.2s ease-in-out infinite; }
        .rec-words { flex:1; min-width:180px; }
        .rec-words b { color:var(--pw-lamp); }
        #rec-clock { font-variant-numeric:tabular-nums; }
        /* Record first: the words to read, large enough to read from a
           step back, then one big Record; uploading is the quieter way in. */
        .rec-script-label { color:var(--pw-muted); font-size:.88em; margin-bottom:4px; }
        .rec-script-easy { margin:-6px 0 12px; }
        .rec-script { margin:0 0 12px; padding:12px 14px; border-left:3px solid var(--pw-accent);
                border-radius:8px; background:var(--pw-surface); color:var(--pw-text);
                font-size:1.05em; line-height:1.55; }
        button.rec-big { min-height:48px; padding:10px 22px; font-size:1em; }
        .rec-guide { flex-basis:100%; color:var(--pw-muted); font-size:.9em; }
        /* What the microphone is hearing, live: a level bar, the device the
           browser opened, and -- only when nothing arrives -- a line saying so. */
        .rec-meter { flex-basis:100%; height:6px; border-radius:3px; overflow:hidden;
                background:var(--pw-line); }
        .rec-level { display:block; height:100%; width:0; background:var(--pw-accent);
                transition:width .2s linear; }
        .rec-input { flex-basis:100%; color:var(--pw-muted); font-size:.85em; }
        .rec-warn { flex-basis:100%; color:var(--pw-lamp); font-size:.9em; }
        .rec-warn:empty { display:none; }
        .rec-device { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:8px; }
        .rec-device .hint { margin:0; }
        .take-diag { font-size:.85em; }
        .rec-or { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-top:12px;
                padding-top:10px; border-top:1px dashed var(--pw-line); }
        .rec-or .hint { margin:0; }
        #take-use { min-height:44px; }
        .take.used .take-what { color:var(--pw-text); }
        .audition-wait { color:var(--pw-text); }
        @keyframes rec-pulse { 50% { opacity:.35; } }
        /* what a voice is used for, under its name */
        .vscope { margin-top:4px; font-size:.82em; color:var(--pw-dim); }
        .vscope > summary { display:inline-flex; align-items:center; gap:4px; cursor:pointer;
                list-style:none; padding:2px 9px; border-radius:999px; border:1px solid var(--pw-line);
                min-height:26px; box-sizing:border-box; }
        .vscope > summary::-webkit-details-marker { display:none; }
        .vscope > summary::after { content:"▾"; font-size:.9em; color:var(--pw-dim); }
        .vscope > summary b { color:var(--pw-text); font-weight:600; }
        .vscope[open] > summary { border-color:var(--pw-accent); }
        .vscope-pop { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
        .vscope-pop .on { border-color:var(--pw-accent); color:var(--pw-accent); }
        .vbadge.vbadge-quiet { background:var(--pw-surface-2); color:var(--pw-text);
                border:1px solid var(--pw-line); }
        .vpreview-line { margin-bottom:12px; }
        .vpreview-line { display:flex; flex-direction:column; gap:4px; }
        .vpreview-line textarea { display:block; width:100%; box-sizing:border-box; margin-top:6px;
                min-height:4.6em; resize:vertical; padding:11px 13px; border-radius:11px;
                border:1px solid var(--pw-line); background:rgba(0,0,0,.25); color:var(--pw-text);
                font:inherit; font-size:1em; line-height:1.45; }
        .vpreview-line textarea::placeholder { color:var(--pw-dim); }

        /* --- Newsroom: a small control desk -------------------------------- */
        /* Same room as the Booth, one step further back: the top of the
           screen REPORTS, the card below it is where you change something.
           Nothing here is a form until you get to the form. */
        .news-state { margin:14px 0 0; }
        .news-facts-row { margin-top:12px; margin-bottom:0; }
        /* When the window is too narrow to keep the state and the next
           window on one line, the leading separator would start a line by
           itself. Below that width the detail simply becomes its own line. */
        @media (max-width: 700px) {
          .news-state { display:block; }
          .news-state .state-detail { display:block; margin-top:5px; }
          .news-state .state-detail::before { content:none; }
        }
        .news-state .state-label { letter-spacing:.14em; }
        .news-trouble { margin-top:12px; padding:11px 14px; border-radius:11px;
                font-size:.9em; line-height:1.5; color:var(--pw-text);
                background:rgba(255,193,7,.12); border-left:3px solid #ffc94d; }
        /* The three promises the whole feature rests on. Said once, plainly,
           where a person decides whether to switch it on. */
        .news-rules { display:flex; flex-wrap:wrap; gap:6px 18px; margin-top:16px;
                padding-top:14px; border-top:1px solid var(--pw-line);
                color:var(--pw-dim); font-size:.82em; }
        .news-rules span { position:relative; padding-left:14px; }
        .news-rules span::before { content:""; position:absolute; left:0; top:.52em;
                width:5px; height:5px; border-radius:50%; background:var(--pw-accent);
                transition:background 700ms ease; }

        /* what the station is holding */
        .wire { display:flex; align-items:flex-start; gap:12px; flex-wrap:wrap;
                padding:13px 15px; border-radius:13px; background:var(--pw-surface-2);
                border-left:3px solid var(--pw-accent); transition:border-color 700ms ease; }
        .wire-body { flex:1; min-width:150px; }
        .wire-source { font-size:1.2em; font-weight:600; overflow-wrap:anywhere; }
        .wire-episode { margin-top:5px; font-size:.95em; color:var(--pw-muted);
                overflow-wrap:anywhere; line-height:1.5; }
        /* An episode title is METADATA. The tag in front of it is what stops
           it reading as a headline somebody reported. */
        .wire-tag { display:inline-block; font-size:.66em; letter-spacing:.12em;
                text-transform:uppercase; font-weight:700; color:var(--pw-dim);
                border:1px solid var(--pw-line); border-radius:5px;
                padding:1px 6px; margin-right:7px; vertical-align:middle; }
        .wire-meta { color:var(--pw-dim); font-size:.84em; margin-top:6px; }
        /* One row per newsroom, so they need to be told apart. A source
           with nothing airable loses the accent edge -- the same signal the
           badge gives, in the shape of the row itself. */
        .wire + .wire { margin-top:10px; }
        .wire.quiet { border-left-color:var(--pw-line); }
        .wire-when { color:var(--pw-muted); font-size:.84em; margin-top:2px; }
        .wire-why { color:var(--pw-dim); font-size:.8em; margin-top:6px;
                overflow-wrap:anywhere; line-height:1.45; }
        .vbadge.cold { background:var(--pw-surface-2); color:var(--pw-dim);
                box-shadow:inset 0 0 0 1px var(--pw-line); }

        /* The two text fields. A station's name for its newsroom is a real
           name -- clipping it at 160px would be the interface telling the
           owner their name is too long. */
        input.news-name { flex:0 1 280px; min-width:200px; }
        .controls .control.news-url { align-items:flex-start; }
        .controls .control.news-url input[type=text] { flex:1 1 320px; min-width:200px; }

        /* the test result: an answer, not a log line */
        .news-test { margin-top:14px; padding:14px 16px; border-radius:13px;
                border:1px solid var(--pw-line); background:rgba(0,0,0,.22); }
        .news-test.good { border-left:3px solid #7cc47f; }
        .news-test.bad { border-left:3px solid #ffa726; }
        .news-test-head { font-weight:600; margin-bottom:6px; }
        .news-test-body { color:var(--pw-muted); font-size:.92em; line-height:1.5;
                overflow-wrap:anywhere; }
        .news-test-detail { margin-top:8px; color:var(--pw-dim); font-size:.82em;
                overflow-wrap:anywhere; font-variant-numeric:tabular-nums; }
        .news-test-foot { margin-top:10px; color:var(--pw-dim); font-size:.82em; }
        /* Dial Stations: the tiles of the Dial stage and the sheet that
           creates or edits one -- setup, never the live console */
        .dial-tiles { display:grid; grid-template-columns:repeat(auto-fill, minmax(186px, 1fr));
                gap:12px; }
        .dial-note { margin:0 0 12px; overflow-wrap:anywhere; }
        .dial-editor { display:flex; flex-direction:column; gap:12px; }
        .dial-editor .sheet-head, .dial-editor .sheet-acts { margin:0; }
        .dial-field { display:flex; flex-direction:column; gap:4px; min-width:0; }
        .dial-field input, .dial-field select { width:100%; max-width:none; box-sizing:border-box; }
        .dial-field .hint { margin-top:2px; overflow-wrap:anywhere; }
        .dial-check { display:flex; gap:10px; align-items:center; align-self:end; min-height:44px; }
        .dial-check input { width:18px; height:18px; flex:none; accent-color:var(--pw-accent); }
        .dial-testrow { margin-top:0; gap:10px 14px; }
        .dial-testrow .hint { flex:1 1 260px; margin-top:0; overflow-wrap:anywhere; }
        .dial-remove-ask { display:inline-flex; flex-wrap:wrap; gap:6px; }
        .dial-preview-mark { font-size:.72em; font-weight:700; letter-spacing:.08em;
                text-transform:uppercase; color:var(--pw-dim); margin-bottom:6px; }
        .dial-warn { margin:8px 0 0; padding-left:18px; color:#ffa726; font-size:.9em; }
        .dial-tracks { margin:10px 0 0; padding-left:26px; display:flex; flex-direction:column; gap:6px; }
        .dial-tracks li { overflow-wrap:anywhere; }
        .dial-t { display:block; }
        .dial-m { display:block; color:var(--pw-dim); font-size:.82em; }
        .dial-how { margin-top:10px; color:var(--pw-muted); font-size:.88em; }
        .dial-how summary { cursor:pointer; }
        .dial-live { margin-top:8px; font-size:.9em; overflow-wrap:anywhere; }
        .dial-live.ok { color:#7cc47f; }
        .dial-live.weak { color:#ffa726; }
        .dial-stale-note { margin:0 0 8px; padding:8px 10px; border:1px solid #ffa726;
                border-radius:9px; color:#ffa726; font-weight:600; font-size:.9em;
                overflow-wrap:anywhere; }
        .dial-stale-note[hidden] { display:none; }
        .dial-stale .dial-tracks, .dial-stale .news-test-head,
        .dial-stale .news-test-body, .dial-stale .dial-how, .dial-stale .dial-warn,
        .dial-stale .dial-live { opacity:.4; text-decoration:line-through; }
        /* On-air station: LIVE. The on-air line in the Dial stage's status --
           broadcast red ONLY for a station on the air now, the accent while
           a start is being confirmed, quiet otherwise -- and the choose sheet
           under a pressed tile, the one place that can put a station on. */
        .air-status { display:flex; flex-direction:column; gap:4px; }
        .air-line { display:flex; flex-wrap:wrap; align-items:flex-start; gap:6px 10px;
                font-size:1.02em; line-height:1.5; color:var(--pw-muted); }
        .air-lamp { flex:none; width:9px; height:9px; margin-top:.5em; border-radius:50%;
                background:rgba(255,255,255,.22); }
        .air-line.on .air-lamp { background:var(--pw-lamp); box-shadow:0 0 10px var(--pw-lamp); }
        .air-line.starting .air-lamp { background:var(--pw-accent); box-shadow:0 0 10px var(--pw-glow); }
        .air-text { flex:1 1 240px; min-width:0; overflow-wrap:anywhere; }
        .air-text b { color:var(--pw-text); font-weight:600; }
        .air-line.off .air-text { color:var(--pw-dim); }
        .air-word { margin-right:4px; font-size:.8em; font-weight:700; letter-spacing:.12em;
                text-transform:uppercase; }
        .air-line.on .air-word { color:var(--pw-lamp); }
        .air-line.starting .air-word { color:var(--pw-accent); }
        .air-acts { display:flex; flex-wrap:wrap; gap:6px; margin-left:auto; }
        .air-meta { display:block; margin-top:3px; color:var(--pw-dim); font-size:.84em;
                line-height:1.5; overflow-wrap:anywhere; }
        .air-problem, .air-legacy { margin:8px 0 0 19px; }
        .air-confirm { margin-top:12px; padding:12px 14px; border-radius:12px;
                background:var(--pw-surface); border:1px solid var(--pw-accent);
                display:flex; flex-direction:column; gap:8px; }
        .air-confirm .hint { margin-top:0; color:var(--pw-muted); overflow-wrap:anywhere; }
        .air-status .air-confirm { margin:8px 0 0 19px; }
        .air-verdict { padding:12px 14px; border-radius:12px; background:rgba(0,0,0,.25);
                border-left:3px solid var(--pw-line); line-height:1.5; overflow-wrap:anywhere; }
        .air-verdict.ok { border-left-color:#7cc47f; }
        .air-verdict.warn, .air-verdict.weak { border-left-color:#ffa726; }
        .air-verdict .hint { margin-top:4px; }
        .air-form .dial-field { max-width:420px; margin-top:12px; }
        .air-form select { width:100%; max-width:none; box-sizing:border-box; }
        .air-form .hint { overflow-wrap:anywhere; }
        .hand-list { display:flex; flex-direction:column; gap:4px; margin:8px 0;
                     max-height:280px; overflow-y:auto; }
        .hand-song { display:flex; gap:8px; align-items:center; justify-content:space-between;
                     padding:4px 2px; border-bottom:1px solid var(--pw-line); }
        .hand-song input { margin:0 6px 0 0; }
        .hand-song span:first-of-type { flex:1 1 auto; overflow-wrap:anywhere; }
        .hand-song.kept { color:var(--pw-dim); }
        .air-request .row input { flex:1 1 16em; min-width:0; box-sizing:border-box; }
        .air-request select { width:100%; max-width:none; box-sizing:border-box; }
        .air-request .notice { margin:10px 0 0; }
        /* THE TEST SITS WITH THE FIELD IT TESTS: the input and its button
           on one row, the answer directly beneath, so the whole exchange
           is one object on the page and the reader never has to carry an
           address down the card to a button at the foot of it. */
        .controls .control.svc-url { align-items:flex-start; }
        .svc-url-entry { flex:1 1 360px; min-width:0; }
        .svc-url-row { margin-top:0; flex-wrap:wrap; }
        .svc-url-row input[type=text] { flex:1 1 220px; min-width:0; }
        .svc-url-entry .news-test { margin-top:10px; }
        .svc-picks { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
        .svc-pick-label { color:var(--pw-dim); margin-right:2px; }
        .svc-pick-more { color:var(--pw-dim); }
        /* A name the service offered, as something to press. Quiet until
           hovered: these are suggestions, not the controls of the card. */
        .chip-btn { padding:5px 10px; border-radius:999px; font-size:.92em;
                    border:1px solid var(--pw-line); background:rgba(0,0,0,.22);
                    color:var(--pw-text); cursor:pointer; min-height:0;
                    transition:border-color .2s ease, background .2s ease; }
        .chip-btn:hover { border-color:var(--pw-accent); background:rgba(0,0,0,.34); }
        .chip-btn:focus-visible { outline:2px solid var(--pw-accent); outline-offset:2px; }
        /* --- Station: where the music comes from ---------------------------
           The Dial is the stage. The hero is the station itself --
           its plate, then the two truths about what is playing: the house
           line in the accent, the on-air line in broadcast red, and red ONLY
           for a station on the air now -- then the saved stations as tiles
           with at most one sheet under them; a selected tile wears a white
           ring, never red. The Request Line, Programming and Advanced follow,
           in the same room as the Booth and the Newsroom. The unavailable
           list is quiet and legible rather than alarmed -- it is a
           description of a different tier, not a fault. */
        .station-desk { padding:20px 22px 22px; }
        .station-desk > * { position:relative; }
        .station-desk > .stage-glow { position:absolute; }
        .deck-head { display:flex; flex-wrap:wrap; align-items:center; gap:16px 22px;
                padding-bottom:16px; margin-bottom:16px; border-bottom:1px solid var(--pw-line); }
        .deck-badge { flex:none; display:flex; flex-direction:column; align-items:center;
                gap:6px; max-width:100%; }
        /* The wordmark and the plate are drawn in the 520 x 150 badge cell.
           Their margins trim that cell to the ink, so each layout box is the
           artwork itself; the plate's measured size arrives from the fit as
           --plate-w and --plate-h, in cell units. */
        .deck-emblem { --emb:158px; display:block; width:var(--emb); height:auto;
                margin:calc(var(--emb) * -30 / 520) calc(var(--emb) * -71 / 520)
                       calc(var(--emb) * -33 / 520) calc(var(--emb) * -60 / 520); }
        .deck-plate { --cell:420px; --plate-w:224; --plate-h:52; position:relative; display:block;
                flex:none; width:var(--cell); aspect-ratio:520 / 150; pointer-events:none;
                margin:calc((var(--plate-h) - 150) / 300 * var(--cell) * 150 / 520)
                       calc((var(--plate-w) - 520) / 1040 * var(--cell)); }
        .deck-name-edit { min-height:30px; padding:4px 12px; font-size:.78em; letter-spacing:.06em;
                color:var(--pw-dim); }
        .deck-status { flex:1 1 320px; min-width:0; display:flex; flex-direction:column; gap:10px; }
        .st-truth { display:flex; flex-direction:column; gap:9px; }
        .st-row { display:flex; align-items:flex-start; gap:10px;
                  font-size:1.02em; line-height:1.5; color:var(--pw-muted); }
        .st-dot { flex:none; width:9px; height:9px; border-radius:50%; margin-top:.5em;
                  background:rgba(255,255,255,.22); }
        .st-dot.live { background:var(--pw-accent); box-shadow:0 0 10px var(--pw-glow); }
        .st-line { flex:1 1 auto; min-width:0; overflow-wrap:anywhere; }
        .st-label { font-weight:600; color:var(--pw-text); }
        .st-detail { color:var(--pw-muted); overflow-wrap:anywhere; }
        /* A small standing label on a source row: what it IS, not what is
           wrong with it. "Optional" is a fact about the product, so it is
           quiet; "In use" is the live one, so it carries the accent. */
        .st-tag { font-size:.72em; letter-spacing:.06em; text-transform:uppercase;
                  border:1px solid var(--pw-line); border-radius:999px;
                  padding:1px 7px; margin-left:7px; color:var(--pw-muted);
                  white-space:nowrap; vertical-align:middle; }
        .st-tag.on { border-color:var(--pw-accent); color:var(--pw-accent); }
        .st-adds { display:flex; flex-direction:column; gap:15px; }
        .st-add { display:flex; gap:13px; align-items:flex-start; }
        .st-add .label { margin-bottom:3px; }
        .st-add .hint { margin:0; }
        .st-icon { flex:none; font-size:1.2em; line-height:1.4; width:1.5em; text-align:center; }
        /* the tiles: one per saved station, then New station */
        .preset { position:relative; display:flex; flex-direction:column; align-items:stretch;
                gap:4px; min-width:0; min-height:104px; padding:13px 14px 12px; text-align:left;
                border-radius:14px; border:1px solid var(--pw-line); background:rgba(0,0,0,.26);
                color:var(--pw-text); font-size:1em; font-weight:500; line-height:1.3;
                transition:border-color .2s ease, background .2s ease, box-shadow .2s ease; }
        .preset:hover:not(:disabled) { background:rgba(0,0,0,.36); border-color:rgba(255,255,255,.22); }
        .preset-label { padding-right:18px; font-size:1.12em; font-weight:600; overflow-wrap:anywhere; }
        .preset-term { color:var(--pw-muted); font-size:.84em; overflow-wrap:anywhere; }
        .preset-state { display:flex; align-items:flex-start; gap:6px; margin-top:auto; padding-top:6px;
                color:var(--pw-dim); font-size:.74em; line-height:1.4; letter-spacing:.04em;
                overflow-wrap:anywhere; }
        .preset-state .st-ico { width:13px; height:13px; margin-top:1px; }
        .preset-state.ok { color:#7cc47f; }
        .preset-state.warn { color:#ffa726; }
        .preset-lamp { display:inline-block; flex:none; width:8px; height:8px; border-radius:50%;
                background:var(--pw-lamp); box-shadow:0 0 8px var(--pw-lamp); }
        .preset > .preset-lamp { position:absolute; top:14px; right:14px; }
        .preset.onair { border-color:rgba(255,65,51,.6); background:rgba(255,65,51,.06);
                box-shadow:0 0 0 1px rgba(255,65,51,.35), 0 0 22px rgba(255,65,51,.14); }
        .preset.onair .preset-state.lit { color:var(--pw-lamp); font-weight:700; letter-spacing:.08em;
                text-transform:uppercase; }
        .preset.off { opacity:.6; }
        .preset.picked { opacity:1; border-color:rgba(255,255,255,.6); background:rgba(255,255,255,.07);
                box-shadow:0 0 0 1px rgba(255,255,255,.35); }
        .preset.onair.picked { box-shadow:0 0 0 1px rgba(255,255,255,.35), 0 0 22px rgba(255,65,51,.14); }
        .preset:disabled { opacity:.4; cursor:default; }
        .preset.new { align-items:center; justify-content:center; gap:6px; text-align:center;
                border-style:dashed; background:transparent; color:var(--pw-dim); }
        .preset.new:hover:not(:disabled) { color:var(--pw-text); }
        .preset.new.picked { border-style:solid; color:var(--pw-text); }
        .preset.new .st-ico { width:22px; height:22px; }
        /* the sheets: one under the tiles (choose, or create and edit), and
           the name sheet under the plate */
        .sheet { margin-top:14px; padding:16px; border-radius:14px; background:rgba(0,0,0,.22);
                border:1px solid rgba(255,255,255,.35); }
        .sheet-head { display:flex; flex-wrap:wrap; align-items:center; gap:8px 10px; margin-bottom:12px; }
        .sheet-title { display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px; flex:1 1 auto;
                min-width:0; font-size:1.15em; font-weight:600; overflow-wrap:anywhere; }
        .sheet-close { display:inline-flex; align-items:center; justify-content:center; flex:none;
                width:36px; height:36px; min-height:36px; padding:0; border-radius:50%;
                background:none; border:1px solid var(--pw-line); color:var(--pw-dim); }
        .sheet-close:hover:not(:disabled) { color:var(--pw-text); border-color:rgba(255,255,255,.3); }
        .sheet-chip { display:inline-flex; align-items:center; gap:6px; padding:3px 11px;
                border-radius:999px; border:1px solid rgba(255,255,255,.4); background:var(--pw-surface);
                color:var(--pw-text); font-size:.72em; font-weight:500; letter-spacing:.02em; }
        .sheet-chip.lit { color:var(--pw-lamp); border-color:rgba(255,65,51,.5); }
        .sheet-grid { display:grid; grid-template-columns:minmax(0, 1fr) minmax(0, 1fr);
                gap:14px 18px; align-items:start; }
        .sheet-acts { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:14px; }
        .name-sheet { margin:0 0 16px; }
        .name-sheet .row { margin-top:0; }
        .name-sheet .row input[type=text] { flex:1 1 14em; min-width:0; }
        .name-sheet .notice { margin:10px 0 0; }
        /* the Request Line: its own compact card under the Dial */
        .rl-card { padding:14px 18px; }
        .rl-row { margin-top:0; gap:10px; }
        .rl-title { flex:none; min-width:120px; margin:0; color:var(--pw-dim); font-size:.78em;
                font-weight:600; letter-spacing:.14em; text-transform:uppercase; }
        .rl-card .hint { overflow-wrap:anywhere; }
        .rl-hint { margin-top:6px; }
        /* alpha.4: one song, next -- its own row under the station row */
        .rl-song { margin-top:14px; padding-top:12px; border-top:1px solid var(--pw-line); }
        .rl-song-hint { margin-top:6px; }
        /* Programming: three rows, each a state and a door */
        .prog { display:flex; flex-direction:column; }
        .prog-row { display:grid; grid-template-columns:28px minmax(0, 1fr) auto; align-items:center;
                gap:8px 12px; padding:12px 0; border-bottom:1px solid var(--pw-line); }
        .prog-row:last-child { border-bottom:none; padding-bottom:0; }
        .prog-icon { display:flex; color:var(--pw-dim); }
        .prog-body { min-width:0; }
        .prog-sum { margin-top:2px; color:var(--pw-dim); font-size:.86em; line-height:1.5;
                overflow-wrap:anywhere; }
        .prog-body .hint { margin-top:6px; overflow-wrap:anywhere; }
        .prog-act { display:flex; flex-wrap:wrap; align-items:center; justify-content:flex-end; gap:6px; }
        .prog-act .inlink { display:inline-flex; align-items:center; justify-content:center;
                min-height:36px; padding:7px 13px; border-radius:9px; border:1px solid var(--pw-line);
                background:var(--pw-surface-2); color:var(--pw-text); font-size:.85em;
                font-weight:500; text-decoration:none; }
        .prog-act .inlink:hover { background:rgba(255,255,255,.13); color:var(--pw-text); }
        .prog-more { grid-column:2 / -1; padding:4px 0 2px; }
        .prog-more .controls { border-top:1px solid var(--pw-line); }
        .prog-more .qhead { margin-top:12px; }
        /* Advanced: closed by default, its state kept on the component */
        .st-adv { margin-top:4px; }
        .st-adv > summary { display:inline-flex; align-items:center; gap:8px; min-height:44px;
                padding:10px 2px; list-style:none; cursor:pointer; color:var(--pw-dim);
                font-size:.8em; letter-spacing:.1em; text-transform:uppercase; }
        .st-adv > summary::-webkit-details-marker { display:none; }
        .st-adv > summary::before { content:"›"; display:inline-block; width:1em;
                font-size:1.5em; line-height:1; text-align:center; transition:transform .2s ease; }
        .st-adv[open] > summary::before { transform:rotate(90deg); }
        .st-adv > summary:hover, .st-adv[open] > summary { color:var(--pw-text); }
        .st-adv > summary:focus-visible { outline:2px solid var(--pw-accent);
                outline-offset:2px; border-radius:6px; }
        /* A sheet or question focus was moved into: ringed for the keyboard only */
        [data-focus]:focus { outline:none; }
        [data-focus]:focus-visible { outline:2px solid var(--pw-accent); outline-offset:2px; }
        .st-adv-body { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:14px;
                margin-top:4px; }
        .st-adv-body .card { margin-bottom:0; }
        .st-ico { width:18px; height:18px; flex:none; fill:none; stroke:currentColor;
                stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }

        /* --- Settings: a setup desk, not a form ----------------------------
           The same room as the Booth, the Newsroom and Station. What makes
           this one a SETUP screen rather than a control panel is that
           almost nothing on it is pressable: it is rows of state, with a
           route out to whichever screen or Home Assistant page actually
           owns the thing. The first-run install -- four steps, none done --
           is the state this was designed around, not the leftover one, so
           the checklist keeps its full weight with every row undone. */
        .settings-desk .booth-name { margin:0; }
        .ready-line { display:flex; align-items:center; gap:12px; margin-bottom:6px; }
        .ready-dot { flex:none; width:12px; height:12px; border-radius:50%;
                background:var(--pw-dim); box-shadow:inset 0 0 0 1px rgba(0,0,0,.35); }
        .ready-dot.ok { background:#7cc47f; box-shadow:0 0 10px rgba(124,196,127,.45); }
        .ready-dot.setup { background:var(--pw-accent); box-shadow:0 0 10px var(--pw-glow); }
        .ready-dot.bad { background:#ffa726; box-shadow:0 0 10px rgba(255,167,38,.45); }
        .ready-meter { display:flex; align-items:center; gap:12px; margin-top:16px; }
        /* The track is a touch brighter than the On Air progress bar: it
           sits on the lighter hero surface, and at 0 of 4 -- the state a
           new owner actually sees -- the track IS the meter. */
        .ready-bar { flex:1; max-width:320px; height:4px; border-radius:3px;
                overflow:hidden; background:rgba(255,255,255,.18); }
        .ready-fill { height:100%; background:var(--pw-accent);
                transition:width 600ms ease, background 700ms ease; }
        .ready-fill.ok { background:#7cc47f; }
        .ready-fill.bad { background:#ffa726; }
        .ready-count { color:var(--pw-dim); font-size:.82em; white-space:nowrap;
                font-variant-numeric:tabular-nums; }

        /* the checklist */
        .ck { display:flex; flex-direction:column; }
        .ck-row { display:grid; grid-template-columns:26px minmax(0,1fr) auto;
                align-items:start; gap:6px 13px; padding:13px 0;
                border-bottom:1px solid var(--pw-line); }
        .ck-row:last-child { border-bottom:none; }
        .ck-mark { grid-row:1 / span 2; align-self:center; width:22px; height:22px;
                border-radius:50%; display:flex; align-items:center; justify-content:center;
                font-size:.8em; font-weight:700; color:#1a1206;
                background:#7cc47f; }
        /* an undone step is an empty ring, never a red cross: it has not
           been done yet, which is not the same as having gone wrong */
        .ck-row.todo .ck-mark { background:transparent; color:transparent;
                box-shadow:inset 0 0 0 2px var(--pw-line); }
        .ck-body { min-width:0; }
        .ck-body .hint { margin-top:3px; }
        .ck-row.done .ck-body .label { color:var(--pw-muted); }
        .ck-go { grid-column:3; grid-row:1 / span 2; align-self:center; }

        /* a section's own verdict: one badge, one sentence */
        .set-head { display:flex; align-items:flex-start; gap:13px; flex-wrap:wrap;
                margin-bottom:4px; }
        .set-badge { flex:none; font-size:.7em; letter-spacing:.1em; text-transform:uppercase;
                font-weight:700; padding:4px 9px; border-radius:6px; white-space:nowrap;
                background:var(--pw-surface-2); color:var(--pw-dim);
                box-shadow:inset 0 0 0 1px var(--pw-line); }
        .set-badge.ok { background:rgba(124,196,127,.18); color:#7cc47f;
                box-shadow:inset 0 0 0 1px rgba(124,196,127,.35); }
        .set-badge.setup { background:var(--pw-accent); color:#1a1206; box-shadow:none; }
        .set-badge.warn { background:rgba(255,201,77,.16); color:#ffc94d;
                box-shadow:inset 0 0 0 1px rgba(255,201,77,.35); }
        .set-badge.bad { background:rgba(255,167,38,.18); color:#ffa726;
                box-shadow:inset 0 0 0 1px rgba(255,167,38,.4); }
        .set-detail { flex:1; min-width:180px; color:var(--pw-muted);
                font-size:.95em; line-height:1.55; }

        /* the DJ-enabled speakers: a list of facts, not a selector */
        .spk { display:flex; flex-direction:column; margin-top:12px; }
        .spk-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap;
                padding:9px 0; border-bottom:1px solid var(--pw-line); }
        .spk-row:last-child { border-bottom:none; }
        .spk-dot { flex:none; width:8px; height:8px; border-radius:50%;
                background:var(--pw-dim); }
        .spk-dot.on { background:#7cc47f; }
        .spk-tag { font-size:.68em; letter-spacing:.1em; text-transform:uppercase;
                font-weight:700; color:var(--pw-dim); padding:3px 8px; border-radius:6px;
                background:var(--pw-surface-2); box-shadow:inset 0 0 0 1px var(--pw-line); }
        .spk-tag.now { background:var(--pw-accent); color:#1a1206; box-shadow:none; }

        /* a capability: what it is, what this installation has, where it
           is configured. The badge carries the verdict so an absent
           optional feature reads as a fact and never as a fault. */
        .cap { display:flex; flex-direction:column; }
        .cap-row { display:grid; grid-template-columns:auto minmax(0,1fr) auto;
                align-items:start; gap:6px 13px; padding:12px 0;
                border-bottom:1px solid var(--pw-line); }
        .cap-row:last-child { border-bottom:none; }
        .cap-badge { grid-row:1; align-self:start; margin-top:1px; flex:none;
                font-size:.68em; letter-spacing:.1em; text-transform:uppercase;
                font-weight:700; padding:4px 9px; border-radius:6px; white-space:nowrap;
                background:var(--pw-surface-2); color:var(--pw-dim);
                box-shadow:inset 0 0 0 1px var(--pw-line); }
        .cap-badge.on { background:var(--pw-accent); color:#1a1206; box-shadow:none; }
        /* "this is fine" is not the same statement as "this is a
           Parlorwave capability that is switched on", and the accent is
           reserved for the second one. */
        .cap-badge.ok { background:rgba(124,196,127,.18); color:#7cc47f;
                box-shadow:inset 0 0 0 1px rgba(124,196,127,.35); }
        .cap-badge.warn { background:rgba(255,201,77,.16); color:#ffc94d;
                box-shadow:inset 0 0 0 1px rgba(255,201,77,.35); }
        .cap-body { min-width:0; }
        .cap-body .hint { margin-top:3px; }
        .cap-go { grid-column:3; align-self:center; }

        /* a route out. A link into Home Assistant and a jump to another
           Parlorwave screen must look identical -- from where the reader
           sits they are the same act. */
        /* A link into Home Assistant and a jump to another Parlorwave
           screen must be the same object: from where the reader sits they
           are the same act, and one of them looking like a web link would
           make the other look like it does something different. */
        a.ghost.route { display:inline-block; text-decoration:none; line-height:1.4;
                white-space:nowrap; color:var(--pw-text); }
        .route-note { display:inline-block; color:var(--pw-dim); font-size:.82em;
                line-height:1.5; }
        .code { font-family:var(--paper-font-code1_-_font-family, ui-monospace, monospace);
                font-size:.92em; color:var(--pw-muted); }

        /* The Ready strip: once an installation is established the
           verdict is one compact card -- a lamp, the verdict, its sentence
           when there is one, and a chip per step. */
        .ready-strip { padding:16px 20px; }
        .ready-strip.bad { border-color:rgba(255,167,38,.45); }
        .ready-head { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
        .ready-strip .ready-title { margin:0; font-size:1.35em; font-weight:600; letter-spacing:0;
                text-transform:none; color:var(--pw-text); line-height:1.2; }
        .ready-steps-btn { margin-left:auto; }
        .ready-desc { margin-top:6px; color:var(--pw-muted); line-height:1.5; overflow-wrap:anywhere; }
        .ready-chips { display:flex; flex-wrap:wrap; gap:7px; margin-top:12px; }
        .ready-chip { display:inline-flex; align-items:center; gap:6px; font-size:.82em;
                color:var(--pw-muted); padding:5px 11px 5px 8px; border-radius:999px;
                border:1px solid var(--pw-line); background:var(--pw-surface); }
        .ready-chip .st-ico { width:13px; height:13px; }
        .ready-chip.done .st-ico { color:#7cc47f; }
        .ready-chip.attn { border-color:rgba(255,167,38,.5); color:#ffa726; }
        .ready-chip.todo { color:var(--pw-text); }
        .ready-ring { flex:none; width:9px; height:9px; border-radius:50%;
                box-shadow:inset 0 0 0 2px var(--pw-accent); }
        /* the steps: the open one in the accent, one that went wrong in
           amber with a "!" -- still a ring, never a cross */
        .ck-row.ck-open .ck-mark { box-shadow:inset 0 0 0 2px var(--pw-accent); }
        .ck-row.ck-attn .ck-mark { box-shadow:inset 0 0 0 2px #ffa726; }
        .ck-row.ck-attn .ck-mark::after { content:"!"; color:#ffa726; }
        .ck-row.ck-open .ck-mark, .ck-row.ck-open .ck-go { align-self:start; }
        .ck-row.ck-open .ck-body .label { color:var(--pw-text); font-weight:600; }
        .ck-tools { margin-top:10px; }
        .ck-tools table { max-width:560px; }
        /* What the DJ may use: three rows, a name and a sentence on the
           left, the list and its Save on the right. The same row the
           Console uses, with a list where the Console has a pill. */
        .src-card:focus { outline:none; }
        .src-card:focus-visible { outline:2px solid var(--pw-accent); outline-offset:2px; }
        .src-row { display:grid; grid-template-columns:minmax(150px,230px) minmax(0,1fr);
                align-items:start; gap:8px 28px; padding:14px 0; border-top:1px solid var(--pw-line); }
        /* A Save with nothing to save recedes to an outline: three filled
           brown blocks at rest read as three things to press. It fills
           the moment a choice differs from what is stored. */
        .spk-acts > button:not(.ghost):disabled { background:transparent; color:var(--pw-dim);
                box-shadow:inset 0 0 0 1px var(--pw-line); opacity:.75; }
        .src-row:first-of-type { border-top:none; padding-top:2px; }
        .src-row:focus { outline:none; }
        .src-head { min-width:0; }
        .src-head .hint { margin-top:3px; }
        .src-body { min-width:0; }
        .src-body .spk-line .spk { margin-top:0; }
        .src-body .news-test { margin-top:12px; }
        .src-body > .hint { margin-top:6px; }
        .src-warn { color:var(--pw-text); }
        .src-warn .badge { margin-right:6px; }
        .src-foot { margin-top:14px; padding-top:12px; border-top:1px solid var(--pw-line); }
        .spk-tag.warn { background:rgba(255,167,38,.16); color:#ffa726;
                box-shadow:inset 0 0 0 1px rgba(255,167,38,.4); }
        /* the speakers: one wrapping row, Save at its end */
        .spk-line { display:flex; align-items:center; gap:6px 18px; flex-wrap:wrap; }
        .spk-line .spk { flex:1 1 auto; flex-direction:row; flex-wrap:wrap; gap:0 18px; margin-top:0; }
        .spk-line .spk-acts { margin-top:0; margin-left:auto; }
        /* the console: a row per choice */
        .set-ctl { display:flex; align-items:center; justify-content:space-between;
                gap:10px 20px; flex-wrap:wrap; padding:12px 0; border-top:1px solid var(--pw-line); }
        .set-ctl:first-of-type { border-top:none; padding-top:0; }
        .set-ctl-text { flex:1 1 220px; min-width:0; }
        .set-ctl-text .hint { margin-top:2px; }
        .fp-options { display:flex; flex-wrap:wrap; gap:8px; }
        /* Extras: one closed line until it is opened; the sections inside
           lose their own card chrome */
        details.extras { padding:0; }
        details.extras > summary { list-style:none; cursor:pointer; display:flex; align-items:center;
                gap:10px; padding:14px 18px; min-height:44px; flex-wrap:wrap; border-radius:16px; }
        details.extras > summary::-webkit-details-marker { display:none; }
        details.extras > summary::before { content:"›"; display:inline-block; width:1em;
                font-size:1.5em; line-height:1; text-align:center; color:var(--pw-dim);
                transition:transform .2s ease; }
        details.extras[open] > summary::before { transform:rotate(90deg); }
        details.extras > summary:focus-visible { outline:2px solid var(--pw-accent);
                outline-offset:2px; }
        .extras-title { font-size:.78em; color:var(--pw-dim); text-transform:uppercase;
                letter-spacing:.14em; font-weight:600; }
        .extras-sum { color:var(--pw-dim); font-size:.84em; min-width:0; }
        .extras-body { padding:0 18px 6px; border-top:1px solid var(--pw-line); }
        .extras-body > .card, .support > .card { background:none; border:none; border-radius:0;
                margin:0; padding:16px 0; border-top:1px solid var(--pw-line); }
        .extras-body > .card:first-child { border-top:none; }
        /* support details: a quiet foot toggle, then one plain card */
        .support-foot { display:flex; justify-content:center; padding:4px 0 2px; }
        .support-foot .support-btn { background:transparent; border-color:transparent;
                color:var(--pw-dim); letter-spacing:.1em; text-transform:uppercase; font-size:.76em; }
        .support-foot .support-btn:hover:not(:disabled) { background:var(--pw-surface);
                color:var(--pw-text); }
        .support > .hint { margin-top:0; }
        .support-diag { padding-top:16px; border-top:1px solid var(--pw-line); }

        /* --- notices, problems, diagnostics ------------------------------- */
        blockquote { border-left:2px solid var(--pw-accent); margin:10px 0 0; padding:4px 12px;
                     color:var(--pw-muted); font-style:italic; }
        table { width:100%; border-collapse:collapse; font-size:.9em; }
        td { padding:7px 8px; border-bottom:1px solid var(--pw-line); }
        td:first-child { color:var(--pw-dim); width:45%; }
        .notice { border-radius:11px; padding:11px 13px; margin-bottom:12px;
                  font-size:.9em; display:flex; align-items:flex-start;
                  gap:10px; }
        .notice-text { flex:1 1 auto; min-width:0; overflow-wrap:anywhere; }
        /* The dismissal is a real control: full size for a finger, and it
           says what it does to a screen reader rather than being a glyph. */
        .notice-count { display:inline-block; margin-left:6px; padding:0 6px; border-radius:8px;
                        font-size:.82em; font-weight:700; background:rgba(255,255,255,.12); }
        .notice-x { flex:none; background:none; border:0; color:inherit;
                    font-size:1.25em; line-height:1; padding:0 2px;
                    min-width:32px; min-height:32px; cursor:pointer;
                    opacity:.75; border-radius:8px; }
        .notice-x:hover { opacity:1; }
        .notice-x:focus-visible { outline:2px solid var(--pw-accent);
                                  outline-offset:2px; }
        .notice.ok { background:rgba(76,175,80,.16); border:1px solid rgba(76,175,80,.3); }
        .notice.err { background:rgba(244,67,54,.16); border:1px solid rgba(244,67,54,.32); }
        .notice-more { display:block; margin-top:6px; font-size:.82em; opacity:.85; }
        .notice-more summary { cursor:pointer; }
        .notice-more code { display:block; margin-top:4px; word-break:break-all; font-size:.95em; }

        /* --- the success toast --------------------------------------------
         * OUT OF FLOW, so nothing on the page moves when it arrives or when
         * it goes. It is the last child of the shadow root rather than a
         * child of .wrap: position:fixed is resolved against the nearest
         * ancestor carrying a transform, filter or perspective, and keeping
         * it out of the page's own containers is what makes "bottom right of
         * the window" mean that on every screen this panel is hosted in.
         *
         * Bottom RIGHT on a desktop -- away from the header and the nav,
         * and away from the controls in the left column that a press has
         * just come from. Full width along the bottom edge on a phone,
         * where a floating card in a corner would either cover a control or
         * be too narrow to read.
         *
         * Translucent, but readable FIRST: the blur and the near-opaque
         * house background are what carry the text, and the border and the
         * shadow are what stop it dissolving into whatever is behind it.
         * A viewer whose browser has no backdrop-filter still gets the
         * background colour below, which is legible on its own. */
        .toast-wrap { position:fixed; right:18px; bottom:18px; z-index:60;
                      width:min(380px, calc(100vw - 36px));
                      pointer-events:none; }
        .toast-wrap .notice { margin:0; pointer-events:auto; }
        .notice.toast {
          background:linear-gradient(rgba(76,175,80,.20), rgba(76,175,80,.20)),
                     rgba(22,24,28,.88);
          border:1px solid rgba(76,175,80,.42);
          box-shadow:0 10px 30px rgba(0,0,0,.45);
          backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px);
          animation:toast-in .18s ease-out;
        }
        @keyframes toast-in {
          from { opacity:0; transform:translateY(8px); }
          to   { opacity:1; transform:none; }
        }
        @media (max-width:640px) {
          .toast-wrap { left:12px; right:12px; bottom:12px; width:auto; }
        }
        /* The same rule the Mouth and the DJ switch already follow. */
        @media (prefers-reduced-motion: reduce) {
          .notice.toast { animation:none; }
        }
        .problems-banner { display:flex; flex-direction:column; gap:8px; margin-bottom:16px; }
        .problem-card { display:flex; gap:12px; padding:13px 15px; border-radius:12px; align-items:flex-start; }
        .problem-card.fatal { background:rgba(244,67,54,.16); border-left:4px solid #ff5346; }
        .problem-card.error { background:rgba(255,152,0,.15); border-left:4px solid #ffa726; }
        .problem-card.warning { background:rgba(255,193,7,.12); border-left:4px solid #ffc94d; }
        .problem-icon { font-size:1.35em; line-height:1; flex:none; }
        .problem-body { flex:1; min-width:0; }
        .problem-header { display:flex; align-items:center; gap:8px; margin-bottom:4px; flex-wrap:wrap; }
        .problem-summary { font-weight:600; font-size:.95em; color:var(--pw-text); }
        .problem-action { font-size:.87em; color:var(--pw-muted); margin-top:4px; line-height:1.45; }
        .status-ok { color:#a5d6a7; background:rgba(76,175,80,.14); padding:11px 14px; border-radius:10px;
                     font-weight:500; font-size:.92em; }
        .setup-callout { background:rgba(255,152,0,.13); border-left:4px solid #ffa726;
                         padding:11px 14px; border-radius:10px; margin-top:12px; font-size:.88em; line-height:1.5; }
        .badge { display:inline-block; font-size:.7em; font-weight:700; padding:2px 7px;
                 border-radius:5px; text-transform:uppercase; letter-spacing:.06em; vertical-align:middle; }
        .badge.fatal { background:#ff5346; color:#180605; }
        .badge.error { background:#ffa726; color:#1a1206; }
        .badge.warning { background:#ffc94d; color:#1a1206; }
        .badge:not(.fatal):not(.error):not(.warning) { background:var(--pw-surface-2); color:var(--pw-dim); }
        .problems-list { display:flex; flex-direction:column; gap:8px; }
        .selected { color:var(--pw-accent); font-weight:600; transition:color 700ms ease; }

        /* --- 768px: the stage stacks, artwork stays the anchor ------------ */
        @media (max-width: 900px) {
          .wrap { padding:12px 14px 36px; }
          /* Five sections and the product name no longer fit on one line
             here: the name is nowrap (it is a name), so without this the
             navigation grows straight through it. The nav takes its own
             row instead -- the same thing it already does on a phone. */
          nav { width:100%; }
          .stage-grid { grid-template-columns:1fr; gap:18px; justify-items:center; text-align:center; }
          .art-wrap { width:min(58vw, 280px); }
          .booth-hero { padding:18px 16px; }
          .booth-name { font-size:1.7em; }
          .stage-meta { width:100%; }
          .state-line, .facts, .stage-actions, .lastbreak-head { justify-content:center; }
          /* ...but the Newsroom is a DESK, not the stage. Centring belongs
             to the thing built around a record sleeve; a status line and a
             pair of facts read as a column and stay left. */
          .news-desk .state-line, .news-desk .facts { justify-content:flex-start; }
          .station-desk .st-truth, .station-desk .air-status { text-align:left; }
          .station-desk .st-row { justify-content:flex-start; }
          .st-adv .facts { justify-content:flex-start; }
          .sheet-grid, .st-adv-body { grid-template-columns:minmax(0, 1fr); }
          /* Settings is a desk too: the verdict, the meter and every row
             read as a left-hand column and must not centre with the stage. */
          .settings-desk .ready-line, .settings-desk .ready-meter, .settings-desk .ready-chips {
                  justify-content:flex-start; text-align:left; }
          .track-title { font-size:1.8em; }
          /* the console reflows: the two eyes (DJ and speaker knobs) sit side by side
             above the mouth, and the mouth takes the full width beneath them */
          .console-deck { grid-template-columns:1fr 1fr; gap:18px 24px; padding:18px 18px 16px; }
          .console-dj { grid-column:1; grid-row:1; justify-self:center; }
          .console-spk { grid-column:2; grid-row:1; justify-self:center; }
          .console-deck .mouth { grid-column:1 / -1; grid-row:2; width:100%; max-width:540px; justify-self:center; margin:16px auto 0; }
          .mouth { height:90px; }
          /* the badge sits between the two eyes on their centre line, and
             shrinks with the gap between their rings (the cloth is the
             container; the vw line is the fallback without cqw) */
          .console-badge { top:95px; width:270px;
                           width:min(402px, calc((50vw - 182px) * 1.337));
                           width:min(402px, calc((50cqw - 156px) * 1.337)); }
          .console-foot { margin:0 18px 16px; }
          .console .lastbreak { padding:14px 18px 16px; }
        }
        @media (max-width: 900px) and (orientation: landscape) {
          .console-deck { grid-template-columns:1fr 1fr; gap:12px 24px; padding:14px 18px; }
          .console-dj { grid-column:1; grid-row:1; }
          .console-spk { grid-column:2; grid-row:1; }
          .console-deck .mouth { grid-column:1 / -1; grid-row:2; max-width:480px; margin:10px auto 0; }
          .mouth { height:76px; }
          .lcd-row-extra { display:none; }
          .console-badge { top:91px; width:270px;
                           width:min(354px, calc((50vw - 178px) * 1.337));
                           width:min(354px, calc((50cqw - 152px) * 1.337)); }
        }
        /* --- 390px: one hand, no horizontal scroll ------------------------ */
        @media (max-width: 560px) {
          .wrap { padding:10px 12px 32px; }
          .stage { padding:16px 14px; border-radius:16px; }
          .art-wrap { width:min(72vw, 250px); }
          .track-title { font-size:1.5em; }
          .track-sub { font-size:.95em; }
          header { gap:10px; padding-bottom:12px; }
          nav { width:100%; }
          nav button { flex:1; padding:11px 4px; font-size:.78em;
                       white-space:nowrap; letter-spacing:.04em; }
          button { min-height:44px; }                    /* touch targets */
          .stage-actions button { flex:1 1 auto; }
          .lyrics { max-height:220px; }
          .history { max-height:260px; }
          .controls .control { flex-direction:column; align-items:stretch; }
          select, input[type=number] { max-width:none; width:100%; }
          /* the same arrangement as the tablet, one hand sized: the two
             eyes stay side by side on the first row -- never one above
             the other with the Mouth between them -- and the Mouth takes
             the full width of the row beneath both. */
          .console { border-radius:16px; }
          .console-deck { grid-template-columns:1fr 1fr; gap:14px 12px; padding:14px 14px 12px; }
          .console-dj { grid-column:1; grid-row:1; justify-self:center; }
          .console-spk { grid-column:2; grid-row:1; justify-self:center; }
          .console-deck .mouth { grid-column:1 / -1; grid-row:2; width:100%; max-width:480px; justify-self:center; margin:8px auto 0; }
          .mouth { height:68px; --lcd-head:17px; }
          .lcd-status { padding:0 10px; font-size:.6rem; letter-spacing:.1em; gap:8px; }
          .lcd-lamp { width:5px; height:5px; }
          .lcd-whisper { bottom:3px; }
          .lcd-whisper-text { font-size:.56rem; letter-spacing:.08em; padding:0 7px; }
          .lcd-whisper-volume .lcd-whisper-text { font-size:.62rem; }
          .lcd-output { padding:4px 10px 5px; gap:2px; }
          .lcd-row { height:18px; font-size:.7rem; padding:0 6px; }
          .lcd-row-extra { display:none; }
          .lcd-result-word { font-size:.8rem; }
          .lcd-result-detail { font-size:.62rem; }
          /* above the eyes, in the 160px the knob rings leave at the top */
          .console-badge { top:22px; width:189px; }
          /* a two-line plate keeps the one-line type size and is taller, so it
             sits 4px higher to stay clear of the rings' halos; nothing else moves */
          .console-badge.badge-two-line { top:18px; }
          /* smaller, not lower: there is no room below it above the knobs */
          .console-badge-emblem { transform:scale(.79); }
          /* The eyes SHRINK TOGETHER when the viewport asks them to. The
             desktop knob is a fixed 154px housing with fixed-size innards;
             here every one of those sizes is re-expressed relative to the
             housing, and the housing itself yields to its grid column --
             so both eyes stay equal, round, and on one row at any width,
             with no JS measuring anything. */
          .pw-knob-unit { width:100%; max-width:170px; }
          .knob-housing { width:min(154px, 100%); height:auto; aspect-ratio:1 / 1; }
          /* 154/104: the indicator ring is drawn on the housing's circle,
             centred on the knob face; margins in % refer to the parent's
             width on both axes, which is exactly the centring wanted for
             a square. */
          .knob-indicator-svg { width:148%; height:148%; margin-top:-74%; margin-left:-74%; }
          /* 104/154: the knob face keeps its share of the housing. */
          .dj-switch, .right-knob { width:67.5%; height:auto; aspect-ratio:1 / 1; }
          .dj-switch { min-height:44px; }
          .right-knob { min-height:44px; }
          .console-foot { margin:0 14px 14px; }
          .console .lastbreak { padding:14px 14px 16px; }
          .booth-hero { padding:16px 14px; border-radius:16px; }
          .booth-name { font-size:1.5em; }
          .vrow { grid-template-columns:24px 1fr; }
          .vnote { grid-column:2; }
          .vactions { grid-column:1 / -1; justify-content:flex-start; }
          .vnow { flex-direction:column; align-items:stretch; }
          .vnow button { width:100%; }
          .vbadge { align-self:flex-start; }
          .create-field { flex-direction:column; align-items:stretch; gap:6px; }
          .create-label { flex:none; }
          .create-field input[type=text] { min-width:0; width:100%; }
          .create-scope { flex-direction:column; }
          .rec-words { min-width:0; }
          .vpreview-line textarea { min-height:8.6em; }
          /* thumbs, not pointers: the record-first controls fill the row */
          button.rec-big, #rec-stop, #take-use, #create-go { width:100%; min-height:48px; }
          .rec-script { font-size:1em; }
          .news-desk { padding:16px 14px; border-radius:16px; }
          .news-rules { flex-direction:column; gap:5px; }
          .wire { flex-direction:column; }
          .vbadge.cold, .wire .vbadge { align-self:flex-start; }
          .svc-url-entry { flex:1 1 auto; width:100%; }
          .svc-url-row button { flex:1 1 auto; }
          .controls .control.news-url input[type=text],
          input.news-name { flex:none; width:100%; min-width:0; }
          table.news-facts td:first-child { width:50%; }
          .hl-row { flex-direction:column; gap:8px; }
          /* A source row and a history row both carry a name, a time and a
           * set of buttons. At 390 they stack rather than squeeze, and
           * every button keeps the 44px touch target set above. */
          .src-head { flex-direction:column; gap:4px; }
          .src-state { margin-left:0; }
          .src-actions button { flex:1 1 auto; }
          .hist-row { flex-direction:column; align-items:stretch; gap:8px; }
          /* flex-basis is the MAIN axis, and the main axis is now vertical:
             flex:1 1 14rem from the wide layout became a 224px minimum
             HEIGHT, which put a screen of empty space under every row. */
          .hist-main { flex:0 1 auto; }
          .hist-row button { width:100%; }
          .station-desk { padding:16px 14px; border-radius:16px; }
          .air-acts button { flex:1 1 auto; }
          .st-add { gap:10px; }
          /* The Dial stage, one hand: the wordmark and the plate share a row
             above the status lines, the tiles go two by two, and the buttons
             of a sheet take the width between them. */
          .deck-head { gap:12px; padding-bottom:12px; margin-bottom:12px; }
          .deck-badge { width:100%; flex-direction:row; flex-wrap:wrap; justify-content:center;
                  gap:8px 12px; }
          .deck-emblem { --emb:112px; }
          .deck-plate { --cell:360px; }
          .deck-name-edit { min-height:44px; }
          .air-acts { flex:1 1 100%; margin-left:0; }
          .dial-tiles { grid-template-columns:repeat(2, minmax(0, 1fr)); gap:8px; }
          .preset { min-height:92px; padding:10px 11px 9px; }
          .preset-label { font-size:1em; }
          .sheet { padding:14px 12px; }
          .sheet-close { width:44px; height:44px; min-height:44px; }
          .sheet-acts button { flex:1 1 auto; }
          .rl-card { padding:14px; }
          .rl-title { min-width:0; flex-basis:100%; }
          .rl-row button { flex:1 1 auto; }
          .rl-song .rl-row input { flex:1 1 100%; }
          .prog-row { grid-template-columns:24px minmax(0, 1fr); }
          .prog-act { grid-column:2; justify-content:flex-start; }
          .prog-act .pill, .prog-act button { flex:1 1 auto; }
          .prog-act .inlink { min-height:44px; }
          .prog-more { grid-column:1 / -1; }
          /* One hand. The route drops under the row it belongs to rather
             than squeezing the label into a two-word column, and the
             checklist mark keeps its own column so the text never wraps
             under it. */
          .settings-desk { padding:16px 14px; border-radius:16px; }
          .ready-meter { flex-direction:column; align-items:flex-start; gap:7px; }
          /* flex:none -- stacked, a growing bar's height would be its basis, 0 */
          .ready-bar { flex:none; max-width:none; width:100%; }
          .ck-row, .cap-row { grid-template-columns:auto minmax(0,1fr); }
          .ck-go, .cap-go { grid-column:1 / -1; grid-row:auto; justify-self:start;
                  align-self:start; margin-top:8px; }
          .ck-mark { grid-row:1; }
          a.ghost.route, .ck-go button, .cap-go button { white-space:normal; }
          .set-head { gap:9px; }
          .spk-row { gap:8px; }
          /* Settings on a phone: the strip's button, Save and the
             Console's choices take the full width; Extras' line wraps */
          .ready-strip { padding:14px; }
          .ready-steps-btn { margin-left:0; width:100%; }
          .spk-line .spk-acts { margin-left:0; width:100%; }
          .spk-acts button { flex:1 1 auto; }
          .set-ctl { flex-direction:column; align-items:stretch; }
          .src-row { grid-template-columns:minmax(0,1fr); gap:6px; }
          .src-body .spk-line .spk-acts { margin-left:0; width:100%; }
          .src-body .spk-line .spk-acts > button:not(.small) { flex:1 1 auto; }
          .set-ctl-text { flex:0 0 auto; }
          .fp-options .pill { flex:1 1 auto; }
          .set-ctl > .pill { width:100%; }
          .extras-sum { flex-basis:100%; }
          .extras-body { padding:0 14px 6px; }
        }
        /* --- Broadcast Diagnostics (support details) ----------------------
           Drawn in the panel's own design tokens. Amber dashes
           mean UNKNOWN / NOT RECORDED everywhere on this card: an absence is
           never drawn like a negative. */
        .diag-head { display:flex; align-items:center; gap:10px; }
        .diag-head h2 { margin:0; }
        .diag-window { margin:12px 0; padding:10px 12px; border-radius:10px; font-size:.82em; line-height:1.5;
                color:var(--pw-muted); background:rgba(240,162,74,.07); border:1px dashed rgba(240,162,74,.42); }
        .diag-window b { color:var(--pw-text); }
        .diag-filters { display:flex; flex-direction:column; gap:8px; margin:12px 0; }
        .diag-pills { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
        button.diag-pill { min-height:34px; padding:5px 12px; border-radius:999px; font-size:.78em; font-weight:600;
                background:var(--pw-surface); color:var(--pw-muted); border:1px solid var(--pw-line); }
        button.diag-pill.on { background:rgba(224,133,60,.16); color:var(--pw-text); border-color:var(--pw-accent); }
        .diag-reason-tag { display:inline-flex; align-items:center; gap:6px; font-size:.78em; color:var(--pw-muted);
                padding:2px 4px 2px 10px; border-radius:8px; border:1px solid var(--pw-accent); }
        .diag-summary { margin:0 0 12px; padding:12px 14px; border-radius:12px; background:rgba(0,0,0,.18);
                border:1px solid var(--pw-line); }
        .diag-kicker { font-size:.7em; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:var(--pw-dim); }
        .diag-stat { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; margin:6px 0; font-size:.86em; color:var(--pw-muted); }
        .diag-big { font-size:1.8em; font-weight:700; color:#ffc94d; line-height:1.1; }
        .diag-counts, .diag-reasons { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
        .diag-count { font-size:.76em; padding:2px 8px; border-radius:6px; background:var(--pw-surface); color:var(--pw-muted); }
        .diag-count b { color:var(--pw-text); }
        button.diag-reason { min-height:30px; padding:3px 9px; border-radius:7px; font-size:.76em; font-weight:500;
                font-family:var(--pw-mono, "SF Mono", "Fira Code", monospace, sans-serif);
                background:var(--pw-surface); color:#ffd195; border:1px solid var(--pw-line); }
        .diag-list { display:flex; flex-direction:column; gap:8px; }
        .diag-opp { border-radius:12px; background:rgba(0,0,0,.2); border:1px solid var(--pw-line);
                border-left:3px solid var(--pw-line); overflow:hidden; }
        .diag-opp.tone-ok { border-left-color:#7cc47f; }
        .diag-opp.tone-warn { border-left-color:#ffa726; }
        .diag-opp.tone-danger { border-left-color:#ff5346; }
        .diag-opp.tone-unknown { border-left:3px dashed rgba(240,162,74,.6); }
        .diag-opp.linked { box-shadow:0 0 0 1px var(--pw-accent); }
        button.diag-opp-sum, .diag-opp-sum.static { display:flex; flex-direction:column; align-items:stretch; gap:7px;
                width:100%; min-height:0; padding:10px 12px; border-radius:0; background:none; color:var(--pw-text);
                font-weight:400; font-size:.9em; text-align:left; }
        button.diag-opp-sum:hover { background:var(--pw-surface); }
        button.diag-opp-sum[aria-expanded="true"] { border-bottom:1px solid var(--pw-line); }
        .diag-line { display:flex; align-items:center; gap:7px; flex-wrap:wrap; width:100%; }
        .diag-time { font-weight:600; font-variant-numeric:tabular-nums; }
        .diag-id { font-family:var(--pw-mono, "SF Mono", "Fira Code", monospace, sans-serif); font-size:.8em; color:var(--pw-dim); }
        .diag-aired, .diag-badge { font-size:.68em; font-weight:700; letter-spacing:.06em; text-transform:uppercase;
                padding:2px 7px; border-radius:6px; white-space:nowrap; }
        .diag-badge { border-radius:999px; }
        .diag-aired.ok, .diag-badge.tone-ok, .diag-ob.ok, .diag-cell.ok { color:#8fd992; background:rgba(124,196,127,.13); }
        .diag-aired.no, .diag-aired.wait, .diag-badge.tone-muted { color:var(--pw-muted); background:var(--pw-surface-2); }
        .diag-badge.tone-warn { color:#ffc94d; background:rgba(255,167,38,.15); }
        .diag-badge.tone-danger, .diag-ob.danger, .diag-cell.danger { color:#ff8a80; background:rgba(255,83,70,.14); }
        .diag-ob.muted, .diag-cell.muted { color:var(--pw-dim); background:var(--pw-surface); }
        .diag-aired.unknown, .diag-badge.tone-unknown, .diag-unknown, .diag-ob.unknown, .diag-cell.unknown {
                color:#ffd195; background:rgba(240,162,74,.12); border:1px dashed rgba(240,162,74,.45); }
        .diag-unknown { font-size:.74em; font-weight:700; letter-spacing:.04em; padding:1px 6px; border-radius:5px; }
        .diag-ob { font-size:.72em; padding:2px 7px; border-radius:6px; white-space:nowrap; }
        .diag-tracks { display:inline-flex; align-items:center; gap:6px; flex-wrap:wrap; }
        .diag-arrow { color:var(--pw-accent); }
        .diag-why { display:inline-flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:.86em;
                padding:2px 8px; border-radius:7px; background:var(--pw-surface); color:var(--pw-muted); }
        .diag-why code, .diag-code b, .diag-kv code, .diag-evidence code, .diag-foot code, .diag-reason-tag code {
                font-family:var(--pw-mono, "SF Mono", "Fira Code", monospace, sans-serif); font-size:.92em; color:#ffd195;
                overflow-wrap:anywhere; }
        .diag-stage { color:var(--pw-dim); }
        .diag-body { display:flex; flex-direction:column; gap:12px; padding:12px; }
        .diag-verdict { padding:12px; border-radius:10px; background:var(--pw-surface); border:1px solid var(--pw-line); }
        .diag-verdict.tone-warn { border-color:rgba(255,167,38,.4); }
        .diag-verdict.tone-danger { border-color:rgba(255,83,70,.4); }
        .diag-verdict.tone-ok { border-color:rgba(124,196,127,.35); }
        .diag-verdict-title { font-weight:600; margin:4px 0 8px; }
        .diag-codes { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:4px; }
        .diag-code { font-size:.78em; padding:2px 8px; border-radius:6px; background:rgba(0,0,0,.3); color:var(--pw-dim); }
        .diag-kv { font-size:.84em; margin-top:5px; line-height:1.55; color:var(--pw-muted); }
        .diag-kv .k { color:var(--pw-dim); margin-right:4px; }
        code.diag-flag, .diag-mark { color:#ffd9d6; background:rgba(255,83,70,.22); border-radius:4px; padding:0 4px; }
        .diag-mark { border-bottom:1px dashed #ff5346; }
        .diag-dim { color:var(--pw-dim); }
        .diag-scripts { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:10px; }
        .diag-script { padding:12px; border-radius:10px; background:rgba(0,0,0,.18); border:1px solid var(--pw-line); min-width:0; }
        .diag-script-head { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-bottom:8px; }
        .diag-script-title { font-size:.72em; font-weight:700; letter-spacing:.1em; text-transform:uppercase;
                color:var(--pw-accent); margin-right:auto; }
        .diag-chip { font-size:.72em; padding:2px 7px; border-radius:6px; background:var(--pw-surface); color:var(--pw-dim);
                max-width:100%; overflow-wrap:anywhere; }
        blockquote.said.diag-said { font-size:.98em; overflow-wrap:anywhere; }
        blockquote.said.diag-said.cut { border-left-color:#ff5346; }
        .diag-empty { font-size:.86em; color:var(--pw-dim); font-style:italic; padding:8px 10px; border-radius:8px;
                border:1px dashed var(--pw-line); }
        .diag-foot { font-size:.8em; margin-top:8px; display:flex; flex-wrap:wrap; gap:6px; align-items:center; color:var(--pw-muted); }
        .diag-decision { flex-basis:100%; }
        .diag-sub { font-size:.72em; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:var(--pw-dim); }
        .diag-sub .diag-dim { text-transform:none; letter-spacing:0; font-weight:400; margin-left:4px; }
        .diag-steps { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:8px; }
        .diag-step { padding:9px 10px; border-radius:9px; background:rgba(0,0,0,.18); border:1px solid var(--pw-line); min-width:0; }
        .diag-step-head { display:flex; flex-wrap:wrap; gap:6px; align-items:center; justify-content:space-between;
                font-size:.78em; margin-bottom:5px; }
        .diag-state { font-family:var(--pw-mono, "SF Mono", "Fira Code", monospace, sans-serif); color:var(--pw-text);
                background:var(--pw-surface-2); padding:1px 6px; border-radius:5px; overflow-wrap:anywhere; }
        .diag-step-detail { font-size:.8em; color:var(--pw-muted); line-height:1.45; overflow-wrap:anywhere; }
        .diag-table-wrap { overflow-x:auto; border:1px solid var(--pw-line); border-radius:9px; }
        table.diag-table { font-size:.8em; }
        .diag-table th { text-align:left; font-size:.85em; font-weight:600; color:var(--pw-dim); padding:7px 8px;
                border-bottom:1px solid var(--pw-line); }
        .diag-table td { vertical-align:top; }
        .diag-table td:first-child { width:auto; color:var(--pw-text); white-space:nowrap; }
        .diag-cell { display:inline-block; font-size:.92em; padding:1px 6px; border-radius:5px; white-space:nowrap; }
        .diag-evidence { font-size:.76em; color:var(--pw-dim); line-height:1.7; overflow-wrap:anywhere; }
        .diag-note { margin:10px 0; padding:10px 12px; border-radius:10px; font-size:.86em; line-height:1.5;
                color:var(--pw-muted); background:var(--pw-surface); border:1px dashed var(--pw-line); }
        .diag-note b { color:var(--pw-text); }
        .diag-linked { margin-bottom:12px; }
        .diag-linked:focus { outline:2px solid var(--pw-accent); outline-offset:2px; }
        .diag-linked-head { display:flex; align-items:center; gap:8px; padding:8px 12px 0; }
        .diag-more { display:flex; justify-content:center; margin-top:12px; }
        .lastbreak-inspect { margin-top:8px; font-size:.82em; text-align:right; }
        .hinspect { font-size:.76em; margin-top:4px; }
        @media (max-width: 900px) {
          .diag-scripts { grid-template-columns:minmax(0,1fr); }
          .diag-steps { grid-template-columns:repeat(2, minmax(0,1fr)); }
          /* the obligations stack: one block per obligation, each value labelled */
          .diag-table, .diag-table tbody { display:block; width:100%; }
          .diag-table thead { display:none; }
          .diag-table tr { display:block; padding:6px 0; border-bottom:1px solid var(--pw-line); }
          .diag-table tr:last-child { border-bottom:none; }
          .diag-table td { display:flex; gap:8px; align-items:baseline; padding:3px 8px; border-bottom:none; }
          .diag-table td:first-child { font-weight:600; }
          .diag-table td[data-label]::before { content:attr(data-label); flex:0 0 7.5em; color:var(--pw-dim); }
          .diag-table .diag-cell { white-space:normal; min-width:0; }
          .diag-table td:empty { display:none; }
        }
        @media (max-width: 560px) {
          .diag-steps { grid-template-columns:minmax(0,1fr); }
          .diag-line > .spacer { display:none; }
          button.diag-pill, button.diag-reason { min-height:44px; }
        }
        /* --- a room that changes colour is still a room ------------------- */
        @media (prefers-reduced-motion: reduce) {
          :host, .stage-glow, .chip, .track-sub, #progress-fill, nav button.active,
          button, .pill.on, blockquote.said, button.ghost.on, .brand-lamp,
          .booth-desc, .vnow, .vrow.vsel, .vbadge, .wire,
          .news-rules span::before { transition:none !important; }
          .lamp { animation:none; }
          .rec-dot { animation:none; }
          .rec-level { transition:none; }
          .dj-switch, .dj-switch-glow, .dj-face, .dj-face-cap, .mouth, .knob-housing { transition:none !important; }
          .knob-housing { transform:none !important; }
          .dj-switch.pending .dj-face { animation:none; }
          .lcd-countdown-bar { animation:none; }
          .lcd-pending .lcd-lamp { animation:none; opacity:.6; }
          .lcd-whisper { transition:none; }
          /* The Mouth's own loop is not started under this preference
             (see _mouthStart): each state is one still picture. */
          .lyric { transition:none !important; }
          .preset, .st-adv > summary::before, details.extras > summary::before { transition:none !important; }
        }
        @media (max-width: 390px) {
          .console-badge { width:177px; }
          .deck-emblem { --emb:96px; }
          .deck-plate { --cell:330px; }
          .preset { min-height:84px; padding:9px 10px 8px; }
          .preset-label { font-size:.95em; }
          .preset-term { font-size:.8em; }
        }
      </style>
`;

/* THE TWO SCREEN-READER REGIONS, written once beside the stylesheet and
 * updated in place (_announce): a live region that is destroyed and
 * re-created on every Home Assistant update is announced as new each
 * time, at the cadence of every state change in the house. */
const SR_REGIONS = `<div id="sr-status" class="visually-hidden" role="status" aria-live="polite" aria-atomic="true"></div>
<div id="sr-alert" class="visually-hidden" role="alert" aria-live="assertive" aria-atomic="true"></div>`;

class ParlorwaveRadioPanel extends HTMLElement {
  // one theme per sleeve, shared by every instance of the panel
  static _paletteCache = new Map();

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._view = "onair";
    try {
      this._faceplate = (typeof localStorage !== "undefined" && localStorage.getItem("parlorwave_faceplate")) || "midnight";
    } catch (_) {
      this._faceplate = "midnight";
    }
    this._lastFpClick = 0;
    try {
      this._mouthVisual = (typeof localStorage !== "undefined" && localStorage.getItem("parlorwave_mouth_visual")) || "waves";
    } catch (_) {
      this._mouthVisual = "waves";
    }
    this._lastMouthClick = 0;
    this._mouthModeToast = null;
    this._mouthToastTimer = null;
    try {
      this._centerLogoMode = (typeof localStorage !== "undefined" && localStorage.getItem("parlorwave_logo_mode")) || "logo";
    } catch (_) {
      this._centerLogoMode = "logo";
    }
    this._lastBadgeClick = 0;
    // Waveform mouth: the one validated waveform held (keyed by the queue
    // item it was checked against), the demand for the item on air now
    // (see _maybeRefreshWaveform), and the playback clock it is read at.
    this._waveform = null;
    this._waveforms = new Map();
    this._wfDemand = null;
    this._clock = null;
    this._sensorSig = null;
    this._seen = new Map();
    this._confirmed = new Set();
    this._waveformDemo = false;
    this._eqPeaks = null;
    this._knobTurning = null;          // null | "left" | "right"
    this._rightKnobAngle = 0;
    this._lastKnobClick = { left: 0, right: 0 };
    this._volThrottleTimer = null;
    this._pendingVol = null;
    this._volHold = null;             // the left knob's held request; see _holdVolume
    this._volHoldTimer = null;
    this._stickyPoint = null;         // the sticky turn's last pointer position, across renders
    this._lastOutputStepAngle = 0;
    this._pipTimers = null;
    // album palette state: the key is the artwork URL, so a theme is
    // computed once per sleeve and never during an ordinary render
    this._artKey = null;
    this._theme = null;
    this._busy = null;
    this._notice = null;
    this._noticeTimer = null;
    this._noticeMeta = null;         // count, critical, the clock (see _setNotice)
    // key -> entity_id, from the entity registry (see _ent). Null until the
    // integration has answered; never derived from a name.
    this._entityMap = null;
    this._entitiesLoading = false;
    // Demand-data state (survives re-renders; refreshed on its own terms)
    this._drawer = null;              // null | "lyrics" | "queue"
    this._lyrics = null;              // { forUri, data }
    // --- the lyric pane's own scroll, and nothing else's ---------------
    // Every one of these is about ONE element. There is no state here
    // that could describe, or move, the page around the panel.
    this._lyricLine = null;           // index of the highlighted line
    this._lyricScrollTop = 0;         // where the pane is, across rebuilds
    this._lyricFollow = true;         // the pane follows the song
    this._lyricScrolledFor = null;    // the line we last moved the pane for
    this._lyricAutoTop = null;        // the last position WE asked for
    this._lyricAutoAt = 0;            // when we asked, to ignore the animation
    this._queue = null;               // { at, data }
    this._historyOpen = false;
    this._history = null;             // { at, data }
    // The Break History list's own scroll, carried across rebuilds the
    // same way the lyric pane's is (and for the same reason: routine hass
    // updates replace the shadow tree wholesale, which threw a reader
    // back to the top of the list). Reset when History is closed on
    // purpose, so reopening starts at the top like a fresh list.
    this._historyScrollTop = 0;
    this._voicesOpen = false;
    this._voiceLib = null;            // websocket copy for the manage view
    this._personaPick = null;         // a pressed personality, until the entity agrees
    this._shiftsBusy = false;         // an Automatic DJ shifts write is in flight
    this._previewing = null;
    this._noteEditing = null;         // voice_id whose note is being edited
    this._vroleOpen = null;           // voice_id whose "Used for" chip is open
    this._noteDraft = null;           // what is typed there (survives re-renders)
    this._nameEditing = null;         // voice_id whose name is being edited
    this._nameDraft = null;
    this._tune = null;                // {id, speed, pause} while a tuning row is open
    this._create = null;              // the Create-a-Voice draft, or null when closed
    // The open microphone, or null. Only a press of Record sets it; see
    // _releaseMic for everything that clears it.
    this._mic = null;
    this._takeAudio = null;           // listening back to a take, or null
    this._previewText = null;         // the owner's preview line (survives re-renders); null = untouched
    this._confirmDelete = null;       // voice_id awaiting a confirmed delete
    // Voice Library: the "Saved recordings" section (its own listing,
    // drafts and the one row action in progress)
    this._vc = { open: false, data: null, error: null, busy: null, archived: false,
                 rename: null, assign: null, del: null, imp: null };
    // --- Newsroom ------------------------------------------------------
    // NOTE the name: `_news` is already taken by the entity getter for
    // the Booth's "news in breaks" switch, and a field that shadows a
    // prototype accessor throws in a class constructor. The news DESK
    // is a different thing from that switch, and is named like one.
    this._newsdesk = null;            // { at, data } from news_status
    // The History disclosure, remembered on the COMPONENT. The shadow tree
    // is replaced wholesale on every coordinator update, so a <details> the
    // owner opened would close itself again within ten seconds if its state
    // lived on the element -- the same reason the notice timer does not.
    this._histOpen = false;
    this._newsDraft = null;           // what is typed in the feed form
    this._newsTest = null;            // { running } | { result } | { error }
    this._newsAdvanced = false;       // the diagnostics drawer
    // --- Settings ------------------------------------------------------
    // The whole screen is ONE document built by the integration; the panel
    // holds the last copy of it and nothing else. `_ready` is named for
    // readiness, not for a loading flag.
    this._ready = null;               // { at, data } | { at, error }
    this._readyAdvanced = false;      // the support disclosure
    // Broadcast Diagnostics, inside the support disclosure: read when it
    // first opens and on Refresh, never polled. `_diag` is the rows read so
    // far with `_diagFilter`; `_diagDetail` each opened row's whole record.
    this._diag = null;                // { items, next, scan, loading, error, unsupported }
    this._diagFilter = { outcome: "", reason: "", kind: "dj_break" };
    this._diagGen = 0;                // the newest list read; an older answer is dropped
    this._diagOpen = new Set();       // ids whose record is shown
    this._diagDetail = {};            // id -> the detail answer, or { loading: true }
    this._diagLinked = null;          // the id an Inspect link opened
    this._diagLinkFocus = false;      // focus the linked record when it arrives
    this._readyStepsOpen = false;     // the four steps, behind Show steps once all four pass
    this._extrasOpen = false;         // Extras, closed by default
    // The DJ-enabled speaker allow-list, edited HERE rather than in the
    // integration's options. `_speakerDraft` is what the checkboxes show;
    // it is only ever written to the service by pressing Save.
    this._speakers = null;            // { at, data } from parlorwave_radio/outputs
    this._speakerDraft = null;        // the ids currently ticked
    this._speakersDirty = false;      // the draft differs from what is stored
    // The weather entity and the calendars the DJ may read, edited HERE as
    // the speakers are. One read (parlorwave_radio/context_sources) carries
    // both inventories and the stored selection; each selector keeps its
    // own draft and saves on its own, through one write that leaves the
    // other selector's value exactly as it was.
    this._sources = null;             // { at, data } | { at, data: null }
    this._srcDraft = null;            // { weather: "", calendars: [] }
    this._srcDirty = { weather: false, calendars: false };
    this._stationSettings = null;     // { settings } from parlorwave_radio/station_settings
    this._stationDraft = null;        // draft station name
    this._stationDirty = false;       // draft differs from stored
    this._stationError = null;        // validation error message
    this._stationSettingsAt = 0;
    this._dial = null;                // { at, data } from parlorwave_radio/station_dial
    this._dialEdit = null;            // the one Dial station being edited
    this._dialTest = null;            // Test Station: { running } | { result } | { error }
    this._dialConfirm = null;         // preset id awaiting a second press to remove
    this._live = null;                // { at, data } from parlorwave_radio/station_live
    this._liveTargets = null;         // { at, data } from parlorwave_radio/station_live_targets
    this._liveForm = null;            // { preset_id, target, confirm } while starting/switching
    this._liveStopAsk = false;        // Stop station awaiting its second press
    // The Dial stage's own disclosures, remembered on the component (the
    // screen is rebuilt on every update), and the deck plate's fit memo.
    this._stNameOpen = false;         // the station-name sheet under the plate
    this._stAdvOpen = false;          // Station's Advanced fold
    this._annOpen = false;            // the Announcements row's Options
    this._deckPlateFit = null;        // { key, name, fit } for the deck's plate
    this._pointerHeld = false;        // a press is in flight
    this._outputMode = false;         // right knob browse/confirm speaker mode
    this._outputIndex = 0;            // candidate index into available outputs
    this._outputRunAt = 0;            // last push of the run that opened the list
    this._outputDeadline = 0;         // when the idle list closes, unchanged
    this._outputPending = null;       // the candidate a confirm is waiting on HA for
    this._outputResult = null;        // { ok, text, detail } shown before closing
    this._outputCancelTimer = null;   // OUTPUT_TIMEOUT_MS idle close
    this._outputConfirmTimer = null;  // the answer's display time
    this._outputTickTimer = null;     // the countdown digits
    this._whisper = null;             // { text, kind, until }: the LCD's transient line
    this._whisperTimer = null;
    this._hinted = { left: false, right: false };   // once a session, per knob
    this._srLast = { state: "", ok: "", alert: "" }; // what the live regions last said
    this._djHold = null;                            // a DJ switch write awaiting its echo
    // The Dial on the same knob: TURN browses the saved stations (see
    // _enterStationMode). Never on at the same time as the speaker browser.
    this._stationMode = false;        // right knob is browsing Dial stations
    this._stationIndex = 0;           // candidate index into _dialStations()
    this._stationArmed = false;       // one push asked; a second one starts
    this._stationArmedAt = 0;
    this._stationArmedId = null;      // the preset the question was asked about
    this._stationPrompt = false;      // after 3s idle: push to choose
    this._stationBusy = false;        // a start is with the backend
    this._stationResult = null;       // { ok, text } shown until the display returns
    this._stationPromptTimer = null;
    this._stationCancelTimer = null;
    this._stationConfirmTimer = null; // a confirming click, held one double-click window
    // The Request Line (its own card under the Dial): the text being typed
    // and whether it has asked its one question. Typing is kept across renders.
    this._reqLine = { text: "", confirm: false, result: null };
    this._songReq = { title: "", artist: "", result: null };
    this._reqTarget = "";             // the speaker picked when none is on air
    this._liveAirSeen = null;         // { key, q }: the last CURRENT on-air answer (_liveSettle)
    this._focusNext = null;           // { id | pick | sel }: where the next render puts focus
    // --- the Broadcast Console's Mouth ---------------------------------
    // The one animation loop this panel has, and everything it needs to be
    // stopped: the canvas it draws on, the frame handle, the state it was
    // started for. One bound visibility handler, made once, so connecting
    // twice can never register it twice.
    this._mouth = null;               // { canvas, mode, reduced, t0, last, raf }
    this._onVisibility = () => this._onVisibilityChange();
    // Rebuilding the DOM between a press and its click loses the click --
    // and, in a text box, the typing. Renders wait for the release; the
    // focusout hook finishes a render a text box or select had held back.
    this.shadowRoot.addEventListener("pointerdown", (ev) => {
      this._pointerHeld = true;
      this._dismissToastOnOutsidePress(ev);
    });
    this._onRelease = () => {
      this._pointerHeld = false;
      if (this._deferredRender) setTimeout(() => this._render(), 0);
    };
    this.shadowRoot.addEventListener("focusout", () => {
      if (this._deferredRender) setTimeout(() => this._render(), 0);
    });
    // Home Assistant rebuilt the panel (see BOOTH_SESSION): carry on in the
    // Booth with the same draft -- its take, its audition, its answer.
    const saved = BOOTH_SESSION.saved;
    BOOTH_SESSION.saved = null;
    if (saved && saved.view === "booth") {
      this._view = "booth";
      this._voicesOpen = !!saved.voicesOpen;
      this._create = saved.create || null;
    }
  }

  connectedCallback() {
    // One local 1 s ticker drives the progress bar and the synced-lyric
    // highlight from the last known elapsed basis — no polling, no
    // re-render: it touches exactly two DOM spots.
    this._ticker = setInterval(() => this._tick(), 1000);
    // The release may land outside the panel (drag away): listen window-wide.
    window.addEventListener("pointerup", this._onRelease);
    window.addEventListener("pointercancel", this._onRelease);
    this._onKeyDown = (e) => {
      if (this._stationMode && !this._outputMode) {
        const t = e.composedPath ? e.composedPath()[0] : e.target;
        if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "")) return;
        if (e.key === "Escape") {
          e.preventDefault();
          this._cancelStationMode();
        } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
          e.preventDefault();
          this._stationStep(1);
        } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
          e.preventDefault();
          this._stationStep(-1);
        } else if (e.key === "Enter") {
          e.preventDefault();
          this._stationPush();
        }
        return;
      }
      if (this._outputMode) {
        const t = e.composedPath ? e.composedPath()[0] : e.target;
        if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "")) return;
        if (e.key === "Escape") {
          e.preventDefault();
          this._cancelOutputMode();
        } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
          e.preventDefault();
          this._nextOutput();
        } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
          e.preventDefault();
          this._prevOutput();
        } else if (e.key === "Enter" || e.key === " ") {
          // The selector owns the key: a focused knob's own click (the
          // button's default action) must not ALSO act on it. A held key's
          // auto-repeat is not another press.
          e.preventDefault();
          if (!e.repeat) this._confirmOutput();
        }
        return;
      }
      this._knobKey(e);
    };
    if (typeof window !== "undefined") {
      window.addEventListener("keydown", this._onKeyDown);
    }
    // A hidden page gets no frames; a page that comes back gets them again.
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this._onVisibility);
    }
    this._startEyeLoop();
    // The plate is fitted to its on-screen size; a breakpoint change
    // (a rotation, a window resized) is the one thing that moves it.
    this._onBadgeResize = () => {
      if (this._badgeResizeTimer) clearTimeout(this._badgeResizeTimer);
      this._badgeResizeTimer = setTimeout(() => {
        this._badgeResizeTimer = null;
        this._fitCenterBadge();
        this._fitDeckPlate();
      }, 120);
    };
    if (typeof window !== "undefined") {
      window.addEventListener("resize", this._onBadgeResize);
    }
  }
  disconnectedCallback() {
    // A panel nobody can see never keeps a microphone open.
    this._releaseMic();
    this._stopTake();
    // What the Booth was doing outlives this element: Home Assistant may
    // build the next one (see BOOTH_SESSION). A take made before the page
    // was hidden is in the draft and goes with it; a recording still
    // running was just thrown away above, as leaving the form always does.
    BOOTH_SESSION.saved = this._view === "booth"
      ? { view: "booth", voicesOpen: this._voicesOpen, create: this._create }
      : null;
    this._stopEyeLoop();
    clearInterval(this._ticker);
    // A confirmation still held for the double-click window dies with the
    // panel: nothing starts from a panel nobody is looking at.
    this._clearStationTimers();
    if (this._noticeTimer) clearTimeout(this._noticeTimer);
    this._noticeTimer = null;
    if (this._mouthToastTimer) clearTimeout(this._mouthToastTimer);
    this._mouthToastTimer = null;
    this._resetWaveformDemand();
    window.removeEventListener("pointerup", this._onRelease);
    window.removeEventListener("pointercancel", this._onRelease);
    if (typeof window !== "undefined" && this._onKeyDown) {
      window.removeEventListener("keydown", this._onKeyDown);
    }
    if (this._volThrottleTimer) clearTimeout(this._volThrottleTimer);
    this._volThrottleTimer = null;
    this._dropVolumeHold();
    if (this._knobWindowCleanup) {
      this._knobWindowCleanup();
      this._knobWindowCleanup = null;
    }
    this._clearOutputTimers();
    // A detached panel keeps no selector open: an answer that arrives later
    // finds it closed and draws nothing.
    this._outputMode = false;
    this._outputPending = null;
    this._outputResult = null;
    if (this._whisperTimer) clearTimeout(this._whisperTimer);
    this._whisperTimer = null;
    this._whisper = null;
    if (this._pipTimers) {
      if (this._pipTimers.left) clearTimeout(this._pipTimers.left);
      if (this._pipTimers.right) clearTimeout(this._pipTimers.right);
      this._pipTimers = null;
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this._onVisibility);
    }
    if (typeof window !== "undefined" && this._onBadgeResize) {
      window.removeEventListener("resize", this._onBadgeResize);
    }
    if (this._badgeResizeTimer) clearTimeout(this._badgeResizeTimer);
    this._badgeResizeTimer = null;
    this._mouthStop();
    // What was just stopped (the Mouth, the knobs' window listeners) only a
    // render's post-write steps start again, so the screen on show is not one
    // a render may keep: the first update after a reconnect rebuilds.
    this._treeKeyShown = null;
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this._entityMap) this._fetchEntities();
    if (first && !this._voiceLib) this._fetchVoiceLib();
    this._syncPlaybackClock();
    this._maybeRefreshDemandData();
    this._checkPlayerTrack();
    this._syncPalette();
    this._settleVolumeHold();
    this._render();
  }

  _checkPlayerTrack() {
    const p = this._player;
    const cid = (p && p.attributes && (p.attributes.media_content_id || p.attributes.media_title)) || null;
    if (this._lastTrackCid === undefined) {
      this._lastTrackCid = cid;
      return;
    }
    if (cid && cid !== this._lastTrackCid) {
      this._lastTrackCid = cid;
      const ids = ["now_playing", "dj_status"]
        .map((k) => this._entityMap && this._entityMap[k])
        .filter(Boolean);
      if (ids.length && this._hass) {
        Promise.resolve(
          this._hass.callService("homeassistant", "update_entity", { entity_id: ids })
        ).catch(() => {});
      }
    }
  }

  /* --- entity discovery: by identity, never by name ----------------------
   *
   * This used to read `friendly_name` and match the words "parlorwave
   * radio" plus a hint. Home Assistant builds that name from the DEVICE's
   * name, and renaming a device is a one-click, entirely ordinary thing to
   * do -- after which nothing matched, and On Air, Booth and Station lost
   * every control they had while telling the owner the integration needed
   * an update.
   *
   * The map comes from the entity registry, keyed on the `unique_id`
   * suffix the integration itself mints (entity.py: `{entry_id}_{key}`).
   * That key is the one name in this system that a person cannot change
   * and a reload cannot move. Nothing here hardcodes an entity_id: the
   * generated ids travel in the map and are looked up fresh every render,
   * so renaming an ENTITY is survived for the same reason as renaming the
   * device. */
  _ent(key) {
    const id = this._entityMap && this._entityMap[key];
    if (!id) return null;
    const state = this._hass && this._hass.states[id];
    return state || null;
  }

  get _dj() { return this._ent("dj_enabled"); }
  get _djSpeech() { return this._ent("dj_speech"); }
  get _djStories() { return this._ent("dj_stories"); }
  get _endless() { return this._ent("endless_radio"); }
  get _cadence() { return this._ent("cadence"); }
  get _breakLength() { return this._ent("break_length"); }
  get _output() { return this._ent("output"); }
  get _station() { return this._ent("station"); }
  get _djStatus() { return this._ent("dj_status"); }
  get _nowCard() { return this._ent("now_playing"); }
  get _personality() { return this._ent("personality"); }
  get _voice() { return this._ent("voice"); }
  get _feel() { return this._ent("station_feel"); }
  get _sameArtist() { return this._ent("same_artist"); }
  get _sameArtistFreq() { return this._ent("same_artist_frequency"); }
  get _weather() { return this._ent("content_weather"); }
  get _calendar() { return this._ent("content_calendar"); }
  get _news() { return this._ent("content_news"); }

  async _fetchEntities() {
    if (this._entitiesLoading) return;
    this._entitiesLoading = true;
    try {
      const data = await this._ws("parlorwave_radio/entities");
      this._entityMap = (data && data.entities) || {};
    } catch (e) {
      // Leave the map null rather than caching an empty one: the next
      // pass tries again, and a half-set-up integration that answers in a
      // moment is the ordinary case at first paint.
      this._entityMap = null;
    }
    this._entitiesLoading = false;
    this._render();
  }

  get _player() {
    const out = this._output;
    const eid = out && out.attributes.output_entity_id;
    if (eid && this._hass.states[eid]) return this._hass.states[eid];
    const st = this._station;
    const qid = st && st.attributes.queue_id;
    if (qid && this._hass.states[qid]) return this._hass.states[qid];
    return null;
  }

  /* Is this Music Assistant queue the selected DJ speaker? A comparison,
   * for the Station screen's house line: it names the speaker it watches
   * only when that is provably this one. The id itself is never shown. */
  _isSelectedOutput(queueId) {
    const out = this._output;
    const sel = out && out.attributes && out.attributes.player_id;
    return !!(queueId && sel && sel === queueId);
  }

  // --- demand data (websocket) ------------------------------------------
  async _ws(type, extra) {
    return this._hass.callWS(Object.assign({ type }, extra || {}));
  }

  _nowUri() {
    const n = this._nowCard;
    return (n && n.attributes.uri) || null;
  }

  _maybeRefreshDemandData() {
    // The Mouth's waveform follows the item on air, while the Broadcast
    // Console is on show (it is part of On Air; see _consoleOnShow).
    this._maybeRefreshWaveform();
    // Lyrics follow the TRACK: refetch only when the drawer is open and
    // the playing uri moved away from the answer we hold.
    if (this._drawer === "lyrics") {
      const uri = this._nowUri();
      if (!this._lyrics || (uri && this._lyrics.forUri !== uri)) this._fetchLyrics();
    }
    if (this._drawer === "queue") {
      if (!this._queue || Date.now() - this._queue.at > 30000) this._fetchQueue();
    }
    // The Newsroom is live state: a bulletin can arm, queue and air while
    // somebody is looking at the screen. It is read only while that screen
    // is the one on show -- a status page nobody is reading should cost
    // nothing.
    if (this._view === "newsroom") {
      if (!this._newsdesk || Date.now() - this._newsdesk.at > NEWS_MAX_AGE_MS) this._fetchNews();
      // The record of what already happened changes only when a bulletin
      // finishes, so it is read ONCE when the screen opens rather than on
      // the live poll beside it.
      if (!this._newsHistory) this._fetchNewsHistory();
    }
    // Readiness is read on EVERY screen, not only on Settings. It is the
    // Settings view model and it is also the only customer-facing
    // translation of the service's health that exists anywhere -- the
    // banner above every screen renders it, so it has to be current
    // wherever somebody is standing. One bounded read-only call every
    // SETTINGS_MAX_AGE_MS; a backend restart, a token pasted into the
    // add-on or a speaker enabled in the options flow all change the
    // verdict without any entity changing. And at once, not on the next
    // turn of that timer, when the integration says the verdict's inputs
    // changed (the DJ status sensor's readiness_key: a restart, a refused
    // token, an outage, a recovery): "Ready." must not outlive what the
    // integration already knows. A document read before the key was known
    // (the first read after a page load lands before the entity map) is
    // read once more when the key appears: it cannot say which key it
    // answered for, and keeping it ignored a refused token for up to the
    // whole timer on a screen opened moments before.
    const rkey = this._readinessKey();
    if (!this._ready || Date.now() - this._ready.at > SETTINGS_MAX_AGE_MS
        || (rkey !== undefined && rkey !== this._ready.key)) {
      this._fetchReadiness();
    }
    // The speaker inventory is read only on the screen that offers to edit
    // it, and NEVER while a half-made selection is waiting to be saved --
    // a refresh landing mid-edit would take the ticks back.
    // The optional services are read ONCE when Settings opens: they change
    // when somebody saves them, not on a clock, and a screen nobody is
    // looking at should cost nothing.
    if (this._view === "settings" && !this._services) this._fetchServices();
    if (this._view === "settings" && !this._speakersDirty) {
      if (!this._speakers || Date.now() - this._speakers.at > SETTINGS_MAX_AGE_MS) {
        this._fetchSpeakers();
      }
    }
    // The weather and calendar inventories, on the same rule: on the screen
    // that offers to edit them, and never while a half-made choice waits.
    if (this._view === "settings" && !this._srcDirtyAny()) {
      if (!this._sources || Date.now() - this._sources.at > SETTINGS_MAX_AGE_MS) {
        this._fetchSources();
      }
    }
    // Station identity lives on the Station screen (its card renders in
    // both Station modes), so that is the screen that reads it -- and
    // never while a half-typed name is waiting to be saved.
    if (this._view === "station" && !this._stationDirty) {
      if (!this._stationSettings || Date.now() - (this._stationSettingsAt || 0) > SETTINGS_MAX_AGE_MS) {
        this._fetchStationSettings();
      }
    }
    // Announcements are live state on the same screen: an occurrence can
    // become due, air and finish while somebody is looking at the list.
    if (this._view === "station") {
      if (!this._announcements
          || Date.now() - (this._announcements.at || 0) > SETTINGS_MAX_AGE_MS) {
        this._fetchAnnouncements();
      }
    }
    // Dial Stations: configuration, re-read only while nobody is editing
    // one -- a refresh must never replace a preset being typed.
    if (this._view === "station" && !this._dialEdit) {
      if (!this._dial || Date.now() - (this._dial.at || 0) > SETTINGS_MAX_AGE_MS) {
        this._fetchDial();
      }
    }
    // The on-air station: its runway moves while somebody watches, so it
    // is re-read like settings -- but never while a start or stop is on
    // its way, which re-reads it itself when it lands.
    if (this._view === "station" && this._busy !== "live_start"
        && this._busy !== "live_stop" && this._busy !== "request_line") {
      if (!this._live || Date.now() - (this._live.at || 0) > SETTINGS_MAX_AGE_MS) {
        this._fetchLive();
      }
    }
    // On Air reads both as well: the right knob's Dial browses the saved
    // stations and aims at the backend's dial_target. Same age rule; never
    // while a Dial start is with the backend (it re-reads when it lands).
    if (this._view === "onair" && !this._stationBusy) {
      if (!this._dialEdit && (!this._dial
          || Date.now() - (this._dial.at || 0) > SETTINGS_MAX_AGE_MS)) {
        this._fetchDial();
      }
      if (!this._live || Date.now() - (this._live.at || 0) > SETTINGS_MAX_AGE_MS) {
        this._fetchLive();
      }
    }
  }

  // --- Settings ---------------------------------------------------------

  /* The speaker inventory and the stored allow-list, in one read-only
   * call. A failure is recorded as a failure rather than as an empty
   * inventory: the picker refuses to draw checkboxes it cannot trust,
   * because saving them would wipe a working list. */
  async _fetchSpeakers() {
    if (this._speakers && this._speakers.loading) return;
    this._speakers = Object.assign({}, this._speakers, { loading: true });
    try {
      const data = await this._ws("parlorwave_radio/outputs");
      this._speakers = { at: Date.now(), data };
      if (!this._speakersDirty) {
        this._speakerDraft = list_of(data && data.enabled);
      }
    } catch (e) {
      this._speakers = { at: Date.now(), data: null };
    }
    this._render();
  }

  _toggleSpeaker(id, on) {
    const draft = list_of(this._speakerDraft);
    const next = on ? (draft.includes(id) ? draft : draft.concat([id]))
                    : draft.filter((x) => x !== id);
    this._speakerDraft = next;
    const stored = list_of(this._speakers && this._speakers.data
                           && this._speakers.data.enabled);
    this._speakersDirty = !sameIds(next, stored);
    this._render();
  }

  /* Save writes the WHOLE list, which is the backend's contract for it,
   * and then re-reads: the screen shows what was stored, never what was
   * asked for. A refusal leaves the draft alone so nothing is silently
   * lost. */
  async _saveSpeakers() {
    const want = list_of(this._speakerDraft);
    this._busy = "speakers"; this._clearNotice(); this._render();
    try {
      await this._ws("parlorwave_radio/outputs_set", { enabled: want });
      this._speakersDirty = false;
      this._setNotice(true, want.length
        ? "Saved. ParlorWave Radio may DJ on those speakers."
        : "Saved. No speakers are enabled, so the DJ has nowhere to speak.");
    } catch (e) {
      this._setNotice(false, "Those speakers were not saved. Nothing has changed.");
    }
    this._busy = null;
    this._speakers = null;             // force a fresh read of the truth
    this._render();
    this._fetchSpeakers();
  }

  _resetSpeakers() {
    this._speakerDraft = list_of(this._speakers && this._speakers.data
                                 && this._speakers.data.enabled);
    this._speakersDirty = false;
    this._render();
  }

  // --- the weather entity and the calendars --------------------------------

  /* Both inventories and the stored selection in one read-only call. A
   * failure is a failure, never an empty inventory: the pickers refuse to
   * draw choices they cannot trust, because saving them would drop a
   * working selection. A draft in progress is never overwritten. */
  async _fetchSources() {
    if (this._sources && this._sources.loading) return;
    this._sources = Object.assign({}, this._sources, { loading: true });
    try {
      const data = await this._ws("parlorwave_radio/context_sources");
      this._sources = { at: Date.now(), data };
      this._srcDraft = this._srcDraftFrom(data, this._srcDraft);
    } catch (e) {
      this._sources = { at: Date.now(), data: null };
    }
    this._render();
  }

  /* The draft, rebuilt from what is stored for every selector that is not
   * mid-edit. */
  _srcDraftFrom(data, keep) {
    const d = (data && data.ok) ? data : {};
    const prev = keep || {};
    return {
      weather: this._srcDirty.weather ? prev.weather
        : String((d.weather || {}).selected || ""),
      calendars: this._srcDirty.calendars ? list_of(prev.calendars)
        : list_of((d.calendars || {}).selected),
    };
  }

  _srcStored(kind) {
    const d = this._sources && this._sources.data;
    if (!d || !d.ok) return kind === "weather" ? "" : [];
    return kind === "weather" ? String((d.weather || {}).selected || "")
                              : list_of((d.calendars || {}).selected);
  }

  _srcDirtyAny() { return !!(this._srcDirty.weather || this._srcDirty.calendars); }

  _setWeatherDraft(id) {
    const draft = this._srcDraft || this._srcDraftFrom(this._sources && this._sources.data);
    draft.weather = String(id || "");
    this._srcDraft = draft;
    this._srcDirty.weather = draft.weather !== this._srcStored("weather");
    this._render();
  }

  _toggleCalendarDraft(id, on) {
    const draft = this._srcDraft || this._srcDraftFrom(this._sources && this._sources.data);
    const list = list_of(draft.calendars);
    draft.calendars = on ? (list.includes(id) ? list : list.concat([id]))
                         : list.filter((x) => x !== id);
    this._srcDraft = draft;
    this._srcDirty.calendars = !sameIds(draft.calendars, this._srcStored("calendars"));
    this._render();
  }

  /* Save writes ONE selector -- the other travels as null, which the
   * integration reads as "leave it" -- and takes the answer as the new
   * truth: the write applies the selection before it answers, so what is
   * shown is what is now read. A refusal leaves the draft alone. */
  async _saveSources(kind) {
    const draft = this._srcDraft || {};
    const msg = kind === "weather"
      ? { weather: String(draft.weather || ""), calendars: null }
      : { weather: null, calendars: list_of(draft.calendars) };
    this._busy = `src_save:${kind}`; this._clearNotice(); this._render();
    try {
      const data = await this._ws("parlorwave_radio/context_sources_set", msg);
      this._srcDirty[kind] = false;
      this._sources = { at: Date.now(), data };
      this._srcDraft = this._srcDraftFrom(data, this._srcDraft);
      this._setNotice(true, this._srcSaid(kind, data));
      // the readiness document's Context rows and the Station tab's
      // "watching" line describe the selection: read them again. The
      // document in hand stays on show while the new one is fetched -- a
      // screen that blanks after every Save is a flicker. Its age is NOT
      // touched: an aged document is the stale verdict (_readyStale), and
      // marking this one old drew "has not answered for a while" over a
      // save that had just succeeded.
      this._announcements = null;
      this._fetchReadiness();
    } catch (e) {
      this._setNotice(false, kind === "weather"
        ? "The weather choice was not saved. Nothing has changed."
        : "Those calendars were not saved. Nothing has changed.");
    }
    this._busy = null;
    this._render();
  }

  _srcSaid(kind, data) {
    const name = (rows, id) => {
      const r = (rows || []).find((x) => x.entity_id === id);
      return r ? r.name : id;
    };
    if (kind === "weather") {
      const id = String((data.weather || {}).selected || "");
      return id ? `Saved. The DJ may mention the weather from ${name((data.weather || {}).entities, id)}.`
                : "Saved. The DJ will not mention the weather.";
    }
    const ids = list_of((data.calendars || {}).selected);
    if (!ids.length) return "Saved. No calendar is read.";
    const names = ids.map((id) => name((data.calendars || {}).entities, id));
    return `Saved. ParlorWave reads ${names.join(", ")}.`;
  }

  _resetSources(kind) {
    const draft = this._srcDraft || {};
    if (kind === "weather") draft.weather = this._srcStored("weather");
    else draft.calendars = this._srcStored("calendars");
    this._srcDraft = draft;
    this._srcDirty[kind] = false;
    this._render();
  }

  async _fetchStationSettings() {
    try {
      const data = await this._ws("parlorwave_radio/station_settings");
      this._stationSettings = (data && data.settings) || {};
      this._stationSettingsAt = Date.now();
      if (!this._stationDirty) {
        const ident = (this._stationSettings && this._stationSettings.identity) || {};
        this._stationDraft = ident.name || "ParlorWave Radio";
      }
    } catch (e) {
      // quiet fallback
    }
    this._render();
  }

  _stationIdentityName() {
    const fromAttrs = this._djStatus && this._djStatus.attributes && this._djStatus.attributes.station_name;
    if (fromAttrs) return fromAttrs;
    const st = this._stationSettings;
    const fromSettings = st && st.identity && st.identity.name;
    if (fromSettings) return fromSettings;
    return "ParlorWave Radio";
  }

  _validateStationName(name) {
    if (typeof name !== "string") return "Station name must be text.";
    const trimmed = name.trim();
    if (!trimmed) return null;
    if (trimmed.length > 60) return "Station name must be at most 60 characters.";
    if (/[\r\n]/.test(trimmed)) return "Station name must be a single line.";
    if (/[<>]/.test(trimmed)) return "Station name must not contain markup (< or >).";
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed.charCodeAt(i) < 32) return "Station name must not contain control characters.";
    }
    return null;
  }

  async _saveStationIdentity() {
    const raw = (this._stationDraft == null ? "" : String(this._stationDraft)).trim();
    const err = this._validateStationName(raw);
    if (err) {
      this._stationError = err;
      this._render();
      return;
    }
    const want = raw || "ParlorWave Radio";
    this._busy = "station_name"; this._clearNotice(); this._stationError = null; this._render();
    try {
      await this._ws("parlorwave_radio/station_save", {
        station: { identity: { name: want } }
      });
      this._stationDirty = false;
      this._stationDraft = want;
      this._setNotice(true, `Saved. Your DJ will use "${want}" on air.`);
    } catch (e) {
      this._stationError = (e && e.message) || "Station name was not saved.";
      this._setNotice(false, "Station name was not saved.");
    }
    this._busy = null;
    this._stationSettings = null;
    this._render();
    this._fetchStationSettings();
  }

  _resetStationIdentity() {
    const ident = (this._stationSettings && this._stationSettings.identity) || {};
    this._stationDraft = ident.name || "ParlorWave Radio";
    this._stationDirty = false;
    this._stationError = null;
    this._render();
  }

  /* Announcements (Station tab): one read-only call answers the whole
   * card -- settings as the engine reads them, sync freshness, upcoming
   * occurrences and what recently aired. Failure is recorded as failure;
   * the card then says the list is unavailable rather than pretending
   * there are no announcements. */
  async _fetchAnnouncements(force) {
    if (this._announcements && this._announcements.loading) return;
    this._announcements = Object.assign({}, this._announcements,
                                        { loading: true });
    try {
      const data = await this._ws("parlorwave_radio/announcements");
      this._announcements = { at: Date.now(), data };
    } catch (e) {
      this._announcements = { at: Date.now(), data: null, error: true };
    }
    this._render();
  }

  async _saveAnnouncementsSetting(patch) {
    this._busy = "announcements"; this._clearNotice(); this._render();
    try {
      await this._ws("parlorwave_radio/station_save",
                     { station: { announcements: patch } });
    } catch (e) {
      this._setNotice(false, "Announcement settings were not saved.");
    }
    this._busy = null;
    await this._fetchAnnouncements(true);
  }

  async _fetchReadiness() {
    const r = this._ready;
    if (r && r.loading && Date.now() - (r.loadingSince || 0) < READY_READ_TIMEOUT_MS) return;
    // the key this read answers for, taken as it starts: a change while it
    // is out asks again rather than being mistaken for this answer
    const key = this._readinessKey();
    this._ready = Object.assign({}, this._ready, { loading: true, loadingSince: Date.now() });
    try {
      const data = await this._ws("parlorwave_radio/readiness");
      this._ready = { at: Date.now(), data, key };
    } catch (e) {
      // The service's own words are NOT shown: a connection failure's
      // message carries the address it failed to reach, and this screen
      // promises that no address of ours ever renders.
      this._ready = { at: Date.now(), data: null, error: true, key };
    }
    this._render();
  }

  /* The integration's readiness_key (DJ status sensor), "" while the
   * sensor is unavailable, undefined on an integration that does not
   * publish one (the timer alone then, as before). */
  _readinessKey() {
    const ent = this._djStatus;
    if (!ent) return undefined;
    if (ent.state === "unavailable") return "";
    const k = (ent.attributes || {}).readiness_key;
    return typeof k === "string" ? k : undefined;
  }

  // --- Newsroom ---------------------------------------------------------

  async _fetchNews() {
    if (this._newsdesk && this._newsdesk.loading) return;
    this._newsdesk = Object.assign({}, this._newsdesk, { loading: true });
    try {
      const data = await this._ws("parlorwave_radio/news_status");
      this._newsdesk = { at: Date.now(), data };
    } catch (e) {
      this._newsdesk = { at: Date.now(), data: null, error: String(e && e.message || e) };
    }
    this._render();
  }

  /* The form's draft. Seeded ONCE from what the station actually holds, so
   * a poll landing between two keystrokes can never put the saved value
   * back under the cursor. */
  /* THE SOURCE LIST, as a draft the screen edits.
   *
   * Seeded once from what is stored and then owned here until Save, for
   * the same reason the two text boxes are: the Newsroom re-reads itself
   * every twenty seconds, and a poll landing between two keystrokes must
   * not put the stored value back under the cursor. */
  _newsSources() {
    if (!this._newsSrcDraft) {
      const b = this._newsBulletins();
      this._newsSrcDraft = (b.sources || []).map((s) => ({
        id: s.id || "",
        name: s.name || "",
        feed_url: s.feed_url || "",
        enabled: s.enabled !== false,
        target_minute: typeof s.target_minute === "number" ? s.target_minute : 30,
      }));
    }
    return this._newsSrcDraft;
  }

  _newsBulletins() {
    return ((this._newsdesk && this._newsdesk.data
             && this._newsdesk.data.newsroom) || {}).bulletins || {};
  }

  _newsSrcEdit(id, key, value) {
    const row = this._newsSources().find((r) => r.id === id);
    if (!row) return;
    row[key] = value;
    this._newsForm().dirty = true;
  }

  _newsSrcAdd() {
    // A new row needs an id before it has a URL, or the screen cannot
    // address the box the cursor is in. The backend derives the REAL id
    // from the feed address on save; this one only has to be unique here.
    this._newsSources().push({
      id: `new-${Date.now().toString(36)}`, name: "", feed_url: "",
      enabled: true, target_minute: 30,
    });
    this._newsForm().dirty = true;
    this._newsEditing = this._newsSources()[this._newsSources().length - 1].id;
    this._render();
  }

  _newsSrcRemove(id) {
    this._newsSrcDraft = this._newsSources().filter((r) => r.id !== id);
    this._newsForm().dirty = true;
    if (this._newsEditing === id) this._newsEditing = null;
    this._render();
  }

  _newsForm() {
    if (!this._newsDraft) {
      const b = ((this._newsdesk && this._newsdesk.data && this._newsdesk.data.newsroom) || {}).bulletins || {};
      this._newsDraft = {
        enabled: !!b.enabled,
        // the STORED name, never the resolved label -- seeding the box
        // with a derived feed host would turn a fallback into a value the
        // next Save writes down as if the owner had typed it
        source_name: b.source_name_stored || "",
        feed_url: b.feed_url || "",
        target_minute: typeof b.target_minute === "number" ? b.target_minute : 30,
        dirty: false,
      };
    }
    return this._newsDraft;
  }

  _newsEdit(key, value) {
    const d = this._newsForm();
    d[key] = value;
    d.dirty = true;
  }

  /* What the two Newsroom actions send. One shape, built in one place, so
   * Test Feed always proves exactly what Save would store. */
  _newsPatch() {
    const d = this._newsForm();
    const sources = this._newsSources()
      .map((r) => ({
        // A row that never got an address is dropped rather than saved as
        // a source that can never air.
        name: (r.name || "").trim(),
        feed_url: (r.feed_url || "").trim(),
        enabled: !!r.enabled,
        target_minute: Number(r.target_minute),
      }))
      .filter((r) => r.feed_url);
    const patch = { enabled: !!d.enabled, sources };
    if (!sources.length) {
      // Removing the last source must actually remove the feed. An empty
      // list beside a legacy address means "not migrated yet" to the
      // backend, so leaving the old fields would migrate the deleted feed
      // straight back on the next read.
      patch.source_name = "";
      patch.publisher = { source: "custom", custom_feed_url: "" };
    }
    return patch;
  }

  /* Test Feed answers for ONE source, and for what is in its boxes right
   * now rather than what was last saved -- so an address can be checked
   * before it is committed to the station. */
  _newsSourcePatch(id) {
    const row = this._newsSources().find((r) => r.id === id) || {};
    return {
      enabled: true,
      source_name: (row.name || "").trim(),
      schedule: { target_minute: Number(row.target_minute) },
      publisher: { source: "custom",
                   custom_feed_url: (row.feed_url || "").trim() },
    };
  }

  async _saveNews() {
    // A source with no address cannot air, and dropping it quietly under a
    // green "saved" is worse than refusing: the typed row would simply vanish.
    const missing = this._newsSources().filter((r) => !(r.feed_url || "").trim());
    if (missing.length) {
      const name = (missing[0].name || "").trim() || "A new source";
      this._setNotice(false, `${name} has no feed address. Add one, or remove the source, before saving.`);
      this._render();
      return;
    }
    this._busy = "news_save";
    this._render();
    try {
      await this._ws("parlorwave_radio/news_save", { bulletins: this._newsPatch() });
      this._newsDraft = null;            // re-seed from what was actually stored
      this._newsSrcDraft = null;
      this._newsEditing = null;
      this._setNotice(true, "Newsroom saved.");
      this._newsdesk = null;
      await this._fetchNews();
    } catch (e) {
      // The backend phrased this refusal for a developer; the person sees a
      // sentence, and the original is kept on the notice for support.
      this._refuse("", e);
    } finally {
      this._busy = null;
      this._render();
    }
  }

  /* Test Calendar. Answers what Parlorwave can see of the calendar RIGHT
   * NOW: the integration republishes, then the backend reports which events
   * it holds and why each one would or would not reach a break. Read-only
   * on both sides -- it selects no topic, commits no suppression mark, and
   * never causes a break to air. */
  async _testNewsSource(id) {
    this._newsTest = { running: true, id };
    this._busy = `news_test:${id}`;
    this._render();
    try {
      const result = await this._ws("parlorwave_radio/news_test",
                                    { bulletins: this._newsSourcePatch(id) });
      this._newsTest = { result, id };
    } catch (e) {
      this._newsTest = { error: String((e && e.message) || e), id };
    } finally {
      this._busy = null;
      this._render();
    }
  }

  async _fetchNewsHistory() {
    try {
      const data = await this._ws("parlorwave_radio/news_history", { limit: 20 });
      this._newsHistory = { rows: (data && data.history) || [],
                            latest: (data && data.latest) || [] };
    } catch (e) {
      this._newsHistory = { error: String((e && e.message) || e) };
    }
    this._render();
  }

  /* LISTEN AGAIN. Local preview in this browser, and nothing else: the
   * audio is fetched through Home Assistant and played here. It is never
   * handed to Music Assistant, never inserted into a queue and never put
   * on a speaker -- replaying the news into the house is exactly what a
   * person pressing "listen again" is not asking for. */
  async _listenAgain(token) {
    if (!token || this._busy === `listen:${token}`) return;
    this._busy = `listen:${token}`;
    this._listenError = null;
    this._render();
    try {
      const send = async () => fetch(
        `${BULLETIN_AUDIO_PATH}?token=${encodeURIComponent(token)}`,
        { headers: await this._authHeaders() });
      let resp = await send();
      if (resp.status === 401 && this._authRetry()) resp = await send();
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.message || "That bulletin is no longer available to play.");
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.addEventListener("ended", () => URL.revokeObjectURL(url));
      await audio.play();
      this._playing = token;
    } catch (e) {
      this._listenError = String((e && e.message) || e);
      // The row said it was available and it is not: re-read, so the
      // button stops offering something that cannot happen.
      this._fetchNewsHistory();
    } finally {
      this._busy = null;
      this._render();
    }
  }

  /* THE TWO OPTIONAL SERVICES.
   *
   * A voice engine speaks the words; a writing model produces them. They
   * are separate capabilities that fail separately and are configured
   * separately, and this screen keeps them apart -- one being down must
   * never read as the other being down.
   *
   * NO CREDENTIAL EVER LIVES HERE. A key typed into the box is sent once
   * and never comes back: every read returns null beside a boolean saying
   * whether one is saved, and the box shows "Configured" rather than a row
   * of dots standing in for a value this browser does not have. */
  _svcForm() {
    if (!this._svcDraft) {
      const s = (this._services && this._services.settings) || {};
      const v = s.voice_engine || {}, w = s.writer || {};
      this._svcDraft = {
        voice_engine: {
          enabled: !!v.enabled, base_url: v.base_url || "",
          voice: v.voice || "", key_set: !!v.key_saved, key: null,
        },
        writer: {
          // No default protocol is named here: the backend offers the
          // list and the first entry is its own default.
          enabled: !!w.enabled,
          provider: w.provider || ((this._services
            && (this._services.writer_providers || [])[0] || {}).id) || "",
          base_url: w.base_url || "", model: w.model || "",
          key_set: !!w.key_saved, key: null,
        },
        dirty: false,
      };
    }
    return this._svcDraft;
  }

  /* WHICH PROTOCOLS THE WRITER CAN SPEAK is a backend fact and arrives
   * with the settings. Naming them here would bake an inference host into
   * the integration, which is a standing invariant and a source-level
   * test. */
  _writerProviders() {
    const offered = (this._services && this._services.writer_providers) || [];
    return offered.filter((o) => o && o.id);
  }

  _svcEdit(kind, key, value) {
    const d = this._svcForm();
    d[kind][key] = value;
    d.dirty = true;
    // Typing never re-renders the form (it would move the cursor), so Save
    // is switched on in place -- as the Newsroom's is. Changing only the
    // voice engine's address used to leave Save off until something else
    // happened to render.
    const save = this.shadowRoot && this.shadowRoot.getElementById("svc-save");
    if (save && this._busy !== "svc_save") save.disabled = false;
  }

  async _fetchServices() {
    try {
      this._services = await this._ws("parlorwave_radio/services");
    } catch (e) {
      this._services = { error: String((e && e.message) || e) };
    }
    this._render();
  }

  _svcPatch() {
    const d = this._svcForm();
    const one = (x, extra) => Object.assign({
      enabled: !!x.enabled,
      base_url: (x.base_url || "").trim(),
      // null means LEAVE THE STORED KEY. The read never returns one, so a
      // form that sent back what it was shown would blank a credential it
      // was never given.
      key: x.key,
    }, extra);
    return {
      voice_engine: one(d.voice_engine, { voice: (d.voice_engine.voice || "").trim() }),
      writer: one(d.writer, { provider: d.writer.provider,
                              model: (d.writer.model || "").trim() }),
    };
  }

  async _saveServices() {
    this._busy = "svc_save";
    this._render();
    try {
      await this._ws("parlorwave_radio/services_save",
                     { services: this._svcPatch() });
      this._svcDraft = null;
      this._services = null;
      this._setNotice(true, "Optional services saved.");
      await this._fetchServices();
    } catch (e) {
      this._refuse("", e);
    } finally {
      this._busy = null;
      this._render();
    }
  }

  /* WHAT IS ON THE SCREEN IS WHAT IS TESTED. The draft carries the address
   * the person is looking at, saved or not, and a key only if they typed
   * one in this session -- a saved key stays where it is and the backend
   * uses it. Nothing here writes a setting. */
  _svcTestPayload(kind) {
    const d = this._svcForm()[kind] || {};
    const out = { kind };
    if (d.base_url) out.base_url = d.base_url;
    if (typeof d.key === "string" && d.key) out.key = d.key;
    if (kind === "writer") {
      if (d.provider) out.provider = d.provider;
      if (d.model) out.model = d.model;
    } else if (d.voice) {
      out.voice = d.voice;
    }
    return out;
  }

  /* What a service said it offers, kept for the field that names one of
   * them. In memory only, and replaced whole rather than merged: an
   * inventory is a snapshot of one answer, not a growing list. */
  _svcRemember(kind, names) {
    const list = (names || []).filter(Boolean).map(String);
    if (!list.length) return;
    this._svcInv = Object.assign({}, this._svcInv, { [kind]: list });
  }

  async _testService(kind) {
    this._svcTest = Object.assign({}, this._svcTest, { [kind]: { running: true } });
    this._busy = `svc_test:${kind}`;
    this._render();
    let out;
    try {
      const result = await this._ws("parlorwave_radio/service_test",
                                    this._svcTestPayload(kind));
      out = { result };
      if (result && result.ok) {
        this._svcRemember(kind, result.voices || result.models);
      }
    } catch (e) {
      out = { error: String((e && e.message) || e) };
    }
    this._svcTest = Object.assign({}, this._svcTest, { [kind]: out });
    this._busy = null;
    this._render();
  }

  /* FIND IT: a short list of named addresses, tried in order by the
   * backend. Bounded there, and never a scan. A hit fills the address in
   * as a DRAFT -- the person still presses Save, because an address this
   * screen guessed is still their decision. */
  async _findWriter() {
    const kind = "writer";
    this._svcTest = Object.assign({}, this._svcTest, { [kind]: { running: true } });
    this._busy = `svc_find:${kind}`;
    this._render();
    let find;
    try {
      const d = this._svcForm()[kind] || {};
      // The protocol travels as the BACKEND named it in writer_providers;
      // this screen has no default of its own, because a default here is
      // an inference host baked into the integration.
      const result = await this._ws("parlorwave_radio/writer_find",
                                    { base_url: d.base_url || "",
                                      provider: d.provider || "" });
      find = { result };
      if (result && result.ok) {
        if (result.found) this._svcEdit(kind, "base_url", result.found);
        this._svcRemember(kind, result.models);
      }
    } catch (e) {
      find = { error: String((e && e.message) || e) };
    }
    this._svcTest = Object.assign({}, this._svcTest, { [kind]: { find } });
    this._busy = null;
    this._render();
  }

  async _testCalendar() {
    this._calTest = { running: true };
    this._busy = "cal_test";
    this._render();
    try {
      this._calTest = { result: await this._ws("parlorwave_radio/calendar_test") };
    } catch (e) {
      this._calTest = { error: String((e && e.message) || e) };
    } finally {
      this._busy = null;
      this._render();
    }
  }

  /* Test Weather. The other half of the same question, and the same
   * shape: the integration republishes what Home Assistant currently
   * reports, then the backend says what it now holds and what a break
   * started this second would say about it. Read-only on both sides --
   * no forecast service is contacted, no topic is selected, no
   * suppression mark is committed, and no break can air because of it. */
  async _testWeather() {
    this._weatherTest = { running: true };
    this._busy = "weather_test";
    this._render();
    try {
      this._weatherTest = { result: await this._ws("parlorwave_radio/weather_test") };
    } catch (e) {
      this._weatherTest = { error: String((e && e.message) || e) };
    } finally {
      this._busy = null;
      this._render();
    }
  }

  /* An event as a person reads it. All-day entries have a DATE and no clock
   * time, so they are never given one here either -- inventing a time is
   * exactly what the backend's fact text is worded to prevent. */
  _calWhen(ev) {
    const raw = String(ev.start || "");
    if (!raw) return "";
    if (ev.all_day) {
      const d = Number(ev.days_away);
      if (d === 0) return "Today \u00b7 all day";
      if (d === 1) return "Tomorrow \u00b7 all day";
      return `${raw} \u00b7 all day`;
    }
    const when = new Date(raw);
    if (isNaN(when.getTime())) return raw;
    const today = new Date();
    const sameDay = when.toDateString() === today.toDateString();
    const time = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return sameDay ? time : `${when.toLocaleDateString([], { weekday: "short" })} ${time}`;
  }

  /* WHY EACH EVENT WOULD OR WOULD NOT BE MENTIONED, in the owner's words
   * rather than the engine's. The codes are the diagnosis's own
   * (dj_context.calendar_diagnosis); anything unrecognised falls through
   * to no flag at all rather than being printed raw, because a reason
   * code on screen is an internal identifier a person has to decode. */
  _calReasonWords(reason) {
    return {
      eligible_headsup: ["can be mentioned", "good"],
      eligible_reminder: ["can be mentioned again", "good"],
      eligible_allday: ["can be mentioned", "good"],
      already_announced: ["already mentioned", "muted"],
      already_started: ["already started", "muted"],
      beyond_allday_lead: ["too far ahead to mention yet", "muted"],
      outside_window: ["not due to be mentioned yet", "muted"],
      no_station_clock: ["no station clock", "muted"],
      unreadable_start: ["its time could not be read", "muted"],
    }[String(reason || "")] || null;
  }

  /* WHAT THE STATION IS HOLDING, said plainly. The point of this whole
   * diagnostic is that silence has several causes, so the footer states
   * the two facts that separate them: when the snapshot arrived, and what
   * the station believes the local time is. Neither is a secret and
   * neither is an identifier. */
  _contextHeld(b) {
    const bits = [];
    if (b.captured_at) {
      bits.push(`received ${this._agoText(b.captured_at) || this._localTime(b.captured_at)}`);
    }
    if (b.station_time) bits.push(`station clock ${this._localTime(b.station_time)}`);
    return bits.length
      ? `<div class="news-test-detail">${this._esc(bits.join(" · "))}</div>` : "";
  }

  _renderCalTest() {
    const t = this._calTest;
    if (!t) return "";
    if (t.running) return `<div class="news-test"><div class="news-test-head">Checking…</div></div>`;
    if (t.error) {
      return `<div class="news-test bad">
        <div class="news-test-head">Could not run the test</div>
        <div class="news-test-body">${this._esc(t.error)}</div></div>`;
    }
    const r = t.result || {};
    const b = r.backend || {};
    const bad = (head, body) => `<div class="news-test bad">
      <div class="news-test-head">${this._esc(head)}</div>
      <div class="news-test-body">${body}</div>
      <div class="news-test-foot">Nothing was changed, and the music was not
      interrupted.</div></div>`;
    if (r.state === "no_calendar_selected") {
      return bad("No calendar selected",
                 `Tick one above and save, and the DJ can mention what is
                  coming up.`);
    }
    if (r.state === "calendar_unavailable") {
      const names = (r.entities || []).map((e) => this._esc(e.name)).join(", ");
      return bad("Calendar unavailable",
                 `Home Assistant currently reports no state for
                  ${names || "the selected calendar"}.`);
    }
    if (r.state === "publish_failed") {
      return bad("ParlorWave could not be given the calendar",
                 this._esc(r.publish_error || "The last publish did not succeed."));
    }
    if (r.state === "backend_has_no_context") {
      return bad("ParlorWave has not received any context yet",
                 `Home Assistant read the calendar, but the station has no
                  snapshot. It keeps retrying; breaks simply leave the
                  calendar out until it succeeds.`);
    }
    const names = (r.entities || []).map((e) => this._esc(e.name)).join(", ");
    const events = b.events || [];
    const say = b.would_say;
    const offRow = b.enabled_in_settings ? "" : `<div class="news-test-detail">
      The DJ is not currently allowed to mention the calendar — turn on
      <b>Calendar</b> in ${this._go("booth")}.</div>`;
    // SUCCESS WITH NO EVENTS IS A SUCCESS, and is written as one: the
    // calendar reads, there is simply nothing in the window. That case
    // used to be indistinguishable from a calendar that was never
    // published, which is the whole reason this screen exists.
    if (!events.length) {
      return `<div class="news-test good">
        <div class="news-test-head">ParlorWave can read ${names || "the calendar"}</div>
        <div class="news-test-body">No upcoming events in the window it looks
        at, so a break right now would not mention the calendar.</div>
        ${this._contextHeld(b)}${offRow}</div>`;
    }
    const rows = events.map((ev) => {
      const words = this._calReasonWords(ev.reason);
      return `<div class="cal-row">
        <span class="cal-when">${this._esc(this._calWhen(ev))}</span>
        <span class="cal-what">${this._esc(ev.summary || "(no title)")}</span>
        ${words ? `<span class="cal-flag ${this._esc(words[1])}">${this._esc(words[0])}</span>` : ""}
      </div>`;
    }).join("");
    return `<div class="news-test good">
      <div class="news-test-head">ParlorWave can read ${names || "the calendar"}</div>
      <div class="news-test-body">${this._esc(
        `${events.length} event${events.length === 1 ? "" : "s"} in the window it looks at.`)}</div>
      <div class="cal-list">${rows}</div>
      <div class="news-test-body">${say
        ? `In a break right now it would say: <b>${this._esc(say)}</b>`
        : `Nothing here is inside the announcement window yet, so a break
           right now would not mention the calendar.`}</div>
      ${this._contextHeld(b)}${offRow}
      <div class="news-test-foot">Only the title and time of an event are ever
      used, and only on this screen and in a break.</div></div>`;
  }

  /* THE WEATHER RESULT. Four different silences, told apart -- no entity
   * chosen, the entity not reporting, the publish failing, the station
   * holding nothing -- and then the facts it does hold, with the sentence
   * a break started this second would actually carry.
   *
   * STALE IS ITS OWN ANSWER, and it is the case worth having this screen
   * for: a reading the station HAS but is too old to state looks, from
   * every other surface, exactly like a healthy one. */
  _renderWeatherTest() {
    const t = this._weatherTest;
    if (!t) return "";
    if (t.running) return `<div class="news-test"><div class="news-test-head">Checking…</div></div>`;
    if (t.error) {
      return `<div class="news-test bad">
        <div class="news-test-head">Could not run the test</div>
        <div class="news-test-body">${this._esc(t.error)}</div></div>`;
    }
    const r = t.result || {};
    const b = r.backend || {};
    const name = (r.entity && r.entity.name) || "the weather entity";
    const bad = (head, body) => `<div class="news-test bad">
      <div class="news-test-head">${this._esc(head)}</div>
      <div class="news-test-body">${body}</div>
      <div class="news-test-foot">Nothing was changed, and the music was not
      interrupted.</div></div>`;
    if (r.state === "no_weather_selected") {
      return bad("No weather entity selected",
                 `Choose one above and save, and the DJ can mention the
                  conditions.`);
    }
    if (r.state === "weather_unavailable") {
      return bad("Weather unavailable",
                 `Home Assistant currently reports no state for
                  ${this._esc(name)}.`);
    }
    if (r.state === "publish_failed") {
      return bad("ParlorWave could not be given the weather",
                 this._esc(r.publish_error || "The last publish did not succeed."));
    }
    if (r.state === "backend_has_no_context") {
      return bad("ParlorWave has not received any context yet",
                 `Home Assistant read ${this._esc(name)}, but the station has
                  no snapshot. It keeps retrying; breaks simply leave the
                  weather out until it succeeds.`);
    }
    if (b.reason === "no_weather_in_snapshot") {
      return bad("ParlorWave holds no weather",
                 `The station has a snapshot with no weather in it.
                  ${this._esc(name)} may have been unavailable when it was
                  published.`);
    }
    const offRow = b.enabled_in_settings ? "" : `<div class="news-test-detail">
      The DJ is not currently allowed to mention the weather — turn on
      <b>Weather</b> in ${this._go("booth")}.</div>`;
    const deg = (v) => `${Math.round(Number(v))}°`;
    const facts = [
      b.condition ? ["Conditions", String(b.condition).replace(/_/g, " ")] : null,
      b.temperature != null ? ["Right now", deg(b.temperature)] : null,
      b.forecast_high != null ? ["High", deg(b.forecast_high)] : null,
      b.forecast_low != null ? ["Low", deg(b.forecast_low)] : null,
    ].filter(Boolean).map((kv) => `<div class="cal-row">
        <span class="cal-when">${this._esc(kv[0])}</span>
        <span class="cal-what">${this._esc(kv[1])}</span></div>`).join("");
    const stale = b.reason === "stale";
    const age = this._runWords((b.weather_age_minutes || 0) * 60);
    return `<div class="news-test ${stale ? "bad" : "good"}">
      <div class="news-test-head">${stale
        ? "ParlorWave's weather is too old to use"
        : `ParlorWave can read ${this._esc(name)}`}</div>
      ${facts ? `<div class="cal-list">${facts}</div>` : ""}
      <div class="news-test-body">${stale
        ? this._esc(`This reading is ${age || "too"} old, so a break leaves the
            weather out rather than state something that may have changed. It
            recovers by itself the moment Home Assistant reports again.`)
        : (b.would_say
            ? `In a break right now it would say: <b>${this._esc(b.would_say)}</b>`
            : `The station holds this reading, and a break right now would not
               state it.`)}</div>
      ${b.daylight ? `<div class="news-test-detail">${this._esc(b.daylight)}</div>` : ""}
      ${this._contextHeld(b)}${offRow}
      <div class="news-test-foot">Only the conditions and temperatures above are
      ever used, and only on this screen and in a break.</div></div>`;
  }

  async _fetchLyrics() {
    const uri = this._nowUri();
    if (this._lyrics && this._lyrics.loading) return;
    // The drawer keeps its height while the next song's lyrics load: a
    // one-line "Fetching lyrics" in its place would throw the console up the
    // page and back at every track change.
    const pane = this.shadowRoot && typeof this.shadowRoot.querySelector === "function"
      ? this.shadowRoot.querySelector(".lyrics") : null;
    const shown = pane && typeof pane.closest === "function" ? pane.closest(".drawer") : null;
    this._lyricHoldPx = shown && shown.offsetHeight ? Math.round(shown.offsetHeight) : 0;
    this._resetLyricPane();
    this._lyrics = { forUri: uri, loading: true };
    try {
      const data = await this._ws("parlorwave_radio/lyrics");
      this._lyrics = { forUri: data.uri || uri, data };
    } catch (e) { this._lyrics = { forUri: uri, data: { kind: "none" } }; }
    this._render();
  }

  async _fetchQueue() {
    if (this._queue && this._queue.loading) return;
    // Rows a moment old stay on show while they are re-read (see
    // QUEUE_SHOW_WHILE_READING_MS); the renderer only reads this flag.
    const prev = this._queue;
    const standIn = !!(prev && prev.data && prev.at && Date.now() - prev.at < QUEUE_SHOW_WHILE_READING_MS);
    this._queue = Object.assign({}, this._queue, { loading: true, standIn });
    try {
      const data = await this._ws("parlorwave_radio/queue", { recent: 5, upcoming: 10 });
      this._queue = { at: Date.now(), data };
    } catch (e) { this._queue = { at: Date.now(), data: null }; }
    this._render();
  }

  async _fetchHistory() {
    try {
      const data = await this._ws("parlorwave_radio/history", { limit: 10 });
      this._history = { at: Date.now(), data };
    } catch (e) { this._history = { at: Date.now(), data: null }; }
    this._render();
  }

  /* BROADCAST DIAGNOSTICS: rows a page at a time, with the filters on
   * show. `more` continues from the last page's cursor; anything else
   * starts again from the newest. A read that fails keeps nothing it
   * cannot vouch for, and an answer a newer read has overtaken is dropped. */
  async _fetchDiag(more) {
    const f = this._diagFilter;
    const prev = this._diag || {};
    const msg = { limit: DIAG_PAGE, kind: f.kind };
    if (f.outcome) msg.outcome = f.outcome;
    if (f.reason) msg.reason = f.reason;
    if (more && prev.next) msg.before = prev.next;
    const gen = ++this._diagGen;
    this._diag = more ? Object.assign({}, prev, { loading: true, error: false })
      : { items: null, next: null, scan: null, loading: true };
    this._render();
    let data = null;
    try { data = await this._ws("parlorwave_radio/broadcast_diagnostics_list", msg); }
    catch (e) { data = null; }
    if (gen !== this._diagGen) return;
    const was = this._diag;
    if (!data) {
      this._diag = Object.assign({}, was, { loading: false, error: true });
    } else if (data.ok === false) {
      this._diag = { items: null, next: null, scan: null, unsupported: true };
    } else {
      const kept = (more && was.items) || [];
      const seen = new Set(kept.map((i) => i.opportunity_id));
      this._diag = { items: kept.concat((data.items || []).filter((i) => !seen.has(i.opportunity_id))),
                     next: data.next_before || null, scan: data.scan || null, loading: false };
    }
    this._render();
  }

  async _fetchDiagDetail(id) {
    const mine = { loading: true };
    this._diagDetail[id] = mine;
    this._render();
    let d = null;
    try { d = await this._ws("parlorwave_radio/broadcast_diagnostics_detail", { opportunity_id: id }); }
    catch (e) { d = null; }
    if (this._diagDetail[id] !== mine) return;       // a newer read, or Refresh, replaced this one
    this._diagDetail[id] = d || { ok: false, reason: "unreadable" };
    if (id === this._diagLinked && this._diagLinkFocus) {
      this._diagLinkFocus = false;
      this._focusNext = { id: "diag-linked" };
    }
    this._render();
  }

  /* An Inspect link on On Air: Settings, the support disclosure open and
   * that break's whole record above the list. Read by its id, so it is
   * found whether or not the loaded page or the filters hold it -- and read
   * again every time, because the break on the air is still changing. */
  _diagInspect(id) {
    this._view = "settings";
    this._readyAdvanced = true;
    this._diagLinked = id;
    this._diagLinkFocus = true;
    this._maybeRefreshDemandData();
    if (!this._diag) this._fetchDiag(false);
    this._fetchDiagDetail(id);
  }

  /* Refresh re-reads only what a person can see -- the linked record and
   * the rows open on the first page -- one after another: each read is a
   * scan of the break record on the station. */
  _diagRefresh() {
    const first = new Set(((this._diag || {}).items || []).slice(0, DIAG_PAGE).map((i) => i.opportunity_id));
    for (const id of [...this._diagOpen]) if (!first.has(id)) this._diagOpen.delete(id);
    const again = [...new Set([this._diagLinked, ...this._diagOpen].filter(Boolean))];
    this._diagDetail = {};
    this._fetchDiag(false);
    (async () => { for (const id of again) await this._fetchDiagDetail(id); })();
  }

  /* The diagnostics commands are Home Assistant's administrator commands
   * (they carry refused drafts); nobody else is offered a door to them. */
  _diagAllowed() {
    const u = this._hass && this._hass.user;
    return !!(u && u.is_admin);
  }

  async _fetchVoiceLib() {
    try { this._voiceLib = await this._ws("parlorwave_radio/voices"); }
    catch (e) { this._voiceLib = null; }
    this._render();
  }

  /* --- Waveform envelope demand data -------------------------------------
   * Fetches Music Assistant's precomputed 1,800-bin audio analysis waveform
   * for the item on air, to drive the Broadcast Console mouth.
   *
   * WHEN. The Mouth is drawn on the Broadcast Console, and the console is
   * part of On Air (_renderOnAir ends with _renderConsole, unconditionally),
   * so the demand runs while On Air is the view. It used to be gated on a
   * view named "console", which does not exist, so the panel sent
   * no waveform request at all. The demand runs from _maybeRefreshDemandData
   * -- on every hass update, which is also how a new item arrives -- and
   * when On Air is chosen.
   *
   * ONCE PER ITEM, THEN ONLY ON ITS OWN TIMERS. The first sight of an item
   * sends one request. Everything after that for the same item -- the
   * confirming look, a bounded retry, the refresh of an unsettled waveform
   * -- is a timer owned by that item's demand, which a new item, another
   * view, the demo or a teardown cancels. An item that exhausted its
   * retries is left on the synthetic display rather than asked again on
   * every hass update.
   *
   * A REPLY IS FILED UNDER THE ITEM IT NAMES, never under the item it was
   * asked for: the backend answers for whatever MA calls current, and its
   * bins belong to that item by construction. Whether that item is the one
   * to DRAW is the clock's question (below), not the reply's. */
  _consoleOnShow() {
    return this._view === "onair";
  }

  _currentQueueItemId() {
    if (this._waveformDemo) return WAVEFORM_DEMO_KEY;
    const n = this._nowCard;
    const a = n && n.attributes;
    // Only an MA queue item id can be checked against a reply; a uri
    // cannot, so an item without one stays on the synthetic display.
    return (a && a.queue_item_id) || null;
  }

  _resetWaveformDemand() {
    const d = this._wfDemand;
    if (d && d.timer) clearTimeout(d.timer);
    this._wfDemand = null;
  }

  _maybeRefreshWaveform() {
    if (this._waveformDemo) return;
    const key = this._consoleOnShow() ? this._currentQueueItemId() : null;
    const d = this._wfDemand;
    if (d && d.key === key) return;              // this item's timers own it
    this._resetWaveformDemand();                 // new item, no item, or off screen
    if (!key) return;
    this._wfDemand = { key, seq: 0, timer: null, retries: 0, refreshes: 0 };
    this._fetchWaveform(this._wfDemand);
  }

  _scheduleWaveform(d, ms) {
    if (d.timer) clearTimeout(d.timer);
    d.timer = setTimeout(() => {
      d.timer = null;
      if (this._wfDemand !== d) return;          // superseded while waiting
      if (!this._consoleOnShow() || this._currentQueueItemId() !== d.key) return;
      this._fetchWaveform(d);
    }, ms);
  }

  async _fetchWaveform(d) {
    if (d.timer) { clearTimeout(d.timer); d.timer = null; }
    const seq = ++d.seq;
    let resp = null;
    try {
      resp = await this._ws("parlorwave_radio/waveform");
    } catch (_err) {
      resp = null;                               // retried below, like not_analyzed
    }
    if (this._wfDemand !== d || d.seq !== seq) return;   // superseded in flight
    const now = this._perfNow();
    const named = resp && typeof resp.queue_item_id === "string" && resp.queue_item_id
      ? resp.queue_item_id : null;
    if (named && resp.ok && Array.isArray(resp.bins) && resp.bins.length > 0) {
      this._storeWaveform(named, resp);
    }
    if (named) {
      this._observe({ key: named, elapsed: resp.elapsed, at: resp.elapsed_at,
                      state: resp.state }, now);
    }
    if (this._currentQueueItemId() !== d.key) return;   // the item moved on
    const held = this._waveforms.get(d.key);
    if (!this._confirmed.has(d.key) || !held) {
      // Not yet confirmed, not analysed, a reply for another item, MA
      // unavailable, a transport error: look again, a bounded number of
      // times -- soon if all that is missing is the confirming look.
      if (d.retries < WAVEFORM_MAX_RETRIES) {
        d.retries++;
        // The confirming look is the one quick look, due once the item is a
        // second old; an item MA has since contradicted (a seek's transient)
        // waits the ordinary retry, like everything else.
        const first = this._seen.get(d.key);
        const since = first == null ? Infinity : now - first;
        const wait = (!this._confirmed.has(d.key) && since < WAVEFORM_CONFIRM_MS)
          ? Math.max(WAVEFORM_CONFIRM_MIN_MS, WAVEFORM_CONFIRM_MS - since + WAVEFORM_CONFIRM_MARGIN_MS)
          : WAVEFORM_RETRY_MS;
        this._scheduleWaveform(d, wait);
      }
      return;
    }
    if (held.stable === false && d.refreshes < WAVEFORM_MAX_REFRESHES) {
      d.refreshes++;
      const hint = Number(held.refreshInS) * 1000;
      const ms = Math.min(WAVEFORM_REFRESH_MAX_MS, Math.max(WAVEFORM_REFRESH_MIN_MS,
        Number.isFinite(hint) ? hint : WAVEFORM_REFRESH_MIN_MS));
      this._scheduleWaveform(d, ms);
    }
  }

  _storeWaveform(key, resp) {
    const n = this._nowCard;
    const a = n && n.attributes;
    const sensorDur = (a && a.queue_item_id === key && Number(a.duration)) || 0;
    const wf = {
      queueItemId: key,
      bins: new Float32Array(resp.bins),
      duration: Number(resp.duration_s) > 0 ? Number(resp.duration_s) : sensorDur,
      stable: resp.stable !== false,
      revision: resp.revision || 0,
      refreshInS: resp.refresh_in_s,
    };
    this._waveforms.delete(key);
    this._waveforms.set(key, wf);
    while (this._waveforms.size > WAVEFORMS_HELD) {
      this._waveforms.delete(this._waveforms.keys().next().value);
    }
    this._waveform = wf;
  }

  toggleWaveformDemo(enable) {
    this._waveformDemo = enable !== undefined ? !!enable : !this._waveformDemo;
    this._resetWaveformDemand();
    if (this._waveformDemo) {
      this._waveform = {
        queueItemId: WAVEFORM_DEMO_KEY,
        bins: demoWaveformBins(1800),
        duration: 6.0,
        stable: true,
      };
      this._waveforms.set(WAVEFORM_DEMO_KEY, this._waveform);
    } else {
      this._waveforms.delete(WAVEFORM_DEMO_KEY);
      this._waveform = null;
      this._maybeRefreshWaveform();
    }
    if (this._mouth) this._mouthStart();
  }

  /* --- the playback clock the waveform is read at -----------------------
   *
   * ONE AUTHORITY, ONE INTERPOLATION:
   *
   *   position = MA's position at the anchor
   *            + local monotonic time since the anchor, counted only while
   *              the audio is audible.
   *
   * The authority is MA, seen two ways: the now-playing sensor's sample
   * (queue_item_id, elapsed, elapsed_at, state) and the same four fields
   * on every waveform reply, each from one MA read. elapsed_at is when MA
   * measured elapsed. The NEWEST observation anchors the clock; a render,
   * the 1 s progress tick or a repeat of the same sample never does. The
   * old model re-based "pos" on the tick's already-advanced progress while
   * still adding the frame time since its first frame, so the mouth ran up
   * to 4.8 s ahead and snapped back at every render.
   *
   * "Audible" is the same test the Mouth uses to move at all (the player
   * first, the sensor if there is no player), so the two cannot disagree.
   * The player resumes while the sensor still reads "paused" for seconds:
   * the clock then runs from the paused position, where playback resumed,
   * instead of replaying the same slice at every render. A pause folds the
   * run into the anchor and stops.
   *
   * CONFIRMED BEFORE DRAWN. During a seek MA can call an old queue item
   * current for a few hundred milliseconds, the sensor can hold that for a
   * 10 s refresh cooldown, and a reply read in the same instant agrees with
   * it -- so a seek could draw another song's waveform for 10 s. So an item is
   * drawn only once two looks at MA at least WAVEFORM_CONFIRM_MS apart have
   * named it; the demand makes the second look. When that look names the
   * item that was playing all along, it is also the newest observation, so
   * the clock goes straight back to it at MA's position.
   *
   * No position -- no elapsed for the newest item -- means nothing is
   * drawn: the synthetic display stands in. Local time is performance.now();
   * the wall clock is read only to age a sample to "now" (CLOCK_MAX_AGE_S). */
  _perfNow() {
    return (typeof performance !== "undefined" && typeof performance.now === "function")
      ? performance.now() : Date.now();
  }

  _remember(coll, key, value) {
    if (coll instanceof Map) { coll.delete(key); coll.set(key, value); } else { coll.delete(key); coll.add(key); }
    while (coll.size > WAVEFORM_KEYS_REMEMBERED) coll.delete(coll.keys().next().value);
  }

  /* One observation of MA: { key, elapsed, at (MA's sample time, epoch s),
   * state }. Counts toward confirming its item, and anchors the clock if
   * it is the newest one seen. */
  _observe(obs, now) {
    if (!obs || !obs.key) return;
    const first = this._seen.get(obs.key);
    if (first == null) this._remember(this._seen, obs.key, now);
    else if (now - first >= WAVEFORM_CONFIRM_MS) this._remember(this._confirmed, obs.key);
    const at = obs.at != null && Number.isFinite(Number(obs.at)) ? Number(obs.at) : null;
    const c = this._clock;
    // Newest wins. An observation that cannot be ordered (no sample time)
    // still counts toward confirmation but never moves an existing clock;
    // a tie goes to a different item, never back to the same one.
    if (c && (at == null || (c.at != null
        && (at < c.at || (at === c.at && obs.key === c.key))))) return;
    const elapsed = obs.elapsed != null ? Number(obs.elapsed) : NaN;
    if (!Number.isFinite(elapsed)) {
      if (!c || c.key !== obs.key) this._clock = null;           // an item with no position
      return;
    }
    let pos = elapsed;
    if (obs.state === "playing" && at != null) {
      const age = Date.now() / 1000 - at;
      if (Number.isFinite(age)) pos += Math.min(CLOCK_MAX_AGE_S, Math.max(0, age));
    }
    const audible = this._mouthState().mode !== MOUTH_IDLE;
    this._clock = { key: obs.key, pos, at, runningSince: audible ? now : null };
  }

  _syncPlaybackClock() {
    const now = this._perfNow();
    const n = this._nowCard;
    const a = n && n.attributes;
    const key = (a && a.queue_item_id) || null;
    if (!key) { this._clock = null; this._sensorSig = null; return; }
    const sig = `${key}|${a.elapsed}|${a.elapsed_at}|${n.state}`;
    if (sig !== this._sensorSig) {
      this._sensorSig = sig;
      this._observe({ key, elapsed: a.elapsed, at: a.elapsed_at, state: n.state }, now);
    }
    const c = this._clock;
    if (!c) return;
    const audible = this._mouthState().mode !== MOUTH_IDLE;
    if (audible && c.runningSince == null) {
      c.runningSince = now;
    } else if (!audible && c.runningSince != null) {
      c.pos += (now - c.runningSince) / 1000;
      c.runningSince = null;
    }
  }

  _clockPosition(now) {
    const c = this._clock;
    if (!c) return null;
    return c.pos + (c.runningSince != null ? Math.max(0, now - c.runningSince) / 1000 : 0);
  }

  /* The waveform to draw now: the clock's item's, once confirmed. */
  _drawnWaveform() {
    if (this._waveformDemo) return this._waveforms.get(WAVEFORM_DEMO_KEY) || null;
    const c = this._clock;
    if (!c || !this._confirmed.has(c.key)) return null;
    return this._waveforms.get(c.key) || null;
  }

  /* Where in "wf" the audio is now, or null when that is not known for
   * THIS waveform's item. */
  _waveformPosition(wf, now) {
    if (wf.queueItemId === WAVEFORM_DEMO_KEY) {
      return wf.duration > 0 ? (now / 1000) % wf.duration : null;
    }
    const c = this._clock;
    if (!c || c.key !== wf.queueItemId || !this._confirmed.has(c.key)) return null;
    return this._clockPosition(now);
  }

  /* A preview is audio for THIS browser: synthesized by the backend and
   * played here. It never reaches Music Assistant, a queue, a break or an
   * announcement. `text` is the owner's own line (the Booth's preview
   * box); without one the backend speaks its fixed phrase. */
  async _previewVoice(voiceId, tune, text) {
    if (this._previewing) return;
    this._previewing = voiceId; this._render();
    try {
      const args = { voice_id: voiceId };
      if (tune) { args.speed = tune.speed; args.pause = tune.pause; }
      const line = String(text === undefined ? (this._previewText || "") : (text || "")).trim();
      if (line) args.text = line;
      const out = await this._ws("parlorwave_radio/voice_preview", args);
      const bytes = Uint8Array.from(atob(out.audio_b64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: out.content_type || "audio/wav" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.addEventListener("ended", () => URL.revokeObjectURL(url));
      await audio.play();
    } catch (e) {
      this._setNotice(false, "Preview failed: " + ((e && e.message) || e));
    }
    this._previewing = null; this._render();
  }

  /* --- Create a Voice ---------------------------------------------------
   * The recording is POSTED, as bytes, to this integration's own
   * authenticated Home Assistant view. It does not ride a service call:
   * base64 inflates a clip by a third and pushes it through the websocket
   * connection that also carries every state update in the house.
   *
   * The credential here is the one this browser session already has for
   * Home Assistant. The backend's address and its API key stay on the
   * Home Assistant side -- this script cannot name either.
   *
   * ENROLLMENT: Record (or choose a file) ->
   * listen back -> the owner's acknowledgement -> a name -> what the voice
   * is for -> Create voice -> hear it. The same form, with the name kept,
   * REPLACES a voice's recording (`mode: "replace"`).
   */
  async _authHeaders() {
    // The websocket that keeps this page alive signed in once; a plain fetch
    // is signed with the CURRENT access token, which lives 30 minutes. A
    // Replace sent with a stale one is answered 401 by Home Assistant before
    // the upload view ever runs, and all the Booth could say is "could not
    // be used". Refresh first, as hass.fetchWithAuth does;
    // after a 401 anyway, _authRetry forces one more (a clock that disagrees).
    const auth = this._hass && this._hass.auth;
    const force = !!this._authStale;
    this._authStale = false;
    if (auth && typeof auth.refreshAccessToken === "function" && (force || auth.expired)) {
      try { await auth.refreshAccessToken(); } catch (e) { /* the answer says what happened */ }
    }
    const token = auth && auth.data && auth.data.access_token;
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  /* After a 401: true when a fresh token can be asked for, and the next
   * _authHeaders will ask. One retry per request, never a loop. */
  _authRetry() {
    const auth = this._hass && this._hass.auth;
    if (!auth || typeof auth.refreshAccessToken !== "function") return false;
    this._authStale = true;
    return true;
  }

  _newDraft(extra) {
    return Object.assign({
      mode: "create", target: null, name: "", note: "", scope: null,
      makeDefault: false, authorized: false,
      rec: { state: "idle", error: null }, take: null,
      busy: false, error: null, done: null,
    }, extra || {});
  }

  _openCreate() {
    this._releaseMic();
    this._create = this._newDraft();
    this._render();
    this._listMicrophones();
  }

  /* Replace a custom voice's recording: the same form, the name kept, the
   * acknowledgement asked again (it is a new recording), what the voice is
   * for shown as it is now and changeable. */
  _openReplace(voiceId) {
    const lib = this._voiceLib || {};
    const v = (lib.customs || []).find((c) => c.voice_id === voiceId);
    if (!v) return;
    this._releaseMic();
    this._create = this._newDraft({ mode: "replace", target: voiceId,
                                    name: v.name, scope: v.scope || "dj" });
    this._confirmDelete = null;
    // The form opens below the whole library, so a press on a row
    // near the top seemed to do nothing. Focus goes to its first control,
    // which brings the form into view the way every other moved focus
    // does -- nothing here scrolls Home Assistant's own page directly.
    this._focusNext = { id: "rec-start" };
    this._render();
    this._listMicrophones();
  }

  _closeCreate() {
    this._releaseMic();
    this._discardTake();
    this._stopAudition();
    const a = this._create && this._create.audition;
    if (a && a.url) URL.revokeObjectURL(a.url);
    this._create = null;
    this._render();
  }

  /* The consent sentence and its version, as the backend published them.
   * Without them there is nothing to acknowledge, and nothing is created. */
  _consent() {
    const cloning = (this._voiceLib && this._voiceLib.cloning) || {};
    const c = cloning.consent || {};
    return c.text && c.version ? c : null;
  }

  _canSubmit(c) {
    if (!c || c.busy || !c.take || c.take.block || !c.take.used || c.take.checking
        || !c.authorized || !this._consent()) return false;
    if (c.mode === "create" && !c.name.trim()) return false;
    return !!c.scope;
  }

  /* --- the microphone ---------------------------------------------------- */
  async _recordStart() {
    const c = this._create;
    if (!c || c.busy || this._mic || c.rec.state === "requesting") return;
    this._discardTake();
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : null;
    if ((typeof window !== "undefined" && window.isSecureContext === false)
        || !md || typeof md.getUserMedia !== "function") {
      c.rec = { state: "error", error: MIC_NEEDS_SECURE };
      this._render(); return;
    }
    if (typeof MediaRecorder === "undefined") {
      c.rec = { state: "error", error: MIC_UNSUPPORTED };
      this._render(); return;
    }
    c.rec = { state: "requesting", error: null };
    this._render();
    let stream;
    const chosen = BOOTH_SESSION.micDeviceId;
    const ask = (id) => md.getUserMedia({ audio: id ? { channelCount: 1, deviceId: { exact: id } }
                                                      : { channelCount: 1 } });
    try {
      // The browser asks the person here, in its own words.
      try { stream = await ask(chosen); }
      catch (e) {
        // The microphone chosen earlier is gone (unplugged, renamed): forget
        // it and take the browser's own choice, once.
        const name = (e && e.name) || "";
        if (!chosen || (name !== "OverconstrainedError" && name !== "NotFoundError")) throw e;
        BOOTH_SESSION.micDeviceId = "";
        stream = await ask("");
      }
    } catch (e) {
      if (this._create === c) { c.rec = { state: "error", error: micRefusal(e) }; this._render(); }
      return;
    }
    const stopTracks = () => { try { stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* gone */ } };
    // The form may have closed, or the Booth been left, while the browser
    // was asking. Nothing records for a form nobody is looking at.
    if (this._create !== c || this._view !== "booth" || !this._voicesOpen) { stopTracks(); return; }
    // Allowing the microphone says nothing about WHICH microphone, or that
    // sound arrives through it: Edge and Chrome on a Windows desktop can
    // record silence with permission granted. So the
    // Booth names the device the browser opened, meters it while recording,
    // and offers the others (labels exist once permission is given).
    const track = (typeof stream.getAudioTracks === "function" ? stream.getAudioTracks()
      : stream.getTracks())[0] || null;
    const settings = (track && typeof track.getSettings === "function" && track.getSettings()) || {};
    const input = { label: (track && track.label) || "", rate: Number(settings.sampleRate) || 0,
                    muted: !!(track && track.muted) };
    this._listMicrophones();
    const mime = recorderMimeType((t) => MediaRecorder.isTypeSupported(t));
    let rec;
    try { rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
    catch (e) { stopTracks(); c.rec = { state: "error", error: MIC_UNSUPPORTED }; this._render(); return; }
    const chunks = [];
    rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
    rec.onstop = () => this._recordFinished(c, chunks, rec.mimeType || mime);
    const cloning = (this._voiceLib && this._voiceLib.cloning) || {};
    const maxS = Number(cloning.max_seconds) || 45;
    const minS = Number(cloning.min_seconds) || 8;
    this._mic = { stream, rec, startedAt: Date.now(), maxS, minS, stopTracks, input,
                  meter: this._openMeter(stream), levelPct: 0,
                  warn: input.muted ? liveSilenceWords(input) : "",
                  tick: setInterval(() => this._recordTick(), 250),
                  cap: setTimeout(() => this._recordStop(), maxS * 1000) };
    try { rec.start(250); }
    catch (e) { this._releaseMic(); c.rec = { state: "error", error: MIC_UNSUPPORTED }; this._render(); return; }
    c.rec = { state: "recording", error: null };
    this._render();
  }

  /* The clock beside "Microphone on", updated in place: a whole render
   * four times a second would rebuild the form under the owner's hands. */
  _recordTick() {
    const m = this._mic;
    if (!m) return;
    const secs = (Date.now() - m.startedAt) / 1000;
    const el = this.shadowRoot && this.shadowRoot.getElementById("rec-clock");
    if (el) el.textContent = clockOf(secs);
    const guide = this.shadowRoot && this.shadowRoot.getElementById("rec-guide");
    if (guide) guide.textContent = recordGuide(secs, m.minS, RECORD_GOOD_SECONDS);
    // The meter and the "no sound" line, in place like the clock. Their
    // values live on the microphone, so a render in between draws them too.
    const mt = m.meter;
    if (!mt || typeof mt.an.getFloatTimeDomainData !== "function") return;
    mt.an.getFloatTimeDomainData(mt.frame);
    const db = frameLevelDb(mt.frame);
    if (db > mt.loudestDb) mt.loudestDb = db;
    m.levelPct = meterPercent(db);
    if (secs >= LIVE_SILENCE_AFTER_S) {
      m.warn = mt.loudestDb > LIVE_SILENCE_DB && !m.input.muted ? "" : liveSilenceWords(m.input);
    }
    const bar = this.shadowRoot && this.shadowRoot.getElementById("rec-level");
    if (bar) bar.style.width = `${m.levelPct}%`;
    const warn = this.shadowRoot && this.shadowRoot.getElementById("rec-warn");
    if (warn && warn.textContent !== m.warn) warn.textContent = m.warn;
  }

  /* A level meter on the live stream: an analyser and nothing else, never
   * connected to the speakers. Optional -- a browser without Web Audio
   * records all the same, it just cannot say how loud. */
  _openMeter(stream) {
    try {
      const Ctx = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
      if (!Ctx) return null;
      const ctx = new Ctx();
      if (typeof ctx.createMediaStreamSource !== "function" || typeof ctx.createAnalyser !== "function") {
        try { ctx.close(); } catch (e) { /* closed */ }
        return null;
      }
      if (ctx.state === "suspended" && typeof ctx.resume === "function") ctx.resume().catch(() => {});
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      ctx.createMediaStreamSource(stream).connect(an);
      return { ctx, an, frame: new Float32Array(an.fftSize), loudestDb: -Infinity };
    } catch (e) {
      return null;
    }
  }

  /* The microphones this browser offers, for the chooser under Record. Only
   * named ones: before permission is given a browser lists none by name,
   * and the chooser stays away until it can say what each one is. */
  async _listMicrophones() {
    try {
      const md = typeof navigator !== "undefined" ? navigator.mediaDevices : null;
      if (!md || typeof md.enumerateDevices !== "function") return;
      const all = await md.enumerateDevices();
      const mics = (all || []).filter((d) => d && d.kind === "audioinput" && d.deviceId && d.label)
        .map((d) => ({ id: d.deviceId, label: d.label }));
      const before = JSON.stringify(this._micDevices || []);
      this._micDevices = mics;
      if (JSON.stringify(mics) !== before) this._render();
    } catch (e) { /* the chooser is a help, never a requirement */ }
  }

  /* The microphone belongs to the Create form in the open Booth library.
   * Anything that took the person away from it -- another screen, the
   * library closed, the form gone -- closes the microphone. Run at the top
   * of every render, before anything can defer it. */
  _micGuard() {
    if (this._mic && (this._view !== "booth" || !this._voicesOpen || !this._create)) {
      this._releaseMic();
    }
  }

  /* Stop and KEEP what was recorded (Stop, the cap, a hidden page). */
  _recordStop() {
    const m = this._mic;
    if (!m) return;
    const c = this._create;
    this._releaseMic(true);
    if (c && c.rec.state === "recording") { c.rec = { state: "processing", error: null }; this._render(); }
  }

  /* Close the microphone. `keep` lets the recorder deliver what it has;
   * otherwise the take is thrown away unheard. Safe to call at any time. */
  _releaseMic(keep) {
    const m = this._mic;
    if (!m) return;
    this._mic = null;
    clearInterval(m.tick); clearTimeout(m.cap);
    if (!keep) { m.rec.ondataavailable = null; m.rec.onstop = null; }
    try { if (m.rec.state !== "inactive") m.rec.stop(); } catch (e) { /* already stopped */ }
    m.stopTracks();
    if (m.meter) { try { m.meter.ctx.close(); } catch (e) { /* closed */ } }
    const c = this._create;
    if (keep && c) c.recInput = m.input || null;
    if (!keep && c && c.rec.state === "recording") c.rec = { state: "idle", error: null };
  }

  /* What the browser recorded -> a WAV at the engine's rate, measured. */
  async _recordFinished(c, chunks, mime) {
    if (this._create !== c) return;
    try {
      const blob = new Blob(chunks, { type: mime || "audio/webm" });
      if (!blob.size) throw new Error("empty");
      const decoded = await this._decodeAudio(await blob.arrayBuffer());
      const chans = [];
      for (let i = 0; i < decoded.numberOfChannels; i++) chans.push(decoded.getChannelData(i));
      const mono = downmixToMono(chans);
      const measure = measureTake(mono, decoded.sampleRate);
      const cloning = (this._voiceLib && this._voiceLib.cloning) || {};
      const problem = takeProblem(measure, Number(cloning.min_seconds) || 8,
                                  Number(cloning.max_seconds) || 45);
      if (this._create !== c) return;
      const input = c.recInput || {};
      c.take = { blob: new Blob([encodeWav16(mono, decoded.sampleRate)], { type: "audio/wav" }),
                 source: "recording", seconds: measure.seconds, fileName: "",
                 problem, block: !!(problem && problem.block),
                 diag: takeDiagnosis({ label: input.label, rate: input.rate, mime: blob.type || mime,
                                       peakDb: measure.peakDb, voicedSeconds: measure.voicedSeconds,
                                       muted: input.muted }) };
      c.rec = { state: "ready", error: null };
    } catch (e) {
      if (this._create !== c) return;
      c.take = null;
      c.rec = { state: "error", error: "That recording could not be read back. Record again, or choose a recording file instead." };
    }
    c.error = null;
    this._render();
  }

  /* Decode in the browser, resampled to the engine's rate where the
   * browser allows it: an AudioContext decodes AT its own sample rate, so
   * one made at 24 kHz hands back 24 kHz. One that refuses the rate falls
   * back to the browser's own, and the WAV simply carries that rate. */
  async _decodeAudio(buf) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    let ctx;
    try { ctx = new Ctx({ sampleRate: RECORD_SAMPLE_RATE }); }
    catch (e) { ctx = new Ctx(); }
    try { return await ctx.decodeAudioData(buf.slice(0)); }
    finally { try { ctx.close(); } catch (e) { /* closed */ } }
  }

  /* Listen back to the take (recorded or chosen) before anything is sent.
   * The player lives in state, not in the page, so a render mid-playback
   * does not cut it off. */
  _playTake() {
    const c = this._create;
    if (!c || !c.take) return;
    if (this._takeAudio) { this._stopTake(); this._render(); return; }
    if (!c.take.url) c.take.url = URL.createObjectURL(c.take.blob);
    const a = new Audio(c.take.url);
    this._takeAudio = a;
    a.addEventListener("ended", () => { if (this._takeAudio === a) { this._takeAudio = null; this._render(); } });
    a.play().catch(() => { if (this._takeAudio === a) { this._takeAudio = null; this._render(); } });
    this._render();
  }

  _stopTake() {
    const a = this._takeAudio;
    this._takeAudio = null;
    if (a) { try { a.pause(); } catch (e) { /* gone */ } }
  }

  _discardTake() {
    this._stopTake();
    const c = this._create;
    if (!c) return;
    if (c.take && c.take.url) URL.revokeObjectURL(c.take.url);
    c.take = null;
    if (c.rec.state !== "recording" && c.rec.state !== "requesting") c.rec = { state: "idle", error: null };
  }

  _chooseFile(file) {
    const c = this._create;
    if (!c) return;
    this._releaseMic();
    this._discardTake();
    if (!file) { this._render(); return; }
    const tooBig = file.size > MAX_SAMPLE_MB * 1024 * 1024;
    c.take = { blob: file, source: "file", seconds: null, fileName: file.name,
               problem: tooBig ? { block: true, code: "too_large",
                 message: `That file is larger than ${MAX_SAMPLE_MB} MB. A short MP3 or FLAC clip is well under it.` } : null,
               block: tooBig, checking: !tooBig, used: false };
    c.error = null;
    this._render();
    if (!tooBig) this._checkFile(c, c.take);
  }

  /* A chosen file is looked at HERE before anything is sent: what it is
   * (its first bytes, the backend's rule), then -- where this browser can
   * decode it -- its length and whether there is a voice in it, by the
   * measure a recording gets. A file this browser cannot decode is not
   * refused for that: the backend measures again and has the final word.
   * The file is sent as chosen, never re-encoded. */
  async _checkFile(c, take) {
    let problem = null, seconds = null;
    try {
      const buf = await take.blob.arrayBuffer();
      const kind = sniffAudio(new Uint8Array(buf.slice(0, 16)));
      problem = fileProblem(kind, null);
      if (!problem) {
        const cloning = (this._voiceLib && this._voiceLib.cloning) || {};
        try {
          const decoded = await this._decodeAudio(buf);
          const chans = [];
          for (let i = 0; i < decoded.numberOfChannels; i++) chans.push(decoded.getChannelData(i));
          const measure = measureTake(downmixToMono(chans), decoded.sampleRate);
          seconds = measure.seconds;
          problem = fileProblem(kind, measure, Number(cloning.min_seconds) || 8,
                                Number(cloning.max_seconds) || 45);
        } catch (e) {
          problem = { block: false, code: "unchecked",
                      message: "This browser could not measure that file. The voice engine checks it when the voice is made." };
        }
      }
    } catch (e) {
      problem = { block: true, code: "unreadable",
                  message: "That file could not be read. Choose it again, or record here instead." };
    }
    if (this._create !== c || c.take !== take) return;
    take.checking = false;
    take.seconds = seconds;
    take.problem = problem;
    take.block = !!(problem && problem.block);
    this._render();
  }

  /* "Use this recording": the owner has listened (or chosen not to) and
   * moves on. Only now does the form ask for permission, a name and a use
   * -- recording comes first, and nothing below it is in the way. */
  _useTake() {
    const c = this._create;
    if (!c || c.busy || !c.take || c.take.block || c.take.checking) return;
    this._stopTake();
    c.take.used = true;
    this._render();
  }

  async _submitCreate() {
    const c = this._create;
    if (!this._canSubmit(c)) return;
    const consent = this._consent();
    this._stopTake();
    c.busy = true; c.error = null; this._render();
    let out = {};
    try {
      const params = { authorized: "true", consent_version: consent.version,
                       scope: c.scope, source: c.take.source };
      if (c.mode === "replace") params.replace = c.target;
      else Object.assign(params, { name: c.name.trim(), note: c.note.trim(),
                                   announcement_default: c.makeDefault ? "true" : "false" });
      const query = new URLSearchParams(params);
      const send = async () => fetch(`${VOICE_SAMPLE_PATH}?${query.toString()}`, {
        method: "POST", headers: await this._authHeaders(), body: c.take.blob });
      let resp = await send();
      if (resp.status === 401 && this._authRetry()) resp = await send();
      out = await resp.json().catch(() => ({}));
      if (!resp.ok || out.ok === false) {
        // The view, the service and the engine behind both write their
        // refusals for a person; Home Assistant's own sign-in check, or
        // anything between, does not -- say which (uploadRefusal).
        c.busy = false;
        c.error = uploadRefusal(resp.status, out);
        this._render(); return;
      }
    } catch (e) {
      c.busy = false;
      c.error = "The recording did not reach Home Assistant. Check the connection and try again.";
      this._render(); return;
    }
    c.busy = false; c.done = out;
    this._discardTake();
    await this._fetchVoiceLib();
    // Hearing the cloned voice IS the last step of creating: the owner
    // hears it before deciding to put it on the air, and "Use this voice"
    // is offered only once it has spoken (_audition).
    this._audition(c, out.voice_id);
  }

  /* "Use this voice" goes through the same entity write the library's
   * radio uses. The shelf behind that entity was refreshed by the upload
   * view, but the entity's own options reach this browser on Home
   * Assistant's next state push -- so a write that arrives a beat early is
   * retried once rather than reported as a failure. */
  async _useVoice(name) {
    const listed = () => {
      const e = this._voice;
      return !!(e && (e.attributes.options || []).includes(name));
    };
    if (!listed()) await new Promise((r) => setTimeout(r, 1200));
    if (!listed()) {
      this._setNotice(false, "Almost there — pick it from My Voices below.");
      this._render(); return;
    }
    const c = this._create;
    const ok = await this._select(this._voice, name);
    await this._fetchVoiceLib();
    if (!ok) {
      // the refusal (it could not speak) stays on the form it came from;
      // the voice is saved and the DJ is unchanged
      if (c && this._create === c) {
        c.useError = (this._notice && this._notice.text) || "That voice could not be made the DJ.";
      }
      this._render(); return;
    }
    this._stopAudition();
    if (c && c.audition && c.audition.url) URL.revokeObjectURL(c.audition.url);
    this._create = null;
    this._setNotice(true, `${name} is now your DJ. The next DJ break uses this voice.`);
    this._render();
  }

  /* The cloned voice says a line -- the backend's fixed one, or the
   * owner's -- through the same preview call the library uses. The audio
   * is KEPT, so "Hear it again" replays it without asking the engine
   * again, and a browser that will not play unprompted simply leaves the
   * button. A voice that could not speak says why, and is not offered as
   * the DJ. */
  async _audition(c, voiceId, text) {
    if (!c || !c.done || (c.audition && c.audition.state === "speaking")) return;
    this._stopAudition();
    if (c.audition && c.audition.url) URL.revokeObjectURL(c.audition.url);
    c.audition = { state: "speaking", url: null, error: null };
    this._render();
    try {
      const args = { voice_id: voiceId };
      const line = String(text || "").trim();
      if (line) args.text = line;
      const out = await this._ws("parlorwave_radio/voice_preview", args);
      const bytes = Uint8Array.from(atob(out.audio_b64 || ""), (ch) => ch.charCodeAt(0));
      if (!bytes.length) throw new Error("The voice engine returned no audio.");
      const url = URL.createObjectURL(new Blob([bytes], { type: out.content_type || "audio/wav" }));
      if (this._create !== c) { URL.revokeObjectURL(url); return; }
      c.audition = { state: "ready", url, error: null, bytes: bytes.length };
    } catch (e) {
      if (this._create !== c) return;
      c.audition = { state: "error", url: null,
                     error: (e && e.message) || "The voice could not speak just now." };
    }
    this._render();
    if (c.audition.state === "ready") this._playAudition();
  }

  _playAudition() {
    const a = this._create && this._create.audition;
    if (!a || a.state !== "ready" || !a.url) return;
    if (this._auditionAudio) { this._stopAudition(); this._render(); return; }
    const el = new Audio(a.url);
    this._auditionAudio = el;
    el.addEventListener("ended", () => { if (this._auditionAudio === el) { this._auditionAudio = null; this._render(); } });
    el.play().catch(() => { if (this._auditionAudio === el) { this._auditionAudio = null; this._render(); } });
    this._render();
  }

  _stopAudition() {
    const el = this._auditionAudio;
    this._auditionAudio = null;
    if (el) { try { el.pause(); } catch (e) { /* gone */ } }
  }

  /* What a voice is allowed for, and which allowed voice reads an
   * announcement that names none. Two separate settings, two separate
   * writes: choosing the default grants nothing. */
  async _setVoiceScope(voiceId, scope) {
    try {
      await this._ws("parlorwave_radio/voice_scope", { voice_id: voiceId, scope });
    } catch (e) {
      this._setNotice(false, (e && e.message) || "That change was not saved.");
    }
    await this._fetchVoiceLib();
  }

  /* Automatic DJ shifts: on/off, or one shift's voice. The backend
   * validates (DJ-allowed voices only) and, when shifts come on or the
   * current shift's voice changes, settles the current shift through the
   * ordinary selection. Nothing is spoken. */
  async _setShifts(patch) {
    if (this._shiftsBusy) return;
    this._shiftsBusy = true;
    this._render();
    try {
      await this._ws("parlorwave_radio/voice_shifts", patch);
    } catch (e) {
      this._setNotice(false, (e && e.message) || "That change was not saved.");
    }
    this._shiftsBusy = false;
    await this._fetchVoiceLib();
  }

  async _setAnnouncementVoice(voiceId) {
    try {
      await this._ws("parlorwave_radio/voice_announcement_default", { voice_id: voiceId || "" });
    } catch (e) {
      this._setNotice(false, (e && e.message) || "That change was not saved.");
    }
    await this._fetchVoiceLib();
    if (this._announcements) this._fetchAnnouncements(true);
  }

  // --- actions -----------------------------------------------------------
  async _svc(domain, service, data, busyKey, okText) {
    this._busy = busyKey;
    const isInteractive = domain === "media_player" || domain === "switch" || service === "select_option" || okText === false;
    if (!isInteractive) this._clearNotice();
    this._render();
    let ok = true;
    try {
      await this._hass.callService(domain, service, data || {});
      if (okText) {
        this._setNotice(true, okText);
      } else if (!isInteractive) {
        this._setNotice(true, "Done.");
      }
    } catch (err) {
      ok = false;
      this._refuse("", err);
    }
    this._busy = null; this._render();
    return ok;
  }

  _toggle(entity) {
    if (!entity) return;
    const want = entity.state === "on" ? "off" : "on";
    if (this._dj && entity.entity_id === this._dj.entity_id) {
      // THE DJ SWITCH WAITS FOR ITS ECHO. The service call returns long
      // before the entity reports the new state (the coordinator's next
      // read), and a knob that shows its OLD state for those seconds reads
      // as a push that did nothing -- the next push undoes it. So the hold
      // keeps the switch pending until the entity says `want`, or
      // DJ_HOLD_MS pass, and a second push during the hold is refused.
      if (this._djHoldActive()) return;
      this._djHold = { want, from: entity.state, until: Date.now() + DJ_HOLD_MS };
      this._svc("switch", want === "on" ? "turn_on" : "turn_off",
        { entity_id: entity.entity_id }, entity.entity_id).then((ok) => {
          if (!ok) this._djHold = null;
          this._render();
        });
      return;
    }
    this._svc("switch", want === "on" ? "turn_on" : "turn_off",
      { entity_id: entity.entity_id }, entity.entity_id);
  }

  /* Is a DJ switch write still waiting for the entity to agree? Settles
   * the hold on the echo; past DJ_HOLD_MS it gives up and says so once. */
  _djHoldActive() {
    const h = this._djHold;
    if (!h) return false;
    const dj = this._dj;
    if (dj && dj.state === h.want) { this._djHold = null; return false; }
    if (Date.now() >= h.until) {
      this._djHold = null;
      const reads = dj && dj.state === "on" ? "DJ ON" : "DJ OFF";
      this._setNotice(false, `The DJ switch did not confirm within ${Math.round(DJ_HOLD_MS / 1000)} seconds. `
        + `It still reads ${reads}. Try again in a moment.`);
      return false;
    }
    return true;
  }

  _select(entity, option) {
    if (!entity || !option) return Promise.resolve();
    return this._svc("select", "select_option",
      { entity_id: entity.entity_id, option }, entity.entity_id);
  }

  /* --- Console Fabric Faceplates -----------------------------------------
   * Swappable acoustic fabric grille cloth matching the physical radio hardware.
   * Persisted in localStorage and selectable via double-click or Settings. */
  _setFaceplate(id) {
    const found = FACEPLATES.find((f) => f.id === id);
    if (!found) return;
    this._faceplate = found.id;
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("parlorwave_faceplate", found.id);
      }
    } catch (_) {}
    this._render();
  }

  _cycleFaceplate() {
    const current = this._faceplate || "midnight";
    const currentIdx = FACEPLATES.findIndex((f) => f.id === current);
    const nextIdx = ((currentIdx >= 0 ? currentIdx : 0) + 1) % FACEPLATES.length;
    this._setFaceplate(FACEPLATES[nextIdx].id);
  }

  /* --- Center Script Logo Mode Cycling -----------------------------------
   * Cycles: "logo" (ParlorWave) -> "station" (configured station name) -> "hidden"
   * upon double-clicking the centered vintage radio badge. Persisted in localStorage. */
  _cycleCenterLogo() {
    const current = this._centerLogoMode || "logo";
    let next = "logo";
    if (current === "logo") next = "station";
    else if (current === "station") next = "hidden";
    else next = "logo";
    this._setCenterLogoMode(next);
  }

  _setCenterLogoMode(mode) {
    if (!["logo", "station", "hidden"].includes(mode)) mode = "logo";
    this._centerLogoMode = mode;
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("parlorwave_logo_mode", mode);
      }
    } catch (_) {}
    this._render();
  }

  /* --- Visualizer Mode Cycling -------------------------------------------
   * Switches between the 4 display modes (waves, eq, robot, dial) upon
   * double-clicking the center mouth LCD. Persisted in localStorage. */
  _cycleMouthMode() {
    const current = this._mouthVisual || "waves";
    const idx = MOUTH_VISUALS.indexOf(current);
    const next = MOUTH_VISUALS[((idx >= 0 ? idx : 0) + 1) % MOUTH_VISUALS.length];
    this._setMouthMode(next);
  }

  _setMouthMode(mode) {
    if (!MOUTH_VISUALS.includes(mode)) mode = "waves";
    this._mouthVisual = mode;
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("parlorwave_mouth_visual", mode);
      }
    } catch (_) {}

    const label = MOUTH_VISUAL_LABELS[mode] || mode;
    this._mouthModeToast = label;
    if (this._mouthToastTimer) clearTimeout(this._mouthToastTimer);
    this._mouthToastTimer = setTimeout(() => {
      this._mouthModeToast = null;
      const toastEl = this.shadowRoot && this.shadowRoot.querySelector(".mouth-toast");
      if (toastEl) toastEl.remove();
    }, MOUTH_TOAST_MS);

    const mouthEl = this.shadowRoot && this.shadowRoot.querySelector(".mouth");
    if (mouthEl) {
      MOUTH_VISUALS.forEach((v) => mouthEl.classList.remove(`mouth-vis-${v}`));
      mouthEl.classList.add(`mouth-vis-${mode}`);
      let toastEl = mouthEl.querySelector(".mouth-toast");
      if (!toastEl) {
        toastEl = document.createElement("div");
        toastEl.className = "mouth-toast";
        toastEl.setAttribute("aria-hidden", "true");
        mouthEl.appendChild(toastEl);
      }
      toastEl.textContent = label;
    }

    if (this._mouth) {
      this._mouthDraw(this._mouth.tSec || 0);
    }
  }

  /* --- Rotary Knob Ring Indicator Pulse -----------------------------------
   * Shows a prominent position indicator on the perimeter LED ring while
   * turning, then smoothly fades back into the solid LED ring color. */
  /* THE LCD'S TRANSIENT LINE. One line under the header, over
   * the display: the volume readout while the left knob moves, and the
   * once-a-session hint. Drawn from state on every render, and updated in
   * place between renders so a drag never rebuilds the page. */
  _showWhisper(text, kind, ms, onShown) {
    this._whisper = { text: String(text), kind: kind || "", until: Date.now() + ms };
    if (this._whisperTimer) clearTimeout(this._whisperTimer);
    this._whisperTimer = setTimeout(() => {
      this._whisperTimer = null;
      this._whisper = null;
      const el = this.shadowRoot && this.shadowRoot.querySelector(".lcd-whisper");
      if (el && el.classList) el.classList.remove("visible");
      if (onShown) onShown();      // it stayed up for its whole time
    }, ms);
    const el = this.shadowRoot && this.shadowRoot.querySelector(".lcd-whisper");
    if (el && el.classList) {
      el.classList.add("visible");
      const t = el.querySelector && el.querySelector(".lcd-whisper-text");
      if (t) t.textContent = this._whisper.text;
    }
  }

  /* The first press or keyboard focus of each knob in a browser session
   * says, once, what the knob does. No permanent instruction anywhere. */
  _knobHint(which) {
    if (this._hinted[which]) return;
    if (this._whisper && this._whisper.kind === "hint") return;   // one is on the LCD now
    const key = `parlorwave_knob_hint_${which}`;
    try {
      if (typeof sessionStorage !== "undefined" && sessionStorage.getItem(key)) {
        this._hinted[which] = true;
        return;
      }
    } catch (_) { /* no storage: the instance flag still holds, once shown */ }
    const text = which === "left" ? "TURN FOR VOLUME \u00b7 PUSH TWICE FOR DJ"
      : "TURN FOR STATIONS \u00b7 PUSH TWICE FOR SPEAKERS";
    // COUNTED ONLY ONCE IT HAS BEEN READ. A hint the first dragged pixel
    // painted over with "VOLUME 52%", or a selector's overlay hid, was
    // never seen; it comes back on the next press instead of never again.
    this._showWhisper(text, "hint", KNOB_HINT_MS, () => {
      this._hinted[which] = true;
      try {
        if (typeof sessionStorage !== "undefined") sessionStorage.setItem(key, "1");
      } catch (_) { /* no storage: once per panel */ }
    });
  }

  /* A knob hint still on the LCD when a selector opens over it is taken
   * down uncounted, so it is offered again later. */
  _cancelHint() {
    if (!(this._whisper && this._whisper.kind === "hint")) return;
    if (this._whisperTimer) clearTimeout(this._whisperTimer);
    this._whisperTimer = null;
    this._whisper = null;
    const el = this.shadowRoot && this.shadowRoot.querySelector(".lcd-whisper");
    if (el && el.classList) el.classList.remove("visible");
  }

  /* Paint a left-knob level everywhere it is drawn -- the knob face, the
   * slider and its percentage -- and say it on the LCD. Writes nothing. */
  _paintVolume(level) {
    const deg = Math.round(KNOB_ANGLE_MIN_DEG + level * KNOB_ANGLE_SWEEP_DEG);
    const face = this.shadowRoot && this.shadowRoot.querySelector("#dj-switch .dj-face");
    if (face) face.style.transform = `rotate(${deg}deg)`;
    const volRange = this.shadowRoot && this.shadowRoot.getElementById("vol-range");
    const volPct = this.shadowRoot && this.shadowRoot.querySelector(".vol-pct");
    const pct = Math.round(level * 100);
    if (volRange) volRange.value = pct;
    if (volPct) volPct.textContent = `${pct}%`;
    this._showWhisper(`VOLUME ${pct}%`, "volume", VOLUME_READOUT_MS);
  }

  /* A STEP of the left knob -- a wheel notch, a sticky-turn move, an arrow
   * key -- from the level last asked for (_holdVolume), held on the
   * knob until the player answers, written at most once per throttle. */
  _knobVolumeTo(level) {
    const next = Math.max(0, Math.min(1, level));
    this._holdVolume(next);
    this._throttledVolumeSet(next);
    this._paintVolume(next);
    this._pulseKnobIndicator("left");
    return next;
  }

  /* Arrows on a FOCUSED knob (the selectors own the keys while open). The
   * left knob steps volume like a wheel notch, Page Up / Page Down ten
   * times as far; the right knob steps as a turn does: the Dial. Enter and
   * Space stay the button's own: DJ power on the left, the speaker list on
   * the right. */
  _knobKey(e) {
    const t = e.composedPath ? e.composedPath()[0] : e.target;
    const id = t && t.id;
    if (id !== "dj-switch" && id !== "right-knob") return;
    const k = e.key;
    if (id === "dj-switch") {
      if (t.disabled) return;
      const step = (k === "ArrowUp" || k === "ArrowRight") ? KNOB_WHEEL_VOLUME_STEP
        : (k === "ArrowDown" || k === "ArrowLeft") ? -KNOB_WHEEL_VOLUME_STEP
        : k === "PageUp" ? KNOB_KEY_VOLUME_PAGE
        : k === "PageDown" ? -KNOB_KEY_VOLUME_PAGE : 0;
      if (!step) return;
      e.preventDefault();
      this._knobVolumeTo(this._volumeBase() + step);
      return;
    }
    if (k === "ArrowRight" || k === "ArrowDown" || k === "ArrowUp" || k === "ArrowLeft") {
      e.preventDefault();
      this._stationStep(k === "ArrowRight" || k === "ArrowDown" ? 1 : -1);
    }
  }

  _pulseKnobIndicator(side) {
    const sel = side === "left" ? "#dj-switch .knob-arc-segment" : "#right-knob .knob-arc-segment";
    const pip = this.shadowRoot && this.shadowRoot.querySelector(sel);
    const housing = this.shadowRoot && this.shadowRoot.querySelector(side === "left" ? ".left-knob-unit .knob-housing" : ".console-spk .knob-housing");
    if (housing) housing.classList.add("pip-active");
    if (!pip) return;
    pip.classList.add("active");
    if (!this._pipTimers) this._pipTimers = {};
    if (this._pipTimers[side]) {
      clearTimeout(this._pipTimers[side]);
    }
    this._pipTimers[side] = setTimeout(() => {
      if (pip) pip.classList.remove("active");
      if (housing) housing.classList.remove("pip-active");
      if (this._pipTimers) this._pipTimers[side] = null;
    }, KNOB_PULSE_MS);
  }

  /* --- Console Eye Expressions (Random Blinks & Speech Saccades) ---------
   * Brings the two console dial "eyes" to life with synchronous natural
   * eyelid blinks and attentive conversational gaze shifts while speaking. */
  _eyesEnabled() {
    if (!this._gentle()) return false;
    if (typeof localStorage === "undefined") return true;
    const val = localStorage.getItem("parlorwave_eye_expressions");
    return val !== "false";
  }

  _toggleEyes() {
    const next = !this._eyesEnabled();
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("parlorwave_eye_expressions", next ? "true" : "false");
    }
    this._render();
  }

  _startEyeLoop() {
    this._stopEyeLoop();
    this._scheduleNextBlink();
  }

  _stopEyeLoop() {
    if (this._blinkTimer) clearTimeout(this._blinkTimer);
    this._blinkTimer = null;
  }

  _scheduleNextBlink() {
    if (this._blinkTimer) clearTimeout(this._blinkTimer);
    this._blinkTimer = null;
    if (!this._eyesEnabled() || this._knobTurning || this._isDragging) {
      this._blinkTimer = setTimeout(() => this._scheduleNextBlink(), 3000);
      return;
    }
    // Relaxed, natural interval: every 14 to 28 seconds (~3x per minute)
    const delay = 14000 + Math.random() * 14000;
    this._blinkTimer = setTimeout(() => {
      this._triggerEyeBlink();
      this._scheduleNextBlink();
    }, delay);
  }

  _triggerEyeBlink() {
    if (!this.shadowRoot || !this._eyesEnabled() || this._knobTurning || this._isDragging) return;
    if (typeof document !== "undefined" && document.hidden) return;
    if (this._view && this._view !== "onair") return;
    const eyes = this.shadowRoot.querySelectorAll(".pw-knob-unit .knob-housing");
    if (!eyes || !eyes.length) return;
    eyes.forEach((el) => el.classList.add("eye-blinking"));
    const isDouble = Math.random() < 0.18;
    setTimeout(() => {
      eyes.forEach((el) => el.classList.remove("eye-blinking"));
      if (isDouble) {
        setTimeout(() => {
          eyes.forEach((el) => el.classList.add("eye-blinking"));
          setTimeout(() => {
            eyes.forEach((el) => el.classList.remove("eye-blinking"));
          }, 110);
        }, 80);
      }
    }, 120);
  }



  /* --- The OUTPUT selector: which speaker the house DJ follows -----------
   * By design: a compact list INSIDE
   * the LCD. The CURRENT speaker -- the select entity's own state, never a
   * guess -- is the top row, marked NOW; the CANDIDATE is the boxed row the
   * knob moves. Browsing changes nothing. The list opens ONLY by the right
   * knob's double push, or Enter/Space on it (turning is always the Dial).
   * ONE deliberate push (or Enter) while the list is open confirms the
   * candidate; the pushes that opened it, and a push that follows the last
   * of them closer than OUTPUT_OPEN_RUN_MS, are one run and do nothing.
   * Idle OUTPUT_TIMEOUT_MS after the last
   * deliberate interaction the list closes WITHOUT a change: a timeout never
   * switches anything. A confirm waits for Home Assistant's answer --
   * SWITCHED, or NOT SWITCHED with the reason -- and the LCD header goes on
   * showing the entity's real state either way. */
  _outputOptions() {
    const out = this._output;
    if (!out || !out.attributes || !Array.isArray(out.attributes.options)) return [];
    return out.attributes.options;
  }

  /* The select entity itself cannot take a choice right now. "unknown" is
   * not this: it is a working select with nothing chosen yet. */
  _outputEntityUnavailable() {
    return !this._output || this._output.state === "unavailable";
  }

  _outputBusy() {
    return !!(this._outputPending || this._outputResult);
  }

  /* `byPush`: the list is opened by a run of knob pushes, whose tail must
   * not confirm. A key opens it with no run behind it. */
  _enterOutputMode(byPush = false) {
    const opts = this._outputOptions();
    if (opts.length === 0) return;
    this._cancelHint();
    if (this._stationMode) {
      // The two selectors never share the display. An unanswered station
      // question is simply dropped; nothing was started.
      this._clearStationTimers();
      this._stationMode = false;
      this._stationArmed = false;
      this._stationResult = null;
    }
    this._outputMode = true;
    this._outputRunAt = byPush ? Date.now() : 0;
    this._outputPending = null;
    this._outputResult = null;
    const current = this._output ? this._output.state : null;
    const idx = opts.indexOf(current);
    this._outputIndex = idx >= 0 ? idx : 0;
    this._rightKnobAngle = opts.length > 1 ? Math.round((this._outputIndex / (opts.length - 1) - 0.5) * OUTPUT_SPREAD_DEG) : 0;
    this._lastOutputStepAngle = this._rightKnobAngle;
    this._mouthStop();
    this._resetOutputTimers();
    this._render();
  }

  /* Every deliberate interaction gives the list its full time again. */
  _resetOutputTimers() {
    this._clearOutputTimers();
    this._outputDeadline = Date.now() + OUTPUT_TIMEOUT_MS;
    this._outputCancelTimer = setTimeout(() => {
      this._outputCancelTimer = null;
      if (this._outputMode && !this._outputBusy()) this._cancelOutputMode();
    }, OUTPUT_TIMEOUT_MS);
    // The digits change in place: no render, nothing else on the page moves.
    this._outputTickTimer = setInterval(() => {
      const el = this.shadowRoot && this.shadowRoot.querySelector(".lcd-countdown-num");
      if (el) el.textContent = `${this._outputSecondsLeft()}s`;
    }, 250);
  }

  _outputSecondsLeft() {
    return Math.max(0, Math.ceil(((this._outputDeadline || 0) - Date.now()) / 1000));
  }

  _clearOutputTimers() {
    if (this._outputCancelTimer) clearTimeout(this._outputCancelTimer);
    if (this._outputConfirmTimer) clearTimeout(this._outputConfirmTimer);
    if (this._outputTickTimer) clearInterval(this._outputTickTimer);
    this._outputCancelTimer = null;
    this._outputConfirmTimer = null;
    this._outputTickTimer = null;
  }

  _stepOutput(dir) {
    if (!this._outputMode || this._outputBusy()) return;
    const opts = this._outputOptions();
    if (opts.length > 1) {
      this._outputIndex = (this._outputIndex + dir + opts.length) % opts.length;
      this._rightKnobAngle = (this._rightKnobAngle || 0) + dir * OUTPUT_STEP_DEG;
    }
    this._resetOutputTimers();
    this._render();
  }

  _nextOutput() { this._stepOutput(1); }

  _prevOutput() { this._stepOutput(-1); }

  /* A knob push inside the list. Part of the run that opened it -- closer
   * than OUTPUT_OPEN_RUN_MS to the previous push of that run -- it extends
   * the run and does nothing; after a pause it is its own gesture and
   * confirms. Keys confirm through _confirmOutput directly. */
  _outputPush() {
    const now = Date.now();
    if (this._outputRunAt && now - this._outputRunAt < OUTPUT_OPEN_RUN_MS) {
      this._outputRunAt = now;
      return;
    }
    this._outputRunAt = 0;
    this._confirmOutput();
  }

  async _confirmOutput() {
    if (!this._outputMode || this._outputBusy()) return;
    const opts = this._outputOptions();
    const candidate = opts[Math.max(0, Math.min(this._outputIndex, opts.length - 1))];
    const out = this._output;
    if (!candidate || !out) { this._cancelOutputMode(); return; }
    this._clearOutputTimers();
    if (this._outputEntityUnavailable()) {
      this._finishOutput({ ok: false, text: "NOT SWITCHED",
                           detail: "Speaker choice is unavailable right now" });
      return;
    }
    if (candidate === out.state) {
      this._finishOutput({ ok: true, same: true, text: "NO CHANGE", detail: candidate });
      return;
    }
    this._outputPending = candidate;
    this._render();
    let ok = false;
    try {
      ok = (await this._select(out, candidate)) !== false;
    } catch (e) {
      ok = false;
    }
    if (!this._outputMode || this._outputPending !== candidate) return;   // closed meanwhile
    this._outputPending = null;
    const why = (this._notice && !this._notice.ok && this._notice.text) || "Home Assistant refused the change";
    if (!ok) {
      // The banner says which operation failed: a speaker selection, never a
      // station start (the selection is a settings write and nothing else).
      const said = /[.!?]$/.test(why) ? why : `${why}.`;
      this._setNotice(false, `The DJ speaker was not switched to ${candidate}: ${said} No station was started or stopped.`);
    }
    this._finishOutput(ok ? { ok: true, text: "SWITCHED", detail: candidate }
                          : { ok: false, text: "NOT SWITCHED", detail: why });
  }

  _finishOutput(result) {
    this._clearOutputTimers();
    this._outputResult = result;
    this._render();
    this._outputConfirmTimer = setTimeout(() => {
      this._outputConfirmTimer = null;
      this._closeOutputMode();
    }, result.ok ? OUTPUT_CONFIRMED_MS : OUTPUT_REFUSED_MS);
  }

  /* Escape, the timeout, or leaving: closes with no change. An answer that
   * is still on its way keeps the display. */
  _cancelOutputMode() {
    if (this._outputPending) return;
    this._closeOutputMode();
  }

  _closeOutputMode() {
    this._clearOutputTimers();
    this._outputMode = false;
    this._outputPending = null;
    this._outputResult = null;
    // The knob lets go with the list: a pointer that moves afterwards must
    // not go on turning the right knob through the Dial.
    if (this._knobTurning === "right") this._knobTurning = null;
    this._render();
    this._mouthStart();
  }

  /* The rows the LCD shows: the CURRENT speaker on top (NOW), then the
   * candidate, then what the next step would bring. When the candidate IS
   * the current speaker it takes the top row itself. Phones show the first
   * two rows only (.lcd-row-extra). Pure. */
  _outputRows() {
    const opts = this._outputOptions();
    const n = opts.length;
    if (!n) return [];
    const cur = this._output ? opts.indexOf(this._output.state) : -1;
    const cand = Math.max(0, Math.min(this._outputIndex, n - 1));
    const order = [];
    if (cur >= 0 && cur !== cand) order.push(cur);
    order.push(cand);
    for (let k = 1; k < n && order.length < 3; k++) {
      const i = (cand + k) % n;
      if (!order.includes(i)) order.push(i);
    }
    return order.map((i, at) => ({ name: opts[i], now: i === cur, cand: i === cand, extra: at >= 2 }));
  }

  /* A SPEAKER NAME THAT KEEPS ITS ENDING. Long names often differ only at
   * the end ("Loft Ceiling Left" / "Loft Ceiling Right"), which a plain
   * end-ellipsis cuts off on a phone. The name is drawn as a head that may
   * shrink to an ellipsis and a tail that never does: the last word, with
   * the words before it while that stays short. A name that fits looks
   * exactly as before (the two parts sit together); the element's text is
   * still the whole name, and its title carries it too. Pure. */
  _nameParts(name) {
    const full = String(name == null ? "" : name);
    const words = full.split(" ");
    if (words.length < 2) return { head: full, tail: "" };
    let tail = words.pop();
    if (tail.length > 16) {
      return { head: full.slice(0, full.length - 12), tail: full.slice(-12) };
    }
    while (words.length > 1 && (words[words.length - 1].length + 1 + tail.length) <= 14) {
      tail = words.pop() + " " + tail;
    }
    return { head: words.join(" ") + " ", tail };
  }

  _nameHTML(name, cls) {
    const { head, tail } = this._nameParts(name);
    const full = this._esc(name);
    if (!tail) return `<span class="${cls}" title="${full}">${full}</span>`;
    return `<span class="${cls} pw-name" title="${full}"><span class="pw-name-head">${this._esc(head)}</span><span class="pw-name-tail">${this._esc(tail)}</span></span>`;
  }

  /* One sentence for the list's state, shared by the list's own label and
   * the right knob's accessible name (focus returns to the knob after every
   * render, so a screen reader hears it as the list moves). */
  _outputSay() {
    const opts = this._outputOptions();
    const count = opts.length;
    if (!count) return "No speakers are enabled.";
    const active = this._output ? this._output.state : null;
    if (this._outputPending) return `Switching to ${this._outputPending}.`;
    if (this._outputResult) {
      const r = this._outputResult;
      return `${r.text}: ${r.detail}.${!r.ok && active && opts.includes(active) ? ` Still on ${active}.` : ""}`;
    }
    const idx = Math.max(0, Math.min(this._outputIndex, count - 1));
    return `${opts[idx]}, ${idx + 1} of ${count}.${active && opts.includes(active) ? ` Now on ${active}.` : ""}`
      + (this._outputEntityUnavailable() ? " Speaker choice is unavailable right now."
                                         : " Push or Enter to switch, Escape to cancel.");
  }

  _renderOutputLcd() {
    const opts = this._outputOptions();
    const count = opts.length;
    const active = this._output ? this._output.state : null;
    if (count === 0) {
      return `
        <div class="mouth-lcd-overlay lcd-output" role="dialog" aria-label="Speaker selection">
          <div class="lcd-header">
            <span class="lcd-header-title"><span class="lcd-header-dot"></span>SPEAKER</span>
          </div>
          <div class="lcd-result"><span class="lcd-result-word">No speakers enabled</span></div>
        </div>`;
    }
    const idx = Math.max(0, Math.min(this._outputIndex, count - 1));
    const cand = opts[idx];
    const head = (right) => `
          <div class="lcd-header">
            <span class="lcd-header-title"><span class="lcd-header-dot"></span>SPEAKER <span class="lcd-pos">${idx + 1}/${count}</span></span>
            <span class="lcd-header-counter">${right}</span>
          </div>`;
    if (this._outputPending) {
      return `
        <div class="mouth-lcd-overlay lcd-output" role="dialog" aria-label="Switching speaker">
          ${head("")}
          <div class="lcd-result"><span class="lcd-result-word">SWITCHING…</span>
            ${this._nameHTML(this._outputPending, "lcd-result-detail")}</div>
        </div>`;
    }
    if (this._outputResult) {
      const r = this._outputResult;
      const detail = r.ok ? r.detail : `${r.detail}${active && active !== "unavailable" ? ` · still ${active}` : ""}`;
      return `
        <div class="mouth-lcd-overlay lcd-output ${r.ok ? "lcd-confirmed" : "lcd-refused-state"}" role="dialog"
             aria-label="${this._esc(`${r.text}: ${detail}`)}">
          ${head("")}
          <div class="lcd-result"><span class="lcd-result-word${r.ok ? "" : " lcd-refused"}">${this._esc(r.text)}${r.ok && !r.same ? " ✓" : ""}</span>
            ${r.ok ? this._nameHTML(detail, "lcd-result-detail")
                   : `<span class="lcd-result-detail" title="${this._esc(detail)}">${this._esc(detail)}</span>`}</div>
        </div>`;
    }
    const unavailable = this._outputEntityUnavailable();
    const elapsed = Math.max(0, OUTPUT_TIMEOUT_MS - Math.max(0, (this._outputDeadline || 0) - Date.now()));
    const rows = this._outputRows().map((r) => `
            <div class="lcd-row${r.cand ? " lcd-row-cand" : ""}${r.now ? " lcd-row-now" : ""}${r.extra ? " lcd-row-extra" : ""}">
              <span class="lcd-row-mark" aria-hidden="true">${r.cand ? "▶" : ""}</span>
              ${this._nameHTML(r.name, "lcd-row-name")}
              <span class="lcd-row-tag">${r.now ? "NOW" : ""}</span>
            </div>`).join("");
    const say = this._outputSay();
    return `
      <div class="mouth-lcd-overlay lcd-output" role="dialog" aria-label="${this._esc(`Speaker selection: ${say}`)}">
        ${head(`<span class="lcd-countdown-num">${this._outputSecondsLeft()}s</span>`)}
        <div class="lcd-rows">${rows}
        </div>
        <div class="lcd-footer">${unavailable
          ? `<span class="lcd-station-note">SPEAKER CHOICE UNAVAILABLE</span>`
          : `<span class="browse-hint">push to switch · turn to browse · esc to cancel</span>`}</div>
        <span class="lcd-countdown-bar" aria-hidden="true" style="animation-duration:${OUTPUT_TIMEOUT_MS}ms; animation-delay:-${Math.round(elapsed)}ms"></span>
      </div>`;
  }

  /* --- The Dial: saved stations on the right knob -------------------------
   * TWO MODES, NEVER MIXED. A double-click opens OUTPUT (which speaker the
   * house DJ follows, above). Turning opens STATION: the saved Dial
   * stations, one at a time, on the display. The first turn only SHOWS the
   * selector; further turns move it; PUSH asks ("push again to start on
   * <speaker>"); a SEPARATE, later push starts. Rotation alone never starts
   * anything, a quick double push can never be the confirming one, and
   * turning away takes the question back. Idle, the display returns to the
   * Mouth exactly as the speaker browser does.
   *
   * A Dial position is a preset id and nothing more. The start sends that
   * id (origin "dial") to the SAME command the Station tab and the Request
   * Line use; the backend reads the preset's CURRENT term, re-runs every
   * live rule and proves the speaker. There is no query, no track list and
   * no station logic here. The speaker is the backend's dial_target -- the
   * station on air, else the speaker the last station ran on -- and there
   * is none until a station has run; the house output is never one. */
  _dialStations() {
    return this._dialPresets().filter((p) => p.kind === "music" && p.enabled !== false);
  }

  /* Station Setup's own verdict on the preset's CURRENT term -- the rule
   * the backend applies. A verdict on an older term is out of date, and
   * the backend re-runs the live rule on every start regardless. */
  _dialThin(p) {
    const lt = (p && p.last_test) || {};
    return lt.viable === false && this._dialTestState(p) === "current";
  }

  _liveData() {
    return (this._live && this._live.data) || {};
  }

  /* Is the on-air answer CURRENT? A failed read keeps the older answer in
   * `data` (see _fetchLive) and an unreadable state answers ok:false: both
   * are unknown -- never "on air", never "nothing on the air". */
  _liveKnown() {
    const l = this._live;
    return !!(l && l.data && !l.error && l.data.ok !== false);
  }

  /* The key of ONE station start (a start's answer, or the station on air):
   * compared, to tell whether a line about a start still describes the
   * station on air -- never shown. */
  _liveStartKey(obj) {
    return (obj && obj.station_id) || null;
  }

  _stationCandidate() {
    const list = this._dialStations();
    if (!list.length) return null;
    return list[Math.max(0, Math.min(this._stationIndex, list.length - 1))];
  }

  /* Why the station under the pointer cannot be started from here, or "". */
  _stationBlock(p) {
    const d = this._liveData();
    if (!p) return "No Dial stations saved";
    if (!this._live || !this._live.data || d.ok === false) return "Station state unknown";
    if (d.legacy_station_active) return "Start Radio is running";
    if (d.state === "starting") return "A station is starting";
    if (this._dialThin(p)) return "Too thin to go live";
    // The Dial starts only what Station Setup approved as the builder
    // programs it now (the backend refuses anything else too).
    const tested = this._dialTestState(p);
    if (tested === "stale") return "Needs retest in Station Setup";
    if (tested !== "current") return "Test it in Station Setup first";
    if (!d.dial_target || !d.dial_target.queue_id) return "Pick a speaker on the Station tab first";
    // The speaker the Dial aims at is the station's (on air, else the last
    // one's) -- never the selected DJ speaker. If the backend's own speaker
    // check already says it cannot take a station (a speaker group, grouped,
    // in a group, the house DJ speaker, unavailable), say so here instead
    // of asking a push that the backend would refuse. The backend still
    // decides every start; this only reads its verdict.
    const tv = this._dialTargetVerdict(d.dial_target.queue_id);
    if (tv && tv.eligible === false) return this._dialTargetWhy(tv, d.dial_target.name);
    if (this._dialOnAir(p)) return "On air now";
    return "";
  }

  /* Turning always opens the Dial, empty or not: with no stations saved it says so, and how to reach the
   * speakers instead. */
  /* The backend's verdict on one speaker, from the read-only targets list
   * (the Station tab's own source), or null when it has not been read. */
  _dialTargetVerdict(queueId) {
    const rows = ((this._liveTargets && this._liveTargets.data) || {}).targets;
    if (!Array.isArray(rows)) return null;
    return rows.find((r) => r && r.queue_id === queueId) || null;
  }

  /* One short LCD line for a speaker that cannot take a station, naming it. */
  _dialTargetWhy(row, name) {
    const who = name || row.name || "That speaker";
    const why = {
      target_is_group: "is a speaker group",
      target_grouped: "is grouped right now",
      target_in_group: "belongs to a speaker group",
      target_is_house_output: "is the house DJ speaker",
      target_unavailable: "is unavailable",
    }[row.reason];
    return why ? `${who} ${why}` : `${who} cannot take a station`;
  }

  _enterStationMode() {
    if (this._outputMode) return false;
    this._cancelHint();
    const onAir = (this._liveData().station || {}).preset_id;
    const at = this._dialStations().findIndex((p) => p.id === onAir);
    this._stationMode = true;
    this._stationIndex = at >= 0 ? at : 0;
    this._stationArmed = false;
    this._stationPrompt = false;
    this._stationResult = null;
    this._mouthStop();
    this._resetStationTimers();
    // What the display says must be current. The start is decided by the
    // backend either way; this only keeps the question honest.
    this._fetchLive(true);
    if (!this._dialEdit) this._fetchDial(true);
    this._fetchLiveTargets();
    this._render();
    return true;
  }

  /* One detent. The first one only opens the selector, whatever the number
   * of saved stations; turning never touches the speaker. */
  _stationStep(dir) {
    if (this._outputMode) return;
    if (!this._stationMode) { this._enterStationMode(); return; }
    if (this._stationBusy) return;
    const n = this._dialStations().length;
    if (n > 1) this._stationIndex = (this._stationIndex + dir + n) % n;
    this._stationArmed = false;
    this._stationPrompt = false;
    this._stationResult = null;
    this._resetStationTimers();
    this._render();
  }

  _stationPush() {
    if (!this._stationMode || this._stationBusy || this._stationResult) return;
    const p = this._stationCandidate();
    if (this._stationBlock(p)) { this._resetStationTimers(); this._render(); return; }
    // The question is about ONE station. If the saved list changed under it
    // and another station now stands at the pointer, this push asks about
    // that one rather than starting it unasked.
    if (!this._stationArmed || this._stationArmedId !== p.id) {
      this._stationArmed = true;
      this._stationArmedAt = Date.now();
      this._stationArmedId = p.id;
      this._resetStationTimers();
      this._render();
      return;
    }
    // The confirming push is its own gesture, never the second half of a
    // double-click.
    if (Date.now() - (this._stationArmedAt || 0) < DIAL_CONFIRM_MIN_MS) return;
    this._dialStart(p);
  }

  /* One KNOB click in the station selector (keys call _stationPush: a key
   * cannot double-click). Asking happens at once -- it starts nothing, and a
   * second click inside the double-click window makes the pair OUTPUT, which
   * drops the question. A click that would CONFIRM is held for that window:
   * if it becomes the first half of a double-click, OUTPUT takes it and
   * nothing starts; only a click that stays single goes on to start. A held
   * confirmation counts once however many bounces follow it, and a click
   * too soon after the question is no confirmation at all. */
  _stationClick() {
    if (!this._stationMode || this._stationBusy || this._stationResult) return;
    if (!this._stationArmed) { this._stationPush(); return; }
    if (this._stationConfirmTimer) return;
    if (Date.now() - (this._stationArmedAt || 0) < DIAL_CONFIRM_MIN_MS) return;
    this._stationConfirmTimer = setTimeout(() => {
      this._stationConfirmTimer = null;
      this._stationPush();
    }, KNOB_DOUBLE_CLICK_MS);
  }

  /* A knob click that was not a turn. Two clicks inside the double-click
   * window are ONE gesture -- OUTPUT on the right knob, DJ power on the left
   * -- and whatever the first of them held back is withdrawn with it. */
  _knobClick(which) {
    const now = Date.now();
    const diff = now - (this._lastKnobClick[which] || 0);
    if (diff < KNOB_DOUBLE_CLICK_MS && diff > KNOB_BOUNCE_MS) {
      this._lastKnobClick[which] = 0;
      if (which === "left") {
        this._toggle(this._dj);
      } else if (this._outputMode) {
        // Inside the speaker list ONE push confirms. The second half of a quick pair is not a new
        // gesture: the first already confirmed, or was the opening run's
        // tail (which it extends). It never re-opens, never switches twice
        // and never engages turning for the Dial.
        if (this._outputRunAt) this._outputRunAt = now;
        return;
      } else {
        // A double-click is always OUTPUT. From the station selector it
        // drops the question the first click asked, and the confirmation
        // the first click held; a start that is already with the backend
        // keeps the display.
        if (this._stationConfirmTimer) {
          clearTimeout(this._stationConfirmTimer);
          this._stationConfirmTimer = null;
        }
        if (!this._outputMode && !this._stationBusy) {
          this._enterOutputMode(true);
        }
        this._knobTurning = "right";
        this._render();
      }
      return;
    }
    this._lastKnobClick[which] = now;
    if (which === "right" && this._outputMode) {
      // Pushing lets go of the knob; the run rule refuses the opening
      // gesture's tail, the confirm refuses a push while an answer is due.
      this._knobTurning = null;
      this._outputPush();
    } else if (which === "right" && this._stationMode) {
      // Pushing lets go of the knob: moving the pointer afterwards must not
      // turn it and silently take the question back.
      this._knobTurning = null;
      this._stationClick();
    } else {
      this._knobTurning = this._knobTurning === which ? null : which;
      this._render();
    }
  }

  async _dialStart(p) {
    const target = (this._liveData().dial_target || {}).queue_id;
    if (!p || !target || this._stationBusy) return;
    this._stationBusy = true;
    this._stationArmed = false;
    this._clearStationTimers();
    this._clearNotice();
    this._render();
    let r;
    try {
      r = await this._ws("parlorwave_radio/station_live_start",
                         { target, preset_id: p.id, origin: "dial" });
    } catch (e) {
      r = { ok: false, message: this._humanRefusal(e).text };
    }
    this._stationBusy = false;
    const ok = !!(r && r.ok);
    const where = (r && r.target && r.target.name) || "the speaker";
    this._stationResult = { ok, text: ok ? `On air on ${where}` : "Not started" };
    const aimed = (this._liveData().dial_target || {}).name || where;
    this._setNotice(ok, ok
      ? `On air: "${p.label}" on ${where}. ${r.opening_count} songs were queued after the song playing now.`
      : `The Dial did not start "${p.label}" on ${aimed}: `
        + (r && r.reason === "handover_required"
          ? "the house speaker is handed over from the Station tab, where you can see what it takes over first."
          : String((r && (r.message || this._liveProblem(r.reason))) || "no reason was given."))
        + " The DJ speaker selection was not changed.");
    this._stationCancelTimer = setTimeout(() => this._cancelStationMode(), DIAL_RESULT_MS);
    this._fetchLive(true);
  }

  _resetStationTimers() {
    this._clearStationTimers();
    // An empty Dial is never prompted to "push to choose": its hint (push
    // twice for speakers) is the whole answer, and it closes like any Dial.
    this._stationPromptTimer = setTimeout(() => {
      if (this._stationMode && !this._stationBusy && !this._stationResult
          && this._dialStations().length) {
        this._stationPrompt = true;
        this._render();
      }
    }, SELECTOR_PROMPT_MS);
    this._stationCancelTimer = setTimeout(() => {
      if (this._stationMode && !this._stationBusy) this._cancelStationMode();
    }, SELECTOR_TIMEOUT_MS);
  }

  _clearStationTimers() {
    if (this._stationPromptTimer) clearTimeout(this._stationPromptTimer);
    if (this._stationCancelTimer) clearTimeout(this._stationCancelTimer);
    if (this._stationConfirmTimer) clearTimeout(this._stationConfirmTimer);
    this._stationPromptTimer = null;
    this._stationCancelTimer = null;
    this._stationConfirmTimer = null;
  }

  _cancelStationMode() {
    if (this._stationBusy) return;       // the answer comes back to the display
    this._clearStationTimers();
    this._stationMode = false;
    this._stationArmed = false;
    this._stationPrompt = false;
    this._stationResult = null;
    this._lastStationStepAngle = null;
    this._render();
    this._mouthStart();
  }

  _renderStationLcd() {
    // THREE rows, like the speaker browser, so it fits the phone's Mouth:
    // header (counter, and the speaker a start is aimed at), the station,
    // and one line saying what a push would do -- or why it cannot.
    const list = this._dialStations();
    const p = this._stationCandidate();
    const d = this._liveData();
    const idx = Math.max(0, Math.min(this._stationIndex, list.length - 1));
    const where = (d.dial_target && d.dial_target.name) || "";
    const verb = d.active ? "switch" : "start";
    const block = this._stationBlock(p);
    const onAir = this._dialOnAir(p);
    let footer;
    if (this._stationBusy) {
      footer = `<span class="lcd-confirm-badge">TUNING…</span>`;
    } else if (this._stationResult) {
      footer = `<span class="lcd-confirm-badge${this._stationResult.ok ? "" : " lcd-refused"}">${
        this._stationResult.ok ? "ON AIR ✓" : "NOT STARTED"}</span>`;
    } else if (!list.length) {
      footer = `<span class="browse-hint">Push twice for speakers</span>`;
    } else if (block) {
      footer = `<span class="lcd-station-note">${this._esc(block)}</span>`;
    } else if (this._stationArmed) {
      footer = `<span class="confirm-prompt">PUSH AGAIN TO ${verb.toUpperCase()}</span>`;
    } else {
      footer = this._stationPrompt
        ? `<span class="confirm-prompt">PUSH TO CHOOSE</span>`
        : `<span class="browse-hint">Turn to browse · push to choose</span>`;
    }
    return `
      <div class="mouth-lcd-overlay lcd-station" role="dialog" aria-label="Station selection">
        <div class="lcd-header">
          <span class="lcd-header-title"><span class="lcd-header-dot"></span>STATION${
            list.length ? ` ${idx + 1}/${list.length}` : ""}</span>
          <span class="lcd-header-counter lcd-station-where">${where ? `→ ${this._esc(where)}` : ""}</span>
        </div>
        <div class="lcd-browser">
          <div class="lcd-candidate-curr">
            <span class="lcd-curr-text">${onAir ? '<span class="lcd-star">★</span> ' : ""}${this._esc(p ? p.label : "No stations saved")}</span>
          </div>
        </div>
        <div class="lcd-footer">${footer}</div>
      </div>`;
  }

  _setCadence(value) {
    const e = this._cadence;
    if (!e) return;
    this._svc("number", "set_value",
      { entity_id: e.entity_id, value: Number(value) }, e.entity_id);
  }

  _request() {
    const input = this.shadowRoot.getElementById("request-input");
    const text = input ? input.value.trim() : "";
    if (!text) { this._setNotice(false, "Type a request first."); this._render(); return; }
    this._svc("parlorwave_radio", "request", { request: text }, "request")
      .then(() => { const i = this.shadowRoot.getElementById("request-input"); if (i) i.value = ""; });
  }

  _thumb(action) {
    const p = this._player;
    const data = {};
    if (p) {
      data.artist = p.attributes.media_artist || "";
      data.title = p.attributes.media_title || "";
      data.player = p.entity_id;
    }
    // Named, not "Done." -- a rating is about one song, and the banner
    // should say which way it went. A rating the catalog could not take
    // never reaches here: the service refuses and _svc shows the refusal.
    const song = data.title ? `\u201c${data.title}\u201d` : "this song";
    this._svc("parlorwave_radio", action, data, action,
              action === "thumbs_up"
                ? `More like ${song}, noted for your station.`
                : `Fewer like ${song}, noted for your station.`);
  }

  _startRadio() { this._svc("parlorwave_radio", "start_radio_from_current", {}, "start_radio"); }

  /* One media_player call on the Music Assistant player the station is
   * following, and nothing else. No queue is read, built or rewritten
   * here; no Parlorwave Radio endpoint is involved. If the call fails,
   * _svc reports the failure -- a transport button never claims a success
   * it did not get. The refresh afterwards is so the screen shows the
   * player's OWN new state rather than the state we asked for. */
  /* WHOLE-HOME VOLUME, through Music Assistant's own player.
   *
   * `media_player.volume_set` on the Music Assistant entity the station is
   * following. That is Music Assistant's supported volume API as Home
   * Assistant exposes it -- the same route the transport buttons already
   * take -- so Music Assistant remains the authority and nothing here
   * reimplements a mixer, a group model or a per-speaker trim.
   *
   * THE SLIDER SHOWS THE PLAYER, NOT OUR WISH. There is no optimistic
   * local value: after a write the entity's own `volume_level` is what is
   * drawn, so a command Music Assistant rejects or clamps shows the truth
   * rather than a number nobody honoured. While a finger is down the
   * displayed value follows the finger (otherwise the thumb fights the
   * poll), and the moment it lifts the entity wins again. The left knob's
   * wheel and sticky turn have no "lift", so they hold the requested level
   * a little longer, and only until the player answers: see _holdVolume.
   */
  _volumeState() {
    const p = this._player;
    if (!p) return { player: null };
    if (p.state === "unavailable") {
      return { player: p, unavailable: true,
               why: `${p.attributes.friendly_name || p.entity_id} is unavailable right now.` };
    }
    const sf = Number(p.attributes.supported_features || 0);
    const level = p.attributes.volume_level;
    return {
      player: p,
      can: !!(sf & MP_VOLUME_SET),
      canMute: !!(sf & MP_VOLUME_MUTE),
      muted: !!p.attributes.is_volume_muted,
      // null is a real answer: a player that supports volume need not have
      // reported a level yet, and inventing 0 would show silence.
      level: typeof level === "number" ? level : null,
      name: p.attributes.friendly_name || p.entity_id,
    };
  }

  _setVolume(fraction) {
    const v = this._volumeState();
    if (!v.player || !v.can) return;
    const level = Math.max(0, Math.min(1, Number(fraction)));
    const held = this._volHold;
    if (held) {
      held.sent.push(level);
      if (held.sent.length > 32) held.sent.shift();
    }
    this._svc("media_player", "volume_set",
              { entity_id: v.player.entity_id, volume_level: level },
              "volume", false)
      .then((ok) => {
        // A refused write never stays on the knob looking accepted.
        if (!ok && held && this._volHold === held) { this._dropVolumeHold(); this._render(); }
      });
  }

  _throttledVolumeSet(fraction) {
    this._pendingVol = fraction;
    if (this._volThrottleTimer) return;
    this._volThrottleTimer = setTimeout(() => {
      this._volThrottleTimer = null;
      if (this._pendingVol != null) {
        this._setVolume(this._pendingVol);
      }
    }, VOLUME_WRITE_THROTTLE_MS);
  }

  _toggleMute() {
    const v = this._volumeState();
    if (!v.player || !v.canMute) return;
    this._svc("media_player", "volume_mute",
              { entity_id: v.player.entity_id, is_volume_muted: !v.muted },
              "volume");
  }

  /* THE LEFT KNOB HOLDS WHAT WAS ASKED FOR, UNTIL THE PLAYER ANSWERS.
   *
   * The slider is a drag with an end: while the finger is down the thumb
   * follows it, and on release the player's report wins. The wheel and the
   * sticky turn have no end. They arrive as a stream of small steps, each
   * throttled into a write, while Home Assistant's reports of the knob's own
   * earlier writes come back late. Stepping from those reports made three
   * notches into one, and every write's render drew the knob back mid-turn.
   *
   * So a wheel notch or a sticky-turn move steps from the level last asked
   * for, and the knob and the slider show that level until the reports have
   * caught up or plainly say something else (VOLUME_HOLD_MS and its
   * neighbours). Then the player wins exactly as before: a clamp, a change
   * made somewhere else, or a level that never arrives is what is drawn. A
   * refused write lets go at once. Nothing here writes; the writes are
   * still _throttledVolumeSet's. A drag or the slider takes the level over
   * and lets the hold go. */
  _heldVolume(v) {
    const h = this._volHold;
    return h && v && v.player && v.can ? h.level : null;
  }

  /* The level the next knob step starts from: what the knob shows. */
  _volumeBase() {
    const v = this._volumeState();
    const held = this._heldVolume(v);
    if (held != null) return held;
    return (v && typeof v.level === "number") ? v.level : KNOB_FALLBACK_LEVEL;
  }

  _holdVolume(level) {
    const v = this._volumeState();
    if (!v.player || !v.can) return;        // nothing can be asked, so nothing is held
    const h = this._volHold
      || { base: typeof v.level === "number" ? v.level : null, sent: [] };
    h.level = level;
    h.at = Date.now();
    this._volHold = h;
    this._scheduleVolumeCheck(VOLUME_HOLD_MS);
  }

  _dropVolumeHold() {
    if (this._volHoldTimer) clearTimeout(this._volHoldTimer);
    this._volHoldTimer = null;
    this._volHold = null;
  }

  _scheduleVolumeCheck(ms) {
    if (this._volHoldTimer) clearTimeout(this._volHoldTimer);
    this._volHoldTimer = setTimeout(() => {
      this._volHoldTimer = null;
      if (this._settleVolumeHold()) this._render();
    }, Math.max(0, ms));
  }

  /* Lets the hold go when the player has answered; true if it did (the
   * caller draws). Called on every report and when a check falls due. */
  _settleVolumeHold() {
    const h = this._volHold;
    if (!h) return false;
    const v = this._volumeState();
    if (!v.player || !v.can) { this._dropVolumeHold(); return true; }
    const quiet = Date.now() - h.at;
    if (quiet < VOLUME_HOLD_MS) {           // still turning: nothing yanks the knob
      this._scheduleVolumeCheck(VOLUME_HOLD_MS - quiet);
      return false;
    }
    if (this._volThrottleTimer) {           // a write is still to go out
      this._scheduleVolumeCheck(VOLUME_WRITE_THROTTLE_MS);
      return false;
    }
    const rep = typeof v.level === "number" ? v.level : null;
    const near = (x) => rep != null && x != null && Math.abs(rep - x) <= VOLUME_ECHO_TOLERANCE;
    const ownEcho = !near(h.level) && (near(h.base) || h.sent.some(near));
    if (ownEcho && quiet < VOLUME_HOLD_MAX_MS) {
      this._scheduleVolumeCheck(VOLUME_HOLD_MAX_MS - quiet);
      return false;
    }
    this._dropVolumeHold();
    return true;
  }

  _renderVolume() {
    const v = this._volumeState();
    // NO SPEAKER, NO SLIDER. A volume control with nothing behind it is a
    // control that lies.
    if (!v.player) return "";
    if (v.unavailable) {
      return `<div class="vol vol-off"><span class="vol-label">Volume</span>
        <span class="vol-why">${this._esc(v.why)}</span></div>`;
    }
    if (!v.can) {
      return `<div class="vol vol-off"><span class="vol-label">Volume</span>
        <span class="vol-why">${this._esc(v.name)} does not support volume
        control.</span></div>`;
    }
    const held = this._heldVolume(v);
    const shown = this._volDrag != null ? this._volDrag
      : held != null ? held
      : (v.level == null ? null : v.level);
    const pct = shown == null ? null : Math.round(shown * 100);
    return `
      <div class="vol">
        <span class="vol-label">Volume</span>
        ${v.canMute
          ? `<button class="ghost small vol-mute ${v.muted ? "on" : ""}"
                     id="vol-mute" aria-pressed="${v.muted}">${
               v.muted ? "Muted" : "Mute"}</button>`
          : ""}
        <input type="range" id="vol-range" min="0" max="100" step="1"
               value="${pct == null ? 0 : pct}"
               ${pct == null ? "disabled" : ""}
               aria-label="Whole home volume for ${this._esc(v.name)}"
               aria-valuetext="${pct == null ? "Unknown" : pct + " percent"}">
        <span class="vol-pct">${pct == null ? "—" : pct + "%"}</span>
      </div>`;
  }

  _transport(service) {
    const p = this._player;
    if (!p) return;
    this._svc("media_player", service, { entity_id: p.entity_id }, "transport");
  }

  // --- local time base for progress + synced lyrics ----------------------
  _progress() {
    const n = this._nowCard;
    const a = n && n.attributes;
    if (!a || a.elapsed == null || !a.duration) return null;
    let pos = Number(a.elapsed);
    if (n.state === "playing" && a.elapsed_at) {
      pos += (Date.now() / 1000) - Number(a.elapsed_at);
    }
    pos = Math.max(0, Math.min(pos, Number(a.duration)));
    return { pos, duration: Number(a.duration) };
  }

  _tick() {
    // Surgical updates only — never a full re-render from the timer.
    // The Mouth's position is NOT touched here: it has its own clock
    // (_syncPlaybackClock), anchored on the sensor, not on this tick.
    this._paintLive();
    // A DJ switch hold that runs out is settled here, so the knob and the
    // notice change without waiting for an entity to change.
    if (this._djHold && Date.now() >= this._djHold.until) { this._djHoldActive(); this._render(); }
    // The Newsroom is the one screen whose content changes without any
    // entity changing: a bulletin arms, queues and airs entirely inside the
    // backend. It therefore re-reads on the ticker WHILE IT IS ON SHOW, and
    // only then -- the age check inside keeps it to one call per 20s.
    if (this._view === "newsroom" && this._hass) this._maybeRefreshDemandData();
    // Settings, for the same reason and on its own slower age check: an
    // installation being repaired should show it without a page reload.
    if (this._view === "settings" && this._hass) this._maybeRefreshDemandData();
    // ...and the stale verdict is a matter of TIME. With Home Assistant's
    // connection gone no state arrives and nothing else renders, so the
    // ticker is what takes "Ready." off the screen once the document ages
    // out -- and puts the screen back when a fresh one lands.
    if (this._view === "settings" && this._hass
        && this._readyStale() !== !!this._readyStaleShown) this._render();
    // Station carries the station's name (its plate and the name sheet),
    // whose stored value comes from the same demand document; the age
    // check inside bounds it.
    if (this._view === "station" && this._hass) this._maybeRefreshDemandData();
  }

  /* --- notices: they go away ---------------------------------------------
   *
   * A SUCCESS IS NEWS FOR A MOMENT; A FAILURE IS EVIDENCE. The green
   * banner used to be neither -- it had no close control and no end, so
   * "Done." sat over the screen until something else replaced it, and an
   * owner who saved three settings could not tell which one it belonged
   * to any more.
   *
   * Both kinds are dismissible by hand. Only a success expires on its
   * own: an error is a diagnostic, and a diagnostic that deletes itself
   * before the person reading it has finished is worse than no message.
   * The timer belongs to the component, not to the element -- _render()
   * replaces the whole shadow tree on every coordinator update, so a
   * timeout hung off the banner would be cancelled by the next poll.
   */
  /* `opts.critical`: an error that must stay until it is dismissed. Every
   * other error is recoverable (NOTICE_RECOVERABLE_MS); success toasts keep
   * NOTICE_TTL_MS. The same error text while it is showing is one banner
   * with a count, and its time starts again. */
  /* THE SERVICE'S OWN WORDS, TRANSLATED. A refusal arrives as the backend
   * phrased it for a developer -- "/settings/bulletins answered 422:
   * bulletins.sources[0].feed_url must be an http(s) URL" -- and nobody at
   * the panel should have to read a path, a status code or a settings key.
   * What is shown is a plain sentence; the original travels with it as the
   * notice's detail, for a bug report. */
  _humanRefusal(raw) {
    const text = String((raw && raw.message) || raw || "").trim();
    const m = /^\/\S*\s+answered\s+(\d{3})(?::\s*)?([\s\S]*)$/.exec(text);
    const status = m ? Number(m[1]) : null;
    const rest = (m ? m[2] : text).trim();
    const known = [
      [/feed_url must be an http\(s\) URL/i, "The feed address must start with http://… or https://…"],
      [/target_minute/i, "Choose a schedule from the list."],
      [/must be an http\(s\) URL/i, "The address must start with http://… or https://…"],
      [/source_name|sources\[\d+\]\.name/i, "Check the source name: it can be left empty, but not be only spaces."],
    ];
    for (const [re, words] of known) {
      if (re.test(rest)) return { text: words, detail: text };
    }
    if (status != null && status >= 500) {
      return { text: "ParlorWave Radio could not make that change just now. Try again in a moment.", detail: text };
    }
    if (m) return { text: `ParlorWave Radio refused the change: ${rest || "no reason was given."}`, detail: text };
    return { text: text || "That change was not saved.", detail: null };
  }

  /* One call for every catch that used to show `e.message` as it came. */
  _refuse(prefix, raw) {
    const h = this._humanRefusal(raw);
    this._setNotice(false, `${prefix || ""}${h.text}`, { detail: h.detail });
  }

  _setNotice(ok, text, opts = {}) {
    const t = String(text);
    const cur = this._notice;
    const meta = this._noticeMeta;
    if (cur && meta && !cur.ok && !ok && cur.text === t) {
      meta.count += 1;
      meta.critical = meta.critical || !!opts.critical;
      this._armNotice(meta.critical ? 0 : NOTICE_RECOVERABLE_MS);
      return;
    }
    this._clearNotice();
    this._notice = { ok: !!ok, text: t, detail: opts.detail && opts.detail !== t ? String(opts.detail) : null };
    this._noticeMeta = { count: 1, critical: !ok && !!opts.critical, ms: 0, dueAt: 0, held: false, left: 0 };
    this._armNotice(ok ? NOTICE_TTL_MS : this._noticeMeta.critical ? 0 : NOTICE_RECOVERABLE_MS);
  }

  /* (Re)start the notice's own clock; 0 = no clock (critical). While the
   * pointer or focus is on the banner the clock is held (_holdNotice). */
  _armNotice(ms) {
    if (this._noticeTimer) clearTimeout(this._noticeTimer);
    this._noticeTimer = null;
    const n = this._notice;
    const m = this._noticeMeta;
    if (!n || !m) return;
    m.ms = ms;
    m.dueAt = ms ? Date.now() + ms : 0;
    if (!ms || m.held) return;
    this._noticeTimer = setTimeout(() => {
      this._noticeTimer = null;
      if (this._notice !== n) return;
      this._notice = null;
      this._noticeMeta = null;
      this._render();
    }, ms);
  }

  _holdNotice(held) {
    const n = this._notice;
    const m = this._noticeMeta;
    if (!n || !m || n.ok || !m.dueAt) return;
    if (held && !m.held) {
      m.held = true;
      m.left = Math.max(0, m.dueAt - Date.now());
      if (this._noticeTimer) clearTimeout(this._noticeTimer);
      this._noticeTimer = null;
    } else if (!held && m.held) {
      m.held = false;
      this._armNotice(Math.max(NOTICE_RESUME_MIN_MS, m.left || 0));
    }
  }

  _clearNotice() {
    if (this._noticeTimer) clearTimeout(this._noticeTimer);
    this._noticeTimer = null;
    this._notice = null;
    this._noticeMeta = null;
  }

  /* A press anywhere but on the toast takes it away.
   *
   * It removes the ELEMENT and does not re-render. A full render on
   * pointerdown would replace the button under the finger between the
   * press and its click, and the click would then land on nothing -- which
   * is the same hazard `_pointerHeld` exists for. Taking one element out of
   * the tree touches nothing anybody is pressing.
   *
   * Only a success. An error is evidence, and evidence that disappears
   * because somebody clicked somewhere else is evidence nobody can read. */
  _dismissToastOnOutsidePress(ev) {
    if (!this._notice || !this._notice.ok) return;
    const wrap = this.shadowRoot.querySelector(".toast-wrap");
    if (!wrap) return;
    const path = (ev && ev.composedPath) ? ev.composedPath() : [];
    if (path.indexOf(wrap) !== -1) return;
    this._clearNotice();
    wrap.remove();
  }

  _mmss(s) {
    s = Math.round(s);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  /* Which line the song is on, or -1 before the first one. */
  _lyricIndex(pr) {
    const d = this._lyrics && this._lyrics.data;
    if (!d || d.kind !== "synced" || !pr) return -1;
    const lines = d.lines || [];
    let idx = -1;
    for (let i = 0; i < lines.length; i++) { if (lines[i].t <= pr.pos) idx = i; else break; }
    return idx;
  }

  /* Move the highlight, and the LYRIC PANE only.
   *
   * Two things are deliberately absent and must stay absent:
   * `scrollIntoView` (it walks every scrollable ancestor, and the outermost
   * one is the Home Assistant page) and `focus()` (moving focus scrolls the
   * page to the focused element and steals the caret from whatever the
   * person was actually using). Everything here addresses one element by
   * its scrollTop, so there is no mechanism by which the outer page could
   * move at all. */
  _highlightLyric(pr) {
    if (this._drawer !== "lyrics") return;
    const list = this.shadowRoot && this.shadowRoot.getElementById("lyric-lines");
    if (!list) return;
    const idx = this._lyricIndex(pr);
    const prev = list.querySelector(".lyric-now");
    const next = idx < 0 ? null : list.querySelector(`[data-li="${idx}"]`);
    if (prev !== next) {
      if (prev) prev.classList.remove("lyric-now");
      if (next) next.classList.add("lyric-now");
      this._lyricLine = idx;
    }
    if (!next) return;
    // THE HIGHLIGHT ALWAYS MOVES; THE PANE ALMOST NEVER DOES. Above this
    // line the active line has been marked, which is what a reader who has
    // scrolled away still wants to be true when they come back. Below it,
    // nothing happens unless following is on AND this is a line we have not
    // already moved for -- so a coordinator refresh, which changes neither,
    // cannot scroll the pane.
    if (!shouldAutoScroll({ line: idx,
                            lastScrolledFor: this._lyricScrolledFor,
                            following: this._lyricFollow })) return;
    this._scrollLyricTo(list, next);
  }

  /* Put one line at the anchor. The only place in the panel that moves the
   * lyric pane, so the "we asked for this" bookkeeping lives here once. */
  _scrollLyricTo(list, el) {
    const wanted = lyricScrollTop({
      paneHeight: list.clientHeight,
      contentHeight: list.scrollHeight,
      lineTop: el.offsetTop - list.offsetTop,
      lineHeight: el.offsetHeight,
    });
    this._lyricScrolledFor = this._lyricLine;
    if (Math.round(list.scrollTop) === wanted) return;
    // Remember what WE asked for, so the scroll event this causes is not
    // mistaken for the reader scrolling by hand.
    this._lyricAutoTop = wanted;
    this._lyricAutoAt = Date.now();
    this._lyricScrollTop = wanted;
    if (typeof list.scrollTo === "function") {
      list.scrollTo({ top: wanted, behavior: this._gentle() ? "smooth" : "auto" });
    } else {
      list.scrollTop = wanted;
    }
  }

  /* Gentle unless the reader has asked the system for less motion. Guarded:
   * matchMedia is absent in the test DOM and in older embeddings, and a
   * missing preference must mean "the ordinary thing", not a throw. */
  _gentle() {
    try {
      return !(window.matchMedia
               && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (e) { return true; }
  }

  /* THE READER HAS TAKEN THE PANE. Called from every interaction that can
   * move it -- wheel, touch, pointer, and a scroll we did not ask for.
   * Immediate and total: no proximity test, no timer, and no way back
   * except the control they can see. */
  _lyricHandsOff() {
    if (!this._lyricFollow) return;
    this._lyricFollow = false;
    this._render();
  }

  /* The pane's own listeners, attached once per rendered pane.
   *
   * A wheel, a touch, a key or a scroll this component did not ask for is
   * the reader taking the pane, and from then on the song does not move it
   * at all. THERE IS NO AUTOMATIC CATCH-UP: following resumes only when
   * the reader presses Follow lyrics. Resuming by itself once the song
   * drew level with wherever the pane had been left would be wrong: "the
   * song caught up" is indistinguishable from "they are still reading
   * three lines further down", so it would take the pane back without
   * being asked. */
  _bindLyricPane() {
    const list = this.shadowRoot && this.shadowRoot.getElementById("lyric-lines");
    if (!list || list._pwBound) return;
    list._pwBound = true;

    // THE INTENT, not its consequence. A wheel, a finger or a pointer on the
    // pane is somebody taking it, and it is unambiguous the moment it
    // happens -- so following stops there rather than after the scroll it
    // causes, which is the difference between "it stopped fighting me" and
    // "it fought me once more first".
    const off = () => this._lyricHandsOff();
    list.addEventListener("wheel", off, { passive: true });
    list.addEventListener("touchstart", off, { passive: true });
    list.addEventListener("pointerdown", off, { passive: true });
    list.addEventListener("keydown", off);

    // And the scroll itself, for everything the three above do not cover:
    // a dragged scrollbar, a trackpad fling, an assistive technology. This
    // one has to tell OUR scroll from theirs.
    list.addEventListener("scroll", () => {
      const top = Math.round(list.scrollTop);
      this._lyricScrollTop = top;
      // Arrived where we asked: that was us.
      if (this._lyricAutoTop != null && Math.abs(top - this._lyricAutoTop) <= 2) return;
      // A smooth scroll arrives as a stream of events and only the last is
      // the resting place. Anything inside the animation window belongs to
      // the animation, not to a person.
      if (Date.now() - (this._lyricAutoAt || 0) < LYRIC_SMOOTH_MS) return;
      this._lyricHandsOff();
    }, { passive: true });
  }

  /* Before the shadow DOM is replaced: remember where the lyric pane was.
   * Afterwards it is put back, so a coordinator poll landing while somebody
   * is reading does not throw them to the top of the song. */
  _saveLyricScroll() {
    const list = this.shadowRoot && this.shadowRoot.getElementById("lyric-lines");
    if (list) this._lyricScrollTop = Math.round(list.scrollTop);
  }

  /* After the shadow DOM has been replaced: put the pane back exactly where
   * it was, restore the highlight, and bind the new element's listeners.
   *
   * THE RESTORE IS ALSO A SCROLL, and that is the defect this prevents.
   * Assigning scrollTop fires a scroll event like any other, and the pane's
   * listener read it as the reader moving the pane by hand -- so after the
   * first coordinator refresh following was off, permanently and
   * invisibly, and the song stopped being followed. The old rule could only
   * resume when the song drifted back within one line of wherever the pane
   * had been left, which for most of a song is never.
   *
   * So the restore declares itself, the same way an auto-scroll does: this
   * position is OURS, asked for at this instant. A listener that can tell
   * our scrolls from theirs is the whole basis of "the reader has taken the
   * pane", and it has to be told about every scroll we cause, not just the
   * ones that look like following. */
  _restoreLyricScroll() {
    const list = this.shadowRoot && this.shadowRoot.getElementById("lyric-lines");
    if (!list) return;
    if (this._lyricScrollTop) {
      this._lyricAutoTop = this._lyricScrollTop;
      this._lyricAutoAt = Date.now();
      list.scrollTop = this._lyricScrollTop;
    }
    // The highlight belongs to the line, and the line is a fresh element
    // after a rebuild: put the class back without moving anything.
    if (this._lyricLine != null && this._lyricLine >= 0) {
      const el = list.querySelector(`[data-li="${this._lyricLine}"]`);
      if (el) el.classList.add("lyric-now");
    }
    this._bindLyricPane();
  }

  /* The Break History list, same contract as the lyric pane: before the
   * shadow DOM is replaced, remember where the list was; afterwards put it
   * back. The value read is wherever the READER left it at the instant of
   * the rebuild, so restoring it never fights an ongoing scroll -- it
   * re-applies the reader's own position to the fresh element, which a
   * browser would otherwise reset to 0. History has no auto-follow, so
   * unlike the lyric pane there is no "ours vs theirs" bookkeeping: every
   * scroll of this list is the reader's. */
  _saveHistoryScroll() {
    // Only while History is OPEN: the render right after an intentional
    // close still finds the old element in the tree, and saving it there
    // would resurrect the place the close just forgot.
    if (!this._historyOpen) return;
    const list = this.shadowRoot && this.shadowRoot.querySelector(".history");
    if (list) this._historyScrollTop = Math.round(list.scrollTop);
  }

  _restoreHistoryScroll() {
    const list = this.shadowRoot && this.shadowRoot.querySelector(".history");
    if (list && this._historyScrollTop) list.scrollTop = this._historyScrollTop;
  }

  /* The reader asking for the pane back. Follow again, forget which line we
   * last moved for so the very next highlight moves it, and go to the line
   * the song is actually on now rather than wherever it was when they
   * stopped following. */
  _resumeLyricFollow() {
    this._lyricFollow = true;
    this._lyricScrolledFor = null;
    this._render();
    const list = this.shadowRoot && this.shadowRoot.getElementById("lyric-lines");
    const el = list && this._lyricLine != null && this._lyricLine >= 0
      ? list.querySelector(`[data-li="${this._lyricLine}"]`) : null;
    if (list && el) this._scrollLyricTo(list, el);
  }

  // --- artwork -----------------------------------------------------------
  /* Where the sleeve actually comes from.
   *
   * The Music Assistant media_player entity's own picture first: Home
   * Assistant hands the browser a URL it can genuinely fetch, which the
   * service's advertised art URL is not obliged to be -- that one is built
   * for Music Assistant's network, not for whichever phone is looking at
   * this page. The service URL remains the fallback for a player that
   * publishes no picture. */
  /* WHAT IS PLAYING, from the fresher of the two things that know.
   *
   * There are two sources and they age differently. The Now Playing CARD
   * is the backend's answer, and it arrives on the coordinator's cycle --
   * up to ten seconds old. The Music Assistant PLAYER entity is a live
   * Home Assistant state and changes the instant the track does.
   *
   * The card used to win unconditionally (`card.title || player.title`),
   * so for the first ten seconds of every song the screen confidently
   * showed the previous one, and the live value underneath it was never
   * reached because the stale one was truthy.
   *
   * For ordinary MUSIC the live player wins. For program audio -- a DJ
   * break, a bulletin -- the card wins and must: the backend knows a
   * break is a break, and Music Assistant only knows it is playing a file.
   */
  _track() {
    const na = (this._nowCard && this._nowCard.attributes) || {};
    const pa = (this._player && this._player.attributes) || {};
    if (this._queueEnded()) return this._endedTrack();
    const kind = na.kind || "music";
    const live = kind === "music" && !!pa.media_title;
    return {
      kind,
      // The backend's word for what a programme item is to a listener
      // right now (upcoming / airing / spent / unknown); null for music.
      lifecycle: kind === "music" ? null : (na.lifecycle || null),
      live,
      title: live ? pa.media_title : (na.title || pa.media_title || null),
      artist: live ? (pa.media_artist || null) : (na.artist || pa.media_artist || null),
      album: kind === "music"
        ? (live ? (pa.media_album_name || null) : (na.album || null)) : null,
      art: live ? (pa.entity_picture || na.art_url || null)
                : (na.art_url || pa.entity_picture || (kind === "news" ? NEWS_ART_URL : null)),
      // The identity of what is on screen, for the artwork element's key
      // and the palette cache. Two different tracks can be served the same
      // artwork URL, and one track can be re-served a new URL; keying on
      // the pair means neither case shows the wrong sleeve.
      uri: (live ? pa.media_content_id : na.uri) || na.uri || null,
    };
  }

  /* The backend's confirmed "this finite queue played to its end" (the
   * Now Playing card's state, decided from Music Assistant's own evidence,
   * never from an idle state alone). */
  _queueEnded() {
    const n = this._nowCard;
    return !!(n && (n.state === "ended"
                    || (n.attributes && n.attributes.state === "ended")));
  }

  _artUrl() {
    const tr = this._track();
    const pa = (this._player && this._player.attributes) || {};
    if (tr.kind === "news" || (typeof pa.media_content_id === "string" && pa.media_content_id.includes("/news/audio/"))) {
      return tr.art || NEWS_ART_URL;
    }
    return tr.art;
  }

  /* QUEUE ENDED: no song at all. The player's own metadata
   * still names the old track, and shown with its leftover position it
   * looked paused mid-song -- an invitation to press Play on a queue that
   * had nothing left. History and the queue itself are untouched. */
  _endedTrack() {
    return { kind: "ended", lifecycle: null, live: false,
             title: "Queue Ended",
             artist: "This queue has played to its end.",
             album: null, art: null, uri: null };
  }

  /* A DJ BREAK'S SLEEVE, when it has none -- which is always: Music
   * Assistant carries no image for a break, so neither the card nor the
   * player has a picture. Rather than a placeholder glyph, the break wears
   * the radio's own face: the console's cabinet wood and grille cloth (the
   * faceplate in use), its brass script, and an engraved plate saying what
   * this is. Built from the console's materials, not an illustration; and
   * NOT an image, so _artUrl stays null and the album palette never reads
   * it. Real artwork, if a break ever carries some, still wins. */
  _renderDjArt() {
    const fp = this._faceplate || "midnight";
    return `<div class="art art-dj" data-fp="${this._esc(fp)}" role="img" aria-label="DJ break">
        <div class="art-dj-cloth console-fp-${this._esc(fp)}" aria-hidden="true">
          <span class="art-dj-script">ParlorWave</span>
          <span class="art-dj-plate">DJ Break</span>
        </div>
      </div>`;
  }

  /* ARRIVING AT ON AIR ASKS, rather than waiting to be told.
   *
   * The card sensor refreshes on the coordinator's cycle, so somebody who
   * spends two minutes in the Booth and comes back can meet an answer up
   * to a cycle old -- and On Air is the one screen whose whole job is
   * saying what is happening NOW. `homeassistant.update_entity` is Home
   * Assistant's own supported way to ask a coordinator for a fresh read;
   * it costs one bounded backend call and touches no playback.
   *
   * Bounded twice: only on arrival, and never more than once every
   * REHYDRATE_MIN_MS, so holding down a nav button cannot become a poll
   * loop against the backend.
   */
  _rehydrateOnAir() {
    const now = Date.now();
    if (this._rehydratedAt && now - this._rehydratedAt < REHYDRATE_MIN_MS) return;
    this._rehydratedAt = now;
    const ids = ["now_playing", "dj_status", "output", "station"]
      .map((k) => this._entityMap && this._entityMap[k])
      .filter(Boolean);
    if (!ids.length || !this._hass) return;
    // Fire and forget: a refusal (an entity mid-reload, say) must not
    // interrupt a screen that already has an answer to draw.
    Promise.resolve(
      this._hass.callService("homeassistant", "update_entity",
                             { entity_id: ids })
    ).catch(() => {});
  }

  // --- album palette (DOM side) ------------------------------------------
  /* Extraction is a side effect of artwork CHANGING, never of rendering.
   * One image load and one 32x32 draw per sleeve, the answer cached by
   * URL, and every failure path -- no artwork, a host that refuses
   * cross-origin reads, a decode error -- lands on the house theme. The
   * interface is readable before this resolves and readable if it never
   * does. */
  _syncPalette() {
    const url = this._artUrl();
    const key = url || "";
    if (key === this._artKey) return;
    this._artKey = key;
    if (!url) { this._applyTheme(null); return; }
    const cached = ParlorwaveRadioPanel._paletteCache.get(key);
    if (cached) { this._applyTheme(cached); return; }
    this._extractTheme(url).then((theme) => {
      const cache = ParlorwaveRadioPanel._paletteCache;
      cache.set(key, theme);
      if (cache.size > ART_CACHE_MAX) cache.delete(cache.keys().next().value);
      if (this._artKey === key) this._applyTheme(theme);
    }).catch(() => { if (this._artKey === key) this._applyTheme(null); });
  }

  _extractTheme(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      // Required for a readable canvas. Without it the draw succeeds and
      // the READ throws, so a host that sends no CORS header simply gets
      // no theme -- nothing here weakens that boundary to get a colour.
      img.crossOrigin = "anonymous";
      img.onerror = () => reject(new Error("artwork load failed"));
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = ART_SAMPLE; c.height = ART_SAMPLE;
          const g = c.getContext("2d", { willReadFrequently: true });
          g.drawImage(img, 0, 0, ART_SAMPLE, ART_SAMPLE);
          resolve(themeFromPixels(g.getImageData(0, 0, ART_SAMPLE, ART_SAMPLE).data));
        } catch (e) { reject(e); }
      };
      img.src = url;
    });
  }

  /* The theme lives on the HOST element, not inside the shadow tree: a
   * render replaces the shadow content wholesale, and the room must not
   * flicker back to house colours every time the panel redraws. */
  _applyTheme(theme) {
    const t = theme || HOUSE_THEME;
    this._theme = t;
    const set = (k, v) => this.style.setProperty(k, v);
    set("--pw-art-accent", t.accent);
    set("--pw-art-bg", t.bg);
    set("--pw-art-bg-deep", t.bgDeep);
    set("--pw-art-glow", t.glow);
    set("--pw-art-muted", t.muted);
    if (this._mouth) {
      this._mouth.accent = t.accent;
      this._mouthDraw(this._mouth.tSec);
    }
  }

  // --- broadcast state ----------------------------------------------------
  /* What the station is doing, in the words a listener would use, derived
   * only from state the backend actually publishes. No countdown is
   * invented: the "in N min" line appears when, and only when, the engine
   * reports seconds_to_air.
   *
   * DJ ENABLED IS NOT DJ SPEAKING. "Speaking now" is said on two facts and
   * nothing else: the DJ engine's own status is on_air, or the Now
   * Playing card says the current item is a break of ours whose lifecycle
   * is `airing`. A card whose kind is dj but whose lifecycle is `spent` is
   * a tombstone the queue rewound onto -- a second of silence -- and is
   * not speech; neither is the DJ switch being on, a route-shaped URL, or
   * a title that says "DJ break". The same rule names a bulletin: the
   * schedule, through the card's lifecycle, and never the route alone. */
  _broadcastState() {
    const jv = this._djStatus, dj = this._dj, p = this._player;
    const jvAttrs = (jv && jv.attributes) || {};
    const now = this._nowCard;
    const na = (now && now.attributes) || {};
    // The SAME verdict the banner uses -- the readiness document, not the
    // service's raw problem list. A fresh installation that has not yet
    // been given a voice is unfinished setup, and setup does not turn the
    // stage light red: the readiness model keeps a problem a setup step is
    // waiting on out of `blockers` for exactly this reason.
    const readiness = this._readiness();
    const problems = (readiness && readiness.blockers) || [];
    const outName = p ? (p.attributes.friendly_name || p.entity_id) : null;
    const playing = na.state === "playing"
      || (p && ["playing", "buffering"].includes(p.state));
    const paused = !playing && ((na.state === "paused") || (p && p.state === "paused"));
    if (problems.length) {
      // the banner above already carries the same blocker, in the same
      // words, with somewhere to go; repeating it here would say it twice,
      // in a style meant for two
      return { label: "Needs attention", tone: "alert", detail: null };
    }
    const attention = this._attentionStep();
    if (attention) {
      // A problem a setup step adopted (Music Assistant not answering, its
      // token refused): no banner carries it, so the state line does, in the
      // step's own words, with the way to Settings.
      return { label: "Needs attention", tone: "alert", detail: attention.detail || attention.label,
               action: "settings" };
    }
    if (this._queueEnded()) {
      return { label: "Queue Ended", tone: "idle", detail: outName };
    }
    const status = jv && jv.state;
    const airing = na.lifecycle === "airing";
    if (na.kind === "announcement" && airing) {
      // Operator programming on the air: the lamp lights exactly as for
      // DJ speech, under the word a listener would use for it.
      const voice = this._voice && this._voice.state;
      return { label: "Announcement", tone: "onair", lamp: true,
               detail: voice && voice !== "unknown" ? voice : null };
    }
    if (status === "on_air" || (na.kind === "dj" && airing)) {
      const voice = this._voice && this._voice.state;
      return { label: "Speaking now", tone: "onair", lamp: true,
               detail: voice && voice !== "unknown" ? voice : null };
    }
    if (playing && na.kind === "news" && airing) {
      return { label: "News", tone: "onair", lamp: true, detail: outName };
    }
    if (status === "preparing" || status === "rendering") {
      return { label: "DJ preparing", tone: "busy", detail: outName };
    }
    // `ready` is a break that is written and rendered but NOT yet in the
    // queue -- it waits for the song's tail to open the insertion gate.
    // `up_next` is one Music Assistant already holds as the next item.
    // Two words, because one of them is a promise and the other a fact.
    if (status === "ready") {
      return { label: "DJ ready", tone: "busy", detail: outName };
    }
    if (status === "up_next") {
      return { label: "DJ up next", tone: "busy", detail: outName };
    }
    if (playing) return { label: "Playing", tone: "live", detail: outName };
    if (paused) return { label: "Paused", tone: "idle", detail: outName };
    if (readiness && readiness.state === "needs_setup") {
      return { label: "Needs setup", tone: "setup",
               detail: `${readiness.complete} of ${readiness.total} setup steps done` };
    }
    if (dj && dj.state === "off") {
      return { label: "DJ off", tone: "idle",
               detail: "Switch the DJ on to hear breaks between songs" };
    }
    return { label: "DJ standing by", tone: "standby",
             detail: "Waiting for music on a DJ-enabled speaker" };
  }

  /* "2 min ago" from a station-local stamp, or null. Relative time only
   * when it is genuinely recent; older breaks keep their clock time.
   * A naive stamp is station-local, so it is parsed as local time -- never
   * as UTC, which would make every one read hours old. A browser in
   * another zone lands outside the hour and falls back to the clock. */
  _agoText(iso) {
    if (!iso) return null;
    try {
      const d = new Date(iso);
      const mins = Math.floor((Date.now() - d.getTime()) / 60000);
      if (!isFinite(mins) || mins < 0) return null;
      if (mins < 1) return "just now";
      if (mins < 60) return `${mins} min ago`;
      return null;
    } catch (e) { return null; }
  }

  // --- render helpers ----------------------------------------------------
  _esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  _chip(label, value) {
    if (value == null || value === "" || value === "unknown") return "";
    return `<span class="chip"><b>${this._esc(label)}</b> ${this._esc(value)}</span>`;
  }

  /* Who hosts the next DJ break. The voice picker's own state is
   * the live answer -- an automatic shift changes the DJ by writing that
   * same selection, so the chip follows a shift exactly as it follows a
   * manual change. When the backend says that voice cannot host, breaks
   * use the default voice, and the chip says so rather than naming a DJ
   * nobody will hear. */
  _djChipName() {
    const dj = (this._voiceLib || {}).dj || null;
    const e = this._voice;
    const picked = e && e.state && !["unknown", "unavailable"].includes(e.state)
      ? e.state : null;
    const name = picked || (dj && dj.name) || null;
    if (dj && dj.in_force === false && (!picked || picked === dj.name)) return "Default voice";
    return name;
  }

  _busyAttr(key) { return this._busy === key ? "disabled" : ""; }

  _localTime(iso) {
    try {
      const d = new Date(iso.includes("T") && !iso.includes("+") && !iso.endsWith("Z")
        ? iso + "Z" : iso);
      // the Parlorwave Radio service stamps are station-local naive; render them verbatim.
      if (!iso.includes("+") && !iso.endsWith("Z")) {
        const m = iso.match(/T(\d{2}):(\d{2})/);
        if (m) { const h = +m[1]; return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? "AM" : "PM"}`; }
      }
      return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    } catch (e) { return iso; }
  }

  // --- Problems & Readiness ---------------------------------------------
  /* THE ONE BANNER, AND IT DIAGNOSES NOTHING.
   *
   * It used to render `dj_status.attributes.problems` -- the service's own
   * structured problems, verbatim. Those are written for whoever deploys
   * the service: they name environment variables, service URLs, HTTP
   * status codes and the internal speech engines, and they said all of it
   * across the top of all five screens. On Settings they also said it a
   * second time, three lines above the same problem rewritten for a person.
   *
   * Now it renders the readiness document the integration already builds
   * (readiness.py) -- the same blockers, the same sentences, the same
   * routes as Settings' own "To fix" card. There is exactly one health
   * translation in this product and it is not in this file.
   *
   * It is NOT drawn on Settings: that screen owns the full verdict, the
   * checklist and the To fix list, and a banner repeating its first line
   * is the duplication this change exists to remove. */
  _renderProblems() {
    if (this._view === "settings") return "";
    const r = this._readiness();
    const blockers = (r && r.blockers) || [];
    if (!blockers.length) return "";
    return `<div class="problems-banner">
      ${blockers.map((b) => `
        <div class="problem-card error">
          <div class="problem-icon" aria-hidden="true">⚠️</div>
          <div class="problem-body">
            <div class="problem-summary">${this._esc(b.title)}</div>
            ${b.detail ? `<div class="problem-action">${this._esc(b.detail)}</div>` : ""}
            ${b.where ? `<div class="row tight">${this._where(b.where)}</div>` : ""}
          </div>
        </div>`).join("")}
    </div>`;
  }

  // --- On Air ------------------------------------------------------------
  /* The live radio. Everything above the fold answers "what is playing and
   * what is my station doing"; configuration lives below it, deliberately
   * quieter, because this is a screen meant to be left open on a desk, a
   * wall tablet or a phone. */
  _renderOnAir() {
    const p = this._player, st = this._station, jv = this._djStatus;
    const dj = this._dj;
    const now = this._nowCard;
    const na = (now && now.attributes) || {};
    const playing = (na.state === "playing")
      || (p && ["playing", "paused", "buffering"].includes(p.state));
    const tr = this._track();
    const kind = tr.kind;
    const title = tr.title;
    const artist = tr.artist;
    const album = tr.album;
    const stationName = st && st.state !== "none" ? st.state : null;
    const jvAttrs = (jv && jv.attributes) || {};
    const bs = this._broadcastState();
    // The engine's own estimate, in its own units, or nothing. It is 0
    // while a break is on the air and that is not "in 0 min": while the
    // DJ is speaking there is no NEXT break to promise, so no chip.
    const nextIn = jvAttrs.seconds_to_air != null && !bs.lamp
      ? this._runWords(Math.max(0, jvAttrs.seconds_to_air)) : null;
    const pr = this._progress();
    const artUrl = this._artUrl();
    const enabledOutputs = jvAttrs.outputs_enabled || [];
    const hasEnabledOutputs = enabledOutputs.length > 0;

    // KEYED ON THE TRACK, not only on the URL. A browser reuses an <img>
    // whose src string did not change, and two different tracks can be
    // served the same artwork address -- which is how the previous cover
    // stayed on screen after the song moved on.
    const art = artUrl
      ? `<img class="art" key="${this._esc(tr.uri || artUrl)}"
              src="${this._esc(artUrl)}"
              alt="${this._esc(album || title || "Album artwork")}">`
      : kind === "dj" ? this._renderDjArt()
      : `<div class="art art-empty" role="img" aria-label="No artwork">${KIND_ICON[kind] || "♪"}</div>`;

    return `
      <section class="stage" aria-label="Now on air">
        <div class="stage-glow" aria-hidden="true"></div>
        <div class="stage-grid">
          <div class="art-wrap">${art}</div>
          <div class="stage-meta">
            <div class="state-line ${this._esc(bs.tone)}">
              ${bs.lamp ? '<span class="lamp" aria-hidden="true"></span>' : ""}
              <span class="state-label">${this._esc(bs.label)}</span>
              ${bs.detail ? `<span class="state-detail">${this._esc(bs.detail)}</span>` : ""}
              ${bs.tone === "setup" || bs.action === "settings" ? `<span class="state-action">· ${this._go("settings", "Open Settings")}</span>` : ""}
            </div>
            <h2 class="track-title">${this._esc(title || (playing ? "" : "Nothing playing"))}</h2>
            <div class="track-sub">${this._esc(artist || "")}${album ? `<span class="track-album"> · ${this._esc(album)}</span>` : ""}</div>
            ${pr ? `<div class="progress"><div class="progress-bar">
                <div id="progress-fill" style="width:${(100 * pr.pos / pr.duration).toFixed(2)}%"></div></div>
                <span id="progress-clock" class="progress-clock">${this._mmss(pr.pos)} / ${this._mmss(pr.duration)}</span></div>` : ""}
            <div class="facts">
              ${this._chip("Speaker", p ? (p.attributes.friendly_name || p.entity_id) : null)}
              ${this._chip("Station", stationName || this._stationIdentityName())}
              ${this._chip("DJ", this._djChipName())}
              ${this._chip("Next break", nextIn ? `in ${nextIn}` : null)}
            </div>
            ${this._renderVolume()}
            <div class="stage-actions">
              ${this._renderTransport(playing)}
              <button class="ghost ${this._drawer === "lyrics" ? "on" : ""}" id="drawer-lyrics"
                      aria-pressed="${this._drawer === "lyrics"}" aria-label="Lyrics">Lyrics</button>
              <button class="ghost ${this._drawer === "queue" ? "on" : ""}" id="drawer-queue"
                      aria-pressed="${this._drawer === "queue"}" aria-label="Queue">Queue</button>
            </div>
          </div>
        </div>
        ${this._renderDrawer()}
      </section>

      ${this._renderConsole(dj, bs, hasEnabledOutputs)}`;
  }

  /* --- Rotary hardware knobs ---------------------------------------------
   * Physical radio styling for the console: dark brushed metallic dials
   * with amber LED halo and precision radial graduations. */
  _knobSvg(side, active) {
    const dim = !active ? " dim" : "";
    return `<svg class="knob-ticks${dim}" viewBox="0 0 160 160" aria-hidden="true">
      <circle cx="80" cy="80" r="56" class="knob-led-ring" />
      <g class="knob-tick-group">
        <line x1="37.6" y1="122.4" x2="29.1" y2="130.9" class="tick-major" />
        <line x1="31.5" y1="115.3" x2="25.8" y2="119.4" class="tick-minor" />
        <line x1="26.5" y1="107.2" x2="20.3" y2="110.4" class="tick-minor" />
        <line x1="22.9" y1="98.5" x2="16.3" y2="100.7" class="tick-minor" />
        <line x1="20.7" y1="89.4" x2="13.8" y2="90.5" class="tick-minor" />
        <line x1="20.0" y1="80.0" x2="8.0" y2="80.0" class="tick-major" />
        <line x1="20.7" y1="70.6" x2="13.8" y2="69.5" class="tick-minor" />
        <line x1="22.9" y1="61.5" x2="16.3" y2="59.3" class="tick-minor" />
        <line x1="26.5" y1="52.8" x2="20.3" y2="49.6" class="tick-minor" />
        <line x1="31.5" y1="44.7" x2="25.8" y2="40.6" class="tick-minor" />
        <line x1="37.6" y1="37.6" x2="29.1" y2="29.1" class="tick-major" />
        <line x1="44.7" y1="31.5" x2="40.6" y2="25.8" class="tick-minor" />
        <line x1="52.8" y1="26.5" x2="49.6" y2="20.3" class="tick-minor" />
        <line x1="61.5" y1="22.9" x2="59.3" y2="16.3" class="tick-minor" />
        <line x1="70.6" y1="20.7" x2="69.5" y2="13.8" class="tick-minor" />
        <line x1="80.0" y1="20.0" x2="80.0" y2="8.0" class="tick-major" />
        <line x1="89.4" y1="20.7" x2="90.5" y2="13.8" class="tick-minor" />
        <line x1="98.5" y1="22.9" x2="100.7" y2="16.3" class="tick-minor" />
        <line x1="107.2" y1="26.5" x2="110.4" y2="20.3" class="tick-minor" />
        <line x1="115.3" y1="31.5" x2="119.4" y2="25.8" class="tick-minor" />
        <line x1="122.4" y1="37.6" x2="130.9" y2="29.1" class="tick-major" />
        <line x1="128.5" y1="44.7" x2="134.2" y2="40.6" class="tick-minor" />
        <line x1="133.5" y1="52.8" x2="139.7" y2="49.6" class="tick-minor" />
        <line x1="137.1" y1="61.5" x2="143.7" y2="59.3" class="tick-minor" />
        <line x1="139.3" y1="70.6" x2="146.2" y2="69.5" class="tick-minor" />
        <line x1="140.0" y1="80.0" x2="152.0" y2="80.0" class="tick-major" />
        <line x1="139.3" y1="89.4" x2="146.2" y2="90.5" class="tick-minor" />
        <line x1="137.1" y1="98.5" x2="143.7" y2="100.7" class="tick-minor" />
        <line x1="133.5" y1="107.2" x2="139.7" y2="110.4" class="tick-minor" />
        <line x1="128.5" y1="115.3" x2="134.2" y2="119.4" class="tick-minor" />
        <line x1="122.4" y1="122.4" x2="130.9" y2="130.9" class="tick-major" />
      </g>
    </svg>`;
  }

  /* The right knob's accessible name says what the speaker is now, and what
   * the keys do -- the LCD header's facts, for a screen reader. */
  _rightKnobLabel() {
    const out = this._output;
    const now = out && out.state && !["unavailable", "unknown"].includes(out.state) ? out.state : null;
    if (this._outputMode) return `Speaker list: ${this._outputSay()}`;
    return `Active DJ speaker${now ? `: ${now}` : ""}. Enter opens the speaker list; arrow keys browse the saved stations.`;
  }

  _renderRightKnob(out, active) {
    const turning = this._knobTurning === "right" || this._outputMode ? " knob-turning" : "";
    const angle = this._rightKnobAngle || 0;
    return `
      <div class="knob-housing">
        ${this._knobSvg("right", !!active)}
        <button class="knob-btn right-knob${turning}" id="right-knob"
                type="button" aria-label="${this._esc(this._rightKnobLabel())}">
          <span class="knob-halo" aria-hidden="true"></span>
          <span class="knob-face" aria-hidden="true" style="transform: rotate(${angle}deg);">
            <svg class="knob-indicator-svg" viewBox="0 0 160 160" aria-hidden="true">
              <circle cx="80" cy="80" r="56" class="knob-arc-segment right-arc" />
            </svg>
          </span>
        </button>
      </div>`;
  }

  /* THE CENTER SCRIPT LOGO BADGE:
   * A vintage radio mark centered on the console faceplate above the mouth.
   * Default: the ParlorWave wordmark, the production vector, as an image.
   * Double-click: the configured station name, engraved on a brass plate
   *   whose metal is an image and whose lettering is live text, fitted to
   *   the name after it is rendered (_fitCenterBadge).
   * Double-click again: hidden.
   * Cycles back to the wordmark. The button's accessible name is always the
   * full configured value; the plate's uppercase is presentation only. */
  _renderCenterBadge() {
    const mode = this._centerLogoMode || "logo";
    const isHidden = mode === "hidden";
    const isStation = mode === "station";
    const station = isStation ? (this._stationIdentityName() || "ParlorWave") : "";
    const label = isHidden ? "Radio badge hidden" : (isStation ? station : "ParlorWave");
    let face;
    let twoLine = false;
    // WHERE THE BADGE ANSWERS A POINTER: on its metal, not on the
    // whole 520 x 150 cell. The cell's transparent margin used to take
    // clicks meant for the knobs beside it (at 900, 768, 430 and 360 px
    // part of each visible knob routed to the badge). Cell units, with a
    // small margin; nothing here changes what is drawn.
    // the wordmark's ink (65, 30, 379 x 86), scaled about the cell's centre
    // and lowered exactly as .console-badge-emblem draws it
    // -- covering it both where it is lowered and on a phone, where it is not
    let hit = { x: 260 + (65 - 260) * PW_EMBLEM_SCALE,
                y: 75 + (30 - 75) * PW_EMBLEM_SCALE,
                w: 379 * PW_EMBLEM_SCALE, h: 86 * PW_EMBLEM_SCALE + 150 * PW_EMBLEM_DROP };
    if (isStation) {
      const fit = (this._plateFit && this._plateFit.name === station) ? this._plateFit.fit : null;
      face = this._renderStationPlate(station, fit);
      twoLine = !!(fit && fit.lines && fit.lines[1]);
      this._hookPlateFont();
      const W = (fit && fit.width) || PW_PLATE.minWidth;
      const H = (fit && fit.height) || PW_PLATE.height;
      hit = { x: PW_PLATE.centerX - W / 2, y: PW_PLATE.centerY - H / 2, w: W, h: H };
    } else {
      face = `<img class="console-badge-emblem" src="${PW_EMBLEM_URL}" alt="" draggable="false">`;
    }
    const m = 4;
    const pc = (v, of) => `${(v / of * 100).toFixed(2)}%`;
    const hitSpan = `<span class="console-badge-hit" aria-hidden="true" style="left:${pc(hit.x - m, 520)}; top:${pc(hit.y - m, 150)}; width:${pc(hit.w + 2 * m, 520)}; height:${pc(hit.h + 2 * m, 150)};"></span>`;
    return `
      <div class="console-badge${isHidden ? " badge-hidden" : ""}${isStation ? " badge-station" : ""}${twoLine ? " badge-two-line" : ""}"
           id="console-badge"
           role="button"
           tabindex="0"
           aria-label="${this._esc(label)}">${face}${hitSpan}</div>`;
  }

  /* The plate as first painted: with the last fit measured for this name,
   * or the smallest plate at the standard setting until the measurement
   * lands. Two text pairs are always present (line 1, line 2); a one-line
   * name leaves the second pair empty. */
  _renderStationPlate(name, fit) {
    const P = PW_PLATE;
    const f = fit || { lines: [name], size: P.text.size, tracking: P.text.tracking,
                       width: P.minWidth, height: P.height, baselines: [P.text.baseline] };
    let texts = "";
    for (let i = 0; i < 2; i++) {
      const line = this._esc(f.lines[i] || "");
      const y = f.baselines[i] != null ? f.baselines[i] : P.text.baseline;
      texts += `<text class="pw-plate-hi" data-line="${i}" x="${P.centerX + 0.7}" y="${y + 0.8}" font-size="${f.size}" letter-spacing="${f.tracking}">${line}</text>`
        + `<text class="pw-plate-ink" data-line="${i}" x="${P.centerX}" y="${y}" font-size="${f.size}" letter-spacing="${f.tracking}">${line}</text>`;
    }
    return `<span class="console-badge-plate" aria-hidden="true">`
      + `<img class="console-badge-plate-body" src="${plateBodyUrl(f.width, f.height)}" alt="" draggable="false">`
      + `<svg class="console-badge-plate-text" viewBox="0 0 520 150" focusable="false">${texts}</svg></span>`;
  }

  _plateBodyUrl(width, height) {
    return plateBodyUrl(width, height);
  }

  _hookPlateFont() {
    if (this._plateFontHooked) return;
    this._plateFontHooked = true;
    ensurePlateFont(() => {
      if (this.isConnected === false) return;
      this._fitCenterBadge();
      this._fitDeckPlate();
    });
  }

  /* Fits a station name on the plate -- the spec's steps, in cell units:
   * the standard tracking, then tight tracking, then the type shrinks one
   * unit at a time to 16, then two lines. `measure(text, size, tracking)`
   * is the width of a line as rendered; it is injected so the rule can be
   * exercised without a browser. Nothing is ever truncated: a name longer
   * than even two lines at the plate's widest is reported as overflow and
   * still rendered whole. On a small screen, where shrinking would take the
   * type under the legible floor, two lines come first. */
  _fitPlateName(name, measure, scale, floorPx) {
    const P = PW_PLATE, T = P.text, avail = P.zoneMax - 2 * P.pad;
    const s = scale > 0 ? scale : 1;
    const floor = floorPx > 0 ? floorPx : 0;
    const steps = [[T.size, T.tracking], [T.size, T.minTracking]];
    for (let size = T.size - 1; size >= T.minSize; size--) steps.push([size, T.minTracking * size / T.size]);
    for (const [size, tracking] of steps) {
      if (size < T.size && size * s < floor) break;
      const w = measure(name, size, tracking);
      if (w <= avail) {
        return { lines: [name], size, tracking: Math.round(tracking * 100) / 100,
                 width: Math.max(P.minWidth, w + 2 * P.pad), height: P.height,
                 baselines: [T.baseline], overflow: false };
      }
    }
    const parts = this._splitPlateName(name);
    const a = parts[0], b = parts[1];
    const L = P.twoLine;
    const w = Math.max(measure(a, L.size, L.tracking), b ? measure(b, L.size, L.tracking) : 0);
    return { lines: b ? [a, b] : [a], size: L.size, tracking: L.tracking,
             width: Math.min(P.zoneMax, Math.max(P.minWidth, w + 2 * P.pad)),
             height: b ? L.height : P.height,
             baselines: b ? L.baselines.slice() : [T.baseline],
             overflow: w + 2 * P.pad > P.zoneMax };
  }

  /* The split at a space that leaves the shortest longest line. */
  _splitPlateName(name) {
    const words = String(name).split(" ").filter(Boolean);
    if (words.length < 2) return [String(name), ""];
    let best = null;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(" "), b = words.slice(i).join(" ");
      const m = Math.max(a.length, b.length);
      if (!best || m < best.m) best = { m, a, b };
    }
    return [best.a, best.b];
  }

  /* Measures the station name as rendered and sizes the plate to it. Runs
   * after a render in station mode, again when the plate's font arrives,
   * and when the badge's on-screen size changes (a breakpoint). It is one
   * layout read; the result is cached by name, scale and font, so a
   * routine hass update re-renders the same markup and measures nothing. */
  _fitCenterBadge() {
    if ((this._centerLogoMode || "logo") !== "station") return;
    const badge = this.shadowRoot && this.shadowRoot.getElementById
      && this.shadowRoot.getElementById("console-badge");
    if (!badge || typeof badge.querySelector !== "function") return;
    const ink = badge.querySelector('.pw-plate-ink[data-line="0"]');
    if (!ink || typeof ink.getComputedTextLength !== "function") return;
    const rect = badge.getBoundingClientRect ? badge.getBoundingClientRect() : null;
    if (!rect || !(rect.width > 0)) return;           // not laid out: nothing to measure against
    const name = this._stationIdentityName() || "ParlorWave";
    const scale = rect.width / 520;
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    const floorPx = dpr >= 2 ? PW_PLATE.floorPx.hiDpi : PW_PLATE.floorPx.loDpi;
    const key = name + "\u0000" + scale.toFixed(3) + "\u0000" + (plateFontState.ready ? "1" : "0");
    if (this._plateFit && this._plateFit.key === key) return;
    const measure = (text, size, tracking) => {
      ink.setAttribute("font-size", size);
      ink.setAttribute("letter-spacing", tracking);
      ink.textContent = text;
      return ink.getComputedTextLength();
    };
    const fit = this._fitPlateName(name, measure, scale, floorPx);
    this._plateFit = { key, name, fit };
    this._applyPlateFit(badge, fit);
  }

  _applyPlateFit(badge, fit) {
    const P = PW_PLATE;
    for (let i = 0; i < 2; i++) {
      const line = fit.lines[i] || "";
      const y = fit.baselines[i] != null ? fit.baselines[i] : P.text.baseline;
      const hi = badge.querySelector('.pw-plate-hi[data-line="' + i + '"]');
      const ink = badge.querySelector('.pw-plate-ink[data-line="' + i + '"]');
      if (hi) { hi.setAttribute("font-size", fit.size); hi.setAttribute("letter-spacing", fit.tracking); hi.setAttribute("y", y + 0.8); hi.textContent = line; }
      if (ink) { ink.setAttribute("font-size", fit.size); ink.setAttribute("letter-spacing", fit.tracking); ink.setAttribute("y", y); ink.textContent = line; }
    }
    const body = badge.querySelector(".console-badge-plate-body");
    const url = plateBodyUrl(fit.width, fit.height);
    if (body && body.getAttribute("src") !== url) body.setAttribute("src", url);
    if (badge.classList) {
      if (fit.lines[1]) badge.classList.add("badge-two-line");
      else badge.classList.remove("badge-two-line");
    }
  }

  /* THE BROADCAST CONSOLE: one object under the stage.
   *
   * The DJ control, the Mouth and the speaker control on one deck, and the
   * Air Check on the strip beneath them -- the face of the station, where
   * the stage above it is the face of the record. It replaces two cards
   * that used to sit here (a switch on its own, and a "DJ controls" card
   * holding the speaker select) with nothing removed: the same switch,
   * writing the same entity; the same select, with the same binding; the
   * same Air Check, from the same two rows of the engine's.
   *
   * What is NOT on it, on purpose: a second copy of the track's name (the
   * stage already says it), and any control that shapes what a break IS
   * (Booth's question). */
  /* THE LCD HEADER: the console's ONE status line. Left, the DJ:
   * what is on the air when the ON-AIR lamp is lit (the broadcast state's
   * own verdict), otherwise the DJ switch entity's own state. Right, the
   * speaker the DJ follows: the output select entity's own state. Nothing
   * here is inferred from the knobs or from what was last asked for: a
   * change in flight keeps the real value and only marks it pending. Pure. */
  _lcdStatus(dj, bs, hasEnabledOutputs) {
    const lamp = !!(bs && bs.lamp);
    let left;
    if (lamp && bs.label === "Announcement") left = { text: "ANNOUNCEMENT", tone: "air" };
    else if (lamp && bs.label === "News") left = { text: "NEWS", tone: "air" };
    else if (lamp) left = { text: "DJ SPEAKING", tone: "air" };
    else if (!dj || ["unavailable", "unknown"].includes(dj.state)) left = { text: "DJ UNAVAILABLE", tone: "dim" };
    else if (dj.state === "on") left = { text: "DJ ON", tone: "on" };
    else left = { text: "DJ OFF", tone: "off" };
    left.pending = !!(dj && (this._busy === dj.entity_id || this._djHoldActive()));
    const out = this._output;
    let right;
    if (!out) right = { text: "NO SPEAKER", tone: "dim" };
    else if (out.state === "unavailable") right = { text: "SPEAKER UNAVAILABLE", tone: "dim" };
    else if (!hasEnabledOutputs) right = { text: "NO SPEAKERS ENABLED", tone: "dim" };
    else if (!out.state || out.state === "unknown") right = { text: "NO SPEAKER CHOSEN", tone: "dim" };
    else right = { text: out.state, tone: "on" };
    right.pending = !!(out && this._busy === out.entity_id);
    return { left, right };
  }

  _renderLcdStatus(dj, bs, hasEnabledOutputs) {
    // Called with the console's own state; alone (a test, a partial
    // render), it reads the same entities the console does.
    if (dj === undefined) dj = this._dj;
    if (bs === undefined) bs = this._broadcastState();
    if (hasEnabledOutputs === undefined) hasEnabledOutputs = this._outputOptions().length > 0;
    const st = this._lcdStatus(dj, bs, hasEnabledOutputs);
    const part = (x, cls) => `<span class="${cls} lcd-tone-${x.tone}${x.pending ? " lcd-pending" : ""}">`;
    return `
        <div class="lcd-status" aria-hidden="true">
          ${part(st.left, "lcd-status-dj")}<span class="lcd-lamp"></span><span class="lcd-status-text">${this._esc(st.left.text)}</span></span>
          ${part(st.right, "lcd-status-out")}${this._nameHTML(st.right.text, "lcd-status-text")}<span class="lcd-lamp"></span></span>
        </div>`;
  }

  _renderConsole(dj, bs, hasEnabledOutputs) {
    const out = this._output;
    const speaker = out
      ? this._selectRow("output", out, "Active DJ speaker",
          hasEnabledOutputs ? "Which enabled speaker the DJ follows right now."
                            : "No speakers are enabled for the DJ yet.")
      : `<div class="control"><div><div class="label">Active DJ speaker</div>
           <div class="hint">Not available yet.</div></div></div>`;
    const hasOut = !!(out && out.state && !["unavailable", "unknown"].includes(out.state));
    const fp = this._faceplate || "midnight";
    const rightActive = !!((hasEnabledOutputs && hasOut) || this._outputMode);
    const r = this._readiness();
    const attention = this._attentionStep();
    return `
      <section class="console" data-fp="${fp}" aria-label="Broadcast console">
        <div class="console-faceplate console-fp-${fp}" id="console-faceplate">
          ${this._renderCenterBadge()}
          <div class="console-deck">
            ${this._renderDjSwitch(dj, bs)}
            ${this._renderMouth(dj, bs, hasEnabledOutputs)}
            <div class="console-spk pw-knob-unit right-knob-unit">
              ${this._renderRightKnob(out, rightActive)}
              <span class="knob-caption" aria-hidden="true">Tuning · Speakers</span>
              <div class="console-out controls visually-hidden">${speaker}</div>
              <div class="knob-tooltip" role="tooltip">Turn: stations · Push twice: speakers</div>
            </div>
          </div>
        </div>
        ${this._renderLastBreak()}
        ${attention ? `
          <div class="setup-callout console-foot">⚠️ <b>Needs attention.</b>
            ${this._esc(attention.detail || attention.label)}
            ${this._go("settings", "Open Settings")}.</div>
        ` : r && r.state === "needs_setup" ? `
          <div class="setup-callout console-foot">⚠️ <b>${this._esc(r.headline || "Needs setup")}</b>
            (${r.complete} of ${r.total} steps done).
            ${this._esc(r.detail)}
            ${this._go("settings", "Open Settings to finish setup")}.</div>
        ` : !hasEnabledOutputs ? `
          <div class="setup-callout console-foot">⚠️ <b>No speakers are enabled for the DJ.</b>
            Choose them under <b>Speakers ParlorWave may DJ on</b>, in
            ${this._go("settings")}.</div>
        ` : ""}
      </section>`;
  }


  /* IS AUDIO MOVING, AND IS IT A PROGRAMME VOICE?
   *
   * One rule, one answer, read by the Mouth -- the console's one display.
   * It used to have a second reader, a small bar meter beside the state
   * line, and two displays of one fact is one display too many: the Mouth
   * says it larger, in the console, where the station's own controls are.
   * The meter was removed rather than reworded.
   *
   * MOTION MEANS AUDIO IS MOVING, and nothing else. This asks a narrower
   * question than On Air's `playing`, which is deliberately generous --
   * it counts paused and buffering, because a paused player still has a
   * track, artwork, a progress bar and working transport buttons. For
   * those that breadth is right. For a display it was simply wrong: the
   * bars went on swaying over a paused speaker, animating silence.
   *
   * The PLAYER is the authority when there is one -- it is the nearest
   * thing to the speaker -- and the backend's Now Playing card answers
   * only when no player entity is resolved. Paused and stopped both
   * settle the display.
   */
  _audioMode(bs, na, player) {
    const pstate = player ? player.state : null;
    const audible = pstate ? (pstate === "playing" || pstate === "buffering")
                           : na.state === "playing";
    // The lamp is the ONE authority on speech (see _broadcastState). A
    // card kind of dj without the lamp is a spent break the queue rewound
    // onto, and a display that talked over its silence would be lying.
    const speaking = audible && !!(bs && bs.lamp);
    return { mode: speaking ? "speaking" : audible ? "music" : "idle" };
  }

  /* THE DJ CONTROL: the console's illuminated push-button -- a studio
   * control, not a settings row.
   *
   * IT SAYS WHAT IT IS, WHICH IS NOT "SPEAKING NOW". This lights when the
   * between-song DJ is ENABLED -- a standing arrangement, not an event.
   * The authoritative "there is speech in the room this second" indicator
   * is the Mouth beside it and the state line above, and it stays that
   * way. So: illuminated when enabled, in the console's own amber -- never
   * the red of the ON-AIR lamp, which means something else and must keep
   * meaning it -- with its own word (DJ ON) and a subtitle that says
   * exactly what was switched on; visibly dark and inert when off. It
   * glows, it does not pulse, and it carries no lamp dot.
   *
   * ILLUMINATED MEANS CONFIRMED. The light follows the switch entity's
   * own state and nothing else. A press makes the control PENDING -- held,
   * marked busy, its light left exactly where it was -- until Home
   * Assistant reports the new state through the ordinary update; a refused
   * press leaves it where the backend says it is, with the refusal in the
   * notice. There is no optimistic ON, and no second write path: the
   * button is bound to the same _toggle the settings pill uses. */
  _renderDjSwitch(dj, bs) {
    const on = dj && dj.state === "on";
    // Before the panel has read its entity map (first paint, or Home
    // Assistant rebuilding a panel that was hidden) there is no switch to
    // look at yet: that is "connecting", not a service that stopped
    // answering.
    const connecting = !dj && !this._entityMap;
    const unavailable = !dj || ["unavailable", "unknown"].includes(dj.state);
    const pending = !!(dj && (this._busy === dj.entity_id || this._djHoldActive()));
    const live = !!(bs && bs.lamp);
    const word = connecting ? "DJ" : unavailable ? "DJ unavailable" : on ? "DJ ON" : "DJ OFF";
    const sub = connecting ? "Connecting to ParlorWave Radio…"
      : unavailable ? "ParlorWave Radio is not answering."
      : pending ? (on ? "Switching off\u2026" : "Switching on\u2026")
      : on ? "Between-song DJ enabled" : "The station plays music only";
    const v = this._volumeState();
    const held = this._heldVolume(v);
    const volLevel = this._volDrag != null ? this._volDrag
      : held != null ? held
      : ((v && typeof v.level === "number") ? v.level : KNOB_FALLBACK_LEVEL);
    const volDeg = Math.round(KNOB_ANGLE_MIN_DEG + volLevel * KNOB_ANGLE_SWEEP_DEG);
    const turning = this._knobTurning === "left" ? " knob-turning" : "";
    return `
      <div class="console-dj pw-knob-unit left-knob-unit">
        <div class="knob-housing">
          ${this._knobSvg("left", on)}
          <button class="dj-switch ${on ? "on" : "off"}${pending ? " pending" : ""}${turning}" id="dj-switch"
                  role="switch" aria-label="Between-song DJ"
                  aria-checked="${on ? "true" : "false"}"
                  aria-busy="${pending ? "true" : "false"}"
                  ${unavailable || pending ? "disabled" : ""}>
            <span class="knob-halo" aria-hidden="true"></span>
            <span class="dj-switch-glow" aria-hidden="true"></span>
            <span class="dj-face" aria-hidden="true" style="transform: rotate(${volDeg}deg);">
              <svg class="knob-indicator-svg" viewBox="0 0 160 160" aria-hidden="true">
                <circle cx="80" cy="80" r="56" class="knob-arc-segment left-arc" />
              </svg>
            </span>
            <span class="dj-switch-body visually-hidden">
              <span class="dj-switch-word">${word}</span>
              <span class="dj-switch-sub">${sub}</span>
              <span>The arrangement, not a live indicator: the DJ speaks between songs.</span>
              <span>A break is on the air now \u2014 the display beside this is the voice.</span>
              <span>Volume ${Math.round(volLevel * 100)} percent. Arrow keys change the volume; Enter switches the DJ.</span>
            </span>
          </button>
        </div>
        <span class="knob-caption" aria-hidden="true">Volume · DJ</span>
        <div class="knob-tooltip" role="tooltip">Turn: volume · Push twice: DJ on/off</div>
      </div>`;
  }

  /* BREAK LENGTH AND CADENCE ARE NOT HERE, ON PURPOSE. They shape what a
   * break IS, which is Booth's question ("what should my station sound
   * like?"); On Air answers "what is happening right now", and owns only
   * the two controls that are part of that -- whether the DJ is speaking
   * at all, and which speaker it is following. They were on both screens,
   * under two different labels, writing the same two settings.
   *
   * TRANSPORT IS NOT A CONFIGURATION CONTROL and so it is not covered by
   * that rule: play, pause, next and previous say what should happen to
   * the music on this screen, right now, which is exactly the question On
   * Air answers. They write no setting at all. */
  /* --- transport -------------------------------------------------------
   *
   * MUSIC ASSISTANT STILL OWNS PLAYBACK, and these buttons are how that
   * ownership is expressed rather than an exception to it. Each one is a
   * plain `media_player` service call on the Music Assistant player the
   * station is following. Music Assistant's own integration owns that
   * entity, so pressing Next here is the same event as pressing Next in
   * Music Assistant: the queue is advanced BY Music Assistant, and
   * nothing in Parlorwave Radio reads, rewrites or rebuilds it.
   *
   * There is deliberately no Parlorwave Radio transport endpoint. The
   * backend has never had one (its contract is that it never touches
   * transport), and adding one to serve five buttons would have made a
   * second authority over the queue out of a cosmetic feature.
   *
   * NOTHING HERE IS ASSUMED. Which buttons work is read from the
   * entity's own `supported_features` bitmask, which is the player's
   * answer and not ours; the play/pause button shows the state the
   * entity reports, never the state we last asked for. A control the
   * player does not support is rendered disabled with the reason on it,
   * because a button that silently does nothing is worse than one that
   * says why it cannot. */
  _transportState() {
    const p = this._player;
    if (!p) {
      return { player: null, why: "No Music Assistant speaker is selected yet." };
    }
    if (p.state === "unavailable") {
      return { player: p, unavailable: true,
               why: `${p.attributes.friendly_name || p.entity_id} is unavailable right now.` };
    }
    const sf = Number(p.attributes.supported_features || 0);
    return {
      player: p,
      playing: p.state === "playing",
      can: {
        prev: !!(sf & MP_PREVIOUS_TRACK),
        next: !!(sf & MP_NEXT_TRACK),
        pause: !!(sf & MP_PAUSE),
        play: !!(sf & MP_PLAY),
      },
    };
  }

  /* One transport button. `can` false means the PLAYER said it cannot do
   * this, which is a different sentence from "there is no player". */
  _tbtn(id, glyph, label, can, t) {
    const off = !t.player || t.unavailable || !can;
    const why = !t.player || t.unavailable ? t.why
      : (!can ? `${t.player.attributes.friendly_name || "This speaker"} does not support ${label.toLowerCase()}.` : label);
    return `<button class="icon" id="${id}" ${off ? "disabled" : ""}
            ${this._busyAttr("transport")} title="${this._esc(why)}"
            aria-label="${this._esc(label)}">${glyph}</button>`;
  }

  /* THUMBS. Taste-learning writes into the local Parlorwave music catalog:
   * a thumb raises or lowers a catalog track's standing, and the station
   * builder reads that standing the next time it picks music.
   *
   * MUSIC ASSISTANT HAS NO FEEDBACK CAPABILITY TO BORROW. Its Home
   * Assistant integration publishes no feedback, rating or favourite
   * service, and no music provider it serves advertises one (verified
   * against MA 2.10). So there is nothing provider-native
   * to call for a Pandora-style thumb, and this button will not pretend
   * otherwise: with no local catalog there is nothing to write to and
   * nothing that would read it, and it says so on the button rather than
   * disappearing or reporting a success that did not happen. */
  /* WHAT A THUMB CAN ACTUALLY REACH, asked before it is offered.
   *
   * Three different reasons a rating has nowhere to go, and they are not
   * the same sentence:
   *
   *   - no local catalog. Taste learning writes a track's standing into
   *     the local Parlorwave catalog and the station builder reads it
   *     back. With no catalog there is nothing to write to and nothing
   *     that would read it.
   *   - a DJ break or a bulletin is the current item. Program audio is
   *     not music and has no standing to raise.
   *   - nothing is playing at all.
   *
   * AND THE BACKSTOP IS NOT ON THIS SCREEN. Even with a catalog, the song
   * playing may not be IN it -- it can come from any provider Music
   * Assistant serves -- and the panel cannot know that from here. The
   * service answers how many rows it changed, and the integration turns
   * zero into a refusal the owner reads, so a thumb that recorded nothing
   * never shows a green Done. That is the rule the capability check here
   * cannot enforce on its own.
   */
  _thumbsState(playing) {
    const cat = this._catalog();
    if (!cat.usable) {
      // Since alpha.4: with no local catalog -- every
      // shipped install -- the thumbs have nowhere to record anything, so
      // they are not drawn at all rather than shown as two buttons that
      // never work. The reason stays here for anyone reading the code.
      return { can: false, hide: true, why: "Taste learning needs a local ParlorWave music catalog. Music Assistant does not offer a thumbs capability to use instead." };
    }
    const kind = this._track().kind;
    if (kind !== "music") {
      return { can: false, why: kind === "news"
        ? "A news bulletin cannot be rated \u2014 only the music can."
        : kind === "announcement"
        ? "An announcement cannot be rated \u2014 only the music can."
        : "A DJ break cannot be rated \u2014 only the music can." };
    }
    if (!playing) return { can: false, why: "Nothing is playing to rate." };
    return { can: true, why: null };
  }

  _renderThumbs(playing) {
    const st = this._thumbsState(playing);
    if (st.hide) return "";
    const off = !st.can;
    const t = (label) => this._esc(st.why || label);
    return `
      <button class="icon" ${this._busyAttr("thumbs_down")} id="thumb-down"
              title="${t("Fewer like this")}"
              aria-label="I dislike this song" ${off ? "disabled" : ""}>👎</button>
      <button class="icon" ${this._busyAttr("thumbs_up")} id="thumb-up"
              title="${t("More like this")}"
              aria-label="I like this song" ${off ? "disabled" : ""}>👍</button>`;
  }

  /* The five controls, in the order a hand reaches for them. Previous and
   * Next are Music Assistant's own previous/next -- no invented ten-second
   * seek, no custom restart rule: whatever Music Assistant does for the
   * provider that is playing is what happens. */
  _renderTransport(playing) {
    const t = this._transportState();
    const can = t.can || {};
    const playPause = t.playing
      ? this._tbtn("tr-pause", "⏸", "Pause", can.pause, t)
      : this._tbtn("tr-play", "▶", "Play", can.play, t);
    return `
      <div class="transport" role="group" aria-label="Playback controls">
        ${this._renderThumbs(playing)}
        ${this._thumbsState(playing).hide ? "" : `<span class="tsep" aria-hidden="true"></span>`}
        ${this._tbtn("tr-prev", "⏮", "Previous track", can.prev, t)}
        ${playPause}
        ${this._tbtn("tr-next", "⏭", "Next track", can.next, t)}
      </div>`;
  }

  // --- the Broadcast Console: the Mouth ---------------------------------
  /* One question, answered by the one audio rule on the screen: is a
   * programme voice airing, is audio moving, or is the room quiet. The lamp is the one authority on speech; a spent break
   * the queue rewound onto, a DJ that is merely enabled, and a route that
   * only looks like ours all leave it dark. */
  _mouthState() {
    const p = this._player;
    const na = (this._nowCard && this._nowCard.attributes) || {};
    const m = this._audioMode(this._broadcastState(), na, p);
    const mode = m.mode === "speaking" ? MOUTH_PROGRAM_VOICE
               : m.mode === "music" ? MOUTH_MUSIC : MOUTH_IDLE;
    return { mode, label: MOUTH_LABELS[mode] };
  }

  /* The display is DECORATIVE to assistive technology, and its meaning is
   * one short phrase on the frame around it: no frame is ever announced,
   * and thirty-three moving segments are not thirty-three things. Not a
   * live region -- the state line above already announces the change. */
  _renderMouth(dj, bs, hasEnabledOutputs) {
    const st = this._mouthState();
    const modeKey = this._mouthVisual || "waves";
    const w = this._whisper && this._whisper.until > Date.now() ? this._whisper : null;
    return `
      <div class="mouth mouth-${st.mode.replace("_", "-")} mouth-vis-${modeKey}${this._outputMode ? " in-output-mode" : ""}${this._stationMode && !this._outputMode ? " in-station-mode" : ""}" role="img"
           aria-label="Broadcast display: ${this._esc(st.label)}">
        ${this._renderLcdStatus(dj, bs, hasEnabledOutputs)}
        <canvas id="mouth" class="mouth-canvas" aria-hidden="true"></canvas>
        <div class="lcd-whisper${w ? " visible" : ""}${w && w.kind ? ` lcd-whisper-${w.kind}` : ""}" aria-hidden="true"><span class="lcd-whisper-text">${this._esc(w ? w.text : "")}</span></div>
        ${this._mouthModeToast ? `<div class="mouth-toast" aria-hidden="true">${this._esc(this._mouthModeToast)}</div>` : ""}
        ${this._outputMode ? this._renderOutputLcd() : ""}
        ${this._stationMode && !this._outputMode ? this._renderStationLcd() : ""}
      </div>`;
  }

  /* --- the animation loop, and its whole lifecycle -----------------------
   *
   * ONE LOOP, EVER. Every render replaces the shadow tree, so the canvas is
   * new each time; _mouthStart cancels whatever loop was running before it
   * binds to the new element, and there is no other path that starts one.
   * It draws nothing when there is nothing to draw: idle and reduced
   * motion are single still frames with no loop at all, a hidden page
   * suspends the loop, and disconnecting the element cancels it.
   *
   * THE FRAME TOUCHES NOTHING BUT THE CANVAS. No entity, no service, no
   * websocket, no fetch, no DOM: the state was decided when the loop
   * started, and the next render -- driven by Home Assistant, as every
   * other change is -- starts a new loop for the new state. Throttled to
   * MOUTH_FPS from the frame timestamp, whatever the display's rate. */
  _mouthStart() {
    const prev = this._mouth;
    this._mouthStop();
    const canvas = this.shadowRoot && this.shadowRoot.getElementById("mouth");
    if (!canvas) { this._mouth = null; return; }
    const st = this._mouthState();
    const reduced = !this._gentle();
    /* THE CLOCK SURVIVES THE RENDER, and that is the whole of this.
     *
     * Every Home Assistant state change anywhere in the house replaces
     * this shadow tree, so on a busy installation the canvas is rebuilt
     * several times a second. The clock used to be rebuilt with it --
     * `t0: null`, re-stamped from the next frame -- so the wave snapped
     * back to phase zero before it had travelled anywhere. MEASURED: with
     * a render every second the Mouth never got past t = 1.0 s of a
     * 3.6-8 s sway, and the largest frame-to-frame step was 0.16 against
     * 0.014 for the same motion left alone -- eleven times the movement
     * the design asks for, arriving at the cadence of the house rather
     * than of the music. That is what read as flicker, and it read as
     * flicker ONLY on music: PROGRAM_VOICE's syllables run at 3.4 Hz, so
     * a restart still looks like a mouth talking.
     *
     * So the phase is carried across a rebuild whenever the STATE has not
     * changed, and a state change still starts its own motion from zero.
     * `tSec` is the last phase actually drawn: the still picture below is
     * redrawn at it rather than at 0, so the rebuild does not itself put
     * one zero-phase frame on the screen. Nothing here is a timer and
     * nothing accumulates -- `t0` is still a frame timestamp and the
     * elapsed time is still read from the frame clock. */
    const keep = !!prev && prev.mode === st.mode && prev.reduced === reduced;
    const accent = (this._theme && this._theme.accent) || MOUTH_AMBER;
    this._syncPlaybackClock();                         // idempotent per sample
    const wf = this._drawnWaveform();
    const qitemId = this._waveformDemo ? WAVEFORM_DEMO_KEY
      : (this._clock ? this._clock.key : null);
    const sameItem = keep && !!prev && prev.activeQueueItemId === qitemId;

    this._mouth = { canvas, mode: st.mode, reduced, accent,
                    t0: keep ? prev.t0 : null,
                    tSec: keep ? (prev.tSec || 0) : 0,
                    last: keep ? prev.last : -Infinity, raf: null,
                    activeQueueItemId: qitemId,
                    waveform: wf,
                    smoothedAmp: (sameItem && prev) ? (prev.smoothedAmp || 0) : 0,
                    slowAmp: (sameItem && prev) ? (prev.slowAmp || 0) : 0,
                    waveformOpen: (sameItem && prev) ? prev.waveformOpen : null };
    this._mouthDraw(this._mouth.tSec);                // the still picture, always
    if (st.mode === MOUTH_IDLE || reduced) return;   // nothing moves: no loop
    if (this._mouthHidden()) return;                  // visibilitychange resumes it
    this._mouthQueue();
  }

  _mouthStop() {
    const m = this._mouth;
    if (m && m.raf != null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(m.raf);
    }
    if (m) m.raf = null;
  }

  _mouthHidden() {
    return typeof document !== "undefined" && document.visibilityState === "hidden";
  }

  _mouthQueue() {
    const m = this._mouth;
    if (!m || m.raf != null || typeof requestAnimationFrame !== "function") return;
    m.raf = requestAnimationFrame((ts) => this._mouthFrame(ts));
  }

  _mouthFrame(ts) {
    const m = this._mouth;
    if (!m) return;
    m.raf = null;
    if (this._mouthHidden()) return;                  // suspended until visible
    if (ts - m.last >= MOUTH_FRAME_MS - 0.5) {        // the ceiling, not a target
      const prevTs = m.last;
      m.last = ts;
      // A carried clock keeps its origin; a fresh one takes this frame's,
      // offset by the phase it is resuming from (zero unless carried).
      if (m.t0 == null) m.t0 = ts - m.tSec * 1000;
      m.tSec = (ts - m.t0) / 1000;

      // The real waveform, read at the playback clock (never at a guess:
      // no known position for this waveform's item draws the synthetic
      // display instead). dt is the frame interval, for the smoother only.
      const dt = (Number.isFinite(prevTs) && ts > prevTs) ? (ts - prevTs) / 1000 : MOUTH_FRAME_MS / 1000;
      // A reply can confirm, re-anchor or change the item between renders.
      const wf = this._drawnWaveform();
      const drawKey = this._waveformDemo ? WAVEFORM_DEMO_KEY : (this._clock ? this._clock.key : null);
      if (drawKey !== m.activeQueueItemId) {
        m.activeQueueItemId = drawKey; m.smoothedAmp = 0; m.slowAmp = 0;
      }
      m.waveform = wf;
      const pos = (wf && wf.bins && wf.bins.length) ? this._waveformPosition(wf, this._perfNow()) : null;
      const targetAmp = pos == null ? null : waveformAmplitude(wf.bins, pos, wf.duration);
      if (targetAmp == null) {
        m.waveformOpen = null;
      } else {
        m.smoothedAmp = smoothAmplitude(m.smoothedAmp || 0, targetAmp, dt);
        // The track's own running level, for the music mapping only. It
        // SEEDS at the first sample it sees (an item change reset it), so
        // the emphasis starts from "at the track's level", never from a
        // fake silence the first beat would tower over.
        m.slowAmp = m.slowAmp
          ? smoothAmplitude(m.slowAmp, targetAmp, dt, MUSIC_SLOW_MS, MUSIC_SLOW_MS)
          : targetAmp;
        // One real amplitude, two presentations: speech keeps the
        // established mapping exactly; music draws the same signal with its
        // own curve and its own dynamics emphasis (see musicWaveformOpen).
        m.waveformOpen = (m.mode === MOUTH_MUSIC)
          ? musicWaveformOpen(m.smoothedAmp, m.slowAmp)
          : mouthWaveformOpen(m.smoothedAmp);
      }

      this._mouthDraw(m.tSec);
    }
    this._mouthQueue();
  }

  /* Page hidden: stop spending frames on a display nobody can see. Page
   * back: pick the loop up for the state it was started with. */
  _onVisibilityChange() {
    // Never record in the background: a hidden page stops the take (and
    // keeps what was said so far, for the owner to hear or discard).
    if (this._mic && typeof document !== "undefined" && document.hidden) this._recordStop();
    if (this._mouthHidden()) { this._mouthStop(); return; }
    const m = this._mouth;
    if (m && m.mode !== MOUTH_IDLE && !m.reduced) this._mouthQueue();
  }

  /* --- Visualizer Audio Data Adapter -------------------------------------
   * Bridges physical playback state to the 4 visualizer modes. Structured
   * with clean audio abstractions (rms, frequency bands, speech envelope)
   * so connecting a live audio stream in the future requires zero changes
   * to the canvas rendering engines. */
  _getVisualizerAudio(t, mode, numBands = 31, vis = "eq", m = null) {
    const still = mode === MOUTH_IDLE || (this._mouth && this._mouth.reduced);
    const bands = new Float32Array(numBands);
    if (still) {
      bands.fill(0.04);
      return { still: true, rms: 0.04, bands, speechAmp: 0 };
    }

    const energyMod = (m && m.waveformOpen != null) ? (0.2 + 0.8 * m.waveformOpen) : 1.0;

    if (mode === MOUTH_PROGRAM_VOICE) {
      // Speech envelope: syllables under a slower phrase envelope
      const phrase = 0.62 + 0.38 * Math.sin(TAU * t / 2.9);
      const syllables = 0.62 + 0.25 * Math.sin(TAU * t * 3.4)
                      + 0.15 * Math.sin(TAU * t * 5.1 + 0.8)
                      + 0.05 * Math.sin(TAU * t * 1.3);
      const speechAmp = (m && m.waveformOpen != null)
        ? clamp01(0.12 + 0.85 * m.waveformOpen)
        : clamp01(0.12 + 0.85 * phrase * syllables);
      for (let i = 0; i < numBands; i++) {
        const normPos = i / Math.max(1, numBands - 1);
        // Human speech formants: low-mids to mid frequencies
        const formantWeight = Math.exp(-Math.pow((normPos - 0.42) * 3.2, 2));
        const chatter = 0.72 + 0.28 * Math.sin(t * 19 + i * 1.8) * Math.cos(t * 8.5 - i * 0.9);
        bands[i] = clamp01(speechAmp * (0.22 + 0.78 * formantWeight) * chatter);
      }
      return { still: false, rms: speechAmp, bands, speechAmp };
    }

    // Music mode: dynamic rhythmic spectrum
    const bassBeat = Math.pow(Math.max(0, Math.sin(TAU * t * 1.8)), 2); // ~108 BPM rhythmic breath
    if (vis === "robot") {
      // Robot mode: smooth traveling wave pattern across the entire width
      // Unified harmonic waves from left to right (matching the right third motion)
      // with a gentle center-focused rhythmic breath instead of harsh 1s triangle pulses
      for (let i = 0; i < numBands; i++) {
        const normPos = i / Math.max(1, numBands - 1);
        const waveA = 0.28 * Math.sin(t * 14.3 - i * 2.1);
        const waveB = 0.16 * Math.cos(t * 7.1 + i * 1.1);
        const waveC = 0.08 * Math.sin(t * 22.0 - i * 3.4);
        const centerPulse = 0.10 * Math.sin(normPos * Math.PI) * bassBeat;
        const bandVal = 0.30 + waveA + waveB + waveC + centerPulse;
        bands[i] = clamp01(bandVal * 0.88 * energyMod);
      }
      return { still: false, rms: (0.55 + 0.15 * bassBeat) * energyMod, bands, speechAmp: 0 };
    }

    // Graphic Equalizer: dynamic frequency spectrum (bass on left, mid in centre, treble on right)
    const eqBass = Math.pow(Math.max(0, Math.sin(TAU * t * 1.8)), 4);
    const eqSnare = Math.pow(Math.max(0, Math.sin(TAU * (t * 1.8 + 0.5))), 6);
    for (let i = 0; i < numBands; i++) {
      const normPos = i / Math.max(1, numBands - 1);
      let bandVal = 0.25;
      if (normPos < 0.28) {
        bandVal = 0.28 + 0.62 * eqBass + 0.14 * Math.sin(t * 4.2 + i);
      } else if (normPos < 0.70) {
        bandVal = 0.22 + 0.45 * eqSnare + 0.24 * Math.sin(t * 6.5 + i * 1.2);
      } else {
        bandVal = 0.18 + 0.35 * Math.sin(t * 14.3 - i * 2.1) + 0.20 * Math.cos(t * 7.1 + i);
      }
      bands[i] = clamp01(bandVal * 0.88 * energyMod);
    }
    return { still: false, rms: (0.55 + 0.25 * eqBass) * energyMod, bands, speechAmp: 0 };
  }

  _mouthDraw(t) {
    const m = this._mouth;
    if (!m) return;
    const c = m.canvas;
    const ctx = typeof c.getContext === "function" ? c.getContext("2d") : null;
    if (!ctx) return;
    const cssW = c.clientWidth || 0, cssH = c.clientHeight || 0;
    if (!cssW || !cssH) return;
    const dpr = (typeof devicePixelRatio === "number" && devicePixelRatio > 0)
      ? Math.min(devicePixelRatio, 2) : 1;
    const W = Math.round(cssW * dpr), H = Math.round(cssH * dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    ctx.clearRect(0, 0, W, H);
    const alpha = MOUTH_ALPHA[m.mode];
    const accent = (m && m.accent) || (this._theme && this._theme.accent) || MOUTH_AMBER;
    const vis = this._mouthVisual || "waves";

    if (vis === "eq") {
      this._drawEq(ctx, W, H, dpr, t, m, alpha, accent);
    } else if (vis === "robot") {
      this._drawRobot(ctx, W, H, dpr, t, m, alpha, accent);
    } else if (vis === "dial") {
      this._drawDial(ctx, W, H, dpr, t, m, alpha, accent);
    } else {
      this._drawWaves(ctx, W, H, dpr, t, m, alpha, accent);
    }
  }

  /* --- Mode 1: Classic Sinusoidal Waves -----------------------------------
   * Preserves exact procedural wave math and roundRect assertions for tests. */
  _drawWaves(ctx, W, H, dpr, t, m, alpha, accent) {
    const n = MOUTH_COLUMNS;
    const still = m.reduced || m.mode === MOUTH_IDLE;
    const colW = W / n;
    const barW = Math.max(1, colW * 0.56);
    const mid = H / 2;
    const maxHalf = H * 0.44;
    // the resting line: the display is visibly there even when quiet
    ctx.globalAlpha = 0.35 * alpha;
    ctx.fillStyle = accent;
    ctx.fillRect(colW * 0.3, mid - Math.max(1, dpr * 0.5), W - colW * 0.6, Math.max(1, dpr));
    ctx.globalAlpha = alpha;
    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) / ((n - 1) / 2);
      let open = still
        ? MOUTH_STILL[m.mode]
        : (m.waveformOpen != null
            ? clamp01(0.06 + m.waveformOpen * 0.94)
            : mouthOpening(m.mode, t, x));
      // MUSIC only: a subtle travelling shimmer across the columns, so
      // the real envelope reads as energy moving through a grille rather
      // than one lens breathing. Its depth is the envelope itself
      // (MUSIC_RIPPLE * open: silence shimmers not at all, a full-scale
      // passage by at most ~14%), and its motion is the presentation
      // clock -- the same one the synthetic sway uses. Speech is left
      // exactly as it is.
      if (!still && m.mode === MOUTH_MUSIC && m.waveformOpen != null) {
        const ripple = (Math.sin(TAU * t / 2.6 + 2.4 * x)
                      + 0.6 * Math.sin(TAU * t / 1.15 - 3.2 * x)) / 1.6;
        open = clamp01(open * (1 + MUSIC_RIPPLE * open * ripple));
      }
      const half = Math.max(dpr * 1.5, open * maxHalf * (0.12 + 0.88 * mouthLens(x)));
      const cx = colW * (i + 0.5);
      ctx.fillStyle = accent;
      roundRect(ctx, cx - barW / 2, mid - half, barW, half * 2, Math.min(barW / 2, half));
      if (m.mode === MOUTH_PROGRAM_VOICE && half > barW) {
        // a cream core while speaking: brighter, not a different colour
        ctx.fillStyle = MOUTH_CREAM;
        ctx.globalAlpha = alpha * 0.55;
        roundRect(ctx, cx - barW * 0.2, mid - half * 0.55, barW * 0.4, half * 1.1, barW * 0.2);
        ctx.globalAlpha = alpha;
      }
    }
    ctx.globalAlpha = 1;
  }

  /* --- Mode 2: Graphic Equalizer Bars ------------------------------------
   * Multi-band graphic equalizer with stacked LED ladder segments and
   * floating peak-hold caps. */
  _drawEq(ctx, W, H, dpr, t, m, alpha, accent) {
    const numBands = 31;
    const audio = this._getVisualizerAudio(t, m.mode, numBands, "eq", m);
    const padX = Math.round(14 * dpr);
    const usableW = W - padX * 2;
    const colSlotW = usableW / numBands;
    const barW = Math.max(2, Math.round(colSlotW * 0.72));
    const padY = Math.round(8 * dpr);
    const usableH = H - padY * 2;
    const numSegments = 10;
    const segGap = Math.max(1, Math.round(1.5 * dpr));
    const totalGaps = (numSegments - 1) * segGap;
    const segH = Math.max(2, Math.floor((usableH - totalGaps) / numSegments));

    if (!this._eqPeaks || this._eqPeaks.length !== numBands) {
      this._eqPeaks = new Float32Array(numBands);
    }

    // Hardware frame subtle inset
    ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
    ctx.fillRect(padX - 4 * dpr, padY - 3 * dpr, usableW + 8 * dpr, usableH + 6 * dpr);

    for (let i = 0; i < numBands; i++) {
      const val = audio.bands[i];
      if (val > this._eqPeaks[i]) {
        this._eqPeaks[i] = val;
      } else {
        this._eqPeaks[i] = Math.max(0, this._eqPeaks[i] - 0.018);
      }

      const activeSegs = audio.still ? 1 : Math.round(val * numSegments);
      const peakSeg = Math.min(numSegments - 1, Math.floor(this._eqPeaks[i] * numSegments));
      const cx = padX + (i + 0.5) * colSlotW;
      const x = Math.round(cx - barW / 2);

      for (let s = 0; s < numSegments; s++) {
        const y = Math.round(H - padY - (s + 1) * segH - s * segGap);
        if (s < activeSegs) {
          if (s >= numSegments - 2) {
            ctx.fillStyle = MOUTH_CREAM;
            ctx.globalAlpha = alpha * 0.95;
          } else {
            ctx.fillStyle = accent;
            ctx.globalAlpha = alpha * (0.65 + 0.35 * (s / numSegments));
          }
          ctx.fillRect(x, y, barW, segH);
        } else if (s === peakSeg && s > 0 && !audio.still) {
          ctx.fillStyle = MOUTH_CREAM;
          ctx.globalAlpha = alpha * 0.85;
          ctx.fillRect(x, y, barW, Math.max(1, Math.round(segH * 0.75)));
        } else {
          ctx.fillStyle = accent;
          ctx.globalAlpha = 0.06 * alpha;
          ctx.fillRect(x, y, barW, segH);
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  /* --- Mode 3: Sci-Fi Vector Oscilloscope ---------------------------------
   * 1960s/70s retro robot/mainframe vector mouth (Cylon / B-9 Robot / HAL).
   * CRT phosphor glow, jagged sawtooth waveform, and baseline heartbeat. */
  _drawRobot(ctx, W, H, dpr, t, m, alpha, accent) {
    const numPoints = 32;
    const audio = this._getVisualizerAudio(t, m.mode, numPoints, "robot", m);
    const padX = Math.round(16 * dpr);
    const usableW = W - padX * 2;
    const midY = H / 2;
    const maxAmp = H * 0.40;

    // 1. CRT Oscilloscope Grid
    ctx.strokeStyle = accent;
    ctx.lineWidth = Math.max(1, dpr * 0.6);
    ctx.globalAlpha = 0.16 * alpha;
    const gridYSteps = 4;
    for (let g = 1; g < gridYSteps; g++) {
      const gy = Math.round((H / gridYSteps) * g);
      ctx.beginPath();
      ctx.moveTo(padX, gy);
      ctx.lineTo(W - padX, gy);
      ctx.stroke();
    }
    const gridXSteps = 8;
    for (let gx = 1; gx < gridXSteps; gx++) {
      const gxx = Math.round(padX + (usableW / gridXSteps) * gx);
      ctx.beginPath();
      ctx.moveTo(gxx, Math.round(H * 0.12));
      ctx.lineTo(gxx, Math.round(H * 0.88));
      ctx.stroke();
    }

    // 2. Center Baseline Reference
    ctx.globalAlpha = 0.32 * alpha;
    ctx.beginPath();
    ctx.moveTo(padX, midY);
    ctx.lineTo(W - padX, midY);
    ctx.stroke();

    // 3. Channel B: Secondary Jagged Shadow Wave (Offset behind, rendered in glowing LED accent color)
    ctx.beginPath();
    if (audio.still) {
      const blipPosB = (((t * 0.35) - 0.08 + 1.0) % 1.0);
      const blipXB = padX + blipPosB * usableW;
      for (let i = 0; i <= numPoints; i++) {
        const x = padX + (i / numPoints) * usableW;
        const distB = Math.abs(x - blipXB);
        const blipB = distB < 20 * dpr ? Math.sin((1 - distB / (20 * dpr)) * Math.PI) * 4.5 * dpr : 0;
        const y = midY - blipB;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    } else {
      for (let i = 0; i <= numPoints; i++) {
        const nx = i / numPoints;
        const x = padX + nx * usableW;
        const sign = (i % 2 === 0) ? 1 : -1;
        const bandVal = audio.bands[Math.min(i, audio.bands.length - 1)];
        let yOffsetB = 0;
        if (m.mode === MOUTH_PROGRAM_VOICE) {
          const lens = Math.sin(nx * Math.PI);
          const chatterB = 0.70 + 0.30 * Math.sin(t * 22 + i * 3.1 + 1.2);
          yOffsetB = sign * bandVal * (maxAmp * 0.58) * (0.2 + 0.8 * lens) * chatterB;
        } else {
          const envelopeB = 0.30 + 0.70 * Math.sin(nx * Math.PI);
          const phaseShift = Math.sin(t * 5.8 + i * 1.1) * 2.5 * dpr;
          yOffsetB = sign * bandVal * (maxAmp * 0.58) * envelopeB + phaseShift;
        }
        const y = midY - yOffsetB;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    }

    // Channel B Pass 1: Phosphor glow in LED accent color
    ctx.strokeStyle = accent;
    ctx.lineWidth = Math.max(2, 4.0 * dpr);
    ctx.globalAlpha = 0.45 * alpha;
    ctx.stroke();

    // Channel B Pass 2: LED accent vector core
    ctx.strokeStyle = accent;
    ctx.lineWidth = Math.max(1, 1.8 * dpr);
    ctx.globalAlpha = 0.88 * alpha;
    ctx.stroke();

    // Channel B Vertex nodes
    if (!audio.still) {
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.75 * alpha;
      const dotB = Math.max(1.0, 1.5 * dpr);
      for (let i = 0; i <= numPoints; i += 2) {
        const nx = i / numPoints;
        const x = padX + nx * usableW;
        const bandVal = audio.bands[Math.min(i, audio.bands.length - 1)];
        const lens = Math.sin(nx * Math.PI);
        const envB = (m.mode === MOUTH_PROGRAM_VOICE) ? (0.2 + 0.8 * lens) : (0.30 + 0.70 * lens);
        const phaseShift = (m.mode === MOUTH_PROGRAM_VOICE) ? 0 : Math.sin(t * 5.8 + i * 1.1) * 2.5 * dpr;
        const yOff = ((i % 2 === 0) ? 1 : -1) * bandVal * (maxAmp * 0.58) * envB + phaseShift;
        ctx.beginPath();
        ctx.arc(x, midY - yOff, dotB, 0, TAU);
        ctx.fill();
      }
    }

    // 4. Channel A: Primary Jagged Wave (Foreground vector with crisp core & vibrant LED glow)
    ctx.beginPath();
    if (audio.still) {
      const blipPos = ((t * 0.35) % 1.0);
      const blipX = padX + blipPos * usableW;
      for (let i = 0; i <= numPoints; i++) {
        const x = padX + (i / numPoints) * usableW;
        const dist = Math.abs(x - blipX);
        const blip = dist < 24 * dpr ? Math.sin((1 - dist / (24 * dpr)) * Math.PI) * 7 * dpr : 0;
        const y = midY - blip;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    } else {
      for (let i = 0; i <= numPoints; i++) {
        const nx = i / numPoints;
        const x = padX + nx * usableW;
        const sign = (i % 2 === 0) ? 1 : -1;
        const bandVal = audio.bands[Math.min(i, audio.bands.length - 1)];
        let yOffset = 0;
        if (m.mode === MOUTH_PROGRAM_VOICE) {
          const lens = Math.sin(nx * Math.PI);
          const chatter = 0.75 + 0.25 * Math.sin(t * 26 + i * 2.8);
          yOffset = sign * bandVal * maxAmp * (0.2 + 0.8 * lens) * chatter;
        } else {
          const envelope = 0.35 + 0.65 * Math.sin(nx * Math.PI);
          yOffset = sign * bandVal * maxAmp * envelope;
        }
        const y = midY - yOffset;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    }

    // Channel A Pass 1: Rich LED phosphor aura (illuminates the waveform in the LED color)
    ctx.strokeStyle = accent;
    ctx.lineWidth = Math.max(2.5, 5.5 * dpr);
    ctx.globalAlpha = 0.70 * alpha;
    ctx.stroke();

    // Channel A Pass 2: Hot vector beam
    ctx.strokeStyle = (m.mode === MOUTH_PROGRAM_VOICE) ? MOUTH_CREAM : "#ffffff";
    ctx.lineWidth = Math.max(1, 1.5 * dpr);
    ctx.globalAlpha = 0.98 * alpha;
    ctx.stroke();

    // Channel A Glowing vertex nodes
    if (!audio.still) {
      ctx.fillStyle = (m.mode === MOUTH_PROGRAM_VOICE) ? MOUTH_CREAM : "#ffffff";
      ctx.globalAlpha = 0.95 * alpha;
      const dotRadius = Math.max(1.2, 2.0 * dpr);
      for (let i = 0; i <= numPoints; i += 2) {
        const nx = i / numPoints;
        const x = padX + nx * usableW;
        const bandVal = audio.bands[Math.min(i, audio.bands.length - 1)];
        const lens = Math.sin(nx * Math.PI);
        const env = (m.mode === MOUTH_PROGRAM_VOICE) ? (0.2 + 0.8 * lens) : (0.35 + 0.65 * lens);
        const yOffset = ((i % 2 === 0) ? 1 : -1) * bandVal * maxAmp * env;
        ctx.beginPath();
        ctx.arc(x, midY - yOffset, dotRadius, 0, TAU);
        ctx.fill();
      }
    }

    // 5. CRT Scanline overlay
    ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
    const scanStep = Math.max(2, Math.round(3 * dpr));
    for (let sy = 0; sy < H; sy += scanStep) {
      ctx.fillRect(0, sy, W, Math.max(1, Math.round(dpr * 0.75)));
    }
    ctx.globalAlpha = 1;
  }

  /* --- Mode 4: Vintage Radio Tuner Dial -----------------------------------
   * Warm incandescent dim bulb-lit AM/FM dial scale with glowing amber needle
   * linked to the Right Knob tuning position and subtle audio signal quiver. */
  _drawDial(ctx, W, H, dpr, t, m, alpha, accent) {
    const padX = Math.round(22 * dpr);
    const usableW = W - padX * 2;
    const midY = Math.round(H * 0.48);

    // 1. Incandescent backlight: soft warm amber illumination from end lamps
    const bulbGlow = ctx.createLinearGradient(0, 0, W, 0);
    bulbGlow.addColorStop(0, "rgba(255, 175, 60, 0.22)");
    bulbGlow.addColorStop(0.16, "rgba(255, 175, 60, 0.07)");
    bulbGlow.addColorStop(0.5, "rgba(255, 175, 60, 0.03)");
    bulbGlow.addColorStop(0.84, "rgba(255, 175, 60, 0.07)");
    bulbGlow.addColorStop(1, "rgba(255, 175, 60, 0.22)");
    ctx.fillStyle = bulbGlow;
    ctx.fillRect(0, 0, W, H);

    // Subtle edge shadows / bezel glass vignette
    const glassVig = ctx.createLinearGradient(0, 0, 0, H);
    glassVig.addColorStop(0, "rgba(0, 0, 0, 0.4)");
    glassVig.addColorStop(0.2, "rgba(0, 0, 0, 0.0)");
    glassVig.addColorStop(0.8, "rgba(0, 0, 0, 0.0)");
    glassVig.addColorStop(1, "rgba(0, 0, 0, 0.5)");
    ctx.fillStyle = glassVig;
    ctx.fillRect(0, 0, W, H);

    // 2. Horizontal divider rail
    ctx.strokeStyle = "rgba(255, 205, 130, 0.35)";
    ctx.lineWidth = Math.max(1, dpr);
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(padX, midY);
    ctx.lineTo(W - padX, midY);
    ctx.stroke();

    // 3. AM Scale (Top: 540 .. 1600 kHz)
    const amFreqs = [540, 600, 700, 800, 1000, 1200, 1400, 1600];
    const amMin = 540, amMax = 1600;
    const amTicksTop = Math.round(midY - 14 * dpr);
    const amTicksBottom = midY;
    const fontSize = Math.max(8, Math.round(7.5 * dpr));
    ctx.font = `600 ${fontSize}px var(--pw-mono, "SF Mono", monospace)`;
    ctx.textBaseline = "bottom";
    ctx.textAlign = "center";

    for (let f = 0; f < amFreqs.length; f++) {
      const freq = amFreqs[f];
      const frac = (freq - amMin) / (amMax - amMin);
      const x = Math.round(padX + frac * usableW);
      ctx.strokeStyle = "rgba(255, 215, 140, 0.75)";
      ctx.lineWidth = Math.max(1, dpr);
      ctx.beginPath();
      ctx.moveTo(x, amTicksTop + 4 * dpr);
      ctx.lineTo(x, amTicksBottom);
      ctx.stroke();
      ctx.fillStyle = "rgba(255, 220, 150, 0.85)";
      const label = freq >= 1000 ? String(freq / 10) : String(freq);
      ctx.fillText(label, x, amTicksTop + 2 * dpr);
    }

    // AM Minor ticks
    ctx.strokeStyle = "rgba(255, 215, 140, 0.35)";
    ctx.lineWidth = Math.max(1, dpr * 0.75);
    for (let f = 550; f < 1600; f += 50) {
      if (amFreqs.includes(f)) continue;
      const frac = (f - amMin) / (amMax - amMin);
      const x = Math.round(padX + frac * usableW);
      ctx.beginPath();
      ctx.moveTo(x, amTicksBottom - 4 * dpr);
      ctx.lineTo(x, amTicksBottom);
      ctx.stroke();
    }

    // AM Brand badge
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(255, 190, 100, 0.7)";
    ctx.fillText("AM  x10 kHz", padX, Math.round(11 * dpr));

    // 4. FM Scale (Bottom: 88 .. 108 MHz)
    const fmFreqs = [88, 92, 96, 100, 104, 108];
    const fmMin = 88, fmMax = 108;
    const fmTicksTop = midY;
    const fmTicksBottom = Math.round(midY + 14 * dpr);
    ctx.textBaseline = "top";
    ctx.textAlign = "center";

    for (let f = 0; f < fmFreqs.length; f++) {
      const freq = fmFreqs[f];
      const frac = (freq - fmMin) / (fmMax - fmMin);
      const x = Math.round(padX + frac * usableW);
      ctx.strokeStyle = "rgba(255, 215, 140, 0.75)";
      ctx.lineWidth = Math.max(1, dpr);
      ctx.beginPath();
      ctx.moveTo(x, fmTicksTop);
      ctx.lineTo(x, fmTicksBottom - 4 * dpr);
      ctx.stroke();
      ctx.fillStyle = "rgba(255, 220, 150, 0.85)";
      ctx.fillText(String(freq), x, fmTicksBottom);
    }

    // FM Minor ticks
    ctx.strokeStyle = "rgba(255, 215, 140, 0.35)";
    ctx.lineWidth = Math.max(1, dpr * 0.75);
    for (let f = 89; f < 108; f += 1) {
      if (fmFreqs.includes(f)) continue;
      const frac = (f - fmMin) / (fmMax - fmMin);
      const x = Math.round(padX + frac * usableW);
      ctx.beginPath();
      ctx.moveTo(x, fmTicksTop);
      ctx.lineTo(x, fmTicksTop + 4 * dpr);
      ctx.stroke();
    }

    // FM Brand badge
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(255, 190, 100, 0.7)";
    ctx.fillText("FM  MHz", W - padX, H - Math.round(4 * dpr));

    // 5. Tuning Pointer / Needle
    const rawPos = ((this._rightKnobAngle || 0) + 135) / 270;
    const cycle = Math.floor(rawPos);
    const normPos = (cycle % 2 === 0) ? (rawPos - cycle) : (1 - (rawPos - cycle));
    const dialPos = 0.04 + 0.92 * normPos;

    // Analog audio signal quiver
    let quiver = 0;
    if (m.mode === MOUTH_PROGRAM_VOICE) {
      const scale = (m && m.waveformOpen != null) ? (0.35 + 1.25 * m.waveformOpen) : 1.0;
      quiver = (Math.sin(t * 24) * 1.5 + Math.sin(t * 37) * 0.8) * dpr * scale;
    } else if (m.mode === MOUTH_MUSIC) {
      const scale = (m && m.waveformOpen != null) ? (0.25 + 1.35 * m.waveformOpen) : 1.0;
      quiver = Math.sin(t * 11) * 0.7 * dpr * scale;
    }

    const needleX = Math.round(padX + dialPos * usableW + quiver);
    const needleTop = Math.round(3 * dpr);
    const needleBottom = Math.round(H - 3 * dpr);

    // Needle outer amber glow
    ctx.strokeStyle = "rgba(255, 110, 20, 0.45)";
    ctx.lineWidth = Math.max(3, 4.5 * dpr);
    ctx.beginPath();
    ctx.moveTo(needleX, needleTop);
    ctx.lineTo(needleX, needleBottom);
    ctx.stroke();

    // Needle bright core
    ctx.strokeStyle = "#ff4800";
    ctx.lineWidth = Math.max(1, 1.8 * dpr);
    ctx.beginPath();
    ctx.moveTo(needleX, needleTop);
    ctx.lineTo(needleX, needleBottom);
    ctx.stroke();

    // Needle tip caps
    ctx.fillStyle = "#ff6a00";
    ctx.beginPath();
    ctx.moveTo(needleX - 3 * dpr, needleTop);
    ctx.lineTo(needleX + 3 * dpr, needleTop);
    ctx.lineTo(needleX, needleTop + 4 * dpr);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(needleX - 3 * dpr, needleBottom);
    ctx.lineTo(needleX + 3 * dpr, needleBottom);
    ctx.lineTo(needleX, needleBottom - 4 * dpr);
    ctx.closePath();
    ctx.fill();

    // 6. Signal Strength / Tuning Eye Lamp (Top Right)
    const eyeX = W - padX - 8 * dpr;
    const eyeY = Math.round(8 * dpr);
    const eyeRad = Math.round(4 * dpr);
    const sigIntensity = (m.mode === MOUTH_PROGRAM_VOICE) ? 0.95
                       : (m.mode === MOUTH_MUSIC) ? 0.7
                       : 0.25;
    ctx.fillStyle = `rgba(255, 185, 60, ${sigIntensity * alpha})`;
    ctx.beginPath();
    ctx.arc(eyeX, eyeY, eyeRad, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 220, 120, 0.5)";
    ctx.lineWidth = Math.max(1, dpr * 0.7);
    ctx.stroke();

  }

  /* AIR CHECK: what the station is saying, or the last thing it said, as
   * broadcast rather than telemetry. Named only from metadata that exists:
   * the voice when the break recorded one, otherwise the personality,
   * never an internal id.
   *
   * It is the current or most recently COMPLETED spoken break, and only
   * those: `on_air_break` is the engine's own airing row and `last_*` its
   * newest completed one, so a queued future break is never the Air Check
   * and a spent item a rewind exposed cannot displace the real last one --
   * neither is a row the engine would publish here.
   *
   * ON AIR OUTRANKS HISTORY. While a break is audible the panel showed the
   * PREVIOUS break's script, because the only script the backend published
   * was the last COMPLETED one -- so a listener heard one break and read
   * the one before it. The backend now describes the break on air in the
   * same words it describes a finished one, and this picks the live one
   * whenever there is one. Nothing here is optimistic: `on_air_break` is
   * the backend's own answer, and with no break on air this is history and
   * says so. */
  _renderLastBreak() {
    const jv = this._djStatus;
    const a = (jv && jv.attributes) || {};
    const live = !!a.on_air_break;
    const spoken = live ? a.on_air_spoken : a.last_spoken;
    const voiceId = live ? a.on_air_break_voice : a.last_break_voice;
    const persona = live ? a.on_air_break_personality : a.last_break_personality;
    const at = live ? a.on_air_break_at : a.last_break_at;
    const who = voiceId ? this._voiceName(voiceId)
      : (persona ? this._personaName(persona) : null);
    const ago = this._agoText(at);
    const when = live ? "Speaking now"
      : (ago || (at ? this._localTime(at) : null));
    const topics = ((live ? a.on_air_break_topics : a.last_break_topics) || [])
      .join(", ");
    const ref = live ? a.on_air_break_id : a.last_break_id;
    return `
      <section class="card lastbreak${live ? " live" : ""}" aria-label="Air Check">
        <div class="lastbreak-head">
          <span class="mic" aria-hidden="true">🎙</span>
          <span class="lastbreak-label">Air Check</span>
          <span class="lastbreak-who">${who ? this._esc(who) : "DJ"}</span>
          ${when ? `<span class="lastbreak-when${live ? " onair" : ""}">${live ? this._esc(when) : this._liveAgo(at)}</span>` : ""}
          <span class="spacer"></span>
          <button class="ghost tiny-btn ${this._historyOpen ? "on" : ""}" id="history-toggle"
                  aria-pressed="${this._historyOpen}" aria-label="Break history">
            ${this._historyOpen ? "Hide history" : "History"}</button>
        </div>
        ${spoken
          ? `<blockquote class="said">${this._esc(spoken)}</blockquote>`
          : (live
            ? `<div class="hint">On air now.</div>`
            : `<div class="hint">Nothing said yet. The first break arrives once music is playing on a DJ-enabled speaker.</div>`)}
        ${topics ? `<div class="lastbreak-topics">${this._esc(topics)}</div>` : ""}
        ${ref && this._diagAllowed() ? `<div class="lastbreak-inspect"><button class="inlink"
          data-diag-inspect="${this._esc(ref)}">Inspect in diagnostics ›</button></div>` : ""}
        ${this._historyOpen ? this._renderHistory(ref) : ""}
      </section>`;
  }

  _renderDrawer() {
    if (this._drawer === "lyrics") return this._renderLyrics();
    if (this._drawer === "queue") return this._renderQueue();
    return "";
  }

  /* A new song is a new document: the pane starts at the top, follows
   * again, and forgets the line the previous song was on. */
  _resetLyricPane() {
    this._lyricLine = null;
    this._lyricScrollTop = 0;
    this._lyricFollow = true;
    this._lyricScrolledFor = null;
    this._lyricAutoTop = null;
    this._lyricAutoAt = 0;
  }

  _renderLyrics() {
    const l = this._lyrics;
    if (!l || l.loading) {
      const hold = l && l.loading && this._lyricHoldPx
        ? ` style="box-sizing:border-box;min-height:${this._lyricHoldPx}px"` : "";
      return `<div class="drawer"${hold}><div class="hint">Fetching lyrics…</div></div>`;
    }
    const d = l.data || { kind: "none" };
    if (d.kind === "synced") {
      const lines = (d.lines || []).map((r, i) =>
        `<div class="lyric" data-li="${i}">${this._esc(r.text) || "&nbsp;"}</div>`).join("");
      // The way back, and only when there is somewhere to come back FROM.
      // While the pane is following the song this control would be an
      // offer to do what is already happening, so it is not drawn at all.
      const follow = this._lyricFollow ? "" : `
        <button class="lyric-follow" id="lyric-follow"
                aria-label="Follow the song again">Follow lyrics</button>`;
      return `<div class="drawer lyric-drawer">
        <div id="lyric-lines" class="lyrics" tabindex="0">${lines}</div>
        ${follow}
      </div>`;
    }
    if (d.kind === "plain") {
      // UNSYNCED LYRICS ARE A PAGE, NOT A PERFORMANCE. There are no times
      // to follow, so there is no `lyric-lines` element here and nothing in
      // the panel can scroll this: the absence is the mechanism.
      return `<div class="drawer"><div class="lyrics plain">${this._esc(d.text)}</div></div>`;
    }
    return `<div class="drawer"><div class="hint">Lyrics unavailable for this track.</div></div>`;
  }

  /* A RUN OF SECONDS, or nothing at all.
   *
   * Music Assistant reports a duration per queue item, and sometimes it
   * does not -- a live stream, an item whose metadata has not resolved.
   * Summing what is present and presenting the answer as the length of
   * the whole group would be arithmetic wearing the clothes of a fact, so
   * one missing length refuses the total for that group. The count is
   * always true and always shown; the time is an extra that has to earn
   * its place. */
  _queueSeconds(items) {
    if (!items || !items.length) return null;
    let secs = 0;
    for (const it of items) {
      // A spent programme item is a tombstone: a second of silence that
      // Music Assistant may still report at its old length. Its time is
      // not missing, it is irrelevant, so it is left out rather than
      // refusing the total for the songs around it.
      if (it && this._queueDead(it)) continue;
      const d = it && it.duration_s;
      if (typeof d !== "number" || !(d > 0)) return null;
      secs += d;
    }
    return secs;
  }

  /* Whole minutes, never a decimal of one. Under a minute says so rather
   * than rounding down to "0 min". */
  _runWords(secs) {
    if (secs == null) return null;
    // Tested BEFORE rounding: 59 seconds rounds to one minute, and "1 min"
    // for something that has not reached a minute is a small lie told for
    // the sake of a tidier sentence.
    if (secs < 60) return "under a minute";
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60), m = mins % 60;
    return m ? `${h} hr ${m} min` : `${h} hr`;
  }

  /* THE SUMMARY IS MUSIC ASSISTANT'S ARITHMETIC, not this drawer's.
   *
   * `total`, `played_count` and `upcoming_count` come from MA's own queue
   * snapshot -- its length and its position in it -- so the numbers
   * describe the WHOLE queue, not the handful of rows this view fetched.
   * When MA does not report them the counts fall back to what is listed,
   * and the wording says so: "5 earlier" about a window of five is a
   * different claim from "5 earlier" about a queue.
   *
   * The words are "earlier" and "still to come", not "played": an item
   * before the current one may have been skipped, and the queue does not
   * record which. */
  _queueSummary(d) {
    const listedAfter = (d.upcoming || []).length;
    const whole = typeof d.played_count === "number"
                  && typeof d.upcoming_count === "number";
    const before = whole ? d.played_count : (d.recent || []).length;
    const after = whole ? d.upcoming_count : listedAfter;
    const ahead = this._runWords(this._queueSeconds(d.upcoming));
    const counts = [d.ended ? "Queue ended" : null,
                    `${before} earlier`,
                    d.current && !d.ended ? "1 playing now" : null,
                    `${after} still to come`].filter(Boolean).join(" \u00b7 ");
    const run = ahead
      ? (whole && after === listedAfter
          ? `about ${ahead} of music still to come`
          : `the next ${listedAfter} run about ${ahead}`)
      : null;
    const scope = whole
      ? (typeof d.total === "number" ? `${d.total} items in this queue` : null)
      : "counted from what is listed below";
    return `<div class="qsum">
      <div class="qsum-counts">${this._esc(counts)}</div>
      ${run ? `<div class="qsum-sub">${this._esc(run)}</div>` : ""}
      ${scope ? `<div class="qsum-sub">${this._esc(scope)}</div>` : ""}
    </div>`;
  }

  /* A PROGRAMME ITEM THAT WILL NOT SPEAK. `lifecycle` is the backend's own
   * word (now_playing.py): `spent` is a break or bulletin that is over --
   * aired, missed, revoked, failed or retired -- whose URL now answers a
   * second of silence; `unknown` is one of ours in a state this build
   * cannot name. Neither is upcoming programme, however far ahead of the
   * play head a rewind has put it. Music is never dead: it has no
   * lifecycle at all. */
  _queueDead(it) {
    return it.kind !== "music" && ["spent", "unknown"].includes(it.lifecycle);
  }

  /* The word beside a programme row, from its lifecycle and nothing else
   * -- not its title, its length or its position. Upcoming needs no word:
   * "DJ break" under "Up next" already says it. */
  _queueTag(it) {
    if (it.kind === "music") return null;
    if (it.lifecycle === "airing") return "speaking now";
    if (it.lifecycle === "spent") return "finished";
    if (it.lifecycle === "unknown") return "status unknown";
    return null;
  }

  /* THE ROWS ARE MUSIC ASSISTANT'S QUEUE, whole. A spent break that a
   * rewind put back ahead of the play head is drawn -- greyed, marked
   * "finished" -- rather than left out, because the counts above these
   * rows are MA's own arithmetic over that queue and a list with holes in
   * it would stop adding up to them. It is drawn as what it is, never as
   * a break coming up; when queue hygiene removes the item it is simply
   * gone from the next read.
   *
   * A FINISHED row KEEPS ITS LENGTH. `duration_s` is Music Assistant's
   * own duration for the item, which for an aired break or bulletin is
   * the length of the programme element as it aired -- "finished · 0:20"
   * answers "how long was that?" the same way "0:20" beside an upcoming
   * break answers "how long will it be?". The length is still left out of
   * the run-time arithmetic (_queueSeconds), which is about music yet to
   * play, and it is never invented: an item MA reports no duration for
   * shows none. A lifecycle this build cannot name ("unknown") keeps no
   * length either -- nothing about it is vouched for. */
  _renderQueue() {
    const q = this._queue;
    if (!q || (q.loading && !q.standIn)) return `<div class="drawer"><div class="hint">Reading the queue\u2026</div></div>`;
    const d = q.data;
    if (!d || d.ok === false || !d.complete) {
      return `<div class="drawer"><div class="hint">Queue unavailable right now.</div></div>`;
    }
    const row = (it, current) => {
      const dead = this._queueDead(it);
      const tag = this._queueTag(it);
      const timed = it.lifecycle === "unknown" ? false : !!it.duration_s;
      return `<div class="qrow ${current ? "qnow" : ""}${dead ? " qspent" : ""}">
      <span class="qicon">${KIND_ICON[it.kind] || "\u266a"}</span>
      <span class="qname">${this._esc(it.kind === "music"
        ? `${it.artist ? it.artist + " \u2014 " : ""}${it.title}` : it.title)}${
        tag ? `<span class="qtag">${this._esc(tag)}</span>` : ""}</span>
      <span class="qtime">${this._esc(timed ? this._mmss(it.duration_s) : "")}</span></div>`;
    };
    const more = typeof d.upcoming_count === "number"
                 && d.upcoming_count > (d.upcoming || []).length
      ? `<div class="qmore">${this._esc(
          `and ${d.upcoming_count - d.upcoming.length} more after these`)}</div>`
      : "";
    return `<div class="drawer">
      ${this._queueSummary(d)}
      ${d.recent && d.recent.length ? `<div class="qhead">Earlier</div>` + d.recent.map((r) => row(r)).join("") : ""}
      ${d.current && !d.ended ? `<div class="qhead">Playing now</div>` + row(d.current, true) : ""}
      ${d.upcoming && d.upcoming.length ? `<div class="qhead">Up next</div>` + d.upcoming.map((r) => row(r)).join("") + more : ""}
    </div>`;
  }

  /* `featured` is the public ref of the break the Air Check is already
   * showing: History is everything ELSE, so that break is not read twice.
   * Matched by ref, never by text -- two breaks may say the same
   * words -- and a news row never carries a break's ref. */
  _renderHistory(featured) {
    const h = this._history;
    if (!h) return `<div class="hint">Loading history…</div>`;
    const all = (h.data && h.data.history) || [];
    const items = all.filter((it) => !(featured && it.id === featured));
    if (!items.length) {
      return `<div class="hint">${all.length ? "Nothing earlier yet."
        : "No aired announcements yet."}</div>`;
    }
    return `<div class="history">${items.map((it) => {
      const [icon, label] = HISTORY_TYPE[it.type] || ["🎙", it.type];
      const meta = [this._localTime(it.at), label,
        it.origin ? { exact: "Exact", smart: "Smart",
                      deterministic: "Deterministic" }[it.origin] || null : null,
        it.personality ? this._personaName(it.personality) : null,
        it.voice ? this._voiceName(it.voice) : null].filter(Boolean).join(" · ");
      return `<div class="hrow">
        <div class="hmeta">${icon} ${this._esc(meta)}</div>
        ${it.text ? `<div class="htext">${this._esc(it.text)}</div>` : ""}
        ${it.id && it.type !== "news_bulletin" && this._diagAllowed() ? `<button class="inlink hinspect"
          data-diag-inspect="${this._esc(it.id)}">Inspect ›</button>` : ""}
      </div>`; }).join("")}</div>`;
  }

  _voiceName(assetOrId) {
    const lib = this._voiceLib || {};
    for (const h of lib.home_assistant || []) if (h.voice_id === assetOrId || h.entity_id === assetOrId) return h.name;
    for (const k of lib.kokoro || []) if (k.voice_id === assetOrId) return k.name;
    for (const c of lib.customs || []) if (c.voice_id === assetOrId) return c.name;
    return String(assetOrId).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // --- Booth control rows (shared with On Air) --------------------------
  _toggleRow(key, entity, hint) {
    if (!entity) return "";
    const on = entity.state === "on";
    const name = (entity.attributes.friendly_name || entity.entity_id).replace(/^Parlorwave Radio /i, "");
    return `<div class="control">
      <div><div class="label">${this._esc(name)}</div>
      <div class="hint">${this._esc(hint)}</div></div>
      <button class="pill ${on ? "on" : ""}" data-toggle="${entity.entity_id}"
        aria-label="${this._esc(name)}: ${on ? "On" : "Off"}"
        ${this._busyAttr(entity.entity_id)}>${on ? "On" : "Off"}</button>
    </div>`;
  }

  /* `hint` null means this row deliberately has no second line -- the
   * screen already said it somewhere better. `labels` lets a row show a
   * word where the entity stores a token; the VALUE written back is still
   * the entity's own, so nothing downstream learns a new vocabulary. */
  _selectRow(key, entity, label, hint, labels) {
    if (!entity) return "";
    const options = entity.attributes.options || [];
    const unavailable = entity.state === "unavailable" || options.length === 0;
    const known = options.includes(entity.state);
    const shown = (o) => (labels && labels[o]) || o;
    const opts = (known ? [] : [`<option selected disabled>${unavailable ? "Unavailable right now" : "—"}</option>`])
      .concat(options.map((o) =>
        `<option value="${this._esc(o)}" ${o === entity.state ? "selected" : ""}>${this._esc(shown(o))}</option>`)).join("");
    const descriptions = entity.attributes.descriptions || {};
    const desc = known ? descriptions[entity.state] : null;
    const line = hint === null ? null : (desc || hint);
    return `<div class="control">
      <div><div class="label">${this._esc(label)}</div>
      ${line ? `<div class="hint">${this._esc(line)}</div>` : ""}</div>
      <select data-select="${entity.entity_id}" aria-label="${this._esc(label)}" ${unavailable ? "disabled" : this._busyAttr(entity.entity_id)}>${opts}</select>
    </div>`;
  }

  /* WHOLE MINUTES LOOK LIKE WHOLE MINUTES. A Home Assistant number entity
   * carries its state as a float, so a cadence of five minutes arrives as
   * the string "5.0" and was put straight into the box. "Every 5.0 minutes"
   * is not how anybody says it, and the decimal implies a precision this
   * setting does not have (the backend takes whole minutes). A value that
   * genuinely has a fraction still shows it. */
  _numAsTyped(value) {
    const n = Number(value);
    // Number -> String drops a trailing ".0" and keeps a real fraction:
    // "5.0" becomes "5", "7.5" stays "7.5".
    return Number.isFinite(n) ? String(n) : String(value);
  }

  _numberRow(key, entity, label) {
    if (!entity) return "";
    return `<div class="control">
      <div class="label">${this._esc(label)}</div>
      <input type="number" data-number="${entity.entity_id}" aria-label="${this._esc(label)}"
        min="${entity.attributes.min}" max="${entity.attributes.max}"
        value="${this._esc(this._numAsTyped(entity.state))}" ${this._busyAttr(entity.entity_id)}>
    </div>`;
  }

  /* --- Booth --------------------------------------------------------------
   * "What should my station sound like?" Three questions, in the order a
   * person actually asks them: who is on the mic, what do they sound like,
   * and how do their breaks go. All three are about the DJ.
   *
   * What the station PLAYS between the breaks is a different question with
   * a different answer on a base install, and it has its own screen: the
   * station feel and the artist-rotation controls live in Station, beside
   * the catalog capability that decides whether they can do anything at
   * all. They are not duplicated here. */
  /* SAVED RECORDINGS. Every recording kept on this
   * installation, apart from the three Custom voices: the ones the owner
   * added, and a copy of each voice's own recording, kept before anything
   * replaces it. One line until opened. Putting a recording into a voice
   * never deletes the recording that voice had; a recording a voice is
   * using cannot be archived or deleted, and deleting asks first and only
   * offers itself for an archived recording. */
  _renderVoiceCollection() {
    const vc = this._vc;
    const entries = (vc.data && vc.data.entries) || [];
    const archived = entries.filter((e) => e.archived);
    const shown = entries.filter((e) => vc.archived || !e.archived);
    const count = vc.data ? ` · ${entries.length - archived.length}` : "";
    const head = `<div class="vgroup-head">
        <div class="vgroup-name">Saved recordings</div>
        <div class="vgroup-note">Recordings kept on this installation. Putting one into a voice
          never deletes the recording that voice had.</div>
      </div>
      <div class="row"><button class="ghost small ${vc.open ? "on" : ""}" id="vc-toggle"
        aria-expanded="${vc.open}">${vc.open ? "Hide saved recordings" : "Show saved recordings" + count}</button></div>`;
    if (!vc.open) return `<div class="vgroup vc">${head}</div>`;
    const busy = !!vc.busy;
    const off = busy ? "disabled" : "";
    const lib = this._voiceLib || {};
    const djId = (lib.selected && lib.selected.voice_id) || "";
    const slots = (vc.data && vc.data.slots) || [];
    const slotLabel = (sl) => sl.name && sl.name !== sl.label ? `${sl.label} · ${sl.name}` : sl.label;
    const consent = this._consent();
    const where = (e) => e.in_slots.length
      ? `In use as ${e.in_slots.map((x) => this._esc(slotLabel(x))).join(", ")}`
      : (e.archived ? "Archived" : "Not in a voice");
    const rowOf = (e) => {
      const used = e.in_slots.length > 0;
      const nameCol = vc.rename && vc.rename.id === e.id
        ? `<div class="row tight">
            <input type="text" class="small-input" maxlength="40" value="${this._esc(vc.rename.draft)}"
              id="vc-rename-input" aria-label="New name">
            <button class="ghost small" data-vc-rename="${e.id}" ${off}>Save</button>
            <button class="ghost small" id="vc-rename-cancel">Cancel</button></div>`
        : `<div class="label">${this._esc(e.name)}
            <button class="ghost tiny" data-vc-rename-edit="${e.id}" title="Rename this recording">✎</button></div>`;
      let actions;
      if (vc.del === e.id) {
        actions = `<span class="hint">Delete “${this._esc(e.name)}” for good?</span>
          <button class="ghost small danger" data-vc-del-yes="${e.id}" ${off}>Delete</button>
          <button class="ghost small" id="vc-del-no">Keep</button>`;
      } else {
        actions = `<button class="ghost small" data-vc-play="${e.id}" ${off}
            aria-label="Play ${this._esc(e.name)}">${vc.busy === "play:" + e.id ? "…" : "▶ Play"}</button>
          ${e.archived ? "" : `<button class="ghost small" data-vc-assign="${e.id}" ${off || (consent ? "" : "disabled")}
            aria-label="Put ${this._esc(e.name)} into a voice">Use as…</button>`}
          ${used ? "" : e.archived
            ? `<button class="ghost small" data-vc-restore="${e.id}" ${off}>Restore</button>
               <button class="ghost small danger" data-vc-del="${e.id}" ${off}
                 aria-label="Delete ${this._esc(e.name)}">Delete</button>`
            : `<button class="ghost small" data-vc-archive="${e.id}" ${off}>Archive</button>`}`;
      }
      const a = vc.assign && vc.assign.id === e.id ? vc.assign : null;
      const target = a && slots.find((sl) => sl.slot === a.slot);
      const assignForm = !a ? "" : `<div class="vc-sub">
          <label>Put it into <select id="vc-slot" aria-label="Which voice">
            ${slots.map((sl) => `<option value="${sl.slot}" ${sl.slot === a.slot ? "selected" : ""}>${this._esc(slotLabel(sl))}</option>`).join("")}
          </select></label>
          <div class="hint">That voice's current recording stays here in Saved recordings.
            ${target && target.slot === djId ? " This voice is the DJ: the next break uses this recording." : ""}</div>
          ${consent ? `<label class="check"><input type="checkbox" id="vc-ack" ${a.ack ? "checked" : ""}>
            ${this._esc(consent.text)}</label>` : ""}
          <div class="row tight">
            <button class="primary small" id="vc-assign-go" ${off || (a.ack ? "" : "disabled")}>
              ${vc.busy === "assign" ? "Putting it in…" : "Use this recording"}</button>
            <button class="ghost small" id="vc-assign-cancel" ${off}>Cancel</button></div>
        </div>`;
      return `<div class="vrow vc-row ${e.archived ? "vgone" : ""}">
          <span class="vpick"></span>
          <div class="vname">${nameCol}
            <div class="vdesc">${where(e)}${e.permission ? "" : " · Permission not recorded"}</div></div>
          <div class="vnote"></div>
          <div class="vactions">${actions}</div>
        </div>${assignForm}`;
    };
    const imp = vc.imp;
    const importForm = !imp
      ? `<div class="row"><button class="ghost small" id="vc-import-open" ${off || (consent ? "" : "disabled")}>
          + Add a recording file</button></div>`
      : `<div class="vc-sub">
          <label>Recording (WAV, MP3 or FLAC)
            <input type="file" id="vc-file" accept=".wav,.mp3,.flac,audio/wav,audio/mpeg,audio/flac"></label>
          ${imp.file ? `<div class="hint">${this._esc(imp.file.name)}</div>` : ""}
          <label>Name <input type="text" class="small-input" id="vc-import-name" maxlength="40"
            value="${this._esc(imp.name)}"></label>
          <label class="check"><input type="checkbox" id="vc-import-ack" ${imp.ack ? "checked" : ""}>
            ${this._esc((consent || {}).text || "")}</label>
          <div class="row tight">
            <button class="primary small" id="vc-import-go"
              ${off || (imp.file && imp.name.trim() && imp.ack ? "" : "disabled")}>
              ${vc.busy === "import" ? "Saving…" : "Save recording"}</button>
            <button class="ghost small" id="vc-import-cancel" ${off}>Cancel</button></div>
        </div>`;
    const body = !vc.data
      ? `<div class="hint">${vc.error ? "" : "Loading saved recordings…"}</div>`
      : (shown.length ? shown.map(rowOf).join("") : `<div class="hint">No saved recordings yet.</div>`);
    return `<div class="vgroup vc">${head}
      ${vc.error ? `<div class="notice err">${this._esc(vc.error)}</div>` : ""}
      ${(vc.data && vc.data.problems && vc.data.problems.length)
        ? `<div class="hint">${this._esc(vc.data.problems[0])}</div>` : ""}
      ${body}
      ${archived.length ? `<div class="row"><button class="ghost tiny" id="vc-archived">
        ${vc.archived ? "Hide archived" : `Show archived (${archived.length})`}</button></div>` : ""}
      ${importForm}
    </div>`;
  }

  async _fetchVc() {
    try { this._vc.data = await this._ws("parlorwave_radio/voice_collection"); this._vc.error = null; }
    catch (e) { this._vc.error = "Saved recordings could not be loaded: " + ((e && e.message) || e); }
    this._render();
  }

  /* One library action at a time; the listing is read again after it. */
  async _vcDo(busy, type, args, done) {
    if (this._vc.busy) return;
    this._vc.busy = busy; this._vc.error = null; this._render();
    try {
      const out = await this._ws(type, args);
      if (done) done(out);
    } catch (e) {
      this._vc.error = (e && e.message) || String(e);
    }
    this._vc.busy = null;
    await this._fetchVc();
  }

  async _vcPlay(id) {
    if (this._vc.busy) return;
    this._vc.busy = "play:" + id; this._render();
    try {
      const out = await this._ws("parlorwave_radio/voice_collection_audio", { entry_id: id });
      const bytes = Uint8Array.from(atob(out.audio_b64 || ""), (ch) => ch.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: out.content_type || "audio/wav" }));
      const audio = new Audio(url);
      audio.addEventListener("ended", () => URL.revokeObjectURL(url));
      await audio.play();
    } catch (e) {
      this._vc.error = "That recording could not be played: " + ((e && e.message) || e);
    }
    this._vc.busy = null; this._render();
  }

  async _vcImport() {
    const vc = this._vc, imp = vc.imp, consent = this._consent();
    if (vc.busy || !imp || !imp.file || !imp.name.trim() || !imp.ack || !consent) return;
    vc.busy = "import"; vc.error = null; this._render();
    try {
      const query = new URLSearchParams({ library: "true", name: imp.name.trim(),
        authorized: "true", consent_version: consent.version, source: "file" });
      const send = async () => fetch(`${VOICE_SAMPLE_PATH}?${query.toString()}`, {
        method: "POST", headers: await this._authHeaders(), body: imp.file });
      let resp = await send();
      if (resp.status === 401 && this._authRetry()) resp = await send();
      const out = await resp.json().catch(() => ({}));
      if (!resp.ok || out.ok === false) vc.error = uploadRefusal(resp.status, out);
      else {
        vc.imp = null;
        this._setNotice(true, out.created === false
          ? `That recording is already saved, as “${out.name}”.` : `Saved “${out.name}”.`);
      }
    } catch (e) {
      vc.error = "The recording did not reach Home Assistant. Check the connection and try again.";
    }
    vc.busy = null;
    await this._fetchVc();
  }

  _renderBooth() {
    const present = [this._personality, this._voice,
                     this._cadence, this._breakLength, this._weather].some(Boolean);
    if (!present) {
      return `<section class="card">
        <h2>Booth</h2>
        <div class="hint">Booth controls have not loaded yet. If this persists after a
        moment, the ParlorWave Radio integration may need a reload or an update.</div>
      </section>`;
    }
    return `${this._renderMicCard()}
      ${this._renderVoiceCard()}
      ${this._renderBreakStyle()}`;
  }

  /* The top of the Booth: who is on the mic. The personality's own name is
   * the headline and its curated description is the subtitle, so the
   * choice reads as a person rather than as a dropdown value.
   *
   * One press per personality. A dropdown only changed the
   * headline once it lost focus, so the card disagreed with itself while
   * a choice was being made. The press shows at once (`_personaPick`) and
   * the entity's own state confirms it. Two different facts are stated
   * separately and need not agree: what the NEXT written break will use,
   * and what the LAST one was actually written as (its own telemetry). */
  _renderMicCard() {
    const e = this._personality;
    const jvAttrs = (this._djStatus && this._djStatus.attributes) || {};
    const descriptions = (e && e.attributes.descriptions) || {};
    const options = (e && e.attributes.options) || [];
    const saved = e && e.state && options.includes(e.state) ? e.state : null;
    const pick = this._personaShown(saved);
    const name = pick || saved;
    const desc = name ? descriptions[name] : null;
    const saving = !!pick && pick !== saved;
    const busy = !!e && this._busy === e.entity_id;
    const last = jvAttrs.last_break_personality
      ? this._personaName(jvAttrs.last_break_personality) : null;
    const chips = options.length
      ? `<div class="persona-chips" role="group" aria-label="Personality">${options.map((o) =>
          `<button class="persona-chip ${o === name ? "on" : ""}" data-persona="${this._esc(o)}"
                   aria-pressed="${o === name ? "true" : "false"}" ${busy ? "disabled" : ""}>${this._esc(o)}</button>`).join("")}</div>`
      : `<div class="hint">Personalities are unavailable right now.</div>`;
    return `
      <section class="booth-hero" aria-label="DJ personality">
        <div class="stage-glow" aria-hidden="true"></div>
        <div class="booth-hero-body">
          <div class="booth-eyebrow">On the mic</div>
          <h2 class="booth-name">${this._esc(name || "No personality selected")}</h2>
          ${desc ? `<div class="booth-desc">${this._esc(desc)}</div>` : ""}
          ${chips}
          <div class="persona-facts">
            ${name ? `<div class="hint"><b>Next break:</b> ${this._esc(name)} ${saving
              ? "· saving…" : "· selected for the next break the DJ writes"}</div>` : ""}
            ${last ? `<div class="hint"><b>Last break:</b> written as ${this._esc(last)}</div>` : ""}
          </div>
          <div class="hint">Changes what the DJ writes, not the voice, and not how often or how long they talk.</div>
        </div>
      </section>`;
  }

  /* The pressed personality while its save is on the way, or null. It
   * gives way to the entity the moment the entity agrees, and after 15 s
   * regardless, so a write the backend refused cannot stay on screen. */
  _personaShown(saved) {
    const p = this._personaPick;
    if (!p) return null;
    if (p.option === saved || Date.now() - p.at > 15000) {
      this._personaPick = null;
      return null;
    }
    return p.option;
  }

  async _pickPersona(option) {
    const e = this._personality;
    if (!e || !option || this._busy === e.entity_id) return;
    if (option === e.state && !this._personaPick) return;
    this._personaPick = { option, at: Date.now() };
    const ok = await this._select(e, option);
    if (!ok) this._personaPick = null;
    this._render();
  }

  /* The voice card: what is speaking now, a way to change it, and the
   * library behind a press. The selected voice is stated in words and
   * shown as a tile -- never signalled by colour alone. */
  _renderVoiceCard() {
    return `
      <section class="card">
        <h2>Voice</h2>
        ${this._voiceNowTile()}
        <div class="controls">${this._voiceRow()}</div>
        ${this._renderShifts((this._voiceLib || {}).dj)}
        <div class="row">
          <button class="ghost ${this._voicesOpen ? "on" : ""}" id="voices-toggle"
                  aria-pressed="${this._voicesOpen}" aria-label="Voice library">
            ${this._voicesOpen ? "Close voice library" : "Voice library"}</button>
        </div>
        ${this._voicesOpen ? this._renderVoiceLibrary() : ""}
      </section>`;
  }

  /* Which group a voice belongs to, in the customer's words. Derived from
   * the shelf the backend put it on -- never from its id. */
  _voiceGroupOf(voiceId) {
    const lib = this._voiceLib || {};
    const on = (list) => (list || []).some((v) => v.voice_id === voiceId);
    if (on(lib.home_assistant)) return "ha";
    if (on(lib.kokoro)) return "local";
    const cur = lib.current && lib.current.voice_id === voiceId ? lib.current : null;
    // a current voice with no recording of its own (no provider) is the
    // voice engine's default sample; one that names a recording is the
    // owner's, enrolled before these shelves existed
    if (cur && !cur.provider) return "engine";
    if (on(lib.customs) || cur) return "mine";
    // A voice no shelf claims -- a library that has not arrived yet, or an
    // enrolled voice from before these shelves existed. Saying nothing is
    // correct; filing it under "My Voices" because that is the last branch
    // would put someone else's words in the customer's mouth.
    return null;
  }

  _voiceNowTile() {
    const e = this._voice;
    const lib = this._voiceLib || {};
    const dj = lib.dj || null;
    const selectedId = (lib.selected && lib.selected.voice_id) || "";
    // The backend's own answer to "who is the DJ" first; the picker's
    // state until the shelf has arrived.
    const name = (dj && dj.name) || (e && e.state && e.state !== "unavailable"
      ? e.state : (selectedId ? this._voiceName(selectedId) : null));
    if (!name) {
      return `<div class="vnow"><div class="vnow-body">
        <div class="vnow-name">No voice selected</div>
        <div class="vnow-meta">Pick one from the voice library below.</div>
      </div></div>`;
    }
    const id = selectedId || this._voiceIdForName(name);
    const key = this._voiceGroupOf(id);
    const meta = [key ? VOICE_GROUPS[key][0] : null, this._voiceNote(id)]
      .filter(Boolean).map((t) => this._esc(t)).join(" · ");
    const busy = !!this._previewing;
    return `<div class="vnow">
      <div class="vnow-body">
        <div class="vnow-eyebrow">Current DJ</div>
        <div class="vnow-name">${this._esc(name)}</div>
        ${meta ? `<div class="vnow-meta">${meta}</div>` : ""}
        ${this._djStandIn(dj)}
      </div>
      <span class="vbadge">Selected</span>
      <button class="ghost small" data-preview="${this._esc(id || "")}"
              ${(!id || busy) ? "disabled" : ""} aria-label="Preview the selected voice">
        ${busy && this._previewing === id ? "…" : "▶ Preview"}</button>
    </div>`;
  }

  /* When the chosen DJ is not the voice a break would use, the tile says
   * so in words: the recording is gone or was replaced by another, or the
   * voice is no longer allowed to be the DJ. The backend then speaks with
   * the service default and changes nothing; choosing again is the
   * owner's act. And while "Speak DJ breaks" is off, a new DJ is heard
   * only when it is back on -- said here, so a silent switch is not
   * mistaken for a broken one. */
  _djStandIn(dj) {
    const lines = [];
    if (dj && dj.in_force === false) {
      const why = DJ_VOICE_NOT_IN_FORCE[dj.reason] || "it cannot be used as the DJ right now";
      lines.push(`Not on the air: ${why}. DJ breaks use the service default voice until you choose a DJ again.`);
    }
    if (this._djSpeech && this._djSpeech.state === "off") {
      lines.push("DJ breaks are off. This voice is heard when Speak DJ breaks is back on.");
    }
    return lines.map((t) => `<div class="vnow-standin">${this._esc(t)}</div>`).join("");
  }

  /* Automatic DJ shifts: one switch, and a voice for Morning, Afternoon
   * and Night. The backend owns the clock -- which shift it is comes from
   * the station's Home Assistant time as `current_shift`, never from this
   * browser -- and the boundaries it states are the station's dayparts.
   * An owner's own choice of DJ holds until the next shift, and the card
   * says so; a shift whose voice cannot be used says why. */
  _renderShifts(dj) {
    const sh = dj && dj.shifts;
    if (!sh) return "";
    const busy = !!this._shiftsBusy;
    const title = (s) => DJ_SHIFT_LABELS[s] || s;
    const hour = (hhmm) => {
      const h = Number(String(hhmm || "").split(":")[0]);
      if (!Number.isFinite(h)) return "";
      return h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`;
    };
    const order = ["morning", "afternoon", "night"];
    const span = (s) => `${hour(sh.starts[s])}–${hour(sh.starts[order[(order.indexOf(s) + 1) % 3]])}`;
    let status;
    if (!sh.enabled) status = "Off. The DJ is whoever you choose.";
    else if (!sh.clock_known) status = "Waiting for the station clock from Home Assistant.";
    else if (sh.override) status = `${title(sh.current_shift)} shift. Manual override until ${title(sh.next_shift)} shift.`;
    else if (sh.pending) status = `${title(sh.current_shift)} shift. Its DJ takes over with the next DJ pass.`;
    else status = `${title(sh.current_shift)} shift.`;
    const lineup = dj.lineup || [];
    const row = (s) => {
      const a = sh.assignments[s] || {};
      const ids = new Set(lineup.map((v) => v.voice_id));
      const opts = [`<option value="" ${a.voice_id ? "" : "selected"}>Not assigned</option>`]
        .concat(lineup.map((v) =>
          `<option value="${this._esc(v.voice_id)}" ${v.voice_id === a.voice_id ? "selected" : ""}>${this._esc(v.name)}</option>`));
      if (a.voice_id && !ids.has(a.voice_id)) {
        opts.push(`<option value="${this._esc(a.voice_id)}" selected disabled>${this._esc(a.name || "Unavailable voice")}</option>`);
      }
      const why = a.problem
        ? (DJ_VOICE_NOT_IN_FORCE[a.problem] || DJ_SHIFT_PROBLEMS[a.problem] || "it cannot be used right now")
        : null;
      const now = sh.enabled && sh.current_shift === s;
      return `<div class="control">
        <div><div class="label">${this._esc(title(s))}${now ? " · now" : ""}</div>
        <div class="hint">${this._esc(span(s))}</div>
        ${why ? `<div class="hint">${this._esc(`${a.name || "This voice"} will not host: ${why}.`)}</div>` : ""}</div>
        <select data-shift="${s}" aria-label="${this._esc(title(s))} DJ" ${busy ? "disabled" : ""}>${opts.join("")}</select>
      </div>`;
    };
    return `<div class="controls">
      <div class="control">
        <div><div class="label">Automatic DJ shifts</div>
        <div class="hint">${this._esc(status)}</div></div>
        <button class="pill ${sh.enabled ? "on" : ""}" data-shifts-toggle
          aria-label="Automatic DJ shifts: ${sh.enabled ? "On" : "Off"}" ${busy ? "disabled" : ""}>${sh.enabled ? "On" : "Off"}</button>
      </div>
      ${order.map(row).join("")}
    </div>`;
  }

  _voiceNote(voiceId) {
    const lib = this._voiceLib || {};
    for (const list of [lib.home_assistant, lib.kokoro, lib.customs]) {
      for (const v of list || []) if (v.voice_id === voiceId) return v.note || "";
    }
    return "";
  }

  _renderBreakStyle() {
    // "On" is the listener's preference; whether stories can air is the
    // service's to say (the switch's `airing`). Absent means not reported.
    const stories = this._djStories;
    const notAiring = !!stories && stories.state === "on" && stories.attributes.airing === false;
    return `
      <section class="card">
        <h2>Break style</h2>
        <div class="controls">
          ${this._toggleRow("dj-speech", this._djSpeech,
            "Off keeps the DJ running and the music, news and announcements playing, but the DJ does not talk between songs")}
          ${this._toggleRow("dj-stories", this._djStories, notAiring
            ? "Not airing in this release yet: the DJ hosts the usual breaks. Your choice is kept for when stories arrive"
            : "Short true stories about the artists you're hearing, from your own Music Assistant library. Off keeps the usual breaks")}
          ${this._selectRow("break-length", this._breakLength, "Break length",
            "How long a break runs when one comes round", BREAK_LENGTH_LABELS)}
          ${this._numberRow("cadence", this._cadence, "Minimum minutes between breaks")}
          ${this._toggleRow("weather", this._weather, "The DJ may mention the weather")}
          ${this._toggleRow("calendar", this._calendar, "The DJ may mention what's coming up")}
        </div>
        <div class="hint">Saved as you change them. The cadence applies to the next break
        the DJ plans; the rest to the next break the DJ writes.</div>
      </section>`;
  }

  // The picker shows friendly NAMES; a preview needs the voice id behind
  // the name. The shelf is the only place that mapping lives.
  _voiceIdForName(name) {
    const lib = this._voiceLib || {};
    const all = [].concat(lib.home_assistant || [], lib.kokoro || [], lib.customs || [],
                          lib.current ? [lib.current] : []);
    const hit = all.find((v) => v.name === name);
    return hit ? hit.voice_id : null;
  }

  /* The quick way to change voice: one dropdown, grouped by the same three
   * customer-facing shelves the library uses, so the two surfaces never
   * disagree about where a voice lives. */
  _voiceRow() {
    const e = this._voice;
    if (!e) return "";
    const unavailable = e.state === "unavailable";
    const options = (e.attributes && e.attributes.options) || [];
    const lib = this._voiceLib || {};
    const namesOf = (list) => new Set((list || []).map((v) => v.name));
    const haNames = namesOf(lib.home_assistant);
    const localNames = namesOf(lib.kokoro);
    const engineNames = namesOf(lib.current && !lib.current.provider ? [lib.current] : []);
    const grouped = [
      [VOICE_GROUPS.ha[0], options.filter((o) => haNames.has(o))],
      [VOICE_GROUPS.local[0], options.filter((o) => localNames.has(o))],
      [VOICE_GROUPS.engine[0], options.filter((o) => engineNames.has(o))],
      [VOICE_GROUPS.mine[0], options.filter((o) => !haNames.has(o) && !localNames.has(o)
                                                   && !engineNames.has(o))],
    ].filter(([, list]) => list.length > 0);

    const option = (o) =>
      `<option value="${this._esc(o)}" ${o === e.state ? "selected" : ""}>${this._esc(o)}</option>`;
    let optsHtml = "";
    if (!options.includes(e.state)) {
      optsHtml += `<option selected disabled>${unavailable ? "Unavailable right now" : "—"}</option>`;
    }
    optsHtml += grouped.length > 1
      ? grouped.map(([label, list]) =>
          `<optgroup label="${this._esc(label)}">${list.map(option).join("")}</optgroup>`).join("")
      : options.map(option).join("");

    return `<div class="control">
      <div><div class="label">Change voice</div>
      <div class="hint">Who the DJ sounds like. Changing it never changes the personality.</div></div>
      <select data-select="${e.entity_id}" aria-label="DJ Voice" ${unavailable ? "disabled" : this._busyAttr(e.entity_id)}>${optsHtml}</select>
    </div>`;
  }

  /* --- the voice library --------------------------------------------------
   * Three groups, in the order a person meets them: what Home Assistant
   * already gives them, what Parlorwave ships, and what they made
   * themselves. Storage ids never appear in anything rendered -- they live
   * in data attributes, which is how the wiring finds a row again. */
  _renderVoiceLibrary() {
    const lib = this._voiceLib;
    if (!lib) return `<div class="hint">Loading the voice library…</div>`;
    const selected = (lib.selected && lib.selected.voice_id) || "";
    const busy = !!this._previewing;
    const preview = (id) => `<button class="ghost small" data-preview="${id}"
      ${busy ? "disabled" : ""} aria-label="Preview this voice">${this._previewing === id ? "…" : "▶ Preview"}</button>`;
    const pick = (name, on) => `<label class="vpick" title="Use this voice">
      <input type="radio" name="dj-voice" data-vpick="${this._esc(name)}" ${on ? "checked" : ""}
             aria-label="Use ${this._esc(name)}"></label>`;
    // The note is the owner's own reminder for a voice ("calm, slower reader").
    // Edited inline; the draft lives in state, so a re-render can never put
    // the stored note back under the cursor.
    const noteLine = (id, note) => {
      if (this._noteEditing === id) {
        const draft = this._noteDraft === null ? (note || "") : this._noteDraft;
        return `<div class="row tight">
          <input type="text" class="small-input" maxlength="80" placeholder="Note to self…"
            value="${this._esc(draft)}" data-vnote-input="${id}">
          <button class="ghost small" data-vnote="${id}">Save</button>
          <button class="ghost small" data-vnote-cancel="${id}">Cancel</button>
        </div>`;
      }
      // No note is the common case. It gets one quiet affordance, not a
      // sentence saying so on every row -- nine rows of "No note yet."
      // is the loudest thing on a screen whose subject is voices.
      // "Clear" for the NOTE: this row already has a bin, and that one
      // removes the voice.
      return note
        ? `<div class="vnote-line"><span>${this._esc(note)}</span>
            <button class="ghost tiny" data-vnote-edit="${id}" title="Change this note">✎</button>
            <button class="ghost tiny" data-vnote-clear="${id}" title="Clear this note">✕</button></div>`
        : `<div class="vnote-line">
            <button class="ghost tiny" data-vnote-edit="${id}" title="Add a note to self">✎ Note</button></div>`;
    };
    // The name column. Any voice can be renamed inline (same draft-in-state
    // rule as the note); a built-in wearing the owner's name says which
    // curated voice it is, and can be put back with one press.
    const nameLine = (id, name, builtin) => {
      const renamed = builtin && builtin !== name;
      if (this._nameEditing === id) {
        const draft = this._nameDraft === null ? name : this._nameDraft;
        return `<div class="row tight">
          <input type="text" class="small-input" maxlength="40" placeholder="Name…"
            value="${this._esc(draft)}" data-vrename-input="${id}">
          <button class="ghost small" data-vrename="${id}">Save</button>
          <button class="ghost small" data-vrename-cancel="${id}">Cancel</button>
          ${renamed ? `<button class="ghost small" data-vrename-reset="${id}"
            title="Back to the built-in name">↺ ${this._esc(builtin)}</button>` : ""}
        </div>`;
      }
      return `<div class="label">${this._esc(name)}
          <button class="ghost tiny" data-vrename-edit="${id}" title="Rename this voice">✎</button></div>
        ${renamed ? `<div class="vdesc">Renamed from ${this._esc(builtin)}</div>` : ""}`;
    };
    const fx = (n) => Number(n == null ? 1 : n).toFixed(2);
    // Delivery for a built-in: speed and the pause between sentences. The
    // sliders are a draft; "Preview these" plays the draft, Save stores it.
    // Cloned voices have no such row -- their delivery is the recording's own.
    const tuneRow = (k) => {
      const t = this._tune;
      if (!t || t.id !== k.voice_id) return "";
      return `
      <div class="vrow vtune">
        <span class="vpick"></span>
        <div class="vtune-body">
          <label>Speed
            <input type="range" min="0.7" max="1.3" step="0.05" value="${fx(t.speed)}" data-vtune-speed="${k.voice_id}">
            <b data-vtune-speed-val="${k.voice_id}">${fx(t.speed)}</b></label>
          <label>Pause between sentences
            <input type="range" min="0.5" max="2.5" step="0.1" value="${fx(t.pause)}" data-vtune-pause="${k.voice_id}">
            <b data-vtune-pause-val="${k.voice_id}">${fx(t.pause)}</b></label>
          <div class="row tight">
            <button class="ghost small" data-vtune-preview="${k.voice_id}" ${busy ? "disabled" : ""}>
              ${busy && this._previewing === k.voice_id ? "…" : "▶ Preview these"}</button>
            <button class="ghost small" data-vtune-save="${k.voice_id}">Save</button>
            <button class="ghost small" data-vtune-default="${k.voice_id}">Back to 1.00 / 1.00</button>
            <button class="ghost small" data-vtune-close="${k.voice_id}">Close</button>
          </div>
          <div class="hint">1.00 is the engine's own. Lower speed is more deliberate; a longer
            pause lets short sentences breathe. Commas follow speed, not pause.</div>
        </div>
      </div>`;
    };
    // A voice whose provider cannot be reached is kept on the shelf --
    // one that vanishes reads as one that was deleted -- but it says so
    // BESIDE ITS NAME, where the eye already is. Left in the actions
    // column the word ends up alone, and on a phone (where that column
    // spans the row) it reads as a heading for the voice below it.
    /* WHAT A VOICE IS FOR. Every shelved
     * voice carries the owner's grant: the DJ, announcements, or both. It
     * is changed here, one voice at a time, and nowhere else; the default
     * announcement voice below is a PREFERENCE among the voices allowed
     * for announcements and grants nothing. The DJ's own voice cannot be
     * made announcements-only (the backend refuses it too).
     *
     * Since alpha.4: one small chip per row that SAYS the grant, and
     * opens to change it -- grant and withdraw both, the same three
     * choices and the same one write as the dropdown it replaces. The
     * grant is never widened here: a voice nobody scoped stays The DJ. */
    const scopeLine = (v, on) => {
      const cur = v.scope || "dj";
      const open = this._vroleOpen === v.voice_id;
      return `<details class="vscope" data-vrole="${this._esc(v.voice_id)}" ${open ? "open" : ""}>
        <summary aria-label="What ${this._esc(v.name)} is used for: ${this._esc(VOICE_SCOPE_LABELS[cur])}">Used for: <b>${this._esc(VOICE_SCOPE_LABELS[cur])}</b></summary>
        <div class="vscope-pop" role="group" aria-label="What ${this._esc(v.name)} is used for">
          ${["dj", "announcement", "both"].map((sc) => `<button class="ghost small ${cur === sc ? "on" : ""}"
            data-vscope="${this._esc(v.voice_id)}" data-scope="${sc}" aria-pressed="${cur === sc}"
            ${sc === "announcement" && on ? `disabled title="The DJ's own voice cannot be announcements only"` : ""}>${VOICE_SCOPE_LABELS[sc]}</button>`).join("")}
        </div></details>`;
    };
    // A voice allowed for announcements only is not a DJ voice: it has
    // no radio to pick it as one.
    const djOk = (v) => v.scope !== "announcement";
    const row = (v, opts) => {
      const on = v.voice_id === selected;
      const gone = v.available === false;
      return `<div class="vrow ${on ? "vsel" : ""} ${gone ? "vgone" : ""}">
        ${gone ? `<span class="vpick"></span>` : (djOk(v) || on ? pick(v.name, on)
          : `<span class="vpick" title="Allowed for announcements only"></span>`)}
        <div class="vname">${opts.rename === false
          ? `<div class="label">${this._esc(v.name)}</div>`
          : nameLine(v.voice_id, v.name, opts.builtin || "")}
          ${gone ? `<div class="vdesc">Unavailable right now</div>`
                 : (opts.desc ? `<div class="vdesc">${this._esc(opts.desc)}</div>` : "")}
          ${gone || opts.scope === false ? "" : scopeLine(v, on)}</div>
        <div class="vnote">${opts.note === false ? "" : noteLine(v.voice_id, v.note)}</div>
        <div class="vactions">
          ${on ? `<span class="vbadge">Selected</span>` : ""}
          ${v.announcement_default ? `<span class="vbadge vbadge-quiet"
            title="Reads announcements that do not name a voice">Announcements</span>` : ""}
          ${gone ? "" : preview(v.voice_id) + (opts.extra || "")}
        </div>
      </div>${opts.after || ""}`;
    };

    // A group head describes what is in the group. When NOTHING in it can
    // be used -- seven curated voices with no engine behind them -- the
    // description becomes a claim the installation cannot back, so it is
    // replaced by the plain fact. Why is not guessed at: the panel knows
    // that the voices are unavailable, not what is missing.
    const allGone = (list) => (list || []).length > 0
      && (list || []).every((v) => v.available === false);
    const group = (key, rows, extra, gone) => rows || extra ? `
      <div class="vgroup">
        <div class="vgroup-head">
          <div class="vgroup-name">${this._esc(VOICE_GROUPS[key][0])}</div>
          <div class="vgroup-note">${gone ? "None of these are available right now."
            : this._esc(VOICE_GROUPS[key][1])}</div>
        </div>
        ${rows || ""}${extra || ""}
      </div>` : "";

    // A row says what the GROUP HEAD has not already said, and nothing
    // more. Repeating "Curated DJ voice." under seven curated DJ voices
    // filed under "Curated DJ voices" is noise wearing the clothes of
    // information -- and no characterisation is invented for a voice the
    // backend describes only by name.
    const haRows = (lib.home_assistant || []).map((h) => row(h, {})).join("");

    const localRows = (lib.kokoro || []).map((k) => row(k, {
      builtin: k.builtin_name,
      desc: (fx(k.speed) !== "1.00" || fx(k.pause) !== "1.00")
        ? `Speed ${fx(k.speed)} · pause ${fx(k.pause)}` : "",
      extra: k.available === false ? "" : `<button class="ghost small" data-vtune="${k.voice_id}"
        title="Speed and pause" aria-label="Tune this voice">Tune</button>`,
      after: tuneRow(k),
    })).join("");

    // My Voices: only voices that EXIST. An empty storage slot is not a
    // voice and is never rendered as one.
    const mine = (lib.customs || []).filter((c) => c.has_sample);
    // A made voice says whether the owner's permission is on record: the
    // acknowledgement given when it was recorded, or -- for a voice made
    // before that was asked -- plainly that it is not.
    const permission = (c) => {
      const a = c.authorization || {};
      if (a.status !== "granted") return "Permission not recorded";
      const when = a.granted_at ? new Date(a.granted_at) : null;
      return when && !isNaN(when)
        ? `Permission recorded ${when.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`
        : "Permission recorded";
    };
    // A new recording is an enrollment: not offered while the backend says
    // enrollment is not qualified. The voice itself stays, and keeps Delete.
    const replaceOff = this._enrollmentOff();
    const mineRows = mine.map((c) => row(c, {
      desc: permission(c),
      extra: this._confirmDelete === c.voice_id
        ? `<span class="hint">Delete this voice?</span>
           <button class="ghost small danger" data-vdelete-yes="${c.voice_id}">Delete</button>
           <button class="ghost small" data-vdelete-no="${c.voice_id}">Keep</button>`
        : `${replaceOff ? "" : `<button class="ghost small" data-vreplace="${c.voice_id}"
             aria-label="Replace this voice's recording">Replace</button>`}
           <button class="ghost small danger" data-vdelete="${c.voice_id}"
             aria-label="Delete this voice">Delete</button>`,
    })).join("") + (lib.current && lib.current.provider ? row(lib.current, {
      rename: false, note: false, scope: false,
      desc: "Your enrolled voice.",
    }) : "");
    // the voice engine's own default sample is NOT the owner's voice: its
    // own group, never "My Voices"
    const engineRows = lib.current && !lib.current.provider ? row(lib.current, {
      rename: false, note: false, scope: false, desc: "",
    }) : "";

    /* THE CURATED SHELF IS SHELVED, NOT DELETED.
     *
     * Those voices are served by an optional engine this release does not
     * ship. On an ordinary installation every one of them is unavailable,
     * and seven greyed-out names under a heading that promises curated DJ
     * voices reads as a product that is broken rather than as a capability
     * that is optional.
     *
     * So the shelf is not drawn when nothing on it can be used. Nothing
     * else changes: the provider, the voice ids, the name and delivery
     * mappings, the availability probe and every test over them are
     * untouched, and the moment the engine answers, the same shelf appears
     * with the same voices on it.
     *
     * ONE EXCEPTION, and it is not optional: a voice that is CURRENTLY
     * SELECTED is always shown, even unavailable. Hiding the voice the
     * station is set to use would leave a person looking at a library that
     * does not contain their own DJ. */
    const localSelected = (lib.kokoro || []).some((k) => k.voice_id === selected);
    const localShelved = allGone(lib.kokoro) && !localSelected;

    return `<div class="voices">
      ${lib.ok === false ? `<div class="notice err">${this._esc(lib.error || "The voice engine could not be reached.")}</div>` : ""}
      ${this._renderPreviewLine(lib)}
      ${group("ha", haRows, null, allGone(lib.home_assistant))}
      ${localShelved ? "" : group("local", localRows, null, allGone(lib.kokoro))}
      ${group("engine", engineRows)}
      ${group("mine", mineRows, this._renderCustomVoices(mine.length))}
      ${this._renderVoiceCollection()}
      ${this._renderAnnouncementVoice(lib)}
    </div>`;
  }

  /* The line every ▶ Preview in the library speaks: the owner's own, or
   * (left empty) the backend's fixed phrase. Heard in this browser only.
   *
   * The whole line is on screen and editable before anything is
   * pressed. Untouched, the box holds the backend's own phrase -- the
   * line a preview with no text speaks, so what is read is what is
   * heard; cleared, it is empty and Preview speaks that same phrase. */
  _renderPreviewLine(lib) {
    const p = lib.preview || {};
    const max = Number(p.max_chars) || 200;
    const shown = this._previewText == null ? (p.default_text || "") : this._previewText;
    return `<div class="control vpreview-line">
      <label class="label" for="voice-preview-text">Preview line</label>
      <div class="hint">What ▶ Preview says, heard here in this browser only. Edit it
        to hear your own words.</div>
      <textarea id="voice-preview-text" rows="3" maxlength="${max}"
        placeholder="${this._esc(p.default_text || "Type a line to hear…")}">${this._esc(shown)}</textarea>
    </div>`;
  }

  /* Which voice reads an announcement whose calendar event names none.
   * Only voices ALLOWED for announcements are offered -- choosing one
   * here allows nothing -- and a default whose permission was since
   * withdrawn is shown as exactly that rather than hidden. */
  _renderAnnouncementVoice(lib) {
    const d = lib.announcement_default || {};
    const current = d.voice_id || "";
    const offered = [].concat(
      (lib.home_assistant || []).filter((v) => v.available !== false),
      (lib.kokoro || []).filter((v) => v.available !== false),
      (lib.customs || []).filter((v) => v.has_sample))
      .filter((v) => v.scope === "announcement" || v.scope === "both");
    const listed = offered.some((v) => v.voice_id === current);
    const stale = current && !listed;
    const staleName = stale ? (this._voiceName(current) || "The chosen voice") : "";
    const opts = [`<option value="" ${current ? "" : "selected"}>The DJ's voice</option>`]
      .concat(stale ? [`<option value="" selected disabled>${this._esc(staleName)} (not allowed for announcements)</option>`] : [])
      .concat(offered.map((v) => `<option data-voice="${this._esc(v.voice_id)}"
        ${v.voice_id === current ? "selected" : ""}>${this._esc(v.name)}</option>`)).join("");
    return `<div class="vgroup">
      <div class="vgroup-head">
        <div class="vgroup-name">Announcements</div>
        <div class="vgroup-note">A calendar entry can name any voice allowed for
          announcements on a <b>voice:</b> line in its description.</div>
      </div>
      <div class="control">
        <div><div class="label">Read announcements in</div>
        <div class="hint">${stale
          ? "That voice is no longer allowed for announcements, so announcements are read in the DJ's voice until you choose again."
          : offered.length
            ? "For an announcement that does not name a voice. Choosing one here allows nothing: only voices already allowed for announcements are listed."
            : "No voice is allowed for announcements yet. Set a voice's “Used for” above to allow it."}</div></div>
        <select id="announce-voice" aria-label="Read announcements in"
          ${offered.length || current ? "" : "disabled"}>${opts}</select>
      </div>
    </div>`;
  }

  /* --- custom voices ------------------------------------------------------
   * The one place that decides whether creating a voice is OFFERED. Every
   * branch is a fact the backend published about itself; nothing here
   * guesses at a capability, and nothing here says where a recording goes
   * beyond what the engine's own configuration states. */
  _renderCustomVoices(existing) {
    const cloning = (this._voiceLib && this._voiceLib.cloning) || {};
    if (this._enrollmentOff()) {
      // NOT IN THIS RELEASE, engine or no engine: the backend refuses new
      // voices and says why. The button keeps its place, disabled, so
      // nothing moves in the release that turns it on.
      return `<div class="row clone-row">
        <button class="ghost" disabled aria-disabled="true"
                title="Not available in this release">＋ Add voice</button>
        <span class="hint">${this._esc(cloning.message || "Making a voice from a recording is not available in this release.")}
        Home Assistant's own voices work as usual.</span>
      </div>`;
    }
    if (this._create) return this._renderCreateVoice();
    if (!cloning.configured) {
      /* NOT A DEAD END, AND NOT A PROMISE.
       *
       * What was here before was a paragraph under a second heading,
       * describing a feature with nothing on screen to press -- which
       * reads as an unfinished prototype rather than as a capability that
       * has not been bought yet. The entry point is now the real one,
       * disabled, saying in one line what would switch it on. The button
       * that appears when the engine IS configured is the same button in
       * the same place, so nothing moves when it becomes available. */
      /* WHAT IS MISSING, AND THE DOOR TO IT. The sentence used to end at
       * "this release does not include", which was true of the ENGINE and
       * wrong about the product: there is a place to point
       * Parlorwave at one, and a person reading a flat refusal had no way
       * to know that. It still promises nothing — the button stays
       * inert until the backend publishes `configured`, which only a
       * reachable engine produces. */
      return `<div class="row clone-row">
        <button class="ghost" disabled aria-disabled="true"
                title="Needs a Chatterbox-compatible voice engine">＋ Add voice</button>
        <span class="hint">Making a DJ voice from your own recording needs the
        optional ParlorWave Voice Engine: a Chatterbox-compatible speech
        service you run yourself and give ParlorWave the address of. None is
        included with this release. Add its address under <b>Optional
        services</b> in ${this._go("settings")} and this button switches on by
        itself. Home Assistant's own voices work without it.</span>
      </div>`;
    }
    if (cloning.reason === "unreachable") {
      // The engine IS configured and is not answering. That is a fault to
      // report, not a capability to explain -- and the button stays in its
      // place, disabled, rather than vanishing and coming back.
      return `<div class="row clone-row">
        <button class="ghost" disabled aria-disabled="true"
                title="The ParlorWave Voice Engine is not answering">＋ Add voice</button>
        <span class="hint">${this._esc(cloning.message || "The ParlorWave Voice Engine is unreachable right now.")}
        Its address is under <b>Optional services</b> in ${this._go("settings")}.</span>
      </div>`;
    }
    if (cloning.reason === "slots_full") {
      return `<div class="hint">${this._esc(cloning.message)}</div>`;
    }
    return `<div class="row clone-row">
      <button class="ghost" id="voice-create" aria-label="Add a voice">＋ Add voice</button>
      ${existing ? "" : `<span class="hint">${this._esc(cloning.processing || PRIVACY_COPY)}</span>`}
    </div>`;
  }

  /* New voices, and new recordings for existing ones, are not offered in
   * this release: the backend publishes that as cloning.reason and refuses
   * them itself. The one reading of it, for Add voice and for Replace. */
  _enrollmentOff() {
    const cloning = (this._voiceLib && this._voiceLib.cloning) || {};
    return cloning.reason === "not_qualified";
  }

  /* Create a Voice: a recording (made here or chosen), the owner's
   * acknowledgement, a name, what the voice is for, and one press. The
   * storage behind it is this release's three slots; nothing on this
   * screen says so, and nothing on it lets a person choose one. The same
   * form replaces a voice's recording (c.mode === "replace"). */
  _renderCreateVoice() {
    const c = this._create;
    const cloning = (this._voiceLib && this._voiceLib.cloning) || {};
    const replacing = c.mode === "replace";
    if (c.done) {
      const a = c.audition || { state: "idle" };
      const warnings = c.done.warnings || [];
      const sc = c.done.scope || c.scope || "dj";
      const announces = sc === "announcement" || sc === "both";
      const max = Number(((this._voiceLib || {}).preview || {}).max_chars) || 200;
      return `<div class="create">
        <div class="create-done-head">${this._esc(c.done.name)} ${replacing ? "has a new recording" : "is ready"}</div>
        ${warnings.map((w) => `<div class="notice warn">${this._esc(w)}</div>`).join("")}
        <div class="hint">Used for: ${this._esc(VOICE_SCOPE_LABELS[sc] || sc)}${c.done.announcement_default
          ? " · reads announcements that do not name a voice" : ""}.${announces
          ? ` A calendar entry can ask for it with <b>voice: ${this._esc(c.done.name)}</b> in its description.` : ""}</div>
        ${a.state === "speaking" ? `<div class="hint audition-wait" role="status" aria-live="polite">
            Making ${this._esc(c.done.name)} say a test line… This can take a few seconds.</div>` : ""}
        ${a.state === "error" ? `<div class="notice err">${this._esc(a.error)}</div>
          <div class="hint">The voice is saved. It can be put on the air once it has spoken.</div>` : ""}
        ${a.state === "ready" ? `<div class="hint" role="status">This is ${this._esc(c.done.name)},
            cloned from your recording${replacing ? "" : ". If it sounds right, put it on the air"}.
            The preview plays here in this browser only.</div>` : ""}
        ${c.useError ? `<div class="notice err">${this._esc(c.useError)}</div>` : ""}
        <div class="row">
          <button class="ghost" id="audition-play" ${a.state === "ready" ? "" : "disabled"}
            aria-label="${this._auditionAudio ? "Stop" : "Hear the cloned voice"}">
            ${this._auditionAudio ? "■ Stop" : "▶ Hear it again"}</button>
          ${a.state === "error" ? `<button class="ghost" data-audition="${this._esc(c.done.voice_id)}"
            aria-label="Try the voice again">Try again</button>` : ""}
          ${sc !== "announcement" && !replacing && a.state === "ready"
            ? `<button data-vuse="${this._esc(c.done.name)}" aria-label="Use this voice">Use this voice</button>` : ""}
          <button class="ghost" id="create-close">Done</button>
        </div>
        <div class="create-field">
          <label class="create-label" for="create-preview-text">Try a line</label>
          <input type="text" id="create-preview-text" maxlength="${max}"
                 placeholder="Don't forget dinner is at 7 tonight."
                 value="${this._esc(this._previewText || "")}">
          <button class="ghost small" data-audition="${this._esc(c.done.voice_id)}"
            ${a.state === "speaking" ? "disabled" : ""} aria-label="Say this line in the cloned voice">Say it</button>
        </div>
      </div>`;
    }
    const consent = this._consent();
    const announces = c.scope === "announcement" || c.scope === "both";
    return `<div class="create">
      <div class="create-head">${replacing
        ? `Replace the recording for “${this._esc(c.name || "this voice")}”` : "Create a Voice"}</div>
      ${c.error ? `<div class="notice err">${this._esc(c.error)}</div>` : ""}
      <div class="create-step">
        <div class="create-step-head"><span class="create-num">1</span> ${c.take && c.take.used
          ? "Recording" : "Record your voice"}</div>
        ${this._renderTake(c, cloning)}
        ${c.take && c.take.used ? "" : `<div class="hint">${this._esc(cloning.recommended
          || "About 10–30 seconds of one person speaking clearly: no music, no other voices, little background noise.")}
          Record here, or upload a WAV, MP3 or FLAC.</div>`}
      </div>
      ${c.take && c.take.used ? this._renderCreateDetails(c, cloning, consent, replacing, announces) : `
      <div class="row">
        <button class="ghost" id="create-cancel" ${c.busy ? "disabled" : ""}>Cancel</button>
      </div>`}
    </div>`;
  }

  /* Steps 2-4 and the button that makes the voice: shown once the owner
   * has a recording they chose to use. */
  _renderCreateDetails(c, cloning, consent, replacing, announces) {
    const ready = this._canSubmit(c);
    const missing = [
      !c.authorized ? "your confirmation of permission" : null,
      !replacing && !c.name.trim() ? "a name" : null,
      !c.scope ? "what it is used for" : null,
    ].filter(Boolean);
    return `
      <div class="create-step">
        <div class="create-step-head"><span class="create-num">2</span> Permission</div>
        ${consent ? `<label class="create-choice create-consent">
            <input type="checkbox" id="create-consent" ${c.authorized ? "checked" : ""}
                   ${c.busy ? "disabled" : ""}>
            <span>${this._esc(consent.text)}</span></label>
          <div class="hint">Make a voice only from your own recording, or from someone
            who knows about it and has agreed. The date you confirm this is kept with
            the voice.</div>`
          : `<div class="hint">This ParlorWave Radio service needs an update before a voice
            can be made here.</div>`}
      </div>
      <div class="create-step">
        <div class="create-step-head"><span class="create-num">3</span> ${replacing ? "Voice" : "Name"}</div>
        ${replacing ? `<div class="hint">The new recording replaces the one
            <b>${this._esc(c.name)}</b> has now; its name stays. Announcements already
            scheduled with the old recording will be read in another voice rather than
            this one.</div>` : `
        <div class="create-field">
          <label class="create-label" for="create-name">Name</label>
          <input type="text" id="create-name" maxlength="40" placeholder="Evening Reader"
                 value="${this._esc(c.name)}" ${c.busy ? "disabled" : ""}>
        </div>
        <div class="create-field">
          <label class="create-label" for="create-note">Note <span class="hint">(optional)</span></label>
          <input type="text" id="create-note" maxlength="80" placeholder="How you want to remember it"
                 value="${this._esc(c.note)}" ${c.busy ? "disabled" : ""}>
        </div>`}
      </div>
      <div class="create-step">
        <div class="create-step-head"><span class="create-num">4</span> Used for</div>
        <div class="create-scope" role="radiogroup" aria-label="What this voice is used for">
          ${["dj", "announcement", "both"].map((sc) => `<label class="create-choice">
            <input type="radio" name="create-scope" data-cscope="${sc}"
                   ${c.scope === sc ? "checked" : ""} ${c.busy ? "disabled" : ""}>
            <span>${VOICE_SCOPE_LABELS[sc]}</span></label>`).join("")}
        </div>
        ${replacing ? "" : `<label class="create-choice">
          <input type="checkbox" id="create-default" ${c.makeDefault && announces ? "checked" : ""}
                 ${announces && !c.busy ? "" : "disabled"}>
          <span>Also read announcements that do not name a voice in it</span></label>`}
      </div>
      <div class="hint">${this._esc(cloning.processing || PRIVACY_COPY)}</div>
      <div class="row">
        <button id="create-go" ${ready ? "" : "disabled"}>
          ${c.busy ? "Checking the recording…" : (replacing ? "Replace recording" : "Create voice")}</button>
        <button class="ghost" id="create-cancel" ${c.busy ? "disabled" : ""}>Cancel</button>
      </div>
      ${!ready && !c.busy && missing.length ? `<div class="hint">Still needed: ${this._esc(missing.join(", "))}.</div>` : ""}`;
  }

  /* Step 1: the take. While the microphone is open the screen says so in
   * words, with the lamp colour, a clock and Stop -- never an icon alone. */
  _renderTake(c, cloning) {
    const maxS = Number(cloning.max_seconds) || 45;
    const minS = Number(cloning.min_seconds) || 8;
    const busy = c.busy ? "disabled" : "";
    const rec = c.rec || {};
    // The script is a guide, not a test -- said where it is read.
    const script = `<div class="rec-script-label">Read this aloud, at your normal pace:</div>
        <blockquote class="rec-script" id="rec-script">${this._esc(RECORD_SCRIPT)}</blockquote>
        <div class="hint rec-script-easy">Read naturally. It doesn’t have to be word-for-word.
        If you make a mistake, keep going—or re-record.</div>`;
    if (rec.state === "recording") {
      const m = this._mic || {};
      const input = m.input || {};
      return `${script}
      <div class="rec-live" role="status" aria-live="polite">
        <span class="rec-dot" aria-hidden="true"></span>
        <span class="rec-words"><b>Microphone on</b> · recording
          <span id="rec-clock">0:00</span> of ${clockOf(maxS)}</span>
        <button id="rec-stop" aria-label="Stop recording">■ Stop</button>
        <span class="rec-guide" id="rec-guide">${this._esc(recordGuide(0, minS, RECORD_GOOD_SECONDS))}</span>
        ${m.meter ? `<span class="rec-meter" aria-hidden="true"><span class="rec-level" id="rec-level"
          style="width:${Number(m.levelPct) || 0}%"></span></span>` : ""}
        ${input.label ? `<span class="rec-input">Microphone: ${this._esc(input.label)}</span>` : ""}
        <span class="rec-warn" id="rec-warn" role="alert">${this._esc(m.warn || "")}</span>
      </div>`;
    }
    if (rec.state === "requesting") {
      return `<div class="hint" role="status">Waiting for your browser to allow the microphone…</div>`;
    }
    if (rec.state === "processing") {
      return `<div class="hint" role="status">Preparing the recording…</div>`;
    }
    const t = c.take;
    if (t) {
      const p = t.problem;
      const what = t.source === "recording"
        ? `Your recording · ${clockOf(t.seconds)}`
        : `File · ${this._esc(t.fileName || "recording")}${t.seconds ? ` · ${clockOf(t.seconds)}` : ""}`;
      if (t.used) {
        return `<div class="take used">
            <span class="take-what">✓ ${what}</span>
            <button class="ghost small" id="take-play" ${busy}
              aria-label="${this._takeAudio ? "Stop listening" : "Listen to the recording"}">
              ${this._takeAudio ? "■ Stop" : "▶ Listen"}</button>
            <button class="ghost small" id="take-discard" ${busy}>Change</button>
          </div>
          ${p && !p.block ? `<div class="notice warn">${this._esc(p.message)}</div>` : ""}`;
      }
      return `<div class="take">
          <span class="take-what">${t.checking ? `${what} · checking…` : what}</span>
          <button class="ghost small" id="take-play" ${busy}
            aria-label="${this._takeAudio ? "Stop listening" : "Listen to the recording"}">
            ${this._takeAudio ? "■ Stop" : "▶ Listen"}</button>
          <button class="ghost small" id="take-discard" ${busy}>${t.source === "recording"
            ? "Record again" : "Choose another"}</button>
        </div>
        ${p ? `<div class="notice ${p.block ? "err" : "warn"}">${this._esc(p.message)}</div>` : ""}
        ${t.diag ? `<div class="hint take-diag">${this._esc(t.diag)}</div>` : ""}
        <div class="row tight">
          <button id="take-use" ${t.block || t.checking || c.busy ? "disabled" : ""}
            aria-label="Use this recording">${t.source === "recording"
            ? "Use this recording" : "Use this file"}</button>
        </div>
        <div class="hint">${t.block ? (t.source === "recording"
            ? "Press Record again to make a new take."
            : "Choose another file, or record here instead.")
          : "Listen first if you like. Nothing is sent until the last step."}</div>`;
    }
    return `${script}
      <div class="row tight">
        <button id="rec-start" class="rec-big" ${busy} aria-label="Record with this device's microphone">● Record</button>
      </div>
      ${this._renderMicChoice(busy)}
      ${rec.error ? `<div class="notice err">${this._esc(rec.error)}</div>` : ""}
      <div class="hint">The microphone turns on only when you press Record, and off
        when you press Stop (or at ${maxS} seconds). Nothing is sent until you press
        ${c.mode === "replace" ? "Replace recording" : "Create voice"}.</div>
      <div class="rec-or">
        <span class="hint">Already have a recording of the voice?</span>
        <label class="ghost small filebtn">Upload a file<input type="file" hidden
          accept=".wav,.mp3,.flac,audio/wav,audio/mpeg,audio/flac" id="create-file"
          ${busy}></label>
      </div>`;
  }

  /* Which microphone Record opens, once the browser can name them. "The
   * browser's choice" is its default; on a Windows desktop that default and
   * the microphone being spoken into are often two different devices. */
  _renderMicChoice(busy) {
    const list = this._micDevices || [];
    if (list.length < 2) return "";
    const cur = BOOTH_SESSION.micDeviceId;
    return `<label class="rec-device"><span class="hint">Microphone</span>
        <select id="rec-device" ${busy} aria-label="Microphone to record with">
          <option value="" ${cur ? "" : "selected"}>The browser's choice</option>
          ${list.map((d) => `<option value="${this._esc(d.id)}" ${d.id === cur ? "selected" : ""}>${this._esc(d.label)}</option>`).join("")}
        </select></label>`;
  }

  _personaName(id) {
    const sel = this._personality;
    const desc = (sel && sel.attributes.descriptions) || {};
    const pretty = String(id).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    return Object.keys(desc).find((n) => n.toLowerCase() === pretty.toLowerCase()) || pretty;
  }

  /* --- Newsroom --------------------------------------------------------
   * A small newsroom desk, not a settings table. The top of the screen is
   * the state of the wire; the form is underneath, where you go when you
   * want to change something. Every sentence on it is written by the
   * backend's view model, so the panel never has to own a second copy of
   * the bulletin lifecycle vocabulary. */
  _renderNewsroom() {
    const held = this._newsdesk && this._newsdesk.data;
    if (!held) {
      return `<section class="card">
        <h2>Newsroom</h2>
        <div class="hint">${this._newsdesk && this._newsdesk.error
          ? "The Newsroom could not be read. Music is unaffected."
          : "Reading the news desk…"}</div>
      </section>`;
    }
    const nr = held.newsroom || {};
    const b = nr.bulletins || {};
    // Headlines in DJ breaks is not drawn in alpha.4: with no
    // textual headline source shipped, the card was a paragraph about a
    // capability nobody can switch on. _renderHeadlinesCard stays for the
    // release that ships one.
    return `${this._renderNewsDesk(b)}
      ${this._renderNewsWire(b)}
      ${this._renderNewsFeedForm(b)}
      ${this._renderNewsHistory()}
      ${this._renderNewsAdvanced(nr.advanced || {})}`;
  }

  /* The desk: what the station is doing about news, right now, in one
   * sentence, with the lamp lit only when a bulletin is genuinely on the
   * air. */
  _renderNewsDesk(b) {
    const live = !!b.on_air;
    // While bulletins are on, the detail only restates the Schedule and
    // Source chips under it. Off or unconfigured, it is the one
    // sentence that says what to do, and it stays.
    const detail = b.configured && (b.enabled || live) ? "" : (b.detail || "");
    return `
      <section class="booth-hero news-desk" aria-label="News bulletins">
        <div class="stage-glow" aria-hidden="true"></div>
        <div class="booth-hero-body">
          <div class="booth-eyebrow">News bulletins</div>
          <h2 class="booth-name">${this._esc(b.headline || "")}</h2>
          ${detail ? `<div class="booth-desc">${this._esc(detail)}</div>` : ""}
          <div class="news-state state-line ${live ? "onair" : ""}">
            ${live ? `<span class="lamp" aria-hidden="true"></span>` : ""}
            <span class="state-label">${this._esc(b.state_label || "")}</span>
            ${b.next_window && !live
              ? `<span class="state-detail">${this._esc(b.next_window.label)}</span>` : ""}
          </div>
          <div class="facts news-facts-row">
            <span class="chip"><b>Schedule</b>${this._esc(b.schedule_label || "")}</span>
            ${b.source_name
              ? `<span class="chip"><b>Source</b>${this._esc(b.source_name)}</span>` : ""}
          </div>
          ${b.trouble ? `<div class="news-trouble">${this._esc(b.trouble)}</div>` : ""}
          ${b.last_result && !b.trouble
            ? `<div class="hint">Last time: ${this._esc(b.last_result)}</div>` : ""}
          <div class="news-rules">
            <span>Bulletins wait for a song to finish.</span>
            <span>A track is never interrupted.</span>
            <span>The music returns on its own.</span>
          </div>
        </div>
      </section>`;
  }

  /* ON THE WIRE: EVERY CONFIGURED NEWSROOM, one row each.
   *
   * It used to render `b.latest`, the single bulletin the one-slot cache
   * held, which meant a station with two newsrooms could only ever see one
   * of them here -- and the one it saw was whichever had fetched most
   * recently, because the two were sharing one slot. With two
   * publishers configured only one showed, and the other looked as though
   * it had never been set up at all.
   *
   * A row now exists because the SOURCE is configured. A source that has
   * never fetched, or whose last fetch failed, says so beside its own name
   * instead of being left off the screen: "nothing collected yet" is an
   * answer, and absence is not. The backend decides all six states and all
   * the words; this renders them. */
  _renderNewsWire(b) {
    const rows = Array.isArray(b.wire) ? b.wire : [];
    if (!rows.length) {
      return `<section class="card">
        <h2>On the wire</h2>
        <div class="hint">${b.configured
          ? "No bulletin source is switched on. Enable one below and the "
            + "station will collect its newest episode a few minutes before "
            + "it is due to air."
          : "Nothing yet — the Newsroom has no feed to collect from."}</div>
      </section>`;
    }
    return `
      <section class="card">
        <h2>On the wire</h2>
        ${rows.map((w) => this._renderWireRow(w)).join("")}
      </section>`;
  }

  _renderWireRow(w) {
    // One badge, and it is the backend's own word for the state. Only a
    // genuinely airable episode is green; everything else -- stale, absent,
    // failed, unfinished -- is the same cold badge, because none of them is
    // a bulletin the station could put on the air right now.
    const meta = w.state === "fresh" || w.state === "stale"
      ? [w.published_age ? "Published " + w.published_age : "Publication time unknown",
         w.duration || null].filter(Boolean).join(" · ")
      : (w.last_aired_label || "");
    return `
      <div class="wire ${w.state === "fresh" ? "" : "quiet"}">
        <div class="wire-body">
          <div class="wire-source">${this._esc(w.source || "")}</div>
          <div class="wire-when">${this._esc(w.schedule_label || "")}</div>
          ${w.item_title
            ? `<div class="wire-episode"><span class="wire-tag">Episode</span>
                 ${this._esc(w.item_title)}</div>` : ""}
          ${meta ? `<div class="wire-meta">${this._esc(meta)}</div>` : ""}
          ${w.error
            ? `<div class="wire-why">${this._esc(w.error)}</div>` : ""}
        </div>
        <span class="vbadge ${w.state === "fresh" ? "" : "cold"}">${
          this._esc(w.state_label || "")}</span>
      </div>`;
  }

  /* BULLETIN SOURCES. One row per newsroom, in the order they resolve: a
   * station may carry one publisher at the top of the hour and another at
   * half past, and two scheduled for the same minute are taken in this
   * order, first one wins the boundary.
   *
   * Zero sources is the FACTORY STATE and is not a fault. No publisher
   * ships preconfigured, and this screen never suggests one by name. */
  _renderNewsFeedForm(b) {
    const d = this._newsForm();
    const rows = this._newsSources();
    const saving = this._busy === "news_save";
    return `
      <section class="card">
        <h2>Bulletin sources</h2>
        <div class="controls">
          <div class="control">
            <div>
              <div class="label">Air scheduled bulletins</div>
              <div class="hint">When this is off the station never contacts any
              feed at all.</div>
            </div>
            <button class="pill ${d.enabled ? "on" : ""}" id="news-enabled"
                    aria-pressed="${!!d.enabled}">${d.enabled ? "On" : "Off"}</button>
          </div>
        </div>
        ${rows.length
          ? `<div class="src-list">${rows.map((r, i) => this._renderNewsSource(r, i, rows)).join("")}</div>`
          : `<div class="hint empty-state">No bulletin sources yet. Add the
             address of an audio podcast or news RSS feed and the station will
             air its newest episode on the hour you choose.</div>`}
        <div class="row">
          <button class="ghost" id="news-add">+ Add bulletin source</button>
          <span class="spacer"></span>
          <button id="news-save" ${saving || !d.dirty ? "disabled" : ""}>
            ${saving ? "Saving…" : "Save"}</button>
        </div>
        ${this._renderNewsTest()}
      </section>`;
  }

  _renderNewsSource(r, i, rows) {
    const editing = this._newsEditing === r.id;
    const testing = this._busy === `news_test:${r.id}`;
    const clash = rows.some((o, j) => j < i && Number(o.target_minute) === Number(r.target_minute));
    const stored = (this._newsBulletins().sources || []).find((s) => s.id === r.id) || {};
    const shown = (r.name || "").trim() || stored.display_name || "Unnamed source";
    return `
      <div class="src ${r.enabled ? "" : "off"}" data-src="${this._esc(r.id)}">
        <div class="src-head">
          <div class="src-name">${this._esc(shown)}</div>
          <div class="src-when">${this._esc(
            `Every hour at :${String(Number(r.target_minute)).padStart(2, "0")}`)}</div>
          <span class="src-state">${r.enabled ? "Enabled" : "Disabled"}</span>
        </div>
        ${r.feed_url
          ? `<div class="src-url">${this._esc(r.feed_url)}</div>`
          : `<div class="src-url dim">No feed address yet</div>`}
        ${stored.last_aired_label
          ? `<div class="src-last">${this._esc(stored.last_aired_label)}</div>` : ""}
        ${clash ? `<div class="src-note">Another source is also set to this
          minute. The one above takes the boundary; this one waits for the
          next hour.</div>` : ""}
        <div class="row tight src-actions">
          <button class="ghost small" data-srctest="${this._esc(r.id)}"
                  ${testing || !r.feed_url ? "disabled" : ""}>
            ${testing ? "Testing…" : "Test"}</button>
          <button class="ghost small" data-srcedit="${this._esc(r.id)}">
            ${editing ? "Done" : "Edit"}</button>
          <button class="ghost small" data-srcoff="${this._esc(r.id)}">
            ${r.enabled ? "Disable" : "Enable"}</button>
          <span class="spacer"></span>
          <button class="ghost small danger" data-srcdel="${this._esc(r.id)}">Remove</button>
        </div>
        ${editing ? this._renderNewsSourceEditor(r) : ""}
      </div>`;
  }

  _renderNewsSourceEditor(r) {
    return `
      <div class="src-edit controls">
        <div class="control">
          <div>
            <div class="label">Source name</div>
            <div class="hint">What the DJ calls it on air. Left empty, the
            station uses the feed's address.</div>
          </div>
          <input type="text" data-srcname="${this._esc(r.id)}" maxlength="60"
                 placeholder="e.g. The Newsroom" value="${this._esc(r.name || "")}">
        </div>
        <div class="control news-url">
          <div>
            <div class="label">Feed address</div>
            <div class="hint">The address of an audio podcast or news RSS feed.
            The station airs its newest episode.</div>
          </div>
          <input type="text" data-srcurl="${this._esc(r.id)}" maxlength="500"
                 placeholder="https://…/podcast.xml" inputmode="url"
                 value="${this._esc(r.feed_url || "")}">
        </div>
        <div class="control">
          <div>
            <div class="label">Schedule</div>
            <div class="hint">The station aims for this minute and airs at the
            next song boundary near it.</div>
          </div>
          <select data-srcmin="${this._esc(r.id)}">
            ${NEWS_SCHEDULES.map((o) =>
              `<option value="${o.minute}" ${Number(r.target_minute) === o.minute
                ? "selected" : ""}>${o.label}</option>`).join("")}
          </select>
        </div>
      </div>`;
  }

  /* WHAT ACTUALLY HAPPENED, AND IT IS SHORT.
   *
   * The question the Newsroom could not answer before: a bulletin that was
   * fetched, armed and then lost its boundary looked exactly like one that
   * aired. That is still the question -- but the answer had grown into a
   * six-row list of mostly identical entries, and all but the newest of
   * them described a recording the station no longer has.
   *
   * So the card leads with ONE ROW PER NEWSROOM: that source's most recent
   * outcome, which under the retention rule is also the only one of its
   * bulletins that can still be played. Everything older is metadata, it is
   * still worth keeping, and it is folded away behind History -- closed,
   * because a list of things that cannot be replayed is not what somebody
   * opening the Newsroom came to read.
   *
   * The Listen again button follows the AUDIO, never the row: the backend
   * asks the disk for every row it returns, and an older row simply does
   * not carry the offer. */
  _renderNewsHistory() {
    const h = this._newsHistory;
    if (!h) return "";
    if (h.error) {
      return `<section class="card"><h2>Recent bulletins</h2>
        <div class="hint">The record could not be read. Music is
        unaffected.</div></section>`;
    }
    const rows = h.rows || [];
    // A backend that predates the short list answers only `history`, and
    // `latest_per_source` returns nothing only when there is no history at
    // all -- so "no latest but some rows" can only be the older backend,
    // and the honest degradation is the list it used to draw rather than an
    // empty card above a fold holding everything.
    const latest = (h.latest && h.latest.length) ? h.latest
                 : (rows.length ? rows : []);
    if (!latest.length && !rows.length) {
      return `<section class="card"><h2>Recent bulletins</h2>
        <div class="hint empty-state">Nothing yet. Once a scheduled bulletin
        airs it is listed here, with the time it actually went out.</div>
        </section>`;
    }
    // The ids the headline rows already account for, so History is the
    // REST of the record rather than the same rows a second time.
    const shown = {};
    latest.forEach((r) => { if (r.id) shown[r.id] = true; });
    const older = rows.filter((r) => !r.id || !shown[r.id]);
    return `
      <section class="card">
        <h2>Recent bulletins</h2>
        ${this._listenError
          ? `<div class="news-test bad"><div class="news-test-body">${
              this._esc(this._listenError)}</div></div>` : ""}
        <div class="hist">${latest.map((r) => this._renderHistRow(r)).join("")}</div>
        ${older.length ? `
          <details class="hist-more" ${this._histOpen ? "open" : ""}>
            <summary id="hist-toggle">History (${older.length})</summary>
            <div class="hist">${older.map((r) => this._renderHistRow(r)).join("")}</div>
            <div class="hint">These are kept as a record of what the station
            did. The recordings themselves are not: each newsroom keeps only
            its most recent bulletin, so only the rows above can be played.</div>
          </details>` : ""}
        <div class="hint">Listen again plays here in this browser only. It is
        never put back into the queue or onto a speaker.</div>
      </section>`;
  }

  _renderHistRow(r) {
    const aired = r.result === "aired";
    const when = this._histClock(r.aired_at || r.scheduled_for);
    const busy = this._busy === `listen:${r.token}`;
    const meta = aired
      ? [when ? `Aired ${when}` : "Aired", this._histDuration(r.duration_s)]
          .filter(Boolean).join(" · ")
      : [r.result === "failed" ? "Did not run" : "Skipped",
         when ? `due ${when}` : null].filter(Boolean).join(" · ");
    return `
      <div class="hist-row ${aired ? "" : "miss"}">
        <div class="hist-main">
          <div class="hist-src">${this._esc(r.source_name || "Newsroom")}</div>
          ${r.item_title
            ? `<div class="hist-title">${this._esc(r.item_title)}</div>` : ""}
          <div class="hist-meta">${this._esc(meta)}</div>
          ${!aired && r.reason
            ? `<div class="hist-why">${this._esc(r.reason)}</div>` : ""}
        </div>
        ${r.listen_again
          ? `<button class="ghost small" data-listen="${this._esc(r.token)}"
                     ${busy ? "disabled" : ""}>${busy ? "Loading…" : "Listen again"}</button>`
          : aired ? `<span class="hist-gone">No longer available</span>` : ""}
      </div>`;
  }

  /* The same wall clock as everywhere else: a naive station stamp as
   * written, an aware one in the browser's zone. */
  _histClock(iso) {
    if (!iso || isNaN(new Date(iso).getTime())) return "";
    return this._localTime(iso);
  }

  _histDuration(seconds) {
    const s = Number(seconds);
    if (!s || !isFinite(s) || s <= 0) return "";
    const m = Math.floor(s / 60);
    return `${m}m ${String(Math.round(s - m * 60)).padStart(2, "0")}s`;
  }

  /* The test result: facts, and on a failure the thing to go and fix.
   * Nothing here touches playback -- and it says so, because the fear this
   * answers is "will pressing this stop my music". */
  _renderNewsTest() {
    const t = this._newsTest;
    if (!t || t.running) return "";
    if (t.error) {
      return `<div class="news-test bad">
        <div class="news-test-head">Could not run the test</div>
        <div class="news-test-body">${this._esc(t.error)}</div>
      </div>`;
    }
    const r = t.result || {};
    if (!r.ok) {
      const WHY = {
        source_unconfigured: ["No feed address", "Enter the address of an audio podcast or news RSS feed."],
        unreachable: ["Could not reach the feed", "Nothing answered at that address. Check the address, and that this machine can reach the internet."],
        unparseable: ["That address is not a feed", "Something answered, but it was not RSS. A podcast page is not the same as its feed address."],
        feed_too_large: ["That feed is too big to read", "The feed answered, so the address is right \u2014 it is just larger than the station will read in one go."],
        no_items: ["The feed is empty", "It was read successfully but has no episodes in it."],
        unsupported_format: ["No playable audio", "The newest episode carries no MP3 audio, so the station cannot air it."],
        mode_not_implemented: ["Not available", "This build cannot produce that kind of bulletin."],
      };
      const [head, body] = WHY[r.reason] || ["The feed could not be used", "Check the address and try again."];
      return `<div class="news-test bad">
        <div class="news-test-head">${this._esc(head)}</div>
        <div class="news-test-body">${this._esc(body)}</div>
        ${r.error ? `<div class="news-test-detail">${this._esc(r.error)}</div>` : ""}
        <div class="news-test-foot">Nothing was changed, and the music was not
        touched.</div>
      </div>`;
    }
    const facts = [];
    facts.push(["Reachable", "Yes"]);
    facts.push(["Readable as a feed", `Yes — ${r.items} episode${r.items === 1 ? "" : "s"}`]);
    facts.push(["Playable audio", r.has_enclosure ? "Yes" : "No"]);
    if (r.published_age_minutes != null) {
      facts.push(["Newest episode published", this._newsAge(r.published_age_minutes)]);
    }
    if (r.duration_s) facts.push(["Length", this._mmss(r.duration_s)]);
    facts.push(["Will be announced as", r.display_artist || ""]);
    return `<div class="news-test good">
      <div class="news-test-head">This feed works</div>
      ${r.item_title
        ? `<div class="news-test-body"><span class="wire-tag">Newest episode</span>
             ${this._esc(r.item_title)}</div>` : ""}
      <table class="news-facts">${facts.map(([k, v]) =>
        `<tr><td>${this._esc(k)}</td><td>${this._esc(v)}</td></tr>`).join("")}</table>
      <div class="news-test-foot">Nothing was saved or downloaded. Press Save to
      keep these settings.</div>
    </div>`;
  }

  _newsAge(minutes) {
    if (minutes == null) return "Unknown";
    if (minutes < 0) return "Dated in the future";
    if (minutes < 2) return "Just now";
    if (minutes < 90) return `${Math.round(minutes)} minutes ago`;
    const hours = minutes / 60;
    if (hours < 36) return `${Math.round(hours)} hours ago`;
    return `${Math.round(hours / 24)} days ago`;
  }

  /* Headlines in DJ breaks: a DIFFERENT capability, reported honestly. An
   * audio feed supplies audio; it does not supply reported headlines, and
   * this card exists so the Newsroom never implies otherwise. */
  _renderHeadlinesCard(h) {
    const off = h.status !== "configured";
    return `
      <section class="card secondary">
        <h2>Headlines in DJ breaks</h2>
        <div class="hl-row">
          <span class="hl-status ${off ? "off" : "on"}">${this._esc(h.label || "")}</span>
          <div class="hl-body">${this._esc(h.detail || "")}</div>
        </div>
        ${h.note ? `<div class="hint">${this._esc(h.note)}</div>` : ""}
        <div class="hint">Separate from the bulletins above: a bulletin is a
        recording that airs between songs, a headline is a line the DJ says
        inside a break.</div>
      </section>`;
  }

  _renderNewsAdvanced(adv) {
    const rows = Object.keys(adv)
      .filter((k) => adv[k] !== null && adv[k] !== undefined && adv[k] !== "")
      .map((k) => [k.replace(/_/g, " "), String(adv[k])]);
    return `
      <section class="card secondary">
        <h2>Advanced diagnostics</h2>
        <div class="row tight">
          <button class="ghost tiny-btn ${this._newsAdvanced ? "on" : ""}"
                  id="news-advanced" aria-expanded="${this._newsAdvanced}">
            ${this._newsAdvanced ? "Hide" : "Show"} engine state</button>
        </div>
        ${this._newsAdvanced
          ? `<div class="hint">The scheduler's own words, for a bug report.
             Nothing here needs to mean anything to you.</div>
             <table>${rows.map(([k, v]) =>
               `<tr><td>${this._esc(k)}</td><td>${this._esc(v)}</td></tr>`).join("")}</table>`
          : ""}
      </section>`;
  }

  /* --- Station -----------------------------------------------------------
   * "Where does my music come from?" -- the one question On Air, Booth and
   * the Newsroom all leave unanswered, and the one a base installation has
   * been answering wrongly by showing controls that cannot work.
   *
   * There are TWO honest answers and this screen shows whichever is true:
   *
   *   MUSIC ASSISTANT PROGRAMS (the base installation, and a completely
   *   supported one). A person starts an album, a playlist, a Music
   *   Assistant station or a hand-built queue; Parlorwave adopts that
   *   session, Music Assistant stays the queue and programming authority,
   *   and Parlorwave does the broadcast presentation between the tracks.
   *   Nothing is missing here and nothing is a fallback.
   *
   *   PARLORWAVE PROGRAMS (a local Parlorwave music catalog exists). The
   *   station can pick music itself, so the autonomous tools appear:
   *   start a station from the current song, request something, endless
   *   refill, station feel, artist rotation.
   *
   * WHICH ONE IS TRUE IS NOT GUESSED HERE. It is `catalog.usable` from the
   * backend's own health features -- the same verdict the services
   * themselves refuse on. Nothing in this file looks at a filesystem path,
   * at whether a station happens to be active, or at unrelated health.
   *
   * This screen deliberately does NOT repeat On Air: no second album-art
   * player, no second queue or lyrics, no break controls. */
  _renderStation() {
    return this._catalog().usable
      ? this._renderStationProgramming()
      : this._renderStationFollowing();
  }

  /* The published capability, with a floor. `known` false means no health
   * answer has arrived yet -- treated exactly like "no catalog", because a
   * control offered on a guess is the failure this contract exists to
   * end. */
  _catalog() {
    const c = (this._djStatus && this._djStatus.attributes
               && this._djStatus.attributes.catalog) || null;
    if (!c) return { usable: false, track_count: 0, known: false };
    return { usable: !!c.usable, track_count: c.track_count || 0,
             known: c.known !== false };
  }

  /* The station's own identity, when it has one. A screen called Station
   * that never says which station is a screen missing its own subject. */
  _stationName() {
    const st = this._station;
    const name = st && st.state;
    if (!name || ["none", "unknown", "unavailable", ""].includes(name)) return null;
    return name;
  }

  /* THE HOUSE LINE: what the house's own playback is doing, from the
   * observer the backend publishes and from nothing else -- never from the
   * Dial, a selected tile or the speaker the last station ran on. The
   * watched speaker is named only when it is provably the selected DJ
   * speaker (or one the speaker list has already named); otherwise it is
   * "a DJ-enabled speaker". The observer's queue is read as a yes/no and
   * compared, never turned into text, and the song is said only while that
   * named speaker is playing or paused. */
  _stationTruthRows() {
    const jvAttrs = (this._djStatus && this._djStatus.attributes) || {};
    const obs = jvAttrs.observer || null;
    const out = this._output;
    // The selected output's OWN player -- never _player's fallback to
    // another queue's entity, which would name a different speaker.
    const live = this._player;
    const p = live && out && out.attributes
      && live.entity_id === out.attributes.output_entity_id ? live : null;
    const enabled = jvAttrs.outputs_enabled;
    const rows = [];
    const attention = this._attentionStep();
    if (attention) {
      rows.push({ label: "Needs attention", tone: "alert", detail: attention.detail || attention.label,
                  door: this._go("settings", "Open Settings") });
    }
    if (obs && !(attention && !obs.queue_id)) {
      const mine = !!obs.queue_id && this._isSelectedOutput(obs.queue_id);
      const listed = obs.queue_id && !mine ? this._dialTargetVerdict(obs.queue_id) : null;
      const outName = out && out.state && !["unknown", "unavailable"].includes(out.state)
        ? out.state : "";
      const speaker = mine ? (p ? (p.attributes.friendly_name || p.entity_id) : outName)
        : ((listed && listed.name) || "");
      const tr = mine && p && ["playing", "paused"].includes(p.state) ? this._track() : null;
      const song = tr && tr.title ? (tr.artist ? `${tr.artist} — ${tr.title}` : tr.title) : "";
      rows.push(obs.running
        ? (obs.queue_id
            ? { label: "Following Music Assistant", tone: "live",
                detail: `on ${speaker || "a DJ-enabled speaker"}${song ? ` · ${song}` : ""}` }
            : { label: "Watching for playback", tone: "idle",
                detail: "· Nothing is playing on a DJ-enabled speaker yet. Start an album, "
                        + "playlist, station, or queue in Music Assistant." })
        : { label: "Not following playback", tone: "idle",
            detail: "· Music Assistant playback is not being observed right now" });
    }
    if (Array.isArray(enabled) && !enabled.length) {
      // The door's words are its name (label in name): "Settings" is the
      // button, the sentence around it is text.
      rows.push({ label: "", tone: "idle", detail: "No DJ-enabled speaker yet.",
                  door: `Choose one in ${this._go("settings")}` });
    }
    if (!rows.length) return "";
    return `<div class="st-truth">${rows.map((r) => `
      <div class="st-row">
        <span class="st-dot ${this._esc(r.tone)}" aria-hidden="true"></span>
        <span class="st-line">${r.label
          ? `<span class="st-label">${this._esc(r.label)}</span> ` : ""}<span class="st-detail">${this._esc(r.detail)}</span>${r.door
          ? ` ${r.door}` : ""}</span>
      </div>`).join("")}</div>`;
  }

  /* BASE MODE. A deliberate operating mode, written as one: Music
   * Assistant chooses the music and Parlorwave puts the station around it.
   * The page is the one catalog mode shows -- the Dial, the Request Line,
   * Programming -- and only Advanced differs: here it says where the music
   * comes from. (Alpha.4: the "Not in this release" roadmap card, the
   * optional-catalog entry and About the Dial are gone -- a shipped
   * install has no local catalog, and what Stop means is said where Stop
   * is pressed.) */
  _renderStationFollowing() {
    return `
      ${this._renderStationDeck()}

      ${this._renderRequestLineCard()}

      ${this._renderProgrammingCard()}

      ${this._renderStationAdvanced(`
      <section class="card secondary">
        <h2>Music source</h2>
        <div class="st-adds">
          <div class="st-add"><span class="st-icon" aria-hidden="true">♫</span>
            <div><div class="label">Music Assistant <span class="st-tag on">In use</span></div>
            <div class="hint">${this._stationName()
              ? `Currently playing ${this._esc(this._stationName())}. ` : ""}Following Music Assistant: it chooses the music and keeps the queue; ParlorWave follows it.</div></div></div>
        </div>
        <div class="hint st-queue-note">Dial Stations and requests play from your Music Assistant library. Music Assistant owns the queue. ParlorWave preserves your music order, adding only finite DJ and news elements and what you ask for.</div>
      </section>`)}`;
  }

  /* CATALOG MODE. The same page, with the autonomous tools in Advanced:
   * what the catalog's own station is doing, how to start one from the song
   * playing now or from a request, and the preferences the next batch of
   * picks is made under. Each of these controls exists once in the panel. */
  _renderStationProgramming() {
    const cat = this._catalog();
    const st = this._station;
    const sa = (st && st.attributes) || {};
    const name = st && st.state && st.state !== "none"
                 && st.state !== "unavailable" ? st.state : null;
    const started = sa.started ? this._agoText(sa.started) || this._localTime(sa.started) : null;
    return `
      ${this._renderStationDeck()}

      ${this._renderRequestLineCard()}

      ${this._renderProgrammingCard()}

      ${this._renderStationAdvanced(`
      <section class="card secondary">
        <h2>Music programming</h2>
        <div class="label">${this._esc(name || "No station of its own")}</div>
        <div class="hint">${name
          ? "ParlorWave Radio is programming this station itself. The controls below apply to it."
          : "ParlorWave Radio is following Music Assistant. Start a station below and it will programme one itself instead."}</div>
        <div class="facts st-facts">
          ${this._chip("Catalog", `${cat.track_count} tracks`)}
          ${this._chip("Started", started)}
          ${this._chip("Refills", sa.refill_count != null ? String(sa.refill_count) : null)}
          ${this._chip("Programmed", sa.tracks_generated != null ? String(sa.tracks_generated) : null)}
        </div>
      </section>

      <section class="card secondary">
        <h2>Start a station</h2>
        <div class="row">
          <input id="request-input" type="text" placeholder="Mood, artist, album, era, or 'surprise me'…"
                 aria-label="Music request">
          <button class="ghost" id="request-go" ${this._busyAttr("request")} aria-label="Play request">Play it</button>
        </div>
        <div class="row tight">
          <button class="ghost" ${this._busyAttr("start_radio")} id="start-radio"
                  aria-label="Start a station from this song">📻 Start a station from this song</button>
        </div>
        <div class="hint">Both build from your local ParlorWave music catalog.
        The song playing now is never interrupted: only what comes after it
        changes.</div>
      </section>

      <section class="card secondary">
        <h2>Station feel</h2>
        <div class="controls">
          ${this._toggleRow("endless", this._endless, "The station keeps itself playing by refilling its own tail")}
          ${this._selectRow("feel", this._feel, "Station feel")}
          ${this._toggleRow("same-artist", this._sameArtist,
            "Let the station play two songs by the same artist in a row")}
          ${this._sameArtist && this._sameArtist.state === "on"
            ? this._selectRow("same-artist-freq", this._sameArtistFreq,
                "How often", "Low: rare · Medium: occasional · High: common")
            : ""}
        </div>
        <div class="hint">Saved as you change them, and applied to the next
        batch of tracks the station picks — nothing already queued or playing
        moves. None of this touches music you queued yourself in Music
        Assistant.</div>
      </section>`)}`;
  }

  /* THE DIAL STAGE: the hero of both modes. The station's own plate; the
   * two truths about what is playing -- the house line (what Music
   * Assistant is doing on the house's speakers) and the on-air line (the
   * station Parlorwave is programming, if any) -- and they are never mixed;
   * then the saved stations as tiles, with at most one sheet under them:
   * the choose sheet for a pressed tile, or the sheet that creates or edits
   * one. The name is edited in its own sheet under the plate. */
  _renderStationDeck() {
    return `
      <section class="booth-hero station-desk" aria-label="The Dial">
        <h2 class="visually-hidden">${this._esc(this._stationIdentityName())}</h2>
        <div class="stage-glow" aria-hidden="true"></div>
        <div class="deck-head">
          ${this._renderDeckPlate()}
          <div class="deck-status">
            ${this._stationTruthRows()}
            ${this._renderOnAirStationCard()}
          </div>
        </div>
        ${this._stNameOpen ? this._renderStationIdentityCard() : ""}
        ${this._renderDialStationsCard()}
        ${this._liveForm && !this._dialEdit ? this._renderAirForm(this._liveData()) : ""}
      </section>`;
  }

  /* The station's name on the console's brass: the approved wordmark above
   * the engraved plate, fitted to the name once it is laid out
   * (_fitDeckPlate). The plate is a picture of the name -- its accessible
   * name IS the name -- and never a control: the name is changed in its own
   * sheet, behind Edit. */
  _renderDeckPlate() {
    const name = this._stationIdentityName();
    const memo = this._deckPlateFit;
    const fit = memo && memo.name === name ? memo.fit : null;
    const size = fit ? ` style="--plate-w:${fit.width}; --plate-h:${fit.height};"` : "";
    this._hookPlateFont();
    return `
      <div class="deck-badge">
        <img class="deck-emblem" src="${PW_EMBLEM_URL}" alt="" draggable="false">
        <span class="deck-plate" id="station-deck-plate"
              role="img" aria-label="${this._esc(name)}"${size}>${this._renderStationPlate(name, fit)}</span>
        <button class="ghost small deck-name-edit" id="station-name-edit"
                aria-expanded="${this._stNameOpen ? "true" : "false"}">Edit Station Name</button>
      </div>`;
  }

  /* Fits the deck's plate exactly as the console's badge is fitted
   * (_fitCenterBadge), against the deck's own on-screen size and with its
   * own memo, so the two plates never share a measurement. The plate's
   * size is handed to the stylesheet too, which trims the badge cell to the
   * brass. A no-op until the plate is laid out. */
  _fitDeckPlate() {
    const box = this.shadowRoot && this.shadowRoot.getElementById
      && this.shadowRoot.getElementById("station-deck-plate");
    if (!box || typeof box.querySelector !== "function") return;
    const ink = box.querySelector('.pw-plate-ink[data-line="0"]');
    if (!ink || typeof ink.getComputedTextLength !== "function") return;
    const rect = box.getBoundingClientRect ? box.getBoundingClientRect() : null;
    if (!rect || !(rect.width > 0)) return;           // not laid out: nothing to measure against
    const name = this._stationIdentityName();
    const scale = rect.width / 520;
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    const floorPx = dpr >= 2 ? PW_PLATE.floorPx.hiDpi : PW_PLATE.floorPx.loDpi;
    const key = name + "\u0000" + scale.toFixed(3) + "\u0000" + (plateFontState.ready ? "1" : "0");
    if (this._deckPlateFit && this._deckPlateFit.key === key) return;
    const measure = (text, size, tracking) => {
      ink.setAttribute("font-size", size);
      ink.setAttribute("letter-spacing", tracking);
      ink.textContent = text;
      return ink.getComputedTextLength();
    };
    const fit = this._fitPlateName(name, measure, scale, floorPx);
    this._deckPlateFit = { key, name, fit };
    this._applyPlateFit(box, fit);
    if (box.style && typeof box.style.setProperty === "function") {
      box.style.setProperty("--plate-w", String(fit.width));
      box.style.setProperty("--plate-h", String(fit.height));
    }
  }

  /* PROGRAMMING: what goes on the air around the music, one row each,
   * stated here rather than switched. The DJ's power is the left knob on On
   * Air and its voice and manner live in Booth; bulletins are the
   * Newsroom's (their state comes from the readiness document already in
   * memory, never from a read of the Newsroom's own data). Announcements
   * is the one row whose switch IS here: no other screen owns it. */
  _renderProgrammingCard() {
    const named = (e) => (e && e.state && !["unknown", "unavailable", "none", ""].includes(e.state)
      ? e.state : null);
    const dj = this._dj;
    const djState = dj && dj.state;
    const speech = this._djSpeech;
    const djWord = djState === "on"
      ? (speech && speech.state === "off" ? "On · speech off" : "On")
      : djState === "off" ? "Off" : "Unavailable";
    const djSum = [djWord, named(this._personality), named(this._voice)]
      .filter(Boolean).map((s) => this._esc(s)).join(" · ")
      + (djState === "off"
        ? ` — switch it on with the left knob on ${this._go("onair", "On Air")}` : "");
    const ready = this._readiness();
    const news = ((ready && ready.optional) || []).find((o) => o && o.key === "newsroom") || null;
    const newsSum = news && news.badge ? news.badge : "Set up in the Newsroom";
    return `
      <section class="card prog-card" aria-label="Programming">
        <h2>Programming</h2>
        <div class="prog">
          <div class="prog-row" role="group" aria-label="DJ breaks">
            <span class="prog-icon" aria-hidden="true">${this._stIcon("mic")}</span>
            <div class="prog-body"><div class="label">DJ breaks</div>
              <div class="prog-sum">${djSum}</div></div>
            <div class="prog-act">${this._go("booth")}</div>
          </div>
          <div class="prog-row" role="group" aria-label="News bulletins">
            <span class="prog-icon" aria-hidden="true">${this._stIcon("news")}</span>
            <div class="prog-body"><div class="label">News bulletins</div>
              <div class="prog-sum">${this._esc(newsSum)}</div></div>
            <div class="prog-act">${this._go("newsroom")}</div>
          </div>
          ${this._renderAnnouncementsCard()}
        </div>
      </section>`;
  }

  /* ADVANCED: closed by default, and its state kept on the component --
   * the screen is rebuilt on every update, so a native disclosure on its
   * own would close itself again (the History fold's pattern). */
  _renderStationAdvanced(inner) {
    return `
      <details class="st-adv" ${this._stAdvOpen ? "open" : ""}>
        <summary>Advanced</summary>
        <div class="st-adv-body">${inner}</div>
      </details>`;
  }

  /* The Station screen's line icons: inline, decorative, drawn in the
   * colour of the text beside them. */
  _stIcon(name) {
    const d = {
      mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v5"/><path d="M8 22h8"/>',
      news: '<path d="M4 5h13a3 3 0 0 1 3 3v11H7a3 3 0 0 1-3-3Z"/><path d="M20 8h-3v11"/><path d="M8 9h6M8 13h6"/>',
      speaker: '<path d="M3 11v2a2 2 0 0 0 2 2h2l5 4V5L7 9H5a2 2 0 0 0-2 2Z"/><path d="M16 9a4 4 0 0 1 0 6"/>',
      check: '<path d="M5 12l5 5L20 7"/>',
      retest: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
      warn: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
      plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
      close: '<path d="M6 6l12 12M18 6 6 18"/>',
    }[name] || "";
    return `<svg class="st-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${d}</svg>`;
  }

  /* --- On-air station (Station Programmer, Mode 2) -------------------------
   * LIVE, NOT SETUP. Two pieces of the Dial stage belong to this block. The
   * on-air line in the stage's status, with Change and Stop: red ONLY for a
   * station on the air now, "Starting" in the accent while a start is being
   * confirmed, and a read that failed -- even one that kept an older answer
   * -- is unknown and says so, never "nothing on the air". And the choose
   * sheet under a pressed tile, the one place on the screen that can put a
   * station on the air, and it looks like it: what the station's last test
   * said, a speaker the person must choose, a filled button, and a second
   * press that says what will change. The backend proves the speaker
   * isolated and refuses anything else; the panel never picks a speaker by
   * itself and never offers the house's own output. Starting works from a
   * SAVED Dial station, so what goes on air is what was tested -- a preset
   * remembers the draw that was approved. Stop ends PROGRAMMING only: the
   * speaker keeps playing what is already queued. */

  async _fetchLive(force) {
    if (this._live && this._live.loading && !force) return;
    this._live = Object.assign({}, this._live, { loading: true });
    try {
      const data = await this._ws("parlorwave_radio/station_live");
      this._live = { at: Date.now(), data: data || {} };
      this._liveSettle();
    } catch (e) {
      this._live = { at: Date.now(), data: (this._live && this._live.data) || null,
                     error: true };
    }
    this._render();
  }

  /* A NEWER ANSWER ABOUT WHAT IS ON THE AIR. Every question on the Station
   * screen was asked about the answer before it, so when the station on
   * the air -- or the speaker it plays on -- changes, they are taken back:
   * the choose sheet's second press, the Stop question and the Request
   * Line's question must each be asked again. And the choose sheet is
   * re-aimed: a switch only ever goes to the speaker the station on the air
   * is playing on, and the speaker an old station was on is never left
   * chosen once it has stopped. Only a CURRENT answer counts: a failed
   * read changes nothing here. */
  _liveSettle() {
    if (!this._liveKnown()) return;
    const d = this._liveData();
    const q = (d.active && ((d.station || {}).target || {}).queue_id) || "";
    const key = d.active ? `on ${this._liveStartKey(d.station) || ""} ${q}` : String(d.state || "off");
    const seen = this._liveAirSeen;
    this._liveAirSeen = { key, q };
    const f = this._liveForm;
    if (f && d.active && f.target !== q) { f.target = q; f.confirm = false; }
    if (!seen || seen.key === key) return;
    if (f) {
      f.confirm = false;
      if (!d.active && seen.q && f.target === seen.q) f.target = "";
    }
    this._liveStopAsk = false;
    if (this._reqLine) this._reqLine.confirm = false;
  }

  async _fetchLiveTargets() {
    this._liveTargets = Object.assign({}, this._liveTargets, { loading: true });
    try {
      const data = await this._ws("parlorwave_radio/station_live_targets");
      this._liveTargets = { at: Date.now(), data: data || {} };
    } catch (e) {
      this._liveTargets = { at: Date.now(), data: null, error: true };
    }
    this._render();
  }

  _livePresets() {
    return this._dialPresets().filter((p) => p.kind === "music");
  }

  /* Opens the choose sheet. With no preset (Change): the first station fit
   * to go live that is not the one on the air. With a preset (a pressed
   * tile): that one -- and a tile pressed while the sheet is already open
   * re-aims it, keeping the speaker the person chose. Off the air no
   * speaker is ever chosen FOR the person; a switch keeps the station's own. */
  _liveOpenForm(presetId) {
    // Only a CURRENT answer aims the sheet: the speaker an older answer
    // named (a read that failed keeps it) is never chosen from here.
    const d = this._liveKnown() ? this._liveData() : {};
    const onAir = d.station || {};
    const pick = presetId
      ? this._dialPresets().find((p) => p.id === presetId)
      : this._livePresets().find((p) => this._dialViable(p) !== false && !this._dialOnAir(p));
    const kept = presetId && this._liveForm && !d.active ? this._liveForm.target || "" : "";
    this._liveForm = { preset_id: (pick || {}).id || "",
                       target: (d.active && onAir.target && onAir.target.queue_id) || kept,
                       confirm: false };
    this._liveStopAsk = false;
    if (this._reqLine) this._reqLine.confirm = false;
    if (!kept) this._fetchLiveTargets();
    this._render();
  }

  async _liveStart(mode = null) {
    const f = this._liveForm;
    // The SECOND press of the question on the screen, and nothing else: a
    // question the sheet has taken back (another speaker chosen, a newer
    // answer about the air) sends nothing, and a switch goes only to the
    // speaker the station on the air is playing on. A house handover sends
    // the token of the picture the person was shown, and their choice.
    if (!f || !f.confirm || !f.preset_id || !f.target || this._busy || this._stationBusy) return;
    if (f.handover && !(mode && f.handover.token)) return;
    const remove = mode === "replace" ? [...(f.handoverRemove || [])] : [];
    if (mode === "replace" && !remove.length) return;
    const d = this._liveKnown() ? this._liveData() : null;
    if (!d || (d.active && ((d.station || {}).target || {}).queue_id !== f.target)) {
      f.confirm = false;
      this._render();
      return;
    }
    const preset = this._livePresets().find((p) => p.id === f.preset_id) || {};
    const body = { target: f.target, preset_id: f.preset_id };
    if (f.handover) {
      body.handover = { token: f.handover.token, upcoming: mode };
      if (remove.length) body.handover.remove = remove;
    }
    this._busy = "live_start"; this._clearNotice(); this._render();
    try {
      const r = await this._ws("parlorwave_radio/station_live_start", body);
      if (r && r.ok) {
        this._liveForm = null;
        const where = (r.target && r.target.name) || "the speaker";
        const waiting = !!(r.handover && r.runway && r.runway.before_station
                           && r.runway.before_station.songs > 0);
        this._setNotice(true, `${waiting ? "Queued" : "On air"}: "${preset.label || "the station"}" on ${where}. `
          + this._liveStartSaid(r));
      } else if (r && r.handover && this._liveForm
                 && ["handover_required", "handover_changed"].includes(r.reason)) {
        // The queue moved under the question: ask again, with what is
        // there NOW. Nothing was changed, and nothing stays ticked.
        this._liveForm.handover = r.handover;
        this._liveForm.handoverRemove = [];
        this._liveForm.handoverPick = false;
        this._setNotice(false, String(r.message || "That speaker's queue changed. Look at it again."));
      } else {
        if (this._liveForm) this._liveForm.confirm = false;
        this._setNotice(false, "The station did not start: "
          + String((r && (r.message || this._liveProblem(r.reason))) || "no reason was given."));
      }
    } catch (e) {
      if (this._liveForm) this._liveForm.confirm = false;
      this._refuse("The station did not start: ", e);
    }
    this._busy = null;
    this._fetchLive(true);
  }

  /* What a start changed, in one sentence: where the station's songs went
   * and, for a house handover, what happened to the songs already queued. */
  _liveStartSaid(r) {
    const n = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
    const h = r.handover;
    const songs = `${n(r.opening_count || 0, "station song")}`;
    if (!h) return `${songs} were queued after the song playing now.`;
    const rep = h.replaced || {};
    const wait = (r.runway && r.runway.before_station) || {};
    const kept = wait.songs || 0;
    let head;
    if (h.mode === "replace" && h.removal_selected && rep.removed < h.removal_selected) {
      head = `${n(rep.removed || 0, "song")} of the ${n(h.removal_selected, "song")} you ticked
        ${rep.removed === 1 ? "was" : "were"} removed; the others had moved on or were already loaded, so they stay.`;
    } else if (h.mode === "replace") {
      head = `${n(rep.removed || 0, "queued song")} removed.`;
    } else {
      head = "";
    }
    const when = kept
      ? `The station starts after the ${n(kept, "queued song")} ahead of it${
          this._liveDuration(wait.seconds) ? ` (about ${this._liveDuration(wait.seconds)})` : ""}.`
      : `${songs} follow the song playing now.`;
    return [head, when, h.restore_autoplay
      ? "Autoplay is off while the station plays and comes back on when you stop it." : ""]
      .filter(Boolean).join(" ").replace(/\s+/g, " ");
  }

  /* The FIRST press on the house speaker: ask the backend what a handover
   * would take over. Its answer (handover_required) writes nothing; the
   * sheet then shows that picture and the two choices. */
  async _liveAskHandover() {
    const f = this._liveForm;
    if (!f || !f.preset_id || !f.target || this._busy || this._stationBusy) return;
    this._busy = "live_ask"; this._clearNotice(); this._render();
    try {
      const r = await this._ws("parlorwave_radio/station_live_start",
                               { target: f.target, preset_id: f.preset_id });
      if (r && r.reason === "handover_required" && r.handover && this._liveForm) {
        // A question, answered: nothing changed, so nothing is re-read.
        this._liveForm.handover = r.handover;
        this._liveForm.confirm = true;
        this._focusNext = { f: "air-ask" };
      } else if (r && r.ok) {
        // A service that predates the handover started it outright.
        this._liveForm = null;
        this._setNotice(true, `On air on ${(r.target && r.target.name) || "the speaker"}. `
          + this._liveStartSaid(r));
        this._fetchLive(true);
      } else {
        this._setNotice(false, "The station did not start: "
          + String((r && (r.message || this._liveProblem(r.reason))) || "no reason was given."));
      }
    } catch (e) {
      this._refuse("The station did not start: ", e);
    }
    this._busy = null;
    this._render();
  }

  _liveTargetRow(id) {
    return ((((this._liveTargets || {}).data || {}).targets || [])
      .find((x) => x.queue_id === id)) || null;
  }

  async _liveStop() {
    this._busy = "live_stop"; this._clearNotice(); this._render();
    try {
      const r = await this._ws("parlorwave_radio/station_live_stop");
      this._setNotice(!!(r && r.ok), (r && r.message) || "The station could not be stopped.");
    } catch (e) {
      this._refuse("The station could not be stopped: ", e);
    }
    this._liveStopAsk = false;
    this._busy = null;
    this._fetchLive(true);
  }

  _liveKind(strategy) {
    if (strategy === "artist_radio") return "Artist station";
    if (strategy === "genre") return "Genre station";
    if (strategy === "era") return "Era station";
    return "Station";
  }

  /* Why a running station is not refilling, in the screen's words. The
   * backend's code is the key; the sentence is the panel's. */
  _liveProblem(code) {
    const words = {
      candidates_exhausted: "Waiting for songs: everything this station can play "
        + "has been heard or queued recently. It adds more as the rotation frees up.",
      station_unresolvable: "The station no longer matches your library, so it "
        + "cannot add songs. Stop it, or start another.",
      catalog_unavailable: "Music Assistant's library could not be read, so no "
        + "songs could be added. It will try again.",
      ma_autoplay_contested: "Music Assistant's own Autoplay keeps being switched "
        + "back on for this speaker, so the station has stepped back. Turn "
        + "Autoplay off in Music Assistant to hand refill back.",
      player_missing: "The speaker has disappeared from Music Assistant.",
      queue_unreadable: "The speaker's queue could not be read.",
      incomplete_queue: "The speaker's queue could not be read in full.",
      current_anchor_missing: "The speaker is not playing anything the station can follow.",
      ownership_unproven: "None of the queued songs can be proven to be the station's.",
      append_did_not_land: "Music Assistant did not add the last songs.",
      target_not_isolated: "The speaker is now part of a group (or unavailable), "
        + "so the station has stopped adding songs to it. Ungroup it, or stop the station.",
      confirmation_lost: "The last songs were added but could not be confirmed. "
        + "ParlorWave will not add them again.",
      reconciliation_unproven: "The last songs sent could not be confirmed yet.",
      reconciliation_unreadable: "The last songs sent could not be confirmed yet.",
      station_state_unreadable: "The station's state could not be read. Nothing has changed; try again in a moment.",
      maintenance_failed: "The station could not add songs just now. It will try again.",
      no_output_configured: "No speaker is enabled for the DJ yet. Choose one in Settings.",
      no_match: "Nothing in your Music Assistant library matches that. Try an artist, a genre, or a decade.",
    };
    return words[code] || (code ? `The station reported a problem (${String(code).replace(/_/g, " ")}).` : "");
  }

  /* THE ON-AIR LINE, in the Dial stage's status. Red only for a station on
   * the air now; "Starting" in the accent; quiet when there is none; and
   * unknown -- not "nothing on the air" -- when the last read failed, even
   * if an older answer is still held. */
  _renderOnAirStationCard() {
    const l = this._live;
    const d = (l && l.data) || null;
    const quiet = (text) => `
      <div class="air-line off">
        <span class="air-lamp" aria-hidden="true"></span>
        <span class="air-text">${text}</span>
      </div>`;
    let body;
    if (!l || (l.loading && !d)) {
      body = quiet("Reading the on-air station…");
    } else if (l.error || !d || d.ok === false) {
      body = quiet(`The on-air station could not be read right now. Nothing has
        changed; try again in a moment.`);
    } else if (d.active || d.state === "starting") {
      body = this._renderAirActive(d);
    } else {
      body = this._renderAirOff(d);
    }
    return `
      <div class="air-status" role="group" aria-label="On-air station">${body}
      </div>`;
  }

  _renderAirActive(d) {
    const st = d.station || {};
    const starting = !d.active;          // state "starting": sent, being confirmed
    const runway = st.runway || {};
    const refill = st.refill || {};
    const last = refill.last || {};
    const busy = !!this._busy;
    const n = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
    const where = (st.target && st.target.name) || "a speaker";
    const since = starting ? "" : this._histClock(st.started_at);
    const from = { request_line: "the Request Line", dial: "the Dial",
                   station_tab: "the Station tab" }[st.origin] || "";
    const owned = typeof runway.owned === "number" ? runway.owned : null;
    const refilled = last.at ? this._histClock(last.at) : "";
    // ONE line of facts under the name: what kind of station, its term, its
    // runway at the last check, its last refill and where it was started.
    const meta = starting
      ? "Starting: the songs were sent and are being confirmed. Nothing will be sent twice."
      : [this._liveKind(st.strategy),
         st.query ? `“${st.query}”` : "",
         owned === null ? "runway not measured yet" : `${n(owned, "station song")} queued`,
         last.at
           ? `last refill${refilled ? ` ${refilled}` : ""} ${last.ok
               ? `added ${n(last.appended || 0, "song")}` : "added nothing"}`
           : "no refill yet",
         refill.pending ? "a refill is being confirmed" : "",
         from ? `started from ${from}` : "",
         st.handover ? "took over from Autoplay" : ""].filter(Boolean).join(" · ");
    const waiting = !starting && this._liveWaiting(st);
    const waitSay = waiting
      ? `Starts after ${n(waiting.songs, "queued song")}${this._liveDuration(waiting.seconds)
          ? ` (about ${this._liveDuration(waiting.seconds)})` : ""}.` : "";
    const problem = st.problem
      ? `<div class="notice err air-problem" role="status">${this._esc(this._liveProblem(st.problem))}</div>` : "";
    const acts = this._liveStopAsk ? "" : `
        <span class="air-acts">
          <button class="ghost small" id="air-open" ${busy || this._liveForm || this._dialEdit || starting ? "disabled" : ""}
                  aria-label="Change station">Change</button>
          <button class="ghost small" id="air-stop" ${busy || starting ? "disabled" : ""}
                  aria-label="Stop station">Stop</button>
        </span>`;
    const confirm = this._liveStopAsk
      ? `<div class="air-confirm" role="group" tabindex="-1" data-focus="stop-ask"
           aria-label="Confirm stopping the station">
           <div class="hint">Stop programming ${this._esc(where)}? Nothing more
           will be added. What is already queued keeps playing.${(st.handover || {}).restore_autoplay
             ? ` Music Assistant's Autoplay comes back on for ${this._esc(where)}.` : ""}</div>
           <div class="row tight">
             <button class="ghost" id="air-stop-confirm" ${busy ? "disabled" : ""}>${this._busy === "live_stop" ? "Stopping…" : "Stop it"}</button>
             <button class="ghost small" id="air-stop-keep" ${busy ? "disabled" : ""}>Keep it on</button>
           </div></div>`
      : "";
    return `
      <div class="air-line ${starting || waiting ? "starting" : "on"}">
        <span class="air-lamp" aria-hidden="true"></span>
        <span class="air-text"><span class="air-word">${starting ? "Starting" : waiting ? "Queued" : "On air"}</span>
          <b>${this._esc(st.label || st.query || "Station")}</b> on ${this._esc(where)}${since
            ? ` · since ${this._esc(since)}` : ""}
          <span class="air-meta">${this._esc(waitSay ? `${waitSay} ${meta}` : meta)}</span></span>${acts}
      </div>
      ${problem}${confirm}`;
  }

  _renderAirOff(d) {
    const last = d.last;
    const stopped = last && last.stopped_at ? this._histClock(last.stopped_at) : "";
    const lastBit = last && last.label
      ? ` · last: “${this._esc(last.label)}” on ${this._esc((last.target && last.target.name)
          || "a speaker")}${stopped ? `, stopped ${this._esc(stopped)}` : ""}` : "";
    const legacy = d.legacy_station_active
      ? `<div class="notice err air-legacy">A Start Radio station is running, so a station
         cannot start here until it ends.</div>` : "";
    return `
      <div class="air-line off">
        <span class="air-lamp" aria-hidden="true"></span>
        <span class="air-text">No Dial Station running${lastBit}</span>
      </div>
      ${legacy}${this._renderAutoplayPending(last)}`;
  }

  /* A HOUSE HANDOVER'S STOP COULD NOT SWITCH AUTOPLAY BACK ON. ParlorWave
   * never does that later by itself -- an OFF flag cannot say whether it is
   * still ParlorWave's or the person's own choice -- so the person decides
   * here. Shown only while the backend says the decision is pending. */
  _renderAutoplayPending(last) {
    const r = last && last.autoplay_restore;
    if (!r || r.state !== "pending") return "";
    const where = this._esc(r.speaker || (last.target && last.target.name) || "that speaker");
    const why = r.reason === "ma_unavailable" ? "Music Assistant did not answer when the station stopped"
      : r.reason === "interrupted" ? "ParlorWave restarted while the station was stopping"
      : "Music Assistant did not confirm the change";
    const busy = !!this._busy;
    return `<div class="air-confirm autoplay-pending" role="group" tabindex="-1"
         aria-label="Switch Autoplay back on for ${where}?">
         <div><strong>Autoplay is still off for ${where}.</strong></div>
         <div class="hint">It was on before the station took over, but ${why}, so it was not
           switched back on. ParlorWave will not switch it on by itself now: it cannot tell
           whether off is still the station's doing or your choice.${r.manual_playback_since
             ? " Other music has been started there since." : ""}</div>
         <div class="row tight">
           <button id="air-autoplay-restore" ${busy ? "disabled" : ""}>${this._busy === "live_autoplay"
             ? "Switching on…" : "Switch Autoplay back on"}</button>
           <button class="ghost small" id="air-autoplay-dismiss" ${busy ? "disabled" : ""}>Leave it off</button>
         </div></div>`;
  }

  async _liveAutoplayDecision(decision) {
    if (this._busy) return;
    this._busy = "live_autoplay"; this._clearNotice(); this._render();
    try {
      const r = await this._ws("parlorwave_radio/station_live_autoplay", { decision });
      const where = ((r && r.autoplay_restore) || {}).speaker || "the speaker";
      this._setNotice(!!(r && r.ok), r && r.ok
        ? (decision === "restore" ? `Autoplay is on again for ${where}.` : `Autoplay stays off for ${where}.`)
        : String((r && r.message) || "Nothing was changed."));
    } catch (e) {
      this._refuse("Autoplay was not changed: ", e);
    }
    this._busy = null;
    this._fetchLive(true);
  }

  /* THE CHOOSE SHEET, under a pressed tile: the station, what its last test
   * said, the speaker and the two presses that put it on the air. The
   * Station tab may start an untested, stale or Off-the-Dial station (the
   * backend re-runs the live rule on every start); a thin one, an All News
   * one and the one already on the air are shown, explained, and offer no
   * start. */
  _renderAirForm(d) {
    const f = this._liveForm;
    const known = this._liveKnown();
    const switching = known && !!d.active;
    // A Dial (knob) start that is with the backend holds this sheet too.
    const busy = !!this._busy || !!this._stationBusy;
    const p = (f.preset_id && this._dialPresets().find((x) => x.id === f.preset_id)) || null;
    const lt = (p && p.last_test) || {};
    const n = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
    const counts = typeof lt.tracks === "number"
      ? n(lt.tracks, "track") + (typeof lt.artists === "number" ? ` · ${n(lt.artists, "artist")}` : "")
      : "";
    const l = this._live;
    const lit = !!(p && this._dialLit(p));
    let verdict;
    let tone = "";
    let startable = false;
    if (!p) {
      verdict = `<div>Choose a station above to put it on the air.</div>`;
    } else if (p.kind !== "music") {
      verdict = `<div>All News stations are not in this release.</div>`;
    } else if (lit) {
      verdict = `<div>This station is already on the air.</div>`;
    } else if (this._dialViable(p) === false) {
      tone = " weak";
      verdict = `<div><strong>Too thin to go live</strong>${counts ? ` · ${this._esc(counts)}` : ""}</div>
        <div class="hint">Test a broader term in Edit, or choose another station.</div>`;
    } else if (this._dialTestState(p) === "stale") {
      tone = " warn";
      startable = true;
      verdict = `<div>Needs retest — the station builder or term has changed since it was tested.</div>`;
    } else if (this._dialViable(p) === null) {
      startable = true;
      verdict = `<div>Not tested yet.</div>`;
    } else {
      tone = " ok";
      startable = true;
      verdict = `<div>Tested${counts ? ` · ${this._esc(counts)}` : ""} · passes the live-station rules</div>`;
    }
    // Whether this is a start or a switch on the station's own speaker
    // depends on what is on the air NOW, so while that is unknown no start
    // is offered at all. Nor while a Start Radio station runs, or while a
    // start is still being confirmed: the on-air line says so, and the
    // Request Line and the Dial refuse both too -- one start at a time,
    // nothing sent twice.
    let wait = "";
    if (startable && !known) {
      startable = false;
      wait = !l || (l.loading && !l.data) ? "Reading the on-air station…"
        : "The on-air station could not be read right now, so a station cannot start here yet. Try again in a moment.";
    } else if (startable && d.legacy_station_active) {
      startable = false;
      wait = "A Start Radio station is running, so a station cannot start here until it ends.";
    } else if (startable && d.state === "starting") {
      startable = false;
      wait = "A station is starting. Try again in a moment.";
    }
    const t = this._liveTargets;
    const targets = ((t && t.data) || {}).targets || [];
    const shown = targets.filter((x) => x.eligible || x.dj_output || x.house_output);
    const onAir = (d.station && d.station.target) || {};
    let speakers = "";
    if (!startable) {
      speakers = "";
    } else if (switching) {
      speakers = `<div class="hint">On ${this._esc(onAir.name || "the same speaker")}
        (a station changes where it is playing only by stopping it first).</div>`;
    } else if (!t || (t.loading && !t.data)) {
      speakers = `<div class="hint">Checking which speakers can take a station…</div>`;
    } else if (t.error || !(t.data || {}).ok) {
      speakers = `<div class="notice err">The speakers could not be checked, so a
        station cannot start right now.</div>`;
    } else {
      // Held while its question is on the screen: the speaker that question
      // names is the one Go on air sends. Back lets it be changed.
      speakers = `<label class="dial-field"><span class="label">Speaker</span>
        <select id="air-target" aria-label="Speaker for the station" ${f.confirm || busy ? "disabled" : ""}>
          <option value="" ${f.target ? "" : "selected"}>Choose a speaker…</option>
          ${shown.map((x) => `<option value="${this._esc(x.queue_id)}"
            ${x.queue_id === f.target ? "selected" : ""} ${x.eligible ? "" : "disabled"}>
            ${this._esc(x.name || x.queue_id)}${x.eligible
              ? (x.handover ? " — house speaker, by handover" : "")
              : ` — ${this._esc(x.message || "not available")}`}</option>`).join("")}
        </select></label>
        <div class="hint">A station plays on one speaker. The house speaker
        can take one by handover: you see what it takes over before anything
        changes. Speaker groups cannot take a station yet.</div>`;
    }
    const chosen = shown.find((x) => x.queue_id === f.target) || {};
    const whereName = switching ? (onAir.name || "the speaker") : (chosen.name || "the speaker");
    // Ready only when the speaker the sentence names IS the one the start
    // would send: on a switch the station's own, off the air a chosen one
    // that may take a station.
    const aimed = switching ? !!f.target && f.target === onAir.queue_id : !!chosen.eligible;
    const ready = startable && !!f.preset_id && aimed;
    let press = "";
    if (ready && f.confirm && f.handover && !switching) {
      press = this._renderHandoverAsk(f.handover, whereName, busy);
    } else if (ready && f.confirm) {
      press = `<div class="air-confirm" role="group" tabindex="-1" data-focus="air-ask"
           aria-label="Confirm going on air">
           <div class="hint">${switching
             ? `This replaces the current station's queued songs on ${this._esc(whereName)}
                with the new station's, after the song playing now. Songs you added
                yourself, DJ breaks and news stay where they are.`
             : `This changes ${this._esc(whereName)}'s queue: the station's songs are
                added after the song playing now, and ParlorWave keeps adding more
                until you stop it. Music Assistant's Autoplay is switched off for
                that speaker.`}</div>
           <div class="row tight">
             <button id="air-confirm" ${busy ? "disabled" : ""}>${this._busy === "live_start"
               ? "Going on air…" : "Go on air"}</button>
             <button class="ghost small" id="air-back" ${busy ? "disabled" : ""}>Back</button>
           </div></div>`;
    } else if (startable) {
      press = `<div class="sheet-acts">
           <button id="air-go" ${busy || !ready ? "disabled" : ""}
                   aria-label="${switching ? "Switch station" : "Start station"}">${switching
             ? "Switch station" : "Start station"}</button>
         </div>`;
    }
    const chip = !p ? ""
      : lit ? `<span class="sheet-chip lit"><span class="preset-lamp" aria-hidden="true"></span>On air</span>`
      : known ? `<span class="sheet-chip">Selected · not on the air</span>`
      : `<span class="sheet-chip">Selected</span>`;
    return `
      <div class="sheet air-form" role="group" tabindex="-1" data-focus="air-sheet"
           aria-label="${switching ? "Change the on-air station" : "Start a station"}">
        <div class="sheet-head">
          <div class="sheet-title">${p ? this._esc(p.label || "Station")
            : (switching ? "Change the station" : "Start a station")}${chip ? ` ${chip}` : ""}</div>
          ${p ? `<button class="ghost small" id="air-edit" ${busy ? "disabled" : ""}
                   aria-label="Edit ${this._esc(p.label || "this station")}">Edit</button>` : ""}
          <button class="sheet-close" id="air-cancel" ${busy ? "disabled" : ""}
                  aria-label="Close" title="Close">${this._stIcon("close")}</button>
        </div>
        <div class="air-verdict${tone}">${verdict}</div>
        ${wait ? `<div class="hint">${wait}</div>` : ""}
        ${speakers}
        ${press}
        ${this._busy === "live_start" ? `<div class="hint" role="status">Building station…
        The first build after a restart can take a little longer.</div>` : ""}
      </div>`;
  }

  /* THE HOUSE HANDOVER, asked. What the speaker is doing now (Autoplay on
   * or off, the songs already queued and how long they run), what changes,
   * what does not, and the one choice that matters: the songs already
   * queued play first, or the station replaces them. Both buttons send the
   * token of exactly this picture; the backend refuses if it has changed. */
  _renderHandoverAsk(h, where, busy) {
    const n = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
    const w = this._esc(where);
    const f = this._liveForm || {};
    const picked = new Set(f.handoverRemove || []);
    const auto = h.autoplay === true
      ? `Music Assistant's Autoplay is choosing the music on ${w} now. The station
         switches Autoplay off for ${w} while it plays and switches it back on
         when you stop the station.`
      : h.autoplay === false
        ? `Autoplay is off for ${w}, and stays off.`
        : `Autoplay's setting for ${w} could not be read. The station switches it
           off while it plays and leaves it off when you stop.`;
    const ahead = h.music_ahead || 0;
    const loading = this._busy === "live_start";
    const common = `<div class="hint">Speaker groups and every other speaker stay as they are.
         DJ breaks and news carry on.</div>`;
    if (!ahead) {
      return `<div class="air-confirm handover" role="group" tabindex="-1" data-focus="air-ask"
           aria-label="Confirm the handover of ${w}">
           <div><strong>Hand ${w} over to this station?</strong></div>
           <div class="hint">${auto}</div>
           <div class="hint">Nothing else is queued after the song playing now: the
             station starts after it.</div>${common}
           <div class="row tight">
             <button id="air-hand-keep" ${busy ? "disabled" : ""}>${loading ? "Going on air…" : "Hand over and go on air"}</button>
             <button class="ghost small" id="air-back" ${busy ? "disabled" : ""}>Back</button>
           </div></div>`;
    }
    const wait = this._liveDuration(h.music_ahead_s || 0);
    const queued = `${n(ahead, "song")} ${ahead === 1 ? "is" : "are"} queued after the one
      playing now${wait ? ` (about ${wait})` : ""}.`;
    if (!f.handoverPick) {
      return `<div class="air-confirm handover" role="group" tabindex="-1" data-focus="air-ask"
           aria-label="Confirm the handover of ${w}">
           <div><strong>Hand ${w} over to this station?</strong></div>
           <div class="hint">${auto}</div>
           <div class="hint">${queued} They are kept: the station's songs are queued
             after them, so the station starts once they have played${wait
               ? `, in about ${wait} from the end of the song playing now` : ""}.</div>${common}
           <div class="row tight">
             <button id="air-hand-keep" ${busy ? "disabled" : ""}>${loading ? "Going on air…" : "Play them first"}</button>
             <button class="ghost" id="air-hand-choose" ${busy || !h.replaceable ? "disabled" : ""}>Choose songs to remove…</button>
             <button class="ghost small" id="air-back" ${busy ? "disabled" : ""}>Back</button>
           </div></div>`;
    }
    const why = { loaded: "already loaded, it plays", announced: "the DJ announced it, it plays" };
    const rows = (h.songs || []).map((x) => {
      const label = `${this._esc(x.title || "Untitled")}${x.artist ? ` · ${this._esc(x.artist)}` : ""}`;
      return x.status === "removable"
        ? `<label class="hand-song"><input type="checkbox" data-handpick="${this._esc(x.queue_item_id)}"
             ${picked.has(x.queue_item_id) ? "checked" : ""} ${busy ? "disabled" : ""}>
             <span>${label}</span></label>`
        : `<div class="hand-song kept"><span>${label}</span>
             <span class="hint">${why[x.status] || "it plays"}</span></div>`;
    }).join("");
    const more = h.songs_unlisted ? `<div class="hint">…and ${n(h.songs_unlisted, "more song")}, which stay.</div>` : "";
    const count = picked.size;
    return `<div class="air-confirm handover" role="group" tabindex="-1" data-focus="air-ask"
         aria-label="Choose the songs to remove from ${w}">
         <div><strong>Remove which queued songs?</strong></div>
         <div class="hint">ParlorWave cannot tell which of these Autoplay added and which
           someone queued, so nothing is removed unless you tick it. Unticked songs play
           first; the station follows them.</div>
         <div class="hand-list">${rows}</div>${more}
         <div class="row tight">
           <button class="ghost small" id="air-hand-all" ${busy ? "disabled" : ""}>Tick all</button>
           <button class="ghost small" id="air-hand-none" ${busy || !count ? "disabled" : ""}>Untick all</button>
         </div>
         <div class="row tight">
           <button class="ghost danger" id="air-hand-replace" ${busy || !count ? "disabled" : ""}>${loading
             ? "Going on air…" : count ? `Remove ${n(count, "song")} and go on air` : "Tick the songs to remove"}</button>
           <button class="ghost small" id="air-hand-unpick" ${busy ? "disabled" : ""}>Keep them all</button>
         </div></div>`;
  }

  /* "1 h 35 min" / "12 min" / "" for a length in seconds. */
  _liveDuration(seconds) {
    const mins = Math.round((seconds || 0) / 60);
    if (!mins) return "";
    return mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
  }

  /* A handover station kept the songs that were queued, and they have not
   * all played yet: its own songs are WAITING, so it is not on the air.
   * {songs, seconds} from the backend's last runway check, else null. */
  _liveWaiting(st) {
    const b = st && st.handover && st.runway && st.runway.before_station;
    return b && b.songs > 0 ? b : null;
  }

  /* --- The Request Line ----------------------------------------------------
   * Type an artist or a genre and the station on air becomes that station
   * (or one starts). NOT a song request: the text becomes the station term
   * of a music StationIntent (origin request_line) and goes to the SAME
   * start command as the form above and the Dial -- the backend resolves
   * it with the one resolver, applies the one live rule and proves the
   * speaker. Nothing here interprets the words.
   *
   * THE SPEAKER IS NEVER GUESSED. On air, it is the station's own speaker
   * and the start is a switch. Off air, the person picks one of the
   * speakers the backend says may take a station; the backend's
   * dial_target (where the last station ran) is offered first, the
   * house's DJ output never.
   *
   * Two presses, like the form: the first ASKS, naming the station term
   * and the speaker; the second starts exactly the term it asked about.
   * Text changed after the question was asked takes the question back. */

  _reqTargetFor(d) {
    if (d.active) return ((d.station || {}).target || {}).queue_id || "";
    const rows = (((this._liveTargets || {}).data || {}).targets || []);
    // A house speaker is taken over only from the Station sheet, where the
    // handover is shown and confirmed: never from here.
    const eligible = (id) => rows.some((x) => x.queue_id === id && x.eligible && !x.handover);
    if (this._reqTarget && eligible(this._reqTarget)) return this._reqTarget;
    const aim = (d.dial_target || {}).queue_id;
    return aim && eligible(aim) ? aim : "";
  }

  _reqAsk() {
    const d = this._liveData();
    const text = String(this._reqLine.text || "").trim().replace(/\s+/g, " ");
    this._reqLine.result = null;
    if (!text) {
      this._reqLine.result = { ok: false, text: "Type an artist or a genre first." };
      this._focusNext = { id: "rl-text" };
      this._render();
      return;
    }
    this._reqLine.asked = text;
    this._reqLine.confirm = true;
    this._focusNext = { f: "rl-ask" };       // the question it has just asked
    if (!d.active) this._fetchLiveTargets();
    this._render();
  }

  async _reqStart() {
    const d = this._liveData();
    const r0 = this._reqLine;
    const text = String(r0.text || "").trim().replace(/\s+/g, " ");
    const target = this._reqTargetFor(d);
    if (!r0.confirm || !r0.asked || !target || this._busy || this._stationBusy) return;
    if (text !== r0.asked) {          // edited since the question: ask again
      r0.confirm = false; this._render(); return;
    }
    this._busy = "request_line"; this._clearNotice();
    r0.result = null;
    this._render();
    let r;
    try {
      r = await this._ws("parlorwave_radio/station_live_start", {
        target,
        intent: { kind: "music", origin: "request_line",
                  label: r0.asked.slice(0, 40), query: r0.asked },
      });
    } catch (e) {
      r = { ok: false, message: this._humanRefusal(e).text };
    }
    this._busy = null;
    if (r && r.ok) {
      const where = (r.target && r.target.name) || "the speaker";
      this._reqLine = { text: "", confirm: false, result: { ok: true,
        of: this._liveStartKey(r),
        text: `On air: ${this._reqResolved(r.station, r0.asked)} on ${where}. `
          + `${r.opening_count} songs were queued after the song playing now.` } };
    } else {
      r0.confirm = false;
      r0.result = { ok: false, text: "The station did not start: "
        + String((r && (r.message || this._liveProblem(r.reason))) || "no reason was given.") };
    }
    this._fetchLive(true);
  }

  /* The Request Line's question, naming the term and the speaker the
   * second press would send to. Drawn by the renderer, and redrawn in
   * place when a speaker is chosen (the list keeps focus, so the render
   * waits). */
  _reqSay(switching, asked, whereName) {
    return switching
      ? `Change the station on ${this._esc(whereName)} to “${this._esc(asked)}”? The
               current station's queued songs are replaced after the song playing now.
               Songs you added yourself, DJ breaks and news stay where they are.`
      : `Start a “${this._esc(asked)}” station on ${this._esc(whereName)}? Its songs are
               added after the song playing now, and ParlorWave keeps adding more until
               you stop it. Music Assistant's Autoplay is switched off for that speaker.`;
  }

  /* What the term turned out to be, in the screen's words. */
  _reqResolved(st, term) {
    const s = st || {};
    const what = s.strategy === "artist_radio" && s.seed_artist ? s.seed_artist
      : s.strategy === "genre" && (s.genres || []).length
        ? s.genres[0] + (s.era ? ` · ${s.era}` : "")
        : s.era || term;
    return `${this._liveKind(s.strategy)} · ${what}`;
  }

  _renderRequestLine(d) {
    const r = this._reqLine;
    const busy = !!this._busy || this._stationBusy;
    const running = this._busy === "request_line";
    // One start flow at a time: while the choose sheet is open on the Dial,
    // or a Stop is being asked there, the Request Line waits -- visibly,
    // and saying why -- rather than starting a second station beside it.
    const sheet = !!(this._liveForm
      || (this._liveStopAsk && (d.active || d.state === "starting")));
    const blocked = d.legacy_station_active ? "A Start Radio station is running, so the Request Line cannot start one."
      : d.state === "starting" ? "A station is starting. Try again in a moment."
      : sheet ? "Finish or cancel the station change above first." : "";
    const switching = !!d.active;
    const onAir = (d.station && d.station.target) || {};
    let ask = "";
    if (r.confirm && !running && !sheet && !blocked) {
      let speaker;
      let unchecked = false;
      let whereName = onAir.name || "the speaker";
      if (switching) {
        speaker = "";
      } else {
        const t = this._liveTargets;
        const rows = ((t && t.data) || {}).targets || [];
        const chosen = this._reqTargetFor(d);
        whereName = (rows.find((x) => x.queue_id === chosen) || {}).name || "the speaker";
        if (!t || (t.loading && !t.data)) {
          speaker = `<div class="hint">Checking which speakers can take a station…</div>`;
        } else if (t.error || !(t.data || {}).ok) {
          // No question over a refusal: the sentence that asks
          // "start it on the speaker?" is not drawn while the answer is
          // already no. The notice and Back are the whole sheet.
          unchecked = true;
          speaker = `<div class="notice err">The speakers could not be checked, so a
            station cannot start right now.</div>`;
        } else {
          speaker = `<label class="dial-field"><span class="label">Speaker</span>
            <select id="rl-target" aria-label="Speaker for the Request Line station">
              <option value="" ${chosen ? "" : "selected"}>Choose a speaker…</option>
              ${rows.filter((x) => x.eligible && !x.handover).map((x) => `<option value="${this._esc(x.queue_id)}"
                ${x.queue_id === chosen ? "selected" : ""}>${this._esc(x.name || x.queue_id)}</option>`).join("")}
            </select></label>`;
        }
      }
      const ready = switching || !!this._reqTargetFor(d);
      ask = `<div class="air-confirm" role="group" tabindex="-1" data-focus="rl-ask"
          aria-label="Confirm the Request Line station">
          ${speaker}
          ${unchecked ? "" : `<div class="hint" id="rl-say">${this._reqSay(switching, r.asked, whereName)}</div>`}
          <div class="row tight">
            ${unchecked ? "" : `<button id="rl-confirm" ${busy || !ready || blocked ? "disabled" : ""}>${switching ? "Change station" : "Go on air"}</button>`}
            <button class="ghost small" id="rl-back" ${busy ? "disabled" : ""}>Back</button>
          </div></div>`;
    }
    const progress = running
      ? `<div class="hint rl-progress" role="status">Building station “${this._esc(r.asked)}”…
         The first build after a restart can take a little longer.</div>` : "";
    // "On air: X" describes ONE start. Once that station is no longer the
    // one on air -- stopped, or replaced from anywhere -- it is history, and
    // saying it in green would be a false claim about the present.
    const current = !r.result || !r.result.ok || !r.result.of
      || (d.active && this._liveStartKey(d.station) === r.result.of);
    const result = r.result && !running && current
      ? `<div class="notice ${r.result.ok ? "ok" : "err"} rl-result" role="status">${this._esc(r.result.text)}</div>` : "";
    return `
      <div class="air-request" role="group" aria-label="Request Line">
        <div class="row rl-row">
          <h2 class="rl-title">Request Line</h2>
          <input id="rl-text" type="text" maxlength="120" autocomplete="off"
                 placeholder="An artist or a genre, e.g. 90s Rock"
                 aria-label="Station to ${switching ? "change to" : "start"}"
                 value="${this._esc(r.text || "")}" ${blocked ? "disabled" : ""}>
          <button id="rl-go" ${busy || blocked || r.confirm ? "disabled" : ""}>${switching ? "Change station" : "Start station"}</button>
        </div>
        <div class="hint rl-hint">Type an artist or a genre, with a decade if you like. This
        ${switching ? "changes the station on air" : "starts a station"}.</div>
        ${blocked ? `<div class="hint rl-blocked">${this._esc(blocked)}</div>` : ""}
        ${ask}${progress}${result}
        ${this._renderSongRequest()}
      </div>`;
  }


  /* The Request Line's own card, compact, under the Dial. Whether it starts
   * a station or changes the one on air depends on the on-air state, so
   * while that state is unknown it says so instead of offering the box. */
  _renderRequestLineCard() {
    const l = this._live;
    const d = (l && l.data) || null;
    const known = this._liveKnown();
    return `
      <section class="card rl-card" aria-label="Request Line">
        ${known ? this._renderRequestLine(d) : ""}
        ${known ? "" : `<div class="row rl-row"><h2 class="rl-title">Request Line</h2>
          <div class="hint rl-off">The Request Line is unavailable until the on-air station can be read.</div></div>`}
      </section>`;
  }

  /* --- One song, next (alpha.4) --------------------------------------------
   * Its own block, outside the on-air station's: it is not a station
   * command and it never starts one. The Request Line card draws it. */

  /* ONE SONG, NEXT (alpha.4). A title, and the artist if it helps; the
   * backend finds it in the Music Assistant library and asks Music
   * Assistant to play it next on the speaker the DJ is on now -- its own
   * "play next", nothing more: no station starts, nothing is reordered,
   * and an answer that is not exactly one song inserts nothing and says
   * so. */
  _renderSongRequest() {
    const q = this._songReq;
    const running = this._busy === "request_song";
    const busy = !!this._busy;
    const result = q.result && !running
      ? `<div class="notice ${q.result.ok ? "ok" : "err"} rl-song-result" role="status">${this._esc(q.result.text)}</div>` : "";
    return `
      <div class="rl-song" role="group" aria-label="Play a song next">
        <div class="row rl-row">
          <input id="rl-song-title" type="text" maxlength="120" autocomplete="off"
                 placeholder="A song title" aria-label="Song title"
                 value="${this._esc(q.title || "")}">
          <input id="rl-song-artist" type="text" maxlength="120" autocomplete="off"
                 placeholder="Artist (optional)" aria-label="Artist, optional"
                 value="${this._esc(q.artist || "")}">
          <button class="ghost" id="rl-song-go" ${busy ? "disabled" : ""}>${running ? "Finding…" : "Play next"}</button>
        </div>
        <div class="hint rl-song-hint">One song from your Music Assistant library, played
        next on the speaker the DJ is on, after the song playing now.</div>
        ${result}
      </div>`;
  }

  /* What the backend said, in one sentence a listener can act on. */
  _songSay(r, title) {
    const t = `“${title}”`;
    const by = (k) => `“${k.title || title}”${k.artist ? ` by ${k.artist}` : ""}`;
    if (r && r.action === "inserted_local_next") {
      return { ok: true, text: `Up next: ${by(r.track || {})}.` };
    }
    // Added, but MA's readback did not show it directly after the
    // song playing now -- so "next" is not said.
    if (r && r.action === "inserted_unconfirmed") {
      return { ok: true, text: `Added ${by(r.track || {})}, but Music Assistant may play another song first.` };
    }
    const res = (r && r.result) || {};
    if (res.status === "ambiguous") {
      const cands = (res.candidates || []).slice(0, 3);
      const k = cands[0] || {};
      const asked = String((res.query && res.query.artist) || "").trim();
      const join = (xs) => [...new Set(xs.filter(Boolean))].join("; ");
      if (res.ambiguity === "version") {
        const labelled = cands.find((c) => c.version);
        const label = (c) => `${c.version || "the plain recording"}${c.album ? ` (${c.album})` : ""}`;
        return { ok: false, text: `Your library has more than one version of ${by(k)}: ${join(cands.map(label))}. `
          + (labelled ? `Type the version into the title to choose one, for example “${k.title} (${labelled.version})”.` : "Nothing was added.") };
      }
      if (res.ambiguity === "album") {
        return { ok: false, text: `${by(k)} is on more than one album in your library (${join(cands.map((c) => c.album))}). `
          + "A request cannot choose between albums yet, so nothing was added." };
      }
      const artists = join(cands.map((c) => c.artist));
      return { ok: false, text: asked
        ? `${t} matches more than one artist like “${asked}” (${artists}). Type the artist's full name.`
        : `More than one artist has a song called ${t} (${artists}). Add the artist.` };
    }
    if (res.status === "local_not_found") return { ok: false, text: `${t} is not in your Music Assistant library.` };
    const pend = (r && r.pending) || {};
    const why = {
      nothing_playing: "Nothing is playing on the DJ's speaker. Start some music first; a request plays after the song playing now.",
      player_paused: "The DJ's speaker is paused. Press play first; a request plays after the song playing now.",
      next_already_buffered: "Music Assistant has already lined up the next song. Ask again once it starts.",
      queue_changed: "The queue changed while the request was being placed, so nothing was added. Try again.",
      request_pending: `${pend.title ? `“${pend.title}”` : "Your last request"} is still waiting to play next. Ask for another song once it starts.`,
      target_required: "The DJ is on more than one speaker right now, so the request was not sent.",
      library_unavailable: "Your Music Assistant library could not be read. Try again in a moment.",
      program_on_air: "The DJ or the news is on now or up next. Ask again once it has played.",
      insert_failed: "Music Assistant did not take the request. Nothing was added.",
      unresolved_uri: `${t} was found but cannot be played from here.`,
      no_output_configured: "No speaker is enabled for the DJ yet. Choose one under Speakers ParlorWave may DJ on, in Settings.",
      output_unavailable: "The DJ's speaker is not available right now, so the request was not sent.",
    }[(r && (r.reason || r.action)) || ""];
    // A reason this screen has no words for is still said in words, never
    // as a code: "no_output_configured" is not a sentence.
    const code = String((r && (r.reason || r.action)) || "").trim();
    const said = (r && r.message) ? String(r.message)
      : code ? `${code.replace(/_/g, " ")}.` : "no reason was given.";
    return { ok: false, text: why || `The request was not played: ${said}` };
  }

  async _songAsk() {
    const q = this._songReq;
    const title = String(q.title || "").trim().replace(/\s+/g, " ");
    const artist = String(q.artist || "").trim().replace(/\s+/g, " ");
    if (this._busy) return;
    if (!title) {
      q.result = { ok: false, text: "Type a song title first." };
      this._focusNext = { id: "rl-song-title" };
      this._render();
      return;
    }
    this._busy = "request_song"; this._clearNotice();
    q.result = null;
    this._render();
    let r;
    try {
      r = await this._ws("parlorwave_radio/request_song", artist ? { title, artist } : { title });
    } catch (e) {
      r = { action: "none", message: this._humanRefusal(e).text };
    }
    this._busy = null;
    const said = this._songSay(r, title);
    this._songReq = said.ok ? { title: "", artist: "", result: said }
                            : Object.assign(q, { result: said });
    this._render();
  }

  /* --- Dial Stations -------------------------------------------------------
   * SETUP, NOT PLAYBACK. The saved stations, drawn as the tiles of the Dial
   * stage, and the sheet that creates or edits one. Pressing a tile only
   * SELECTS it: choosing a speaker and putting it on the air belong to the
   * on-air block, and nothing in this block can start music -- there is no
   * play call anywhere in it. Test Station runs the real station builder as
   * a dry run -- it reads the Music Assistant library and shows the opening
   * run of songs the station would play -- and changes nothing: no queue,
   * no speaker, no transport.
   *
   * A tile is lit only for the station on the air NOW, by its identity
   * (_dialOnAir), never because it was pressed: a selected tile wears a
   * white ring, never red. While a station is being edited every other
   * tile waits, so a stray press never throws an unsaved edit away.
   *
   * One preset is edited at a time. The label (what the Dial shows) and
   * the station term (what the builder reads) are separate fields on
   * purpose: renaming a station never changes its music, and retuning its
   * music never renames it. */

  async _fetchDial(force) {
    if (this._dial && this._dial.loading && !force) return;
    this._dial = Object.assign({}, this._dial, { loading: true });
    try {
      const data = await this._ws("parlorwave_radio/station_dial");
      this._dial = { at: Date.now(), data: data || {} };
    } catch (e) {
      this._dial = { at: Date.now(), data: null, error: true };
    }
    this._render();
  }

  _dialPresets() {
    const d = (this._dial && this._dial.data) || {};
    return Array.isArray(d.presets) ? d.presets : [];
  }

  _dialStartEdit(id) {
    const p = id ? this._dialPresets().find((x) => x.id === id) : null;
    this._dialEdit = p
      ? { id: p.id, label: p.label || "", query: p.query || "",
          kind: p.kind || "music", enabled: p.enabled !== false,
          last_test: p.last_test || null }
      : { id: null, label: "", query: "", kind: "music", enabled: true,
          last_test: null };
    this._dialTest = null;
    this._dialConfirm = null;
    this._render();
  }

  _dialSameTerm(a, b) {
    const n = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
    return n(a) === n(b);
  }

  /* Is this preset's last test an approval of what the station builder
   * programs NOW? "current" | "stale" | "none", as the BACKEND judged it
   * (test_states in the Dial read): stale means tested for another term or
   * by an older builder revision. Only a current test has a verdict. */
  _dialTestState(p) {
    const d = (this._dial && this._dial.data) || {};
    const st = p && d.test_states && d.test_states[p.id];
    if (st) return st;
    const lt = p && p.last_test;
    if (!lt) return "none";
    // A preset the backend has not judged yet (just saved): the same rule.
    const rev = d.builder_revision;
    return rev && (lt.builder_revision || 1) === rev && this._dialSameTerm(lt.query, p.query)
      ? "current" : "stale";
  }

  /* Is this preset -- as it is saved and approved NOW -- the station on
   * air? Never by id alone: a preset retuned (or re-approved on another
   * draw) since its station started is a different station, and the Dial
   * may switch to it. The backend names both sides in one form (term in
   * the builder's comparison form + approved draw); a backend without
   * identities falls back to the id and the term. */
  _dialOnAir(p) {
    const d = this._liveData();
    const st = d.station || {};
    if (!p || !d.active || st.preset_id !== p.id) return false;
    const ids = ((this._dial && this._dial.data) || {}).identities || {};
    if (st.identity && ids[p.id]) return st.identity === ids[p.id];
    return (!st.kind || !p.kind || st.kind === p.kind)
      && this._dialSameTerm(st.query, p.query || p.source);
  }

  /* Lit on the Dial: genuinely on the air by identity, from an answer that is
   * current. The one test every lit tile, chip and tile press uses. */
  _dialLit(p) {
    return this._liveKnown() && this._dialOnAir(p);
  }

  /* Could this saved station run live? true / false from its last test's
   * own verdict; for a record saved before tests carried one, the same
   * rule applied to its counts (the backend's numbers when it has sent
   * them); null when it has never been tested -- or when that test is out
   * of date, whose verdict is neither "thin" nor "fine". A thin station
   * must never look like a healthy one on the Dial. */
  _dialViable(p) {
    const lt = p && p.last_test;
    if (!lt || !lt.tracks) return null;
    if (this._dialTestState(p) !== "current") return null;
    if (typeof lt.viable === "boolean") return lt.viable;
    const rules = ((this._live && this._live.data) || {}).rules || {};
    return lt.tracks >= (rules.min_opening || 15)
      && lt.artists >= (rules.min_artists || 3);
  }

  async _dialRunTest(retry) {
    const ed = this._dialEdit;
    if (!ed || ed.kind !== "music" || !String(ed.query || "").trim()) return;
    const prev = this._dialTest;
    const variant = retry && prev && prev.result
      && this._dialSameTerm(prev.query, ed.query) ? (prev.variant || 0) + 1 : 0;
    this._dialTest = { running: true, query: ed.query, variant };
    this._busy = "dial_test"; this._render();
    try {
      const result = await this._ws("parlorwave_radio/station_preview", {
        intent: { origin: "station_tab", kind: "music",
                  label: ed.label || ed.query, query: ed.query },
        count: 25, variant });
      this._dialTest = { result, query: ed.query, variant };
    } catch (e) {
      this._dialTest = { error: String((e && e.message) || e),
                         query: ed.query, variant };
    } finally {
      this._busy = null; this._render();
    }
  }

  /* The list as the backend stores it: a preset without an id is new and
   * is given one there. Nothing but these fields is ever sent. */
  _dialWire(p) {
    const out = { label: p.label, kind: p.kind, enabled: p.enabled !== false };
    if (p.id) out.id = p.id;
    if (p.kind === "music") out.query = p.query; else out.source = p.source;
    if (p.last_test) out.last_test = p.last_test;
    return out;
  }

  async _dialSaveList(presets, okText) {
    this._busy = "dial_save"; this._clearNotice(); this._render();
    let saved = false;
    try {
      const data = await this._ws("parlorwave_radio/station_dial_save",
                                  { presets: presets.map((p) => this._dialWire(p)) });
      this._dial = { at: Date.now(), data: data || {} };
      this._setNotice(true, okText);
      saved = true;
    } catch (e) {
      this._refuse("Dial Stations were not saved: ", e);
    }
    this._busy = null;
    this._render();
    return saved;
  }

  async _dialSave() {
    const ed = this._dialEdit;
    if (!ed) return;
    const label = String(ed.label || "").trim();
    const query = String(ed.query || "").trim();
    if (!label || !query) {
      this._setNotice(false, "A Dial station needs a label and a station term.");
      this._render();
      return;
    }
    const t = this._dialTest;
    // Remember a NEW test only when it was of this exact term; a test of
    // something else is never recorded as this preset's. A retune without
    // a new test KEEPS the stored record: it names its own (old) term, so
    // the backend judges it stale -- "Needs retest" everywhere -- rather
    // than the preset reading as never tested.
    const tested = t && t.result && t.result.ok && t.result.last_test
      && this._dialSameTerm(t.query, query) ? t.result.last_test : null;
    const mine = { id: ed.id, label, kind: "music", query,
                   enabled: ed.enabled !== false,
                   last_test: tested || ed.last_test || null };
    const list = this._dialPresets().filter((p) => p.id !== ed.id);
    const at = ed.id ? this._dialPresets().findIndex((p) => p.id === ed.id) : -1;
    if (at >= 0) list.splice(at, 0, mine); else list.push(mine);
    // Saving the station that is on the air changes what the Dial holds,
    // not what is playing: the station keeps the term it was started with.
    const was = at >= 0 ? this._dialPresets()[at] : null;
    const lit = !!(was && this._dialLit(was));
    const said = !lit ? `Saved "${label}" to the Dial. Nothing is playing it yet.`
      : this._dialSameTerm(was.query, query) ? `Saved "${label}" to the Dial.`
      : `Saved "${label}" to the Dial. The station on the air keeps its old term until it is started again.`;
    if (await this._dialSaveList(list, said)) {
      this._dialEdit = null;
      this._dialTest = null;
      this._focusNext = ed.id ? { pick: ed.id } : { id: "dial-add" };
      this._render();
    }
  }

  async _dialRemove(id) {
    const keep = this._dialPresets().filter((p) => p.id !== id);
    this._dialConfirm = null;
    if (await this._dialSaveList(keep, "Removed from the Dial.")) {
      if (this._dialEdit && this._dialEdit.id === id) this._dialEdit = null;
      this._focusNext = { id: "dial-add" };
      this._render();
    }
  }

  _dialKindWord(kind) {
    return kind === "news" ? "All News" : "Music";
  }

  /* THE TILES: one per saved station and New station, each saying in one
   * caption what that station is now -- on the air (by identity), All News
   * (not in this release), too thin to go live, off the Dial, needing a
   * retest, tested, or never tested. */
  _renderDialStationsCard() {
    const d = this._dial;
    const data = (d && d.data) || {};
    const presets = this._dialPresets();
    const max = data.max_presets || 12;
    const ed = this._dialEdit;
    const picking = this._liveForm;
    const unread = !d || (d.loading && !d.data) || !!d.error;
    const held = this._busy === "dial_save" || this._busy === "dial_test"
      || this._busy === "live_start" || this._busy === "live_stop"
      || this._busy === "request_line" || !!this._stationBusy;
    const n = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
    const stale = "Needs retest: the station builder or term has changed since it was tested";
    const where = ((this._liveData().station || {}).target || {}).name || "";
    let note = "";
    if (!d || (d.loading && !d.data)) {
      note = `<div class="hint dial-note">Reading your Dial Stations…</div>`;
    } else if (d.error) {
      note = `<div class="hint dial-note">Your Dial Stations could not be read right
        now. Nothing has changed; try again in a moment.</div>`;
    } else if (!presets.length) {
      note = `<div class="hint dial-note">No Dial Stations yet. Add one, test it, and
        save it when it sounds right.</div>`;
    }
    const problem = data.problem
      ? `<div class="notice err dial-note">The saved Dial
          Stations could not be read, so none are shown. Saving here starts
          a fresh list; the unreadable settings are kept beside it.</div>`
      : "";
    const tiles = presets.map((p) => {
      const lt = p.last_test || {};
      // Lit only from an on-air answer that is current: a read that failed
      // -- even one that kept an older answer -- lights no tile.
      const lit = this._dialLit(p);
      // A handover station waiting behind kept songs is not on the air: its
      // tile is neither red nor lamped until its own songs play.
      const queuedTile = lit && !!this._liveWaiting((this._liveData() || {}).station);
      const viable = this._dialViable(p);
      const counts = typeof lt.tracks === "number"
        ? n(lt.tracks, "track") + (typeof lt.artists === "number" ? ` · ${n(lt.artists, "artist")}` : "")
        : "";
      const spoken = counts.replace(/ · /g, ", ");
      let caption;
      let say;
      let tone = "";
      let icon = "";
      let title = "";
      if (queuedTile) {
        caption = where ? `Queued · ${where}` : "Queued";
        say = where ? `queued on ${where}, after the songs already there` : "queued";
      } else if (lit) {
        caption = where ? `On air · ${where}` : "On air";
        say = where ? `on the air on ${where}` : "on the air";
        tone = " lit";
      } else if (p.kind !== "music") {
        caption = "Not in this release";
        say = "not in this release";
      } else if (viable === false) {
        caption = `Too thin to go live${counts ? ` · ${counts}` : ""}`;
        say = `too thin to go live${spoken ? `, ${spoken}` : ""}`;
        tone = " warn";
        icon = "warn";
      } else if (p.enabled === false) {
        caption = "Off the Dial";
        say = "off the Dial";
      } else if (this._dialTestState(p) === "stale") {
        caption = "Needs retest";
        say = stale;
        title = stale;
        tone = " warn";
        icon = "retest";
      } else if (viable) {
        caption = `Tested${counts ? ` · ${counts}` : ""}`;
        say = `tested${spoken ? `, ${spoken}` : ""}`;
        tone = " ok";
        icon = "check";
      } else {
        caption = "Not tested yet";
        say = "not tested yet";
      }
      const picked = ed ? ed.id === p.id : !!(picking && picking.preset_id === p.id);
      const waits = held || !!(ed && ed.id !== p.id);
      const term = p.kind === "music" ? (p.query || "") : this._dialKindWord(p.kind);
      const label = p.label || "Station";
      const cls = "preset" + (lit && !queuedTile ? " onair" : "") + (viable === false && !lit ? " weak" : "")
        + (p.enabled === false ? " off" : "") + (picked ? " picked" : "");
      return `
        <button class="${cls}" data-dial-pick="${this._esc(p.id)}"
                aria-label="${this._esc(`${label}, ${term && term !== label ? `${term}, ` : ""}${say}`)}"${title
                  ? ` title="${this._esc(title)}"` : ""}
                aria-expanded="${picked ? "true" : "false"}" ${waits ? "disabled" : ""}>
          ${lit && !queuedTile ? `<span class="preset-lamp" aria-hidden="true"></span>` : ""}
          <span class="preset-label">${this._esc(label)}</span>
          <span class="preset-term">${this._esc(term)}</span>
          <span class="preset-state${tone}">${icon ? this._stIcon(icon) : ""}${this._esc(caption)}</span>
        </button>`;
    }).join("");
    const creating = !!(ed && !ed.id);
    const full = presets.length >= max;
    const addWaits = creating ? held : (held || !!ed || unread || full);
    // A tile that waits says why, in words beside it: a disabled button
    // cannot be focused, so a title would never reach a keyboard.
    const others = presets.some((p) => !ed || ed.id !== p.id);
    const why = ed && others
      ? `<div class="hint dial-note">Save or close ${ed.id ? "this station" : "the new station"} to choose another.</div>`
      : !ed && !unread && full
        ? `<div class="hint dial-note">The Dial holds ${max} stations. Remove one to add another.</div>`
        : "";
    return `
      ${problem}${note}
      <div class="dial-tiles" role="group" aria-label="Dial Stations">${tiles}
        <button class="preset new${creating ? " picked" : ""}" id="dial-add"
                aria-label="New station" aria-expanded="${creating ? "true" : "false"}"
                ${addWaits ? "disabled" : ""}>${this._stIcon("plus")}<span>New station</span></button>
      </div>
      ${why}
      ${ed ? this._renderDialEditor() : ""}`;
  }

  /* THE SHEET that creates a station or edits one: its label and term, the
   * Dial switch, Test Station and its preview, Save -- and, for a saved
   * one, Remove, which asks first. Removing a station never stops one that
   * is on the air; the sheet's chip says when this one is. */
  _renderDialEditor() {
    const ed = this._dialEdit;
    const testing = this._busy === "dial_test";
    const saving = this._busy === "dial_save";
    const ready = String(ed.query || "").trim().length > 0;
    const saved = ed.id ? this._dialPresets().find((x) => x.id === ed.id) || null : null;
    const name = (saved && saved.label) || ed.label || "this station";
    const lit = !!(saved && this._dialLit(saved));
    const asking = !!(ed.id && this._dialConfirm === ed.id);
    const remove = !ed.id ? "" : asking
      ? `<span class="dial-remove-ask">
           <button class="ghost small" data-dial-remove="${this._esc(ed.id)}" ${testing || saving ? "disabled" : ""}
                   aria-label="Confirm removing ${this._esc(name)}">Remove it</button>
           <button class="ghost small" id="dial-remove-cancel" ${testing || saving ? "disabled" : ""}>Keep</button></span>`
      : `<button class="ghost small" data-dial-ask="${this._esc(ed.id)}" ${testing || saving ? "disabled" : ""}
                 aria-label="Remove ${this._esc(name)} from the Dial">Remove from the Dial</button>`;
    return `
      <div class="sheet dial-editor" role="group" tabindex="-1" data-focus="dial-sheet"
           aria-label="${ed.id ? "Edit Dial station" : "New Dial station"}">
        <div class="sheet-head">
          <div class="sheet-title">${ed.id ? this._esc(name) : "New station"}${lit
            ? ` <span class="sheet-chip lit"><span class="preset-lamp" aria-hidden="true"></span>On air</span>` : ""}</div>
          <button class="sheet-close" id="dial-cancel" ${testing || saving ? "disabled" : ""}
                  aria-label="Cancel" title="Cancel">${this._stIcon("close")}</button>
        </div>
        <div class="sheet-grid">
          <label class="dial-field"><span class="label">Dial label</span>
            <input type="text" id="dial-label" maxlength="40"
                   value="${this._esc(ed.label)}" placeholder="Saturday Rock"
                   aria-label="Dial label"></label>
          <label class="dial-field"><span class="label">Station term</span>
            <input type="text" id="dial-query" maxlength="120"
                   value="${this._esc(ed.query)}" placeholder="90s alternative rock"
                   aria-label="Station term">
            <span class="hint">An artist's name, a genre ("Metal"), an era
            ("70s"), or a genre in an era ("90s Rock"). The label is only its
            name on the Dial.</span></label>
          <label class="dial-field"><span class="label">Type</span>
            <select id="dial-kind" aria-label="Station type">
              <option value="music" selected>Music</option>
              <option value="news" disabled>All News — not in this release</option>
            </select></label>
          <label class="dial-check"><input type="checkbox" id="dial-enabled"
            ${ed.enabled !== false ? "checked" : ""}> Show on the Dial</label>
        </div>
        <div class="row dial-testrow">
          <button class="ghost" id="dial-test" ${testing || saving || !ready ? "disabled" : ""}
                  aria-label="Test Station">${testing ? "Building…" : "Test Station"}</button>
          <span class="hint">Test Station builds it from your Music Assistant library,
          the same way it would really be programmed, and shows you the songs.
          Nothing plays and nothing in the queue changes.</span>
        </div>
        ${this._renderDialPreview()}
        <div class="sheet-acts">
          <button class="ghost" id="dial-save" ${testing || saving ? "disabled" : ""}
                  aria-label="Save to Dial">${saving ? "Saving…" : "Save to Dial"}</button>
          <span class="spacer"></span>
          ${remove}
        </div>
      </div>`;
  }

  _dialHow(res) {
    const era = res.era && res.era.label ? res.era.label : "";
    if (res.strategy === "artist_radio") {
      return `An artist station: ${res.seed_artist} and the artists your
        library relates to them${era ? `, from the ${era}` : ""}.`;
    }
    if (res.strategy === "genre") {
      const g = (res.genres && res.genres[0] && res.genres[0].name) || "";
      return `A genre station: Music Assistant's ${g} genre${era ? `, ${era}` : ""}.`;
    }
    if (res.strategy === "era") return `An era station: everything from the ${era}.`;
    return "";
  }

  _renderDialPreview() {
    const t = this._dialTest;
    if (!t) return "";
    const head = `<div class="dial-preview-mark">Preview — not on air</div>`;
    if (t.running) {
      return `<div class="news-test dial-preview">${head}
        <div class="news-test-head">Building station…</div>
        <div class="news-test-body">The first build after a restart can take
        a little longer: an artist station first reads how every artist in
        the library is related. Later tests are quick.</div></div>`;
    }
    const foot = `<div class="news-test-foot">Nothing was played, and the
      queue and speakers were not touched.</div>`;
    if (t.error) {
      return `<div class="news-test bad dial-preview">${head}
        <div class="news-test-head">Could not run the test</div>
        <div class="news-test-body">${this._esc(t.error)}</div>${foot}</div>`;
    }
    const r = t.result || {};
    const res = r.resolution || {};
    // STALE IS UNMISSABLE: a banner at the top in the caution colour, and
    // the old list dimmed and struck through beneath it. Rendered always
    // and toggled by the term field itself (see the dial-query binding),
    // so it flips the moment the term is edited -- not at the next render.
    const isStale = !!(this._dialEdit
      && !this._dialSameTerm(t.query, this._dialEdit.query));
    const stale = `<div class="dial-stale-note" id="dial-stale-note" role="status"
        ${isStale ? "" : "hidden"}>Out of date: the station term has changed since
        this preview. This list is "${this._esc(t.query)}", not the new term.
        Test again to hear the new one.</div>`;
    const staleCls = isStale ? " dial-stale" : "";
    const notes = (res.notes || []).map((n) => `<li>${this._esc(n)}</li>`).join("");
    if (!r.ok) {
      const cands = (res.candidates || []).length
        ? `<div class="news-test-body">Did you mean: ${this._esc(res.candidates.join(", "))}?</div>` : "";
      return `<div class="news-test bad dial-preview${staleCls}" id="dial-preview">${head}
        ${stale}
        <div class="news-test-head">No station from "${this._esc(t.query)}"</div>
        <div class="news-test-body">${this._esc(r.message || "")}</div>
        ${cands}${foot}</div>`;
    }
    const s = r.summary || {};
    const warns = (res.warnings || []).concat(r.quality || [])
      .map((w) => `<li>${this._esc(w.message)}</li>`).join("");
    const mix = res.strategy === "artist_radio"
      ? `${s.seed_matches} by ${this._esc(res.seed_artist)} · ${s.related_matches} from related artists`
      : `${s.category_matches} matching tracks`;
    const roster = (res.roster || []).slice(0, 16)
      .map((a) => this._esc(a.artist)).join(", ");
    const rows = (r.tracks || []).map((x) => `<li>
        <span class="dial-t">${this._esc(x.artist)} — ${this._esc(x.title)}</span>
        <span class="dial-m">${this._esc([x.album, x.year].filter(Boolean).join(" · "))}${x.why ? ` · ${this._esc(x.why)}` : ""}</span>
      </li>`).join("");
    const n = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
    // The live verdict: the same minimum-viable rule a start enforces, so a
    // thin station is called thin here, before anyone saves it.
    const live = r.live || null;
    const verdict = !live ? "" : live.viable
      ? `<div class="dial-live ok">Passes the live-station rules.</div>`
      : `<div class="dial-live weak"><strong>Too thin to go live.</strong>
         ${(live.reasons || []).map((x) => this._esc(x.message)).join(" ")}</div>`;
    const weak = !!(live && !live.viable);
    // Green only for a station the library supports well; any warning
    // (short, one artist, a folded genre, too thin to go live) wears the
    // caution edge.
    return `<div class="news-test ${warns || weak ? "bad" : "good"} dial-preview${staleCls}" id="dial-preview">${head}
      ${stale}
      <div class="news-test-head">${n(s.total_tracks, "track")} · ${n(s.unique_artists, "artist")}</div>
      <div class="news-test-body">${this._esc(this._dialHow(res))}
        ${mix}${s.duplicates_rejected ? ` · ${s.duplicates_rejected} duplicate recordings set aside` : ""}.</div>
      ${warns ? `<ul class="dial-warn">${warns}</ul>` : ""}
      ${verdict}
      <ol class="dial-tracks">${rows}</ol>
      <details class="dial-how"><summary>How this station was built</summary>
        <ul>${notes}</ul>
        ${roster ? `<div class="news-test-detail">Artists it draws on: ${roster}</div>` : ""}
      </details>
      <div class="row tight">
        <button class="ghost small" id="dial-retry" ${this._busy || isStale ? "disabled" : ""}
                aria-label="Try again">Try again</button>
      </div>
      <div class="hint">Try again builds another opening run of the same
      station. Each run is a fresh draw from the same rules.</div>
      ${foot}</div>`;
  }

  /* HEALTH & DIAGNOSTICS. The support disclosure, closed by default and
   * empty of anything a person needs on an ordinary day. What is actually
   * WRONG has already been said, twice, in their own words: once in the
   * verdict at the top of this screen and once in the To fix card. This is
   * what somebody helping them would ask for -- which installation, which
   * version, what can be reached -- plus the service's own problem codes
   * so a report can name them.
   *
   * It is a disclosure, not a hiding place: everything here is safe to
   * screenshot. No token, no API key, no filesystem path and no internal
   * address reaches it, because the document this renders never carries
   * one. The Music Assistant server is the single deliberate exception.
   *
   * A quiet foot toggle under the screen. Opened, it also holds
   * the Music Assistant and Speech details -- facts somebody helping asks
   * for, which an ordinary day never needs in the open. */
  _renderDiagnostics() {
    const r = this._readiness();
    const d = (r || {}).diagnostics || {};
    const rows = (d.rows || []).slice();
    const problems = d.problems || [];
    // The entity ids, still here and still only here: an installer writing
    // an automation needs them, and the Booth is not where you look. Read
    // from the same registry map every screen uses, so what is printed is
    // what the automation must name -- whatever the device is called now.
    for (const key of ["dj_enabled", "output", "personality", "voice",
                       "station_feel"]) {
      const e = this._ent(key);
      if (e) rows.push([`entity: ${e.attributes.friendly_name || key}`, e.entity_id]);
    }
    const severityWord = { blocker: "Blocking", warning: "Warning" };
    return `
      <div class="support-foot">
        <button class="ghost small support-btn"
                id="settings-advanced" aria-expanded="${this._readyAdvanced}">
          ${this._readyAdvanced ? "Hide support details" : "Support details"}</button>
      </div>
      ${this._readyAdvanced ? `
        <section class="card secondary support" aria-label="Support details">
          <div class="hint">For a bug report. Nothing here needs to mean
          anything to you, and all of it is safe to share — no tokens, no keys
          and no file locations are ever shown.</div>
          ${r ? this._renderMusicAssistant(r) : ""}
          ${r ? this._renderSpeech(r) : ""}
          <div class="support-diag">
            <h2>Health &amp; diagnostics</h2>
            <table>${rows.map(([k, v]) =>
              `<tr><td>${this._esc(k)}</td><td>${this._esc(v)}</td></tr>`).join("")}</table>
            ${problems.length ? `
              <div class="qhead">Reported by the service</div>
              <table>${problems.map((pr) => `
                <tr><td><span class="badge ${pr.severity === "blocker" ? "error" : "warning"}">
                  ${this._esc(severityWord[pr.severity] || pr.severity)}</span>
                  <span class="code">${this._esc(pr.code)}</span></td>
                <td>${this._esc(pr.title)}</td></tr>`).join("")}</table>` : ""}
          </div>
        </section>${this._renderBroadcastDiag()}` : ""}`;
  }

  /* --- Broadcast Diagnostics ---------------------------------------------
   * Why each DJ opportunity aired as the DJ wrote it, aired as the
   * station's own line, or did not air -- from what the station RECORDED
   * and nothing else. The data is the backend's own projection, through
   * two administrator websocket commands. Rows are compact; a
   * row's whole record (the draft, the copy rendered for air, the
   * pipeline, the obligations) is read when it is opened.
   *
   * THE RULES THIS CARD KEEPS. null is UNKNOWN or NOT RECORDED and is never
   * drawn as a negative: a break whose row has been retired is not a break
   * that did not air. An offending span is shown only where the refusing
   * check recorded one, and is never searched for in the draft. Every word
   * from a record is escaped. The list never claims to be the whole
   * history: one read covers the newest few megabytes of the record. */
  _renderBroadcastDiag() {
    const open = `<section class="card secondary diag" aria-label="Broadcast diagnostics">`;
    if (!this._diagAllowed()) {
      return `${open}<h2>Broadcast diagnostics</h2>
        <div class="hint">For Home Assistant administrators: it keeps the drafts the
        station refused, which the Air Check never shows.</div></section>`;
    }
    const d = this._diag || {};
    const f = this._diagFilter;
    const head = `<div class="diag-head"><h2>Broadcast diagnostics</h2><span class="spacer"></span>
        <button class="ghost tiny-btn" id="diag-refresh" ${d.loading ? "disabled" : ""}>Refresh</button></div>
      <div class="hint">Why each DJ break aired as the DJ wrote it, aired as the station's own
      line, or did not air: what the station recorded, and nothing else. Read-only.</div>`;
    if (d.unsupported) {
      return `${open}${head}<div class="diag-note">This version of the ParlorWave service does not
        provide broadcast diagnostics.</div></section>`;
    }
    return `${open}${head}
      ${this._renderDiagWindow(d.scan)}
      ${this._diagLinked ? this._renderDiagLinked(this._diagLinked) : ""}
      ${this._renderDiagFilters(f)}
      ${!f.outcome && !f.reason && d.items && d.items.length ? this._renderDiagSummary(d) : ""}
      <div class="diag-list">${(d.items || []).map((it) => this._renderDiagRow(it)).join("")}</div>
      ${this._renderDiagFoot(d)}
    </section>`;
  }

  /* NOT THE WHOLE HISTORY, said where the list starts: how far one read
   * reaches, and why an old break's delivery can only be UNKNOWN. */
  _renderDiagWindow(scan) {
    const s = scan || {};
    const bytes = s.budget_bytes || 8 * 1048576;
    const size = bytes >= 1048576 ? `${Math.round(bytes / 1048576)} MiB` : `${Math.round(bytes / 1024)} KiB`;
    const when = s.oldest_at ? this._esc(this._diagWhen(s.oldest_at)) : null;
    const reach = s.budget_exhausted && when
      ? ` This read stopped at its limit at ${when}: older history exists and was not read.`
      : s.complete && when ? ` This read reached the oldest record the station holds (${when}).` : "";
    return `<div class="diag-window" role="note"><b>Not the whole history.</b> Each read covers at
      most the newest ${size} of the break record${bytes === 8 * 1048576 ? " (about five days)" : ""}, and a break's own row
      (its revoke reason and coverage) is kept only for a day or less: past that, what only the
      row knew shows as UNKNOWN.${reach}</div>`;
  }

  _renderDiagFilters(f) {
    const pill = (attr, value, label, on, title) => `<button class="diag-pill${on ? " on" : ""}"
      data-${attr}="${this._esc(value)}" data-focus="${attr}-${this._esc(value || "all")}"
      aria-pressed="${on}"${title ? ` title="${this._esc(title)}"` : ""}>${this._esc(label)}</button>`;
    return `<div class="diag-filters" role="toolbar" aria-label="Filter the opportunities">
      <div class="diag-pills">${DIAG_OUTCOMES.map(([v, l]) => pill("diag-outcome", v, l, f.outcome === v,
        v === "no_break_aired" ? "Only breaks with a recorded reason they did not reach the room. UNKNOWN is not included." : "")).join("")}</div>
      <div class="diag-pills">${DIAG_KINDS.map(([v, l]) => pill("diag-kind", v, l, f.kind === v)).join("")}
        ${f.reason ? `<span class="diag-reason-tag">Reason <code>${this._esc(f.reason)}</code>
          <button class="ghost tiny" id="diag-reason-clear" aria-label="Clear the reason filter">×</button></span>` : ""}</div>
    </div>`;
  }

  /* What the loaded rows say together -- and only them: the count is of
   * this page and those above it, never of the station's history. */
  _renderDiagSummary(d) {
    const count = {}, reasons = {};
    for (const it of d.items) {
      count[it.outcome] = (count[it.outcome] || 0) + 1;
      const code = (it.rejection || {}).reason_code;
      if (code) reasons[code] = (reasons[code] || 0) + 1;
    }
    const floor = d.items.filter((i) => i.writer_outcome === "floor").length;
    const written = floor + d.items.filter((i) => i.writer_outcome === "accepted").length;
    const top = Object.entries(reasons).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return `<div class="diag-summary">
      <div class="diag-kicker">The ${d.items.length} loaded${d.next ? ", with older ones below" : ""}</div>
      ${written ? `<div class="diag-stat"><span class="diag-big">${Math.round(100 * floor / written)}%</span>
        <span>of the ${written} breaks a writer produced copy for used the station floor (${floor}).</span></div>` : ""}
      <div class="diag-counts">${Object.keys(count).map((o) => {
        const [label, tone] = DIAG_BADGE[o] || [o, "unknown"];
        return `<span class="diag-count tone-${tone}">${this._esc(label)} <b>${count[o]}</b></span>`; }).join("")}</div>
      ${top.length ? `<div class="diag-reasons">${top.map(([code, n]) => `<button class="diag-reason"
        data-diag-reason="${this._esc(code)}" data-focus="diag-reason-${this._esc(code)}"
        title="Show only this reason">${this._esc(code)} <b>×${n}</b></button>`).join("")}</div>` : ""}
    </div>`;
  }

  _diagTone(it) { return (DIAG_BADGE[it.outcome] || [null, "unknown"])[1]; }

  _diagWhen(at) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T/.exec(String(at || ""));
    if (!m) return at ? String(at) : "UNKNOWN";
    const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+m[2] - 1];
    return `${mon} ${+m[3]} · ${this._localTime(at)}`;
  }

  _renderDiagRow(it) {
    const id = it.opportunity_id;
    const open = this._diagOpen.has(id);
    return `<div class="diag-opp tone-${this._diagTone(it)}${this._diagLinked === id ? " linked" : ""}">
      <button class="diag-opp-sum" data-diag-row="${this._esc(id)}" data-focus="diag-row-${this._esc(id)}"
              aria-expanded="${open}">${this._renderDiagLine(it)}</button>
      ${open ? this._renderDiagBody(id) : ""}
    </div>`;
  }

  /* One opportunity in two lines: when, which, whether it aired, what was
   * owed, the verdict; then the songs either side and the recorded reason. */
  _renderDiagLine(it) {
    const [label, tone] = DIAG_BADGE[it.outcome] || [it.outcome || "Unknown", "unknown"];
    const r = it.rejection || {};
    const t = it.tracks || {};
    const track = (name) => (name ? `<span class="diag-track">${this._esc(name)}</span>`
      : `<span class="diag-unknown">UNKNOWN</span>`);
    const stage = r.validation_stage ? (DIAG_STAGES[r.validation_stage] || r.validation_stage) : null;
    const id = String(it.opportunity_id || "");
    return `<span class="diag-line">
        <span class="diag-time">${this._esc(this._diagWhen(it.at))}</span>
        <span class="diag-id" title="Opportunity ${this._esc(id)}">#${this._esc(id.slice(0, 8))}</span>
        ${it.kind && it.kind !== "dj_break" ? `<span class="diag-id">${this._esc((HISTORY_TYPE[it.kind] || [null, it.kind])[1])}</span>` : ""}
        ${this._renderDiagAired(it)}
        <span class="spacer"></span>
        ${this._renderDiagPills(it)}
        <span class="diag-badge tone-${tone}">${this._esc(label)}</span>
      </span>
      <span class="diag-line">
        <span class="diag-tracks">${track(t.ending)}<span class="diag-arrow" aria-label="then">→</span>${track(t.next)}</span>
        ${r.reason_code || stage ? `<span class="diag-why">${stage ? `<span class="diag-stage">${this._esc(stage)}</span>` : ""}
          ${r.reason_code ? `<code>${this._esc(r.reason_code)}</code>` : ""}
          ${r.headline && r.headline !== r.reason_code ? `<span>${this._esc(r.headline)}</span>` : ""}</span>` : ""}
      </span>`;
  }

  /* aired_to_room is true, false or null, and null is its own answer. */
  _renderDiagAired(it) {
    const state = (it.delivery || {}).state;
    if (it.aired_to_room === true) {
      return `<span class="diag-aired ok">${state === "cut" ? "Aired · cut short" : "Aired"}</span>`;
    }
    if (it.aired_to_room === false) return `<span class="diag-aired no">Not aired</span>`;
    if (state === "pending") {
      return `<span class="diag-aired wait" title="Its break row is still live: planned, being prepared, queued or on air. Not yet a finding either way.">In progress</span>`;
    }
    return `<span class="diag-aired unknown" title="No record of whether it reached the room survives. That is not a finding that it did not air.">Airing UNKNOWN</span>`;
  }

  _renderDiagPills(it) {
    if (it.obligations_evaluated === false) return `<span class="diag-ob muted">Obligations not evaluated</span>`;
    const items = (it.obligations || {}).items || [];
    if (it.obligations_evaluated == null || !items.length || items.every((i) => i.due == null)) {
      return `<span class="diag-ob unknown">Obligations UNKNOWN</span>`;
    }
    return items.filter((i) => i.due === true).map((i) => {
      const [short, long] = DIAG_OBLIGATIONS[i.key] || [i.key, i.key];
      const [word, tone] = i.delivered == null ? ["UNKNOWN", "unknown"]
        : (DIAG_DELIVERED[i.delivered] || [i.delivered, "unknown"]);
      const mark = { confirmed: "✓", not_delivered: "✕", cut: "cut",
                     aired_coverage_not_recorded: "in copy" }[i.delivered] || word;
      return `<span class="diag-ob ${tone}" title="${this._esc(long)}: ${this._esc(word)}">${this._esc(short)} ${this._esc(mark)}</span>`;
    }).join("");
  }

  _renderDiagBody(id) {
    const d = this._diagDetail[id];
    if (!d || d.loading) return `<div class="diag-body"><div class="hint">Reading what the station recorded…</div></div>`;
    if (d.ok === false) {
      return `<div class="diag-body"><div class="diag-note">${d.reason === "not_found"
        ? `<b>No record of #${this._esc(id.slice(0, 8))} in the history read.</b> One read covers about
           the last five days of the break record; this break's records may be older, or were never
           written. That is not evidence that it did not air.`
        : "The station did not answer for this break just now. Refresh to try again."}</div></div>`;
    }
    return `<div class="diag-body">
      ${this._renderDiagVerdict(d)}
      <div class="diag-scripts">${this._renderDiagDraft(d)}${this._renderDiagCopy(d)}</div>
      ${this._renderDiagPipeline(d)}
      ${this._renderDiagObligations(d)}
      ${this._renderDiagEvidence(d)}
    </div>`;
  }

  _renderDiagVerdict(d) {
    const r = d.rejection || {};
    const state = (d.delivery || {}).state;
    const stage = r.validation_stage ? (DIAG_STAGES[r.validation_stage] || r.validation_stage) : null;
    let title = r.headline;
    if (!title && (d.outcome === "accepted" || d.outcome === "program")) {
      title = state === "completed" ? "Nothing refused it, and it completed on air"
        : state === "pending" ? "Nothing refused it; it has not finished yet (its row is still live)"
        : "Nothing refused it; whether it reached the room was not recorded";
    }
    const kv = (k, v) => `<div class="diag-kv"><span class="k">${k}</span> ${v}</div>`;
    const span = DIAG_SPAN_STAGES.includes(r.validation_stage)
      ? kv("Offending words", r.offending_span
        ? `<code class="diag-flag">${this._esc(r.offending_span)}</code>
           <span class="diag-dim">recorded in ${this._esc(r.offending_span_source || "the refusing check")}</span>`
        : `<span class="diag-unknown">NOT RECORDED</span>
           <span class="diag-dim">${this._esc(r.offending_span_source || "no span was recorded")}; never guessed from the draft</span>`)
      : "";
    const unmet = (d.obligations || {}).unmet_in_draft;
    return `<div class="diag-verdict tone-${this._diagTone(d)}">
      <div class="diag-kicker">Verdict</div>
      <div class="diag-verdict-title">${this._esc(title || "No reason was recorded")}</div>
      <div class="diag-codes">
        ${stage ? `<span class="diag-code">Stage <b>${this._esc(stage)}</b></span>` : ""}
        ${r.reason_code ? `<span class="diag-code">Reason <b>${this._esc(r.reason_code)}</b></span>` : ""}
        ${r.guard_category ? `<span class="diag-code">Guard <b>${this._esc(r.guard_category)}</b></span>` : ""}
      </div>
      ${r.reason_source ? kv("Recorded in", `<code>${this._esc(r.reason_source)}</code>`) : ""}
      ${span}
      ${r.fact_ref ? kv("Fact", `<code>${this._esc(r.fact_ref.fact_id)}</code>${r.fact_ref.predicate
        ? ` <code>${this._esc(r.fact_ref.predicate)}</code>` : ""}`) : ""}
      ${Array.isArray(unmet) && unmet.length ? kv("Owed but missing from the draft", `<code>${this._esc(unmet.join(", "))}</code>`) : ""}
      ${r.fallback_action ? kv("The station's answer", `<code>${this._esc(r.fallback_action)}</code>`) : ""}
    </div>`;
  }

  /* The recorded span, marked where it occurs VERBATIM in the draft; a span
   * the clipped draft does not contain marks nothing. */
  _diagMark(draft, span) {
    const at = span ? draft.indexOf(span) : -1;
    if (at < 0) return this._esc(draft);
    return `${this._esc(draft.slice(0, at))}<mark class="diag-mark">${this._esc(span)}</mark>${this._esc(draft.slice(at + span.length))}`;
  }

  _renderDiagDraft(d) {
    const s = d.smart_dj || {};
    const chips = [s.attempted_kind ? `kind ${s.attempted_kind}` : null,
      typeof s.attempts === "number" ? `${s.attempts} planner decision${s.attempts === 1 ? "" : "s"}` : null,
      s.retry ? "retried" : null,
      typeof s.draft_word_count === "number" ? `${s.draft_word_count} words` : null].filter(Boolean);
    const body = s.raw_draft
      ? `<blockquote class="said diag-said">${this._diagMark(s.raw_draft, (d.rejection || {}).offending_span)}</blockquote>`
      : `<div class="diag-empty">${this._esc(s.attempted === false ? "No draft: this is not a break the planner writes."
        : s.attempted == null ? "UNKNOWN: no planner decision for this break is in the history read."
        : d.writer_outcome === "silent" ? "No draft: the model chose silence."
        : "No draft was recorded.")}</div>`;
    const lists = [["Cited facts", s.fact_ids_cited], ["Unknown fact ids", s.unknown_fact_ids],
                   ["Moment refs", s.moment_refs]].filter(([, v]) => Array.isArray(v) && v.length)
      .map(([k, v]) => `<div class="diag-foot"><span class="diag-dim">${k}</span>
        ${v.map((x) => `<code>${this._esc(x)}</code>`).join(" ")}</div>`).join("");
    const all = Array.isArray(s.decisions) && s.decisions.length > 1
      ? `<div class="diag-foot"><span class="diag-dim">Every decision</span>${s.decisions.map((x) =>
        `<span class="diag-decision">${this._esc(this._diagWhen(x.at))} · ${this._esc(x.action || "UNKNOWN")}${
          x.reason ? ` <code>${this._esc(x.reason)}</code>` : ""}${
          x.offending_span ? ` <code class="diag-flag">${this._esc(x.offending_span)}</code>` : ""}</span>`).join("")}</div>`
      : "";
    return `<div class="diag-script"><div class="diag-script-head">
        <span class="diag-script-title">Original Smart DJ draft</span>
        ${chips.map((c) => `<span class="diag-chip">${this._esc(c)}</span>`).join("")}</div>
      ${body}
      ${s.raw_draft && s.raw_draft.length === 600 ? `<div class="diag-foot diag-dim">600 characters, the most a recorded draft keeps: it may have been cut.</div>` : ""}
      ${lists}${all}</div>`;
  }

  _renderDiagCopy(d) {
    const c = d.aired_copy || {};
    const dl = d.delivery || {};
    const added = c.service_completion_added || [];
    const chips = [c.writer_mode ? (DIAG_WRITERS[c.writer_mode] || c.writer_mode) : null,
      c.template_id ? `template ${c.template_id}` : null,
      typeof c.word_count === "number" ? `${c.word_count} words` : null,
      c.service_completion === "station_tail" ? `station tail${added.length ? `: ${added.join(", ")}` : ""}` : null
    ].filter(Boolean);
    const body = c.final_text
      ? `<blockquote class="said diag-said${dl.state === "cut" ? " cut" : ""}">${this._esc(c.final_text)}</blockquote>`
      : `<div class="diag-empty">${this._esc(d.outcome === "rejected" ? "Nothing was rendered: the planner stayed silent."
        : (d.rejection || {}).validation_stage === "pre_planner_gate" ? "Nothing was written: the opportunity was suppressed first."
        : "UNKNOWN: no rendered copy for this break is in the history read.")}</div>`;
    return `<div class="diag-script"><div class="diag-script-head">
        <span class="diag-script-title">Copy rendered for air</span>
        ${chips.map((x) => `<span class="diag-chip">${this._esc(x)}</span>`).join("")}</div>
      ${body}
      <div class="diag-foot"><span class="diag-dim">Delivery</span>
        ${dl.state ? `<b>${this._esc(DIAG_DELIVERY[dl.state] || dl.state)}</b>` : `<span class="diag-unknown">UNKNOWN</span>`}
        ${dl.reason ? `<code>${this._esc(dl.reason)}</code>` : ""}
        ${dl.coverage ? `<span class="diag-dim">coverage ${this._esc(dl.coverage)}</span>` : ""}
        ${dl.source ? `<span class="diag-dim">from ${this._esc(dl.source)}</span>` : ""}</div>
      ${c.final_text ? `<div class="diag-foot diag-dim">Recorded when it was rendered: the delivery line says whether it aired.</div>` : ""}
    </div>`;
  }

  /* The four stages, each only as far as it left a record. */
  _renderDiagPipeline(d) {
    const p = d.pipeline || {};
    const step = (n, label, state, detail) => `<div class="diag-step">
      <div class="diag-step-head"><span class="diag-dim">${n} · ${label}</span>
        ${state ? `<span class="diag-state">${this._esc(state)}</span>` : `<span class="diag-unknown">NOT RECORDED</span>`}</div>
      <div class="diag-step-detail">${this._esc(detail || (state ? "No further detail was recorded."
        : "No record of this stage in the history read."))}</div></div>`;
    return `<div class="diag-sub">Writer → render → insert → completion</div>
      <div class="diag-steps">${step(1, "Writer", p.writer_state, p.writer_detail)}${
        step(2, "Render", p.render_state, p.render_detail)}${
        step(3, "Queue insert", p.insert_state, p.insert_detail)}${
        step(4, "Completion", p.completion_state, p.completion_detail)}</div>`;
  }

  _renderDiagObligations(d) {
    const o = d.obligations || {};
    const cell = (word, tone) => `<span class="diag-cell ${tone}">${this._esc(word)}</span>`;
    const unknown = cell("UNKNOWN", "unknown");
    const yn = (v) => (v === true ? cell("yes", "ok") : v === false ? cell("no", "danger") : unknown);
    const context = (i) => {
      const c = i.context;
      if (!c) return "";
      const bits = i.key === "weather"
        ? [c.condition, c.temperature != null ? `${c.temperature}°` : null, c.status,
           c.observation_age_minutes != null ? `${c.observation_age_minutes} min old` : null]
        : [c.event_id ? `event ${c.event_id}` : null, c.timing_band,
           c.minutes_until != null ? `in ${c.minutes_until} min` : null, c.status];
      return bits.filter((x) => x != null && x !== "").join(" · ");
    };
    const shape = d.obligations_evaluated === false ? "not evaluated for a suppressed opportunity"
      : o.record_shape ? (DIAG_SHAPES[o.record_shape] || o.record_shape) : "record shape UNKNOWN";
    return `<div class="diag-sub">Owed hosting, judged against what aired <span class="diag-dim">${this._esc(shape)}</span></div>
      <div class="diag-table-wrap"><table class="diag-table">
        <thead><tr><th>Obligation</th><th>Context</th><th>Due</th><th>In the draft</th>
          <th>In the aired copy</th><th>Delivered</th><th>Evidence</th></tr></thead>
        <tbody>${(o.items || []).map((i) => `<tr>
          <td>${this._esc((DIAG_OBLIGATIONS[i.key] || [i.key, i.key])[1])}</td>
          <td data-label="Context">${this._esc(context(i))}</td>
          <td data-label="Due">${i.due === true ? cell("due", "ok") : i.due === false ? cell("not due", "muted") : unknown}</td>
          <td data-label="In the draft">${i.due === false ? "" : yn(i.in_draft)}</td>
          <td data-label="In the aired copy">${i.due === false ? "" : yn(i.in_aired)}</td>
          <td data-label="Delivered">${i.delivered == null ? unknown : cell(...(DIAG_DELIVERED[i.delivered] || [i.delivered, "unknown"]))}</td>
          <td class="diag-dim" data-label="Evidence">${this._esc(i.note || "")}</td></tr>`).join("")}</tbody></table></div>
      <div class="hint">Confirmed: recorded as delivered (the break completed whole with it in the words,
      or the station's own delivery list names it). In aired copy: the words held it and the break
      completed, but how much of it played was not recorded.</div>`;
  }

  _renderDiagEvidence(d) {
    const e = d.evidence || {};
    const code = (v) => `<code>${this._esc(v)}</code>`;
    return `<div class="diag-evidence">${[
      `opportunity ${code(d.opportunity_id)}`,
      d.boundary ? `boundary ${code(d.boundary)}` : null, d.queue_id ? `queue ${code(d.queue_id)}` : null,
      `records ${(e.records || []).map(code).join(" ") || "none"}`,
      e.break_row === "present" ? "its break row is still held" : "no break row is held for it",
      (e.redactions || []).includes("calendar_title") ? "a calendar title was masked" : null,
    ].filter(Boolean).join(" · ")}</div>`;
  }

  _renderDiagLinked(id) {
    const d = this._diagDetail[id];
    const ok = d && !d.loading && d.ok !== false;
    return `<div class="diag-opp diag-linked tone-${ok ? this._diagTone(d) : "unknown"}" id="diag-linked"
         tabindex="-1" aria-label="Opportunity #${this._esc(id.slice(0, 8))}, opened from On Air">
      <div class="diag-linked-head"><span class="diag-kicker">Opened from On Air</span><span class="spacer"></span>
        <button class="ghost tiny-btn" id="diag-linked-close">Close</button></div>
      ${ok ? `<div class="diag-opp-sum static">${this._renderDiagLine(d)}</div>` : ""}
      ${this._renderDiagBody(id)}
    </div>`;
  }

  _renderDiagFoot(d) {
    if (d.loading) return `<div class="hint">Reading the break record…</div>`;
    if (d.error) {
      return `<div class="diag-note">The diagnostics could not be read just now.
        <button class="ghost tiny-btn" id="diag-retry">Try again</button></div>`;
    }
    if (!d.items) return "";
    const f = this._diagFilter;
    if (!d.items.length) {
      return `<div class="hint">Nothing in the history read matches${f.outcome || f.reason ? " these filters" : ""}.</div>`;
    }
    if (d.next) return `<div class="diag-more"><button class="ghost small" id="diag-more">Load older</button></div>`;
    return `<div class="hint">${(d.scan || {}).complete ? "That is everything the station still holds."
      : "Older history exists beyond what one read covers."}</div>`;
  }

  /* --- Settings ----------------------------------------------------------
   * "Is Parlorwave Radio ready to work, what is connected, and where do I
   * change it." Nothing else. This screen owns no personality, no voice,
   * no bulletin, no programming and no playback -- every one of those has
   * a screen of its own, and Settings links to them rather than growing a
   * second copy of their controls that could disagree.
   *
   * NOTHING HERE IS DIAGNOSED IN THE BROWSER. The whole screen renders one
   * document built by the integration (readiness.py) from the backend's
   * own health contract plus what Home Assistant knows about itself. That
   * is why no problem code, no environment variable and no service URL
   * appears anywhere in this file: the panel is handed sentences, and a
   * token or a filesystem path cannot reach a screen it was never sent.
   *
   * FIRST RUN IS THE DESIGNED STATE, not the leftover one. A brand-new
   * Home Assistant OS install with Music Assistant, no catalog, no voice
   * engine, no writing model and no news feed sees the verdict and its
   * four setup steps, each done or carrying its one next action.
   *
   * ONE VERDICT, THEN THE EVERYDAY SCREEN, IN EVERY STATE. How
   * the verdict and the steps are drawn depends on _readyMode: a ready
   * installation folds the steps into the Ready strip at once; one whose
   * setup is not complete -- new or established, it cannot be told apart
   * -- shows the verdict, the four steps and every step that is not done
   * opened with its own fix (the speaker list appears INSIDE the speaker
   * step). The everyday controls are drawn whatever the verdict, so no
   * number of failing prerequisites can take a working control away.
   * What is wrong and nobody's step ("To fix", "Worth a look") is said in
   * every mode, because the banner other screens show is not drawn here.
   * Extras -- every optional service and capability -- stays reachable in
   * every mode, closed until opened. */
  _renderSettings() {
    const r = this._readiness();
    this._readyStaleShown = this._readyStale();
    // a record opened from On Air does not wait for the installation's answer
    if (!r || this._readyStaleShown) {
      return this._renderSettingsWaiting() + (this._diagLinked ? this._renderBroadcastDiag() : "");
    }
    return `
      ${this._renderReadyHero(r)}
      ${this._renderSetupChecklist(r)}
      ${this._renderIssues(r)}
      ${this._renderSources(r)}
      ${this._renderFaceplateSetting()}
      ${this._renderExtras(r)}
      ${this._renderDiagnostics()}`;
  }

  /* The station's name, edited in its own sheet under the plate on the
   * Station screen -- never on the brass itself. The same controls and the
   * same save path as ever; Done closes the sheet, and a half-typed
   * name does not outlive it. */
  _renderStationIdentityCard() {
    const draft = this._stationDraft != null ? this._stationDraft : this._stationIdentityName();
    const busy = this._busy === "station_name";
    return `
      <div class="sheet name-sheet" role="group" aria-label="Station identity">
        <div class="sheet-head">
          <div class="sheet-title">Station name</div>
          <button class="ghost small" id="station-name-done" ${busy ? "disabled" : ""}>Done</button>
        </div>
        <div class="row">
          <input type="text" id="station-name-input" maxlength="60"
                 placeholder="ParlorWave Radio"
                 value="${this._esc(draft)}"
                 aria-label="Station name">
          <button class="ghost" id="station-name-save" ${(!this._stationDirty && !this._stationError) || busy ? "disabled" : ""} aria-label="Save station name">
            ${busy ? "Saving…" : "Save"}
          </button>
          <button class="ghost small" id="station-name-reset" ${!this._stationDirty || busy ? "disabled" : ""} aria-label="Reset station name">Reset</button>
        </div>
        ${this._stationError ? `<div class="notice err">${this._esc(this._stationError)}</div>` : ""}
        <div class="hint">The name the DJ says in station IDs, time checks and news intros.</div>
      </div>`;
  }

  /* --- Announcements (Station tab) ---------------------------------------
   * Calendar entries that BEGIN with ANNOUNCE (or ANNOUNCE EXACT) are
   * station programming: aired once, at a safe song change, at their
   * scheduled time. On Station they are one row of the Programming card:
   * the switch and a one-line summary on the row, a held state said on the
   * row where it cannot be missed, and everything else behind Options. The
   * entries themselves are created in the person's own calendar app, and
   * this screen deliberately does not grow a calendar editor. */

  _announceWhen(start) {
    if (!start) return "";
    if (!/[T ]/.test(start)) return start;          // date-only: as written
    const d = new Date(start);
    if (isNaN(d)) return start;
    return d.toLocaleString([], { weekday: "short", month: "short",
                                  day: "numeric", hour: "numeric",
                                  minute: "2-digit" });
  }

  /* Lifecycle, in the operator's words -- never internal state names. */
  _announceStatus(o) {
    const inv = {
      empty_payload: "Nothing to say — add text after ANNOUNCE",
      payload_too_long: "Too long to air (500 characters max)",
      all_day_unsupported: "Needs a start time — all-day events don't air",
    };
    if (o.state === "invalid") return inv[o.invalid_reason] || "Can't air";
    if (o.state === "scheduled") return "Scheduled";
    if (o.state === "spent") return "Aired";
    // Handed to the player, but its airing was never seen (a short line can
    // play between two checks): never replayed, never claimed as silence.
    if (o.state === "expired" && o.expire_reason === "unconfirmed_after_insert") {
      return "Sent to air, playback not confirmed";
    }
    if (o.state === "expired") return "Expired unaired";
    if (o.state === "committed:ready") return "Waiting for a song change";
    if (o.state === "committed:queued") return "Queued to air";
    if (o.state === "committed:airing") return "On the air";
    if (String(o.state).startsWith("committed")) return "Preparing";
    return o.state;
  }

  _announceModeWord(o) {
    if (o.mode === "exact") return "Exact";
    if (o.origin === "smart") return "Smart";
    if (o.origin === "deterministic") return "Announced as written";
    return "Smart";
  }

  _renderAnnouncementsCard() {
    const a = this._announcements;
    const d = a && a.data;
    const busy = this._busy === "announcements";
    const frame = (body, acts, more) => `
      <div class="prog-row ann-row" role="group" aria-label="Announcements">
        <span class="prog-icon" aria-hidden="true">${this._stIcon("speaker")}</span>
        <div class="prog-body"><div class="label">Announcements</div>${body}</div>
        ${acts ? `<div class="prog-act">${acts}</div>` : ""}
        ${more}
      </div>`;
    if (!a || (a.loading && !d)) {
      return frame(`<div class="prog-sum">Reading announcements…</div>`, "", "");
    }
    if (!d) {
      return frame(`<div class="prog-sum">Announcements are unavailable right now. The
        ParlorWave Radio service may be restarting or may need an update.</div>`, "", "");
    }
    const cals = d.calendars || [];
    const calNames = cals.map((c) => String(c).replace(/^calendar\./, "").replace(/_/g, " "));
    const late = Number(d.late_air_minutes) || 40;
    const lateChoices = [15, 30, 40, 60, 90];
    if (!lateChoices.includes(late)) lateChoices.push(late);
    const row = (o) => `<div class="qrow${["spent", "expired", "invalid"]
        .includes(o.state) || String(o.state).startsWith("expired")
        ? " qspent" : ""}">
      <span class="qicon">📣</span>
      <span class="qname">${this._esc(o.payload || "")}
        <span class="qtag antag">${this._esc([this._announceWhen(o.start),
          this._announceModeWord(o), this._announceStatus(o)]
          .filter(Boolean).join(" · "))}</span></span></div>`;
    const upcoming = d.upcoming || [];
    const sentToAir = (o) => o.state === "spent"
      || o.expire_reason === "unconfirmed_after_insert";
    const aired = (d.recent || []).filter(sentToAir);
    const missedOrInvalid = (d.recent || []).filter((o) => !sentToAir(o));
    const summary = ["Calendar entries that start with ANNOUNCE",
      cals.length ? `watching ${calNames.join(", ")}` : "no calendars yet",
      upcoming.length ? `${upcoming.length} coming up` : ""].filter(Boolean).join(" · ");
    // HELD is said on the row itself, never only behind Options: nothing
    // airs while it holds, and a row that merely looked quiet would hide it.
    const held = d.store_problem || d.config_problem ? `<div class="hint">
        <span class="badge warning">Held</span> ${d.store_problem
          ? "The announcements record can't be read, so nothing will air until it is repaired or restored. Nothing that already aired can air twice."
          : "The Station settings can't be read, so announcements are held off until they are saved again."}</div>` : "";
    const failed = (d.calendars_failed || []).length
      ? `<div class="hint"><span class="badge warning">Some calendars are unavailable</span></div>` : "";
    const acts = `
          <button class="pill ${d.enabled ? "on" : ""}" id="announce-enabled"
            aria-label="Announcements: ${d.enabled ? "On" : "Off"}"
            ${busy ? "disabled" : ""}>${d.enabled ? "On" : "Off"}</button>
          <button class="ghost small" id="announce-options"
            aria-expanded="${this._annOpen ? "true" : "false"}">Options</button>`;
    const more = !this._annOpen ? "" : `
        <div class="prog-more">
          <div class="controls">
            <div class="control">
              <div><div class="label">Calendars to watch</div>
              <div class="hint">${cals.length
                ? `Watching ${cals.length === 1 ? "calendar" : "calendars"}: ${
                    this._esc(calNames.join(", "))}.`
                : `No calendars selected yet. Pick the calendars ParlorWave
                   watches, then create an event like
                   “ANNOUNCE Fish Fry 5p-10p for $11.99”.`}</div></div>
              <button class="ghost small" data-goto="settings" data-goto-focus="sources-calendars"
                      aria-label="Choose calendars in Settings">Choose calendars</button>
            </div>
            <div class="control">
              <div><div class="label">Smart rewriting <span class="badge">Experimental</span></div>
              <div class="hint">${d.smart_available
                ? `Off by default. When on, the writer may rephrase plain
                   ANNOUNCE entries — only from the facts you wrote, checked
                   word for word, and falling back to your own wording if the
                   check fails. ANNOUNCE EXACT is always read as written.`
                : `Off by default, and no writing model is set up. Plain
                   ANNOUNCE entries air in a clean spoken form of your own
                   words; ANNOUNCE EXACT is always read exactly as written.`}</div></div>
              <button class="pill ${d.smart_rewriting ? "on" : ""}" id="announce-smart"
                aria-label="Smart rewriting: ${d.smart_rewriting ? "On" : "Off"}"
                ${busy ? "disabled" : ""}>${d.smart_rewriting ? "On" : "Off"}</button>
            </div>
            <div class="control">
              <div><div class="label">How late an announcement may air</div>
              <div class="hint">The station waits for a song change; past this
              it stays silent rather than air stale news.</div></div>
              <select id="announce-late" aria-label="Late-air tolerance"
                ${busy ? "disabled" : ""}>
                ${lateChoices.sort((x, y) => x - y).map((m) =>
                  `<option value="${m}" ${m === late ? "selected" : ""}>
                   ${m} minutes</option>`).join("")}
              </select>
            </div>
          </div>
          ${upcoming.length ? `<div class="qhead">Coming up</div>${
            upcoming.map(row).join("")}` : (cals.length
            ? `<div class="hint">Nothing scheduled. An
               event titled “ANNOUNCE …” becomes a spoken announcement at its
               start time; “ANNOUNCE EXACT …” is read exactly as written.</div>`
            : "")}
          ${aired.length ? `<div class="qhead">Last aired</div>${
            aired.slice(0, 3).map((o) => `<div class="qrow">
              <span class="qicon">📣</span>
              <span class="qname">${this._esc(o.spoken_text || o.payload || "")}
                <span class="qtag antag">${this._esc([this._announceWhen(o.aired_at
                  || o.start), this._announceModeWord(o),
                  o.state === "spent" ? "Aired" : this._announceStatus(o)]
                  .join(" · "))}</span></span></div>`).join("")}` : ""}
          ${missedOrInvalid.length ? `<div class="qhead">Didn't air</div>${
            missedOrInvalid.slice(0, 2).map(row).join("")}` : ""}
        </div>`;
    return frame(`<div class="prog-sum">${this._esc(summary)}</div>${held}${failed}`, acts, more);
  }

  /* THE CONSOLE: how the On Air console looks, two rows. Kept to what is
   * true: the eyes blink at random while the DJ speaks (there are no gaze
   * shifts), and both choices are this browser's own. */
  _renderFaceplateSetting() {
    const current = this._faceplate || "midnight";
    const eyesEnabled = this._eyesEnabled();
    return `
      <section class="card console-set" aria-label="Console">
        <h2>Console</h2>
        <div class="set-ctl">
          <div class="set-ctl-text"><div class="label">Faceplate</div>
            <div class="hint">The grille cloth on the On Air console. Double-click open
            space on the console to cycle it.</div></div>
          <div class="fp-options" role="group" aria-label="Faceplate">
            ${FACEPLATES.map((fp) => `
              <button class="pill ${fp.id === current ? "on" : ""}" data-fp-choice="${fp.id}" type="button"
                      aria-pressed="${fp.id === current ? "true" : "false"}">${this._esc(fp.label)}</button>`).join("")}
          </div>
        </div>
        <div class="set-ctl">
          <div class="set-ctl-text"><div class="label">Eye expressions</div>
            <div class="hint">Random blinks on the console dials while the DJ speaks.</div></div>
          <button class="pill ${eyesEnabled ? "on" : ""}" id="btn-toggle-eyes" type="button"
                  aria-label="Eye expressions" aria-pressed="${eyesEnabled ? "true" : "false"}">${eyesEnabled ? "On" : "Off"}</button>
        </div>
      </section>`;
  }

  _readiness() {
    return (this._ready && this._ready.data && this._ready.data.readiness) || null;
  }

  /* The document in hand is too old to be the current state. A stale
   * connection -- Home Assistant unreachable from this browser, the
   * integration not answering -- must never leave "Ready." on the screen:
   * the verdict was true when it arrived, and nothing since has said so. */
  _readyStale() {
    const r = this._ready;
    return !!(r && r.data && Date.now() - (r.at || 0) > READY_STALE_MS);
  }

  /* THE STEP THAT NEEDS ATTENTION, if the verdict says one does. The
   * readiness model keeps a problem a setup step has adopted out of
   * `blockers`, so a new install is not told it is broken -- but a Music
   * Assistant that does not answer is that kind of problem, and On Air and
   * Station must not go on saying "waiting for music" or "start an album
   * in Music Assistant" over it. The step carries the problem's own
   * sentence; nothing is phrased here. */
  _attentionStep() {
    const r = this._readiness();
    if (!r || r.state !== "needs_attention") return null;
    const step = (r.checklist || []).find((c) => this._stepNeedsAttention(r, c));
    if (!step) return null;
    return { label: step.label || "", detail: step.detail || "", where: step.where || "settings", code: step.code };
  }

  /* WHICH PRESENTATION, from the document's own verdict and nothing else:
   * never a problem code, never this browser's memory, and never a guess
   * at how new the installation is. Nothing records whether an
   * installation was ever ready -- not this document, not the integration,
   * not the service -- so an unfinished setup is ONE neutral state however
   * many of its steps pass: zero of four on a new install and zero of four
   * on an established one whose prerequisites all failed are drawn alike,
   * from their own sentences. */
  _readyMode(r) {
    if (!r || r.known === false || r.state === "checking") return "checking";
    if (r.state === "ready") return "ready";
    return "incomplete";
  }

  /* Is an unfinished step a problem to attend to, rather than simply not
   * done yet? Only while the verdict itself asks for attention, and only
   * for a step whose own problem stops the station -- found by the code
   * the step carries, compared and never written here. A step that is
   * merely not done (the DJ switched off, a voice not chosen yet) keeps the
   * plain ring. */
  _stepNeedsAttention(r, c) {
    if (!c || c.done || r.state !== "needs_attention" || !c.code) return false;
    const problems = (r.diagnostics || {}).problems || [];
    return problems.some((p) => p.code === c.code && p.severity === "blocker");
  }

  /* Before the first answer, and after a failed one. Neither is dressed up
   * as a verdict: a setup screen that guesses is worse than one that waits. */
  _renderSettingsWaiting() {
    const failed = this._ready && this._ready.error;
    const stale = !failed && this._readyStale();
    return `
      <section class="booth-hero settings-desk" aria-label="Setup and readiness">
        <div class="stage-glow" aria-hidden="true"></div>
        <div class="booth-hero-body">
          <div class="booth-eyebrow">Setup &amp; readiness</div>
          <h2 class="booth-name">${failed ? "Cannot read this installation."
            : stale ? "This installation has not answered for a while."
            : "Reading this installation…"}</h2>
          <div class="booth-desc">${failed
            ? "ParlorWave Radio did not answer. It may be restarting; this page recovers on its own when it does."
            : stale
            ? "The last answer is more than five minutes old, so nothing here is shown as current. This page recovers on its own when ParlorWave Radio answers again."
            : "One moment."}</div>
        </div>
      </section>`;
  }

  /* THE ONE VERDICT, and the reason for it, said first. A setup that is
   * not complete gets the hero: the verdict, its sentence and the meter --
   * the four steps themselves are the list directly beneath it, and they
   * are not said twice. Ready and checking
   * get the compact strip, where the chips ARE the summary of the steps
   * folded away; ready folds them at once (Show steps brings them back),
   * and a finished installation with nothing worth a look reads calm,
   * without the onboarding sentence. */
  _renderReadyHero(r) {
    const tone = { ready: "ok", needs_setup: "setup",
                   needs_attention: "bad" }[r.state] || "idle";
    const mode = this._readyMode(r);
    if (mode !== "incomplete") {
      const ready = mode === "ready";
      const said = ready && !(r.warnings || []).length ? "" : this._esc(r.detail);
      const open = !!this._readyStepsOpen;
      return `
      <section class="card ready-strip ${this._esc(tone)}" aria-label="Setup and readiness">
        <div class="ready-head">
          <span class="ready-dot ${this._esc(tone)}" aria-hidden="true"></span>
          <h2 class="ready-title">${this._esc(r.headline)}</h2>
          ${ready ? `<button class="ghost small ready-steps-btn" id="ready-steps"
                  aria-expanded="${open ? "true" : "false"}">${open ? "Hide steps" : "Show steps"}</button>` : ""}
        </div>
        ${said ? `<div class="ready-desc">${said}</div>` : ""}
        ${mode === "checking" ? "" : this._readyChips(r)}
      </section>`;
    }
    const pct = r.total ? Math.round((100 * r.complete) / r.total) : 0;
    return `
      <section class="booth-hero settings-desk" aria-label="Setup and readiness">
        <div class="stage-glow" aria-hidden="true"></div>
        <div class="booth-hero-body">
          <div class="booth-eyebrow">Setup &amp; readiness</div>
          <div class="ready-line">
            <span class="ready-dot ${this._esc(tone)}" aria-hidden="true"></span>
            <h2 class="booth-name">${this._esc(r.headline)}</h2>
          </div>
          <div class="booth-desc">${this._esc(r.detail)}</div>
          <div class="ready-meter" role="img"
               aria-label="${r.complete} of ${r.total} setup steps done">
            <div class="ready-bar"><div class="ready-fill ${this._esc(tone)}"
                 style="width:${pct}%"></div></div>
            <span class="ready-count">${r.complete} of ${r.total} set up</span>
          </div>
        </div>
      </section>`;
  }

  /* One chip per step, in the document's order. The words are short forms
   * of the step, filled from what is actually configured (the speaker the
   * DJ follows, the voice on the air, whether the DJ is on); the state is
   * said in words for a screen reader, and the mark beside it is
   * decoration. Amber only for a step whose own problem stops the station
   * (_stepNeedsAttention). */
  _readyChips(r) {
    const o = r.outputs || {}, s = r.speech || {};
    const word = (c) => (c.key === "music_assistant" ? "Music Assistant"
      : c.key === "outputs" ? (c.done && o.current ? `Speaker · ${o.current}` : "Speaker")
      : c.key === "speech" ? (c.done && s.voice ? `Voice · ${s.voice}` : "Voice")
      : c.key === "dj" ? (c.done ? "DJ on" : "DJ off")
      : (c.label || ""));
    return `
      <div class="ready-chips" role="list" aria-label="Setup steps">
        ${(r.checklist || []).map((c) => {
          const attn = this._stepNeedsAttention(r, c);
          const kind = c.done ? "done" : attn ? "attn" : "todo";
          const mark = c.done ? this._stIcon("check")
            : attn ? this._stIcon("warn") : `<span class="ready-ring" aria-hidden="true"></span>`;
          const state = c.done ? "done" : attn ? "needs attention" : "not done yet";
          return `<span class="ready-chip ${kind}" role="listitem">${mark}${this._esc(word(c))}<span
            class="visually-hidden">: ${state}</span></span>`;
        }).join("")}
      </div>`;
  }

  /* THE MINIMUM PATH, and all of it. Four rows, the same four on every
   * installation, each either done or carrying the one next step. No
   * optional capability appears here -- a new owner is never told they
   * need a catalog, a voice engine, a writing model or a news feed.
   *
   * While setup is not complete all four are shown, and EVERY step that is
   * not done is open: its sentence, where it is done and, for the speaker
   * step, the speaker list itself -- the same for a new installation and
   * for an established one, since the two cannot be told apart. Done
   * steps stay one quiet line. Once ready the steps hide behind Show
   * steps. An undone step is an empty ring, never a cross. */
  _renderSetupChecklist(r) {
    const mode = this._readyMode(r);
    if (mode === "checking") return "";
    if (mode === "ready" && !this._readyStepsOpen) return "";
    const items = r.checklist || [];
    if (!items.length) return "";
    return `
      <section class="card" aria-label="Setup steps">
        <h2>Setup</h2>
        <div class="ck">
          ${items.map((c) => {
            const open = !c.done;
            const kind = c.done ? "done"
              : `todo ck-open${this._stepNeedsAttention(r, c) ? " ck-attn" : ""}`;
            // The speaker step's route is this very screen: its list is
            // drawn in the step instead of a button back to here.
            const go = open && c.where !== "settings" ? this._where(c.where) : "";
            return `
            <div class="ck-row ${kind}">
              <span class="ck-mark" aria-hidden="true">${c.done ? "✓" : ""}</span>
              <div class="ck-body">
                <div class="label">${this._esc(c.label)}</div>
                <div class="hint">${this._esc(c.detail)}</div>
                ${open ? this._renderStepControl(r, c) : ""}
              </div>
              <div class="ck-go">${go}</div>
            </div>`;
          }).join("")}
        </div>
        ${mode === "incomplete" ? `<div class="hint">These four are everything ParlorWave Radio
        needs to work. Everything else is optional, and an installation without
        any of it is a complete one.</div>` : ""}
      </section>`;
  }

  /* What an open step carries beyond its sentence: the speaker list for
   * the speaker step (the one control on this screen a step needs), the
   * server and token facts for the Music Assistant step. */
  _renderStepControl(r, c) {
    if (c.key === "outputs") {
      return `<div class="ck-tools">${this._renderSpeakerPicker((r.outputs || {}).speakers)}</div>`;
    }
    if (c.key === "music_assistant") {
      const rows = this._setRows((r.music_assistant || {}).rows);
      return rows ? `<div class="ck-tools">${rows}</div>` : "";
    }
    return "";
  }

  /* What is wrong, in a person's words, with somewhere to go. Split by
   * whether it stops the station or merely deserves a look, because
   * telling somebody a warning is a failure is how a working station gets
   * taken apart. */
  _renderIssues(r) {
    const blockers = r.blockers || [], warnings = r.warnings || [];
    if (!blockers.length && !warnings.length) return "";
    const row = (i, severity) => `
      <div class="problem-card ${this._esc(severity)}">
        <div class="problem-icon" aria-hidden="true">${severity === "error" ? "⚠️" : "•"}</div>
        <div class="problem-body">
          <div class="problem-summary">${this._esc(i.title)}</div>
          ${i.detail ? `<div class="problem-action">${this._esc(i.detail)}</div>` : ""}
          ${i.where ? `<div class="row tight">${this._where(i.where)}</div>` : ""}
        </div>
      </div>`;
    return `
      ${blockers.length ? `
        <section class="card">
          <h2>To fix</h2>
          <div class="problems-list">${blockers.map((i) => row(i, "error")).join("")}</div>
        </section>` : ""}
      ${warnings.length ? `
        <section class="card secondary">
          <h2>Worth a look</h2>
          <div class="problems-list">${warnings.map((i) => row(i, "warning")).join("")}</div>
          <div class="hint">None of these stops the station. They are listed so
          nothing about this installation is a surprise later.</div>
        </section>` : ""}`;
  }

  _renderMusicAssistant(r) {
    const ma = r.music_assistant || {};
    return `
      <section class="card">
        <h2>Music Assistant</h2>
        ${this._setHead(ma)}
        ${this._setRows(ma.rows)}
        <div class="hint">The server address and the <b>Music Assistant access
        token</b> are set in the ParlorWave Radio add-on, under Configuration.
        Create that token <b>in Music Assistant</b> — Profile › Access tokens ›
        Create new token. A Home Assistant long-lived access token will not
        work here. The token is never shown on this screen or anywhere else in
        this interface.</div>
      </section>`;
  }

  /* TWO DIFFERENT THINGS, and the whole card exists to keep them apart.
   *
   *   which speakers Parlorwave Radio MAY DJ on   -- the allow-list, here
   *   which enabled speaker it is following NOW   -- Active DJ speaker,
   *                                                  on On Air
   *
   * THE ALLOW-LIST USED TO BE EDITED SOMEWHERE ELSE, and that is the
   * onboarding trap this card closes. The list itself has always lived in
   * the service (settings.dj.outputs.enabled); only its FORM lived in the
   * Home Assistant integration's options. So setup sent people to Devices
   * & services, where several plausible Parlorwave rows wait, where the
   * obvious one opens a device page whose "Output" selector looks exactly
   * like speaker setup and only picks the active one, and where the real
   * control is behind a gear icon nothing mentions -- with no way back
   * here afterwards. A person could finish all of that and have enabled
   * nothing.
   *
   * Editing it here moves no data and migrates nothing: the same two API
   * calls the options form made are made from this screen, and the options
   * form still works for anyone who opens it. */
  /* WHAT THE DJ MAY USE: the three things in Home Assistant it is allowed
   * to read, chosen here and nowhere else a person has to find.
   *
   *   the speakers it may DJ on     -- the service's allow-list
   *   the weather entity            -- the integration's options
   *   the calendars                 -- the integration's options
   *
   * All three used to be picked in the integration's options flow, behind
   * a gear icon nothing on this screen mentioned, and the speakers were
   * moved here first for exactly that reason. The weather entity and the
   * calendars follow the same pattern: a list to tick, a draft that lives
   * in state, Save that writes the whole value and re-reads the truth, and
   * nothing drawn that cannot be trusted. Each row saves on its own.
   *
   * None of this moves any data. The speakers are still the service's
   * setting; the weather entity and the calendars are still the config
   * entry's options, written through Home Assistant's own update, so the
   * options flow shows what was saved here and this shows what was saved
   * there. */
  _renderSources(r) {
    const o = r.outputs || {};
    // While the speaker step is open the speaker list is drawn in that
    // step, and never twice: a second Save would be a dead button.
    const step = (r.checklist || []).find((c) => c.key === "outputs");
    const speakersHere = !(step && !step.done && this._readyMode(r) !== "checking");
    const c = r.context || {};
    const sun = (c.rows || []).find((row) => row.label === "Daylight");
    return `
      <section class="card src-card" aria-label="What the DJ may use" tabindex="-1" data-focus="sources">
        <h2>What the DJ may use</h2>
        ${speakersHere ? `
        <div class="src-row spk-card" data-focus="sources-speakers">
          <div class="src-head">
            <div class="label">Speakers ParlorWave may DJ on</div>
            <div class="hint">It follows what plays on these and talks between the songs.</div>
          </div>
          <div class="src-body">${this._renderSpeakerPicker(o.speakers || [])}</div>
        </div>` : ""}
        <div class="src-row" data-focus="sources-weather">
          <div class="src-head">
            <div class="label">Weather</div>
            <div class="hint">One weather entity, for the conditions and the day's high and low.</div>
          </div>
          <div class="src-body">${this._renderWeatherPicker()}</div>
        </div>
        <div class="src-row" data-focus="sources-calendars">
          <div class="src-head">
            <div class="label">Calendars</div>
            <div class="hint">Upcoming events, and entries that begin with ANNOUNCE, which
            air as announcements.</div>
          </div>
          <div class="src-body">${this._renderCalendarPicker()}</div>
        </div>
        ${c.error ? `<div class="setup-callout">ParlorWave Radio could not be
          given these facts on the last try. It keeps retrying, and the DJ
          simply leaves them out until it succeeds.</div>` : ""}
        <div class="hint src-foot">Only what is chosen here is ever read, and only the
        time, the conditions and an event's title travel. Sunrise and sunset come
        from Home Assistant on their own${sun && sun.tone === "warn"
          ? ", though it is not reporting the sun right now" : ""}. Whether the DJ
        mentions any of it is set in ${this._go("booth")}.</div>
      </section>`;
  }

  /* A tag on a row that is not simply there and working. "Not found" is
   * an entity that was chosen and is no longer in Home Assistant: it stays
   * chosen, because ending a selection is the person's act, not this
   * code's. */
  _srcTag(row, pending) {
    if (row.missing) return `<span class="spk-tag warn">Not found</span>`;
    if (row.failed) return `<span class="spk-tag warn">Can't read</span>`;
    const n = Number(pending || 0);
    return `${row.available ? "" : `<span class="spk-tag warn">Unavailable</span>`}${
      n ? `<span class="spk-tag">${n} scheduled</span>` : ""}`;
  }

  /* Why the pickers are not drawn: the inventory has not been read, or
   * could not be. Zero entities and "could not be read" must never look
   * alike once drawn, because saving the first would wipe a selection. */
  /* Changing the weather entity or the calendars changes the integration's
   * options, which Home Assistant keeps for administrators (the write is
   * require_admin, as the options flow is). Somebody else sees the choice
   * and is told who can change it, rather than a Save that cannot work. */
  _srcReadOnly() {
    const u = this._hass && this._hass.user;
    return !!(u && u.is_admin === false);
  }

  _srcUnreadable() {
    const d = this._sources;
    // A REFRESH NEVER BLANKS WHAT IS ON SHOW. Settings re-reads every 30 s,
    // and the first of its reads to answer renders while the others are
    // still out: drawing "Reading…" over data already held rewrote the whole
    // screen twice per refresh, shrank it for a frame and moved a scrolled
    // page. The placeholder is for the first
    // read only.
    if (!d || (d.loading && !d.data)) return `<div class="hint">Reading what Home Assistant has…</div>`;
    if (!d.data || d.data.ok === false) {
      return `<div class="hint">Home Assistant could not be read just now, so this
        cannot be changed from here. Nothing has been altered.</div>`;
    }
    return "";
  }

  /* ONE weather entity, or none. Radio buttons in the speaker list's
   * dress: None is a choice in its own right, drawn first. */
  _renderWeatherPicker() {
    const held = this._srcUnreadable();
    if (held) return held;
    const w = this._sources.data.weather || {};
    const rows = w.entities || [];
    const draft = this._srcDraft || this._srcDraftFrom(this._sources.data);
    const chosen = String(draft.weather || "");
    const dirty = this._srcDirty.weather;
    const busy = this._busy === "src_save:weather";
    const locked = this._srcReadOnly();
    if (!rows.length) {
      return `
        <div class="hint">Home Assistant has no weather integration yet. Add one
        (Met.no comes with Home Assistant) and it appears here on its own.</div>
        <div class="row tight">${this._where("ha_weather")}</div>`;
    }
    const pick = (id, label, tag) => `
      <label class="spk-pick">
        <input type="radio" name="src-weather" data-weather="${this._esc(id)}"
               ${chosen === id ? "checked" : ""} ${busy || locked ? "disabled" : ""}>
        <span class="label">${this._esc(label)}</span>${tag || ""}
      </label>`;
    return `
      <div class="spk-line">
        <div class="spk" role="radiogroup" aria-label="Weather entity">
          ${pick("", "None")}
          ${rows.map((row) => pick(row.entity_id, row.name, this._srcTag(row))).join("")}
        </div>
        <div class="row tight spk-acts">
          ${dirty ? `<button class="ghost small" id="wx-reset" ${busy ? "disabled" : ""}>Undo</button>` : ""}
          ${locked ? "" : `<button id="wx-save" ${dirty && !busy ? "" : "disabled"}>${busy ? "Saving…" : "Save weather"}</button>`}
          <button class="ghost small" id="weather-test"
                  ${this._busy === "weather_test" || dirty ? "disabled" : ""}
                  title="${dirty ? "Save first; the test reads what is saved" : "Read it now and see what a break would say"}">
            ${this._busy === "weather_test" ? "Checking…" : "Test"}</button>
        </div>
      </div>
      ${!chosen ? `<div class="hint">With none chosen the DJ never mentions the weather.</div>` : ""}
      ${locked ? `<div class="hint">Only a Home Assistant administrator can change this.</div>` : ""}
      ${this._renderWeatherTest()}`;
  }

  /* ANY number of calendars, or none. Unticking a calendar with
   * announcements still to air is said on the spot, before Save: the
   * service cancels what has not aired from a calendar it is no longer
   * given, and that is not a thing to find out afterwards. */
  _renderCalendarPicker() {
    const held = this._srcUnreadable();
    if (held) return held;
    const c = this._sources.data.calendars || {};
    const rows = c.entities || [];
    const pending = this._sources.data.pending || {};
    const draft = this._srcDraft || this._srcDraftFrom(this._sources.data);
    const chosen = list_of(draft.calendars);
    const stored = this._srcStored("calendars");
    const dirty = this._srcDirty.calendars;
    const busy = this._busy === "src_save:calendars";
    const locked = this._srcReadOnly();
    const cancels = this._sources.data.deselect_cancels === true;
    if (!rows.length) {
      return `
        <div class="hint">Home Assistant has no calendar yet. Add one (Local Calendar
        comes with Home Assistant; Google and CalDAV calendars can be added) and it
        appears here on its own.</div>
        <div class="row tight">${this._where("ha_calendar")}</div>`;
    }
    const dropping = stored.filter((id) => !chosen.includes(id) && Number(pending[id] || 0) > 0);
    const name = (id) => { const r = rows.find((x) => x.entity_id === id); return r ? r.name : id; };
    return `
      <div class="spk-line">
        <div class="spk" role="group" aria-label="Calendars">
          ${rows.map((row) => `
            <label class="spk-pick">
              <input type="checkbox" data-cal="${this._esc(row.entity_id)}"
                     ${chosen.includes(row.entity_id) ? "checked" : ""} ${busy || locked ? "disabled" : ""}>
              <span class="label">${this._esc(row.name)}</span>${this._srcTag(row, pending[row.entity_id])}
            </label>`).join("")}
        </div>
        <div class="row tight spk-acts">
          ${dirty ? `<button class="ghost small" id="cal-reset" ${busy ? "disabled" : ""}>Undo</button>` : ""}
          ${locked ? "" : `<button id="cal-save" ${dirty && !busy ? "" : "disabled"}>${busy ? "Saving…" : "Save calendars"}</button>`}
          <button class="ghost small" id="cal-test"
                  ${this._busy === "cal_test" || dirty ? "disabled" : ""}
                  title="${dirty ? "Save first; the test reads what is saved" : "Read them now and see what a break would say"}">
            ${this._busy === "cal_test" ? "Checking…" : "Test"}</button>
        </div>
      </div>
      ${dropping.map((id) => {
        const n = Number(pending[id]);
        const what = `${n} announcement${n === 1 ? "" : "s"}`;
        // What unticking does is the backend's to say (deselect_cancels):
        // The current backend keeps a scheduled announcement and airs it.
        return cancels
          ? `<div class="hint src-warn"><span class="badge warning">Before you save</span>
            Unticking ${this._esc(name(id))} cancels ${what} from it that ${
              n === 1 ? "has" : "have"} not aired yet.</div>`
          : `<div class="hint src-warn"><span class="badge warning">Before you save</span>
            ${this._esc(name(id))} has ${what} scheduled. Unticking it does not cancel
            ${n === 1 ? "it" : "them"}: ${n === 1 ? "it still airs" : "they still air"}. To cancel
            ${n === 1 ? "it" : "them"}, press Undo, delete ${n === 1 ? "it" : "them"} in the calendar,
            press Test, and untick it after that.</div>`;
      }).join("")}
      ${!chosen.length ? `<div class="hint">With none chosen the DJ never mentions the calendar,
        and no new announcements are picked up.</div>` : ""}
      ${locked ? `<div class="hint">Only a Home Assistant administrator can change this.</div>` : ""}
      ${this._renderCalTest()}`;
  }

  /* The allow-list itself: one checkbox per Music Assistant output, saved
   * from here.
   *
   * NOTHING IS SAVED UNTIL SAVE IS PRESSED, and the draft lives in state
   * rather than in the DOM, because this screen re-reads itself every
   * thirty seconds and a poll landing between two clicks must not put the
   * stored list back under the pointer.
   *
   * WHEN THE INVENTORY CANNOT BE READ THE CHECKBOXES ARE NOT DRAWN. An
   * empty list of speakers and "Music Assistant did not answer" look
   * identical once they are rendered as zero checkboxes, and saving that
   * would wipe a working configuration. The same rule the options form
   * already used, for the same reason. */
  _renderSpeakerPicker(fallbackRows) {
    const s = this._speakers;
    // the first read only -- a refresh keeps the list on show (see _srcUnreadable)
    if (!s || (s.loading && !s.data)) return `<div class="hint">Reading your speakers…</div>`;
    if (!s.data || s.data.ok === false) {
      // Fall back to the readiness view's own list so the screen still
      // says which speakers ARE enabled -- it just cannot offer to change
      // them while the inventory is unknown.
      return `
        ${(fallbackRows || []).length ? `<div class="spk">
          ${(fallbackRows || []).map((row) => `
            <div class="spk-row">
              <span class="spk-dot ${row.available ? "on" : "off"}" aria-hidden="true"></span>
              <span class="label">${this._esc(row.name)}</span>
              ${row.current ? `<span class="spk-tag now">Current</span>` : ""}
            </div>`).join("")}
        </div>` : ""}
        <div class="hint">Music Assistant could not be read just now, so the list
        cannot be changed from here. Nothing has been altered.</div>`;
    }
    const all = s.data.speakers || [];
    const chosen = this._speakerDraft || [];
    const dirty = this._speakersDirty;
    if (!all.length) {
      return `<div class="hint">Music Assistant is not reporting any speakers yet.</div>`;
    }
    return `
      <div class="spk-line">
        <div class="spk">
          ${all.map((sp) => `
            <label class="spk-pick">
              <input type="checkbox" data-spk="${this._esc(sp.id)}"
                     ${chosen.includes(sp.id) ? "checked" : ""}>
              <span class="label">${this._esc(sp.name)}</span>
              ${sp.id === s.data.selected ? `<span class="spk-tag now">Active</span>` : ""}
            </label>`).join("")}
        </div>
        <div class="row tight spk-acts">
          ${dirty ? `<button class="ghost small" id="spk-reset">Undo</button>` : ""}
          <button id="spk-save" ${dirty ? "" : "disabled"} ${this._busyAttr("speakers")}>Save speakers</button>
        </div>
      </div>
      ${!chosen.length ? `<div class="hint">With none selected the DJ has nowhere to speak.</div>` : ""}`;
  }

  /* CAPABILITY, not plumbing. What speaks, whether it can, and where the
   * voice itself is chosen. The speech service behind it is never named. */
  _renderSpeech(r) {
    const s = r.speech || {};
    return `
      <section class="card">
        <h2>Speech</h2>
        ${this._setHead(s)}
        ${this._setRows(s.rows)}
        <div class="row tight">${this._where(s.where)}</div>
        <div class="hint">Which voice reads the breaks, and how it is tuned,
        is chosen in ${this._go("booth")}.</div>
      </section>`;
  }

  /* THE BASE PRODUCT WRITES ITS OWN BREAKS. This card says so first and
   * without qualification: the built-in writer is the product, needs
   * nothing, and is never described as a fallback or a degraded mode. An
   * external model is one optional row underneath it. */
  _renderWriter(r) {
    const w = r.writer || {};
    return `
      <section class="card">
        <h2>Writing</h2>
        ${this._setHead(w)}
        <div class="cap">
          ${(w.rows || []).map((row) => this._capRow(row)).join("")}
        </div>
      </section>`;
  }

  /* EXTRAS: everything optional, in one disclosure closed by default and
   * kept as the person left it across rebuilds (the toggle is recorded,
   * as Station's Advanced is). Its line names what is inside, Optional
   * services first -- the words Booth's door uses. Inside: the two
   * optional services and their forms, what writes the breaks, and the
   * capabilities other screens own. The weather and the calendars are
   * not extras: they are chosen in the card above, with the speakers. */
  _renderExtras(r) {
    return `
      <details class="card secondary extras" ${this._extrasOpen ? "open" : ""}>
        <summary><span class="extras-title">Extras</span>
          <span class="extras-sum">Optional services, the writing model, news feed
          and custom voices</span></summary>
        <div class="extras-body">
          ${this._renderOptionalServices()}
          ${this._renderWriter(r)}
          ${this._renderOptional(r)}
        </div>
      </details>`;
  }

  /* OPTIONAL SERVICES, configured here. Two independent cards, because
   * they are two independent capabilities: the writer produces the words
   * and the voice engine speaks them, and either can be absent, off or
   * broken without the other noticing. */
  _renderOptionalServices() {
    if (!this._services) return "";
    if (this._services.error) {
      return `<section class="card secondary"><h2>Optional services</h2>
        <div class="hint">These could not be read. Everything else is
        unaffected — the station is complete without them.</div></section>`;
    }
    const d = this._svcForm();
    const saving = this._busy === "svc_save";
    return `
      <section class="card">
        <h2>Optional services</h2>
        <div class="hint">ParlorWave is complete without both of these. Each
        one makes a part of the station nicer, and each falls back to the
        built-in behaviour whenever it is off, unreachable or slow — the
        music is never affected either way.</div>
        ${this._renderVoiceEngine(d.voice_engine)}
        ${this._renderWriterService(d.writer)}
        <div class="row">
          <span class="spacer"></span>
          <button id="svc-save" ${saving || !d.dirty ? "disabled" : ""}>
            ${saving ? "Saving…" : "Save"}</button>
        </div>
      </section>`;
  }

  _renderVoiceEngine(v) {
    return `
      <div class="svc">
        <div class="svc-head">
          <div class="svc-name">Voice engine</div>
          <button class="pill ${v.enabled ? "on" : ""}" id="svc-ve-enabled"
                  aria-pressed="${!!v.enabled}">${v.enabled ? "On" : "Off"}</button>
        </div>
        <div class="hint">A Chatterbox-compatible speech service, for a
        warmer voice than the built-in one. Without it the DJ speaks in your
        Home Assistant text-to-speech voice, which is the product working
        normally and not a fallback.</div>
        <div class="controls">
          ${this._svcUrlField("voice_engine", "ve-url", "Address", v.base_url,
            "The address of the speech service, ending in /audio/speech.")}
          ${this._svcKeyField("ve-key", v)}
          ${this._svcField("ve-voice", "Voice", v.voice,
            "The engine's own voice name. Leave empty for its default.",
            { kind: "voice_engine", field: "voice" })}
        </div>
      </div>`;
  }

  _renderWriterService(w) {
    return `
      <div class="svc">
        <div class="svc-head">
          <div class="svc-name">Writing model</div>
          <button class="pill ${w.enabled ? "on" : ""}" id="svc-wr-enabled"
                  aria-pressed="${!!w.enabled}">${w.enabled ? "On" : "Off"}</button>
        </div>
        <div class="hint">An external model to write the breaks. The built-in
        writer is the product and always writes them when this is off,
        unreachable or slow — a break is never skipped waiting for it.</div>
        <div class="controls">
          <div class="control">
            <div><div class="label">Kind</div>
            <div class="hint">Which protocol the service speaks.</div></div>
            <select id="svc-wr-provider">
              ${this._writerProviders().map((o) => `<option value="${
                this._esc(o.id)}" ${w.provider === o.id ? "selected" : ""}>${
                this._esc(o.label)}</option>`).join("")}
            </select>
          </div>
          ${this._svcUrlField("writer", "wr-url", "Address", w.base_url,
            "The address the service listens on. A name or an IP on its own "
            + "is enough; anything it is missing is filled in for you.")}
          ${this._svcField("wr-model", "Model", w.model,
            "The model name the service knows it by.",
            { kind: "writer", field: "model" })}
          ${this._svcKeyField("wr-key", w)}
        </div>
      </div>`;
  }

  /* A FIELD THAT KNOWS WHAT THE SERVICE OFFERS, when the service has been
   * asked. `pick` names the inventory a successful Test filled in, and the
   * field becomes a suggesting one: the names are offered by the browser's
   * own list control and are still only suggestions, because a service may
   * serve something it does not list and this must not overrule the owner
   * by refusing to accept it. */
  _svcField(id, label, value, hint, pick) {
    const names = pick ? this._svcNames(pick.kind) : [];
    const listId = names.length ? `svc-${id}-list` : "";
    return `
      <div class="control news-url">
        <div><div class="label">${this._esc(label)}</div>
        <div class="hint">${this._esc(hint)}</div></div>
        <input type="text" id="svc-${id}" maxlength="500"
               value="${this._esc(value || "")}" inputmode="url"
               ${listId ? `list="${listId}"` : ""}
               aria-label="${this._esc(label)}">
        ${listId ? `<datalist id="${listId}">${names.map((n) =>
          `<option value="${this._esc(n)}"></option>`).join("")}</datalist>` : ""}
      </div>`;
  }

  /* THE TEST BELONGS TO THE ADDRESS, and sits with it.
   *
   * It used to be a button at the foot of the card, below the key and the
   * voice, and it tested the address that was SAVED rather than the one on
   * the screen -- so the ordinary way a person sets this up (type an
   * address, press Test) reported on a different address than the one
   * being read. Both halves of that are fixed here: the button is attached
   * to the field, and what is in the field is what travels. */
  _svcUrlField(kind, id, label, value, hint) {
    const busy = this._busy === `svc_test:${kind}`;
    const finding = this._busy === `svc_find:${kind}`;
    const held = busy || finding;
    return `
      <div class="control news-url svc-url">
        <div><div class="label">${this._esc(label)}</div>
        <div class="hint">${this._esc(hint)}</div></div>
        <div class="svc-url-entry">
          <div class="row tight svc-url-row">
            <input type="text" id="svc-${id}" maxlength="500"
                   value="${this._esc(value || "")}" inputmode="url"
                   aria-label="${this._esc(label)}">
            <button class="ghost" data-svctest="${this._esc(kind)}"
                    ${held ? "disabled" : ""}>${busy ? "Testing\u2026"
                      : "Test connection"}</button>
            ${kind === "writer" ? `<button class="ghost" data-svcfind="writer"
                    ${held ? "disabled" : ""}>${finding ? "Looking\u2026"
                      : "Find it"}</button>` : ""}
          </div>
          ${this._renderSvcTest(kind)}
        </div>
      </div>`;
  }

  /* The inventory a successful Test (or Find) came back with, for the one
   * field that names something from it. Held in memory only: it is what a
   * service said a moment ago, never a setting and never stored. */
  _svcNames(kind) {
    const inv = (this._svcInv || {})[kind];
    return Array.isArray(inv) ? inv : [];
  }

  /* WHAT IT FOUND, AS SOMETHING TO CHOOSE. A list of names in a sentence
   * is a thing to retype; the same names as buttons are the answer to
   * "and now which one". Choosing writes the draft and nothing else --
   * Save is still the only thing that stores a setting. */
  _svcPickList(kind, names) {
    const list = (names || []).filter(Boolean).map(String);
    if (!list.length) return "";
    const field = kind === "voice_engine" ? "voice" : "model";
    const shown = list.slice(0, 24);
    return `
      <div class="news-test-detail svc-picks">
        <span class="svc-pick-label">${this._esc(
          field === "voice" ? "Voices it offers" : "Models it offers")}</span>
        ${shown.map((n) => `<button class="chip-btn" type="button"
            data-svcpick="${this._esc(kind)}|${this._esc(field)}|${this._esc(n)}"
            >${this._esc(n)}</button>`).join("")}
        ${list.length > shown.length
          ? `<span class="svc-pick-more">and ${list.length - shown.length} more</span>`
          : ""}
      </div>`;
  }

  /* FINDING ONE, at a short list of named addresses. The screen says where
   * it looked, in full, whether or not it found anything -- "not found" on
   * its own teaches nobody where to type an address instead. */
  _renderSvcFind(kind, f) {
    if (f.error) {
      return `<div class="news-test bad"><div class="news-test-head">
        Could not look</div>
        <div class="news-test-body">${this._esc(f.error)}</div></div>`;
    }
    const r = f.result || {};
    const tried = (r.searched || []).map((u) => this._esc(u)).join(", ");
    if (r.ok) {
      return `<div class="news-test good">
        <div class="news-test-head">Found one at ${this._esc(r.found || "")}</div>
        <div class="news-test-body">The address above has been filled in.
        Press Save to keep it.</div>
        ${this._svcPickList(kind, r.models || [])}
        <div class="news-test-foot">Nothing was changed, and the music was not
        touched.</div></div>`;
    }
    return `<div class="news-test bad">
      <div class="news-test-head">Nothing answered</div>
      <div class="news-test-body">Looked at ${tried}. If the model runs on
      another machine, type its address above \u2014 the name or IP is enough
      \u2014 and press Test connection.</div></div>`;
  }

  /* A KEY BOX THAT NEVER SHOWS A KEY. The value is not in this browser,
   * so the field says whether one is saved rather than pretending to hold
   * it behind dots. Typing replaces it; Clear removes it. */
  _svcKeyField(id, x) {
    const typed = typeof x.key === "string";
    return `
      <div class="control">
        <div><div class="label">Key</div>
        <div class="hint">${x.key_set && !typed
          ? "A key is saved. It is never shown again — type a new one to "
            + "replace it."
          : "Only if the service needs one. It is stored by the add-on and "
            + "never shown, logged or exported."}</div></div>
        <div class="row tight svc-key">
          ${x.key_set && !typed
            ? `<span class="svc-badge">Configured</span>` : ""}
          <input type="password" id="svc-${id}" maxlength="500"
                 autocomplete="new-password"
                 placeholder="${x.key_set && !typed ? "Replace key…" : "Paste key…"}"
                 value="${this._esc(typed ? x.key : "")}"
                 aria-label="Service key">
          ${x.key_set ? `<button class="ghost small" data-svcclear="${
            this._esc(id)}">Clear</button>` : ""}
        </div>
      </div>`;
  }

  _renderSvcTest(kind) {
    const t = (this._svcTest || {})[kind];
    if (!t || t.running) return "";
    if (t.find) return this._renderSvcFind(kind, t.find);
    if (t.error) {
      return `<div class="news-test bad"><div class="news-test-head">
        Could not run the test</div>
        <div class="news-test-body">${this._esc(t.error)}</div></div>`;
    }
    const r = t.result || {};
    if (r.ok) {
      return `<div class="news-test good">
        <div class="news-test-head">Connected</div>
        <div class="news-test-body">${this._esc(r.detail || "")}</div>
        ${this._svcPickList(kind, r.voices || r.models || [])}
        <div class="news-test-foot">Nothing was changed, and the music was not
        touched.</div></div>`;
    }
    const WHY = {
      not_configured: "No address yet",
      disabled: "This service is switched off",
      unreachable: "Could not reach the service",
      timed_out: "The service did not answer in time",
      refused_credential: "The service refused the key",
      bad_response: "That address answered, but not as this service",
      http_error: "The service reported an error",
    };
    return `<div class="news-test bad">
      <div class="news-test-head">${this._esc(WHY[r.reason] || "It could not be used")}</div>
      <div class="news-test-body">${this._esc(r.detail || "")}</div>
      <div class="news-test-foot">The station is unaffected: the built-in
      behaviour continues exactly as before.</div></div>`;
  }

  /* CAPABILITIES SOME INSTALLATIONS HAVE. Not a feature matrix, not an
   * upsell, and never a fault: each row says what the capability is, what
   * this installation has, and which screen owns it. Settings reports; it
   * does not configure any of them. */
  _renderOptional(r) {
    const items = r.optional || [];
    if (!items.length) return "";
    return `
      <section class="card secondary">
        <h2>Optional capabilities</h2>
        <div class="cap">
          ${items.map((row) => this._capRow(row, row.where)).join("")}
        </div>
        <div class="hint">Everything here is optional. ParlorWave Radio is
        complete without all of it, and each one is set up on the screen that
        owns it — never here.</div>
      </section>`;
  }

  // --- Settings render helpers ------------------------------------------
  _setHead(section) {
    if (!section || !section.label) return "";
    return `
      <div class="set-head">
        <span class="set-badge ${this._esc(section.state || "idle")}">${this._esc(section.label)}</span>
        <div class="set-detail">${this._esc(section.detail || "")}</div>
      </div>`;
  }

  _setRows(rows) {
    if (!rows || !rows.length) return "";
    return `<table>${rows.map(([k, v]) =>
      `<tr><td>${this._esc(k)}</td><td>${this._esc(v)}</td></tr>`).join("")}</table>`;
  }

  /* One capability: a name, a badge saying what this installation has, and
   * a sentence. Shaped like the Newsroom's headline row on purpose -- the
   * product already has one way of saying "this exists, this does not". */
  _capRow(row, where) {
    return `
      <div class="cap-row">
        <span class="cap-badge ${this._esc(row.tone || "off")}">${this._esc(row.badge || "")}</span>
        <div class="cap-body">
          <div class="label">${this._esc(row.label || "")}</div>
          <div class="hint">${this._esc(row.detail || "")}</div>
        </div>
        ${where ? `<div class="cap-go">${this._where(where)}</div>` : ""}
      </div>`;
  }

  /* WHERE SOMETHING IS CHANGED, as a route rather than a paragraph.
   * Ownership is decided in the integration; this only knows how to travel
   * to the three kinds of place a route can name -- a Home Assistant page,
   * another Parlorwave screen, or (for the add-on's own configuration,
   * which has no stable address) a plain instruction. */
  /* A NAMED SCREEN IN A SENTENCE IS A DOOR, NOT AN INSTRUCTION.
   *
   * The panel owns all five screens, so telling somebody that voices
   * "live in Booth" and then leaving them to find Booth is asking them to
   * do work this component could do in one press. Every reference to one
   * of our own surfaces inside our own copy is rendered by this, and the
   * same [data-goto] handler that Settings' route buttons use moves the
   * view. It stays a button: it navigates within the panel and must not
   * look like a Home Assistant page link or offer a right-click "open in
   * new tab" that would land somewhere else. */
  _go(view, text) {
    const label = text || VIEW_LABELS[view] || view;
    if (!VIEWS.includes(view)) return this._esc(label);
    return `<button type="button" class="inlink" data-goto="${this._esc(view)}"
      aria-label="Go to ${this._esc(VIEW_LABELS[view] || view)}">${this._esc(label)}</button>`;
  }

  _where(where) {
    if (!where) return "";
    const w = SETTINGS_ROUTES[where];
    if (!w) return "";
    if (w.view) {
      return `<button class="ghost small" data-goto="${this._esc(w.view)}">${this._esc(w.label)}</button>`;
    }
    if (w.href) {
      return `<a class="ghost small route" href="${this._esc(w.href)}">${this._esc(w.label)}</a>`;
    }
    return `<span class="route-note">${this._esc(w.label)}</span>`;
  }

  /* Where keyboard focus is, as something the next render can find again:
   * an element's id, a Dial tile, or a sheet or question (data-focus). */
  _focusKeyOf(el) {
    if (!el || !el.tagName) return null;
    if (el.id) return { id: el.id };
    const ds = el.dataset || {};
    if (ds.dialPick) return { pick: ds.dialPick };
    if (ds.focus) return { f: ds.focus };
    if (ds.dialAsk) return { sel: "[data-dial-ask]" };
    if (ds.spk) return { spk: ds.spk };
    if ("weather" in ds) return { wx: ds.weather };
    if (ds.cal) return { cal: ds.cal };
    if (ds.fpChoice) return { fp: ds.fpChoice };
    const up = el.parentNode;
    if (el.tagName === "SUMMARY" && up && up.classList) {
      if (up.classList.contains("st-adv")) return { sel: ".st-adv > summary" };
      if (up.classList.contains("extras")) return { sel: "details.extras > summary" };
    }
    return null;
  }

  /* Puts focus back on what _focusKeyOf named, if the new tree has it. A
   * control that kept focus across a rebuild stays where the page is; one
   * an action moved focus to is scrolled into view. */
  _focusByKey(k, keep) {
    const root = this.shadowRoot;
    if (!k || !root) return;
    let el = null;
    try {
      const find = (sel, key, want) => Array.from(root.querySelectorAll(sel) || [])
        .find((b) => b.dataset && b.dataset[key] === want) || null;
      if (k.id) el = root.getElementById(k.id);
      else if (k.pick) el = find("[data-dial-pick]", "dialPick", k.pick);
      else if (k.f) el = find("[data-focus]", "focus", k.f);
      else if (k.spk) el = find("[data-spk]", "spk", k.spk);
      else if ("wx" in k) el = find("[data-weather]", "weather", k.wx);
      else if (k.cal) el = find("[data-cal]", "cal", k.cal);
      else if (k.fp) el = find("[data-fp-choice]", "fpChoice", k.fp);
      else if (k.sel) el = root.querySelector(k.sel);
    } catch (_) { el = null; }
    if (!el || typeof el.focus !== "function" || el.disabled) return;
    try { el.focus({ preventScroll: !!keep }); } catch (_) { /* best effort */ }
  }

  /* ONE TREE WRITE. The stylesheet and the two live regions are written
   * once and kept; a render replaces only what is inside #pw-app. A root
   * whose elements have no innerHTML of their own (the node test harness)
   * takes the whole tree, as every render used to. */
  /* THE CLOCK-DRIVEN SPOTS, written in place. The progress bar, its clock,
   * the synced lyric and every relative time ("2 min ago") move with time,
   * not with any entity. The ticker paints them every second and a render
   * that keeps the tree paints them once (see _render). */
  _paintLive() {
    const root = this.shadowRoot;
    const pr = this._progress();
    const fill = root && root.getElementById("progress-fill");
    if (fill && pr) fill.style.width = `${(100 * pr.pos / pr.duration).toFixed(2)}%`;
    const clock = root && root.getElementById("progress-clock");
    if (clock && pr) clock.textContent = `${this._mmss(pr.pos)} / ${this._mmss(pr.duration)}`;
    this._highlightLyric(pr);
    const agos = root && typeof root.querySelectorAll === "function" ? root.querySelectorAll(".pw-ago") : [];
    for (const span of agos) {
      const iso = span.getAttribute ? span.getAttribute("data-at") : null;
      const text = iso ? (this._agoText(iso) || this._localTime(iso)) : null;
      if (text && span.textContent !== text) span.textContent = text;
    }
  }

  /* A relative time the ticker keeps true (_paintLive), so "2 min ago"
   * becoming "3 min ago" is a text change, not a new screen. */
  _liveAgo(iso) {
    const text = this._agoText(iso) || this._localTime(iso);
    return `<span class="pw-ago" data-at="${this._esc(iso)}">${this._esc(text || "")}</span>`;
  }

  /* WHAT A RENDER WOULD CHANGE, minus the clock-driven spots _paintLive owns.
   * Two renders with the same key describe the same screen. */
  _treeKey(markup) {
    return markup
      .replace(/(id="progress-fill" style=")[^"]*(")/, "$1$2")
      .replace(/(id="progress-clock"[^>]*>)[^<]*/, "$1")
      .replace(/(<span class="pw-ago" data-at="[^"]*">)[^<]*/g, "$1");
  }

  /* Is the tree on screen still exactly what the last written markup made?
   * Handlers write to it between renders (a knob face turned by the volume
   * slider, a pulse class, the Request Line's answer); the render after them
   * must rebuild, as it always did, so the screen goes back to the truth.
   * Only the spots _paintLive owns are not news. No MutationObserver (an old
   * engine, the node harness) means no proof, and so no keeping. */
  _treeUnchanged() {
    const obs = this._treeObserver;
    if (!obs) return false;
    for (const r of obs.takeRecords()) this._treeDirtyCheck(r);
    return !this._treeDirty;
  }

  _treeDirtyCheck(record) {
    // Records arrive here twice over: delivered by the observer, or taken
    // synchronously by _treeUnchanged. Any change outside the clock-driven
    // spots marks the tree.
    if (this._treeDirty) return;
    const n = record.target;
    for (let e = n && n.nodeType === 1 ? n : n && n.parentElement; e; e = e.parentElement) {
      if (e.id === "progress-fill" || e.id === "progress-clock" || e.id === "lyric-lines") return;
      if (e.classList && e.classList.contains("pw-ago")) return;
      if (e.id === "pw-app") break;
    }
    this._treeDirty = true;
  }

  _writeTree(markup, bs) {
    const root = this.shadowRoot;
    const app = root.getElementById ? root.getElementById("pw-app") : null;
    if (app && typeof app.innerHTML === "string" && app.isConnected !== false) {
      app.innerHTML = markup;
    } else {
      root.innerHTML = `${PANEL_STYLE}${SR_REGIONS}<div id="pw-app">${markup}</div>`;
    }
    this._treeKeyShown = this._treeKey(markup);
    const fresh = root.getElementById ? root.getElementById("pw-app") : null;
    if (fresh && typeof MutationObserver === "function") {
      if (!this._treeObserver) {
        // One observer for the panel's life, never a second: it watches the
        // persistent #pw-app, whose contents are what each render replaces.
        this._treeObserver = new MutationObserver((records) => {
          for (const r of records) this._treeDirtyCheck(r);
        });
        this._treeObserver.observe(fresh, { childList: true, subtree: true, attributes: true, characterData: true });
        this._treeObservedApp = fresh;
      } else if (this._treeObservedApp !== fresh) {
        this._treeObserver.disconnect();
        this._treeObserver.observe(fresh, { childList: true, subtree: true, attributes: true, characterData: true });
        this._treeObservedApp = fresh;
      }
    }
    this._settleTree();                   // the write just made is not news
    this._announce(bs);
  }

  /* What a screen reader hears, and only when it changes: the On Air state
   * line (or the screen's name elsewhere), a success notice once, and every
   * blocker or error once. Text only -- the regions themselves persist. */
  _announce(bs) {
    const root = this.shadowRoot;
    const put = (id, text) => {
      const el = root.getElementById ? root.getElementById(id) : null;
      if (!el) return;
      try { el.textContent = text; } catch (_) { /* a read-only stand-in */ }
    };
    const r = this._readiness();
    const err = this._notice && !this._notice.ok ? this._notice.text : "";
    const alert = [...((r && r.blockers) || []).map((b) => b.title), err].filter(Boolean).join(". ");
    if (alert !== this._srLast.alert) { this._srLast.alert = alert; put("sr-alert", alert); }
    const state = this._view === "onair" && bs
      ? `${bs.label}${bs.detail ? ` \u00b7 ${bs.detail}` : ""}` : (VIEW_LABELS[this._view] || "");
    const ok = this._notice && this._notice.ok ? this._notice.text : "";
    if (state !== this._srLast.state) {
      this._srLast.state = state; put("sr-status", state);
    } else if (ok && ok !== this._srLast.ok) {
      put("sr-status", ok);
    }
    this._srLast.ok = ok;
  }

  _render() {
    if (!this._hass) return;
    this._micGuard();
    if (this._pointerHeld) { this._deferredRender = true; return; }
    const active = this.shadowRoot && this.shadowRoot.activeElement;
    const textLike = active && (active.tagName === "TEXTAREA" || (active.tagName === "INPUT"
      && !["radio", "checkbox", "button", "file"].includes(active.type)));
    if (active && (active.tagName === "SELECT" || textLike)) {
      this._deferredRender = true;      // finish on focusout, not mid-click
      return;
    }
    this._deferredRender = false;
    const knobFocus = active && (active.id === "dj-switch" || active.id === "right-knob") ? active.id : null;
    // On Station and Settings the control that had keyboard focus keeps it
    // across the rebuild -- by its id, its tile, its sheet or its speaker --
    // unless an action has just said where focus goes next (_focusNext).
    const keptFocus = !knobFocus && (this._view === "station" || this._view === "settings")
      ? this._focusKeyOf(active) : null;
    // The whole shadow tree is about to be replaced. The lyric pane and
    // the Break History list are the two things on it a person may be
    // READING rather than looking at, so their scroll positions are
    // carried across the rebuild.
    this._saveLyricScroll();
    this._saveHistoryScroll();
    const bs = this._broadcastState();
    const onAirNow = bs.tone === "onair";
    /* A SUCCESS FLOATS; A FAILURE TAKES ITS PLACE ON THE PAGE.
     *
     * Both are the same notice with the same close control and the same
     * rules: dismissible by hand, a success expires after 30 s, an
     * error never does. What differs is where they are drawn, and that is a
     * layout question, not a second mechanism -- there is still exactly one
     * `_notice`, set from one `_setNotice`, and no screen has its own.
     *
     * The green "Done." used to be an ordinary block at the top of the
     * page, so saving a setting pushed everything below it down by the
     * height of the banner and then pulled it back up thirty seconds later.
     * The control the owner had just used moved out from under the cursor
     * twice for a message that says the press worked. So a success is now
     * an overlay: fixed to the viewport, out of the document's flow,
     * changing the position of nothing.
     *
     * An error is left in the flow on purpose. It is not a receipt, it is
     * the state of the screen, it can run to several lines, and a diagnostic
     * floating over the very controls it is talking about is worse than one
     * that makes room for itself. */
    const noticeInner = this._notice
      ? `<span class="notice-text">${this._esc(this._notice.text)}${this._noticeMeta && this._noticeMeta.count > 1
           ? ` <span class="notice-count" aria-label="${this._noticeMeta.count} times">\u00d7${this._noticeMeta.count}</span>` : ""}${this._notice.detail
           ? `<details class="notice-more"><summary>Details for support</summary><code>${this._esc(this._notice.detail)}</code></details>` : ""}</span>
         <button class="notice-x" id="notice-close" aria-label="Dismiss this message"
                 title="Dismiss">\u00d7</button>`
      : "";
    const notice = this._notice && !this._notice.ok
      ? `<div class="notice err${this._noticeMeta && this._noticeMeta.critical ? " notice-critical" : ""}" id="notice-banner"
              tabindex="-1">${noticeInner}</div>` : "";
    const toast = this._notice && this._notice.ok
      ? `<div class="toast-wrap"><div class="notice ok toast">${noticeInner}</div></div>` : "";
    const markup = `
      <div class="wrap">
      <header>
        <div class="brand">
          <span class="brand-lamp ${onAirNow ? "lit" : ""}" aria-hidden="true"></span>
          <span class="brand-name">ParlorWave <b>Radio</b></span>
        </div>
        <nav aria-label="Sections">${VIEWS.map((v) =>
          `<button class="${v === this._view ? "active" : ""}" data-view="${v}"
                   aria-current="${v === this._view ? "page" : "false"}">
            ${VIEW_LABELS[v]}</button>`).join("")}
        </nav>
      </header>
      ${notice}
      ${this._renderProblems()}
      ${this._view === "onair" ? this._renderOnAir()
        : this._view === "booth" ? this._renderBooth()
        : this._view === "newsroom" ? this._renderNewsroom()
        : this._view === "station" ? this._renderStation()
        : this._renderSettings()}
      </div>
      ${toast}`;
    // NOTHING ON SHOW CHANGED: KEEP THE TREE. Home
    // Assistant hands the panel a new hass on EVERY state change in the
    // house, and each one used to replace every node here: the knob under a
    // resting pointer lost and re-ran its hover glow and tooltip, the On Air
    // lamps restarted their pulse and the emblem was a new image. When the
    // markup is the screen already shown (bar the clock-driven spots) and
    // nothing has written to that screen since, it is painted, not rebuilt --
    // and its nodes keep the listeners they were bound with, so nothing below
    // runs a second time.
    const key = this._treeKey(markup);
    if (key === this._treeKeyShown && !this._focusNext && this._treeUnchanged()) {
      this._paintLive();
      this._announce(bs);
      return;
    }
    this._writeTree(markup, bs);

    // wire events (innerHTML render = rebind each pass; fine at this scale)
    this.shadowRoot.querySelectorAll("[data-view]").forEach((b) =>
      b.addEventListener("click", () => {
        this._view = b.dataset.view;
        // Arriving at the Newsroom reads the desk; leaving it drops the
        // half-typed test result rather than letting it reappear later
        // beside settings it no longer describes.
        if (this._view === "newsroom") this._maybeRefreshDemandData();
        else this._newsTest = null;
        if (this._view === "settings") this._maybeRefreshDemandData();
        if (this._view === "station") this._maybeRefreshDemandData();
        if (this._view === "onair") this._rehydrateOnAir();
        this._maybeRefreshWaveform();
        this._render();
      }));
    this.shadowRoot.querySelectorAll("[data-toggle]").forEach((b) =>
      b.addEventListener("click", () =>
        this._toggle(this._hass.states[b.dataset.toggle])));
    this.shadowRoot.querySelectorAll("[data-select]").forEach((s) =>
      s.addEventListener("change", () =>
        this._select(this._hass.states[s.dataset.select], s.value)));
    this.shadowRoot.querySelectorAll("[data-number]").forEach((n) =>
      n.addEventListener("change", () => this._setCadence(n.value)));
    const on = (id, fn) => { const e = this.shadowRoot.getElementById(id); if (e) e.addEventListener("click", fn); };
    // The DJ switch writes the SAME entity the settings pill always did --
    // one control, one write path, no second copy of the rule.
    //
    // It must be bound BELOW `const on`, not above it. `const` is hoisted
    // but not initialised, so calling it earlier in this method is a
    // temporal-dead-zone ReferenceError -- which aborts _render() from the
    // hass setter and, inside Home Assistant's own update cycle, takes the
    // whole panel down to a blank screen.
    on("dj-switch", () => this._toggle(this._dj));
    on("right-knob", () => {
      // Reached only from the keyboard (the capture guard keeps pointer
      // clicks for _knobClick). Enter or Space is the keyboard's double
      // push: it opens the speaker list, where the arrows browse and Enter
      // confirms. It used to switch to the next speaker blind.
      if (this._outputMode || this._stationMode) return;
      this._enterOutputMode();
    });
    const consoleEl = this.shadowRoot.querySelector(".console");
    if (consoleEl) {
      consoleEl.addEventListener("click", (e) => {
        if (e.target.closest("button, select, input, canvas, a, .mouth-canvas, .mouth, .pw-knob, .hist-more, .lastbreak, .console-badge")) return;
        const now = Date.now();
        const diff = now - (this._lastFpClick || 0);
        if (e.detail >= 2 || (diff < FACEPLATE_DOUBLE_CLICK_MS && diff > SURFACE_BOUNCE_MS)) {
          this._lastFpClick = 0;
          this._cycleFaceplate();
        } else {
          this._lastFpClick = now;
        }
      });
    }
    const badgeEl = this.shadowRoot.getElementById("console-badge");
    if (badgeEl) {
      badgeEl.addEventListener("click", (e) => {
        const now = Date.now();
        const diff = now - (this._lastBadgeClick || 0);
        if (e.detail >= 2 || (diff < BADGE_DOUBLE_CLICK_MS && diff > SURFACE_BOUNCE_MS)) {
          this._lastBadgeClick = 0;
          e.stopPropagation();
          this._cycleCenterLogo();
        } else {
          this._lastBadgeClick = now;
        }
      });
      badgeEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this._cycleCenterLogo();
        }
      });
    }
    const mouthEl = this.shadowRoot.querySelector(".mouth");
    if (mouthEl) {
      mouthEl.addEventListener("click", (e) => {
        if (this._outputMode || this._stationMode) return;
        const now = Date.now();
        const diff = now - (this._lastMouthClick || 0);
        if (e.detail >= 2 || (diff < MOUTH_DOUBLE_CLICK_MS && diff > SURFACE_BOUNCE_MS)) {
          this._lastMouthClick = 0;
          e.stopPropagation();
          this._cycleMouthMode();
        } else {
          this._lastMouthClick = now;
        }
      });
    }
    this.shadowRoot.querySelectorAll("[data-fp-choice]").forEach((b) =>
      b.addEventListener("click", () => this._setFaceplate(b.dataset.fpChoice)));
    on("btn-toggle-eyes", () => this._toggleEyes());
    on("notice-close", () => { this._clearNotice(); this._render(); });
    // A banner being read is not taken away: pointer or focus on it holds
    // its clock, leaving gives it the rest (at least NOTICE_RESUME_MIN_MS).
    const banner = this.shadowRoot.getElementById("notice-banner");
    if (banner) {
      banner.addEventListener("mouseenter", () => this._holdNotice(true));
      banner.addEventListener("mouseleave", () => this._holdNotice(false));
      banner.addEventListener("focusin", () => this._holdNotice(true));
      banner.addEventListener("focusout", () => this._holdNotice(false));
    }
    on("lyric-follow", () => this._resumeLyricFollow());
    // Recorded on toggle, and NOT re-rendered: the browser has already
    // opened or closed the disclosure, and rebuilding the tree to say so
    // would only take the scroll position away from whoever just asked to
    // read the list.
    const hist = this.shadowRoot.querySelector(".hist-more");
    if (hist) hist.addEventListener("toggle", () => { this._histOpen = hist.open; });
    on("request-go", () => this._request());
    const input = this.shadowRoot.getElementById("request-input");
    if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter") this._request(); });
    on("start-radio", () => this._startRadio());
    on("thumb-up", () => this._thumb("thumbs_up"));
    on("thumb-down", () => this._thumb("thumbs_down"));
    const vol = this.shadowRoot.getElementById("vol-range");
    if (vol) {
      // While the finger is down the thumb follows the finger; the entity
      // takes it back the moment it lifts, so a rejected or clamped value
      // is never left on screen looking accepted.
      vol.addEventListener("input", () => {
        this._dropVolumeHold();           // the slider owns the level now
        const frac = Number(vol.value) / 100;
        this._volDrag = frac;
        const pct = this.shadowRoot.querySelector(".vol-pct");
        if (pct) pct.textContent = `${vol.value}%`;
        const deg = Math.round(KNOB_ANGLE_MIN_DEG + frac * KNOB_ANGLE_SWEEP_DEG);
        const face = this.shadowRoot.querySelector("#dj-switch .dj-face");
        if (face) face.style.transform = `rotate(${deg}deg)`;
        this._pulseKnobIndicator("left");
      });
      vol.addEventListener("change", () => {
        const wanted = Number(vol.value) / 100;
        this._volDrag = null;
        this._dropVolumeHold();
        const deg = Math.round(KNOB_ANGLE_MIN_DEG + wanted * KNOB_ANGLE_SWEEP_DEG);
        const face = this.shadowRoot.querySelector("#dj-switch .dj-face");
        if (face) face.style.transform = `rotate(${deg}deg)`;
        this._setVolume(wanted);
        this._pulseKnobIndicator("left");
      });
    }
    on("vol-mute", () => this._toggleMute());
    on("tr-prev", () => this._transport("media_previous_track"));
    on("tr-next", () => this._transport("media_next_track"));
    on("tr-play", () => this._transport("media_play"));
    on("tr-pause", () => this._transport("media_pause"));
    on("drawer-lyrics", () => {
      this._drawer = this._drawer === "lyrics" ? null : "lyrics";
      if (this._drawer) this._fetchLyrics(); else this._render();
    });
    on("drawer-queue", () => {
      this._drawer = this._drawer === "queue" ? null : "queue";
      if (this._drawer) this._fetchQueue(); else this._render();
    });
    on("history-toggle", () => {
      this._historyOpen = !this._historyOpen;
      if (this._historyOpen) { this._fetchHistory(); if (!this._voiceLib) this._fetchVoiceLib(); }
      // Closing History on purpose forgets where it was: reopening is a
      // fresh look at the list and starts from the top. (A rebuild while
      // it stays open keeps the reader's place -- _saveHistoryScroll.)
      else this._historyScrollTop = 0;
      this._render();
    });
    on("voices-toggle", () => {
      this._voicesOpen = !this._voicesOpen;
      if (this._voicesOpen) this._fetchVoiceLib();
      else {
        this._releaseMic(); this._discardTake();
        this._create = null; this._confirmDelete = null;
      }
      this._render();
    });
    // --- Saved recordings ----------------------------------------------
    const vc = this._vc;
    const each = (sel, ev, fn) => this.shadowRoot.querySelectorAll(sel).forEach((el) =>
      el.addEventListener(ev, () => fn(el)));
    on("vc-toggle", () => {
      vc.open = !vc.open;
      if (vc.open) this._fetchVc();
      this._render();
    });
    on("vc-archived", () => { vc.archived = !vc.archived; this._render(); });
    each("[data-vc-play]", "click", (b) => this._vcPlay(b.dataset.vcPlay));
    each("[data-vc-rename-edit]", "click", (b) => {
      const e = ((vc.data || {}).entries || []).find((x) => x.id === b.dataset.vcRenameEdit);
      vc.rename = e ? { id: e.id, draft: e.name } : null; this._render();
    });
    each("#vc-rename-input", "input", (i) => { if (vc.rename) vc.rename.draft = i.value; });
    on("vc-rename-cancel", () => { vc.rename = null; this._render(); });
    each("[data-vc-rename]", "click", (b) => {
      const draft = ((vc.rename || {}).draft || "").trim();
      if (!draft) return;
      this._vcDo("rename", "parlorwave_radio/voice_collection_rename",
        { entry_id: b.dataset.vcRename, name: draft }, () => { vc.rename = null; });
    });
    each("[data-vc-assign]", "click", (b) => {
      const e = ((vc.data || {}).entries || []).find((x) => x.id === b.dataset.vcAssign);
      const held = new Set(((e || {}).in_slots || []).map((x) => x.slot));
      const free = ((vc.data || {}).slots || []).find((sl) => !held.has(sl.slot));
      const first = ((vc.data || {}).slots || [])[0];
      if (!first) return;
      vc.assign = { id: b.dataset.vcAssign, slot: (free || first).slot, ack: false };
      vc.del = null; this._render();
    });
    each("#vc-slot", "change", (sel) => { if (vc.assign) { vc.assign.slot = sel.value; this._render(); } });
    each("#vc-ack", "change", (c) => { if (vc.assign) { vc.assign.ack = c.checked; this._render(); } });
    on("vc-assign-cancel", () => { vc.assign = null; this._render(); });
    on("vc-assign-go", () => {
      const a = vc.assign, consent = this._consent();
      if (!a || !a.ack || !consent) return;
      this._vcDo("assign", "parlorwave_radio/voice_collection_assign",
        { entry_id: a.id, slot: a.slot, authorized: true, consent_version: consent.version },
        (out) => {
          vc.assign = null;
          const sl = ((vc.data || {}).slots || []).find((x) => x.slot === a.slot) || {};
          this._setNotice(true, `“${out.name}” is now ${sl.label || "that voice"}. `
            + "The recording it replaced is kept in Saved recordings.");
          this._fetchVoiceLib();
        });
    });
    each("[data-vc-archive]", "click", (b) => this._vcDo("archive",
      "parlorwave_radio/voice_collection_archive", { entry_id: b.dataset.vcArchive, archived: true }));
    each("[data-vc-restore]", "click", (b) => this._vcDo("archive",
      "parlorwave_radio/voice_collection_archive", { entry_id: b.dataset.vcRestore, archived: false }));
    each("[data-vc-del]", "click", (b) => { vc.del = b.dataset.vcDel; vc.assign = null; this._render(); });
    on("vc-del-no", () => { vc.del = null; this._render(); });
    each("[data-vc-del-yes]", "click", (b) => {
      const e = ((vc.data || {}).entries || []).find((x) => x.id === b.dataset.vcDelYes);
      if (!e) return;
      this._vcDo("delete", "parlorwave_radio/voice_collection_delete",
        { entry_id: e.id, confirm: e.name }, () => { vc.del = null; });
    });
    on("vc-import-open", () => { vc.imp = { file: null, name: "", ack: false }; this._render(); });
    on("vc-import-cancel", () => { vc.imp = null; this._render(); });
    each("#vc-file", "change", (f) => {
      const file = f.files && f.files[0];
      if (!vc.imp || !file) return;
      vc.imp.file = file;
      if (!vc.imp.name) vc.imp.name = file.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 40);
      this._render();
    });
    each("#vc-import-name", "input", (i) => { if (vc.imp) vc.imp.name = i.value; });
    each("#vc-import-ack", "change", (c) => { if (vc.imp) { vc.imp.ack = c.checked; this._render(); } });
    on("vc-import-go", () => this._vcImport());
    this.shadowRoot.querySelectorAll("[data-vpick]").forEach((r) =>
      r.addEventListener("change", () => {
        r.blur();
        this._select(this._voice, r.dataset.vpick).then(() => this._fetchVoiceLib());
      }));
    this.shadowRoot.querySelectorAll("[data-preview]").forEach((b) =>
      b.addEventListener("click", () => { if (b.dataset.preview) this._previewVoice(b.dataset.preview); }));
    this.shadowRoot.querySelectorAll("[data-shifts-toggle]").forEach((b) =>
      b.addEventListener("click", () => {
        const sh = ((this._voiceLib || {}).dj || {}).shifts || {};
        this._setShifts({ enabled: !sh.enabled });
      }));
    this.shadowRoot.querySelectorAll("[data-shift]").forEach((sel) =>
      sel.addEventListener("change", () => {
        sel.blur();
        this._setShifts({ [sel.dataset.shift]: sel.value });
      }));
    this.shadowRoot.querySelectorAll("[data-persona]").forEach((b) =>
      b.addEventListener("click", () => this._pickPersona(b.dataset.persona)));
    const saveNote = (id, note) =>
      this._svc("parlorwave_radio", "voice_note", { voice_id: id, note }, "note_" + id)
        .then(() => { this._noteEditing = null; this._noteDraft = null; this._fetchVoiceLib(); });
    const stopEditing = () => { this._noteEditing = null; this._noteDraft = null; this._render(); };
    this.shadowRoot.querySelectorAll("[data-vnote-edit]").forEach((b) =>
      b.addEventListener("click", () => {
        this._noteEditing = b.dataset.vnoteEdit; this._noteDraft = null; this._render();
        const inp = this.shadowRoot.querySelector(`[data-vnote-input="${b.dataset.vnoteEdit}"]`);
        if (inp) inp.focus();
      }));
    this.shadowRoot.querySelectorAll("[data-vnote-cancel]").forEach((b) =>
      b.addEventListener("click", stopEditing));
    this.shadowRoot.querySelectorAll("[data-vnote-input]").forEach((inp) => {
      inp.addEventListener("input", () => { this._noteDraft = inp.value; });
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); inp.blur(); saveNote(inp.dataset.vnoteInput, inp.value.trim()); }
        else if (e.key === "Escape") { inp.blur(); stopEditing(); }
      });
    });
    this.shadowRoot.querySelectorAll("[data-vnote]").forEach((b) =>
      b.addEventListener("click", () => {
        const inp = this.shadowRoot.querySelector(`[data-vnote-input="${b.dataset.vnote}"]`);
        saveNote(b.dataset.vnote, (inp ? inp.value : (this._noteDraft || "")).trim());
      }));
    this.shadowRoot.querySelectorAll("[data-vnote-clear]").forEach((b) =>
      b.addEventListener("click", () => saveNote(b.dataset.vnoteClear, "")));
    const saveName = (id, name) =>
      this._svc("parlorwave_radio", "voice_rename", { voice_id: id, name }, "voice_" + id)
        .then(() => { this._nameEditing = null; this._nameDraft = null; this._fetchVoiceLib(); });
    const stopRenaming = () => { this._nameEditing = null; this._nameDraft = null; this._render(); };
    this.shadowRoot.querySelectorAll("[data-vrename-edit]").forEach((b) =>
      b.addEventListener("click", () => {
        this._nameEditing = b.dataset.vrenameEdit; this._nameDraft = null; this._render();
        const inp = this.shadowRoot.querySelector(`[data-vrename-input="${b.dataset.vrenameEdit}"]`);
        if (inp) inp.focus();
      }));
    this.shadowRoot.querySelectorAll("[data-vrename-cancel]").forEach((b) =>
      b.addEventListener("click", stopRenaming));
    this.shadowRoot.querySelectorAll("[data-vrename-input]").forEach((inp) => {
      inp.addEventListener("input", () => { this._nameDraft = inp.value; });
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); inp.blur(); saveName(inp.dataset.vrenameInput, inp.value.trim()); }
        else if (e.key === "Escape") { inp.blur(); stopRenaming(); }
      });
    });
    this.shadowRoot.querySelectorAll("[data-vrename]").forEach((b) =>
      b.addEventListener("click", () => {
        const inp = this.shadowRoot.querySelector(`[data-vrename-input="${b.dataset.vrename}"]`);
        saveName(b.dataset.vrename, (inp ? inp.value : (this._nameDraft || "")).trim());
      }));
    this.shadowRoot.querySelectorAll("[data-vrename-reset]").forEach((b) =>
      b.addEventListener("click", () => saveName(b.dataset.vrenameReset, "")));
    const kokoroOf = (id) => ((this._voiceLib || {}).kokoro || []).find((k) => k.voice_id === id) || {};
    this.shadowRoot.querySelectorAll("[data-vtune]").forEach((b) =>
      b.addEventListener("click", () => {
        const k = kokoroOf(b.dataset.vtune);
        this._tune = (this._tune && this._tune.id === b.dataset.vtune) ? null
          : { id: b.dataset.vtune, speed: Number(k.speed == null ? 1 : k.speed),
              pause: Number(k.pause == null ? 1 : k.pause) };
        this._render();
      }));
    // sliders update the draft and their readout in place -- no rebuild
    // under a drag
    this.shadowRoot.querySelectorAll("[data-vtune-speed],[data-vtune-pause]").forEach((inp) =>
      inp.addEventListener("input", () => {
        if (!this._tune) return;
        const which = inp.dataset.vtuneSpeed ? "speed" : "pause";
        this._tune[which] = Number(inp.value);
        const out = this.shadowRoot.querySelector(`[data-vtune-${which}-val="${this._tune.id}"]`);
        if (out) out.textContent = Number(inp.value).toFixed(2);
      }));
    this.shadowRoot.querySelectorAll("[data-vtune-preview]").forEach((b) =>
      b.addEventListener("click", () => {
        if (this._tune) this._previewVoice(this._tune.id, { speed: this._tune.speed, pause: this._tune.pause });
      }));
    this.shadowRoot.querySelectorAll("[data-vtune-save]").forEach((b) =>
      b.addEventListener("click", () => {
        const t = this._tune; if (!t) return;
        this._svc("parlorwave_radio", "voice_tuning", { voice_id: t.id, speed: t.speed, pause: t.pause },
          "tune_" + t.id).then(() => this._fetchVoiceLib());
      }));
    this.shadowRoot.querySelectorAll("[data-vtune-default]").forEach((b) =>
      b.addEventListener("click", () => {
        if (this._tune) { this._tune.speed = 1; this._tune.pause = 1; this._render(); }
      }));
    this.shadowRoot.querySelectorAll("[data-vtune-close]").forEach((b) =>
      b.addEventListener("click", () => { this._tune = null; this._render(); }));
    // Deleting a voice is the one irreversible thing in the library, so it
    // asks first -- in the row, not in a dialog that covers what it is
    // about to remove.
    this.shadowRoot.querySelectorAll("[data-vdelete]").forEach((b) =>
      b.addEventListener("click", () => {
        this._confirmDelete = b.dataset.vdelete; this._render();
      }));
    this.shadowRoot.querySelectorAll("[data-vdelete-no]").forEach((b) =>
      b.addEventListener("click", () => { this._confirmDelete = null; this._render(); }));
    this.shadowRoot.querySelectorAll("[data-vdelete-yes]").forEach((b) =>
      b.addEventListener("click", () => {
        const id = b.dataset.vdeleteYes;
        this._confirmDelete = null;
        this._svc("parlorwave_radio", "voice_delete", { slot: id }, "voice_" + id)
          .then(() => this._fetchVoiceLib());
      }));
    this.shadowRoot.querySelectorAll("[data-vuse]").forEach((b) =>
      b.addEventListener("click", () => this._useVoice(b.dataset.vuse)));
    on("voice-create", () => this._openCreate());
    on("create-cancel", () => this._closeCreate());
    on("create-close", () => this._closeCreate());
    on("create-go", () => this._submitCreate());
    this.shadowRoot.querySelectorAll("[data-vreplace]").forEach((b) =>
      b.addEventListener("click", () => this._openReplace(b.dataset.vreplace)));
    // --- recording ---------------------------------------------------
    // Record is the ONLY thing that opens the microphone.
    on("rec-start", () => this._recordStart());
    on("rec-stop", () => this._recordStop());
    on("take-play", () => this._playTake());
    on("take-discard", () => { this._discardTake(); this._render(); });
    on("take-use", () => this._useTake());
    on("audition-play", () => this._playAudition());
    this.shadowRoot.querySelectorAll("[data-audition]").forEach((b) =>
      b.addEventListener("click", () => {
        const box = this.shadowRoot.getElementById("create-preview-text");
        this._audition(this._create, b.dataset.audition,
                       box ? box.value : (this._previewText || ""));
      }));
    const consentBox = this.shadowRoot.getElementById("create-consent");
    if (consentBox) consentBox.addEventListener("change", () => {
      if (this._create) this._create.authorized = consentBox.checked === true;
      this._render();
    });
    this.shadowRoot.querySelectorAll("[data-cscope]").forEach((r) =>
      r.addEventListener("change", () => {
        if (!this._create) return;
        this._create.scope = r.dataset.cscope;
        if (r.dataset.cscope === "dj") this._create.makeDefault = false;
        this._render();
      }));
    const defaultBox = this.shadowRoot.getElementById("create-default");
    if (defaultBox) defaultBox.addEventListener("change", () => {
      if (this._create) this._create.makeDefault = defaultBox.checked === true;
      this._render();
    });
    // What a voice is used for, and which allowed voice reads an
    // announcement that names none: two settings, never one write.
    this.shadowRoot.querySelectorAll("[data-vrole]").forEach((d) =>
      d.addEventListener("toggle", () => {
        if (d.open) this._vroleOpen = d.dataset.vrole;
        else if (this._vroleOpen === d.dataset.vrole) this._vroleOpen = null;
      }));
    this.shadowRoot.querySelectorAll("[data-vscope]").forEach((b) =>
      b.addEventListener("click", () => {
        this._vroleOpen = null;
        if (b.classList.contains("on")) { this._render(); return; }
        this._setVoiceScope(b.dataset.vscope, b.dataset.scope);
      }));
    const annVoice = this.shadowRoot.getElementById("announce-voice");
    if (annVoice) annVoice.addEventListener("change", () => {
      const opt = annVoice.options[annVoice.selectedIndex];
      annVoice.blur();
      this._setAnnouncementVoice((opt && opt.dataset.voice) || "");
    });
    // The preview line lives in state, like every other draft.
    for (const id of ["voice-preview-text", "create-preview-text"]) {
      const input = this.shadowRoot.getElementById(id);
      if (input) input.addEventListener("input", () => { this._previewText = input.value; });
    }
    // The draft lives in state, never in the DOM: a re-render between two
    // keystrokes must not put an empty box back under the cursor.
    for (const [id, key] of [["create-name", "name"], ["create-note", "note"]]) {
      const input = this.shadowRoot.getElementById(id);
      if (!input) continue;
      input.addEventListener("input", () => {
        if (this._create) this._create[key] = input.value;
        const go = this.shadowRoot.getElementById("create-go");
        if (go && this._create) go.disabled = !this._canSubmit(this._create);
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); input.blur(); this._submitCreate(); }
      });
    }
    // --- Newsroom ---------------------------------------------------
    on("news-enabled", () => {
      this._newsEdit("enabled", !this._newsForm().enabled);
      this._render();
    });
    on("cal-test", () => this._testCalendar());
    on("weather-test", () => this._testWeather());
    // --- optional services ------------------------------------------
    on("svc-save", () => this._saveServices());
    on("svc-ve-enabled", () => {
      this._svcEdit("voice_engine", "enabled", !this._svcForm().voice_engine.enabled);
      this._render();
    });
    on("svc-wr-enabled", () => {
      this._svcEdit("writer", "enabled", !this._svcForm().writer.enabled);
      this._render();
    });
    this.shadowRoot.querySelectorAll("[data-svctest]").forEach((b) =>
      b.addEventListener("click", () => this._testService(b.dataset.svctest)));
    this.shadowRoot.querySelectorAll("[data-svcfind]").forEach((b) =>
      b.addEventListener("click", () => this._findWriter()));
    this.shadowRoot.querySelectorAll("[data-svcpick]").forEach((b) =>
      b.addEventListener("click", () => {
        const [kind, field, ...rest] = String(b.dataset.svcpick).split("|");
        this._svcEdit(kind, field, rest.join("|"));
        this._render();
      }));
    this.shadowRoot.querySelectorAll("[data-svcclear]").forEach((b) =>
      b.addEventListener("click", () => {
        // An empty string is the deliberate way to clear a stored key, and
        // the only way: null means "leave it".
        this._svcEdit(b.dataset.svcclear.startsWith("ve") ? "voice_engine" : "writer",
                      "key", "");
        this._render();
      }));
    const prov = this.shadowRoot.getElementById("svc-wr-provider");
    if (prov) prov.addEventListener("change", () => {
      this._svcEdit("writer", "provider", prov.value);
      this._render();
    });
    // The boxes keep their value in STATE, for the same reason every other
    // live screen's do.
    for (const [id, kind, key] of [
        ["svc-ve-url", "voice_engine", "base_url"],
        ["svc-ve-voice", "voice_engine", "voice"],
        ["svc-ve-key", "voice_engine", "key"],
        ["svc-wr-url", "writer", "base_url"],
        ["svc-wr-model", "writer", "model"],
        ["svc-wr-key", "writer", "key"]]) {
      const input = this.shadowRoot.getElementById(id);
      if (input) input.addEventListener("input",
        () => this._svcEdit(kind, key, input.value));
    }
    on("news-add", () => this._newsSrcAdd());
    const srcAct = (attr, fn) =>
      this.shadowRoot.querySelectorAll(`[data-${attr}]`).forEach((el) =>
        el.addEventListener("click", () => fn(el.dataset[attr])));
    srcAct("srctest", (id) => this._testNewsSource(id));
    srcAct("srcedit", (id) => {
      this._newsEditing = this._newsEditing === id ? null : id;
      this._render();
    });
    srcAct("srcoff", (id) => {
      const row = this._newsSources().find((r) => r.id === id);
      if (row) this._newsSrcEdit(id, "enabled", !row.enabled);
      this._render();
    });
    srcAct("srcdel", (id) => this._newsSrcRemove(id));
    srcAct("listen", (token) => this._listenAgain(token));
    // Each source's boxes keep their value in STATE, never in the DOM:
    // the Newsroom re-reads itself every twenty seconds, and a poll landing
    // between two keystrokes must not put the stored value back under the
    // cursor.
    for (const [attr, key] of [["srcname", "name"], ["srcurl", "feed_url"]]) {
      this.shadowRoot.querySelectorAll(`[data-${attr}]`).forEach((input) =>
        input.addEventListener("input", () =>
          this._newsSrcEdit(input.dataset[attr], key, input.value)));
    }
    this.shadowRoot.querySelectorAll("[data-srcmin]").forEach((sel) =>
      sel.addEventListener("change", () => {
        this._newsSrcEdit(sel.dataset.srcmin, "target_minute", Number(sel.value));
        this._render();
      }));
    on("news-save", () => this._saveNews());
    on("news-advanced", () => { this._newsAdvanced = !this._newsAdvanced; this._render(); });
    // --- Settings ---------------------------------------------------
    on("settings-advanced", () => {
      this._readyAdvanced = !this._readyAdvanced;
      // Broadcast Diagnostics is read the first time the disclosure opens
      if (this._readyAdvanced && !this._diag && this._diagAllowed()) this._fetchDiag(false);
      else this._render();
    });
    // --- Broadcast Diagnostics ------------------------------------------
    on("diag-refresh", () => this._diagRefresh());
    on("diag-more", () => this._fetchDiag(true));
    on("diag-retry", () => this._fetchDiag(!!(this._diag && this._diag.items && this._diag.next)));
    on("diag-linked-close", () => { this._diagLinked = null; this._render(); });
    on("diag-reason-clear", () => { this._diagFilter.reason = ""; this._fetchDiag(false); });
    each("[data-diag-outcome]", "click", (b) => { this._diagFilter.outcome = b.dataset.diagOutcome; this._fetchDiag(false); });
    each("[data-diag-kind]", "click", (b) => { this._diagFilter.kind = b.dataset.diagKind; this._fetchDiag(false); });
    each("[data-diag-reason]", "click", (b) => { this._diagFilter.reason = b.dataset.diagReason; this._fetchDiag(false); });
    each("[data-diag-row]", "click", (b) => {
      const id = b.dataset.diagRow;
      if (this._diagOpen.has(id)) { this._diagOpen.delete(id); this._render(); return; }
      this._diagOpen.add(id);
      const d = this._diagDetail[id];
      if (d && (d.loading || d.ok !== false)) this._render();
      else this._fetchDiagDetail(id);
    });
    each("[data-diag-inspect]", "click", (b) => this._diagInspect(b.dataset.diagInspect));
    on("ready-steps", () => { this._readyStepsOpen = !this._readyStepsOpen; this._render(); });
    // Extras: recorded on toggle, not re-rendered (Station's Advanced does
    // the same), so the next rebuild keeps it as the person left it.
    const extras = this.shadowRoot.querySelector(".extras");
    if (extras) extras.addEventListener("toggle", () => { this._extrasOpen = extras.open; });
    const stationInput = this.shadowRoot.getElementById("station-name-input");
    if (stationInput) {
      stationInput.addEventListener("input", () => {
        this._stationDraft = stationInput.value;
        const current = (this._stationSettings && this._stationSettings.identity && this._stationSettings.identity.name) || "ParlorWave Radio";
        this._stationDirty = (this._stationDraft !== current);
        const save = this.shadowRoot.getElementById("station-name-save");
        if (save) save.disabled = !this._stationDirty;
        const reset = this.shadowRoot.getElementById("station-name-reset");
        if (reset) reset.disabled = !this._stationDirty;
      });
      stationInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          stationInput.blur();
          this._saveStationIdentity();
        }
      });
    }
    on("station-name-save", () => this._saveStationIdentity());
    on("station-name-reset", () => this._resetStationIdentity());
    // The name sheet under the plate: Edit opens it; Done (or Edit again)
    // closes it, putting a draft that was never saved back to the stored
    // name first -- a half-typed name is never left behind a closed sheet.
    // Focus follows the sheet: into its field when it opens, back to Edit
    // when it closes.
    const stationNameDone = () => {
      this._stNameOpen = false;
      this._focusNext = { id: "station-name-edit" };
      if (this._stationDirty) this._resetStationIdentity();
      else { this._stationError = null; this._render(); }
    };
    on("station-name-edit", () => {
      if (this._stNameOpen) stationNameDone();
      else { this._stNameOpen = true; this._focusNext = { id: "station-name-input" }; this._render(); }
    });
    on("station-name-done", stationNameDone);
    // --- Announcements (Station tab) ---------------------------------
    on("announce-enabled", () => {
      const d = (this._announcements && this._announcements.data) || {};
      this._saveAnnouncementsSetting({ enabled: !d.enabled });
    });
    on("announce-smart", () => {
      const d = (this._announcements && this._announcements.data) || {};
      this._saveAnnouncementsSetting({ smart_rewriting: !d.smart_rewriting });
    });
    const lateSel = this.shadowRoot.getElementById("announce-late");
    if (lateSel) lateSel.addEventListener("change", () =>
      this._saveAnnouncementsSetting({ late_air_minutes: Number(lateSel.value) }));
    on("announce-options", () => { this._annOpen = !this._annOpen; this._render(); });
    // Station's Advanced fold: recorded on toggle, not re-rendered (the
    // History fold's pattern), so the next rebuild keeps it as it is.
    const stAdv = this.shadowRoot.querySelector(".st-adv");
    if (stAdv) stAdv.addEventListener("toggle", () => { this._stAdvOpen = stAdv.open; });
    // --- Dial Stations (Station tab) --------------------------------
    // Setup only: every handler here edits a draft, runs Test Station,
    // saves the preset list or opens a sheet. None of them can start
    // playback; only the choose sheet's second press does (below).
    // ONE SHEET AT A TIME under the tiles. These handlers keep it so --
    // opening the edit/create sheet closes the choose sheet, and opening
    // the choose sheet closes the edit/create sheet -- and the stage draws
    // the choose sheet only while nothing is being edited. Focus goes into
    // the sheet that opens and back to what opened it when it closes.
    on("dial-add", () => {
      if (this._dialEdit && !this._dialEdit.id) {          // New station again: close it
        this._dialEdit = null; this._dialTest = null;
        this._focusNext = { id: "dial-add" };
        this._render();
        return;
      }
      this._liveForm = null; this._liveStopAsk = false;
      this._focusNext = { id: "dial-label" };
      this._dialStartEdit(null);
    });
    // A tile: the station on the air opens its editor (never a second
    // offer of itself); any other opens the choose sheet; the tile whose
    // sheet is open closes it.
    this.shadowRoot.querySelectorAll("[data-dial-pick]").forEach((b) =>
      b.addEventListener("click", () => {
        const id = b.dataset.dialPick;
        const p = this._dialPresets().find((x) => x.id === id);
        if (!p) return;
        if ((this._dialEdit && this._dialEdit.id === id)
            || (!this._dialEdit && this._liveForm && this._liveForm.preset_id === id)) {
          this._dialEdit = null; this._dialTest = null; this._liveForm = null;
          this._focusNext = { pick: id };          // back to the tile that opened it
          this._render();
        } else if (this._dialLit(p)) {
          this._liveForm = null; this._liveStopAsk = false;
          this._focusNext = { f: "dial-sheet" };   // into the sheet that opened
          this._dialStartEdit(id);
        } else {
          this._dialEdit = null; this._dialTest = null;
          this._focusNext = { f: "air-sheet" };    // into the sheet that opened
          this._liveOpenForm(id);
        }
      }));
    on("dial-cancel", () => {
      const id = this._dialEdit && this._dialEdit.id;
      this._dialEdit = null; this._dialTest = null;
      this._focusNext = id ? { pick: id } : { id: "dial-add" };
      this._render();
    });
    on("dial-test", () => this._dialRunTest(false));
    on("dial-retry", () => this._dialRunTest(true));
    on("dial-save", () => this._dialSave());
    on("dial-remove-cancel", () => {
      this._dialConfirm = null; this._focusNext = { sel: "[data-dial-ask]" }; this._render();
    });
    this.shadowRoot.querySelectorAll("[data-dial-ask]").forEach((b) =>
      b.addEventListener("click", () => {
        this._dialConfirm = b.dataset.dialAsk;
        this._focusNext = { id: "dial-remove-cancel" };   // Keep: the safe answer
        this._render();
      }));
    this.shadowRoot.querySelectorAll("[data-dial-remove]").forEach((b) =>
      b.addEventListener("click", () => this._dialRemove(b.dataset.dialRemove)));
    for (const [id, key] of [["dial-label", "label"], ["dial-query", "query"]]) {
      const input = this.shadowRoot.getElementById(id);
      if (!input) continue;
      input.addEventListener("input", () => {
        if (this._dialEdit) this._dialEdit[key] = input.value;
        const test = this.shadowRoot.getElementById("dial-test");
        if (test && key === "query") test.disabled = !input.value.trim() || !!this._busy;
        if (key === "query" && this._dialTest && !this._dialTest.running) {
          // The preview goes stale the moment its term is edited -- no
          // re-render, so the field keeps its caret.
          const stale = !this._dialSameTerm(this._dialTest.query, input.value);
          const box = this.shadowRoot.getElementById("dial-preview");
          const note = this.shadowRoot.getElementById("dial-stale-note");
          const retry = this.shadowRoot.getElementById("dial-retry");
          if (box) box.classList.toggle("dial-stale", stale);
          if (note) note.hidden = !stale;
          if (retry) retry.disabled = stale || !!this._busy;
        }
      });
      if (key === "query") input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); input.blur(); this._dialRunTest(false); }
      });
    }
    const dialEnabled = this.shadowRoot.getElementById("dial-enabled");
    if (dialEnabled) dialEnabled.addEventListener("change", () => {
      if (this._dialEdit) this._dialEdit.enabled = dialEnabled.checked;
    });
    // --- On-air station (Station tab) -------------------------------
    // The only controls that can put a station on air, and each takes two
    // presses: choose, then confirm. Stop is two presses as well.
    // Focus follows each sheet and question: into it when it opens, back
    // to what opened it when it closes.
    on("air-open", () => { this._focusNext = { f: "air-sheet" }; this._liveOpenForm(); });
    on("air-cancel", () => {
      const id = this._liveForm && this._liveForm.preset_id;
      this._liveForm = null;
      this._focusNext = id ? { pick: id } : { id: "air-open" };
      this._render();
    });
    on("air-edit", () => {
      const id = this._liveForm && this._liveForm.preset_id;
      this._liveForm = null;
      this._focusNext = id ? { id: "dial-label" } : null;
      if (id) this._dialStartEdit(id); else this._render();
    });
    on("air-go", () => {
      const row = this._liveForm && this._liveTargetRow(this._liveForm.target);
      if (row && row.handover && !(this._liveData() || {}).active) {
        this._liveAskHandover();
        return;
      }
      if (this._liveForm && this._liveForm.preset_id && this._liveForm.target) {
        this._liveForm.confirm = true;
        this._focusNext = { f: "air-ask" };   // the question, not its button
        this._render();
      }
    });
    on("air-back", () => {
      if (this._liveForm) {
        Object.assign(this._liveForm, { confirm: false, handover: null, handoverPick: false, handoverRemove: [] });
      }
      this._focusNext = { id: "air-go" };
      this._render();
    });
    on("air-confirm", () => this._liveStart());
    on("air-hand-keep", () => this._liveStart("keep"));
    on("air-hand-replace", () => this._liveStart("replace"));
    // Choosing songs to remove: nothing is ticked until the person ticks it.
    on("air-hand-choose", () => { if (this._liveForm) { this._liveForm.handoverPick = true; this._liveForm.handoverRemove = []; } this._render(); });
    on("air-hand-unpick", () => { if (this._liveForm) { this._liveForm.handoverPick = false; this._liveForm.handoverRemove = []; } this._render(); });
    on("air-hand-all", () => {
      const f = this._liveForm;
      if (f && f.handover) f.handoverRemove = (f.handover.songs || [])
        .filter((x) => x.status === "removable").map((x) => x.queue_item_id);
      this._render();
    });
    on("air-hand-none", () => { if (this._liveForm) this._liveForm.handoverRemove = []; this._render(); });
    this.shadowRoot.querySelectorAll("[data-handpick]").forEach((box) =>
      box.addEventListener("change", () => {
        const f = this._liveForm;
        if (!f) return;
        const set = new Set(f.handoverRemove || []);
        if (box.checked) set.add(box.dataset.handpick); else set.delete(box.dataset.handpick);
        f.handoverRemove = [...set];
        this._render();
      }));
    on("air-stop", () => { this._liveStopAsk = true; this._liveForm = null; this._focusNext = { f: "stop-ask" }; this._render(); });
    on("air-stop-keep", () => { this._liveStopAsk = false; this._focusNext = { id: "air-stop" }; this._render(); });
    on("air-stop-confirm", () => this._liveStop());
    on("air-autoplay-restore", () => this._liveAutoplayDecision("restore"));
    on("air-autoplay-dismiss", () => this._liveAutoplayDecision("dismiss"));
    // The Request Line. Typing is recorded without a render (the render
    // waits for the box to lose focus anyway), so nothing typed is lost.
    const rl = this.shadowRoot.getElementById("rl-text");
    if (rl) {
      rl.addEventListener("input", () => { this._reqLine.text = rl.value; });
      // Enter leaves the box first: a focused text box holds every render
      // back, so the question it asks would not appear until it did.
      rl.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        if (typeof rl.blur === "function") rl.blur();
        this._reqAsk();
      });
    }
    on("rl-go", () => this._reqAsk());
    for (const [id, key] of [["rl-song-title", "title"], ["rl-song-artist", "artist"]]) {
      const box = this.shadowRoot.getElementById(id);
      if (!box) continue;
      box.addEventListener("input", () => { this._songReq[key] = box.value; });
      box.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        if (typeof box.blur === "function") box.blur();
        this._songAsk();
      });
    }
    on("rl-song-go", () => this._songAsk());
    on("rl-back", () => { this._reqLine.confirm = false; this._focusNext = { id: "rl-go" }; this._render(); });
    on("rl-confirm", () => this._reqStart());
    // A chosen speaker keeps focus, so the render waits for it to leave
    // (see _render). Until then the question is brought up to date in
    // place: it names the speaker Go on air would send, and Go on air
    // waits for one.
    const rlTarget = this.shadowRoot.getElementById("rl-target");
    if (rlTarget) rlTarget.addEventListener("change", () => {
      this._reqTarget = rlTarget.value;
      const opt = Array.from(rlTarget.options || []).find((o) => o.value === rlTarget.value);
      const say = this.shadowRoot.getElementById("rl-say");
      if (say) say.innerHTML = this._reqSay(false, this._reqLine.asked || "",
        rlTarget.value && opt ? String(opt.textContent || "").trim() : "the speaker");
      const go = this.shadowRoot.getElementById("rl-confirm");
      const d = this._liveData();
      if (go) go.disabled = !rlTarget.value || !!this._busy || !!this._stationBusy
        || !!d.legacy_station_active || d.state === "starting";
      this._render();
    });
    // The choose sheet's speaker. The station itself is the pressed tile.
    // As above, Start waits for a speaker in place while the list keeps
    // focus.
    const airTarget = this.shadowRoot.getElementById("air-target");
    if (airTarget) airTarget.addEventListener("change", () => {
      if (!this._liveForm) return;
      this._liveForm.target = airTarget.value;
      this._liveForm.confirm = false;
      this._liveForm.handover = null;
      this._liveForm.handoverPick = false;
      this._liveForm.handoverRemove = [];
      const go = this.shadowRoot.getElementById("air-go");
      if (go) go.disabled = !!this._busy || !!this._stationBusy || !airTarget.value;
      this._render();
    });
    this.shadowRoot.querySelectorAll("[data-spk]").forEach((cb) =>
      cb.addEventListener("change", () => this._toggleSpeaker(cb.dataset.spk, cb.checked)));
    on("spk-save", () => this._saveSpeakers());
    on("spk-reset", () => this._resetSpeakers());
    // the weather entity and the calendars: the same draft-then-Save shape
    this.shadowRoot.querySelectorAll("[data-weather]").forEach((rb) =>
      rb.addEventListener("change", () => { if (rb.checked) this._setWeatherDraft(rb.dataset.weather); }));
    this.shadowRoot.querySelectorAll("[data-cal]").forEach((cb) =>
      cb.addEventListener("change", () => this._toggleCalendarDraft(cb.dataset.cal, cb.checked)));
    on("wx-save", () => this._saveSources("weather"));
    on("wx-reset", () => this._resetSources("weather"));
    on("cal-save", () => this._saveSources("calendars"));
    on("cal-reset", () => this._resetSources("calendars"));
    // A route to another Parlorwave screen is a jump, not a link: it moves
    // this panel rather than reloading Home Assistant around it.
    this.shadowRoot.querySelectorAll("[data-goto]").forEach((b) =>
      b.addEventListener("click", () => {
        // Booth's doors to Settings are about its optional services, which
        // live in Extras: arriving from there opens it.
        if (this._view === "booth" && b.dataset.goto === "settings") this._extrasOpen = true;
        // A door that names a spot on the screen it opens (the calendars
        // in Settings, from the Station tab) lands focus there.
        if (b.dataset.gotoFocus) this._focusNext = { f: b.dataset.gotoFocus };
        this._view = b.dataset.goto;
        if (this._view === "newsroom") this._maybeRefreshDemandData();
        if (this._view === "station") this._maybeRefreshDemandData();
        if (this._view === "onair") this._rehydrateOnAir();
        this._maybeRefreshWaveform();
        this._render();
      }));
    const sched = this.shadowRoot.getElementById("news-schedule");
    if (sched) sched.addEventListener("change", () => {
      this._newsEdit("target_minute", Number(sched.value));
      this._render();
    });
    // The two text boxes keep their value in STATE, never in the DOM: the
    // Newsroom re-reads itself every 20 seconds, and a poll landing between
    // two keystrokes must not put the stored value back under the cursor.
    for (const [id, key] of [["news-name", "source_name"], ["news-url", "feed_url"]]) {
      const input = this.shadowRoot.getElementById(id);
      if (!input) continue;
      input.addEventListener("input", () => {
        this._newsEdit(key, input.value);
        const save = this.shadowRoot.getElementById("news-save");
        if (save) save.disabled = false;
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); input.blur(); this._saveNews(); }
      });
    }

    const file = this.shadowRoot.getElementById("create-file");
    if (file) file.addEventListener("change", () => {
      if (!this._create) return;
      this._chooseFile((file.files && file.files[0]) || null);
    });
    // The microphone for the next Record (kept for the page; see BOOTH_SESSION).
    const device = this.shadowRoot.getElementById("rec-device");
    if (device) device.addEventListener("change", () => {
      BOOTH_SESSION.micDeviceId = device.value || "";
    });
    // Put the lyric pane back where it was and re-mark the current line.
    // Nothing here scrolls the page: one element's scrollTop is assigned.
    this._restoreLyricScroll();
    // And the Break History list, for the same reason.
    this._restoreHistoryScroll();
    // The Mouth binds to the canvas this render produced, or stops when
    // there is none (another screen). Never more than one loop.
    this._mouthStart();
    this._bindKnobControls();
    this._fitCenterBadge();
    this._fitDeckPlate();
    // A knob that had keyboard focus keeps it across the rebuild, so arrow
    // keys and the selector keep working and a screen reader hears the
    // knob's new name.
    if (knobFocus) {
      const k = this.shadowRoot.getElementById(knobFocus);
      if (k && typeof k.focus === "function") {
        try { k.focus({ preventScroll: true }); } catch (_) { /* best effort */ }
      }
    }
    const nextFocus = this._focusNext;
    this._focusNext = null;
    if (!knobFocus && (nextFocus || keptFocus)) this._focusByKey(nextFocus || keptFocus, !nextFocus);
    // What the steps above wrote (the badge fitted, the Mouth's canvas sized,
    // focus put back) is part of this render, not a change made to it.
    this._settleTree();
  }

  _settleTree() {
    if (this._treeObserver) this._treeObserver.takeRecords();
    this._treeDirty = false;
  }

  /* --- Rotary Knob Controllers & Gesture Physics -------------------------
   * Both knobs: an invisible halo about 1.6x the knob takes the
   * pointer (.knob-halo); a press travelling more than
   * KNOB_DRAG_DEAD_ZONE_PX is a TURN and never also a push; a turn is
   * circular when it starts out at the rim and runs round the knob, else
   * linear (right and up are more); letting go of a turn lets go of the
   * knob; one pointer per gesture; a cancelled touch is never a push.
   * Left Knob (Volume / DJ Power):
   *   - Drag, wheel, or arrows/Page keys when focused: volume, from the level
   *     last asked for, with the LCD's readout
   *   - 1 Click: engages sticky turning (the pointer turns it until Escape,
   *     a click elsewhere or another push)
   *   - 2 Clicks, or Enter/Space: toggles the between-song DJ
   * Right Knob (Dial / Speaker Select):
   *   - Turn (drag, wheel, arrows when focused): ALWAYS the Dial (an empty
   *     one says so); inside the speaker list, browses the list
   *   - 2 Clicks, or Enter/Space: opens the speaker list
   *   - Inside the list: ONE click (or Enter) confirms, except the clicks of
   *     the run that opened it; Escape cancels; 5 s idle closes it unchanged
   *   - 1 Click outside the list: the Dial's push, or sticky turning
   */
  _bindKnobControls() {
    const leftBtn = this.shadowRoot.getElementById("dj-switch");
    const rightBtn = this.shadowRoot.getElementById("right-knob");

    if (this._knobWindowCleanup) {
      this._knobWindowCleanup();
      this._knobWindowCleanup = null;
    }

    if (!leftBtn && !rightBtn) return;

    const setupKnob = (btn, which) => {
      if (!btn) return;

      btn.addEventListener("click", (e) => {
        if (e.detail === 0 && e.clientX === 0 && e.clientY === 0) return;
        if (!e.__pw_dispatch) {
          e.stopImmediatePropagation();
          e.preventDefault();
        }
      }, true);

      // Keyboard focus is a first interaction too; a mouse press says it
      // from pointerdown below.
      btn.addEventListener("focus", () => {
        let keyboard = false;
        try { keyboard = !!(btn.matches && btn.matches(":focus-visible")); } catch (_) { keyboard = false; }
        if (keyboard) this._knobHint(which);
      });

      btn.addEventListener("wheel", (e) => {
        e.preventDefault();
        const delta = -Math.sign(e.deltaY || e.deltaX);
        if (which === "left") {
          // From the level last asked for, not the last report: _holdVolume.
          this._knobVolumeTo(this._volumeBase() + delta * KNOB_WHEEL_VOLUME_STEP);
        } else {
          this._rightKnobAngle = (this._rightKnobAngle || 0) + delta * KNOB_WHEEL_ANGLE_DEG;
          const face = btn.querySelector(".knob-face");
          if (face) face.style.transform = `rotate(${this._rightKnobAngle}deg)`;
          if (this._mouth && this._mouthVisual === "dial") this._mouthDraw(this._mouth.tSec || 0);
          this._pulseKnobIndicator("right");
          if (this._outputMode) {
            if (delta > 0) this._nextOutput(); else if (delta < 0) this._prevOutput();
          } else if (delta) {
            this._stationStep(delta > 0 ? 1 : -1);
          }
        }
      }, { passive: false });

      btn.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        this._knobHint(which);
        // ONE pointer per gesture: a second finger on the other knob is its
        // own gesture and never moves this one.
        const pid = e.pointerId;
        const same = (ev) => pid == null || !ev || ev.pointerId == null || ev.pointerId === pid;
        const startX = e.clientX;
        const startY = e.clientY;
        let lastX = e.clientX;
        let lastY = e.clientY;
        let isDragging = false;
        let startAngle = which === "left" ? 0 : (this._rightKnobAngle || 0);
        let currentAngle = startAngle;
        let lastStepAngle = startAngle;

        // The knob's centre and radius, read once at the press, for a
        // circular turn. No geometry (a layout-less host): linear only.
        let centre = null;
        let radius = 0;
        try {
          const r = btn.getBoundingClientRect ? btn.getBoundingClientRect() : null;
          if (r && r.width > 0 && r.height > 0) {
            centre = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            radius = r.width / 2;
          }
        } catch (_) { centre = null; }
        let circular = false;
        let lastTheta = 0;

        // A press starts from what the knob shows, and a new press always
        // starts a new sticky baseline.
        let currentLevel = this._volumeBase();
        this._stickyPoint = null;

        const onMove = (ev) => {
          if (!same(ev)) return;
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (!isDragging && Math.sqrt(dx * dx + dy * dy) > KNOB_DRAG_DEAD_ZONE_PX) {
            isDragging = true;
            this._isDragging = true;
            this._knobTurning = which;
            if (which === "left") this._dropVolumeHold();   // the drag owns the level now
            btn.classList.add("knob-turning", "is-dragging");
            if (centre) {
              const rx = startX - centre.x;
              const ry = startY - centre.y;
              const r0 = Math.sqrt(rx * rx + ry * ry);
              if (r0 >= KNOB_CIRCULAR_MIN_RADIUS * radius && r0 > 0) {
                const radial = Math.abs((dx * rx + dy * ry) / r0);
                const around = Math.abs((dx * ry - dy * rx) / r0);
                circular = around > radial;
              }
              if (circular) lastTheta = Math.atan2(startY - centre.y, startX - centre.x);
            }
          }
          if (!isDragging) return;

          // Linear: right and up are more. Circular: clockwise is more, and
          // the face follows the pointer round exactly.
          let delta = 0;
          let turnDeg = 0;
          if (circular) {
            const theta = Math.atan2(ev.clientY - centre.y, ev.clientX - centre.x);
            turnDeg = (theta - lastTheta) * 180 / Math.PI;
            if (turnDeg > 180) turnDeg -= 360;
            if (turnDeg < -180) turnDeg += 360;
            lastTheta = theta;
          } else {
            delta = (ev.clientX - lastX) - (ev.clientY - lastY);
          }
          lastX = ev.clientX;
          lastY = ev.clientY;

          if (which === "left") {
            const step = circular ? turnDeg / KNOB_ANGLE_SWEEP_DEG : delta * KNOB_DRAG_VOLUME_PER_PX;
            currentLevel = Math.max(0, Math.min(1, currentLevel + step));
            this._paintVolume(currentLevel);
            this._throttledVolumeSet(currentLevel);
            this._pulseKnobIndicator("left");
          } else {
            currentAngle += circular ? turnDeg : delta * KNOB_TURN_DEG_PER_PX;
            this._rightKnobAngle = currentAngle;
            const face = btn.querySelector(".knob-face");
            if (face) face.style.transform = `rotate(${currentAngle}deg)`;
            if (this._mouth && this._mouthVisual === "dial") this._mouthDraw(this._mouth.tSec || 0);
            this._pulseKnobIndicator("right");

            if (this._outputMode) {
              if (currentAngle - lastStepAngle >= KNOB_DETENT_DEG) {
                this._nextOutput();
                lastStepAngle = currentAngle;
              } else if (currentAngle - lastStepAngle <= -KNOB_DETENT_DEG) {
                this._prevOutput();
                lastStepAngle = currentAngle;
              }
            } else if (Math.abs(currentAngle - lastStepAngle) >= KNOB_DETENT_DEG) {
              this._stationStep(currentAngle > lastStepAngle ? 1 : -1);
              lastStepAngle = currentAngle;
            }
          }
        };

        const stopListening = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUpEvent);
          window.removeEventListener("pointercancel", onCancel);
          btn.classList.remove("is-dragging");
          this._isDragging = false;
        };

        // A drag is a turn, and letting go lets go: the knob does not go on
        // turning with a pointer that is no longer holding it.
        const endDrag = () => {
          if (this._knobTurning === which) this._knobTurning = null;
          if (which === "left") {
            this._setVolume(currentLevel);
          } else {
            this._render();
          }
        };

        const onUp = () => {
          stopListening();

          if (isDragging) {
            endDrag();
            return;
          }

          this._knobClick(which);
        };
        const onUpEvent = (ev) => { if (same(ev)) onUp(); };
        // The browser took the gesture (a scroll begun on the halo's outer
        // ring, a system gesture): it ends here and is never a push.
        const onCancel = (ev) => {
          if (!same(ev)) return;
          stopListening();
          if (isDragging) endDrag();
        };

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUpEvent);
        window.addEventListener("pointercancel", onCancel);
      });
    };

    setupKnob(leftBtn, "left");
    setupKnob(rightBtn, "right");

    let lastGlobalX = null;
    let lastGlobalY = null;

    const onGlobalPointerMove = (ev) => {
      if (!this._knobTurning || this._isDragging) {
        lastGlobalX = ev.clientX;
        lastGlobalY = ev.clientY;
        this._stickyPoint = null;
        return;
      }
      if (this._knobTurning === "left") {
        // The left knob keeps its last point on the component, not in this
        // closure: every throttled volume write re-renders and rebinds, and
        // the move after it must still count. The first move after the
        // knob is engaged only sets the point, as it always has.
        const last = this._stickyPoint;
        this._stickyPoint = { x: ev.clientX, y: ev.clientY };
        lastGlobalX = ev.clientX;
        lastGlobalY = ev.clientY;
        if (!last) return;
        const delta = (ev.clientX - last.x) - (ev.clientY - last.y);
        if (!delta) return;
        // From the level last asked for, not the last report: _holdVolume.
        this._knobVolumeTo(this._volumeBase() + delta * KNOB_STICKY_VOLUME_PER_PX);
        return;
      }
      if (lastGlobalX == null || lastGlobalY == null) {
        lastGlobalX = ev.clientX;
        lastGlobalY = ev.clientY;
        return;
      }
      const dx = ev.clientX - lastGlobalX;
      const dy = ev.clientY - lastGlobalY;
      lastGlobalX = ev.clientX;
      lastGlobalY = ev.clientY;

      const delta = dx - dy;
      if (!delta) return;

      if (this._knobTurning === "right") {
        this._rightKnobAngle = (this._rightKnobAngle || 0) + delta * KNOB_TURN_DEG_PER_PX;
        const face = this.shadowRoot && this.shadowRoot.querySelector("#right-knob .knob-face");
        if (face) face.style.transform = `rotate(${this._rightKnobAngle}deg)`;
        if (this._mouth && this._mouthVisual === "dial") this._mouthDraw(this._mouth.tSec || 0);
        this._pulseKnobIndicator("right");

        if (this._outputMode) {
          const stepDelta = this._rightKnobAngle - (this._lastOutputStepAngle || 0);
          if (stepDelta >= KNOB_DETENT_DEG) {
            this._nextOutput();
            this._lastOutputStepAngle = this._rightKnobAngle;
          } else if (stepDelta <= -KNOB_DETENT_DEG) {
            this._prevOutput();
            this._lastOutputStepAngle = this._rightKnobAngle;
          }
        } else {
          if (this._lastStationStepAngle == null) this._lastStationStepAngle = this._rightKnobAngle;
          const stepDelta = this._rightKnobAngle - this._lastStationStepAngle;
          if (Math.abs(stepDelta) >= KNOB_DETENT_DEG) {
            this._stationStep(stepDelta > 0 ? 1 : -1);
            this._lastStationStepAngle = this._rightKnobAngle;
          }
        }
      }
    };

    const onGlobalClick = (ev) => {
      if (!this._knobTurning) return;
      const path = ev.composedPath ? ev.composedPath() : [];
      const onLeft = leftBtn && path.includes(leftBtn);
      const onRight = rightBtn && path.includes(rightBtn);
      if (!onLeft && !onRight) {
        this._knobTurning = null;
        this._render();
      }
    };

    const onGlobalKeyDown = (ev) => {
      if (ev.key === "Escape" && this._knobTurning) {
        this._knobTurning = null;
        this._render();
      }
    };

    window.addEventListener("pointermove", onGlobalPointerMove);
    window.addEventListener("click", onGlobalClick, true);
    window.addEventListener("keydown", onGlobalKeyDown);

    this._knobWindowCleanup = () => {
      window.removeEventListener("pointermove", onGlobalPointerMove);
      window.removeEventListener("click", onGlobalClick, true);
      window.removeEventListener("keydown", onGlobalKeyDown);
    };
  }
}

if (!customElements.get("parlorwave-radio-panel")) {
  customElements.define("parlorwave-radio-panel", ParlorwaveRadioPanel);
}
