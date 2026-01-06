// ripp—tdl-greatcircle-moire-hello (WHITE CANVAS + BLACK BANDS).js
// Preview contract: init(api), update(api, t, dt)
//
// Great-circle “Chladni-ish” bands + moiré:
// - 2 oriented stripe families on the sphere.
// - Each family is bands around a great-circle system defined by an axis.
// - Bands are animated by phase drift over time.
// - Combine the families to get moiré-like interference lattices.
// - STRICTLY t-based animation (no _simT).

export const meta = {
  name: "Great-circle Moiré: Hello World (white dome, black bands)",
  fps: 60,
  duration: 60
};

// ============================================================================
// Controls (hello-world knobs)
// ============================================================================

// Global animation speed (phase drift)
const SPEED = 12.;

// Family A: “equator-ish” bands (aligned with global Y)
const A_BANDS     = 6.0;   // number of bands from pole to pole (roughly)
const A_AXIS      = norm3([0.0, 1.0, 0.0]); // up/down axis
const A_PHASE_RATE = 0.20; // relative phase speed

// Family B: tilted bands (creates moiré)
const B_BANDS     = 7.0;   // slightly different count for interference
const B_AXIS      = norm3([0., -1., 0.0]); // arbitrary tilted axis
const B_PHASE_RATE = .16; // relative phase speed

// Family weights (how much each contributes)
const A_WEIGHT = 2.;
const B_WEIGHT = 1.40;

// Nodal band thickness & feather (in field-value units)
const NODE_THICKNESS = .55;  // smaller = thinner lines
const NODE_FEATHER   = .20;  // soft edge around lines

// Combine mode:
// 0 = ADD (A + B, clamped) -> brighter / denser
// 1 = MULTIPLY (A * B)     -> only where both exist (moiré lattice)
// 2 = MAX (max(A,B))       -> union of bands
// 3 = XOR-ish              -> bands where they disagree
const COMBINE_MODE = 1;

// Contrast
const INK_STRENGTH = 1.;   // 0..1
const INVERT       = false; // false = black bands on white

// Optional: bias toward global equator (0 = off)
const EQUATOR_BIAS = 0.0;   // try 0.25 later if you want more “plate” vibe

// ============================================================================
// Helpers for your schema
// ============================================================================
function allTDLIds(api){
  const T = Array.isArray(api?.ids?.T) ? api.ids.T : [];
  const D = Array.isArray(api?.ids?.D) ? api.ids.D : [];
  const L = Array.isArray(api?.ids?.L) ? api.ids.L : [];
  return [...new Set([...T, ...D, ...L])];
}

// ============================================================================
// State
// ============================================================================
let IDS = [];

let center = { x:0, y:0, z:0 };
let domeR  = 250;

let posX = new Float32Array(0);
let posY = new Float32Array(0);
let posZ = new Float32Array(0);

// Stable, non-alloc render objects
let changes = [];

// ============================================================================
// Lifecycle
// ============================================================================
export function init(api){
  IDS = allTDLIds(api);

  // White canvas
  api.resetColorsTo([1,1,1,1]);

  if (api?.info && Number.isFinite(api.info.radius)) domeR = api.info.radius;
  if (api?.info && api.info.center){
    center = {
      x: api.info.center.x || 0,
      y: api.info.center.y || 0,
      z: api.info.center.z || 0
    };
  }

  allocAll();
  cachePositions(api);
}

function allocAll(){
  const N = IDS.length;

  posX = new Float32Array(N);
  posY = new Float32Array(N);
  posZ = new Float32Array(N);

  changes = new Array(N);
  for (let i = 0; i < N; i++){
    changes[i] = { id: IDS[i], color: [1,1,1,1] };
  }
}

