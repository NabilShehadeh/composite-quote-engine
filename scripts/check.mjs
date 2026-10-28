import { analyze, dfmFlags } from '../src/geometry.js';
import { SAMPLES, buildSample, sampler } from '../src/parts.js';
import { formulaQuote } from '../src/cost.js';
const r = (x, d = 2) => +x.toFixed(d);
for (const s of SAMPLES) {
  const t0 = performance.now();
  const mesh = buildSample(s); const a = analyze(mesh); const f = a.features;
  const q = formulaQuote(f, 50);
  console.log(s.name.padEnd(15), 'tris', a.triangles, 'closed', f.closed, 't', r(f.thickness_mm), '(want', s.params.t + ')', 'plies', f.plies,
    'area', r(f.layup_area_m2, 4), 'sharp_m', r(f.sharp_edge_m, 3), 'zeroDraft', r(f.zero_draft_frac), 'minDraft', f.min_draft_deg, 'depthR', r(f.depth_ratio), 'curv', r(f.curvature),
    '| $', r(q.unitPrice), 'cycle', r(q.cycle, 1), 'lead', q.leadWeeks, '| flags', dfmFlags(f).map(x => x.id).join(','), '|', r(performance.now() - t0, 0) + 'ms');
}
const next = sampler(); let bad = 0, n = 300;
for (let i = 0; i < n; i++) { const p = next(); const f = analyze(p.mesh).features; if (!f.closed || Math.abs(f.thickness_mm - p.params.t) / p.params.t > 0.15) { bad++; if (bad < 8) console.log('MISMATCH', p.family, JSON.stringify(p.params), 't', r(f.thickness_mm), 'closed', f.closed); } }
console.log('random parts with thickness off by >15% or open:', bad, '/', n);
