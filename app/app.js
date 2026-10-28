import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { analyze, dfmFlags, parseSTL, scaleMesh } from '../src/geometry.js';
import { SAMPLES, buildSample, sampler, FAMILIES } from '../src/parts.js';
import { RATES } from '../src/cost.js';
import { quote, whatIf } from '../src/model.js';

const MODEL_URL = 'model.json';
const QTYS = [10, 50, 100, 500, 1000];
const $ = s => document.querySelector(s);
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const fine = matchMedia('(hover: hover) and (pointer: fine)');
const money = (v, d = 2) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

const state = { model: null, part: null, qty: 100, rates: { ...RATES }, mode: 'shaded', focus: null };

/* ───────── 3D viewer ───────── */

const viewer = (() => {
  const wrap = $('#viewer');
  const canvas = $('#canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.autoRotate = !reduce;
  controls.autoRotateSpeed = 0.7;
  const stopSpin = () => { controls.autoRotate = false; wrap.classList.add('touched'); };
  controls.addEventListener('start', stopSpin);

  scene.add(new THREE.HemisphereLight(0xdfe7f5, 0x1a1a1a, 1.25));
  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(1, 1.6, 1.2); scene.add(key);
  const rim = new THREE.DirectionalLight(0x6f8fd0, 1.1); rim.position.set(-1.4, 0.6, -1); scene.add(rim);

  // Carbon look: dark clear-coated surface; colour per face comes from vertex colours.
  const material = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.15, clearcoat: 0.7, clearcoatRoughness: 0.25, side: THREE.DoubleSide });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0xe0a43a, transparent: true, opacity: 0 });
  let mesh = null, edges = null, info = null, colors = null;

  const C = {
    carbon: new THREE.Color('#2a2d32'), cut: new THREE.Color('#3a3d42'),
    warn: new THREE.Color('#e0a43a'), mid: new THREE.Color('#8fa7c9'), good: new THREE.Color('#2b6dd1'),
    dim: new THREE.Color('#1e2023'),
  };

  function load(pos, analysis) {
    if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); }
    if (edges) { scene.remove(edges); edges.geometry.dispose(); }
    info = analysis;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    colors = new Float32Array(pos.length);
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    // Sit the part the way it would sit in the mold: pull direction up.
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(...analysis.pull), new THREE.Vector3(0, 1, 0));
    geo.applyQuaternion(q);
    geo.computeBoundingBox();
    const centre = geo.boundingBox.getCenter(new THREE.Vector3());
    geo.translate(-centre.x, -centre.y, -centre.z);
    geo.computeVertexNormals();
    mesh = new THREE.Mesh(geo, material);
    scene.add(mesh);

    const ep = new Float32Array(analysis.sharpEdges.flat());
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.BufferAttribute(ep, 3));
    eg.applyQuaternion(q); eg.translate(-centre.x, -centre.y, -centre.z);
    edges = new THREE.LineSegments(eg, edgeMat);
    scene.add(edges);

    geo.computeBoundingSphere();
    const r = geo.boundingSphere.radius || 1;
    const dist = r / Math.sin((camera.fov * Math.PI / 180) / 2) * 1.05;
    camera.near = dist / 100; camera.far = dist * 20; camera.updateProjectionMatrix();
    camera.position.set(dist * 0.62, dist * 0.5, dist * 0.6);
    controls.target.set(0, 0, 0);
    controls.update();
    paint();
  }

  function paint() {
    if (!mesh) return;
    const { draft, surface } = info.faces;
    const n = draft.length;
    const focus = state.focus;
    for (let f = 0; f < n; f++) {
      let c;
      if (state.mode === 'draft' || focus === 'draft') {
        if (!surface[f]) c = C.cut;
        else if (draft[f] < 1) c = C.warn;
        else if (focus === 'draft') c = C.dim;
        else c = draft[f] < 3 ? C.mid : C.good;
      } else {
        c = surface[f] ? C.carbon : C.cut;
        if (focus === 'sharp') c = C.dim;
      }
      for (let k = 0; k < 3; k++) { colors[f * 9 + k * 3] = c.r; colors[f * 9 + k * 3 + 1] = c.g; colors[f * 9 + k * 3 + 2] = c.b; }
    }
    mesh.geometry.attributes.color.needsUpdate = true;
    edgeMat.opacity = focus === 'sharp' ? 1 : state.mode === 'draft' ? 0.85 : 0;
    wrap.classList.toggle('mode-draft', state.mode === 'draft');
  }

  function resize() {
    const { width, height } = wrap.getBoundingClientRect();
    renderer.setSize(width, height, false);
    camera.aspect = width / height; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(wrap);

  // Only render while the viewer is on screen.
  let visible = true;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(wrap);
  renderer.setAnimationLoop(() => { if (!visible) return; controls.update(); renderer.render(scene, camera); });

  return { load, paint, wrap };
})();

