// ripp—tdl-pollock-ink-guided-ooze (Jackson Pollock dome wipe) — SINGLE-HEAD (no multi-tap)
// Preview contract: init(api), update(api, t, dt)

export const meta = {
  name: 'Pollock Ink: Drips + Slashes + Spatter (guided coverage + subtle ooze) — single-head',
  fps: 60,
  duration: 30
};

// ============================================================================
// CORE KNOBS (what you’ll actually tweak first)
// ============================================================================

// Spawn cadence (ms) — LOWER = more strokes
const RAMP_EMIT_PERIOD_MS = {
  start: 50.0,
  end:   12.0,
  secs:  3.0,
  startAt: 0.0
};
const EMIT_PERIOD_MIN_MS = 3.0;
const EMIT_PERIOD_MAX_MS = 2000.0;

// Stroke radius range (WU)
const RAMP_RADIUS_MIN_WU = {
  start: 10.0,
  end:   35.0,
  secs:  5.0,
  startAt: 0.0
};
const RAMP_RADIUS_MAX_WU = {
  start: 10.0,
  end:   35.0,
  secs:  5.0,
  startAt: 0.0
};

// Live stroke cap (perf safety)
const MAX_LIVE_STROKES = 220;

// ============================================================================
// STROKE STYLE MIX (Pollock vocabulary)
// ============================================================================
// Type probabilities (must sum ~1.0)
const PROB_SLASH   = 0.52;  // long directional slashes
const PROB_DRIP    = 0.18;  // gravity-ish drips
const PROB_SPATTER = 0.30;  // small chaotic spatters

// Slash (paths along surface)
const SLASH_LENGTH_MIN_WU = 1020;
const SLASH_LENGTH_MAX_WU = 10020;
const SLASH_SPEED_MIN_WU_PER_SEC = 3040;
const SLASH_SPEED_MAX_WU_PER_SEC = 8000;

// Drip (more ooze + shorter lateral)
const DRIP_LENGTH_MIN_WU = 190;
const DRIP_LENGTH_MAX_WU = 860;
const DRIP_SPEED_MIN_WU_PER_SEC = 140;
const DRIP_SPEED_MAX_WU_PER_SEC = 520;

// Spatter (tiny quick splats, multi-spawn)
const SPATTER_BURST_MIN = 3;
const SPATTER_BURST_MAX = 12;
const SPATTER_LENGTH_MIN_WU = 125;
const SPATTER_LENGTH_MAX_WU = 390;
const SPATTER_SPEED_MIN_WU_PER_SEC = 220;
const SPATTER_SPEED_MAX_WU_PER_SEC = 1200;

// ============================================================================
// INK / STACKING (same technique, relevant knobs preserved)
// ============================================================================
const INK_ALPHA_BASE = 0.40;
const INK_ALPHA_MAX  = 0.82;
const STACK_MODE     = 'over'; // 'over' | 'linear'

const DONE_INK   = 0.92;
const DONE_G_MAX = Math.round((1 - DONE_INK) * 255);

const ENDGAME_ENABLE = true;
const ENDGAME_STACK_SWITCH_DONEFRAC = 0.90;
const ENDGAME_LINEAR_GAIN = 1.55;

// Catch-up (push ink stronger when behind schedule)
const CATCHUP_START_FRAC = 0.55;
const BEHIND_WINDOW = 0.22;

// ============================================================================
// GUIDED COVERAGE (random early -> efficient endgame)
// 2D bins: azimuth x elevation (s bands) gives better “chad sniping”
// ============================================================================
const AZ_BINS = 96;     // around the dome
const S_BINS  = 28;     // top->bottom bands

const RNG_SPAWN_PROB  = 0.05;  // percent of strokes that ignore guidance
const BIAS_POW_MIN    = 2.20;
const BIAS_POW_MAX    = 22.0;
const EPS_WEIGHT      = 1e-3;

const BIN_JITTER_AZ_FRAC = 0.28;
const BIN_JITTER_S_FRAC  = 0.35;

