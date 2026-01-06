// ripp—tdl-curl-noise-dualmode (PROJECTION + INKING, FF exp+gain + FF strengths).js
// Preview contract: init(api), update(api, t, dt)
//
// Curl-noise style flow field on the dome.
//
// PROJECTION (live):
//   - computes curl magnitude -> "projInk" (0..1 darkness amount)
//   - renders as grayscale projection
//
// INKING (persistent accumulation):
//   - separate float buffer inkA[i] (0..1)
//   - dt-stable accumulation driven by projection darkness
//   - optional delay + ramp-in (INK_START_MS / INK_RAMP_MS)
//
// FINAL:
//   - gFinal = gProj * (1 - inkA)
//   - keeps projection readable while ink accumulates behind it
//
// CANON: time is driven by host `t` (seconds). We derive a local timeline (localT)
// that starts at 0 on init and resets if host time goes backwards (scrub/restart).
//
// Flying Faders (FF):
//   - FLOW_EXPONENT_FF
//   - FLOW_GAIN_FF
//   - MODE1_STRENGTH_FF
//   - MODE2_STRENGTH_FF
//
// FF Schema:
//   [{ ms:<number>, v:<number>, ease?:<string> }, ...]
//
// Supported eases (case-insensitive):
//   linear, inQuad, outQuad, inOutQuad, inCubic, outCubic, inOutCubic

export const meta = {
  name: "Curl Noise: Dual-Mode Flow — PROJECTION + INKING (FF exp+gain + FF strengths)",
  fps: 60,
  duration: 60
};

// ============================================================================
// Controls (unchanged)
// ============================================================================
const MASTER_SPEED = 2.0;

// Mode 1: broad, slow flow
const MODE1_SCALE    = 0.80;
const MODE1_TIME     = 1.10;
const MODE1_STRENGTH = 0.50;

// Mode 2: finer, faster flow
const MODE2_SCALE    = 0.90;
const MODE2_TIME     = 0.90;
const MODE2_STRENGTH = 1.60;

// Blend between the two modes
const MODE_MIX = 0.50;

// Curl shaping (defaults; FF can override dynamically)
const FLOW_EXPONENT = 0.40;
const FLOW_GAIN     = 1.00;

// Visual controls
const INK_STRENGTH  = 1.0;
const INVERT        = false;

// Optional: focus around equator (0 = off)
const EQUATOR_BIAS = 0.0;

// ============================================================================
// (KEEP) Projection start envelope — guarantees pure white at the very start
// ----------------------------------------------------------------------------
// This only affects the *projection visibility* (not the ink buffer).
// If you want projection visible immediately, set START_INK_FADE_MS = 0.
// ============================================================================
const START_WHITE_HOLD_MS = 0;
const START_INK_FADE_MS   = 500; // projection fade-in time

// ============================================================================
// INKING (persistent accumulation; canonical schema from caustics)
// ----------------------------------------------------------------------------
// Delay before ink begins + ramp-in.
// Ink write is dt-stable, driven by projection darkness.
//
// Tip:
// - If you want: "projection immediately, ink later": set INK_START_MS ~ 600..1500.
// - If you want: "ink starts right away but gently": set INK_START_MS = 0, larger INK_RAMP_MS.
// ============================================================================
const INK_ENABLE   = true;

const INK_START_MS = 2000;   // <-- delay before inking begins
const INK_RAMP_MS  = 2000;  // <-- time to ramp ink write strength up

const INK_ALPHA_BASE =.75;      // per-second base write rate (dt-stable)
const STACK_MODE     = "linear";  // "linear" or "over"
const INK_WRITE_MAX  = 1.0;       // 0..1 cap

// Float ink buffer snap-to-black to avoid infinite tail
const INK_SNAP_EPS = 1 / 255;

// ============================================================================
// Flying Faders (FF) — edit these arrays
// ============================================================================
const FLOW_EXPONENT_FF = [
  { ms: 0,    v: 0.00, ease: "inOutQuad" },
  { ms: 1000, v: 0.40 }
];

const FLOW_GAIN_FF = [
  { ms: 0,    v: 0.00, ease: "inOutQuad" },
  { ms: 1000, v: 1.00 }
];

const MODE1_STRENGTH_FF = [
  { ms: 0,    v: 0.00, ease: "inOutQuad" },
  { ms: 1500, v: 0.90 }
];

