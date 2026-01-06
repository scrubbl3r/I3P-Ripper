// ripp—tdl-caustics-procedural-worldspace (PROJECTION + INKING LAYER, float ink buffer).js
// Preview contract: init(api), update(api, t, dt)
//
// Projection = live caustics (your current look).
// Inking     = persistent accumulation driven by projection intensity.
// Final      = projection * (1 - inkA) so the projection stays readable while ink builds.

export const meta = {
  name: "Caustics (procedural, world-space): Projection + Ink accumulation (float) + bottom-up bloom",
  fps: 60,
  duration: 60
};

// ============================================================================
// PROJECTION (live caustics)
// ============================================================================
const CAUSTIC_SPEED     = 1.0;
const CAUSTIC_SIZE      = 15.00;
const CAUSTIC_THICKNESS = .1;

const CAUSTIC_STRENGTH  = 0.75; // 0..1
const WARP_AMOUNT       = 1.5;  // 0..2
const WARP_SCALE        = .18;

const DRIFT_DIR = norm3([0.0, -0.50, 0.0]);

// ============================================================================
// BLOOM (projection reveal)
// ============================================================================
const BLOOM_ENABLE            = true;
const BLOOM_SECS              = .5;
const BLOOM_START_BELOW_RADII = .85;
const BLOOM_FEATHER           = .45;
const BLOOM_FADE_STRENGTH     = 1;

// ============================================================================
// INKING (persistent accumulation; canonical schema)
// ----------------------------------------------------------------------------
// INK_START_MS:  delay before inking begins
// INK_RAMP_MS:   time to ramp ink write strength up
//
// INK_ALPHA_*:   per-second ink alpha (dt-stable)
// STACK_MODE:    'over' (layering) or 'linear' (additive)
// INK_WRITE_MAX: global cap on write strength (0..1)
// ============================================================================
const INK_ENABLE   = true;

const INK_START_MS = 0;
const INK_RAMP_MS  = 1000;

const INK_ALPHA_BASE = 0.45;

const STACK_MODE     = "linear"; // 'over' or 'linear'
const INK_WRITE_MAX  = 1.0;

// Float ink buffer snap-to-black to avoid “infinite tail”
const INK_SNAP_EPS = 1 / 255;

// ============================================================================
// Helpers
// ============================================================================
function allTDLIds(api){
  const T = Array.isArray(api?.ids?.T) ? api.ids.T : [];
  const D = Array.isArray(api?.ids?.D) ? api.ids.D : [];
  const L = Array.isArray(api?.ids?.L) ? api.ids.L : [];
  return [...new Set([...T, ...D, ...L])];
}

function clamp01(x){ return x < 0 ? 0 : (x > 1 ? 1 : x); }
function lerp(a,b,t){ return a + (b - a) * t; }
function smooth(t){ return t * t * (3 - 2 * t); }
function smoothstep(e0, e1, x){
  if (e1 <= e0) return x >= e1 ? 1 : 0;
  const u = clamp01((x - e0) / (e1 - e0));
  return u * u * (3 - 2 * u);
}
function norm3(v){
  const x = v[0], y = v[1], z = v[2];
  const m = Math.hypot(x, y, z) || 1;
  return [x/m, y/m, z/m];
}

// dt-stable: per-second alpha -> per-frame alpha
function alphaPerFrame(alphaPerSec, dtSec){
  alphaPerSec = clamp01(alphaPerSec);
  dtSec = Math.max(0, dtSec);
  if (alphaPerSec <= 0 || dtSec <= 0) return 0;
  return 1 - Math.pow(1 - alphaPerSec, dtSec);
}

// stack ink density a∈[0..1]
function stackInk(aOld, inkAlpha){
  inkAlpha = clamp01(inkAlpha);
  if (inkAlpha <= 0) return aOld;

  if (STACK_MODE === "linear"){
    return Math.min(1, aOld + inkAlpha);
  }
  return 1 - (1 - aOld) * (1 - inkAlpha);
}

// ink ramp 0..1
function inkRamp01(tMs){
  if (!INK_ENABLE) return 0;
  if (!Number.isFinite(INK_START_MS)) return 0;
  if (tMs < INK_START_MS) return 0;

  const dur = Math.max(0, INK_RAMP_MS);
  if (dur <= 0) return 1;

  return clamp01((tMs - INK_START_MS) / dur);
}

// ============================================================================
// State
// ============================================================================
let IDS = [];

let center = { x:0, y:0, z:0 };
let domeR = 250;

let posX = new Float32Array(0);
let posY = new Float32Array(0);
let posZ = new Float32Array(0);

// Persistent ink density (0..1). 0 = white, 1 = full black.
let inkA = new Float32Array(0);

// Stable render list
let changes = [];

