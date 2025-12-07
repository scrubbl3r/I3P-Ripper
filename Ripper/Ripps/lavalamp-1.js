// ripp—tdl-layered-ink-black-guided-bubblepatch (BOTTOM→TOP + global bubble patch).js
// Preview contract: init(api), update(api, t, dt)

export const meta = {
  name: 'Layered Ink (guided): Bottom→Top (monoblack) + Bubble Motion Patch (global)',
  fps: 60,
  duration: 30
};

// ---- Tunables --------------------------------------------------------------
// per-sphere diameter range (world units)
const SPHERE_DIAMETER_MIN_WU = 25.0;
const SPHERE_DIAMETER_MAX_WU = 35.0;

const EMIT_PERIOD_MS   = 100;
const START_FRAC_MIN   = 0.95; // near bottom
const START_FRAC_MAX   = 0.95;

// Geometric acceleration stabilized vs dt using a reference FPS.
const FPS_REF          = meta.fps || 60;
const STEP_INIT        = 0.01;
const ACCEL            = 1.02;
const STEP_MAX         = 0.1;
const SPEED_SCALE      = 0.4;

// Layering
const INK_ALPHA_BASE   = 0.25;
const INK_ALPHA_MAX    = 0.30;
const STACK_MODE       = 'over'; // 'over' (smooth) or 'linear' (fast clamp)

// “Done” threshold
const DONE_INK         = 0.95;
const DONE_G_MAX       = Math.round((1 - DONE_INK) * 255); // <= 5 is “done”

// Coverage guidance
const BIN_COUNT        = 36;    // azimuth slices
const RNG_SPAWN_PROB   = 0.05;  // percent of spawns that ignore guidance
const BIAS_POW_MIN     = 1.50;
const BIAS_POW_MAX     = 1.55;
const BIN_JITTER_FRAC  = 0.65;
const EPS_WEIGHT       = 1e-3;

// Catch-up behavior
const CATCHUP_START_FRAC = 0.60;
const BEHIND_WINDOW      = 0.22;

// GC / perf controls
const MAX_LIVE_SPHERES = 600;
const S_CULL_OVER      = 1.02;

// ---- Bubble motion presets -------------------------------------------------
// All spheres use ONE patch: hardcode ACTIVE_BUBBLE_PATCH_NAME below.
// Use the exact `name` string.
// ---- Bubble motion presets (v2: MUCH more divergent + extreme) -------------
// All spheres still use ONE patch: set ACTIVE_BUBBLE_PATCH_NAME to one of these.
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
    radiusPulseAmp: 0.65, radiusPulseHz: 0.90, // huge “breath”
    squashAmp: 0.25, squashHz: 0.45, squashYZ: 0.85,
    tumbleRate: 0.40, tumbleJitterAmp: 0.18, tumbleJitterHz: 0.22
  },
    {
    name: 'H: Shepard Drift (two-speed interference)',
    swayAmpWU: 45,   swayAmpWU2: 28,
    swayHz: 0.17,    swayHz2: 0.173, // near-match -> long beating drift
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
    radiusPulseAmp: 0.10, radiusPulseHz: 12.0,
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
const ACTIVE_BUBBLE_PATCH_NAME = 'C: Kelp Sway (big lateral arcs)'; // <- change this

let ACTIVE_BUBBLE_PATCH = null;
function resolveBubblePatch(){
  if (ACTIVE_BUBBLE_PATCH) return ACTIVE_BUBBLE_PATCH;

  if (typeof ACTIVE_BUBBLE_PATCH_NAME === 'string' && ACTIVE_BUBBLE_PATCH_NAME){
    const hit = BUBBLE_PRESETS.find(p => p.name === ACTIVE_BUBBLE_PATCH_NAME);
    if (hit){
      ACTIVE_BUBBLE_PATCH = hit;
      return ACTIVE_BUBBLE_PATCH;
    }
  }
  ACTIVE_BUBBLE_PATCH = BUBBLE_PRESETS[4];
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

// Stack “ink density” a∈[0..1].
function stackInk(aOld, inkAlpha){
  if (STACK_MODE === 'linear'){
    return Math.min(1, aOld + inkAlpha);
  }
  // 'over' / multiplicative: add inkAlpha of remaining whiteness
  return 1 - (1 - aOld) * (1 - inkAlpha);
}

// Map path fraction s∈[0..1] (top→bottom) to a meridian rotated by az around Y (Y-up)
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
  // matches our meridian: x = sin(az), z = cos(az)
  return wrapRad(Math.atan2(dx, dz));
}

function signedPow(x, p){
  const ax = Math.abs(x);
  const y = Math.pow(ax, p);
  return x < 0 ? -y : y;
}

// Build tangent directions at given az/theta.
// tangentAz is horizontal around the dome (spin around Y).
// tangentMer is along the meridian (up/down along the dome surface).
function tangentsAt(az, theta){
  const sinAz = Math.sin(az);
  const cosAz = Math.cos(az);

  // d/daz of (sinAz, 0, cosAz) direction
  const tAz = { x: cosAz, y: 0, z: -sinAz };

  // d/dtheta direction along meridian (normalized, domeR cancels)
  // dx ~ -sin(theta)*sinAz, dy ~ cos(theta), dz ~ -sin(theta)*cosAz
  const tx = -Math.sin(theta) * sinAz;
  const ty =  Math.cos(theta);
  const tz = -Math.sin(theta) * cosAz;
  const len = Math.hypot(tx, ty, tz) || 1;
  const tMer = { x: tx/len, y: ty/len, z: tz/len };

  return { tAz, tMer, sinAz, cosAz };
}

// ---- State -----------------------------------------------------------------
let IDS = [];
let IDS_SET = new Set();
let center = {x:0,y:0,z:0};
let domeR = 250; // fallback
let emitAccMs = 0;

let posX = new Float32Array(0);
let posY = new Float32Array(0);
let posZ = new Float32Array(0);

// bin mapping per id index + bin stats
let idBinIdx = new Uint16Array(0);
let binCount = new Uint32Array(BIN_COUNT);
let binWhiteSum = new Float32Array(BIN_COUNT);

// each sphere: { s, step, az, radiusWU, r2, seed, phaseA, phaseB, phaseC }
const spheres = [];
let needFirstSpawnAtNow = true;

// ink state per id: store grayscale byte g∈[0..255] (255=white, 0=black).
const paintedG = new Map(); // id -> gByte
let doneCount = 0;

// ---- Lifecycle -------------------------------------------------------------
export function init(api){
  IDS = allTDLIds(api);
  IDS_SET = new Set(IDS);

  // start from white
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

  // lock the global bubble patch for this run
  ACTIVE_BUBBLE_PATCH = null;
  resolveBubblePatch();
}

export function update(api, t/*s*/, dt/*s*/){
  const dtMs = Math.max(0, dt * 1000);

  // detect ID changes + clean maps + rebuild bins/sums
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

  if (needFirstSpawnAtNow){
    spawnOne(api, t);
    needFirstSpawnAtNow = false;
  }

  // spawn cadence
  emitAccMs += dtMs;
  while (emitAccMs >= EMIT_PERIOD_MS){
    emitAccMs -= EMIT_PERIOD_MS;
    spawnOne(api, t);
  }

  // advance spheres (dt-stable) — BOTTOM→TOP means s decreases toward 0
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

      // cull beyond the top
      if (d.s <= 0 || d.s < -S_CULL_OVER){
        spheres.splice(i, 1);
      }
    }
  }

  paint(api, t);
}

