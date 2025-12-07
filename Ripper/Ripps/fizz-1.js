// ripp—tdl-layered-ink-black-guided-bubblepatch (BOTTOM→TOP + global bubble patch + ENDGAME SNIPER + RAMPED PARAMS + GLOBAL FADE).js
// Preview contract: init(api), update(api, t, dt)

export const meta = {
  name: 'Layered Ink (guided): Bottom→Top (monoblack) + Bubble Patch + Endgame Sniper + Time Ramps + Global Fade',
  fps: 60,
  duration: 30
};

// ============================================================================
// TIME-RAMPED “SILVER BULLET” CONTROLS
// - Each has: start, end, secs (transition duration), (optional) startAt
// - Uses smoothstep easing by default.
// ============================================================================

// Sphere diameter min (WU)
const RAMP_SPHERE_DIAMETER_MIN = {
  start: 10.0,
  end:   25.0,
  secs:  2.0,
  startAt: 0.0
};

// Sphere diameter max (WU)
const RAMP_SPHERE_DIAMETER_MAX = {
  start: 35.0,
  end:   60.0,
  secs:  5.0,
  startAt: 0.0
};

// Emit period (ms) — LOWER = more spheres
const RAMP_EMIT_PERIOD_MS = {
  start: 20.0,
  end:   3.0,
  secs:  2.0,
  startAt: 0.0
};

// hard safety clamps (prevents accidental “infinite spawn”)
const EMIT_PERIOD_MIN_MS = 3.0;
const EMIT_PERIOD_MAX_MS = 2000.0;

// ============================================================================
// GLOBAL FADE TO BLACK (NEW)
// - Starts at startAt, ends at endAt.
// - Multiplies ALL current paint brightness toward black over time.
// - This is a true whole-dome fade: it updates every panel each frame during fade.
// ============================================================================
const GLOBAL_FADE_TO_BLACK = {
  startAt: 1.2,  // <- begin fade at this time (seconds)
  endAt:   2.5   // <- fully black by this time (seconds)
};

// ---- Movement --------------------------------------------------------------
const START_FRAC_MIN   = 0.95; // near bottom
const START_FRAC_MAX   = 0.95;

// Geometric acceleration stabilized vs dt using a reference FPS.
const FPS_REF          = meta.fps || 60;
const STEP_INIT        = 0.01;
const ACCEL            = 1.03;
const STEP_MAX         = 0.1;
const SPEED_SCALE      = 0.3;

// ---- Layering --------------------------------------------------------------
const INK_ALPHA_BASE   = 0.50;
const INK_ALPHA_MAX    = 0.76;
const STACK_MODE       = 'over'; // base mode (we “slam” in endgame)

// “Done” threshold
const DONE_INK         = 0.90;
const DONE_G_MAX       = Math.round((1 - DONE_INK) * 255); // <= 5 is “done”

// ---- Coverage guidance -----------------------------------------------------
const BIN_COUNT        = 128;
const RNG_SPAWN_PROB   = 0.01;
const BIAS_POW_MIN     = 15.25;
const BIAS_POW_MAX     = 25.50;
const BIN_JITTER_FRAC  = 0.22;
const EPS_WEIGHT       = 1e-3;

// Catch-up behavior
const CATCHUP_START_FRAC = 0.60;
const BEHIND_WINDOW      = 0.22;

// GC / perf controls
const MAX_LIVE_SPHERES = 600;
const S_CULL_OVER      = 1.02;

// ============================================================================
// ENDGAME SNIPER
// ============================================================================
const SNIPER_ENABLE = false;
const SNIPER_START_DONEFRAC = 0.95;
const SNIPER_SPAWN_PROB = 0.90;

const SNIPER_S_OFFSET = 0.035;
const SNIPER_RADIUS_SCALE = 1.55;
const SNIPER_SWAY_SCALE = 0.18;
const SNIPER_AZ_JITTER_FRAC = 0.06;

