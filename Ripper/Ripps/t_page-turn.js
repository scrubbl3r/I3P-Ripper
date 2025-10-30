// ripp—planewave—wipe (rotate Z, 5s wipe + 1s pause + reverse, soft 40ms ramp).js
// Preview contract: init(api), update(api, t, dt)
// Infinite plane rotates about **world Z**. We use it as a wiping front:
//   • 0–5000 ms: rotate forward → any T/D/L the plane intersects begins a
//                 40 ms fade to BLACK (wipe-in)
//   • 5000–6000 ms: pause (hold)
//   • 6000–11000 ms: rotate backward → intersections begin a 40 ms fade to WHITE (wipe-out)
//   • 11000–12000 ms: pause (hold) → loop
// TD/Ls are initialized WHITE.

export const meta = { name: 'Planewave — Z wipe (5s + pause + reverse, soft ramp)', fps: 30, duration: 120 };

// ---- Tunables --------------------------------------------------------------
const HALF_THICKNESS_WU = 2.5;    // collision band half‑thickness around the plane
const Y_DROP_BEYOND_WU  = 5.0;    // anchor plane below dome bottom by this many WU
const WIPE_FWD_MS       = 5000;   // forward wipe duration
const HOLD_TOP_MS       = 1000;   // pause after forward wipe
const WIPE_BACK_MS      = 5000;   // reverse wipe duration
const HOLD_BOTTOM_MS    = 1000;   // pause after reverse wipe
const RAMP_MS           = 40;     // per‑panel fade time when switching colors
const PHASE0            = Math.PI * 0.5; // start with plane **horizontal under dome** (normal +Y)

const BASE_WHITE = [1, 1, 1, 1];
const BLACK      = [0, 0, 0, 1];

// ---- Helpers ---------------------------------------------------------------
const sub = (a,b)=>({x:a.x-b.x, y:a.y-b.y, z:a.z-b.z});
function allTDLIds(api){
  const T = Array.isArray(api?.ids?.T) ? api.ids.T : [];
  const D = Array.isArray(api?.ids?.D) ? api.ids.D : [];
  const L = Array.isArray(api?.ids?.L) ? api.ids.L : [];
  return [...new Set([...T, ...D, ...L])];
}
function mix(a,b,t){ return a + (b-a)*t; }
function lerpColor(c0, c1, t){ return [mix(c0[0],c1[0],t), mix(c0[1],c1[1],t), mix(c0[2],c1[2],t), mix(c0[3],c1[3],t)]; }

// ---- State -----------------------------------------------------------------
let IDS = [];
let center = {x:0,y:0,z:0};
let domeR = 250; // fallback
let lastEmitted = new Set(); // unused but kept for potential diffing extension

// Per‑panel color/transition state
// map id -> { color:[r,g,b,a], t0:number|null, from:[..], to:[..] }
const S = new Map();

export function init(api){
  IDS = allTDLIds(api);

  if (api.info && Number.isFinite(api.info.radius)) domeR = api.info.radius;
  if (api.info && api.info.center) center = { x: api.info.center.x||0, y: api.info.center.y||0, z: api.info.center.z||0 };

  // Initialize all panels to solid white
  const entries = [];
  for (const id of IDS){
    S.set(id, { color: BASE_WHITE.slice(), t0: null, from: BASE_WHITE.slice(), to: BASE_WHITE.slice() });
    entries.push({ id, color: BASE_WHITE });
  }
  if (entries.length) api.setColors(entries);
}

export function update(api, t/*s*/, dt/*s*/){
  if (!IDS.length) init(api);
  const nowMs = Math.max(0, t*1000);

  // ---- Compute current plane normal (Z‑axis rotation with holds and reverse) ----
  const CYCLE_MS = WIPE_FWD_MS + HOLD_TOP_MS + WIPE_BACK_MS + HOLD_BOTTOM_MS; // 12000
  const u = nowMs % CYCLE_MS;

  let theta; // angle around Z
  let mode;  // 'black' during forward wipe, 'white' during reverse, null during holds
  if (u < WIPE_FWD_MS){
    // forward PHASE0 → PHASE0+2π over WIPE_FWD_MS
    const a = u / WIPE_FWD_MS; // 0..1
    theta = PHASE0 + a * (Math.PI*2);
    mode = 'black';
  } else if (u < WIPE_FWD_MS + HOLD_TOP_MS){
    theta = PHASE0 + (Math.PI*2);
    mode = null; // hold
  } else if (u < WIPE_FWD_MS + HOLD_TOP_MS + WIPE_BACK_MS){
    const a = (u - (WIPE_FWD_MS + HOLD_TOP_MS)) / WIPE_BACK_MS; // 0..1
    theta = PHASE0 + (Math.PI*2) * (1 - a); // reverse back to 0
    mode = 'white';
  } else {
    theta = PHASE0;
    mode = null; // hold
  }

  const n = { x: Math.cos(theta), y: Math.sin(theta), z: 0 }; // unit normal in XY

  // Anchor point for plane just below dome bottom
  const planePoint = { x: center.x, y: center.y - domeR - Y_DROP_BEYOND_WU, z: center.z };

  // Determine which ids are intersected by the plane band this frame
  const hitNow = new Set();
  for (let i=0; i<IDS.length; i++){
    const id = IDS[i];
    const p = api.posOf(id);
    if (!p || !Number.isFinite(p.x)) continue;
    const v = sub(p, planePoint);
    const d = v.x*n.x + v.y*n.y + v.z*n.z;
    if (Math.abs(d) <= HALF_THICKNESS_WU) hitNow.add(id);
  }

  // Kick transitions for hit ids depending on mode
  const toColor = (mode === 'black') ? BLACK : (mode === 'white' ? BASE_WHITE : null);
  if (toColor){
    const T0 = nowMs;
    for (const id of hitNow){
      const st = S.get(id) || { color: BASE_WHITE.slice(), t0:null, from: BASE_WHITE.slice(), to: BASE_WHITE.slice() };
      // If already targeting the same color and not changing, skip
      const sameTarget = st.to && st.to[0]===toColor[0] && st.to[1]===toColor[1] && st.to[2]===toColor[2] && st.to[3]===toColor[3];
      const already = st.color[0]===toColor[0] && st.color[1]===toColor[1] && st.color[2]===toColor[2] && st.color[3]===toColor[3];
      if (!sameTarget && !already){
        st.t0 = T0;
        st.from = st.color.slice();
        st.to = toColor.slice();
        S.set(id, st);
      }
    }
  }

  // Advance transitions and emit color changes
  const changes = [];
  for (const [id, st] of S.entries()){
    if (st.t0 != null){
      const a = Math.min(1, (nowMs - st.t0) / RAMP_MS);
      const col = lerpColor(st.from, st.to, a);
      // Only emit if visibly changed (or until we finish)
      const changed = (Math.abs(col[0]-st.color[0])>1e-3 || Math.abs(col[1]-st.color[1])>1e-3 || Math.abs(col[2]-st.color[2])>1e-3 || Math.abs(col[3]-st.color[3])>1e-3);
      if (changed){
        st.color = col;
        changes.push({ id, color: col });
      } else if (a>=1){
        st.color = st.to.slice();
        st.t0 = null; // finished
        changes.push({ id, color: st.color });
      }
    }
  }

  if (changes.length) api.setColors(changes);
}
