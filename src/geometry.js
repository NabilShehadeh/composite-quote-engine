// Geometry for the quote engine. Runs unchanged in the browser and in Node, so the
// features the model was trained on are computed exactly the same way at quote time.
//
// A mesh is a flat Float32Array of triangle corners: [x0,y0,z0, x1,y1,z1, x2,y2,z2, ...] in mm.

/* ───────── STL ───────── */

export function parseSTL(buffer) {
  const bytes = buffer instanceof ArrayBuffer ? buffer : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const view = new DataView(bytes);
  if (bytes.byteLength >= 84) {
    const n = view.getUint32(80, true);
    if (84 + n * 50 === bytes.byteLength) {
      const out = new Float32Array(n * 9);
      for (let i = 0; i < n; i++) {
        const o = 84 + i * 50 + 12; // skip the stored normal, we recompute it
        for (let k = 0; k < 9; k++) out[i * 9 + k] = view.getFloat32(o + k * 4, true);
      }
      return out;
    }
  }
  const text = new TextDecoder().decode(bytes);
  const nums = [];
  const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
  for (let m; (m = re.exec(text));) nums.push(+m[1], +m[2], +m[3]);
  if (!nums.length || nums.length % 9) throw new Error('This file does not look like an STL mesh.');
  return new Float32Array(nums);
}

export function scaleMesh(pos, k) {
  if (k === 1) return pos;
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i++) out[i] = pos[i] * k;
  return out;
}

/* ───────── small vector helpers ───────── */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = a => Math.hypot(a[0], a[1], a[2]);

