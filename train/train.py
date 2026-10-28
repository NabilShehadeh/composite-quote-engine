"""Train the quote model.

The model predicts how far a real job lands from the rule-of-thumb quote:
    y = log(actual price / formula price)
so the formula keeps doing the arithmetic (and stays editable), and the model only learns the
corrections: sharp corners, missing draft, deep draws, order size and so on.

Three LightGBM models give the 5th, 50th and 95th percentile of y. Split conformal calibration
(CQR) then widens or narrows the band so it covers 90% of held-out jobs.

    python3 train/train.py   ->  app/model.json, data/metrics.json
"""
import json
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
FEATURES = ['layup_area_m2', 'thickness_mm', 'plies', 'footprint_m2', 'mold_len_mm', 'mold_wid_mm', 'depth_mm',
            'depth_ratio', 'sharp_edge_m', 'zero_draft_frac', 'min_draft_deg', 'curvature', 'max_dim_mm', 'log_qty']
LABELS = {
    'layup_area_m2': 'Layup area', 'thickness_mm': 'Thickness', 'plies': 'Ply count', 'footprint_m2': 'Mold footprint',
    'mold_len_mm': 'Mold length', 'mold_wid_mm': 'Mold width', 'depth_mm': 'Depth', 'depth_ratio': 'Draw depth',
    'sharp_edge_m': 'Sharp corners', 'zero_draft_frac': 'Missing draft', 'min_draft_deg': 'Minimum draft',
    'curvature': 'Curvature', 'max_dim_mm': 'Largest dimension', 'log_qty': 'Order quantity',
}
# The price can only go up with more sharp corners, less draft or a deeper draw, and down with a bigger order.
MONOTONE = {'sharp_edge_m': 1, 'zero_draft_frac': 1, 'depth_ratio': 1, 'log_qty': -1}
ALPHA = 0.10  # 90% intervals

df = pd.read_csv(ROOT / 'data' / 'jobs.csv')
df['log_qty'] = np.log(df['qty'])
df['y'] = np.log(df['actual'] / df['formula'])

rng = np.random.default_rng(7)
idx = rng.permutation(len(df))
n_train, n_cal = int(0.6 * len(df)), int(0.2 * len(df))
train, cal, test = df.iloc[idx[:n_train]], df.iloc[idx[n_train:n_train + n_cal]], df.iloc[idx[n_train + n_cal:]]
X = lambda d: d[FEATURES].to_numpy()


def fit(alpha):
    params = dict(learning_rate=0.05, num_leaves=15, min_data_in_leaf=30, feature_fraction=0.9,
                  bagging_fraction=0.9, bagging_freq=1, lambda_l2=1.0, verbose=-1, seed=7)
    if alpha == 0.5:
        # The point estimate carries the monotone constraints, so "fix this" savings are never negative.
        # LightGBM only allows them on regression objectives, so the band edges stay unconstrained.
        params.update(objective='regression', monotone_constraints=[MONOTONE.get(f, 0) for f in FEATURES],
                      monotone_constraints_method='advanced')
    else:
        params.update(objective='quantile', alpha=alpha)
    ds = lgb.Dataset(X(train), train['y'], feature_name=FEATURES)
    val = lgb.Dataset(X(cal), cal['y'], reference=ds)
    return lgb.train(params, ds, num_boost_round=1500, valid_sets=[val],
                     callbacks=[lgb.early_stopping(60, verbose=False)])


models = {name: fit(a) for name, a in [('lo', ALPHA / 2), ('mid', 0.5), ('hi', 1 - ALPHA / 2)]}

# Conformal calibration: how far outside the raw band do calibration jobs fall?
lo_c, hi_c = models['lo'].predict(X(cal)), models['hi'].predict(X(cal))
scores = np.maximum(lo_c - cal['y'], cal['y'] - hi_c)
k = int(np.ceil((len(cal) + 1) * (1 - ALPHA))) - 1
q_hat = float(np.sort(scores)[min(k, len(scores) - 1)])

