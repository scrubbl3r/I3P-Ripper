// ripp—sea-horizon—bw.js
// Preview contract: init(api), update(api, t, dt)
// Pure black water, pure white background. Keep soft transparency at the wave crest.
// Self‑contained (does not rely on external textures). 30 fps.

export const meta = { name: 'Sea Horizon — Black/White (soft crest alpha)', fps: 30, duration: 120 };

const ctx = {
  ready: false,
  ids: [],
  center: { x: 0, y: 0, z: 0 },
  R: 1,
  band: 0.08,   // feather half‑width around waterline (as fraction of R)
  A: 0.22,      // wave amplitude (fraction of R)
  wlBase: -0.10 // baseline waterline offset (fraction of R)
};

export function init(api){
  ctx.ids = Array.from(api._rgbaById.keys());

  // center & robust radius (median)
  let sx=0, sy=0, sz=0;
  for (const id of ctx.ids){ const p=api.posOf(id); sx+=p.x; sy+=p.y; sz+=p.z; }
  const inv = ctx.ids.length ? 1/ctx.ids.length : 1;
  ctx.center = { x: sx*inv, y: sy*inv, z: sz*inv };

  const rs=[];
  for (const id of ctx.ids){
    const p=api.posOf(id);
    rs.push(Math.hypot(p.x-ctx.center.x, p.y-ctx.center.y, p.z-ctx.center.z));
  }
  rs.sort((a,b)=>a-b);
  const m = rs.length ? (rs.length&1? rs[(rs.length-1)/2] : 0.5*(rs[rs.length/2-1]+rs[rs.length/2])) : 1;
  ctx.R = m || 1;

  // scale parameters to world units
  ctx.A      = 0.22  * ctx.R;
  ctx.band   = 0.08  * ctx.R;
  ctx.wlBase = -0.10 * ctx.R;

  ctx.ready = true;
}

// ---- Lift animation (water level sweeps from below bottom to above top every 2000ms) ----
const LIFT_MS   = 10000;      // ms for one full rise
const LIFT_PAD_BOTTOM = 0.10; // start just a little below the bottom (~2%)
const LIFT_PAD_TOP    = 0.10; // still go a bit past the top (~10%)
function liftY(t){
  const WAIT_MS = 2000;
  const CYCLE_MS = LIFT_MS*2 + WAIT_MS*2; // up 10s, hold 2s, down 10s, hold 2s
  const u = ((t * 1000) % CYCLE_MS);
  const y0 = -ctx.R * (1 + LIFT_PAD_BOTTOM); // start ~10% past bottom
  const y1 =  ctx.R * (1 + LIFT_PAD_TOP);    // end ~10% past top
  if (u < LIFT_MS){
    // rise: y0 -> y1 over LIFT_MS
    const a = u / LIFT_MS;
    return y0 + (y1 - y0) * a;
  } else if (u < LIFT_MS + WAIT_MS){
    // hold at top
    return y1;
  } else if (u < LIFT_MS + WAIT_MS + LIFT_MS){
    // fall: y1 -> y0 over LIFT_MS
    const a = (u - (LIFT_MS + WAIT_MS)) / LIFT_MS;
    return y1 + (y0 - y1) * a;
  } else {
    // hold at bottom
    return y0;
  }
}

export function update(api, t, dt){
  if (!ctx.ready) init(api);

  const T = 10.0, TWO_PI = Math.PI*2;
  const phase = TWO_PI * (t % T) / T; // seamless 10s loop
  const lift = liftY(t);

  const WHITE = [1,1,1];
  const BLACK = [0,0,0];

  const entries = [];
  for (const id of ctx.ids){
    const p0 = api.posOf(id);
    const x = p0.x - ctx.center.x;
    const y = p0.y - ctx.center.y;
    const z = p0.z - ctx.center.z;

    // azimuth around Y — we shape the waterline along the equator band
    const theta = Math.atan2(z, x);
    const θ = theta < 0 ? theta + TWO_PI : theta;

    const ySurf = waterlineY(θ, phase, lift);

    const d = y - ySurf; // signed distance to surface ( + above / − underwater )

    // Soft feather between water (black) and sky (white)
    const f = smoothstep(-ctx.band, ctx.band, d); // 0 underwater → 1 above

    // Crest transparency: maximum right at the surface, fades away with depth/height
    const near = 1 - smoothstep(0, ctx.band, Math.abs(d)); // 1 at crest, 0 away
    const alpha = mix(1.0, 0.6, near); // 0.6 at crest, 1 elsewhere

    const r = mix(BLACK[0], WHITE[0], f);
    const g = mix(BLACK[1], WHITE[1], f);
    const b = mix(BLACK[2], WHITE[2], f);

    entries.push({ id, color: [r, g, b, alpha] });
  }

  api.setColors(entries);
}

/* -------- Wave field (integer-periodic for a seamless loop) -------- */
function waterlineY(theta, phase, baseY){
  // Combine a few integer spatial/temporal harmonics so it tiles in time
  const k1=1, k2=2, k3=3;  // spatial
  const s1=3, s2=6, s3=9;  // temporal → 10s loop

  let w =  Math.sin(k1*theta - s1*phase)
        + 0.55*Math.sin(k2*theta + 1*phase + 1.2)
        + 0.30*Math.sin(k3*theta - 1*phase - 0.6);

  // a little colored noise for richness (still integer‑periodic)
  const n =  0.35 * Math.sin(2*theta + 5*phase + 1.0)
           + 0.25 * Math.sin(5*theta + 7*phase - 2.0)
           + 0.15 * Math.sin(3*theta + 4*phase + 0.5);
  w += 0.8 * n;

  // gently shape the peaks
  const shaped = w + 0.6*(w*w*w)*0.25;
  const s = shaped * (1.0/1.85);

  return baseY + ctx.A * s;
}

/* -------- Utils -------- */
function smoothstep(a,b,x){ const t=clamp((x-a)/(b-a),0,1); return t*t*(3-2*t); }
function clamp(x,a,b){ return Math.max(a, Math.min(b, x)); }
function mix(a,b,t){ return a*(1-t) + b*t; }
