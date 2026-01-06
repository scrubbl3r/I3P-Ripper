// ripp—tdl-chladni-hello-world (WHITE CANVAS + BLACK NODES).js
// Preview contract: init(api), update(api, t, dt)
//
// Chladni-style “plate modes” adapted to the dome surface.
// - Uses spherical coordinates (lon/lat) per face centroid.
// - Builds a scalar mode field F(lon,lat,t) from a small set of modes.
// - Renders *nodes* (where F≈0) as black lines on a white dome.
// - STRICTLY t-based animation (no _simT).

export const meta = {
  name: "Cymatics (Chladni): Hello World (white dome, black nodal lines)",
  fps: 60,
  duration: 60
};

// ============================================================================
// Controls (hello-world knobs)
// ============================================================================

// Overall animation speed (phase drift of modes)
const SPEED = 2.;  // ---| 0 -> 1000?

// Two simple modes (integer-ish)
// Larger values = finer patterns
const MODE1_M = 2;   // around equator (lon)
const MODE1_N = 3;  // over latitude (lat)

const MODE2_M = 6;
const MODE2_N = 8;

// Blend between modes (0 = mode1 only, 1 = mode2 only)
const MODE_MIX = 0.50;

// Optional third harmonic sprinkle (subtle richness)
const HARM_ENABLE = true;
const HARM_AMOUNT = 1.22;

// Nodal line thickness & softness (in field-value units)
const NODE_THICKNESS = 0.50; // thicker = bolder lines ---||||| !!!!  MAIN LINE TRANSITION 0.1 -> 1.5
const NODE_FEATHER   = .70;  // soft edge around lines

// NEW: Coverage control (0..1)
// 0 = almost no nodes (white dome), 1 = lots of nodes (dense network)
// This drives an "emergent reveal" via threshold windowing (not opacity).
const NODE_COVERAGE = 1; // <-- start at 0, animate up to 1

// Contrast
const INK_STRENGTH   = 1;  // 0..1
const INVERT         = false; // false = black nodes on white

// Optional: bias toward equator (0 = off). Helps keep “plate” vibe if desired.
const EQUATOR_BIAS = 0; // try 0.25 later

// ============================================================================
// Motion mode toggle (tests 3 behaviors)
// 0 = Traveling (directional drift around Y)  [your current behavior]
// 1 = Standing (no drift; “breathing” only)
// 2 = Neutral (direction-cancels; symmetric wobble / no net rotation)
// ============================================================================
const MOTION_MODE = 2; // <-- set to 0/1/2 to test

// For mode 0 only: flip sign to reverse CW/CCW feel
const TRAVEL_DIR = -1; // +1 or -1

// For mode 1 & 2: how much “breathing” amplitude modulation (0..1-ish)
const BREATH_AMOUNT = .030;

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

// Precomputed spherical coords per face centroid
let lonA = new Float32Array(0); // [-pi..pi]
let latA = new Float32Array(0); // [-pi/2..pi/2]

// Stable, non-alloc render objects
let changes = [];

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
  buildLonLat();
}

