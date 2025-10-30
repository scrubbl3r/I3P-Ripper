// /Ripps/cascade-1.js
export const meta = {
  id: "cascade-1",
  name: "Cascade 1 — 10s loop",
  fps: 60,
  duration: 10
};

let plane = null;
let startY = 0;
let endY = 0;
let active = false;

// helpers (linear space math)
function mix(a,b,t){ return a*(1-t)+b*t; }
function smooth(x){ return x*x*(3-2*x); }

export function init(api){
  // base: white opaque (linear working space)
  api.resetColorsTo([1,1,1,1]);

  // ------ visible overlay plane ------
  api.clearOverlay?.();
  const THREE = api.THREE;
  if (!THREE || !api.overlay || !api.info) return;

  const R = api.info.radius;
  const side = R * 2.2;
  const geom = new THREE.PlaneGeometry(side, side, 1, 1);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x00ffff,
    transparent: true,
    opacity: 0.15,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  plane = new THREE.Mesh(geom, mat);
  plane.rotation.x = -Math.PI / 2;

  const cy = api.info.center.y;
  startY = cy + 1.2 * R;
  endY   = cy - 1.2 * R;
  plane.position.set(api.info.center.x, startY, api.info.center.z);
  api.overlay.add(plane);
  active = true;
}

export function update(api, t, dt){
  if (!api.info) return;

  // Loop every 10s
  const loopT = 10.0;
  const tt = t % loopT;

  // The plane descends in the first 0.5s of the loop, then sits hidden
  const dropDur = 0.5;
  let y = startY;
  let visible = false;

  if (tt <= dropDur) {
    const p = smooth(tt / dropDur);
    y = mix(startY, endY, p);
    visible = true;
  }

  // Update overlay plane visibility/position
  if (plane && api.overlay) {
    plane.visible = !!visible;
    plane.position.y = y;
  }

  // Color effect: tint panels within a thin slab around plane's Y
  const R = api.info.radius;
  const thickness = 0.015 * R;
  const ids = api.ids.T.concat(api.ids.D, api.ids.L);

  if (visible) {
    const entries = [];
    for (const id of ids){
      const p = api.posOf(id); // centroid world pos
      if (!p) continue;
      if (Math.abs(p.y - y) <= thickness){
        const cur = api._rgbaById.get(id) || [1,1,1,1];
        // target aqua (sRGB value, but we’re doing linear “vibe math” here—close enough for a demo)
        const target = [0.1, 0.9, 0.9, 1];
        // hard mix inside slab
        const out = [ mix(cur[0], target[0], 1), mix(cur[1], target[1], 1), mix(cur[2], target[2], 1), 1 ];
        entries.push({ id, color: out });
      }
    }
    if (entries.length) api.setColors(entries);
  }
}

export function dispose(api){
  if (plane){
    plane.parent?.remove(plane);
    plane.geometry?.dispose?.();
    plane.material?.dispose?.();
    plane = null;
  }
  api.clearOverlay?.();
  active = false;
}
