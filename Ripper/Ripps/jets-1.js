// ripp—tdl-layered-ink-black-guided (MULTI HOSE: distributed random origins, per-hose random spawn point, independent meander)
// + NEW: Forced fade-out to pure black after a given time window.
// Preview contract: init(api), update(api, t, dt)

export const meta = {
  name: 'Layered Ink (guided): Multi-Hose Origin→Antipode + Hose Pose (distributed random origins, per-hose meander)',
  fps: 60,
  duration: 30
};

// ============================================================================
// FORCED FADE-OUT (2 params)
// ----------------------------------------------------------------------------
// After FADEOUT_START_MS, we begin forcing any remaining non-black areas toward
// pure black, finishing in FADEOUT_DURATION_MS.
// - This does NOT change your normal hose painting behavior before the start.
// - During the fade, we only ever darken (never lighten).
// ============================================================================
const FADEOUT_START_MS    = 2000; // when the forced fade begins (ms from t=0)
const FADEOUT_DURATION_MS = 1000;  // how long the forced fade takes (ms). 0 = instant

// ============================================================================
// MULTI HOSE (1..4)
// ============================================================================
const HOSE_COUNT = 2;

// Each hose gets its own SPAWN_ORIGIN_WU point each run.
// Distance from center doesn’t change the snapped-on-surface origin direction,
// but we keep it “real” to satisfy “random spawn origin position”.
const ORIGIN_RADIUS_MIN_MULT = 0.30; // * domeR
const ORIGIN_RADIUS_MAX_MULT = 2.00; // * domeR
const ORIGIN_TANGENT_JITTER_WU = 15; // small tangent wiggle so points aren’t collinear

// Optional: for debugging, tint each hose slightly so you can SEE 4 hoses.
// Keep false for true monoblack ink.
const DEBUG_TINT_HOSES = false;

// ============================================================================
// HOSE POSE (multi-axial tumble) — base values (each hose gets slight random variants)
// ============================================================================
const HOSE_ENABLE = true;
const HOSE_RETARGET_SEC = .4;
const HOSE_SMOOTH_SEC   = 0.4;
const HOSE_MAX_TILT_RAD = Math.PI;
const HOSE_ROLL_SPEED   = 0.90;
const HOSE_WANDER       = 1.0;

const HOSE_GUIDANCE_FOLLOWS = true;
const HOSE_BIN_REFRESH_SEC  = 0.5;

// ============================================================================
// TRAVEL-LIMITED PAINT EFFECT (measured from TRUE origin s=0)
// ============================================================================
const EFFECT_TRAVEL_PCT = 100;
const EFFECT_FADE_POW   = 3;
const CULL_AT_EFFECT_END = true;

// ---- Tunables --------------------------------------------------------------
const SPHERE_DIAMETER_MIN_WU = 10.0;
const SPHERE_DIAMETER_MAX_WU = 30.0;

// Spawn cadence is PER HOSE (total emission scales with HOSE_COUNT)
const EMIT_PERIOD_MS   = 4;
const START_FRAC_MIN   = 0.0;
const START_FRAC_MAX   = 0.05;

// dt-stable accel
const FPS_REF          = meta.fps || 60;
const STEP_INIT        = 0.001;
const ACCEL            = 2.55;
const STEP_MAX         = 0.1;
const SPEED_SCALE      = 0.7;

// Layering
const INK_ALPHA_BASE   = 0.35;
const INK_ALPHA_MAX    = 0.80;
const STACK_MODE       = 'over'; // 'over' or 'linear'

// Done threshold
const DONE_INK         = 0.90;
const DONE_G_MAX       = Math.round((1 - DONE_INK) * 255);

// Coverage guidance (PER HOSE)
const BIN_COUNT        = 36;
const RNG_SPAWN_PROB   = 0.05;
const BIAS_POW_MIN     = 1.50;
const BIAS_POW_MAX     = 1.55;
const BIN_JITTER_FRAC  = 0.65;
const EPS_WEIGHT       = 1e-3;

// Catch-up behavior
const CATCHUP_START_FRAC = 0.60;
const BEHIND_WINDOW      = 0.22;

// Perf
const MAX_LIVE_SPHERES_TOTAL = 600;
const S_CULL_OVER      = 1.02;

