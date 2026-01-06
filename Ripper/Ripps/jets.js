// ripp—tdl-layered-ink-black-guided (origin-anywhere, antipode-run, dt-stable accel, adaptive alpha)
// FIX: travel fade is measured from TRUE origin (s=0), full strength at origin, fades with distance.
// Also FIX: {x:0,y:0,z:0} maps to TOP by default via the frame fallback (as in your working version).
//
// Preview contract: init(api), update(api, t, dt)

export const meta = {
  name: 'Layered Ink (guided): Origin→Antipode + Travel-Limited Fade (monoblack, stacked ink, guided coverage)',
  fps: 60,
  duration: 30
};

// ============================================================================
// ORIGIN CONTROL (WORLD UNITS)
// ----------------------------------------------------------------------------
// This point can be anywhere (not necessarily on the surface).
// We convert it to a direction from the dome center, then SNAP to the dome
// surface so s=0 starts exactly on the dome, and s increases toward the antipode.
//
// IMPORTANT: If SPAWN_ORIGIN_WU equals the dome center (or is degenerate),
// we fall back to "top of dome" (Y-up). Therefore:
//   {x:0,y:0,z:0} acts as "top" in your dome if your center is {0,0,0}.
// ============================================================================
const SPAWN_ORIGIN_WU = { x: 150, y: 0, z: 0 };

// ============================================================================
// NEW: TRAVEL-LIMITED PAINT EFFECT
// ----------------------------------------------------------------------------
// We fade the painting strength based on how far the sphere has traveled along
// the origin→antipode path.
//
// - EFFECT_TRAVEL_PCT = 100  => full influence at origin, fades to 0 at antipode
// - EFFECT_TRAVEL_PCT = 50   => full influence at origin, fades to 0 halfway
//
// EFFECT_FADE_POW shapes the fade curve:
// - 1.0 linear
// - <1  holds strong longer then drops near the end
// - >1  fades sooner / more aggressively
// ============================================================================
const EFFECT_TRAVEL_PCT = 100; // 0..100 (try 50, 75, 100)
const EFFECT_FADE_POW   = 3.5; // easing power (try 0.6, 1.0, 2.0)

// Optional perf: cull spheres once they’ve fully faded (recommended)
const CULL_AT_EFFECT_END = true;

// ---- Tunables --------------------------------------------------------------
// per-sphere diameter range (world units)
const SPHERE_DIAMETER_MIN_WU = 10.0;
const SPHERE_DIAMETER_MAX_WU = 25.0;

const EMIT_PERIOD_MS   = 12;
const START_FRAC_MIN   = 0.00;
const START_FRAC_MAX   = 0.10;

// Geometric acceleration stabilized vs dt using a reference FPS.
const FPS_REF          = meta.fps || 60;
const STEP_INIT        = 0.001;
const ACCEL            = 2.55;
const STEP_MAX         = 0.1;
const SPEED_SCALE      = 0.7;

// Layering
const INK_ALPHA_BASE   = 0.40;  // your “20% per hit”
const INK_ALPHA_MAX    = 0.75;  // catch-up cap near the end (only if behind)
const STACK_MODE       = 'over'; // 'over' (smooth) or 'linear' (fast clamp)

// “Done” threshold (98% ink)
const DONE_INK         = 0.98;
const DONE_G_MAX       = Math.round((1 - DONE_INK) * 255); // <= 5 is “done”

// Coverage guidance
const BIN_COUNT        = 36;    // heading slices around the ORIGIN axis
const RNG_SPAWN_PROB   = 0.05;
const BIAS_POW_MIN     = 1.50;
const BIAS_POW_MAX     = 1.55;
const BIN_JITTER_FRAC  = 0.65;
const EPS_WEIGHT       = 1e-3;

// Catch-up behavior
const CATCHUP_START_FRAC = 0.60;
const BEHIND_WINDOW      = 0.22;

// GC / perf controls
const MAX_LIVE_SPHERES = 600;
const S_CULL_OVER      = 1.02;

