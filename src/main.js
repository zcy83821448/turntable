import * as THREE from 'three';
import { createEnvironments } from './env.js';
import { createProbe } from './probe.js';
import { createRig, buildRigPanels, RIG, GAIN } from './lights.js';
import { createTurntable, DIM } from './turntable.js';
import { createSoftFloor } from './floor.js';
import { createLidMirror } from './lidmirror.js';
import { createComposer } from './post.js';
import { Orbit } from './controls.js';
import { clamp, damp, ease, Timeline } from './anim.js';
import * as TX from './textures.js';
import { TapeAudio } from './audio.js';
import { readTags, looksLikeAudio } from './tags.js';

const $ = (s) => document.querySelector(s);
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const canvas = $('#gl');

/* ============================== nothing changes in one frame ==============
   Two helpers, and between them every read-out on this page changes the way
   everything else does — by moving. Both are here, at the top, because the boot
   sequence writes labels before the rest of the module exists.

   swapText is for words: 走带 ／ 暂停, 读取整机 ／ 读取磁带, the vantage's name, the
   model plate on the masthead, the track in the chip. Assigning textContent
   replaces the glyphs between two frames, which is a cut; so the outgoing word
   leaves upward, the incoming one arrives from below, and a swap that arrives
   mid-flight only moves the target — holding — walks the read-out without it
   flickering. Falls through to a plain write for the very first value and under
   prefers-reduced-motion.

   setRoll is for numbers: the counter, the clock, the deck's numeral, the volume
   readout, the dial. The text is built once as one cell per character and only
   the characters that changed move — the old digit rises out of the cell while
   the new one rises in from underneath, which is what a tape counter does. The
   cells are right-aligned, so a read-out that gains a digit (`0%` → `100%`) gains
   a cell rather than being rebuilt, and the ones place never moves. Tabular
   figures mean the cell is the same width before and after anyway.

   Both drive the Web Animations API rather than CSS classes: replaying a class
   animation needs the class removed, a reflow forced and the class re-added, and
   this runs once a second for the life of the page. */
const RISE = { duration: 300, easing: 'cubic-bezier(.16, 1, .3, 1)' };
const LEAVE = { duration: 150, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' };
const FROM_ABOVE = [{ opacity: 0, transform: 'translateY(.5em)' }, { opacity: 1, transform: 'none' }];
const TO_ABOVE = [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-.5em)' }];
const FROM_BELOW = [{ opacity: 0, transform: 'translateY(.72em)' }, { opacity: 1, transform: 'none' }];
const TO_ABOVE_CELL = [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-.72em)' }];

function swapText(el, text) {
  if (!el) return;
  text = String(text);
  if (el.__t === text) return;
  const seed = el.__t === undefined;
  el.__t = text;
  if (seed || reduce) { el.textContent = text; return; }
  if (el.__leaving) return;             // already on its way out; __t holds the latest
  el.__leaving = true;
  const out = el.animate(TO_ABOVE, LEAVE);
  /* Arriving is a timer's job, not the animation's `finish` event. A stalled or
     throttled animation clock — a backgrounded tab, a machine in low-power mode,
     a headless renderer — would otherwise leave the label showing its old word
     for good, and a read-out that lies is worse than one that cuts. The
     movement is decoration; the arrival is the contract. */
  clearTimeout(el.__swapT);
  el.__swapT = setTimeout(() => {
    el.__leaving = false;
    // the fill has to go before the new text is written, or its forwards fill
    // would still be holding opacity 0 under the incoming animation
    out.cancel();
    el.textContent = el.__t;
    el.animate(FROM_ABOVE, RISE);
  }, LEAVE.duration);
}

/** The in-only variant, for a read-out that is rewritten faster than a two-part
    swap can finish — the loader's status line, which changes once per boot step.
    Every value arrives with motion and none of them is ever dark, which is the
    one case where a two-part swap would be worse than useless: with steps a frame
    apart the outgoing half never gets to finish, and the line would sit at
    opacity 0 for the whole load. */
function riseText(el, text) {
  if (!el) return;
  text = String(text);
  if (el.__r === text) return;
  const seed = el.__r === undefined;
  el.__r = text;
  el.textContent = text;
  if (seed || reduce) return;
  el.animate(FROM_ABOVE, RISE);
}

function setRoll(el, text) {
  if (!el) return;
  text = String(text);
  if (el.__v === text) return;
  const seed = el.__v === undefined;
  el.__v = text;
  let cells = el.__cells;
  if (!cells) {
    el.textContent = '';
    cells = el.__cells = [];
  }
  while (cells.length < text.length) {
    const c = document.createElement('span');
    c.className = 'od';
    c.append(document.createElement('b'), document.createElement('b'));
    el.append(c);
    cells.push(c);
  }
  // right-aligned: growing a digit adds a cell on the left, so the ones place —
  // and everything to the right of it — never moves
  const off = cells.length - text.length;
  for (let i = 0; i < cells.length; i++) {
    const ch = i < off ? '' : text[i - off];
    const c = cells[i];
    if (c.__c === ch) continue;
    const old = c.__c ?? '';
    c.__c = ch;
    c.lastElementChild.textContent = old;
    c.firstElementChild.textContent = ch;
    if (seed || reduce || !old || !ch) continue;
    c.lastElementChild.animate(TO_ABOVE_CELL, RISE);
    c.firstElementChild.animate(FROM_BELOW, RISE);
  }
}

/* ============================== theme presets ============================ */
const THEMES = {
  noir: {
    env: 'noir', hal: 0.072, ao: 1.0,
    grade: { bloom: 0.32, ca: 0.85, grain: 0.050, vig: 0.85, sat: 1.0, edge: 1.0, focus: 0.26 },
    bg: {
      stops: [[0, '#12151a'], [0.44, '#1e232a'], [0.64, '#0d1014'], [1, '#040507']],
      spot: { u: 0.849, v: 0.48, r: 0.40, color: 'rgba(140,162,200,0.75)' },
    },
    floor2: 0x101317, floorMix: 0.60, shadowOp: 0.44,
    pool: 0xff8a3c, poolOp: 0.09,
  },
  studio: {
    env: 'studio', hal: 0.020, ao: 0.92,
    grade: { bloom: 0.32, ca: 0.85, grain: 0.050, vig: 0.85, sat: 1.0, edge: 1.0, focus: 0.26 },
    /* The room the lid has to be seen against.
     *
     * This was calibrated as a bright studio — mid grey at the top of the dome
     * to near-white along the bottom — and a clear acrylic lid over a cream deck
     * against an equally bright wall has nothing to be seen *by*. At
     * `transmission: 1` with no tint, the glass is only ever its own rim and the
     * softboxes it mirrors; in noir that is plenty, because the room is dark and
     * the strips are hard, but here every surface in frame sat within a couple of
     * stops of every other one and the lid simply vanished. So the room came down
     * until the deck had something to stand against — the stops below are the old
     * ones at 0.62, the floor with them, and the spot that stands in for the
     * softbox glow with them. */
    bg: {
      stops: [[0, '#5f6368'], [0.46, '#787b80'], [0.78, '#86878a'], [1, '#909294']],
      spot: { u: 0.849, v: 0.48, r: 0.44, color: 'rgba(255,255,255,0.34)' },
    },
    floor2: 0x60646a, floorMix: 0.38, shadowOp: 0.26,
    pool: 0xffffff, poolOp: 0.04,
  },
};
for (const T of Object.values(THEMES)) {
  T.cFloor2 = new THREE.Color(T.floor2);
  T.cPool = new THREE.Color(T.pool);
}
let themeName = 'studio';

/* ============================== renderer ================================= */
let renderer;
try {
  /* `antialias: false`, and the image is identical. Everything the page draws goes
     through the composer, and the last pass writes one full-screen quad to the
     canvas — every canvas pixel is therefore written exactly once per frame, so
     the default framebuffer's MSAA has nothing to resolve and costs a 4× buffer
     plus a resolve at presentation. The beauty pass keeps its own 4× target (see
     post.js); this is only the window's back buffer. */
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
} catch (err) {
  document.body.innerHTML = '<p style="color:#eee;font:14px/1.6 system-ui;padding:3rem">当前浏览器无法初始化 WebGL，请使用 Chrome / Edge 打开。</p>';
  throw err;
}
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setSize(innerWidth, innerHeight, false);
renderer.toneMapping = THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
/* The dust cover is a transmission material, and three renders one extra pass of
   the scene for it at this fraction of the viewport. Full resolution, and that is
   not the default worth shaving: at half, everything seen through the lid comes
   back soft, and softness through glass reads as *frosted*, not as thick. It was
   the difference between a block and a sheet of tracing paper. The mirror pass
   does not pay this either way — it takes the lid's flat stand-in, see
   useCheapGlass. */
renderer.transmissionResolutionScale = 1;

const scene = new THREE.Scene();
/* The frame draws the scene several times (probe, floor mirror, lid mirror,
   beauty), and three brings the scene graph up to date at the top of every one of
   those calls. Nothing moves between them, so the work is done once, by hand, at
   the end of `loop` — see the note there. The boot steps call it explicitly too,
   because the probe's photograph and the warm-up frames have to see a settled
   graph. */
scene.matrixWorldAutoUpdate = false;
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 1, 220);

/* ============================== studio set =============================== */
const backdropMaps = {};
let backdrop;
{
  const g = new THREE.SphereGeometry(70, 32, 24);
  backdrop = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.BackSide, depthWrite: false }));
  backdrop.frustumCulled = false;
  scene.add(backdrop);

  /* The room's background is a baked texture with no in-between, and it is the
     largest single surface in the frame — 暗房 is near black and 影棚 pale grey,
     so cutting the map was the loudest thing in the whole transition.
     *
     * That used to be carried by a *second, transparent* shell stacked over this
     * one, let in by its opacity. It cannot be, and the reason is worth writing
     * down because it only shows on one surface. three's transmission pass does
     * not render transparent objects: `renderTransmissionPass` draws the opaque
     * list and nothing else. The lid is `transmission: 1`, so everything it shows
     * *behind itself* comes from that opaque-only render — which means the
     * transparent shell was invisible to the glass for the whole cross-fade. The
     * opaque base had already been handed the incoming room, so through the lid
     * the room changed at the handover frame while every opaque surface saw a
     * blend across the probe. That is a reflection-content step on the one
     * surface that is almost pure transmission, and it is exactly the "lid
     * changes colour once the transition has finished" that was reported.
     *
     * So the cross-fade happens *inside one opaque material* instead: the map
     * chunk is patched to mix the outgoing and incoming rooms by the theme
     * clock. One opaque mesh means the transmission pass, the probe and the
     * background all see the same blend, so there is nothing left to be
     * discontinuous at the handover.
     *
     * `onBeforeCompile` rather than a hand-written ShaderMaterial, deliberately:
     * MeshBasicMaterial's program carries three's tone mapping and colour-space
     * chunks, and dropping them would put the room through no tone curve at all.
     * Patching the map chunk touches map sampling and nothing else.
     *
     * The two ends of the mix live on the *material*, not on the shader object,
     * and that is the whole reason this renders at all. three's `getProgram`
     * attaches `shader.uniforms` to the program on the compile where
     * `onBeforeCompile` actually runs, and on no other. A material with a map is
     * recompiled the first time that map is swapped — the boot `setTheme` hands
     * over the real room, which is not the map the material was built with — and
     * the second compile used to be skipped by an "already patched" guard. That
     * left the program declaring `tBackA` with no uniform value behind it, and
     * three skips a uniform it has no cached value for, so the sampler was never
     * bound: it read whatever texture unit 0 happened to hold, which is the
     * magenta room. Material uniforms are merged into the program on *every*
     * compile, so the guard can go and the patch is idempotent by construction. */
  const backUniforms = {
    tBackA: { value: null },                      // where the room is coming from
    tBackB: { value: null },                      // where it is going
    uBackMix: { value: 1 },                       // 1 = settled: B is the room on screen
  };
  backdrop.material.uniforms = backUniforms;
  backdrop.material.onBeforeCompile = (shader) => {
    const m = backdrop.material.map;
    backUniforms.tBackA.value = m;
    backUniforms.tBackB.value = m;
    if (shader.uniforms) {
      shader.uniforms.tBackA = backUniforms.tBackA;
      shader.uniforms.tBackB = backUniforms.tBackB;
      shader.uniforms.uBackMix = backUniforms.uBackMix;
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nuniform sampler2D tBackA;\nuniform sampler2D tBackB;\nuniform float uBackMix;')
      .replace('#include <map_fragment>', /* glsl */`
        #ifdef USE_MAP
          /* No colour-space decode here, deliberately. three r180 never decodes
             the map in the fragment shader: an sRGB texture is uploaded as
             SRGB8_ALPHA8 and the hardware hands back linear, which is why the
             stock map chunk is a bare texture2D and does not use the
             sRGBTransferEOTF it sits next to. Adding one here would decode a
             value that is already linear. */
          vec4 sampledDiffuseColor = mix(
            texture2D( tBackA, vMapUv ), texture2D( tBackB, vMapUv ), uBackMix );
          diffuseColor *= sampledDiffuseColor;
        #endif
      `);
  };
  backdrop.userData.mix = 1;
}
/* `interval: 2` is the mirror's documented behaviour — the reflection is
   blurred by design and the floor under it is dark, so on a still camera an
   alternate-frame refresh is invisible and halves a whole extra scene render.
   A moving camera forces every frame (see the loop's camMoved), and anything
   the mirror actually shows moving — the drift, the reels — is either slower
   than a texel a frame or behind the smoke glass. */
const floorBase = createSoftFloor({ base: 0x0b0c0e, mix: 0.62, y: -1.62, interval: 2 });
scene.add(floorBase.mesh);
/* The lid's planar reflection. Full resolution and every frame, which is the
   opposite of every other judgement call on this page — the floor is 0.6 res on
   alternate frames because its reflection is blurred by design, and this one is
   not: it is seen through 3mm of glass at roughness 0.03, so it has to be sharp.
   See lidmirror.js for why a cube probe could not do this at all. */
const lidMirror = createLidMirror(renderer, { width: innerWidth, height: innerHeight });
const shadowCatcher = new THREE.Mesh(
  new THREE.PlaneGeometry(46, 46),
  new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.42, transparent: true, depthWrite: false })
);
shadowCatcher.rotation.x = -Math.PI / 2;
shadowCatcher.position.y = -1.612;
shadowCatcher.receiveShadow = true;
shadowCatcher.renderOrder = 2;
scene.add(shadowCatcher);
const poolMat = new THREE.MeshBasicMaterial({
  map: TX.radialTexture(512, { inner: 'rgba(255,255,255,1)', color: '255,255,255', p: 0.18 }),
  color: 0xff8a3c, transparent: true, opacity: 0.2,
  blending: THREE.AdditiveBlending, depthWrite: false,
});
const pool = new THREE.Mesh(new THREE.CircleGeometry(9, 48), poolMat);
pool.rotation.x = -Math.PI / 2;
pool.position.y = -1.60;                 // the floor's rest height, +0.02
pool.renderOrder = 3;
scene.add(pool);

const FLOOR_Y = -1.62;
/* ============================== dust ====================================
 * There was a dust column here — two additive point clouds, 290 motes, drifting
 * up through the volume the machine sits in — and it is gone by choice, so it is
 * worth writing down what it cost, because the numbers are why the choice was
 * easy. From the close stop (radius 9.5, the lens inside the column) it was
 * 0.8 ms of a 2.1 ms frame: the largest single item in the frame, and it got
 * there by drawing the motes around the lens as bokeh discs the size of the
 * screen. At every other framing it was worth about nothing in time and was
 * subtle enough that nobody would name its absence. The alternative was to fade
 * it out as the lens came in — keep it in the wide shots, stop paying where it is
 * useless — and the call was to drop it outright instead.
 *
 * What went with it: the two `Points`, their per-frame drift and wrap-fade, the
 * `dust` opacity in the theme presets, and `dustSprite` in textures.js. */

/* ============================== model =================================== */
let cas = null, envs = null, rig = null, composer = null, grade = null, bloom = null;
let probe = null, rigPanels = null, probeBound = false;
/* hoisted: the lid's probe is re-placed every frame and a fresh Box3 per frame
   is garbage for no reason */
const _lidBox = new THREE.Box3(), _lidCentre = new THREE.Vector3();

/* Handling the model is a detour, not a destination: five seconds after the last
   drag or zoom the camera eases back to the framing the panel says it is on —
   the vantage you last chose, or the record's own view if one is open. Without
   it a stray drag leaves the tape at whatever three-quarter angle you let go of,
   and the read-out down the side keeps naming a vantage the lens has left. The
   timer is armed only by *manual* handling; anything the app does itself (arrows,
   a record, the double-click home) already ends on a framing, so it
   disarms instead. 巡览 beats it: with the model turning by itself there is
   nothing to return to. */
const HOME_DELAY = 5.0;
let homeArmed = false;
function armHome() { if (!autoRotate) homeArmed = true; }
function goHome() {
  homeArmed = false;
  orbit.setPreset(vi >= 0 ? VANTAGES[vi].v : cur().view, false);
  if (orbit.tween) orbit.tween.dur = 1.6;
}
/* The two heights the aim's far end takes: 3.5 is the calibrated value for the
   open cover, and 1.3 is the shut cover's own top — once the lid is down there is
   nothing above the deck left to clear, so the camera can come down and let the
   machine sit where it belongs in the frame. */
const AIM_LID_OPEN = 3.5;
const AIM_LID_SHUT = 1.3;

