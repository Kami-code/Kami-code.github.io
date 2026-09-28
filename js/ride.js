/*! chenbao.tech | (c) 2026 Chen Bao | MIT License | https://chenbao.tech | please credit: "Based on chenbao.tech by Chen Bao" */
// ride.js — first-person ride inside the suspended monorail car.
// Renderer, car (assets/car.glb), camera + look-around, parallax city layers (assets/layers),
// guideway pillars + lamps (instanced), hologram panels per stop, in-car displays, motion sim.
//
// Frames: car-local = glTF root (+X = direction of travel, floor y = 0, -Z = left/viewing side).
// The car never moves in world space; the city scrolls past (layer UV offset, pillar instances,
// holograms are anchored to their stop's track distance). Numbers: assets/car-interior.json.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Point lights: skip the BRDF of a light whose contribution is exactly 0 at this fragment (intensity 0, or beyond
// its cutoff distance). Same image, but most interior pixels are only in range of 2-4 of the 8 lights.
{
  const K = 'lights_fragment_begin', src = THREE.ShaderChunk[K];
  const i0 = src.indexOf('#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )'), i1 = src.indexOf('#if ( NUM_SPOT_LIGHTS > 0 )');
  const call = 'RE_Direct( directLight, geometryPosition';
  if (i0 >= 0 && i1 > i0 && src.slice(i0, i1).split(call).length === 2) {
    THREE.ShaderChunk[K] = src.slice(0, i0) + src.slice(i0, i1).replace(call, 'if ( directLight.visible ) ' + call) + src.slice(i1);
  }
}

