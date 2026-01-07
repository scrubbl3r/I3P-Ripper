// ripp—tdl-kaleidoscope-canon + newton-fractal (hello) + paint-bands + SEEK_SECONDS.js
// Preview contract: init(api), update(api, t, dt)
//
// ORDER (as requested):
// 1) KALEIDOSCOPE CANON (prism rig + mirror set construction)
// 2) NEWTON FRACTAL (pattern source)
// 3) PAINT CONTROLS (ink shaping + grayscale bands)
//
// Notes:
// - No UI / no wireframe (pure .js like your other ripps)
// - “paired” rigMode creates a true doppelgänger for every plane:
//   same instantaneous angle components, but sign-inverted (opposite motion).
//   Fan + FanBias only affect the ORIGINAL planes; doppelgängers follow by construction.
// - NEW: SEEK_SECONDS fast-forwards the entire world (rig + pattern + any time-bucketed seed changes).

export const meta = {
  name: "Kaleidoscope Canon + Newton Fractal (Hello) + Banded Ink — SEEK_SECONDS",
  fps: 60,
  duration: 60
};

// ============================================================================
// SEEK (global time offset)
// ============================================================================
// Start as if the ripp has already been running for N seconds.
// This affects: mirror rig motion, Newton domain drift/rotation/zoom pulse, ripple warp,
// and any ChangeRate bucketing (if enabled later).
const AXIS_SLIDE_X_WU = .0;
const SEEK_SECONDS = 3.0; // try: 4, 8, 12, 18

// ============================================================================
// 1) KALEIDOSCOPE CANON — PRISM RIG (mirror plane set)
// ============================================================================

// Mirror count (original planes). If rigMode === "paired", total planes = 2 * MIRROR_PLANES.
const MIRROR_PLANES = 2;      // 1..10 (low counts recommended for coarse dome)
const REFLECT_ITERS = 8;     // 6..14 (more = stronger canonical fold, can mush)

// Rig construction mode:
// - "tumble"   : lively, less fair, per-plane tumble phases
// - "balanced" : coherent, distribution-preserving organic field
// - "paired"   : like balanced/tumble (choose below), but each plane gets a true doppelgänger
const RIG_MODE = "paired";  // "tumble" | "balanced" | "paired"

// If RIG_MODE === "paired", this base rig is the one we doppelgänger.
// (paired always behaves like alternating spin at the base carousel)
const PAIRED_BASE = "balanced"; // "balanced" | "tumble"

// Spin direction mapping (for the ORIGINAL planes)
// "uniform" | "alternating" | "halves" | "perPlane"
const SPIN_MODE = "uniform";

// Global carousel speed (radians/sec)
const BASE_SPEED = 0.20;

// Twist multiplier (affects angular distribution)
const TWIST = .80;

// Fan controls (apply ONLY to original planes)
// Fan=0 => evenly distributed
// Fan=±1 => fully collapsed (all stack at same baseAngle)
// FanBias shifts the entire fan cluster (+ or -)
const FAN = 0.00;       // [-1..1]
const FAN_BIAS = 0.00;  // [-1..1]

// Energy + Independence (motion intensity / divergence)
const ENERGY = .80;         // 0..2.5
const INDEPENDENCE = 0.15;   // 0..1 (micro-chaos / per-plane uniqueness)

// Optional: seeded per-plane speed spread when SPIN_MODE === "perPlane"
const SEED = 1337;
const CHANGE_RATE = 0.0;      // seconds; 0 = locked (only used for perPlane map refreshing)
const PERPLANE_SPREAD = 0.35; // 0..1 (only used for spinMode="perPlane")

// Balanced advanced (only used by balanced / paired-base=balanced)
const FIELD_PRECESS   = .08; // rad/sec
const FIELD_TILT      = .35; // radians (static tilt)
const FIELD_BREATH_A  = 0.18; // radians
const FIELD_BREATH_HZ = 0.07; // cycles/sec
const PERPLANE_WOB_A  = 0.18; // radians
const PERPLANE_WOB_HZ = 0.14; // cycles/sec
const ROLL_SPEED      = 0.06; // rad/sec

