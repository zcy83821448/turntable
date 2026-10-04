import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
/* AO: the hand-written pass in ./ao.js, for now.
 *
 * It is expensive on a big window — measured on the machine that struggles, 5.5 ms
 * of an 11.7 ms frame at the close stop, five full-resolution full-screen passes
 * (occlusion, two blur directions, the temporal accumulate, the combine) at around
 * thirty depth taps each — and the replacement for it is three's own `GTAOPass`
 * (same three version, no new dependency, ground-truth AO, one GBuffer render plus
 * one AO pass plus one denoise pass).
 *
 * The first attempt at that swap is worth writing down, because it looked like the
 * cheapest possible configuration and broke the frame: `GTAOPass` in `OUTPUT.Off`
 * computes the AO and writes *nothing* to the composer's buffers. An
 * EffectComposer pass must write its write buffer — nothing written means the
 * buffer swap hands the next pass a stale target, and the picture dissolves into a
 * wash. Use `OUTPUT.Default` (a copy of the beauty plus a blend), or `Denoise`
 * with the multiply folded into a pass that does write. */
const Grade = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uGrain: { value: 0.05 },
    uVig: { value: 0.85 },
    uCA: { value: 0.85 },
    uFade: { value: 0 },
    uSat: { value: 1.0 },
    uHal: { value: 0.06 },
    uEdge: { value: 1.0 },     // lens defocus strength away from the subject
    uFocus: { value: 0.26 },   // uv radius that stays sharp
    uCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime, uGrain, uVig, uCA, uFade, uSat, uHal, uEdge, uFocus;
    uniform vec2 uCenter, uTexel;
    varying vec2 vUv;

    float hash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p + 19.19); return fract(p.x * p.y); }

    // 9 tap disc — at r = 0 this collapses back to a single fetch
    vec3 disc(vec2 uv, vec2 r) {
      vec3 s = texture2D(tDiffuse, uv).rgb * 0.22;
      s += texture2D(tDiffuse, uv + vec2(r.x, 0.0)).rgb * 0.10;
      s += texture2D(tDiffuse, uv - vec2(r.x, 0.0)).rgb * 0.10;
      s += texture2D(tDiffuse, uv + vec2(0.0, r.y)).rgb * 0.10;
      s += texture2D(tDiffuse, uv - vec2(0.0, r.y)).rgb * 0.10;
      s += texture2D(tDiffuse, uv + r * 0.70).rgb * 0.095;
      s += texture2D(tDiffuse, uv - r * 0.70).rgb * 0.095;
      s += texture2D(tDiffuse, uv + vec2(r.x, -r.y) * 0.70).rgb * 0.095;
      s += texture2D(tDiffuse, uv + vec2(-r.x, r.y) * 0.70).rgb * 0.095;
      return s;
    }

    void main() {
      vec2 uv = vUv;
      vec2 d = uv - 0.5;
      float r2 = dot(d, d);

      // soft wide-open falloff outside the focus radius
      float def = smoothstep(uFocus, uFocus + 0.40, distance(uv, uCenter)) * uEdge;
      vec2 blur = uTexel * (1.0 + def * 4.6);

      vec2 off = d * r2 * uCA * 0.012;
      vec3 c;
      c.r = disc(uv + off, blur).r;
      c.g = disc(uv, blur).g;
      c.b = disc(uv - off, blur).b;

      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));

      // filmic split tone — cool shadows, warm highlights
      c *= mix(vec3(0.93, 0.985, 1.07), vec3(1.055, 1.005, 0.935), smoothstep(0.16, 0.86, l));
      // halation: warm bleed off the brightest speculars
      c += vec3(1.0, 0.60, 0.32) * smoothstep(0.78, 1.0, l) * uHal;
      c = mix(vec3(l), c, uSat);

      float vig = smoothstep(1.18, 0.28, length(d) * 1.42);
      c *= mix(1.0, vig, uVig);

      float g = hash(uv * vec2(1927.0, 1087.0) + fract(uTime) * 91.7);
      c += (g - 0.5) * uGrain * mix(1.35, 0.35, smoothstep(0.0, 0.8, l));

      gl_FragColor = vec4(c * uFade, 1.0);
    }
  `,
};

export function createComposer(renderer, scene, camera) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  // a real depth texture on the beauty target: three resolves it for free as
  // part of the MSAA blit, so the AO pass needs no prepass of its own
  const depthTexture = new THREE.DepthTexture(size.x, size.y);
  depthTexture.minFilter = depthTexture.magFilter = THREE.NearestFilter;
  depthTexture.type = THREE.UnsignedIntType;
  const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    colorSpace: THREE.LinearSRGBColorSpace,
    samples: 4,
    depthBuffer: true,
    depthTexture,
    resolveDepthBuffer: true,
  });
  const composer = new EffectComposer(renderer, rt);
  /* RenderPass always draws into readBuffer, and readBuffer alternates between
     the composer's two targets: the chain swaps an odd number of times per
     frame (AO, Output, Grade). rt's clone carries a *cloned* depth texture —
     three clones the depth attachment along with the target — so the AO would be
     handed the previous frame's depth on every other frame.
     The subject drifts ~0.08 px per frame, so that shows up as an occlusion
     pattern that flips between two slightly different images at half the frame
     rate: a shimmer on every edge, which no amount of sampling tweaking fixes.
     Point both buffers at one depth texture and the resolved depth is always
     the frame being shaded. */
  composer.renderTarget2.depthTexture = depthTexture;
  const render = new RenderPass(scene, camera);
  /* Ground-truth AO, three's own, in its `Default` mode — which is the mode that
     works and not the one that looks cheapest. `Default` copies the beauty into
     the write buffer and then blends the AO over it: two full-screen passes on
     top of the GBuffer render, the 16-sample AO and the Poisson denoise. Against
     the hand-written pass this replaces (five full-resolution passes at roughly
     thirty depth taps each) that is the whole of the win, and `Off` — which
     computes the AO and writes nothing — is not an option: see the note above.
     ao.js stays in the tree as the look this has to be matched against. */
  const ao = new GTAOPass(scene, camera, size.x, size.y);
  ao.output = GTAOPass.OUTPUT.Default;
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.32, 0.70, 0.87);
  const output = new OutputPass();
  const grade = new ShaderPass(Grade);
  grade.uniforms.uFade.value = 0;
  composer.addPass(render);
  composer.addPass(ao);
  composer.addPass(bloom);
  composer.addPass(output);
  composer.addPass(grade);
  return { composer, render, ao, bloom, grade, output, depthTexture };
}