// ============================================================================
// Helpers
// ============================================================================
function allTDLIds(api){
  const T = Array.isArray(api?.ids?.T) ? api.ids.T : [];
  const D = Array.isArray(api?.ids?.D) ? api.ids.D : [];
  const L = Array.isArray(api?.ids?.L) ? api.ids.L : [];
  return [...new Set([...T, ...D, ...L])];
}

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
function wrapPi(a){
  const TAU = Math.PI * 2;
  a = (a + Math.PI) % TAU;
  return (a < 0 ? a + TAU : a) - Math.PI;
}
function dot3(ax,ay,az,bx,by,bz){ return ax*bx + ay*by + az*bz; }
function cross3(ax,ay,az,bx,by,bz){
  return [ay*bz - az*by, az*bx - ax*bz, ax*by - ay*bx];
}
function norm3(x,y,z){
  const m = Math.hypot(x,y,z) || 1;
  return [x/m, y/m, z/m];
}
function rotateAroundAxis(vx,vy,vz, kx,ky,kz, a){
  const c = Math.cos(a), s = Math.sin(a);
  const d = dot3(vx,vy,vz, kx,ky,kz);
  const cx = ky*vz - kz*vy;
  const cy = kz*vx - kx*vz;
  const cz = kx*vy - ky*vx;
  return [
    vx*c + cx*s + kx*d*(1-c),
    vy*c + cy*s + ky*d*(1-c),
    vz*c + cz*s + kz*d*(1-c)
  ];
}

// dt-stable smoothing alpha from time constant (seconds)
function smoothAlpha(dt, tau){
  const t = Math.max(1e-6, tau);
  return 1 - Math.exp(-Math.max(0, dt) / t);
}

// Slerp between unit vectors (a->b)
function slerpUnit(ax,ay,az, bx,by,bz, t){
  t = clamp01(t);
  let d = dot3(ax,ay,az, bx,by,bz);
  d = Math.max(-1, Math.min(1, d));

  if (d > 0.9995){
    const x = ax + (bx - ax) * t;
    const y = ay + (by - ay) * t;
    const z = az + (bz - az) * t;
    return norm3(x,y,z);
  }

  const th = Math.acos(d);
  const s = Math.sin(th) || 1e-6;
  const w1 = Math.sin((1 - t) * th) / s;
  const w2 = Math.sin(t * th) / s;
  return norm3(
    ax*w1 + bx*w2,
    ay*w1 + by*w2,
    az*w1 + bz*w2
  );
}

// Uniform random direction
function randomUnit3(rng){
  const u = rng();
  const v = rng();
  const z = 2*u - 1;
  const a = 2*Math.PI*v;
  const r = Math.sqrt(Math.max(0, 1 - z*z));
  return [r*Math.cos(a), z, r*Math.sin(a)];
}

// Simple seeded RNG (Mulberry32)
function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randIn(min,max,rng){ return min + rng()*(max-min); }

// Stack “ink density” a∈[0..1].
function stackInk(aOld, inkAlpha){
  if (STACK_MODE === 'linear'){
    return Math.min(1, aOld + inkAlpha);
  }
  return 1 - (1 - aOld) * (1 - inkAlpha);
}

// ============================================================================
// Frames: build from an arbitrary SPAWN_ORIGIN_WU point (per hose)
// ============================================================================
function buildOriginFrameFromPoint(center, domeR, pt){
  const dx = (pt?.x ?? 0) - center.x;
  const dy = (pt?.y ?? 0) - center.y;
  const dz = (pt?.z ?? 0) - center.z;

  let Ux,Uy,Uz;
  if (Math.hypot(dx,dy,dz) < 1e-6){
    // default: top of dome (Y-up)
    Ux=0; Uy=1; Uz=0;
  } else {
    ;[Ux,Uy,Uz] = norm3(dx,dy,dz);
  }

  // Pick reference axis not parallel to U
  let rx=0, ry=1, rz=0;
  const d = Math.abs(dot3(Ux,Uy,Uz, rx,ry,rz));
  if (d > 0.92){ rx=0; ry=0; rz=1; }

  // B = normalize(ref × U)
  let B = cross3(rx,ry,rz, Ux,Uy,Uz);
  let Bx=0, By=0, Bz=0;
  ;[Bx,By,Bz] = norm3(B[0], B[1], B[2]);

  // P = normalize(U × B)
  let P = cross3(Ux,Uy,Uz, Bx,By,Bz);
  let Px=0, Py=0, Pz=0;
  ;[Px,Py,Pz] = norm3(P[0], P[1], P[2]);

  const origin = {
    x: center.x + Ux * domeR,
    y: center.y + Uy * domeR,
    z: center.z + Uz * domeR
  };

  return { spawnWU: {x:pt.x,y:pt.y,z:pt.z}, origin, U:[Ux,Uy,Uz], B:[Bx,By,Bz], P:[Px,Py,Pz] };
}

