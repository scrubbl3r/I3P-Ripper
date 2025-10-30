// ripp—planewave—diagnostic (freeze mid, red on hit).js
// Preview contract: init(api), update(api, t, dt)
// Diagnostic: a single infinite plane, **no animation**. Plane passes through the
// **center of the dome** (middle) and we paint **RED on collision**, **WHITE otherwise**.

export const meta = { name: 'Planewave — diagnostic (mid-plane, red on hit)', fps: 60, duration: 120 };

// ---- Tunables --------------------------------------------------------------
const HALF_THICKNESS_WU = 2.5;    // collision band half‑thickness around the plane
const BASE = [1, 1, 1, 1];        // white
const RED  = [1, 0, 0, 1];        // red on hit

// Example: ROT_DEG = { x: -45, y: 45, z: 0 };
// RAOTATION  ------------------------------------------------------------------------------------ \\
const ROT_DEG = { x: 0, y: 0, z: 0 }; // edit me: degrees

// ---- Helpers --------------------------------------------------------------
const sub = (a,b)=>({x:a.x-b.x, y:a.y-b.y, z:a.z-b.z});
function allTDLIds(api){
  const T = Array.isArray(api?.ids?.T) ? api.ids.T : [];
  const D = Array.isArray(api?.ids?.D) ? api.ids.D : [];
  const L = Array.isArray(api?.ids?.L) ? api.ids.L : [];
  return [...new Set([...T, ...D, ...L])];
}
function rad(d){ return d * Math.PI / 180; }

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

  // Compute the frozen plane orientation and anchor
// Build plane normal by rotating base +Y with Euler angles ROT_DEG (apply X→Y→Z)
{
  const rx = rad(ROT_DEG.x), ry = rad(ROT_DEG.y), rz = rad(ROT_DEG.z);
  // start with base normal (0,1,0)
  let nx = 0, ny = 1, nz = 0;
  // rotate about X
  {
    const c = Math.cos(rx), s = Math.sin(rx);
    const ny1 = ny*c - nz*s;
    const nz1 = ny*s + nz*c;
    ny = ny1; nz = nz1;
  }
  // rotate about Y
  {
    const c = Math.cos(ry), s = Math.sin(ry);
    const nx1 = nx*c + nz*s;
    const nz1 = -nx*s + nz*c;
    nx = nx1; nz = nz1;
  }
  // rotate about Z
  {
    const c = Math.cos(rz), s = Math.sin(rz);
    const nx1 = nx*c - ny*s;
    const ny1 = nx*s + ny*c;
    nx = nx1; ny = ny1;
  }
  const inv = 1 / Math.hypot(nx, ny, nz);
  n = { x: nx*inv, y: ny*inv, z: nz*inv };
}

  // POSITION ------------------------------------------------------------------------------------ \\
  planePoint = { x: center.x, y: center.y, z: center.z };
  
  // One paint pass
  paint(api);
}

export function update(api, t/*s*/, dt/*s*/){
  // No animation; repaint only if needed (e.g., preview restarts)
  if (!IDS.length) init(api);
}

function paint(api){
  const hit = new Set();

  for (let i=0; i<IDS.length; i++){
    const id = IDS[i];
    const p = api.posOf(id);
    if (!p || !Number.isFinite(p.x)) continue;

    const v = sub(p, planePoint);
    const d = v.x*n.x + v.y*n.y + v.z*n.z; // signed distance
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