// Bilateral fold (optional pre-fold before prism reflection)
const BILATERAL_MODE = "x"; // "off" | "x" | "z"

// ============================================================================
// 2) NEWTON FRACTAL — PATTERN SOURCE (sampled AFTER reflection)
// ============================================================================

// Newton fractal for z^3 - 1 = 0 (three basins)
const NEWTON_MAX_ITERS = 7;     // 10..30
const NEWTON_EPS       = 3e-2;   // convergence threshold
const NEWTON_SCALE     = 2.0;   // bigger = chunkier (less detail)
const NEWTON_ROT_SPEED = .35;   // rad/sec rotate domain
const NEWTON_DRIFT     = .40;   // drift speed in domain
const NEWTON_ZOOM_PULSE_AMP   = .35; // 0..1 (scale modulation)
const NEWTON_ZOOM_PULSE_HZ    = .06; // cycles/sec

// How much basin identity affects ink (0 = pure convergence only)
const BASIN_MIX = .50; // 0..0.6 subtle

// Edge emphasis (boundary glow / ink boost near slow-converge regions)
const EDGE_GAIN = .05; // 0..2

// Optional domain warp (tiny ripple helps “read” on coarse dome)
const RIPPLE_WARP  = .12; // 0 disables
const RIPPLE_FREQ  = .95;
const RIPPLE_SPEED = 0.10;

// Seam scaffold (adds ink along mirror boundaries)
const SEAM_ADD = .56;
const SEAM_MIX = .6;

// ============================================================================
// 3) PAINT CONTROLS — INKING + BANDS
// ============================================================================

const INK_STRENGTH = 1.; // overall ink multiplier
const GAMMA        = 1.2; // <1 brighter mids, >1 darker mids

const BAND_BRIGHT  = 0.00;
const BAND_MID     = 0.50;
const BAND_INK     = 1.00;

const BAND_T1      = 0.70;
const BAND_T2      = 0.85;
const BAND_FEATHER = 0.10;

// ============================================================================
// Schema helpers
// ============================================================================
function allTDLIds(api){
  const T = Array.isArray(api?.ids?.T) ? api.ids.T : [];
  const D = Array.isArray(api?.ids?.D) ? api.ids.D : [];
  const L = Array.isArray(api?.ids?.L) ? api.ids.L : [];
  return [...new Set([...T, ...D, ...L])];
}

// ============================================================================
// Math utils
// ============================================================================
const TAU = Math.PI * 2;

const clamp01 = (x)=> x < 0 ? 0 : (x > 1 ? 1 : x);
const clamp   = (x,a,b)=> x < a ? a : (x > b ? b : x);
const fract   = (x)=> x - Math.floor(x);
const lerp    = (a,b,t)=> a + (b - a) * t;

