// ripp—tdl-kaleidoscope-canon + MANDELBROT + paint-bands + SEEK_SECONDS.js
// Preview contract: init(api), update(api, t, dt)
//
// ORDER (as requested):
// 1) KALEIDOSCOPE CANON (prism rig + mirror set construction)
// 2) MANDELBROT SET (pattern source)
// 3) PAINT CONTROLS (ink shaping + grayscale bands)
//
// Notes:
// - No UI / no wireframe (pure .js like your other ripps)
// - “paired” rigMode creates a true doppelgänger for every plane:
//   same instantaneous angle components, but sign-inverted (opposite motion).
//   Fan + FanBias only affect the ORIGINAL planes; doppelgängers follow by construction.
// - SEEK_SECONDS fast-forwards the entire world (rig + pattern + any time-bucketed seed changes).
// - AXIS_SLIDE_X_WU shifts the *axis origin* in world X (fixing the off-center spine).

export const meta = {
  name: "Kaleidoscope Canon + Mandelbrot + Banded Ink — SEEK_SECONDS",
  fps: 60,
  duration: 60
};

// ============================================================================
// SEEK (global time offset) + AXIS SLIDE
// ============================================================================
const AXIS_SLIDE_X_WU = 0.0;  // try: 5, 10, 20, -10
const SEEK_SECONDS    = 0;  // try: 4, 8, 12, 18

// ============================================================================
// 1) KALEIDOSCOPE CANON — PRISM RIG (mirror plane set)
// ============================================================================
const MIRROR_PLANES = 2;   // 1..10 (low counts recommended for coarse dome)
const REFLECT_ITERS = 8;   // 6..14 (more = stronger canonical fold, can mush)

const RIG_MODE    = "tumble";    // "tumble" | "balanced" | "paired"
const PAIRED_BASE = "balanced";  // "balanced" | "tumble"
const SPIN_MODE   = "alternating";   // "uniform" | "alternating" | "halves" | "perPlane"

const BASE_SPEED = 0.40;  // radians/sec
const TWIST      = 1.0;

const FAN      = 0.00;   // [-1..1]
const FAN_BIAS = 0.00;   // [-1..1]

const ENERGY       = 0.80; // 0..2.5
const INDEPENDENCE = 0.25; // 0..1

const SEED           = 1337;
const CHANGE_RATE    = 0.0;   // seconds; 0 = locked
const PERPLANE_SPREAD= 0.35;

const FIELD_PRECESS   = 0.08; // rad/sec
const FIELD_TILT      = 0.35; // radians
const FIELD_BREATH_A  = 0.18; // radians
const FIELD_BREATH_HZ = 0.07; // cycles/sec
const PERPLANE_WOB_A  = 0.18; // radians
const PERPLANE_WOB_HZ = 0.14; // cycles/sec
const ROLL_SPEED      = 0.06; // rad/sec

const BILATERAL_MODE  = "off";  // "off" | "x" | "z"

// ============================================================================
// 2) MANDELBROT — PATTERN SOURCE (sampled AFTER reflection)
// ============================================================================
// Preserve the same “time knobs” you were using for Newton, mapped to Mandelbrot.

const MANDEL_MAX_ITERS        = 8;     // more = sharper boundary detail
const MANDEL_ESCAPE_RADIUS    = 2.5;   // 2 is canonical; bump slightly (2.5) for different feel

const MANDEL_SCALE            = 2.5;   // bigger = chunkier (less detail)
const MANDEL_ROT_SPEED        = 0.45;  // rad/sec rotate domain
const MANDEL_DRIFT            = 0.40;  // drift speed in domain
const MANDEL_ZOOM_PULSE_AMP   = 0.35;  // 0..1
const MANDEL_ZOOM_PULSE_HZ    = 0.06;  // cycles/sec

// Reuse “basin mix” as a subtle orbit-angle modulation (petal-ish variation).
const ORBIT_MIX               = .50;  // 0..0.6 subtle

// Edge emphasis (boost ink near boundary)
const EDGE_GAIN               = .51;  // 0..2

// Optional domain warp (kept from your canon)
const RIPPLE_WARP             = 0.12;  // 0 disables
const RIPPLE_FREQ             = 0.95;
const RIPPLE_SPEED            = 0.10;

// Seam scaffold (kept)
const SEAM_ADD                = 0.46;
const SEAM_MIX                = 0.60;

// ============================================================================
// 3) PAINT CONTROLS — INKING + BANDS
// ============================================================================
const INK_STRENGTH = 1.0;
const GAMMA        = 0.5;

const BAND_BRIGHT  = 0.00;
const BAND_MID     = 0.80;
const BAND_INK     = 1.00;

const BAND_T1      = 0.65;
const BAND_T2      = 0.85;
const BAND_FEATHER = 0.20;

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
function hash1(i, seed){
  let h = (i * 374761393) ^ (seed * 668265263);
  h = (h ^ (h >> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h >>> 0) / 4294967296;
}
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
  return 1 + (r - 0.5) * 2 * spread;
}