// ---- Coverage guidance -----------------------------------------------------
function rebuildBins(api){
  idBinIdx = new Uint16Array(IDS.length);
  binCount = new Uint32Array(BIN_COUNT);
  binWhiteSum = new Float32Array(BIN_COUNT);

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
    binWhiteSum[b] += (g / 255);
    if (g <= DONE_G_MAX) doneCount++;
  }
}

function chooseGuidedAz(t){
  const bw = TAU / BIN_COUNT;

  // rng escape hatch
  if (Math.random() < RNG_SPAWN_PROB){
    return Math.random() * TAU;
  }

  const dur = Math.max(0.001, meta.duration || 1);
  const progress = clamp01(t / dur);

  // guidance ramps slightly over time
  const biasPow = BIAS_POW_MIN + (BIAS_POW_MAX - BIAS_POW_MIN) * progress;

  // weight bins by remaining whiteness
  let totalW = 0;
  const wArr = new Float32Array(BIN_COUNT);

  for (let b = 0; b < BIN_COUNT; b++){
    const w = Math.pow(binWhiteSum[b] + EPS_WEIGHT, biasPow);
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

// ---- Spawn / Paint ---------------------------------------------------------
function spawnOne(api, t){
  if (spheres.length >= MAX_LIVE_SPHERES) return;

  const s0 = randIn(START_FRAC_MIN, START_FRAC_MAX);
  const az = chooseGuidedAz(t);

  const diamWU  = randIn(SPHERE_DIAMETER_MIN_WU, SPHERE_DIAMETER_MAX_WU);
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

    // per-sphere variety (same patch, different phases)
    seed, phaseA, phaseB, phaseC
  });
}

function computeInkAlpha(t){
  const total = Math.max(1, IDS.length);
  const doneFrac = doneCount / total;

  const dur = Math.max(0.001, meta.duration || 1);
  const target = clamp01(t / dur);

  const lateRamp = smoothstep(CATCHUP_START_FRAC, 1.0, target);
  const behind = clamp01((target - doneFrac) / BEHIND_WINDOW);
  const boost = behind * lateRamp;

  return INK_ALPHA_BASE + (INK_ALPHA_MAX - INK_ALPHA_BASE) * boost;
}

