// ripp—tdl-chladni-hello-world (WHITE CANVAS + BLACK NODES) + MASTER FADE + FF Tier1.js
// Preview contract: init(api), update(api, t, dt)
//
// Chladni-ish scalar field on the dome (lon/lat), rendered as nodal lines (F≈0).
// Tier-1 Flying Faders: NODE_COVERAGE, MODE_MIX, MODE1/2 (M,N).
// Master fade: forces everything to black after a given time.

export const meta = {
  name: "Cymatics (Chladni): Hello World + Tier1 FF + master fade",
  fps: 60,
  duration: 60
};

// ============================================================================
// MASTER FADE (ms)
// ============================================================================
const MASTER_FADE_START_MS    = 4500;
const MASTER_FADE_DURATION_MS = 5000; // 0 = instant

// ============================================================================
// FLYING FADERS (ms -> v with easing)
// - ease is applied for the segment ending at that keyframe.
// - duplicate ms = instantaneous jump.
// ============================================================================
const FF = {
  nodeCoverage: [
    { ms:    0, v: 0.00, ease: "inOutCubic" },
    { ms: 1000, v: 10.00 }
  ],

  modeMix: [
    { ms:    0, v: 0.00, ease: "inOutCubic" },
    { ms: 3000, v: 10.00 },
    { ms: 5000, v: 6.20, ease: "outCubic" }
  ],

  mode1M: [
    { ms:    0, v: 3.0, ease: "inOutCubic" },
    { ms: 7000, v: 3.0 }
  ],
  mode1N: [
    { ms:    0, v: 1.0, ease: "inOutCubic" },
    { ms: 8000, v: 4.0 }
  ],

  mode2M: [
    { ms:    0, v: 1.0, ease: "inOutCubic" },
    { ms: 9000, v: 5.0 }
  ],
  mode2N: [
    { ms:    0, v: 8.0, ease: "inOutCubic" },
    { ms: 10000, v: 12.0 }
  ],
};

// ============================================================================
// OTHER CONTROLS
// ============================================================================
const SPEED = 8.0;

const HARM_ENABLE = true;
const HARM_AMOUNT = 1.22;

const NODE_THICKNESS = 0.10;
const NODE_FEATHER   = 0.50;

const INK_STRENGTH   = 1.0;
const INVERT         = false;

const EQUATOR_BIAS   = 0.0;

const MOTION_MODE    = 2;   // 0 travel, 1 standing, 2 neutral
const TRAVEL_DIR     = -1;
const BREATH_AMOUNT  = 0.030;

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

let lonA = new Float32Array(0);
let latA = new Float32Array(0);

let changes = [];

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
  const tMs = t * 1000;

  // Tier-1 FF values
  const NODE_COVERAGE = clamp01(ff(FF.nodeCoverage, tMs, 1.0));
  const MODE_MIX      = clamp01(ff(FF.modeMix,      tMs, 0.5));
  const MODE1_M       = Math.max(0, ff(FF.mode1M, tMs, 3.0));
  const MODE1_N       = Math.max(0, ff(FF.mode1N, tMs, 1.0));
  const MODE2_M       = Math.max(0, ff(FF.mode2M, tMs, 1.0));
  const MODE2_N       = Math.max(0, ff(FF.mode2N, tMs, 8.0));

  const mix = MODE_MIX;
  const inkStr = clamp01(INK_STRENGTH);

  const thick   = Math.max(1e-6, NODE_THICKNESS);
  const feather = Math.max(0.0, NODE_FEATHER);

  // coverage scales the node window (reveal via thresholding)
  const s = NODE_COVERAGE * NODE_COVERAGE;
  const thickEff   = thick   * s;
  const featherEff = feather * s;

  const w1 = TAU * (0.18 * SPEED);
  const w2 = TAU * (0.11 * SPEED);
  const w3 = TAU * (0.07 * SPEED);

  const breath = 1.0 + BREATH_AMOUNT * Math.sin(TAU * (0.09 * SPEED) * t);

  const doTravel   = (MOTION_MODE === 0);
  const doStanding = (MOTION_MODE === 1);
  const doNeutral  = (MOTION_MODE === 2);

  const ph1_tr = (TRAVEL_DIR * w1) * t;
  const ph2_tr = (TRAVEL_DIR * w2) * t;
  const ph3_tr = (TRAVEL_DIR * w3) * t;

  const fadeProg = masterFadeProgress(tMs);

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
      const f1p = modeField(lon, lat, MODE1_M, MODE1_N,  w1*t,  w2*t);
      const f2p = modeField(lon, lat, MODE2_M, MODE2_N,  w2*t,  w3*t);
      let Fp = lerp(f1p, f2p, mix);

      if (HARM_ENABLE){
        const hm = Math.max(0, 0.5 * (MODE1_M + MODE2_M));
        const hn = Math.max(0, 0.5 * (MODE1_N + MODE2_N));
        const fhp = modeField(lon, lat, hm, hn,  w3*t,  w1*t);
        Fp += fhp * HARM_AMOUNT;
      }

      const f1m = modeField(lon, lat, MODE1_M, MODE1_N, -w1*t, -w2*t);
      const f2m = modeField(lon, lat, MODE2_M, MODE2_N, -w2*t, -w3*t);
      let Fm = lerp(f1m, f2m, mix);

      if (HARM_ENABLE){
        const hm = Math.max(0, 0.5 * (MODE1_M + MODE2_M));
        const hn = Math.max(0, 0.5 * (MODE1_N + MODE2_N));
        const fhm = modeField(lon, lat, hm, hn, -w3*t, -w1*t);
        Fm += fhm * HARM_AMOUNT;
      }

      F = 0.5 * (Fp + Fm);
      F *= breath;

    } else {
      const ph1 = doTravel ? ph1_tr : 0.0;
      const ph2 = doTravel ? ph2_tr : 0.0;
      const ph3 = doTravel ? ph3_tr : 0.0;

      const f1 = modeField(lon, lat, MODE1_M, MODE1_N, ph1, ph2);
      const f2 = modeField(lon, lat, MODE2_M, MODE2_N, ph2, ph3);

      F = lerp(f1, f2, mix);

      if (HARM_ENABLE){
        const hm = Math.max(0, 0.5 * (MODE1_M + MODE2_M));
        const hn = Math.max(0, 0.5 * (MODE1_N + MODE2_N));
        const fh = modeField(lon, lat, hm, hn, ph3, ph1);
        F += fh * HARM_AMOUNT;
      }

      if (doStanding) F *= breath;
    }

    if (EQUATOR_BIAS > 0){
      const eq = 1.0 - Math.abs(lat) / (Math.PI * 0.5);
      F *= lerp(1.0, eq, clamp01(EQUATOR_BIAS));
    }

    const d = Math.abs(F);
    const line = 1.0 - smoothstep(thickEff, thickEff + featherEff, d);

    const ink = clamp01(line * inkStr);
    const gBase = INVERT ? ink : (1 - ink);

    const g = gBase * (1 - fadeProg);

    c[0]=g; c[1]=g; c[2]=g; c[3]=1;
  }

  api.setColors(changes);
}

