// ripp—tdl-cymatics-interference-hello (WHITE CANVAS + BLACK NODAL LINES, FFs).js
// Preview contract: init(api), update(api, t, dt)
//
// Adds Flying Faders (FF) for:
//   SPEED, FREQ, AMP, NODE_THRESHOLD, NODE_FEATHER, INK_STRENGTH
//
// CANON: time is driven by host `t` (seconds). We derive a local timeline (localT)
// that starts at 0 on init and resets if host time goes backwards (scrub/restart).
//
// FF Schema:
//   [{ ms:<number>, v:<number>, ease?:<string> }, ...]
//
// Rules:
// - `ms` is on the local timeline (localT*1000).
// - Between keyframes, we interpolate using the *starting* keyframe's ease.
// - Repeated ms values are allowed; the later keyframe “wins” (hard jump).
//
// Supported eases (case-insensitive):
//   linear, inQuad, outQuad, inOutQuad, inCubic, outCubic, inOutCubic

export const meta = {
  name: "Cymatics (hello): Interference → nodal lines (white dome) — FFs",
  fps: 60,
  duration: 60
};

// ============================================================================
// Controls (hello cymatics)
// ============================================================================

// Number of virtual sources (2..6 recommended). 4 is a great default.
const SOURCE_COUNT = 4;

// Global wave frequency (higher = tighter rings / more detail)
const FREQ = 0.075; // radians per WU (approx)

// Global animation speed (higher = faster morph)
const SPEED = 5.0;  // multiplies time (t)

// Small per-source frequency detune to create slow emergent drift
const DETUNE = 0.04; // 0..0.02

// Per-source amplitude
const AMP = 0.90;

// Where nodal lines appear: abs(F) near 0
const NODE_THRESHOLD = 0.01; // bigger = thicker lines
const NODE_FEATHER   = 0.90; // bigger = softer edges

// Sharpening exponent for the extracted line mask
const SHARPNESS = 5.8;

// How dark the ink gets on white
const INK_STRENGTH = 1.0;

// Use only a band around the equator? (performance + “plate-ish” feel)
const EQUATOR_BAND_WU = 0; // e.g. 90 for a belt, 0 for full dome

// Optional: rotate the whole pattern around the vertical axis (radians)
const PHASE_OFFSET = 0.0;

// ============================================================================
// Flying Faders (FF) — edit these arrays
// ----------------------------------------------------------------------------
// Defaults are "no-op": they hold your existing constants forever WITHOUT
// relying on meta.duration.
// ============================================================================


const SPEED_FF = [
  { ms: 0,    v: 0.00, ease: "linear" },
  { ms: 5000, v: 5.0 }
];

const FREQ_FF = [
  { ms: 0,    v: 0.09, ease: "outQuad" },
  { ms: 5000, v: 0.05 }
];

const AMP_FF = [
  { ms: 0,    v: 0.60, ease: "outQuad" },
  { ms: 5000, v: .90 }
];

const NODE_THRESHOLD_FF = [
  { ms: 0,    v: 0.01, ease: "inQuad" },
  { ms: 4000, v: 1.1 }
];

const NODE_FEATHER_FF = [
  { ms: 0,    v: 0.01, ease: "outQuad" },
  { ms: 6000, v: 2.9 }
];

const INK_STRENGTH_FF = [
  { ms: 0,    v: 0.00, ease: "outQuad" },
  { ms: 1000, v: 1.}
];

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

// cached, sorted keyframes
let _ffSpeed = null;
let _ffFreq  = null;
let _ffAmp   = null;
let _ffTh    = null;
let _ffFeath = null;
let _ffInk   = null;

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

  // pre-process FF keyframes once
  _ffSpeed = prepFF(SPEED_FF);
  _ffFreq  = prepFF(FREQ_FF);
  _ffAmp   = prepFF(AMP_FF);
  _ffTh    = prepFF(NODE_THRESHOLD_FF);
  _ffFeath = prepFF(NODE_FEATHER_FF);
  _ffInk   = prepFF(INK_STRENGTH_FF);

  buildSources();
}

function buildSources(){
  const n = clampInt(SOURCE_COUNT, 1, 16);

  SRC_X = new Float32Array(n);
  SRC_Y = new Float32Array(n);
  SRC_Z = new Float32Array(n);
  SRC_W = new Float32Array(n);
  SRC_P = new Float32Array(n);

  const r = domeR * 0.95;
  for (let i = 0; i < n; i++){
    const a = (i / n) * TAU + PHASE_OFFSET;

    const x = center.x + Math.cos(a) * r;
    const z = center.z + Math.sin(a) * r;

    const y = center.y + ((i & 1) ? 0.08 : -0.08) * domeR;

    SRC_X[i] = x;
    SRC_Y[i] = y;
    SRC_Z[i] = z;

    const det = (i - (n - 1) * 0.5) / Math.max(1, n - 1); // [-0.5..0.5]
    SRC_W[i] = 1.0 + det * DETUNE;

    SRC_P[i] = (i / n) * TAU * 0.37;
  }
}