// ---- Helpers ---------------------------------------------------------------
function allTDLIds(api){
  const T = Array.isArray(api?.ids?.T) ? api.ids.T : [];
  const D = Array.isArray(api?.ids?.D) ? api.ids.D : [];
  const L = Array.isArray(api?.ids?.L) ? api.ids.L : [];
  return [...new Set([...T, ...D, ...L])];
}
function randIn(min,max){ return min + Math.random()*(max-min); }
function clamp01(x){ return x < 0 ? 0 : (x > 1 ? 1 : x); }
function smoothstep(e0, e1, x){
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
function wrapRad(a){
  const TAU = Math.PI * 2;
  a = a % TAU;
  return a < 0 ? a + TAU : a;
}
function dot3(ax,ay,az,bx,by,bz){ return ax*bx + ay*by + az*bz; }
function cross3(ax,ay,az,bx,by,bz){
  return [ay*bz - az*by, az*bx - ax*bz, ax*by - ay*bx];
}
function norm3(x,y,z){
  const m = Math.hypot(x,y,z) || 1;
  return [x/m, y/m, z/m];
}

// Stack “ink density” a∈[0..1].
function stackInk(aOld, inkAlpha){
  if (STACK_MODE === 'linear'){
    return Math.min(1, aOld + inkAlpha);
  }
  return 1 - (1 - aOld) * (1 - inkAlpha);
}

// ============================================================================
// Local sphere frame (origin-as-north-pole)
// ============================================================================
function buildOriginFrame(center, domeR){
  const dx = (SPAWN_ORIGIN_WU?.x ?? 0) - center.x;
  const dy = (SPAWN_ORIGIN_WU?.y ?? 0) - center.y;
  const dz = (SPAWN_ORIGIN_WU?.z ?? 0) - center.z;

  let Ux,Uy,Uz;
  if (Math.hypot(dx,dy,dz) < 1e-6){
    // default: top of dome (Y-up)
    Ux=0; Uy=1; Uz=0;
  } else {
    ;[Ux,Uy,Uz] = norm3(dx,dy,dz);
  }

  // Pick a reference axis not parallel to U
  let rx=0, ry=1, rz=0; // world Y
  const d = Math.abs(dot3(Ux,Uy,Uz, rx,ry,rz));
  if (d > 0.92){
    rx=0; ry=0; rz=1; // switch to world Z
  }

  // B = normalize(ref × U)
  let B = cross3(rx,ry,rz, Ux,Uy,Uz);
  let Bx=0, By=0, Bz=0;
  ;[Bx,By,Bz] = norm3(B[0], B[1], B[2]);

  // P = normalize(U × B)
  let P = cross3(Ux,Uy,Uz, Bx,By,Bz);
  let Px=0, Py=0, Pz=0;
  ;[Px,Py,Pz] = norm3(P[0], P[1], P[2]);

  // snapped origin point on dome surface
  const origin = {
    x: center.x + Ux * domeR,
    y: center.y + Uy * domeR,
    z: center.z + Uz * domeR
  };

  return { origin, U:[Ux,Uy,Uz], B:[Bx,By,Bz], P:[Px,Py,Pz] };
}

function posFromOriginToAntipode(center, domeR, frame, s, az){
  const theta = Math.PI/2 - Math.PI * s; // +pi/2..-pi/2
  const sinT = Math.sin(theta);
  const cosT = Math.cos(theta);

  const [Ux,Uy,Uz] = frame.U;
  const [Bx,By,Bz] = frame.B;
  const [Px,Py,Pz] = frame.P;

  const sinA = Math.sin(az);
  const cosA = Math.cos(az);

  const Tx = Bx*sinA + Px*cosA;
  const Ty = By*sinA + Py*cosA;
  const Tz = Bz*sinA + Pz*cosA;

  const dx = Ux*sinT + Tx*cosT;
  const dy = Uy*sinT + Ty*cosT;
  const dz = Uz*sinT + Tz*cosT;

  return {
    x: center.x + dx * domeR,
    y: center.y + dy * domeR,
    z: center.z + dz * domeR
  };
}

function azAroundOriginAxis(center, p, frame){
  const vx = p.x - center.x;
  const vy = p.y - center.y;
  const vz = p.z - center.z;
  let nx=0, ny=0, nz=0;
  ;[nx,ny,nz] = norm3(vx,vy,vz);

  const [Bx,By,Bz] = frame.B;
  const [Px,Py,Pz] = frame.P;

  const b = dot3(nx,ny,nz, Bx,By,Bz);
  const q = dot3(nx,ny,nz, Px,Py,Pz);

  return wrapRad(Math.atan2(b, q));
}

// ============================================================================
// Travel fade
// ----------------------------------------------------------------------------
// s is global along the origin→antipode great-circle. Spheres start at s0.
// We want FULL strength at the actual origin (s=0), and fade with distance from
// the origin, not distance from s0.
//
// So fade is based on sClamped itself (0..1), with cutoff at sCut.
// ============================================================================
function travelFadeFromS(sClamped){
  const travelFrac = clamp01(EFFECT_TRAVEL_PCT / 100);
  if (travelFrac <= 1e-6) return 0;

  const u = clamp01(sClamped / travelFrac); // 0 at origin, 1 at cutoff
  const pow = Math.max(1e-6, EFFECT_FADE_POW);
  return Math.pow(Math.max(0, 1 - u), pow); // 1 at origin → 0 at cutoff
}

// ---- State -----------------------------------------------------------------
let IDS = [];
let IDS_SET = new Set();
let center = {x:0,y:0,z:0};
let domeR = 250;
let emitAccMs = 0;

let posX = new Float32Array(0);
let posY = new Float32Array(0);
let posZ = new Float32Array(0);

let ORIGIN_FRAME = null;

// bins
let idBinIdx = new Uint16Array(0);
let binCount = new Uint32Array(BIN_COUNT);
let binWhiteSum = new Float32Array(BIN_COUNT);

const spheres = [];
let needFirstSpawnAtNow = true;

const paintedG = new Map();
let doneCount = 0;

// ---- Lifecycle -------------------------------------------------------------
export function init(api){
  IDS = allTDLIds(api);
  IDS_SET = new Set(IDS);

  api.resetColorsTo([1,1,1,1]);

  if (api.info && Number.isFinite(api.info.radius)) domeR = api.info.radius;
  if (api.info && api.info.center) {
    center = { x: api.info.center.x || 0, y: api.info.center.y || 0, z: api.info.center.z || 0 };
  }

  ORIGIN_FRAME = buildOriginFrame(center, domeR);

  posX = new Float32Array(IDS.length);
  posY = new Float32Array(IDS.length);
  posZ = new Float32Array(IDS.length);

  spheres.length = 0;
  emitAccMs = 0;
  needFirstSpawnAtNow = true;

  paintedG.clear();
  doneCount = 0;

  rebuildBins(api);
}

export function update(api, t/*s*/, dt/*s*/){
  const dtMs = Math.max(0, dt * 1000);

  const newIDS = allTDLIds(api);
  if (newIDS.length !== IDS.length){
    IDS = newIDS;
    IDS_SET = new Set(IDS);

    posX = new Float32Array(IDS.length);
    posY = new Float32Array(IDS.length);
    posZ = new Float32Array(IDS.length);

    for (const key of paintedG.keys()){
      if (!IDS_SET.has(key)) paintedG.delete(key);
    }

    if (api.info && Number.isFinite(api.info.radius)) domeR = api.info.radius;
    if (api.info && api.info.center) {
      center = { x: api.info.center.x || 0, y: api.info.center.y || 0, z: api.info.center.z || 0 };
    }
    ORIGIN_FRAME = buildOriginFrame(center, domeR);

    rebuildBins(api);
  }

  for (let i = 0; i < IDS.length; i++){
    const p = api.posOf(IDS[i]);
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)){
      posX[i] = p.x; posY[i] = p.y; posZ[i] = p.z;
    } else {
      posX[i] = NaN; posY[i] = NaN; posZ[i] = NaN;
    }
  }

  if (needFirstSpawnAtNow){
    spawnOne(api, t);
    needFirstSpawnAtNow = false;
  }

  emitAccMs += dtMs;
  while (emitAccMs >= EMIT_PERIOD_MS){
    emitAccMs -= EMIT_PERIOD_MS;
    spawnOne(api, t);
  }

  // advance spheres (dt-stable)
  if (spheres.length){
    const frames = dt * FPS_REF;
    const accelMul = frames > 0 ? Math.pow(ACCEL, frames) : 1;

    // optional earlier cull at fade end (sCut)
    const travelFrac = clamp01(EFFECT_TRAVEL_PCT / 100);
    const sCut = travelFrac > 1e-6 ? (travelFrac * S_CULL_OVER) : 0;

    for (let i = spheres.length - 1; i >= 0; i--){
      const d = spheres[i];

      if (!Number.isFinite(d.s) || !Number.isFinite(d.step) || !Number.isFinite(d.radiusWU)){
        spheres.splice(i, 1);
        continue;
      }

      d.step = Math.min(STEP_MAX, d.step * accelMul);
      if (d.step <= 0){
        spheres.splice(i, 1);
        continue;
      }

      // Always increase s away from origin toward antipode
      d.s += (d.step * frames * SPEED_SCALE);

      if (CULL_AT_EFFECT_END){
        if (d.s >= sCut) spheres.splice(i, 1);
      } else {
        if (d.s >= 1 || d.s > S_CULL_OVER) spheres.splice(i, 1);
      }
    }
  }

  paint(api, t);
}