// ============================================================================
// Flying Fader eval
// ============================================================================
function ff(keys, tMs, fallback){
  if (!Array.isArray(keys) || keys.length === 0) return fallback;

  // find last key with ms <= tMs (favor later duplicates)
  let i0 = -1;
  for (let i = 0; i < keys.length; i++){
    const ms = keys[i]?.ms;
    if (Number.isFinite(ms) && ms <= tMs) i0 = i;
  }

  if (i0 < 0){
    const v0 = keys[0]?.v;
    return Number.isFinite(v0) ? v0 : fallback;
  }

  // exact time: return last duplicate at that ms
  const ms0 = keys[i0].ms;
  let j = i0;
  while (j + 1 < keys.length && keys[j + 1]?.ms === ms0) j++;
  if (ms0 === tMs){
    const v = keys[j]?.v;
    return Number.isFinite(v) ? v : fallback;
  }

  // next key with ms > ms0
  let i1 = -1;
  for (let i = j + 1; i < keys.length; i++){
    const ms = keys[i]?.ms;
    if (Number.isFinite(ms) && ms > ms0){ i1 = i; break; }
  }
  if (i1 < 0){
    const v = keys[j]?.v;
    return Number.isFinite(v) ? v : fallback;
  }

  const k0 = keys[j];
  const k1 = keys[i1];

  const v0 = Number.isFinite(k0?.v) ? k0.v : fallback;
  const v1 = Number.isFinite(k1?.v) ? k1.v : v0;

  const dt = Math.max(1e-6, (k1.ms - k0.ms));
  let u = clamp01((tMs - k0.ms) / dt);

  const easeName = (k1.ease || k0.ease || "linear");
  u = ease01(u, easeName);

  return lerp(v0, v1, u);
}

function ease01(u, name){
  const k = String(name || "linear").toLowerCase().replace(/[\s_-]/g, "");
  if (k === "incubic") return u*u*u;
  if (k === "outcubic"){ const a = 1 - u; return 1 - a*a*a; }
  if (k === "inoutcubic"){
    return (u < 0.5)
      ? 4*u*u*u
      : 1 - Math.pow(-2*u + 2, 3) / 2;
  }
  return u; // linear
}

// ============================================================================
// Master fade
// ============================================================================
function masterFadeProgress(tMs){
  if (!Number.isFinite(MASTER_FADE_START_MS)) return 0;
  if (tMs < MASTER_FADE_START_MS) return 0;

  const dur = Math.max(0, MASTER_FADE_DURATION_MS);
  if (dur <= 0) return 1;

  return clamp01((tMs - MASTER_FADE_START_MS) / dur);
}

// ============================================================================
// Position cache + lon/lat
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

    lonA[i] = Math.atan2(nz, nx);
    latA[i] = Math.asin(clamp1(ny));
  }
}

// ============================================================================
// Field + utils
// ============================================================================
function modeField(lon, lat, m, n, phA, phB){
  m = Math.max(0, +m);
  n = Math.max(0, +n);

  const a = Math.sin(m * lon + phA);
  const b = Math.cos(n * lat + phB);

  return (
    0.72 * a * b +
    0.28 *
      Math.sin((m + n) * lon * 0.5 + phB) *
      Math.sin((n + 1) * lat + phA)
  );
}

const TAU = Math.PI * 2;

function lerp(a, b, t){ return a + (b - a) * t; }
function clamp01(x){ return x < 0 ? 0 : (x > 1 ? 1 : x); }
function clamp1(x){ return x < -1 ? -1 : (x > 1 ? 1 : x); }

function smoothstep(edge0, edge1, x){
  const t = clamp01((x - edge0) / Math.max(1e-6, (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
