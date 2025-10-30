
// Plane Spawn ▸ Start→End ▸ Fade In/Out ▸ Blend Crossings ▸ Destroy
// RNG spawn 50–500ms · 40 max concurrent · band 0.01–2.0 DM
export const meta = { name: 'Plane Spawn → Fade → Blend (w/ Smooth Gradient Underlay)', fps: 60, duration: 120 };

// ---------- vec helpers ----------
const dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z;
const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
const add=(a,b)=>({x:a.x+b.x,y:a.y+b.y,z:a.z+b.z});
const mul=(a,s)=>({x:a.x*s,y:a.y*s,z:a.z*s});
const len=a=>Math.hypot(a.x,a.y,a.z);
const norm=a=>{const L=len(a)||1;return {x:a.x/L,y:a.y/L,z:a.z/L};};
function rotX(v,a){const c=Math.cos(a),s=Math.sin(a);return{ x:v.x,y:c*v.y-s*v.z,z:s*v.y+c*v.z }; }
function rotY(v,a){const c=Math.cos(a),s=Math.sin(a);return{ x:c*v.x+s*v.z,y:v.y,z:-s*v.x+c*v.z }; }
function rotZ(v,a){const c=Math.cos(a),s=Math.sin(a);return{ x:c*v.x-s*v.y,y:s*v.x+c*v.y,z:v.z }; }
function applyEuler(v,ax,ay,az){ return rotZ(rotY(rotX(v,ax),ay),az); }

// ---- PNG-derived palette (one color per swatch, 0..1 RGBA) ----
// (Drop-in literal table you asked for earlier)
const PALETTE = [
  [0.643,1,0.141,1],[0.643,1,0.141,1],[0.643,1,0.141,1],[0.643,1,0.141,1],[0.647,0.945,0.624,1],[1,0.969,0,1],[0.875,0.839,0.424,1],[0.612,0.91,0.047,1],[0.522,1,0.592,1],[0.898,0.737,0.243,1],[0.455,0.741,0.498,1],[0.337,0.82,0.024,1],[0.91,0.502,0.133,1],[0.047,0.725,0.412,1],[0.988,0.012,0.173,1],[0.988,0.012,0.173,1],[0.988,0.012,0.173,1],[0.918,0.447,0.369,1],[0.373,0.561,0.463,1],[0.09,0.678,0.024,1],[0.761,0.392,0.518,1],[0.796,0.525,0.024,1],[0.42,0.49,0.106,1],[0.11,0.529,0.439,1],[0.753,0.345,0.318,1],[0.455,0.435,0.263,1],[0.153,0.494,0.043,1],[0.333,0.341,0.478,1],[0.651,0.231,0.459,1],[0.529,0.271,0.212,1],[0.071,0.271,0.412,1],[0.204,0,0.639,1]
];
const pickColor = () => PALETTE[(Math.random()*PALETTE.length)|0];

// ---------- knobs (kept aligned with your working build) ----------
let DM_TO_WU=14;
const EXTEND_DM=0.8;

// rotation of guide path
const ROT_X_PER=10.0;
const ROT_Y_PER=10.0;
const ROT_Z_PER=10.0;

// spawn cadence (seconds)
const SPAWN_MIN=0.05;
const SPAWN_MAX=0.50;
const nextInterval = () => SPAWN_MIN + Math.random()*(SPAWN_MAX - SPAWN_MIN);

// count / band width / travel
const MAX_ACTIVE = 40;          // your larger flow
const BAND_MIN_DM = 0.01;
const BAND_MAX_DM = 2.0;
const TRAVEL_DUR = 4.0;         // start → end, then destroy

// ---------- state ----------
let EXTEND_WU=11.2;
let center, radius, vS0, vE0, samples=[];
let waves=[];
let timeToNext=0.2;

// ---------- alpha envelope ----------
const alphaEnvelope = (u)=>Math.sin(Math.PI*Math.max(0,Math.min(1,u))); // 0→1→0

// ---------- base reset (only used once) ----------
const BASE=[0,0,0,1];