# Held-out test results.
pred = {n: m.predict(X(test)) for n, m in models.items()}
actual, formula = test['actual'].to_numpy(), test['formula'].to_numpy()
mid_price = formula * np.exp(pred['mid'])
lo_price, hi_price = formula * np.exp(pred['lo'] - q_hat), formula * np.exp(pred['hi'] + q_hat)
mape = lambda p: float(np.mean(np.abs(p - actual) / actual) * 100)
within10 = lambda p: float(np.mean(np.abs(p - actual) / actual <= 0.10) * 100)
covered = (actual >= lo_price) & (actual <= hi_price)
complex_mask = (test['sharp_edge_m'] > 0.005) | (test['zero_draft_frac'] > 0.04) | (test['depth_ratio'] > 1)

gain = models['mid'].feature_importance('gain')
order = np.argsort(gain)[::-1]
metrics = {
    'jobs': int(len(df)), 'train': int(len(train)), 'calibration': int(len(cal)), 'test': int(len(test)),
    'formula_mape': round(mape(formula), 1), 'model_mape': round(mape(mid_price), 1),
    'formula_within10': round(within10(formula), 1), 'model_within10': round(within10(mid_price), 1),
    'complex_formula_mape': round(float(np.mean(np.abs(formula - actual)[complex_mask] / actual[complex_mask]) * 100), 1),
    'complex_model_mape': round(float(np.mean(np.abs(mid_price - actual)[complex_mask] / actual[complex_mask]) * 100), 1),
    'coverage': round(float(covered.mean() * 100), 1), 'target_coverage': round((1 - ALPHA) * 100),
    'median_band_pct': round(float(np.median((hi_price - lo_price) / mid_price) * 100), 1),
    'q_hat': round(q_hat, 5),
    'trees': {n: m.num_trees() for n, m in models.items()},
    'importance': [{'feature': FEATURES[i], 'label': LABELS[FEATURES[i]], 'share': round(float(gain[i] / gain.sum()), 4)} for i in order if gain[i] > 0],
}
print(json.dumps({k: v for k, v in metrics.items() if k != 'importance'}, indent=1))
print('top drivers:', [(m['label'], m['share']) for m in metrics['importance'][:6]])


def compact(booster):
    """Flatten each tree to parallel arrays: feature (-1 for a leaf), threshold, left, right, value."""
    trees = []
    for t in booster.dump_model()['tree_info']:
        feat, thr, left, right, val = [], [], [], [], []

        def walk(node):
            i = len(feat)
            feat.append(-1); thr.append(0); left.append(-1); right.append(-1); val.append(0)
            if 'leaf_value' in node:
                val[i] = round(node['leaf_value'], 7)
                return i
            assert node['decision_type'] == '<='
            feat[i] = node['split_feature']; thr[i] = node['threshold']
            left[i] = walk(node['left_child']); right[i] = walk(node['right_child'])
            return i

        walk(t['tree_structure'])
        trees.append([feat, thr, left, right, val])
    return trees


export = {
    'features': FEATURES, 'labels': LABELS, 'q_hat': q_hat, 'alpha': ALPHA,
    'models': {n: compact(m) for n, m in models.items()},
    'metrics': metrics,
    # A slice of test jobs so the browser can check its tree evaluation matches Python exactly.
    'parity': {'X': X(test.iloc[:40]).round(6).tolist(), 'mid': [round(float(v), 7) for v in pred['mid'][:40]]},
}
(ROOT / 'app').mkdir(exist_ok=True)
(ROOT / 'app' / 'model.json').write_text(json.dumps(export, separators=(',', ':')))
(ROOT / 'data' / 'metrics.json').write_text(json.dumps(metrics, indent=1))
print('model.json', round((ROOT / 'app' / 'model.json').stat().st_size / 1024), 'KB')