function smoothstep(e0,e1,x){
  if (e1 <= e0) return x >= e1 ? 1 : 0;
  const t = clamp01((x - e0) / (e1 - e0));
  return t*t*(3 - 2*t);
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
  // Rodrigues; assumes axis is unit-ish
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
function reflect3(vx,vy,vz, nx,ny,nz){
  const d = dot3(vx,vy,vz, nx,ny,nz);
  return [vx - 2*d*nx, vy - 2*d*ny, vz - 2*d*nz];
}

// stable-ish hash: int -> [0,1)
function hash1(i, seed){
  let h = (i * 374761393) ^ (seed * 668265263);
  h = (h ^ (h >> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h >>> 0) / 4294967296;
}

// banded grayscale mapping (ink 0..1 -> shade 0..1)
function bandedShade(ink){
  const f = Math.max(1e-6, BAND_FEATHER);
  const a = smoothstep(BAND_T1 - f, BAND_T1 + f, ink);
  const b = smoothstep(BAND_T2 - f, BAND_T2 + f, ink);
  const bm = lerp(BAND_BRIGHT, BAND_MID, a);
  return lerp(bm, BAND_INK, b);
}

// ============================================================================
// Dome center/radius + UP detection
// ============================================================================
let UP_AXIS = "y";
function computeCenterRadiusAndUp(api, ids){
  let c = api?.info?.center;
  let r = api?.info?.radius;

  let cx = (c?.x ?? 0), cy = (c?.y ?? 0), cz = (c?.z ?? 0);
  const haveInfoCenter = !!c;

  const N = Math.min(ids.length, 512);
  let sx=0, sy=0, sz=0, n=0;

  for (let i=0;i<N;i++){
    const p = api.posOf(ids[i]);
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)){
      sx+=p.x; sy+=p.y; sz+=p.z; n++;
    }
  }
  if (!haveInfoCenter && n>0){ cx=sx/n; cy=sy/n; cz=sz/n; }

  let rr = Number.isFinite(r) ? r : 0;
  if (!Number.isFinite(r) || rr <= 1e-6){
    let maxD = 0;
    for (let i=0;i<N;i++){
      const p = api.posOf(ids[i]);
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)){
        const dx=p.x-cx, dy=p.y-cy, dz=p.z-cz;
        const d = Math.hypot(dx,dy,dz);
        if (d > maxD) maxD = d;
      }
    }
    rr = maxD > 1e-6 ? maxD : 250;
  }

  // crude up estimator
  let mx=0,my=0,mz=0, nn=0;
  const invR = 1/Math.max(1e-6, rr);
  for (let i=0;i<N;i++){
    const p = api.posOf(ids[i]);
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)){
      mx += (p.x - cx) * invR;
      my += (p.y - cy) * invR;
      mz += (p.z - cz) * invR;
      nn++;
    }
  }
  if (nn>0){
    mx/=nn; my/=nn; mz/=nn;
    const ax=Math.abs(mx), ay=Math.abs(my), az=Math.abs(mz);
    UP_AXIS = (ay>=ax && ay>=az) ? "y" : (az>=ax && az>=ay) ? "z" : "x";
  } else {
    UP_AXIS = "y";
  }

  return { cx, cy, cz, rr, up: UP_AXIS };
}

function basisFromUp(upAxis){
  if (upAxis === "x"){
    return { U:[1,0,0], B:[0,0,1], P:[0,1,0] };
  }
  if (upAxis === "z"){
    return { U:[0,0,1], B:[1,0,0], P:[0,1,0] };
  }
  return { U:[0,1,0], B:[1,0,0], P:[0,0,1] };
}

function spinDirForPlane(k, N, mode){
  if (mode === "alternating") return (k % 2 === 0) ? 1 : -1;
  if (mode === "halves"){
    if (N < 2) return 1;
    return (k < (N/2)) ? 1 : -1;
  }
  return 1;
}
function perPlaneSpeedMul(k, seed, spread){
  const r = hash1(k + 11, seed);
  return 1 + (r - 0.5) * 2 * spread; // 1 ± spread
}

