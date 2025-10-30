// ripp—planewave—diagnostic (tiltX+25, spinY 2s, XY sweep + Z→90, side-paint, pause+invert+restart).js
// Preview contract: init(api), update(api, t, dt)

export const meta = { name: 'Planewave — tiltX+25, spinY 2s, sweep+tumble (pause 1s on monochrome, invert, restart)', fps: 30, duration: 120 };

// ---- Tunables --------------------------------------------------------------
// Colors are "side-of-plane": +n side gets POS_COLOR, −n side gets NEG_COLOR.
// We invert these on each loop restart.
const BASE = [1, 1, 1, 1];        // −n side (initially blue)
const RED  = [0, 0, 0, 1];        // +n side (initially white)

const TILT_X_DEG     = 20;        // fixed tilt about X
const SPIN_PERIOD_MS = 2000;      // one full revolution around Y per 2000 ms

// Independent sweeps & Z tumble
const X_SWEEP_MS   = 2700;        // ms: x : (+70 → −70)
const Y_SWEEP_MS   = 2900;        // ms: y : (−57 → +57)
const Z_TUMBLE_MS  = 3000;        // ms: rz: 0° → +90°
const PAUSE_MS     = 10;        // hold time between loops

/* Soft, undulating edge parameters
   FEATHER_WU      : base half-width of the feather band (WU)
   RIPPLE_AMP_WU   : sinusoidal offset of the plane (in world units); small = subtle curvature
   FEATHER_GAIN    : extra feather added proportionally to |ripple| (taller peaks ⇒ softer blend)
   RIPPLE_FREQ_CYC : number of crests around 2π in the local (u,v) angular coordinate
   RIPPLE_SPEED_HZ : temporal speed of the ripple phase (Hz)
   Notes:
   - These values are intentionally mild so motion timing is visually preserved.
   - Both paint() and isMonochrome() use the SAME computations to stay consistent.
*/
const FEATHER_WU      = 2.5;
const RIPPLE_AMP_WU   = 3.0;
const FEATHER_GAIN    = 0.75;
const RIPPLE_FREQ_CYC = 4.2;
const RIPPLE_SPEED_HZ = 0.06;

// ---- Helpers ---------------------------------------------------------------
const sub = (a,b)=>({x:a.x-b.x, y:a.y-b.y, z:a.z-b.z});
function allTDLIds(api){
  const T = Array.isArray(api?.ids?.T) ? api.ids.T : [];
  const D = Array.isArray(api?.ids?.D) ? api.ids?.D : [];
  const L = Array.isArray(api?.ids?.L) ? api.ids?.L : [];
  return [...new Set([...T, ...D, ...L])];
}
function rad(d){ return d * Math.PI / 180; }
function clamp01(x){ return x<0?0:x>1?1:x; }
function mix(a,b,t){ return a + (b-a)*t; }
function smoothstep(a,b,x){ const t=clamp01((x-a)/(b-a)); return t*t*(3-2*t); }

// Rotate base +Y by Euler angles (apply X→Y→Z) and return unit normal
function normalFromEuler(rx, ry, rz){
  let nx = 0, ny = 1, nz = 0; // start from +Y
  { const c=Math.cos(rx), s=Math.sin(rx); const ny1 = ny*c - nz*s; const nz1 = ny*s + nz*c; ny = ny1; nz = nz1; }
  { const c=Math.cos(ry), s=Math.sin(ry); const nx1 = nx*c + nz*s; const nz1 = -nx*s + nz*c; nx = nx1; nz = nz1; }
  { const c=Math.cos(rz), s=Math.sin(rz); const nx1 = nx*c - ny*s; const ny1 = nx*s + ny*c; nx = nx1; ny = ny1; }
  const inv = 1 / Math.hypot(nx, ny, nz);
  return { x: nx*inv, y: ny*inv, z: nz*inv };
}
function dot(a,b){ return a.x*b.x + a.y*b.y + a.z*b.z; }
function cross(a,b){ return { x:a.y*b.z - a.z*b.y, y:a.z*b.x - a.x*b.z, z:a.x*b.y - a.y*b.x }; }
function norm(v){ const L=Math.hypot(v.x,v.y,v.z)||1; return {x:v.x/L, y:v.y/L, z:v.z/L}; }

// Build a stable local (uT,vT) tangent basis for the current plane normal n
function planeBasis(n){
  // pick a world axis least aligned with n
  const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
  const ref = (ax<ay && ax<az) ? {x:1, y:0, z:0} : (ay<az ? {x:0,y:1,z:0} : {x:0,y:0,z:1});
  const uT = norm(cross(ref, n));   // tangent 1
  const vT = cross(n, uT);          // tangent 2 (already unit)
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
  const dEff = dRaw - ripple; // shift the plane by ripple amount
  return { dEff, featherWU };
}

// ---- State -----------------------------------------------------------------
let IDS = [];
let center = {x:0,y:0,z:0};
let domeR = 250;
let n = {x:0,y:1,z:0};           // plane normal (unit)
let planePoint = {x:0,y:0,z:0};  // a point on the plane

// animation timing (relative to a latched start)
let t0_ms = null;                // sweep/tumble start time
let spinOffsetMs = null;         // Y-spin phase offset (so spin restarts at same pose)

// loop control
let state = 'run';               // 'run' | 'pause'
let pauseStartMs = 0;
let invertColors = false;        // toggles each loop

