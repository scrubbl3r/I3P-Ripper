// /Ripps/plane-osc-spawner + STROBE.js
// Bench-agnostic. Seed plane oscillates along a line while the line rotates about the dome center.
// Every 200ms we spawn a duplicate "wave" (max 14 live, ~2.8s TTL) with a random color from a fixed palette
// and random Euler start phases. T/D/L within BAND_DM get colored. Newest wins (LIFO).
// ADD: global strobe (full-frame RGB invert) at ~8–12 Hz (default 10 Hz).

export const meta = {
  name: 'Plane Osc · Spawner (0.2s) · 14 max · Strobe 10Hz',
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
let DM_TO_WU = 14;        // picks up window.WB_DM_WU if present
const BAND_DM     = 2.0;  // influence half-thickness
const EXTEND_DM   = 0.8;  // extend endpoints along the segment
const OSC_PERIOD  = 1.2;  // seconds per full back-forth
const ROT_X_PER   = 1.0;  // seconds per 360° around X
const ROT_Y_PER   = 1.5;  // seconds per 360° around Y
const ROT_Z_PER   = 1.2;  // seconds per 360° around Z

const SPAWN_EVERY = 0.2;  // seconds
const MAX_LIVE    = 14;   // max copies alive
const TTL         = MAX_LIVE * SPAWN_EVERY; // ~2.8s

// ---------- STROBE ----------
const STROBE_ENABLED = true;
const STROBE_HZ      = 10;     // 10 Hz is clean at 30 fps (3 frames/cycle)
const STROBE_DUTY    = 0.5;    // 50% on / 50% off

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
    phase: { x, y, z, osc }
  }
*/
let waves = [];
let lastSpawnT = -Infinity;

// base & blend
const BASE = [0,0,0,1];

// ---------- RNG PALETTE (provided earlier idea) ----------
const PALETTE = [
  [0.992,0.992,0.992,1],[0.976,0.984,0,1],[0.012,0.996,1,1],[0.004,1,0,1],
  [0.992,0,0.984,1],[0.984,0.004,0.008,1],[0.078,0.078,0.078,1],[0.012,0.004,0.984,1]
];

function rnd(min=0,max=1){ return min + Math.random()*(max-min); }
function rndColorFromPalette(){
  const idx = (Math.random()*PALETTE.length) | 0;
  const c = PALETTE[idx];
  return [c[0], c[1], c[2], c[3]];
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
  const halfSpan  = 0.8 * radius;
  const baseStart = { x: center.x - halfSpan, y: center.y, z: center.z };
  const baseEnd   = { x: center.x + halfSpan, y: center.y, z: center.z };

  // Extend endpoints
  const dirSE   = norm(sub(baseEnd, baseStart));
  const dirES   = mul(dirSE, -1);
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

  // start black
  api.resetColorsTo(BASE);

  // spawn the seed wave immediately
  spawnWave(0);
}

function spawnWave(tNow){
  const w = {
    born: tNow,
    color: rndColorFromPalette(),
    phase: {
      x: rnd(0, 2*Math.PI),
      y: rnd(0, 2*Math.PI),
      z: rnd(0, 2*Math.PI),
      osc: rnd(0, 2*Math.PI)
    }
  };
  waves.push(w);
  // hard LIFO cap in case TTL ever changes
  if (waves.length > MAX_LIVE) waves.pop();
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
    const u = 0.5 * (1 + Math.sin((2*Math.PI/OSC_PERIOD) * t + w.phase.osc)); // 0..1
    const p0 = add(pS, mul(dir, u * sLen)); // plane point at this time
    const n  = dir;

    // paint hits
    for (let i=0; i<samples.length; i++){
      const pos = samples[i].pos;
      const d   = Math.abs( dot(sub(pos, p0), n) );
      if (d <= BAND_WU){
        out[i].color = w.color; // newest wave overrides previous color
      }
    }
  }

  // ---- STROBE POST-PASS ----------------------------------------------------
  if (STROBE_ENABLED){
    const phase = (t * STROBE_HZ) % 1;     // 0..1
    if (phase < STROBE_DUTY){
      for (let i = 0; i < out.length; i++){
        const c = out[i].color;
        // total inversion (RGB), preserve alpha
        out[i].color = [1 - c[0], 1 - c[1], 1 - c[2], c[3]];
      }
    }
  }

  if (out.length) api.setColors(out);
}