// Evenly spread directions over the upper hemisphere (d and -d are the same pull axis).
function hemisphere(n) {
  const out = [];
  const g = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const z = 1 - i / n;               // 1 .. ~0
    const r = Math.sqrt(1 - z * z);
    out.push([Math.cos(g * i) * r, Math.sin(g * i) * r, z]);
  }
  return out;
}
const DIRS = hemisphere(240).concat([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);

/* ───────── analysis ───────── */

// Thresholds that define the features. Changing these means retraining.
export const SHARP_DEG = 40;      // edges folding more than this are sharp corners
export const SMOOTH_DEG = 20;     // faces bending less than this belong to the same surface patch
export const ZERO_DRAFT_DEG = 1;  // walls closer than this to the pull direction will stick in the mold

export function analyze(pos) {
  const nTri = pos.length / 9;
  if (!nTri) throw new Error('The mesh has no triangles.');

  // Weld corners into shared vertices so neighbouring faces can find each other.
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { if (pos[i + k] < min[k]) min[k] = pos[i + k]; if (pos[i + k] > max[k]) max[k] = pos[i + k]; }
  const diag = len(sub(max, min)) || 1;
  const tol = diag * 1e-6;
  const key = new Map();
  const verts = [];
  const tri = new Uint32Array(nTri * 3);
  for (let i = 0; i < nTri * 3; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const k = Math.round(x / tol) + ',' + Math.round(y / tol) + ',' + Math.round(z / tol);
    let id = key.get(k);
    if (id === undefined) { id = verts.length / 3; key.set(k, id); verts.push(x, y, z); }
    tri[i] = id;
  }
  const V = i => [verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]];

  // Face normals, areas, total area and enclosed volume.
  const normal = new Float32Array(nTri * 3);
  const area = new Float32Array(nTri);
  let A = 0, vol = 0;
  for (let f = 0; f < nTri; f++) {
    const a = V(tri[f * 3]), b = V(tri[f * 3 + 1]), c = V(tri[f * 3 + 2]);
    const n = cross(sub(b, a), sub(c, a));
    const l = len(n);
    area[f] = l / 2;
    A += l / 2;
    if (l > 0) { normal[f * 3] = n[0] / l; normal[f * 3 + 1] = n[1] / l; normal[f * 3 + 2] = n[2] / l; }
    vol += dot(a, cross(b, c)) / 6;
  }

  // Edge adjacency and the fold angle across each edge.
  const edges = new Map();
  for (let f = 0; f < nTri; f++) {
    for (let e = 0; e < 3; e++) {
      const u = tri[f * 3 + e], v = tri[f * 3 + (e + 1) % 3];
      const k = u < v ? u * 4294967296 + v : v * 4294967296 + u;
      const rec = edges.get(k);
      if (rec) rec.push(f); else edges.set(k, [f, u, v]);
    }
  }
  let openEdges = 0;
  const edgeList = []; // [u, v, f1, f2, foldDeg]
  for (const [, rec] of edges) {
    if (rec.length !== 4) { openEdges++; continue; }
    const [f1, u, v, f2] = rec;
    const c = normal[f1 * 3] * normal[f2 * 3] + normal[f1 * 3 + 1] * normal[f2 * 3 + 1] + normal[f1 * 3 + 2] * normal[f2 * 3 + 2];
    edgeList.push([u, v, f1, f2, Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI]);
  }
  const closed = openEdges === 0;

  // Group faces into smooth surface patches (faces meeting at less than SMOOTH_DEG).
  const parent = new Int32Array(nTri).map((_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (const [, , f1, f2, fold] of edgeList) if (fold < SMOOTH_DEG) { const a = find(f1), b = find(f2); if (a !== b) parent[a] = b; }
  const patch = new Map();
  const P = f => { const r = find(f); let p = patch.get(r); if (!p) { p = { area: 0, boundary: 0 }; patch.set(r, p); } return p; };
  for (let f = 0; f < nTri; f++) P(f).area += area[f];
  // A patch's width is 2 × area / outline length: exact for strips and rings, large for real surfaces.
  for (const [a, b, f1, f2] of edgeList) {
    if (find(f1) === find(f2)) continue;
    const L = len(sub(V(a), V(b)));
    P(f1).boundary += L; P(f2).boundary += L;
  }

  // Patches about one laminate thick are cut edges (trim faces); the rest is laminate surface.
  // Thickness and that split depend on each other, so refine twice: t = 2 × volume / laminate area.
  const surface = new Uint8Array(nTri);
  let thickness = closed && A > 0 ? (2 * Math.abs(vol)) / A : 2;
  let surfArea = A;
  for (let pass = 0; pass < 2; pass++) {
    for (const p of patch.values()) p.trim = (2 * p.area) / (p.boundary || 1) < 1.8 * thickness;
    surfArea = 0;
    for (let f = 0; f < nTri; f++) { surface[f] = patch.get(find(f)).trim ? 0 : 1; if (surface[f]) surfArea += area[f]; }
    if (surfArea < A * 0.2) { surface.fill(1); surfArea = A; } // solid blocks: treat every face as surface
    if (closed) thickness = (2 * Math.abs(vol)) / surfArea;
  }
  thickness = Math.max(0.2, Math.min(thickness, 40));

  // Skins: laminate faces joined across any shared edge (sharp or not). A one-sided tool touches
  // one whole skin, so every face of that skin must release in the same direction.
  const skinOf = new Int32Array(nTri).map((_, i) => i);
  const sfind = i => { while (skinOf[i] !== i) { skinOf[i] = skinOf[skinOf[i]]; i = skinOf[i]; } return i; };
  for (const [, , f1, f2] of edgeList) if (surface[f1] && surface[f2]) { const a = sfind(f1), b = sfind(f2); if (a !== b) skinOf[a] = b; }
  const skin = new Int32Array(nTri);
  for (let f = 0; f < nTri; f++) skin[f] = sfind(f);

  // Signed draft for pull direction d: positive releases, negative is an undercut.
  const step = Math.max(1, Math.floor(nTri / 30000)); // sample faces on very large uploads
  const skinSum = new Float64Array(nTri);
  const signedDraft = (d, out) => {
    skinSum.fill(0);
    for (let f = 0; f < nTri; f += step) if (surface[f]) skinSum[skin[f]] += area[f] * (normal[f * 3] * d[0] + normal[f * 3 + 1] * d[1] + normal[f * 3 + 2] * d[2]);
    for (let f = 0; f < nTri; f += step) {
      const c = normal[f * 3] * d[0] + normal[f * 3 + 1] * d[1] + normal[f * 3 + 2] * d[2];
      const s = surface[f] ? (skinSum[skin[f]] >= 0 ? 1 : -1) : 1;
      out(f, Math.asin(Math.max(-1, Math.min(1, s * (surface[f] ? c : Math.abs(c))))) * 180 / Math.PI, Math.abs(c));
    }
  };

  // Best pull direction: the most draft on the worst 5% of the laminate, then the biggest footprint.
  let best = null;
  for (const d of DIRS) {
    const hist = new Float64Array(180);
    let foot = 0, total = 0;
    signedDraft(d, (f, deg, c) => {
      if (!surface[f]) return;
      hist[Math.max(0, Math.min(179, Math.floor(deg + 90)))] += area[f];
      foot += area[f] * c; total += area[f];
    });
    let acc = 0, p5 = -90;
    for (let b = 0; b < 180; b++) { acc += hist[b]; if (acc >= 0.05 * total) { p5 = b - 90; break; } }
    const score = p5 * 1e6 + foot;
    if (!best || score > best.score) best = { d, score, p5, foot: (foot / 2) * step };
  }
  const d = best.d;

  // Per-face signed draft for the chosen direction (the viewer paints this).
  const draft = new Float32Array(nTri);
  let zeroDraftArea = 0;
  const saved = step; // evaluate every face for the final direction
  for (let f = 0; f < nTri; f++) {
    const c = normal[f * 3] * d[0] + normal[f * 3 + 1] * d[1] + normal[f * 3 + 2] * d[2];
    draft[f] = Math.abs(c);
  }
  skinSum.fill(0);
  for (let f = 0; f < nTri; f++) if (surface[f]) skinSum[skin[f]] += area[f] * (normal[f * 3] * d[0] + normal[f * 3 + 1] * d[1] + normal[f * 3 + 2] * d[2]);
  for (let f = 0; f < nTri; f++) {
    const c = normal[f * 3] * d[0] + normal[f * 3 + 1] * d[1] + normal[f * 3 + 2] * d[2];
    const s = surface[f] ? (skinSum[skin[f]] >= 0 ? 1 : -1) : 1;
    draft[f] = Math.asin(Math.max(-1, Math.min(1, surface[f] ? s * c : Math.abs(c)))) * 180 / Math.PI;
    if (surface[f] && draft[f] < ZERO_DRAFT_DEG) zeroDraftArea += area[f];
  }
  void saved;

  // Extents along the pull axis (depth) and across it (mold footprint).
  const ref = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = cross(d, ref); const ul = len(u); u[0] /= ul; u[1] /= ul; u[2] /= ul;
  const w = cross(d, u);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < verts.length; i += 3) {
    const q = [verts[i], verts[i + 1], verts[i + 2]];
    const s = [dot(q, d), dot(q, u), dot(q, w)];
    for (let k = 0; k < 3; k++) { if (s[k] < lo[k]) lo[k] = s[k]; if (s[k] > hi[k]) hi[k] = s[k]; }
  }
  const depth = hi[0] - lo[0];
  const spanU = hi[1] - lo[1], spanV = hi[2] - lo[2];

  // Sharp corners and curvature, counted only between laminate surfaces (not on cut edges).
  let sharpLen = 0, bendLen = 0;
  const sharp = [];
  for (const [a, b, f1, f2, fold] of edgeList) {
    if (!surface[f1] || !surface[f2]) continue;
    const L = len(sub(V(a), V(b)));
    if (fold > SHARP_DEG) { sharpLen += L; sharp.push(a, b); }
    else if (fold > 3) bendLen += L * fold / 90;
  }

  const layupArea = surfArea / 2;                       // one skin of the laminate, mm²
  const footprint = Math.max(best.foot, 1);             // projected area in the mold, mm²
  const features = {
    layup_area_m2: layupArea / 1e6,
    thickness_mm: thickness,
    plies: plyCount(thickness),
    footprint_m2: footprint / 1e6,
    mold_len_mm: Math.max(spanU, spanV),
    mold_wid_mm: Math.min(spanU, spanV),
    depth_mm: depth,
    depth_ratio: Math.min(3, depth / Math.sqrt(footprint)), // capped: closed sections have no real footprint
    sharp_edge_m: sharpLen / 1000,
    zero_draft_frac: surfArea ? zeroDraftArea / surfArea : 0,
    min_draft_deg: best.p5,
    curvature: bendLen / Math.sqrt(layupArea || 1),
    max_dim_mm: Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]),
    closed,
  };

  return {
    features,
    pull: d,
    faces: { draft, surface, area, normal },
    sharpEdges: sharp.map(i => [verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]]),
    triangles: nTri,
  };
}

