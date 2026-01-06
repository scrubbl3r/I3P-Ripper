// ripp—tdl-curl-advected-smoke (WHITE CANVAS + FLOW FIELD).js
// Preview contract: init(api), update(api, t, dt)
//
// Curl-noise “smoke” on the dome:
// - Each face has a base position on the dome + an advected offset.
// - A 3D curl-noise field defines a velocity at the advected position.
// - Offsets are updated by this velocity (advection), then damped/clamped.
// - A scalar fbm noise is sampled at the advected positions and mapped to ink.
// - STRICTLY t-based timing for advection with dt fallback.

export const meta = {
  name: "Curl Smoke: Advected Noise on Dome (white canvas, black flow)",
  fps: 60,
  duration: 60
};

// ============================================================================
// Controls
// ============================================================================

// Master time scale for advection
const MASTER_SPEED = 23.55;

// Mode 1: broad, slow flow
const MODE1_SCALE    = .20;  // spatial frequency (bigger = tighter curls)
const MODE1_TIME     = 2.45;  // temporal frequency multiplier
const MODE1_STRENGTH = 1.;   // contribution weight

// Mode 2: finer, faster flow
const MODE2_SCALE    = .60;
const MODE2_TIME     = 2.55;
const MODE2_STRENGTH = 5.6;

// Blend between the two modes
// 0 = mode1 only, 1 = mode2 only
const MODE_MIX = 0.85;

// Curl shaping
const FLOW_EXPONENT = .9;  // <1 softens velocity contrast, >1 sharpens
const FLOW_GAIN     = .3;  // multiplies result before clamp

// Visual controls
const INK_STRENGTH  = 1.0;   // 0..1, scales ink darkness
const INVERT        = false; // true = white flow on black dome

// Optional: focus around equator (0 = off)
const EQUATOR_BIAS  = 0.0;   // try 0.25 for "belt" emphasis

// Scalar noise sampling for ink (texture frequency & shape)
const DENSITY_SCALE = .9;   // frequency of the fbm texture
const FBM_OCTAVES   = 2;
const NOISE_BIAS    = 0.12;  // baseline; lower = more filled
const NOISE_GAIN    = 1.6;   // contrast before gamma
const NOISE_GAMMA   = .3;  // >1 = more punchy

// Time behaviour
const MAX_DT_SIM      = 0.08;   // clamp big jumps
const USE_DT_FALLBACK = true;   // if t stalls but dt is valid, use dt
const DT_EPS          = 1e-6;

// Curl finite-difference epsilon (controls “tightness” of curls)
const CURL_EPS = 0.003;  // bigger = coarser curls, smaller = finer (but noisier)

// Offset damping & limit
const OFFSET_DAMPING = 0.55; // higher = quicker “forgetting” of past motion
const OFFSET_LIMIT   = 0.75; // hard limit on offset magnitude in normalized space

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
let domeR  = 250;

let posX = new Float32Array(0);
let posY = new Float32Array(0);
let posZ = new Float32Array(0);

// Per-face advected offsets in *normalized* dome space
let offX = new Float32Array(0);
let offY = new Float32Array(0);
let offZ = new Float32Array(0);

// Stable render objects
let changes = [];

// Time tracking (t-based with dt fallback)
let _prevT = null;

// ============================================================================
// Lifecycle
// ============================================================================
export function init(api){
  IDS = allTDLIds(api);

  // White canvas
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

  offX.fill(0);
  offY.fill(0);
  offZ.fill(0);

  _prevT = null;
}

function allocAll(){
  const N = IDS.length;

  posX = new Float32Array(N);
  posY = new Float32Array(N);
  posZ = new Float32Array(N);

  offX = new Float32Array(N);
  offY = new Float32Array(N);
  offZ = new Float32Array(N);

  changes = new Array(N);
  for (let i = 0; i < N; i++){
    changes[i] = { id: IDS[i], color: [1,1,1,1] };
  }
}