// OPTIONAL ENDGAME SNIPER (targets the single “most unpainted” face)
const SNIPER_ENABLE = true;
const SNIPER_START_DONEFRAC = 0.93;
const SNIPER_SPAWN_PROB = 0.72;
const SNIPER_AZ_JITTER_FRAC = 0.06;
const SNIPER_S_JITTER_FRAC  = 0.035;
const SNIPER_RADIUS_SCALE = 1.5;

// ============================================================================
// OOZE (subtle gravity pull after impact, drifting along surface)
// ============================================================================
const OOZE_ENABLE = true;
const OOZE_MAX_WU = 58;            // max drift distance along the surface
const OOZE_EASE_SECS = 1.2;        // how quickly ooze “settles”
const OOZE_STRENGTH = 0.42;        // 0..1 overall influence
const OOZE_DRIP_BOOST = 1.85;      // drips ooze more than slashes/spatter

// ============================================================================
// MOTION QUALITY (prevents gaps at high speeds)
// ============================================================================
const MAX_SEGMENT_STEPS = 10;
const SEGMENT_STEP_FRACTION_OF_RADIUS = 0.72;

// ============================================================================
// Helpers
// ============================================================================
const TAU = Math.PI * 2;

function allTDLIds(api){
  const T = Array.isArray(api?.ids?.T) ? api.ids.T : [];
  const D = Array.isArray(api?.ids?.D) ? api.ids.D : [];
  const L = Array.isArray(api?.ids?.L) ? api.ids.L : [];
  return [...new Set([...T, ...D, ...L])];
}
function clamp01(x){ return x < 0 ? 0 : (x > 1 ? 1 : x); }
function wrapRad(a){ a = a % TAU; return a < 0 ? a + TAU : a; }
function lerp(a,b,t){ return a + (b - a) * t; }
function randIn(a,b){ return a + Math.random() * (b - a); }
function irand(a,b){ return Math.floor(randIn(a, b + 1)); }

