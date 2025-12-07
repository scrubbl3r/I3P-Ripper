// ripp—tdl-spiral-ink (multi-sphere spiral emitter).js
// Preview contract: init(api), update(api, t, dt)

export const meta = {
  name: 'Spiral Ink: Multi-Sphere Emitter (Top/Bottom start, orbit+elevation controls, time ramps)',
  fps: 60,
  duration: 30
};

// ============================================================================
// SPIRAL CONTROLS (the main knobs)
// ============================================================================

// Where does the spiral start?
const SPIRAL_START = 'bottom'; // 'bottom' | 'top'

// How close to the pole we start/end (avoid singularity right at the pole)
const POLE_MARGIN_FRAC = 0.02; // 0.0..0.1

// Orbit speed (turns per second). 1.0 = one full revolution per second.
const ORBIT_TURNS_PER_SEC = 5;

// Elevation speed, simplest form: seconds to travel pole→pole.
const ELEVATION_SECS = 1;

// Start delay (seconds) before the spiral begins moving
const SPIRAL_START_AT = 0.0;

// Optional: keep orbiting/painting at the end pole after reaching it
const HOLD_AND_PAINT_AT_END = true;

// ============================================================================
// MULTI-SPHERE EMISSION (NEW)
// - Spheres are emitted from the SAME start band (the spiral's start pole margin).
// - By default, each emitted sphere starts at the CURRENT emitter azimuth,
//   so they "pour" out from the live spawning point around that band.
// - Max sphere count caps cost.
// ============================================================================

const EMIT_ENABLE = true;
const EMIT_PERIOD_SECS = 0.02;   // emit cadence (seconds) — smaller => more spheres
const MAX_SPHERES = 2;           // hard cap on live spheres
const INITIAL_SPHERES = 1;        // how many to spawn instantly at SPIRAL_START_AT

// If true: spawn always uses the current emitter azimuth (moving spawn point).
// If false: spawn always uses a fixed azimuth (0), i.e. identical spawn point.
const SPAWN_USES_EMITTER_AZ = true;

// ============================================================================
// “INK” / PAINTING
// ============================================================================

// Base sphere radius in world units (WU)
const SPHERE_RADIUS_WU = 10.0;

// How much “ink” each hit adds (STACK_MODE impacts behavior)
const INK_ALPHA_BASE = .70;
const STACK_MODE = 'over'; // 'over' (smooth) or 'linear' (aggressive)

// Done threshold (used by optional endgame slam)
const DONE_INK = 0.92;
const DONE_G_MAX = Math.round((1 - DONE_INK) * 255);

// OPTIONAL: endgame slam helps kill the “last gray chads”
const ENDGAME_ENABLE = true;
const ENDGAME_STACK_SWITCH_DONEFRAC = 0.90;
const ENDGAME_LINEAR_GAIN = 1.6;

// ============================================================================
// MOTION QUALITY: SUB-SAMPLING (prevents gaps at high speeds)
// ============================================================================

// Cap on how many samples we take along the sphere path per frame (PER SPHERE)
const MAX_SEGMENT_STEPS = 8;

// How aggressive to sub-sample (smaller = more samples)
const SEGMENT_STEP_FRACTION_OF_RADIUS = 0.70; // 0.4..1.0 (lower = more steps)

// ============================================================================
// OPTIONAL TIME RAMPS (keep your “start/end/secs/startAt” system)
// - If you don’t want a ramp, set the spec to null.
// - These ramps override the base values above.
// ============================================================================

const RAMP_ORBIT_TURNS_PER_SEC = null; // { start: 0.5, end: 3.0, secs: 6.0, startAt: 0.0 }
const RAMP_ELEV_FRACTION_PER_SEC = null; // { start: 0.05, end: 0.20, secs: 8.0, startAt: 0.0 }
const RAMP_SPHERE_RADIUS_WU = null; // { start: 26, end: 40, secs: 8.0, startAt: 0.0 }
const RAMP_INK_ALPHA = null; // { start: 0.40, end: 0.80, secs: 8.0, startAt: 0.0 }

