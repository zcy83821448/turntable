import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import glb from '../assets/turntable.glb';
import * as TX from './textures.js';
import { clamp, damp, smoothstep } from './anim.js';
import { LID_FACES } from './lidmirror.js';

/* ============================== the deck ==============================
   The geometry is not written here. It is the 唱片机.blend the model was
   actually built in, exported to glTF by `tools/export-glb.py` and inlined
   into this bundle as bytes (see build.mjs — `GLTFLoader` fetches, and a fetch
   from a `file://` page is blocked, so the GLB travels inside the JS).

   What this file owns is everything the export cannot carry: what the parts
   *mean*. The exporter named five nodes and put each mesh under one of them —
     Plinth   the deck, its feet, the controls, the hinge brackets   (17)
     Platter  the platter, its rim and the spindle                    (3)
     Record   the disc                                                (1)
     Arm      the arm, its bearing and its counterweight             (14)
     Cover    the lid, its glass and the hinge barrels                (7)

   — and each of those nodes sits on the axis it moves about: the Platter and
   Record nodes on the spindle, the Arm node on the bearing, the Cover node on
   the hinge. So driving the machine is a rotation on a node, and there is no
   geometry to get wrong.

   Substituting materials is deliberate: the .blend's 23 materials are solid
   colours with no textures, so the page rebuilds them from its own palette —
   which is what lets the ambient probe, the theme crossfade and the ghost
   fade all reach the deck the way they reached the tape. The exporter renamed
   each material to say what it is, and `MAT_MAP` is that hand-off.
   ===================================================================== */

/** The one dimension main.js needs: deck (y = 0) down to the bottom of the feet. */
export const DIM = { hd: 1.1418 };

export const PIVOT = { x: 4.275, z: -3.1 };      // the arm bearing's axis
export const SPINDLE = { x: -0.917, z: -0.254 }; // the platter's axis

/* Measured off the exported node tree, in the Turntable node's own units. */
const D_PS = Math.hypot(SPINDLE.x - PIVOT.x, SPINDLE.z - PIVOT.z);   // pivot -> spindle
const AE = 6.492;                                                     // pivot -> stylus
const THETA_PS = Math.atan2(SPINDLE.z - PIVOT.z, SPINDLE.x - PIVOT.x);

/* the grooves, in the same units */
export const GROOVE = { outer: 3.45, inner: 1.45, rest: 6.1 };

/* exported material name -> palette key */
const MAT_MAP = {
  Plinth: 'plinth',
  ControlMetal: 'controlMetal',
  BrandInk: 'brandInk',
  Brass: 'brass',
  Steel: 'steel',
  KnobMetal: 'knobMetal',
  KnobMetalLight: 'knobMetalLight',
  KnobDark01: 'knobDark',
  KnobDark02: 'knobDark',
  PlatterSteel: 'platter',
  PlatterMatDark: 'platterDark',
  Vinyl: 'vinyl',
  RecordLabel: 'label',
  CoverAcrylic: 'glass',
  HingeDark: 'hingeDark',
  HingeCap: 'hingeCap',
  ArmBase: 'armBase',
  ArmTrim: 'armTrim',
  ArmDark: 'armDark',
  ArmTube: 'armTube',
  ArmCounter: 'armCounter',
  ArmWeight: 'armWeight',
  Copper: 'copper',
};

/* Three objects in the .blend carry no material at all — the stylus pin, the
   clip that holds it and the ring on the counterweight. Blender does not mind;
   its viewport gives them a neutral grey. glTF's answer to a primitive with no
   material is a default white MeshStandardMaterial, and on this deck that lands
   on the very tip of the tonearm, where it is the brightest thing in the frame
   and reads as a modelling error rather than a stylus.
   So they are named, not guessed, and only these three are. */
const MAT_FALLBACK = {
  ArmStylus: 'steel',
  ArmClip: 'armTrim',
  ArmCwRing: 'copper',
};

/* ============================== materials ==============================
   The deck is three materials doing most of the work — a warm matte plastic, a
   black machined disc, and near-black vinyl — and the rest is trim. The tape's
   micro-normal and roughness maps are reused throughout, because a moulded ABS
   panel and a moulded polycarbonate shell have the same surface as far as a
   renderer is concerned. */
