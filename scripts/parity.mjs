import { readFileSync } from 'node:fs';
import { parityCheck, quote, whatIf } from '../src/model.js';
import { analyze } from '../src/geometry.js';
import { SAMPLES, buildSample } from '../src/parts.js';
const model = JSON.parse(readFileSync(new URL('../app/model.json', import.meta.url)));
const worst = parityCheck(model);
console.log('max |JS - Python| on 40 test jobs:', worst.toExponential(2), worst < 1e-5 ? 'OK' : 'MISMATCH');
for (const s of SAMPLES) {
  const f = analyze(buildSample(s)).features;
  for (const qty of [10, 100, 1000]) {
    const q = quote(model, f, qty);
    if (qty === 100) console.log(s.name.padEnd(15), 'qty', qty, 'formula $' + q.formulaPrice.toFixed(2), '-> $' + q.price.toFixed(2), `[${q.low.toFixed(2)}, ${q.high.toFixed(2)}]`, 'x' + q.factor.toFixed(3), JSON.stringify(whatIf(model, f, qty).map(w => [w.label, +w.saving.toFixed(2)])));
  }
  const p = [10, 50, 100, 500, 1000].map(n => quote(model, f, n).price);
  if (p.some((v, i) => i && v > p[i - 1] + 1e-9)) console.log('  WARNING price rises with quantity', p.map(v => v.toFixed(2)));
}
