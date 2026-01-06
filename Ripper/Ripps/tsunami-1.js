// ripp—tsunami—planewave—pose-gated (START_AZ_DEG, clean-start, engage-gate).js
// Preview contract: init(api), update(api, t, dt)
//
// "Tsunami" = a moving/rotating plane that sweeps across the dome with a soft, rippled edge.
//
// Fix (your flashing after lowering start Y):
//   We add an **ENGAGE GATE** so the loop cannot immediately "complete" (monochrome)
//   until the plane has actually *engaged* the dome at least once (seen a mixed edge).
//
// Master pose knob:
//   START_AZ_DEG (0..360) rotates the whole rig about dome Y.
//
// Time canon: motion uses host `t` (seconds). dt not required for motion timing here.

export const meta = {
  name: "Tsunami — planewave (pose rotatable) + engage-gated loop (prevents flash on clean start)",
  fps: 60,
  duration: 120
};

// ============================================================================
// POSE (master direction knob)
// ============================================================================
const START_AZ_DEG = 300; // 0..360 (try 0, 90, 180, 270)

// ============================================================================
// COLORS
// ----------------------------------------------------------------------------
// Side-of-plane paint: +n side gets POS_COLOR, −n side gets NEG_COLOR.
// We invert these on each loop restart.
// For "start pure black", make BASE black.
const BASE = [0, 0, 0, 1]; // −n side (initially BLACK)  <-- start dome black
const RED  = [1, 1, 1, 1]; // +n side (initially WHITE)

// ============================================================================
// MOTION
// ============================================================================
const TILT_X_DEG     = 20;   // fixed tilt about X
const SPIN_PERIOD_MS = 2000; // one full revolution around Y per 2000 ms

// Independent sweeps & Z tumble
const X_SWEEP_MS   = 2700; // ms: x : (+X0 → +X1)
const Y_SWEEP_MS   = 2900; // ms: y : (+Y0 → +Y1)
const Z_TUMBLE_MS  = 3000; // ms: rz: 0° → +90°
const PAUSE_MS     = 1000; // hold time between loops (monochrome pause)

// ============================================================================
// PATH (this is the area you were tweaking)
// ----------------------------------------------------------------------------
// These are the *unposed* sweep endpoints relative to center.
// If you want to start “lower”, adjust Y0_WU and/or START_Y_EXTRA_WU.
// If you want to start “further out”, adjust X0_WU and/or START_X_PAD_WU.
// ============================================================================
const X0_WU = 70;
const X1_WU = -70;

const Y0_WU = -61;  // <-- your "culprit" value (try -60 etc.)
const Y1_WU =  57;

// Optional pads (safe knobs)
const START_X_PAD_WU   = 0;  // try 10..60 if you ever see early intersection at t=0
const START_Y_EXTRA_WU = 0;  // try 1..10 to push the whole path down a bit

// ============================================================================
// SOFT, UNDULATING EDGE (rippled feather)
// ============================================================================
const FEATHER_WU      = 4.5;
const RIPPLE_AMP_WU   = 3.0;
const FEATHER_GAIN    = 0.75;
const RIPPLE_FREQ_CYC = 4.2;
const RIPPLE_SPEED_HZ = 0.06;

// ============================================================================
// Helpers
// ============================================================================
const sub = (a,b)=>({x:a.x-b.x, y:a.y-b.y, z:a.z-b.z});
function allTDLIds(api){
  const T = Array.isArray(api?.ids?.T) ? api.ids.T : [];
  const D = Array.isArray(api?.ids?.D) ? api.ids.D : [];
  const L = Array.isArray(api?.ids?.L) ? api.ids.L : [];
  return [...new Set([...T, ...D, ...L])];
}
function rad(d){ return d * Math.PI / 180; }
function clamp01(x){ return x<0?0:x>1?1:x; }
function mix(a,b,t){ return a + (b-a)*t; }
function smoothstep(a,b,x){ const t=clamp01((x-a)/(b-a)); return t*t*(3-2*t); }
function dot(a,b){ return a.x*b.x + a.y*b.y + a.z*b.z; }
function cross(a,b){ return { x:a.y*b.z - a.z*b.y, y:a.z*b.x - a.x*b.z, z:a.x*b.y - a.y*b.x }; }
function norm(v){ const L=Math.hypot(v.x,v.y,v.z)||1; return {x:v.x/L, y:v.y/L, z:v.z/L}; }

