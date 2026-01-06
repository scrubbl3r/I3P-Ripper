// ripp—tdl-curl-noise-dualmode (WHITE CANVAS + BLACK FLOW).js
// Preview contract: init(api), update(api, t, dt)
//
// Curl-noise style flow field on the dome.
// - Uses dome-space positions (normalized) as input to 3D noise.
// - Computes curl of a scalar field in 3D to get a "swirly" vector.
// - Two independent modes (scale/speed/strength) cross-faded by MODE_MIX.
// - Renders flow magnitude as black ink on white dome.

export const meta = {
  name: "Curl Noise: Dual-Mode Flow (white dome, black ink)",
  fps: 60,
  duration: 60
};

// ============================================================================
// Controls
// ============================================================================

// Overall animation speed multiplier (affects both modes)
const MASTER_SPEED = 2.07;

// Mode 1: broad, slow flow
const MODE1_SCALE    = .80;   // spatial frequency (bigger = tighter curls)
const MODE1_TIME     = 1.10;  // temporal frequency
const MODE1_STRENGTH = .5;   // contribution weight

// Mode 2: finer, faster flow
const MODE2_SCALE    = .90;
const MODE2_TIME     = .90;
const MODE2_STRENGTH = 1.6;

// Blend between the two modes
// 0 = mode1 only, 1 = mode2 only
const MODE_MIX = .65;

// Curl shaping
const FLOW_EXPONENT = .4;  // >1 sharpens filaments
const FLOW_GAIN     = 1.;  // multiplies result before clamp

// Visual controls
const INK_STRENGTH  = 1.0;  // 0..1, scales ink darkness
const INVERT        = false; // true = white flow on black dome

// Optional: focus around equator (0 = off)
const EQUATOR_BIAS = 0.0; // try 0.25 for "belt" emphasis

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
let center = { x:0, y:0, z:0 };
let domeR = 250;

let posX = new Float32Array(0);
let posY = new Float32Array(0);
let posZ = new Float32Array(0);

let changes = [];

// ============================================================================
// Lifecycle
// ============================================================================
export function init(api){
  IDS = allTDLIds(api);

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

  allocAll();
  cachePositions(api);
}

function allocAll(){
  const N = IDS.length;

  posX = new Float32Array(N);
  posY = new Float32Array(N);
  posZ = new Float32Array(N);

  changes = new Array(N);
  for (let i = 0; i < N; i++){
    changes[i] = { id: IDS[i], color: [1,1,1,1] };
  }
}

export function update(api, t/*s*/, dt/*s*/){
  // detect ID changes (hot reload / model swap)
  const newIDS = allTDLIds(api);
  if (newIDS.length !== IDS.length){
    IDS = newIDS;
    allocAll();
    cachePositions(api);
  } else {
    cachePositions(api);
  }

  t = Number.isFinite(t) ? t : 0;

  const N = IDS.length;
  const invR = 1 / Math.max(1e-6, domeR);
  const mix = clamp01(MODE_MIX);
  const inkStr = clamp01(INK_STRENGTH);

  // Effective times per mode
  const t1 = t * MODE1_TIME * MASTER_SPEED;
  const t2 = t * MODE2_TIME * MASTER_SPEED;

  for (let i = 0; i < N; i++){
    const c = changes[i].color;
    const x = posX[i];

    if (!Number.isFinite(x)){
      c[0]=1; c[1]=1; c[2]=1; c[3]=1;
      continue;
    }

    // dome-normalized coordinates
    const nx = (x - center.x) * invR;
    const ny = (posY[i] - center.y) * invR;
    const nz = (posZ[i] - center.z) * invR;

    // optional equator emphasis
    let equatorWeight = 1.0;
    if (EQUATOR_BIAS > 0){
      const eq = 1.0 - Math.abs(ny); // roughly 1 at equator, 0 at poles
      equatorWeight = lerp(1.0, clamp01(eq), clamp01(EQUATOR_BIAS));
    }

    // Mode 1 curl
    const v1 = curl3(
      nx * MODE1_SCALE,
      ny * MODE1_SCALE,
      nz * MODE1_SCALE,
      t1
    );

    // Mode 2 curl
    const v2 = curl3(
      nx * MODE2_SCALE,
      ny * MODE2_SCALE,
      nz * MODE2_SCALE,
      t2 + 7.31  // small offset to decorrelate
    );

    // Blend modes
    const w1 = MODE1_STRENGTH * (1.0 - mix);
    const w2 = MODE2_STRENGTH * mix;

    const vx = v1[0] * w1 + v2[0] * w2;
    const vy = v1[1] * w1 + v2[1] * w2;
    const vz = v1[2] * w1 + v2[2] * w2;

    // Use magnitude as “ink” source
    let mag = Math.sqrt(vx*vx + vy*vy + vz*vz);

    // Shape it into bright filaments
    mag = Math.pow(mag * FLOW_GAIN, FLOW_EXPONENT);
    mag = clamp01(mag);

    // Apply equator emphasis
    mag *= equatorWeight;

    const ink = clamp01(mag * inkStr);
    const g = INVERT ? ink : (1 - ink);

    c[0]=g; c[1]=g; c[2]=g; c[3]=1;
  }

  api.setColors(changes);
}