// ---- Lifecycle -------------------------------------------------------------
export function init(api){
  IDS = allTDLIds(api);
  api.resetColorsTo(BASE); // start fully BASE each preview

  if (api.info && Number.isFinite(api.info.radius)) domeR = api.info.radius;
  if (api.info && api.info.center) center = { x: api.info.center.x||0, y: api.info.center.y||0, z: api.info.center.z||0 };

  // Initialize start pose & timers
  resetMotion(/*nowMs=*/0);

  // Initial orientation: X tilt only; Y/Z animated per-frame
  n = normalFromEuler(rad(TILT_X_DEG), 0, 0);

  // First paint
  paint(api, /*timeSec=*/0);
}

// reset all motion timers/poses to the canonical start values
function resetMotion(nowMs){
  // Start pose: plane anchored at (x:+70, y:-57) relative to center
  planePoint = { x: center.x + 70, y: center.y - 57, z: center.z };

  // timers latch on first update after reset
  t0_ms = null;           // sweep/tumble start time
  spinOffsetMs = null;    // spin phase anchor
  state = 'run';
}

// ---- Frame -----------------------------------------------------------------
export function update(api, t/*s*/, dt/*s*/){
  if (!IDS.length) init(api);

  const nowMs = Math.max(0, t*1000);
  const timeSec = t;

  // latch timers after a reset
  if (state === 'run'){
    if (t0_ms === null) t0_ms = nowMs;
    if (spinOffsetMs === null) spinOffsetMs = nowMs; // spin starts at ry=0
  }

  if (state === 'pause'){
    // During pause we do not repaint (keeps previous frame's colors frozen)
    if (nowMs - pauseStartMs >= PAUSE_MS){
      invertColors = !invertColors; // swap sides for next run
      resetMotion(nowMs);
    }
    return; // keep paint frozen
  }

  // --- Y spin (continuous, but phase-locked to spinOffsetMs) ---------------
  const spinU = ((nowMs - spinOffsetMs) % SPIN_PERIOD_MS) / SPIN_PERIOD_MS; // 0..1
  const ry = spinU * 2 * Math.PI;                                          // radians

  // --- Independent sweeps ---------------------------------------------------
  const ux = clamp01((nowMs - t0_ms) / X_SWEEP_MS);
  const uy = clamp01((nowMs - t0_ms) / Y_SWEEP_MS);

  // X sweeps from +70 → −70; Y sweeps from −57 → +57
  planePoint.x = mix(center.x + 70, center.x - 70, ux);
  planePoint.y = mix(center.y - 57, center.y + 57, uy);
  planePoint.z = center.z;

  // --- Z tumble to +90° -----------------------------------------------------
  const uz = clamp01((nowMs - t0_ms) / Z_TUMBLE_MS);
  const rz = rad(90 * uz);

  // Compose orientation: fixed X tilt, spinning Y, tumbling Z
  n = normalFromEuler(rad(TILT_X_DEG), ry, rz);

  // If we just achieved monochrome (using feather+ripple aware test),
  // switch to pause (but DO paint this frame to match exactly)
  const becameMono = isMonochrome(api, timeSec);
  paint(api, timeSec); // paint first (so frozen color matches this moment exactly)

  if (becameMono){
    state = 'pause';
    pauseStartMs = nowMs;
    // Immediately reset motion so next run restarts from canonical start.
    // (Colors remain frozen throughout the pause because we skip painting.)
    resetMotion(nowMs);
    state = 'pause'; // keep pause state after resetMotion sets 'run'
  }
}

// ---- Monochrome detection (feather+ripple aware) ---------------------------
// True only if EVERY point is beyond its own blend band on the SAME side.
// Any point still within its local feather band delays the pause.
function isMonochrome(api, timeSec){
  let pos = 0, neg = 0, mid = 0;
  const EPS = 0.25; // small safety so grazing points don’t flicker the state
  for (const id of IDS){
    const p = api.posOf(id); if (!p || !Number.isFinite(p.x)) continue;
    const { dEff, featherWU } = edgeProfileForPoint(p, planePoint, n, timeSec);
    if (dEff >  featherWU + EPS) pos++;
    else if (dEff < -featherWU - EPS) neg++;
    else { mid++; }
    if (pos>0 && neg>0) return false;      // both sides present ⇒ not mono
    if (mid>0) {/* keep scanning but not monochrome yet */}
  }
  // Monochrome only if there are NO mid points (fully past soft edge) and
  // all points that aren’t mid lie on the same side.
  const mono = (mid === 0) && (pos === 0 || neg === 0);
  return mono;
}

// ---- Paint: side-of-plane coloring (feathered ripple edge) -----------------
function paint(api, timeSec){
  const POS_COLOR = invertColors ? BASE : RED; // +n side color this cycle
  const NEG_COLOR = invertColors ? RED  : BASE; // −n side color this cycle

  const changes = [];

  for (const id of IDS){
    const p = api.posOf(id); if (!p || !Number.isFinite(p.x)) continue;

    const { dEff, featherWU } = edgeProfileForPoint(p, planePoint, n, timeSec);

    // Feathered blend across local band
    const t = smoothstep(-featherWU, featherWU, dEff); // 0 on −n → 1 on +n
    const r = NEG_COLOR[0] + (POS_COLOR[0]-NEG_COLOR[0]) * t;
    const g = NEG_COLOR[1] + (POS_COLOR[1]-NEG_COLOR[1]) * t;
    const b = NEG_COLOR[2] + (POS_COLOR[2]-NEG_COLOR[2]) * t;
    const a = NEG_COLOR[3] + (POS_COLOR[3]-NEG_COLOR[3]) * t;
    changes.push({ id, color: [r,g,b,a] });
  }

  if (changes.length) api.setColors(changes);
}