// Local time origin so bloom/flow start at 0 even if host t starts nonzero
let _t0 = null;
let _prevT = null;

// ============================================================================
// Lifecycle
// ============================================================================
export function init(api){
  IDS = allTDLIds(api);
  api.resetColorsTo([1,1,1,1]);

  if (api?.info && Number.isFinite(api.info.radius)) domeR = api.info.radius;
  if (api?.info && api.info.center){
    center = {
      x: api.info.center.x || 0,
      y: api.info.center.y || 0,
      z: api.info.center.z || 0
    };
  }

  allocAll();
  _t0 = null;
  _prevT = null;
}

function allocAll(){
  const N = IDS.length;

  posX = new Float32Array(N);
  posY = new Float32Array(N);
  posZ = new Float32Array(N);

  inkA = new Float32Array(N);
  inkA.fill(0);

  changes = new Array(N);
  for (let i = 0; i < N; i++){
    changes[i] = { id: IDS[i], color: [1,1,1,1] };
  }
}

function clearInk(){
  if (inkA && inkA.length) inkA.fill(0);
}

// ============================================================================
// Update
// ============================================================================
export function update(api, t/*s*/, dt/*s*/){
  t  = Number.isFinite(t)  ? t  : 0;
  dt = Number.isFinite(dt) ? dt : 0;
  if (dt < 0) dt = 0;

  // local timeline + restart detection
  let restarted = false;
  if (_t0 === null){
    _t0 = t;
    _prevT = t;
  } else if (_prevT !== null && t < _prevT - 1e-6){
    _t0 = t;
    restarted = true;
  }
  _prevT = t;

  // detect ID changes (hot reload / model swap)
  const newIDS = allTDLIds(api);
  if (newIDS.length !== IDS.length){
    IDS = newIDS;
    allocAll();
    restarted = true;
  }

  if (restarted){
    clearInk();
    api.resetColorsTo([1,1,1,1]);
  }

  const localT = Math.max(0, t - _t0);
  const flowT  = localT * CAUSTIC_SPEED;
  const bloomT = localT;

  // cache positions
  for (let i = 0; i < IDS.length; i++){
    const p = api.posOf(IDS[i]);
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)){
      posX[i] = p.x; posY[i] = p.y; posZ[i] = p.z;
    } else {
      posX[i] = NaN; posY[i] = NaN; posZ[i] = NaN;
    }
  }

  // size => frequency
  const size = Math.max(1e-4, CAUSTIC_SIZE);
  const baseFreq = (2.6 / size);
  const freq2    = baseFreq * 1.85;

  // drift in dome-normalized space
  const driftX = DRIFT_DIR[0] * flowT * 0.55;
  const driftY = DRIFT_DIR[1] * flowT * 0.55;
  const driftZ = DRIFT_DIR[2] * flowT * 0.55;

  const invR = 1 / Math.max(1e-6, domeR);

  // bloom envelope (projection only)
  let bloomP = 1.0;
  let headH = 999;

  if (BLOOM_ENABLE){
    bloomP = smoothstep(0.0, Math.max(1e-6, BLOOM_SECS), bloomT);

    const feather = Math.max(1e-4, BLOOM_FEATHER);
    const startH = (-1 - Math.max(0, BLOOM_START_BELOW_RADII)) - feather;
    const endH   = ( 1 + feather);

    headH = lerp(startH, endH, bloomP);
  }

  // ink write strength (0..1)
  const tMs = localT * 1000;
  const inkGain = inkRamp01(tMs);

  // per-second alpha (dt-stable), single-rate model
    let alphaSec = 0;
    if (inkGain > 0){
    // ramp controls *when* ink turns on; INK_ALPHA_BASE controls *how fast* it accumulates
    alphaSec = INK_ALPHA_BASE * inkGain;
    alphaSec *= clamp01(INK_WRITE_MAX);
    }
    const alphaFrameBase = alphaPerFrame(alphaSec, dt);


  for (let i = 0; i < IDS.length; i++){
    const c = changes[i].color;

    const px = posX[i];
    if (!Number.isFinite(px)){
      c[0]=1; c[1]=1; c[2]=1; c[3]=1;
      continue;
    }

    // dome-normalized coords
    const nx = (px - center.x) * invR;
    const ny = (posY[i] - center.y) * invR;
    const nz = (posZ[i] - center.z) * invR;

    // pattern coords + drift
    const p1x = nx * baseFreq + driftX;
    const p1y = ny * baseFreq + driftY;
    const p1z = nz * baseFreq + driftZ;

    const w1 = warp3(p1x, p1y, p1z, flowT, WARP_SCALE, WARP_AMOUNT);
    const a = ridgedFbm3(p1x + w1[0], p1y + w1[1], p1z + w1[2], 3);

    const p2x = nx * freq2 + driftX * 1.13 + 17.3;
    const p2y = ny * freq2 + driftY * 1.13 -  9.1;
    const p2z = nz * freq2 + driftZ * 1.13 +  4.7;

    const w2 = warp3(p2x, p2y, p2z, flowT * 1.07, WARP_SCALE * 1.15, WARP_AMOUNT * 0.85);
    const b = ridgedFbm3(p2x + w2[0], p2y + w2[1], p2z + w2[2], 3);

    let v = Math.max(a, b);
    v = clamp01((v - 0.35) * 2.8);

    const expo = 1.2 + clamp01(CAUSTIC_THICKNESS) * 7.0;
    v = Math.pow(v, expo);

    // projection darkness (0..1)
    let projInk = clamp01(v * (CAUSTIC_STRENGTH * 1.35));

    // bloom envelope affects projection only
    if (BLOOM_ENABLE && bloomP < 1.0){
      const feather = Math.max(1e-4, BLOOM_FEATHER);

      let activation = 1.0 - smoothstep(headH - feather, headH + feather, ny);
      if (BLOOM_FADE_STRENGTH) activation *= bloomP;

      projInk *= activation;
    }

    // projection grayscale
    const gProj = 1 - projInk;

    // inking: accumulate where projection is dark
    if (alphaFrameBase > 0 && projInk > 1e-6){
      const aOld = inkA[i];
      if (aOld < 1){
        let aNew = stackInk(aOld, alphaFrameBase * projInk);
        if (aNew > 1 - INK_SNAP_EPS) aNew = 1;
        if (aNew > aOld) inkA[i] = aNew;
      }
    }

    // final = projection * remaining whiteness
    const gInk = 1 - inkA[i];
    const gFinal = gProj * gInk;

    c[0]=gFinal; c[1]=gFinal; c[2]=gFinal; c[3]=1;
  }

  api.setColors(changes);
}