function posFromOriginToAntipode(center, domeR, frame, s, az){
  const theta = Math.PI/2 - Math.PI * s;
  const sinT = Math.sin(theta);
  const cosT = Math.cos(theta);

  const [Ux,Uy,Uz] = frame.U;
  const [Bx,By,Bz] = frame.B;
  const [Px,Py,Pz] = frame.P;

  const sinA = Math.sin(az);
  const cosA = Math.cos(az);

  const Tx = Bx*sinA + Px*cosA;
  const Ty = By*sinA + Py*cosA;
  const Tz = Bz*sinA + Pz*cosA;

  const dx = Ux*sinT + Tx*cosT;
  const dy = Uy*sinT + Ty*cosT;
  const dz = Uz*sinT + Tz*cosT;

  return {
    x: center.x + dx * domeR,
    y: center.y + dy * domeR,
    z: center.z + dz * domeR
  };
}

function azAroundOriginAxis(center, p, frame){
  const vx = p.x - center.x;
  const vy = p.y - center.y;
  const vz = p.z - center.z;
  let nx=0, ny=0, nz=0;
  ;[nx,ny,nz] = norm3(vx,vy,vz);

  const [Bx,By,Bz] = frame.B;
  const [Px,Py,Pz] = frame.P;

  const b = dot3(nx,ny,nz, Bx,By,Bz);
  const q = dot3(nx,ny,nz, Px,Py,Pz);

  return wrapRad(Math.atan2(b, q));
}

// Fade based on s distance from TRUE origin s=0
function travelFadeFromS(sClamped){
  const travelFrac = clamp01(EFFECT_TRAVEL_PCT / 100);
  if (travelFrac <= 1e-6) return 0;

  const u = clamp01(sClamped / travelFrac);
  const pow = Math.max(1e-6, EFFECT_FADE_POW);
  return Math.pow(Math.max(0, 1 - u), pow);
}

// ============================================================================
// Evenly-distributed starting directions (then one global random rotation)
// ============================================================================
function baseDirectionsForCount(N){
  const T = [
    norm3( 1, 1, 1),
    norm3(-1,-1, 1),
    norm3(-1, 1,-1),
    norm3( 1,-1,-1),
  ];
  if (N <= 1) return [norm3(0,1,0)];
  if (N === 2){
    const u = norm3(0,1,0);
    return [u, [-u[0],-u[1],-u[2]]];
  }
  if (N === 3) return [T[0], T[1], T[2]];
  return [T[0], T[1], T[2], T[3]];
}

function rotateVecEuler(v, ax, ay, az){
  let [x,y,z] = v;

  // Rx
  { const c=Math.cos(ax), s=Math.sin(ax); const y2=y*c - z*s; const z2=y*s + z*c; y=y2; z=z2; }
  // Ry
  { const c=Math.cos(ay), s=Math.sin(ay); const x2=x*c + z*s; const z2=-x*s + z*c; x=x2; z=z2; }
  // Rz
  { const c=Math.cos(az), s=Math.sin(az); const x2=x*c - y*s; const y2=x*s + y*c; x=x2; y=y2; }

  return norm3(x,y,z);
}