function smoothstep(e0, e1, x){
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

function rampValue(t, spec){
  const startAt = Number.isFinite(spec?.startAt) ? spec.startAt : 0;
  const secs = Math.max(1e-6, Number(spec?.secs ?? 0));
  const u = clamp01((t - startAt) / secs);
  const e = u * u * (3 - 2 * u); // smoothstep
  return lerp(Number(spec.start), Number(spec.end), e);
}

function norm3(x,y,z){
  const l = Math.hypot(x,y,z) || 1;
  return { x:x/l, y:y/l, z:z/l, l };
}

function projectToSphere(center, domeR, x, y, z){
  const nx = x - center.x, ny = y - center.y, nz = z - center.z;
  const n = norm3(nx, ny, nz);
  return {
    x: center.x + n.x * domeR,
    y: center.y + n.y * domeR,
    z: center.z + n.z * domeR,
    nx: n.x, ny: n.y, nz: n.z
  };
}

function posOnMeridianAz(center, domeR, s, az){
  const theta = Math.PI/2 - Math.PI * s;   // latitude (+top .. -bottom)
  const y = center.y + domeR * Math.sin(theta);
  const rHor = domeR * Math.cos(theta);
  const x = center.x + rHor * Math.sin(az);
  const z = center.z + rHor * Math.cos(az);
  return { x, y, z, theta, rHor };
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

function sFromPointY(center, domeR, py){
  const u = (py - center.y) / Math.max(1e-6, domeR);
  const theta = Math.asin(Math.max(-1, Math.min(1, u))); // latitude
  return clamp01((Math.PI/2 - theta) / Math.PI);
}

// “Need” from gByte: higher = more unpainted
function need01FromG(gByte){
  return Math.max(0, (gByte - DONE_G_MAX) / 255);
}

// Ink stacking
function stackInk(aOld, inkAlpha){
  if (STACK_MODE === 'linear') return Math.min(1, aOld + inkAlpha);
  return 1 - (1 - aOld) * (1 - inkAlpha);
}
function stackInkDynamic(aOld, inkAlpha, doneFrac){
  if (ENDGAME_ENABLE && doneFrac >= ENDGAME_STACK_SWITCH_DONEFRAC){
    return Math.min(1, aOld + inkAlpha * ENDGAME_LINEAR_GAIN);
  }
  return stackInk(aOld, inkAlpha);
}

// ============================================================================
// State
// ============================================================================
let IDS = [];
let IDS_SET = new Set();
let center = {x:0,y:0,z:0};
let domeR = 250;

let posX = new Float32Array(0);
let posY = new Float32Array(0);
let posZ = new Float32Array(0);

// paint state
const paintedG = new Map(); // id -> gByte
let doneCount = 0;

// 2D bins
let idCellIdx = new Uint16Array(0);
let cellCount = new Uint16Array(AZ_BINS * S_BINS);
let cellNeedSum = new Float32Array(AZ_BINS * S_BINS);

// stroke particles
// each stroke: {
//   type, t0, life, lengthWU, speedWU, radiusWU, inkK,
//   p0x,p0y,p0z, dirx,diry,dirz, sideX,sideY,sideZ,
//   oozeAmt, prevX, prevY, prevZ
// }
const strokes = [];
let emitAccMs = 0;

// sniper
let targetIdx = -1;
let targetAz = 0;
let targetS = 0.5;

// ============================================================================
// Lifecycle
// ============================================================================
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

  // cache positions once (static dome geometry)
  for (let i = 0; i < IDS.length; i++){
    const p = api.posOf(IDS[i]);
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)){
      posX[i] = p.x; posY[i] = p.y; posZ[i] = p.z;
    } else {
      posX[i] = NaN; posY[i] = NaN; posZ[i] = NaN;
    }
  }

  paintedG.clear();
  doneCount = 0;

  strokes.length = 0;
  emitAccMs = 0;

  rebuildBins(api);
  targetIdx = -1; targetAz = 0; targetS = 0.5;
}

export function update(api, t/*s*/, dt/*s*/){
  dt = Math.max(0, dt || 0);
  const dtMs = dt * 1000;

  // Handle ID changes (rare)
  const newIDS = allTDLIds(api);
  if (newIDS.length !== IDS.length){
    IDS = newIDS;
    IDS_SET = new Set(IDS);

    posX = new Float32Array(IDS.length);
    posY = new Float32Array(IDS.length);
    posZ = new Float32Array(IDS.length);
    for (let i = 0; i < IDS.length; i++){
      const p = api.posOf(IDS[i]);
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)){
        posX[i] = p.x; posY[i] = p.y; posZ[i] = p.z;
      } else {
        posX[i] = NaN; posY[i] = NaN; posZ[i] = NaN;
      }
    }

    for (const key of paintedG.keys()){
      if (!IDS_SET.has(key)) paintedG.delete(key);
    }

    rebuildBins(api);
  }

  // Evaluate ramped controls
  let emitPeriodMs = rampValue(t, RAMP_EMIT_PERIOD_MS);
  if (!Number.isFinite(emitPeriodMs)) emitPeriodMs = 45;
  emitPeriodMs = Math.max(EMIT_PERIOD_MIN_MS, Math.min(EMIT_PERIOD_MAX_MS, emitPeriodMs));

  let rMin = rampValue(t, RAMP_RADIUS_MIN_WU);
  let rMax = rampValue(t, RAMP_RADIUS_MAX_WU);
  if (!Number.isFinite(rMin)) rMin = 10;
  if (!Number.isFinite(rMax)) rMax = 40;
  if (rMin > rMax){ const tmp = rMin; rMin = rMax; rMax = tmp; }

  // Update sniper target (endgame)
  updateTargetIndex();

  // Spawn cadence
  emitAccMs += dtMs;
  while (emitAccMs >= emitPeriodMs){
    emitAccMs -= emitPeriodMs;
    spawnPollockBurst(t, rMin, rMax);
  }

  // cull dead strokes
  for (let i = strokes.length - 1; i >= 0; i--){
    const s = strokes[i];
    if (!s || (t - s.t0) > s.life + 0.25){
      strokes.splice(i, 1);
    }
  }

  // Paint
  if (strokes.length){
    paintAll(api, t);
  }
}