// ============================================================================
// Helpers
// ============================================================================

const TAU = Math.PI * 2;

function allTDLIds(api){
  const T = Array.isArray(api?.ids?.T) ? api.ids.T : [];
  const D = Array.isArray(api?.ids?.D) ? api.ids.D : [];
  const L = Array.isArray(api?.ids?.L) ? api.ids.L : [];
  return [...new Set([...T, ...D, ...L])];
}
function clamp01(x){ return x < 0 ? 0 : (x > 1 ? 1 : x); }
function wrapRad(a){ a = a % TAU; return a < 0 ? a + TAU : a; }
function lerp(a,b,t){ return a + (b - a) * t; }

function rampValue(t, spec){
  const startAt = Number.isFinite(spec?.startAt) ? spec.startAt : 0;
  const secs = Math.max(1e-6, Number(spec?.secs ?? 0));
  const u = clamp01((t - startAt) / secs);
  const e = u * u * (3 - 2 * u); // smoothstep
  return lerp(Number(spec.start), Number(spec.end), e);
}
function evalMaybeRamp(t, base, spec){
  return spec ? rampValue(t, spec) : base;
}

// s∈[0..1] where s=0 is TOP, s=1 is BOTTOM (matches your existing convention)
function posOnMeridianAz(center, domeR, s, az){
  const theta = Math.PI/2 - Math.PI * s;
  const y = center.y + domeR * Math.sin(theta);
  const rHor = domeR * Math.cos(theta);
  const x = center.x + rHor * Math.sin(az);
  const z = center.z + rHor * Math.cos(az);
  return { x, y, z, theta };
}

// Ink stacking
function stackInk(aOld, inkAlpha){
  if (STACK_MODE === 'linear'){
    return Math.min(1, aOld + inkAlpha);
  }
  return 1 - (1 - aOld) * (1 - inkAlpha);
}
function stackInkDynamic(aOld, inkAlpha, doneFrac){
  if (ENDGAME_ENABLE && doneFrac >= ENDGAME_STACK_SWITCH_DONEFRAC){
    return Math.min(1, aOld + inkAlpha * ENDGAME_LINEAR_GAIN);
  }
  return stackInk(aOld, inkAlpha);
}

// ============================================================================
// State
// ============================================================================

let IDS = [];
let IDS_SET = new Set();

let center = {x:0,y:0,z:0};
let domeR = 250;

let posX = new Float32Array(0);
let posY = new Float32Array(0);
let posZ = new Float32Array(0);

// paint state
const paintedG = new Map(); // id -> gByte
let doneCount = 0;

// start/end s for the spiral’s elevation
let startS = 0.98, endS = 0.02;

// emitter orbit phase (used for spawn az if SPAWN_USES_EMITTER_AZ)
let emitterOrbitPhase = 0;

// emission accumulator
let emitAcc = 0;
let emissionStarted = false;

// spheres
// each sphere: { u, orbit, prevCx, prevCy, prevCz, alive }
const spheres = [];

// ============================================================================
// Lifecycle
// ============================================================================

export function init(api){
  IDS = allTDLIds(api);
  IDS_SET = new Set(IDS);

  api.resetColorsTo([1,1,1,1]);

  if (api.info && Number.isFinite(api.info.radius)) domeR = api.info.radius;
  if (api.info && api.info.center) {
    center = {
      x: api.info.center.x || 0,
      y: api.info.center.y || 0,
      z: api.info.center.z || 0
    };
  }

  // cache positions once (dome geometry is static)
  posX = new Float32Array(IDS.length);
  posY = new Float32Array(IDS.length);
  posZ = new Float32Array(IDS.length);

  for (let i = 0; i < IDS.length; i++){
    const p = api.posOf(IDS[i]);
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)){
      posX[i] = p.x; posY[i] = p.y; posZ[i] = p.z;
    } else {
      posX[i] = NaN; posY[i] = NaN; posZ[i] = NaN;
    }
  }

  paintedG.clear();
  doneCount = 0;

  // set start/end s based on start pole
  const m = clamp01(POLE_MARGIN_FRAC);
  if (SPIRAL_START === 'top'){
    startS = m;
    endS = 1 - m;
  } else {
    startS = 1 - m;
    endS = m;
  }

  emitterOrbitPhase = 0;

  spheres.length = 0;
  emitAcc = 0;
  emissionStarted = false;
}

