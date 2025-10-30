// ripp—tdl-collide-orange-emitter (30fps, geometric-accel, random-start+az, gc+perf).js
// Preview contract: init(api), update(api, t, dt)
// Same vibe as your current build, with **hard GC + perf guards**:
//  • Strict cull when s > 1 or invalid (NaN/Inf), plus overshoot safety (S_CULL_OVER)
//  • Max live sphere cap (MAX_LIVE_SPHERES) — oldest drops are culled when over budget
//  • Reuse a single Set for hits to avoid per-frame allocations
//  • Early‑out if there are zero spheres
//  • Minor micro‑opts in loops

export const meta = { name: 'Emitter: Top→Bottom (orange, geom accel, rnd start+az, GC)', fps: 60, duration: 120 };

// ---- Tunables --------------------------------------------------------------
const SPHERE_RADIUS_WU = 15.0;      // collision radius
const EMIT_PERIOD_MS   = 100;       // spawn cadence (timer only)
const START_FRAC_MIN   = 0.07;      // random spawn band (0=crown)
const START_FRAC_MAX   = 0.15;

// Geometric acceleration (per-frame, NOT per-time)
const STEP_INIT        = 0.005;     // initial path increment per frame (fraction of path)
const ACCEL            = 1.05;      // multiply step by this each frame (grows speed)
const STEP_MAX         = 0.06;      // clamp to keep things sane

// GC / perf controls
const MAX_LIVE_SPHERES = 600;       // hard cap to avoid O(N_spheres * N_panels) blow‑ups
const S_CULL_OVER      = 1.02;      // overshoot guard: cull if s passes this

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
function randIn(min,max){ return min + Math.random()*(max-min); }

// Map path fraction s∈[0..1] to a meridian rotated by az around Y (Y‑up)
function posOnMeridianAz(center, domeR, s, az){
  const theta = Math.PI/2 - Math.PI * s;   // +Y crown → −Y bottom
  const y = center.y + domeR * Math.sin(theta);
  const rHor = domeR * Math.cos(theta);    // horizontal radius at this latitude
  const x = center.x + rHor * Math.sin(az);
  const z = center.z + rHor * Math.cos(az);
  return { x, y, z };
}

// ---- State -----------------------------------------------------------------
let IDS = [];
let center = {x:0,y:0,z:0};
let domeR = 250; // fallback
let lastHit = new Set();
let emitAccMs = 0;
// each sphere: { s:number, step:number, az:number }
const spheres = [];
let needFirstSpawnAtNow = true;
// Reusable hit set to avoid per‑frame allocations
const hit = new Set();

export function init(api){
  IDS = allTDLIds(api);
  api.resetColorsTo(BASE);

  if (api.info && Number.isFinite(api.info.radius)) domeR = api.info.radius;
  if (api.info && api.info.center) center = {x:api.info.center.x||0, y:api.info.center.y||0, z:api.info.center.z||0};

  spheres.length = 0;
  emitAccMs = 0;
  needFirstSpawnAtNow = true;
  hit.clear();
}

export function update(api, t/*s*/, dt/*s*/){
  // spawn according to cadence (timer only)
  const dtMs = Math.max(0, dt*1000);

  if (needFirstSpawnAtNow){
    spawnOne();
    needFirstSpawnAtNow = false;
  }

  emitAccMs += dtMs;
  while (emitAccMs >= EMIT_PERIOD_MS){
    emitAccMs -= EMIT_PERIOD_MS;
    spawnOne();
  }

  if (spheres.length === 0){
    // nothing to do
    return;
  }

  // advance each sphere geometrically per frame (no dt dependence) with GC hardening
  for (let i = spheres.length - 1; i >= 0; i--){
    const d = spheres[i];
    // validate
    if (!Number.isFinite(d.s) || !Number.isFinite(d.step)) { spheres.splice(i,1); continue; }
    d.step = Math.min(STEP_MAX, d.step * ACCEL);
    if (d.step <= 0) { spheres.splice(i,1); continue; }
    d.s += d.step;
    if (d.s >= 1 || d.s > S_CULL_OVER){
      spheres.splice(i,1);
    }
  }

  // enforce max live spheres (drop oldest)
  if (spheres.length > MAX_LIVE_SPHERES){
    const drop = spheres.length - MAX_LIVE_SPHERES;
    spheres.splice(0, drop); // remove the oldest first
  }

  paint(api);
}

function spawnOne(){
  // Guard against runaway queue
  if (spheres.length >= MAX_LIVE_SPHERES) return;
  const s0 = randIn(START_FRAC_MIN, START_FRAC_MAX);
  const az = Math.random() * Math.PI * 2; // random meridian around Y
  spheres.push({ s: s0, step: STEP_INIT, az });
}

function paint(api){
  hit.clear();

  // Gather hits across all live spheres
  const nS = spheres.length;
  const nI = IDS.length;
  for (let si = 0; si < nS; si++){
    const d = spheres[si];
    const sClamped = d.s < 0 ? 0 : (d.s > 1 ? 1 : d.s);
    const C = posOnMeridianAz(center, domeR, sClamped, d.az);
    for (let ii = 0; ii < nI; ii++){
      const id = IDS[ii];
      const p = api.posOf(id);
      if (!p || !Number.isFinite(p.x)) continue;
      const dx = p.x - C.x, dy = p.y - C.y, dz = p.z - C.z;
      const dWU = Math.hypot(dx, dy, dz);
      if (dWU <= SPHERE_RADIUS_WU) hit.add(id);
    }
  }

  // Diff vs last frame
  const changes = [];
  // ids that were hit but no longer
  for (const id of lastHit){ if (!hit.has(id)) changes.push({ id, color: BASE }); }
  // newly hit ids
  for (const id of hit){ if (!lastHit.has(id)) changes.push({ id, color: ORANGE }); }

  if (changes.length) api.setColors(changes);
  lastHit = new Set(hit); // keep set size bounded and drop old refs
}
