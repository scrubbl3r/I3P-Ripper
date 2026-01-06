// ripp—tdl-oscilloscope-equator (WHITE CANVAS + BLACK TRACE + ABSOLUTE KEYFRAMES, MANUAL PARAMS + FF, BAND OFFSET + FF).js
// Preview contract: init(api), update(api, t, dt)
//
// Goal (per your cymatics-FF schema):
// - Keep manual knobs up top (single-source “defaults” you can set by hand).
// - Keep ALL existing animation/tweens exactly as-is.
// - Keyframes are NOT wrapped in a single AUTO object.
// - Automation is ABSOLUTE-time (driven by host `t`): nowMs = t*1000
// - EQUATOR_BAND_OFFSET_WU is now ALSO tweenable (ABSOLUTE-time), and is placed
//   at the top of the FF list. Manual default remains 0.

export const meta = {
  name: "Oscilloscope (equator wrap): Manual params + Absolute-time FFs + band offset (tweenable)",
  fps: 60,
  duration: 60
};

// ============================================================================
// Controls (MANUAL DEFAULTS — you can set these by hand)
// ----------------------------------------------------------------------------
// These are the fallback values used when a given *_FF list is empty/null.
// Your current animation will override these via the *_FF keyframes below.
// ============================================================================
const AUTO_LOOP = false; // if true, wraps automation time over LOOP_MS
const LOOP_MS = meta.duration * 1000;

// NEW: raise/lower the oscilloscope band center in WORLD UNITS (WU).
//  0 = centered at center.y
// +WU = move band upward
// -WU = move band downward
const EQUATOR_BAND_OFFSET_WU = 0; // try -40..+40

// Manual defaults (fallbacks if you disable automation for a parameter)
const CYCLES       = 30.0;  // cycles around equator (can be fractional)
const PHASE_RATE   = 4.0;   // cycles per second added to phase term
const AMP_WU       = 34.0;  // amplitude in WU
const THICK_WU     = 120.0; // trace thickness in WU
const FEATHER_WU   = 50.0;  // feather in WU
const BAND_WU      = 90.0;  // equator band cull in WU
const INK_STRENGTH = 1.0;   // 0..1
const PHASE_OFFSET = 90.0;  // radians (yes, your existing tween uses 90.0 as-is)

// ============================================================================
// Flying Faders (FF) — ABSOLUTE time keyframes in milliseconds (uses host `t`)
// ----------------------------------------------------------------------------
// Schema: [{ ms:<number>, v:<number>, ease?:<string> }, ...]
// Rules:
// - Between keyframes, we interpolate using the *starting* keyframe's ease.
// - Repeated ms values are allowed; the later keyframe “wins” (hard jump).
// - If you want to “turn off” automation for a param, set its array to null
//   (or []), and the manual constant above will be used.
//
// Supported eases (case-insensitive):
//   linear, smooth, inQuad, outQuad, inOutQuad, inCubic, outCubic, inOutCubic
// ============================================================================

// NEW (placed at top as requested). Default is 0 and (by default) does nothing.
const EQUATOR_BAND_OFFSET_WU_FF = [
  { ms:   0, v: -100.0, ease: "outCubic" },
  { ms:   1200, v: 10.0,ease: "inOutCubic"  },
  { ms:   3500, v: -20.0 },
];

// PRESERVED from your ripp (same values/timing/eases)
const CYCLES_FF = [
  { ms:   0, v: 1.0, ease: "inOutCubic" },
  { ms: 4000, v: 30.0 },
];

const PHASE_RATE_FF = [
  { ms:   0, v: 1.00, ease: "OutCubic" },
  { ms: 4000, v: 4.0 }
];

const AMP_WU_FF = [
  { ms:    0, v: 1.0, ease: "OutCubic" },
  { ms: 4000, v: 34.0 },
];

const THICK_WU_FF = [
  { ms:   0, v: .001, ease: "inCubic" },
  { ms: 4000, v: 180.0 },
];

const FEATHER_WU_FF = [
  { ms:   0, v: 10.0, ease: "smooth" },
  { ms: 4000, v: 50.0 }
];

const BAND_WU_FF = [
  { ms:   0, v: 0.10, ease: "linear" },
  { ms: 4000, v: 10.0 }
];