// ===============================================================
//                    GRADIENT UNDERLAY (smooth)
// ===============================================================
//
// Design goals:
//  - no "pops": colors *easethrough* targets (cosine easing), long durations
//  - saturation preserved: operate directly in palette RGBA (no HSV wash-out)
//  - spatial blend along a slowly rotating axis
//
function lerp(a,b,t){ return a+(b-a)*t; }
function lerpColor(c0,c1,t){
  return [ lerp(c0[0],c1[0],t), lerp(c0[1],c1[1],t), lerp(c0[2],c1[2],t), 1 ];
}
function easeCos(t){ return 0.5 - 0.5*Math.cos(Math.PI*Math.min(1,Math.max(0,t))); }

const GRAD = {
  // two independent color lanes (A,B), each eases toward a target
  A: { cur: pickColor(), from: null, to: null, t0:0, dur:12, next:0 },
  B: { cur: pickColor(), from: null, to: null, t0:0, dur:16, next:0 },
  // slow rotation of gradient axis
  axisPhase: { x: Math.random()*6.283, y: Math.random()*6.283, z: Math.random()*6.283 }
};

// choose a new target different from current
function newTargetColor(cur){
  let c = pickColor();
  // avoid identical pick; also bias against picking an extremely similar color (keeps saturation presence)
  for(let i=0;i<8;i++){
    const d = Math.abs(c[0]-cur[0])+Math.abs(c[1]-cur[1])+Math.abs(c[2]-cur[2]);
    if(d>0.15) break;
    c = pickColor();
  }
  return c;
}

function updateLane(lane, t, durMin, durMax){
  if (t >= lane.next) {
    lane.from = lane.cur;
    lane.to   = newTargetColor(lane.cur);
    lane.t0   = t;
    lane.dur  = durMin + Math.random()*(durMax - durMin);
    lane.next = lane.t0 + lane.dur; // schedule next retarget
  }
  const u = easeCos((t - lane.t0) / lane.dur);
  lane.cur = lerpColor(lane.from || lane.cur, lane.to || lane.cur, u);
}

// rate multipliers (tweak externally if you like)
const GRAD_AXIS_RATE = 0.05;     // axis rotations
const GRAD_LANE_A_RANGE = [14, 28]; // seconds to retarget A
const GRAD_LANE_B_RANGE = [18, 36]; // seconds to retarget B
const GRAD_SPACE_FREQ = 1.35;    // spatial sinus frequency

function baseColorAt(pos, t){
  // advance lanes (very slow, long blends → no pops)
  updateLane(GRAD.A, t, GRAD_LANE_A_RANGE[0], GRAD_LANE_A_RANGE[1]);
  updateLane(GRAD.B, t, GRAD_LANE_B_RANGE[0], GRAD_LANE_B_RANGE[1]);

  // rotate axis slowly
  const ax = GRAD.axisPhase.x + t*GRAD_AXIS_RATE*0.15;
  const ay = GRAD.axisPhase.y + t*GRAD_AXIS_RATE*0.11;
  const az = GRAD.axisPhase.z + t*GRAD_AXIS_RATE*0.09;
  const dir = norm(applyEuler({x:1,y:0,z:0}, ax, ay, az));

  // spatial blend along axis
  const uSpace = 0.5 + 0.5*Math.sin(dot(sub(pos,center), dir)*(GRAD_SPACE_FREQ/(radius||1)));
  return lerpColor(GRAD.A.cur, GRAD.B.cur, uSpace);
}

