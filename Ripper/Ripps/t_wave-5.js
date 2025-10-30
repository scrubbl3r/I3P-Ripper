// ripp—planewave—diagnostic (tilt +15°X, spin Y every 1000ms, red on hit).js
// Preview contract: init(api), update(api, t, dt)
// Plane passes through the dome center. Fixed tilt +15° (X), continuous spin around Y (1s per rev).

export const meta = { name: 'Planewave — tiltX+15, spinY 1s (red on hit)', fps: 30, duration: 120 };

// ---- Tunables --------------------------------------------------------------
const HALF_THICKNESS_WU = 2.5;    // collision band half-thickness around the plane
const BASE = [1, 1, 1, 1];        // white
const RED  = [1, 0, 0, 1];        // red on hit

const TILT_X_DEG   = 15;          // fixed tilt about X
const SPIN_PERIOD_MS = 3000;      // one full revolution around Y per 1000 ms

// ---- Helpers --------------------------------------------------------------
const sub = (a,b)=>({x:a.x-b.x, y:a.y-b.y, z:a.z-b.z});
function allTDLIds(api){
  const T = Array.isArray(api?.ids?.T) ? api.ids.T : [];
  const D = Array.isArray(api?.ids?.D) ? api.ids.D : [];
  const L = Array.isArray(api?.ids?.L) ? api.ids.L : [];
  return [...new Set([...T, ...D, ...L])];
}
function rad(d){ return d * Math.PI / 180; }

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
let n = {x:0,y:1,z:0}; // plane normal
let planePoint = {x:0,y:0,z:0};

export function init(api){
  IDS = allTDLIds(api);
  api.resetColorsTo(BASE);

  if (api.info && Number.isFinite(api.info.radius)) domeR = api.info.radius;
  if (api.info && api.info.center) center = { x: api.info.center.x||0, y: api.info.center.y||0, z: api.info.center.z||0 };

  // Anchor the plane through the dome center
  planePoint = { x: center.x, y: center.y, z: center.z };

  // Initialize normal with tilt only (spin will be applied per-frame)
  n = normalFromEuler(rad(TILT_X_DEG), 0, 0);

  // One paint pass
  paint(api);
}

export function update(api, t/*s*/, dt/*s*/){
  if (!IDS.length) init(api);

  // Compute spin angle about Y that wraps every SPIN_PERIOD_MS
  const nowMs = Math.max(0, t*1000);
  const spinU = (nowMs % SPIN_PERIOD_MS) / SPIN_PERIOD_MS; // 0..1
  const ry = spinU * 2 * Math.PI;                          // radians

  // Recompute plane normal with fixed X tilt and animated Y spin (no Z)
  n = normalFromEuler(rad(TILT_X_DEG), ry, 0);

  // Repaint
  paint(api);
}

function paint(api){
  const hit = new Set();

  for (let i=0; i<IDS.length; i++){
    const id = IDS[i];
    const p = api.posOf(id);
    if (!p || !Number.isFinite(p.x)) continue;

    const v = sub(p, planePoint);
    const d = v.x*n.x + v.y*n.y + v.z*n.z; // signed distance to plane
    if (Math.abs(d) <= HALF_THICKNESS_WU){
      hit.add(id);
    }
  }

  const changes = [];
  for (let i=0; i<IDS.length; i++){
    const id = IDS[i];
    changes.push({ id, color: hit.has(id) ? RED : BASE });
  }
  if (changes.length) api.setColors(changes);
}
