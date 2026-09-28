// Renderer, scene graph, post-processing and the frame loop.
import * as THREE from 'three';
import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  KernelSize,
  NoiseEffect,
  RenderPass,
  SMAAEffect,
  TiltShiftEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  BlendFunction,
} from 'postprocessing';
import { CameraRig } from './camera';
import { createNoiseTexture, createTerrainUniforms, hexToLinear } from './glsl';
import { HeightField, type Level } from './assets';
import { Terrain } from './terrain';
import { Influence, createZoneUniforms, type Splat } from './influence';
import { createSlab } from './slab';

export class Stage {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  rig = new CameraRig(30);
  composer: EffectComposer;
  tu = createTerrainUniforms();
  noise = createNoiseTexture();
  zu = createZoneUniforms(this.noise);
  heights = new HeightField();
  terrain: Terrain;
  influence: Influence;
  light: Record<string, THREE.IUniform>;
  tilt: TiltShiftEffect;
  bloom: BloomEffect;
  vignette: VignetteEffect;
  time = 0;
  private last = performance.now();
  private hooks: ((dt: number) => void)[] = [];
  private postHooks: ((dt: number) => void)[] = [];
  private frameTimes: number[] = [];
  private dpr = 1;
  maxDpr = Math.min(window.devicePixelRatio || 1, 1.75);
  width = 1;
  height = 1;
  running = true;
  hasLevel = { L1: false, L2: false };
  quality = { adaptive: true };
  splats: Splat[] = [];