// ============================================================================
// Coverage bins / targeting
// ============================================================================
function rebuildBins(api){
  idCellIdx = new Uint16Array(IDS.length);
  cellCount = new Uint16Array(AZ_BINS * S_BINS);
  cellNeedSum = new Float32Array(AZ_BINS * S_BINS);
  doneCount = 0;

  for (let i = 0; i < IDS.length; i++){
    const id = IDS[i];
    const px = posX[i];
    if (!Number.isFinite(px)){
      idCellIdx[i] = 0;
      continue;
    }

    const az = wrapRad(Math.atan2(px - center.x, posZ[i] - center.z));
    const s = sFromPointY(center, domeR, posY[i]);

    const c = cellIndexFromAzS(az, s);
    idCellIdx[i] = c;
    cellCount[c]++;

    const g = paintedG.get(id) ?? 255;
    const need = need01FromG(g);
    cellNeedSum[c] += need;
    if (g <= DONE_G_MAX) doneCount++;
  }
}

function cellIndexFromAzS(az, s){
  const azw = TAU / AZ_BINS;
  const sw = 1 / S_BINS;

  let ai = Math.floor(wrapRad(az) / azw);
  ai = Math.max(0, Math.min(AZ_BINS - 1, ai));

  let si = Math.floor(clamp01(s) / sw);
  si = Math.max(0, Math.min(S_BINS - 1, si));

  return si * AZ_BINS + ai;
}

function chooseGuidedTarget(t){
  // rng escape hatch
  if (Math.random() < RNG_SPAWN_PROB){
    const az = Math.random() * TAU;
    const v = Math.random() * 2 - 1;          // uniform y/r in [-1,1]
    const theta = Math.asin(v);               // latitude
    let s = (Math.PI/2 - theta) / Math.PI;    // to s
    s = clamp01(s);
    return { az, s };
  }

  const total = Math.max(1, IDS.length);
  const doneFrac = doneCount / total;

  const dur = Math.max(0.001, meta.duration || 1);
  const progress = clamp01(t / dur);

  // ramp bias up over time, but soften the exponent right at the bitter end
  const soften = smoothstep(0.92, 0.997, doneFrac);
  const biasBase = BIAS_POW_MIN + (BIAS_POW_MAX - BIAS_POW_MIN) * progress;
  const biasPow  = biasBase * (1 - 0.80 * soften) + 0.9 * soften;

  const nCells = AZ_BINS * S_BINS;
  let totalW = 0;
  const wArr = new Float32Array(nCells);

  for (let c = 0; c < nCells; c++){
    const cnt = cellCount[c] || 0;
    const avgNeed = cnt ? (cellNeedSum[c] / cnt) : 0;

    let w = Math.pow(avgNeed + EPS_WEIGHT, biasPow);

    // prevent starving “tiny remaining” cells at endgame
    if (soften > 0 && avgNeed > 0){
      w = Math.max(w, 0.010 * soften);
    }

    wArr[c] = w;
    totalW += w;
  }

  if (!(totalW > 0)){
    return { az: Math.random() * TAU, s: Math.random() };
  }

  let r = Math.random() * totalW;
  let chosen = 0;
  for (let c = 0; c < nCells; c++){
    r -= wArr[c];
    if (r <= 0){ chosen = c; break; }
  }

  const si = Math.floor(chosen / AZ_BINS);
  const ai = chosen - si * AZ_BINS;

  const azw = TAU / AZ_BINS;
  const sw  = 1 / S_BINS;

  let az = (ai + 0.5) * azw;
  let s  = (si + 0.5) * sw;

  // jitter within cell
  az = wrapRad(az + (Math.random() - 0.5) * azw * BIN_JITTER_AZ_FRAC);
  s  = clamp01(s  + (Math.random() - 0.5) * sw  * BIN_JITTER_S_FRAC);

  return { az, s };
}

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
    const az = wrapRad(Math.atan2(posX[bestIdx] - center.x, posZ[bestIdx] - center.z));
    const s  = sFromPointY(center, domeR, posY[bestIdx]);
    targetAz = az;
    targetS  = s;
  }
}

