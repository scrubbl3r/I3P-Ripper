// ripp—tdl-layered-ink-black-guided (coverage-biased az, dt-stable accel, adaptive alpha).js
// Preview contract: init(api), update(api, t, dt)

export const meta = {
  name: 'Layered Ink (guided): Top→Bottom (monoblack, 20% ink stacks, guaranteed-ish fill)',
  fps: 60,
  duration: 30
};

// ---- Tunables --------------------------------------------------------------
// per-sphere diameter range (world units)
const SPHERE_DIAMETER_MIN_WU = 2.0;
const SPHERE_DIAMETER_MAX_WU = 40.0;

const EMIT_PERIOD_MS   = 4;
const START_FRAC_MIN   = 0.95;
const START_FRAC_MAX   = 0.95;

// Geometric acceleration stabilized vs dt using a reference FPS.
const FPS_REF          = meta.fps || 60;
const STEP_INIT        = 0.001;
const ACCEL            = 2.55;
const STEP_MAX         = 0.1;
const SPEED_SCALE      = 0.7;

// Layering
const INK_ALPHA_BASE   = 0.20;  // your “20% per hit”
const INK_ALPHA_MAX    = 0.50;  // catch-up cap near the end (only if behind)
const STACK_MODE       = 'over'; // 'over' (smooth) or 'linear' (fast clamp)

// “Done” threshold (Q3 a = 98% ink)
const DONE_INK         = 0.95;
const DONE_G_MAX       = Math.round((1 - DONE_INK) * 255); // <= 5 is “done”

// Coverage guidance (Q1 b + Q4 b)
const BIN_COUNT        = 36;    // azimuth slices
const RNG_SPAWN_PROB   = 0.05;  // percent of spawns that ignore guidance (keeps it organic)
const BIAS_POW_MIN     = 1.50;  // guidance strength ramps a bit over time
const BIAS_POW_MAX     = 1.55;
const BIN_JITTER_FRAC  = 0.65;  // jitter within bin width
const EPS_WEIGHT       = 1e-3;

// Catch-up behavior (Q2 b)
const CATCHUP_START_FRAC = 0.60; // don’t boost alpha until late
const BEHIND_WINDOW      = 0.22; // normalization window for “how behind” we are

// GC / perf controls
const MAX_LIVE_SPHERES = 600;
const S_CULL_OVER      = 1.02;

// ---- Helpers ---------------------------------------------------------------
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
  const TAU = Math.PI * 2;
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

// Map path fraction s∈[0..1] to a meridian rotated by az around Y (Y-up)
function posOnMeridianAz(center, domeR, s, az){
  const theta = Math.PI/2 - Math.PI * s;
  const y = center.y + domeR * Math.sin(theta);
  const rHor = domeR * Math.cos(theta);
  const x = center.x + rHor * Math.sin(az);
  const z = center.z + rHor * Math.cos(az);
  return { x, y, z };
}

function azOfPoint(center, p){
  const dx = p.x - center.x;
  const dz = p.z - center.z;
  // matches our meridian: x = sin(az), z = cos(az)
  return wrapRad(Math.atan2(dx, dz));
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

// each sphere: { s, step, az, radiusWU, r2 }
const spheres = [];
let needFirstSpawnAtNow = true;

// ink state per id: store grayscale byte g∈[0..255] (255=white, 0=black).
const paintedG = new Map(); // id -> gByte
let doneCount = 0;

// ---- Lifecycle -------------------------------------------------------------
export function init(api){
  IDS = allTDLIds(api);
  IDS_SET = new Set(IDS);

  // start from white (per your earlier Q2 A)
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

  // spawn cadence (unchanged per your request)
  emitAccMs += dtMs;
  while (emitAccMs >= EMIT_PERIOD_MS){
    emitAccMs -= EMIT_PERIOD_MS;
    spawnOne(api, t);
  }

  // advance spheres (dt-stable)
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

    const bw = (Math.PI * 2) / BIN_COUNT;
    const b = Math.min(BIN_COUNT - 1, Math.max(0, Math.floor(az / bw)));
    idBinIdx[i] = b;
    binCount[b]++;

    const g = paintedG.get(id) ?? 255;
    binWhiteSum[b] += (g / 255);
    if (g <= DONE_G_MAX) doneCount++;
  }
}