const orbit = new Orbit(canvas, camera, {
  theta: 1.18, phi: 1.34, radius: 40, target: new THREE.Vector3(0, 3.5, 0),  /* The two ends of the aim curve (see Orbit.apply). nearAim is the record's own
     centre — measured, not assumed, because the record does not sit on the orbit
     axis; farAim is the middle of the whole machine with the lid open, measured
     at 3.5, which is what brings the lid inside the top edge at the isometric
     vantage. With an aim on the deck's top face the lid overflowed by 0.30 NDC,
     and raising the *camera* instead (lower phi) made that monotonically worse:
     1.2994 at phi 1.03, 1.3479 at 0.95, 1.3817 at 0.88, 1.4395 at 0.70. Where the
     axis points is the lever, not how high the camera is.
     farAim's height is not a constant though: it exists to clear the open cover,
     and a shut cover reaches barely above the deck, so holding the camera up
     there for it frames empty air and shoves the machine down the screen. The
     frame loop drives its y from the cover's own position — see AIM_LID_*. */
  nearAim: new THREE.Vector3(-0.824, 0.40, -0.228),
  farAim: new THREE.Vector3(0, AIM_LID_OPEN, 0),
  aimNearR: 18, aimFarR: 33,
  minR: 11, maxR: 52, minPhi: 0.16, maxPhi: 1.52,
  auto: false,
  reduce,
  onInteract: (dragging) => {
    document.body.classList.toggle('dragging', dragging);
    document.body.classList.add('moved');
    // the countdown starts when the hand comes off, not when it lands
    if (!dragging) armHome();
  },
  onManual: armHome,
  onReset: () => {
    // the double-click home *is* VANTAGES[0], so the panel follows the camera
    // back to the first vantage. Without this it keeps showing 04 / MACRO and
    // keeps the dossier narrowed for a lens that is no longer close in.
    vi = 0;
    homeArmed = false;
    render();
  },
});
/* the tape is ~9.6 units across, so the framing wants the lens well back of the
   old product-shot distance — at 18 units the subject alone filled the frame and
   there was no room left for the panel down the right-hand side */
orbit.home = { theta: 0.62, phi: 1.03, radius: 33 };

const audio = new TapeAudio();

/* ============================== the tape's music ========================= */
/* What is inside the shell is whatever was put there last: ADD MUSIC (or a file
   dropped on the page, or O) hands it a track. The three lines the README used to
   ask for by hand — title, artist, album — come off the file's own ID3 tags
   instead, and the label on the cassette is rewritten to match (see applyTrack).

   This page now ships with *no track*. It used to boot with one — a real record,
   with a real artist printed on its label — and that is someone's music, which
   does not belong in a repository or on a page anyone can open. So the file is not
   in the tree, the defaults below carry none of its names, and `src` is empty:
   the transport still runs and the deck still turns, with a tape that is not there
   until the visitor drops one in. Nothing about the animation depends on it. */
const TRACK_DEFAULT = {
  title: '未载入曲目',
  artist: 'ADD MUSIC 载入',
  album: '—',
  src: '',
  file: null,
};
const TRACK = { ...TRACK_DEFAULT };
/* the blob URL of the track the user added, so the next one can let it go */
let objUrl = null;
const audioEl = $('#tape-audio');
let mode = 'idle';          // idle | play | rew
let muted = false;
/* The music's own level, and the only thing the wheel over the speaker changes.
   It used to be whatever the <audio> element defaults to — 1.0 — with the tape
   bed ducked to 0.30 to compensate; now the music sits at 0.10 to begin with and
   the bed keeps its own mix, which is what a transport actually does. */
let volume = 0.10;
const VOL_STEP = 0.05;
/* The tape bed is mixed *against* the music — 0.30 against a full-scale track is
   the balance that was tuned by ear — so it has to follow the wheel as well, or
   turning the music down would leave the hiss sitting on top of it. Muting still
   leaves the machine audible: that is the point of that state, and the one place
   the bed is set on its own. (Declared up here because ?p=1 reaches togglePlay
   during module evaluation, long before the rest of the volume wiring exists.) */
const bedLevel = () => (prefs.hiss ? (muted ? 0.45 : 0.30 * volume) : 0);
const audioOk = () => audioEl.readyState >= 2 && isFinite(audioEl.duration) && audioEl.duration > 0;

/* ============================== putting a track in =======================
   A label is a baked texture and pointing a material at a new one is a step, so
   a swap is not a swap: it is a *rewrite*. The incoming print is drawn onto the
   copy of the plate the write head carries (see cassette.js), the head crosses
   the card over SWAP_DUR, and only then does the plate itself take the new map
   (updateLabelSwap below).

   Everything the page says about the track changes on that last frame and not
   one frame sooner — the handwriting on the label, its MINUTES caption, the
   badge on the masthead, the chip in the middle, the two counters down in the
   corner, the tab's own title. That is why the new duration is held here rather
   than going straight to the cassette: it is the one piece of the change the
   browser hands over several hundred milliseconds *before* the print does.
   ======================================================================== */
const SWAP_DUR = 1.2;
const swap = { state: 'idle', p: 0, press: 0, neu: null, old: null, dur: 0, play: false, meta: null };
/* Every load carries a ticket. A load spends a few hundred milliseconds waiting
   on the media element, and REINITIALIZE can land inside that window — without
   this the load would come back from the await and print itself over the reset
   that just cancelled it. */
let loadSeq = 0;
const brandCode = $('#brand-code');
/* what the transport is actually holding, for the failure message: TRACK only
   catches up at the end of a swap, and by then the error has been reported */
let currentName = TRACK_DEFAULT.src;
let audioFailed = false;

const tapeMinutes = (dur) => String(clamp(Math.round(dur / 60), 1, 99)).padStart(2, '0');

/** the transport's read-out: the total is however long the loaded audio is */
function setDur() {
  const d = audioEl.duration;
  if (!isFinite(d) || d <= 0) return;
  // mid-swap the plate still reads the old length; land the new one with the print
  if (swap.state !== 'idle') { swap.dur = d; return; }
  cas.st.duration = d;
}
function setNowChip() {
  swapText($('#now-title'), TRACK.title);
  const credits = [TRACK.artist, TRACK.album].filter(Boolean).join(' · ');
  swapText($('#now-sub'), audioFailed ? '音频加载失败 · 仅转盘动画' : (credits || '未知曲目'));
}

/** the file's own length as a promise — the media element is the only thing that
    knows it. 2.5 s is generous for a local blob and short enough that a file the
    browser cannot decode does not leave the button stuck. */
function whenPlayable() {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(ok, 2500);
    function cleanup() {
      clearTimeout(timer);
      audioEl.removeEventListener('loadedmetadata', ok);
      audioEl.removeEventListener('durationchange', ok);
      audioEl.removeEventListener('error', bad);
    }
    function finish(v) { if (done) return; done = true; cleanup(); resolve(v); }
    function ok() { finish(isFinite(audioEl.duration) && audioEl.duration > 0 ? audioEl.duration : 0); }
    function bad() { finish(0); }
    audioEl.addEventListener('loadedmetadata', ok);
    audioEl.addEventListener('durationchange', ok);
    audioEl.addEventListener('error', bad);
    if (audioEl.readyState >= 1) ok();
  });
}

/** The one way a track gets into the shell. The audio element is switched first,
    so the metadata is already on its way while the tags are read; the rewrite
    then waits for a length, because a card printed with the previous track's
    minutes is a lie for exactly as long as the browser takes to answer. */
async function applyTrack({ title, artist, album, src, file }) {
  const seq = ++loadSeq;
  const stale = objUrl;
  objUrl = src.startsWith('blob:') ? src : null;
  const short = file?.name || src;
  currentName = short;

  if (cas.st.playing) togglePlay(false);      // the tape that was playing is gone
  mode = 'idle';
  document.body.classList.remove('rewinding');
  audioEl.pause();
  /* No track, no load: assigning an empty `src` fires the element's own error, and
     the page would greet every visitor with "audio failed" for a track it never
     had. Empty means the tape is simply not there, and everything else runs. */
  if (src) {
    audioEl.src = src;
    audioEl.load();
    audioEl.currentTime = 0;
  }
  cas.setProgress(0);                         // and it sits at the head again
  document.body.classList.remove('no-audio');
  audioFailed = false;
  if (stale && stale !== src) URL.revokeObjectURL(stale);

  swap.meta = { title, artist, album, src, file };
  swap.state = 'arming';
  swap.dur = 0;
  const dur = await whenPlayable();
  if (seq !== loadSeq) return;                // a reset overtook this load

  /* drawn here, on a still frame: two 2048px canvases are the one expensive part
     of a swap, and a hitch before anything moves reads far better than a hitch
     in the middle of a sweep */
  const staged = cas.setLabel({ title, artist, album, minutes: dur > 0 ? tapeMinutes(dur) : '--' });
  swap.neu = staged.neu;
  swap.old = staged.old;
  cas.sweepLabel(0);                          // parked off the leading edge
  audio.clunk(0.9);                           // the head comes down on the tape
  swap.p = 0;
  swap.state = 'sweep';
}

/** the write head crossing the card — cassette.js owns what the numbers mean */
function updateLabelSwap(dt) {
  // the light runs on its own clock and outlives the sweep, so this is ticked
  // before the state check rather than under it
  cas.stepHead(dt);
  if (swap.state !== 'sweep') return;
  swap.p = Math.min(1, swap.p + dt / SWAP_DUR);
  const k = ease.inOut(swap.p);
  cas.sweepLabel(k);
  // the machine takes the load: pressed down under the head, up again after it
  swap.press = Math.sin(Math.PI * k) * 0.10;
  if (swap.p >= 1) settleSwap();
}

function settleSwap() {
  swap.state = 'idle';
  swap.press = 0;
  cas.commitLabel();
  // The plates' ghost copies hold the maps that are about to go — move them off
  // first, or a part caught mid-ghost keeps sampling a disposed texture.
  for (const e of ghosts) {
    const i = swap.old.indexOf(e.m.map);
    if (i >= 0) e.m.map = swap.neu[i];
  }
  for (const t of swap.old) t.dispose();
  swap.neu = swap.old = null;

  Object.assign(TRACK, swap.meta);
  swap.meta = null;
  // no duration (a file the browser cannot decode) leaves the total where it
  // was, and the card keeps the '--' it was printed with
  if (swap.dur > 0) {
    cas.st.duration = swap.dur;
    swapText(brandCode, 'RD—' + tapeMinutes(swap.dur));
  }
  setNowChip();
  flashAdd(null);
  // a play pressed while the head was moving waits for the tape, not the tape bed
  if (swap.play) { swap.play = false; togglePlay(true); }
}

/** the track that was loading is dropped without being read: nothing was ever
    printed with it, so there is nothing to put back */
function cancelSwap() {
  loadSeq++;                                  // ...and any load still waiting bails
  swap.state = 'idle';
  swap.press = 0;
  swap.meta = null;
  swap.dur = 0;
  swap.play = false;
  if (swap.neu) for (const t of swap.neu) t.dispose();
  swap.neu = swap.old = null;
  cas.warmLabel(false);
}

/** REINITIALIZE puts the shipped record back, print and all. No sweep: this
    button *is* the reset, and a reset that eases into place is not a reset. */
function reinitTrack() {
  if (swap.state !== 'idle') cancelSwap();
  if (objUrl) { URL.revokeObjectURL(objUrl); objUrl = null; }
  const T = TRACK_DEFAULT;
  currentName = T.src;
  audioEl.pause();
  if (T.src) {                                // same guard as applyTrack: no track, no load
    audioEl.src = T.src;
    audioEl.load();
    audioEl.currentTime = 0;
  }
  cas.setProgress(0);
  audioFailed = false;
  Object.assign(TRACK, T);
  const staged = cas.setLabel({ title: T.title, artist: T.artist, album: T.album, minutes: '05' });
  for (const e of ghosts) {
    const i = staged.old.indexOf(e.m.map);
    if (i >= 0) e.m.map = staged.neu[i];
  }
  cas.commitLabel();
  for (const t of staged.old) t.dispose();
  cas.warmLabel(false);
  swapText(brandCode, 'RD—05');
  setNowChip();
  swap.dur = 0;
}

/* deep-linkable state:  ?v=front&f=1&t=studio&p=1&ui=0&intro=0 */
const Q = new URLSearchParams(location.search);
/* `camera` is false while the intro is going to play. The intro *is* a camera
   move, so landing the URL's vantage on top of it cancels the whole thing —
   ?intro=1&r=03 should still open record 03, it just shouldn't grab the lens.
   Everything else in the query applies either way. */
function applyQuery(camera = true) {
  if (Q.get('ui') === '0') document.querySelector('.ui').style.display = 'none';
  if (Q.get('fps') === '1') {
    perfEl = document.createElement('div');
    perfEl.style.cssText = 'position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:99;font:11px/1.4 Consolas,monospace;letter-spacing:.08em;color:#8dffb0;background:rgba(0,0,0,.55);padding:3px 10px;border-radius:99px';
    document.body.appendChild(perfEl);
  }
  if (Q.has('t')) setTheme(Q.get('t'), true);
  // through VANTAGES rather than a private table, so ?v=detail lands in the
  // same state as clicking there — including the panel narrowing itself
  const vk = camera && Q.has('v') ? VANTAGES.findIndex((x) => x.k === Q.get('v')) : -1;
  if (vk >= 0) { vi = vk; orbit.setPreset(VANTAGES[vk].v, true); }
  else if (camera && [...Q.keys()].length) orbit.setPreset(orbit.home, true);
  if (Q.get('lid') === '0') setLid(false, true);
  // ?r=03 opens that record: the id, not the index, so a link keeps working
  if (Q.has('r')) {
    const r = RECORDS.findIndex((x) => x.no === Q.get('r').padStart(2, '0'));
    if (r >= 0) { ri = r; readRecord(true, camera); }
  }
  if (Q.get('p') === '1') togglePlay(true);
  if (Q.get('spin') === '1') setAuto(true);
  else if (Q.get('spin') === '0') setAuto(false);
  render();          // 'v' and 'r' both move state the panel has to reflect
}

/* ============================== theme =================================== */
function setTheme(name, first = false) {
  // a bad ?t= used to reach THEMES[name].env as undefined and take the whole
  // boot down with it
  if (!THEMES[name]) name = 'studio';
  // the whole room walks from here: one clock for the lamps, the exposure, the
  // grade, the floor and the background (see themeRate)
  themeName = name;
  if (!first) themeP = 0;
  document.documentElement.dataset.theme = name;
  // the segmented control is styled off a class, not off [data-theme], so it
  // has to be told. Without this the highlight sits on 影棚 no matter which
  // room you are actually standing in.
  for (const b of document.querySelectorAll('#theme button')) {
    b.classList.toggle('on', b.dataset.theme === name);
    b.setAttribute('aria-pressed', String(b.dataset.theme === name));
  }
  render();                               // the illumination column marks the live one
  scene.environment = envs[THEMES[name].env];
  setBackdrop(name, first);
  if (rigPanels) {
    scene.remove(rigPanels);
    rigPanels.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    rigPanels = buildRigPanels(name, 2);
    scene.add(rigPanels);
    /* No "re-photograph the probe now" call here any more, and nothing to put
       in its place: the probe renders a face every frame, so the new panels
       are in the reflections a sixth of a second from now, with no swap for
       anyone to catch. A second setTheme with the same name — boot does one,
       and the reset path does another — used to rebuild identical panels and
       then re-photograph them for nothing; now it costs nothing either.
       This is deliberately still a rebuild. The panels are unlit geometry the
       probe consumes one face at a time, so the new room arrives over six
       frames — about 100 ms of a reflection that is already blurred by the
       roughness it is sampled through, and six frames late. That is not the
       step the glass lid was showing; the lid's step was the backdrop handover,
       which is a different thing entirely (see the mix in the wall material,
       below). */
  }
}

/** Hand the incoming room to the wall's mix; `applyTheme` walks it in.
 *
 * `mix` is how much of the wall is the incoming room B rather than the outgoing
 * one A, so a settled wall is mix = 1 with B holding the room that is on screen. */
function setBackdrop(name, first = false) {
  const map = backdropMaps[name];
  if (!map) return;
  const u = backdrop.material.uniforms;
  /* A fade already in flight, and more than half arrived: the room it is carrying
     is the one the eye is in, so it is *committed* first, and the next room then
     walks in over what is actually on screen rather than over the one before it.
     Committing is only a re-point of the two ends — B (what is arriving) becomes
     A (where we are), the incoming room becomes B, and `mix` is left exactly where
     it stands, so the frame renders identically before and after. The stacked
     shells promoted an in-flight fade the same way; resetting `mix` here instead
     would cut the wall back to the outgoing room on the frame a new one was
     chosen, which is the opposite of what this is for. The 0.5 line is the
     shells' behaviour, kept. */
  const midway = backdrop.userData.mix > 0.5;
  if (!first && midway) u.tBackA.value = u.tBackB.value;
  backdrop.material.map = map;
  backdrop.material.needsUpdate = true;   // a new map recompiles; the patch re-applies
  u.tBackB.value = map;
  backdrop.userData.mix = first ? 1 : (midway ? backdrop.userData.mix : 0);
}

/* The room change runs on a clock, not on an exponential decay. A decay drops
   most of its range in the first third of a second: going brighter that is
   barely noticeable, and going darker it reads as the lights being cut — 影棚
   to 暗房 came back as "突然变暗" for exactly that reason. This walks the
   transition linearly instead, eased at both ends, so the room gets dark at a
   rate the eye can follow.

   A rate cannot be written down in advance the way a decay can, because the
   distance each value has to cover differs; what is shared is the *progress*.
   For dx/dt = rate·(target − x) with rate = p′/(1 − q), the solution is
   x = x₀ + (target − x₀)·q — the damper every value here already uses, driven
   by a rate that turns it into a linear walk in q. Each value therefore lands
   exactly on q(p), which is what keeps a colour, a light *and* an opacity in
   step with each other no matter how far each has to travel. */
const THEME_DUR = 1.6;
let themeP = 1;                        // 0 → 1 while a room change is walking
function themeQ() {                    // eased progress, the shape every value lands on
  const p = themeP;
  return p * p * (3 - 2 * p);
}
function themeRate() {
  if (themeP >= 1) return 2.8;         // settled: back to an ordinary ease
  const s = themeQ();
  return (6 * themeP * (1 - themeP)) / (THEME_DUR * Math.max(1e-3, 1 - s));
}

