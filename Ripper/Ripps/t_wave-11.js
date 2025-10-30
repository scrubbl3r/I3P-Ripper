// ripp—planewave—spawned waves (tiltX+25, spinY 2s, XY sweep + Z→90, band-blend, SPAWN_MS).js
// Preview contract: init(api), update(api, t, dt)

export const meta = { name: 'Planewave — spawned waves, rolling band blend', fps: 60, duration: 120 };

// ---- Tunables --------------------------------------------------------------
const WAVE_PALETTE = [
  [1,0.737,0.02,1],
  [0,0.529,0.878,1],
  [0,0.078,0.522,1],
  [0.984,0.027,0.6,1],
];

const TILT_X_DEG     = 20;
const SPIN_PERIOD_MS = 3000;

const X_SWEEP_MS   = 2700;
const Y_SWEEP_MS   = 2000;
const Z_TUMBLE_MS  = 14000;
const WAVE_LIFETIME_MS = Math.max(X_SWEEP_MS, Y_SWEEP_MS, Z_TUMBLE_MS);

// tighter cadence
const SPAWN_MS = 1800;

const FEATHER_WU      = 1.8;
const RIPPLE_AMP_WU   = 3.0;
const FEATHER_GAIN    = 0.75;
const RIPPLE_FREQ_CYC = 4.2;
const RIPPLE_SPEED_HZ = 0.06;

const INITIAL_BG = [1, 1, 1, 1];

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
function smooth01(x){ const t=clamp01(x); return t*t*(3-2*t); }
function lerpColor(a,b,t){ return [ mix(a[0],b[0],t), mix(a[1],b[1],t), mix(a[2],b[2],t), mix(a[3],b[3],t) ]; }

function normalFromEuler(rx, ry, rz){
  let nx = 0, ny = 1, nz = 0;
  { const c=Math.cos(rx), s=Math.sin(rx); const ny1 = ny*c - nz*s; const nz1 = ny*s + nz*c; ny = ny1; nz = nz1; }
  { const c=Math.cos(ry), s=Math.sin(ry); const nx1 = nx*c + nz*s; const nz1 = -nx*s + nz*c; nx = nx1; nz = nz1; }
  { const c=Math.cos(rz), s=Math.sin(rz); const nx1 = nx*c - ny*s; const ny1 = nx*s + ny*c; nx = nx1; ny = ny1; }
  const inv = 1 / Math.hypot(nx, ny, nz);
  return { x: nx*inv, y: ny*inv, z: nz*inv };
}
function dot(a,b){ return a.x*b.x + a.y*b.y + a.z*b.z; }
function cross(a,b){ return { x:a.y*b.z - a.z*b.y, y:a.z*b.x - a.x*b.z, z:a.x*b.y - a.y*b.x }; }
function norm(v){ const L=Math.hypot(v.x,v.y,v.z)||1; return {x:v.x/L, y:v.y/L, z:v.z/L}; }

function planeBasis(n){
  const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
  const ref = (ax<ay && ax<az) ? {x:1, y:0, z:0} : (ay<az ? {x:0,y:1,z:0} : {x:0,y:0,z:1});
  const uT = norm(cross(ref, n));
  const vT = cross(n, uT);
  return { uT, vT };
}

// same ripple profile as before
function edgeProfileForPoint(p, planePoint, n, timeSec){
  const r = sub(p, planePoint);
  const { uT, vT } = planeBasis(n);
  const u = dot(r, uT);
  const v = dot(r, vT);
  const theta = Math.atan2(v, u);
  const phase = 2*Math.PI*RIPPLE_SPEED_HZ*timeSec;
  const ripple = RIPPLE_AMP_WU * Math.sin(theta * RIPPLE_FREQ_CYC + phase);
  const featherWU = FEATHER_WU + FEATHER_GAIN * Math.abs(ripple);
  const dRaw = dot(r, n);
  const dEff = dRaw - ripple;
  return { dEff, featherWU };
}

function randInt(n){ return Math.floor(Math.random()*n); }

// ---- State -----------------------------------------------------------------
let IDS = [];
let center = {x:0,y:0,z:0};

let lastSpawnMs = null;
let lastPaletteIdx = -1;

let waves = [];
let nextWaveId = 1;

// persistent framebuffer
let prevColors = new Map();

// ---- Wave factory ----------------------------------------------------------
function pickNonRepeatingColor(){
  let idx = randInt(WAVE_PALETTE.length);
  if (WAVE_PALETTE.length > 1){
    while (idx === lastPaletteIdx) idx = randInt(WAVE_PALETTE.length);
  }
  lastPaletteIdx = idx;
  return WAVE_PALETTE[idx];
}

function spawnWave(nowMs){
  const t0 = nowMs;
  const spin0 = nowMs;
  const color = pickNonRepeatingColor();
  const underColorById = new Map();
  // this wave paints the "other" side solid
  const solidSide = -1;
  return { id: nextWaveId++, t0, spin0, color, underColorById, solidSide };
}