const MODE2_STRENGTH_FF = [
  { ms: 0,    v: 0.00, ease: "inOutQuad" },
  { ms: 1500, v: 1.60 }
];

// ============================================================================
// Helpers (schema)
// ============================================================================
function allTDLIds(api){
  const T = Array.isArray(api?.ids?.T) ? api.ids.T : [];
  const D = Array.isArray(api?.ids?.D) ? api.ids.D : [];
  const L = Array.isArray(api?.ids?.L) ? api.ids.L : [];
  return [...new Set([...T, ...D, ...L])];
}

function lerp(a,b,t){ return a + (b - a) * t; }
function clamp01(x){ return x < 0 ? 0 : (x > 1 ? 1 : x); }

// ============================================================================
// State
// ============================================================================
let IDS = [];
let center = { x:0, y:0, z:0 };
let domeR = 250;

let posX = new Float32Array(0);
let posY = new Float32Array(0);
let posZ = new Float32Array(0);

// Persistent ink density (0..1). 0 = none, 1 = full black layer.
let inkA = new Float32Array(0);

// Stable render list
let changes = [];

// local time origin so FF + motion can start at 0 even if host t starts nonzero
let _t0 = null;
let _prevT = null;

// cached, sorted keyframes
let _ffExp  = null;
let _ffGain = null;
let _ffM1   = null;
let _ffM2   = null;

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

  _t0 = null;
  _prevT = null;

  _ffExp  = prepFF(FLOW_EXPONENT_FF);
  _ffGain = prepFF(FLOW_GAIN_FF);
  _ffM1   = prepFF(MODE1_STRENGTH_FF);
  _ffM2   = prepFF(MODE2_STRENGTH_FF);
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
    cachePositions(api);
    restarted = true;
  } else {
    cachePositions(api);
  }

  if (restarted){
    clearInk();
    api.resetColorsTo([1,1,1,1]);
  }

  const localT  = Math.max(0, t - _t0);
  const localMs = localT * 1000;

  const N = IDS.length;
  const invR = 1 / Math.max(1e-6, domeR);
  const mixV = clamp01(MODE_MIX);
  const inkStr = clamp01(INK_STRENGTH);

  // FF-evaluated shaping (fallback to constants if missing)
  const flowExp  = safeNumber(evalFF(localMs, _ffExp),  FLOW_EXPONENT);
  const flowGain = safeNumber(evalFF(localMs, _ffGain), FLOW_GAIN);

  const m1Strength = safeNumber(evalFF(localMs, _ffM1), MODE1_STRENGTH);
  const m2Strength = safeNumber(evalFF(localMs, _ffM2), MODE2_STRENGTH);

  // projection visibility envelope (keeps start pure white)
  const projFade = startProjectionFade(localMs);

  // INKING: dt-stable alpha per frame
  const inkGain = inkRamp01(localMs); // 0..1
  let alphaFrameBase = 0;
  if (inkGain > 0){
    let alphaSec = INK_ALPHA_BASE * inkGain;
    alphaSec *= clamp01(INK_WRITE_MAX);
    alphaFrameBase = alphaPerFrame(alphaSec, dt);
  }

  // Effective times per mode (driven by local timeline)
  const t1 = localT * MODE1_TIME * MASTER_SPEED;
  const t2 = localT * MODE2_TIME * MASTER_SPEED;

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
      const eq = 1.0 - Math.abs(ny);
      equatorWeight = lerp(1.0, clamp01(eq), clamp01(EQUATOR_BIAS));
    }

    // Mode 1 curl
    const v1 = curl3(nx * MODE1_SCALE, ny * MODE1_SCALE, nz * MODE1_SCALE, t1);

    // Mode 2 curl
    const v2 = curl3(nx * MODE2_SCALE, ny * MODE2_SCALE, nz * MODE2_SCALE, t2 + 7.31);

    // Blend modes (strengths are FF-driven)
    const w1 = m1Strength * (1.0 - mixV);
    const w2 = m2Strength * mixV;

    const vx = v1[0] * w1 + v2[0] * w2;
    const vy = v1[1] * w1 + v2[1] * w2;
    const vz = v1[2] * w1 + v2[2] * w2;

    // "projection intensity" source
    let mag = Math.sqrt(vx*vx + vy*vy + vz*vz);

    // filament shaping (FF-driven)
    mag = Math.pow(mag * flowGain, flowExp);
    mag = clamp01(mag);

    // apply equator emphasis
    mag *= equatorWeight;

    // PROJECTION darkness (0..1), then apply projection fade-in
    let projInk = clamp01(mag * inkStr) * projFade;

    // Projection grayscale
    const gProj = INVERT ? projInk : (1 - projInk);

    // For inking accumulation we want a "darkness driver"
    // (so in normal mode, dark filaments drive ink; in invert mode, the dark background drives ink less)
    const projDarkDriver = INVERT ? (1 - projInk) : projInk;

    // INKING: accumulate where projection is dark (dt-stable)
    if (INK_ENABLE && alphaFrameBase > 0 && projDarkDriver > 1e-6){
      const aOld = inkA[i];
      if (aOld < 1){
        let aNew = stackInk(aOld, alphaFrameBase * projDarkDriver);
        if (aNew > 1 - INK_SNAP_EPS) aNew = 1;
        if (aNew > aOld) inkA[i] = aNew;
      }
    }

    // FINAL: projection * remaining whiteness
    const gInk = 1 - inkA[i];
    const gFinal = gProj * gInk;

    c[0]=gFinal; c[1]=gFinal; c[2]=gFinal; c[3]=1;
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
// Projection start fade (pure white at start)
// ============================================================================
function startProjectionFade(localMs){
  if (localMs <= START_WHITE_HOLD_MS) return 0;

  const fadeMs = Math.max(1e-6, START_INK_FADE_MS);
  const x = (localMs - START_WHITE_HOLD_MS) / fadeMs;
  const t = clamp01(x);
  return t*t*(3 - 2*t); // smoothstep
}

