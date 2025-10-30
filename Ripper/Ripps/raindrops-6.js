// ripp—tdl-collide-orange-emitter (30fps, geometric-accel, random-start+az, trails+palette).js
// Preview contract: init(api), update(api, t, dt)

export const meta = { name: 'Emitter: Top→Bottom (geom accel, random start+az, trails+palette)', fps: 30, duration: 120 };

// ---- Tunables --------------------------------------------------------------
const SPHERE_RADIUS_WU = 12.0;
const EMIT_PERIOD_MS   = 45;
const START_FRAC_MIN   = 0.07;
const START_FRAC_MAX   = 0.15;

const STEP_INIT        = 0.007;
const ACCEL            = 1.55;
const STEP_MAX         = 0.09;

const MAX_LIVE_SPHERES = 600;
const S_CULL_OVER      = 1.02;

// ---- Helpers ---------------------------------------------------------------
const sub = (a,b)=>({x:a.x-b.x, y:a.y-b.y, z:a.z-b.z});
function allTDLIds(api){
  const T = Array.isArray(api?.ids?.T) ? api.ids.T : [];
  const D = Array.isArray(api?.ids?.D) ? api.ids?.D : [];
  const L = Array.isArray(api?.ids?.L) ? api.ids?.L : [];
  return [...new Set([...T, ...D, ...L])];
}
function randIn(min,max){ return min + Math.random()*(max-min); }

// Bright color generator (HSV→RGB)
function hsvToRgb(h, s, v){
  const c = v * s; const x = c * (1 - Math.abs((h/60)%2 - 1)); const m = v - c;
  let r=0,g=0,b=0;
  if (0<=h && h<60){ r=c; g=x; b=0; }
  else if (60<=h && h<120){ r=x; g=c; b=0; }
  else if (120<=h && h<180){ r=0; g=c; b=x; }
  else if (180<=h && h<240){ r=0; g=x; b=c; }
  else if (240<=h && h<300){ r=x; g=0; b=c; }
  else { r=c; g=0; b=x; }
  return [r+m, g+m, b+m];
}
function randomBrightRGB(){
  const h = Math.random()*360;
  const s = 0.85 + Math.random()*0.15;
  const v = 0.9;
  return hsvToRgb(h, s, v);
}

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
let center = {x:0,y:0,z:0};
let domeR = 250;
let emitAccMs = 0;
const spheres = [];
let needFirstSpawnAtNow = true;

let dropsSpawned = 0;
let currentRGB = [1, 0.5, 0];
const painted = new Map();  // id -> 'r,g,b,a'

export function init(api){
  IDS = allTDLIds(api);

  // START BLACK
  api.setColors(IDS.map(id => ({ id, color: [0,0,0,1] })));

  if (api.info && Number.isFinite(api.info.radius)) domeR = api.info.radius;
  if (api.info && api.info.center) center = {x:api.info.center.x||0, y:api.info.center.y||0, z:api.info.center.z||0};

  spheres.length = 0;
  emitAccMs = 0;
  needFirstSpawnAtNow = true;
  dropsSpawned = 0;
  currentRGB = [1, 0.5, 0];
  painted.clear();
}

export function update(api, t/*s*/, dt/*s*/){
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

  if (spheres.length){
    for (let i = spheres.length - 1; i >= 0; i--){
      const d = spheres[i];
      if (!Number.isFinite(d.s) || !Number.isFinite(d.step)) { spheres.splice(i,1); continue; }
      d.step = Math.min(STEP_MAX, d.step * ACCEL);
      if (d.step <= 0) { spheres.splice(i,1); continue; }
      d.s += d.step;
      if (d.s >= 1 || d.s > S_CULL_OVER){
        spheres.splice(i,1);
      }
    }
  }

  paint(api);
}

function spawnOne(){
  if ((dropsSpawned % 20) === 0){
    currentRGB = randomBrightRGB();
  }
  dropsSpawned++;

  if (spheres.length >= MAX_LIVE_SPHERES) return;
  const s0 = randIn(START_FRAC_MIN, START_FRAC_MAX);
  const az = Math.random() * Math.PI * 2;
  spheres.push({ s: s0, step: STEP_INIT, az, color: currentRGB });
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
      if (dWU <= SPHERE_RADIUS_WU){
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