// ---- Coverage guidance -----------------------------------------------------
function rebuildBins(api){
  idBinIdx = new Uint16Array(IDS.length);
  binCount = new Uint32Array(BIN_COUNT);
  binWhiteSum = new Float32Array(BIN_COUNT);

  doneCount = 0;

  const bw = (Math.PI * 2) / BIN_COUNT;

  for (let i = 0; i < IDS.length; i++){
    const id = IDS[i];
    const p = api.posOf(id);

    const az = (p && Number.isFinite(p.x) && ORIGIN_FRAME)
      ? azAroundOriginAxis(center, p, ORIGIN_FRAME)
      : 0;

    const b = Math.min(BIN_COUNT - 1, Math.max(0, Math.floor(az / bw)));
    idBinIdx[i] = b;
    binCount[b]++;

    const g = paintedG.get(id) ?? 255;
    binWhiteSum[b] += (g / 255);
    if (g <= DONE_G_MAX) doneCount++;
  }
}

function chooseGuidedAz(t){
  const TAU = Math.PI * 2;
  const bw = TAU / BIN_COUNT;

  if (Math.random() < RNG_SPAWN_PROB){
    return Math.random() * TAU;
  }

  const dur = Math.max(0.001, meta.duration || 1);
  const progress = clamp01(t / dur);

  const biasPow = BIAS_POW_MIN + (BIAS_POW_MAX - BIAS_POW_MIN) * progress;

  let totalW = 0;
  const wArr = new Float32Array(BIN_COUNT);

  for (let b = 0; b < BIN_COUNT; b++){
    const w = Math.pow(binWhiteSum[b] + EPS_WEIGHT, biasPow);
    wArr[b] = w;
    totalW += w;
  }

  if (!(totalW > 0)){
    return Math.random() * TAU;
  }

  let r = Math.random() * totalW;
  let chosen = 0;
  for (let b = 0; b < BIN_COUNT; b++){
    r -= wArr[b];
    if (r <= 0){
      chosen = b;
      break;
    }
  }

  const binStart = chosen * bw;
  let az = binStart + (Math.random() * bw);

  const jitter = (Math.random() - 0.5) * bw * BIN_JITTER_FRAC;
  az = wrapRad(az + jitter);

  return az;
}

