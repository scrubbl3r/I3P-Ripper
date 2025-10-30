// ripp—planewave—diagnostic (tiltX+15, spinY 3s, XY sweep 3s + Z→90, red on hit).js
// Preview contract: init(api), update(api, t, dt)

export const meta = { name: 'Planewave — tiltX+15, spinY 3s, XY sweep + Z tumble (red on hit)', fps: 30, duration: 120 };

// ---- Tunables --------------------------------------------------------------
const HALF_THICKNESS_WU = 2.5;    // collision band half-thickness around the plane
const BASE = [1, 1, 1, 1];        // white
const RED  = [1, 0, 0, 1];        // red on hit

const TILT_X_DEG     = 25;        // fixed tilt about X
const SPIN_PERIOD_MS = 2000;      // one full revolution around Y per 3000 ms

// XY sweep & Z tumble
const SWEEP_MS       = 3000;      // ms: (x:-70,y:-57) → (x:+70,y:+57)
const Z_TUMBLE_MS    = 3000;      // ms: rz: 0° → +90°

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
let n = {x:0,y:1,z:0};           // plane normal
let planePoint = {x:0,y:0,z:0};  // anchor point on plane

let t0_ms = null;                // sweep/tumble start time (latched)

// ---- Lifecycle -------------------------------------------------------------
export function init(api){
  IDS = allTDLIds(api);
  api.resetColorsTo(BASE);

  if (api.info && Number.isFinite(api.info.radius)) domeR = api.info.radius;
  if (api.info && api.info.center) center = { x: api.info.center.x||0, y: api.info.center.y||0, z: api.info.center.z||0 };

  // Start pose: plane anchored at (-70, -57) relative to center
  planePoint = { x: center.x - 70, y: center.y - 57, z: center.z };

  // Initial orientation: +15° about X, no Y spin yet, no Z tumble yet
  n = normalFromEuler(rad(TILT_X_DEG), 0, 0);

  t0_ms = 0; // latch actual start time on first update
  paint(api);
}

export function update(api, t/*s*/, dt/*s*/){
  if (!IDS.length) init(api);

  const nowMs = Math.max(0, t*1000);
  if (t0_ms === 0 || t0_ms === null) t0_ms = nowMs;

  // --- Y spin (continuous, 3s per rev) -------------------------------------
  const spinU = (nowMs % SPIN_PERIOD_MS) / SPIN_PERIOD_MS; // 0..1
  const ry = spinU * 2 * Math.PI;                          // radians

  // --- XY sweep over 3000 ms -----------------------------------------------
  const us = clamp01((nowMs - t0_ms) / SWEEP_MS);
  planePoint.x = mix(center.x + 70, center.x - 70, us);
  planePoint.y = mix(center.y - 57, center.y + 57, us);
  planePoint.z = center.z;

  // --- Z tumble to +90° over 3000 ms ---------------------------------------
  const uz = clamp01((nowMs - t0_ms) / Z_TUMBLE_MS);
  const rz = rad(90 * uz);

  // Compose orientation: fixed X tilt, spinning Y, tumbling Z
  n = normalFromEuler(rad(TILT_X_DEG), ry, rz);

  paint(api);
}

// ---- Paint -----------------------------------------------------------------
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