// Build a per-hose SPAWN_ORIGIN_WU point from a direction, with “real” random distance + tangent jitter.
function spawnPointFromDir(center, domeR, U, rng){
  const r = domeR * randIn(ORIGIN_RADIUS_MIN_MULT, ORIGIN_RADIUS_MAX_MULT, rng);

  // tangent basis for jitter
  let rx=0, ry=1, rz=0;
  const d = Math.abs(dot3(U[0],U[1],U[2], rx,ry,rz));
  if (d > 0.92){ rx=0; ry=0; rz=1; }

  let B = cross3(rx,ry,rz, U[0],U[1],U[2]);
  B = norm3(B[0],B[1],B[2]);
  let P = cross3(U[0],U[1],U[2], B[0],B[1],B[2]);
  P = norm3(P[0],P[1],P[2]);

  const j1 = (rng()*2 - 1) * ORIGIN_TANGENT_JITTER_WU;
  const j2 = (rng()*2 - 1) * ORIGIN_TANGENT_JITTER_WU;

  return {
    x: center.x + U[0]*r + B[0]*j1 + P[0]*j2,
    y: center.y + U[1]*r + B[1]*j1 + P[1]*j2,
    z: center.z + U[2]*r + B[2]*j1 + P[2]*j2
  };
}

// ============================================================================
// Hose object
// ============================================================================
function makeHose(idx, baseFrame, rng){
  const N = BIN_COUNT;

  // per-hose parameter variance (independent “meander orbit” feel)
  const retargetSec = HOSE_RETARGET_SEC * randIn(0.70, 1.35, rng);
  const smoothSec   = HOSE_SMOOTH_SEC   * randIn(0.70, 1.35, rng);
  const rollSpeed   = HOSE_ROLL_SPEED   * randIn(0.70, 1.35, rng);
  const wander      = clamp01(HOSE_WANDER * randIn(0.80, 1.15, rng));

  const h = {
    idx,
    rng,

    // this hose's random SPAWN_ORIGIN_WU point + derived base frame
    baseFrame,

    // current hose frame state (starts at base)
    U: [baseFrame.U[0], baseFrame.U[1], baseFrame.U[2]],
    B: [baseFrame.B[0], baseFrame.B[1], baseFrame.B[2]],
    P: [baseFrame.P[0], baseFrame.P[1], baseFrame.P[2]],
    frame: { origin: baseFrame.origin, U:null, B:null, P:null },

    // targets + timing
    targetU: [baseFrame.U[0], baseFrame.U[1], baseFrame.U[2]],
    roll: 0,
    targetRoll: 0,
    nextRetargetT: 0,

    // per-hose meander params
    retargetSec,
    smoothSec,
    rollSpeed,
    wander,

    // guidance bins for THIS hose
    idBinIdx: new Uint16Array(0),
    binWhiteSum: new Float32Array(N),
    binAcc: 0
  };

  h.frame.U = h.U; h.frame.B = h.B; h.frame.P = h.P;

  // pick initial targets
  hoseRetarget(h, 0);

  return h;
}

function hoseRetarget(h, tNow){
  const rng = h.rng;
  const [bUx,bUy,bUz] = h.baseFrame.U;

  // propose random direction
  let [rx,ry,rz] = randomUnit3(rng);

  // bias toward baseU if wander < 1
  if (h.wander < 1){
    const w = clamp01(h.wander);
    const x = bUx*(1-w) + rx*w;
    const y = bUy*(1-w) + ry*w;
    const z = bUz*(1-w) + rz*w;
    ;[rx,ry,rz] = norm3(x,y,z);
  }

  // clamp tilt vs baseU
  let d = dot3(bUx,bUy,bUz, rx,ry,rz);
  d = Math.max(-1, Math.min(1, d));
  const ang = Math.acos(d);

  const maxTilt = Math.max(0, HOSE_MAX_TILT_RAD);
  if (ang > maxTilt && ang > 1e-6){
    const tt = maxTilt / ang;
    const v = slerpUnit(bUx,bUy,bUz, rx,ry,rz, tt);
    rx=v[0]; ry=v[1]; rz=v[2];
  }

  h.targetU = [rx,ry,rz];
  h.targetRoll = (rng()*2 - 1) * Math.PI;

  // schedule next retarget with jitter
  const j = 0.75 + 0.50*rng();
  h.nextRetargetT = tNow + h.retargetSec * j;
}