const INK_STRENGTH_FF = [
  { ms:   0, v: 0.0, ease: "linear" },
  { ms: 550, v: 1.0 }
];

const PHASE_OFFSET_FF = [
  { ms:   0, v: 0.0, ease: "linear" },
  { ms: 4000, v: 90.0 }
];

// ============================================================================
// Helpers
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

// automation cache (per-track search index + last time)
const _autoState = Object.create(null);

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

  posX = new Float32Array(IDS.length);
  posY = new Float32Array(IDS.length);
  posZ = new Float32Array(IDS.length);

  // init caches (track names are the stable keys for our evaluator)
  _autoState.bandOffsetWU = { idx: 0, lastMs: -Infinity };

  _autoState.cycles      = { idx: 0, lastMs: -Infinity };
  _autoState.phaseRate   = { idx: 0, lastMs: -Infinity };
  _autoState.ampWU       = { idx: 0, lastMs: -Infinity };
  _autoState.thickWU     = { idx: 0, lastMs: -Infinity };
  _autoState.featherWU   = { idx: 0, lastMs: -Infinity };
  _autoState.bandWU      = { idx: 0, lastMs: -Infinity };
  _autoState.inkStrength = { idx: 0, lastMs: -Infinity };
  _autoState.phaseOffset = { idx: 0, lastMs: -Infinity };
}

