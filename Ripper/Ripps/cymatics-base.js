// ripp—tdl-cymatics-interference-hello (WHITE CANVAS + BLACK NODAL LINES).js
// Preview contract: init(api), update(api, t, dt)

export const meta = {
  name: "Cymatics (hello): Interference sources → nodal lines (white dome)",
  fps: 60,
  duration: 60
};

// ============================================================================
// Controls (hello cymatics)
// ============================================================================

// Number of virtual sources (2..6 recommended). 4 is a great default.
const SOURCE_COUNT = 4;

// Global wave frequency (higher = tighter rings / more detail)
const FREQ = 0.075; // in radians per WU (approx)

// Global animation speed (higher = faster morph)
const SPEED = 1.0;  // multiplies time (t)

// Small per-source frequency detune to create slow emergent drift
const DETUNE = 0.04; // 0..0.02

// Per-source amplitude
const AMP = .50;

// Where nodal lines appear: abs(F) near 0
const NODE_THRESHOLD = 0.15; // bigger = thicker lines
const NODE_FEATHER   = 0.60; // bigger = softer edges

// Sharpening exponent for the extracted line mask
const SHARPNESS = 5.8;

// How dark the ink gets on white
const INK_STRENGTH = 0.95;

// Use only a band around the equator? (performance + “plate-ish” feel)
// Set to 0 to disable banding (full dome).
const EQUATOR_BAND_WU = 0; // e.g. 90 for a belt, 0 for full dome

// Optional: rotate the whole pattern around the vertical axis (radians)
const PHASE_OFFSET = 0.0;

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

// Local time origin so it behaves well if t starts nonzero / scrubs
let _t0 = null;
let _prevT = null;

// Precomputed sources (stable across frames)
let SRC_X = new Float32Array(0);
let SRC_Y = new Float32Array(0);
let SRC_Z = new Float32Array(0);
let SRC_W = new Float32Array(0); // per-source freq multiplier (detune)
let SRC_P = new Float32Array(0); // per-source phase offset

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

  buildSources();
}

function buildSources(){
  const n = clampInt(SOURCE_COUNT, 1, 16);

  SRC_X = new Float32Array(n);
  SRC_Y = new Float32Array(n);
  SRC_Z = new Float32Array(n);
  SRC_W = new Float32Array(n);
  SRC_P = new Float32Array(n);

  // Place sources around the equator at evenly spaced longitudes.
  // Slight up/down staggering to break perfect symmetry (still “cymatic”).
  const r = domeR * 0.95;
  for (let i = 0; i < n; i++){
    const a = (i / n) * TAU + PHASE_OFFSET;

    // equator ring
    const x = center.x + Math.cos(a) * r;
    const z = center.z + Math.sin(a) * r;

    // tiny vertical offset alternating
    const y = center.y + ((i & 1) ? 0.08 : -0.08) * domeR;

    SRC_X[i] = x;
    SRC_Y[i] = y;
    SRC_Z[i] = z;

    // detune around 1.0, stable per source
    const det = (i - (n - 1) * 0.5) / Math.max(1, n - 1); // [-0.5..0.5]
    SRC_W[i] = 1.0 + det * DETUNE;

    // phase offsets spread out
    SRC_P[i] = (i / n) * TAU * 0.37;
  }
}

export function update(api, t/*s*/, dt/*s*/){
  // sanitize time inputs
  t  = Number.isFinite(t)  ? t  : 0;
  dt = Number.isFinite(dt) ? dt : 0;
  if (dt < 0) dt = 0;

  // establish local time origin; reset on backward time jump
  if (_t0 === null){
    _t0 = t;
    _prevT = t;
  } else if (_prevT !== null && t < _prevT - 1e-6){
    _t0 = t;
  }
  _prevT = t;

  const localT = Math.max(0, t - _t0);

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

  const nSrc = SRC_X.length;
  const changes = new Array(IDS.length);

  // Precompute time phase
  const timePhase = localT * SPEED;

  // Equator band cull (optional)
  const bandWU = Math.max(0, EQUATOR_BAND_WU);

  for (let i = 0; i < IDS.length; i++){
    const px = posX[i];
    if (!Number.isFinite(px)){
      changes[i] = { id: IDS[i], color: [1,1,1,1] };
      continue;
    }

    const py = posY[i];
    const pz = posZ[i];

    if (bandWU > 0){
      const dy = Math.abs(py - center.y);
      if (dy > bandWU){
        changes[i] = { id: IDS[i], color: [1,1,1,1] };
        continue;
      }
    }

    // Interference field F: sum of distance-based traveling waves
    let F = 0.0;

    for (let s = 0; s < nSrc; s++){
      const dx = px - SRC_X[s];
      const dy = py - SRC_Y[s];
      const dz = pz - SRC_Z[s];

      const d = Math.hypot(dx, dy, dz); // WU distance

      // Phase: k*d - w*t + phi
      const k = FREQ * SRC_W[s];
      const phase = (k * d) - (k * 260.0) * timePhase + SRC_P[s]; // 260 is a pleasing scaling for motion

      F += Math.sin(phase) * AMP;
    }

    // Normalize by number of sources (keeps threshold stable-ish)
    F /= Math.max(1, nSrc);

    // Extract nodal lines: abs(F) near 0
    const aF = Math.abs(F);
    let line = 1.0 - smoothstep(NODE_THRESHOLD, NODE_THRESHOLD + NODE_FEATHER, aF);

    // Sharpen
    line = Math.pow(clamp01(line), Math.max(1e-3, SHARPNESS));

    // Ink
    const ink = clamp01(line * INK_STRENGTH);
    const g = 1 - ink;

    changes[i] = { id: IDS[i], color: [g, g, g, 1] };
  }

  api.setColors(changes);
}

// ============================================================================
// Utils
// ============================================================================
const TAU = Math.PI * 2;

function clamp01(x){ return x < 0 ? 0 : (x > 1 ? 1 : x); }
function clampInt(x, a, b){
  x = (x|0);
  return x < a ? a : (x > b ? b : x);
}
function smoothstep(e0, e1, x){
  if (e1 <= e0) return x >= e1 ? 1 : 0;
  const u = clamp01((x - e0) / (e1 - e0));
  return u * u * (3 - 2 * u);
}