function applyTheme(dt, instant = false) {
  const T = THEMES[themeName];
  themeP = Math.min(1, themeP + dt / THEME_DUR);
  const l = themeRate();
  rig.apply(RIG[themeName], dt, instant, l);
  const k = instant ? 1 : 1 - Math.exp(-l * dt);
  /* `instant` is documented at the boot call site as "land the whole preset
     before the first frame" — but damp(x, y, l, 0) is a *no-op*, not a snap, so
     everything that eases through damp() was staying on its default and then
     drifting into the preset over the first second of the page. k-scaled values
     snap; damped ones need telling. */
  const to = (cur, tgt) => (instant ? tgt : damp(cur, tgt, l, dt));
  renderer.toneMappingExposure += ((RIG[themeName].exposure ?? 1) - renderer.toneMappingExposure) * k;
  // the environment is a light here, not a backdrop: it is what the brass and
  // the steel are actually lit by, so the rig's gain applies to it as well
  scene.environmentIntensity += ((RIG[themeName].envInt ?? 1) * GAIN - (scene.environmentIntensity ?? 1)) * k;
  floorBase.uniforms.color.value.lerp(T.cFloor2, k);
  floorBase.uniforms.uMix.value = to(floorBase.uniforms.uMix.value, T.floorMix);
  shadowCatcher.material.opacity = to(shadowCatcher.material.opacity, T.shadowOp);
  grade.uniforms.uHal.value = to(grade.uniforms.uHal.value, T.hal);
  const G = T.grade ?? {};
  grade.uniforms.uGrain.value = to(grade.uniforms.uGrain.value, G.grain ?? 0.05);
  grade.uniforms.uCA.value = to(grade.uniforms.uCA.value, G.ca ?? 0.85);
  // the vignette is the one grade value a setting owns: the dial scales whatever
  // depth the room asks for, so each theme keeps its own (see RIG) and 0 is the
  // off it used to be a switch for. The damping above walks it rather than
  // cutting it, which is also what makes the dial feel like it is turning
  // something rather than setting a number.
  grade.uniforms.uVig.value = to(grade.uniforms.uVig.value, (G.vig ?? 0.85) * prefs.vig);
  grade.uniforms.uSat.value = to(grade.uniforms.uSat.value, G.sat ?? 1);
  // the lens' own defocus is here so a room *can* own it; both rooms are at the
  // same numbers today
  grade.uniforms.uEdge.value = to(grade.uniforms.uEdge.value, G.edge ?? 1);
  grade.uniforms.uFocus.value = to(grade.uniforms.uFocus.value, G.focus ?? 0.26);
  if (bloom) bloom.strength = to(bloom.strength, G.bloom ?? 0.32);
  if (composer?.ao) composer.ao.blendIntensity = to(composer.ao.blendIntensity, T.ao ?? 1);
  poolMat.color.lerp(T.cPool, k);
  poolMat.opacity = to(poolMat.opacity, T.poolOp);
  /* The wall crosses over on the same clock as everything else, and it is the
     same `themeQ()` every other value lands on — not an exponential of its own,
     because a room change is authored as a linear walk in q and the wall has to
     arrive with the lamps and the exposure or the room would still be changing
     after the transition was over.
     Nothing is committed here any more. The old version handed the incoming map
     to the base and hid the shell once the opacity passed 0.999 — an unnecessary
     discrete act sitting at the very end of the ramp, on the one surface the
     glass lid transmits. With the mix there is nothing to hand over: at q = 1 the
     shader is sampling the incoming room and nothing else, and it stays that way
     until the next room is chosen. */
  const uBack = backdrop.material.uniforms;
  uBack.uBackMix.value = instant ? 1 : themeQ();
  backdrop.userData.mix = uBack.uBackMix.value;
  intro.fade = reduce ? 1 : damp(intro.fade, 1, 1.6, dt);
  grade.uniforms.uFade.value = intro.fade;
}

/* This is the only place the probe texture is handed to a material, and it runs
   once, at boot.
   *
   * That is the change. The probe used to produce a brand new cubeUV texture per
   * capture, so every one of these assignments was a *content swap* — the one
   * frame the materials spent sampling something else, and the step the whole
   * snapshot apparatus existed to hide. Now the probe renders into the render
   * target it already has (see probe.js), so the texture identity the materials
   * are holding at boot is the identity they hold for the life of the page, and
   * there is no later frame to hand anything over on.
   *
   * The consequence worth stating: there is no second chance. Anything missed
   * here samples the probe's first cycle for the rest of the session, so
   * `prime` has to have run — that is why it runs inside the boot step rather
   * than on the first frame. */
function bindProbe(tex) {
  if (!tex || !cas) return;
  for (const m of Object.values(cas.materials)) {
    if (!m || !m.isMaterial) continue;
    m.envMap = tex;
    if (!probeBound) m.needsUpdate = true;   // one recompile, then just swap
  }
  // the travelling ghost copies are not in `materials`; without this a part
  // caught mid-ghost when the theme changes keeps the old probe and goes flat
  for (const e of ghosts) {
    e.m.envMap = tex;
    if (!probeBound) e.m.needsUpdate = true;
  }
  // And neither are the write head's layers, which is worse: they are *meant* to
  // be invisible stand-ins for the label plates, so a layer outside this pipeline
  // is lit by a different room than the plate it covers. The reveal then reads as
  // a brightness band crossing the card — bright or dark depending on which way
  // the two rooms differ — and the frame the head is taken off it, the whole
  // label snaps back to the plate's shading. That snap is what looked like a
  // white light being switched off at the end of the sweep.
  for (const m of cas.headMaterials) {
    m.envMap = tex;
    if (!probeBound) m.needsUpdate = true;
  }
  probeBound = true;
}

/* ============================== boot ==================================== */
const loaderBar = $('#lbar'), loaderLbl = $('#llbl'), loaderPct = $('#lpct');
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
function showError(msg) {
  console.error(msg);
  if (loaderLbl.parentElement) {
    setRoll(loaderPct, 'ERR');
    riseText(loaderLbl, String(msg).slice(0, 160));
    loaderLbl.style.color = '#e0684a';
  }
}
addEventListener('error', (e) => showError(e.error?.stack || e.message));
addEventListener('unhandledrejection', (e) => showError(e.reason?.stack || e.reason?.message || String(e.reason)));
async function step(label, pct, fn) {
  riseText(loaderLbl, label);
  loaderBar.style.width = pct + '%';
  setRoll(loaderPct, pct + '%');
  await nextFrame();
  await fn?.();
  await nextFrame();
}

/* ============================== perf probe ===============================
 *
 * `?perf=1` answers "where does this machine spend the frame" — on the machine
 * being looked at, not on someone else's. Every figure is the median frame
 * interval with one pass switched off, so the gap from the first line is what
 * that pass costs *there*. That is not a thing to reason about from the outside:
 * the frame is fill-rate bound at close range (the vinyl, the glass, the mirrors)
 * and per-pass bound at others, and which one wins depends on the GPU, the window
 * size and the display scale.
 *
 * It writes the table on screen and to the console, and it puts every pass back
 * where it found it — including the saved settings, via `applyPrefs`. */
function runPerfProbe() {
  const box = document.createElement('pre');
  box.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:99;margin:0;'
    + 'padding:8px 12px;font:11px/1.55 Consolas,monospace;color:#8dffb0;'
    + 'background:rgba(0,0,0,.62);border-radius:6px;white-space:pre;pointer-events:none';
  document.body.appendChild(box);
  const line = (s) => { box.textContent += s + '\n'; console.log('[perf] ' + s); };
  const realStep = probe.step;
  const apply = (c) => {
    if (c.machine !== undefined) cas.root.visible = c.machine;
    if (c.record !== undefined) cas.parts.gRecord.visible = c.record;
    if (c.glass !== undefined) cas.setRefraction(c.glass);
    if (c.floor !== undefined) floorBase.setEnabled(c.floor);
    if (c.lid !== undefined) lidMirror.setEnabled(c.lid);
    if (c.probe !== undefined) probe.step = c.probe ? realStep : () => {};
    if (c.ao !== undefined) composer.ao.enabled = c.ao;
    if (c.bloom !== undefined) composer.bloom.enabled = c.bloom;
    if (c.grade !== undefined) composer.grade.enabled = c.grade;
  };
  const measure = (frames = 40) => new Promise((res) => {
    const ts = [];
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      ts.push(now - last);
      last = now;
      if (ts.length < frames) requestAnimationFrame(tick);
      else { ts.sort((a, b) => a - b); res(ts[ts.length >> 1]); }
    };
    requestAnimationFrame(tick);
  });
  const tests = [
    ['everything', {}],
    ['no record', { record: false }],
    ['no glass (refraction)', { glass: false }],
    ['no floor mirror', { floor: false }],
    ['no lid mirror', { lid: false }],
    ['no probe', { probe: false }],
    ['no ao', { ao: false }],
    ['no bloom', { bloom: false }],
    ['no grade', { grade: false }],
    ['machine only', { glass: false, floor: false, lid: false, probe: false }],
    ['nothing (no machine)', { machine: false }],
  ];
  (async () => {
    /* Hold the framing for the whole run. The page returns the camera home after
       five seconds of idling, and a table takes longer than that: without this,
       the rows at the top of the table and the rows at the bottom are measured at
       two different framings, and the numbers contradict each other. */
    homeArmed = false;
    line(`perf · ${innerWidth}×${innerHeight} @ dpr ${devicePixelRatio.toFixed(2)}`);
    const first = await measure();
    for (const [name, c] of tests) {
      if (Object.keys(c).length) { apply(c); await measure(8); }
      const ms = Object.keys(c).length ? await measure() : first;
      line(`${name.padEnd(22)}${ms.toFixed(2).padStart(7)} ms   ${ms === first ? '' : '−' + (first - ms).toFixed(2)}`);
      apply({ machine: true, record: true, glass: true, floor: true, lid: true, probe: true, ao: true, bloom: true, grade: true });
    }
    applyPrefs();
    line('(each line: that one pass off; slower GPU ⇒ bigger gaps)');
  })();
}

async function boot() {
  await step('正在载入唱片机', 12, async () => {
    cas = await createTurntable({ title: TRACK.title, artist: TRACK.artist, album: TRACK.album, minutes: '05' });
    scene.add(cas.root);
    // the cover measures its own faces once, here, in its local space: they are
    // re-picked per frame with the lid's matrix, but the measurement is static
    if (cas.glassMesh) lidMirror.setMesh(cas.glassMesh);
    // ...and hand the glass the pass it just measured. The mix is read from the
    // pass's own uniform object, not copied, so the per-frame update in
    // lidmirror.js reaches the shader without anything having to say so.
    cas.setLidReflection(lidMirror.uniforms);
    /* The lid's material has two writers — the ghost system and the mirror pass's
       flat-pane swap — and this is the lid telling the second one to ask the
       first. It is a function rather than a flag because the answer changes every
       frame while a part is being read (see useCheapGlass). */
    cas.setGlassOwner(() => {
      const e = cas.glassMesh.userData._g;
      return e && e.live ? e.m : null;
    });
    /* ...and the hook that puts ghosts into the lid's refraction, which three
       leaves out of it. Installed here, with the model: it needs `cas` to confirm
       which render target is three's, and it has to be in place before the first
       frame that draws a ghost. */
    installRefractionGhosts();
    installGlassAOExclusion();
    rig = createRig(scene);
    // the shell only breathes slowly, so the shadow map does not need a full
    // re-render every frame — refresh it on alternate frames instead
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    setDur();
    audioEl.addEventListener('loadedmetadata', setDur);
    audioEl.addEventListener('durationchange', setDur);
    audioEl.addEventListener('error', () => {
      // the loader is already gone by the time a late 404 lands, so the failure
      // has to say so somewhere the user can still see: the now-playing chip
      audioFailed = true;
      document.body.classList.add('no-audio');
      if (swap.state === 'idle') setNowChip();
      showError('音频加载失败（' + (audioEl.error?.code ?? '?') + '）：' + currentName);
    });
    audioEl.addEventListener('ended', () => {
      mode = 'rew';
      cas.st.driven = false;
      cas.st.playing = true;
      cas.st.dir = 1;                                    // spool back, then play again
      document.body.classList.add('rewinding');
    });
    setNowChip();
  });
  await step('正在合成材质与纹理', 42, () => {});
  await step('正在烘焙环境光照', 72, () => {
    envs = createEnvironments(renderer);
    for (const k of Object.keys(THEMES)) backdropMaps[k] = TX.backdropTexture(THEMES[k].bg);
    // softboxes as geometry on a hidden layer, so the probe sees the rig
    // for the theme that is actually active. It is rebuilt at the end of boot
    // anyway, but a rig that is briefly the wrong room is a trap: whatever
    // photographs the scene in between bakes that room in, and the probe
    // photographs the scene on the very next step.
    rigPanels = buildRigPanels(themeName, 2);
    scene.add(rigPanels);
    /* The probe sits at the middle of the machine.
       From there it sees the lighting rig *and* the deck's own body, so glossy
       and chrome parts pick up the studio and their neighbouring parts in the
       same reflection. It is built here because it has to exist before the frame
       that first draws a material holding it — there is no handover later.
       The point used to be [0, 2.4, 3.4], which was chosen for the cassette this
       page was rebuilt from: "from there it sees the rig and the cassette's own
       body". The deck stands from y = -1.18 to y = 9.15 with the lid up, so that
       point sits low and behind the machine, and the reflections it feeds are
       wrong in place as well as in parallax.
       [0, 4.0, 0] is the middle of the machine, which roughly halves the
       positional error — and that is all it does. One point cannot reflect a
       surface: a cubemap knows what surrounds the machine, not where a thing
       should appear from any particular pane of glass. An exact reflection needs
       a planar pass per lid panel, the way floor.js does the floor. This is a
       better approximation, not the fix. */
    probe = createProbe(renderer, scene, { size: 512, at: [0, 4.0, 0] });
  });
  await step('正在编译着色器', 82, () => {
    composer = createComposer(renderer, scene, camera);
    grade = composer.grade; bloom = composer.bloom;
    setTheme(themeName, true);
    applyTheme(0, true);          // land the whole preset before the first frame
  });
  /* AFTER the theme, and that ordering is now the *only* thing that makes the
   * opening frame right.
   *
   * The probe photographs the room, and until `setTheme` has run there is no
   * room to photograph: `scene.environment` is unset, the backdrop is still
   * whatever it was built with, and the softbox rig is whatever the previous
   * step left there. Photograph that and every material wears the wrong room's
   * light from the first frame — and with one texture for the life of the page
   * there is no later capture to correct it. `prime` runs one whole cycle here,
   * synchronously, so the six faces and the PMREM filter are already done by the
   * time `bindProbe` hands the texture over, and the first frame the page draws
   * is a frame with a complete probe in it.
   *
   * What the old version of this step had to worry about is gone with the
   * snapshot: it used to force the backdrop, the rig, the lid pose and the IBL
   * level to their settled values before photographing, because it was baking a
   * "later" into every following frame and could not photograph a transition.
   * This one is a live probe — it photographs whatever is true this frame, and
   * the next cycle picks up whatever changed. */
  await step('正在解算自反射', 92, () => {
    /* The lid goes flat for this, exactly as it does for the floor's mirror —
       and for the same reason, one step worse.
       three keys its transmission render target *per camera*, and the probe
       renders with a camera of its own, so leaving the real glass in the scene
       makes every one of these six faces buy a second full scene render. That is
       the cost; the correctness problem is that it also puts a per-camera
       transmission result into the probe's content, and the probe's camera never
       moves. The flat pane has no transmission pass at all, so the probe
       photographs the same lid the mirror does: a tinted sheet, at a detail the
       mirror blurs away anyway. See useCheapGlass. */
    cas.useCheapGlass(true);
    scene.updateMatrixWorld(true);      // see the note on the flag: once, before the probe looks
    probe.prime(renderer, scene);
    cas.useCheapGlass(false);
  });

  await step('准备就绪', 100, async () => {
    onResize();
    scene.updateMatrixWorld(true);      // the warm-up frames below are renders too
    /* THE PROBE IS HANDED OVER BEFORE THE WARM-UP, AND THAT ORDER IS THE FIX.
     *
     * It used to be bound one line after this step, which looked harmless — the
     * warm-up frames below draw the ghosts either way — and cost five seconds on
     * the first click of the session. Measured, with the program counter either
     * side of a real read:
     *
     *   整机   programs 77 → 77 → 77    frame  1.0 ms
     *   底座   programs 77 → 77 → 86    frame 5108 ms   (86 → 86 on the second read)
     *   转盘   programs 86 → 86 → 87    frame  640 ms
     *
     * Nine programs, linked in the middle of the click. The reason is that three
     * keys a program on the *environment it samples*, not just on the material:
     * `envMapMode` and `envMapCubeUVHeight` are both in the cache key, so a
     * material sampling the room and the same material sampling the probe are two
     * programs. Every ghost copy was being cloned and drawn before `bindProbe`
     * ran, so the whole warm-up compiled the room-sampling variants — and the
     * first read, which is the first time a ghost is drawn with the probe bound,
     * re-keyed all of them at once. The second read is free because by then they
     * exist (86 → 86 → 86 above); that is the "first one only" in the report.
     *
     * `renderer.compileAsync` above the ghost loop was no help for the same
     * reason: it compiles what the material asks for at that moment, and at that
     * moment the material was still pointed at `scene.environment`.
     *
     * So the handover moves to the front of this step. Now the ghosts are cloned
     * from materials that already hold the probe, their programs are keyed the way
     * the read will key them, and the read adds nothing. It is also strictly less
     * work than before: the room-sampling ghost variants were never used again, so
     * compiling them was the waste. */
    bindProbe(probe.texture);
    // Every ghost copy is built now and held on its mesh just long enough for
    // the compiler to see it. three keys a program on `opaque`, and a ghost is
    // transparent, so each one needs a second program — built lazily that was a
    // burst of compiles on the first frame of the first 读取, i.e. the picture
    // stopping for a beat the instant you click. Pay for it here instead.
    const restore = [];
    cas.assembly.traverse((o) => {
      if (!o.isMesh || Array.isArray(o.material)) return;
      restore.push([o, o.material]);
      o.material = ghostFor(o).m;
    });
    if (renderer.compileAsync) await renderer.compileAsync(scene, camera);
    else renderer.compile(scene, camera);
    for (const [o, src] of restore) o.material = src;   // parts stay real until asked

    // Compiling them is not enough on its own. three keeps a program only while
    // some material is using it, and a compile pass hands the materials back
    // straight away — so the variants that only a ghost ever asks for (the
    // transparent pass *and* the probe's cube-UV envmap sampling) are dropped
    // again, and the first 读取 of each record re-links three to eight of them on
    // the spot. Measured: 75 programs after boot, +8 the first time 轮毂 is
    // read, +3 more for 上壳, and nothing at all on the second read of the same
    // record — i.e. they survive once built. So build them here and *use* them:
    // one real frame per record, behind the loader, and every later click is
    // free.
    // ...and a *whole frame* per record, not just the composer. The floor mirror,
    // the reflection probe and the lid's planar pass all run outside the composer,
    // so a ghost material that only the composer had drawn would still build its
    // program in those three the first time a part was actually read — which is
    // the stall this is here to remove. Every pass the frame loop runs, run here.
    for (const R of RECORDS) {
      applyFocus(R.key);
      cas.useCheapGlass(true);
      floorBase.update(renderer, scene, camera, true);
      probe.step(renderer, scene);
      lidMirror.update(renderer, scene, camera, cas.glassMesh);
      cas.useCheapGlass(false);
      composer.composer.render();
    }
    applyFocus(null);
    /* One more frame with every ghost painted at k = 0 — the state a handover ends
       in. A fade converges on the source's own settings, and for the lid that is
       the *other* program (transmission on), so drawing it here is what keeps the
       first fade-out of the session from building it in the middle of the fade. */
    for (const e of ghosts) paintGhost(e, 0);
    cas.useCheapGlass(true);
    floorBase.update(renderer, scene, camera, true);
    probe.step(renderer, scene);
    lidMirror.update(renderer, scene, camera, cas.glassMesh);
    cas.useCheapGlass(false);
    composer.composer.render();
    // and put the scene back exactly as a settled ghost fade would leave it:
    // every part on its own material, in its own draw order, painted at k = 0
    for (const e of ghosts) {
      paintGhost(e, 0);
      e.o.material = e.base;
      e.o.renderOrder = e.order;
      e.o.layers.disable(REFRACT_LAYER);
      e.live = false;
    }
    ghosts.length = 0;
    composer.composer.render();
    // ...and the write head's two layers, which stay invisible until a track is
    // loaded. A program is built on the first frame a material is *drawn*, so
    // without this the first sweep would build two of them on the frame it
    // starts — a stutter in the middle of a move. Open the window over the print
    // that is already on the card: nothing changes on screen, and it is still
    // behind the loader.
    cas.warmLabel(true);
    composer.composer.render();
    cas.warmLabel(false);
    // ...and the lid's flat stand-in, which is only ever drawn inside the mirror
    // pass and would otherwise be built on the first frame the floor refreshes.
    cas.useCheapGlass(true);
    composer.composer.render();
    cas.useCheapGlass(false);
  });
  document.body.classList.add('ready');
  /* The bind is the one at the top of the step above, and it is still the only
     one: there is no second handover waiting in the loop. It sits there rather
     than here because the warm-up has to see the same environment the read will;
     see the note on it. */
  render();
  pinPanel();          // measured with a record's sheet in it, not an empty one
  applyPrefs();        // the remembered switches, now that there is a scene to apply them to
  // ?intro=1 forces it and ?intro=0 refuses it — any other query at all, which is
  // how a link meant to be photographed lands, has never played it. Otherwise the
  // setting decides.
  const qIntro = Q.get('intro');
  const wantsIntro = qIntro === '1' ? true : qIntro === '0' ? false
    : prefs.intro && ![...Q.keys()].length;
  if (!wantsIntro) intro.fade = 1;
  else runIntro();
  applyQuery(!wantsIntro);
  loop();
  if (Q.get('perf') === '1') setTimeout(runPerfProbe, 1500);
  /* ...and by hand for any other state: zoom to the framing in question, then
     `__perf()` in the console. The table is only true where it was taken, and the
     close-up is the framing that asks the question. */
  window.__perf = runPerfProbe;
  /* ...and on the `P` key, at whatever framing the page happens to be in. The
     framing that asks the question is the close stop — the lens full of vinyl —
     and getting there should not need a console. */
  addEventListener('keydown', (e) => {
    if ((e.key === 'p' || e.key === 'P') && !e.metaKey && !e.ctrlKey && !e.altKey) runPerfProbe();
  });
}

