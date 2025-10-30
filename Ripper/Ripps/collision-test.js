// Orbit Collision — Green (single-file ripp)
// Drop this file into your Ripps/ folder as: Ripps/orbit-collide-green.js
// Then add it to Ripps/_index.js (id: "orbit-collide-green") so it shows up in the menu.

export const meta = {
  id: "orbit-collide-green",
  name: "Orbit Collision — Green",
  fps: 60,
  duration: 0.01
};

// === Embedded bench snapshot (used only to compute positions) ===
const BENCH = {"benchVersion":1,"name":"Dome Previsualizer \u2014 WU Build","manifest":{"kind":"ripper-bench","specVersion":"1.0","description":"Workbench export for vibe-to-ripp generation (self-describing)."},"rippContract":{"target":"ripp@1","moduleFormat":"esm","entryFile":"Ripps/_index.js","expects":{"paths":["line","curve","orbit","parametric"],"objects":["plane","cube","sphere","cone","cylinder"],"units":"worldUnits","upAxis":"Y","handedness":"right"},"intentsSchema":{"spawner":["spawnEveryMs","maxInstances","startDelayMs","posJitter","rotJitterDeg","scaleJitter"],"motionDefaults":["moveMode","durationMs","easing","align","upMode","scaleMode"],"lifecycle":["spawnAtStart","destroyAtEnd","dwellStartMs","dwellEndMs"],"collision":["applyTo","with","evaluator","radius","falloff","blend","color"],"fanout":["count","path","phaseMode"],"pathMutate":["path","modifiers"]},"defaults":{"moveMode":"traverse","durationMs":2000,"easing":"linear","spawnEveryMs":null,"destroyAtEnd":true,"collisionEnabled":false}},"units":{"base":"WU","worldPerDD":700,"overscanWU":null,"scales":{"WU":1},"angle":"deg","time":"ms","notes":"Stored values are WU. (Legacy DD/DM/DC removed from scales.)"},"dome":{"radius":250,"segments":[64,64],"origin":[0,0,0]},"aliases":{"ring":"orbit-*","planes":"plane-*","line A":"line-001"},"paths":[{"id":"orbit-001","type":"orbit","params":{"center":[0,0.001,0],"normal":[0,1,0],"radius":54.052433434763465,"startAngle":0,"endAngle":180}}],"objects":[{"id":"sphere-001","type":"sphere","params":{"sizeWU":[70,70,70],"radiusWU":35},"transform":{"position":[68.36,0,0],"rotation":[0,0,0],"scale":[5.180155348935225,5.180155348935225,5.180155348935225]},"material":{"baseColor":"#ffffff"}}],"attachments":[],"intents":[{"type":"motionDefaults","applyTo":"allAttached","moveMode":"traverse","durationMs":2000,"easing":"linear","align":"perp","upMode":"world","scaleMode":"relativeToPath"},{"type":"lifecycle","applyTo":"allAttached","spawnAtStart":true,"destroyAtEnd":true,"dwellStartMs":0,"dwellEndMs":0},{"type":"spawner","applyTo":"none","spawnEveryMs":null,"maxInstances":64,"startDelayMs":0,"posJitter":[0,0,0],"rotJitterDeg":[0,0,0],"scaleJitter":[0,0,0]},{"type":"collision","applyTo":"none","with":"dome","evaluator":"auto","radius":"20DM","falloff":"smoothstep","blend":"max","color":"randomPalette"}]};

function v3(x, y, z) { return { x: Number(x)||0, y: Number(y)||0, z: Number(z)||0 }; }
function add(a, b) { return v3(a.x+b.x, a.y+b.y, a.z+b.z); }
function sub(a, b) { return v3(a.x-b.x, a.y-b.y, a.z-b.z); }
function mul(a, s) { s=Number(s)||0; return v3(a.x*s, a.y*s, a.z*s); }
function len(a) { return Math.hypot(a.x, a.y, a.z); }
function dist(a, b) { return len(sub(a,b)); }
function dot(a,b) { return a.x*b.x + a.y*b.y + a.z*b.z; }
function norm(a) { const L=len(a)||1; return v3(a.x/L, a.y/L, a.z/L); }
function cross(a,b) { return v3(a.y*b.z - a.z*b.y, a.z*b.x - a.x*b.z, a.x*b.y - a.y*b.x); }