const DEG = Math.PI / 180;
const clamp =(x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const FONT_SIGN = '"Barlow Semi Condensed", "Arial Narrow", sans-serif';
const FONT_MONO = '"IBM Plex Mono", ui-monospace, Consolas, monospace';
const FONT_BODY = '"IBM Plex Sans", system-ui, "Segoe UI", sans-serif';
const FONT_ZH = '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';

// ---------------------------------------------------------------- car numbers (car-interior.json)
const CAR = {
  pivotY: 4.7,                                  // suspension axis for sway (y 4.7, z 0)
  // Base views. yaw -36 / pitch ~1 frames the floor, the full L seat row, open door B with the platform edge
  // and the depth of the car, with the hologram (haz/hel, degrees from the eye) inside window W2.
  // Phone: wider lens and turned toward door B so the doorway and the hologram share the narrow frame;
  // the hologram stays left of az ~45 deg, where the open door-B leaf slides behind W2.
  view: {
    desk: { eye: [-0.6, 1.65, 0.55], yaw: -36, pitch: 1, vfov: 58, shift: 0, haz: 30, hel: 3 },
    tablet: { eye: [-0.6, 1.65, 0.55], yaw: -36, pitch: 3, vfov: 62, shift: 0.08, haz: 30, hel: 3 },
    phone: { eye: [-0.6, 1.65, 0.55], yaw: -42, pitch: -6, vfov: 80, shift: 0.18, haz: 33, hel: 2 },
    // short landscape (phone on its side): the stop card fills the left ~half, so the lens is shifted right
    short: { eye: [-0.6, 1.65, 0.55], yaw: -31, pitch: 1, vfov: 62, shift: 0, xshift: 0.32, haz: 30, hel: 3 },
  },
  look: { yaw: 18, pitch: 8 },
  door: { t0: 1.0, t1: 2.5 },                   // 'Scene' clip seconds for the L (-Z) side: closed -> open
  // planes sit 5-6 mm inboard of the route-map LED nodes / door status LED so those never poke through
  route: { size: [3.36, 0.066], pos: [0, 2.733, -1.2465], px: [2048, 40] },
  header: { size: [1.30, 0.13], pos: [2.76, 2.555, -1.2605], px: [1024, 102] },
};
const MAT_OVR = {
  LaminatedClearGlass: { transmission: 0, transparent: true, depthWrite: false, opacity: 0.2, color: '#0f1c24', roughness: 0.1, metalness: 0, specularIntensity: 0, envMapIntensity: 1.5, ior: 1.5 },
  WarmLED: { color: '#fff1dc', emissive: '#ffe0bd', emissiveIntensity: 3.2, roughness: 0.3 },
  InteriorWarmWhite: { color: '#c9c1b0', roughness: 0.62, metalness: 0 },
  CeramicWarmGrey: { color: '#8f9090', roughness: 0.42, metalness: 0.25, envMapIntensity: 0.8 },
  InteriorGraphite: { color: '#1d2226', roughness: 0.5, metalness: 0.2 },
  BrushedSteel: { color: '#b8bcbf', roughness: 0.22, metalness: 1, envMapIntensity: 1.2 },
  SeatMossTeal: { color: '#2b6a6b', roughness: 0.78, metalness: 0 },
  SeatBackShell: { color: '#3b464b', roughness: 0.38, metalness: 0.1 },
  PrioritySeatOchre: { color: '#9a5a1a', roughness: 0.75, metalness: 0 },
  FloorMineralGrey: { color: '#2b2f31', roughness: 0.38, metalness: 0.05, envMapIntensity: 1 },
  WindowEPDM: { color: '#0b0d0e', roughness: 0.7, metalness: 0 },
  ExteriorGraphite: { color: '#15191c', roughness: 0.35, metalness: 0.5 },
  SafetyOchre: { color: '#b86a14', roughness: 0.45, metalness: 0.1 },
  DisplayAmber: { emissiveIntensity: 3.0 },
};

// ---------------------------------------------------------------- ride / motion constants
const SPACING = 72;          // m between stops (multiple of the 24 m pillar pitch: same framing at every stop)
// Responsive ride: the car pulls away while its doors shut (they close in 0.34 s, it departs at 30 % closed),
// acceleration ramps in over RAMP s (no jolt), a one-stop hop takes ~2 s, braking fades out over the last metre
// (soft landing, V_SOFT), and the doors are open 0.45 s after arrival.
const ACC = 90, BRK = 90;    // m/s^2 (stylised)
const VMAX = 120;            // m/s (multi-stop jumps; one hop peaks at ~78)
const RAMP = 0.22, V_SOFT = 4, DEPART_U = 0.7;
const DOOR_OPEN = 0.42, DOOR_CLOSE = 0.34, DWELL = 0.03;   // s
const ACC0 = 30, BRK0 = 30, VMAX0 = 80;                     // nominal speed profile for ?p= (parallax test views)
const PILLAR_PITCH = 24, PILLAR_X0 = 11.9, LAMP_DX = 8;  // pillars just outside the frame at every stop
const PILLAR_Z = -4.9, LAMP_Z = -3.25;                   // ~3.5 m / ~1.9 m outside the glass (z -1.371)
const HOLO = { az: 30, el: 3, dist: 28 };                // default anchor seen from the eye; views override az/el
// Vertical band for the (tall) media holograms, in degrees of elevation from the eye: the top stays under the hand
// loops (the x = 0 loop hangs down to el 13.2 at az 24), the bottom >= RAIL_CLEAR above the platform handrail,
// which is seen through the window below the panel. Taller panels are scaled down to fit (holoFit).
const HOLO_TOP_EL = 12.5, RAIL_CLEAR = 1.2;
const HOLO_HALF_W = (10.4 + 2 * 0.28) / 2;               // full-size panel half width (createHologram: W + 2 pad)
const XSHIFT_MAX = 0.3;                                  // largest lens shift used to clear the stop card (NDC)

/** scroll stop-progress s (0..N-1) -> target track distance; dead zone around each stop */
function distForS(s) {
  const k = Math.floor(s + 1e-9), f = s - k, dz = 0.18;
  const e = f <= dz ? 0 : f >= 1 - dz ? 1 : smooth(0, 1, (f - dz) / (1 - 2 * dz));
  return (k + e) * SPACING;
}
/** nominal speed profile inside a hop (accelerate / cruise / brake), used for ?p= */
function profileSpeed(D) {
  const k = Math.floor(D / SPACING), a = D - k * SPACING, b = SPACING - a;
  return Math.min(VMAX0, Math.sqrt(2 * ACC0 * a), Math.sqrt(2 * BRK0 * b));
}

// ================================================================= entry
/** createRide({ canvas, ui, P, reduced, force, onReady, onFail }) -> ride API { pause, resume, dispose, ... }.
 *  onFail(why) asks main.js to switch to the text version: 'lost' (WebGL context lost) or 'slow' (frame times stay
 *  bad at the lowest quality level; never with force = ?force3d=1). dispose() stops everything and frees the GPU. */
export async function createRide({ canvas, ui, P, reduced, force = false, signal, onReady, onFail }) {
  const num = (k, d) => (P.has(k) && P.get(k) !== '' && !isNaN(+P.get(k)) ? +P.get(k) : d);
  const frozenT = P.has('t') ? num('t', 0) : null;
  const frozen = frozenT !== null;
  const debug = P.get('debug') === '1';
  const stops = ui.stops, N = ui.N;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const smallScreen = Math.min(screen.width, screen.height) < 820 || coarse;
  // every listener this ride adds goes away with it (dispose -> a retry builds a fresh ride)
  const ac = new AbortController(), sig = { signal: ac.signal }, psig = { passive: true, signal: ac.signal };
  let disposed = false;
  let monReset = () => {};   // frame-time guard reset (defined with the loop)

  // ------------------------------------------------ renderer
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: frozen, alpha: false });
  } catch (e) { throw new Error('WebGL unavailable'); }
  if (!renderer.capabilities.isWebGL2) { renderer.dispose(); throw new Error('WebGL2 unavailable'); }
  const gl = renderer.getContext();
  // GPU class (for the starting pixel ratio) and the largest drawable size
  const gpuName = (() => {
    let r = String(gl.getParameter(gl.RENDERER) || '');
    if (/^(webkit|mozilla)?\s*webgl$|^webkit$/i.test(r)) { const ex = gl.getExtension('WEBGL_debug_renderer_info'); if (ex) r = String(gl.getParameter(ex.UNMASKED_RENDERER_WEBGL) || r); }
    return r;
  })();
  const maxDraw = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), ...gl.getParameter(gl.MAX_VIEWPORT_DIMS));
  // the ride hands the page back to the text version if the context goes (driver reset, GPU memory pressure)
  canvas.addEventListener('webglcontextlost', () => { if (!disposed) onFail?.('lost'); }, sig);
  // loading steps: if one fails, or main.js gave up meanwhile (signal: load watchdog), release what exists and stop
  const abandon = () => {
    if (disposed) return; disposed = true; ac.abort();
    try { renderer.dispose(); if (!gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch (e) { /* gone */ }
  };
  const need = async (p) => {
    let v;
    try { v = await p; } catch (e) { abandon(); throw e; }
    if (signal?.aborted) { abandon(); throw new Error('abandoned'); }
    return v;
  };
  const tm = P.get('tm');
  renderer.toneMapping = tm === 'neutral' ? THREE.NeutralToneMapping : tm === 'agx' ? THREE.AgXToneMapping : THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = num('exposure', 1.0);
  renderer.info.autoReset = false;
  renderer.debug.checkShaderErrors = debug;     // no blocking info-log queries in production
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0a0714');
  const camera = new THREE.PerspectiveCamera(56, innerWidth / innerHeight, 0.1, 16000);
  camera.rotation.order = 'YXZ';

  // ------------------------------------------------ night environment (reflections on steel / glass)
  scene.environment = nightEnv(renderer);
  scene.environmentIntensity = 1.0;

  // ------------------------------------------------ rig: pivot on the suspension axis, car hangs below
  const rig = new THREE.Group(); rig.position.set(0, CAR.pivotY, 0); scene.add(rig);

  // ------------------------------------------------ assets (parallel)
  const fontsP = loadFonts();
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const carP = loader.loadAsync('assets/car.glb');
  const layersMetaP = fetch('assets/layers/layers.json').then((r) => { if (!r.ok) throw new Error('layers.json ' + r.status); return r.json(); });
  // small screens, <= 4 GB, or a GPU whose textures stop below 4096 px: the 2048 px layer set
  const useSmallLayers = smallScreen || (navigator.deviceMemory && navigator.deviceMemory <= 4) || renderer.capabilities.maxTextureSize < 4096;
  const texLoader = new THREE.TextureLoader();
  // large / HiDPI desktop canvases get the 2x close layer (40 px/m) so its signs stay crisp
  const useHiLayers = !useSmallLayers && innerWidth * Math.min(devicePixelRatio || 1, 2) >= 1800 && renderer.capabilities.maxTextureSize >= 8192;
  const ASSET_V = '20260928a';   // cache-busting token for the layer images (tools/bump-version.py)
  const layerFile = (L) => (useSmallLayers ? L.file2k : useHiLayers && L.fileHi ? L.fileHi : L.file);
  const layersP = layersMetaP.then((meta) => Promise.all(meta.layers.map((L) =>
    loadTex('assets/layers/' + layerFile(L) + '?v=' + ASSET_V, texLoader).then((tex) => ({ L, tex })))).then((arr) => ({ meta, arr })));
  layersP.catch(() => {});   // awaited below; this only stops an early rejection being reported as unhandled

  const gltf = await need(carP);
  const car = gltf.scene;
  car.position.y = -CAR.pivotY;
  rig.add(car);

  // materials by name
  const MAT = {};
  car.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) MAT[(m.name || '').replace('E_DETAIL_', '')] = m;
  });
  for (const [k, v] of Object.entries(MAT_OVR)) {
    const m = MAT[k]; if (!m) continue;
    for (const [p, val] of Object.entries(v)) {
      if (m[p] && m[p].isColor) m[p].set(val); else if (p in m) m[p] = val;
    }
    m.needsUpdate = true;
  }
  // Transparent double-sided panes: three draws them in two passes (back faces, then front) and re-resolves the
  // program twice per frame. The panes are flat, so one pass gives the same image at half the cost.
  if (MAT.LaminatedClearGlass && MAT.LaminatedClearGlass.side === THREE.DoubleSide) MAT.LaminatedClearGlass.forceSinglePass = true;
  // Seat upholstery: woven moquette micro-texture (car-space triplanar; the GLB has no UVs) + a crease shadow where
  // the cushion meets the back pad. The seat shells keep their slightly glossy plastic.
  const carInv = { value: new THREE.Matrix4() };
  if (MAT.SeatMossTeal) fabric(MAT.SeatMossTeal, carInv, true);
  if (MAT.PrioritySeatOchre) fabric(MAT.PrioritySeatOchre, carInv, false);
  // Ceiling vent grilles (VentPanel, merged into the InteriorGraphite mesh) read as black zebra louvres next
  // to the LED lenses once bloom is off: tint just those vertices a light warm grey via vertex colours.
  if (MAT.InteriorGraphite) {
    const g = MAT.InteriorGraphite, base = g.color.clone(), vent = new THREE.Color('#bdb3a3'), v = new THREE.Vector3();
    car.updateMatrixWorld(true);
    car.traverse((o) => {
      if (!o.isMesh || o.material !== g) return;
      const pos = o.geometry.attributes.position, col = new Float32Array(pos.count * 3);
      const toCar = new THREE.Matrix4().copy(car.matrixWorld).invert().multiply(o.matrixWorld);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(toCar);
        const c = v.y > 2.815 && v.y < 2.85 && Math.abs(v.z) > 1.0 && Math.abs(v.z) < 1.2 ? vent : base;
        col[3 * i] = c.r; col[3 * i + 1] = c.g; col[3 * i + 2] = c.b;
      }
      o.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    });
    g.color.set('#ffffff'); g.vertexColors = true; g.needsUpdate = true;
  }
  // transparent draw order: city layers (-100..-96) < holograms (-50/-49) < platform glass (-20)
  // < window reflections (-11/-10) < car glass (0)

  // doors: L (-Z) side only, driven by door fraction u
  const mixer = new THREE.AnimationMixer(car);
  const clip = gltf.animations.find((a) => a.name === 'Scene') || gltf.animations[0];
  if (clip) mixer.clipAction(clip).play();
  let lastDoorU = -1;
  const setDoor = (u) => {
    if (!clip || Math.abs(u - lastDoorU) < 1e-4) return;
    lastDoorU = u; mixer.setTime(CAR.door.t0 + (CAR.door.t1 - CAR.door.t0) * u);
  };
  setDoor(0);

  // ------------------------------------------------ interior lights
  const hemi = new THREE.HemisphereLight('#ffe2c0', '#1a1410', 0.45); scene.add(hemi);
  for (const x of [-3.9, -1.3, 1.3, 3.9]) {
    const l = new THREE.PointLight('#ffdcb8', 3.6, 6.5, 1.3); l.position.set(x, 2.0, 0); car.add(l);
  }
  const cool = new THREE.DirectionalLight('#6a78ff', 0.35);
  cool.position.set(2, 1.2, -8); cool.target.position.set(0, 1, 0); scene.add(cool, cool.target);
  // passing-lamp sweep lights (inside, near the L windows; cool white so they read against the warm interior)
  // + hologram spill + the station's own light at door B (moves with the platform)
  const sweep = [0, 1].map(() => { const l = new THREE.PointLight('#cfe6ff', 0, 5.5, 1.4); car.add(l); return l; });
  const platLight = new THREE.PointLight('#ffe9cf', 0, 9, 1.2); car.add(platLight);
  const holoLight = new THREE.PointLight('#64e0ff', 0, 6, 1.2); holoLight.position.set(1.2, 2.2, -1.05); car.add(holoLight);

  // ------------------------------------------------ night-window reflections (mirror images of the lit ceiling)
  // Mirror plane = L side glass z = -1.371: z' = -2.742 - z. Additive, drawn after the city, before the glass.
  const reflGroup = new THREE.Group(); car.add(reflGroup);
  const reflStrips = [];
  {
    const zg = -1.371;
    const stripMat = (k) => new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffe2c4').multiplyScalar(k), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
    for (const [z, k] of [[-0.94, 0.3], [0.94, 0.16]]) {
      for (const cx of [-4.95, -2.97, -0.99, 0.99, 2.97, 4.95]) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(1.68, 0.12), stripMat(k));
        m.rotation.x = Math.PI / 2; m.position.set(cx, 2.78, 2 * zg - z); m.renderOrder = -10;
        reflGroup.add(m); reflStrips.push(m);
      }
    }
    // the warm ceiling itself: a faint veil across the upper panes
    const veil = new THREE.Mesh(new THREE.PlaneGeometry(11.9, 2.56), new THREE.MeshBasicMaterial({ color: new THREE.Color('#c9b39a').multiplyScalar(0.05), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    veil.rotation.x = Math.PI / 2; veil.position.set(0, 2.85, 2 * zg); veil.renderOrder = -11;
    reflGroup.add(veil); reflStrips.push(veil);
  }

  // ------------------------------------------------ camera (parented to the car)
  car.add(camera);
  let view = CAR.view.desk;
  const lookState = { yaw: 0, pitch: 0, vy: 0, vp: 0, ty: 0, tp: 0 };
  if (P.has('yaw')) lookState.yaw = lookState.ty = clamp(num('yaw', 0), -CAR.look.yaw, CAR.look.yaw);
  if (P.has('pitch')) lookState.pitch = lookState.tp = clamp(num('pitch', 0), -CAR.look.pitch, CAR.look.pitch);
  const lookFixed = P.has('yaw') || P.has('pitch');

  // ------------------------------------------------ in-car displays (CanvasTexture planes; GLB has no UVs)
  const routeDisp = makeDisplay(CAR.route, 'route');
  const headerDisp = makeDisplay(CAR.header, 'header');
  car.add(routeDisp.mesh, headerDisp.mesh);

  // ------------------------------------------------ city layers
  const eyeWorld = new THREE.Vector3(...CAR.view.desk.eye);   // layer planes are placed relative to the standing eye
  const layers = [];
  const layerGroup = new THREE.Group(); scene.add(layerGroup);
  const buildLayers = ({ meta, arr }) => {
    for (const { L, tex } of arr) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.anisotropy = Math.min(8, maxAniso);
      tex.needsUpdate = true;
      const d = L.depthM;
      const x0 = eyeWorld.x - 1.4 * d, x1 = eyeWorld.x + 9.5 * d;
      let yLo = L.yBottomM, yHi = L.yTopM;
      if (L.id === 'close') yLo = L.yBottomM - 8 * d;          // street / fog colour continues below
      if (L.id === 'sky') yHi = L.yTopM + 4 * d;               // night sky continues above
      const g = new THREE.BufferGeometry();
      const Y = (y) => eyeWorld.y + y, U = (x) => x / L.tileWidthM, V = (y) => (y - L.yBottomM) / L.heightM;
      const z = eyeWorld.z - d;
      g.setAttribute('position', new THREE.Float32BufferAttribute([x0, Y(yLo), z, x1, Y(yLo), z, x1, Y(yHi), z, x0, Y(yHi), z], 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute([U(x0), V(yLo), U(x1), V(yLo), U(x1), V(yHi), U(x0), V(yHi)], 2));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      const mat = new THREE.ShaderMaterial({
        uniforms: { map: { value: tex }, offset: { value: 0 }, blur: { value: 0 }, gain: { value: 1.0 } },
        vertexShader: LAYER_VS, fragmentShader: LAYER_FS,
        transparent: true, depthWrite: false, depthTest: true,
      });
      const mesh = new THREE.Mesh(g, mat);
      mesh.renderOrder = -100 + L.renderOrder;
      mesh.frustumCulled = false;
      layerGroup.add(mesh);
      layers.push({ L, mesh, mat });
    }
    // harbour haze (雾港) between the layers: additive vertical-gradient planes, uniform in x so they never scroll
    const hc = document.createElement('canvas'); hc.width = 4; hc.height = 256;
    const hx = hc.getContext('2d'), hg = hx.createLinearGradient(0, 0, 0, 256);
    hg.addColorStop(0, '#000'); hg.addColorStop(0.45, 'rgb(70,70,70)'); hg.addColorStop(0.72, 'rgb(200,200,200)'); hg.addColorStop(0.8, '#fff'); hg.addColorStop(1, '#fff');
    hx.fillStyle = hg; hx.fillRect(0, 0, 4, 256);
    const hazeTex = new THREE.CanvasTexture(hc); hazeTex.colorSpace = THREE.SRGBColorSpace;
    const street = -(meta.eyeAboveStreetM || 14);
    for (const [d, ro, k] of [[300, -98.5, 1.7], [120, -97.5, 1.25]]) {
      const yLo = street - 25, yHi = street + 100;          // gradient: full below street + 0 m, gone ~100 m up
      const w = 10.9 * d;
      const hm = new THREE.Mesh(new THREE.PlaneGeometry(w, yHi - yLo), new THREE.MeshBasicMaterial({
        map: hazeTex, color: new THREE.Color('#3a2c52').multiplyScalar(k), transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }));
      hm.position.set(eyeWorld.x + 4.05 * d, eyeWorld.y + (yLo + yHi) / 2, eyeWorld.z - d);
      hm.renderOrder = ro; hm.frustumCulled = false;
      layerGroup.add(hm);
    }
    return meta;
  };

  // ------------------------------------------------ guideway pillars + lamp posts (instanced)
  // Concrete grey (subtle warm spill only on the car-facing face) with a streaked canvas texture and light edge
  // bevels. Speed smear = cheap motion blur: every near object is stretched along x by the distance it covers in
  // ~1.3 frames and faded by the same factor, so the nearest things smear the most instead of strobing.
  const outside = new THREE.Group(); scene.add(outside);
  const NP = 18, K0 = -4;
  const streetY = eyeWorld.y - 14;
  const pillarTex = concreteTexture(); pillarTex.anisotropy = Math.min(8, maxAniso);
  const PW = 0.85;
  const pillarMat = new THREE.MeshBasicMaterial({ vertexColors: true, map: pillarTex, transparent: true });
  const pillarSm = motionSmear(pillarMat);
  const white1 = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); white1.needsUpdate = true;   // gives the strips UVs
  const pillarGeo = new THREE.BoxGeometry(PW, 21, PW, 1, 42, 1); pillarGeo.translate(0, 10.5, 0);
  {
    // light baked into vertex colours: concrete, a little warm window spill at car height on the face toward
    // the car, faint magenta bounce from the street below
    const pos = pillarGeo.attributes.position, nor = pillarGeo.attributes.normal, col = [];
    const base = new THREE.Color('#3a3c44'), warm = new THREE.Color('#7a6552'), street = new THREE.Color('#3a2440'), c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const yw = pos.getY(i) + (eyeWorld.y - 14);           // world y (street at eye - 14 m)
      const nz = nor.getZ(i), nx = Math.abs(nor.getX(i));
      const facing = nz > 0.5 ? 1 : nx > 0.5 ? 0.55 : 0.25;
      const spill = Math.exp(-Math.pow((yw - 1.4) / 2.4, 2)) * (nz > 0.5 ? 1 : 0.25);
      const low = Math.exp(-Math.pow((yw - (eyeWorld.y - 14)) / 5, 2)) * (0.4 + 0.6 * facing);
      c.copy(base).multiplyScalar(0.55 + 0.45 * facing).lerp(warm, spill * 0.4).lerp(street, low * 0.5);
      col.push(c.r, c.g, c.b);
    }
    pillarGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    // the leading / trailing side faces sit where the smear ramps reach ~0: give them a constant u near the edge
    // so motionSmear fades them out too (at rest they just show one streaked texture column)
    const uv = pillarGeo.attributes.uv;
    for (let i = 0; i < uv.count; i++) if (Math.abs(nor.getX(i)) > 0.5) uv.setX(i, 0.045);
  }
  const pillars = new THREE.InstancedMesh(pillarGeo, pillarMat, NP);
  const STRIP_COL = new THREE.Color('#5fe2ff').multiplyScalar(4.8), SW = 0.07;
  const stripMat = new THREE.MeshBasicMaterial({ color: STRIP_COL.clone(), map: white1, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const stripSm = motionSmear(stripMat);
  const stripGeo = new THREE.BoxGeometry(SW, 14, 0.03); stripGeo.translate(0, 7, 0);
  const strips = new THREE.InstancedMesh(stripGeo, stripMat, NP * 2);
  const poleMat = new THREE.MeshStandardMaterial({ color: '#2a2d35', roughness: 0.6, metalness: 0.5, envMapIntensity: 0.3, transparent: true });
  const poleGeo = new THREE.CylinderGeometry(0.07, 0.09, 1, 8); poleGeo.translate(0, 0.5, 0);
  const poles = new THREE.InstancedMesh(poleGeo, poleMat, NP);
  const armGeo = new THREE.BoxGeometry(0.08, 0.08, 1.1); armGeo.translate(0, 0, 0.55);
  const arms = new THREE.InstancedMesh(armGeo, poleMat, NP);
  const HEAD_COL = new THREE.Color('#fff4e6').multiplyScalar(3.0), HW = 0.5;
  const headMat = new THREE.MeshBasicMaterial({ color: HEAD_COL.clone(), map: white1, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const headSm = motionSmear(headMat);
  const headGeo = new THREE.BoxGeometry(HW, 0.07, 0.22);
  const heads = new THREE.InstancedMesh(headGeo, headMat, NP);
  for (const m of [pillars, strips, poles, arms, heads]) { m.frustumCulled = false; m.renderOrder = -30; outside.add(m); }
  // OWN GUIDEWAY BEAM. The beam the car hangs from is right above the roof (never visible overhead), but ahead of the
  // car it is seen through the front glass: LED strips on its lower edges and marker lights every 3 m show the line
  // running on with open air beneath. Gamma-arms from the pylons carry it. Segments are one pillar pitch long
  // (joints at the pylons) and dim with distance (instance colours) so the line fades into the haze.
  const GB = { y0: 5.0, h: 1.2, w: 1.3, seg: PILLAR_PITCH, arm: 0.7 };
  const armZ0 = PILLAR_Z - PW / 2, armZ1 = GB.w / 2 + 0.15;
  const beamGeo = new THREE.BoxGeometry(GB.seg - 0.08, GB.h, GB.w);
  const armGGeo = new THREE.BoxGeometry(GB.arm, 0.8, armZ1 - armZ0);
  for (const g of [beamGeo, armGGeo]) {
    // baked light: dark concrete, the underside washed by the LED strips
    const pos = g.attributes.position, nor = g.attributes.normal, col = [];
    const side = new THREE.Color('#474c5c'), far = new THREE.Color('#2a2d38'), top = new THREE.Color('#202229'), under = new THREE.Color('#255f6c');
    for (let i = 0; i < pos.count; i++) {
      const ny = nor.getY(i), nz = nor.getZ(i);
      const c = ny < -0.5 ? under : ny > 0.5 ? top : nz < -0.5 ? side : far;
      col.push(c.r, c.g, c.b);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  }
  const beamMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const gBeams = new THREE.InstancedMesh(beamGeo, beamMat, NP);
  const ledMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#7ff0ff').multiplyScalar(3.8), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const gLeds = new THREE.InstancedMesh(new THREE.BoxGeometry(GB.seg - 0.9, 0.1, 0.1), ledMat, NP * 2);
  const MK = 8, MKW = 0.35;                               // underside marker lights: 8 per segment (every 3 m)
  const mkMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#e8fbff').multiplyScalar(3.4), map: white1, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const mkSm = motionSmear(mkMat);
  const gMarkers = new THREE.InstancedMesh(new THREE.BoxGeometry(MKW, 0.05, 0.22), mkMat, NP * MK);
  const armGMat = new THREE.MeshBasicMaterial({ vertexColors: true, map: white1, transparent: true });
  const armGSm = motionSmear(armGMat);
  const gArms = new THREE.InstancedMesh(armGGeo, armGMat, NP);
  const gCol = new THREE.Color(1, 1, 1);
  for (let i = 0; i < NP; i++) { gBeams.setColorAt(i, gCol); gArms.setColorAt(i, gCol); for (let k = 0; k < 2; k++) gLeds.setColorAt(2 * i + k, gCol); for (let k = 0; k < MK; k++) gMarkers.setColorAt(MK * i + k, gCol); }
  const guideMeshes = [gBeams, gLeds, gMarkers, gArms];
  for (const m of guideMeshes) { m.frustumCulled = false; m.renderOrder = -30; outside.add(m); }
  const LAMP_TOP = 3.25;
  const tmpM = new THREE.Matrix4(), tmpS = new THREE.Vector3(1, 1, 1), tmpQ = new THREE.Quaternion(), tmpP = new THREE.Vector3();
  function placeOutside(D, v) {
    const ph = ((D % PILLAR_PITCH) + PILLAR_PITCH) % PILLAR_PITCH;
    // distance covered in ~0.7 frame at 60 fps; each object becomes a trapezoid of width w + sm (motionSmear)
    const sm = reduced ? 0 : Math.min(1.2, Math.abs(v) * 0.012);
    const kP = PW / (PW + sm), kS = SW / (SW + sm), kL = 0.18 / (0.18 + sm), kH = HW / (HW + sm);
    pillarSm.set(PW, sm); stripSm.set(SW, sm, 0.12); headSm.set(HW, sm);   // strips: dimmer than energy-conserving, or the face washes cyan
    const kA = GB.arm / (GB.arm + sm), kM = MKW / (MKW + sm); armGSm.set(GB.arm, sm); mkSm.set(MKW, sm);
    const exG = view.eye[0];
    poleMat.opacity = Math.max(0.2, kL);
    for (let i = 0; i < NP; i++) {
      const x = PILLAR_X0 + (K0 + i) * PILLAR_PITCH - ph;
      tmpS.set(1 / kP, 1, 1); tmpM.compose(tmpP.set(x, streetY, PILLAR_Z), tmpQ, tmpS); pillars.setMatrixAt(i, tmpM);
      tmpS.set(1 / kS, 1, 1);
      tmpM.compose(tmpP.set(x - 0.2, streetY + 6.5, PILLAR_Z + 0.44), tmpQ, tmpS); strips.setMatrixAt(2 * i, tmpM);
      tmpM.compose(tmpP.set(x + 0.2, streetY + 6.5, PILLAR_Z + 0.44), tmpQ, tmpS); strips.setMatrixAt(2 * i + 1, tmpM);
      const lx = x + LAMP_DX;
      tmpS.set(1 / kL, LAMP_TOP - streetY, 1); tmpM.compose(tmpP.set(lx, streetY, LAMP_Z - 1.0), tmpQ, tmpS); poles.setMatrixAt(i, tmpM);
      tmpS.set(1 + (1 / kL - 1) * (0.18 / 0.08), 1, 1); tmpM.compose(tmpP.set(lx, LAMP_TOP, LAMP_Z - 1.0), tmpQ, tmpS); arms.setMatrixAt(i, tmpM);
      tmpS.set(1 / kH, 1, 1); tmpM.compose(tmpP.set(lx, LAMP_TOP - 0.06, LAMP_Z + 0.05), tmpQ, tmpS); heads.setMatrixAt(i, tmpM);
      // own beam segment between this pylon and the next, its two LED strips, markers, and the pylon's arm
      const bx = x + GB.seg / 2, fade = Math.exp(-Math.max(0, Math.abs(bx - exG) - 40) / 160);
      tmpS.set(1, 1, 1);
      tmpM.compose(tmpP.set(bx, GB.y0 + GB.h / 2, 0), tmpQ, tmpS); gBeams.setMatrixAt(i, tmpM);
      tmpM.compose(tmpP.set(bx, GB.y0 + 0.03, GB.w / 2 - 0.02), tmpQ, tmpS); gLeds.setMatrixAt(2 * i, tmpM);
      tmpM.compose(tmpP.set(bx, GB.y0 + 0.03, -GB.w / 2 + 0.02), tmpQ, tmpS); gLeds.setMatrixAt(2 * i + 1, tmpM);
      gBeams.setColorAt(i, gCol.setScalar(0.3 + 0.7 * fade)); gLeds.setColorAt(2 * i, gCol.setScalar(fade)); gLeds.setColorAt(2 * i + 1, gCol);
      tmpS.set(1 / kA, 1, 1); tmpM.compose(tmpP.set(x, GB.y0 + GB.h + 0.4, (armZ0 + armZ1) / 2), tmpQ, tmpS); gArms.setMatrixAt(i, tmpM);
      tmpS.set(1 / kM, 1, 1);
      for (let k = 0; k < MK; k++) {
        tmpM.compose(tmpP.set(x + (k + 0.5) * (GB.seg / MK), GB.y0 - 0.03, 0), tmpQ, tmpS); gMarkers.setMatrixAt(MK * i + k, tmpM);
        gMarkers.setColorAt(MK * i + k, gCol.setScalar(fade));
      }
    }
    for (const m of [pillars, strips, poles, arms, heads]) m.instanceMatrix.needsUpdate = true;
    for (const m of guideMeshes) { m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true; }
    // the two nearest lamps sweep cool light through the interior as they pass (x relative to the eye)
    const ex = view.eye[0];
    let n0 = Infinity, n1 = Infinity;           // the two lamp x nearest to the eye (lamps sit on a regular pitch)
    for (let i = 0; i < NP; i++) {
      const lx = PILLAR_X0 + (K0 + i) * PILLAR_PITCH - ph + LAMP_DX;
      if (Math.abs(lx - ex) < Math.abs(n0 - ex)) { n1 = n0; n0 = lx; } else if (Math.abs(lx - ex) < Math.abs(n1 - ex)) n1 = lx;
    }
    for (let j = 0; j < 2; j++) {
      const lx = j ? n1 : n0, dx = lx - ex;
      sweep[j].position.set(clamp(lx, -5.5, 5.5), 1.5, -0.35);
      sweep[j].intensity = 5.5 * (1 - smooth(4.0, 7.0, Math.abs(lx))) * (0.65 + 0.35 * Math.exp(-(dx * dx) / 6));
    }
  }

  // ------------------------------------------------ station platforms (one per stop, instanced)
  // floor flush with the car floor (lit terrazzo: tile joints, tactile strip behind the yellow edge, light pools
  // every 6 m in the emissive map), yellow edge, glass balustrade with a lit handrail and a light strip at its
  // base 4.7 m out, one station name board (the nearest stop) seen through door B, and the station's own light.
  const PL = { len: 58, z0: -1.53, z1: -6.2 };
  const platTex = platformTextures(maxAniso);
  const platFloor = new THREE.InstancedMesh(new THREE.BoxGeometry(PL.len, 0.35, PL.z0 - PL.z1).translate(0, -0.175, (PL.z0 + PL.z1) / 2),
    new THREE.MeshStandardMaterial({ color: '#ffffff', map: platTex.map, emissive: '#ffe6c8', emissiveMap: platTex.emis, emissiveIntensity: 0.6, roughness: 0.6, metalness: 0.05, envMapIntensity: 0.4 }), N);
  const platEdge = new THREE.InstancedMesh(new THREE.BoxGeometry(PL.len, 0.012, 0.42).translate(0, 0.006, PL.z0 - 0.21),
    new THREE.MeshStandardMaterial({ color: '#c8951f', emissive: '#c8951f', emissiveIntensity: 0.12, roughness: 0.6, metalness: 0.0 }), N);
  const platGlass = new THREE.InstancedMesh(new THREE.PlaneGeometry(PL.len, 1.05).translate(0, 0.525, PL.z1 + 0.05),
    new THREE.MeshBasicMaterial({ color: new THREE.Color('#6fe4ff').multiplyScalar(0.08), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true }), N);
  const RAIL_Y = 1.07, RAIL_Z = PL.z1 + 0.05;
  const platRail = new THREE.InstancedMesh(new THREE.BoxGeometry(PL.len, 0.035, 0.05).translate(0, RAIL_Y, RAIL_Z),
    new THREE.MeshBasicMaterial({ color: new THREE.Color('#bfe6f2').multiplyScalar(0.8) }), N);   // lit, but under the bloom threshold
  const platGlow = new THREE.InstancedMesh(new THREE.BoxGeometry(PL.len, 0.035, 0.05).translate(0, 0.05, PL.z1 + 0.14),
    new THREE.MeshBasicMaterial({ color: new THREE.Color('#9feaff').multiplyScalar(2.6) }), N);
  platGlass.renderOrder = -20;
  const platParts = [platFloor, platEdge, platGlass, platRail, platGlow];
  for (const m of platParts) { m.frustumCulled = false; outside.add(m); }
  const board = stationBoard(stops, maxAniso);
  outside.add(board.group);
  const BOARD_X = 10.2, DOOR_B_X = 2.76;
  function placePlatforms(D) {
    for (let k = 0; k < N; k++) {
      const x = k * SPACING - D;
      // far platforms collapse to a point (a y-only zero scale leaves flat faces with NaN normals -> NaN bloom)
      const s = Math.abs(x) < 150 ? 1 : 0;
      tmpS.set(s, s, s);
      tmpM.compose(tmpP.set(x, 0, 0), tmpQ, tmpS);
      for (const m of platParts) m.setMatrixAt(k, tmpM);
    }
    for (const m of platParts) m.instanceMatrix.needsUpdate = true;
    const kN = clamp(Math.round(D / SPACING), 0, N - 1), xN = kN * SPACING - D;
    board.show(kN);
    board.group.position.set(xN + BOARD_X, 0, PL.z1 + 0.16);
    board.group.visible = Math.abs(xN) < 150;
    platLight.position.set(xN + DOOR_B_X, 2.4, -3.1);
    platLight.intensity = 6 * (1 - smooth(18, 40, Math.abs(xN)));
  }

  // ------------------------------------------------ holograms
  const holos = new Map();
  const holoAnchor = new THREE.Vector3();
  function anchorFor(v) {
    const e = v.eye, az = (v.haz ?? HOLO.az) * DEG, el = (v.hel ?? HOLO.el) * DEG, d = HOLO.dist;
    return holoAnchor.set(e[0] + d * Math.sin(az), e[1] + d * Math.tan(el), e[2] - d * Math.cos(az));
  }
  /** Vertical placement + scale of hologram H for view v: centred at the view's anchor elevation, raised so its
   *  bottom edge clears the platform handrail by RAIL_CLEAR deg (the rail is highest in the frame at the panel's
   *  right edge, the largest azimuth), and scaled down if it would then reach the hand loops (HOLO_TOP_EL). */
  function holoFit(v, H, out) {
    const e = v.eye, d = HOLO.dist, az = (v.haz ?? HOLO.az) * DEG;
    const yC0 = e[1] + d * Math.tan((v.hel ?? HOLO.el) * DEG);
    const yMax = e[1] + d * Math.tan(HOLO_TOP_EL * DEG);
    let s = 1, yMin = 0;
    for (let k = 0; k < 2; k++) {
      const azR = az + Math.atan((H.w * s) / 2 / d);
      const railEl = -Math.atan(((e[1] - RAIL_Y - 0.02) * Math.cos(azR)) / (e[2] - RAIL_Z));
      yMin = e[1] + d * Math.tan(railEl + RAIL_CLEAR * DEG);
      s = Math.min(1, (yMax - yMin) / H.h);
    }
    const half = (H.h * s) / 2;
    out.s = s; out.y = Math.min(Math.max(yC0, yMin + half), yMax - half);
    return out;
  }
  const holoTargets = [];
  async function ensureHolo(i) {
    if (holos.has(i)) return holos.get(i);
    const H = createHologram(stops[i], { frozen, reduced, texLoader, maxAniso, renderer, parked: () => parkedOpen() });
    holos.set(i, H);
    outside.add(H.group);
    holoTargets.push(...H.pickables);
    return H;
  }

  // ------------------------------------------------ post-processing
  const composerRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: clamp(Math.round(num('msaa', 4)), 0, 8) });
  const composer = new EffectComposer(renderer, composerRT);
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.45, 0.9);
  {
    const hp = bloom.materialHighPassFilter, src = 'vec4 texel = texture2D( tDiffuse, vUv );';
    if (hp && hp.fragmentShader.includes(src)) {
      // NaN / Inf from any shader would otherwise be smeared across the whole bloom mip chain (black blocks)
      hp.fragmentShader = hp.fragmentShader.replace(src, src + ' if ( !( texel.r + texel.g + texel.b < 3.0e4 ) ) texel = vec4( 0.0 );');
      hp.needsUpdate = true;
    }
  }
  composer.addPass(bloom);
  const outPass = new OutputPass();
  composer.addPass(outPass);
  // The bloom's last step (add the bloom mip composite onto the full-res scene) drew a full-screen quad into the
  // 4x MSAA HalfFloat target and forced a second MSAA resolve. Do that add inside the output pass instead (same
  // maths: additive blend = rgb * a), which reads the resolved scene anyway.
  {
    const fq = bloom._fsQuad, bm = bloom.blendMaterial, src = 'gl_FragColor = texture2D( tDiffuse, vUv );';
    if (fq && bm && typeof fq.render === 'function' && outPass.material.fragmentShader.includes(src)) {
      outPass.uniforms.tBloom = { value: null };
      outPass.uniforms.bloomOn = { value: 0 };
      outPass.material.fragmentShader = outPass.material.fragmentShader
        .replace('uniform sampler2D tDiffuse;', 'uniform sampler2D tDiffuse;\nuniform sampler2D tBloom;\nuniform float bloomOn;')
        .replace(src, src + '\nif ( bloomOn > 0.5 ) { vec4 bl = texture2D( tBloom, vUv ); gl_FragColor.rgb += bl.rgb * bl.a; }');
      const fqRender = fq.render.bind(fq);
      fq.render = (r) => { if (fq.material !== bm) fqRender(r); };
      const outRender = outPass.render.bind(outPass);
      outPass.render = (...a) => {
        outPass.uniforms.tBloom.value = bloom.renderTargetsHorizontal[0].texture;
        outPass.uniforms.bloomOn.value = bloom.enabled ? 1 : 0;
        outRender(...a);
      };
    }
  }
  let bloomScale = 1;
  const bloomSetSize = bloom.setSize.bind(bloom);
  bloom.setSize = (w, h) => bloomSetSize(Math.max(1, Math.round(w * bloomScale)), Math.max(1, Math.round(h * bloomScale)));
  const sceneStats = { calls: 0, tris: 0 };
  const rpRender = renderPass.render.bind(renderPass);
  renderPass.render = (...a) => { renderer.info.reset(); rpRender(...a); sceneStats.calls = renderer.info.render.calls; sceneStats.tris = renderer.info.render.triangles; };

  // ------------------------------------------------ sizing
  // Pixel ratio: HiDPI desktops with a capable GPU start sharp at DPR 2 (hiDpr); the first quality step drops that to
  // the 1.5 cap if the GPU does not keep up. Phones / tablets / touch screens stay <= 1.5 (their GPUs are the weak
  // part and their small screens gain little). Then the quality steps: 0 full, 1 no bloom, 2 dpr <= 1, 3 dpr 0.75.
  let quality = 0;
  const weakGpu = /intel|mali|adreno|powervr|videocore|mesa|llvmpipe|swiftshader|software|basic render/i.test(gpuName);
  let hiDpr = !P.has('dprcap') && !smallScreen && (devicePixelRatio || 1) > 1.5 && !weakGpu && renderer.capabilities.maxTextureSize >= 16384;
  function pickView() {
    const a = innerWidth / innerHeight;
    const v = { ...(a < 0.8 ? CAR.view.phone : a < 1.3 ? CAR.view.tablet : innerHeight <= 500 ? CAR.view.short : CAR.view.desk) };
    if (P.has('byaw')) v.yaw = num('byaw', v.yaw);
    if (P.has('bpitch')) v.pitch = num('bpitch', v.pitch);
    if (P.has('beye')) v.eye = P.get('beye').split(',').map(Number);
    if (P.has('haz')) v.haz = num('haz', v.haz);
    if (P.has('hel')) v.hel = num('hel', v.hel);
    return v;
  }
  // Desktop layout: the stop card column (bottom-left) must not cover the hologram. Project the full-size panel's
  // left edge and shift the lens right until it clears the card column by 24 px; past XSHIFT_MAX the card column
  // narrows instead (--card-w). Same framing at every stop of a given viewport (tallest-card case).
  const phoneMQ = matchMedia('(max-width: 700px), (max-width: 1024px) and (orientation: portrait)');
  const probe = new THREE.PerspectiveCamera(), probeV = new THREE.Vector3();
  const htmlRoot = document.documentElement;
  let railShown = false, cardXShift = 0;
  function holoLeftNdc(v) {
    probe.projectionMatrix.copy(camera.projectionMatrix);
    probe.position.set(v.eye[0], v.eye[1], v.eye[2]);
    probe.rotation.set(v.pitch * DEG, v.yaw * DEG, 0, 'YXZ');
    probe.updateMatrixWorld(true);
    const a = anchorFor(v), fx = a.x - v.eye[0], fz = a.z - v.eye[2], L = Math.hypot(fx, fz);
    const rx = -fz / L, rz = fx / L;                       // the viewer's right, in the panel plane
    let ndc = Infinity;
    for (const dy of [-3.5, 3.5]) ndc = Math.min(ndc, probeV.set(a.x - rx * HOLO_HALF_W, a.y + dy, a.z - rz * HOLO_HALF_W).project(probe).x);
    return ndc;
  }
  function cardClearShift(w) {
    if (!htmlRoot.classList.contains('ride')) return cardXShift;       // text view: keep the last value
    htmlRoot.style.removeProperty('--card-w');
    if (phoneMQ.matches) return 0;
    const col = document.getElementById('content')?.getBoundingClientRect();
    if (!col || !col.width) return 0;
    const left = holoLeftNdc(view);
    const need = (2 * (col.right + 24)) / w - 1 - left;
    if (need <= XSHIFT_MAX) return Math.max(0, need);
    const px = ((left + XSHIFT_MAX + 1) / 2) * w;
    htmlRoot.style.setProperty('--card-w', Math.max(320, Math.floor(px - 24 - col.left)) + 'px');
    return XSHIFT_MAX;
  }
  function resize() {
    const w = innerWidth, h = innerHeight;
    view = pickView();
    const portrait = w / h < 0.8;
    bloomScale = portrait || smallScreen ? 0.5 : 1;
    // DPR 2 costs ~3x the pixels of DPR 1 (measured +220 % frame time): only while the GPU keeps up (hiDpr)
    const cap = num('dprcap', hiDpr ? 2 : 1.5);
    let dpr = quality >= 3 ? 0.75 : quality >= 2 ? Math.min(1, cap) : Math.min(devicePixelRatio || 1, cap);
    dpr = Math.min(dpr, maxDraw / Math.max(w, h, 1));   // never beyond the GPU's largest drawable size
    renderer.setPixelRatio(dpr); renderer.setSize(w, h, false);
    composer.setPixelRatio(dpr); composer.setSize(w, h);
    camera.aspect = w / h;
    // very wide screens: cap the horizontal FOV at ~92 deg so the view stays inside the glazing
    const hfovCap = 92 * DEG;
    let vfov = num('fov', view.vfov);
    const hfov = 2 * Math.atan(Math.tan(vfov * DEG / 2) * camera.aspect);
    if (hfov > hfovCap) vfov = 2 * Math.atan(Math.tan(hfovCap / 2) / camera.aspect) / DEG;
    camera.fov = vfov;
    camera.near = 0.1; camera.far = 16000;
    camera.updateProjectionMatrix();
    cardXShift = cardClearShift(w);
    const shift = num('shift', view.shift), xshift = Math.max(view.xshift || 0, cardXShift);
    if (shift || xshift) {
      camera.projectionMatrix.elements[9] -= shift;      // content up by shift/2 of the height
      camera.projectionMatrix.elements[8] -= xshift;     // content right by xshift/2 of the width
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    }
    // the HTML route map (desktop layout) covers the ceiling route strip: draw the strip as a text-free route
    // diagram there, so no clipped letters peek out around the panel. (?ui=0 renders what sits under the UI, so
    // assets/poster.jpg matches the live page it stands in for while loading.)
    railShown = htmlRoot.classList.contains('ride') && !phoneMQ.matches;
  }
  resize();
  addEventListener('resize', () => { monReset(); resize(); }, sig);

  // ------------------------------------------------ look-around input
  const stage = canvas.parentElement;
  let dragging = null;
  addEventListener('pointermove', (e) => {
    if (lookFixed || reduced) return;
    if (e.pointerType === 'mouse') {
      if (e.target.closest && e.target.closest('#identity, main, #ride-ui')) return;
      const nx = (e.clientX / innerWidth) * 2 - 1, ny = (e.clientY / innerHeight) * 2 - 1;
      lookState.ty = -nx * CAR.look.yaw; lookState.tp = -ny * CAR.look.pitch;
      hover(e);
    } else if (dragging && e.pointerId === dragging.id) {
      const dx = e.clientX - dragging.x, dy = e.clientY - dragging.y;
      if (Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy)) dragging.moved = true;
      if (dragging.moved) lookState.ty = clamp(dragging.yaw + (dx / innerWidth) * 70, -CAR.look.yaw, CAR.look.yaw);
    }
  }, psig);
  document.documentElement.addEventListener('mouseleave', () => { if (!lookFixed) { lookState.ty = 0; lookState.tp = 0; } }, sig);
  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') dragging = { id: e.pointerId, x: e.clientX, y: e.clientY, yaw: lookState.yaw, moved: false };
  }, sig);
  const endDrag = (e) => { if (dragging && e.pointerId === dragging.id) { dragging = null; if (!lookFixed) { lookState.ty = 0; lookState.tp = 0; } } };
  addEventListener('pointerup', endDrag, sig); addEventListener('pointercancel', endDrag, sig);

  // hologram picking
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function pick(clientX, clientY) {
    ndc.set((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const vis = holoTargets.filter((m) => m.visible && m.parent.visible && m.userData.holo.appear > 0.5);
    const hit = raycaster.intersectObjects(vis, false)[0];
    return hit ? hit.object.userData.holo : null;
  }
  let hoverT = 0;
  function hover(e) {
    const now = performance.now(); if (now - hoverT < 80) return; hoverT = now;
    stage.style.cursor = pick(e.clientX, e.clientY) ? 'pointer' : '';
  }
  stage.addEventListener('click', (e) => {
    const H = pick(e.clientX, e.clientY);
    if (H) ui.hologramClicked(H.stop.i);
  }, sig);

  // ------------------------------------------------ simulation state
  const sim = {
    D: 0, v: 0, acc: 0, doorU: 0, dwell: 0, ramp: 0,
    swing: 0, swingV: 0,        // fore-aft pendulum swing of the hanging car (deg)
    t: 0,
  };
  const Dstop = (k) => k * SPACING;
  const stopAtD = (D) => { const k = Math.round(D / SPACING); return Math.abs(D - Dstop(k)) < 1e-3 && k >= 0 && k < N ? k : -1; };
  let lockTarget = null;
  const holdP = ui.pInit !== null && ui.pInit !== undefined;
  if (holdP) {
    sim.D = ui.pInit * (N - 1) * SPACING;
    sim.v = sim.D >= (N - 1) * SPACING ? 0 : profileSpeed(sim.D);
    const kNext = Math.min(N - 1, Math.ceil(sim.D / SPACING - 1e-6));
    lockTarget = Dstop(kNext);
  } else if (P.has('stop')) {
    sim.D = Dstop(ui.initial); lockTarget = sim.D;
  } else if (!reduced) {
    sim.D = Dstop(ui.initial) - 110; sim.v = 42;     // intro: glide into the first stop
  } else {
    sim.D = Dstop(ui.initial);
  }
  const frozenP = frozen && holdP;   // parallax test: keep the car exactly at p, moving at the profile speed

  function targetD() {
    if (ui.locked && lockTarget !== null) return lockTarget;
    return distForS(ui.getTargetS());
  }
  // parked at a stop with the doors open and no other stop chosen: the only time media start-up work may run
  const parkedOpen = () => sim.v === 0 && sim.doorU === 1 && stopAtD(sim.D) >= 0 && Math.abs(targetD() - sim.D) < 0.01;

  function step(dt) {
    const Dt = targetD();
    const tStop = stopAtD(Dt);
    const prevV = sim.v;
    if (reduced) {
      sim.D = Dt; sim.v = 0; sim.doorU = tStop >= 0 ? 1 : 0; sim.acc = 0; sim.t += dt; return;
    }
    const needMove = Math.abs(Dt - sim.D) > 0.01;
    if (needMove && sim.doorU > 0) {
      sim.doorU = Math.max(0, sim.doorU - dt / DOOR_CLOSE); sim.dwell = 0;   // doors shut as it pulls away
    }
    if ((needMove && sim.doorU <= DEPART_U) || sim.v !== 0) {
      sim.ramp = Math.min(1, sim.ramp + dt / RAMP);
      const d = Dt - sim.D, sgn = Math.sign(d) || 1;
      // braking curve with a soft end: deceleration fades to 0 at the stop (v ~ BRK * d / V_SOFT near it)
      const vdes = sgn * Math.min(VMAX, Math.sqrt(2 * BRK * Math.abs(d) + V_SOFT * V_SOFT) - V_SOFT);
      const braking = Math.abs(vdes) < Math.abs(sim.v) || Math.sign(vdes) !== Math.sign(sim.v);
      const r = sim.ramp * sim.ramp * (3 - 2 * sim.ramp);                  // eased departure (limits the jerk)
      const lim = (braking ? BRK : ACC * r) * dt;
      sim.v += clamp(vdes - sim.v, -lim, lim);
      sim.D += sim.v * dt;
      if (Math.abs(Dt - sim.D) < 0.012 && Math.abs(sim.v) < 0.3) { sim.D = Dt; sim.v = 0; }
    }
    if (sim.v === 0 && !needMove) sim.ramp = 0;
    const at = stopAtD(sim.D);
    if (at >= 0 && at === tStop && sim.v === 0) {
      sim.dwell += dt;
      if (sim.dwell > DWELL) sim.doorU = Math.min(1, sim.doorU + dt / DOOR_OPEN);
    } else if (!needMove) { sim.dwell = 0; }
    const a = (sim.v - prevV) / Math.max(dt, 1e-4);
    sim.acc += (a - sim.acc) * Math.min(1, dt * 8);
    // pendulum: equilibrium swing proportional to acceleration, under-damped
    const eq = -0.6 * clamp(sim.acc / ACC, -1.2, 1.2);
    const w = 2.3, z = 0.4;
    sim.swingV += (-(w * w) * (sim.swing - eq) - 2 * z * w * sim.swingV) * dt;
    sim.swing += sim.swingV * dt;
    sim.t += dt;
  }
  function run(T) { const dt = 1 / 60; for (let t = 0; t < T - 1e-9; t += dt) step(Math.min(dt, T - t)); }

  // ------------------------------------------------ wait for layers + fonts, then first holograms
  const layerData = await need(layersP);
  buildLayers(layerData);
  await need(fontsP);
  routeDisp.draw(''); headerDisp.draw('');

  if (frozen && !frozenP) run(frozenT);
  if (frozenP) sim.t = frozenT;

  // holograms near the start position (awaited when frozen so screenshots are deterministic)
  const kNear = Math.round(sim.D / SPACING);
  // Station boards: the ones the car can show first (from the start position to the first stop, and their
  // neighbours) are drawn now and uploaded with everything else (prewarm); the others once the ride is on screen
  // and parked (paintLater), long before the car can reach them.
  {
    const k0 = clamp(Math.min(kNear, ui.initial) - 1, 0, N - 1), k1 = clamp(Math.max(kNear, ui.initial) + 1, 0, N - 1);
    for (let k = k0; k <= k1; k++) board.paint(k);
    board.show(clamp(kNear, 0, N - 1));
  }
  // Every hologram is built now (hidden): none is drawn to a canvas, uploaded or compiled in the middle of a ride.
  for (let k = 0; k < N; k++) ensureHolo(k);
  const firstReady = Promise.all([kNear - 1, kNear, kNear + 1].filter((k) => k >= 0 && k < N).map((k) => holos.get(k).ready));
  if (frozen) await need(firstReady);
  freezeStatic();
  await need(prewarm());

  // ------------------------------------------------ prewarm (before the canvas fades in)
  // Compile every program the ride can need (hidden holograms included) in parallel (KHR_parallel_shader_compile)
  // with the render state of the composer's target, then upload every texture. The first frames of a hop used to
  // pay for shader links and texture uploads (8-11 ms spikes), and the first frame for all of it (~1.2 s).
  async function prewarm() {
    const wait = (p) => Promise.race([p, new Promise((r) => setTimeout(r, 5000))]);
    const quadScene = (mats) => { const s = new THREE.Scene(); for (const m of mats) s.add(new THREE.Mesh(new THREE.PlaneGeometry(), m)); return s; };
    const jobs = [];
    // parallel compile where the driver offers it (KHR_parallel_shader_compile); otherwise a plain compile now
    // (asking three for the missing extension would log a warning)
    const par = renderer.extensions.has('KHR_parallel_shader_compile');
    const compile = (sc, cam, target = null) => (par ? renderer.compileAsync(sc, cam, target) : (renderer.compile(sc, cam, target), Promise.resolve()));
    try {
      renderer.setRenderTarget(composer.renderTarget1);
      jobs.push(compile(scene, camera));
      const bloomMats = [bloom.materialHighPassFilter, ...(bloom.separableBlurMaterials || []), bloom.compositeMaterial].filter(Boolean);
      // the route display's other material (desktop route diagram) with the ride scene's lights: a program's key
      // includes the scene's light counts, and one compiled without them was linked again, synchronously, in the
      // first frame (~50 ms on the load's critical path)
      jobs.push(compile(quadScene(routeDisp.mats.filter((m) => m !== routeDisp.mesh.material)), camera, scene));
      renderer.setRenderTarget(bloom.renderTargetBright);
      jobs.push(compile(quadScene(bloomMats), camera));
      // The output pass (tone mapping + sRGB) sets its shader defines in its first render: set them now (its quad
      // draw skipped) so that its program is compiled in parallel with the others, not in the first frame.
      const oq = outPass._fsQuad;
      if (oq && typeof oq.render === 'function') {
        const draw = oq.render;
        oq.render = () => {};
        try { outPass.render(renderer, null, composer.readBuffer); } finally { oq.render = draw; }
        renderer.setRenderTarget(null);
        jobs.push(compile(quadScene([outPass.material]), camera));
      }
    } catch (e) { /* compile on first use instead */ }
    renderer.setRenderTarget(null);
    const tex = new Set();
    scene.traverse((o) => {
      for (const m of o.material ? [].concat(o.material) : []) {
        for (const v of Object.values(m)) if (v && v.isTexture) tex.add(v);
        if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u && u.value && u.value.isTexture) tex.add(u.value);
      }
    });
    board.textures.forEach((t, k) => { if (board.painted(k)) tex.add(t); else tex.delete(t); });
    for (const t of tex) { try { renderer.initTexture(t); } catch (e) { /* uploaded on first use */ } }
    // The state symbols (● ▸ ›) are outside the sign / mono fonts' subsets: resolve their fallback font here, while
    // the main thread only waits for the parallel shader compile. Its first use (a system font lookup, ~25-30 ms,
    // 4x that on a slow phone) used to land in the first departing frame, and then on the load's critical path.
    {
      const c = document.createElement('canvas').getContext('2d');
      for (const f of [`600 58px ${FONT_SIGN}`, `600 31px ${FONT_SIGN}`, `500 11px ${FONT_MONO}`]) { c.font = f; c.measureText('● ▸ › ‹ ▲'); c.fillText('● ▸ › ‹ ▲', 0, 40); }
    }
    await wait(Promise.all(jobs).catch(() => {}));
  }

  // The remaining station boards: drawn and uploaded one per idle slot while the car is parked with its doors open
  // and no other stop chosen (a board shows from half-way between two stops; drawing one costs a few ms of text
  // measuring, more on a slow phone).
  function paintLater() {
    const left = [];
    for (let k = 0; k < N; k++) if (!board.painted(k)) left.push(k);
    const idle = typeof requestIdleCallback === 'function' ? (f) => requestIdleCallback(f, { timeout: 500 }) : (f) => setTimeout(f, 50);
    const next = () => {
      if (disposed || !left.length) return;
      if (!parkedOpen()) { setTimeout(() => idle(next), 250); return; }      // not while departing / moving
      const kC = Math.round(sim.D / SPACING);
      let j = 0;
      for (let i = 1; i < left.length; i++) if (Math.abs(left[i] - kC) < Math.abs(left[j] - kC)) j = i;
      const k = left.splice(j, 1)[0];
      if (board.paint(k)) { try { renderer.initTexture(board.textures[k]); } catch (e) { /* uploaded on first use */ } }
      idle(next);
    };
    if (left.length && !frozen) idle(next);         // frozen (?t=): the car never leaves its place
  }

  // ------------------------------------------------ static objects
  // Most of the scene never moves relative to its parent (car parts, platforms, layers, instanced outside objects —
  // their instances move, not the object). Compose their local matrices once instead of every frame (three still
  // recomputes world matrices below the swaying rig). Kept live: the rig, the camera, lights and boards that move,
  // hologram groups and every node the door animation drives.
  function freezeStatic() {
    const live = new Set([scene, rig, camera, board.group, platLight, ...sweep]);
    for (const H of holos.values()) live.add(H.group);
    if (clip) for (const tr of clip.tracks) { const o = THREE.PropertyBinding.findNode(car, THREE.PropertyBinding.parseTrackName(tr.name).nodeName); if (o) live.add(o); }
    scene.traverse((o) => { if (!live.has(o)) { o.updateMatrix(); o.matrixAutoUpdate = false; } });
  }

  // ------------------------------------------------ per-frame apply
  let primeT = -1e9, lastOutD = NaN, lastOutV = NaN, lastOutE = NaN, mapKey = -1, routeKey = -1, headKey = -1;
  const camBase = new THREE.Vector3();
  const eyeW = new THREE.Vector3();
  const fit = { s: 1, y: 0 };
  const rideState = { s: 0, moving: false, atStop: -1, doorU: 0, v: 0 };
  function apply(t, dt) {
    const speedN = clamp(Math.abs(sim.v) / 45, 0, 1);
    const accN = clamp(Math.abs(sim.acc) / ACC, 0, 1);
    // sway (roll about the rail axis) + fore-aft pendulum swing; bob on the head
    if (!reduced) {
      rig.rotation.x = DEG * ((0.22 * Math.sin(0.71 * t) + 0.08 * Math.sin(1.93 * t + 1.3)) * (0.3 + 0.7 * speedN) + 0.12 * accN * Math.sin(3.1 * t));
      rig.rotation.z = DEG * sim.swing;
    } else { rig.rotation.set(0, 0, 0); }
    rig.updateMatrix(); car.updateMatrix();
    carInv.value.multiplyMatrices(rig.matrix, car.matrix).invert();
    // look spring (critically damped)
    // closed-form critically damped step: the same motion at 60, 144 or 164 fps
    const wl = 6.0;
    if (!lookFixed) {
      const e = Math.exp(-wl * dt);
      let x0 = lookState.yaw - lookState.ty, c = lookState.vy + wl * x0;
      lookState.yaw = lookState.ty + (x0 + c * dt) * e; lookState.vy = (lookState.vy - wl * c * dt) * e;
      x0 = lookState.pitch - lookState.tp; c = lookState.vp + wl * x0;
      lookState.pitch = lookState.tp + (x0 + c * dt) * e; lookState.vp = (lookState.vp - wl * c * dt) * e;
    }
    const e = view.eye;
    camBase.set(e[0], e[1], e[2]);
    const bob = reduced ? 0 : 0.009 * Math.sin(2 * Math.PI * 1.55 * t) * speedN + 0.004 * Math.sin(2 * Math.PI * 0.23 * t) + 0.004 * accN * Math.sin(2 * Math.PI * 3.1 * t);
    camera.position.set(camBase.x, camBase.y + bob, camBase.z);
    camera.rotation.y = (view.yaw + lookState.yaw) * DEG;
    camera.rotation.x = (view.pitch + lookState.pitch) * DEG;
    camera.rotation.z = 0;

    // doors
    setDoor(sim.doorU);
    // no glass in the open door-B aperture: fade reflections that are seen through it
    for (const m of reflStrips) if (m.position.x > 1.2 && m.position.x < 4.6) m.visible = sim.doorU < 0.35;

    // city: UV scroll ∝ distance, blur ∝ speed
    for (const { L, mat } of layers) {
      mat.uniforms.offset.value = ((sim.D / L.tileWidthM) % 1 + 1) % 1;
      mat.uniforms.blur.value = Math.min(0.012, (Math.abs(sim.v) / 80) / L.tileWidthM);
    }
    if (sim.D !== lastOutD || sim.v !== lastOutV || view.eye[0] !== lastOutE) {
      lastOutD = sim.D; lastOutV = sim.v; lastOutE = view.eye[0];
      placeOutside(sim.D, sim.v); placePlatforms(sim.D);
    }

    // holograms: anchored to their stop, fade/drift in as the car approaches
    const sNow = sim.D / SPACING;
    const kN = Math.round(sNow);
    for (let k = kN - 1; k <= kN + 1; k++) if (k >= 0 && k < N && !holos.has(k)) ensureHolo(k);
    camera.getWorldPosition(eyeW);
    const anchor = anchorFor(view);
    let spill = 0;
    for (let k = 0; k < N; k++) {
      const H = holos.get(k);
      if (!H) continue;
      const dd = sim.D - Dstop(k);
      const near = 1 - smooth(6, 64, Math.abs(dd));
      const atStopBoost = stopAtD(sim.D) === k ? 1 : 0;
      const appear = Math.max(near * near, atStopBoost);
      H.group.visible = appear > 0.003 && Math.abs(dd) < 140;
      if (!H.group.visible) { H.setActive(false); continue; }
      holoFit(view, H, fit);
      H.group.scale.setScalar(fit.s);
      H.group.position.set(anchor.x - dd, fit.y + (1 - near) * 2.5, anchor.z);
      H.group.lookAt(eyeW);
      H.group.rotateY((1 - near) * 38 * DEG * Math.sign(dd || 1));
      H.update(t, appear);
      H.setActive(appear > 0.05);
      spill = Math.max(spill, appear);
    }
    holoLight.intensity = 2.2 * spill;
    // parked, doors open: prime this stop's and the neighbours' videos (one per ~0.3 s, outside the frame), so no
    // media start-up lands in the middle of a hop. Checked again when the timeout runs: a tap / swipe in between
    // has already set the doors closing, and the video start-up (tens of ms) would land in the departure.
    const atNow = stopAtD(sim.D);
    if (atNow >= 0 && sim.v === 0 && sim.doorU === 1 && sim.dwell > 0.8 && sim.t - primeT > 0.3) {
      const H = [atNow, atNow + 1, atNow - 1].map((k) => holos.get(k)).find((h) => h && !h.primed());
      if (H) { primeT = sim.t; setTimeout(() => { if (parkedOpen()) H.prime(); }, 0); }
    }

    // displays
    const at = stopAtD(sim.D);
    // while moving, ▸ names the destination (the stop the target distance rounds to in the travel direction);
    // a station passed on the way is shown on the route strip after ›. The only words are the stops' labels
    // (the page's own headings / paper title prefixes, as written); the states are symbols: ● here, ▸ next.
    let dirNext, passing = -1;
    if (at >= 0 && sim.v === 0) dirNext = Math.min(N - 1, at + 1);
    else {
      const sT = targetD() / SPACING, fwd = sim.v > 0 || (sim.v === 0 && sT >= sNow);
      dirNext = clamp(fwd ? Math.ceil(sT - 1e-3) : Math.floor(sT + 1e-3), 0, N - 1);
      const kPass = clamp(fwd ? Math.ceil(sNow - 1e-3) : Math.floor(sNow + 1e-3), 0, N - 1);
      if (kPass !== dirNext && (fwd ? kPass < dirNext : kPass > dirNext)) passing = kPass;
    }
    // Displays: canvas redraws (texture uploads) only when their content changes. The desktop route diagram's
    // moving parts (progress bar, car marker) are drawn by its shader from uniforms; its canvas (line, stop dots)
    // changes only when the car reaches, leaves or passes a stop (it was redrawn ~40x per stop = 67x/s at speed).
    const lab = (k) => stops[k].label;
    const parked = at >= 0 && sim.v === 0;
    const hk = parked ? at : 100 + dirNext;
    if (hk !== headKey) { headKey = hk; headerDisp.draw(parked ? `● ${lab(at)}` : `▸ ${lab(dirNext)}`); }
    if (railShown) {
      const atS = parked ? at : -1, mk = (atS + 1) * 64 + clamp(Math.ceil(sNow), 0, N);
      if (mk !== mapKey) { mapKey = mk; routeKey = -1; routeDisp.drawMap(N, sNow, atS); }
      routeDisp.setMapCar(N, sNow, atS);
    } else {
      const rk = parked ? at : 1000 + (passing + 1) * 64 + dirNext;
      if (rk !== routeKey) {
        routeKey = rk; mapKey = -1;
        routeDisp.draw(parked ? `●  ${lab(at)}` + (at < N - 1 ? `        ▸  ${lab(at + 1)}` : '')
          : (passing >= 0 ? `›  ${lab(passing)}        ` : '') + `▸  ${lab(dirNext)}`);
      }
    }

    rideState.s = sNow; rideState.moving = sim.v !== 0; rideState.atStop = parked ? at : -1; rideState.doorU = sim.doorU; rideState.v = sim.v;
    ui.onRideState(rideState);
  }

  // ------------------------------------------------ loop
  let running = true, last = performance.now(), liveT = sim.t, fps = 0, dbgT = 0;
  let readySent = false;
  // Parked and nothing changing (no input for 1.2 s, car stopped, doors settled, look spring at rest): render at
  // ~60 fps instead of every refresh (164 Hz on a fast monitor). What still moves then (the slow idle sway,
  // hologram scanlines, video) looks the same at 60 fps; any input or departure restores the full rate.
  const IDLE_MS = 13.5;
  let lastInputT = performance.now(), lastRenderT = -1e9;
  const poke = () => { lastInputT = performance.now(); };
  for (const ev of ['pointermove', 'pointerdown', 'wheel', 'keydown', 'scroll', 'touchstart', 'resize']) addEventListener(ev, poke, psig);
  const idleNow = (now) => !frozen && now - lastInputT > 1200 && sim.v === 0 && (sim.doorU === 0 || sim.doorU === 1) &&
    Math.abs(targetD() - sim.D) < 0.01 && Math.abs(lookState.vy) + Math.abs(lookState.vp) < 0.02 &&
    Math.abs(lookState.ty - lookState.yaw) + Math.abs(lookState.tp - lookState.pitch) < 0.02;

  // Frame-time guard: adaptive quality, then the text version. Only frames rendered back to back count (not the one
  // after an idle-throttle skip, a hidden tab, a pause, a resize or a quality step), from 2 s after the first frame.
  // Per second of counted time: at DPR 2, below the display's pace (< 85 % of its refresh rate, and never < 50 fps)
  // twice in a row -> DPR 1.5; then < 27 fps (q0-1) / < 20 fps (q2)
  // three times in a row, or once < 12 fps -> the next quality step; at the lowest step, < 20 fps four times in a
  // row, or 3 frames > 250 ms within 5 s -> onFail('slow') (main.js fades to the text version). ?force3d=1 and a
  // frozen ?t= never fail; 30 fps-capped devices (iOS Low Power Mode) never degrade.
  // A drop from DPR 2 is not for good: after 10 counted seconds in a row at >= 95 % of the pace (DPR 1.5, full
  // quality) the next stop tries DPR 2 again (a short burst of GPU contention from another tab or app must not keep
  // the whole visit at 1.5); after a second drop it waits 30 s, after a third it stays at 1.5.
  // rAF faster than 240 Hz is not paced by a display (a 360 Hz monitor, or vsync off): 144 Hz stands in for it.
  const mon = { t: 0, n: 0, low: 0, bad: 0, good: 0, long: [], from: Infinity, skip: true, failed: false };
  monReset = () => { mon.t = 0; mon.n = 0; mon.low = 0; mon.bad = 0; mon.good = 0; mon.long.length = 0; mon.skip = true; };
  const hiDprOk = hiDpr;
  let hiRetry = { left: 2, need: 10 };
  function stepDown() { monReset(); degrade(); }
  // display refresh: rAF timestamps are vsync-aligned, so the short end of the tick intervals (skipped ticks included)
  // is one refresh even while frames take two
  const ticks = new Float32Array(120); let tickN = 0, lastTick = 0;
  const refreshHz = () => {
    if (tickN < 30) return 60;
    const a = Array.from(ticks.subarray(0, Math.min(tickN, 120))).sort((x, y) => x - y);
    return 1000 / a[Math.floor(a.length * 0.1)];
  };
  function guard(dt, now) {
    if (frozen || mon.failed || document.visibilityState !== 'visible') return;
    const lowest = quality >= 3 && !hiDpr;
    if (lowest && !force && dt > 0.25) {
      mon.long.push(now);
      while (now - mon.long[0] > 5000) mon.long.shift();
      if (mon.long.length >= 3) { mon.failed = true; onFail?.('slow'); return; }
    }
    mon.t += dt; mon.n++;
    if (mon.t < 1) return;
    fps = mon.n / mon.t; mon.t = 0; mon.n = 0;
    const hz = refreshHz(), pace = hz > 240 ? 144 : hz;
    if (hiDpr) {
      mon.low = fps < Math.max(50, 0.85 * pace) ? mon.low + 1 : 0;
      if (mon.low >= 2 || fps < 12) { hiDpr = false; stepDown(); }
    } else if (quality < 3) {
      mon.low = fps < (quality < 2 ? 27 : 20) ? mon.low + 1 : 0;
      if (mon.low >= 3 || fps < 12) { quality++; stepDown(); }
      else if (hiDprOk && quality === 0 && hiRetry.left > 0) mon.good = fps >= 0.95 * pace ? mon.good + 1 : 0;
    } else if (!force) {
      mon.bad = fps < 20 ? mon.bad + 1 : 0;
      if (mon.bad >= 4) { mon.failed = true; onFail?.('slow'); }
    }
  }

  function frame(now) {
    if (lastTick) { const d = now - lastTick; if (d > 2 && d < 50) ticks[tickN++ % 120] = d; }
    lastTick = now;
    if (readySent && now - lastRenderT < IDLE_MS && idleNow(now)) { mon.skip = true; return; }   // skip this refresh (dt accumulates)
    lastRenderT = now;
    const rawDt = Math.max(0, (now - last) / 1000); last = now;
    const dt = Math.min(0.1, rawDt);
    if (frozen) {
      apply(frozenT, 1 / 60);
    } else {
      let rem = dt; while (rem > 1e-6) { const h = Math.min(1 / 60, rem); step(h); rem -= h; }
      liveT = sim.t;
      apply(liveT, dt);
    }
    renderer.info.reset();
    composer.render(dt);
    if (!readySent) { readySent = true; mon.from = now + 2000; requestAnimationFrame(() => { if (!disposed) { onReady?.(); paintLater(); } }); }
    if (mon.skip) mon.skip = false; else if (now >= mon.from) guard(rawDt, now);
    // back to DPR 2 (see the guard), while parked: the render targets are reallocated in this frame
    if (mon.good >= hiRetry.need && sim.v === 0) { hiDpr = true; hiRetry = { left: hiRetry.left - 1, need: 30 }; stepDown(); }
    if (debug && now - dbgT > 500) { dbgT = now; ui.setDebug(debugText()); }
  }
  function degrade() {
    bloom.enabled = quality < 1;
    hemi.intensity = quality < 1 ? 0.45 : 0.58;     // make up a little of the missing LED glow
    resize();                                        // dpr steps down in resize() (absolute targets per step)
  }
  if (P.has('q')) { quality = clamp(num('q', 0), 0, 3); degrade(); }
  function debugText() {
    const i = renderer.info;
    const res = performance.getEntriesByType('resource');
    const sel = (re) => res.filter((r) => re.test(r.name));
    const size = (r) => r.transferSize || r.encodedBodySize || 0;
    const sum = (arr) => arr.reduce((a, r) => a + size(r), 0);
    const kb = (b) => (b / 1024).toFixed(0) + ' KB';
    const first3D = sel(/assets\/(car\.glb|layers\/)/);
    const media = sel(/assets\/(papers|projects)\//);
    const three = sel(/three@/);
    const lines = [
      `fps ${frozen ? '(frozen t)' : fps.toFixed(0)} · dpr ${renderer.getPixelRatio().toFixed(2)}${hiDpr ? ' (hi)' : ''} · q${quality}${quality >= 1 ? ' (bloom off)' : ''}`,
      `scene draw calls ${sceneStats.calls} · tris ${(sceneStats.tris / 1000).toFixed(1)}k`,
      `frame total calls ${i.render.calls} (incl. post) · tex ${i.memory.textures} · geo ${i.memory.geometries}`,
      `D ${sim.D.toFixed(1)} m · v ${sim.v.toFixed(1)} m/s · door ${sim.doorU.toFixed(2)}`,
      `— transfer (budget) —`,
      `3D first load ${kb(sum(first3D))} / 3072 KB ${sum(first3D) <= 3 * 1024 * 1024 ? 'OK' : 'OVER'}`,
      ...first3D.map((r) => `  ${r.name.split('/').slice(-1)[0]} ${kb(size(r))}`),
      `media (lazy) ${kb(sum(media))} / 8192 KB ${sum(media) <= 8 * 1024 * 1024 ? 'OK' : 'OVER'}`,
      ...media.map((r) => `  ${r.name.split('/').slice(-1)[0]} ${kb(size(r))}`),
      `three.js ${kb(sum(three))} (${three.length} files)`,
    ];
    return lines.join('\n');
  }
  renderer.setAnimationLoop(frame);
  document.addEventListener('visibilitychange', () => {
    monReset(); lastTick = 0;
    if (document.hidden) renderer.setAnimationLoop(null); else if (running) { last = performance.now(); renderer.setAnimationLoop(frame); }
  }, sig);

  /** stop for good and give the GPU memory back: loop, listeners, videos, textures (+ their ImageBitmaps), buffers,
   *  render targets, then the context itself */
  function dispose() {
    if (disposed) return;
    disposed = true; running = false;
    renderer.setAnimationLoop(null);
    ac.abort();
    stage.style.cursor = '';
    for (const H of holos.values()) H.dispose();
    document.getElementById('holo-media')?.remove();
    mixer.stopAllAction();
    const seen = new Set();
    const free = (t) => {
      if (!t || !t.isTexture || seen.has(t)) return;
      seen.add(t);
      const img = t.image;
      t.dispose();
      if (img && typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) img.close();
    };
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.isInstancedMesh) o.dispose();
      for (const m of o.material ? [].concat(o.material) : []) {
        for (const v of Object.values(m)) free(v);
        if (m.uniforms) for (const u of Object.values(m.uniforms)) free(u && u.value);
        m.dispose();
      }
    });
    for (const m of routeDisp.mats) m.dispose();
    for (const t of board.textures) free(t);
    free(scene.environment); free(pillarTex); free(white1);
    try { composer.dispose(); bloom.dispose(); composerRT.dispose(); } catch (e) { /* older addons */ }
    renderer.dispose();
    if (!gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  return {
    pause() { running = false; renderer.setAnimationLoop(null); for (const H of holos.values()) H.setActive(false); },
    resume() { if (running || disposed) return; running = true; monReset(); last = performance.now(); resize(); renderer.setAnimationLoop(frame); },
    dispose,
    get state() { return { ...sim }; },
    get debugScene() { return debug ? scene : null; },
    get holoRect() {
      if (!debug) return null;
      const H = holos.get(Math.round(sim.D / SPACING)); if (!H || !H.group.visible) return null;
      const f = H.pickables[0]; f.updateMatrixWorld(true); camera.updateMatrixWorld(true);
      const pos = f.geometry.attributes.position, xs = [], ys = [];
      for (let i = 0; i < pos.count; i++) {
        probeV.fromBufferAttribute(pos, i).applyMatrix4(f.matrixWorld).project(camera);
        xs.push((probeV.x + 1) / 2 * innerWidth); ys.push((1 - probeV.y) / 2 * innerHeight);
      }
      const r = (v) => Math.round(v);
      return { left: r(Math.min(...xs)), right: r(Math.max(...xs)), top: r(Math.min(...ys)), bottom: r(Math.max(...ys)), scale: +H.group.scale.x.toFixed(3) };
    },
  };

  // ================================================================ helpers (closures)
  function makeDisplay(spec, kind) {
    const c = document.createElement('canvas'); c.width = spec.px[0]; c.height = spec.px[1];
    const ctx = c.getContext('2d');
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = Math.min(8, maxAniso);
    const off = { toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };
    const textMat = new THREE.MeshBasicMaterial({ map: tex, ...off });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(spec.size[0], spec.size[1]), textMat);
    mesh.position.set(...spec.pos);
    // route diagram (desktop): the canvas holds the static part, the shader adds the progress bar + the car marker
    const MX0 = 110, MX1 = c.width - 110, MY = c.height / 2;
    const mapU = kind === 'route' ? {
      map: { value: tex }, size: { value: new THREE.Vector2(c.width, c.height) }, x0: { value: MX0 }, x1: { value: MX1 }, y: { value: MY },
      n: { value: 2 }, onK: { value: -1 }, fillX: { value: MX0 }, carOn: { value: 0 },
      amber: { value: new THREE.Color('#ffb347') }, carCol: { value: new THREE.Color('#f4fbff') },
    } : null;
    const mapMat = mapU ? new THREE.ShaderMaterial({ uniforms: mapU, vertexShader: LAYER_VS, fragmentShader: ROUTE_FS, ...off }) : null;
    function draw(text) {
      mesh.material = textMat;
      const w = c.width, h = c.height;
      ctx.fillStyle = '#07090b'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ffb347';
      ctx.textBaseline = 'middle';
      // shrink a long label (e.g. "Selected Awards and Honors") to fit instead of cutting it
      const fit = (px, avail) => { let fs = px; ctx.font = `600 ${fs}px ${FONT_SIGN}`; while (fs > 12 && ctx.measureText(text).width > avail) { fs -= 2; ctx.font = `600 ${fs}px ${FONT_SIGN}`; } };
      if (kind === 'route') {
        fit(31, w - 120);
        ctx.textAlign = 'center';
        ctx.fillText(text, w / 2, h / 2 + 1);
        ctx.fillStyle = '#ff5ab0'; ctx.beginPath(); ctx.arc(40, h / 2, 6, 0, 7); ctx.arc(w - 40, h / 2, 6, 0, 7); ctx.fill();
      } else {
        fit(58, w - 60);
        ctx.textAlign = 'left';
        ctx.fillText(text, 30, h / 2 + 3);
      }
      tex.needsUpdate = true;
    }
    const mapX = (n, k) => MX0 + ((MX1 - MX0) * k) / Math.max(1, n - 1);
    /** the static part of the text-free route diagram (n stops, car at stop progress s, `at` = stop it stands at or
     *  -1): line + stop dots (passed ones dimmed amber). Progress bar and car marker: setMapCar (shader uniforms). */
    function drawMap(n, s, at) {
      mesh.material = mapMat;
      const w = c.width, h = c.height, y = MY;
      ctx.fillStyle = '#07090b'; ctx.fillRect(0, 0, w, h);
      const g = ctx.createLinearGradient(MX0, 0, MX1, 0);
      g.addColorStop(0, '#ffb347'); g.addColorStop(0.3, '#ff5ab0'); g.addColorStop(0.7, '#6fe4ff'); g.addColorStop(1, '#ffb347');
      ctx.globalAlpha = 0.6; ctx.fillStyle = g; ctx.fillRect(MX0, y - 2, MX1 - MX0, 4); ctx.globalAlpha = 1;
      for (let k = 0; k < n; k++) {
        const on = k === at;
        ctx.beginPath(); ctx.arc(mapX(n, k), y, on ? 10 : 7, 0, 7);
        ctx.fillStyle = on ? '#ffb347' : k < s ? '#8a5a22' : '#0b0c14'; ctx.fill();
        ctx.lineWidth = 3; ctx.strokeStyle = on ? '#ffd9a0' : '#9aa3b5'; ctx.stroke();
      }
      ctx.fillStyle = '#ff5ab0'; ctx.beginPath(); ctx.arc(40, y, 6, 0, 7); ctx.arc(w - 40, y, 6, 0, 7); ctx.fill();
      tex.needsUpdate = true;
      mapU.n.value = n; mapU.onK.value = at;
    }
    function setMapCar(n, s, at) { mapU.fillX.value = mapX(n, s); mapU.carOn.value = at < 0 ? 1 : 0; }
    return { mesh, draw, drawMap, setMapCar, mats: [textMat, mapMat].filter(Boolean), tex };
  }
}