function hoseStep(h, dt, t, center, domeR){
  if (!HOSE_ENABLE) return;

  if (!(h.nextRetargetT > 0)){
    // desync so multiple hoses don’t lock-step
    h.nextRetargetT = t + h.rng() * h.retargetSec;
  }

  if (t >= h.nextRetargetT){
    hoseRetarget(h, t);
  }

  const a = smoothAlpha(dt, h.smoothSec);

  const oldU = h.U;
  const oldB = h.B;
  const oldP = h.P;

  const nu = slerpUnit(oldU[0],oldU[1],oldU[2], h.targetU[0],h.targetU[1],h.targetU[2], a);
  const newU = [nu[0],nu[1],nu[2]];

  // transport B/P with minimal rotation oldU->newU
  let newB = [oldB[0],oldB[1],oldB[2]];
  let newP = [oldP[0],oldP[1],oldP[2]];

  const c = cross3(oldU[0],oldU[1],oldU[2], newU[0],newU[1],newU[2]);
  const cm = Math.hypot(c[0],c[1],c[2]);

  if (cm > 1e-8){
    const ax = c[0]/cm, ay = c[1]/cm, az = c[2]/cm;
    let dd = dot3(oldU[0],oldU[1],oldU[2], newU[0],newU[1],newU[2]);
    dd = Math.max(-1, Math.min(1, dd));
    const ang = Math.acos(dd);

    const rb = rotateAroundAxis(oldB[0],oldB[1],oldB[2], ax,ay,az, ang);
    const rp = rotateAroundAxis(oldP[0],oldP[1],oldP[2], ax,ay,az, ang);
    newB = norm3(rb[0],rb[1],rb[2]);
    newP = norm3(rp[0],rp[1],rp[2]);
  }

  // roll
  const prevRoll = h.roll;
  h.roll = wrapPi(h.roll + h.rollSpeed * dt);
  const dRoll = wrapPi(h.targetRoll - h.roll);
  h.roll = wrapPi(h.roll + dRoll * a);
  const deltaRoll = wrapPi(h.roll - prevRoll);

  if (Math.abs(deltaRoll) > 1e-9){
    const rrB = rotateAroundAxis(newB[0],newB[1],newB[2], newU[0],newU[1],newU[2], deltaRoll);
    const rrP = rotateAroundAxis(newP[0],newP[1],newP[2], newU[0],newU[1],newU[2], deltaRoll);
    newB = norm3(rrB[0],rrB[1],rrB[2]);
    newP = norm3(rrP[0],rrP[1],rrP[2]);
  }

  // re-orthonormalize
  newB = norm3(newB[0],newB[1],newB[2]);
  {
    const P = cross3(newU[0],newU[1],newU[2], newB[0],newB[1],newB[2]);
    newP = norm3(P[0],P[1],P[2]);
    const B = cross3(newP[0],newP[1],newP[2], newU[0],newU[1],newU[2]);
    newB = norm3(B[0],B[1],B[2]);
  }

  h.U = newU; h.B = newB; h.P = newP;

  // origin-on-surface follows current U (this is the “orbit” across the dome)
  h.frame = {
    origin: { x: center.x + newU[0]*domeR, y: center.y + newU[1]*domeR, z: center.z + newU[2]*domeR },
    U: h.U, B: h.B, P: h.P
  };
}

// ============================================================================
// Guidance bins per hose
// ============================================================================
function ensureHoseBins(h, idCount){
  if (!h.idBinIdx || h.idBinIdx.length !== idCount) h.idBinIdx = new Uint16Array(idCount);
  if (!h.binWhiteSum || h.binWhiteSum.length !== BIN_COUNT) h.binWhiteSum = new Float32Array(BIN_COUNT);
}

function rebuildBinsForHose(api, h, center){
  ensureHoseBins(h, IDS.length);
  h.binWhiteSum.fill(0);

  const bw = (Math.PI * 2) / BIN_COUNT;

  for (let i = 0; i < IDS.length; i++){
    const id = IDS[i];
    const p = api.posOf(id);

    const az = (p && Number.isFinite(p.x))
      ? azAroundOriginAxis(center, p, h.frame)
      : 0;

    const b = Math.min(BIN_COUNT - 1, Math.max(0, Math.floor(az / bw)));
    h.idBinIdx[i] = b;

    const g = paintedG.get(id) ?? 255;
    h.binWhiteSum[b] += (g / 255);
  }
}

