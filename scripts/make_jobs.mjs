// Builds the training set: 8,000 simulated past jobs.
//
// Each job is a random part from one of the eight families, ordered in a random quantity.
// The "shop floor" below decides what the job really cost. It adds the effects a hand quote
// misses, so the model has something real to learn. It is a simulation, not real factory data.
//
//   node scripts/make_jobs.mjs [count]   ->  data/jobs.csv
import { writeFileSync, mkdirSync } from 'node:fs';
import { analyze } from '../src/geometry.js';
import { sampler } from '../src/parts.js';
import { formulaQuote, RATES } from '../src/cost.js';

const N = +(process.argv[2] || 8000);

// Seeded random numbers so the dataset is reproducible.
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = mulberry32(44);
const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

// What the job actually cost, given the geometry and the order size.
function shopFloor(f, qty) {
  const q = formulaQuote(f, qty);
  const p = q.parts;
  const sharp = Math.tanh(f.sharp_edge_m * 6);                 // corners without radius slow layup and cause voids
  const closedSection = f.zero_draft_frac > 0.8;               // needs a mandrel or bladder
  const noDraft = closedSection ? 0 : Math.min(1, f.zero_draft_frac * 2);
  const deep = Math.max(0, Math.min(f.depth_ratio, 2) - 0.45);  // deep draws need darted plies

  let layupMult = 1 + 0.45 * sharp + 0.55 * Math.pow(deep, 1.3) + 0.012 * Math.min(f.curvature, 25);
  if (closedSection) layupMult *= 1.35;
  const learning = Math.min(1.15, Math.max(0.7, Math.pow(qty / 40, -0.08))); // crews get faster on long runs
  const cureMult = f.plies > 20 ? 1.8 : 1;                    // thick laminates need a stepped cure
  const handling = f.layup_area_m2 < 0.008 ? 5 : 0;           // tiny parts are slow to handle and trim
  const scrap = 0.03 + 0.18 * noDraft + 0.06 * sharp + (f.thickness_mm < 0.8 ? 0.07 : 0) + (f.plies > 24 ? 0.05 : 0);
  const toolMult = 1 + 0.4 * noDraft + (closedSection ? 0.9 : 0);

  const unit = (p.material + p.layup * layupMult * learning + p.cure * cureMult + p.trim + p.inspect + handling) / (1 - scrap);
  const complexity = sharp + noDraft + deep + (closedSection ? 0.5 : 0);
  const noise = Math.exp(gauss() * (0.05 + 0.06 * Math.min(complexity, 2)));
  const actual = (unit * (1 + RATES.margin) + (q.tooling * toolMult) / qty) * noise;
  return { formula: q.unitPrice, actual };
}

const FEATURES = ['layup_area_m2', 'thickness_mm', 'plies', 'footprint_m2', 'mold_len_mm', 'mold_wid_mm', 'depth_mm', 'depth_ratio', 'sharp_edge_m', 'zero_draft_frac', 'min_draft_deg', 'curvature', 'max_dim_mm'];
const next = sampler(rand);
const rows = [['family', ...FEATURES, 'qty', 'formula', 'actual'].join(',')];
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const part = next();
  const f = analyze(part.mesh).features;
  const qty = Math.round(Math.exp(Math.log(10) + rand() * (Math.log(2000) - Math.log(10))));
  const { formula, actual } = shopFloor(f, qty);
  rows.push([part.family, ...FEATURES.map(k => +f[k].toFixed(6)), qty, formula.toFixed(4), actual.toFixed(4)].join(','));
  if ((i + 1) % 2000 === 0) console.log(`${i + 1} jobs (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
writeFileSync(new URL('../data/jobs.csv', import.meta.url), rows.join('\n') + '\n');
console.log(`Wrote ${N} jobs to data/jobs.csv`);
