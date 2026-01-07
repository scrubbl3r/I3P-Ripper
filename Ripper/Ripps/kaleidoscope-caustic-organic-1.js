// ripp—tdl-kaleidoscope-prism-greatcircle-bands-v3-BALANCED ( + SEEK_SECONDS).js
// Preview contract: init(api), update(api, t, dt)
//
// Adds SEEK_SECONDS (fast-forward) exactly like your canon+newton+bands ripp:
// - local timeline still starts at 0 on init and resets on backward scrubs
// - then we add SEEK_SECONDS on top (clamped >= 0)
// - affects: mirror rig motion (spin/field/wobble/roll), domain drift, ripple warp,
//   and the PHASE_BLACK gate (so SEEK can skip the initial black flash)

export const meta = {
  name: "Kaleidoscope (prism v3 • Balanced): Organic motion + distribution-preserving mirror set + grayscale bands (SEEK_SECONDS)",
  fps: 60,
  duration: 60
};

// ============================================================================
// SEEK (global time offset)
// ============================================================================
// Start as if the ripp has already been running for N seconds.
// This affects: mirror rig motion, drift, ripple warp, and the phase-black gate.
const SEEK_SECONDS = 0.; // moments: 2.1, 

// ============================================================================
// PRISM CHAMBER (baseline)
// ============================================================================
const MIRROR_PLANES = 4;        // 2..8
const REFLECT_ITERS = 8;

const PLANE_ROT_SPEED = 0.40;   // rad/sec (global spin about UP)
const PLANE_TWIST     = 0.90;   // 0..1.5

// ============================================================================
// ORGANIC BUT ALWAYS BALANCED (NEW)
// Strategy:
// - Start from a perfectly symmetric mirror set (evenly spaced around UP).
// - Apply *the same* low-frequency organic field to all planes (so the set
//   stays coherent, not clumpy).
// - Add a per-plane wobble that is perfectly phase-distributed around the set
//   (so the wobble cancels globally and stays “balanced”).
// ============================================================================

// Shared organic field (affects entire mirror rig)
const FIELD_PRECESS_SPEED = 0.08;  // rad/sec (slow drift of field axis around UP)
const FIELD_TILT_ANGLE    = 0.35;  // radians (how far the rig tilts; 0 = upright)
const FIELD_TILT_BREATH   = 0.18;  // radians (extra breathing tilt)
const FIELD_BREATH_FREQ   = 0.07;  // cycles/sec

// Balanced per-plane wobble (distributed phases, cancels globally)
const PERPLANE_WOB_ANGLE  = 0.18;  // radians (micro-tilt)
const PERPLANE_WOB_FREQ   = 0.14;  // cycles/sec
const PERPLANE_WOB_TWIST  = 1.00;  // phase rotation across planes (1=even)

// Optional: keep a clean carousel spin (can be your “music” axis)
const ROLL_SPEED          = 0.06;  // rad/sec (slow roll around UP)

// Quick proof flash
const PHASE_BLACK = 0.06;

// ============================================================================
// PATTERN DOMAIN (unchanged)
// ============================================================================
const PATTERN_SCALE  = 0.50;
const DRIFT_SPEED    = 0.30;
const FILAMENT_THICK = 0.70;
const FILAMENT_GAIN  = 1.00;

const RING_COUNT = 5;
const RING_WIDTH = 0.30;

const INK_STRENGTH = 1.0;
const GAMMA = 0.95;

const SEAM_ADD = 0.12;

// KEEP THESE (requested)
const FILAMENT_MIX = 1.00;
const RING_MIX     = 0.95;
const SEAM_MIX     = 1.50;

const RIPPLE_WARP  = 0.4;
const RIPPLE_FREQ  = 2.2;
const RIPPLE_SPEED = 0.6;

// Grayscale bands
const BAND_BRIGHT = 1.00;
const BAND_MID    = 0.25;
const BAND_INK    = 0.00;

