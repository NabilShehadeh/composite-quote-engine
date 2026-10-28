// Runs the trained LightGBM trees in the browser. No server, no library: each tree is a set of
// parallel arrays (feature, threshold, left, right, value) exported by train/train.py.
import { formulaQuote } from './cost.js';

function evalTrees(trees, x) {
  let sum = 0;
  for (const [feat, thr, left, right, val] of trees) {
    let i = 0;
    while (feat[i] !== -1) i = x[feat[i]] <= thr[i] ? left[i] : right[i];
    sum += val[i];
  }
  return sum;
}

export function vectorize(model, f, qty) {
  return model.features.map(k => (k === 'log_qty' ? Math.log(qty) : +f[k]));
}

// Correction factors (log of actual / formula) for the low, middle and high estimate.
export function correction(model, f, qty) {
  const x = vectorize(model, f, qty);
  const mid = evalTrees(model.models.mid, x);
  let lo = evalTrees(model.models.lo, x) - model.q_hat;
  let hi = evalTrees(model.models.hi, x) + model.q_hat;
  lo = Math.min(lo, mid); hi = Math.max(hi, mid); // keep the band around the estimate
  return { lo, mid, hi };
}

export function quote(model, f, qty, rates) {
  const base = formulaQuote(f, qty, rates);
  const c = correction(model, f, qty);
  const factor = Math.exp(c.mid);
  return {
    ...base,
    formulaPrice: base.unitPrice,
    price: base.unitPrice * factor,
    low: base.unitPrice * Math.exp(c.lo),
    high: base.unitPrice * Math.exp(c.hi),
    factor,
  };
}

// What the price would be with a design issue fixed: the actionable part of the quote.
export function whatIf(model, f, qty, rates) {
  const now = quote(model, f, qty, rates).price;
  const out = [];
  const tryFix = (id, label, patch) => {
    const fixed = quote(model, { ...f, ...patch }, qty, rates).price;
    if (now - fixed > 0.5) out.push({ id, label, saving: now - fixed, pct: (now - fixed) / now });
  };
  if (f.sharp_edge_m > 0.005) tryFix('sharp', 'Add inside radii', { sharp_edge_m: 0 });
  if (f.zero_draft_frac > 0.04 && f.zero_draft_frac <= 0.8) tryFix('draft', 'Add 2° of draft', { zero_draft_frac: 0, min_draft_deg: Math.max(f.min_draft_deg, 2) });
  if (f.depth_ratio > 1 && f.zero_draft_frac <= 0.8) tryFix('deep', 'Make it shallower', { depth_ratio: 0.8, depth_mm: f.depth_mm * 0.8 / f.depth_ratio });
  return out.sort((a, b) => b.saving - a.saving);
}

export function parityCheck(model) {
  const { X, mid } = model.parity;
  let worst = 0;
  X.forEach((x, i) => { worst = Math.max(worst, Math.abs(evalTrees(model.models.mid, x) - mid[i])); });
  return worst;
}