export function update(api, t/*s*/, dt/*s*/){
  // Detect ID changes (hot reload / different model)
  const newIDS = allTDLIds(api);
  if (newIDS.length !== IDS.length){
    IDS = newIDS;
    allocAll();
    cachePositions(api);

    offX.fill(0);
    offY.fill(0);
    offZ.fill(0);
    _prevT = null;
  } else {
    cachePositions(api);
  }

  // Sanitize time inputs
  t  = Number.isFinite(t)  ? t  : 0;
  dt = Number.isFinite(dt) ? dt : 0;
  if (dt < 0) dt = 0;

  // Backward jump => reset offsets and timing
  if (_prevT !== null && t < _prevT - 1e-6){
    offX.fill(0);
    offY.fill(0);
    offZ.fill(0);
    _prevT = t;
    renderToColors(t);
    api.setColors(changes);
    return;
  }

  // --- t-based dtSim with dt fallback ---------------------------------------
  const prevT = _prevT;
  let dtFromT = (prevT === null) ? 0 : (t - prevT);
  let dtSim   = dtFromT;

  if (USE_DT_FALLBACK && dtSim >= 0 && dtSim < DT_EPS){
    let dtUse = dt;
    if (dtUse > 1.0) dtUse *= 0.001; // ms -> s
    if (Number.isFinite(dtUse) && dtUse > DT_EPS){
      dtSim = dtUse;
    } else {
      dtSim = 1 / ((meta && meta.fps) ? meta.fps : 60);
    }
  }

  _prevT = t;

  if (!Number.isFinite(dtSim) || dtSim < 0) dtSim = 0;
  dtSim *= MASTER_SPEED;
  if (dtSim > MAX_DT_SIM) dtSim = MAX_DT_SIM;

  if (dtSim > 0){
    advectOffsets(dtSim, t);
  }

  renderToColors(t);
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
// Advection step: offsets move through curl field
// ============================================================================
function advectOffsets(dtSim, t){
  const N = IDS.length;
  const invR = 1 / Math.max(1e-6, domeR);

  // Base field time; each mode has its own multiplier
  const tBase = t;

  // Damping factor for this frame
  const damp = Math.max(0, 1 - OFFSET_DAMPING * dtSim);

  for (let i = 0; i < N; i++){
    const x = posX[i];
    if (!Number.isFinite(x)) continue;

    const y = posY[i];
    const z = posZ[i];

    // Base normalized dome position
    const nx = (x - center.x) * invR;
    const ny = (y - center.y) * invR;
    const nz = (z - center.z) * invR;

    // Current advected position in normalized space
    let ax = nx + offX[i];
    let ay = ny + offY[i];
    let az = nz + offZ[i];

    // Sample blended curl field at advected position
    const v = sampleCurlBlended(ax, ay, az, tBase); // [vx,vy,vz]

    // Project velocity onto the sphere tangent so flow hugs the dome
    const dotNV = nx * v[0] + ny * v[1] + nz * v[2];
    const tvx = v[0] - dotNV * nx;
    const tvy = v[1] - dotNV * ny;
    const tvz = v[2] - dotNV * nz;

    // Update offsets
    let ox = offX[i] + tvx * dtSim;
    let oy = offY[i] + tvy * dtSim;
    let oz = offZ[i] + tvz * dtSim;

    // Damping
    ox *= damp;
    oy *= damp;
    oz *= damp;

    // Clamp magnitude to avoid runaway drift
    const len = Math.hypot(ox, oy, oz);
    if (len > OFFSET_LIMIT && len > 1e-6){
      const k = OFFSET_LIMIT / len;
      ox *= k;
      oy *= k;
      oz *= k;
    }

    offX[i] = ox;
    offY[i] = oy;
    offZ[i] = oz;
  }
}

// ============================================================================
// Render: sample scalar fbm at advected positions -> ink
// ============================================================================
function renderToColors(t){
  const N = IDS.length;
  const invR = 1 / Math.max(1e-6, domeR);

  const inkStr = clamp01(INK_STRENGTH);

  for (let i = 0; i < N; i++){
    const c = changes[i].color;

    const x = posX[i];
    if (!Number.isFinite(x)){
      c[0]=1; c[1]=1; c[2]=1; c[3]=1;
      continue;
    }

    const y = posY[i];
    const z = posZ[i];

    const nx = (x - center.x) * invR;
    const ny = (y - center.y) * invR;
    const nz = (z - center.z) * invR;

    // Advected sample position
    const sx = nx + offX[i];
    const sy = ny + offY[i];
    const sz = nz + offZ[i];

    // Scalar fbm noise at advected position
    const s = fbm3(
      sx * DENSITY_SCALE,
      sy * DENSITY_SCALE,
      sz * DENSITY_SCALE,
      FBM_OCTAVES
    );

    // Map 0..1 fbm to smoke ink
    let v = (s - NOISE_BIAS) * NOISE_GAIN;
    v = clamp01(v);
    v = Math.pow(v, NOISE_GAMMA);

    // Optional equator emphasis
    if (EQUATOR_BIAS > 0){
      const eq = 1.0 - Math.abs(ny); // ~1 at equator, ~0 at poles
      const bias = lerp(1.0, eq, clamp01(EQUATOR_BIAS));
      v *= bias;
    }

    const ink = clamp01(v * inkStr);
    const g = INVERT ? ink : (1 - ink);

    c[0]=g; c[1]=g; c[2]=g; c[3]=1;
  }
}

// ============================================================================
// Curl field: blended modes with per-mode time/scale/strength
// ============================================================================
function sampleCurlBlended(x, y, z, tBase){
  const mix = clamp01(MODE_MIX);

  // Mode 1
  const v1 = curlNoise3(
    x * MODE1_SCALE,
    y * MODE1_SCALE,
    z * MODE1_SCALE,
    tBase * MODE1_TIME
  );
  v1[0] *= MODE1_STRENGTH;
  v1[1] *= MODE1_STRENGTH;
  v1[2] *= MODE1_STRENGTH;

  // Mode 2
  const v2 = curlNoise3(
    x * MODE2_SCALE,
    y * MODE2_SCALE,
    z * MODE2_SCALE,
    tBase * MODE2_TIME
  );
  v2[0] *= MODE2_STRENGTH;
  v2[1] *= MODE2_STRENGTH;
  v2[2] *= MODE2_STRENGTH;

  // Blend between the two
  let vx = lerp(v1[0], v2[0], mix);
  let vy = lerp(v1[1], v2[1], mix);
  let vz = lerp(v1[2], v2[2], mix);

  // Shape flow magnitude using exponent/gain
  const mag = Math.hypot(vx, vy, vz);
  if (mag > 1e-6){
    const shaped = Math.pow(mag, FLOW_EXPONENT) * FLOW_GAIN;
    const k = shaped / mag;
    vx *= k;
    vy *= k;
    vz *= k;
  }

  return [vx, vy, vz];
}

// ============================================================================
// Curl noise from a 3D vector fbm field
// ============================================================================
function curlNoise3(x, y, z, t){
  const e = CURL_EPS;

  // Offsets for 3 independent fbm channels
  const o1x = 13.27, o1y = -7.41, o1z =  5.19;
  const o2x = -3.11, o2y = 17.73, o2z = -9.37;
  const o3x =  8.03, o3y =  2.91, o3z = 21.17;

  function field(px, py, pz){
    const fx = fbm3(px + o1x + t*0.51, py + o1y,        pz + o1z,        FBM_OCTAVES);
    const fy = fbm3(px + o2x,        py + o2y + t*0.63, pz + o2z,        FBM_OCTAVES);
    const fz = fbm3(px + o3x,        py + o3y,          pz + o3z + t*0.79, FBM_OCTAVES);
    return [fx, fy, fz];
  }

  // Samples for finite differences
  const f_y1 = field(x, y + e, z);
  const f_y0 = field(x, y - e, z);
  const f_z1 = field(x, y, z + e);
  const f_z0 = field(x, y, z - e);
  const f_x1 = field(x + e, y, z);
  const f_x0 = field(x - e, y, z);

  const inv2e = 1.0 / (2.0 * e);

  // dFz/dy - dFy/dz
  const dFz_dy = (f_y1[2] - f_y0[2]) * inv2e;
  const dFy_dz = (f_z1[1] - f_z0[1]) * inv2e;
  const curlX = dFz_dy - dFy_dz;

  // dFx/dz - dFz/dx
  const dFx_dz = (f_z1[0] - f_z0[0]) * inv2e;
  const dFz_dx = (f_x1[2] - f_x0[2]) * inv2e;
  const curlY = dFx_dz - dFz_dx;

  // dFy/dx - dFx/dy
  const dFy_dx = (f_x1[1] - f_x0[1]) * inv2e;
  const dFx_dy = (f_y1[0] - f_y0[0]) * inv2e;
  const curlZ = dFy_dx - dFx_dy;

  return [curlX, curlY, curlZ];
}

// ============================================================================
// Noise / fbm
// ============================================================================
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

// 3D value noise (hash lattice + trilinear interpolation)
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
const TAU = Math.PI * 2;

function lerp(a, b, t){ return a + (b - a) * t; }
function clamp01(x){ return x < 0 ? 0 : (x > 1 ? 1 : x); }
function smooth(t){ return t * t * (3 - 2 * t); }