function arr3(a) { return v3(a?.[0]||0, a?.[1]||0, a?.[2]||0); }

function findObjectById(id) { return (BENCH.objects||[]).find(o=>o.id===id); }
function findPathById(id)   { return (BENCH.paths||[]).find(p=>p.id===id); }

function sphereRadiusWU(obj) {
  // Prefer explicit radiusWU from your bench exporter
  const r = obj?.params?.radiusWU;
  if (Number.isFinite(r) && r>0) return r;
  // Else derive from sizeWU (take max/2)
  const sz = obj?.params?.sizeWU;
  if (Array.isArray(sz) && sz.length>=3) return Math.max(sz[0],sz[1],sz[2]) * 0.5;
  // Fallback
  return 10;
}

function sphereWorldPosAtT(objectId, t=0) {
  const att = (BENCH.attachments||[]).find(a=>a.objectId===objectId);
  const obj = findObjectById(objectId);
  if (!att) {
    // No path: use transform.position
    const p = obj?.transform?.position; 
    return v3(p?.[0]||0, p?.[1]||0, p?.[2]||0);
  }
  const path = findPathById(att.pathId);
  const tt = Math.min(1, Math.max(0, (att?.follow?.t ?? t)));
  if (!path) {
    const p = obj?.transform?.position;
    return v3(p?.[0]||0, p?.[1]||0, p?.[2]||0);
  }

  if (path.type === "orbit") {
    const center = arr3(path.params.center);
    const normal = norm(arr3(path.params.normal));
    const R = Number(path.params.radius)||0;
    const a0 = (Number(path.params.startAngle)||0) * Math.PI/180;
    const a1 = (Number(path.params.endAngle)||0)   * Math.PI/180;
    const ang = a0 + (a1-a0)*tt;

    const worldUp = v3(0,1,0);
    const tmp = Math.abs(dot(normal, worldUp)) > 0.999 ? v3(1,0,0) : worldUp;
    const u = norm(cross(normal, tmp));
    const v = norm(cross(normal, u));

    // pos = center + u*cos + v*sin
    return add(center, add(mul(u, Math.cos(ang)*R), mul(v, Math.sin(ang)*R)));
  }

  if (path.type === "line") {
    const p0 = arr3(path.params.start);
    const p1 = arr3(path.params.end);
    return add(p0, mul(sub(p1,p0), tt));
  }

  if (path.type === "curve") {
    const p0 = arr3(path.params.start);
    const pc = arr3(path.params.control);
    const p2 = arr3(path.params.end);
    const u = 1-tt;
    // Quadratic Bezier
    return add( add(mul(p0, u*u), mul(pc, 2*u*tt)), mul(p2, tt*tt) );
  }

  const p = obj?.transform?.position;
  return v3(p?.[0]||0, p?.[1]||0, p?.[2]||0);
}

function firstSphereId() {
  const s = (BENCH.objects||[]).find(o => String(o.type).toLowerCase() === "sphere");
  return s?.id || null;
}

function panelsCollidingWithSphere(SceneAPI, center, radiusWU) {
  const out = [];
  const lists = [SceneAPI.ids.T, SceneAPI.ids.D, SceneAPI.ids.L];
  for (const arr of lists) {
    for (const id of (arr||[])) {
      const c = SceneAPI.posOf(id); // {x,y,z}
      const d = Math.hypot((c.x-center.x),(c.y-center.y),(c.z-center.z));
      if (d <= radiusWU) out.push(id);
    }
  }
  return out;
}

export function init(SceneAPI) {
  // Reset to white
  SceneAPI.resetColorsTo([1,1,1,1]);

  const sid = firstSphereId();
  if (!sid) return;

  const obj = findObjectById(sid);
  const rWU = sphereRadiusWU(obj);
  const pos = sphereWorldPosAtT(sid, 0);  // t=0 along orbit

  // Paint colliding panels GREEN
  const hits = panelsCollidingWithSphere(SceneAPI, pos, rWU);
  const green = [0,1,0,1];
  SceneAPI.setColors(hits.map(id => ({ id, color: green })));
}

export function update(SceneAPI/*, t, dt */) {
  // No animation; work done in init()
}
