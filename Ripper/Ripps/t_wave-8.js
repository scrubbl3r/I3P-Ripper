// ripp—planewave—diagnostic (tiltX+25, spinY 2s, XY sweep + Z→90, side-paint, pause+invert+restart).js
// Preview contract: init(api), update(api, t, dt)

export const meta = { name: 'Planewave — tiltX+25, spinY 2s, sweep+tumble (pause 1s on monochrome, invert, restart)', fps: 30, duration: 120 };

// ---- Tunables --------------------------------------------------------------
// Colors are "side-of-plane": +n side gets POS_COLOR, −n side gets NEG_COLOR.
// We invert these on each loop restart.
const BASE = [0, 0, 1, 1];        // −n side (initially blue)
const RED  = [1, 1, 1, 1];        // +n side (initially white)

const TILT_X_DEG     = 25;        // fixed tilt about X
const SPIN_PERIOD_MS = 2000;      // one full revolution around Y per 2000 ms

// Independent sweeps & Z tumble
const X_SWEEP_MS   = 3000;        // ms: x : (+70 → −70)
const Y_SWEEP_MS   = 3000;        // ms: y : (−57 → +57)
const Z_TUMBLE_MS  = 3000;        // ms: rz: 0° → +90°
const PAUSE_MS     = 1000;        // hold time between loops

/* Optional soft edge around the plane:
   set FEATHER_WU > 0 (e.g. 2.5) and we’ll blend across ±FEATHER_WU.
   Leave at 0 for a crisp, hard split. */
const FEATHER_WU = 0;

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
  paint(api);
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

  // If we just achieved monochrome, switch to pause (but DO paint this frame)
  const becameMono = isMonochrome(api);
  paint(api); // paint first (so frozen color matches this moment exactly)

  if (becameMono){
    state = 'pause';
    pauseStartMs = nowMs;
    // Immediately reset motion so next run restarts from canonical start.
    // (Colors remain frozen throughout the pause because we skip painting.)
    resetMotion(nowMs);
    state = 'pause'; // keep pause state after resetMotion sets 'run'
  }
}

// ---- Monochrome detection --------------------------------------------------
// Hard edge (FEATHER_WU==0): true if all dots >=0 OR all <0
// Feathered: ignore band within ±FEATHER_WU so edge pixels don’t block.
function isMonochrome(api){
  let pos = 0, neg = 0;
  const margin = FEATHER_WU > 0 ? FEATHER_WU : 0;
  for (const id of IDS){
    const p = api.posOf(id); if (!p || !Number.isFinite(p.x)) continue;
    const d = dot(sub(p, planePoint), n);
    if (d >  margin) pos++;
    else if (d < -margin) neg++;
    if (pos > 0 && neg > 0) return false;
  }
  return (pos === 0 || neg === 0);
}

// ---- Paint: side-of-plane coloring (hard edge or feathered) ---------------
function paint(api){
  const POS_COLOR = invertColors ? BASE : RED; // +n side color this cycle
  const NEG_COLOR = invertColors ? RED  : BASE; // −n side color this cycle

  const changes = [];

  if (FEATHER_WU > 0){
    for (const id of IDS){
      const p = api.posOf(id); if (!p || !Number.isFinite(p.x)) continue;
      const d = dot(sub(p, planePoint), n);      // signed distance
      const t = smoothstep(-FEATHER_WU, FEATHER_WU, d); // 0 on −n → 1 on +n
      const r = NEG_COLOR[0] + (POS_COLOR[0]-NEG_COLOR[0]) * t;
      const g = NEG_COLOR[1] + (POS_COLOR[1]-NEG_COLOR[1]) * t;
      const b = NEG_COLOR[2] + (POS_COLOR[2]-NEG_COLOR[2]) * t;
      const a = NEG_COLOR[3] + (POS_COLOR[3]-NEG_COLOR[3]) * t;
      changes.push({ id, color: [r,g,b,a] });
    }
  } else {
    for (const id of IDS){
      const p = api.posOf(id); if (!p || !Number.isFinite(p.x)) continue;
      const d = dot(sub(p, planePoint), n);
      changes.push({ id, color: d >= 0 ? POS_COLOR : NEG_COLOR });
    }
  }

  if (changes.length) api.setColors(changes);
}
