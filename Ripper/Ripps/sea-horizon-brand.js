// File: Ripps/equator-waves.js
// 10s seamless loop — equatorial wave band with sampled palettes:
// - Skybox uses image_1 palette mapped bottom-of-dome → top-of-dome (light blue at top).
// - Wave uses image_2 palette mapped top-of-wave (surface) → bottom-of-dome (black).

export const meta = {
  id: 'equator-waves',
  name: 'Equator Waves — 10s seamless (image-mapped palettes)',
  type: 'algorithmic',
  fps: 60,
  duration: 10
};

const ctx = {
  ready: false,
  ids: [],
  center: { x: 0, y: 0, z: 0 },
  R: 1,
  band: 0.08,        // feather width (~8% of R)
  A: 0.2145,         // amplitude
  wlBase: -0.10,     // baseline offset as fraction of R (10% below equator)
  skyYMin: 0,
  skyYMax: 0
};

/* ---------- Palettes sampled from the provided strips ----------
   NOTE: u ∈ [0,1] increases upward along the strip image.

   SKY (image_1) — bottom (warm orange) → mid (cream) → light blue → sky blue.
   The stops below are proportional approximations of the provided swatch.
*/
const SKY_STOPS = [
  { u: 0.00, c: [1.00, 0.55, 0.10] }, // deep warm orange (bottom of dome)
  { u: 0.55, c: [1.00, 0.75, 0.20] }, // golden
  { u: 0.75, c: [0.96, 0.93, 0.84] }, // light cream band
  { u: 0.85, c: [0.78, 0.90, 0.98] }, // very light blue
  { u: 1.00, c: [0.27, 0.65, 1.00] }  // sky blue (top of dome)
];

/* WAVE (image_2) — top (brighter blue crest) → near-black at the bottom. */
const WAVE_STOPS = [
  
  { u: 0.15, c: [0.0275, 0.0588, 0.2745] }, // mid
  { u: 1.00, c: [0.00, 0.00, 0.00] }  // bottom (near black)
];

/* ------------------------- Lifecycle ------------------------- */
export function init(api){
  ctx.ids = Array.from(api._rgbaById.keys());

  // center & robust radius (median)
  let sx=0, sy=0, sz=0;
  for (const id of ctx.ids){ const p=api.posOf(id); sx+=p.x; sy+=p.y; sz+=p.z; }
  const inv = ctx.ids.length? 1/ctx.ids.length : 1;
  ctx.center = { x:sx*inv, y:sy*inv, z:sz*inv };

  const rs=[];
  for (const id of ctx.ids){
    const p=api.posOf(id);
    rs.push(Math.hypot(p.x-ctx.center.x, p.y-ctx.center.y, p.z-ctx.center.z));
  }
  rs.sort((a,b)=>a-b);
  const m = rs.length? (rs.length&1? rs[(rs.length-1)/2] : 0.5*(rs[rs.length/2-1]+rs[rs.length/2])) : 1;
  ctx.R = m || 1;

  // scales
  ctx.A      = 0.2145 * ctx.R;
  ctx.band   = 0.08   * ctx.R;
  ctx.wlBase = -0.10  * ctx.R;

  // Skybox range: EXACTLY bottom → top of dome for linear mapping
  ctx.skyYMin = -ctx.R;
  ctx.skyYMax = +ctx.R;

  ctx.ready = true;
}

export function update(api, t, dt){
  if (!ctx.ready) init(api);

  const T = 10.0, TWO_PI = Math.PI*2;
  const phase = TWO_PI * (t % T) / T;

  const entries = [];

  for (const id of ctx.ids){
    const p0 = api.posOf(id);
    const x = p0.x - ctx.center.x;
    const y = p0.y - ctx.center.y;
    const z = p0.z - ctx.center.z;

    const theta = Math.atan2(z, x);
    const θ = theta < 0 ? theta + TWO_PI : theta;

    const ySurf = waterlineY(θ, phase);

    // signed distance to surface (positive = above)
    const d = y - ySurf;

    // 0 underwater → 1 above (soft feather around surface)
    const f = smoothstep(-ctx.band, ctx.band, d);

    // ---- SKYBOX from image_1: linearly map bottom→top of *dome* ----
    const skyU = clamp((y - ctx.skyYMin) / (ctx.skyYMax - ctx.skyYMin), 0, 1);
    const skyCol = sampleStrip(skyU, SKY_STOPS);

    // ---- WAVE from image_2: top-of-wave (surface) → bottom-of-dome ----
    // u=0 at the surface; u=1 at dome bottom (−R)
    const waveDen = Math.max(1e-6, (ySurf - (-ctx.R)));   // avoid div by zero
    const waveU = clamp((ySurf - y) / waveDen, 0, 1);
    const waveCol = sampleStrip(waveU, WAVE_STOPS);

    // Final blend across the waterline band (feather f)
    const r = mix(waveCol[0], skyCol[0], f);
    const g = mix(waveCol[1], skyCol[1], f);
    const b = mix(waveCol[2], skyCol[2], f);

    entries.push({ id, color: [r,g,b,1] });
  }

  api.setColors(entries);
}

/* -------------------- Wave surface (seamless) -------------------- */
function waterlineY(theta, phase){
  const k1=1, k2=2, k3=3;  // spatial (integers → wrap cleanly)
  const s1=3, s2=6, s3=9;  // temporal (integers → 10s loop)

  let w =  Math.sin(k1*theta - s1*phase)
        + 0.55*Math.sin(k2*theta + 1*phase + 1.2)
        + 0.30*Math.sin(k3*theta - 1*phase - 0.6);

  const n =
      0.35 * Math.sin(2*theta + 5*phase + 1.0) +
      0.25 * Math.sin(5*theta + 7*phase - 2.0) +
      0.15 * Math.sin(3*theta + 4*phase + 0.5);

  w += 0.8 * n;

  const shaped = w + 0.6*(w*w*w)*0.25;
  const s = shaped * (1.0/1.85);

  return ctx.wlBase + ctx.A * s;
}

/* ------------------------ Palette sampling ------------------------ */
// Linear sampler over an ordered list of {u, c:[r,g,b]} stops (u ∈ [0,1]).
function sampleStrip(u, stops){
  if (u <= stops[0].u) return stops[0].c.slice();
  const L = stops.length;
  if (u >= stops[L-1].u) return stops[L-1].c.slice();
  // find segment
  for (let i=0; i<L-1; i++){
    const a = stops[i], b = stops[i+1];
    if (u >= a.u && u <= b.u){
      const t = (u - a.u) / Math.max(1e-6, (b.u - a.u));
      return [ mix(a.c[0], b.c[0], t),
               mix(a.c[1], b.c[1], t),
               mix(a.c[2], b.c[2], t) ];
    }
  }
  return stops[L-1].c.slice();
}

/* --------------------------- Utils --------------------------- */
function clamp(x,a,b){ return Math.max(a, Math.min(b, x)); }
function mix(a,b,t){ return a*(1-t) + b*t; }
function smoothstep(a,b,x){ const t=clamp((x-a)/(b-a),0,1); return t*t*(3-2*t); }