// Rotate base +Y by Euler angles (apply X→Y→Z) and return unit normal
function normalFromEuler(rx, ry, rz){
  let nx = 0, ny = 1, nz = 0; // start from +Y
  { const c=Math.cos(rx), s=Math.sin(rx); const ny1 = ny*c - nz*s; const nz1 = ny*s + nz*c; ny = ny1; nz = nz1; }
  { const c=Math.cos(ry), s=Math.sin(ry); const nx1 = nx*c + nz*s; const nz1 = -nx*s + nz*c; nx = nx1; nz = nz1; }
  { const c=Math.cos(rz), s=Math.sin(rz); const nx1 = nx*c - ny*s; const ny1 = nx*s + ny*c; nx = nx1; ny = ny1; }
  const inv = 1 / Math.hypot(nx, ny, nz);
  return { x: nx*inv, y: ny*inv, z: nz*inv };
}

// --- Master pose rotation (yaw about Y) -------------------------------------
function rotY_vec(v, yaw){
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return { x: v.x*c + v.z*s, y: v.y, z: -v.x*s + v.z*c };
}
function rotY_aboutCenter(p, yaw, c0){
  const v = { x: p.x - c0.x, y: p.y - c0.y, z: p.z - c0.z };
  const r = rotY_vec(v, yaw);
  return { x: c0.x + r.x, y: c0.y + r.y, z: c0.z + r.z };
}

// Build a stable local (uT,vT) tangent basis for the current plane normal n
function planeBasis(n){
  const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
  const ref = (ax<ay && ax<az) ? {x:1, y:0, z:0} : (ay<az ? {x:0,y:1,z:0} : {x:0,y:0,z:1});
  const uT = norm(cross(ref, n));
  const vT = cross(n, uT); // already unit
  return { uT, vT };
}

// Compute ripple, adaptive feather and effective signed distance for a point p
function edgeProfileForPoint(p, planePoint, n, timeSec){
  const r = sub(p, planePoint);
  const { uT, vT } = planeBasis(n);
  const u = dot(r, uT);
  const v = dot(r, vT);
  const theta = Math.atan2(v, u); // [-π, π]
  const phase = 2*Math.PI*RIPPLE_SPEED_HZ*timeSec;
  const ripple = RIPPLE_AMP_WU * Math.sin(theta * RIPPLE_FREQ_CYC + phase);
  const featherWU = FEATHER_WU + FEATHER_GAIN * Math.abs(ripple);
  const dRaw = dot(r, n);
  const dEff = dRaw - ripple;
  return { dEff, featherWU };
}

// ============================================================================
// State
// ============================================================================
let IDS = [];
let center = {x:0,y:0,z:0};
let domeR = 250;

let n = {x:0,y:1,z:0};           // plane normal (unit)
let planePoint = {x:0,y:0,z:0};  // point on plane

// animation timing (relative to a latched start)
let t0_ms = null;        // sweep/tumble start time
let spinOffsetMs = null; // Y-spin phase offset (so spin restarts at same pose)

// loop control
let state = "run";       // 'run' | 'pause'
let pauseStartMs = 0;
let invertColors = false;

// engage gate: becomes true once we ever see a “mixed” condition this run
let hasEngaged = false;

// yaw pose cached after init (depends on START_AZ_DEG)
let _yawRad = 0;

// ============================================================================
// Lifecycle
// ============================================================================
export function init(api){
  IDS = allTDLIds(api);
  api.resetColorsTo(BASE);

  if (api?.info && Number.isFinite(api.info.radius)) domeR = api.info.radius;
  if (api?.info && api.info.center){
    center = { x: api.info.center.x||0, y: api.info.center.y||0, z: api.info.center.z||0 };
  }

  _yawRad = rad(((START_AZ_DEG % 360) + 360) % 360);

  resetMotion(/*nowMs=*/0);

  // Initial orientation: X tilt only (then yaw pose applied)
  const nLocal = normalFromEuler(rad(TILT_X_DEG), 0, 0);
  n = rotY_vec(nLocal, _yawRad);

  paint(api, /*timeSec=*/0);
}

// Reset all motion timers/poses to the canonical start values
function resetMotion(nowMs){
  // start pose: use the same base x/y endpoints; place at sweep start (ux=0, uy=0)
  const startX = X0_WU + Math.max(0, START_X_PAD_WU);
  const startY = (Y0_WU - Math.max(0, START_Y_EXTRA_WU));

  const p0 = { x: center.x + startX, y: center.y + startY, z: center.z };
  planePoint = rotY_aboutCenter(p0, _yawRad, center);

  t0_ms = null;
  spinOffsetMs = null;
  state = "run";
  hasEngaged = false;
}