// ============================================================================
// Cache positions
// ============================================================================
function cachePositions(api){
  for (let i = 0; i < IDS.length; i++){
    const p = api.posOf(IDS[i]);
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)){
      posX[i] = p.x; posY[i] = p.y; posZ[i] = p.z;
    } else {
      posX[i] = NaN; posY[i] = NaN; posZ[i] = NaN;
    }
  }
}

// ============================================================================
// Curl noise core
// ============================================================================
//
// We build a pseudo 3D noise field and approximate curl by finite differences:
//   curl(F) = (∂Fz/∂y - ∂Fy/∂z,
//              ∂Fx/∂z - ∂Fz/∂x,
//              ∂Fy/∂x - ∂Fx/∂y)
//
// Here F = (N1, N2, N3) where each Ni is a scalar noise with different offsets.
// This is a lightweight, dome-friendly variant (not a full Perlin/Simplex impl).
//

function curl3(x, y, z, t){
  const e = 0.02;

  // Sample three noise “components”
  const F = noiseVec3(x, y, z, t);

  // Partial derivatives via central differences
  const Fy1 = noiseVec3(x, y + e, z, t);
  const Fy0 = noiseVec3(x, y - e, z, t);
  const Fz1 = noiseVec3(x, y, z + e, t);
  const Fz0 = noiseVec3(x, y, z - e, t);
  const Fx1 = noiseVec3(x + e, y, z, t);
  const Fx0 = noiseVec3(x - e, y, z, t);

  const dFz_dy = (Fz1[2] - Fz0[2]) * (0.5 / e);
  const dFy_dz = (Fy1[1] - Fy0[1]) * (0.5 / e);

  const dFx_dz = (Fx1[0] - Fx0[0]) * (0.5 / e);
  const dFz_dx = (Fz1[2] - Fz0[2]) * (0.5 / e);

  const dFy_dx = (Fy1[1] - Fy0[1]) * (0.5 / e);
  const dFx_dy = (Fx1[0] - Fx0[0]) * (0.5 / e);

  const cx = dFz_dy - dFy_dz;
  const cy = dFx_dz - dFz_dx;
  const cz = dFy_dx - dFx_dy;

  return [cx, cy, cz];
}

function noiseVec3(x, y, z, t){
  // Three correlated scalar noises with different offsets
  const n1 = noise4(x + 11.2, y + 5.7,  z - 3.4,  t * 0.9);
  const n2 = noise4(x - 7.9,  y + 2.1,  z + 13.3, t * 1.1);
  const n3 = noise4(x + 4.6,  y - 9.4,  z + 1.7,  t * 1.3);

  return [
    n1 * 2.0 - 1.0,
    n2 * 2.0 - 1.0,
    n3 * 2.0 - 1.0
  ];
}

// Simple 4D hash/noise (not fancy, but stable and cheap enough)
function noise4(x, y, z, w){
  // Integer lattice corner
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), wi = Math.floor(w);
  const xf = x - xi,       yf = y - yi,       zf = z - zi,       wf = w - wi;

  const u = smooth(xf), v = smooth(yf), s = smooth(zf), r = smooth(wf);

  let acc = 0.0;
  for (let dx = 0; dx <= 1; dx++){
    for (let dy = 0; dy <= 1; dy++){
      for (let dz = 0; dz <= 1; dz++){
        for (let dw = 0; dw <= 1; dw++){
          const hx = xi + dx;
          const hy = yi + dy;
          const hz = zi + dz;
          const hw = wi + dw;

          const h = hash4(hx, hy, hz, hw);

          const wx = dx ? u : (1 - u);
          const wy = dy ? v : (1 - v);
          const wz = dz ? s : (1 - s);
          const ww = dw ? r : (1 - r);

          const weight = wx * wy * wz * ww;
          acc += h * weight;
        }
      }
    }
  }

  return acc; // already in 0..1-ish range
}

// ============================================================================
// Utils
// ============================================================================
const TAU = Math.PI * 2;

function lerp(a, b, t){ return a + (b - a) * t; }
function clamp01(x){ return x < 0 ? 0 : (x > 1 ? 1 : x); }

function smooth(t){
  return t * t * (3 - 2 * t);
}

function hash4(x, y, z, w){
  let h = x * 374761393 + y * 668265263 + z * 2147483647 + w * 912931;
  h = (h ^ (h >> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  return (h >>> 0) / 4294967296;
}