// Compute pose/orientation for a wave at time nowMs
function wavePose(wave, nowMs){
  const elapsed = nowMs - wave.t0;
  const ux = clamp01(elapsed / X_SWEEP_MS);
  const uy = clamp01(elapsed / Y_SWEEP_MS);
  const uz = clamp01(elapsed / Z_TUMBLE_MS);

  const ry = ((nowMs - wave.spin0) % SPIN_PERIOD_MS) / SPIN_PERIOD_MS * 2*Math.PI;
  const rz = rad(90 * uz);

  const planePoint = {
    x: mix(center.x + 70, center.x - 70, ux),
    y: mix(center.y - 57, center.y + 75, uy),
    z: center.z
  };
  const n = normalFromEuler(rad(TILT_X_DEG), ry, rz);

  return { planePoint, n };
}

// ---- Lifecycle -------------------------------------------------------------
export function init(api){
  IDS = allTDLIds(api);

  if (api.info && api.info.center){
    center = { x: api.info.center.x||0, y: api.info.center.y||0, z: api.info.center.z||0 };
  }

  // persistent framebuffer init
  prevColors.clear();
  for (const id of IDS){
    prevColors.set(id, INITIAL_BG.slice());
  }
  api.setColors(IDS.map(id => ({ id, color: prevColors.get(id) })));

  // first spawn
  lastSpawnMs = 0;
  waves = [ spawnWave(0) ];
}

export function update(api, t/*s*/, dt/*s*/){
  if (!IDS.length) init(api);

  const nowMs = Math.max(0, t*1000);
  const timeSec = t;

  // 1) spawn manager
  if (lastSpawnMs === null) lastSpawnMs = nowMs;
  if (nowMs - lastSpawnMs >= SPAWN_MS){
    waves.push( spawnWave(nowMs) );
    lastSpawnMs = nowMs;
  }

  // prepare waves for “can I destroy?” info this frame
  for (const w of waves){
    w._hasFeather = false;   // saw at least one LED still in feather
    w._hasBackSide = false;  // saw at least one LED on the NOT-solid side
  }

  // we'll collect *all* color changes (normal + finalize) here
  const outChanges = [];

  // 2) per-frame compositing: start from PREVIOUS COLOR, not white
  for (const id of IDS){
    const p = api.posOf(id);
    if (!p || !Number.isFinite(p.x)) {
      outChanges.push({ id, color: prevColors.get(id) || INITIAL_BG.slice() });
      continue;
    }

    // start from last frame's color
    let col = prevColors.get(id) || INITIAL_BG.slice();

    // layer waves in birth order
    for (let wi = 0; wi < waves.length; wi++){
      const wave = waves[wi];
      const { planePoint, n } = wavePose(wave, nowMs);
      const { dEff, featherWU } = edgeProfileForPoint(p, planePoint, n, timeSec);

      const absd = Math.abs(dEff);
      let wBell = 0;
      if (featherWU > 0 && absd < featherWU){
        const b = 1 - (absd / featherWU);  // 1 at center
        wBell = smooth01(b);               // 0..1
      }

      if (wBell > 0){
        // still in feather → wave not done yet
        wave._hasFeather = true;

        // inside feather: capture base and blend
        if (!wave.underColorById.has(id)){
          wave.underColorById.set(id, col.slice());
        }
        const base = wave.underColorById.get(id);
        col = lerpColor(base, wave.color, wBell);
      } else {
        const solidSide = wave.solidSide ?? 1;
        const onSolidSide = (dEff * solidSide) >= featherWU;

        if (onSolidSide){
          // we only force solid if we’ve actually visited this LED
          if (wave.underColorById.has(id)){
            col = wave.color.slice();
          }
        } else {
          // this LED is on the opposite side of the plane
          if (wave.underColorById.has(id)){
            // not fully done yet, this wave still has a “back” LED
            wave._hasBackSide = true;
            const base = wave.underColorById.get(id);
            col = base.slice();
          }
        }
      }
    }

    // write back to persistent framebuffer
    prevColors.set(id, col);
    outChanges.push({ id, color: col });
  }

  // 3) destroy waves ONLY when every TDL they touched is fully opaque (no feather)
  if (waves.length){
    const alive = [];
    for (const wave of waves){
      // condition: wave actually touched something, and no feather, and no back side
      if (
        wave.underColorById.size > 0 &&
        !wave._hasFeather &&
        !wave._hasBackSide
      ){
        // finalize: force all touched LEDs to solid color, update framebuffer
        for (const id of wave.underColorById.keys()){
          prevColors.set(id, wave.color.slice());
          outChanges.push({ id, color: wave.color.slice() });
        }
        // drop wave
      } else {
        alive.push(wave);
      }
    }
    waves = alive;
  }

  // 4) single draw → avoids spawn flicker from multi-setColors
  if (outChanges.length) api.setColors(outChanges);
}
