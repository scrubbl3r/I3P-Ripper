// /Ripps/plane-osc-spawner.js
// Bench-agnostic. Seed plane oscillates along a line while the line rotates about the dome center.
// Every 500ms we spawn a duplicate "wave" (max 10 live, 5s TTL) with a random color and random
// starting Euler phases (randomized X/Y/Z starting orientation). T/D/L within 1.0 DM get colored.
// Newest instance wins (LIFO) when overlaps happen.

export const meta = {
  name: 'Plane Osc · Spawner (0.5s) · 10 max · 1.0DM band',
  fps: 60,
  duration: 120
};

// ---------- tiny vec helpers ----------
const dot = (a,b)=>a.x*b.x + a.y*b.y + a.z*b.z;
const sub = (a,b)=>({x:a.x-b.x, y:a.y-b.y, z:a.z-b.z});
const add = (a,b)=>({x:a.x+b.x, y:a.y+b.y, z:a.z+b.z});
const mul = (a,s)=>({x:a.x*s, y:a.y*s, z:a.z*s});
const len = (a)=>Math.hypot(a.x,a.y,a.z);
const norm= (a)=>{const L=len(a)||1; return {x:a.x/L,y:a.y/L,z:a.z/L};};

function rotX(v,a){ const c=Math.cos(a), s=Math.sin(a); return { x:v.x, y:c*v.y - s*v.z, z:s*v.y + c*v.z }; }
function rotY(v,a){ const c=Math.cos(a), s=Math.sin(a); return { x:c*v.x + s*v.z, y:v.y, z:-s*v.x + c*v.z }; }
function rotZ(v,a){ const c=Math.cos(a), s=Math.sin(a); return { x:c*v.x - s*v.y, y:s*v.x + c*v.y, z:v.z }; }
function applyEuler(v, ax, ay, az){ return rotZ(rotY(rotX(v,ax),ay),az); }

// ---------- canon / knobs ----------
let DM_TO_WU = 14;       // picks up window.WB_DM_WU if present
const BAND_DM     = 1.0; // influence half-thickness
const EXTEND_DM   = 0.8; // extend endpoints along the segment
const OSC_PERIOD  = 1.0; // seconds per full back-forth (kept at 1s)
const ROT_X_PER   = 1.0; // seconds per 360° around X
const ROT_Y_PER   = 1.5; // seconds per 360° around Y
const ROT_Z_PER   = 1.2; // seconds per 360° around Z

const SPAWN_EVERY = 0.5; // seconds
const MAX_LIVE    = 10;  // max copies alive
const TTL         = MAX_LIVE * SPAWN_EVERY; // 5s so we naturally cap at 10

let BAND_WU   = 14.0;
let EXTEND_WU = 11.2;

// ---------- seed path (relative to dome center) ----------
let center, radius;
let vS0, vE0; // endpoints in center-relative space

// ---------- sampling targets ----------
let samples = []; // { id, pos }

// ---------- instance state ----------
/*
  instance = {
    born: seconds,
    color: [r,g,b,a],
    phase: { x, y, z, osc }, // random starting phases (radians)
  }
*/
let waves = [];
let lastSpawnT = -Infinity;

// base & blend
const BASE = [1,1,1,1];
function rnd(min=0,max=1){ return min + Math.random()*(max-min); }
function rndColor(){
  // bright-ish random; keep alpha=1
  const h = Math.random(), s = 0.8, l = 0.55;
  // HSL -> RGB (quick ‘n simple)
  const a = s * Math.min(l,1-l);
  const f = n=>{
    const k=(n + h*12)%12;
    return l - a * Math.max(Math.min(k-3, 9-k, 1), -1);
  };
  return [f(0), f(8), f(4), 1];
}

