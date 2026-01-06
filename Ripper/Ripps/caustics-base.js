// ripp—tdl-caustics-procedural-worldspace (WHITE CANVAS + SPEED/SIZE/THICKNESS).js
// Preview contract: init(api), update(api, t, dt)

export const meta = {
  name: "Caustics (procedural, world-space): Endless sweep (white canvas)",
  fps: 60,
  duration: 60
};

// ============================================================================
// Controls
// ============================================================================
// Animation speed (higher = faster flow)
const CAUSTIC_SPEED = .75;

// Size control (bigger = larger features; smaller = tighter pattern)
// Think of this as "feature size in dome-normalized space"
const CAUSTIC_SIZE = 14.00; // try 0.6 (tighter), 1.8 (bigger)

// Thickness control (0..1): higher = thinner/brighter filaments
const CAUSTIC_THICKNESS = .01;

// Visibility
const CAUSTIC_STRENGTH = 0.75; // darkening amount on white (0..1)
const WARP_AMOUNT = .5;      // 0..2
const WARP_SCALE  = 1.7;      // relative warp frequency

// Drift direction across the dome
const DRIFT_DIR = norm3([0.0, -0.50, 0.0]);

// ============================================================================
// Helpers for your schema
// ============================================================================
function allTDLIds(api){
  const T = Array.isArray(api?.ids?.T) ? api.ids.T : [];
  const D = Array.isArray(api?.ids?.D) ? api.ids.D : [];
  const L = Array.isArray(api?.ids?.L) ? api.ids.L : [];
  return [...new Set([...T, ...D, ...L])];
}

// ============================================================================
// State
// ============================================================================
let IDS = [];
let IDS_SET = new Set();

let center = { x:0, y:0, z:0 };
let domeR = 250;

let posX = new Float32Array(0);
let posY = new Float32Array(0);
let posZ = new Float32Array(0);

// NEW: local time origin so motion starts at 0 even if `t` begins nonzero
let _t0 = null;
let _prevT = null;

// ============================================================================
// Lifecycle
// ============================================================================
export function init(api){
  IDS = allTDLIds(api);
  IDS_SET = new Set(IDS);

  // white canvas
  api.resetColorsTo([1,1,1,1]);

  if (api?.info && Number.isFinite(api.info.radius)) domeR = api.info.radius;
  if (api?.info && api.info.center){
    center = {
      x: api.info.center.x || 0,
      y: api.info.center.y || 0,
      z: api.info.center.z || 0
    };
  }

  posX = new Float32Array(IDS.length);
  posY = new Float32Array(IDS.length);
  posZ = new Float32Array(IDS.length);

  _t0 = null;
  _prevT = null;
}

export function update(api, t/*s*/, dt/*s*/){
  // sanitize time inputs
  t  = Number.isFinite(t)  ? t  : 0;
  dt = Number.isFinite(dt) ? dt : 0;
  if (dt < 0) dt = 0;

  // establish local time origin on first frame; reset if time jumps backward (scrub/restart)
  if (_t0 === null){
    _t0 = t;
    _prevT = t;
  } else if (_prevT !== null && t < _prevT - 1e-6){
    _t0 = t;
  }
  _prevT = t;

  const localT = Math.max(0, t - _t0);
  const flowT  = localT * CAUSTIC_SPEED;

  // detect ID changes (hot reload / model swap)
  const newIDS = allTDLIds(api);
  if (newIDS.length !== IDS.length){
    IDS = newIDS;
    IDS_SET = new Set(IDS);

    posX = new Float32Array(IDS.length);
    posY = new Float32Array(IDS.length);
    posZ = new Float32Array(IDS.length);
  }

  // cache positions once per frame
  for (let i = 0; i < IDS.length; i++){
    const p = api.posOf(IDS[i]);
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)){
      posX[i] = p.x; posY[i] = p.y; posZ[i] = p.z;
    } else {
      posX[i] = NaN; posY[i] = NaN; posZ[i] = NaN;
    }
  }

  // thickness => sharpness exponent (kept; not currently used downstream)
  const thick = clamp01(CAUSTIC_THICKNESS);
  const sharpness = 2.0 + thick * 11.0; // 2..13 (unused)

  // size => frequency (bigger size => lower frequency)
  const size = Math.max(1e-4, CAUSTIC_SIZE);
  const baseFreq = (2.6 / size);     // main frequency
  const freq2    = baseFreq * 1.85;  // second layer

  // drift in dome-normalized space
  const drift = [
    DRIFT_DIR[0] * flowT * 0.55,
    DRIFT_DIR[1] * flowT * 0.55,
    DRIFT_DIR[2] * flowT * 0.55
  ];

  const invR = 1 / Math.max(1e-6, domeR);

  // paint entire dome each frame (global procedural field)
  const changes = new Array(IDS.length);

  for (let i = 0; i < IDS.length; i++){
    const px = posX[i];
    if (!Number.isFinite(px)){
      // if missing pos, just leave white
      changes[i] = { id: IDS[i], color: [1,1,1,1] };
      continue;
    }

    // normalize to dome space (seamless world-space field)
    const nx = (px - center.x) * invR;
    const ny = (posY[i] - center.y) * invR;
    const nz = (posZ[i] - center.z) * invR;

    // pattern coords + drift
    const p1x = nx * baseFreq + drift[0];
    const p1y = ny * baseFreq + drift[1];
    const p1z = nz * baseFreq + drift[2];

    const w1 = warp3(p1x, p1y, p1z, flowT, WARP_SCALE, WARP_AMOUNT);
    const a = ridgedFbm3(p1x + w1[0], p1y + w1[1], p1z + w1[2], 3);

    // 2nd layer (offset + slightly different time)
    const p2x = nx * freq2 + drift[0] * 1.13 + 17.3;
    const p2y = ny * freq2 + drift[1] * 1.13 -  9.1;
    const p2z = nz * freq2 + drift[2] * 1.13 +  4.7;

    const w2 = warp3(p2x, p2y, p2z, flowT * 1.07, WARP_SCALE * 1.15, WARP_AMOUNT * 0.85);
    const b = ridgedFbm3(p2x + w2[0], p2y + w2[1], p2z + w2[2], 3);

    // Combine layers without crushing (max keeps energy)
    let c = Math.max(a, b); // 0..1

    // Push values into a highlight band (threshold + gain)
    c = clamp01((c - 0.35) * 2.8);

    // Thickness -> exponent (higher thickness => thinner filaments)
    const expo = 1.2 + clamp01(CAUSTIC_THICKNESS) * 7.0; // 1.2..8.2
    c = Math.pow(c, expo);

    // Darken white canvas
    const ink = clamp01(c * (CAUSTIC_STRENGTH * 1.35));
    const g = 1 - ink;

    changes[i] = { id: IDS[i], color: [g, g, g, 1] };
  }

  api.setColors(changes);
}

// ============================================================================
// Procedural core: value noise + fbm + ridged + warp
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
    const n = noise3(x * freq, y * freq, z * freq); // 0..1
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

// 3D value noise: lattice hash + smooth interpolation
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

// ============================================================================
// Utils
// ============================================================================
function lerp(a, b, t){ return a + (b - a) * t; }
function smooth(t){ return t * t * (3 - 2 * t); }
function clamp01(x){ return x < 0 ? 0 : (x > 1 ? 1 : x); }

function norm3(v){
  const x = v[0], y = v[1], z = v[2];
  const m = Math.hypot(x, y, z) || 1;
  return [x/m, y/m, z/m];
}