function chooseGuidedAz(t){
  const TAU = Math.PI * 2;
  const bw = TAU / BIN_COUNT;

  // rng escape hatch (keeps it feeling alive)
  if (Math.random() < RNG_SPAWN_PROB){
    return Math.random() * TAU;
  }

  const dur = Math.max(0.001, meta.duration || 1);
  const progress = clamp01(t / dur);

  // medium guidance ramps slightly over time
  const biasPow = BIAS_POW_MIN + (BIAS_POW_MAX - BIAS_POW_MIN) * progress;

  // weight bins by remaining whiteness (unpainted-ness)
  let totalW = 0;
  const wArr = new Float32Array(BIN_COUNT);

  for (let b = 0; b < BIN_COUNT; b++){
    // binWhiteSum is sum of (g/255) for ids in bin
    const w = Math.pow(binWhiteSum[b] + EPS_WEIGHT, biasPow);
    wArr[b] = w;
    totalW += w;
  }

  // fallback to uniform if something goes weird
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

  // pick an az inside bin with jitter
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

  spheres.push({ s: s0, step: STEP_INIT, az, radiusWU, r2: radiusWU * radiusWU });
}

function computeInkAlpha(t){
  // progress vs schedule uses “done” fraction (>=98% ink)
  const total = Math.max(1, IDS.length);
  const doneFrac = doneCount / total;

  const dur = Math.max(0.001, meta.duration || 1);
  const target = clamp01(t / dur);

  // only start catch-up late in the piece
  const lateRamp = smoothstep(CATCHUP_START_FRAC, 1.0, target);

  // how behind are we? (0..1)
  const behind = clamp01((target - doneFrac) / BEHIND_WINDOW);

  // boost alpha only if behind, only late
  const boost = behind * lateRamp;

  return INK_ALPHA_BASE + (INK_ALPHA_MAX - INK_ALPHA_BASE) * boost;
}

function paint(api, t){
  const changes = [];
  const inkAlpha = computeInkAlpha(t);

  for (let si = 0; si < spheres.length; si++){
    const d = spheres[si];
    const sClamped = d.s < 0 ? 0 : (d.s > 1 ? 1 : d.s);
    const C = posOnMeridianAz(center, domeR, sClamped, d.az);

    const cx = C.x, cy = C.y, cz = C.z;
    const r2 = d.r2;

    for (let ii = 0; ii < IDS.length; ii++){
      const px = posX[ii];
      if (!Number.isFinite(px)) continue;

      const dx = px - cx;
      const dy = posY[ii] - cy;
      const dz = posZ[ii] - cz;

      if ((dx*dx + dy*dy + dz*dz) <= r2){
        const id = IDS[ii];

        const gOld = paintedG.get(id) ?? 255;
        if (gOld === 0) continue;

        const aOld = 1 - (gOld / 255);
        const aNew = stackInk(aOld, inkAlpha);
        const gNew = Math.round((1 - aNew) * 255);

        if (gNew < gOld){
          paintedG.set(id, gNew);

          // update bin whiteness sum (so guidance stays accurate)
          const b = idBinIdx[ii] | 0;
          const deltaW = (gOld - gNew) / 255; // whiteness decreased
          binWhiteSum[b] = Math.max(0, binWhiteSum[b] - deltaW);

          // update done counter when crossing threshold
          if (gOld > DONE_G_MAX && gNew <= DONE_G_MAX) doneCount++;

          const g = gNew / 255;
          changes.push({ id, color: [g, g, g, 1] });
        }
      }
    }
  }

  if (changes.length) api.setColors(changes);
}