export function createMaterials(labelOpts = {}) {
  const micro = TX.normalTex(256, { octaves: 5, strength: 1.4, seed: 11 });
  const micro2 = TX.normalTex(256, { octaves: 5, strength: 2.4, seed: 23 });
  const rgh = TX.roughTex(512, { lo: 0.42, hi: 0.70, seed: 5 });
  const paperN = TX.normalTex(512, { octaves: 6, strength: 2.6, seed: 31 });
  const brush = TX.brushedTexture(512, [176, 178, 186]);
  const vinylR = TX.grooveRough(512);
  const labelMap = TX.recordLabelTexture(labelOpts);

  return {
    micro, micro2, rgh, paperN, brush, vinylR, labelMap,

    /* Warm ivory, soft-touch. The .blend's plinth is a linear 0.80/0.69/0.56,
       which is the cream this lands on once it has been through the same tone
       mapping the rest of the page uses. */
    plinth: new THREE.MeshPhysicalMaterial({
      color: 0xe9dcc6, metalness: 0, roughness: 0.44,
      roughnessMap: rgh, clearcoat: 0.34, clearcoatRoughness: 0.42,
      normalMap: micro, normalScale: new THREE.Vector2(0.16, 0.16),
      envMapIntensity: 0.9, sheen: 0.22, sheenRoughness: 0.7,
      sheenColor: new THREE.Color(0xfff3e2),
    }),
    /* The metal control plate — 立方体.001, the only thing wearing 材质.006.
       It used to be pointed at `plinthDark`, a cream matte the page had invented,
       so the plate came out the same colour as the plinth it sits on. The rename
       table had guessed 材质.006 was the plinth's dark trim, on the assumption
       that a material used next to the plinth belongs to it; read out of the live
       Blender session it is grey 0.8, metalness 0.5545, roughness 0.2682, and
       nothing else in the model uses it.
       The colour is converted rather than copied: Blender's Base Color is linear
       and three's `color` is sRGB, so 0.8 straight across comes out noticeably
       dark. 0.8 linear is 0.9045 sRGB. */
    controlMetal: new THREE.MeshPhysicalMaterial({
      color: 0xe7e7e7, metalness: 0.5545, roughness: 0.2682,
      envMapIntensity: 1.1,
    }),
    brandInk: new THREE.MeshPhysicalMaterial({
      color: 0x6a6a70, metalness: 0.25, roughness: 0.42, roughnessMap: rgh,
      envMapIntensity: 0.7,
    }),

    /* Blued steel, not black plastic: metalness at 1 and a low roughness is
       what puts the environment's whole gradient into a single band across the
       disc — and that band is the mirror the record sits in. */
    platter: new THREE.MeshPhysicalMaterial({
      color: 0x24262b, metalness: 0.94, roughness: 0.28,
      roughnessMap: rgh, normalMap: micro, normalScale: new THREE.Vector2(0.08, 0.08),
      envMapIntensity: 1.25, clearcoat: 0.3, clearcoatRoughness: 0.3,
    }),
    platterDark: new THREE.MeshPhysicalMaterial({
      color: 0x1b1d21, metalness: 0.9, roughness: 0.42, roughnessMap: rgh,
      envMapIntensity: 0.9,
    }),

    /* Vinyl, as an anisotropic surface rather than a bumpy one.
     *
     * It used to carry a normal map of the grooves — 170 concentric sine ridges
     * over a 1024 map, which is about three screen pixels per ring at this size.
     * Anything sampled finer than the pixel grid does not average out, it
     * *interferes*: the rings beat against the raster and the disc grew a moiré
     * rosette that turned with the platter. The file's own comment admitted the
     * spacing; what it did not say is that three pixels is past the point where
     * a normal map is a surface and before the point where it is a pattern.
     *
     * The replacement is what the grooves actually are. A record is not a rough
     * disc, it is an *anisotropic* one: its micro-structure runs along the
     * grooves, so the highlight stretches along them instead of scattering in
     * every direction. That is a property of the surface, not a texture on it —
     * no sampling, no aliasing, and it survives being seen at any distance.
     *
     * `roughnessMap: vinylR` stays. It is a smooth radial gradient from glassy
     * rim to duller centre with a little broadband noise on it, no rings, so it
     * cannot beat against anything — and it is still most of what says "record"
     * rather than "wheel".
     *
     * The direction is tangential — the direction the grooves run — and it is
     * carried by a real per-vertex `tangent` attribute (`discTangents`), not by
     * the UVs. It has to be: three falls back to deriving the tangent from the
     * screen-space derivatives of the UV, those are constant across a triangle,
     * and a constant direction per triangle on a 128-segment fan is a faceted
     * disc. See the note there. */
    vinyl: new THREE.MeshPhysicalMaterial({
      color: 0x0a0a0c, metalness: 0.0, roughness: 0.42,
      roughnessMap: vinylR,
      anisotropy: 0.9, anisotropyRotation: 0,
      envMapIntensity: 1.15, clearcoat: 0.85, clearcoatRoughness: 0.10,
      sheen: 0.18, sheenColor: new THREE.Color(0x8f7ea8), sheenRoughness: 0.5,
    }),

    label: new THREE.MeshPhysicalMaterial({
      map: labelMap, metalness: 0, roughness: 0.86,
      normalMap: paperN, normalScale: new THREE.Vector2(0.22, 0.22),
      sheen: 0.12, sheenColor: new THREE.Color(0xfff0f6), sheenRoughness: 0.85,
      envMapIntensity: 0.6, clearcoat: 0.10, clearcoatRoughness: 0.65,
    }),

    steel: new THREE.MeshPhysicalMaterial({
      color: 0xc2c6ce, metalness: 1, roughness: 0.24,
      roughnessMap: brush, anisotropy: 0.55, envMapIntensity: 1.6,
    }),
    brass: new THREE.MeshPhysicalMaterial({
      color: 0x9c7c4e, metalness: 1, roughness: 0.32, roughnessMap: rgh,
      envMapIntensity: 1.35,
    }),
    copper: new THREE.MeshPhysicalMaterial({
      color: 0xb06a4e, metalness: 1, roughness: 0.30, envMapIntensity: 1.4,
    }),
    /* The plinth's controls, and the one place the rig was left isotropic.
     *
     * `brush` alone was doing nothing here: a roughness map changes how *blurred*
     * a highlight is, never which way it runs, so a smooth convex disc still
     * mirrored one narrow cone of the room and read as an even wash with no
     * direction in it. Anisotropy is the part that puts a direction in — real
     * turned or radially brushed metal has its micro-grooves running outward from
     * the centre, and that is what spreads the reflection into rays.
     *
     * `anisotropyRotation` is an angle in tangent space, and the tangent comes
     * from the cap's own polar unwrap: Blender unwraps a cylinder cap as a disc,
     * so u runs *around* the cap and v runs *out* from its centre. Hence a
     * quarter turn to put the grooves on the radius; at zero they would come out
     * as concentric rings, which is a lathe rather than a sunburst. */
    knobMetal: new THREE.MeshPhysicalMaterial({
      color: 0x8b9099, metalness: 0.95, roughness: 0.38, roughnessMap: brush,
      anisotropy: 0.85, anisotropyRotation: Math.PI / 2,
      envMapIntensity: 1.2,
    }),
    knobMetalLight: new THREE.MeshPhysicalMaterial({
      color: 0xb6bbc4, metalness: 0.85, roughness: 0.32, roughnessMap: brush,
      anisotropy: 0.85, anisotropyRotation: Math.PI / 2,
      envMapIntensity: 1.35,
    }),
    knobDark: new THREE.MeshPhysicalMaterial({
      color: 0x1e2024, metalness: 0.3, roughness: 0.5, roughnessMap: rgh,
      normalMap: micro2, normalScale: new THREE.Vector2(0.3, 0.3), envMapIntensity: 0.75,
    }),

    /* Two blacks rather than one: the tube is satin and catches a long
       highlight down its length, the plastic around the bearing is nearly
       matte, and putting them on one roughness makes the arm read as a single
       extrusion. */
    armTube: new THREE.MeshPhysicalMaterial({
      color: 0x15171a, metalness: 0.22, roughness: 0.30,
      roughnessMap: brush, anisotropy: 0.6, normalMap: micro,
      normalScale: new THREE.Vector2(0.06, 0.06), clearcoat: 0.5,
      clearcoatRoughness: 0.2, envMapIntensity: 1.0,
    }),
    armDark: new THREE.MeshPhysicalMaterial({
      color: 0x111316, metalness: 0.08, roughness: 0.66,
      roughnessMap: rgh, normalMap: micro2, normalScale: new THREE.Vector2(0.4, 0.4),
      envMapIntensity: 0.7,
    }),
    armBase: new THREE.MeshPhysicalMaterial({
      color: 0x17191d, metalness: 0.2, roughness: 0.58,
      roughnessMap: rgh, normalMap: micro2, normalScale: new THREE.Vector2(0.35, 0.35),
      envMapIntensity: 0.8,
    }),
    armTrim: new THREE.MeshPhysicalMaterial({
      color: 0x2a2d33, metalness: 0.6, roughness: 0.36,
      roughnessMap: rgh, clearcoat: 0.4, clearcoatRoughness: 0.3, envMapIntensity: 1.05,
    }),
    armCounter: new THREE.MeshPhysicalMaterial({
      color: 0x24272c, metalness: 0.5, roughness: 0.42,
      roughnessMap: rgh, envMapIntensity: 0.95,
    }),
    armWeight: new THREE.MeshPhysicalMaterial({
      color: 0x0e0f12, metalness: 0.35, roughness: 0.52, roughnessMap: rgh,
      normalMap: micro2, normalScale: new THREE.Vector2(0.3, 0.3), envMapIntensity: 0.8,
    }),

    hingeDark: new THREE.MeshPhysicalMaterial({
      color: 0x191b1f, metalness: 0.15, roughness: 0.55, roughnessMap: rgh,
      normalMap: micro2, normalScale: new THREE.Vector2(0.35, 0.35), envMapIntensity: 0.8,
    }),
    hingeCap: new THREE.MeshPhysicalMaterial({
      color: 0x3a3e45, metalness: 0.75, roughness: 0.34,
      roughnessMap: rgh, envMapIntensity: 1.1,
    }),

    /* The dust cover, as glass.
     *
     * `transmission` is the physically correct path: real Fresnel, a real IOR,
     * light actually bent on the way through, and the tint built from how far it
     * travelled rather than from a flat opacity. It costs an extra scene render
     * per frame, which is exactly the cost the tape's smoked window and the
     * first cut of this lid were traded away to avoid — and it is why floor.js
     * computes its mirror by hand rather than with the Reflector addon: that
     * addon hooks `onBeforeRender`, which fires *again inside this pass* and
     * re-enters setRenderTarget mid-render. See the note at the top of floor.js.
     *
     * `thickness` is where this stops being literal, and it has to be said out
     * loud rather than buried: the lid is a hollow shell (690 verts, mesh volume
     * 4.4% of its bounding box), so its walls are about 0.4 mm — the 49 mm of
     * depth you see at the rim is the skirt, and the geometry already gives you
     * that. Refracting through a real 0.4 mm sheet is very nearly refracting
     * through nothing, so `thickness` is set as a stand-in optical path instead:
     * 0.30 local units is about 11 mm of glass. That is thicker than the sheet a
     * real dust cover is folded from and far thinner than the shell, and it is
     * the value at which the rim reads as a block with volume instead of as a
     * tinted film. It is a deliberate lie about the wall, not about the optics.
     *
     * Everything else is the real number for acrylic: `ior` 1.49, and a
     * `dispersion` of 0.65, which is the visible-spectrum spread of acrylic's
     * index. three turns that into `halfSpread = (ior - 1) * 0.025 * dispersion`
     * — 0.008 either side of 1.49, i.e. the 1.485..1.498 that acrylic actually
     * measures. The fringe on the rim is what does most of the work of making
     * the lid read as solid.
     *
     * Front faces only, as before: double-siding draws the panel's far side over
     * its near side and the tint lands twice, which is how a 0.30 pane came out
     * looking like paper. */
    glass: new THREE.MeshPhysicalMaterial({
      color: 0xffffff, metalness: 0, roughness: 0.03,
      transmission: 1, thickness: 0.28, ior: 1.49, dispersion: 0.65,
      /* No absorption, and that is the correction: this carried a green-grey
         attenuation colour, and because `volumeAttenuation` raises it to a
         power, it took red out of the transmitted light everywhere rather than
         only where the path is long. Real acrylic's green lives in the *edge*,
         where you look through 50 mm of it — and three has no way to express
         that, because the path is one constant `thickness` for the whole mesh.
         So the honest thing is to drop the tint entirely rather than place a
         uniform cast where the physics would put a gradient. The green that
         belongs on the rim comes from `dispersion` instead, which is geometry-
         aware because it works through the refraction itself.
         `attenuationDistance` is left at its default of infinity — the shader
         short-circuits to a transmittance of exactly 1. */
      clearcoat: 0, envMapIntensity: 0.9,
      specularIntensity: 1, side: THREE.FrontSide,
    }),

    /* What the lid is while the floor's mirror is being drawn — a flat tinted
       pane, the material this lid used before it became real glass.
       The mirror renders at 0.6 resolution, on every other frame, and blurs what
       it gets over 13 taps; it cannot show the difference. But three keys its
       transmission render target per camera, so asking for real refraction down
       there buys a *second* full scene render per mirror frame. Measured: with
       it, the page fell to 0.8 on its quality ladder, and the first thing that
       ladder sacrifices is the mirror itself — so the cost of correct glass was
       being paid by switching the floor reflection off. See useCheapGlass. */
    glassFlat: new THREE.MeshPhysicalMaterial({
      color: 0x8f9492, metalness: 0, roughness: 0.06,
      transparent: true, opacity: 0.30, depthWrite: false,
      clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 0.9,
      specularIntensity: 1, side: THREE.FrontSide,
    }),

    // the print being laid down, and the light doing the laying
    labelNext: new THREE.MeshPhysicalMaterial({
      map: labelMap, metalness: 0, roughness: 0.86,
      normalMap: paperN, normalScale: new THREE.Vector2(0.22, 0.22),
      transparent: true, depthWrite: false, forceSinglePass: true,
      envMapIntensity: 0.6, clearcoat: 0.10, clearcoatRoughness: 0.65,
    }),
  };
}