// ============================================================================
// Frame update
// ============================================================================
export function update(api, t/*s*/, dt/*s*/){
  // detect ID changes (hot reload / model swap)
  const newIDS = allTDLIds(api);
  if (newIDS.length !== IDS.length){
    IDS = newIDS;
    allocAll();
    cachePositions(api);
  } else {
    cachePositions(api);
  }

  t = Number.isFinite(t) ? t : 0;

  const inkStr   = clamp01(INK_STRENGTH);
  const thick    = Math.max(1e-6, NODE_THICKNESS);
  const feather  = Math.max(0.0, NODE_FEATHER);

  const N = IDS.length;
  const invR = 1 / Math.max(1e-6, domeR);

  // Time → phases for each family
  const phA = TAU * SPEED * A_PHASE_RATE * t;
  const phB = TAU * SPEED * B_PHASE_RATE * t;

  // For optional equator bias (relative to global Y)
  const EQUATOR_AXIS = [0, 1, 0];

  for (let i = 0; i < N; i++){
    const c = changes[i].color;

    const x = posX[i];
    if (!Number.isFinite(x)){
      c[0]=1; c[1]=1; c[2]=1; c[3]=1;
      continue;
    }

    // Normalize centroid to dome-space
    const nx = (x - center.x) * invR;
    const ny = (posY[i] - center.y) * invR;
    const nz = (posZ[i] - center.z) * invR;

    const nLen2 = nx*nx + ny*ny + nz*nz;
    if (!(nLen2 > 0)){
      c[0]=1; c[1]=1; c[2]=1; c[3]=1;
      continue;
    }
    const invLen = 1 / Math.sqrt(nLen2);
    const vx = nx * invLen;
    const vy = ny * invLen;
    const vz = nz * invLen;

    // --- Family A: bands around A_AXIS --------------------------------------
    const dA = dot3(vx, vy, vz, A_AXIS[0], A_AXIS[1], A_AXIS[2]);
    // "Latitude" relative to axis A: ranges [-1..1]; we use asin for smoother spacing
    const latA = Math.asin(clamp1(dA)); // [-pi/2..pi/2]
    const fA = Math.sin(A_BANDS * latA + phA);
    const bandValA = bandMask(fA, thick, feather) * A_WEIGHT;

    // --- Family B: bands around B_AXIS --------------------------------------
    const dB = dot3(vx, vy, vz, B_AXIS[0], B_AXIS[1], B_AXIS[2]);
    const latB = Math.asin(clamp1(dB));
    const fB = Math.sin(B_BANDS * latB + phB);
    const bandValB = bandMask(fB, thick, feather) * B_WEIGHT;

    // Combine families
    let line;
    const a = clamp01(bandValA);
    const b = clamp01(bandValB);

    if (COMBINE_MODE === 0){
      // ADD
      line = clamp01(a + b);
    } else if (COMBINE_MODE === 1){
      // MULTIPLY (moiré lattice)
      line = a * b;
    } else if (COMBINE_MODE === 2){
      // MAX (union)
      line = (a > b) ? a : b;
    } else {
      // XOR-ish: strong where they disagree
      const sum = clamp01(a + b);
      const both = a * b;
      line = clamp01(sum - 2.0 * both);
    }

    // Optional equator emphasis (global Y-axis)
    if (EQUATOR_BIAS > 0){
      const dEq = dot3(vx, vy, vz, EQUATOR_AXIS[0], EQUATOR_AXIS[1], EQUATOR_AXIS[2]);
      const eq = 1.0 - Math.abs(dEq); // 1 at equator, 0 at poles
      const bias = lerp(1.0, eq, clamp01(EQUATOR_BIAS));
      line *= bias;
    }

    const ink = clamp01(line * inkStr);
    const g   = INVERT ? ink : (1 - ink);

    c[0]=g; c[1]=g; c[2]=g; c[3]=1;
  }

  api.setColors(changes);
}

// ============================================================================
// Cache positions
// ============================================================================
function cachePositions(api){
  for (let i = 0; i < IDS.length; i++){
    const p = api.posOf(IDS[i]);
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)){
      posX[i] = p.x; posY[i] = p.y; posZ[i] = p.z;
    } else {
      posX[i] = NaN; posY[i] = NaN; posZ[i] = NaN;
    }
  }
}

// ============================================================================
// Band mask: maps a signed “stripe function” f to 0..1 band intensity
// We want bands where f ≈ 0 (zero crossings on great-circles).
// ============================================================================
function bandMask(f, thick, feather){
  const d = Math.abs(f); // distance from node
  return 1.0 - smoothstep(thick, thick + feather, d);
}

// ============================================================================
// Utils
// ============================================================================
const TAU = Math.PI * 2;

function lerp(a, b, t){ return a + (b - a) * t; }

function clamp01(x){
  return x < 0 ? 0 : (x > 1 ? 1 : x);
}

function clamp1(x){
  return x < -1 ? -1 : (x > 1 ? 1 : x);
}

function norm3(v){
  const x = v[0], y = v[1], z = v[2];
  const m = Math.hypot(x, y, z) || 1;
  return [x/m, y/m, z/m];
}

function dot3(ax, ay, az, bx, by, bz){
  return ax*bx + ay*by + az*bz;
}

function smoothstep(edge0, edge1, x){
  const t = clamp01((x - edge0) / Math.max(1e-6, (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
