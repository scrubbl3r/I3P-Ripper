// ripp—drops-black-emitter-easein.js
// Preview contract: init(api), update(api, t, dt)
// "Drops" = small collision spheres traveling from dome TOP (+Y) to BOTTOM (−Y).
// Spawns at a RANDOM cadence between 25–250 ms. Each drop eases in (exponential),
// so it starts slow and accelerates downward. Any T/D/L inside a live drop → BLACK.

export const meta = { name: 'Drops: Top→Bottom (black, ease-in, random spawn)', fps: 60, duration: 120 };

// ---- Tunables --------------------------------------------------------------
const DROP_RADIUS_WU   = 12.5;     // size of each drop
const LIFETIME_MS      = 1333;  // 50% faster (2000 / 1.5)     // travel time top→bottom (per drop)
const SPAWN_MIN_MS     = 1;     // 4× faster spawn (was 5)       // random spawn window
const SPAWN_MAX_MS     = 58;    // 4× faster spawn (was 230)
const BLACK            = [0, 0, 0, 1];
const BASE             = [1, 1, 1, 1];
const H_SHRINK        = 0.8;  // make drops TALL: shrink horizontal acceptance by 20% (tighter in X/Z)

// ---- Helpers ---------------------------------------------------------------
const sub = (a,b)=>({x:a.x-b.x, y:a.y-b.y, z:a.z-b.z});
const len = (v)=>Math.hypot(v.x, v.y, v.z);
function allTDLIds(api){
  const T = Array.isArray(api?.ids?.T) ? api.ids.T : [];
  const D = Array.isArray(api?.ids?.D) ? api.ids.D : [];
  const L = Array.isArray(api?.ids?.L) ? api.ids.L : [];
  return [...new Set([...T, ...D, ...L])];
}
function randIn(min, max){ return min + Math.random()*(max-min); }
function easeInExpo(u){ return u <= 0 ? 0 : (u >= 1 ? 1 : Math.pow(2, 10*(u-1))); }

// New: motion profile for drops
// Very slow start near the crown, accelerating strongly toward and past the equator.
// Combines a cubic ease-in with a smooth bell-shaped boost centered at u≈0.5.
function progressDown(u){
  // Circular ease-in: starts very slow, then ramps up fast near mid/late
  // s(u) = 1 - sqrt(1 - u^2)
  u = Math.min(1, Math.max(0, u));
  return 1 - Math.sqrt(1 - u*u);
}

// ---- State -----------------------------------------------------------------
let IDS = [];
let center = {x:0,y:0,z:0};
let domeR = 250; // fallback
let lastHit = new Set();
let emitAccMs = 0;
let nextDelayMs = 100; // will randomize on init
const drops = []; // { bornMs:number, az:number, r:number }

export function init(api){
  IDS = allTDLIds(api);
  api.resetColorsTo(BASE);

  if (api.info && Number.isFinite(api.info.radius)) domeR = api.info.radius;
  if (api.info && api.info.center) center = {x:api.info.center.x||0, y:api.info.center.y||0, z:api.info.center.z||0};

  drops.length = 0;
  emitAccMs = 0;
  nextDelayMs = randIn(SPAWN_MIN_MS, SPAWN_MAX_MS);

  // seed one drop immediately
  drops.push({ bornMs: 0, az: Math.random() * Math.PI * 2, r: DROP_RADIUS_WU * (1 + randIn(-0.35, 0.35)) });
  paint(api, 0);
}

export function update(api, t/*s*/, dt/*s*/){
  const nowMs = t * 1000;

  // spawn with random cadence between 25–250ms
  emitAccMs += Math.max(0, dt*1000);
  while (emitAccMs >= nextDelayMs){
    emitAccMs -= nextDelayMs;
    drops.push({ bornMs: nowMs, az: Math.random() * Math.PI * 2, r: DROP_RADIUS_WU * (1 + randIn(-0.35, 0.35)) });
    nextDelayMs = randIn(SPAWN_MIN_MS, SPAWN_MAX_MS);
  }

  // cull finished drops
  for (let i = drops.length - 1; i >= 0; i--){
    if (nowMs - drops[i].bornMs >= LIFETIME_MS) drops.splice(i,1);
  }

  paint(api, nowMs);
}

function dropCenterAtOld(nowMs, bornMs){
  // fraction of lifetime (linear)
  const u = Math.min(1, Math.max(0, (nowMs - bornMs)/LIFETIME_MS));
  // apply exponential ease-in → starts slow near the crown, accelerates downward
  const s = progressDown(u);

  // Parametrize along the meridian in XY plane (Z fixed), top +Y → bottom −Y
  const theta = Math.PI/2 - Math.PI * s; // s:0→1 maps to theta:+pi/2→-pi/2
  const x = center.x + domeR * Math.cos(theta);
  const y = center.y + domeR * Math.sin(theta);
  const z = center.z; // fixed Z
  return { x, y, z };
}

function dropCenterAt(nowMs, bornMs, az){
  const u = Math.min(1, Math.max(0, (nowMs - bornMs)/LIFETIME_MS));
  const s = progressDown(u);
  const theta = Math.PI/2 - Math.PI * s;
  const y = center.y + domeR * Math.sin(theta);
  const rHor = domeR * Math.cos(theta);
  const x = center.x + rHor * Math.sin(az);
  const z = center.z + rHor * Math.cos(az);
  return { x, y, z };
}

function paint(api, nowMs){
  const hit = new Set();

  // aggregate collisions across all live drops
  for (const d of drops){
    const C = dropCenterAt(nowMs, d.bornMs, d.az);
    for (const id of IDS){
      const p = api.posOf(id);
      if (!p || !Number.isFinite(p.x)) continue;
      const diff = sub(p, C);
      const dist = Math.hypot(diff.x / H_SHRINK, diff.y, diff.z / H_SHRINK);
      if (dist <= d.r) hit.add(id);
    }
  }

  // diff and push changes
  const changes = [];
  for (const id of lastHit){ if (!hit.has(id)) changes.push({ id, color: BASE }); }
  for (const id of hit){ if (!lastHit.has(id)) changes.push({ id, color: BLACK }); }

  if (changes.length) api.setColors(changes);
  lastHit = hit;
}