/** decode the inlined GLB. `GLTFLoader.parse` resolves on a microtask even for
    a self-contained GLB, so the caller awaits — see boot() in main.js. */
function parseGLB(bytes) {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(buf, '', resolve, reject);
  });
}

/** Rewrite a flat disc's UVs as a straight plan projection of its top cap.
 *
 *  The record needs this and there is no way around it. Blender's default
 *  cylinder unwrap lays a cylinder's two caps out as two small circles at the
 *  left and right of the uv square, with the side wall as a band between them —
 *  which is a fine unwrap for a tin can and completely wrong for a record. The
 *  groove field is a radial pattern in the square, so sampling it through that
 *  layout does not produce rings: it produces a sunburst, and the sunburst
 *  rotates with the platter, which is the one thing a record's surface must not
 *  do.
 *
 *  Re-projecting the cap costs one pass over the vertices at load. Everything
 *  off the top face is parked at a uv far outside the pattern, where the maps
 *  are flat, so the edge and the underside take no grooves at all. */
function planarCapUV(mesh) {
  const g = mesh.geometry;
  const pos = g.attributes.position;
  const nrm = g.attributes.normal;
  const uv = g.attributes.uv;
  if (!pos || !uv) return false;
  g.computeBoundingBox();
  const bb = g.boundingBox;
  const cx = (bb.max.x + bb.min.x) / 2;
  const cz = (bb.max.z + bb.min.z) / 2;
  const r = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2 || 1;
  for (let i = 0; i < pos.count; i++) {
    if (!nrm || nrm.getY(i) > 0.5) {
      /* u is mirrored. The label's print is drawn the right way round on the
         canvas — `fillText` sets "Secret Play" left to right — but projecting the
         cap's local +X straight onto u lays it down back to front on the disc, so
         every word on the label read as its own mirror image. Reversing u here is
         the whole fix.
         It is safe on the vinyl, which this same projection also feeds: that
         surface is radially symmetric — a radial roughness gradient and no print
         of its own — so a flip about the centre leaves it identical. Comparing
         this function against the project's own backup shows it byte for byte
         unchanged, so the mirror predates today's work rather than being a
         regression from it. */
      uv.setXY(i, 0.5 - (pos.getX(i) - cx) / (2 * r), (pos.getZ(i) - cz) / (2 * r) + 0.5);
    } else {
      uv.setXY(i, -1, -1);
    }
  }
  uv.needsUpdate = true;
  return true;
}

