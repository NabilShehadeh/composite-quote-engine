// Parametric carbon-fibre parts: the families a drone or robotics customer would order.
// Each generator returns a closed, consistently oriented triangle mesh in mm.

/* ───────── 2D helpers ───────── */

const norm2 = ([x, y]) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
const area2 = pts => { let s = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };

// Round every interior corner of an open polyline with radius r (0 keeps it sharp).
function fillet(pts, r) {
  if (!(r > 0) || pts.length < 3) return pts.map(p => [...p]);
  const out = [[...pts[0]]];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const a = norm2([pts[i - 1][0] - p[0], pts[i - 1][1] - p[1]]);
    const b = norm2([pts[i + 1][0] - p[0], pts[i + 1][1] - p[1]]);
    const cos = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]));
    const inner = Math.acos(cos);                // angle between the two legs
    const turn = Math.PI - inner;                // how far the path turns
    if (turn < 1e-3) { out.push([...p]); continue; }
    const tdist = r / Math.tan(inner / 2);
    const bis = norm2([a[0] + b[0], a[1] + b[1]]);
    const cdist = r / Math.sin(inner / 2);
    const c = [p[0] + bis[0] * cdist, p[1] + bis[1] * cdist];
    const s = [p[0] + a[0] * tdist, p[1] + a[1] * tdist];
    const e = [p[0] + b[0] * tdist, p[1] + b[1] * tdist];
    let a0 = Math.atan2(s[1] - c[1], s[0] - c[0]);
    let a1 = Math.atan2(e[1] - c[1], e[0] - c[0]);
    let da = a1 - a0;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    const n = Math.max(3, Math.ceil(Math.abs(da) / (Math.PI / 2) * 8));
    for (let k = 0; k <= n; k++) { const t = a0 + da * k / n; out.push([c[0] + Math.cos(t) * r, c[1] + Math.sin(t) * r]); }
  }
  out.push([...pts[pts.length - 1]]);
  return out;
}

// Offset an open polyline sideways (left is positive) with mitred joins.
function offset(pts, dist) {
  const n = pts.length, out = [];
  const seg = i => { const d = norm2([pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]]); return [-d[1], d[0]]; };
  for (let i = 0; i < n; i++) {
    let nn;
    if (i === 0) nn = seg(0);
    else if (i === n - 1) nn = seg(n - 2);
    else {
      const a = seg(i - 1), b = seg(i);
      const m = norm2([a[0] + b[0], a[1] + b[1]]);
      const k = 1 / Math.max(0.2, m[0] * a[0] + m[1] * a[1]);
      nn = [m[0] * k, m[1] * k];
    }
    out.push([pts[i][0] + nn[0] * dist, pts[i][1] + nn[1] * dist]);
  }
  return out;
}

// Ear-clipping triangulation of a simple CCW polygon. Returns index triples.
function earclip(poly) {
  const idx = poly.map((_, i) => i), tris = [];
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const inside = (p, a, b, c) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i + idx.length - 1) % idx.length], i1 = idx[i], i2 = idx[(i + 1) % idx.length];
      const a = poly[i0], b = poly[i1], c = poly[i2];
      if (cross(a, b, c) <= 1e-12) continue;
      let ok = true;
      for (const j of idx) { if (j === i0 || j === i1 || j === i2) continue; if (inside(poly[j], a, b, c)) { ok = false; break; } }
      if (!ok) continue;
      tris.push([i0, i1, i2]); idx.splice(i, 1); clipped = true; break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}

/* ───────── mesh builder ───────── */

class Mesh {
  constructor() { this.t = []; }
  tri(a, b, c) { this.t.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); }
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }
  // Strip between two loops of equal length (closed loops by default).
  strip(L1, L2, closed = true) {
    const n = L1.length, m = closed ? n : n - 1;
    for (let i = 0; i < m; i++) { const j = (i + 1) % n; this.quad(L1[i], L1[j], L2[j], L2[i]); }
  }
  fan(loop, center) { for (let i = 0; i < loop.length; i++) this.tri(center, loop[i], loop[(i + 1) % loop.length]); }
  done() { return orient(new Float32Array(this.t)); }
}