export function init(api){
  if (typeof window !== 'undefined' && Number.isFinite(window.WB_DM_WU)){
    DM_TO_WU = window.WB_DM_WU;
  }
  BAND_WU   = BAND_DM   * DM_TO_WU;
  EXTEND_WU = EXTEND_DM * DM_TO_WU;

  const info = api.info || { center:{x:0,y:0,z:0}, radius:200 };
  center = { x:info.center.x, y:info.center.y, z:info.center.z };
  radius = Number(info.radius || 200);

  // Seed segment through center along X (span ~0.8*diameter)
  const halfSpan = 0.8 * radius;
  const baseStart = { x: center.x - halfSpan, y: center.y, z: center.z };
  const baseEnd   = { x: center.x + halfSpan, y: center.y, z: center.z };

  // Extend endpoints
  const dirSE = norm(sub(baseEnd, baseStart));
  const dirES = mul(dirSE, -1);
  const pStartExt = add(baseStart, mul(dirES, EXTEND_WU));
  const pEndExt   = add(baseEnd,   mul(dirSE, EXTEND_WU));

  vS0 = sub(pStartExt, center);
  vE0 = sub(pEndExt,   center);

  // panel sample list (T/D/L)
  const ids = [...(api.ids?.T||[]), ...(api.ids?.D||[]), ...(api.ids?.L||[])];
  samples = ids.map(id => ({ id, pos: api.posOf(id) }))
               .filter(s => Number.isFinite(s.pos?.x));

  waves.length = 0;
  lastSpawnT = -Infinity;

  api.resetColorsTo(BASE);

  // spawn the seed wave immediately
  spawnWave(0);
}

function spawnWave(tNow){
  const w = {
    born: tNow,
    color: rndColor(),
    phase: {
      x: rnd(0, 2*Math.PI),
      y: rnd(0, 2*Math.PI),
      z: rnd(0, 2*Math.PI),
      osc: rnd(0, 2*Math.PI)
    }
  };
  waves.push(w);
  // hard LIFO cap in case TTL ever changes
  if (waves.length > MAX_LIVE) waves.pop(); // drop newest if we somehow exceeded
}

export function update(api, t, dt){
  // natural TTL trim (oldest first)
  while (waves.length && (t - waves[0].born) > TTL) waves.shift();

  // spawn on schedule
  if ((t - lastSpawnT) >= SPAWN_EVERY - 1e-6){
    spawnWave(t);
    lastSpawnT = t;
  }

  // start with base color for everyone
  const out = samples.map(s => ({ id: s.id, color: BASE }));

  // Evaluate each wave in LIFO order so newest wins
  for (let wi = waves.length - 1; wi >= 0; wi--){
    const w = waves[wi];
    const age = t - w.born;

    // Euler rotations with per-wave starting phases
    const ax = 2*Math.PI * ((t / ROT_X_PER)) + w.phase.x;
    const ay = 2*Math.PI * ((t / ROT_Y_PER)) + w.phase.y;
    const az = 2*Math.PI * ((t / ROT_Z_PER)) + w.phase.z;

    // rotate seed endpoints about center
    const vS = applyEuler(vS0, ax, ay, az);
    const vE = applyEuler(vE0, ax, ay, az);
    const pS = add(center, vS);
    const pE = add(center, vE);

    // segment & plane normal
    const seg  = sub(pE, pS);
    const dir  = norm(seg);
    const sLen = len(seg);

    // oscillation along the (rotated) path (same speed for all, random start phase)
    const u = 0.5*(1 + Math.sin((2*Math.PI/OSC_PERIOD) * t + w.phase.osc)); // 0..1
    const p0 = add(pS, mul(dir, u * sLen)); // plane point at this time
    const n  = dir;

    // paint hits
    for (let i=0; i<samples.length; i++){
      const pos = samples[i].pos;
      const d = Math.abs( dot(sub(pos, p0), n) );
      if (d <= BAND_WU){
        out[i].color = w.color; // newest wave overrides previous color
      }
    }
  }

  if (out.length) api.setColors(out);
}