/* ============================== intro =================================== */
const intro = { y: 0, tilt: 0, spin: 0, fade: 0 };
/* The lift starts *on* the floor, not under it. Coming up through the floor
   from below meant the tape spent the first two seconds of the page buried in
   a sheet it has no business being inside — and every frame of that was a
   slab pushing through a plane, which is the one thing this scene is otherwise
   careful never to do. It now waits on the floor for 0.7s (long enough to be
   seen resting there) and then floats up to the height it belongs at. */
const FLOOR_REST = FLOOR_Y + DIM.hd;

/* linear for most of the way and eased out into the last of it. A straight
   ease over this distance spends the whole travel braking and never reads as a
   rise; a straight line arrives like a lift. This is the shape the hover has:
   a rate, with the floor coming up to meet it. */
const LIFT = (t) => (t < 0.62 ? (t / 0.62) * 0.82 : 0.82 + 0.18 * ease.out((t - 0.62) / 0.38));

let tl = null;
function runIntro() {
  if (reduce) {
    intro.fade = 1; intro.y = 0; intro.tilt = 0;
    orbit.setPreset(orbit.home, true);
    return;
  }
  intro.y = FLOOR_REST; intro.tilt = 0; intro.spin = 2.4; intro.fade = 0;
  orbit.theta = orbit.gTheta = 1.32;
  orbit.phi = orbit.gPhi = 1.38;
  orbit.radius = orbit.gRadius = 42;
  tl = new Timeline();
  tl.add({
    delay: 0.7, dur: 2.4, ease: LIFT,
    onUpdate: (e) => { intro.y = FLOOR_REST * (1 - e); },
  });
  /* There used to be a second timeline entry here — `delay: 3.6` — which marked
     the reflection probe stale, because the probe was a snapshot photographed
     before the lift and the deck it landed in was a different one. Neither half
     of that is true any more, and the entry has nothing left to do: the probe
     renders a face every frame, so it photographs the lift as it happens and
     catches up within one sixth of a second of it ending. A call here would buy
     nothing and answer nothing. */
  tl.play();
  orbit.setPreset(orbit.home, false);
  if (orbit.tween) orbit.tween.dur = 3.4;
}

/* ============================== the index ===============================
   Everything the page can do is a file in an index. Five columns of them:
   ←/→ walks the columns, ↑/↓ walks the files inside one, and ENTER — or the
   ACCESS FILE button, or a second click on an already-selected row — reads
   the file. Reading is what actually moves the scene, so browsing the list is
   free and nothing changes under you while you are reading it.

   The labels are functions wherever a file is a toggle, so the dossier always
   names the action it is about to perform rather than the state it is in.
   ===================================================================== */
/* The model does not turn by itself until asked to. 巡览 used to start on, and
   the same switch also gates the slow drift the camera picks up after a drag
   (controls.js scales it by the eased auto weight), so leaving it off means the
   tape simply holds still until something moves it. */
let lidOpen = true, autoRotate = false;

/* One record per thing that is actually on this tape: the whole unit, and the
   five parts it is assembled from. A record carries its own real
   spec sheet, its own framing, and — for a part — the node that stays in its
   true materials while the rest of the shell drops back to a ghost. The three
   numbers in `spec` are the only made-up thing here; everything else is read
   off the model. */
const RECORDS = [
  {
    no: '00', cn: '整机', en: 'BELT-DRIVE TURNTABLE',
    note: 'ABS 底座，黄铜脚，钢转盘走皮带。九年义务教育里那台机器的形状，重新做过一遍。',
    spec: [['底座', 'ABS · 420 × 340 mm'], ['转盘', '钢 · ⌀306 mm'], ['驱动', '皮带 · 33⅓ / 45'],
      ['唱臂', '9" · 228.6 mm'], ['整重', '6.4 kg']],
    act: '读取整机', key: null,
    view: { theta: 0.62, phi: 1.03, radius: 34 }, viewName: '等轴机位', viewEn: 'ISOMETRIC',
  },
  {
    no: '01', cn: '底座与脚', en: 'PLINTH & FEET',
    note: '一体化 ABS 底座，四只黄铜锥脚坐在橡胶垫上。台面是整块件的基准面，所有零件从它往上量。',
    spec: [['材料', 'ABS · 象牙白'], ['尺寸', '420 × 340 × 46 mm'], ['脚', '黄铜 · ⌀34 × 18'],
      ['脚距', '342 × 262 mm'], ['基准', '台面 · ±0.05 mm']],
    act: '读取底座', key: 'plinth',
    view: { theta: 0.95, phi: 1.34, radius: 33 }, viewName: '专用机位', viewEn: 'BASE ELEVATION',
  },
  {
    no: '02', cn: '转盘', en: 'PLATTER',
    note: '整块车出来的钢盘，边缘车亮，盘面下沉让出毡垫的凹槽。转速由周向闪光点读，不由计数器。',
    spec: [['材料', '冷轧钢 · 车削'], ['直径', '⌀306 mm'], ['厚度', '62 mm'],
      ['重量', '1.6 kg'], ['驱动', '皮带 · 单速']],
    act: '读取转盘', key: 'platter',
    view: { theta: 0.30, phi: 0.62, radius: 31 }, viewName: '专用机位', viewEn: 'PLATTER PLAN',
  },
  {
    no: '03', cn: '唱片', en: 'VINYL RECORD',
    note: '12 吋黑胶，一条连续刻槽从外圈走到内圈。纸标签压在中心，中心轴从它中间穿过去。',
    spec: [['材料', 'PVC · 黑'], ['直径', '⌀300 mm'], ['厚度', '1.8 mm'],
      ['转速', '33⅓ rpm'], ['标签', '纸 · ⌀100 mm']],
    act: '读取唱片', key: 'record',
    view: { theta: 0.42, phi: 0.44, radius: 28 }, viewName: '专用机位', viewEn: 'GROOVE MACRO',
  },
  {
    no: '04', cn: '唱臂', en: 'TONEARM',
    note: '九吋臂，万向轴承。枢轴、主轴与针尖围成的三角形是固定的，所以针尖的半径就是轴承的角度。',
    spec: [['有效长度', '228.6 mm'], ['枢轴距', '211.5 mm'], ['超距', '17.1 mm'],
      ['循迹角', '32°'], ['唱头', '动磁 · MM']],
    act: '读取唱臂', key: 'arm',
    view: { theta: 1.05, phi: 1.08, radius: 25 }, viewName: '专用机位', viewEn: 'ARM SWEEP',
  },
  {
    no: '05', cn: '防尘盖', en: 'DUST COVER',
    note: '亚克力盖，后缘铰链，停在 70°。开盖之后它才是这台机器最高的那一部分。',
    spec: [['材料', '亚克力 · 3 mm'], ['尺寸', '420 × 340 mm'], ['开启', '70°'],
      ['铰链', '后缘 · 两点'], ['工艺', '阳极氧化框']],
    act: '读取防尘盖', key: 'cover',
    view: { theta: 0.10, phi: 1.16, radius: 35 }, viewName: '专用机位', viewEn: 'LID OPEN',
  },
];

/* the camera's four filed vantages, independent of whatever record is open */
const VANTAGES = [
  { k: 'iso', cn: '等轴机位', en: 'ISOMETRIC', v: { theta: 0.62, phi: 1.03, radius: 34 } },
  { k: 'front', cn: '正视机位', en: 'ELEVATION', v: { theta: 0.06, phi: 1.30, radius: 32 } },
  { k: 'top', cn: '俯视机位', en: 'PLAN', v: { theta: 0.34, phi: 0.30, radius: 36 } },
  { k: 'detail', cn: '细节特写', en: 'MACRO', v: { theta: 0.95, phi: 1.14, radius: 22 } },
];

let ri = 0, vi = 0;               // record, vantage; vi < 0 means a record's own framing
const cur = () => RECORDS[ri];
const MACRO = VANTAGES.findIndex((v) => v.en === 'MACRO');

const D = {
  colCn: $('#col-cn'), colCn2: $('#col-cn-2'), colEn: $('#col-en'),
  colI: $('#col-i'), colN: $('#col-n'),
  fileno: $('.fileno'), caret: $('.fileno .caret'),
  fileId: $('#file-id'), fileCn: $('#file-cn'), fileEn: $('#file-en'),
  fileNote: $('#file-note'), fileSpec: $('#file-spec'), doc: $('.doc'),
  selI: $('#sel-i'), selN: $('#sel-n'),
  refList: $('#ref-list'), cols: $('#cols'),
  access: $('#btn-access'), accessLabel: $('#access-label'),
  dossier: $('#dossier'), dbody: $('#dbody'), fold: $('#btn-fold'),
};
D.colN.textContent = String(VANTAGES.length).padStart(2, '0');
D.selN.textContent = RECORDS[RECORDS.length - 1].no;

/* the pick list and the ticks, built once. The records never change — only
   which of them is live — so `render` only ever toggles their classes, and the
   markers get to slide instead of being replaced mid-stride. */
const refRows = [], ticks = [];
for (let i = 0; i < RECORDS.length; i++) {
  const r = RECORDS[i];
  // click selects; clicking the row you already selected reads it, so the
  // list can be driven end to end without reaching for the button
  const pick = () => { if (i === ri) readRecord(); else { ri = i; render(true); } };

  const b = document.createElement('button');
  b.className = 'row';
  b.innerHTML = `<span class="rn">${r.no}</span><span class="rt">${r.cn}</span><i class="rd"></i>`;
  b.addEventListener('click', pick);
  const li = document.createElement('li');
  li.appendChild(b);
  D.refList.appendChild(li);
  refRows.push(b);

  const t = document.createElement('button');
  t.className = 'tick';
  t.title = `${r.no} · ${r.cn}`;
  t.setAttribute('aria-label', `${r.no} ${r.cn}`);
  t.addEventListener('click', pick);
  D.cols.appendChild(t);
  ticks.push(t);
}

/* ---------- ghosting: the part you are reading stays real ----------
   The parts that step aside travel to the ghost over about half a second
   rather than being swapped onto it. Everything the ghost is — its grey, its
   flatness, its transparency — is reached by animating the material's own
   uniforms: colour, roughness, metalness, clearcoat and normal scale all walk
   to the target, and the opacity follows them down. The old version cut
   straight to a translucent grey material, and next to a camera move that eases,
   that one hard cut read as a glitch.

   The travelling copy has to be per-mesh, because the originals are shared:
   every part using `M.shell` points at the same material, so dimming one would
   dim all of them. The clone is made once, at boot, and kept — after that the
   only thing changing per frame is uniforms, so nothing recompiles. Building
   them lazily put the *first* program of each transparent variant on the first
   frame of the first read instead; see the warm-up in `boot`.

   The ghost is deliberately darker than the room, not paler: the room is
   already near-white, and a light ghost dissolves into it and turns the frame
   to mush. depthWrite stays off so a ghost never occludes the part you asked
   to see. */
const GHOST = {
  color: new THREE.Color(0x8a8375),
  opacity: 0.30, roughness: 0.92, metalness: 0, env: 0.25,
};
/* A transparent object cannot occlude anything, so whatever is drawn *after* it
   blends straight over the top — and the floor, the shadow catcher and the light
   pool are all transparent, sitting at renderOrder 1–3, i.e. after every ghost
   (they were all at 0). The floor fragment seen through the cassette is far
   beyond it, and the floor's own radial fade means that when the lens looks
   *down* at the shell, that fragment is close enough to be near full opacity.

   So look down and every ghost was painted over by the floor: a part fading
   back in never appeared to change at all. It stayed buried until the frame it
   went opaque, wrote depth, and had the floor rejected all in one go — which is
   the part snapping into existence instead of materialising. Looking from a low
   angle the floor behind the shell is past its fade radius and contributes
   nothing, which is why that view looked right.

   Ghosts therefore sort after the floor group, and in front of the window glass
   — transparent too, and it belongs on top of everything inside the shell. */
const GHOST_ORDER = 4;
const ghosts = [];

function focusSets(key) {
  const P = cas.parts;
  switch (key) {
    // the deck's five parts, each one either staying real or being dropped to a
    // ghost. The platter drops the record and the cover drops nothing: the
    // record is what actually hides the platter, and nothing hides the cover
    // except the cover.
    case 'plinth': return { keep: new Set([P.gPlinth]), drop: new Set([P.gCover]) };
    case 'platter': return { keep: new Set([P.gPlatter]), drop: new Set([P.gRecord]) };
    case 'record': return { keep: new Set([P.gRecord]) };
    // The arm record keeps the tower as well as the arm: the tower is part of
    // what you are looking at when you read 唱臂, it just does not move.
    case 'arm': return { keep: new Set([P.gArm, P.gArmSwivel, P.gArmMount]) };
    // The lid record keeps its hinge as well: the barrels are part of what you
    // are looking at when you read 防尘盖, they just do not move.
    case 'cover': return { keep: new Set([P.gCover, P.gCoverMount]) };
    default: return null;
  }
}

let focusKey = null;

/** the travelling copy for one mesh, created once and kept for the life of the
    page. Originals are shared — every part using `M.shell` points at the same
    material, so fading one would fade them all — hence one copy per mesh. */
