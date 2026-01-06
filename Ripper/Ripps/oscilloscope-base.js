// ripp—tdl-oscilloscope-equator-helloworld (WHITE CANVAS + BLACK TRACE, BAND OFFSET).js
// Preview contract: init(api), update(api, t, dt)
//
// NEW: EQUATOR_BAND_OFFSET shifts the oscilloscope band up/down in dome-normalized Y.
// - 0.0 = centered on true equator (center.y)
// - +0.1 = band centered above equator
// - -0.1 = band centered below equator
//
// This affects BOTH the band cull and the trace placement, so the whole scope “lives”
// on that shifted latitude.

export const meta = {
  name: "Oscilloscope (equator wrap): Hello World — band offset (white dome, black trace)",
  fps: 60,
  duration: 60
};

// ============================================================================
// Controls (simple “hello world” knobs)
// ============================================================================

// How fast the waveform animates (phase scroll). Higher = faster.
const SCOPE_SPEED = 10.85;

// Number of sine cycles around the equator (integer-ish looks nicest).
const SCOPE_CYCLES = 4.0;

// Wave amplitude in *dome-normalized* Y (0..~0.3 is sane).
// 0.12 means the wave swings ±12% of dome radius above/below equator.
const SCOPE_AMPLITUDE = 0.55;

// Thickness of the trace in dome-normalized Y.
// Smaller = thinner line.
const SCOPE_THICKNESS = 0.02;

// Additional soft edge to avoid harsh aliasing.
const SCOPE_FEATHER = 0.10;

// How wide of an “equator band” we consider (performance + style).
// If too small, you’ll clip the wave at peaks.
const EQUATOR_BAND = 0.60;

// NEW: shift the whole oscilloscope band up/down (dome-normalized Y units)
const EQUATOR_BAND_OFFSET = 0.0; // try -0.20 .. +0.20

// Darkness of the ink (0..1)
const INK_STRENGTH = 1;

// Optional: rotate where “0 phase” starts around the dome
const PHASE_OFFSET = 0.0; // radians

// ============================================================================
// Helpers (schema kept from your caustics ripp)
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

let _simT = 0;

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

  _simT = 0;
}

export function update(api, t/*s*/, dt/*s*/){
  // dt-stable sim time
  dt = Number.isFinite(dt) ? dt : 0;
  if (dt < 0) dt = 0;
  _simT += dt * SCOPE_SPEED;

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

  const invR = 1 / Math.max(1e-6, domeR);
  const changes = new Array(IDS.length);

  // Precompute
  const cycles = Math.max(0.0, SCOPE_CYCLES);
  const amp    = clamp01ish(SCOPE_AMPLITUDE);
  const thick  = Math.max(1e-6, SCOPE_THICKNESS);
  const feather= Math.max(0.0, SCOPE_FEATHER);
  const band   = Math.max(thick + feather, EQUATOR_BAND);
  const inkStr = clamp01(INK_STRENGTH);

  // NEW: band center (normalized Y) where the scope “lives”
  const bandCenterY = Number.isFinite(EQUATOR_BAND_OFFSET) ? EQUATOR_BAND_OFFSET : 0;

  for (let i = 0; i < IDS.length; i++){
    const px = posX[i];
    if (!Number.isFinite(px)){
      changes[i] = { id: IDS[i], color: [1,1,1,1] };
      continue;
    }

    // dome-normalized space
    const nx = (px - center.x) * invR;
    const ny = (posY[i] - center.y) * invR;
    const nz = (posZ[i] - center.z) * invR;

    // Shifted Y relative to band center
    const nyRel = ny - bandCenterY;

    // Quick cull: only process a band around the shifted “equator” (nyRel≈0)
    if (Math.abs(nyRel) > band){
      changes[i] = { id: IDS[i], color: [1,1,1,1] };
      continue;
    }

    // Longitude around the equator: atan2(z, x) gives [-pi..pi]
    const lon = Math.atan2(nz, nx) + PHASE_OFFSET;

    // Phase 0..1 (wrap-safe)
    const phase01 = fract((lon / TAU) + 0.5);

    // Oscilloscope trace in RELATIVE band space (nyRel)
    const wave = Math.sin(TAU * (phase01 * cycles + _simT * 0.25));
    const yTargetRel = wave * amp;

    // Distance from trace (in normalized Y, in shifted band space)
    const d = Math.abs(nyRel - yTargetRel);

    // Anti-aliased line
    const line = 1.0 - smoothstep(thick, thick + feather, d);

    // Ink on white
    const ink = clamp01(line * inkStr);
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
function fract(x){ return x - Math.floor(x); }

// A slightly looser clamp for amplitude so you can push it later without rewriting;
// for hello-world we keep it in a sane range (0..0.45).
function clamp01ish(x){
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 0.45) return 0.45;
  return x;
}

function smoothstep(edge0, edge1, x){
  const t = clamp01((x - edge0) / Math.max(1e-6, (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