// ============================================================================
// Frame
// ============================================================================
export function update(api, t/*s*/, dt/*s*/){
  if (!IDS.length) init(api);

  const nowMs = Math.max(0, t*1000);
  const timeSec = t;

  // latch timers after a reset
  if (state === "run"){
    if (t0_ms === null) t0_ms = nowMs;
    if (spinOffsetMs === null) spinOffsetMs = nowMs; // spin starts at ry=0
  }

  if (state === "pause"){
    // During pause we do not repaint (keeps previous frame frozen)
    if (nowMs - pauseStartMs >= PAUSE_MS){
      invertColors = !invertColors;
      resetMotion(nowMs);
    }
    return;
  }

  // --- Y spin (continuous, phase-locked) -----------------------------------
  const spinU = ((nowMs - spinOffsetMs) % SPIN_PERIOD_MS) / SPIN_PERIOD_MS; // 0..1
  const ry = spinU * 2 * Math.PI;

  // --- Independent sweeps ---------------------------------------------------
  const ux = clamp01((nowMs - t0_ms) / X_SWEEP_MS);
  const uy = clamp01((nowMs - t0_ms) / Y_SWEEP_MS);

  // base (un-posed) sweep
  const y0 = (Y0_WU - Math.max(0, START_Y_EXTRA_WU));
  const y1 = (Y1_WU - Math.max(0, START_Y_EXTRA_WU));

  const pBase = {
    x: mix(center.x + X0_WU, center.x + X1_WU, ux),
    y: mix(center.y + y0,   center.y + y1,   uy),
    z: center.z
  };

  // apply master yaw pose to path
  planePoint = rotY_aboutCenter(pBase, _yawRad, center);

  // --- Z tumble to +90° -----------------------------------------------------
  const uz = clamp01((nowMs - t0_ms) / Z_TUMBLE_MS);
  const rz = rad(90 * uz);

  // Compose orientation: fixed X tilt, spinning Y, tumbling Z (then yaw pose)
  const nLocal = normalFromEuler(rad(TILT_X_DEG), ry, rz);
  n = rotY_vec(nLocal, _yawRad);

  // --- Engage-gated monochrome detection -----------------------------------
  const s = monoState(api, timeSec);
  hasEngaged = hasEngaged || s.engagedNow;
  const becameMono = hasEngaged && s.monoNow;

  // Paint this frame first so the frozen state matches exactly
  paint(api, timeSec);

  if (becameMono){
    state = "pause";
    pauseStartMs = nowMs;

    // Prep next run; colors remain frozen during pause since we skip repaint
    resetMotion(nowMs);
    state = "pause";
  }
}

// ============================================================================
// Engage-aware monochrome state
// ----------------------------------------------------------------------------
// engagedNow: we have a "mixed" condition (edge band present OR both sides present)
// monoNow:    fully past soft edge AND all points on one side
// ============================================================================
function monoState(api, timeSec){
  let pos = 0, neg = 0, mid = 0;
  const EPS = 0.25;

  for (const id of IDS){
    const p = api.posOf(id);
    if (!p || !Number.isFinite(p.x)) continue;

    const { dEff, featherWU } = edgeProfileForPoint(p, planePoint, n, timeSec);

    if (dEff >  featherWU + EPS) pos++;
    else if (dEff < -featherWU - EPS) neg++;
    else mid++;
  }

  const engagedNow = (mid > 0) || (pos > 0 && neg > 0);
  const monoNow = (mid === 0) && (pos === 0 || neg === 0);

  return { engagedNow, monoNow };
}

// ============================================================================
// Paint: side-of-plane coloring (feathered ripple edge)
// ============================================================================
function paint(api, timeSec){
  const POS_COLOR = invertColors ? BASE : RED; // +n side
  const NEG_COLOR = invertColors ? RED  : BASE; // −n side

  const changes = [];

  for (const id of IDS){
    const p = api.posOf(id);
    if (!p || !Number.isFinite(p.x)) continue;

    const { dEff, featherWU } = edgeProfileForPoint(p, planePoint, n, timeSec);

    const t = smoothstep(-featherWU, featherWU, dEff); // 0 on −n → 1 on +n
    const r = NEG_COLOR[0] + (POS_COLOR[0] - NEG_COLOR[0]) * t;
    const g = NEG_COLOR[1] + (POS_COLOR[1] - NEG_COLOR[1]) * t;
    const b = NEG_COLOR[2] + (POS_COLOR[2] - NEG_COLOR[2]) * t;
    const a = NEG_COLOR[3] + (POS_COLOR[3] - NEG_COLOR[3]) * t;

    changes.push({ id, color: [r, g, b, a] });
  }

  if (changes.length) api.setColors(changes);
}