// ============================================================================
// Mirror normal builder (CANON)
// - Returns array of plane normals (unit vectors).
// - In paired mode: returns 2N normals (originals first, then doppelgängers).
// ============================================================================
function buildMirrorNormals(localT){
  const rigMode = (RIG_MODE === "paired") ? PAIRED_BASE : RIG_MODE;

  const N = Math.max(1, MIRROR_PLANES);
  const { U, B, P } = basisFromUp(UP_AXIS);
  const [Ux,Uy,Uz] = U;
  const [Bx,By,Bz] = B;
  const [Px,Py,Pz] = P;

  // IMPORTANT: planes are unique only over π (n and -n are same plane)
  const slice = Math.PI / N;

  // Per-plane seed bump
  let seed = SEED | 0;
  if (CHANGE_RATE > 0.0001){
    const bump = Math.floor(localT / CHANGE_RATE) | 0;
    seed = (seed + bump * 9973) | 0;
  }

  // Fan mapping
  const fan = clamp(FAN, -1, 1);
  const spread = 1 - Math.min(1, Math.abs(fan));
  const c = (N - 1) * 0.5;
  const bias = clamp(FAN_BIAS, -1, 1);
  const biasShift = bias * (slice * c);

  // Spin mode override in paired
  const spinMode = (RIG_MODE === "paired") ? "alternating" : SPIN_MODE;

  const originals = new Array(N);
  const dops      = (RIG_MODE === "paired") ? new Array(N) : null;

  // Precompute any balanced shared axes
  let Pnx=Px, Pny=Py, Pnz=Pz;
  let Qx=0, Qy=0, Qz=0;
  let rollA = 0;

  if (rigMode === "balanced"){
    const precA = localT * FIELD_PRECESS;
    const Paxis = rotateAroundAxis(Px,Py,Pz, Ux,Uy,Uz, precA);
    ;[Pnx,Pny,Pnz] = norm3(Paxis[0], Paxis[1], Paxis[2]);

    const Q = cross3(Ux,Uy,Uz, Pnx,Pny,Pnz);
    ;[Qx,Qy,Qz] = norm3(Q[0], Q[1], Q[2]);

    rollA = localT * ROLL_SPEED * (0.25 + 0.75*ENERGY);
  }

  for (let k=0; k<N; k++){
    const baseAngle = ((k - c) * slice * TWIST * spread) + biasShift;

    const dir = spinDirForPlane(k, N, spinMode);
    let perMul = 1.0;
    if (spinMode === "perPlane"){
      perMul = perPlaneSpeedMul(k, seed, PERPLANE_SPREAD);
    }

    const spinAngle = (localT * BASE_SPEED) * dir * perMul;

    let nx=Bx, ny=By, nz=Bz;

    let v = rotateAroundAxis(nx,ny,nz, Ux,Uy,Uz, baseAngle + spinAngle);
    nx=v[0]; ny=v[1]; nz=v[2];

    if (rigMode === "balanced"){
      const breath = Math.sin(localT * TAU * FIELD_BREATH_HZ) * FIELD_BREATH_A;
      const sharedTilt = (FIELD_TILT + breath) * ENERGY;

      const phase = (k / N) * TAU;
      const wob = Math.sin(localT * TAU * PERPLANE_WOB_HZ + phase) * (PERPLANE_WOB_A * ENERGY);

      let indepW = 0;
      let ax=0, ay=0, az=1;
      const indep = clamp(INDEPENDENCE, 0, 1);
      if (indep > 1e-6){
        const ra = (hash1(k + 101, seed) * TAU);
        const rb = (hash1(k + 313, seed) * TAU);
        ax = Math.cos(ra) * Math.sin(rb);
        ay = Math.sin(ra) * Math.sin(rb);
        az = Math.cos(rb);
        ;[ax,ay,az] = norm3(ax,ay,az);

        const amp = indep * 0.35 * ENERGY;
        indepW = Math.sin(localT * (0.7 + 0.3*hash1(k+777, seed)) + (k*0.37)) * amp;
      }

      v = rotateAroundAxis(nx,ny,nz, Pnx,Pny,Pnz, sharedTilt);
      nx=v[0]; ny=v[1]; nz=v[2];

      v = rotateAroundAxis(nx,ny,nz, Qx,Qy,Qz, wob);
      nx=v[0]; ny=v[1]; nz=v[2];

      v = rotateAroundAxis(nx,ny,nz, Ux,Uy,Uz, rollA);
      nx=v[0]; ny=v[1]; nz=v[2];

      if (indepW !== 0){
        v = rotateAroundAxis(nx,ny,nz, ax,ay,az, indepW);
        nx=v[0]; ny=v[1]; nz=v[2];
      }

      originals[k] = norm3(nx,ny,nz);

      if (dops){
        let dx=Bx, dy=By, dz=Bz;

        v = rotateAroundAxis(dx,dy,dz, Ux,Uy,Uz, baseAngle - spinAngle);
        dx=v[0]; dy=v[1]; dz=v[2];

        v = rotateAroundAxis(dx,dy,dz, Pnx,Pny,Pnz, -sharedTilt);
        dx=v[0]; dy=v[1]; dz=v[2];

        v = rotateAroundAxis(dx,dy,dz, Qx,Qy,Qz, -wob);
        dx=v[0]; dy=v[1]; dz=v[2];

        v = rotateAroundAxis(dx,dy,dz, Ux,Uy,Uz, -rollA);
        dx=v[0]; dy=v[1]; dz=v[2];

        if (indepW !== 0){
          v = rotateAroundAxis(dx,dy,dz, ax,ay,az, -indepW);
          dx=v[0]; dy=v[1]; dz=v[2];
        }

        dops[k] = norm3(dx,dy,dz);
      }

      continue;
    }

    // ---- TUMBLE rig ----
    const e = ENERGY;

    const ph1 = (k * 0.43) + (hash1(k + 17, seed) * TAU);
    const tilt1 = Math.sin(localT * (0.63 + 0.25*hash1(k+21, seed)) + ph1) * (0.55 * e);

    let Q = cross3(Ux,Uy,Uz, Px,Py,Pz);
    let qx=Q[0], qy=Q[1], qz=Q[2];
    ;[qx,qy,qz] = norm3(qx,qy,qz);

    const ph2 = (k * 0.71) + (hash1(k + 99, seed) * TAU);
    const tilt2 = Math.sin(localT * (0.41 + 0.22*hash1(k+55, seed)) + ph2) * (0.40 * e);

    let indepW = 0;
    let ax=0, ay=0, az=1;
    const indep = clamp(INDEPENDENCE, 0, 1);
    if (indep > 1e-6){
      const ra = (hash1(k + 211, seed) * TAU);
      const rb = (hash1(k + 223, seed) * TAU);
      ax = Math.cos(ra) * Math.sin(rb);
      ay = Math.sin(ra) * Math.sin(rb);
      az = Math.cos(rb);
      ;[ax,ay,az] = norm3(ax,ay,az);

      const amp = indep * 0.85 * e;
      indepW = Math.sin(localT * (0.95 + 0.35*hash1(k+333, seed)) + (k*0.19)) * amp;
    }

    v = rotateAroundAxis(nx,ny,nz, Px,Py,Pz, tilt1);
    nx=v[0]; ny=v[1]; nz=v[2];

    v = rotateAroundAxis(nx,ny,nz, qx,qy,qz, tilt2);
    nx=v[0]; ny=v[1]; nz=v[2];

    if (indepW !== 0){
      v = rotateAroundAxis(nx,ny,nz, ax,ay,az, indepW);
      nx=v[0]; ny=v[1]; nz=v[2];
    }

    originals[k] = norm3(nx,ny,nz);

    if (dops){
      let dx=Bx, dy=By, dz=Bz;

      v = rotateAroundAxis(dx,dy,dz, Ux,Uy,Uz, baseAngle - spinAngle);
      dx=v[0]; dy=v[1]; dz=v[2];

      v = rotateAroundAxis(dx,dy,dz, Px,Py,Pz, -tilt1);
      dx=v[0]; dy=v[1]; dz=v[2];

      v = rotateAroundAxis(dx,dy,dz, qx,qy,qz, -tilt2);
      dx=v[0]; dy=v[1]; dz=v[2];

      if (indepW !== 0){
        v = rotateAroundAxis(dx,dy,dz, ax,ay,az, -indepW);
        dx=v[0]; dy=v[1]; dz=v[2];
      }

      dops[k] = norm3(dx,dy,dz);
    }
  }

  return dops ? originals.concat(dops) : originals;
}

