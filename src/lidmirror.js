import * as THREE from 'three';

/* A planar reflection for the dust cover.
 *
 * The cube probe cannot do this, and the reason is worth writing down because it
 * is not a matter of tuning. A cubemap is sampled by *direction* — that is what
 * a reflection vector is — and every fragment of a flat pane has the same normal,
 * so every fragment computes the same direction and reads the same texel. The
 * pane gets one colour out of it, whatever the probe's position, size or
 * roughness. That is exactly what the lid has been showing: a flat milky field,
 * which reads as glass with nothing in it. Adding a second probe inside the lid
 * changed nothing, for the same reason.
 *
 * A flat pane needs a *projective* sample instead: each fragment looks up the
 * mirrored view at its own screen position. That is what floor.js does for the
 * floor, and this is the same construction for the lid. Two differences:
 *
 *   - The floor's plane is fixed at y = const. The lid's is one of the cover's own
 *     faces, measured off the mesh once in its local space and then carried by the
 *     lid's matrix — see `measure` for why it is one face and not a fresh pick.
 *   - The floor is opaque, so it replaces its colour with the reflection. The lid
 *     is transmissive, so the reflection is handed to the glass as a texture and
 *     composited there with the Fresnel weight (see the glass material in
 *     turntable.js).
 *
 * One face at a time. The cover is a shell with several faces at different angles,
 * and a plane reflection is exact for exactly one of them; the pass follows the
 * face being looked through and swaps under a dip when another face takes over
 * (see `measure` and `update`). Whichever face is in use, the rest of the shell is
 * still reflected about the wrong plane, and that is geometry rather than an
 * unfinished job: no single plane is right for a shell. If every face of the cover
 * has to be right rather than the pane being looked through, that is an argument
 * for SSR or for a parallax-corrected probe, not for more planes here.
 *
 * --- the settled replacement, and why it is exact ---------------------------
 *
 * That last sentence was wrong, and the reason is worth stating plainly: the cover
 * is not a curved shell, it is a *polyhedron* of flat faces. A plane reflection is
 * exact for one plane, so the exact answer for a polyhedron is one plane
 * reflection *per face*, sampled per fragment by the face that fragment is on.
 * That is not an approximation of anything — for a flat-faced object it is the
 * reflection, pixel for pixel — and it retires the whole pick: no face election, no
 * hysteresis, no dip, and therefore no switch at any angle and none of the "wrong
 * at some camera/lid angles" the single-plane version cannot avoid.
 *
 * The shape of it, decided but not yet built:
 *
 *   - K = 6 faces: the pane's outer and inner surfaces and the four skirts, by
 *     area, with everything below (chamfers, the frame's inner lip) merged into the
 *     nearest of the six by normal. The pane's two surfaces are 3 mm apart, so
 *     their planes differ by 3 mm — negligible, but they are two faces and cost
 *     nothing to keep as two.
 *   - One render per face, from that face's mirrored camera, into **one atlas**
 *     (K stacked tiles, sampled with a uv offset — one sampler, no sampler2DArray
 *     and no GLSL version trouble).
 *   - Each of those renders is scissored to *that face's own projected footprint*,
 *     which the footprint() helper below already computes. This is what keeps the
 *     cost from multiplying: the fill is the cover's total screen area, not K
 *     screens — cheaper than today's single full-screen pass whenever the cover
 *     does not fill the frame. What multiplies is only the per-render submission
 *     (scene traversal and draw calls): K ≈ 6 renders, measured elsewhere at
 *     ~0.1 ms each on the machine that matters.
 *   - Tile sizes need not match: the pane keeps full resolution, the four skirts
 *     can drop to a quarter, which is invisible on a face that narrow and keeps the
 *     atlas near the memory of the single reflection it replaces.
 *   - In the glass patch (turntable.js) the fragment picks its tile by comparing
 *     its own world normal against the six face normals and taking the best match;
 *     a chamfer lands on its nearest face, which is what it should do.
 *
 * The camera-facing normal flip, the oblique near-plane clip and the footprint
 * scissor all stay exactly as they are — they are per-plane machinery and this is
 * K planes instead of one. `plane` (below) remains what main.js reads for the
 * refraction ghosts: that pass wants "which side of the cover is the lens on", and
 * one of the six answers it as well as one did.
 */
export const LID_FACES = 6;