export function update(api, t/*s*/, dt/*s*/){
  dt = Math.max(0, dt || 0);

  // Handle ID changes (rare, but keep you safe)
  const newIDS = allTDLIds(api);
  if (newIDS.length !== IDS.length){
    IDS = newIDS;
    IDS_SET = new Set(IDS);

    posX = new Float32Array(IDS.length);
    posY = new Float32Array(IDS.length);
    posZ = new Float32Array(IDS.length);

    for (let i = 0; i < IDS.length; i++){
      const p = api.posOf(IDS[i]);
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)){
        posX[i] = p.x; posY[i] = p.y; posZ[i] = p.z;
      } else {
        posX[i] = NaN; posY[i] = NaN; posZ[i] = NaN;
      }
    }

    // scrub paint map of orphan IDs + recount doneCount
    for (const key of paintedG.keys()){
      if (!IDS_SET.has(key)) paintedG.delete(key);
    }
    doneCount = 0;
    for (let i = 0; i < IDS.length; i++){
      const g = paintedG.get(IDS[i]) ?? 255;
      if (g <= DONE_G_MAX) doneCount++;
    }
  }

  // Wait until start time
  if (t < SPIRAL_START_AT){
    return;
  }

  // Evaluate ramped parameters (once per frame)
  const orbitTurns = evalMaybeRamp(t, ORBIT_TURNS_PER_SEC, RAMP_ORBIT_TURNS_PER_SEC);
  const orbitOmega = (Number.isFinite(orbitTurns) ? orbitTurns : ORBIT_TURNS_PER_SEC) * TAU;

  // Elevation as “fraction per second”
  const baseElevSpeed = 1 / Math.max(1e-6, ELEVATION_SECS);
  const elevSpeed = evalMaybeRamp(t, baseElevSpeed, RAMP_ELEV_FRACTION_PER_SEC);
  const vU = (Number.isFinite(elevSpeed) ? elevSpeed : baseElevSpeed);

  // Sphere radius + ink alpha (optionally ramped)
  const radiusWU = Math.max(1e-3, evalMaybeRamp(t, SPHERE_RADIUS_WU, RAMP_SPHERE_RADIUS_WU));
  const inkAlpha = clamp01(evalMaybeRamp(t, INK_ALPHA_BASE, RAMP_INK_ALPHA));

  // Advance emitter orbit (used for spawn az)
  emitterOrbitPhase = wrapRad(emitterOrbitPhase + orbitOmega * dt);

  // Start emission / initial burst
  if (!emissionStarted){
    emissionStarted = true;
    const burst = Math.max(0, Math.min(MAX_SPHERES, INITIAL_SPHERES | 0));
    for (let i = 0; i < burst; i++){
      spawnSphere(SPAWN_USES_EMITTER_AZ ? emitterOrbitPhase : 0);
    }
  }

  // Emit more spheres over time until MAX_SPHERES
  if (EMIT_ENABLE && spheres.length < MAX_SPHERES){
    emitAcc += dt;
    const period = Math.max(1e-6, EMIT_PERIOD_SECS);
    while (emitAcc >= period && spheres.length < MAX_SPHERES){
      emitAcc -= period;
      spawnSphere(SPAWN_USES_EMITTER_AZ ? emitterOrbitPhase : 0);
    }
  }

  // doneFrac for endgame slam decision
  const total = Math.max(1, IDS.length);
  const doneFrac = doneCount / total;

  // Collect per-frame changes without duplicates
  const frameG = new Map(); // id -> gByte (darkest wins)

  // Advance + paint each sphere
  for (let si = spheres.length - 1; si >= 0; si--){
    const sphr = spheres[si];

    // integrate orbit
    sphr.orbit = wrapRad(sphr.orbit + orbitOmega * dt);

    // integrate elevation
    if (sphr.u < 1){
      sphr.u = clamp01(sphr.u + vU * dt);
    } else if (!HOLD_AND_PAINT_AT_END){
      // drop it once it reaches the end
      spheres.splice(si, 1);
      continue;
    }

    const sFrac = lerp(startS, endS, sphr.u);
    const P = posOnMeridianAz(center, domeR, sFrac, sphr.orbit);
    const cx = P.x, cy = P.y, cz = P.z;

    // Determine sub-sampling along this sphere's motion segment (prev -> current)
    let steps = 1;
    if (Number.isFinite(sphr.prevCx)){
      const dx = cx - sphr.prevCx, dy = cy - sphr.prevCy, dz = cz - sphr.prevCz;
      const dist = Math.hypot(dx, dy, dz);
      const denom = Math.max(1e-6, radiusWU * SEGMENT_STEP_FRACTION_OF_RADIUS);
      steps = Math.max(1, Math.min(MAX_SEGMENT_STEPS, Math.ceil(dist / denom)));
    }

    // Paint along segment
    for (let k = 1; k <= steps; k++){
      const u = steps === 1 ? 1 : (k / steps);
      const sx = Number.isFinite(sphr.prevCx) ? (sphr.prevCx + (cx - sphr.prevCx) * u) : cx;
      const sy = Number.isFinite(sphr.prevCy) ? (sphr.prevCy + (cy - sphr.prevCy) * u) : cy;
      const sz = Number.isFinite(sphr.prevCz) ? (sphr.prevCz + (cz - sphr.prevCz) * u) : cz;

      paintAt(sx, sy, sz, radiusWU, inkAlpha, doneFrac, frameG);
    }

    sphr.prevCx = cx; sphr.prevCy = cy; sphr.prevCz = cz;
  }

  // Apply all changes for this frame (combined across spheres)
  if (frameG.size){
    const changes = [];
    for (const [id, gByte] of frameG.entries()){
      const g = (gByte / 255);
      changes.push({ id, color: [g, g, g, 1] });
    }
    api.setColors(changes);
  }
}

