// ripp—tdl-collide-orange-emitter.js
// Preview contract: init(api), update(api, t, dt)
// Spawns small collision spheres at the TOP of the dome, moves them to the BOTTOM,
// destroys them at the bottom. Emits one every 500 ms. No looping per sphere.
// Any T/D/L whose centroid is inside any live sphere → painted ORANGE; others → BASE.

export const meta = { name: 'Emitter: Top→Bottom Spheres (orange)', fps: 60, duration: 120 };

// ---- Tunables --------------------------------------------------------------
const SPHERE_RADIUS_WU = 12.5; // 25% of 50 WU
const EMIT_PERIOD_MS   = 500;  // spawn cadence
const LIFETIME_MS      = 2000; // time for a sphere to travel from top to bottom
const ORANGE = [1, 0.5, 0, 1];
const BASE   = [1, 1, 1, 1];

// ---- Helpers ---------------------------------------------------------------
const sub = (a,b)=>({x:a.x-b.x, y:a.y-b.y, z:a.z-b.z});
const len = (v)=>Math.hypot(v.x, v.y, v.z);
function allTDLIds(api){
  const T = Array.isArray(api?.ids?.T) ? api.ids.T : [];
  const D = Array.isArray(api?.ids?.D) ? api.ids.D : [];
  const L = Array.isArray(api?.ids?.L) ? api.ids.L : [];
  return [...new Set([...T, ...D, ...L])];
}

// ---- State -----------------------------------------------------------------
let IDS = [];
let center = {x:0,y:0,z:0};
let domeR = 250; // fallback
let lastHit = new Set();
let emitAccMs = 0;
const spheres = []; // { bornMs:number }

export function init(api){
  IDS = allTDLIds(api);
  api.resetColorsTo(BASE);

  if (api.info && Number.isFinite(api.info.radius)) domeR = api.info.radius;
  if (api.info && api.info.center) center = {x:api.info.center.x||0, y:api.info.center.y||0, z:api.info.center.z||0};

  // start with one sphere at the top
  spheres.length = 0;
  spheres.push({ bornMs: 0 });
  emitAccMs = 0;

  // prime first paint
  paint(api, 0);
}

export function update(api, t/*s*/, dt/*s*/){
  const nowMs = t * 1000;

  // spawn according to cadence
  emitAccMs += Math.max(0, dt*1000);
  while (emitAccMs >= EMIT_PERIOD_MS){
    emitAccMs -= EMIT_PERIOD_MS;
    spheres.push({ bornMs: nowMs });
  }

  // cull expired spheres
  for (let i = spheres.length - 1; i >= 0; i--){
    if (nowMs - spheres[i].bornMs >= LIFETIME_MS) spheres.splice(i,1);
  }

  paint(api, nowMs);
}

function sphereCenterAt(nowMs, bornMs){
  // Progress 0..1 across lifetime
  const s = Math.min(1, Math.max(0, (nowMs - bornMs)/LIFETIME_MS));
  // Parametrize along a MERIDIAN in the XY plane (Z fixed) from TOP → BOTTOM (Y-up).
  // theta: +PI/2 (top at +Y) → -PI/2 (bottom at -Y)
  const theta = Math.PI/2 - Math.PI * s;
  const x = center.x + domeR * Math.cos(theta);
  const y = center.y + domeR * Math.sin(theta);
  const z = center.z; // keep Z constant; Y is vertical
  return { x, y, z };
}

function paint(api, nowMs){
  const hit = new Set();

  // Gather hits across all live spheres
  for (const s of spheres){
    const C = sphereCenterAt(nowMs, s.bornMs);
    for (const id of IDS){
      const p = api.posOf(id);
      if (!p || !Number.isFinite(p.x)) continue;
      const d = len(sub(p, C));
      if (d <= SPHERE_RADIUS_WU) hit.add(id);
    }
  }

  // Diff vs last frame
  const changes = [];
  for (const id of lastHit){ if (!hit.has(id)) changes.push({ id, color: BASE }); }
  for (const id of hit){ if (!lastHit.has(id)) changes.push({ id, color: ORANGE }); }

  if (changes.length) api.setColors(changes);
  lastHit = hit;
}
