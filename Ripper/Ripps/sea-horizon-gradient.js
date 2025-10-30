// File: Ripps/equator-waves.js
// 10s seamless loop — equatorial wave band + saturated skybox.
// New: underwater grades to pure black at the dome bottom; crest gets subtle aqua tint
//      modulated by the skybox behind it (back-lit look).

export const meta = {
  id: 'skybox-ref-gradient',
  name: 'Skybox — Reference Gradient (Test)',
  type: 'algorithmic',
  fps: 30,
  duration: 10
};

const ctx = {
  ready: false,
  ids: [],
  center: { x: 0, y: 0, z: 0 },
  R: 1,
  band: 0.08,        // feather width (~8% of R)
  A: 0.2145,         // amplitude (25% less than the big version)
  wlBase: -0.10,     // baseline offset as fraction of R (10% below equator)
  skyYMin: 0,
  skyYMax: 0
};

export function init(api){
  console.log('[ripp] sea-horizon-red loaded: forcing skybox to solid red');
  ctx.ids = Array.from(api._rgbaById.keys());

  // center & robust radius (median)
  let sx=0, sy=0, sz=0;
  for (const id of ctx.ids){ const p=api.posOf(id); sx+=p.x; sy+=p.y; sz+=p.z; 
  if (typeof window !== 'undefined' && typeof window.requestRedraw === 'function') { try { window.requestRedraw(); } catch(e){} }
}

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

  // skybox bounds: bottom well below lowest trough; top near zenith
  const troughMin = ctx.wlBase - ctx.A;
  ctx.skyYMin = Math.min(troughMin - 0.20*ctx.R, -1.6*ctx.A - 0.20*ctx.R);
  ctx.skyYMax = +0.95*ctx.R;

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

    // --- UNDERWATER base: vertical grade to pure black at dome bottom ---
    let under = colorUnder(y, ySurf);

    // --- Crest tint: only near the surface on the water side + at higher peaks ---
    // near crest region (just *below* the surface)
    const nearCrest = smoothstep(-0.8*ctx.band, -0.05*ctx.band, d); // 0 far below → 1 just under surface
    // peakiness: 0 (deep trough) → 1 (high crest)
    const peak = clamp((ySurf - ctx.wlBase) / ctx.A, 0, 1);
    // strength combines proximity to surface and height of the crest
    const crestK = Math.pow(nearCrest, 1.2) * Math.pow(peak, 1.5) * 0.55;

    if (crestK > 1e-4){
      // sky color *behind* the crest (sample at the surface height)
      const backSky = skyboxColor(ySurf);
      // base aqua (transmission) — not literal color match; just a vibe
      const aquaBase = [0.35, 0.90, 0.95];
      // modulate toward the sky hue to keep it natural
      const aqua = mix3(backSky, aquaBase, 0.6);
      under = mix3(under, aqua, crestK);
    }

    // Final blend with sky (fixed background) by feather f
    const above = skyboxColor(y);
    const r = mix(under[0], above[0], f);
    const g = mix(under[1], above[1], f);
    const b = mix(under[2], above[2], f);

    entries.push({ id, color: [r,g,b,1] });
  }

  api.setColors(entries);
}

/* -------- Seamless wave (integer-periodic) -------- */
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

/* -------- Fixed, saturated skybox gradient -------- */
function skyboxColor(y){
  // Stationary skybox using the provided reference gradient:
  // orange (bottom) -> warm beige -> light grey -> soft blue (top cap)
  // y is in screen space; we normalize across the sky bounds.
  const skyMin = (typeof ctx.skyYMin === 'number') ? ctx.skyYMin : 0.0;
  const skyMax = (typeof ctx.skyYMax === 'number') ? ctx.skyYMax : 1.0;
  let t = clamp((y - skyMin) / (skyMax - skyMin), 0, 1);

  // Hold warm band longer to match the reference
  t = Math.pow(t, 0.75);

  // Palette approximated from the image
  const orange = [1.00, 0.55, 0.00]; // strong horizon orange
  const beige  = [0.98, 0.78, 0.55]; // warm sand/beige
  const grey   = [0.86, 0.90, 0.96]; // light grey/blue mist
  const blue   = [0.44, 0.60, 0.84]; // soft top blue

  // Split points (visual match to reference)
  const s1 = 0.58; // orange -> beige (thick orange base)
  const s2 = 0.80; // beige  -> grey  (mid transition)
  const s3 = 0.97; // grey   -> blue  (narrow top band)
  const s4 = 1.00;

  function mix(a,b,t){ return a + (b-a)*t; }
  function mix3(A,B,t){ return [mix(A[0],B[0],t), mix(A[1],B[1],t), mix(A[2],B[2],t)]; }

  if (t <= s1){
    return mix3(orange, beige, t / s1);
  } else if (t <= s2){
    return mix3(beige, grey, (t - s1) / (s2 - s1));
  } else if (t <= s3){
    return mix3(grey, blue, (t - s2) / (s3 - s2));
  } else {
    // slight blue cap
    return mix3(blue, blue, (t - s3) / (s4 - s3));
  }
}
/* -------- Underwater shading: grade to pure black at bottom -------- */
function colorUnder(y, ySurf){
  // Vertical factor toward bottom of dome (-R → black, 0.. up → bluer)
  const tVert = clamp((y + ctx.R) / (1.6*ctx.R), 0, 1); // stretches so bottom stays truly black
  const vert = mix3([0,0,0], [0.05, 0.15, 0.22], tVert);

  // Extra darkening as you go deeper *below the surface*
  const depthAmt = clamp((ySurf - y) / (ctx.A*0.9), 0, 1);
  return mix3(vert, [0,0,0], depthAmt * 0.5);
}

/* -------- Utils -------- */
function clamp(x,a,b){ return Math.max(a, Math.min(b, x)); }
function mix(a,b,t){ return a*(1-t) + b*t; }
function mix3(a,b,t){ return [ mix(a[0],b[0],t), mix(a[1],b[1],t), mix(a[2],b[2],t) ]; }
function smoothstep(a,b,x){ const t=clamp((x-a)/(b-a),0,1); return t*t*(3-2*t); }
function cubicEase(t, bias=0.85){ const k=clamp(bias,0.01,0.99); const u=t*t*(3-2*t); return Math.pow(u,k); }