// Make every face wind the same way (flood fill across shared edges), then point normals outward.
function orient(pos) {
  const n = pos.length / 9;
  const key = new Map(), tri = new Uint32Array(n * 3);
  let vid = 0;
  for (let i = 0; i < n * 3; i++) {
    const k = pos[i * 3].toFixed(4) + ',' + pos[i * 3 + 1].toFixed(4) + ',' + pos[i * 3 + 2].toFixed(4);
    let id = key.get(k); if (id === undefined) { id = vid++; key.set(k, id); } tri[i] = id;
  }
  const edge = new Map();
  const ek = (u, v) => (u < v ? u + '_' + v : v + '_' + u);
  for (let f = 0; f < n; f++) for (let e = 0; e < 3; e++) { const k = ek(tri[f * 3 + e], tri[f * 3 + (e + 1) % 3]); (edge.get(k) || edge.set(k, []).get(k)).push(f); }
  const flip = new Int8Array(n), seen = new Uint8Array(n);
  const dirEdges = f => { const a = tri[f * 3], b = flip[f] ? tri[f * 3 + 2] : tri[f * 3 + 1], c = flip[f] ? tri[f * 3 + 1] : tri[f * 3 + 2]; return [[a, b], [b, c], [c, a]]; };
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    seen[s] = 1; const queue = [s];
    while (queue.length) {
      const f = queue.pop();
      for (const [u, v] of dirEdges(f)) {
        for (const g of edge.get(ek(u, v))) {
          if (g === f || seen[g]) continue;
          // a consistent neighbour walks this edge the other way (v -> u)
          const same = dirEdges(g).some(([p, q]) => p === u && q === v);
          if (same) flip[g] = 1;
          seen[g] = 1; queue.push(g);
        }
      }
    }
  }
  const out = new Float32Array(pos.length);
  let vol = 0;
  for (let f = 0; f < n; f++) {
    const o = f * 9, order = flip[f] ? [0, 2, 1] : [0, 1, 2];
    for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) out[o + c * 3 + k] = pos[o + order[c] * 3 + k];
    const a = out.subarray(o, o + 3), b = out.subarray(o + 3, o + 6), c = out.subarray(o + 6, o + 9);
    vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  if (vol < 0) for (let f = 0; f < n; f++) { const o = f * 9; for (let k = 0; k < 3; k++) { const t = out[o + 3 + k]; out[o + 3 + k] = out[o + 6 + k]; out[o + 6 + k] = t; } }
  return out;
}

/* ───────── families ───────── */

// Thin profile (a centreline with bends) extruded along Z: plates, angles, channels, hats, Z sections.
function extrudeProfile(centre, t, rIn, L) {
  const mid = fillet(centre, rIn > 0 ? rIn + t / 2 : 0);
  let outline = offset(mid, t / 2).concat(offset(mid, -t / 2).reverse());
  if (area2(outline) < 0) outline.reverse();
  const m = new Mesh();
  const at = (p, z) => [p[0], p[1], z];
  for (let i = 0; i < outline.length; i++) { const a = outline[i], b = outline[(i + 1) % outline.length]; m.quad(at(a, 0), at(b, 0), at(b, L), at(a, L)); }
  for (const [i, j, k] of earclip(outline)) { m.tri(at(outline[i], L), at(outline[j], L), at(outline[k], L)); m.tri(at(outline[i], 0), at(outline[k], 0), at(outline[j], 0)); }
  return m.done();
}

function roundedRect(hw, hd, rc, z, seg = 6) {
  const pts = [];
  const corners = [[hw - rc, hd - rc, 0], [-hw + rc, hd - rc, Math.PI / 2], [-hw + rc, -hd + rc, Math.PI], [hw - rc, -hd + rc, 1.5 * Math.PI]];
  for (const [cx, cy, a0] of corners) for (let k = 0; k <= seg; k++) { const a = a0 + (Math.PI / 2) * k / seg; pts.push([cx + Math.cos(a) * rc, cy + Math.sin(a) * rc, z]); }
  return pts;
}

export const FAMILIES = {
  plate: {
    label: 'Flat panel',
    build: p => extrudeProfile([[0, 0], [p.w, 0]], p.t, 0, p.l),
  },
  angle: {
    label: 'Angle bracket',
    build: p => extrudeProfile([[0, p.a], [0, 0], [p.b, 0]], p.t, p.r, p.l),
  },
  channel: {
    label: 'U-channel',
    build: p => { const s = p.h * Math.tan(p.draft * Math.PI / 180); return extrudeProfile([[-s, p.h], [0, 0], [p.w, 0], [p.w + s, p.h]], p.t, p.r, p.l); },
  },
  hat: {
    label: 'Hat stiffener',
    build: p => { const s = p.h * Math.tan(p.wall * Math.PI / 180); return extrudeProfile([[0, 0], [p.f, 0], [p.f + s, p.h], [p.f + s + p.c, p.h], [p.f + 2 * s + p.c, 0], [2 * p.f + 2 * s + p.c, 0]], p.t, p.r, p.l); },
  },
  zsection: {
    label: 'Z-section',
    build: p => extrudeProfile([[-p.a, p.h], [0, p.h], [0, 0], [p.b, 0]], p.t, p.r, p.l),
  },
  tube: {
    label: 'Round tube',
    build: p => {
      const N = 48, m = new Mesh();
      const ring = (r, z) => Array.from({ length: N }, (_, i) => { const a = 2 * Math.PI * i / N; return [Math.cos(a) * r, Math.sin(a) * r, z]; });
      const o0 = ring(p.r, 0), oL = ring(p.r, p.l), i0 = ring(p.r - p.t, 0), iL = ring(p.r - p.t, p.l);
      m.strip(o0, oL); m.strip(iL, i0); m.strip(oL, iL); m.strip(i0, o0);
      return m.done();
    },
  },
  tray: {
    label: 'Tray',
    build: p => {
      const tanD = Math.tan(p.draft * Math.PI / 180);
      const outerProfile = fillet([[-Math.max(p.rf, 1) - 4, 0], [0, 0], [p.h * tanD, p.h]], p.rf).slice(1);
      const innerProfile = offset([[-Math.max(p.rf, 1) - 4, 0], ...outerProfile], p.t).slice(1);
      const loops = prof => prof.map(([s, z]) => roundedRect(p.w / 2 + s, p.d / 2 + s, p.rc + s, z));
      const O = loops(outerProfile), I = loops(innerProfile);
      const m = new Mesh();
      for (let k = 0; k < O.length - 1; k++) m.strip(O[k], O[k + 1]);
      for (let k = 0; k < I.length - 1; k++) m.strip(I[k + 1], I[k]);
      m.strip(O[O.length - 1], I[I.length - 1]);
      m.fan(O[0].slice().reverse(), [0, 0, O[0][0][2]]);
      m.fan(I[0], [0, 0, I[0][0][2]]);
      return m.done();
    },
  },
  dome: {
    label: 'Dome fairing',
    build: p => {
      const NT = 48, NP = 14, m = new Mesh(), th = p.theta * Math.PI / 180;
      const rings = R => Array.from({ length: NP }, (_, j) => { const ph = th * (j + 1) / NP; return Array.from({ length: NT }, (_, i) => { const a = 2 * Math.PI * i / NT; return [R * Math.sin(ph) * Math.cos(a), R * Math.sin(ph) * Math.sin(a), R * Math.cos(ph)]; }); });
      const O = rings(p.r), I = rings(p.r - p.t);
      m.fan(O[0].slice().reverse(), [0, 0, p.r]);
      m.fan(I[0], [0, 0, p.r - p.t]);
      for (let j = 0; j < NP - 1; j++) { m.strip(O[j + 1], O[j]); m.strip(I[j], I[j + 1]); }
      m.strip(O[NP - 1], I[NP - 1]);
      return m.done();
    },
  },
};