export const PLY_MM = 0.25; // cured ply thickness of an intermediate-modulus carbon prepreg (assumed)
export const plyCount = t => Math.max(2, Math.min(48, Math.round(t / PLY_MM)));

/* ───────── design-for-manufacture checks ───────── */

export function dfmFlags(f) {
  const out = [];
  if (!f.closed) out.push({ id: 'open', level: 'note', title: 'Open mesh', text: 'The file has holes, so laminate thickness could not be measured. The quote assumes 2 mm.' });
  if (f.sharp_edge_m > 0.005) out.push({ id: 'sharp', level: 'warn', title: 'Sharp corners', text: `${Math.round(f.sharp_edge_m * 1000)} mm of corners have no radius. Fibre bridges over tight corners, so add an inside radius of at least ${(2 * f.thickness_mm).toFixed(1)} mm.` });
  const closedSection = f.zero_draft_frac > 0.8;
  if (closedSection) out.push({ id: 'draft', level: 'warn', title: 'Closed section', text: 'No single pull direction releases this part from a one-sided tool. It needs a mandrel, a bladder or a split mold, which the quote prices in.' });
  else if (f.zero_draft_frac > 0.04) out.push({ id: 'draft', level: 'warn', title: 'Walls without draft', text: `${Math.round(f.zero_draft_frac * 100)}% of the surface has under ${ZERO_DRAFT_DEG}° of draft or is undercut, so it will grip the mold. Add 2° to 3° of draft, or plan for a split mold.` });
  if (!closedSection && f.depth_ratio > 1) out.push({ id: 'deep', level: 'warn', title: 'Deep draw', text: 'The part is deep for its footprint, so plies are likely to wrinkle at the corners. Expect slower layup or darted plies.' });
  if (f.thickness_mm < 0.8) out.push({ id: 'thin', level: 'warn', title: 'Thin laminate', text: `About ${f.plies} plies. Thin laminates are fragile to handle and to trim.` });
  if (f.thickness_mm > 8) out.push({ id: 'thick', level: 'warn', title: 'Thick laminate', text: `${f.plies} plies. Thick sections need a longer, stepped cure to control exotherm.` });
  if (f.max_dim_mm > 1200) out.push({ id: 'size', level: 'warn', title: 'Larger than a standard cell', text: 'Over 1.2 m long. This needs a larger tool and oven, so treat the quote as a rough estimate.' });
  return out;
}