function chooseGuidedAzForHose(t, h){
  const rng = h.rng;
  const TAU = Math.PI * 2;
  const bw = TAU / BIN_COUNT;

  if (rng() < RNG_SPAWN_PROB) return rng() * TAU;

  const dur = Math.max(0.001, meta.duration || 1);
  const progress = clamp01(t / dur);
  const biasPow = BIAS_POW_MIN + (BIAS_POW_MAX - BIAS_POW_MIN) * progress;

  let totalW = 0;
  const wArr = new Float32Array(BIN_COUNT);

  for (let b = 0; b < BIN_COUNT; b++){
    const w = Math.pow(h.binWhiteSum[b] + EPS_WEIGHT, biasPow);
    wArr[b] = w;
    totalW += w;
  }

  if (!(totalW > 0)) return rng() * TAU;

  let r = rng() * totalW;
  let chosen = 0;
  for (let b = 0; b < BIN_COUNT; b++){
    r -= wArr[b];
    if (r <= 0){ chosen = b; break; }
  }

  const binStart = chosen * bw;
  let az = binStart + (rng() * bw);

  const jitter = (rng() - 0.5) * bw * BIN_JITTER_FRAC;
  az = wrapRad(az + jitter);

  return az;
}

// ============================================================================
// Forced fade-out helpers
// ============================================================================
function fadeProgressFromTime(tSec){
  const tMs = tSec * 1000;

  // Allow disabling by setting start to Infinity/NaN
  if (!Number.isFinite(FADEOUT_START_MS)) return 0;

  if (tMs < FADEOUT_START_MS) return 0;

  const dur = Math.max(0, FADEOUT_DURATION_MS);
  if (dur <= 0) return 1;

  return clamp01((tMs - FADEOUT_START_MS) / dur);
}

// ============================================================================
// State
// ============================================================================
let IDS = [];
let center = {x:0,y:0,z:0};
let domeR = 250;

let posX = new Float32Array(0);
let posY = new Float32Array(0);
let posZ = new Float32Array(0);

let emitAccMs = 0;
let needFirstSpawnAtNow = true;

const spheres = []; // {hoseIdx, s, step, az, radiusWU, r2, Ux..Pz}
const paintedG = new Map();
let doneCount = 0;

let RUN_RNG = Math.random;
let HOSES = [];

// forced fade-out snapshot (captures grayscale at the moment fade begins)
let FADE_ACTIVE = false;
let FADE_START_G = null; // Uint16Array(IDS.length)

// ============================================================================
// Lifecycle
// ============================================================================
export function init(api){
  IDS = allTDLIds(api);
  api.resetColorsTo([1,1,1,1]);

  if (api.info && Number.isFinite(api.info.radius)) domeR = api.info.radius;
  if (api.info && api.info.center) {
    center = { x: api.info.center.x || 0, y: api.info.center.y || 0, z: api.info.center.z || 0 };
  }

  // new seed every init/run
  const seed = ((Math.random() * 1e9) | 0) ^ ((Date.now() & 0xffffffff) | 0);
  RUN_RNG = mulberry32(seed);

  posX = new Float32Array(IDS.length);
  posY = new Float32Array(IDS.length);
  posZ = new Float32Array(IDS.length);

  spheres.length = 0;
  emitAccMs = 0;
  needFirstSpawnAtNow = true;

  paintedG.clear();
  doneCount = 0;

  // reset forced fade state
  FADE_ACTIVE = false;
  FADE_START_G = null;

  // --- Build evenly-distributed starting directions, then one global random rotation ---
  const N = Math.max(1, Math.min(4, HOSE_COUNT|0));
  const baseDirs = baseDirectionsForCount(N);

  const ax = (RUN_RNG()*2 - 1) * Math.PI;
  const ay = (RUN_RNG()*2 - 1) * Math.PI;
  const az = (RUN_RNG()*2 - 1) * Math.PI;

  HOSES = new Array(N);

  for (let i=0;i<N;i++){
    // distributed direction, randomized as a set
    const U0 = rotateVecEuler(baseDirs[i], ax, ay, az);

    // make per-hose RNG (so each has independent orbit + spawn jitter)
    const hRng = mulberry32((seed + 1013*i) | 0);

    // per-hose SPAWN_ORIGIN_WU point (random position), but aligned with U0
    const spawnWU = spawnPointFromDir(center, domeR, U0, hRng);

    // build base frame from THAT point
    const baseFrame = buildOriginFrameFromPoint(center, domeR, spawnWU);

    // hose object
    HOSES[i] = makeHose(i, baseFrame, hRng);

    // set initial frame
    HOSES[i].frame = {
      origin: { x: center.x + HOSES[i].U[0]*domeR, y: center.y + HOSES[i].U[1]*domeR, z: center.z + HOSES[i].U[2]*domeR },
      U: HOSES[i].U, B: HOSES[i].B, P: HOSES[i].P
    };
  }

  // initial guidance bins per hose
  for (let i=0;i<HOSES.length;i++){
    rebuildBinsForHose(api, HOSES[i], center);
    HOSES[i].binAcc = 0;
  }
}