// ---- Spawn / Paint ---------------------------------------------------------
function spawnOne(api, t){
  if (spheres.length >= MAX_LIVE_SPHERES) return;

  // Start at/near TRUE origin: s=0 (plus optional tiny offset)
  const s0 = randIn(START_FRAC_MIN, START_FRAC_MAX);
  const az = chooseGuidedAz(t);

  const diamWU   = randIn(SPHERE_DIAMETER_MIN_WU, SPHERE_DIAMETER_MAX_WU);
  const radiusWU = diamWU * 0.5;

  spheres.push({ s: s0, step: STEP_INIT, az, radiusWU, r2: radiusWU * radiusWU });
}

function computeInkAlpha(t){
  const total = Math.max(1, IDS.length);
  const doneFrac = doneCount / total;

  const dur = Math.max(0.001, meta.duration || 1);
  const target = clamp01(t / dur);

  const lateRamp = smoothstep(CATCHUP_START_FRAC, 1.0, target);

  const behind = clamp01((target - doneFrac) / BEHIND_WINDOW);
  const boost = behind * lateRamp;

  return INK_ALPHA_BASE + (INK_ALPHA_MAX - INK_ALPHA_BASE) * boost;
}

function paint(api, t){
  const changes = [];
  const inkAlphaBase = computeInkAlpha(t);

  for (let si = 0; si < spheres.length; si++){
    const d = spheres[si];

    // clamp s for position
    const sClamped = d.s < 0 ? 0 : (d.s > 1 ? 1 : d.s);

    // fade from TRUE origin (s=0), regardless of spawn jitter
    const fade = travelFadeFromS(sClamped);
    if (fade <= 1e-6) continue;

    const inkAlpha = inkAlphaBase * fade;
    if (inkAlpha <= 1e-6) continue;

    const C = posFromOriginToAntipode(center, domeR, ORIGIN_FRAME, sClamped, d.az);

    const cx = C.x, cy = C.y, cz = C.z;
    const r2 = d.r2;

    for (let ii = 0; ii < IDS.length; ii++){
      const px = posX[ii];
      if (!Number.isFinite(px)) continue;

      const dx = px - cx;
      const dy = posY[ii] - cy;
      const dz = posZ[ii] - cz;

      if ((dx*dx + dy*dy + dz*dz) <= r2){
        const id = IDS[ii];

        const gOld = paintedG.get(id) ?? 255;
        if (gOld === 0) continue;

        const aOld = 1 - (gOld / 255);
        const aNew = stackInk(aOld, inkAlpha);
        let gNew = Math.round((1 - aNew) * 255);

        if (gNew <= 2) gNew = 0;

        if (gNew < gOld){
          paintedG.set(id, gNew);

          const b = idBinIdx[ii] | 0;
          const deltaW = (gOld - gNew) / 255;
          binWhiteSum[b] = Math.max(0, binWhiteSum[b] - deltaW);

          if (gOld > DONE_G_MAX && gNew <= DONE_G_MAX) doneCount++;

          const g = gNew / 255;
          changes.push({ id, color: [g, g, g, 1] });
        }
      }
    }
  }

  if (changes.length) api.setColors(changes);
}