// ===============================================================
//                           API
// ===============================================================
export function init(api){
  if(typeof window!=='undefined' && Number.isFinite(window.WB_DM_WU)) DM_TO_WU=window.WB_DM_WU;
  EXTEND_WU=EXTEND_DM*DM_TO_WU;

  const info=api.info||{center:{x:0,y:0,z:0},radius:200};
  center={x:info.center.x,y:info.center.y,z:info.center.z};
  radius=Number(info.radius||200);

  const halfSpan=0.8*radius;
  const baseStart={x:center.x-halfSpan,y:center.y,z:center.z};
  const baseEnd  ={x:center.x+halfSpan,y:center.y,z:center.z};

  const dirSE=norm(sub(baseEnd,baseStart));
  const dirES=mul(dirSE,-1);
  const pStartExt=add(baseStart,mul(dirES,EXTEND_WU));
  const pEndExt  =add(baseEnd,  mul(dirSE,EXTEND_WU));

  vS0=sub(pStartExt,center);
  vE0=sub(pEndExt,center);

  const ids=[...(api.ids?.T||[]),...(api.ids?.D||[]),...(api.ids?.L||[])];
  samples=ids.map(id=>({id,pos:api.posOf(id)})).filter(s=>Number.isFinite(s.pos?.x));

  // baseline (will be replaced every frame by gradient)
  api.resetColorsTo(BASE);

  waves.length=0;
  timeToNext = nextInterval();
}

function spawnWave(tNow){
  if(waves.length >= MAX_ACTIVE) return;
  const bandDM = BAND_MIN_DM + Math.random()*(BAND_MAX_DM - BAND_MIN_DM);
  const bandWU = bandDM * DM_TO_WU;
  waves.push({
    born:tNow,
    color:pickColor(), // RGBA; per-frame alpha via envelope
    bandWU,
    phase:{ x:Math.random()*Math.PI*2, y:Math.random()*Math.PI*2, z:Math.random()*Math.PI*2 }
  });
}

export function update(api,t,dt){
  // RNG spawns
  timeToNext -= dt;
  while(timeToNext <= 0){
    if(waves.length < MAX_ACTIVE) spawnWave(t);
    timeToNext += nextInterval();
    if(waves.length >= MAX_ACTIVE) break;
  }

  const nS = samples.length;
  const accR = new Float32Array(nS);
  const accG = new Float32Array(nS);
  const accB = new Float32Array(nS);
  const accA = new Float32Array(nS);

  // contribute each traveling band (start→end, fade in/out)
  for(let wi=0; wi<waves.length; wi++){
    const w=waves[wi];

    const ax=2*Math.PI*(t/ROT_X_PER)+w.phase.x;
    const ay=2*Math.PI*(t/ROT_Y_PER)+w.phase.y;
    const az=2*Math.PI*(t/ROT_Z_PER)+w.phase.z;

    const vS=applyEuler(vS0,ax,ay,az);
    const vE=applyEuler(vE0,ax,ay,az);
    const pS=add(center,vS);
    const pE=add(center,vE);

    const seg=sub(pE,pS);
    const dir=norm(seg);
    const sLen=len(seg);

    const u = Math.min(1, (t - w.born) / TRAVEL_DUR); // 0→1 along path
    const p0=add(pS,mul(dir,u*sLen));
    const n=dir;

    const a = alphaEnvelope(u); // 0→1→0 opacity
    if(a<=0) { if(u>=1) w._done=true; continue; }

    const r=w.color[0], g=w.color[1], b=w.color[2];

    for(let i=0;i<nS;i++){
      const pos=samples[i].pos;
      const d=Math.abs(dot(sub(pos,p0),n));
      if(d<=w.bandWU){
        // Porter–Duff "over" onto local accumulator over BLACK
        const remain = 1 - accA[i];
        if(remain>1e-6){
          const aPremul = a * remain;
          accR[i] += r * aPremul;
          accG[i] += g * aPremul;
          accB[i] += b * aPremul;
          accA[i] += aPremul;
        }
      }
    }

    if(u>=1) w._done = true; // done at end-of-path
  }

  // composite bands over the **animated gradient underlay**
  const out = new Array(nS);
  for(let i=0;i<nS;i++){
    const base = baseColorAt(samples[i].pos, t); // smooth, saturated, no pops
    const inv = 1 - accA[i];
    const r = accR[i] + base[0]*inv;
    const g = accG[i] + base[1]*inv;
    const b = accB[i] + base[2]*inv;
    out[i] = { id: samples[i].id, color: [r,g,b,1] };
  }

  // purge finished waves
  for(let i=waves.length-1;i>=0;i--){
    if(waves[i]._done) waves.splice(i,1);
  }

  if(out.length) api.setColors(out);
}
