// ripp—tdl-spiral-ink (dual-group spiral painter: A lead + B interleaved cleanup).js
// Preview contract: init(api), update(api, t, dt)

export const meta = {
  name: 'Spiral Ink: Group A (lead) + Group B (interleaved cleanup) w/ trails + caps',
  fps: 60,
  duration: 30
};

// ============================================================================
// SPIRAL CONTROLS (A is the “driver”; B follows A except offset + delay)
// ============================================================================
const SPIRAL_START = 'bottom'; // 'bottom' | 'top'
const POLE_MARGIN_FRAC = 0.0;
const ORBIT_TURNS_PER_SEC = 6;     // turns/sec
const ELEVATION_SECS = 1;          // seconds pole→pole (base; ramps can override)
const SPIRAL_START_AT = 0.0;
const HOLD_AND_PAINT_AT_END = true;

// ============================================================================
// GROUP A: TRAIL (soften stroke by stacking multiple delayed heads)
// ============================================================================
const A_ENABLE = true;
const A_MAX_SPHERES = 10;           // hard cap
const A_TRAIL_COUNT = 5;           // <= 5 (your “two spheres behind” default)
const A_TRAIL_OFFSET_MS = 70;     // tracer spacing

// ============================================================================
// GROUP B: CLEANUP CHASER (follows A with delay + geometric offset)
// ============================================================================
const B_ENABLE = true;
const B_MAX_SPHERES = 10;
const B_TRAIL_COUNT = 8;
const B_TRAIL_OFFSET_MS = 70;

// “B waits before doing the follow pass”
const B_CHASE_DELAY_MS = 700;      // <-- main knob (milliseconds)

// Offset strategy:
// - 'interleave' is the “two-start spiral” (fills the stripe between A wraps)
// - 'oppositeAz' is “same s/u, az += π” (simple opposite-side duplicate)
// - 'stripeNormal' also adds an extra tangent-plane offset (fine trim)
const B_OFFSET_MODE = 'interleave'; // 'interleave' | 'oppositeAz' | 'stripeNormal'

// Interleave offsets (used by 'interleave'):
// B gets az += 0.5 turn (π) and u += 0.5 * (u-per-turn) so it lands between A wraps.
const B_INTERLEAVE_AZ_TURNS = 0.5;   // half-turn
const B_INTERLEAVE_U_FACTOR = 1;     // (kept as-is per your settings)

// Optional extra tweaking (small)
const B_EXTRA_AZ_TURNS = 0.0;
const B_EXTRA_U = 0.0;               // in u units (0..1)

// Optional “stripe centerline” nudge in tangent plane (used by 'stripeNormal'):
const B_STRIPE_OFFSET_WU = 0.0;      // world units (try ~radius/2)
const B_STRIPE_SIDE = +1;            // +1 or -1 flips which side of the spiral

// ============================================================================
// INK / PAINTING
// ============================================================================
const SPHERE_RADIUS_WU = 8.0; // legacy base (kept)

// NEW: independent per-group radius bases (defaults preserve your current behavior)
const A_SPHERE_RADIUS_WU = SPHERE_RADIUS_WU;
const B_SPHERE_RADIUS_WU = 25;

const INK_ALPHA_BASE = 0.25;
const STACK_MODE = 'over'; // 'over' | 'linear'

const DONE_INK = 0.92;
const DONE_G_MAX = Math.round((1 - DONE_INK) * 255);

const ENDGAME_ENABLE = true;
const ENDGAME_STACK_SWITCH_DONEFRAC = 0.90;
const ENDGAME_LINEAR_GAIN = 1.6;

// ============================================================================
// MOTION QUALITY: SUB-SAMPLING (prevents gaps at high speeds)
// ============================================================================
const MAX_SEGMENT_STEPS = 8;
const SEGMENT_STEP_FRACTION_OF_RADIUS = 0.70;