// ============================================================================
// Spawning strokes
// ============================================================================
function spawnPollockBurst(t, rMin, rMax){
  if (strokes.length >= MAX_LIVE_STROKES) return;

  // decide if sniper overrides target choice
  const total = Math.max(1, IDS.length);
  const doneFrac = doneCount / total;

  const useSniper = (SNIPER_ENABLE && targetIdx >= 0 && doneFrac >= SNIPER_START_DONEFRAC && Math.random() < SNIPER_SPAWN_PROB);

  // pick base impact point on dome (az,s)
  let az, s;
  if (useSniper){
    const azw = TAU / AZ_BINS;
    az = wrapRad(targetAz + (Math.random() - 0.5) * azw * SNIPER_AZ_JITTER_FRAC);
    s  = clamp01(targetS  + (Math.random() - 0.5) * SNIPER_S_JITTER_FRAC);
  } else {
    const pick = chooseGuidedTarget(t);
    az = pick.az; s = pick.s;
  }

  // choose type
  const u = Math.random();
  let type = 'slash';
  if (u < PROB_SLASH) type = 'slash';
  else if (u < (PROB_SLASH + PROB_DRIP)) type = 'drip';
  else type = 'spatter';

  // spatter emits multiple tiny strokes in one burst
  if (type === 'spatter'){
    const k = irand(SPATTER_BURST_MIN, SPATTER_BURST_MAX);
    for (let i = 0; i < k; i++){
      if (strokes.length >= MAX_LIVE_STROKES) break;
      spawnOneStroke(t, az, s, rMin, rMax, 'spatter', useSniper);
    }
    return;
  }

  spawnOneStroke(t, az, s, rMin, rMax, type, useSniper);
}

function spawnOneStroke(t, az, s, rMin, rMax, type, isSniper){
  // impact point on dome
  const P = posOnMeridianAz(center, domeR, s, az);

  // choose tangent direction: random mix of tAz + tMer, then normalize
  // drips start slightly “downish”
  const { tAz, tMer } = tangentsAt(az, P.theta);
  let phi = Math.random() * TAU;
  if (type === 'drip') phi = (Math.random() * 0.5 + 0.25) * Math.PI; // push toward meridian-ish
  const dx = tAz.x * Math.cos(phi) + tMer.x * Math.sin(phi);
  const dy = tAz.y * Math.cos(phi) + tMer.y * Math.sin(phi);
  const dz = tAz.z * Math.cos(phi) + tMer.z * Math.sin(phi);
  const dir = norm3(dx, dy, dz);

  // side vector (for subtle waviness)
  const nx = P.x - center.x, ny = P.y - center.y, nz = P.z - center.z;
  const nrm = norm3(nx, ny, nz);
  const side = norm3(
    (nrm.y * dir.z - nrm.z * dir.y),
    (nrm.z * dir.x - nrm.x * dir.z),
    (nrm.x * dir.y - nrm.y * dir.x)
  );

  // radius (sniper fattens a bit)
  let radiusWU = randIn(rMin, rMax);
  if (isSniper) radiusWU *= SNIPER_RADIUS_SCALE;

  // length + speed by type
  let lengthWU, speedWU;
  if (type === 'slash'){
    lengthWU = randIn(SLASH_LENGTH_MIN_WU, SLASH_LENGTH_MAX_WU);
    speedWU  = randIn(SLASH_SPEED_MIN_WU_PER_SEC, SLASH_SPEED_MAX_WU_PER_SEC);
  } else if (type === 'drip'){
    lengthWU = randIn(DRIP_LENGTH_MIN_WU, DRIP_LENGTH_MAX_WU);
    speedWU  = randIn(DRIP_SPEED_MIN_WU_PER_SEC, DRIP_SPEED_MAX_WU_PER_SEC);
  } else { // spatter
    lengthWU = randIn(SPATTER_LENGTH_MIN_WU, SPATTER_LENGTH_MAX_WU);
    speedWU  = randIn(SPATTER_SPEED_MIN_WU_PER_SEC, SPATTER_SPEED_MAX_WU_PER_SEC);
    radiusWU *= randIn(0.35, 0.75);
  }

  const life = Math.max(0.06, lengthWU / Math.max(1e-6, speedWU));
  const inkK = (type === 'spatter') ? randIn(0.75, 1.15) : randIn(0.90, 1.20);

  // ooze amount per stroke
  let oozeAmt = OOZE_ENABLE ? (OOZE_STRENGTH * randIn(0.35, 1.0)) : 0;
  if (type === 'drip') oozeAmt *= OOZE_DRIP_BOOST;
  if (type === 'spatter') oozeAmt *= 0.65;

  strokes.push({
    type,
    t0: t,
    life,
    lengthWU,
    speedWU,
    radiusWU,
    inkK,

    p0x: P.x, p0y: P.y, p0z: P.z,
    dirx: dir.x, diry: dir.y, dirz: dir.z,
    sideX: side.x, sideY: side.y, sideZ: side.z,

    oozeAmt,
    prevX: NaN,
    prevY: NaN,
    prevZ: NaN
  });
}

