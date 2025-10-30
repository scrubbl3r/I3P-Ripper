// ripp—raindrops-2—autumn+accent+tracers.js
// Preview contract: init(api), update(api, t, dt)

export const meta = { name: 'Raindrops-2 • Autumn+Accents • Tracers', fps: 60, duration: 120 };

// ---- Tunables --------------------------------------------------------------
// per-drop radius range (world units)
const DROP_RADIUS_MIN_WU = 8;
const DROP_RADIUS_MAX_WU = 12;

const LIFETIME_MS      = 800;
const SPAWN_MIN_MS     = 20;
const SPAWN_MAX_MS     = 80;
const H_SHRINK         = 0.7;

// Tracer behavior
const GHOST_LIFE_MS    = 700;
const GHOST_EASE       = (u)=> u*u*(3-2*u);
const GHOST_MAX_ALPHA  = 0.6;

// ---- Palette ---------------------------------------------------------------
const AUTUMN = [
  [0.459,0.024,0.024,1],[0.494,0.02,0,1],[0.816,0.133,0.012,1],[0.816,0.133,0.012,1],
[0.914,0.161,0,1],[0.98,0.196,0.012,1],[0.969,0.298,0.047,1],[0.992,0.282,0.008,1],
[0.992,0.322,0.035,1],[0.992,0.322,0.035,1],[0.992,0.322,0.035,1],[0.957,0.298,0,1],
[0.996,0.322,0,1],[0.988,0.357,0.012,1],[0.988,0.514,0.016,1],[0.988,0.514,0.016,1],
[0.988,0.514,0.016,1],[1,0.529,0.008,1],[0.996,0.573,0.043,1],[1,0.58,0.012,1],
[0.996,0.58,0.008,1],[0.988,0.58,0.012,1],[0.988,0.592,0,1],[0.988,0.639,0.047,1],
[0.988,0.714,0.016,1],[0.969,0.914,0.333,1],[0.996,0.922,0.008,1],[0.271,0.008,0.035,1],
[0.412,0.012,0.024,1],[0.443,0.016,0.027,1]
];
const ACCENTS = AUTUMN; // you duplicated, so we'll treat the same
function jitterRGB(rgb, amt=0.06){
  const [r,g,b] = rgb;
  const j = () => (Math.random()*2-1)*amt;
  return [
    Math.min(1, Math.max(0, r + j())),
    Math.min(1, Math.max(0, g + j())),
    Math.min(1, Math.max(0, b + j()))
  ];
}
function pickPaletteColor(){
  const useAccent = Math.random() < 0.20;
  const src = useAccent ? ACCENTS : AUTUMN;
  const base = src[(Math.random()*src.length)|0];
  // we ignore their alpha; we set alpha explicitly
  return jitterRGB([base[0], base[1], base[2]]);
}

// ---- Helpers ---------------------------------------------------------------
const sub = (a,b)=>({x:a.x-b.x, y:a.y-b.y, z:a.z-b.z});
function allTDLIds(api){
  const T = Array.isArray(api?.ids?.T) ? api.ids.T : [];
  const D = Array.isArray(api?.ids?.D) ? api.ids?.D : [];
  const L = Array.isArray(api?.ids?.L) ? api.ids?.L : [];
  return [...new Set([...T, ...D, ...L])];
}
function randIn(min, max){ return min + Math.random()*(max-min); }

// motion profile
function progressDown(u){
  u = Math.min(1, Math.max(0, u));
  const slow = Math.pow(u, 3.0);
  const mid = 0.5, width = 0.22, boost = 0.35;
  const t = Math.max(0, 1 - Math.abs((u - mid)/width));
  const bell = t*t*(3 - 2*t);
  let s = slow + boost * bell * u;
  return Math.min(1, Math.max(0, s));
}

// ---- State -----------------------------------------------------------------
let IDS = [];
let center = {x:0,y:0,z:0};
let domeR = 250;
let emitAccMs = 0;
let nextDelayMs = 100;
const drops = []; // { bornMs, az, r, color:[r,g,b] }
const ghost = new Map(); // id -> { color:[r,g,b], t0:number, a:number }

export function init(api){
  IDS = allTDLIds(api);

  // Explicitly paint every TDL transparent (alpha 0)
  api.setColors(IDS.map(id => ({ id, color: [0,0,0,0] })));

  if (api.info && Number.isFinite(api.info.radius)) domeR = api.info.radius;
  if (api.info && api.info.center) center = {x:api.info.center.x||0, y:api.info.center.y||0, z:api.info.center.z||0};

  drops.length = 0;
  ghost.clear();
  emitAccMs = 0;
  nextDelayMs = randIn(SPAWN_MIN_MS, SPAWN_MAX_MS);

  // seed one drop immediately
  drops.push({
    bornMs: 0,
    az: Math.random()*Math.PI*2,
    r: randIn(DROP_RADIUS_MIN_WU, DROP_RADIUS_MAX_WU),
    color: pickPaletteColor()
  });

  paint(api, 0);
}

export function update(api, t/*s*/, dt/*s*/){
  const nowMs = t * 1000;

  // spawn cadence
  emitAccMs += Math.max(0, dt*1000);
  while (emitAccMs >= nextDelayMs){
    emitAccMs -= nextDelayMs;
    drops.push({
      bornMs: nowMs,
      az: Math.random()*Math.PI*2,
      r: randIn(DROP_RADIUS_MIN_WU, DROP_RADIUS_MAX_WU),
      color: pickPaletteColor()
    });
    nextDelayMs = randIn(SPAWN_MIN_MS, SPAWN_MAX_MS);
  }

  // cull finished drops
  for (let i = drops.length - 1; i >= 0; i--){
    if (nowMs - drops[i].bornMs >= LIFETIME_MS) drops.splice(i,1);
  }

  paint(api, nowMs, dt*1000);
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

function paint(api, nowMs, dtMs=16){
  const hitColorById = new Map();

  // 1) collect current hits
  for (const d of drops){
    const C = dropCenterAt(nowMs, d.bornMs, d.az);
    for (const id of IDS){
      const p = api.posOf(id);
      if (!p || !Number.isFinite(p.x)) continue;
      const dx = (p.x - C.x) / H_SHRINK;
      const dy = (p.y - C.y);
      const dz = (p.z - C.z) / H_SHRINK;
      const dist = Math.hypot(dx, dy, dz);
      if (dist <= d.r){
        hitColorById.set(id, d.color);
      }
    }
  }

  // 2) decay ghosts
  const DECAY = Math.max(0.0001, GHOST_LIFE_MS);
  for (const [id, g] of ghost){
    const age = nowMs - g.t0;
    const u = Math.min(1, Math.max(0, age/DECAY));
    g.a = GHOST_MAX_ALPHA * (1 - GHOST_EASE(u));
    if (g.a <= 0.001) ghost.delete(id);
  }

  // 3) refresh ghosts from current hits
  for (const [id, col] of hitColorById){
    ghost.set(id, { color: col, t0: nowMs, a: GHOST_MAX_ALPHA });
  }

  // 4) output
  const changes = [];
  for (const id of IDS){
    const hitCol = hitColorById.get(id);
    if (hitCol){
      changes.push({ id, color: [hitCol[0], hitCol[1], hitCol[2], 1] });
    } else {
      const g = ghost.get(id);
      if (g){
        changes.push({ id, color: [g.color[0], g.color[1], g.color[2], Math.max(0, Math.min(1, g.a))] });
      } else {
        // stay transparent
        // changes.push({ id, color: [0,0,0,0] }); // uncomment if you want hard clear every frame
      }
    }
  }

  if (changes.length) api.setColors(changes);
}