  constructor(public canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.setClearColor(new THREE.Color('#0d0b09'));
    this.scene.background = hexToLinear('#0f0d0b');
    this.dpr = Math.min(this.maxDpr, 1.5);

    const sun = new THREE.Vector3(-0.66, 0.52, -0.54).normalize();
    this.light = {
      uSunDir: { value: sun },
      uSunColor: { value: new THREE.Color('#fff0dc').convertSRGBToLinear().multiplyScalar(1.2) },
      uSkyColor: { value: new THREE.Color('#aebccb').convertSRGBToLinear().multiplyScalar(0.5) },
      uGroundColor: { value: new THREE.Color('#8a7658').convertSRGBToLinear().multiplyScalar(0.3) },
      uNoise: { value: this.noise },
      uTime: { value: 0 },
      uCamDist: { value: 1000 },
      uHaze: { value: new THREE.Color('#b9b3a6').convertSRGBToLinear().multiplyScalar(0.55) },
      uShadeExag: { value: 10 },
      uHearth: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, 0, 1, 0)) },
      uFocus: { value: new THREE.Vector4(0, 0, 1, 0) },
      uRivers: { value: 1 },
    };

    this.terrain = new Terrain(this.tu, this.zu, this.light);
    this.scene.add(this.terrain.mesh);
    this.scene.add(createSlab(this.tu, this.light));
    this.influence = new Influence(this.zu, 768);

    this.composer = new EffectComposer(this.renderer, { frameBufferType: THREE.HalfFloatType });
    this.composer.addPass(new RenderPass(this.scene, this.rig.camera));
    this.bloom = new BloomEffect({
      intensity: 1.1,
      luminanceThreshold: 0.62,
      luminanceSmoothing: 0.25,
      mipmapBlur: true,
      radius: 0.72,
    });
    this.tilt = new TiltShiftEffect({
      offset: 0.02,
      rotation: 0,
      focusArea: 0.5,
      feather: 0.32,
      kernelSize: KernelSize.MEDIUM,
    });
    this.vignette = new VignetteEffect({ darkness: 0.62, offset: 0.28 });
    const noise = new NoiseEffect({ premultiply: true, blendFunction: BlendFunction.SCREEN });
    noise.blendMode.opacity.value = 0.035;
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
    this.composer.addPass(new EffectPass(this.rig.camera, this.bloom));
    this.composer.addPass(new EffectPass(this.rig.camera, this.tilt));
    this.composer.addPass(new EffectPass(this.rig.camera, tone, this.vignette, noise));
    this.composer.addPass(new EffectPass(this.rig.camera, new SMAAEffect()));

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  addLevel(slot: 0 | 1 | 2, L: Level) {
    const u = this.tu;
    const H = [u.uH0, u.uH1, u.uH2][slot], M = [u.uM0, u.uM1, u.uM2][slot], Lk = [u.uL0, u.uL1, u.uL2][slot];
    const Rr = [u.uR0, u.uR1, u.uR2][slot], T = [u.uT0, u.uT1, u.uT2][slot];
    H.value = L.hTex;
    M.value = L.mTex;
    Lk.value = L.lTex;
    Rr.value.set(L.x0, L.y0, L.W * L.k, L.H * L.k);
    T.value.set(1 / L.W, 1 / L.H, L.k);
    this.heights.add(L);
    if (slot === 0) this.terrain.buildBounds(this.heights);
    if (slot === 1) this.hasLevel.L1 = true;
    if (slot === 2) this.hasLevel.L2 = true;
  }

  onFrame(fn: (dt: number) => void) {
    this.hooks.push(fn);
  }
  afterFrame(fn: (dt: number) => void) {
    this.postHooks.push(fn);
  }

  resize() {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(this.width, this.height, false);
    this.composer.setSize(this.width, this.height, false);
    this.rig.camera.aspect = this.width / this.height;
    this.rig.camera.updateProjectionMatrix();
  }

  private adapt(ms: number) {
    if (!this.quality.adaptive) return;
    this.frameTimes.push(ms);
    if (this.frameTimes.length < 40) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes = [];
    let next = this.dpr;
    if (avg > 24 && this.dpr > 0.7) next = Math.max(0.7, this.dpr - 0.15);
    else if (avg < 13 && this.dpr < this.maxDpr) next = Math.min(this.maxDpr, this.dpr + 0.1);
    if (next !== this.dpr) {
      this.dpr = next;
      this.resize();
    }
  }

  /** vertical exaggeration as a function of camera distance */
  static exaggeration(dist: number) {
    return Math.min(46, Math.max(7, 8.2 * Math.pow(dist / 1000, 0.36)));
  }

  /** debug: fixed time step per frame (for headless capture of animations) */
  fixedDt = 0;

  frame = () => {
    const now = performance.now();
    const dt = this.fixedDt || Math.min(0.1, (now - this.last) / 1000);
    this.adapt(now - this.last);
    this.last = now;
    this.time += dt;
    this.renderStep(dt);
    if (this.running) requestAnimationFrame(this.frame);
  };

  renderStep(dt: number) {
    this.rig.update(dt);
    const v = this.rig.view;
    const u = this.tu;
    u.uExag.value = Stage.exaggeration(v.dist);
    u.uHas.value.x = Math.min(1, u.uHas.value.x + (this.hasLevel.L1 ? dt * 1.5 : 0));
    u.uHas.value.y = Math.min(1, u.uHas.value.y + (this.hasLevel.L2 ? dt * 1.5 : 0));
    this.light.uTime.value = this.time;
    this.light.uCamDist.value = v.dist;
    this.light.uShadeExag.value = 8 + 6.5 * Math.pow(v.dist / 1000, 0.42);
    for (const h of this.hooks) h(dt);
    this.rig.apply();
    this.terrain.update(this.rig.camera);
    // influence field window: centred a little beyond the target, in view direction
    const hd = (v.heading * Math.PI) / 180;
    const fwd = Math.sin((v.pitch * Math.PI) / 180) * v.dist * 0.7;
    this.influence.setWindow(v.x + Math.sin(hd) * fwd, v.y + Math.cos(hd) * fwd, v.dist * (2.4 + 3.4 * Math.sin((v.pitch * Math.PI) / 180)));
    this.influence.render(this.renderer, this.splats);
    this.composer.render(dt);
    for (const h of this.postHooks) h(dt);
  }

  start() {
    this.last = performance.now();
    requestAnimationFrame(this.frame);
  }
}