// ============================================================================
// OPTIONAL TIME RAMPS (keep your system)
// ============================================================================
// NOTE:
// - RAMP_SPHERE_RADIUS_WU is now treated as Group A's radius ramp (preserves prior meaning).
// - Group B gets its own optional radius ramp: RAMP_B_SPHERE_RADIUS_WU.
const RAMP_ORBIT_TURNS_PER_SEC = null;        // { start, end, secs, startAt }
const RAMP_ELEV_FRACTION_PER_SEC = null;      // { start, end, secs, startAt } (u/sec)
const RAMP_SPHERE_RADIUS_WU = null;           // legacy (now Group A)
const RAMP_INK_ALPHA = null;                  // { start, end, secs, startAt }

// NEW:
const RAMP_B_SPHERE_RADIUS_WU = null;         // { start, end, secs, startAt }

// Aliases (for clarity)
const RAMP_A_SPHERE_RADIUS_WU = RAMP_SPHERE_RADIUS_WU;

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

// s∈[0..1] where s=0 is TOP, s=1 is BOTTOM
function posOnMeridianAz(center, domeR, s, az){
  const theta = Math.PI/2 - Math.PI * s;
  const y = center.y + domeR * Math.sin(theta);
  const rHor = domeR * Math.cos(theta);
  const x = center.x + rHor * Math.sin(az);
  const z = center.z + rHor * Math.cos(az);
  return { x, y, z, theta, rHor };
}

// tangents at (az, theta) on sphere
function tangentsAt(az, theta){
  const sinAz = Math.sin(az);
  const cosAz = Math.cos(az);
  const tAz = { x: cosAz, y: 0, z: -sinAz };

  const tx = -Math.sin(theta) * sinAz;
  const ty =  Math.cos(theta);
  const tz = -Math.sin(theta) * cosAz;
  const len = Math.hypot(tx, ty, tz) || 1;
  const tMer = { x: tx/len, y: ty/len, z: tz/len };

  return { tAz, tMer };
}

function norm3(x,y,z){
  const l = Math.hypot(x,y,z) || 1;
  return { x:x/l, y:y/l, z:z/l, l };
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

// spiral integrator state (authoritative “now”)
let spiralU = 0;     // 0..1
let orbitPhase = 0;  // radians
let startS = 0.98, endS = 0.02;
let started = false;

// per-head previous positions (for segment sub-sampling)
let prevAx = [], prevAy = [], prevAz = [];
let prevBx = [], prevBy = [], prevBz = [];

// history for delayed sampling (A drives; B samples A history)
const HIST = []; // items: { t, spiralU, orbitPhase, orbitOmega, elevSpeed, radiusA, radiusB, inkAlpha }
let HIST_MAX_SEC = 3.0; // computed in init

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

  // start/end s based on start pole
  const m = clamp01(POLE_MARGIN_FRAC);
  if (SPIRAL_START === 'top'){
    startS = m;
    endS = 1 - m;
  } else {
    startS = 1 - m;
    endS = m;
  }

  spiralU = 0;
  orbitPhase = 0;
  started = false;

  // compute history window we need (A trails + B chase + B trails)
  const aNeed = (Math.max(0, Math.min(A_TRAIL_COUNT, A_MAX_SPHERES) - 1) * A_TRAIL_OFFSET_MS) / 1000;
  const bNeed = (B_CHASE_DELAY_MS / 1000) + (Math.max(0, Math.min(B_TRAIL_COUNT, B_MAX_SPHERES) - 1) * B_TRAIL_OFFSET_MS) / 1000;
  HIST_MAX_SEC = Math.max(1.0, aNeed, bNeed) + 0.75; // extra margin

  HIST.length = 0;

  prevAx = []; prevAy = []; prevAz = [];
  prevBx = []; prevBy = []; prevBz = [];
}