export function update(api, t/*s*/, dt/*s*/){
  const dtMs = Math.max(0, dt * 1000);

  // cache positions once per frame
  for (let i = 0; i < IDS.length; i++){
    const p = api.posOf(IDS[i]);
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)){
      posX[i] = p.x; posY[i] = p.y; posZ[i] = p.z;
    } else {
      posX[i] = NaN; posY[i] = NaN; posZ[i] = NaN;
    }
  }

  // step each hose (independent orbit)
  for (let i=0;i<HOSES.length;i++){
    const h = HOSES[i];
    hoseStep(h, dt, t, center, domeR);

    if (HOSE_GUIDANCE_FOLLOWS){
      h.binAcc += dt;
      if (h.binAcc >= HOSE_BIN_REFRESH_SEC){
        h.binAcc = 0;
        rebuildBinsForHose(api, h, center);
      }
    }
  }

  // first-frame burst: one spawn per hose immediately
  if (needFirstSpawnAtNow){
    for (let i=0;i<HOSES.length;i++) spawnOneForHose(t, HOSES[i]);
    needFirstSpawnAtNow = false;
  }

  // spawn cadence: per hose
  emitAccMs += dtMs;
  while (emitAccMs >= EMIT_PERIOD_MS){
    emitAccMs -= EMIT_PERIOD_MS;
    for (let i=0;i<HOSES.length;i++) spawnOneForHose(t, HOSES[i]);
  }

  // advance spheres (dt-stable)
  if (spheres.length){
    const frames = dt * FPS_REF;
    const accelMul = frames > 0 ? Math.pow(ACCEL, frames) : 1;

    const travelFrac = clamp01(EFFECT_TRAVEL_PCT / 100);
    const sCut = travelFrac > 1e-6 ? (travelFrac * S_CULL_OVER) : 0;

    for (let i = spheres.length - 1; i >= 0; i--){
      const d = spheres[i];

      d.step = Math.min(STEP_MAX, d.step * accelMul);
      d.s += (d.step * frames * SPEED_SCALE);

      if (CULL_AT_EFFECT_END){
        if (d.s >= sCut) spheres.splice(i, 1);
      } else {
        if (d.s >= 1 || d.s > S_CULL_OVER) spheres.splice(i, 1);
      }
    }
  }

  // forced fade-out snapshot kick-in
  const fProg = fadeProgressFromTime(t);
  if (fProg > 0){
    if (!FADE_ACTIVE || !FADE_START_G || FADE_START_G.length !== IDS.length){
      FADE_ACTIVE = true;
      FADE_START_G = new Uint16Array(IDS.length);
      for (let i=0;i<IDS.length;i++){
        const id = IDS[i];
        FADE_START_G[i] = (paintedG.get(id) ?? 255);
      }
    }
  }

  paint(api, t, fProg);
}