function allocAll(){
  const N = IDS.length;

  posX = new Float32Array(N);
  posY = new Float32Array(N);
  posZ = new Float32Array(N);

  lonA = new Float32Array(N);
  latA = new Float32Array(N);

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
    buildLonLat();
  } else {
    cachePositions(api);
  }

  t = Number.isFinite(t) ? t : 0;

  const mix = clamp01(MODE_MIX);
  const inkStr = clamp01(INK_STRENGTH);

  const thick = Math.max(1e-6, NODE_THICKNESS);
  const feather = Math.max(0.0, NODE_FEATHER);

  // --- NEW: coverage -> effective node window ---
  // We want: coverage=0 => white dome (almost nothing qualifies as node)
  //          coverage=1 => lots of nodes
  // Map coverage to a field-value window size, then scale by NODE_THICKNESS.
  const cov = clamp01(NODE_COVERAGE);

    // Shape it (optional): gives nicer control near 0
    const s = cov * cov; // or cov*cov*cov for even slower “reveal” near zero

    const thickEff   = thick   * s;
    const featherEff = feather * s;


  // Base phase rates (your original)
  const w1 = TAU * (0.18 * SPEED);
  const w2 = TAU * (0.11 * SPEED);
  const w3 = TAU * (0.07 * SPEED);

  // Build phases according to the motion mode
  const breath = 1.0 + BREATH_AMOUNT * Math.sin(TAU * (0.09 * SPEED) * t);

  // Traveling (directional): phase shifts inside lon/lat terms -> drifting nodes
  const ph1_tr = (TRAVEL_DIR * w1) * t;
  const ph2_tr = (TRAVEL_DIR * w2) * t;
  const ph3_tr = (TRAVEL_DIR * w3) * t;

  // Standing: no phase drift; only amplitude breath applied outside
  const ph1_st = 0.0;
  const ph2_st = 0.0;
  const ph3_st = 0.0;

  // Neutral: cancel drift by summing +phase and -phase (counter-propagating)
  const doTravel   = (MOTION_MODE === 0);
  const doStanding = (MOTION_MODE === 1);
  const doNeutral  = (MOTION_MODE === 2);

  const N = IDS.length;

  for (let i = 0; i < N; i++){
    const c = changes[i].color;

    if (!Number.isFinite(posX[i])){
      c[0]=1; c[1]=1; c[2]=1; c[3]=1;
      continue;
    }

    const lon = lonA[i];
    const lat = latA[i];

    let F;

    if (doNeutral){
      // + drift
      const f1p = modeField(lon, lat, MODE1_M, MODE1_N,  w1*t,  w2*t);
      const f2p = modeField(lon, lat, MODE2_M, MODE2_N,  w2*t,  w3*t);
      let Fp = lerp(f1p, f2p, mix);

      if (HARM_ENABLE){
        const hm = Math.max(1, (MODE1_M + MODE2_M) >> 1);
        const hn = Math.max(1, (MODE1_N + MODE2_N) >> 1);
        const fhp = modeField(lon, lat, hm, hn,  w3*t,  w1*t);
        Fp += fhp * HARM_AMOUNT;
      }

      // - drift
      const f1m = modeField(lon, lat, MODE1_M, MODE1_N, -w1*t, -w2*t);
      const f2m = modeField(lon, lat, MODE2_M, MODE2_N, -w2*t, -w3*t);
      let Fm = lerp(f1m, f2m, mix);

      if (HARM_ENABLE){
        const hm = Math.max(1, (MODE1_M + MODE2_M) >> 1);
        const hn = Math.max(1, (MODE1_N + MODE2_N) >> 1);
        const fhm = modeField(lon, lat, hm, hn, -w3*t, -w1*t);
        Fm += fhm * HARM_AMOUNT;
      }

      // cancel direction
      F = 0.5 * (Fp + Fm);

      // gentle breath
      F *= breath;

    } else {
      const ph1 = doTravel ? ph1_tr : ph1_st;
      const ph2 = doTravel ? ph2_tr : ph2_st;
      const ph3 = doTravel ? ph3_tr : ph3_st;

      const f1 = modeField(lon, lat, MODE1_M, MODE1_N, ph1, ph2);
      const f2 = modeField(lon, lat, MODE2_M, MODE2_N, ph2, ph3);

      F = lerp(f1, f2, mix);

      if (HARM_ENABLE){
        const hm = Math.max(1, (MODE1_M + MODE2_M) >> 1);
        const hn = Math.max(1, (MODE1_N + MODE2_N) >> 1);
        const fh = modeField(lon, lat, hm, hn, ph3, ph1);
        F += fh * HARM_AMOUNT;
      }

      // Standing: apply breath outside the field so nodes don't drift.
      if (doStanding){
        F *= breath;
      }
    }

    // Optional equator emphasis (more “plate” vibe)
    if (EQUATOR_BIAS > 0){
      const eq = 1.0 - Math.abs(lat) / (Math.PI * 0.5); // 1 at equator, 0 at poles
      F *= lerp(1.0, eq, clamp01(EQUATOR_BIAS));
    }

    // --- Render nodes: black where |F| is small ------------------------------
    const d = Math.abs(F);

    // NOTE: uses thickEff so coverage gives a true “white -> reveal” ramp
    const line = 1.0 - smoothstep(thickEff, thickEff + featherEff, d);

    const ink = clamp01(line * inkStr);
    const g = INVERT ? ink : (1 - ink);

    c[0]=g; c[1]=g; c[2]=g; c[3]=1;
  }

  api.setColors(changes);
}

// ============================================================================
// Cache positions + spherical coords
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

    lonA[i] = Math.atan2(nz, nx);        // [-pi..pi]
    latA[i] = Math.asin(clamp1(ny));     // [-pi/2..pi/2]
  }
}

// ============================================================================
// “Mode” field (simple nodal structure)
// ============================================================================
function modeField(lon, lat, m, n, phA, phB){
  m = Math.max(0, (m|0));
  n = Math.max(0, (n|0));

  const a = Math.sin(m * lon + phA);
  const b = Math.cos(n * lat + phB);

  const F =
    0.72 * a * b +
    0.28 *
      Math.sin((m + n) * lon * 0.5 + phB) *
      Math.sin((n + 1) * lat + phA);

  return F;
}

// ============================================================================
// Utils
// ============================================================================
const TAU = Math.PI * 2;

function lerp(a, b, t){ return a + (b - a) * t; }
function clamp01(x){ return x < 0 ? 0 : (x > 1 ? 1 : x); }
function clamp1(x){ return x < -1 ? -1 : (x > 1 ? 1 : x); }

function smoothstep(edge0, edge1, x){
  const t = clamp01((x - edge0) / Math.max(1e-6, (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
