// ripp—tdl-kaleidoscope-prism-greatcircle-bands-v3.js
// Preview contract: init(api), update(api, t, dt)

export const meta = {
  name: "Kaleidoscope (prism v3): Great-circle mirrors + mixers + ripple warp + grayscale bands",
  fps: 60,
  duration: 60
};

// ============================================================================
// PRISM CHAMBER
// ============================================================================
const MIRROR_PLANES = 4;        // 2..8 (more = more facets)
const REFLECT_ITERS = 8;        // 2..6 (more = richer but can mush)

// Mirror plane motion
const PLANE_ROT_SPEED = 0.40;   // rad/sec
const PLANE_TWIST     = .90;   // 0..1.5

// ============================================================================
// PATTERN DOMAIN (sampled AFTER reflection)
// ============================================================================
const PATTERN_SCALE  = .70;    // bigger = chunkier
const DRIFT_SPEED    = 0.30;
const FILAMENT_THICK = 0.50;
const FILAMENT_GAIN  = 1.00;

// Radial scaffold (lens rings)
const RING_COUNT = 5;
const RING_WIDTH = 0.30;

// Output shaping
const INK_STRENGTH = 1.0;
const GAMMA = 0.95;

// Seam scaffold (great-circle boundaries)
const SEAM_ADD = 0.12;

// ============================================================================
// KEEP THESE (requested): independent layer mixes + ripple warp knobs
// ============================================================================
const FILAMENT_MIX = 1.00; // 0..1.5
const RING_MIX     = 0.95; // 0..1.5
const SEAM_MIX     = 1.50; // 0..1.5

const RIPPLE_WARP  = 0.4; // 0 disables; ~0.1–0.6
const RIPPLE_FREQ  = 2.2;  // 1–6
const RIPPLE_SPEED = 0.6;  // 0.2–1.5

// ============================================================================
// NEW: CONTROLLED GRAYSCALE BANDS (ink → mid → bright)
// Instead of just "white background + black ink", we quantize ink into 3 tones,
// with smooth band transitions to reduce shimmer on the coarse dome.
// ============================================================================
const BAND_BRIGHT = 1.00;  // background / highlight
const BAND_MID    = 0.25;  // mid-gray fill
const BAND_INK    = 0.0;  // darkest ink (not necessarily pure black)

const BAND_T1     = 0.75;  // ink threshold for bright→mid
const BAND_T2     = 0.55;  // ink threshold for mid→ink
const BAND_FEATHER = 0.55; // softness of band edges (0.02–0.15)

// ============================================================================
// Schema helpers (your contract)
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

// reflect v across plane with unit normal n
function reflect3(vx,vy,vz, nx,ny,nz){
  const d = dot3(vx,vy,vz, nx,ny,nz);
  return [vx - 2*d*nx, vy - 2*d*ny, vz - 2*d*nz];
}
function rotY(x,z,a){
  const c = Math.cos(a), s = Math.sin(a);
  return [x*c - z*s, x*s + z*c];
}
function rotX(y,z,a){
  const c = Math.cos(a), s = Math.sin(a);
  return [y*c - z*s, y*s + z*c];
}
function rotZ(x,y,a){
  const c = Math.cos(a), s = Math.sin(a);
  return [x*c - y*s, x*s + y*c];
}

// chunky filament lattice in 2D tile space
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

// banded grayscale mapping (ink 0..1 -> shade 0..1)
function bandedShade(ink){
  const f = Math.max(1e-6, BAND_FEATHER);

  const a = smoothstep(BAND_T1 - f, BAND_T1 + f, ink); // bright->mid
  const b = smoothstep(BAND_T2 - f, BAND_T2 + f, ink); // mid->ink

  const bm = lerp(BAND_BRIGHT, BAND_MID, a);
  return lerp(bm, BAND_INK, b);
}

// ============================================================================
// State (positions + center/radius + local time)
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

