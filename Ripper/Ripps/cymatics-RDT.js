// ripp—tdl-turing-reaction-diffusion-buzzy (WHITE CANVAS + BLACK TURING BUZZ).js
// Preview contract: init(api), update(api, t, dt)
//
// Gray-Scott reaction–diffusion on dome faces (TDL ids) with “endless buzz” forcing.
// Goals:
// - No single orbiting blob.
// - Continuous morphing patterns without manual stirring.
// Strategy:
// (A) t-based dtSim with dt fallback (host-safe).
// (B) Gentle distributed forcing driven by a cymatic-ish standing-wave field on the dome.
// (C) Tiny global FEED/KILL wobble to avoid static attractors.
// (D) Visual shimmer: render a blend of V and |ΔV| so motion stays visible.

export const meta = {
  name: "Turing / Reaction–Diffusion (Gray-Scott): Endless buzz (t-based + standing-wave forcing)",
  fps: 60,
  duration: 60
};

// ============================================================================
// Controls — Simulation
// ============================================================================

const SIM_SPEED  = 4.0;   // overall speed of chemistry
const SUBSTEPS   = 7;     // stability; higher = smoother and less “blow through”

// Neighbor graph (proximity diffusion)
const NEIGHBOR_RADIUS_MULT = 2.0; // smaller = finer detail; larger = smoother blobs
const MAX_NEIGHBORS = 18;

// Gray-Scott base parameters (good “worms/labyrinth” region)
const DIFF_U = 0.16;
const DIFF_V = 0.08;

const FEED_BASE = 0.0340;
const KILL_BASE = 0.0610;

// Tiny global wobble to prevent settling (time-only)
const PARAM_WOBBLE_ENABLE = true;
const FEED_WOBBLE = 0.0022;  // +/- amount
const KILL_WOBBLE = 0.0018;
const WOBBLE_HZ   = 0.055;   // slow (cycles per second)

// Seeding (initial condition)
const SEED_DENSITY  = 0.05;
const SEED_V_AMOUNT = 1.0;
const SEED_NOISE    = 0.015;

// Optional: restrict sim+render to an equator belt (WU). 0 = full dome.
const EQUATOR_BAND_WU = 0;

// Time clamping
const MAX_DT_SIM = 0.04;
const USE_DT_FALLBACK = true;
const DT_EPS = 1e-6;

// ============================================================================
// Controls — “Endless buzz” forcing (distributed, cymatic-ish)
// ============================================================================
// This replaces stir(): instead of one moving injector, we apply a gentle
// standing-wave field that continuously excites many regions lightly.

const FORCE_ENABLE = true;

// How strong the forcing is (per-second). Keep small; too large -> blobs.
const FORCE_RATE = 0.22;

// Threshold on the forcing field (0..1). Higher = sparser excitation.
const FORCE_THRESHOLD = 0.62;

// Sharpness of excitation around the threshold (higher = crisper node boundaries).
const FORCE_POWER = 2.4;

// Standing-wave “modes” on the dome (integer-ish)
const MODE_LON = 10; // lobes around equator
const MODE_LAT = 5;  // bands over latitude

// How fast the forcing field “breathes” / phase-drifts (Hz)
const FORCE_HZ_1 = 0.085;
const FORCE_HZ_2 = 0.061;

// Add a very tiny stochastic “micro-sparkle” to prevent long-term lock-in
const SPARK_ENABLE = true;
const SPARK_DENSITY = 0.012;  // fraction of cells touched per frame (very small)
const SPARK_AMOUNT  = 0.06;   // added V per second * dtSim (very small)

// ============================================================================
// Controls — Rendering (V + dV shimmer)
// ============================================================================

const INK_STRENGTH  = 1;

// Map V range to ink
const V_MIN = 0.05;
const V_MAX = 0.60;
const V_SHARPNESS = 1.8;