/** Give a flat disc per-vertex tangents that run around it.
 *
 *  The vinyl's anisotropy direction is read from the tangent, and a mesh that
 *  does not carry one gets it derived instead: three's `getTangentFrame` takes
 *  the screen-space derivatives of the UV, and those are constant across a
 *  triangle. So the tangent is constant across a triangle, so the anisotropy
 *  direction is constant across a triangle — and on a 128-segment fan that is a
 *  hard radial edge every three degrees. Rendered, it is a faceted disc: a
 *  pinwheel of flat wedges with visible creases, which no amount of smooth
 *  vertex normals fixes, because the normals were never the thing that was
 *  faceted.
 *
 *  A real `tangent` attribute is interpolated per fragment and the fan
 *  disappears. three switches to it on its own the moment the geometry has one.
 *
 *  Two things this deliberately does *not* do:
 *
 *  It does not re-project the UVs. An earlier attempt made them polar on the
 *  theory that the direction had to come from there, and that quietly broke
 *  `roughnessMap: vinylR` — a radial gradient drawn for a plan projection, which
 *  sampled through polar coordinates reads as a straight band. The plan
 *  projection is right for the map and irrelevant to the tangent, so the vinyl
 *  keeps it.
 *
 *  It does not park anything. `planarCapUV` leaves off-cap vertices at a
 *  constant uv, which under anisotropy is fatal: zero UV derivatives give a zero
 *  tangent frame, the Smith visibility term then divides by components of it,
 *  and the Inf that comes out survives the bloom pass and blacks out most of the
 *  frame — with nothing in the console to say so. Nothing here is fed to a
 *  derivative, so nothing here can degenerate; the one vertex with no radius to
 *  be tangential to gets an arbitrary unit tangent rather than a zero one. */
function discTangents(mesh) {
  const g = mesh.geometry;
  const pos = g.attributes.position;
  if (!pos) return false;
  g.computeBoundingBox();
  const bb = g.boundingBox;
  const cx = (bb.max.x + bb.min.x) / 2;
  const cz = (bb.max.z + bb.min.z) / 2;
  const tan = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const dx = pos.getX(i) - cx;
    const dz = pos.getZ(i) - cz;
    const rr = Math.hypot(dx, dz);
    if (rr > 1e-5) {
      // around the disc: up x radial, lying in the disc's own plane
      tan[i * 4] = dz / rr;
      tan[i * 4 + 1] = 0;
      tan[i * 4 + 2] = -dx / rr;
    } else {
      tan[i * 4] = 1;
    }
    tan[i * 4 + 3] = 1;   // handedness — only read for tangent-space normal maps
  }
  g.setAttribute('tangent', new THREE.BufferAttribute(tan, 4));
  return true;
}