export function update(api, t/*s*/, dt/*s*/){
  dt = Math.max(0, dt || 0);

  // Handle ID changes (rare but safe)
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

    for (const key of paintedG.keys()){
      if (!IDS_SET.has(key)) paintedG.delete(key);
    }
    doneCount = 0;
    for (let i = 0; i < IDS.length; i++){
      const g = paintedG.get(IDS[i]) ?? 255;
      if (g <= DONE_G_MAX) doneCount++;
    }
  }

  // Evaluate ramped parameters (once per frame, “now”)
  const orbitTurns = evalMaybeRamp(t, ORBIT_TURNS_PER_SEC, RAMP_ORBIT_TURNS_PER_SEC);
  const orbitOmega = (Number.isFinite(orbitTurns) ? orbitTurns : ORBIT_TURNS_PER_SEC) * TAU;

  const baseElevSpeed = 1 / Math.max(1e-6, ELEVATION_SECS); // u/sec
  const elevSpeed = evalMaybeRamp(t, baseElevSpeed, RAMP_ELEV_FRACTION_PER_SEC);

  // NEW: independent radii (evaluated "now" for history sampling)
  const radiusA = Math.max(1e-3, evalMaybeRamp(t, A_SPHERE_RADIUS_WU, RAMP_A_SPHERE_RADIUS_WU));
  const radiusB = Math.max(1e-3, evalMaybeRamp(t, B_SPHERE_RADIUS_WU, RAMP_B_SPHERE_RADIUS_WU));

  const inkAlpha = clamp01(evalMaybeRamp(t, INK_ALPHA_BASE, RAMP_INK_ALPHA));

  // Integrate A “authoritative now” (this is what we record to history)
  if (t >= SPIRAL_START_AT){
    orbitPhase = wrapRad(orbitPhase + orbitOmega * dt);

    if (!started){
      started = true;
      spiralU = 0;
    } else if (spiralU < 1){
      spiralU = clamp01(spiralU + (Number.isFinite(elevSpeed) ? elevSpeed : baseElevSpeed) * dt);
    }
  }

  // Record history sample (A drives)
  HIST.push({
    t,
    spiralU,
    orbitPhase,
    orbitOmega,
    elevSpeed: (Number.isFinite(elevSpeed) ? elevSpeed : baseElevSpeed),
    radiusA,
    radiusB,
    inkAlpha
  });

  // Prune history
  const cutoff = t - HIST_MAX_SEC;
  while (HIST.length && HIST[0].t < cutoff) HIST.shift();

  // If not started, nothing to paint
  if (t < SPIRAL_START_AT) return;

  // DoneFrac for endgame decisions
  const total = Math.max(1, IDS.length);
  const doneFrac = doneCount / total;

  // Build head offsets for group trails (seconds)
  const aOffsets = buildTrailOffsetsSec(A_ENABLE ? A_TRAIL_COUNT : 0, A_TRAIL_OFFSET_MS, A_MAX_SPHERES);
  const bOffsets = buildTrailOffsetsSec(B_ENABLE ? B_TRAIL_COUNT : 0, B_TRAIL_OFFSET_MS, B_MAX_SPHERES);

  // Ensure prev arrays sized
  ensurePrevSize(aOffsets.length, prevAx, prevAy, prevAz);
  ensurePrevSize(bOffsets.length, prevBx, prevBy, prevBz);

  // Collect per-frame changes without duplicates (darkest wins)
  const frameG = new Map(); // id -> gByte

  // --- Paint GROUP A (lead) ---
  if (A_ENABLE && (spiralU < 1 || HOLD_AND_PAINT_AT_END)){
    for (let i = 0; i < aOffsets.length; i++){
      const ts = t - aOffsets[i];
      if (ts < SPIRAL_START_AT) continue;

      const st = sampleStateAt(ts);
      if (!st) continue;

      const pos = stateToWorldCenter(st, /*group*/'A');
      paintHeadSegment(
        pos.cx, pos.cy, pos.cz,
        st.radiusA, st.inkAlpha,
        doneFrac,
        prevAx, prevAy, prevAz, i,
        frameG
      );
    }
  }

  // --- Paint GROUP B (cleanup) ---
  if (B_ENABLE && (spiralU < 1 || HOLD_AND_PAINT_AT_END)){
    const chaseDelaySec = Math.max(0, B_CHASE_DELAY_MS) / 1000;

    for (let i = 0; i < bOffsets.length; i++){
      const ts = t - chaseDelaySec - bOffsets[i];
      if (ts < SPIRAL_START_AT) continue;

      const st = sampleStateAt(ts);
      if (!st) continue;

      const pos = stateToWorldCenter(st, /*group*/'B');
      paintHeadSegment(
        pos.cx, pos.cy, pos.cz,
        st.radiusB, st.inkAlpha,
        doneFrac,
        prevBx, prevBy, prevBz, i,
        frameG
      );
    }
  }

  // Apply changes
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
// Trails / History sampling
// ============================================================================
function buildTrailOffsetsSec(count, dtMs, maxCap){
  const n = Math.max(0, Math.min(Number(count) | 0, Number(maxCap) | 0));
  const step = Math.max(0, Number(dtMs) || 0) / 1000;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = i * step;
  return out;
}