const ENDGAME_STACK_SWITCH_DONEFRAC = 0.92;
const ENDGAME_LINEAR_GAIN = 1.25;

// ---- Bubble motion presets -------------------------------------------------
const BUBBLE_PRESETS = [
  {
    name: 'D: Tornado Roll (violent tumble, mild sway)',
    swayAmpWU: 10,    swayAmpWU2: 6,
    swayHz: 0.55,     swayHz2: 0.8,
    swayShape: 1.1,
    radiusPulseAmp: 0.10, radiusPulseHz: 0.9,
    squashAmp: 1.10,  squashHz: 1.05, squashYZ: 0.12,
    tumbleRate: 14.0, tumbleJitterAmp: 2.2, tumbleJitterHz: 1.6
  },
  {
    name: 'F: Heartbeat Blob (big breathing + modest drift)',
    swayAmpWU: 12,   swayAmpWU2: 7,
    swayHz: 0.14,    swayHz2: 0.19,
    swayShape: 2.0,
    radiusPulseAmp: 0.65, radiusPulseHz: 0.90,
    squashAmp: 0.25, squashHz: 0.45, squashYZ: 0.85,
    tumbleRate: 0.40, tumbleJitterAmp: 0.18, tumbleJitterHz: 0.22
  },
  {
    name: 'H: Shepard Drift (two-speed interference)',
    swayAmpWU: 45,   swayAmpWU2: 28,
    swayHz: 0.17,    swayHz2: 0.173,
    swayShape: 1.3,
    radiusPulseAmp: 0.09, radiusPulseHz: 0.21,
    squashAmp: 0.80, squashHz: 0.19, squashYZ: 0.30,
    tumbleRate: 0.95, tumbleJitterAmp: 0.35, tumbleJitterHz: 0.23
  },
  {
    name: 'V: Nervous Minnow (micro-sway, twitchy jitter)',
    swayAmpWU: 9,    swayAmpWU2: 5,
    swayHz: 7.2,     swayHz2: 11.5,
    swayShape: 0.55,
    radiusPulseAmp: 0.10, radiusPulseHz: 20.0,
    squashAmp: 0.60, squashHz: 14.0, squashYZ: 0.35,
    tumbleRate: 14.0, tumbleJitterAmp: 7.5, tumbleJitterHz: 18.0
  },
  {
    name: 'AF: Geiger Pop (tiny motion + sharp jitter spikes)',
    swayAmpWU: 8,    swayAmpWU2: 5,
    swayHz: 4.8,     swayHz2: 9.3,
    swayShape: 0.25,
    radiusPulseAmp: 0.22, radiusPulseHz: 16.0,
    squashAmp: 0.85, squashHz: 18.0, squashYZ: 0.20,
    tumbleRate: 20.0, tumbleJitterAmp: 12.0, tumbleJitterHz: 20.0
  },
];

// ---------------------------------------------------------------------------
// GLOBAL PATCH SELECT (all spheres use the same patch)
// ---------------------------------------------------------------------------
const ACTIVE_BUBBLE_PATCH_NAME = 'V: Nervous Minnow (micro-sway, twitchy jitter)';

let ACTIVE_BUBBLE_PATCH = null;
function resolveBubblePatch(){
  if (ACTIVE_BUBBLE_PATCH) return ACTIVE_BUBBLE_PATCH;
  const hit = BUBBLE_PRESETS.find(p => p.name === ACTIVE_BUBBLE_PATCH_NAME);
  ACTIVE_BUBBLE_PATCH = hit || BUBBLE_PRESETS[3];
  return ACTIVE_BUBBLE_PATCH;
}

// ---- Helpers ---------------------------------------------------------------
const TAU = Math.PI * 2;