// ================================================================= shaders
const LAYER_VS = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const LAYER_FS = /* glsl */`
uniform sampler2D map; uniform float offset; uniform float blur; uniform float gain;
varying vec2 vUv;
void main() {
  vec2 uv = vec2(vUv.x + offset, vUv.y);
  vec4 s = texture2D(map, uv);
  vec3 acc = s.rgb * s.a; float a = s.a;
  if (blur > 1e-6) {
    for (int i = 1; i <= 3; i++) {
      float o = blur * float(i) / 3.0;
      vec4 p = texture2D(map, uv + vec2(o, 0.0)); vec4 q = texture2D(map, uv - vec2(o, 0.0));
      acc += p.rgb * p.a + q.rgb * q.a; a += p.a + q.a;
    }
    acc /= 7.0; a /= 7.0;
  }
  vec3 col = a > 1e-4 ? acc / a : vec3(0.0);
  gl_FragColor = vec4(col * gain, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Route diagram (desktop in-car display): the canvas (map) holds the line and the stop dots; this adds what moves —
// the amber progress bar from the first stop to the car (under the dots, as the canvas used to draw it) and the car
// marker (a white 16 x 8 px ellipse) — in canvas pixels, anti-aliased with the pixel footprint.
const ROUTE_FS = /* glsl */`
uniform sampler2D map; uniform vec2 size; uniform float x0; uniform float x1; uniform float y; uniform float n;
uniform float onK; uniform float fillX; uniform float carOn; uniform vec3 amber; uniform vec3 carCol;
varying vec2 vUv;
void main() {
  vec2 p = vec2(vUv.x * size.x, (1.0 - vUv.y) * size.y);
  vec2 fw = max(fwidth(p), vec2(1e-3));
  vec3 col = texture2D(map, vUv).rgb;
  float bar = clamp(min(p.x - x0, fillX - p.x) / fw.x + 0.5, 0.0, 1.0) * clamp((2.0 - abs(p.y - y)) / fw.y + 0.5, 0.0, 1.0);
  float sp = (x1 - x0) / max(1.0, n - 1.0);
  float k = clamp(floor((p.x - x0) / sp + 0.5), 0.0, n - 1.0);
  float r = (abs(k - onK) < 0.5 ? 10.0 : 7.0) + 1.5;
  float dotm = clamp((r - length(p - vec2(x0 + k * sp, y))) / max(fw.x, fw.y) + 0.5, 0.0, 1.0);
  col = mix(col, amber, bar * (1.0 - dotm));
  vec2 e = (p - vec2(fillX, y)) / vec2(16.0, 8.0);
  float car = carOn * clamp((1.0 - length(e)) / max(length(fw / vec2(16.0, 8.0)), 1e-3) + 0.5, 0.0, 1.0);
  col = mix(col, carCol, car);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const HOLO_VS = LAYER_VS;
const HOLO_FS = /* glsl */`
uniform sampler2D map; uniform float time; uniform float appear; uniform float gain; uniform float isMedia;
varying vec2 vUv;
float hash(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  vec2 uv = vUv;
  float band = floor(uv.y * 46.0);
  float tick = floor(time * 8.0);
  float g = step(0.972, hash(band * 1.31 + tick * 7.7));
  uv.x += g * 0.014 * (hash(band + tick) - 0.5);
  vec4 c = texture2D(map, uv);
  float scan = 0.9 + 0.1 * sin(vUv.y * 520.0 - time * 4.0);
  float flick = 0.95 + 0.05 * sin(time * 29.0 + 2.0 * sin(time * 6.1));
  float edge = appear * 1.12 - vUv.y;
  float reveal = smoothstep(0.0, 0.06, edge);
  float wipe = (1.0 - smoothstep(0.0, 0.02, abs(edge - 0.01))) * (1.0 - step(0.999, appear));
  vec3 col = c.rgb * gain * scan * flick;
  if (isMedia > 0.5) col = mix(col, col * vec3(0.78, 1.0, 1.12), 0.4) * 0.86;
  col += vec3(0.45, 0.95, 1.0) * wipe * 1.6;
  float a = clamp(c.a * reveal * appear + wipe * 0.7 * appear, 0.0, 1.0);
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ================================================================= environment
function nightEnv(renderer) {
  const s = new THREE.Scene();
  s.background = new THREE.Color(0x04050a);
  const room = new THREE.Mesh(new THREE.BoxGeometry(12, 2.9, 2.7), new THREE.MeshBasicMaterial({ color: 0x0c0d11, side: THREE.BackSide }));
  room.position.y = 1.45 - 1.65; s.add(room);
  const warm = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffe6cc).multiplyScalar(3) });
  for (const z of [-0.94, 0.94]) { const m = new THREE.Mesh(new THREE.BoxGeometry(11.6, 0.03, 0.08), warm); m.position.set(0, 2.76 - 1.65, z); s.add(m); }
  const neon = [0x19d6ff, 0xff2e9a, 0x7a5cff, 0xffa24a];
  for (let i = 0; i < 10; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.6 + (i % 3) * 0.4, 0.15 + (i % 2) * 0.3),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(neon[i % 4]).multiplyScalar(0.5), side: THREE.DoubleSide }));
    const zs = i % 2 ? 1 : -1; m.position.set(-5 + i * 1.1, 1.8 - 1.65 + ((i * 7) % 5) * 0.12, zs * 1.34); m.rotation.y = zs > 0 ? Math.PI : 0; s.add(m);
  }
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(s, 0.035).texture; pm.dispose();
  return tex;
}

// ================================================================= cheap motion blur for the near guideway objects
/** A box of width w moving sm metres during the exposure smears into a trapezoid: linear ramps of min(w, sm) at both
 *  ends of the stretched width w + sm, peak opacity min(w, sm) / sm (<= 1). Needs a map (UVs, u along x on the
 *  car-facing face). The instance matrices stretch x by (w + sm) / w. Energy is conserved, so a bright strip turns
 *  into a faint wide streak and a pillar keeps a solid core with soft leading / trailing edges. */
function motionSmear(mat) {
  const ramp = { value: 0 }, peak = { value: 1 };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uRamp = ramp; sh.uniforms.uPeak = peak;
    sh.fragmentShader = 'uniform float uRamp;\nuniform float uPeak;\n' + sh.fragmentShader.replace('#include <map_fragment>',
      '#include <map_fragment>\n\tif ( uRamp > 1e-4 ) diffuseColor.a *= uPeak * clamp( vMapUv.x / uRamp, 0.0, 1.0 ) * clamp( ( 1.0 - vMapUv.x ) / uRamp, 0.0, 1.0 );');
  };
  mat.customProgramCacheKey = () => 'smear';
  return {
    set(w, sm, gain = 1) {
      if (sm < 1e-3) { ramp.value = 0; peak.value = 1; return; }
      const m = Math.min(w, sm);
      ramp.value = m / (w + sm); peak.value = (m / sm) * gain;
    },
  };
}

// ================================================================= seat fabric
const FABRIC_GLSL = /* glsl */`
varying vec3 vCarPos;
varying vec3 vCarNrm;
float fabHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float fabNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(fabHash(i), fabHash(i + vec2(1.0, 0.0)), u.x), mix(fabHash(i + vec2(0.0, 1.0)), fabHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
// one projection plane, p in metres -> (albedo offset -1..1, roughness 0..1)
vec2 fabPlane(vec2 p) {
  // plain weave, ~3.6 mm thread pitch; fades out before the threads get smaller than ~2 px (no moire)
  vec2 t = p * 280.0;
  vec2 fw = fwidth(t);
  float aa = 1.0 - smoothstep(0.22, 0.55, max(fw.x, fw.y));
  vec2 c = floor(t), f = fract(t) - 0.5;
  float over = mod(c.x + c.y, 2.0);
  float th = mix(1.0 - 2.0 * abs(f.y), 1.0 - 2.0 * abs(f.x), over);
  float weave = (sqrt(max(th, 0.0)) - 0.62) * aa;
  // twill rib on the diagonal (~1 cm) and yarn heather: still visible from a couple of metres
  float rq = (p.x + p.y) * 640.0;
  float rib = sin(rq) * (1.0 - smoothstep(0.5, 1.6, fwidth(rq)));
  float heather = fabNoise(p * vec2(220.0, 70.0)) - 0.5;
  float mottle = fabNoise(p * vec2(26.0, 11.0)) - 0.5;
  float v = 1.1 * weave + 0.45 * rib + 1.2 * heather + 0.9 * mottle;
  return vec2(clamp(v, -1.0, 1.0), clamp(0.55 + 1.2 * weave - 0.5 * heather, 0.0, 1.0));
}
vec3 fabric(vec3 p, vec3 n) {
  vec3 w = pow(abs(n), vec3(4.0)); w /= (w.x + w.y + w.z + 1e-5);
  vec2 a = vec2(0.0);
  if (w.x > 0.01) a += fabPlane(p.zy) * w.x;
  if (w.y > 0.01) a += fabPlane(p.xz) * w.y;
  if (w.z > 0.01) a += fabPlane(p.xy) * w.z;
  float crease = 0.0, pillow = 0.0;
#ifdef FAB_CREASE
  // seat numbers (car-interior.json + mesh): seats every 0.6 m centred at x = 0.3 + 0.6 k, pads 0.52 m wide;
  // cushion top y 0.521, |z| 0.75..1.29; back pad y 0.751..1.205 at |z| 1.20..1.26
  float az = abs(p.z);
  float u = abs(p.x - 0.3 - 0.6 * floor((p.x - 0.3) / 0.6 + 0.5));
  float side = smoothstep(0.17, 0.265, u);
  float onBack = smoothstep(0.45, 0.8, abs(n.z)) * step(1.12, az) * step(0.7, p.y);
  float onSeat = smoothstep(0.45, 0.8, n.y) * step(p.y, 0.62) * step(0.6, az);
  // crease: where the cushion meets the back (lower back pad, rear of the cushion)
  crease = max(onBack * (1.0 - smoothstep(0.755, 0.97, p.y)), onSeat * smoothstep(1.0, 1.25, az));
  // pillowing: the foam rounds off toward the pad edges
  pillow = max(onBack * max(side, smoothstep(1.13, 1.205, p.y)), onSeat * max(side, 1.0 - smoothstep(0.75, 0.84, az)));
#endif
  // x: albedo factor (weave +-6 %, crease / pad edges darker), y: roughness 0.72..0.85, z: crease (for the AO term)
  return vec3((1.0 + 0.06 * a.x) * (1.0 - 0.3 * crease) * (1.0 - 0.18 * pillow), mix(0.72, 0.85, a.y), crease);
}`;

/** woven upholstery on a MeshStandardMaterial; carInv = inverse car matrix (shared uniform, updated per frame) */
function fabric(mat, carInv, crease) {
  mat.roughness = 0.8;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uCarInv = carInv;
    if (crease) sh.defines = { ...(sh.defines || {}), FAB_CREASE: '' };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform mat4 uCarInv;\nvarying vec3 vCarPos;\nvarying vec3 vCarNrm;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tmat4 toCar = uCarInv * modelMatrix;\n\tvCarPos = (toCar * vec4(transformed, 1.0)).xyz;\n\tvCarNrm = mat3(toCar) * objectNormal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FABRIC_GLSL)
      .replace('#include <map_fragment>', '#include <map_fragment>\n\tvec3 fab = fabric(vCarPos, normalize(vCarNrm));\n\tdiffuseColor.rgb *= fab.x;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n\troughnessFactor = fab.y;')
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\n\treflectedLight.indirectDiffuse *= 1.0 - 0.3 * fab.z;');
  };
  mat.customProgramCacheKey = () => 'fabric' + (crease ? '-crease' : '');
  mat.needsUpdate = true;
}

// ================================================================= procedural textures (seeded, deterministic)
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** guideway pillar concrete: vertical streaks, formwork joints, light bevel lines at both edges (multiplies vertex colours) */
function concreteTexture() {
  const W = 128, H = 1024, c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d'), r = rng(7);
  x.fillStyle = 'rgb(196,196,196)'; x.fillRect(0, 0, W, H);
  for (let i = 0; i < 90; i++) {                        // rain streaks / stains running down
    const sx = r() * W, w = 1 + r() * 5, y0 = r() * H * 0.6, len = 80 + r() * 600, g = r() < 0.5 ? 150 + r() * 30 : 205 + r() * 25;
    x.fillStyle = `rgba(${g},${g},${g + 4},${0.18 + r() * 0.3})`; x.fillRect(sx, y0, w, len);
  }
  for (let i = 0; i < 2500; i++) {                      // pores
    const g = 130 + r() * 110; x.fillStyle = `rgba(${g},${g},${g},0.35)`; x.fillRect(r() * W, r() * H, 1 + r() * 2, 1 + r() * 2);
  }
  x.fillStyle = 'rgba(90,90,96,0.8)';                   // formwork joints every ~1.2 m (21 m tall)
  for (let j = 1; j < 18; j++) x.fillRect(0, Math.round((j * H) / 17.5), W, 2);
  x.fillStyle = 'rgb(255,255,255)'; x.fillRect(0, 0, 4, H); x.fillRect(W - 4, 0, 4, H);   // edge bevels catch light
  x.fillStyle = 'rgb(120,120,126)'; x.fillRect(4, 0, 2, H); x.fillRect(W - 6, 0, 2, H);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** platform floor: 58 m x 4.67 m. Canvas top = balustrade side, bottom = car edge (BoxGeometry +y face UVs). */
function platformTextures(maxAniso) {
  const W = 2048, H = 160, pxX = W / 58, pxZ = H / 4.67, r = rng(11);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = 'rgb(122,120,116)'; x.fillRect(0, 0, W, H);                          // warm terrazzo
  for (let i = 0; i < 9000; i++) { const g = 95 + r() * 90; x.fillStyle = `rgba(${g},${g - 2},${g - 6},0.5)`; x.fillRect(r() * W, r() * H, 1 + r() * 1.5, 1 + r() * 1.5); }
  x.fillStyle = 'rgba(70,68,66,0.7)';                                                // 0.6 m tile joints
  for (let m = 0; m <= 58; m += 0.6) x.fillRect(Math.round(m * pxX), 0, 1, H);
  for (let m = 0.6; m < 4.67; m += 0.6) x.fillRect(0, H - Math.round(m * pxZ), W, 1);
  const zRow = (m0, m1) => [H - Math.round(m1 * pxZ), Math.round((m1 - m0) * pxZ)];   // metres from the car edge -> rows
  let [ty, th] = zRow(0.45, 0.78);                                                    // tactile warning strip
  x.fillStyle = 'rgb(176,168,146)'; x.fillRect(0, ty, W, th);
  x.fillStyle = 'rgba(96,90,78,0.9)';
  for (let px = 2; px < W; px += 6) for (let py = ty + 2; py < ty + th - 1; py += 4) x.fillRect(px, py, 2, 2);
  [ty, th] = zRow(4.3, 4.67); x.fillStyle = 'rgb(58,58,62)'; x.fillRect(0, ty, W, th);  // plinth under the balustrade
  const map = new THREE.CanvasTexture(c); map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = Math.min(8, maxAniso);

  const e = document.createElement('canvas'); e.width = 512; e.height = 64;           // light pools every 6 m
  const ex = e.getContext('2d'), sx = 512 / 58, sz = 64 / 4.67;
  ex.fillStyle = 'rgb(22,21,20)'; ex.fillRect(0, 0, 512, 64);
  for (let m = 1; m < 58; m += 6) {
    const cx = m * sx, cy = 64 - 2.3 * sz, g = ex.createRadialGradient(cx, cy, 0, cx, cy, 2.4 * sx);
    g.addColorStop(0, 'rgb(150,142,128)'); g.addColorStop(0.5, 'rgb(70,66,60)'); g.addColorStop(1, 'rgba(22,21,20,0)');
    ex.fillStyle = g; ex.fillRect(cx - 2.5 * sx, 0, 5 * sx, 64);
  }
  const emis = new THREE.CanvasTexture(e); emis.colorSpace = THREE.SRGBColorSpace;
  return { map, emis };
}

/** one station name board showing the nearest stop (stop number + the stop's label as the page writes it). Every
 *  stop's face is drawn once (prepare(), after the fonts) and uploaded with the rest; show(k) only swaps textures. */
function stationBoard(stops, maxAniso) {
  const group = new THREE.Group();
  const BW = 2.6, BH = 0.62, Y0 = 1.3;
  const texs = stops.map(() => {
    const c = document.createElement('canvas'); c.width = 1024; c.height = 244;
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = Math.min(8, maxAniso);
    return t;
  });
  const faceMat = new THREE.MeshBasicMaterial({ map: texs[0], toneMapped: false });
  const face = new THREE.Mesh(new THREE.PlaneGeometry(BW, BH), faceMat);
  face.position.set(0, Y0 + BH / 2, 0.036);
  const dark = new THREE.MeshStandardMaterial({ color: '#15181e', roughness: 0.5, metalness: 0.6, envMapIntensity: 0.4 });
  const frame = new THREE.Mesh(new THREE.BoxGeometry(BW + 0.1, BH + 0.1, 0.06), dark); frame.position.set(0, Y0 + BH / 2, 0);
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, Y0, 0.08), dark); post.position.set(0, Y0 / 2, -0.01);
  group.add(post, frame, face);
  const drawn = new Set();
  function paint(k) {
    if (drawn.has(k)) return false; drawn.add(k);
    const c = texs[k].image, x = c.getContext('2d'), s = stops[k], w = c.width, h = c.height;
    x.fillStyle = '#0b1020'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#6fe4ff'; x.fillRect(0, 0, w, 8);
    x.fillStyle = '#ffb347'; x.fillRect(34, 50, 132, 132);
    x.fillStyle = '#1b1003'; x.font = `600 84px ${FONT_SIGN}`; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(String(k + 1).padStart(2, '0'), 100, 120);
    x.fillStyle = '#f3f7ff'; x.textAlign = 'left';
    let fs = 120; x.font = `600 ${fs}px ${FONT_SIGN}`;
    const label = s.label;
    while (x.measureText(label).width > w - 250 && fs > 48) { fs -= 6; x.font = `600 ${fs}px ${FONT_SIGN}`; }
    x.fillText(label, 200, 122);
    texs[k].needsUpdate = true;
    return true;
  }
  let cur = -1;
  function show(k) {
    if (k === cur) return; cur = k;
    paint(k);                                  // normally painted (and uploaded) long before: see paintLater
    faceMat.map = texs[k];
  }
  // paint(k) -> true when it drew now (then its texture wants an upload); painted(k): drawn already
  return { group, show, paint, painted: (k) => drawn.has(k), textures: texs };
}

// ================================================================= fonts (canvas text needs them loaded)
function loadFonts() {
  if (!document.fonts || !document.fonts.load) return Promise.resolve();
  const wants = [
    document.fonts.load(`600 64px ${FONT_SIGN}`), document.fonts.load(`500 32px ${FONT_MONO}`),
    document.fonts.load(`400 32px ${FONT_BODY}`), document.fonts.load(`500 64px ${FONT_ZH}`, '鲍辰'),
  ];
  return Promise.race([Promise.allSettled(wants), new Promise((r) => setTimeout(r, 3500))]);
}

// ================================================================= holograms
/** word-wrap into lines no wider than maxW; never truncates (the panel grows instead) */
function wrapLines(ctx, text, maxW) {
  const words = text.split(/\s+/).filter(Boolean); const lines = []; let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (ctx.measureText(t).width <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** The hologram's text, laid out top-down. Every string is one the page shows, copied as written (no case change,
 *  no added words): a paper / the project = its venue (the end of its venue line / the whole line), its title
 *  before the colon, the rest of the title;
 *  Intro = the heading, the name (identity panel) and the intro's first sentence; News = the heading and the
 *  first three items; Selected Awards and Honors = the heading and its list. Returns { h, draw(ctx, x, y) }. */
const FONT_BODY_EMOJI = FONT_BODY.replace(/sans-serif$/, '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif');
function holoText(stop, maxW) {
  const m = document.createElement('canvas').getContext('2d');
  const ops = []; let y = 0;
  const GLOW = 'rgba(111,228,255,0.85)';
  const para = (text, font, color, lh, x = 0, w = maxW) => {
    m.font = font;
    for (const ln of wrapLines(m, text, w - x)) { ops.push({ text: ln, font, color, x, y }); y += lh; }
  };
  const big = (text, px, { min = 64, color = '#effcff', lh = 1.08 } = {}) => {   // one line, shrunk to fit
    let fs = px; const f = (s) => `600 ${s}px ${FONT_SIGN}`;
    m.font = f(fs);
    while (m.measureText(text).width > maxW && fs > min) { fs -= 4; m.font = f(fs); }
    ops.push({ text, font: f(fs), color, x: 0, y, glow: GLOW, blur: 20 });
    y += Math.round(fs * lh);
  };
  const kick = (text) => { if (text) para(text, `500 30px ${FONT_MONO}`, '#ffc070', 46); };
  if (stop.kind === 'paper' || stop.kind === 'project') {
    // kicker: a paper's venue as its venue line ends ("..., TMLR 2025" -> "TMLR 2025"); the project's whole line
    const v0 = stop.venues[0] || '';
    kick(stop.kind === 'paper' && v0.includes(', ') ? v0.slice(v0.lastIndexOf(', ') + 2) : v0);
    big(stop.short || stop.fullTitle, 96, { lh: 1.0 });
    y += 8;
    if (stop.rest) para(stop.rest, `400 38px ${FONT_BODY}`, '#bfeeff', 48);
  } else if (stop.kind === 'intro') {
    kick(stop.heading);
    m.font = `600 150px ${FONT_SIGN}`;
    const nw = m.measureText(stop.name).width;
    ops.push({ text: stop.name, font: m.font, color: '#effcff', x: 0, y, glow: GLOW, blur: 22 });
    ops.push({ text: stop.nameZh, font: `500 118px ${FONT_ZH}`, color: '#ffc070', x: nw + 34, y: y + 22, glow: 'rgba(255,179,71,0.8)', blur: 22 });
    y += 172;
    if (stop.lead) para(stop.lead, `400 42px ${FONT_BODY}`, '#bfeeff', 52);
  } else if (stop.kind === 'news') {
    big(stop.heading, 120);
    y += 8;
    for (const it of (stop.items || []).slice(0, 3)) {
      m.font = `500 30px ${FONT_MONO}`;
      ops.push({ text: it.date, font: m.font, color: '#ffc070', x: 0, y: y + 4 });
      para(it.text, `400 36px ${FONT_BODY_EMOJI}`, '#d6f6ff', 44, m.measureText(it.date).width + 18);
      y += 22;
    }
  } else {
    big(stop.heading, 96);
    y += 10;
    for (const it of stop.items || []) { para(it.text, `400 32px ${FONT_BODY}`, '#d6f6ff', 42); y += 4; }
  }
  return {
    h: y,
    draw(ctx, X, Y) {
      ctx.textBaseline = 'top'; ctx.textAlign = 'left';
      for (const o of ops) {
        ctx.font = o.font; ctx.fillStyle = o.color;
        ctx.shadowColor = o.glow || 'transparent'; ctx.shadowBlur = o.glow ? o.blur : 0;
        ctx.fillText(o.text, X + o.x, Y + o.y);
      }
      ctx.shadowBlur = 0;
    },
  };
}

function createHologram(stop, { frozen, reduced, texLoader, maxAniso, renderer, parked }) {
  const group = new THREE.Group();
  const hasMedia = !!stop.media;
  const W = 10.4;                                       // media width (m)
  const mediaA = hasMedia ? stop.mediaW / stop.mediaH : 0;
  const mediaH = hasMedia ? W / mediaA : 0;
  const pad = 0.28;
  const TW = W + 2 * pad;
  const PX = 1024 / TW;                                 // canvas px per metre
  const TXT0 = Math.round(pad * PX) + 8;                // text inset (px)
  const text = holoText(stop, 1024 - 2 * TXT0);
  const titleH = (text.h + 8) / PX;
  const TH = pad + titleH + (hasMedia ? 0.18 + mediaH : 0) + pad;
  const c = document.createElement('canvas'); c.width = 1024; c.height = Math.round(TH * PX);
  const ctx = c.getContext('2d');
  const cw = c.width, ch = c.height;

  // --- frame / backing / title (one canvas) ---
  const r = 26;
  ctx.clearRect(0, 0, cw, ch);
  const grad = ctx.createLinearGradient(0, 0, 0, ch);
  grad.addColorStop(0, 'rgb(10,26,44)'); grad.addColorStop(1, 'rgb(5,13,27)');
  ctx.fillStyle = grad;
  roundRect(ctx, 3, 3, cw - 6, ch - 6, r); ctx.fill();
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(111,228,255,0.55)'; roundRect(ctx, 3, 3, cw - 6, ch - 6, r); ctx.stroke();
  // corner brackets
  ctx.strokeStyle = 'rgba(160,240,255,0.95)'; ctx.lineWidth = 6;
  const B = 46;
  for (const [x, y, sx, sy] of [[10, 10, 1, 1], [cw - 10, 10, -1, 1], [10, ch - 10, 1, -1], [cw - 10, ch - 10, -1, -1]]) {
    ctx.beginPath(); ctx.moveTo(x, y + sy * B); ctx.lineTo(x, y); ctx.lineTo(x + sx * B, y); ctx.stroke();
  }
  // text (only the page's own strings, see holoText)
  text.draw(ctx, TXT0, TXT0);
  const frameTex = new THREE.CanvasTexture(c); frameTex.colorSpace = THREE.SRGBColorSpace; frameTex.anisotropy = Math.min(8, maxAniso);
  const mkMat = (map, isMedia) => new THREE.ShaderMaterial({
    uniforms: { map: { value: map }, time: { value: 0 }, appear: { value: 0 }, gain: { value: 1 }, isMedia: { value: isMedia ? 1 : 0 } },
    vertexShader: HOLO_VS, fragmentShader: HOLO_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true,
  });
  const frameMat = mkMat(frameTex, false);
  const frame = new THREE.Mesh(new THREE.PlaneGeometry(TW, TH), frameMat);
  frame.renderOrder = -50;
  group.add(frame);
  const H = { stop, group, w: TW, h: TH, appear: 0, pickables: [frame], ready: Promise.resolve() };
  frame.userData.holo = H;

  let mediaMesh = null, mediaMat = null, video = null, videoTex = null, videoOn = false, active = false, dead = false;
  const owned = [frameTex];          // textures this hologram created (freed in H.dispose)
  if (hasMedia) {
    const blank = new THREE.DataTexture(new Uint8Array([10, 20, 30, 255]), 1, 1); blank.needsUpdate = true;
    owned.push(blank);
    mediaMat = mkMat(blank, true);
    mediaMesh = new THREE.Mesh(new THREE.PlaneGeometry(W, mediaH), mediaMat);
    mediaMesh.position.set(0, -TH / 2 + pad + mediaH / 2, 0.03);
    mediaMesh.renderOrder = -49;
    mediaMesh.userData.holo = H;
    group.add(mediaMesh); H.pickables.push(mediaMesh);
    const stillUrl = stop.mediaType === 'video' ? (stop.still || stop.poster) : stop.media;
    H.ready = loadTex(stillUrl, texLoader).then((t) => {
      if (dead) { const img = t.image; t.dispose(); if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) img.close(); return; }
      owned.push(t);
      t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = Math.min(8, maxAniso);
      try { renderer.initTexture(t); } catch (e) { /* uploaded on first use */ }   // upload now, not in a frame
      if (!videoOn) mediaMat.uniforms.map.value = t;
    }).catch(() => {});
    if (stop.mediaType === 'video' && !frozen && !reduced) {   // reduced motion: keep the still
      H.startVideo = () => {
        if (video || dead) return;
        video = document.createElement('video');
        Object.assign(video, { muted: true, loop: true, playsInline: true, preload: 'auto' });
        video.setAttribute('muted', ''); video.setAttribute('playsinline', '');
        video.src = stop.media;
        let bin = document.getElementById('holo-media');
        if (!bin) {
          bin = document.createElement('div'); bin.id = 'holo-media'; bin.setAttribute('aria-hidden', 'true');
          bin.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
          document.body.append(bin);
        }
        bin.append(video);
        // allocate + upload the video texture as soon as a frame is decoded (an event task, not a render frame);
        // swap it in once playback runs
        const makeTex = () => {
          if (videoTex || dead) return;
          videoTex = new THREE.VideoTexture(video); videoTex.colorSpace = THREE.SRGBColorSpace;
          owned.push(videoTex);
          videoTex.needsUpdate = true;
          try { renderer.initTexture(videoTex); } catch (e) { /* uploaded on first use */ }
        };
        // ... and that allocation + upload only while parked with the doors open: loadeddata arrives ~0.2 s after
        // the element was created, possibly after the visitor chose the next stop (then it waits for the next park)
        const whenParked = (fn) => { if (dead) return; if (!parked || parked()) fn(); else setTimeout(() => whenParked(fn), 250); };
        const swapIn = () => {
          if (videoOn || dead) return;
          makeTex(); videoOn = true;
          mediaMat.uniforms.map.value = videoTex;
        };
        video.addEventListener('loadeddata', () => whenParked(makeTex), { once: true });
        video.addEventListener('playing', () => { if (videoTex) swapIn(); else whenParked(swapIn); }, { once: true });
      };
    }
  }
  H.update = (t, appear) => {
    H.appear = appear;
    if (reduced) t = 0.5;          // reduced motion: no scanline crawl, flicker or glitch bands (fixed phase)
    frameMat.uniforms.time.value = t; frameMat.uniforms.appear.value = appear;
    if (mediaMat) { mediaMat.uniforms.time.value = t + 0.37; mediaMat.uniforms.appear.value = appear; }
  };
  // Creating a <video> (media player start-up) costs tens of ms of main thread: it is only done while the car is
  // parked with its doors open (prime), never in the middle of a hop. setActive then only plays / pauses.
  H.primed = () => !H.startVideo || !!video;
  H.prime = () => {
    if (!H.startVideo || video || dead) return;
    H.startVideo();
    if (active) video.play().catch(() => {});
  };
  H.setActive = (on) => {
    if (on === active || dead) return; active = on;
    if (!video) return;
    if (on) video.play().catch(() => {}); else video.pause();
  };
  // release the media: stop + unload the video (frees its decoder), free the textures and decoded images
  H.dispose = () => {
    if (dead) return; dead = true;
    if (video) { video.pause(); video.removeAttribute('src'); try { video.load(); } catch (e) { /* detached */ } video.remove(); video = null; }
    for (const t of owned) {
      const img = t.image;
      t.dispose();
      if (img && typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) img.close();
    }
  };
  return H;
}

/** image -> texture, decoded off the main thread (ImageBitmap) so the GPU upload never waits for a synchronous
 *  decode inside a frame. Same pixels as the <img> path (flipped at decode instead of at upload). */
function loadTex(url, texLoader) {
  if (typeof createImageBitmap !== 'function') return texLoader.loadAsync(url);
  return fetch(url)
    .then((r) => { if (!r.ok) throw new Error(url + ' ' + r.status); return r.blob(); })
    .then((b) => createImageBitmap(b, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'default' }))
    .then((bmp) => { const t = new THREE.Texture(bmp); t.flipY = false; t.needsUpdate = true; return t; })
    .catch(() => texLoader.loadAsync(url));
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