// Map |ΔV| range to ink (motion highlight)
const DV_MIN = 0.000;
const DV_MAX = 0.015;
const DV_SHARPNESS = 1.2;

// Blend between static pattern and motion shimmer:
// 0 = V only, 1 = |ΔV| only
const DV_BLEND = 0.75;

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

// Precomputed spherical coords for forcing field
let lonA = new Float32Array(0); // atan2(z,x)  [-pi..pi]
let latA = new Float32Array(0); // asin(y/r)   [-pi/2..pi/2]

// Reaction–diffusion buffers
let U  = new Float32Array(0);
let V  = new Float32Array(0);
let U2 = new Float32Array(0);
let V2 = new Float32Array(0);

// For motion render
let Vprev = new Float32Array(0);

// Neighbor graph (fixed-size adjacency)
let nbrCount = new Uint8Array(0);
let nbrIdx   = new Int32Array(0);
let nbrW     = new Float32Array(0);

// Stable render objects
let changes = [];

// Time tracking
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

  cachePositions(api);
  buildLonLat();
  buildNeighbors();
  reseed();

  _prevT = null;
}

function allocAll(){
  const N = IDS.length;

  posX = new Float32Array(N);
  posY = new Float32Array(N);
  posZ = new Float32Array(N);

  lonA = new Float32Array(N);
  latA = new Float32Array(N);

  U  = new Float32Array(N);
  V  = new Float32Array(N);
  U2 = new Float32Array(N);
  V2 = new Float32Array(N);

  Vprev = new Float32Array(N);

  const K = clampInt(MAX_NEIGHBORS, 1, 64);
  nbrCount = new Uint8Array(N);
  nbrIdx   = new Int32Array(N * K);
  nbrW     = new Float32Array(N * K);

  changes = new Array(N);
  for (let i = 0; i < N; i++){
    changes[i] = { id: IDS[i], color: [1,1,1,1] };
  }
}