/* ───────── parts ───────── */

const randomPart = sampler();
const samplesEl = $('#samples');
SAMPLES.forEach(s => {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'chip'; b.textContent = s.name; b.dataset.sample = s.id;
  b.setAttribute('aria-pressed', 'false');
  b.addEventListener('click', () => setPart({ name: s.name, mesh: buildSample(s), sample: s.id }));
  samplesEl.appendChild(b);
});

$('#shuffle').addEventListener('click', () => {
  const p = randomPart();
  setPart({ name: `${FAMILIES[p.family].label}, random`, mesh: p.mesh });
});

function setPart(part) {
  let analysis;
  try { analysis = analyze(part.mesh); }
  catch (e) { fileMsg(e.message, true); return; }
  state.part = { ...part, analysis, flags: dfmFlags(analysis.features) };
  state.focus = null;
  document.querySelectorAll('[data-sample]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.sample === part.sample)));
  viewer.load(part.mesh, analysis);
  render();
}

/* ───────── upload ───────── */

const fileInput = $('#file');
const fileMsg = (text, err = false) => { const m = $('#file-msg'); m.textContent = text; m.classList.toggle('err', err); };
let lastUpload = null;

async function readFile(file) {
  if (!file) return;
  if (!/\.stl$/i.test(file.name)) { fileMsg('Only STL files are supported for now.', true); return; }
  if (file.size > 60 * 1024 * 1024) { fileMsg('That file is over 60 MB. Try a lighter export.', true); return; }
  try {
    fileMsg(`Reading ${file.name}`);
    const raw = parseSTL(await file.arrayBuffer());
    lastUpload = { name: file.name.replace(/\.stl$/i, ''), raw };
    quoteUpload();
  } catch (e) {
    fileMsg(e.message || 'That file could not be read as an STL.', true);
  }
}
function quoteUpload() {
  if (!lastUpload) return;
  const t0 = performance.now();
  setPart({ name: lastUpload.name, mesh: scaleMesh(lastUpload.raw, +$('#units').value) });
  if (!state.part?.analysis) return;
  const ms = Math.round(performance.now() - t0);
  const tri = state.part.analysis.triangles.toLocaleString('en-US');
  fileMsg(`${tri} triangles, analysed in ${ms} ms, all in your browser.`);
}
fileInput.addEventListener('change', () => readFile(fileInput.files[0]));
$('#units').addEventListener('change', quoteUpload);

let dragDepth = 0;
addEventListener('dragenter', e => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; viewer.wrap.classList.add('dragging'); } });
addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) viewer.wrap.classList.remove('dragging'); });
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; viewer.wrap.classList.remove('dragging'); readFile(e.dataTransfer.files[0]); });

/* ───────── view modes ───────── */

document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
  state.mode = b.dataset.mode;
  document.querySelectorAll('[data-mode]').forEach(x => x.setAttribute('aria-checked', String(x === b)));
  viewer.paint();
}));

/* ───────── quantity ───────── */

const qtyEl = $('#qty'), thumb = $('#qty-thumb');
QTYS.forEach(n => {
  const b = document.createElement('button');
  b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset.qty = n; b.textContent = n.toLocaleString('en-US');
  b.addEventListener('click', () => { state.qty = n; render(); });
  qtyEl.appendChild(b);
});
qtyEl.addEventListener('keydown', e => {
  const i = QTYS.indexOf(state.qty);
  const j = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? Math.min(QTYS.length - 1, i + 1) : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? Math.max(0, i - 1) : i;
  if (j !== i) { e.preventDefault(); state.qty = QTYS[j]; render(); qtyEl.querySelector(`[data-qty="${state.qty}"]`).focus(); }
});
function placeThumb() {
  const btn = qtyEl.querySelector(`[data-qty="${state.qty}"]`);
  if (!btn) return;
  thumb.style.width = btn.offsetWidth + 'px';
  thumb.style.transform = `translateX(${btn.offsetLeft - 3}px)`;
}
new ResizeObserver(placeThumb).observe(qtyEl);

