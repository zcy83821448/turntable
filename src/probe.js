import * as THREE from 'three';

/* A reflection probe: a cubemap rendered from the subject's centre, filtered
   through PMREM so rough materials still get properly blurred reflections.

   This is what gives the turntable its self- and inter-object reflections — the
   brass feet show the plinth, the platter shows the arm, the acrylic lid shows
   the whole machine — without the per-frame cost of screen-space ray marching,
   and without SSR's habit of losing anything that leaves frame.

   It used to be a *snapshot*. All six faces were rendered in one call, the
   result was PMREM-filtered into a brand new render target, and every material
   was re-pointed at it. That re-pointing is a content swap, and a content swap
   is a step the eye can see: the texture the materials sample changes identity
   between two frames, and nothing hides that — not timing it to the dimmest
   frame, not posing the world before the capture, and not dipping
   `envMapIntensity` to zero across the handover. Worst on the glass lid, which
   is almost pure reflection, so nearly all of its brightness *is* the probe.

   So there is no handover any more. One cube face is rendered per frame into
   the *same* cube render target, and when the sixth lands, the PMREM is re-run
   into the *same* output render target. Every material holds one texture for
   the life of the page and its identity never changes; the content improves
   quietly, one sixth of the sphere at a time, at a rate the eye reads as
   "live" rather than as "swapped". A sixth of the sphere per frame is late by
   up to six frames, which at 60 Hz is 100 ms — slower than the platter and the
   lid move, and irrelevant for a reflection that is already blurred by the
   roughness it is sampled through.

   Prime does one whole cycle at boot, because there is no later correction:
   the first frame the materials are drawn on has to already have a probe. */
export function createProbe(renderer, scene, { size = 512, near = 0.25, far = 90, layer = 2, at = [0, 2.4, 3.4] } = {}) {
  const rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false });
  /* The eyes. `CubeCamera.update` would do exactly this, but it does all six
     faces in one call — which is the thing being taken apart here, so the two
     cameras are built by hand and driven one face at a time. Two of them, not
     one, because the two cameras of a stereo pair are offset sideways; the
     probe is a single point in space, so both are the same camera. The class
     requires a second one and only ever uses `.layers` off it. */
  const cam = new THREE.PerspectiveCamera(90, 1, near, far);
  const cam2 = new THREE.PerspectiveCamera(90, 1, near, far);
  /* The softbox rig is real geometry on a hidden layer — the main camera sees
     layer 0 and the rig lives on layer 2 — so the probe has to ask for layer 2
     explicitly or it photographs lamps that are not there. It keeps layer 0 as
     well: the cassette reflects the room *and* itself, and the machine is on
     the default layer. */
  cam.layers.enable(layer);
  cam2.layers.enable(layer);
  cam.position.set(at[0], at[1], at[2]);
  const pmrem = new THREE.PMREMGenerator(renderer);
  /* The six orientations `CubeCamera.update` uses, as look-at / up pairs rather
     than as Euler angles: writing them as rotations means six chances to typo a
     sign and end up with a cube that is mirrored on one axis, which reads as
     the room being inside out in exactly one direction. */
  const FACES = [
    { lookAt: [1, 0, 0], up: [0, -1, 0] },
    { lookAt: [-1, 0, 0], up: [0, -1, 0] },
    { lookAt: [0, 1, 0], up: [0, 0, 1] },
    { lookAt: [0, -1, 0], up: [0, 0, -1] },
    { lookAt: [0, 0, 1], up: [0, 1, 0] },
    { lookAt: [0, 0, -1], up: [0, 1, 0] },
  ];
  let face = 0;                          // which face renders on the next step
  let out = null;                        // the PMREM render target, allocated once

  /** The PMREM, re-filtered into the target that is already bound.
   *
   * This is the load-bearing line of the whole design: `out` is assigned on the
   * **first** call only. `fromCubemap(tex, target)` writes into the target it
   * is handed and returns that same target back, so a texture identity that was
   * handed to the materials stays theirs — and re-assigning `out = ...` on a
   * later call (which compiles fine, and looks like tidying) would swap that
   * identity out from under every material and put the visible step straight
   * back. */
  function refresh() {
    out = out ? pmrem.fromCubemap(rt.texture, out) : pmrem.fromCubemap(rt.texture);
  }

  /** One cube face. On the sixth, the PMREM as well. Both renders are wrapped
   * in a save/restore of the renderer's target, because `step` is called from
   * the middle of the frame loop, between the mirror pass and the composer —
   * leaving the renderer pointed at a cube face there would send the rest of
   * the frame into the probe. */
  function step(rendererArg = renderer, sceneArg = scene) {
    const prevTarget = rendererArg.getRenderTarget();
    const prevFace = rendererArg.getActiveCubeFace();
    const prevLevel = rendererArg.getActiveMipmapLevel();
    const f = FACES[face];
    cam.up.fromArray(f.up);
    cam.lookAt(f.lookAt[0], f.lookAt[1], f.lookAt[2]);
    cam.updateMatrixWorld();
    cam2.matrixWorld.copy(cam.matrixWorld);
    rendererArg.setRenderTarget(rt, face);
    rendererArg.render(sceneArg, cam);
    face++;
    if (face === 6) {
      face = 0;
      refresh();
    }
    rendererArg.setRenderTarget(prevTarget, prevFace, prevLevel);
  }

  return {
    /** the stable PMREM texture — null until the first cycle has completed */
    get texture() { return out ? out.texture : null; },
    /** one whole cycle, synchronously, so the texture exists before frame one */
    prime(rendererArg = renderer, sceneArg = scene) {
      // `step` runs the PMREM itself when the sixth face lands, which is the
      // whole cycle — looping it separately here would refresh twice and pay
      // the filter pass for nothing.
      for (let i = 0; i < 6; i++) step(rendererArg, sceneArg);
    },
    step,
    dispose() {
      rt.dispose();
      pmrem.dispose();
      if (out) out.dispose();
    },
  };
}