// ============================================================================
// Update
// ============================================================================
export function update(api, t/*s*/, dt/*s*/){
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

  const localT  = Math.max(0, t - _t0);
  const localMs = localT * 1000;

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

  // FF-evaluated params (fallback to constants if missing)
  const speedV = safeNumber(evalFF(localMs, _ffSpeed), SPEED);
  const freqV  = safeNumber(evalFF(localMs, _ffFreq),  FREQ);
  const ampV   = safeNumber(evalFF(localMs, _ffAmp),   AMP);

  const thV    = safeNumber(evalFF(localMs, _ffTh),    NODE_THRESHOLD);
  const feV    = safeNumber(evalFF(localMs, _ffFeath), NODE_FEATHER);
  const inkV   = clamp01(safeNumber(evalFF(localMs, _ffInk), INK_STRENGTH));

  // Precompute time phase (FF-driven)
  const timePhase = localT * speedV;

  // Equator band cull (optional)
  const bandWU = Math.max(0, EQUATOR_BAND_WU);

  const nSrc = SRC_X.length;
  const changes = new Array(IDS.length);

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

      const d = Math.hypot(dx, dy, dz);

      // Phase: k*d - w*t + phi
      const k = freqV * SRC_W[s];
      const phase = (k * d) - (k * 260.0) * timePhase + SRC_P[s];

      F += Math.sin(phase) * ampV;
    }

    // Normalize by number of sources
    F /= Math.max(1, nSrc);

    // Extract nodal lines: abs(F) near 0
    const aF = Math.abs(F);
    let line = 1.0 - smoothstep(thV, thV + feV, aF);

    // Sharpen
    line = Math.pow(clamp01(line), Math.max(1e-3, SHARPNESS));

    // Ink
    const ink = clamp01(line * inkV);
    const g = 1 - ink;

    changes[i] = { id: IDS[i], color: [g, g, g, 1] };
  }

  api.setColors(changes);
}

// ============================================================================
// Flying Faders implementation
// ============================================================================
function prepFF(keys){
  if (!Array.isArray(keys) || keys.length === 0) return null;

  // clone + normalize + stable-sort by ms (ties keep original order)
  const k = keys.map((o, idx)=>({
    ms: Number(o?.ms ?? 0),
    v:  Number(o?.v  ?? 0),
    ease: String(o?.ease ?? "linear"),
    _i: idx
  })).filter(o=>Number.isFinite(o.ms) && Number.isFinite(o.v));

  k.sort((a,b)=> (a.ms - b.ms) || (a._i - b._i));
  return k.length ? k : null;
}

function evalFF(tMs, keys){
  if (!keys || keys.length === 0) return NaN;

  if (tMs <= keys[0].ms) return keys[0].v;
  const last = keys[keys.length - 1];
  if (tMs >= last.ms) return last.v;

  let i1 = 0;
  for (let i = 0; i < keys.length - 1; i++){
    if (tMs >= keys[i].ms && tMs <= keys[i+1].ms){ i1 = i; break; }
  }

  const a = keys[i1];
  const b = keys[i1 + 1];
  const span = b.ms - a.ms;

  if (!(span > 0)) return b.v; // repeated-ms = hard jump

  const u = clamp01((tMs - a.ms) / span);
  const e = ease01(u, a.ease);
  return a.v + (b.v - a.v) * e;
}

function ease01(t, easeName){
  const e = String(easeName || "linear").toLowerCase();

  if (e === "incubic" || e === "in_cubic") return t*t*t;
  if (e === "outcubic" || e === "out_cubic"){ const u = 1 - t; return 1 - u*u*u; }
  if (e === "inoutcubic" || e === "in_out_cubic" || e === "inout_cubic"){
    return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2;
  }

  if (e === "inquad" || e === "in_quad") return t*t;
  if (e === "outquad" || e === "out_quad") return 1 - (1 - t)*(1 - t);
  if (e === "inoutquad" || e === "in_out_quad" || e === "inout_quad"){
    return t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2) / 2;
  }

  return t; // linear
}

function safeNumber(x, fallback){
  return Number.isFinite(x) ? x : fallback;
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