function ensurePrevSize(n, px, py, pz){
  while (px.length < n){ px.push(NaN); py.push(NaN); pz.push(NaN); }
  while (px.length > n){ px.pop(); py.pop(); pz.pop(); }
}

function sampleStateAt(ts){
  if (!HIST.length) return null;
  if (ts <= HIST[0].t) return HIST[0];
  const last = HIST[HIST.length - 1];
  if (ts >= last.t) return last;

  // find bracketing samples (linear scan is fine; HIST is tiny)
  for (let i = HIST.length - 2; i >= 0; i--){
    const a = HIST[i];
    const b = HIST[i + 1];
    if (a.t <= ts && ts <= b.t){
      const span = Math.max(1e-6, b.t - a.t);
      const u = (ts - a.t) / span;

      // linear interp for smooth path sampling
      const spiralU = a.spiralU + (b.spiralU - a.spiralU) * u;

      // unwrap shortest angular path for orbitPhase
      let dph = b.orbitPhase - a.orbitPhase;
      if (dph > Math.PI) dph -= TAU;
      if (dph < -Math.PI) dph += TAU;
      const orbitPhase = wrapRad(a.orbitPhase + dph * u);

      return {
        t: ts,
        spiralU,
        orbitPhase,
        orbitOmega: a.orbitOmega + (b.orbitOmega - a.orbitOmega) * u,
        elevSpeed:  a.elevSpeed  + (b.elevSpeed  - a.elevSpeed)  * u,
        radiusA:    a.radiusA    + (b.radiusA    - a.radiusA)    * u,
        radiusB:    a.radiusB    + (b.radiusB    - a.radiusB)    * u,
        inkAlpha:   a.inkAlpha   + (b.inkAlpha   - a.inkAlpha)   * u
      };
    }
  }
  return HIST[0];
}