// ============================================================================
// Spawn / Painting
// ============================================================================

function spawnSphere(spawnAz){
  if (spheres.length >= MAX_SPHERES) return;

  // All spheres start at the spiral "start band" (u = 0), but with a spawn az.
  // This is the "existing spawning point" (the pole margin ring).
  spheres.push({
    u: 0,
    orbit: wrapRad(spawnAz),
    prevCx: NaN, prevCy: NaN, prevCz: NaN
  });
}

function paintAt(cx, cy, cz, radiusWU, inkAlpha, doneFrac, frameG){
  const r2 = radiusWU * radiusWU;

  for (let i = 0; i < IDS.length; i++){
    const px = posX[i];
    if (!Number.isFinite(px)) continue;

    const dx = px - cx;
    const dy = posY[i] - cy;
    const dz = posZ[i] - cz;

    if ((dx*dx + dy*dy + dz*dz) <= r2){
      const id = IDS[i];

      const gOld = paintedG.get(id) ?? 255;
      if (gOld === 0) continue;

      const aOld = 1 - (gOld / 255);
      const aNew = stackInkDynamic(aOld, inkAlpha, doneFrac);
      const gNew = Math.round((1 - aNew) * 255);

      if (gNew < gOld){
        paintedG.set(id, gNew);

        if (gOld > DONE_G_MAX && gNew <= DONE_G_MAX) doneCount++;

        const prev = frameG.get(id);
        if (prev === undefined || gNew < prev) frameG.set(id, gNew);
      }
    }
  }
}