function ghostFor(o) {
  let e = o.userData._g;
  if (e) return e;
  const src = o.material;
  const m = src.clone();
  m.transparent = true;
  m.depthWrite = false;
  /* A ghost is a flat grey stand-in, so at full ghost it must not refract:
     `transmission` there would mean a 30% grey sheet running a full extra scene
     render per frame, and it would put the ghost in three's *transmissive* list,
     where what it shows is the opaque-only transmission image rather than the
     scene. But it is not a value that can simply be dropped — `transmission` is a
     define, i.e. a different program, and the end of a fade has to *converge* on
     what the real material looks like or the handover reads as a jump: with it
     pinned at 0 the lid's stand-in finished as an opaque grey slab and the swap to
     real glass snapped. So it is owned by `paintGhost`, which ramps it with k. */
  if (m.transmission > 0) m.transmission = 0;
  /* A ghost of a patched material carries the patch too. The lid's planar
     reflection lives in `M.glass.onBeforeCompile`, and a stand-in without it can
     never converge on the glass for the same reason: the last frames of the fade
     would be missing the one thing the lid mostly is. */
  m.onBeforeCompile = src.onBeforeCompile;
  // three renders a transparent DoubleSide material as two passes, flipping
  // `side` and setting needsUpdate each time — which re-acquires one program and
  // releases the other, and a released program is destroyed, so the next frame
  // compiles both again. Forever. The tape is DoubleSide, so every frame the
  // ghosted tape lived was two shader builds: reading 上壳 (tape ghosts) hitched
  // and reading 磁带 (tape stays real) did not, which is exactly what the
  // compile counter showed. forceSinglePass is three's own flag for this; the
  // ghost is a 30% grey stand-in, so the blend order the second pass buys is
  // not worth a shader build per frame.
  m.forceSinglePass = true;
  e = o.userData._g = {
    o, m, base: src, k: 0, t: 1, live: false, order: o.renderOrder,
    src: {
      color: src.color.clone(),
      opacity: src.opacity,
      roughness: src.roughness,
      metalness: src.metalness,
      clearcoat: src.clearcoat,
      sheen: src.sheen,
      env: src.envMapIntensity,
      ns: src.normalScale ? src.normalScale.clone() : null,
      tr: src.transmission,
    },
  };
  return e;
}

function embrace(o) {
  const e = ghostFor(o);
  // The ghost copy's envMap is whatever the source material carried when the
  // copy was made, and a copy made before `bindProbe` ran — or made for a
  // material that was not in `cas.materials` — would hold an empty one, which is
  // the one thing that shows: the part would go flat the moment it became a
  // ghost. So it is taken from the live material each time. (The probe's texture
  // never changes identity, so this is a correction for copies, not a handover.)
  e.m.envMap = e.base.envMap;
  if (o.material !== e.m) o.material = e.m;
  o.renderOrder = GHOST_ORDER;      // see GHOST_ORDER: the floor draws first
  // and into the lid's refraction: only ghosts are on this layer, so the extra
  // draw that puts them back in that image (see the note further down) takes the
  // ghosts and nothing else. The lid itself stays off it — the pane cannot be
  // behind the pane, and while its stand-in is the glass again (see paintGhost) a
  // transmissive object on this layer would make that extra draw open a
  // transmission pass of its own, inside the one it is already running in.
  if (o !== cas.glassMesh) o.layers.enable(REFRACT_LAYER);
  e.t = 1;
  if (!e.live) { e.live = true; ghosts.push(e); }
}

function release(o) {
  const e = o.userData._g;
  if (e) e.t = 0;
}

/** k = 0 is the part's own material, k = 1 is the ghost */
const DEFINE_FLOOR = 0.004;
function paintGhost(e, k) {
  const m = e.m, s = e.src;
  m.color.copy(s.color).lerp(GHOST.color, k);
  m.opacity = s.opacity + (GHOST.opacity - s.opacity) * k;
  /* A transparent object cannot occlude anything: whatever is drawn after it
     blends over the top, even when it is behind. The reels are the clearest
     case — the wound pack is a full disc of the reel's own radius, its top face
     sits *below* the hub's top ring, and it is the later of the two in draw
     order, so a hub fading back in stayed washed grey under the disc until the
     frame it went opaque and depth took over.

     Once a part is opaque enough that it is hiding things anyway, let it write
     depth. Whatever is genuinely in front of it still blends as it should, and
     everything behind it is rejected however the sort ordered the two. A ghost
     proper (0.30) and the 0.30 window glass never reach the line, so neither of
     them ever starts occluding. */
  m.depthWrite = m.opacity >= 0.7;
  m.roughness = s.roughness + (GHOST.roughness - s.roughness) * k;
  m.metalness = s.metalness + (GHOST.metalness - s.metalness) * k;
  // three builds a shader program per *whether* clearcoat and sheen are on
  // (`HAS_CLEARCOAT = material.clearcoat > 0`, same for sheen), so easing either
  // one down to exactly zero compiles a fresh program on that frame — a dozen of
  // them landing together as the fade ends, which is the hitch a beat after
  // 读取 on the parts that carry both. Stop a hair short instead: at 0.004 the
  // layer contributes nothing visible and the define never flips.
  if (s.clearcoat > 0) m.clearcoat = Math.max(s.clearcoat * (1 - k), DEFINE_FLOOR);
  if (s.sheen > 0) m.sheen = Math.max(s.sheen * (1 - k), DEFINE_FLOOR);
  if (s.env !== undefined) m.envMapIntensity = s.env + (GHOST.env - s.env) * k;
  if (s.ns) m.normalScale.set(s.ns.x * (1 - k), s.ns.y * (1 - k));
  /* `transmission` is a define, not a uniform: turning it off is a different
     program, and both ends of a fade need their own. At full ghost the stand-in is
     the cheap opaque pane; from the first frame of the handover it is the glass
     again, ramped, so the last frames of the fade are the glass's own refraction
     arriving rather than a slab waiting to be swapped. The only step left is at
     k = 1 exactly, where the value drops from DEFINE_FLOOR to 0 — 0.004 of a
     refraction that is, by then, a 30% grey veil. */
  if (s.tr > 0) m.transmission = k >= 1 ? 0 : Math.max(s.tr * (1 - k), DEFINE_FLOOR);
}

function updateGhost(dt) {
  for (let i = ghosts.length - 1; i >= 0; i--) {
    const e = ghosts[i];
    if (Math.abs(e.t - e.k) > 0.0015) {
      e.k = reduce ? e.t : damp(e.k, e.t, 5.0, dt);
      paintGhost(e, e.k);
    } else if (e.k !== e.t) {
      e.k = e.t;
      paintGhost(e, e.k);
    }
    if (e.t === 0 && e.k === 0) {
      e.o.material = e.base;          // back on the shared original
      e.o.renderOrder = e.order;
      e.o.layers.disable(REFRACT_LAYER);
      e.live = false;
      ghosts.splice(i, 1);
    }
  }
}

function applyFocus(key) {
  focusKey = key;
  const sets = key ? focusSets(key) : null;
  cas.assembly.traverse((o) => {
    // the write head's layers are a transition device rather than a part: they
    // are only on screen while a track is being loaded, and the ghost system's
    // per-frame opacity is the one thing that would fight the sweep
    if (!o.isMesh || Array.isArray(o.material) || o.userData.noGhost) return;
    let keep = !sets;
    if (sets) {
      for (let n = o; n && n !== cas.assembly; n = n.parent) {
        if (sets.drop?.has(n)) { keep = false; break; }
        if (sets.keep.has(n)) { keep = true; break; }
      }
    }
    if (keep) release(o); else embrace(o);
  });
  document.body.classList.toggle('focused', !!key);
}

/* ============ the ghosts the lid's refraction was missing ================
 *
 * Look through the dust cover while a part is being read and the ghosts were not
 * there at all — on 防尘盖, where every other part of the machine is a ghost,
 * there was nothing behind the lid to see. Two of three's decisions stack up:
 *
 *   - What the glass shows *behind itself* is one render of the scene, and
 *     `renderTransmissionPass` draws `opaqueObjects` and nothing else
 *     (three.module.js:16759). A ghost is `transparent: true`, so it is in the
 *     transparent list and not in that image.
 *   - The glass itself is drawn before the transparent list and writes depth, so
 *     a ghost behind it is rejected as well. There is no second chance.
 *
 * This is the same limitation the room cross-fade ran into — see the note on the
 * backdrop in the studio set — and there the answer was to stop using a
 * transparent shell. A ghost cannot stop being transparent, so this is the other
 * way round: the ghosts are drawn a second time, into three's own transmission
 * image, once three has finished the opaque half of it.
 *
 * The moment matters. That pass writes into a 4× multisampled target, blits it to
 * the texture the glass samples (`updateMultisampleRenderTarget`) and only then
 * unbinds — so a draw added when the target is unbound is a draw nobody sees.
 * The hook is therefore the *end of the last opaque draw*: the backdrop is
 * opaque, is in the scene in every theme, and at renderOrder 999 it is the last
 * thing in that list. By then the target is still bound and still unresolved, so
 * the ghosts blend into the image itself, depth-tested against the opaque scene
 * and resolved into the texture with it — mip levels included.
 *
 * Which target that is has to be recognised rather than held, because three
 * keeps no public reference to it: it is matched on the flags it is built with,
 * and — once the glass has been drawn at least once — confirmed against the
 * texture the glass is actually sampling (`renderer.properties` is public and
 * holds a material's live uniforms). If a future three changes both, this pass
 * quietly does nothing rather than drawing into something else.
 *
 * What it looks like is deliberately the same as outside the glass: the pass runs
 * with `toneMapping` off and the nested render inherits that, so the ghost is
 * shaded exactly as the opaque parts already in that image are, and the glass
 * composites the result through its own refraction and tone mapping. */

const REFRACT_LAYER = 3;      // free: 0 is the machine, 2 is the light rig
let refractTarget = null;     // three's transmission target while its pass is open
let refractBusy = false;      // our own nested render must not re-enter this
/* The ghost pass gets a camera of its own rather than borrowing the frame's: the
   oblique clip above is written *into* a projection matrix, and the frame's
   matrix is the one the real camera is using for everything else. */
const refractCam = new THREE.PerspectiveCamera();
/* It is placed by hand every frame, and `matrixWorldAutoUpdate` has to say so:
   three recomposes a camera's world matrix from its own transform before
   rendering, which would throw the copy away and leave the pass looking out of
   the world origin. */
refractCam.matrixWorldAutoUpdate = false;
const refractPlane = new THREE.Plane(), refractNormal = new THREE.Vector3();
const refractClip = new THREE.Vector4(), refractQ = new THREE.Vector4();

/** the texture three is feeding the glass, or null before it has drawn it once */
function liveTransmissionTexture() {
  const m = cas && cas.materials ? cas.materials.glass : null;
  const props = m && renderer.properties ? renderer.properties.get(m) : null;
  const u = props && props.uniforms;
  return u && u.transmissionSamplerMap ? u.transmissionSamplerMap.value : null;
}

function isTransmissionTarget(t) {
  if (!t || t.isWebGLRenderTarget !== true) return false;
  if (t.samples !== 4 || t.resolveDepthBuffer !== false) return false;
  if (t.texture.generateMipmaps !== true) return false;
  if (t.texture.minFilter !== THREE.LinearMipmapLinearFilter) return false;
  const live = liveTransmissionTexture();
  return live === null ? true : t.texture === live;
}

/** one more draw of the ghosts, into three's transmission image, while it is
 *  still bound and still multisampled */
function drawGhostsIntoRefraction() {
  refractBusy = true;
  const autoClear = renderer.autoClear, bg = scene.background;
  const shAuto = renderer.shadowMap.autoUpdate, shNeed = renderer.shadowMap.needsUpdate;
  /* The target already holds the opaque scene and its depth, and both have to
     survive this pass: no clear, no background (the room is already in there, and
     a background render would clear the target), and no shadow pass. */
  renderer.autoClear = false;
  scene.background = null;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = false;
  /* Only what is on the far side of the pane belongs in this image. A ghost on
     the *viewer's* side of the glass is not something the glass is looking at —
     and since a ghost writes no depth, the glass is not rejected where the two
     overlap either, so drawing it in here would paint it onto the glass as well
     as in front of it. The projection is copied and folded around the pane's own
     plane as its near plane, which is the same oblique clip lidmirror.js uses to
     stop the mirror camera seeing through its plane, with the sign turned
     around: that pass keeps the viewer's side, this one keeps the far side. */
  refractCam.matrixWorld.copy(camera.matrixWorld);
  refractCam.matrixWorldInverse.copy(camera.matrixWorldInverse);
  refractCam.layers.set(REFRACT_LAYER);
  refractCam.projectionMatrix.copy(camera.projectionMatrix);
  refractPlane.setFromNormalAndCoplanarPoint(refractNormal.copy(lidMirror.plane.normal).negate(), lidMirror.plane.point);
  refractPlane.applyMatrix4(refractCam.matrixWorldInverse);
  refractClip.set(refractPlane.normal.x, refractPlane.normal.y, refractPlane.normal.z, refractPlane.constant);
  const pm = refractCam.projectionMatrix, q = refractQ;
  q.x = (Math.sign(refractClip.x) + pm.elements[8]) / pm.elements[0];
  q.y = (Math.sign(refractClip.y) + pm.elements[9]) / pm.elements[5];
  q.z = -1.0;
  q.w = (1.0 + pm.elements[10]) / pm.elements[14];
  refractClip.multiplyScalar(2.0 / refractClip.dot(q));
  pm.elements[2] = refractClip.x;
  pm.elements[6] = refractClip.y;
  pm.elements[10] = refractClip.z + 1.0 - 0.003;
  pm.elements[14] = refractClip.w;
  renderer.render(scene, refractCam);
  renderer.shadowMap.autoUpdate = shAuto;
  renderer.shadowMap.needsUpdate = shNeed;
  scene.background = bg;
  renderer.autoClear = autoClear;
  refractBusy = false;
}

/** The dust cover is not an occluder, and it is not a surface ambient occlusion
 *  should darken. It is a transparent pane, and an AO pass sees it as one more
 *  opaque surface in its normal/depth GBuffer — so it darkened the glass, and the
 *  glass occluded what is behind it, which is the one thing a window does not do.
 *
 *  GTAOPass draws that GBuffer with the scene through an override material, and
 *  that is the signature this hangs on: while an override is set, the cover is out
 *  of the render, and the moment it is back, so is the cover. Nothing else in the
 *  frame changes — the pane is still drawn, refracted and reflected exactly as
 *  before, and it costs the same; it simply stops casting and receiving screen
 *  space occlusion. */
function installGlassAOExclusion() {
  const renderScene = renderer.render.bind(renderer);
  renderer.render = function (sc, cam) {
    const gbuffer = sc.overrideMaterial != null && cas.glassMesh && cas.glassMesh.visible;
    if (gbuffer) cas.glassMesh.visible = false;
    const out = renderScene(sc, cam);
    if (gbuffer) cas.glassMesh.visible = true;
    return out;
  };
}

/** call once, after the model is in the scene and before the first frame */
function installRefractionGhosts() {
  const setTarget = renderer.setRenderTarget.bind(renderer);
  renderer.setRenderTarget = function (target, face, level) {
    if (!refractBusy) refractTarget = isTransmissionTarget(target) ? target : null;
    return setTarget(target, face, level);
  };
  backdrop.renderOrder = 999;         // last opaque draw, in every pass
  backdrop.onAfterRender = function () {
    if (refractTarget !== null && ghosts.length) drawGhostsIntoRefraction();
  };
}

/* a record is "live" when it is the one on screen and the scene is actually
   showing it — the unit record is live only while the shell is shut */
const live = (r, i) => i === ri && (r.key ? focusKey === r.key : focusKey === null);

/* Changing record rewrites the sheet that is being read — its name, its note and
   its specs. Without this it reads as text being overwritten in place, and the
   eye has nothing to follow; restarting a keyframe on it gives the change a
   direction. It is only that sheet: the number has a cursor of its own to be
   written by, the breadcrumb and the counters are one line each, and the
   reference list is the thing being clicked — a whole-panel flash took all of
   them with it, including the row under the pointer. */
function swapIn(h0) {
  const el = D.doc;
  /* The sheet is re-ruled as well as rewritten: the rule under the file number
     and the one under REFERENCE AREA draw themselves in from the left, which is
     what says a fresh slip has been laid on the plate rather than the old one
     edited. A class rather than a style so the two rules can be given different
     delays in CSS; `offsetWidth` is the forced restart, and it is one read on a
     record change. */
  clearTimeout(reprintT);
  D.dossier.classList.remove('reprint');
  void D.dossier.offsetWidth;
  D.dossier.classList.add('reprint');
  reprintT = setTimeout(() => D.dossier.classList.remove('reprint'), 900);
  /* A grow from the last pick may still be in flight. Put the box back on auto
     before measuring, or this one reads the height the last one is passing
     through and walks to a height that was never the sheet's. (Nothing is painted
     in between — the layout is read and written inside one frame.) */
  clearTimeout(docT);
  el.classList.remove('grow');
  el.style.height = '';
  el.classList.remove('swap');
  void el.offsetWidth;
  el.classList.add('swap');
  /* The sheet is a different length for every record — a spec row more or less, a
     note a line longer — and rewriting it used to move everything under it in a
     single frame. Held to the height it had for one frame and walked to the one
     it needs on the same clock as the fade above, the growth is one motion: the
     button under it rides down at the speed the box grows, because it is in the
     flow of that box and nothing else has to animate. */
  const h1 = el.getBoundingClientRect().height;
  if (reduce || !(h0 > 0) || Math.abs(h1 - h0) < 0.5) return;
  el.style.height = h0 + 'px';
  el.classList.add('grow');
  void el.offsetHeight;                  // let the old height be the starting one
  el.style.height = h1 + 'px';
  clearTimeout(docT);
  docT = setTimeout(() => {
    el.classList.remove('grow');
    el.style.height = '';                // back to auto, at the height it landed on
  }, 460);
}
let docT = 0;
let reprintT = 0;