// ============================================================================
// Spawn / Paint
// ============================================================================
function spawnOneForHose(t, h){
  if (spheres.length >= MAX_LIVE_SPHERES_TOTAL) return;

  const s0 = randIn(START_FRAC_MIN, START_FRAC_MAX, h.rng);
  const az = chooseGuidedAzForHose(t, h);

  const diamWU   = randIn(SPHERE_DIAMETER_MIN_WU, SPHERE_DIAMETER_MAX_WU, h.rng);
  const radiusWU = diamWU * 0.5;

  // sphere captures THIS hose frame at birth
  const birth = h.frame;

  spheres.push({
    hoseIdx: h.idx,
    s: s0,
    step: STEP_INIT,
    az,
    radiusWU,
    r2: radiusWU * radiusWU,

    Ux: birth.U[0], Uy: birth.U[1], Uz: birth.U[2],
    Bx: birth.B[0], By: birth.B[1], Bz: birth.B[2],
    Px: birth.P[0], Py: birth.P[1], Pz: birth.P[2],
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

function paint(api, t, fadeProg){
  const changes = [];
  const inkAlphaBase = computeInkAlpha(t);

  // --- normal hose painting (your existing behavior) ---
  for (let si = 0; si < spheres.length; si++){
    const d = spheres[si];
    const sClamped = d.s < 0 ? 0 : (d.s > 1 ? 1 : d.s);

    const fade = travelFadeFromS(sClamped);
    if (fade <= 1e-6) continue;

    const inkAlpha = inkAlphaBase * fade;
    if (inkAlpha <= 1e-6) continue;

    const frame = {
      U: [d.Ux, d.Uy, d.Uz],
      B: [d.Bx, d.By, d.Bz],
      P: [d.Px, d.Py, d.Pz]
    };

    const C = posFromOriginToAntipode(center, domeR, frame, sClamped, d.az);
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
        let gNew = Math.round((1 - aNew) * 255);
        if (gNew <= 2) gNew = 0;

        if (gNew < gOld){
          paintedG.set(id, gNew);

          // update done count
          if (gOld > DONE_G_MAX && gNew <= DONE_G_MAX) doneCount++;

          // update per-hose guidance whiteness sums
          const deltaW = (gOld - gNew) / 255;
          for (let hi=0; hi<HOSES.length; hi++){
            const h = HOSES[hi];
            const b = h.idBinIdx[ii] | 0;
            h.binWhiteSum[b] = Math.max(0, h.binWhiteSum[b] - deltaW);
          }

          // commit color (optionally tinted for debugging)
          let r = gNew/255, g = gNew/255, b = gNew/255;
          if (DEBUG_TINT_HOSES){
            const k = (d.hoseIdx % 4);
            if (k === 1) { r *= 1.00; g *= 0.90; b *= 0.90; }
            if (k === 2) { r *= 0.90; g *= 1.00; b *= 0.90; }
            if (k === 3) { r *= 0.90; g *= 0.90; b *= 1.00; }
          }

          changes.push({ id, color: [r, g, b, 1] });
        }
      }
    }
  }

  // --- forced fade-out pass (kicks in after FADEOUT_START_MS) ---
  if (fadeProg > 0 && FADE_ACTIVE && FADE_START_G && FADE_START_G.length === IDS.length){
    const k = clamp01(fadeProg);

    for (let ii = 0; ii < IDS.length; ii++){
      const id = IDS[ii];

      const gOld = paintedG.get(id) ?? 255;
      if (gOld === 0) continue;

      // target darkness based on snapshot at fade start (deterministic)
      let gTarget = Math.round(FADE_START_G[ii] * (1 - k));
      if (gTarget <= 2) gTarget = 0;

      // never lighten; only darken toward the target
      const gNew = (gTarget < gOld) ? gTarget : gOld;
      if (gNew === gOld) continue;

      paintedG.set(id, gNew);

      if (gOld > DONE_G_MAX && gNew <= DONE_G_MAX) doneCount++;

      // update per-hose guidance whiteness sums for this id
      const deltaW = (gOld - gNew) / 255;
      for (let hi=0; hi<HOSES.length; hi++){
        const h = HOSES[hi];
        const b = h.idBinIdx[ii] | 0;
        h.binWhiteSum[b] = Math.max(0, h.binWhiteSum[b] - deltaW);
      }

      const gg = gNew / 255;
      changes.push({ id, color: [gg, gg, gg, 1] });
    }
  }

  if (changes.length) api.setColors(changes);
}
