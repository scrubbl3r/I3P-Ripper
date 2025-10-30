// ripp—tdl-collide-orange-emitter (30fps, geometric-accel, random-start+az, trails+palette, no-repeat colors).js
// Preview contract: init(api), update(api, t, dt)

export const meta = { name: 'Emitter: Top→Bottom (geom accel, random start+az, trails, no-repeat palette)', fps: 60, duration: 120 };

// ---- Tunables --------------------------------------------------------------
// per-sphere diameter range (world units)
const SPHERE_DIAMETER_MIN_WU = 10.0;
const SPHERE_DIAMETER_MAX_WU = 65.0;

const EMIT_PERIOD_MS   = 45;
const START_FRAC_MIN   = 0.07;
const START_FRAC_MAX   = 0.15;

// Geometric acceleration (per-frame, NOT per-time)
const STEP_INIT        = 0.01;
const ACCEL            = 1.55;
const STEP_MAX         = 0.06;

// GC / perf controls
const MAX_LIVE_SPHERES = 600;
const S_CULL_OVER      = 1.02;

// ---- Palette (non-repeating bag) -------------------------------------------
// Given palette (RGBA)
const BASE_PALETTE = [
  [1,     0.196, 0.102, 1],
  [1,     0.565, 0.106, 1],
  [0.886, 0,     0.969, 1],
  [0.271, 0.055, 1,     1],
  [0.133, 0,     0.439, 1],
];
// working bag (will hold copies of the above)
let paletteBag = [];

// ---- Helpers ---------------------------------------------------------------
const sub = (a,b)=>({x:a.x-b.x, y:a.y-b.y, z:a.z-b.z});
function allTDLIds(api){
  const T = Array.isArray(api?.ids?.T) ? api.ids.T : [];
  const D = Array.isArray(api?.ids?.D) ? api.ids?.D : [];
  const L = Array.isArray(api?.ids?.L) ? api.ids?.L : [];
  return [...new Set([...T, ...D, ...L])];
}
function randIn(min,max){ return min + Math.random()*(max-min); }

function refillPaletteBag(){
  // copy so we don't mutate the base
  paletteBag = BASE_PALETTE.map(c => c.slice());
}
function nextPaletteColor(){
  if (!paletteBag.length) refillPaletteBag();
  const idx = Math.floor(Math.random() * paletteBag.length);
  const col = paletteBag[idx];
  paletteBag.splice(idx, 1);
  // return just RGB (we paint with alpha=1 anyway)
  return [col[0], col[1], col[2]];
}

// Map path fraction s∈[0..1] to a meridian rotated by az around Y (Y-up)
function posOnMeridianAz(center, domeR, s, az){
  const theta = Math.PI/2 - Math.PI * s;
  const y = center.y + domeR * Math.sin(theta);
  const rHor = domeR * Math.cos(theta);
  const x = center.x + rHor * Math.sin(az);
  const z = center.z + rHor * Math.cos(az);
  return { x, y, z };
}

// ---- State -----------------------------------------------------------------
let IDS = [];
let IDS_SET = new Set();
let center = {x:0,y:0,z:0};
let domeR = 250; // fallback
let emitAccMs = 0;
// each sphere: { s, step, az, color:[r,g,b], radiusWU }
const spheres = [];
let needFirstSpawnAtNow = true;

// painting state
let dropsSpawned = 0;
let currentRGB = [1, 0.5, 0]; // will be overwritten by nextPaletteColor()
const painted = new Map();     // id -> 'r,g,b,a' string to avoid redundant setColors

// ---- Lifecycle -------------------------------------------------------------
export function init(api){
  IDS = allTDLIds(api);
  IDS_SET = new Set(IDS);
  api.resetColorsTo([1,1,1,1]);

  if (api.info && Number.isFinite(api.info.radius)) domeR = api.info.radius;
  if (api.info && api.info.center) center = {x:api.info.center.x||0, y:api.info.center.y||0, z:api.info.center.z||0};

  spheres.length = 0;
  emitAccMs = 0;
  needFirstSpawnAtNow = true;
  dropsSpawned = 0;

  // init palette bag
  refillPaletteBag();
  currentRGB = nextPaletteColor();

  painted.clear();
}

export function update(api, t/*s*/, dt/*s*/){
  const dtMs = Math.max(0, dt*1000);

  // detect ID changes and GC painted
  const newIDS = allTDLIds(api);
  if (newIDS.length !== IDS.length){
    IDS = newIDS;
    IDS_SET = new Set(IDS);
    for (const key of painted.keys()){
      if (!IDS_SET.has(key)) painted.delete(key);
    }
  }

  if (needFirstSpawnAtNow){
    spawnOne();
    needFirstSpawnAtNow = false;
  }

  // spawn according to cadence (timer only)
  emitAccMs += dtMs;
  while (emitAccMs >= EMIT_PERIOD_MS){
    emitAccMs -= EMIT_PERIOD_MS;
    spawnOne();
  }

  // advance & cull spheres
  if (spheres.length){
    for (let i = spheres.length - 1; i >= 0; i--){
      const d = spheres[i];
      if (!Number.isFinite(d.s) || !Number.isFinite(d.step) || !Number.isFinite(d.radiusWU)){
        spheres.splice(i,1);
        continue;
      }
      d.step = Math.min(STEP_MAX, d.step * ACCEL);
      if (d.step <= 0){
        spheres.splice(i,1);
        continue;
      }
      d.s += d.step;
      if (d.s >= 1 || d.s > S_CULL_OVER){
        spheres.splice(i,1);
      }
    }
  }

  paint(api);
}

function spawnOne(){
  // every spawn gets next non-repeating color
  currentRGB = nextPaletteColor();
  dropsSpawned++;

  if (spheres.length >= MAX_LIVE_SPHERES) return;

  const s0 = randIn(START_FRAC_MIN, START_FRAC_MAX);
  const az = Math.random() * Math.PI * 2;
  const diamWU  = randIn(SPHERE_DIAMETER_MIN_WU, SPHERE_DIAMETER_MAX_WU);
  const radiusWU = diamWU * 0.5;

  spheres.push({ s: s0, step: STEP_INIT, az, color: currentRGB, radiusWU });
}

function paint(api){
  const changes = [];

  for (let si = 0; si < spheres.length; si++){
    const d = spheres[si];
    const sClamped = d.s < 0 ? 0 : (d.s > 1 ? 1 : d.s);
    const C = posOnMeridianAz(center, domeR, sClamped, d.az);

    for (let ii = 0; ii < IDS.length; ii++){
      const id = IDS[ii];
      const p = api.posOf(id);
      if (!p || !Number.isFinite(p.x)) continue;

      const dx = p.x - C.x, dy = p.y - C.y, dz = p.z - C.z;
      const dWU = Math.hypot(dx, dy, dz);

      if (dWU <= d.radiusWU){
        const a = 1;
        const key = `${d.color[0].toFixed(3)},${d.color[1].toFixed(3)},${d.color[2].toFixed(3)},${a}`;
        const prev = painted.get(id);
        if (prev !== key){
          painted.set(id, key);
          changes.push({ id, color: [d.color[0], d.color[1], d.color[2], a] });
        }
      }
    }
  }

  if (changes.length) api.setColors(changes);
}