// ============================================================================
// Update
// ============================================================================
export function update(api, t/*s*/, dt/*s*/){
  // detect ID changes (hot reload / model swap)
  const newIDS = allTDLIds(api);
  if (newIDS.length !== IDS.length){
    IDS = newIDS;
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

  // --- Automation time (ABSOLUTE) ------------------------------------------
  let nowMs = (Number.isFinite(t) ? t : 0) * 1000;
  if (AUTO_LOOP){
    const m = Math.max(1, LOOP_MS|0);
    nowMs = ((nowMs % m) + m) % m;
  }

  // Evaluate params (automation overrides manual constants)
  const bandOffsetWU = getAuto("bandOffsetWU", EQUATOR_BAND_OFFSET_WU_FF, nowMs, EQUATOR_BAND_OFFSET_WU);

  const cycles      = Math.max(0, getAuto("cycles",      CYCLES_FF,        nowMs, CYCLES));
  const phaseRate   =          getAuto("phaseRate",   PHASE_RATE_FF,    nowMs, PHASE_RATE);
  const ampWU       =          getAuto("ampWU",       AMP_WU_FF,        nowMs, AMP_WU);

  const thickWU     = Math.max(0.0001, getAuto("thickWU",   THICK_WU_FF,    nowMs, THICK_WU));
  const featherWU   = Math.max(0.0,    getAuto("featherWU", FEATHER_WU_FF,  nowMs, FEATHER_WU));

  const bandBaseWU  = Math.max(thickWU + featherWU, getAuto("bandWU", BAND_WU_FF, nowMs, BAND_WU));

  const inkStrength = clamp01(getAuto("inkStrength", INK_STRENGTH_FF, nowMs, INK_STRENGTH));
  const phaseOffset =          getAuto("phaseOffset", PHASE_OFFSET_FF, nowMs, PHASE_OFFSET);

  // Phase time uses t directly (so host “speed%” affects this if it affects t)
  const timeS = Number.isFinite(t) ? t : 0;

  const changes = new Array(IDS.length);

  // NaN-safe band offset
  const bandOffset = Number.isFinite(bandOffsetWU) ? bandOffsetWU : 0;

  for (let i = 0; i < IDS.length; i++){
    const px = posX[i];
    if (!Number.isFinite(px)){
      changes[i] = { id: IDS[i], color: [1,1,1,1] };
      continue;
    }

    // world coords relative to dome center (WU)
    const dx = px - center.x;

    // shifted band space (y relative to a movable equator center)
    const dy = (posY[i] - center.y) - bandOffset;

    const dz = posZ[i] - center.z;

    // cull to shifted equator band
    if (Math.abs(dy) > bandBaseWU){
      changes[i] = { id: IDS[i], color: [1,1,1,1] };
      continue;
    }

    // longitude around equator [-pi..pi]
    const lon = Math.atan2(dz, dx) + phaseOffset;

    // phase 0..1
    const phase01 = fract((lon / TAU) + 0.5);

    // wave in Y (WU) in shifted space
    const wave = Math.sin(TAU * (phase01 * cycles + timeS * phaseRate));
    const yTargetWU = wave * ampWU;

    // distance from trace in WU (shifted space)
    const d = Math.abs(dy - yTargetWU);

    // soft line: 1 on line, 0 away
    const line = 1.0 - smoothstep(thickWU, thickWU + featherWU, d);

    // darken white canvas where line exists
    const ink = clamp01(line * inkStrength);
    const g = 1 - ink;

    changes[i] = { id: IDS[i], color: [g, g, g, 1] };
  }

  api.setColors(changes);
}

// ============================================================================
// Automation evaluator (absolute-time keyframes, forward cache + scrub safe)
// ============================================================================
function getAuto(trackName, keys, nowMs, fallback){
  const v = evalKF(trackName, keys, nowMs);
  return Number.isFinite(v) ? v : fallback;
}

function evalKF(trackName, keys, nowMs){
  if (!Array.isArray(keys) || keys.length === 0) return NaN;

  const st = _autoState[trackName] || (_autoState[trackName] = { idx: 0, lastMs: -Infinity });

  // clamp time before/after
  if (nowMs <= keys[0].ms) { st.idx = 0; st.lastMs = nowMs; return keys[0].v; }
  const last = keys[keys.length - 1];
  if (nowMs >= last.ms) { st.idx = Math.max(0, keys.length - 2); st.lastMs = nowMs; return last.v; }

  // scrub backwards -> binary search
  if (nowMs < st.lastMs){
    st.idx = findSegment(keys, nowMs);
  } else {
    // march forward
    let i = Math.max(0, Math.min(st.idx|0, keys.length - 2));
    while (i < keys.length - 2 && nowMs > keys[i+1].ms) i++;
    st.idx = i;
  }
  st.lastMs = nowMs;

  const k0 = keys[st.idx];
  const k1 = keys[st.idx + 1];

  const span = (k1.ms - k0.ms);

  // repeated-ms -> hard jump; later key wins
  if (!(span > 0)) return k1.v;

  let u = (nowMs - k0.ms) / span;
  u = u < 0 ? 0 : (u > 1 ? 1 : u);

  const uu = ease01(u, k0.ease);
  return lerp(k0.v, k1.v, uu);
}

function findSegment(keys, nowMs){
  let lo = 0, hi = keys.length - 2;
  while (lo <= hi){
    const mid = (lo + hi) >> 1;
    const a = keys[mid].ms, b = keys[mid+1].ms;
    if (nowMs < a) hi = mid - 1;
    else if (nowMs >= b) lo = mid + 1;
    else return mid;
  }
  return Math.max(0, Math.min(keys.length - 2, lo));
}

// ============================================================================
// Eases (case-insensitive; accepts OutCubic/InCubic/etc)
// ============================================================================
function ease01(u, easeName){
  const e = String(easeName || "linear").toLowerCase();

  if (e === "smooth" || e === "smoothstep") return u*u*(3 - 2*u);

  if (e === "inquad" || e === "in_quad") return u*u;
  if (e === "outquad" || e === "out_quad"){
    const t = 1 - u; return 1 - t*t;
  }
  if (e === "inoutquad" || e === "in_out_quad" || e === "inout_quad"){
    return u < 0.5 ? 2*u*u : 1 - Math.pow(-2*u + 2, 2) / 2;
  }

  if (e === "incubic" || e === "in_cubic") return u*u*u;
  if (e === "outcubic" || e === "out_cubic"){
    const t = 1 - u; return 1 - t*t*t;
  }
  if (e === "inoutcubic" || e === "in_out_cubic" || e === "inout_cubic"){
    return u < 0.5 ? 4*u*u*u : 1 - Math.pow(-2*u + 2, 3) / 2;
  }

  return u; // linear
}

// ============================================================================
// Utils
// ============================================================================
const TAU = Math.PI * 2;

function clamp01(x){ return x < 0 ? 0 : (x > 1 ? 1 : x); }
function lerp(a, b, t){ return a + (b - a) * t; }
function fract(x){ return x - Math.floor(x); }

function smoothstep(edge0, edge1, x){
  const t = clamp01((x - edge0) / Math.max(1e-6, (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