/** Where the panel hangs from: half of what it measures when it is framed at its
    own length. Set once and on resize — never on a record change, or the panel
    would walk up the screen one record at a time. */
function pinPanel() {
  const h = D.dossier.getBoundingClientRect().height;
  if (h > 0) D.dossier.style.setProperty('--panel-half', (h / 2).toFixed(1) + 'px');
}

/* Folded, the panel has vacated the middle of the frame, so the subject takes
   it; open, the subject keeps to the left half. This is the single writer for
   the view offset — record framing used to set it directly, and
   three writers meant whichever ran last won. */
function syncViewShift() {
  // Folded, the panel retracts to the right and the subject takes the middle.
  // The tape is ~36% of the frame wide, so at 0.05 its right edge lands around
  // 63% — clear of the retracted panel, which starts at 80%.
  viewShiftTarget = folded ? 0.05 : 0.155;
}

/* The panel's length is not a state that gets toggled, it is a function of how
   close the lens is. It rests 20% short (the CSS default) and gives up another
   30% over the run from the home framing to the closest the wheel will come,
   linearly. The far end is clamped: pulling back out past the home framing is
   not a reason for the panel to grow into the frame. Damping is the margin-left
   transition the fold already runs on, so a wheel still turning is a target that
   keeps moving rather than a second smoothing stacked on top of the first. */
const GIVE_FROM = orbit.home.radius, GIVE_TO = orbit.minR, GIVE_MAX = 30;
/* Where the shortening stops being a shorter panel and becomes no panel.

   A notch and a half short of the closest framing: 让出 45%, the column down to
   55% of its length. Pushed all the way to the stop it was too late — the fold
   only arrived once the lens had nothing left to do — and a third of the way in
   (30%, then 33%) was too early, so the line sits just inside the end of the
   travel now, and 收起详情 is still there for folding a readable panel by hand at
   any framing. Pushing it deeper is one number: 让出 40% is FOLD_AT 20.

   One line, crossed both ways. It used to fold at ten points of give but only
   unfold back at zero — the framing right in at the home radius — so pulling the
   wheel out to where it had just left from left the panel away, and it took
   another two thirds of a retreat to bring it back. The wheel's own position is
   the thing the eye is holding while it scrolls, so that is the thing the fold
   follows: the same line in both directions.

   What it is *not* is a pure function of where the wheel is. The decision is
   taken on the crossing, not on the side the wheel happens to be on: otherwise
   收起详情 could not be used at all — every frame would put the panel straight
   back the way the wheel wants it — and that button is the one way to fold a
   perfectly readable panel out of the way. Between crossings, whatever it is
   stays what it is. Nothing flaps on the line either: a notch is about five
   points of give at this end of the range, so there is no landing on it. */
const FOLD_AT = 25;
let lastGive = 0;              // where the wheel stood when the fold last looked
const giveFor = (r) => clamp((GIVE_FROM - r) / (GIVE_FROM - GIVE_TO), 0, 1) * GIVE_MAX;

let given = -1;
function syncPanelGive() {
  const give = giveFor(orbit.radius);
  // this lands on an element that is already animating, every frame; a tenth of
  // a percent is well under anything the transition can show
  if (Math.abs(give - given) < 0.1) return;
  given = give;
  D.dossier.style.setProperty('--give', give.toFixed(1));
}

/* One writer for the fold, and two reasons to want it. 细节特写 is one: that
   vantage puts the lens in close enough that the tape runs under this column, so
   the vantage folds the panel itself, deliberately and at once — it used to be
   asked to shorten 34% and ended up folding anyway, two beats late, because the
   distance mapping had already taken more off it than that. The wheel is the
   other, once the shortening has gone past 30% (FOLD_AT above).
   Both read the wheel's *target*, not the damped radius: the camera eases in
   asymptotically and would never quite arrive at the clamp, and the fold has to
   fire on the notch that asks for it rather than a second later. The latch is
   what keeps the two from arguing over the panel — whatever it is between the
   lines stays, so one unfolded by hand stays unfolded. */
let wantFold = false;
function syncPanelFold() {
  const give = giveFor(orbit.gRadius);
  const over = give >= FOLD_AT;
  const wasOver = lastGive >= FOLD_AT;
  lastGive = give;
  let want = wantFold;
  if (vi === MACRO) want = true;
  else if (over !== wasOver) want = over;      // the wheel crossed the line
  if (want === wantFold) return;
  wantFold = want;
  setFold(want);
}

let folded = false, foldCamT = 0;
function setFold(on) {
  folded = on;
  D.dossier.classList.toggle('folded', on);
  D.fold.setAttribute('aria-expanded', String(!on));
  D.fold.textContent = on ? '展开详情' : '收起详情';
  // the camera moves on the second beat: it waits for the body to finish
  // collapsing, then travels in with the retract. Unfolding is the reverse —
  // the camera comes back first, while the body is still shut.
  // the delay exists to wait out the panel's own two-beat collapse; with the
  // transitions off there is nothing to wait for
  clearTimeout(foldCamT);
  if (on && !reduce) foldCamT = setTimeout(syncViewShift, 400);
  else syncViewShift();
}
D.fold.addEventListener('click', () => {
  setFold(!folded);
  audio.tick();
  document.body.classList.add('moved');
});

/* ---------- the number, written rather than switched ----------
   The bar beside the file number is a nib, not a cursor (it does not blink — see
   .caret), and it works the number over the way a hand would: a stroke to the
   left laying a mask down behind it, a beat with the whole number covered, then a
   stroke back to the right taking the mask away again.

   The mask is what does the erasing. The nib does not delete digits one at a
   time, which pops a glyph out of the line every time it moves — it covers them:
   the digits to its right are hidden under a clip whose edge *is* the nib, so the
   number is wiped away rather than eaten. Nothing is removed until all of it is
   under the mask, and that is where the old digits trade places with the new ones
   — where nobody can see it happen. The clip is on the number alone: the label
   beside it, the rule under it, the panel and the scene are all untouched.

   Three things have to line up for this to read, and only the first is obvious:
   the nib's edge has to be on the mask's edge (it is the nib that hides the hard
   cut, so it is centred on it); the nib has to travel *past* the number, not stop
   at it (its stroke is twice the number's width, which carries it out into the
   gap and leaves it standing just short of the label); and the stroke has to
   arrive — fast off the mark, slowing, stopped — because a nib that slides in at
   a constant speed and reverses reads as a wipe rather than as a hand.

   Driven from the main loop's clock like everything else in the scene: a CSS
   animation would run in wall-clock time, and the mask would drift out from under
   the nib the moment a frame cost more than the last. */
/* Off the mark, slowing, stopped — the shape a hand has. A stroke spends most of
   its deceleration on the overrun past the number (the mask is already across
   before the nib has finished travelling), so the phases are kept short: the wipe
   is the first half of a stroke and the rest of it is the nib settling. */
const NO_ERASE = 0.30, NO_HOLD = 0.12, NO_TYPE = 0.36;
/* How far one stroke runs, as a multiple of the number's own width. Past 1 the
   nib clears the far end of the number and comes to rest just outside it; at
   exactly 1 it stops on the last digit, which reads as being cut short. */
const NO_TRAVEL = 1.75;
const no = {
  on: false, phase: 0, p: 0, d: 0, d0: 0, lead: 0, w: 0, travel: 0, cap: 2, from: '', to: '',
};
let noText = D.fileId.textContent;        // the value, not whatever is painted
const NO_STROKE = (t) => ease.out(t);     // fast, then slowing, then stopped

/** one instant of the stroke.
    `d` is how far the nib has travelled from where it stands at rest, `lead` is
    the distance between that rest and the near end of the number, so the mask
    only starts to cover once the nib has crossed the lead and it is full — for
    the rest of the stroke — at the far end of the number. */
function paintNo() {
  const m = clamp(no.d - no.lead, 0, no.w);       // how much of the number is under it
  D.fileId.textContent = no.phase === 0 ? no.from : no.to;
  D.fileId.style.clipPath = m <= 0.02 ? '' : `inset(0 ${m.toFixed(2)}px 0 0)`;
  D.caret.style.transform = `translate(${(-no.d).toFixed(2)}px, .06em)`;
}

function endNo() {
  no.on = false;
  no.d = 0;
  D.fileId.textContent = noText;
  D.fileId.style.minWidth = '';
  D.fileId.style.clipPath = '';
  D.caret.style.transform = '';
}

/** the one writer of the number. `animate: false` is how a deep link lands — that
    URL exists to be photographed, and a nib caught mid-stroke is not it. */
function setFileNo(text, animate = true) {
  if (text === noText) return;
  noText = text;
  if (!animate || reduce) { endNo(); return; }
  /* A browse that lands mid-stroke carries on from where the nib is. An erase or
     a beat that is interrupted only retargets — the mask is already where it is,
     and `to` is the whole of what changes. A *return* that is interrupted turns
     the nib around: it goes back over the digits it had been revealing, which is
     what a hand does when it changes its mind halfway through a line. */
  if (!no.on) { no.from = D.fileId.textContent; no.d = 0; no.phase = 0; no.p = 0; }
  else if (no.phase === 2) { no.from = no.to; no.phase = 0; no.p = 0; }
  /* phase 0 (mid-erase): the stroke carries on — same clock, same mask, and only
     the destination changed. phase 1 (the beat): the mask is already across, so
     the beat finishes and the new number is revealed under it. */
  no.d0 = no.d;
  no.to = text;
  no.cap = Math.max(no.from.length, no.to.length, 1);
  no.on = true;
  D.fileId.style.minWidth = no.cap + 'ch';   // the reserve has to be in place first
  no.w = D.fileId.getBoundingClientRect().width;   // so this reads the box, not the text
  // the nib's rest sits one flex gap clear of the number, so the mask cannot
  // start until it has crossed that gap; and it is centred on the mask's edge,
  // because a 6px nib is the only thing hiding that cut
  const gap = parseFloat(getComputedStyle(D.fileno).columnGap) || 0;
  no.lead = gap + D.caret.offsetWidth / 2;
  no.travel = no.w * NO_TRAVEL;
  paintNo();
}

/** land it settled (deep links, reduced motion, a reset) */
function snapFileNo() {
  if (no.on) endNo();
  else D.fileId.textContent = noText;
}

function updateFileNo(dt) {
  if (!no.on) return;
  no.p += dt / (no.phase === 0 ? NO_ERASE : no.phase === 1 ? NO_HOLD : NO_TYPE);
  if (no.p >= 1) {
    if (no.phase === 0) {
      no.phase = 1;                       // the mask is across: now the beat, and the
      no.p = 0;                           // two numbers trade places inside it, where
      no.d = no.travel;                   // nothing of either of them can be seen
      paintNo();
      return;
    }
    if (no.phase === 1) {
      no.phase = 2;
      no.p = 0;
      no.d = no.travel;
      paintNo();
      return;
    }
    endNo();
    return;
  }
  // The beat stands still — nib and mask both. (Falling through to the stroke
  // below was the bug: the beat has no travel of its own, so it recomputed the
  // position from the erase's starting point and threw the nib back to the right
  // for a tenth of a second before the return began.)
  if (no.phase === 1) return;
  no.d = no.phase === 2
    ? no.travel * (1 - NO_STROKE(no.p))    // ...and the return is a stroke too: fast
    : no.d0 + (no.travel - no.d0) * NO_STROKE(no.p);   // off the mark, then stopped
  paintNo();
}

function render(bump = false) {
  const R = cur();
  // measured before the sheet is rewritten: swapIn() walks the box from this
  const docH = D.doc.getBoundingClientRect().height;
  swapText(D.colCn, R.cn);
  setFileNo(R.no);
  D.fileCn.textContent = R.cn;
  D.fileEn.textContent = R.en;
  D.fileNote.textContent = R.note;
  setRoll(D.selI, R.no);
  swapText(D.accessLabel, R.act);
  D.access.classList.toggle('done', live(R, ri));
  // only rebuild the spec rows when the record actually changed — render runs
  // on every arrow press and theme switch, and a rebuild drops hover state
  if (D.fileSpec.dataset.no !== R.no) {
    D.fileSpec.dataset.no = R.no;
    D.fileSpec.replaceChildren(...R.spec.map(([k, v], i) => {
      const li = document.createElement('li');
      // the row's index, for the cascade in styles.css: the table arrives in
      // order rather than as one block
      li.style.setProperty('--i', i);
      li.innerHTML = `<span>${k}</span><b>${v}</b>`;
      return li;
    }));
  }

  // 细节特写 folds the panel (see syncPanelFold). This is the state it falls
  // back into if that fold is undone by hand: still narrowed, because the tape
  // is still running under the column, but with the spec table back on screen
  D.dossier.classList.toggle('tight', vi === MACRO);

  // the vantage read-out falls back to the record's own framing, and says so
  const V = vi >= 0 ? VANTAGES[vi] : null;
  setRoll(D.colI, V ? String(vi + 1).padStart(2, '0') : '--');
  swapText(D.colCn2, V ? V.cn : R.viewName);
  swapText(D.colEn, V ? V.en : R.viewEn);

  // the pick list and the ticks are the same six records at two sizes. Both
  // were built once, further up — rebuilding them here would replace the
  // elements, and a fresh element starts already in its final state, so the
  // marker would jump instead of sliding
  for (let i = 0; i < RECORDS.length; i++) {
    const l = live(RECORDS[i], i);
    refRows[i].className = 'row' + (i === ri ? ' sel' : '') + (l ? ' done' : '');
    ticks[i].className = 'tick' + (i === ri ? ' on' : '') + (l ? ' done' : '');
  }
  syncIndexSel();
  if (bump) swapIn(docH);
}

/* Reading is the one action that changes the scene: it opens the shell,
   isolates the record's part and reframes the camera onto it. Browsing with
   the arrows only moves the cursor, so nothing jumps while you read. */
function readRecord(instant = false, moveCam = true) {
  const R = cur();
  homeArmed = false;                  // a record ends on its own framing
  applyFocus(R.key);
  // with the lens left alone (the intro is driving it) the panel keeps naming
  // the vantage that is actually on screen — the intro lands on VANTAGES[0]
  if (moveCam) {
    vi = -1;                                 // the record brings its own framing
    orbit.setPreset(R.view, instant);
    if (!instant && orbit.tween) orbit.tween.dur = 1.6;
  }
  syncViewShift();
  audio.tick();
  document.body.classList.add('moved');
  render(true);
  if (instant) snapFileNo();               // a deep link lands settled, cursor included
}
function moveRecord(d) { ri = (ri + d + RECORDS.length) % RECORDS.length; audio.tick(); render(true); }
function setVantage(i) {
  // `vi = -1` is a record's own framing: there is no vantage to count from, so
  // the first step lands on the end it is stepping toward — ← goes to the last
  // vantage, → to the first. Wrapping from -1 lands on 03 instead, which is
  // neither the previous nor the last one.
  vi = vi < 0 ? (i < 0 ? VANTAGES.length - 1 : 0) : (i + VANTAGES.length) % VANTAGES.length;
  homeArmed = false;                  // this *is* a framing, not a detour from one
  orbit.setPreset(VANTAGES[vi].v, false);
  if (orbit.tween) orbit.tween.dur = 1.2;
  audio.tick();
  document.body.classList.add('moved');
  render();
}

function setAuto(on) {
  autoRotate = on;
  if (on) homeArmed = false;          // the model turning itself beats returning
  orbit.setAuto(on);
  $('#btn-auto').classList.toggle('on', on);
  $('#btn-auto').setAttribute('aria-pressed', String(on));
}
function setMute(on) {
  muted = on;
  audioEl.muted = on;
  document.body.classList.toggle('muted', on);
  $('#btn-mute').setAttribute('aria-pressed', String(on));
  audio.setLevel(bedLevel());
}


/* the speaker is a knob as well as a switch: wheel over it to set the level,
   click (or M) to cut the music. Turning it all the way down *is* muted, so the
   icon can never claim to be playing something it is not; turning it back up
   lifts the mute, which is what a hand on a knob expects. */