export function update(api, t/*s*/, dt/*s*/){
  // Detect ID changes
  const newIDS = allTDLIds(api);
  if (newIDS.length !== IDS.length){
    IDS = newIDS;

    allocAll();

    cachePositions(api);
    buildLonLat();
    buildNeighbors();
    reseed();

    _prevT = null;
  } else {
    cachePositions(api);
    // positions are static normally; lon/lat are stable enough to keep
  }

  // sanitize time inputs
  t  = Number.isFinite(t)  ? t  : 0;
  dt = Number.isFinite(dt) ? dt : 0;
  if (dt < 0) dt = 0;

  // Backward jump => reseed and restart timing
  if (_prevT !== null && t < _prevT - 1e-6){
    reseed();
    _prevT = t;
    renderToColors();
    api.setColors(changes);
    return;
  }

  // dtSim from t (preferred), with dt fallback, then 1/fps fallback
  const prevT = _prevT;
  let dtSim = (prevT === null) ? 0 : (t - prevT);

  if (USE_DT_FALLBACK && dtSim >= 0 && dtSim < DT_EPS){
    let dtUse = dt;
    if (dtUse > 1.0) dtUse *= 0.001; // if host sends ms
    if (Number.isFinite(dtUse) && dtUse > DT_EPS){
      dtSim = dtUse;
    } else {
      dtSim = 1 / ((meta && meta.fps) ? meta.fps : 60);
    }
  }

  _prevT = t;

  if (!Number.isFinite(dtSim) || dtSim < 0) dtSim = 0;
  dtSim *= SIM_SPEED;
  if (dtSim > MAX_DT_SIM) dtSim = MAX_DT_SIM;

  // Compute global parameter wobble (very small)
  let FEED = FEED_BASE;
  let KILL = KILL_BASE;
  if (PARAM_WOBBLE_ENABLE){
    const w = Math.sin(TAU * WOBBLE_HZ * t);
    const w2 = Math.cos(TAU * (WOBBLE_HZ * 1.37) * t);
    FEED = FEED_BASE + FEED_WOBBLE * w;
    KILL = KILL_BASE + KILL_WOBBLE * w2;
  }

  if (dtSim > 0){
    const steps = clampInt(SUBSTEPS, 1, 16);
    const h = dtSim / steps;

    for (let s = 0; s < steps; s++){
      stepRD(h, FEED, KILL);
      // swap
      let tmp = U; U = U2; U2 = tmp;
      tmp = V; V = V2; V2 = tmp;
    }

    // Distributed forcing once per frame (not per substep) to keep it lively
    if (FORCE_ENABLE){
      applyForcing(dtSim, t);
    }
  }

  renderToColors();
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

// Precompute lon/lat for forcing field
function buildLonLat(){
  const invR = 1 / Math.max(1e-6, domeR);

  for (let i = 0; i < IDS.length; i++){
    const x = posX[i];
    if (!Number.isFinite(x)){
      lonA[i] = 0;
      latA[i] = 0;
      continue;
    }

    const nx = (x - center.x) * invR;
    const ny = (posY[i] - center.y) * invR;
    const nz = (posZ[i] - center.z) * invR;

    lonA[i] = Math.atan2(nz, nx);
    latA[i] = Math.asin(clamp1(ny));
  }
}

// ============================================================================
// Build neighbor graph via spatial hashing (proximity on centroids)
// ============================================================================
function buildNeighbors(){
  const N = IDS.length;
  const K = clampInt(MAX_NEIGHBORS, 1, 64);

  const area = 4 * Math.PI * domeR * domeR;
  const spacing = Math.sqrt(area / Math.max(1, N));
  const radius = Math.max(1e-3, spacing * Math.max(0.5, NEIGHBOR_RADIUS_MULT));
  const r2 = radius * radius;
  const cellSize = radius;

  const grid = new Map();

  for (let i = 0; i < N; i++){
    const x = posX[i];
    if (!Number.isFinite(x)) continue;

    const y = posY[i], z = posZ[i];
    const ix = Math.floor(x / cellSize);
    const iy = Math.floor(y / cellSize);
    const iz = Math.floor(z / cellSize);

    const key = hashCell(ix, iy, iz);
    let arr = grid.get(key);
    if (!arr){
      arr = [];
      grid.set(key, arr);
    }
    arr.push(i);
  }

  nbrCount.fill(0);
  nbrIdx.fill(-1);
  nbrW.fill(0);

  const cand = [];
  const candD2 = [];

  for (let i = 0; i < N; i++){
    const xi = posX[i];
    if (!Number.isFinite(xi)) continue;

    const yi = posY[i], zi = posZ[i];

    const cix = Math.floor(xi / cellSize);
    const ciy = Math.floor(yi / cellSize);
    const ciz = Math.floor(zi / cellSize);

    cand.length = 0;
    candD2.length = 0;

    for (let dz = -1; dz <= 1; dz++){
      for (let dy = -1; dy <= 1; dy++){
        for (let dx = -1; dx <= 1; dx++){
          const key = hashCell(cix + dx, ciy + dy, ciz + dz);
          const arr = grid.get(key);
          if (!arr) continue;

          for (let a = 0; a < arr.length; a++){
            const j = arr[a];
            if (j === i) continue;

            const xj = posX[j];
            if (!Number.isFinite(xj)) continue;

            const dxw = xj - xi;
            const dyw = posY[j] - yi;
            const dzw = posZ[j] - zi;
            const d2 = dxw*dxw + dyw*dyw + dzw*dzw;
            if (d2 > r2) continue;

            cand.push(j);
            candD2.push(d2);
          }
        }
      }
    }

    // pick up to K nearest by weight
    const base = i * K;
    let count = 0;

    for (let c = 0; c < cand.length; c++){
      const j = cand[c];
      const d2 = candD2[c];
      const w = 1.0 / (1e-6 + d2);

      if (count < K){
        let k = count;
        while (k > 0 && nbrW[base + (k - 1)] < w){
          nbrIdx[base + k] = nbrIdx[base + (k - 1)];
          nbrW[base + k]   = nbrW[base + (k - 1)];
          k--;
        }
        nbrIdx[base + k] = j;
        nbrW[base + k]   = w;
        count++;
      } else {
        const worstW = nbrW[base + (K - 1)];
        if (w <= worstW) continue;

        let k = K - 1;
        while (k > 0 && nbrW[base + (k - 1)] < w){
          nbrIdx[base + k] = nbrIdx[base + (k - 1)];
          nbrW[base + k]   = nbrW[base + (k - 1)];
          k--;
        }
        nbrIdx[base + k] = j;
        nbrW[base + k]   = w;
      }
    }

    nbrCount[i] = count;
  }
}

// ============================================================================
// Seed / reset chemicals
// ============================================================================
function reseed(){
  const N = IDS.length;

  for (let i = 0; i < N; i++){
    U[i] = 1.0;
    V[i] = 0.0;
    U2[i] = 1.0;
    V2[i] = 0.0;
    Vprev[i] = 0.0;
  }

  for (let i = 0; i < N; i++){
    if (!Number.isFinite(posX[i])) continue;

    const r = hash01(i * 1103515245 + 12345);
    if (r < SEED_DENSITY){
      V[i] = SEED_V_AMOUNT;
      U[i] = 0.0;
    }

    const n = (hash01(i * 69069 + 1) - 0.5) * 2.0 * SEED_NOISE;
    U[i] = clamp01(U[i] + n);
    V[i] = clamp01(V[i] - n);
  }
}

// ============================================================================
// Reaction–diffusion step (Gray-Scott)
// ============================================================================
function stepRD(h, FEED, KILL){
  const N = IDS.length;
  const K = clampInt(MAX_NEIGHBORS, 1, 64);
  const bandWU = Math.max(0, EQUATOR_BAND_WU);

  for (let i = 0; i < N; i++){
    if (!Number.isFinite(posX[i])){
      U2[i] = U[i];
      V2[i] = V[i];
      continue;
    }

    if (bandWU > 0 && Math.abs(posY[i] - center.y) > bandWU){
      U2[i] = U[i];
      V2[i] = V[i];
      continue;
    }

    const u = U[i];
    const v = V[i];

    const base = i * K;
    const n = nbrCount[i];

    let sumWU = 0, sumWV = 0, sumW = 0;

    for (let k = 0; k < n; k++){
      const j = nbrIdx[base + k];
      if (j < 0) break;
      const w = nbrW[base + k];
      sumWU += U[j] * w;
      sumWV += V[j] * w;
      sumW  += w;
    }

    const avgU = (sumW > 0) ? (sumWU / sumW) : u;
    const avgV = (sumW > 0) ? (sumWV / sumW) : v;

    const lapU = avgU - u;
    const lapV = avgV - v;

    const uvv = u * v * v;
    const du = DIFF_U * lapU - uvv + FEED * (1 - u);
    const dv = DIFF_V * lapV + uvv - (KILL + FEED) * v;

    U2[i] = clamp01(u + du * h);
    V2[i] = clamp01(v + dv * h);
  }
}

// ============================================================================
// Distributed forcing (standing-wave field + tiny sparkle)
// ============================================================================
function applyForcing(dtSim, t){
  const N = IDS.length;

  const ph1 = TAU * FORCE_HZ_1 * t;
  const ph2 = TAU * FORCE_HZ_2 * t;

  // per-frame forcing scale
  const addBase = FORCE_RATE * dtSim;

  // sparkle seed: changes each frame but deterministic
  const sparkKey = (t * 60) | 0;

  for (let i = 0; i < N; i++){
    if (!Number.isFinite(posX[i])) continue;

    // Cymatic-ish standing-wave field (0..1)
    const lon = lonA[i];
    const lat = latA[i];

    // A couple of interlocked modes -> richer nodes
    const a = Math.sin(MODE_LON * lon + ph1) * Math.cos(MODE_LAT * lat - ph2);
    const b = Math.cos((MODE_LON - 3) * lon - ph2 * 0.9) * Math.sin((MODE_LAT + 2) * lat + ph1 * 0.7);

    let field = 0.5 + 0.5 * (0.62 * a + 0.38 * b); // ~0..1
    field = clamp01(field);

    // Gate + shape around threshold so we excite mostly near “antinodes”
    let m = (field - FORCE_THRESHOLD) / Math.max(1e-6, (1 - FORCE_THRESHOLD));
    m = clamp01(m);
    m = Math.pow(m, FORCE_POWER);

    // Apply gentle excitation (V up, U down a bit)
    if (m > 0){
      const add = addBase * m;
      V[i] = clamp01(V[i] + add);
      U[i] = clamp01(U[i] - add * 0.55);
    }

    // Tiny stochastic sparkle (prevents long-term lock-in)
    if (SPARK_ENABLE){
      const r = hash01((i * 1664525) ^ (sparkKey * 1013904223));
      if (r < SPARK_DENSITY){
        const s = SPARK_AMOUNT * dtSim;
        V[i] = clamp01(V[i] + s);
        U[i] = clamp01(U[i] - s * 0.45);
      }
    }
  }
}

// ============================================================================
// Render: blend V and |ΔV| for “buzz visibility”
// ============================================================================
function renderToColors(){
  const N = IDS.length;

  const vmin = V_MIN, vmax = Math.max(vmin + 1e-6, V_MAX);
  const invV = 1.0 / (vmax - vmin);

  const dvmin = DV_MIN, dvmax = Math.max(dvmin + 1e-6, DV_MAX);
  const invDV = 1.0 / (dvmax - dvmin);

  const strength = clamp01(INK_STRENGTH);
  const vPow  = Math.max(1e-3, V_SHARPNESS);
  const dvPow = Math.max(1e-3, DV_SHARPNESS);
  const blend = clamp01(DV_BLEND);

  for (let i = 0; i < N; i++){
    const c = changes[i].color;

    if (!Number.isFinite(posX[i])){
      c[0]=1; c[1]=1; c[2]=1; c[3]=1;
      continue;
    }

    const v = V[i];
    const dv = Math.abs(v - Vprev[i]);
    Vprev[i] = v;

    let xV = clamp01((v - vmin) * invV);
    xV = Math.pow(xV, vPow);

    let xDV = clamp01((dv - dvmin) * invDV);
    xDV = Math.pow(xDV, dvPow);

    const x = lerp(xV, xDV, blend);

    const ink = clamp01(x * strength);
    const g = 1 - ink;

    c[0]=g; c[1]=g; c[2]=g; c[3]=1;
  }
}

// ============================================================================
// Utils
// ============================================================================
const TAU = Math.PI * 2;

function lerp(a, b, t){ return a + (b - a) * t; }
function clamp01(x){ return x < 0 ? 0 : (x > 1 ? 1 : x); }
function clamp1(x){ return x < -1 ? -1 : (x > 1 ? 1 : x); }

function clampInt(x, a, b){
  x = (x|0);
  return x < a ? a : (x > b ? b : x);
}

function hashCell(ix, iy, iz){
  let h = (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791);
  return h >>> 0;
}

function hash01(n){
  n = (n ^ (n >>> 16)) >>> 0;
  n = Math.imul(n, 2246822507) >>> 0;
  n = (n ^ (n >>> 13)) >>> 0;
  n = Math.imul(n, 3266489909) >>> 0;
  n = (n ^ (n >>> 16)) >>> 0;
  return (n >>> 0) / 4294967296;
}