// ============================================================================
// Convert a sampled state to a world-space center (with B offsets)
// ============================================================================
function stateToWorldCenter(st, group){
  // Base A path
  let u = clamp01(st.spiralU);
  let az = st.orbitPhase;

  if (group === 'B'){
    if (B_OFFSET_MODE === 'oppositeAz'){
      az = wrapRad(az + Math.PI + (B_EXTRA_AZ_TURNS * TAU));
      u = clamp01(u + B_EXTRA_U);
    } else {
      // 'interleave' and 'stripeNormal' both start from interleaved two-start helix
      const azOff = (B_INTERLEAVE_AZ_TURNS + B_EXTRA_AZ_TURNS) * TAU;
      az = wrapRad(az + azOff);

      // u-per-turn ≈ elevSpeed / turnsPerSec
      const turnsPerSec = Math.max(1e-6, (st.orbitOmega || 0) / TAU);
      const uPerTurn = (Number.isFinite(st.elevSpeed) ? st.elevSpeed : 0) / turnsPerSec;
      const uOff = (B_INTERLEAVE_U_FACTOR * uPerTurn) + B_EXTRA_U;
      u = clamp01(u + uOff);
    }
  }

  const s = lerp(startS, endS, u);
  const P = posOnMeridianAz(center, domeR, s, az);

  let cx = P.x, cy = P.y, cz = P.z;

  // Optional: tangent-plane “stripe centerline” nudge (only if requested)
  if (group === 'B' && B_OFFSET_MODE === 'stripeNormal' && B_STRIPE_OFFSET_WU !== 0){
    const { tAz, tMer } = tangentsAt(az, P.theta);

    // build a local direction of travel in tangent plane (uses instantaneous speeds)
    const dsdt = (endS - startS) * (Number.isFinite(st.elevSpeed) ? st.elevSpeed : 0);
    const dthetadt = -Math.PI * dsdt; // theta = π/2 - π*s
    const vMerLen = domeR * dthetadt;

    const dazdt = Number.isFinite(st.orbitOmega) ? st.orbitOmega : 0;
    const vAzLen = P.rHor * dazdt;

    const vx = tAz.x * vAzLen + tMer.x * vMerLen;
    const vy = tAz.y * vAzLen + tMer.y * vMerLen;
    const vz = tAz.z * vAzLen + tMer.z * vMerLen;
    const dir = norm3(vx, vy, vz);

    // surface normal
    const nx = cx - center.x, ny = cy - center.y, nz = cz - center.z;
    const nrm = norm3(nx, ny, nz);

    // across = n × dir (perpendicular in tangent plane)
    const across = norm3(
      (nrm.y * dir.z - nrm.z * dir.y),
      (nrm.z * dir.x - nrm.x * dir.z),
      (nrm.x * dir.y - nrm.y * dir.x)
    );

    cx += across.x * B_STRIPE_OFFSET_WU * B_STRIPE_SIDE;
    cy += across.y * B_STRIPE_OFFSET_WU * B_STRIPE_SIDE;
    cz += across.z * B_STRIPE_OFFSET_WU * B_STRIPE_SIDE;
  }

  return { cx, cy, cz };
}

// ============================================================================
// Painting (per head)
// ============================================================================
function paintHeadSegment(cx, cy, cz, radiusWU, inkAlpha, doneFrac, prevX, prevY, prevZ, idx, frameG){
  // sub-sample along motion segment (prev -> current)
  let steps = 1;
  const px = prevX[idx];
  if (Number.isFinite(px)){
    const dx = cx - prevX[idx], dy = cy - prevY[idx], dz = cz - prevZ[idx];
    const dist = Math.hypot(dx, dy, dz);
    const denom = Math.max(1e-6, radiusWU * SEGMENT_STEP_FRACTION_OF_RADIUS);
    steps = Math.max(1, Math.min(MAX_SEGMENT_STEPS, Math.ceil(dist / denom)));
  }

  for (let k = 1; k <= steps; k++){
    const u = steps === 1 ? 1 : (k / steps);
    const sx = Number.isFinite(prevX[idx]) ? (prevX[idx] + (cx - prevX[idx]) * u) : cx;
    const sy = Number.isFinite(prevY[idx]) ? (prevY[idx] + (cy - prevY[idx]) * u) : cy;
    const sz = Number.isFinite(prevZ[idx]) ? (prevZ[idx] + (cz - prevZ[idx]) * u) : cz;
    paintAt(sx, sy, sz, radiusWU, inkAlpha, doneFrac, frameG);
  }

  prevX[idx] = cx; prevY[idx] = cy; prevZ[idx] = cz;
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
