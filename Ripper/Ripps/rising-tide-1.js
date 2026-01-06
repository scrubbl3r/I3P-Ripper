// ripp—rising-tide—bw.js
// Preview contract: init(api), update(api, t, dt)
// Pure black water, pure white background. Soft feather at the waterline.
// Adds 500ms holds at BOTH reversals (top + bottom).

export const meta = { name: 'Rising Tide — Black/White (soft crest alpha)', fps: 60, duration: 23 };

const ctx = {
  ready: false,
  ids: [],
  center: { x: 0, y: 0, z: 0 },
  R: 1,
  band: 0.08,   // feather half-width around waterline (fraction of R)
  A: 0.22,      // wave amplitude (fraction of R)
  wlBase: -0.10 // baseline waterline offset (fraction of R)
};

export function init(api){
  // Canon id gather (T/D/L) if available; else fall back to internal rgba map keys.
  ctx.ids = allTDLIds(api);
  if (!ctx.ids.length && api?._rgbaById?.keys) ctx.ids = Array.from(api._rgbaById.keys());

  // center
  let sx=0, sy=0, sz=0;
  for (const id of ctx.ids){ const p=api.posOf(id); sx+=p.x; sy+=p.y; sz+=p.z; }
  const inv = ctx.ids.length ? 1/ctx.ids.length : 1;
  ctx.center = { x: sx*inv, y: sy*inv, z: sz*inv };

  // robust radius (median)
  const rs=[];
  for (const id of ctx.ids){
    const p=api.posOf(id);
    rs.push(Math.hypot(p.x-ctx.center.x, p.y-ctx.center.y, p.z-ctx.center.z));
  }
  rs.sort((a,b)=>a-b);
  const m = rs.length ? (rs.length&1 ? rs[(rs.length-1)/2] : 0.5*(rs[rs.length/2-1]+rs[rs.length/2])) : 1;
  ctx.R = m || 1;

  // scale parameters to world units
  ctx.A      = 0.22  * ctx.R;
  ctx.band   = 0.08  * ctx.R;
  ctx.wlBase = -0.10 * ctx.R;

  ctx.ready = true;
}

// ---- Lift animation (water level sweeps bottom->top->bottom with reversal holds) ----
const LIFT_MS         = 10000; // ms for one rise or one fall
const LIFT_REV_WAIT_MS = 500;  // <-- NEW: 500ms delay at each reversal (top + bottom)
const LIFT_PAD_BOTTOM = 0.10;  // start a bit below bottom
const LIFT_PAD_TOP    = 0.10;  // go a bit past top

function liftY(tSec){
  const CYCLE_MS = LIFT_MS*2 + LIFT_REV_WAIT_MS*2; // up, hold, down, hold
  const u = ((tSec * 1000) % CYCLE_MS);

  const y0 = -ctx.R * (1 + LIFT_PAD_BOTTOM);
  const y1 =  ctx.R * (1 + LIFT_PAD_TOP);

  if (u < LIFT_MS){
    // rise: y0 -> y1
    const a = u / LIFT_MS;
    return y0 + (y1 - y0) * a;

  } else if (u < LIFT_MS + LIFT_REV_WAIT_MS){
    // hold at top (delay before reversing down)
    return y1;

  } else if (u < LIFT_MS + LIFT_REV_WAIT_MS + LIFT_MS){
    // fall: y1 -> y0
    const a = (u - (LIFT_MS + LIFT_REV_WAIT_MS)) / LIFT_MS;
    return y1 + (y0 - y1) * a;

  } else {
    // hold at bottom (delay before reversing up)
    return y0;
  }
}

export function update(api, t, dt){
  if (!ctx.ready) init(api);

  t = Number.isFinite(t) ? t : 0;

  const T = 10.0;
  const TWO_PI = Math.PI * 2;

  const phase = TWO_PI * (t % T) / T; // seamless 10s loop
  const lift  = liftY(t);

  const WHITE = [1,1,1];
  const BLACK = [0,0,0];

  const entries = new Array(ctx.ids.length);

  for (let i = 0; i < ctx.ids.length; i++){
    const id = ctx.ids[i];
    const p0 = api.posOf(id);

    const x = p0.x - ctx.center.x;
    const y = p0.y - ctx.center.y;
    const z = p0.z - ctx.center.z;

    // azimuth around Y
    const theta = Math.atan2(z, x);
    const th = theta < 0 ? theta + TWO_PI : theta;

    const ySurf = waterlineY(th, phase, lift);
    const d = y - ySurf; // + above / - underwater

    // Soft feather between water and sky
    const f = smoothstep(-ctx.band, ctx.band, d); // 0 water -> 1 sky

    // Crest transparency: max at surface, fades away
    const near = 1 - smoothstep(0, ctx.band, Math.abs(d)); // 1 at crest
    const alpha = mix(1.0, 0.6, near);

    const r = mix(BLACK[0], WHITE[0], f);
    const g = mix(BLACK[1], WHITE[1], f);
    const b = mix(BLACK[2], WHITE[2], f);

    entries[i] = { id, color: [r, g, b, alpha] };
  }

  api.setColors(entries);
}

/* -------- Wave field (integer-periodic for a seamless loop) -------- */
function waterlineY(theta, phase, baseY){
  // integer spatial/temporal harmonics so it tiles in time
  const k1=1, k2=2, k3=3;  // spatial
  const s1=3, s2=6, s3=9;  // temporal -> 10s loop

  let w =  Math.sin(k1*theta - s1*phase)
        + 0.55*Math.sin(k2*theta + 1*phase + 1.2)
        + 0.30*Math.sin(k3*theta - 1*phase - 0.6);

  // extra richness (still integer-periodic)
  const n =  0.35*Math.sin(2*theta + 5*phase + 1.0)
           + 0.25*Math.sin(5*theta + 7*phase - 2.0)
           + 0.15*Math.sin(3*theta + 4*phase + 0.5);
  w += 0.8 * n;

  // gently shape peaks
  const shaped = w + 0.6*(w*w*w)*0.25;
  const s = shaped * (1.0/1.85);

  return baseY + ctx.A * s;
}

/* -------- Canon id helper -------- */
function allTDLIds(api){
  const T = Array.isArray(api?.ids?.T) ? api.ids.T : [];
  const D = Array.isArray(api?.ids?.D) ? api.ids.D : [];
  const L = Array.isArray(api?.ids?.L) ? api.ids.L : [];
  return [...new Set([...T, ...D, ...L])];
}

/* -------- Utils -------- */
function smoothstep(a,b,x){ const t=clamp((x-a)/(b-a),0,1); return t*t*(3-2*t); }
function clamp(x,a,b){ return Math.max(a, Math.min(b, x)); }
function mix(a,b,t){ return a*(1-t) + b*t; }