export function createLidMirror(renderer, { width = 1, height = 1, samples = 4 } = {}) {
  const size = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    return [Math.max(1, Math.round(width * dpr)), Math.max(1, Math.round(height * dpr))];
  };
  /* --- the atlas ----------------------------------------------------------
   * One target holding one reflection per face. The pane gets a full-resolution
   * tile; the five smaller faces share a strip below it at a quarter of the height,
   * which is invisible on a face that narrow and keeps the whole thing at about a
   * quarter more memory than the single reflection it replaces.
   *
   * `uv` is the rect the shader offsets into, in the target's own uv space. Rows
   * are counted from the bottom: WebGL's viewport origin is bottom-left and so is
   * the bias matrix that builds the sampling coordinate, so the two agree without
   * a flip anywhere. */
  const tiles = [];
  function layout() {
    const [w, h] = size();
    const sw = Math.max(1, Math.round(w / (LID_FACES - 1)));
    const sh = Math.max(1, Math.round(h / 4));
    const H = h + sh;
    tiles.length = 0;
    for (let i = 0; i < LID_FACES; i++) {
      const t = i === 0
        ? { x: 0, y: 0, w, h }
        : { x: (i - 1) * sw, y: h, w: sw, h: sh };
      t.uv = new THREE.Vector4(t.x / w, t.y / H, t.w / w, t.h / H);
      tiles.push(t);
    }
    return [w, H];
  }
  const [aw, ah] = layout();
  const rt = new THREE.WebGLRenderTarget(aw, ah, {
    type: THREE.HalfFloatType, depthBuffer: true, samples,
  });

  /* The shared uniforms, one set per face and handed to the glass material as
     *these objects* rather than as copies, so updating them here updates what the
     shader reads. They are six scalar uniforms each (`lidM0…`, `lidN0…`, `lidT0…`)
     rather than arrays because the shader picks its face with an unrolled chain of
     comparisons — every index in it is then a literal, and the patch needs no
     dynamic indexing of anything, which is the one thing that would have tied this
     to a GLSL version. */
  const uniforms = {
    tLid: { value: rt.texture },
    lidMix: { value: 1 },
  };
  for (let i = 0; i < LID_FACES; i++) {
    uniforms['lidM' + i] = { value: new THREE.Matrix4() };
    // a normal facing away from the lens: a face that does not exist can never win
    uniforms['lidN' + i] = { value: new THREE.Vector3(0, 0, -1) };
    uniforms['lidT' + i] = { value: tiles[i].uv };
  }

  /* --- the cover's flat faces, in the cover's own space ------------------- */
  const panels = [];
  let faces = [];              // the six the reflection is built for, biggest first
  function measure(mesh) {
    panels.length = 0;
    const g = mesh.geometry;
    const pos = g.attributes.position;
    if (!pos) return;
    const idx = g.index;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
    const tris = idx ? idx.count / 3 : pos.count / 3;
    const buckets = new Map();
    for (let t = 0; t < tris; t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3;
      const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0);
      b.fromBufferAttribute(pos, i1);
      c.fromBufferAttribute(pos, i2);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      n.crossVectors(ab, ac);
      const area = n.length() * 0.5;
      if (area < 1e-9) continue;
      n.divideScalar(area * 2);                    // unit normal of this triangle
      // quantised so the triangles of one face land in one bucket; two decimals
      // is coarse enough for a face and fine enough not to merge a 67-degree bend
      const key = n.x.toFixed(2) + '|' + n.y.toFixed(2) + '|' + n.z.toFixed(2);
      let e = buckets.get(key);
      if (!e) { e = { n: n.clone(), p: new THREE.Vector3(), area: 0 }; buckets.set(key, e); }
      e.area += area;
      e.p.addScaledVector(a, area);                // area-weighted, for the centroid
    }
    for (const e of buckets.values()) {
      e.p.divideScalar(e.area || 1);
      panels.push(e);
    }
    panels.sort((x, y) => y.area - x.area);
    /* The faces the reflection is built for: the six largest, by area.
     *
     * There used to be a *pick* here — one face chosen per frame by projected area,
     * with a dead band and a dip to hide the swap when it changed its mind — and it
     * is gone. The pass now builds a reflection for every one of these six and the
     * shader takes the one that owns each pixel, so nothing is chosen, nothing can
     * change its mind, and the jump the dead band and the dip existed for cannot
     * happen at any camera or lid angle. That jump was what "the reflection looks
     * wrong at some angles" was: with one plane in use, every other face of the
     * shell was reflected about a plane that does not belong to it.
     *
     * The ranking is by area alone. A dot-only ranking is the obvious thing to write
     * and this mesh punishes it: the cover carries hundreds of chamfer facets and
     * some sliver of the rim is always nearer to square than the pane is (measured
     * over an 8 s dither: 16 changes of mind, and never once the pane). Twenty faces
     * come out of the buckets; the six taken here are the pane's two surfaces and
     * the four skirts, and everything below them is a sliver no reflection would
     * ever be read from. */
    faces = panels.slice(0, LID_FACES);
  }

  /* --- the pass ----------------------------------------------------------- */
  /** The cover's footprint in the mirror target, or null if it cannot be trusted.
   *  See the call site for why this is the whole of what the pass is for. */
  const _fbox = new THREE.Box3(), _fv = new THREE.Vector4();
  function footprint(w, h, mesh, cam) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    _fbox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      _fv.set(i & 1 ? _fbox.max.x : _fbox.min.x, i & 2 ? _fbox.max.y : _fbox.min.y, i & 4 ? _fbox.max.z : _fbox.min.z, 1)
        .applyMatrix4(cam.matrixWorldInverse)
        .applyMatrix4(cam.projectionMatrix);
      if (_fv.w <= 1e-3) return null;                 // behind the lens: no usable rectangle
      const sx = (_fv.x / _fv.w * 0.5 + 0.5) * w;
      const sy = (_fv.y / _fv.w * 0.5 + 0.5) * h;
      x0 = Math.min(x0, sx); x1 = Math.max(x1, sx);
      y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    }
    const pad = 4;
    const ax = Math.max(0, Math.floor(x0 - pad)), ay = Math.max(0, Math.floor(y0 - pad));
    const bx = Math.min(w, Math.ceil(x1 + pad)), by = Math.min(h, Math.ceil(y1 + pad));
    return bx > ax && by > ay ? [ax, ay, bx - ax, by - ay] : null;
  }
  const virtual = new THREE.PerspectiveCamera();
  const bias = new THREE.Matrix4().set(
    0.5, 0, 0, 0.5,
    0, 0.5, 0, 0.5,
    0, 0, 0.5, 0.5,
    0, 0, 0, 1
  );
  const camPos = new THREE.Vector3(), lookAt = new THREE.Vector3();
  const view = new THREE.Vector3();
  const target = new THREE.Vector3(), rotation = new THREE.Matrix4();
  const clipPlane = new THREE.Vector4(), reflectorPlane = new THREE.Plane();
  const q = new THREE.Vector4();
  const clipBias = 0.003;
  const planePoint = new THREE.Vector3(), planeNormal = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3(), toCam = new THREE.Vector3();
  let enabled = true;
  /* The dead band, the dip and the freeze that used to live here are gone with the
     pick: with a reflection per face there is no plane to change under the viewer,
     so there is nothing to soften and nothing to time. */
  /** Rebuild the mirror camera about the plane {point, normal} and render. The
   *  construction is three's own Reflector's, with one sign deliberately not
   *  copied: see the note on `view` below, which is where the reflection spent
   *  several rounds upside down.
   *  camera is the real one reflected, its `up` is reflected with it, and the
   *  projection is copied across unchanged — the reflection in the plane is what
   *  corrects the handedness of a camera looking at the scene from the far side,
   *  so the frustum maps a point on the plane to its own screen position and the
   *  sampling needs no correction of its own. */
  function renderFace(rendererArg, scene, camera, mesh, tile, idx, planePt, planeN) {
    camera.updateMatrixWorld();
    mesh.updateMatrixWorld();
    camPos.setFromMatrixPosition(camera.matrixWorld);
    // which side of the plane the camera is on decides whether there is anything
    // to see: looking at the cover from behind it, there is no reflection
    toCam.subVectors(camPos, planePt);
    if (toCam.dot(planeN) <= 0) return false;

    /* Both of these carry a sign that is easy to get backwards, and this is where
       it was. three's Reflector builds `view` as *plane minus camera* and then
       negates the reflection; this builds it as *camera minus plane*, so the
       negations cancel out and neither belongs here. With them in, the mirror
       camera landed twenty-five units under the floor — which is why the lid kept
       reflecting the underside of the deck, feet and all.
       The `up` below takes no negation in either version: it is a direction, and
       reflecting a direction about the plane is all that is wanted. */
    view.copy(camPos).sub(planePt);
    view.reflect(planeN).add(planePt);

    rotation.extractRotation(camera.matrixWorld);
    lookAt.set(0, 0, -1).applyMatrix4(rotation).add(camPos);
    target.subVectors(lookAt, planePt).reflect(planeN).add(planePt);

    virtual.position.copy(view);
    virtual.up.set(0, 1, 0).applyMatrix4(rotation).reflect(planeN);
    virtual.lookAt(target);
    virtual.near = camera.near;
    virtual.far = camera.far;
    virtual.fov = camera.fov;
    virtual.zoom = camera.zoom;
    virtual.filmGauge = camera.filmGauge;
    virtual.filmOffset = camera.filmOffset;
    virtual.updateMatrixWorld();
    virtual.matrixWorldInverse.copy(virtual.matrixWorld).invert();
    if (camera.view?.enabled) {
      const v = camera.view;
      virtual.setViewOffset(v.fullWidth, v.fullHeight, v.offsetX,
        v.fullHeight - v.offsetY - v.height, v.width, v.height);
    } else {
      virtual.projectionMatrix.copy(camera.projectionMatrix);
    }
    virtual.matrixWorldInverse.copy(virtual.matrixWorld).invert();

    /* Oblique near-plane clipping, which is the step that was missing and which
       explains all three symptoms at once.
       A mirror only ever reflects what is on the *viewer's* side of it. The
       mirrored camera sits on the far side, so without clipping it looks straight
       through the pane and renders whatever is behind — the deck, and from a low
       angle the underside of the deck with its feet, which is precisely what kept
       appearing. From the front this never showed, because there the machine *is*
       on the viewer's side and belongs in the reflection.
       The trick is to fold the mirror plane into the perspective matrix as its
       near plane, so the projection itself discards everything on the wrong side.
       It is three's Reflector's code, followed line for line rather than
       re-derived — and that means two variables, not one: the plane is a `Plane`
       and the clip plane it turns into is a `Vector4`. Folding them together is
       what produced "clipPlane.dot is not a function". */
    reflectorPlane.setFromNormalAndCoplanarPoint(planeN, planePt);
    reflectorPlane.applyMatrix4(virtual.matrixWorldInverse);
    clipPlane.set(reflectorPlane.normal.x, reflectorPlane.normal.y, reflectorPlane.normal.z, reflectorPlane.constant);
    const pm = virtual.projectionMatrix;
    q.x = (Math.sign(clipPlane.x) + pm.elements[8]) / pm.elements[0];
    q.y = (Math.sign(clipPlane.y) + pm.elements[9]) / pm.elements[5];
    q.z = -1.0;
    q.w = (1.0 + pm.elements[10]) / pm.elements[14];
    clipPlane.multiplyScalar(2.0 / clipPlane.dot(q));
    pm.elements[2] = clipPlane.x;
    pm.elements[6] = clipPlane.y;
    pm.elements[10] = clipPlane.z + 1.0 - clipBias;
    pm.elements[14] = clipPlane.w;

    /* The uniform this face's tile is read through. It takes a *view-space* point —
       the fragment's own, which the glass shader has as `-vViewPosition` — so the
       chain is bias · P · V · cameraWorld: view space to world by the camera's own
       matrix, then into this mirror camera. (It used to end in `mesh.matrixWorld`
       and be fed from the vertex shader; the selection is per fragment now, so the
       matrix has to be too.) */
    uniforms['lidM' + idx].value.copy(bias)
      .multiply(virtual.projectionMatrix)
      .multiply(virtual.matrixWorldInverse)
      .multiply(camera.matrixWorld);

    const prev = rendererArg.getRenderTarget();
    const wasVisible = mesh.visible;
    // The cover has to be out of its own reflection. This is the rule the probe
    // missed when it was moved inside the lid: whatever you are reflecting must
    // not be in the way of the camera that reflects it.
    mesh.visible = false;
    rendererArg.setRenderTarget(rt);
    rendererArg.setViewport(tile.x, tile.y, tile.w, tile.h);
    /* Only part of this tile is ever read, and the rest is fill rate spent on
       nobody.
       What reads it is the glass, and the coordinate it reads at comes from the
       fragment's own position run through this face's camera. So the footprint of
       the cover, projected through `virtual`, is the whole of the readership —
       everything outside it is drawn and thrown away, in a tile that is mostly
       smaller than the frame to begin with. At the close stop, where the lens is
       full of vinyl and the cover is a corner of the frame, most of this pass stops
       happening at all.
       The rectangle comes from the cover's world box, projected *after* the oblique
       clip above (that clip rewrites the matrix the shader's coordinate is built
       from, so it has to be the one used here too). Conservative by construction — a
       box contains the mesh — and padded, because a vertex on the boundary has to
       still land inside its own rectangle after rounding. If any corner is behind
       the camera the projection mirrors and the box would be nonsense, so that case
       falls back to the whole tile. */
    const rect = footprint(tile.w, tile.h, mesh, virtual);
    if (rect) {
      rendererArg.setScissorTest(true);
      rendererArg.setScissor(tile.x + rect[0], tile.y + rect[1], rect[2], rect[3]);
    }
    rendererArg.render(scene, virtual);
    if (rect) rendererArg.setScissorTest(false);
    rendererArg.setViewport(0, 0, rt.width, rt.height);
    rendererArg.setRenderTarget(prev);
    mesh.visible = wasVisible;
    return true;
  }

  return {
    uniforms,
    texture: rt.texture,
    /** The plane the pass settled on, in world space, carried by the lid. Read by
     *  main.js for the ghost pass it adds to the refraction: a ghost is only part
     *  of what the glass is looking at when it is on the far side of this plane,
     *  and that is a question only this file can answer. */
    plane: { normal: planeNormal, point: planePoint },
    /** remember the cover's faces. Call once, after the model is in the scene. */
    setMesh(mesh) { measure(mesh); },
    /** carry the chosen face with the lid and re-render. False when there is
     *  nothing to do (disabled, no mesh, or the geometry yielded no face). */
    update(rendererArg, scene, camera, mesh) {
      if (!enabled || !mesh || !panels.length) return false;
      mesh.updateMatrixWorld();
      camera.updateMatrixWorld();
      camPos.setFromMatrixPosition(camera.matrixWorld);
      normalMatrix.getNormalMatrix(mesh.matrixWorld);
      /* ---- one reflection per face ----------------------------------------
         Every face gets its own plane, its own mirrored camera and its own tile,
         and the shader takes the one that owns the pixel, by comparing the
         fragment's own normal against the six. So there is nothing to choose here:
         no pick, no dead band, no dip, no freeze. The reflection cannot switch,
         because there is no switch — each face's pixels were already reading that
         face's plane on the frame before this one, at every camera and lid angle.
         The one thing that still fades is a face turning edge-on, and that fade is
         per fragment in the shader (`smoothstep` on its own normal), which is where
         it belongs; it used to be one number for the whole chosen face. */
      let any = false;
      for (let i = 0; i < faces.length; i++) {
        const face = faces[i];
        planeNormal.copy(face.n).applyMatrix3(normalMatrix).normalize();
        planePoint.copy(face.p).applyMatrix4(mesh.matrixWorld);
        toCam.subVectors(camPos, planePoint);
        const dist = toCam.length();
        if (dist < 1e-4) continue;
        toCam.divideScalar(dist);
        // the face may wind either way; the mirror camera has to end up on the far
        // side of the panel, not behind the viewer
        if (planeNormal.dot(toCam) < 0) planeNormal.negate();
        // what the shader ranks the faces by: the same normal, in view space, so the
        // fragment compares against it with the normal it already has
        uniforms['lidN' + i].value.copy(planeNormal).transformDirection(camera.matrixWorldInverse);
        if (renderFace(rendererArg, scene, camera, mesh, tiles[i], i, planePoint, planeNormal)) any = true;
      }
      /* What main.js reads for the refraction ghosts: that pass wants "which side of
         the cover is the lens on", and the pane answers it. */
      if (faces.length) {
        planeNormal.copy(faces[0].n).applyMatrix3(normalMatrix).normalize();
        planePoint.copy(faces[0].p).applyMatrix4(mesh.matrixWorld);
        if (toCam.subVectors(camPos, planePoint).dot(planeNormal) < 0) planeNormal.negate();
      }
      /* `lidMix` is the whole reflection's on/off now; the grazing fade is per face
         and per fragment, from the normal that fragment has. */
      uniforms.lidMix.value = 1;
      return any;
    },
    setEnabled(on) { enabled = on; if (!on) uniforms.lidMix.value = 0; },
    setSize(w, h) {
      width = w; height = h;
      const [nw, nh] = layout();
      rt.setSize(nw, nh);
      // the tiles are new objects after a relayout, so the uniforms have to be
      // pointed at them again or the shader keeps reading the old rects
      for (let i = 0; i < LID_FACES; i++) uniforms['lidT' + i].value = tiles[i].uv;
    },
    dispose() { rt.dispose(); },
  };
}