const BAND_T1      = 0.75;
const BAND_T2      = 0.55;
const BAND_FEATHER = 0.50;

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
const clamp = (x,a,b)=> x < a ? a : (x > b ? b : x);
const fract = (x)=> x - Math.floor(x);
const lerp = (a,b,t)=> a + (b - a) * t;

function smoothstep(e0,e1,x){
  if (e1 <= e0) return x >= e1 ? 1 : 0;
  const t = clamp01((x - e0) / (e1 - e0));
  return t*t*(3 - 2*t);
}
function norm3(x,y,z){
  const m = Math.hypot(x,y,z) || 1;
  return [x/m, y/m, z/m];
}
function dot3(ax,ay,az,bx,by,bz){ return ax*bx + ay*by + az*bz; }
function cross3(ax,ay,az,bx,by,bz){
  return [ay*bz - az*by, az*bx - ax*bz, ax*by - ay*bx];
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

function filament(u, v, thick){
  const a = Math.abs(fract(u + v) - 0.5) * 2.0;
  const b = Math.abs(fract(u - v) - 0.5) * 2.0;
  const c = Math.abs(fract(u) - 0.5) * 2.0;
  const d = Math.abs(fract(v) - 0.5) * 2.0;
  const line = Math.min(Math.min(a, b), Math.min(c, d));
  return 1.0 - smoothstep(0.0, thick, line);
}
function ringBand(r, rings, width){
  const u = r * rings;
  const d = Math.abs(fract(u) - 0.5) * 2.0;
  return 1.0 - smoothstep(0.0, width, d);
}
function bandedShade(ink){
  const f = Math.max(1e-6, BAND_FEATHER);
  const a = smoothstep(BAND_T1 - f, BAND_T1 + f, ink);
  const b = smoothstep(BAND_T2 - f, BAND_T2 + f, ink);
  const bm = lerp(BAND_BRIGHT, BAND_MID, a);
  return lerp(bm, BAND_INK, b);
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

  // local time origin; reset on backward scrub
  if (_t0 === null){ _t0 = t; _prevT = t; }
  else if (_prevT !== null && t < _prevT - 1e-6){ _t0 = t; }
  _prevT = t;

  // base local timeline
  const localT0 = Math.max(0, t - _t0);

  // NEW: seeked time (fast-forward, clamped >= 0)
  const localT = Math.max(0, localT0 + Math.max(0, SEEK_SECONDS));

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

  for (let i=0;i<IDS.length;i++){
    const p = api.posOf(IDS[i]);
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)){
      posX[i]=p.x; posY[i]=p.y; posZ[i]=p.z;
    } else {
      posX[i]=NaN; posY[i]=NaN; posZ[i]=NaN;
    }
  }

  const invR = 1/Math.max(1e-6, domeR);
  const cx=center.x, cy=center.y, cz=center.z;

  const changes = new Array(IDS.length);

  // SEEK affects this gate too (so you can skip the initial black flash)
  if (localT < PHASE_BLACK){
    for (let i=0;i<IDS.length;i++) changes[i] = { id: IDS[i], color:[0,0,0,1] };
    api.setColors(changes);
    return;
  }

  // Build symmetry-locked base set around UP
  let Ux=0, Uy=1, Uz=0;
  let Bx=1, By=0, Bz=0;
  let Px=0, Py=0, Pz=1;

  if (UP_AXIS === "x"){ Ux=1;Uy=0;Uz=0;  Bx=0;By=0;Bz=1;  Px=0;Py=1;Pz=0; }
  else if (UP_AXIS === "z"){ Ux=0;Uy=0;Uz=1;  Bx=1;By=0;Bz=0;  Px=0;Py=1;Pz=0; }
  else { Ux=0;Uy=1;Uz=0;  Bx=1;By=0;Bz=0;  Px=0;Py=0;Pz=1; }

  const baseSpin = localT * PLANE_ROT_SPEED;
  const rollA    = localT * ROLL_SPEED;

  // Shared organic field axis that precesses around UP
  const precA = localT * FIELD_PRECESS_SPEED;
  let P = rotateAroundAxis(Px,Py,Pz, Ux,Uy,Uz, precA);
  let Pnx=P[0], Pny=P[1], Pnz=P[2];
  ;[Pnx,Pny,Pnz] = norm3(Pnx,Pny,Pnz);

  // Orthogonal axis Q to apply balanced per-plane wobble
  let Q = cross3(Ux,Uy,Uz, Pnx,Pny,Pnz);
  let Qx=Q[0], Qy=Q[1], Qz=Q[2];
  ;[Qx,Qy,Qz] = norm3(Qx,Qy,Qz);

  // Shared “breathing” tilt (same for all planes)
  const breath = Math.sin(localT * TAU * FIELD_BREATH_FREQ) * FIELD_TILT_BREATH;
  const sharedTilt = FIELD_TILT_ANGLE + breath;

  const normals = [];
  const slice = TAU / Math.max(1, MIRROR_PLANES);

  for (let k=0;k<MIRROR_PLANES;k++){
    const a = baseSpin + k * slice * PLANE_TWIST;

    // evenly spaced around UP
    let n = rotateAroundAxis(Bx,By,Bz, Ux,Uy,Uz, a);
    let nx=n[0], ny=n[1], nz=n[2];

    // shared tilt about P (organic field)
    n = rotateAroundAxis(nx,ny,nz, Pnx,Pny,Pnz, sharedTilt);
    nx=n[0]; ny=n[1]; nz=n[2];

    // balanced per-plane wobble: same freq, phase distributed around set
    const phase = (k / Math.max(1, MIRROR_PLANES)) * TAU * PERPLANE_WOB_TWIST;
    const wob = Math.sin(localT * TAU * PERPLANE_WOB_FREQ + phase) * PERPLANE_WOB_ANGLE;

    n = rotateAroundAxis(nx,ny,nz, Qx,Qy,Qz, wob);
    nx=n[0]; ny=n[1]; nz=n[2];

    // gentle roll around UP (carousel coherence)
    n = rotateAroundAxis(nx,ny,nz, Ux,Uy,Uz, rollA);
    nx=n[0]; ny=n[1]; nz=n[2];

    normals.push(norm3(nx,ny,nz));
  }

  const drift = localT * DRIFT_SPEED;

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

    let aa, bb;
    if (UP_AXIS === "y"){ aa = vx; bb = vz; }
    else if (UP_AXIS === "z"){ aa = vx; bb = vy; }
    else { aa = vy; bb = vz; }

    // ripple warp
    let aw = aa, bw = bb;
    if (RIPPLE_WARP > 0){
      const rr = Math.hypot(aa, bb);
      const wob = Math.sin(rr * RIPPLE_FREQ + drift * RIPPLE_SPEED) * RIPPLE_WARP;
      const inv = 1 / (rr + 1e-6);
      aw = aa + wob * (aa * inv);
      bw = bb + wob * (bb * inv);
    }

    // filaments
    const u = (aw * PATTERN_SCALE) + drift * 0.25;
    const v = (bw * PATTERN_SCALE) + drift * 0.18;

    const f1 = filament(u, v, FILAMENT_THICK);
    const f2 = filament(u*1.7 - drift*0.22, v*1.4 + drift*0.20, FILAMENT_THICK*0.85);

    let ink = Math.max(f1, f2) * FILAMENT_GAIN * FILAMENT_MIX;

    // rings
    const up = (UP_AXIS === "y") ? vy : (UP_AXIS === "z") ? vz : vx;
    const polar = Math.acos(clamp(up, -1, 1));
    const rr2 = polar / Math.PI;

    const rings = ringBand(rr2 + 0.05*Math.sin(drift*0.6), RING_COUNT, RING_WIDTH);
    ink = Math.max(ink, rings * 0.70 * RING_MIX);

    ink = clamp01(ink + seam * SEAM_ADD * SEAM_MIX);

    ink = clamp01(Math.pow(clamp01(ink), GAMMA));
    ink = clamp01(ink * INK_STRENGTH);

    const shade = bandedShade(ink);
    changes[i] = { id: IDS[i], color:[shade, shade, shade, 1] };
  }

  api.setColors(changes);
}