const volRead = $('#vol-read');
const muteBtn = $('#btn-mute');
let volFlash = 0;
function showVolume() {
  swapText(volRead, muted ? '静音' : `${Math.round(volume * 100)}%`);
  muteBtn.classList.add('show-vol');
  clearTimeout(volFlash);
  volFlash = setTimeout(() => muteBtn.classList.remove('show-vol'), 1100);
}
function setVolume(v, { unmute = false, flash = true } = {}) {
  // snapping through the 5% grid in one step rather than v/0.05*0.05, which
  // lands on 0.30000000000000004 and prints as "30%" only by luck of rounding
  volume = Math.max(0, Math.min(1, Math.round(v * 20) / 20));
  audioEl.volume = volume;
  // the arcs follow the level too: one below half, two above, none when silent
  muteBtn.classList.toggle('vol-lo', volume < 0.5);
  if (volume === 0 && !muted) setMute(true);
  else if (unmute && muted && volume > 0) setMute(false);
  audio.setLevel(bedLevel());
  if (flash) showVolume();
}
/* ---------- the full index, for when five columns do not fit on screen ---- */
const indexEl = $('#index'), indexCols = $('#index-cols');
let indexOpen = false;
function buildIndex() {
  indexCols.replaceChildren(...RECORDS.map((R, x) => {
    const d = document.createElement('div');
    d.className = 'icol' + (x === ri ? ' on' : '');
    // the card's index, for the cascade in styles.css
    d.style.setProperty('--i', x);
    const h = document.createElement('button');
    h.className = 'icol-h';
    h.innerHTML = `<span>${R.no} ${R.cn}</span><em>${R.en}</em>`;
    h.addEventListener('click', () => { ri = x; closeIndex(); readRecord(); });
    d.appendChild(h);
    const ul = document.createElement('ul');
    ul.className = 'spec';
    ul.replaceChildren(...R.spec.map(([k, v]) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${k}</span><b>${v}</b>`;
      return li;
    }));
    d.appendChild(ul);
    return d;
  }));
  syncIndexSel();
}
function syncIndexSel() {
  if (!indexOpen) return;
  indexCols.querySelectorAll('.icol').forEach((c, x) => c.classList.toggle('on', x === ri));
}
function openIndex() {
  indexOpen = true;
  buildIndex();
  indexEl.hidden = false;
  requestAnimationFrame(() => indexEl.classList.add('open'));
  document.body.classList.add('moved');
}
function closeIndex() {
  if (!indexOpen) return;
  indexOpen = false;
  indexEl.classList.remove('open');
  setTimeout(() => { if (!indexOpen) indexEl.hidden = true; }, 600);
}
const toggleIndex = () => (indexOpen ? closeIndex() : openIndex());

/* ---------- settings ----------
   Five switches for the things a visitor to a tape deck would actually reach for,
   and every one of them is a knob the page already had: the opening move, what
   happens when the tape runs out, whether the machine hisses, whether the key
   legend is in the way, and whether the floor keeps its mirror. Nothing here
   needed new machinery — it needed a handle on machinery that was already there.
   The sheet is the ARCHIVE INDEX overlay with five rows in it, because the page
   has exactly one way of putting a sheet over itself and this is it.

   The switches are remembered (localStorage, guarded: a blocked store just means
   the page boots as it shipped). They are the one thing here that is *supposed*
   to outlive a reload — the music deliberately is not (see 音乐 in the README). */
const PREF_KEY = 'ohmtape.prefs';
/* `vig` is the sheet's one dial rather than a switch: 0 to 1 (50% out of the box),
   scaling whatever strength the room itself asks for (see applyTheme).
   `v` is the generation those defaults belong to, and it is here because a stored
   value outranks a new default: the dial shipped at 0, every browser that had ever
   touched a setting was holding that 0, and changing the default would have been
   invisible to exactly the people who had used the page. So a `vig` written under
   an older generation is not read back — once — while every other switch is still
   whatever the visitor left it at. */
const PREF_V = 2;
const prefs = { intro: true, loop: true, hiss: true, keys: true, mirror: true, refraction: true, vig: 0.5 };
try {
  const saved = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
  const stale = saved.v !== PREF_V;
  for (const k of Object.keys(prefs)) {
    if (stale && k === 'vig') continue;
    if (typeof saved[k] === typeof prefs[k]) prefs[k] = saved[k];
  }
  prefs.vig = clamp(prefs.vig, 0, 1);
} catch { /* no store: the defaults are the page */ }
const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify({ v: PREF_V, ...prefs })); } catch { /* nothing to do */ } };

const SETTINGS = [
  { k: 'intro', cn: '开场动画', en: 'OPENING MOVE', note: '打开时那 3.4 秒的推轨与浮起，下次打开生效。' },
  { k: 'loop', cn: '循环播放', en: 'AUTO RETURN', note: '放完自动抬臂回位再落针；关掉则回到开头停住。' },
  { k: 'hiss', cn: '黑胶底噪', en: 'VINYL NOISE', note: '针尖划过沟槽的嘶声与马达嗡声，不含换片声与旋钮声。' },
  { k: 'keys', cn: '按键提示', en: 'KEY LEGEND', note: '底部那行快捷键说明。' },
  { k: 'mirror', cn: '地面镜像', en: 'FLOOR MIRROR', note: '地面实时反射，关掉可省一整遍场景渲染。' },
  { k: 'refraction', cn: '玻璃折射', en: 'GLASS REFRACTION', note: '防尘盖的实时光线折射：透过它看到的东西会被真的弯折。关掉换成一块平板玻璃，省一遍透射渲染，盖子后面也不再变形。' },
  { k: 'vig', cn: '暗角', en: 'VIGNETTE', dial: true, note: '画面四周压暗，像镜头前的遮光罩。滑条调的是强度，三套灯光各留自己的深浅。' },
];

/** what a switch does. `intro` is read once by the boot flow and `loop` where the
    tape runs out, so neither has anything to do here — and `vig` needs nothing
    either: applyTheme() reads it every frame, so the vignette walks itself out
    on the next one. */
function applyPref(k) {
  if (k === 'hiss') audio.setLevel(bedLevel());
  else if (k === 'keys') document.body.classList.toggle('keys-off', !prefs.keys);
  else if (k === 'mirror') floorBase.setEnabled(prefs.mirror && quality > 0.8);
  // `cas` is built after the first applyPrefs pass, so the guard is load-bearing
  // rather than defensive: without it the boot would throw on a setting the page
  // has not built the thing for yet.
  else if (k === 'refraction' && cas) {
    cas.setRefraction(prefs.refraction);
    // and the pass behind it: with the lid flat there is nothing transmissive to
    // reflect into, so the render would be paid for and thrown away
    lidMirror.setEnabled(prefs.refraction);
  }
}
function applyPrefs() { for (const k of Object.keys(prefs)) applyPref(k); }

const settingsEl = $('#settings'), setList = $('#set-list'), settingsBtn = $('#btn-settings');
let setOpen = false;

/* The dial's rail: `--fill` is how much of the hairline is ink, which is the same
   language the segmented control speaks — ink for what is set. It is a style
   property rather than a class because it moves continuously. */
const DIAL_STEPS = 20;                 // one detent per 5%, and one click with it
function paintDial(s) {
  const v = prefs[s.k];
  s.dialEl.value = String(v);
  // the same `--p` the transport's rail reads: the fill is an element that
  // scales, so a click on the rail slides instead of jumping. It lives on the
  // track's wrapper so the fill and the input share one number.
  s.dialEl.parentElement.style.setProperty('--p', v.toFixed(3));
  // 0 is the switch it used to be, and 关 is what this sheet says for off
  const label = v > 0 ? Math.round(v * 100) + '%' : '关';
  setRoll(s.valEl, label);
  // read from the label rather than from the element: a rolled read-out's
  // textContent is the live cells *plus* whatever ghost is mid-flight
  s.dialEl.setAttribute('aria-valuetext', label);
}
function syncSettings() {
  for (const s of SETTINGS) {
    if (s.dial) { paintDial(s); continue; }
    for (const b of s.seg.children) {
      const on = (b.dataset.v === '1') === prefs[s.k];
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }
}
function setPref(s, v) {
  if (prefs[s.k] === v) return;
  prefs[s.k] = v;
  savePrefs();
  applyPref(s.k);
  syncSettings();
  // a switch ticks once per press; the dial ticks per detent, from its own
  // handler, or a drag would fire a burst of them
  if (!s.dial) audio.tick();
  document.body.classList.add('moved');
}
/* built when the sheet is opened, like the index's cards, and rebuilt each time:
   the state can only have changed from in here */
function buildSettings() {
  setList.replaceChildren(...SETTINGS.map((s, i) => {
    const li = document.createElement('li');
    li.className = 'set-row';
    // the row's index, for the cascade in styles.css
    li.style.setProperty('--i', i);
    const t = document.createElement('div');
    t.className = 'set-t';
    t.innerHTML = `<b>${s.cn}</b><i>${s.en}</i><em>${s.note}</em>`;
    if (s.dial) {
      const box = document.createElement('div');
      box.className = 'set-dial';
      // the same parts as the transport's rail: a track, an ink fill that scales,
      // and the native range above them. Two rails on one page, one language.
      const track = document.createElement('div');
      track.className = 'dial-track';
      const fill = document.createElement('i');
      fill.className = 'rail-fill';
      fill.setAttribute('aria-hidden', 'true');
      const r = document.createElement('input');
      r.type = 'range'; r.min = '0'; r.max = '1'; r.step = String(1 / DIAL_STEPS);
      r.className = 'ui-hit';
      r.setAttribute('aria-label', `${s.cn}强度`);
      track.append(fill, r);
      const out = document.createElement('b');
      out.className = 'set-val';      // the vignette is damped in applyTheme, so the picture follows the thumb
      // a beat behind it — which is what a knob on a machine does
      let detent = Math.round(prefs.vig * DIAL_STEPS);
      r.addEventListener('input', () => {
        const v = Number(r.value);
        const k = Math.round(v * DIAL_STEPS);
        if (k !== detent) { detent = k; audio.tick(); }
        setPref(s, v);
      });
      box.append(track, out);
      s.dialEl = r; s.valEl = out;
      li.append(t, box);
      return li;
    }
    const seg = document.createElement('div');
    seg.className = 'seg';
    for (const v of [true, false]) {
      const b = document.createElement('button');
      b.className = 'ui-hit';
      b.textContent = v ? '开' : '关';
      b.dataset.v = v ? '1' : '0';
      b.addEventListener('click', () => setPref(s, v));
      seg.appendChild(b);
    }
    s.seg = seg;
    li.append(t, seg);
    return li;
  }));
  syncSettings();
}
function openSettings() {
  setOpen = true;
  buildSettings();
  settingsEl.hidden = false;
  requestAnimationFrame(() => settingsEl.classList.add('open'));
  // the gear stays turned while the sheet is up, so the button reads as open
  settingsBtn.classList.add('open');
  settingsBtn.setAttribute('aria-expanded', 'true');
  document.body.classList.add('moved');
}
function closeSettings() {
  if (!setOpen) return;
  setOpen = false;
  settingsEl.classList.remove('open');
  settingsBtn.classList.remove('open');
  settingsBtn.setAttribute('aria-expanded', 'false');
  setTimeout(() => { if (!setOpen) settingsEl.hidden = true; }, 600);
}
const toggleSettings = () => (setOpen ? closeSettings() : openSettings());

settingsBtn.addEventListener('click', () => { toggleSettings(); audio.tick(); });
$('#settings-close').addEventListener('click', () => { closeSettings(); audio.tick(); });
settingsEl.addEventListener('click', (e) => { if (e.target === settingsEl) closeSettings(); });

function reinit() {
  ri = 0; vi = 0;
  // the intro owns the lens *and* the cassette's lift for its first three
  // seconds. Left running, it keeps writing intro.y every frame and the shell
  // floats on up out of a reset that was supposed to put it back on the table.
  tl = null;
  intro.y = 0; intro.tilt = 0; intro.spin = 0; intro.fade = 1;
  setFold(false);
  closeIndex();
  closeSettings();
  applyFocus(null);
  setMute(false);
  setAuto(false);
  // reinitialize puts the deck back the way it is found: lid up
  setLid(true);
  syncViewShift();
  if (cas.st.playing) togglePlay(false);
  audioEl.currentTime = 0;
  mode = 'idle';
  document.body.classList.remove('rewinding');
  reinitTrack();                      // ...and the record it shipped with
  setTheme('studio');
  orbit.setPreset(VANTAGES[0].v, false);
  if (orbit.tween) orbit.tween.dur = 1.4;
  audio.clunk(0.7);
  render();
}

/* ---------- wiring ---------- */
$('#btn-auto').addEventListener('click', () => { setAuto(!autoRotate); audio.tick(); render(); });
$('#btn-auto').classList.toggle('on', autoRotate);
$('#btn-auto').setAttribute('aria-pressed', String(autoRotate));
$('#btn-play').addEventListener('click', () => { togglePlay(); audio.tick(); render(); });
$('#btn-mute').addEventListener('click', () => { setMute(!muted); showVolume(); audio.tick(); render(); });
/* The wheel is captured on the button itself and stopped there: the orbit
   control listens on `window`, so without stopPropagation the same notch would
   set the volume *and* push the lens. preventDefault keeps the page from
   scrolling behind it. */
$('#btn-mute').addEventListener('wheel', (e) => {
  e.preventDefault();
  e.stopPropagation();
  // one notch is one step, however coarse the device's delta is; and scrolling
  // up out of a mute lifts the mute rather than sitting there doing nothing
  const up = e.deltaY < 0;
  setVolume(volume + (up ? VOL_STEP : -VOL_STEP), { unmute: up });
  audio.tick();
}, { passive: false });
setVolume(volume, { flash: false });
$('#btn-lid').addEventListener('click', () => { setLid(!lidOpen); audio.tick(); render(); });
$('#theme').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) { setTheme(b.dataset.theme); audio.tick(); document.body.classList.add('moved'); }
});
// wrapped, not passed by reference: readRecord's first parameter is `instant`,
// and a listener called with the click event would read that MouseEvent as
// `true` — snapping the shell open and cutting the camera instead of easing
$('#btn-access').addEventListener('click', () => readRecord());
$('#btn-index').addEventListener('click', toggleIndex);
$('#index-close').addEventListener('click', closeIndex);
$('#btn-reinit').addEventListener('click', reinit);

/* ---------- the seek rail -------------------------------------------------
   A real <input type="range">, not a div with a pointer handler: the drag, the
   click-to-jump, the arrow keys, Home/End and the slider role all arrive
   already working, and the settings sheet already styles one of these — so the
   rail under the counter and the dial in the sheet are visibly the same part.
   The filled part of the rail is its own element (`.rail-fill`), sized by `--p`
   as a fraction of the rail: a gradient stop could not be interpolated, so a
   click on the rail teleported the ink. `--p` is written on the *track*, so the
   fill, the tick scale and the input all read one number.

   Two things the loop may not do to it. It may not write the value back while a
   hand is on it — `scrubbing` is that lock, and without it the thumb is dragged
   one way and pushed the other. And it may not decide where the tape is after a
   seek: `cas.setProgress()` is the picture's opinion of the same number the
   audio element was just given, so tape and sound land together. */
const seekEl = $('#seek');
const railEl = seekEl.parentElement;
let scrubbing = false;
let railShown = -1;                     // what the fill currently shows, so the
                                        // loop only writes when it moves

/** put the tape where the hand put the rail, and the read-out with it */
function seekTo(frac) {
  if (!cas) return;
  const dur = audioOk() ? audioEl.duration : cas.st.duration;
  if (!(dur > 0)) return;
  const f = clamp(frac, 0, 1);
  // A seek is a positioning action, so it ends a spool-back rather than
  // interrupting one: the reel is taken, the run is abandoned, and the
  // transport is left standing at the point it was dropped on. `dir` has to be
  // set back to forward by hand — left on the rewind it would spool to the end
  // the moment play was pressed again.
  if (mode === 'rew') togglePlay(false);
  cas.st.dir = -1;
  if (audioOk()) audioEl.currentTime = f * dur;
  cas.setProgress(f);
  // the loop's counter tick is a fifth of a second behind a hand; this is the
  // one place the two clocks are told to agree now
  const tc = $('#tc');
  const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  setRoll(tc, fmt(f * dur));
  seekEl.value = String(f);
  railShown = f;
  railEl.style.setProperty('--p', f.toFixed(4));
  document.body.classList.add('moved');
}
seekEl.addEventListener('pointerdown', () => { scrubbing = true; });
seekEl.addEventListener('input', () => { scrubbing = true; seekTo(+seekEl.value); });
seekEl.addEventListener('change', () => { scrubbing = false; seekTo(+seekEl.value); });
seekEl.addEventListener('pointerup', () => { scrubbing = false; });
seekEl.addEventListener('keyup', () => { scrubbing = false; });
/* the native range only steps, so the two ends of the tape are asked for by
   name — a listener here cannot reach the global one, which already hands the
   arrows to a focused range and would otherwise step the vantage instead */
seekEl.addEventListener('keydown', (e) => {
  if (e.key === 'Home') { e.preventDefault(); seekTo(0); }
  else if (e.key === 'End') { e.preventDefault(); seekTo(1); }
});

/* ---------- the key legend is a read-out, not a caption -------------------
   Each chip carries the key it names (data-k), and the chip lights for as long
   as the key is held. One querySelector per keystroke; it is the only place the
   page admits out loud which keys it is listening for, and a legend that
   answers back stops being furniture. */
const keyChips = [...document.querySelectorAll('#keys .kg')];
const chipFor = (k) => keyChips.find((c) => (c.dataset.k || '').split(' ').includes(k));
const chipKey = (e) => (e.key === ' ' ? 'space' : String(e.key || '').toLowerCase());
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const c = chipFor(chipKey(e));
  if (c) c.classList.add('hit');
});
addEventListener('keyup', (e) => {
  const c = chipFor(chipKey(e));
  if (c) c.classList.remove('hit');
});
// a key still held when the window loses focus never sends its keyup
addEventListener('blur', () => { for (const c of keyChips) c.classList.remove('hit'); });

/* ---------- ADD MUSIC ----------
   One file, and it replaces what is in the shell — the page is a single tape,
   and the ARCHIVE INDEX is a list of parts rather than of tracks. Whatever the
   user picks is named by its own tags where it has them and by its file name
   where it does not (src/tags.js), and the plate is rewritten to say so. */
const addBtn = $('#btn-add'), addRead = $('#add-read'), fileInput = $('#tape-file');
let addFlash = 0;
function flashAdd(msg) {
  clearTimeout(addFlash);
  if (!msg) { addBtn.classList.remove('show-vol'); return; }
  addRead.textContent = msg;
  addBtn.classList.add('show-vol');
  addFlash = setTimeout(() => addBtn.classList.remove('show-vol'), 1400);
}
function openPicker() {
  // clearing first, so re-picking the file that is already in there still fires
  fileInput.value = '';
  fileInput.click();
  audio.tick();
}
async function addFiles(files) {
  const file = [...files].find(looksLikeAudio);
  if (!file) { flashAdd('不是音频文件'); return; }
  if (swap.state !== 'idle') { flashAdd('正在装入'); return; }
  flashAdd('正在装入');
  const tags = await readTags(file);          // guarded inside: always an object
  applyTrack({ ...tags, src: URL.createObjectURL(file), file });
}
addBtn.addEventListener('click', openPicker);
fileInput.addEventListener('change', () => {
  if (fileInput.files?.length) addFiles(fileInput.files);
});
/* and one dropped anywhere on the page does the same. `dragover` has to be
   cancelled or the browser navigates away to the file instead of handing it
   over — and the canvas' own drag is pointer-based, so the two never meet. */
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});
indexEl.addEventListener('click', (e) => { if (e.target === indexEl) closeIndex(); });
for (const b of document.querySelectorAll('.pk')) {
  b.addEventListener('click', () => {
    const a = b.dataset.act;
    if (a === 'prev-file') moveRecord(-1);
    else if (a === 'next-file') moveRecord(1);
    else if (a === 'prev-col') setVantage(vi - 1);
    else setVantage(vi + 1);
    b.classList.add('flash');
    setTimeout(() => b.classList.remove('flash'), 240);
  });
}

addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  // a focused control owns Space and Enter; intercepting them here would make
  // Tab-to-the-fold-button then Enter read a record instead of folding
  const tag = e.target?.tagName;
  if ((k === ' ' || k === 'Enter') && (tag === 'BUTTON' || tag === 'INPUT')) return;
  // one layer at a time: the overlay, then the shell, then the panel
  if (k === 'Escape') {
    if (setOpen) closeSettings();           // the sheet on top closes first
    else if (indexOpen) closeIndex();
    else if (folded) { setFold(false); audio.tick(); render(); }
    return;
  }
  if (k === 'Enter') {
    e.preventDefault();
    // read with the index still up and the whole scene changes behind an
    // opaque panel. Close first, exactly like the cards do.
    if (indexOpen) closeIndex();
    readRecord();
    return;
  }
  // a focused dial owns its arrows, or the panel would step the vantage out
  // from under the thumb. Escape above still reaches the sheet.
  if (e.target?.type === 'range') return;
  if (k === 'ArrowUp') { e.preventDefault(); moveRecord(-1); return; }
  if (k === 'ArrowDown') { e.preventDefault(); moveRecord(1); return; }
  if (k === 'ArrowLeft') { e.preventDefault(); setVantage(vi - 1); return; }
  if (k === 'ArrowRight') { e.preventDefault(); setVantage(vi + 1); return; }
  if (k === ' ') { e.preventDefault(); togglePlay(); render(); return; }
  const l = k.toLowerCase();
  if (l === 'f') setLid(!lidOpen);
  else if (l === 'a') setAuto(!autoRotate);
  else if (l === 'm') { setMute(!muted); showVolume(); }
  else if (l === 'i') toggleIndex();
  else if (l === ',') toggleSettings();
  else if (l === 'o') { openPicker(); return; }      // the picker is the feedback
  else return;
  document.body.classList.add('moved');
  render();
});

/* Pressing play does not start the record, it starts the *deck*: the lid comes
   up, the platter spins, the arm swings over and lowers. The music is armed
   here and released in loop() on the frame the stylus lands (`cas.st.landed`),
   because starting the track on the press plays the first bar to a needle that
   is still in the air — about 0.6 s of it. */
let cueArmed = false;

function togglePlay(force) {
  const st = cas.st;
  const on = force ?? !st.playing;
  if (on && mode === 'rew') return;               // wait for the spool-back
  // The write head is crossing the card: the duration the reels would be driven
  // from is about to be replaced, so the press is held until the print lands.
  if (swap.state !== 'idle') {
    if (on) { swap.play = true; document.body.classList.add('moved'); }
    return;
  }
  st.playing = on;
  document.body.classList.toggle('playing', on);
  // the label always names what pressing it does next, so the idling state
  // says 落针 — the same word it says before the first press
  swapText($('#play-label'), on ? '抬臂' : '落针');
  if (on) {
    mode = 'play';
    if (audioOk()) {
      if (audioEl.ended || audioEl.currentTime > audioEl.duration - 0.08) audioEl.currentTime = 0;
      // armed, not played — see the note on `cueArmed`
      cueArmed = true;
    }
    // The bed is the motor and the surface, and the motor *does* start on the
    // press: the platter is already turning while the arm is still on its way
    // down. Only the record itself waits for the needle.
    audio.setLevel(bedLevel());
    audio.start();
  } else {
    cueArmed = false;
    audioEl.pause();
    audio.stop();
    // Pausing mid spool-back has to leave 'rew' behind as well. Left in it, the
    // guard at the top of this function ("wait for the spool-back") refuses the
    // *next* press too, and the transport is dead until a reinitialize. dir
    // stays +1, so pressing play again finishes the rewind and carries on.
    if (mode === 'rew') {
      mode = 'idle';
      document.body.classList.remove('rewinding');
    }
  }
  document.body.classList.add('moved');
}

function setLid(on, instant = false) {
  lidOpen = on;
  cas.setLid(on);
  if (instant || reduce) cas.st.lid = cas.st.lidTarget;
  // no accent on this button — see the note in styles.css. The body class
  // swaps the glyph and remembers which way the lid is.
  document.body.classList.toggle('lid-shut', !on);
  $('#btn-lid').title = on ? '合上防尘盖（F）' : '打开防尘盖（F）';
  audio.clunk(on ? 0.8 : 1.2);
  document.body.classList.add('moved');
}

/* ============================== resize ================================== */
let quality = 1, perfAcc = 0, perfN = 0, fps = 0, jsMs = 0;

/* The render scale only ever ratcheted down. One sustained bad window — a
   window that was briefly huge, another app holding the GPU — and the page sat
   at 0.6× for the rest of the session with the floor mirror, the first thing
   dropped, never coming back. Recovery is slow and capped on purpose: two good
   windows in a row to climb one step, never above `qualityCeil` (the level last
   *measured* as too slow, so the climb cannot become the mirror switching
   itself on and off every few seconds), and only a real window resize clears
   the ceiling — that is the one event where the GPU budget has actually
   changed. */
let qualityCeil = 1, goodWindows = 0, perfSkip = 0;
let perfEl = null;
/* The ladder must not be fed the page's own settling.
 *
 * `loop()` starts the instant the model is in, and its first frames are not
 * frames: three allocates the transmission render target on the first one that
 * draws the lid — a full-resolution half-float buffer with 4x MSAA, ~120 MB —
 * the post chain builds its targets at their final size, and whatever only the
 * first real frame asks for gets linked there. `dt` is clamped to 50 ms, so
 * those frames all read as 50 ms, and 2.5 s of them is one window. One window is
 * enough to ratchet `qualityCeil` down, and the ceiling only ever comes down —
 * so the page finishes loading and quietly spends the rest of the session at
 * 0.8x with the floor mirror switched off.
 *
 * Measured, on a machine that was not remotely busy: `170 fps · js 1.01 ms ·
 * dpr×0.8 · no-mirror`, a few seconds after load. Neither number is a statement
 * about what the GPU can hold, so the first few seconds are not allowed to make
 * one. Wall clock rather than accumulated dt, because dt is the clamped thing
 * being distrusted in the first place. */
const PERF_SETTLE_MS = 4000;
let perfT0 = 0;
function watchPerf(dt) {
  perfAcc += dt; perfN++;
  fps = fps ? fps * 0.94 + (1 / Math.max(dt, 1e-3)) * 0.06 : 1 / Math.max(dt, 1e-3);
  if (perfEl && (perfN & 3) === 0) {
    perfEl.textContent = `${fps.toFixed(0)} fps · js ${jsMs.toFixed(2)} ms · dpr×${quality.toFixed(1)} · `
      + `${floorBase ? (floorBase.mesh.visible ? 'mirror' : 'no-mirror') : ''} `
      + `· off ${viewShift.toFixed(3)}→${viewShiftTarget.toFixed(3)}`;
  }
  if (performance.now() - perfT0 < PERF_SETTLE_MS) { perfAcc = 0; perfN = 0; return; }
  if (perfAcc < 2.5) return;
  const avg = perfAcc / perfN;
  perfAcc = 0; perfN = 0;
  // the window right after a change measures the change, not the machine
  if (perfSkip > 0) { perfSkip--; return; }
  if (avg > 0.030) {
    goodWindows = 0;
    if (quality > 0.6) {
      quality = Math.max(0.6, quality - 0.2);
      qualityCeil = Math.min(qualityCeil, quality);
      onResize();
    }
    if (quality <= 0.8 || !prefs.mirror) floorBase.setEnabled(false);   // the mirror goes first
    perfSkip = 1;
  } else if (avg < 0.018 && quality < qualityCeil) {
    if (++goodWindows >= 2) {
      goodWindows = 0;
      quality = Math.min(qualityCeil, quality + 0.2);
      onResize();
      perfSkip = 1;
      // the mirror is a whole extra scene render every frame: only the full
      // rate can be asked to pay for it
      if (quality >= 1) floorBase.setEnabled(prefs.mirror);
    }
  } else {
    goodWindows = 0;
  }
}
function onResize() {
  const w = innerWidth, h = innerHeight;
  const dpr = Math.min(devicePixelRatio || 1, 2) * quality;
  camera.aspect = w / h;
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  camera.updateProjectionMatrix();
  // supersample when there is GPU headroom to spare (downsampled by the last pass)
  const px = w * dpr * h * dpr;
  const ss = px > 9.0e6 ? 1 : 1.25;
  const bw = Math.round(w * dpr * ss), bh = Math.round(h * dpr * ss);
  if (composer) composer.composer.setSize(bw, bh);
  if (bloom) bloom.setSize(bw, bh);
  floorBase.setSize(w, h);
  lidMirror.setSize(w, h);
  if (grade) grade.uniforms.uTexel.value.set(1 / bw, 1 / bh);
  applyViewOffset();
  pinPanel();
}
/* the subject sits left of centre and the dossier takes the right half, so the
   offset is positive: the render window slides left and the scene follows */
let viewShift = 0.155, viewShiftTarget = 0.155;
function applyViewOffset() {
  const w = innerWidth, h = innerHeight;
  camera.clearViewOffset();
  if (w >= 900) camera.setViewOffset(w, h, w * viewShift, h * 0.025, w, h);
  camera.updateProjectionMatrix();
}
// a resize is the one event that changes what the GPU has to push, so it is
// also the only thing that re-opens the render-scale ceiling
addEventListener('resize', () => {
  qualityCeil = 1;
  goodWindows = 0;
  onResize();
});

/* ============================== loop ==================================== */
const tcEl = $('#tc'), tdEl = $('#td'), clockEl = $('#clock');
const p2 = (n) => String(n).padStart(2, '0');
const subjectPos = new THREE.Vector3();
const lastCamPos = new THREE.Vector3(0, 0, 1e9);
let last = performance.now(), t = 0, counterAcc = 0, lastTitle = '';

function loop() {
  const now = performance.now();
  if (!perfT0) perfT0 = now;          // the settle window the ladder must ignore
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  t += dt;
  const jsStart = now;

  tl?.update(dt);
  // the tape is driven by the music itself, so picture and sound never drift
  if (mode === 'rew') {
    cas.st.driven = false;
    if (cas.st.dir === -1) {                      // spooled back, at the head again
      document.body.classList.remove('rewinding');
      audioEl.currentTime = 0;
      // 循环 off: the tape still spools back, it just stands there afterwards —
      // the same state a pause leaves it in, which is what togglePlay is for.
      // 循环 on: the arm has to come down again before the side replays, so the
      // music is armed rather than started.
      if (prefs.loop) { mode = 'play'; cueArmed = true; }
      else togglePlay(false);
    }
  } else if (audioOk() && !audioEl.paused && !audioEl.ended) {
    cas.st.driven = true;
    cas.setProgress(audioEl.currentTime / audioEl.duration);
  } else {
    // paused, blocked by autoplay policy, or no audio at all → simulate locally
    cas.st.driven = false;
  }
  // Every frame, not every other. The shell only breathes slowly, which is what
  // the half rate was for — but the *lamp* moves on a theme change, and so do
  // the shell (lid) and the whole deck (intro). A shadow map that
  // alternates between two light positions 30 times a second is a flicker along
  // every shadow edge, and no amount of easing elsewhere covers it up.
  renderer.shadowMap.needsUpdate = true;
  const st = cas.update(dt);
  // the needle lands: release whatever the press armed
  if (cueArmed && st.landed) {
    cueArmed = false;
    if (audioOk()) audioEl.play().catch(() => {});   // autoplay guard: ignore
  }
  updateGhost(dt);
  updateLabelSwap(dt);
  updateFileNo(dt);
  if (intro.spin > 0) {
    /* The intro gives the platter a shove before the model has settled, so the
       thing arrives already turning. One spin, not two: a record player has a
       single rotating body, and it is the one the whole page is about. */
    cas.spinBy(16 * dt);
    intro.spin -= dt;
  }

  // idle life
  const bob = reduce ? 0 : Math.sin(t * 0.62) * 0.055 + Math.sin(t * 1.71) * 0.012;
  cas.root.position.y = intro.y + bob - swap.press;   // ...and pressed down under the write head
  cas.root.rotation.z = intro.tilt + (reduce ? 0 : Math.sin(t * 0.42) * 0.008);
  cas.root.rotation.x = reduce ? 0 : Math.sin(t * 0.33 + 1.2) * 0.006;

  // the environment drifts almost imperceptibly, so highlights crawl across
  // the shell instead of sitting frozen
  if (!reduce) {
    scene.environmentRotation.y = (scene.environmentRotation.y || 0) + 0.0055 * dt;
    scene.environmentRotation.x = Math.sin(t * 0.07) * 0.05;
  }
  /* The aim rides the lid as well as the zoom — see AIM_LID_*. `cas.lid` is
     already damped inside the turntable, so the camera settles as the cover does
     instead of snapping with it, and nothing here needs its own easing. */
  orbit.farAim.y = AIM_LID_SHUT + (AIM_LID_OPEN - AIM_LID_SHUT) * cas.lid;
  orbit.update(dt);
  /* One cube face of the reflection probe, every frame. This is what makes the
     probe live rather than a snapshot: six frames from now the whole sphere has
     been re-photographed, and on the sixth the PMREM is re-filtered into the
     render target the materials are already holding — so the reflections in the
     lid and the chrome follow the room, the lid, the arm and the platter without
     anything ever being re-bound. It sits here because everything the frame
     does to the scene is done by now, and `orbit.update` is the last of it.

     Cost is one 512² scene render per frame, and — with the lid flattened for
     it, as for the mirror — no transmission pass on top: see the note on
     `prime`. That is the price of having no handover at all; the alternative is
     a full six-face re-take that has to be hidden. */
  /* Everything that moves has moved by now, so the scene graph is brought up to
     date once and the passes below are told not to do it again: this frame draws
     the scene four times (probe, floor mirror, lid mirror, beauty) and each of
     those render calls would otherwise walk the whole graph and re-derive every
     matrix on its own — four traversals of the same unchanged tree, for three
     copies of the same answer. `scene.matrixWorldAutoUpdate` is off for that
     reason; this is the one update. */
  scene.updateMatrixWorld(true);
  cas.useCheapGlass(true);
  probe.step(renderer, scene);
  cas.useCheapGlass(false);
  if (homeArmed && !autoRotate && !orbit.dragging && !orbit.tween && orbit.idle > HOME_DELAY) goHome();
  if (reduce) {
    // the subject sliding across the frame as the panel folds is motion too
    if (viewShift !== viewShiftTarget) { viewShift = viewShiftTarget; applyViewOffset(); }
  } else if (Math.abs(viewShift - viewShiftTarget) > 2e-4) {
    viewShift = damp(viewShift, viewShiftTarget, 2.6, dt);
    applyViewOffset();
  }
  syncPanelGive();
  syncPanelFold();
  cas.root.getWorldPosition(subjectPos).project(camera);
  grade.uniforms.uCenter.value.set(subjectPos.x * 0.5 + 0.5, subjectPos.y * 0.5 + 0.5);
  watchPerf(dt);
  applyTheme(dt, reduce);
  grade.uniforms.uTime.value = t;

  // counter (throttled DOM write)
  counterAcc += dt;
  if (counterAcc > 0.2) {
    counterAcc = 0;
    const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    const t1 = fmt(st.time), t2 = fmt(st.duration);
    setRoll(tcEl, t1);
    setRoll(tdEl, t2);
    // the rail rides the same clock the counter does, and is left alone while a
    // hand is on it (see the seek wiring) — one throttle for both, so the two
    // read-outs can never disagree about where the tape is
    if (!scrubbing && st.duration > 0) {
      const frac = clamp(st.time / st.duration, 0, 1);
      if (Math.abs(frac - railShown) > 2e-4) {
        railShown = frac;
        seekEl.value = String(frac);
        railEl.style.setProperty('--p', frac.toFixed(4));
      }
    }
    const d = new Date();
    const cs = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    setRoll(clockEl, cs);
    // tab title doubles as a transport read-out
    const audioLive = audioOk() && !audioEl.paused && !audioEl.ended;
    // writing document.title re-titles the native window every time; only do it
    // when the string actually changes
    const title = audioLive ? `♪ ${fmt(audioEl.currentTime)} · ${TRACK.title}` : `${TRACK.title} — OHM DECK`;
    if (title !== lastTitle) { lastTitle = title; document.title = title; }
  }

  // refresh the mirror every frame while the camera is moving; settle to every
  // other frame once it holds still
  const camMoved = camera.position.distanceToSquared(lastCamPos) > 1e-6;
  lastCamPos.copy(camera.position);
  /* The lid goes flat for the mirror pass and comes back as glass for the frame
     that is actually seen. The mirror gets its own transmission render target
     from three — one per camera — so the correct material would buy a second
     full scene render down there for detail that 0.6 resolution, every other
     frame and a 13-tap blur cannot carry. See `glassFlat` in turntable.js. */
  cas.useCheapGlass(true);
  floorBase.update(renderer, scene, camera, camMoved);
  lidMirror.update(renderer, scene, camera, cas.glassMesh);
  cas.useCheapGlass(false);
  composer.composer.render();
  // everything above is CPU: matrix updates, culling, uniform uploads, draw
  // submission. This is the number to watch when the GPU is not the bottleneck.
  jsMs = jsMs * 0.92 + (performance.now() - jsStart) * 0.08;
  requestAnimationFrame(loop);
}

boot().catch((e) => showError(e?.stack || e));