// ============================================================================
// Newton fractal (z^3 - 1)
// ============================================================================
function newton3(x, y, maxIters, eps){
  let zx = x, zy = y;
  let lastDx = 0, lastDy = 0;

  let it = 0;
  for (; it < maxIters; it++){
    const z2x = zx*zx - zy*zy;
    const z2y = 2*zx*zy;

    const z3x = z2x*zx - z2y*zy;
    const z3y = z2x*zy + z2y*zx;

    const fx = z3x - 1;
    const fy = z3y;

    const fmag = Math.hypot(fx, fy);
    if (fmag < eps) break;

    const dfx = 3*z2x;
    const dfy = 3*z2y;

    const denom = (dfx*dfx + dfy*dfy) || 1e-12;
    const dx = (fx*dfx + fy*dfy) / denom;
    const dy = (fy*dfx - fx*dfy) / denom;

    zx -= dx;
    zy -= dy;

    lastDx = dx;
    lastDy = dy;

    if (!Number.isFinite(zx) || !Number.isFinite(zy) || (zx*zx + zy*zy) > 1e6) break;
  }

  const ang = Math.atan2(zy, zx);
  let a = ang;
  if (a < 0) a += TAU;
  const basin = Math.max(0, Math.min(2, Math.floor((a / TAU) * 3)));

  const conv = 1 - (it / Math.max(1, maxIters));

  const stepMag = Math.hypot(lastDx, lastDy);
  const edge = clamp01(stepMag * 1.25);

  return { basin, it, conv, edge };
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

let _t0 = null;
let _prevT = null;

// ============================================================================
// Lifecycle
// ============================================================================
export function init(api){
  IDS = allTDLIds(api);
  api.resetColorsTo([1,1,1,1]);

  const est = computeCenterRadiusAndUp(api, IDS);
  center = { x: est.cx, y: est.cy, z: est.cz };
  domeR = est.rr;
  UP_AXIS = est.up;

  posX = new Float32Array(IDS.length);
  posY = new Float32Array(IDS.length);
  posZ = new Float32Array(IDS.length);

  _t0 = null;
  _prevT = null;
}

export function update(api, t/*s*/, dt/*s*/){
  t  = Number.isFinite(t)  ? t  : 0;
  dt = Number.isFinite(dt) ? dt : 0;

  if (_t0 === null){ _t0 = t; _prevT = t; }
  else if (_prevT !== null && t < _prevT - 1e-6){ _t0 = t; }
  _prevT = t;

  // base local time
  const localT0 = Math.max(0, t - _t0);

  // NEW: seeked time (fast-forward)
  const localT = Math.max(0, localT0 + Math.max(0, SEEK_SECONDS));

  // model swap safety
  const newIDS = allTDLIds(api);
  if (newIDS.length !== IDS.length){
    IDS = newIDS;
    const est = computeCenterRadiusAndUp(api, IDS);
    center = { x: est.cx, y: est.cy, z: est.cz };
    domeR = est.rr;
    UP_AXIS = est.up;

    posX = new Float32Array(IDS.length);
    posY = new Float32Array(IDS.length);
    posZ = new Float32Array(IDS.length);
  }
  if (!IDS.length) return;

  // cache positions
  for (let i=0;i<IDS.length;i++){
    const p = api.posOf(IDS[i]);
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)){
      posX[i]=p.x; posY[i]=p.y; posZ[i]=p.z;
    } else {
      posX[i]=NaN; posY[i]=NaN; posZ[i]=NaN;
    }
  }

  const invR = 1/Math.max(1e-6, domeR);

    // Axis origin (center of kaleidoscope rig) — slid in world X
    const cx = center.x;
    const cy = center.y;
    const cz = center.z + AXIS_SLIDE_X_WU;

  function bilateralFold(vx,vy,vz){
    if (BILATERAL_MODE === "x") return [Math.abs(vx), vy, vz];
    if (BILATERAL_MODE === "z") return [vx, vy, Math.abs(vz)];
    return [vx,vy,vz];
  }

  // build mirror plane normals (through center) — using SEEKed localT
  const normals = buildMirrorNormals(localT);

  // pattern time controls — using SEEKed localT
  const drift = localT * NEWTON_DRIFT;
  const rotA  = localT * NEWTON_ROT_SPEED;

  const zoomPulse = 1 + Math.sin(localT * TAU * NEWTON_ZOOM_PULSE_HZ) * NEWTON_ZOOM_PULSE_AMP;
  const scale = Math.max(1e-6, NEWTON_SCALE * zoomPulse);

  const changes = new Array(IDS.length);

  for (let i=0;i<IDS.length;i++){
    const px = posX[i];
    if (!Number.isFinite(px)){
      changes[i] = { id: IDS[i], color:[1,1,1,1] };
      continue;
    }

    let vx = (px - cx) * invR;
    let vy = (posY[i] - cy) * invR;
    let vz = (posZ[i] - cz) * invR;
    ;[vx,vy,vz] = norm3(vx,vy,vz);

    ;[vx,vy,vz] = bilateralFold(vx,vy,vz);
    ;[vx,vy,vz] = norm3(vx,vy,vz);

    let seam = 0;

    for (let it=0; it<REFLECT_ITERS; it++){
      let changed = false;

      for (let p=0; p<normals.length; p++){
        const n = normals[p];
        const d = dot3(vx,vy,vz, n[0],n[1],n[2]);

        seam = Math.max(seam, 1.0 - smoothstep(0.00, 0.12, Math.abs(d)));

        if (d < 0){
          const r = reflect3(vx,vy,vz, n[0],n[1],n[2]);
          vx = r[0]; vy = r[1]; vz = r[2];
          changed = true;
        }
      }

      if (!changed) break;
    }

    let a, b;
    if (UP_AXIS === "y"){ a = vx; b = vz; }
    else if (UP_AXIS === "z"){ a = vx; b = vy; }
    else { a = vy; b = vz; }

    {
      const cR = Math.cos(rotA), sR = Math.sin(rotA);
      const aa = a*cR - b*sR;
      const bb = a*sR + b*cR;
      a = aa; b = bb;
    }

    let aw=a, bw=b;
    if (RIPPLE_WARP > 0){
      const rr = Math.hypot(a, b);
      const wob = Math.sin(rr * RIPPLE_FREQ + drift * RIPPLE_SPEED) * RIPPLE_WARP;
      const inv = 1 / (rr + 1e-6);
      aw = a + wob * (a * inv);
      bw = b + wob * (b * inv);
    }

    const x = (aw * scale) + 0.12*Math.sin(drift*0.7);
    const y = (bw * scale) + 0.12*Math.cos(drift*0.6);

    const N3 = newton3(x, y, NEWTON_MAX_ITERS, NEWTON_EPS);

    let ink = 0;

    ink = clamp01(1 - N3.conv);
    ink = clamp01(ink + N3.edge * EDGE_GAIN);

    if (BASIN_MIX > 0){
      const basinTone = (N3.basin / 2);
      ink = clamp01(lerp(ink, clamp01(ink * (0.65 + 0.7*basinTone)), BASIN_MIX));
    }

    ink = clamp01(ink + seam * SEAM_ADD * SEAM_MIX);

    ink = clamp01(Math.pow(clamp01(ink), GAMMA));
    ink = clamp01(ink * INK_STRENGTH);

    const shade = bandedShade(ink);

    changes[i] = { id: IDS[i], color:[shade, shade, shade, 1] };
  }

  api.setColors(changes);
}