// ============================================================================
// Ink alpha (catch-up) + painting
// ============================================================================
function computeInkAlpha(t){
  const total = Math.max(1, IDS.length);
  const doneFrac = doneCount / total;

  const dur = Math.max(0.001, meta.duration || 1);
  const target = clamp01(t / dur);

  const lateRamp = smoothstep(CATCHUP_START_FRAC, 1.0, target);
  const behind = clamp01((target - doneFrac) / BEHIND_WINDOW);
  const boost = behind * lateRamp;

  // gently push alpha upward near the end so remaining gray dies faster
  const fin = smoothstep(0.90, 0.997, doneFrac);

  let a = INK_ALPHA_BASE + (INK_ALPHA_MAX - INK_ALPHA_BASE) * boost;
  a = a + (1 - a) * (0.55 * fin);

  return clamp01(a);
}

function paintAll(api, t){
  const changesMap = new Map(); // id -> darkest gByte in this frame
  const inkAlphaBase = computeInkAlpha(t);

  const total = Math.max(1, IDS.length);
  const doneFrac = doneCount / total;

  for (let si = 0; si < strokes.length; si++){
    const s = strokes[si];
    const age = t - s.t0;
    if (age < 0) continue;

    // single-head sample of the stroke motion
    const u = clamp01(age / Math.max(1e-6, s.life));
    const distWU = u * s.lengthWU;

    // base along-tangent motion
    let x = s.p0x + s.dirx * distWU;
    let y = s.p0y + s.diry * distWU;
    let z = s.p0z + s.dirz * distWU;

    // subtle lateral wobble for “hand flung” feel
    const wob = (s.type === 'slash') ? 0.12 : (s.type === 'drip' ? 0.06 : 0.20);
    const w = Math.sin((age * (s.type === 'spatter' ? 9.5 : 3.2)) + si * 0.77) * wob * s.radiusWU;
    x += s.sideX * w; y += s.sideY * w; z += s.sideZ * w;

    // project to surface
    let P = projectToSphere(center, domeR, x, y, z);

    // ooze drift along downhill tangent
    if (OOZE_ENABLE && s.oozeAmt > 0){
      // downhill = gravity projected into tangent plane
      const gx = 0, gy = -1, gz = 0;
      const dot = gx*P.nx + gy*P.ny + gz*P.nz;
      let tx = gx - P.nx * dot;
      let ty = gy - P.ny * dot;
      let tz = gz - P.nz * dot;
      const tl = Math.hypot(tx, ty, tz);
      if (tl > 1e-6){
        tx /= tl; ty /= tl; tz /= tl;
        const oozeEase = 1 - Math.exp(-age / Math.max(1e-6, OOZE_EASE_SECS));
        const oozeWU = OOZE_MAX_WU * oozeEase * s.oozeAmt;
        P = projectToSphere(center, domeR, P.x + tx * oozeWU, P.y + ty * oozeWU, P.z + tz * oozeWU);
      }
    }

    // per-stroke ink scaling
    const inkAlpha = clamp01(inkAlphaBase * s.inkK);

    paintStrokeSegment(P.x, P.y, P.z, s.radiusWU, inkAlpha, doneFrac, s, changesMap);
  }

  if (changesMap.size){
    const changes = [];
    for (const [id, gByte] of changesMap.entries()){
      const g = gByte / 255;
      changes.push({ id, color: [g, g, g, 1] });
    }
    api.setColors(changes);
  }
}