// ============================================================================
// Mirror normal builder (CANON)
// ============================================================================
function buildMirrorNormals(localT){
  const rigMode = (RIG_MODE === "paired") ? PAIRED_BASE : RIG_MODE;

  const N = Math.max(1, MIRROR_PLANES);
  const { U, B, P } = basisFromUp(UP_AXIS);
  const [Ux,Uy,Uz] = U;
  const [Bx,By,Bz] = B;
  const [Px,Py,Pz] = P;

  const slice = Math.PI / N;

  let seed = SEED | 0;
  if (CHANGE_RATE > 0.0001){
    const bump = Math.floor(localT / CHANGE_RATE) | 0;
    seed = (seed + bump * 9973) | 0;
  }

  const fan = clamp(FAN, -1, 1);
  const spread = 1 - Math.min(1, Math.abs(fan));
  const c = (N - 1) * 0.5;
  const bias = clamp(FAN_BIAS, -1, 1);
  const biasShift = bias * (slice * c);

  const spinMode = (RIG_MODE === "paired") ? "alternating" : SPIN_MODE;

  const originals = new Array(N);
  const dops      = (RIG_MODE === "paired") ? new Array(N) : null;

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

      v = rotateAroundAxis(nx,ny,nz, Pnx,Pny,Pnz, sharedTilt); nx=v[0]; ny=v[1]; nz=v[2];
      v = rotateAroundAxis(nx,ny,nz, Qx,Qy,Qz, wob);          nx=v[0]; ny=v[1]; nz=v[2];
      v = rotateAroundAxis(nx,ny,nz, Ux,Uy,Uz, rollA);        nx=v[0]; ny=v[1]; nz=v[2];
      if (indepW !== 0){
        v = rotateAroundAxis(nx,ny,nz, ax,ay,az, indepW);     nx=v[0]; ny=v[1]; nz=v[2];
      }

      originals[k] = norm3(nx,ny,nz);

      if (dops){
        let dx=Bx, dy=By, dz=Bz;

        v = rotateAroundAxis(dx,dy,dz, Ux,Uy,Uz, baseAngle - spinAngle); dx=v[0]; dy=v[1]; dz=v[2];
        v = rotateAroundAxis(dx,dy,dz, Pnx,Pny,Pnz, -sharedTilt);        dx=v[0]; dy=v[1]; dz=v[2];
        v = rotateAroundAxis(dx,dy,dz, Qx,Qy,Qz, -wob);                 dx=v[0]; dy=v[1]; dz=v[2];
        v = rotateAroundAxis(dx,dy,dz, Ux,Uy,Uz, -rollA);               dx=v[0]; dy=v[1]; dz=v[2];
        if (indepW !== 0){
          v = rotateAroundAxis(dx,dy,dz, ax,ay,az, -indepW);            dx=v[0]; dy=v[1]; dz=v[2];
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

    v = rotateAroundAxis(nx,ny,nz, Px,Py,Pz, tilt1); nx=v[0]; ny=v[1]; nz=v[2];
    v = rotateAroundAxis(nx,ny,nz, qx,qy,qz, tilt2); nx=v[0]; ny=v[1]; nz=v[2];
    if (indepW !== 0){
      v = rotateAroundAxis(nx,ny,nz, ax,ay,az, indepW);      nx=v[0]; ny=v[1]; nz=v[2];
    }

    originals[k] = norm3(nx,ny,nz);

    if (dops){
      let dx=Bx, dy=By, dz=Bz;

      v = rotateAroundAxis(dx,dy,dz, Ux,Uy,Uz, baseAngle - spinAngle); dx=v[0]; dy=v[1]; dz=v[2];
      v = rotateAroundAxis(dx,dy,dz, Px,Py,Pz, -tilt1);                dx=v[0]; dy=v[1]; dz=v[2];
      v = rotateAroundAxis(dx,dy,dz, qx,qy,qz, -tilt2);                dx=v[0]; dy=v[1]; dz=v[2];
      if (indepW !== 0){
        v = rotateAroundAxis(dx,dy,dz, ax,ay,az, -indepW);             dx=v[0]; dy=v[1]; dz=v[2];
      }

      dops[k] = norm3(dx,dy,dz);
    }
  }

  return dops ? originals.concat(dops) : originals;
}

// ============================================================================
// Mandelbrot helper
// Returns: { mu: 0..1 (smooth-ish), edge: 0..1, ang: 0..1, escaped: bool }
// ============================================================================
function mandelbrot(cx, cy, maxIters, escapeR){
  let zx = 0, zy = 0;
  let it = 0;
  let r2 = 0;

  const esc2 = escapeR * escapeR;

  for (; it < maxIters; it++){
    // z <- z^2 + c
    const zx2 = zx*zx - zy*zy + cx;
    const zy2 = 2*zx*zy + cy;
    zx = zx2; zy = zy2;

    r2 = zx*zx + zy*zy;
    if (r2 > esc2) break;
  }

  const escaped = (it < maxIters);

  // Smooth iteration (classic continuous escape time)
  let mu = it / Math.max(1, maxIters);
  if (escaped){
    const r = Math.sqrt(Math.max(1e-12, r2));
    const log_zn = Math.log(r);
    const nu = it + 1 - Math.log(Math.max(1e-12, log_zn)) / Math.log(2);
    mu = nu / Math.max(1, maxIters);
  }
  mu = clamp01(mu);

  // Boundary emphasis: only turn on near “late escape” region
  const edge = escaped ? clamp01((mu - 0.70) / 0.30) : 0;

  // Orbit angle at exit (gives gentle “petal” variation if mixed in)
  let ang = Math.atan2(zy, zx); // -pi..pi
  if (ang < 0) ang += TAU;
  ang = ang / TAU; // 0..1

  return { mu, edge, ang, escaped };
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

  const localT0 = Math.max(0, t - _t0);
  const localT  = Math.max(0, localT0 + Math.max(0, SEEK_SECONDS));

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
  const cx = center.x + AXIS_SLIDE_X_WU;
  const cy = center.y;
  const cz = center.z;

  function bilateralFold(vx,vy,vz){
    if (BILATERAL_MODE === "x") return [Math.abs(vx), vy, vz];
    if (BILATERAL_MODE === "z") return [vx, vy, Math.abs(vz)];
    return [vx,vy,vz];
  }

  // build mirror plane normals (using SEEKed localT)
  const normals = buildMirrorNormals(localT);

  // pattern time controls (using SEEKed localT)
  const drift = localT * MANDEL_DRIFT;
  const rotA  = localT * MANDEL_ROT_SPEED;

  const zoomPulse = 1 + Math.sin(localT * TAU * MANDEL_ZOOM_PULSE_HZ) * MANDEL_ZOOM_PULSE_AMP;
  const scale = Math.max(1e-6, MANDEL_SCALE * zoomPulse);

  const changes = new Array(IDS.length);

  for (let i=0;i<IDS.length;i++){
    const px = posX[i];
    if (!Number.isFinite(px)){
      changes[i] = { id: IDS[i], color:[1,1,1,1] };
      continue;
    }

    // unit ray from (slid) axis origin
    let vx = (px - cx) * invR;
    let vy = (posY[i] - cy) * invR;
    let vz = (posZ[i] - cz) * invR;
    ;[vx,vy,vz] = norm3(vx,vy,vz);

    // bilateral pre-fold
    ;[vx,vy,vz] = bilateralFold(vx,vy,vz);
    ;[vx,vy,vz] = norm3(vx,vy,vz);

    // reflect into canonical region
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

    // plane coords (from reflected ray)
    let a, b;
    if (UP_AXIS === "y"){ a = vx; b = vz; }
    else if (UP_AXIS === "z"){ a = vx; b = vy; }
    else { a = vy; b = vz; }

    // domain rotate
    {
      const cR = Math.cos(rotA), sR = Math.sin(rotA);
      const aa = a*cR - b*sR;
      const bb = a*sR + b*cR;
      a = aa; b = bb;
    }

    // gentle ripple warp
    let aw=a, bw=b;
    if (RIPPLE_WARP > 0){
      const rr = Math.hypot(a, b);
      const wob = Math.sin(rr * RIPPLE_FREQ + drift * RIPPLE_SPEED) * RIPPLE_WARP;
      const inv = 1 / (rr + 1e-6);
      aw = a + wob * (a * inv);
      bw = b + wob * (b * inv);
    }

    // map to Mandelbrot domain (+ drift)
    const x = (aw * scale) + 0.12*Math.sin(drift*0.7);
    const y = (bw * scale) + 0.12*Math.cos(drift*0.6);

    const M = mandelbrot(x, y, MANDEL_MAX_ITERS, MANDEL_ESCAPE_RADIUS);

    // Build ink:
    // - Use escape-time near boundary; keep interior mostly bright (ink=0)
    let ink = 0;

    // Base from iteration (late-escape => higher ink)
    ink = M.escaped ? M.mu : 0;

    // Edge emphasis (kicks in only near boundary)
    ink = clamp01(ink + M.edge * EDGE_GAIN);

    // Orbit-angle modulation (optional; similar spirit to BASIN_MIX petals)
    if (ORBIT_MIX > 0){
      // 3-lobed modulation (soft “petal” suggestion)
      const pet = 0.5 + 0.5*Math.cos((M.ang * TAU) * 3.0);
      ink = clamp01(lerp(ink, clamp01(ink * (0.70 + 0.60*pet)), ORBIT_MIX));
    }

    // seam scaffold
    ink = clamp01(ink + seam * SEAM_ADD * SEAM_MIX);

    // paint shaping
    ink = clamp01(Math.pow(clamp01(ink), GAMMA));
    ink = clamp01(ink * INK_STRENGTH);

    // grayscale bands
    const shade = bandedShade(ink);

    changes[i] = { id: IDS[i], color:[shade, shade, shade, 1] };
  }

  api.setColors(changes);
}