// ============================================================================
// Procedural core
// ============================================================================
function warp3(x, y, z, t, warpScale, warpAmt){
  const s = warpScale;
  const tt = t * 0.35;

  const nx = fbm3(x*s + 31.2, y*s - 12.7, z*s + tt, 3);
  const ny = fbm3(x*s -  7.4, y*s + 18.9, z*s - tt, 3);
  const nz = fbm3(x*s +  2.1, y*s +  3.3, z*s + 9.1 + tt, 3);

  return [
    (nx * 2 - 1) * warpAmt,
    (ny * 2 - 1) * warpAmt,
    (nz * 2 - 1) * warpAmt
  ];
}

function ridgedFbm3(x, y, z, octaves){
  let amp = 0.58;
  let freq = 1.0;
  let sum = 0.0;
  let norm = 0.0;

  for (let i = 0; i < octaves; i++){
    const n = noise3(x * freq, y * freq, z * freq);
    const ridge = 1.0 - Math.abs(n * 2.0 - 1.0);
    const v = ridge * ridge;

    sum += v * amp;
    norm += amp;

    freq *= 2.05;
    amp *= 0.55;
  }

  return norm > 0 ? (sum / norm) : 0;
}

function fbm3(x, y, z, octaves){
  let amp = 0.5;
  let freq = 1.0;
  let sum = 0.0;
  let norm = 0.0;

  for (let i = 0; i < octaves; i++){
    sum += noise3(x * freq, y * freq, z * freq) * amp;
    norm += amp;
    freq *= 2.0;
    amp *= 0.5;
  }

  return norm > 0 ? (sum / norm) : 0;
}

function noise3(x, y, z){
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi,       yf = y - yi,       zf = z - zi;

  const u = smooth(xf), v = smooth(yf), w = smooth(zf);

  const n000 = hash3(xi,   yi,   zi);
  const n100 = hash3(xi+1, yi,   zi);
  const n010 = hash3(xi,   yi+1, zi);
  const n110 = hash3(xi+1, yi+1, zi);

  const n001 = hash3(xi,   yi,   zi+1);
  const n101 = hash3(xi+1, yi,   zi+1);
  const n011 = hash3(xi,   yi+1, zi+1);
  const n111 = hash3(xi+1, yi+1, zi+1);

  const x00 = lerp(n000, n100, u);
  const x10 = lerp(n010, n110, u);
  const x01 = lerp(n001, n101, u);
  const x11 = lerp(n011, n111, u);

  const y0 = lerp(x00, x10, v);
  const y1 = lerp(x01, x11, v);

  return lerp(y0, y1, w);
}

function hash3(x, y, z){
  let h = x * 374761393 + y * 668265263 + z * 2147483647;
  h = (h ^ (h >> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  return (h >>> 0) / 4294967296;
}