/* ───────── random parts for training ───────── */

export function sampler(rand = Math.random) {
  const U = (a, b) => a + (b - a) * rand();
  const LU = (a, b) => Math.exp(U(Math.log(a), Math.log(b)));
  const radius = (pSharp, a, b) => (rand() < pSharp ? 0 : U(a, b));
  const draft = (pZero, a, b) => (rand() < pZero ? 0 : U(a, b));
  const pick = {
    plate: () => ({ w: LU(40, 400), l: LU(60, 600), t: U(1, 6) }),
    angle: () => ({ a: LU(20, 120), b: LU(20, 150), t: U(1, 5), r: radius(0.25, 0.5, 10), l: LU(20, 300) }),
    channel: () => ({ w: LU(20, 150), h: LU(15, 80), draft: draft(0.4, 1, 8), r: radius(0.2, 1, 8), t: U(1, 4), l: LU(80, 600) }),
    hat: () => ({ f: U(10, 40), h: U(10, 50), c: U(15, 60), wall: U(5, 35), r: radius(0.15, 1, 8), t: U(0.8, 3), l: LU(100, 800) }),
    zsection: () => ({ a: U(15, 60), h: U(20, 80), b: U(15, 60), r: radius(0.25, 1, 6), t: U(1, 4), l: LU(60, 500) }),
    tube: () => { const r = LU(6, 40); return { r, t: Math.min(U(0.8, 3), r * 0.4), l: LU(80, 700) }; },
    tray: () => {
      const w = LU(60, 400), d = LU(40, 300), t = U(1, 4), rf = rand() < 0.3 ? 0 : U(2, 10);
      const lo = rf + t + 4, hi = Math.max(lo, Math.min(rf + t + 40, Math.min(w, d) / 2 - 2)); // corners must fit inside the tray
      return { w, d, h: LU(10, 120), draft: draft(0.25, 1, 8), rc: U(lo, hi), rf, t };
    },
    dome: () => ({ r: LU(40, 300), theta: U(20, 75), t: U(0.8, 4) }),
  };
  const names = Object.keys(pick);
  return () => { const family = names[Math.floor(rand() * names.length)]; const params = pick[family](); return { family, params, mesh: FAMILIES[family].build(params) }; };
}

/* ───────── sample parts shown in the app ───────── */

export const SAMPLES = [
  { id: 'arm', name: 'Drone arm', family: 'tube', params: { r: 12, t: 1.5, l: 260 } },
  { id: 'tray', name: 'Battery tray', family: 'tray', params: { w: 220, d: 140, h: 45, draft: 3, rc: 16, rf: 6, t: 2 } },
  { id: 'mount', name: 'Motor mount', family: 'angle', params: { a: 40, b: 60, t: 3, r: 0, l: 50 } },
  { id: 'hat', name: 'Hat stiffener', family: 'hat', params: { f: 20, h: 25, c: 30, wall: 15, r: 4, t: 2, l: 420 } },
  { id: 'fairing', name: 'Sensor fairing', family: 'dome', params: { r: 160, theta: 45, t: 1.6 } },
  { id: 'channel', name: 'Rail channel', family: 'channel', params: { w: 40, h: 30, draft: 0, r: 3, t: 2.5, l: 300 } },
];
export const buildSample = s => FAMILIES[s.family].build(s.params);