function paintStrokeSegment(cx, cy, cz, radiusWU, inkAlpha, doneFrac, stroke, changesMap){
  // sub-sample along motion segment (prev -> current)
  let steps = 1;
  if (Number.isFinite(stroke.prevX)){
    const dx = cx - stroke.prevX, dy = cy - stroke.prevY, dz = cz - stroke.prevZ;
    const dist = Math.hypot(dx, dy, dz);
    const denom = Math.max(1e-6, radiusWU * SEGMENT_STEP_FRACTION_OF_RADIUS);
    steps = Math.max(1, Math.min(MAX_SEGMENT_STEPS, Math.ceil(dist / denom)));
  }

  for (let k = 1; k <= steps; k++){
    const u = (steps === 1) ? 1 : (k / steps);
    const sx = Number.isFinite(stroke.prevX) ? (stroke.prevX + (cx - stroke.prevX) * u) : cx;
    const sy = Number.isFinite(stroke.prevY) ? (stroke.prevY + (cy - stroke.prevY) * u) : cy;
    const sz = Number.isFinite(stroke.prevZ) ? (stroke.prevZ + (cz - stroke.prevZ) * u) : cz;
    paintAt(sx, sy, sz, radiusWU, inkAlpha, doneFrac, changesMap);
  }

  stroke.prevX = cx; stroke.prevY = cy; stroke.prevZ = cz;
}

function paintAt(cx, cy, cz, radiusWU, inkAlpha, doneFrac, changesMap){
  const r2 = radiusWU * radiusWU;

  for (let i = 0; i < IDS.length; i++){
    const px = posX[i];
    if (!Number.isFinite(px)) continue;

    const dx = px - cx;
    const dy = posY[i] - cy;
    const dz = posZ[i] - cz;

    if ((dx*dx + dy*dy + dz*dz) <= r2){
      const id = IDS[i];

      const gOld = paintedG.get(id) ?? 255;
      if (gOld === 0) continue;

      const aOld = 1 - (gOld / 255);
      const aNew = stackInkDynamic(aOld, inkAlpha, doneFrac);
      const gNew = Math.round((1 - aNew) * 255);

      if (gNew < gOld){
        paintedG.set(id, gNew);

        // update bins (need sum + done count)
        const c = idCellIdx[i] | 0;
        const needOld = need01FromG(gOld);
        const needNew = need01FromG(gNew);
        const deltaNeed = needOld - needNew;
        if (deltaNeed > 0) cellNeedSum[c] = Math.max(0, cellNeedSum[c] - deltaNeed);

        if (gOld > DONE_G_MAX && gNew <= DONE_G_MAX) doneCount++;

        const prev = changesMap.get(id);
        if (prev === undefined || gNew < prev) changesMap.set(id, gNew);
      }
    }
  }
}