// ============================================================================
// INKING helpers (canonical)
// ============================================================================
function inkRamp01(tMs){
  if (!INK_ENABLE) return 0;
  if (!Number.isFinite(INK_START_MS)) return 0;
  if (tMs < INK_START_MS) return 0;

  const dur = Math.max(0, INK_RAMP_MS);
  if (dur <= 0) return 1;

  return clamp01((tMs - INK_START_MS) / dur);
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
  // "over"
  return 1 - (1 - aOld) * (1 - inkAlpha);
}

// ============================================================================
// Flying Faders implementation (unchanged)
// ============================================================================
function prepFF(keys){
  if (!Array.isArray(keys) || keys.length === 0) return null;

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
// Curl noise core (unchanged)
// ============================================================================
function curl3(x, y, z, t){
  const e = 0.02;

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

  return [
    dFz_dy - dFy_dz,
    dFx_dz - dFz_dx,
    dFy_dx - dFx_dy
  ];
}

function noiseVec3(x, y, z, t){
  const n1 = noise4(x + 11.2, y + 5.7,  z - 3.4,  t * 0.9);
  const n2 = noise4(x - 7.9,  y + 2.1,  z + 13.3, t * 1.1);
  const n3 = noise4(x + 4.6,  y - 9.4,  z + 1.7,  t * 1.3);
  return [ n1 * 2.0 - 1.0, n2 * 2.0 - 1.0, n3 * 2.0 - 1.0 ];
}

function noise4(x, y, z, w){
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), wi = Math.floor(w);
  const xf = x - xi,       yf = y - yi,       zf = z - zi,       wf = w - wi;

  const u = smooth(xf), v = smooth(yf), s = smooth(zf), r = smooth(wf);

  let acc = 0.0;
  for (let dx = 0; dx <= 1; dx++){
    for (let dy = 0; dy <= 1; dy++){
      for (let dz = 0; dz <= 1; dz++){
        for (let dw = 0; dw <= 1; dw++){
          const h = hash4(xi + dx, yi + dy, zi + dz, wi + dw);
          const wx = dx ? u : (1 - u);
          const wy = dy ? v : (1 - v);
          const wz = dz ? s : (1 - s);
          const ww = dw ? r : (1 - r);
          acc += h * (wx * wy * wz * ww);
        }
      }
    }
  }
  return acc;
}

// ============================================================================
// Utils
// ============================================================================
function smooth(t){ return t * t * (3 - 2 * t); }

function hash4(x, y, z, w){
  let h = x * 374761393 + y * 668265263 + z * 2147483647 + w * 912931;
  h = (h ^ (h >> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  return (h >>> 0) / 4294967296;
}