/* ============================== build =================================== */
export async function createTurntable(labelOpts = {}) {
  const M = createMaterials(labelOpts);

  const root = new THREE.Group();
  const assembly = new THREE.Group();
  root.add(assembly);

  const gltf = await parseGLB(glb);
  const model = gltf.scene;
  assembly.add(model);
  model.updateMatrixWorld(true);

  const group = (n) => {
    const o = model.getObjectByName(n);
    if (!o) throw new Error(`turntable.glb has no node named ${n}`);
    return o;
  };
  const gPlinth = group('Plinth');
  const gPlatter = group('Platter');
  const gRecord = group('Record');
  const gArm = group('Arm');
  /* The tower the arm swings *in* — base plate, bearing housing, collar, rest
     post. It sits on the same axis as `Arm` and is deliberately never written
     to: it is bolted to the deck. Turning the whole assembly as one group (the
     first thing tried) swept a fixed 2-unit plate through 46° every time the
     needle moved, which is the loudest thing in the frame at the moment you
     press play. */
  const gArmMount = group('ArmMount');
  /* The bearing assembly — the yoke the arm hangs in, and the shaft it hangs on.
     It gets the arm's *yaw* and nothing else, which is why it is not simply a
     child of `Arm`: `Arm` is also what carries the cueing lift, and the yoke is
     hardware sitting on the tower. In `Arm` it rose 12.9 mm clear of the collar
     every time the deck was paused — the arm appearing to detach from its mount,
     and only while paused, because `armDown` is 1 whenever the deck is playing.
     Yawing it matters and lifting it does not: the yoke is a cube 0.417 units off
     the axis, so the turn is visible, while the shaft is a cylinder on the axis,
     where it is not. */
  const gArmSwivel = group('ArmSwivel');
  const gCover = group('Cover');
  /* The hinge the lid swings on — the four barrels and caps, bolted to the deck.
     Same arrangement as Arm / ArmMount: it sits on the same axis and is never
     written to. Turning it with the lid is invisible — they are cylinders on
     their own axis. */
  const gCoverMount = group('CoverMount');

  /* ---- materials -------------------------------------------------------
     Every mesh is handed a page material by the name the exporter gave its
     Blender material, so the artist's decision about which part is brass and
     which is matte black survives without the code re-deciding it. */
  const labelMesh = { current: null };
  const recordParts = [];
  const vinylParts = [];
  const unmapped = new Set();
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    const name = o.material?.name;
    const key = MAT_MAP[name] ?? MAT_FALLBACK[o.name];
    if (key) {
      o.material = M[key];
    } else {
      unmapped.add(`${o.name} (${name})`);
    }
    if (name === 'RecordLabel') labelMesh.current = o;
    if (name === 'RecordLabel') recordParts.push(o);
    if (name === 'Vinyl') vinylParts.push(o);
  });
  if (unmapped.size) console.warn('turntable: unmapped materials', [...unmapped]);
  if (!labelMesh.current) throw new Error('turntable.glb: no RecordLabel primitive');
  /* Two different jobs. The plan projection is what the printed label and the
     radial roughness gradient were both drawn for. The tangents are what the
     vinyl's anisotropy direction comes from — see the note on discTangents for
     why it cannot come from the UVs. */
  for (const m of recordParts) planarCapUV(m);
  for (const m of vinylParts) {
    planarCapUV(m);
    if (!discTangents(m)) console.warn('turntable: Vinyl mesh has no positions — no anisotropy direction', m.name);
  }

  /* the glass is the only transparent thing above the deck, so it blends last */
  const glassMesh = model.getObjectByName('CoverGlass');
  if (glassMesh) {
    glassMesh.renderOrder = 10;
    glassMesh.castShadow = glassMesh.receiveShadow = false;
  }

  /** Put the flat stand-in on the lid, or the real glass back. Around the floor's
   *  mirror pass only — see `glassFlat` for why the correct material is not worth
   *  its second transmission pass down there.
   *
   *  The refraction setting is the same swap, which is why it lives here: the
   *  settings panel's switch and the mirror pass both want the lid flat, and the
   *  restore at the end of a pass therefore has to ask the setting before it puts
   *  the real glass back.
   *
   *  This is not the only writer of `glassMesh.material`, and it used to behave as
   *  if it were. While a part is being read the cover can be one of the ghosts,
   *  with a flat stand-in of its own — and the swap below, running every frame
   *  just before the visible pass, put the *real* glass back on it every time. A
   *  dropped lid therefore never actually looked dropped: it drew itself as dark
   *  reflective glass (at a low camera angle, a mirror of the dark floor) and hid
   *  the ghost machine behind it, which is the one thing the reader is looking
   *  through. So the ghost gets the last word — `setGlassOwner` is how main.js
   *  says who is holding the material right now, and it is asked every time
   *  rather than latched, so it cannot go stale. */
  let refraction = true;
  let glassOwner = null;
  function useCheapGlass(on) {
    if (!glassMesh) return;
    const owned = glassOwner ? glassOwner() : null;
    glassMesh.material = owned || ((on || !refraction) ? M.glassFlat : M.glass);
  }
  /** who owns the lid's material: a function returning the ghost's material while
   *  the cover is ghosted, or null when the lid is the lid. Passing null hands it
   *  back to the swaps above. */
  function setGlassOwner(fn) { glassOwner = fn || null; useCheapGlass(false); }
  /** the 玻璃折射 switch. Off means the lid is a flat tinted pane for good: no
   *  transmission pass in the main view either, so nothing behind it is bent. */
  function setRefraction(on) {
    refraction = !!on;
    useCheapGlass(false);
  }

  /* ---- the lid's planar reflection --------------------------------------
     A cube probe gives a flat pane one colour and no image, because every
     fragment of a flat surface computes the same reflection direction. Only a
     projective sample — the mirrored view read at each fragment's own screen
     position — puts a picture on it. main.js runs that pass and hands its texture
     and projection matrix in here (see lidmirror.js); this is where they are
     composited.
     Only `glass` is patched. `glassFlat` is the stand-in the mirror and probe
     passes put on the lid, and a material that reflected there would be reflecting
     the pass that is drawing it — the recursion this page has already been bitten
     by once.
     `F0` is the dielectric reflectance at normal incidence, ((n-1)/(n+1))^2, and
     it is written as a literal because it cannot be a uniform: it has to be in the
     shader source before the program is compiled. */
  const F0 = Math.pow((1.5 - 1) / (1.5 + 1), 2);
  /* The reflection's uniforms: one holder per face of the cover, named `lidM{i}`,
     `lidN{i}`, `lidT{i}` — the pass in lidmirror.js fills those same names, and the
     two lists are one contract. Holders rather than values, so what the shader was
     compiled against keeps being what gets written. */
  const glassRefl = { live: null, uniforms: null };
  const reflDefaults = () => {
    const u = { tLid: { value: null }, lidMix: { value: 0 } };
    for (let i = 0; i < LID_FACES; i++) {
      u['lidM' + i] = { value: new THREE.Matrix4() };
      // facing away from the lens, so a face that does not exist can never win
      u['lidN' + i] = { value: new THREE.Vector3(0, 0, -1) };
      u['lidT' + i] = { value: new THREE.Vector4() };
    }
    return u;
  };
  glassRefl.uniforms = reflDefaults();
  M.glass.onBeforeCompile = (shader) => {
    for (const k in glassRefl.uniforms) shader.uniforms[k] = glassRefl.uniforms[k];
    const decl = [], pick = [];
    for (let i = 0; i < LID_FACES; i++) {
      decl.push(`uniform mat4 lidM${i};\nuniform vec3 lidN${i};\nuniform vec4 lidT${i};`);
      if (i === 0) continue;
      pick.push(`{ float d = dot(normal, lidN${i}); if (d > bd) { bd = d; proj = lidM${i} * vec4(-vViewPosition, 1.0); tile = lidT${i}; } }`);
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D tLid;
uniform float lidMix;
${decl.join('\n')}`)
      .replace('#include <transmission_fragment>', `#include <transmission_fragment>
        {
          /* Which face of the cover this pixel is on, taken from the normal it
             already has. The pass builds one planar reflection per face of the
             cover and gives each its own tile, so this picks the plane that belongs
             to the surface being shaded — a face is never reflected about another
             face's plane, which is what "the reflection looks wrong at some angles"
             was. The comparison is unrolled with literal indices, so nothing here
             needs dynamic indexing of anything. */
          vec4 proj = lidM0 * vec4(-vViewPosition, 1.0);
          vec4 tile = lidT0;
          float bd = dot(normal, lidN0);
          ${pick.join('\n          ')}
          vec2 lidUv = clamp(proj.xy / max(proj.w, 1e-5), 0.0, 1.0);
          vec3 lidRefl = texture2D(tLid, tile.xy + lidUv * tile.zw).rgb;
          float cosT = clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0);
          float F = ${F0.toFixed(5)} + (1.0 - ${F0.toFixed(5)}) * pow(1.0 - cosT, 5.0);
          /* The grazing fade, and it is this face's own angle now rather than the
             chosen face's: a face turning edge-on carries almost nothing, and which
             face that is, is a per-pixel question. */
          totalSpecular += lidRefl * F * smoothstep(0.06, 0.30, cosT) * lidMix;
        }`);
  };
  /** hand the glass the pass's uniforms, or take them away again with null.
   *
   *  The uniforms change hands as *objects*, not as values, and that is the whole
   *  contract with lidmirror.js: the pass rewrites the six `lidM{i}` matrices and
   *  the six `lidN{i}` face normals every frame, and what the compiled shader reads
   *  has to be those objects. `needsUpdate` is what makes the swap take: the patch
   *  installs whatever `glassRefl.uniforms` holds at *compile* time, so changing
   *  hands without a recompile would leave the shader reading the previous set. */
  function setLidReflection(u) {
    glassRefl.uniforms = u || reflDefaults();
    glassRefl.live = u || null;
    /* The cube's contribution goes to zero while the planar one is live. Both are
       the same reflection of the same room, and a cube can only give this surface
       a flat colour, so leaving it on would add a milky wash on top of the exact
       image. */
    M.glass.envMapIntensity = u ? 0 : 1;
    M.glass.needsUpdate = true;
  }

  /* ---- the lid ---------------------------------------------------------
     The export shuts the lid (a 10 x 10 x 10 open box frames badly, and a lid
     that is already up leaves the page nothing to reveal). The node therefore
     carries the rotation that shut it, and opening it is taking that back off.
     Captured rather than hard-coded, so re-exporting at a different angle
     cannot drift away from what this file believes. */
  const LID_SHUT = gCover.rotation.x;

  /* ---- the print on the record ----------------------------------------
     One label mesh in the GLB; the incoming print is a copy of it sitting a
     few microns above, let in through a mask that opens from the spindle.
     `labelNext` is parented to the Record node rather than to the mesh it
     copies: the record's own node is squashed flat (scale.y 0.16), and an
     offset applied inside *that* would be a tenth of the thickness it needs
     to be. */
  const yUp = new THREE.Vector3(0, 1, 0);
  const place = new THREE.Matrix4();
  gRecord.updateMatrixWorld(true);
  place.copy(gRecord.matrixWorld).invert().multiply(labelMesh.current.matrixWorld);

  const labelNext = new THREE.Mesh(labelMesh.current.geometry, M.labelNext);
  place.decompose(labelNext.position, labelNext.quaternion, labelNext.scale);
  const labelY = labelNext.position.y;
  labelNext.position.y += 0.006;
  labelNext.renderOrder = 8;
  labelNext.visible = false;
  labelNext.userData.noGhost = true;      // a transition device, not a part
  gRecord.add(labelNext);

  // the label's own radius, in the Record node's space — the ring of light
  // that follows the cut is scaled by it
  labelMesh.current.geometry.computeBoundingBox();
  const bb = labelMesh.current.geometry.boundingBox;
  const LABEL_R = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2
    * Math.max(labelNext.scale.x, labelNext.scale.z);

  const glow = new THREE.Mesh(
    new THREE.RingGeometry(0.93, 1.0, 96, 1),
    new THREE.MeshBasicMaterial({
      color: 0xffd9a8, transparent: true, opacity: 0, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    })
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.set(labelNext.position.x, labelY + 0.010, labelNext.position.z);
  glow.renderOrder = 9;
  glow.visible = false;
  glow.userData.noGhost = true;
  gRecord.add(glow);

  const wipeMap = TX.discWipe(256, 0.09);
  wipeMap.wrapS = wipeMap.wrapT = THREE.ClampToEdgeWrapping;
  M.labelNext.alphaMap = wipeMap;

  const HEAD_LIT = 0.40, HEAD_FADE = 0.85, HEAD_DELAY = 0.55;
  const head = { enter: 0, dying: false, fade: 0, r: 0, hold: 0 };
  const paintHead = () => {
    glow.material.opacity = HEAD_LIT * head.enter * (1 - smoothstep(0, 1, head.fade));
    glow.scale.setScalar(Math.max(0.001, head.r));
  };

  /** Open the cut's mask to `k` of the label's radius.
   *
   *  The inverse, and it has to be. A uv transform in three is
   *  `uv * repeat + offset`, and what the wipe wants is the mask's own white
   *  disc — which is a disc of radius 0.5 in its texture — to *shrink* onto the
   *  label as k grows. So the sampled coordinate has to move outward as k falls:
   *
   *      uv_tex - 0.5 = (uv_final - 0.5) / k
   *
   *  which is `repeat = 1/k`, `offset = 0.5 - 0.5/k`. Writing `repeat = k`
   *  instead — the obvious thing, and what this did at first — multiplies the
   *  label's own radius by k, so the mask is *almost entirely open by k = 0.5*
   *  and the whole reveal happens in the first few frames. It reads as a hard
   *  swap with a flicker, which is very close to not being there at all.
   *
   *  Outside the square the map is clamped, and the wipe's border is
   *  transparent, so a shrunk mask is transparent rather than wraparound. */
  function openMask(k) {
    const s = Math.max(k, 1e-3);
    wipeMap.repeat.set(1 / s, 1 / s);
    wipeMap.offset.set(0.5 - 0.5 / s, 0.5 - 0.5 / s);
  }

  /* ---- analysis anchors ------------------------------------------------ */
  const anchor = (parent, x, y, z) => {
    const o = new THREE.Object3D();
    o.position.set(x, y, z);
    parent.add(o);
    return o;
  };
  const anchors = {
    plinth: anchor(gPlinth, -3.6, 0.20, 3.55),
    platter: anchor(gPlatter, 2.75, 0.34, -1.05),
    record: anchor(gRecord, 1.35, 0.46, 1.70),
    arm: anchor(gArm, -0.05, 0.42, 2.60),
    cover: anchor(gCover, 1.70, 0.10, 2.60),
  };

  /* ---- the arm ---------------------------------------------------------
     The geometry that matters is not the arm but the triangle it closes —
     pivot, spindle, stylus. Its two fixed sides are `D_PS` and `AE`, so the
     stylus radius *is* the bearing angle: `armAngle` is the law of cosines
     read backwards, and everything the arm does follows from it. Tracking a
     side is one interpolation on the radius, and the whole sweep from the rest
     post to the run-out is 46°. */
  const armAngle = (r) => THETA_PS - Math.acos(
    clamp((D_PS * D_PS + AE * AE - r * r) / (2 * D_PS * AE), -1, 1));
  // three maps a local +z onto the world angle (90° - rotation.y)
  const armYaw = (r) => Math.PI / 2 - armAngle(r);

  /* ---- transport state -------------------------------------------------
     A side of a record is one pass of the stylus from the rim to the run-out,
     and everything the deck does is a function of where the stylus is. So the
     model's only real state is `progress` — 0 at the rim, 1 at the label — and
     the platter's angle, the bearing angle and the counter all follow from it.
     That is the tape model's `areaL` idea kept, with one coordinate instead of
     two packs. */
  const RPM = 100 / 3;                     // 33⅓
  const TAU = Math.PI * 2;
  const OMEGA = (RPM / 60) * TAU;
  const REW_SECONDS = 8.5;                 // how long the arm takes to go home
  const st = {
    progress: 0,
    playing: false, dir: -1, driven: false,
    time: 0, duration: 317,                // 5:17, the page's default side
    /* The platter's angle is an accumulator while it is turning and a function
       of `progress` whenever an external clock is driving, so a seek lands the
       record exactly where the music is. `vel` is the spindown: a platter this
       heavy takes a couple of seconds to stop, and freezing it on the frame the
       button is pressed is the single thing that most makes a deck look like a
       video. */
    angle: 0, vel: 0,
    armDown: 0, armR: GROOVE.rest, armYaw: armYaw(GROOVE.rest),
    /* `landed` is the frame the needle touches the record, and it is the one
       signal the page keys the music off — see the note in update(). */
    landed: false, onRecord: false,
    /* The lid ships shut with the target already open, so the page's first
       second and a half is the lid coming up (see update). */
    lid: 0, lidTarget: 1,
  };
  gArm.rotation.y = st.armYaw;
  gArmSwivel.rotation.y = st.armYaw;

  const sideTurns = () => Math.max(1, st.duration) * (RPM / 60);

  /* The platter's own phase, and the reason the angle is not simply
   * `progress * turns * TAU`.
   *
   * How far round the disc happens to be is a purely visual quantity — the
   * record's rotation is not in the audio — so `progress` does not imply an
   * absolute angle, it only implies a *rate*. Assigning the product outright
   * therefore picks an arbitrary phase, and the platter's real phase at that
   * moment is very unlikely to be the same one. The disc snaps by the
   * difference. Measured: 0.70 rad, 40°, on the exact frame the stylus touched
   * down — which, now that the platter is held still until then, is the first
   * motion of the side.
   *
   * So carry the difference. While the deck is stopped, `phase` is kept equal to
   * "where the disc actually is, minus where `progress` would put it", and the
   * driven angle adds it back. The handover then costs nothing: the first driven
   * angle equals the angle the coast left behind. Seeking still moves the disc,
   * because seeking moves `progress` — which is right, the disc should jump when
   * the audio does.
   *
   * Recomputed while coasting rather than captured at the handover because
   * main.js sets `st.driven = true` *before* it calls setProgress, so there is no
   * false-to-true edge left to hook. */
  let phase = 0;
  const drivenAngle = () => st.progress * sideTurns() * TAU + phase;

  /** drive the deck from outside (an `<audio>` element's currentTime) */
  function setProgress(frac) {
    st.progress = clamp(frac, 0, 1);
    st.driven = true;
    st.angle = drivenAngle();
  }

  /* Where the stylus belongs right now. Rewinding and sitting at the start are
     both "off the record": a deck lifts the arm before it does anything else,
     which is also what makes the return legible — the arm is visibly *not*
     tracking while it travels back. */
  const armTargetR = () =>
    (st.dir > 0 || (!st.playing && st.progress <= 1e-6)) ? GROOVE.rest
      : GROOVE.outer + (GROOVE.inner - GROOVE.outer) * st.progress;

  function update(dt) {
    // ---- transport
    if (st.playing && !st.driven) {
      if (st.dir < 0) {
        /* The platter is already turning, but nothing has been *read* yet.
           A side does not start when the button is pressed, it starts when the
           stylus reaches the groove — so the run's clock is held at zero for
           the length of the cue (about 0.6 s). Without this the record's own
           time starts on the press and the first second of the side plays to an
           arm that is still in the air, which is exactly what it looks like. */
        if (st.landed) {
          st.progress += dt / Math.max(st.duration, 1);
          if (st.progress >= 1) { st.progress = 1; st.dir = 1; }
        }
      } else {
        st.progress -= dt / REW_SECONDS;
        if (st.progress <= 0) { st.progress = 0; st.dir = -1; }
      }
    }
    st.time = st.progress * st.duration;

    // ---- platter
    if (st.driven) {
      st.angle = drivenAngle();
      st.vel = st.playing ? OMEGA : 0;
    } else if (st.playing && st.dir < 0 && st.landed) {
      /* The same gate the audio is behind, for the same reason and on the same
         frame: a side begins when the stylus reaches the groove, not when the
         button is pressed. Ungated here, the disc was already turning for the
         whole cue — the arm visibly descending onto a record that was some way
         into a revolution it had not started.
         `st.landed` is written further down this function, so what is read here
         is the previous frame's value. That is a sixtieth of a second and it
         cannot be seen; hoisting the whole landing calculation above the platter
         to remove it would only make the two disagree about which frame they
         are on. Before landing the platter falls through to the coast branch
         below, where a velocity of zero stays zero. */
      st.angle += OMEGA * dt;
      st.vel = OMEGA;
    } else if (st.playing && st.dir > 0) {
      // the return leg is faster than the side played: a deck spools home in
      // about a fortieth of the time, and by then the platter is only coasting
      st.angle += OMEGA * 0.55 * dt;
      st.vel = OMEGA * 0.55;
    } else {
      // the deck is stopped, so this is the angle the next handover has to
      // continue from — see the note on `phase`
      phase = st.angle - st.progress * sideTurns() * TAU;
      st.angle += st.vel * dt;
      st.vel *= Math.exp(-2.1 * dt);
      if (Math.abs(st.vel) < 1e-4) st.vel = 0;
    }
    // folded into a whole number of turns, which the disc cannot show: left to
    // climb it passes 1e5 rad in a long session, where float32 spacing is
    // 0.01 rad and the label's print starts to judder
    st.angle %= TAU * 4096;
    gPlatter.rotation.y = st.angle;
    gRecord.rotation.y = st.angle;

    // ---- arm
    st.armR = damp(st.armR, armTargetR(), 2.6, dt);
    /* Pressing play lowers the needle, and nothing else. This used to also
       require `st.progress > 1e-4`, which read as "don't drop the arm at the
       very start of a side" — but at the very start of a side is precisely
       where the arm *should* drop, so the condition only ever delayed the cue by
       a frame or two and made the intent unreadable. */
    const wantDown = st.playing && st.dir < 0;
    st.armDown = damp(st.armDown, wantDown ? 1 : 0, 3.4, dt);
    /* The touchdown threshold is deliberately late in the travel. At 0.5 the arm
       is still visibly swinging toward the groove and anything keyed off it — the
       run's clock, the music — would start with the stylus in mid-air, which is
       the bug this whole signal exists to prevent. At 0.88 the arm has all but
       stopped: the needle is down. */
    st.landed = st.armDown > 0.88;
    st.onRecord = st.landed;
    st.armYaw = damp(st.armYaw, armYaw(st.armR), 3.0, dt);
    gArm.rotation.y = st.armYaw;
    gArmSwivel.rotation.y = st.armYaw;
    /* Nothing writes `gArm.position` any more, and nothing should. The arm used
       to be lifted bodily by 0.36 units while the deck was stopped — a
       translation of the whole assembly, which is not how a tonearm cues. The
       real motion turns the arm about a horizontal axis near the bearing: the
       front rises, the counterweight dips, and nothing comes away from the parts
       that carry it. Moving the whole group instead opened a gap at the mount,
       and because that gap is between the arm and its yoke and shaft, the arm
       read as detached from the deck whenever it was parked — and as correct the
       moment it played, since `armDown` is 1 then and the offset was zero. The
       model's own pose *is* the arm's pose. It swings, and that is all it does. */

    // ---- lid
    /* It ships shut — a lid already standing at 67° makes the model a 10-unit
       cube, and it leaves the page nothing to reveal. So the lid is a state:
       the model starts shut (`st.lid` at 0) with the target already open, and
       the first second and a half of the page is the lid coming up.
       After that the page owns it — F, or the round button. */
    st.lid = damp(st.lid, st.lidTarget, 2.2, dt);
    gCover.rotation.x = LID_SHUT * (1 - st.lid);

    return st;
  }

  return {
    root, assembly, materials: M, anchors, st, update, setProgress,
    /* Only one printed surface on a record, so the write head's material list
       is one long. main.js iterates it, so the length is its business, not
       ours. */
    headMaterials: [M.labelNext],
    setLid: (on) => { st.lidTarget = on ? 1 : 0; },
    /** how far up the cover is right now: 0 shut, 1 open. Damped, so it is safe to
     *  drive something continuous off it without introducing a step. */
    get lid() { return st.lid; },
    useCheapGlass,
    setGlassOwner,
    /** the lid's own mesh — the planar reflection needs the cover to measure its
     *  faces off and to hide it inside its own pass */
    glassMesh,
    setRefraction,
    setLidReflection,
    /** the intro gives the platter a shove, so the thing arrives turning */
    spinBy: (rad) => { st.angle += rad; },

    /* ---- the cut, driven from outside --------------------------------
       `setLabel` draws the new print and parks the mask closed on the spindle,
       `sweepLabel` opens it (0 → 1), `commitLabel` hands the print to the
       record. Nothing here animates on its own: the caller owns the clock, so
       a cut can be interrupted, skipped or run instantly. */
    setLabel(opts) {
      const neu = [TX.recordLabelTexture(opts)];
      const old = [M.label.map];
      head.enter = 0; head.dying = false; head.fade = 0; head.r = 0; head.hold = 0;
      M.labelNext.map = neu[0];
      M.labelNext.needsUpdate = true;
      labelNext.visible = true;
      glow.visible = true;
      paintHead();
      return { neu, old };
    },
    sweepLabel(p) {
      const k = clamp(p, 0, 1);
      openMask(k);
      head.r = Math.max(0.02, k * LABEL_R);
      // it comes on as the cut starts, and dies once the mask has reached the rim
      head.enter = smoothstep(0.02, 0.16, k);
      if (k >= 0.995) head.dying = true;
      paintHead();
    },
    /** The light's own clock, ticked once a frame by the caller. It holds at the
        rim for HEAD_DELAY after the cut has settled and only then begins to go:
        the print is finished before the light is, and a light that vanished on
        the frame the print landed reads as a cut, not as a fade. */
    stepHead(dt) {
      if (!head.dying || head.fade >= 1) return;
      head.hold += dt;
      if (head.hold < HEAD_DELAY) return;
      head.fade = Math.min(1, head.fade + dt / HEAD_FADE);
      paintHead();
      if (head.fade >= 1) glow.visible = false;
    },
    /** the print changes hands here, with the mask already past the rim. The
        texture it replaces is handed back by `setLabel` and must be kept alive
        until every material that points at it has been moved — the ghost copies
        of the record hold the same map. */
    commitLabel() {
      M.label.map = M.labelNext.map;
      M.label.needsUpdate = true;
      labelNext.visible = false;
    },
    /** One frame with the incoming disc on screen and the mask wide open, over
        the print already on the record — nothing changes on screen, but the
        program then exists, instead of being built on the first frame of the
        first cut (which is a stutter in the middle of a move). Off is also how
        a cancelled swap is put away. */
    warmLabel(on) {
      labelNext.visible = on;
      glow.visible = false;
      glow.material.opacity = 0;
      openMask(on ? 1 : 0);
      head.enter = 0; head.dying = false; head.fade = 0; head.r = 0; head.hold = 0;
    },
    parts: {
      gPlinth, gPlatter, gRecord, gArm, gArmSwivel, gArmMount, gCover, gCoverMount,
      model, label: labelMesh.current, labelNext, glow,
      lidShut: LID_SHUT, labelR: LABEL_R,
    },
    dispose: () => assembly.traverse((o) => { if (o.isMesh) o.geometry.dispose?.(); }),
  };
}