// auto-up detector (stable enough for our purposes)
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

  if (_t0 === null){ _t0 = t; _prevT = t; }
  else if (_prevT !== null && t < _prevT - 1e-6){ _t0 = t; }
  _prevT = t;

  const localT = Math.max(0, t - _t0);

  // model swap
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
  const cx=center.x, cy=center.y, cz=center.z;

  // Mirror plane normals (through center), rotating over time.
  const baseA = localT * PLANE_ROT_SPEED;
  const normals = [];

  // stable starting direction
  let bx=1, by=0, bz=0;
  if (UP_AXIS === "x"){ bx=0; by=1; bz=0; }

  for (let k=0;k<MIRROR_PLANES;k++){
    const a = baseA + k * (TAU / MIRROR_PLANES) * PLANE_TWIST;

    let x=bx, y=by, z=bz;
    ;[x,z] = rotY(x,z, a);
    ;[y,z] = rotX(y,z, a*0.63 + k*0.4);
    ;[x,y] = rotZ(x,y, a*0.41);

    normals.push(norm3(x,y,z));
  }

  const drift = localT * DRIFT_SPEED;
  const changes = new Array(IDS.length);

  for (let i=0;i<IDS.length;i++){
    const px = posX[i];
    if (!Number.isFinite(px)){
      changes[i] = { id: IDS[i], color:[1,1,1,1] };
      continue;
    }

    // unit ray from center
    let vx = (px - cx) * invR;
    let vy = (posY[i] - cy) * invR;
    let vz = (posZ[i] - cz) * invR;
    ;[vx,vy,vz] = norm3(vx,vy,vz);

    // reflect into canonical region (dot >= 0 for all planes)
    let seam = 0;

    for (let it=0; it<REFLECT_ITERS; it++){
      let changed = false;

      for (let p=0; p<normals.length; p++){
        const n = normals[p];
        const d = dot3(vx,vy,vz, n[0],n[1],n[2]);

        // seam proximity scaffold (distance to plane)
        seam = Math.max(seam, 1.0 - smoothstep(0.00, 0.12, Math.abs(d)));

        if (d < 0){
          const r = reflect3(vx,vy,vz, n[0],n[1],n[2]);
          vx = r[0]; vy = r[1]; vz = r[2];
          changed = true;
        }
      }

      if (!changed) break;
    }

    // sample plane coords (from reflected ray)
    let a, b;
    if (UP_AXIS === "y"){ a = vx; b = vz; }
    else if (UP_AXIS === "z"){ a = vx; b = vy; }
    else { a = vy; b = vz; }

    // ----------------------------------------------------------------------
    // RIPPLE WARP BLOCK (domain warp before filaments)
    // ----------------------------------------------------------------------
    let aw = a, bw = b;
    if (RIPPLE_WARP > 0){
      const rr = Math.hypot(a, b);
      const wob = Math.sin(rr * RIPPLE_FREQ + drift * RIPPLE_SPEED) * RIPPLE_WARP;

      const inv = 1 / (rr + 1e-6);
      aw = a + wob * (a * inv);
      bw = b + wob * (b * inv);
    }

    // filament domain (chunky, drifted)
    const u = (aw * PATTERN_SCALE) + drift * 0.25;
    const v = (bw * PATTERN_SCALE) + drift * 0.18;

    const f1 = filament(u, v, FILAMENT_THICK);
    const f2 = filament(u*1.7 - drift*0.22, v*1.4 + drift*0.20, FILAMENT_THICK*0.85);

    let ink = Math.max(f1, f2) * FILAMENT_GAIN * FILAMENT_MIX;

    // radial rings (use reflected "up")
    const up = (UP_AXIS === "y") ? vy : (UP_AXIS === "z") ? vz : vx;
    const polar = Math.acos(clamp(up, -1, 1));
    const rr2 = polar / Math.PI;

    const rings = ringBand(rr2 + 0.05*Math.sin(drift*0.6), RING_COUNT, RING_WIDTH);
    ink = Math.max(ink, rings * 0.70 * RING_MIX);

    // seam scaffold (additive, safe)
    ink = clamp01(ink + seam * SEAM_ADD * SEAM_MIX);

    // output shaping
    ink = clamp01(Math.pow(clamp01(ink), GAMMA));
    ink = clamp01(ink * INK_STRENGTH);

    // NEW: banded grayscale output
    const shade = bandedShade(ink);
    changes[i] = { id: IDS[i], color:[shade, shade, shade, 1] };
  }

  api.setColors(changes);
}
