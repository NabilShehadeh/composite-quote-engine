// Copies the quote engine into the portfolio at site/quote/:  node quote-engine/build.mjs
//
// Module imports and the model file get a ?v=<hash of contents> suffix, so a browser can never
// combine new code with an old cached file (Base44 caches JS and JSON for an hour).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'site', 'quote');
const hash = s => createHash('sha256').update(s).digest('hex').slice(0, 8);

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'src'), { recursive: true });

// Leaf modules first, so a dependent can embed its dependency's hash.
const done = {};
const stampImports = (code, prefix) => code.replace(/from '(\.\.\/src\/|\.\/)([a-z]+\.js)'/g, (_, __, file) => {
  if (!done[file]) throw new Error(`build order: ${file} is imported before it was built`);
  return `from '${prefix}${file}?v=${done[file]}'`;
});
for (const file of ['geometry.js', 'parts.js', 'cost.js', 'model.js']) {
  const code = stampImports(readFileSync(join(here, 'src', file), 'utf8'), './');
  writeFileSync(join(out, 'src', file), code);
  done[file] = hash(code);
}

const model = readFileSync(join(here, 'app', 'model.json'));
writeFileSync(join(out, 'model.json'), model);

let app = stampImports(readFileSync(join(here, 'app', 'app.js'), 'utf8'), './src/');
app = app.replace("const MODEL_URL = 'model.json';", `const MODEL_URL = 'model.json?v=${hash(model)}';`);
writeFileSync(join(out, 'app.js'), app);
writeFileSync(join(out, 'styles.css'), readFileSync(join(here, 'app', 'styles.css')));
writeFileSync(join(out, 'index.html'), readFileSync(join(here, 'app', 'index.html')));
console.log('Built site/quote:', Object.entries(done).map(([f, h]) => `${f}@${h}`).join(' '), `model.json@${hash(model)}`);