function bubbleFieldForSphere(d, t, sClamped, az, theta){
  const P = resolveBubblePatch();

  // stable oscillators (no per-frame randomness)
  const w1 = Math.sin((t * P.swayHz  * TAU) + d.phaseA);
  const w2 = Math.sin((t * P.swayHz2 * TAU) + d.phaseB);

  const shaped1 = (P.swayShape && P.swayShape !== 1)
    ? signedPow(w1, P.swayShape)
    : w1;

  const shaped2 = (P.swayShape && P.swayShape !== 1)
    ? signedPow(w2, P.swayShape)
    : w2;

  const offAz  = (P.swayAmpWU  || 0) * shaped1;
  const offMer = (P.swayAmpWU2 || 0) * shaped2;

  const radPulse = 1 + (P.radiusPulseAmp || 0) * Math.sin((t * (P.radiusPulseHz || 0.25) * TAU) + d.phaseC);

  // squash/elongate footprint (ellipsoid axes)
  const sq = (P.squashAmp || 0) * Math.sin((t * (P.squashHz || 0.4) * TAU) + d.phaseB);
  const squashYZ = (Number.isFinite(P.squashYZ) ? P.squashYZ : 0.8); // how much Y/Z counter-squash

  // rx grows with +sq, rz shrinks with +sq, ry counter-balances a bit
  // (this makes a “tumbling oval” feel when combined with yaw below)
  const rxMul = radPulse * (1 + sq);
  const rzMul = radPulse * (1 - sq);
  const ryMul = radPulse * (1 - sq * squashYZ);

  // tumble (yaw around Y)
  const baseYaw = (d.seed * 1e-9) * TAU; // stable per-sphere (0..tau)
  const yaw = baseYaw
    + (P.tumbleRate || 0) * t
    + (P.tumbleJitterAmp || 0) * Math.sin((t * (P.tumbleJitterHz || 0.2) * TAU) + d.phaseA);

  return {
    offAz, offMer,
    rxMul, ryMul, rzMul,
    yaw
  };
}

function paint(api, t){
  const changes = [];
  const inkAlpha = computeInkAlpha(t);

  for (let si = 0; si < spheres.length; si++){
    const d = spheres[si];

    const sClamped = d.s < 0 ? 0 : (d.s > 1 ? 1 : d.s);

    // base position on dome
    const base = posOnMeridianAz(center, domeR, sClamped, d.az);
    let cx = base.x, cy = base.y, cz = base.z;

    // bubble motion/distortion patch (GLOBAL patch, per-sphere phases)
    const { tAz, tMer } = tangentsAt(d.az, base.theta);
    const bf = bubbleFieldForSphere(d, t, sClamped, d.az, base.theta);

    // apply sway offsets along tangents
    cx += tAz.x  * bf.offAz  + tMer.x * bf.offMer;
    cy += tAz.y  * bf.offAz  + tMer.y * bf.offMer;
    cz += tAz.z  * bf.offAz  + tMer.z * bf.offMer;

    // ellipsoid axes (distorted bubble footprint)
    const rx = Math.max(1e-3, d.radiusWU * bf.rxMul);
    const ry = Math.max(1e-3, d.radiusWU * bf.ryMul);
    const rz = Math.max(1e-3, d.radiusWU * bf.rzMul);

    const invRx2 = 1 / (rx * rx);
    const invRy2 = 1 / (ry * ry);
    const invRz2 = 1 / (rz * rz);

    // “tumble” = rotate ellipsoid in XZ plane (yaw around Y)
    const cyaw = Math.cos(bf.yaw);
    const syaw = Math.sin(bf.yaw);

    for (let ii = 0; ii < IDS.length; ii++){
      const px = posX[ii];
      if (!Number.isFinite(px)) continue;

      const dx0 = px - cx;
      const dy  = posY[ii] - cy;
      const dz0 = posZ[ii] - cz;

      // rotate dx/dz by yaw (tumbling oval)
      const dx = dx0 * cyaw + dz0 * syaw;
      const dz = -dx0 * syaw + dz0 * cyaw;

      // ellipsoid inside test
      const q = (dx*dx) * invRx2 + (dy*dy) * invRy2 + (dz*dz) * invRz2;
      if (q <= 1){
        const id = IDS[ii];

        const gOld = paintedG.get(id) ?? 255;
        if (gOld === 0) continue;

        const aOld = 1 - (gOld / 255);
        const aNew = stackInk(aOld, inkAlpha);
        const gNew = Math.round((1 - aNew) * 255);

        if (gNew < gOld){
          paintedG.set(id, gNew);

          // update bin whiteness sum
          const b = idBinIdx[ii] | 0;
          const deltaW = (gOld - gNew) / 255;
          binWhiteSum[b] = Math.max(0, binWhiteSum[b] - deltaW);

          // update done counter
          if (gOld > DONE_G_MAX && gNew <= DONE_G_MAX) doneCount++;

          const g = gNew / 255;
          changes.push({ id, color: [g, g, g, 1] });
        }
      }
    }
  }

  if (changes.length) api.setColors(changes);
}