function allTDLIds(api){
  const T = Array.isArray(api?.ids?.T) ? api.ids.T : [];
  const D = Array.isArray(api?.ids?.D) ? api.ids.D : [];
  const L = Array.isArray(api?.ids?.L) ? api.ids.L : [];
  return [...new Set([...T, ...D, ...L])];
}
function randIn(min,max){ return min + Math.random()*(max-min); }
function clamp01(x){ return x < 0 ? 0 : (x > 1 ? 1 : x); }
function smoothstep(e0, e1, x){
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
function wrapRad(a){
  a = a % TAU;
  return a < 0 ? a + TAU : a;
}
function signedPow(x, p){
  const ax = Math.abs(x);
  const y = Math.pow(ax, p);
  return x < 0 ? -y : y;
}

function lerp(a,b,t){ return a + (b - a) * t; }

function rampValue(t, spec){
  const startAt = Number.isFinite(spec?.startAt) ? spec.startAt : 0;
  const secs = Math.max(1e-6, Number(spec?.secs ?? 0));
  const u = clamp01((t - startAt) / secs);
  const e = u * u * (3 - 2 * u); // smoothstep
  return lerp(Number(spec.start), Number(spec.end), e);
}

// NEW: 1 = no fade, 0 = fully black
function globalFadeMul(t){
  const s = Number(GLOBAL_FADE_TO_BLACK?.startAt ?? Infinity);
  const e = Number(GLOBAL_FADE_TO_BLACK?.endAt ?? Infinity);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return 1.0;
  if (t <= s) return 1.0;
  if (t >= e) return 0.0;
  const f = smoothstep(s, e, t); // 0..1
  return 1.0 - f;
}

function need01FromG(gByte){
  return Math.max(0, (gByte - DONE_G_MAX) / 255);
}

function sFromPointY(py){
  const u = (py - center.y) / Math.max(1e-6, domeR);
  const theta = Math.asin(Math.max(-1, Math.min(1, u)));
  return clamp01((Math.PI/2 - theta) / Math.PI);
}

// Dynamic stack (endgame slam)
function stackInkDynamic(aOld, inkAlpha, doneFrac){
  if (SNIPER_ENABLE && doneFrac >= ENDGAME_STACK_SWITCH_DONEFRAC){
    return Math.min(1, aOld + inkAlpha * ENDGAME_LINEAR_GAIN);
  }
  if (STACK_MODE === 'linear'){
    return Math.min(1, aOld + inkAlpha);
  }
  return 1 - (1 - aOld) * (1 - inkAlpha);
}

function posOnMeridianAz(center, domeR, s, az){
  const theta = Math.PI/2 - Math.PI * s;
  const y = center.y + domeR * Math.sin(theta);
  const rHor = domeR * Math.cos(theta);
  const x = center.x + rHor * Math.sin(az);
  const z = center.z + rHor * Math.cos(az);
  return { x, y, z, theta };
}

function azOfPoint(center, p){
  const dx = p.x - center.x;
  const dz = p.z - center.z;
  return wrapRad(Math.atan2(dx, dz));
}

function tangentsAt(az, theta){
  const sinAz = Math.sin(az);
  const cosAz = Math.cos(az);

  const tAz = { x: cosAz, y: 0, z: -sinAz };

  const tx = -Math.sin(theta) * sinAz;
  const ty =  Math.cos(theta);
  const tz = -Math.sin(theta) * cosAz;
  const len = Math.hypot(tx, ty, tz) || 1;
  const tMer = { x: tx/len, y: ty/len, z: tz/len };

  return { tAz, tMer };
}

// ---- State -----------------------------------------------------------------
let IDS = [];
let IDS_SET = new Set();
let center = {x:0,y:0,z:0};
let domeR = 250;
let emitAccMs = 0;

let posX = new Float32Array(0);
let posY = new Float32Array(0);
let posZ = new Float32Array(0);

let idBinIdx = new Uint16Array(0);
let binCount = new Uint32Array(BIN_COUNT);
let binNeedSum = new Float32Array(BIN_COUNT);

const spheres = [];
let needFirstSpawnAtNow = true;

const paintedG = new Map();
let doneCount = 0;

let targetIdx = -1;
let targetAz = 0;
let targetS  = 0.5;

// NEW: track last fade so we can do full-refresh updates only when needed
let _lastGlobalFadeMul = 1.0;

// ---- Lifecycle -------------------------------------------------------------
export function init(api){
  IDS = allTDLIds(api);
  IDS_SET = new Set(IDS);

  api.resetColorsTo([1,1,1,1]);

  if (api.info && Number.isFinite(api.info.radius)) domeR = api.info.radius;
  if (api.info && api.info.center) {
    center = {
      x: api.info.center.x || 0,
      y: api.info.center.y || 0,
      z: api.info.center.z || 0
    };
  }

  posX = new Float32Array(IDS.length);
  posY = new Float32Array(IDS.length);
  posZ = new Float32Array(IDS.length);

  spheres.length = 0;
  emitAccMs = 0;
  needFirstSpawnAtNow = true;

  paintedG.clear();
  doneCount = 0;

  rebuildBins(api);

  ACTIVE_BUBBLE_PATCH = null;
  resolveBubblePatch();

  targetIdx = -1; targetAz = 0; targetS = 0.5;

  _lastGlobalFadeMul = 1.0;
}

export function update(api, t/*s*/, dt/*s*/){
  const dtMs = Math.max(0, dt * 1000);

  // dynamic ramped params evaluated ONCE per frame
  let diamMinWU = rampValue(t, RAMP_SPHERE_DIAMETER_MIN);
  let diamMaxWU = rampValue(t, RAMP_SPHERE_DIAMETER_MAX);
  if (!Number.isFinite(diamMinWU)) diamMinWU = 25;
  if (!Number.isFinite(diamMaxWU)) diamMaxWU = 35;
  if (diamMinWU > diamMaxWU){
    const tmp = diamMinWU; diamMinWU = diamMaxWU; diamMaxWU = tmp;
  }

  let emitPeriodMs = rampValue(t, RAMP_EMIT_PERIOD_MS);
  if (!Number.isFinite(emitPeriodMs)) emitPeriodMs = 40;
  emitPeriodMs = Math.max(EMIT_PERIOD_MIN_MS, Math.min(EMIT_PERIOD_MAX_MS, emitPeriodMs));

  // detect ID changes
  const newIDS = allTDLIds(api);
  if (newIDS.length !== IDS.length){
    IDS = newIDS;
    IDS_SET = new Set(IDS);

    posX = new Float32Array(IDS.length);
    posY = new Float32Array(IDS.length);
    posZ = new Float32Array(IDS.length);

    for (const key of paintedG.keys()){
      if (!IDS_SET.has(key)) paintedG.delete(key);
    }

    rebuildBins(api);
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

  // update target (for sniper)
  updateTargetIndex();

  if (needFirstSpawnAtNow){
    spawnOne(api, t, false, diamMinWU, diamMaxWU);
    needFirstSpawnAtNow = false;
  }

  // spawn cadence (ramped)
  emitAccMs += dtMs;
  while (emitAccMs >= emitPeriodMs){
    emitAccMs -= emitPeriodMs;
    spawnOne(api, t, false, diamMinWU, diamMaxWU);
  }

  // advance spheres
  if (spheres.length){
    const frames = dt * FPS_REF;
    const accelMul = frames > 0 ? Math.pow(ACCEL, frames) : 1;

    for (let i = spheres.length - 1; i >= 0; i--){
      const d = spheres[i];

      if (!Number.isFinite(d.s) || !Number.isFinite(d.step) || !Number.isFinite(d.radiusWU)){
        spheres.splice(i, 1);
        continue;
      }

      d.step = Math.min(STEP_MAX, d.step * accelMul);
      if (d.step <= 0){
        spheres.splice(i, 1);
        continue;
      }

      d.s -= (d.step * frames * SPEED_SCALE);

      if (d.s <= 0 || d.s < -S_CULL_OVER){
        spheres.splice(i, 1);
      }
    }
  }

  paint(api, t);
}

// ---- Endgame target selection ----------------------------------------------
function updateTargetIndex(){
  if (!SNIPER_ENABLE) return;

  const total = Math.max(1, IDS.length);
  const doneFrac = doneCount / total;
  if (doneFrac < SNIPER_START_DONEFRAC){
    targetIdx = -1;
    return;
  }

  let bestNeed = 0;
  let bestIdx = -1;

  for (let i = 0; i < IDS.length; i++){
    const id = IDS[i];
    const g = paintedG.get(id) ?? 255;
    if (g <= DONE_G_MAX) continue;

    const n = need01FromG(g);
    if (n > bestNeed){
      bestNeed = n;
      bestIdx = i;
    }
  }

  targetIdx = bestIdx;
  if (bestIdx >= 0){
    const px = posX[bestIdx], py = posY[bestIdx], pz = posZ[bestIdx];
    if (Number.isFinite(px) && Number.isFinite(py) && Number.isFinite(pz)){
      targetAz = wrapRad(Math.atan2(px - center.x, pz - center.z));
      targetS = sFromPointY(py);
    }
  }
}

// ---- Coverage guidance -----------------------------------------------------
function rebuildBins(api){
  idBinIdx = new Uint16Array(IDS.length);
  binCount = new Uint32Array(BIN_COUNT);
  binNeedSum = new Float32Array(BIN_COUNT);

  doneCount = 0;

  for (let i = 0; i < IDS.length; i++){
    const id = IDS[i];
    const p = api.posOf(id);
    const az = (p && Number.isFinite(p.x)) ? azOfPoint(center, p) : 0;

    const bw = TAU / BIN_COUNT;
    const b = Math.min(BIN_COUNT - 1, Math.max(0, Math.floor(az / bw)));
    idBinIdx[i] = b;
    binCount[b]++;

    const g = paintedG.get(id) ?? 255;
    binNeedSum[b] += need01FromG(g);
    if (g <= DONE_G_MAX) doneCount++;
  }
}

function chooseGuidedAz(t){
  const bw = TAU / BIN_COUNT;

  if (Math.random() < RNG_SPAWN_PROB){
    return Math.random() * TAU;
  }

  const dur = Math.max(0.001, meta.duration || 1);
  const progress = clamp01(t / dur);

  const total = Math.max(1, IDS.length);
  const doneFrac = doneCount / total;
  const soften = smoothstep(0.90, 0.995, doneFrac);

  const biasPowBase = BIAS_POW_MIN + (BIAS_POW_MAX - BIAS_POW_MIN) * progress;
  const biasPow = biasPowBase * (1 - 0.85 * soften) + 0.6 * soften;

  let totalW = 0;
  const wArr = new Float32Array(BIN_COUNT);

  for (let b = 0; b < BIN_COUNT; b++){
    const avgNeed = binNeedSum[b] / Math.max(1, binCount[b]);
    let w = Math.pow(avgNeed + EPS_WEIGHT, biasPow);

    if (soften > 0){
      if (avgNeed > 0) w = Math.max(w, 0.015 * soften);
    }

    wArr[b] = w;
    totalW += w;
  }

  if (!(totalW > 0)){
    return Math.random() * TAU;
  }

  let r = Math.random() * totalW;
  let chosen = 0;
  for (let b = 0; b < BIN_COUNT; b++){
    r -= wArr[b];
    if (r <= 0){
      chosen = b;
      break;
    }
  }

  const binStart = chosen * bw;
  let az = binStart + (Math.random() * bw);

  const jitter = (Math.random() - 0.5) * bw * BIN_JITTER_FRAC;
  az = wrapRad(az + jitter);

  return az;
}

// ---- Spawn -----------------------------------------------------------------
function spawnOne(api, t, forceSniper, diamMinWU, diamMaxWU){
  if (spheres.length >= MAX_LIVE_SPHERES) return;

  const total = Math.max(1, IDS.length);
  const doneFrac = doneCount / total;
  const endgame = SNIPER_ENABLE && doneFrac >= SNIPER_START_DONEFRAC;

  const useSniper = forceSniper || (endgame && targetIdx >= 0 && Math.random() < SNIPER_SPAWN_PROB);

  let s0, az, radiusScale = 1.0, sniper = false;

  if (useSniper && targetIdx >= 0){
    const bw = TAU / BIN_COUNT;
    const tight = bw * SNIPER_AZ_JITTER_FRAC;
    az = wrapRad(targetAz + (Math.random() - 0.5) * tight);

    s0 = clamp01(targetS + SNIPER_S_OFFSET);

    radiusScale = SNIPER_RADIUS_SCALE;
    sniper = true;
  } else {
    s0 = randIn(START_FRAC_MIN, START_FRAC_MAX);
    az = chooseGuidedAz(t);
  }

  const diamWU  = randIn(diamMinWU, diamMaxWU) * radiusScale;
  const radiusWU = diamWU * 0.5;

  const seed = Math.random() * 1e9;
  const phaseA = Math.random() * TAU;
  const phaseB = Math.random() * TAU;
  const phaseC = Math.random() * TAU;

  spheres.push({
    s: s0,
    step: STEP_INIT,
    az,
    radiusWU,
    r2: radiusWU * radiusWU,
    seed, phaseA, phaseB, phaseC,
    sniper
  });
}

// ---- Ink alpha + bubble field ----------------------------------------------
function computeInkAlpha(t){
  const total = Math.max(1, IDS.length);
  const doneFrac = doneCount / total;

  const dur = Math.max(0.001, meta.duration || 1);
  const target = clamp01(t / dur);

  const lateRamp = smoothstep(CATCHUP_START_FRAC, 1.0, target);
  const behind = clamp01((target - doneFrac) / BEHIND_WINDOW);
  const boost = behind * lateRamp;

  const fin = smoothstep(0.90, 0.995, doneFrac);

  let a = INK_ALPHA_BASE + (INK_ALPHA_MAX - INK_ALPHA_BASE) * boost;
  a = a + (1 - a) * (0.55 * fin);

  return a;
}

function bubbleFieldForSphere(d, t){
  const P = resolveBubblePatch();

  const w1 = Math.sin((t * P.swayHz  * TAU) + d.phaseA);
  const w2 = Math.sin((t * P.swayHz2 * TAU) + d.phaseB);

  const shaped1 = (P.swayShape && P.swayShape !== 1) ? signedPow(w1, P.swayShape) : w1;
  const shaped2 = (P.swayShape && P.swayShape !== 1) ? signedPow(w2, P.swayShape) : w2;

  const swayScale = d.sniper ? SNIPER_SWAY_SCALE : 1.0;

  const offAz  = (P.swayAmpWU  || 0) * shaped1 * swayScale;
  const offMer = (P.swayAmpWU2 || 0) * shaped2 * swayScale;

  const radPulse = 1 + (P.radiusPulseAmp || 0) * Math.sin((t * (P.radiusPulseHz || 0.25) * TAU) + d.phaseC);

  const sq = (P.squashAmp || 0) * Math.sin((t * (P.squashHz || 0.4) * TAU) + d.phaseB);
  const squashYZ = (Number.isFinite(P.squashYZ) ? P.squashYZ : 0.8);

  const rxMul = radPulse * (1 + sq);
  const rzMul = radPulse * (1 - sq);
  const ryMul = radPulse * (1 - sq * squashYZ);

  const baseYaw = (d.seed * 1e-9) * TAU;
  const yawJit = (P.tumbleJitterAmp || 0) * (d.sniper ? 0.35 : 1.0);

  const yaw = baseYaw
    + (P.tumbleRate || 0) * t
    + yawJit * Math.sin((t * (P.tumbleJitterHz || 0.2) * TAU) + d.phaseA);

  return { offAz, offMer, rxMul, ryMul, rzMul, yaw };
}

// ---- Paint -----------------------------------------------------------------
function paint(api, t){
  const changes = [];
  const inkAlpha = computeInkAlpha(t);

  const total = Math.max(1, IDS.length);
  const doneFrac = doneCount / total;

  // NEW: global fade multiplier (1..0). If it changes, we do a full-dome refresh.
  const fadeMul = globalFadeMul(t);
  const fullRefresh = Math.abs(fadeMul - _lastGlobalFadeMul) > 1e-6;

  for (let si = 0; si < spheres.length; si++){
    const d = spheres[si];
    const sClamped = d.s < 0 ? 0 : (d.s > 1 ? 1 : d.s);

    const base = posOnMeridianAz(center, domeR, sClamped, d.az);
    let cx = base.x, cy = base.y, cz = base.z;

    const { tAz, tMer } = tangentsAt(d.az, base.theta);
    const bf = bubbleFieldForSphere(d, t);

    cx += tAz.x  * bf.offAz  + tMer.x * bf.offMer;
    cy += tAz.y  * bf.offAz  + tMer.y * bf.offMer;
    cz += tAz.z  * bf.offAz  + tMer.z * bf.offMer;

    const rx = Math.max(1e-3, d.radiusWU * bf.rxMul);
    const ry = Math.max(1e-3, d.radiusWU * bf.ryMul);
    const rz = Math.max(1e-3, d.radiusWU * bf.rzMul);

    const invRx2 = 1 / (rx * rx);
    const invRy2 = 1 / (ry * ry);
    const invRz2 = 1 / (rz * rz);

    const cyaw = Math.cos(bf.yaw);
    const syaw = Math.sin(bf.yaw);

    for (let ii = 0; ii < IDS.length; ii++){
      const px = posX[ii];
      if (!Number.isFinite(px)) continue;

      const dx0 = px - cx;
      const dy  = posY[ii] - cy;
      const dz0 = posZ[ii] - cz;

      const dx = dx0 * cyaw + dz0 * syaw;
      const dz = -dx0 * syaw + dz0 * cyaw;

      const q = (dx*dx) * invRx2 + (dy*dy) * invRy2 + (dz*dz) * invRz2;
      if (q <= 1){
        const id = IDS[ii];

        const gOld = paintedG.get(id) ?? 255;
        if (gOld === 0) continue;

        const aOld = 1 - (gOld / 255);
        const aNew = stackInkDynamic(aOld, inkAlpha, doneFrac);
        const gNew = Math.round((1 - aNew) * 255);

        if (gNew < gOld){
          paintedG.set(id, gNew);

          const needOld = need01FromG(gOld);
          const needNew = need01FromG(gNew);
          const deltaNeed = needOld - needNew;
          if (deltaNeed > 0){
            const b = idBinIdx[ii] | 0;
            binNeedSum[b] = Math.max(0, binNeedSum[b] - deltaNeed);
          }

          if (gOld > DONE_G_MAX && gNew <= DONE_G_MAX) doneCount++;

          // If we're NOT doing a full refresh this frame, push per-id updates now.
          if (!fullRefresh){
            const gDisp = (gNew / 255) * fadeMul;
            changes.push({ id, color: [gDisp, gDisp, gDisp, 1] });
          }
        }
      }
    }
  }

  // NEW: During global fade (or any time fadeMul changes), force a whole-dome refresh
  // so *every* panel gets updated to its faded value, even if it wasn't hit this frame.
  if (fullRefresh){
    changes.length = 0;
    for (let i = 0; i < IDS.length; i++){
      const id = IDS[i];
      const gByte = paintedG.get(id) ?? 255;
      const gDisp = (gByte / 255) * fadeMul;
      changes.push({ id, color: [gDisp, gDisp, gDisp, 1] });
    }
  }

  if (changes.length) api.setColors(changes);

  _lastGlobalFadeMul = fadeMul;
}
