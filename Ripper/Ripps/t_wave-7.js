// ripp—planewave—diagnostic (tiltX+25, spinY 2s, independent X/Y sweep + Z→90, side-paint).js
// Preview contract: init(api), update(api, t, dt)

export const meta = { name: 'Planewave — tiltX+25, spinY 2s, X/Y sweep + Z tumble (side paint)', fps: 60, duration: 120 };

// ---- Tunables --------------------------------------------------------------
const BASE = [0, 0, 1, 1];        // (−n side)
const RED  = [1, 1, 1, 1];        // (+n side)

const TILT_X_DEG     = 25;        // fixed tilt about X
const SPIN_PERIOD_MS = 2000;      // one full revolution around Y per 2000 ms

// Independent sweeps & Z tumble
const X_SWEEP_MS   = 2600;        // ms: x : ( +70 → −70 )
const Y_SWEEP_MS   = 1100;        // ms: y : ( −57 → +57 )
const Z_TUMBLE_MS  = 2500;        // ms: rz: 0° → +90°

/* Optional soft edge around the plane:
   set FEATHER_WU > 0 (e.g. 2.5) and we’ll blend across ±FEATHER_WU.
   Leave at 0 for a crisp, hard split. */
const FEATHER_WU = 0;

// ---- Helpers ---------------------------------------------------------------
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

// Rotate base +Y by Euler angles (apply X→Y→Z) and return unit normal
function normalFromEuler(rx, ry, rz){
  let nx = 0, ny = 1, nz = 0; // start from +Y
  { const c=Math.cos(rx), s=Math.sin(rx); const ny1 = ny*c - nz*s; const nz1 = ny*s + nz*c; ny = ny1; nz = nz1; }
  { const c=Math.cos(ry), s=Math.sin(ry); const nx1 = nx*c + nz*s; const nz1 = -nx*s + nz*c; nx = nx1; nz = nz1; }
  { const c=Math.cos(rz), s=Math.sin(rz); const nx1 = nx*c - ny*s; const ny1 = nx*s + ny*c; nx = nx1; ny = ny1; }
  const inv = 1 / Math.hypot(nx, ny, nz);
  return { x: nx*inv, y: ny*inv, z: nz*inv };
}

// ---- State -----------------------------------------------------------------
let IDS = [];
let center = {x:0,y:0,z:0};
let domeR = 250;
let n = {x:0,y:1,z:0};           // plane normal (unit)
let planePoint = {x:0,y:0,z:0};  // a point on the plane
let t0_ms = null;                // animation start time

// ---- Lifecycle -------------------------------------------------------------
export function init(api){
  IDS = allTDLIds(api);
  api.resetColorsTo(BASE); // start fully BASE each preview

  if (api.info && Number.isFinite(api.info.radius)) domeR = api.info.radius;
  if (api.info && api.info.center) center = { x: api.info.center.x||0, y: api.info.center.y||0, z: api.info.center.z||0 };

  // Start pose: plane anchored at (-70, -57) relative to center
  planePoint = { x: center.x - 70, y: center.y - 57, z: center.z };

  // Initial orientation: X tilt only; Y/Z animated per-frame
  n = normalFromEuler(rad(TILT_X_DEG), 0, 0);

  t0_ms = 0; // latch actual start time on first update
  paint(api);
}

// ---- Frame -----------------------------------------------------------------
export function update(api, t/*s*/, dt/*s*/){
  if (!IDS.length) init(api);

  const nowMs = Math.max(0, t*1000);
  if (t0_ms === 0 || t0_ms === null) t0_ms = nowMs;

  // --- Y spin (continuous) --------------------------------------------------
  const spinU = (nowMs % SPIN_PERIOD_MS) / SPIN_PERIOD_MS; // 0..1
  const ry = spinU * 2 * Math.PI;                          // radians

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

  paint(api);
}

// ---- Paint: side-of-plane coloring (hard edge or feathered) ---------------
function paint(api){
  const changes = [];

  if (FEATHERING()){
    for (const id of IDS){
      const p = api.posOf(id); if (!p || !Number.isFinite(p.x)) continue;
      const d = dot(sub(p, planePoint), n); // signed distance to plane
      const t = smoothstep(-FEATHER_WU, FEATHER_WU, d); // 0 on −n side → 1 on +n side
      const r = BASE[0] + (RED[0]-BASE[0]) * t;
      const g = BASE[1] + (RED[1]-BASE[1]) * t;
      const b = BASE[2] + (RED[2]-BASE[2]) * t;
      const a = BASE[3] + (RED[3]-BASE[3]) * t;
      changes.push({ id, color: [r,g,b,a] });
    }
  } else {
    for (const id of IDS){
      const p = api.posOf(id); if (!p || !Number.isFinite(p.x)) continue;
      const d = dot(sub(p, planePoint), n); // signed distance to plane
      changes.push({ id, color: d >= 0 ? RED : BASE });
    }
  }

  if (changes.length) api.setColors(changes); // <-- fixed
}

// ---- Tiny utils ------------------------------------------------------------
function dot(a,b){ return a.x*b.x + a.y*b.y + a.z*b.z; }
function FEATHERING(){ return FEATHER_WU > 0; }