/* ───────── quote panel ───────── */

const ICON = { warn: 'ph-fill ph-warning-circle', note: 'ph-fill ph-info' };
let lastPrice = null;

function render() {
  const { model, part } = state;
  if (!model || !part) return;
  const f = part.analysis.features;
  const q = quote(model, f, state.qty, state.rates);
  const fixes = whatIf(model, f, state.qty, state.rates);

  $('#panel').classList.remove('loading');
  $('#part-name').textContent = part.name;
  const dims = [f.max_dim_mm >= 100 ? Math.round(f.max_dim_mm) : f.max_dim_mm.toFixed(1)];
  $('#part-meta').textContent = `${f.plies} plies, ${f.thickness_mm.toFixed(1)} mm thick, ${(f.layup_area_m2 * 1e4).toFixed(0)} cm² of laminate, ${dims[0]} mm long`;

  qtyEl.querySelectorAll('button').forEach(b => { const on = +b.dataset.qty === state.qty; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
  placeThumb();

  // Price: a quick blur crossfade so the change reads as an update, not a jump.
  const priceEl = $('#price');
  const text = money(q.price);
  if (lastPrice !== null && lastPrice !== text && !reduce) {
    priceEl.classList.add('swap');
    setTimeout(() => { priceEl.textContent = text; priceEl.classList.remove('swap'); }, 90);
  } else priceEl.textContent = text;
  lastPrice = text;

  // Range bar: the 90% band on a scale padded around it.
  const span = q.high - q.low || 1;
  const min = q.low - span * 0.35, max = q.high + span * 0.35;
  const pct = v => ((v - min) / (max - min)) * 100;
  $('#range-band').style.left = pct(q.low) + '%';
  $('#range-band').style.width = (pct(q.high) - pct(q.low)) + '%';
  $('#range-dot').style.left = pct(q.price) + '%';
  $('#range-label').textContent = `90% range ${money(q.low)} to ${money(q.high)}`;

  const delta = (q.factor - 1) * 100;
  const reason = fixes[0] ? ` ${fixes[0].id === 'sharp' ? 'Sharp corners' : fixes[0].id === 'draft' ? 'Walls without draft' : 'The deep draw'} account for ${money(fixes[0].saving)} of it.` : '';
  $('#why').textContent = Math.abs(delta) < 2
    ? `The rule of thumb says ${money(q.formulaPrice)}, and the model agrees for this geometry.`
    : `The rule of thumb says ${money(q.formulaPrice)}. The model ${delta > 0 ? 'adds' : 'takes off'} ${Math.abs(delta).toFixed(0)}% for this part and order size.${delta > 0 ? reason : ''}`;

  $('#total').textContent = money(q.price * state.qty, 0);
  $('#lead').textContent = `${q.leadWeeks} weeks`;
  $('#cycle').textContent = `${Math.round(q.cycle)} min`;

  // Design checks, each linked to the viewer and to the saving from fixing it.
  const list = $('#flags');
  list.innerHTML = '';
  if (!part.flags.length) {
    list.innerHTML = '<li class="flag ok"><i class="ph-fill ph-check-circle" aria-hidden="true"></i><div><p class="flag-title">No design issues found</p><p class="flag-text">Good radii and draft for a one-sided tool.</p></div></li>';
  }
  for (const fl of part.flags) {
    const li = document.createElement('li');
    li.className = 'flag';
    const fix = fixes.find(x => x.id === fl.id);
    const linked = fl.id === 'sharp' || fl.id === 'draft';
    if (linked) { li.dataset.focus = fl.id; li.tabIndex = 0; }
    li.innerHTML = `<i class="${ICON[fl.level] || ICON.warn}" aria-hidden="true"></i><div><p class="flag-title"><span></span>${fix ? `<span class="save">${fix.label}, save ${money(fix.saving)} a part</span>` : ''}</p><p class="flag-text"></p></div>`;
    li.querySelector('.flag-title span').textContent = fl.title;
    li.querySelector('.flag-text').textContent = fl.text;
    list.appendChild(li);
  }

  // Breakdown: the formula's parts plus the model's correction, adding up to the price.
  const parts = q.parts;
  const rows = [['Material', parts.material], ['Layup', parts.layup], ['Cure', parts.cure], ['Trim', parts.trim], ['Inspection', parts.inspect], ['Tooling, shared over the order', parts.tooling], ['Margin', parts.margin]];
  const bd = $('#breakdown');
  bd.innerHTML = '';
  for (const [label, v] of rows) bd.insertAdjacentHTML('beforeend', `<div><dt>${label}</dt><dd>${money(v)}</dd></div>`);
  bd.insertAdjacentHTML('beforeend', `<div class="adj"><dt>Model correction</dt><dd>${q.price >= q.formulaPrice ? '+' : '-'}${money(Math.abs(q.price - q.formulaPrice))}</dd></div>`);
  bd.insertAdjacentHTML('beforeend', `<div class="total"><dt>Per part</dt><dd>${money(q.price)}</dd></div>`);
}

// Hovering or focusing a linked check highlights it on the part.
const flagsEl = $('#flags');
const setFocus = id => { if (state.focus === id) return; state.focus = id; viewer.paint(); flagsEl.querySelectorAll('[data-focus]').forEach(el => el.classList.toggle('on', el.dataset.focus === id)); };
flagsEl.addEventListener('pointerover', e => { if (fine.matches) setFocus(e.target.closest('[data-focus]')?.dataset.focus || null); });
flagsEl.addEventListener('pointerleave', () => setFocus(null));
flagsEl.addEventListener('focusin', e => setFocus(e.target.closest('[data-focus]')?.dataset.focus || null));
flagsEl.addEventListener('focusout', () => setFocus(null));
flagsEl.addEventListener('click', e => { if (!fine.matches) { const id = e.target.closest('[data-focus]')?.dataset.focus || null; setFocus(state.focus === id ? null : id); } });

/* ───────── how it works ───────── */

const RATE_FIELDS = [
  ['prepreg', 'Prepreg', '$ / m² / ply', 1],
  ['cell', 'Layup cell', '$ / hour', 1],
  ['oven', 'Oven', '$ / hour', 1],
  ['margin', 'Margin', '%', 100],
];
function buildRates() {
  const grid = $('#rates');
  grid.innerHTML = '';
  for (const [k, label, unit, scale] of RATE_FIELDS) {
    const id = 'rate-' + k;
    grid.insertAdjacentHTML('beforeend', `<div class="rate"><label for="${id}">${label}</label><div class="rate-in"><input id="${id}" type="number" inputmode="decimal" min="0" step="any" value="${+(state.rates[k] * scale).toFixed(2)}"><span class="unit">${unit}</span></div></div>`);
    $('#' + id).addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      if (Number.isFinite(v) && v >= 0) { state.rates[k] = v / scale; render(); }
    });
  }
}
$('#reset').addEventListener('click', () => { state.rates = { ...RATES }; buildRates(); render(); });

function renderModelCard(m) {
  const n = v => v.toLocaleString('en-US');
  $('#m-jobs').textContent = n(m.jobs);
  $('#m-test').textContent = n(m.test);
  $('#metrics').innerHTML = `
    <div><dt>Average error, vs the rule of thumb</dt><dd><s>${m.formula_mape}%</s>${m.model_mape}%</dd></div>
    <div><dt>Quotes within 10% of the real cost</dt><dd><s>${m.formula_within10}%</s>${m.model_within10}%</dd></div>
    <div><dt>Error on parts with design issues</dt><dd><s>${m.complex_formula_mape}%</s>${m.complex_model_mape}%</dd></div>
    <div><dt>Real costs inside the 90% range</dt><dd>${m.coverage}%</dd></div>`;
  const top = m.importance.slice(0, 6);
  const maxShare = top[0].share;
  $('#importance').innerHTML = top.map(t => `<li><span>${t.label}</span><span class="imp-bar" style="transform: scaleX(${(t.share / maxShare).toFixed(3)})"></span><span class="imp-val">${(t.share * 100).toFixed(0)}%</span></li>`).join('');
}

/* ───────── start ───────── */

$('#panel').classList.add('loading');
buildRates();
setPart({ name: SAMPLES[1].name, mesh: buildSample(SAMPLES[1]), sample: SAMPLES[1].id });
fetch(MODEL_URL)
  .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
  .then(model => { state.model = model; renderModelCard(model.metrics); render(); })
  .catch(() => { $('#part-name').textContent = 'The pricing model could not load. Refresh to try again.'; $('#panel').classList.remove('loading'); });
