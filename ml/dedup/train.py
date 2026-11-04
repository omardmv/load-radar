"""Train the same-load classifier and compare it with the rule and LightGBM.

    ml/.venv/bin/python ml/dedup/train.py ml/dedup/data/pairs.csv ml/dedup

Splits by time (60% train / 20% threshold / 20% test): random splits would leak the future.
Threshold: the highest-recall one whose precision is >= 0.995 on the validation split, because a wrong merge
hides a real load from a dispatcher while a missed merge only costs a duplicate alert.
Exports logistic-regression weights to model.json for the TypeScript engine; LightGBM is trained for comparison.
"""
import csv
import json
import sys
import time

import lightgbm as lgb
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, precision_recall_curve, precision_score, recall_score
from sklearn.preprocessing import StandardScaler

TARGET_PRECISION = 0.995
NON_FEATURES = ("rule", "label", "t", "a_load", "b_load")

pairs_csv, out_dir = sys.argv[1], sys.argv[2]
rows = list(csv.DictReader(open(pairs_csv)))
features = [c for c in rows[0].keys() if c not in NON_FEATURES]
X = np.array([[float(r[f]) for f in features] for r in rows])
y = np.array([int(r["label"]) for r in rows])
rule = np.array([int(r["rule"]) for r in rows])
t = np.array([float(r["t"]) for r in rows])

order = np.argsort(t, kind="stable")
n = len(rows)
tr, va, te = order[: int(0.6 * n)], order[int(0.6 * n): int(0.8 * n)], order[int(0.8 * n):]


def pick_threshold(prob, labels):
    """Highest-recall threshold whose precision meets the target (a wrong merge hides a real load)."""
    prec, rec, thr = precision_recall_curve(labels, prob)
    ok = [(r, th) for p, r, th in zip(prec[:-1], rec[:-1], thr) if p >= TARGET_PRECISION]
    return float(max(ok)[1]) if ok else 0.5


def report(name, pred, prob=None):
    tp = int(((pred == 1) & (y[te] == 1)).sum())
    fp = int(((pred == 1) & (y[te] == 0)).sum())
    fn = int(((pred == 0) & (y[te] == 1)).sum())
    d = {"model": name, "precision": round(float(precision_score(y[te], pred, zero_division=0)), 4),
         "recall": round(float(recall_score(y[te], pred)), 4), "wrong_merges": fp, "missed_merges": fn, "right_merges": tp}
    if prob is not None:
        d["pr_auc"] = round(float(average_precision_score(y[te], prob)), 4)
    return d


scaler = StandardScaler().fit(X[tr])
t0 = time.time()
lr = LogisticRegression(max_iter=2000).fit(scaler.transform(X[tr]), y[tr])
lr_secs = time.time() - t0
lr_th = pick_threshold(lr.predict_proba(scaler.transform(X[va]))[:, 1], y[va])
lr_te = lr.predict_proba(scaler.transform(X[te]))[:, 1]

t0 = time.time()
gbm = lgb.LGBMClassifier(n_estimators=300, learning_rate=0.05, num_leaves=31, verbose=-1).fit(X[tr], y[tr])
gbm_secs = time.time() - t0
gbm_th = pick_threshold(gbm.predict_proba(X[va])[:, 1], y[va])
gbm_te = gbm.predict_proba(X[te])[:, 1]

metrics = [
    report("rule", rule[te]),
    report("logistic", (lr_te >= lr_th).astype(int), lr_te),
    report("lightgbm", (gbm_te >= gbm_th).astype(int), gbm_te),
]
importance = sorted(zip(features, (lr.coef_[0]).tolist()), key=lambda x: -abs(x[1]))
model = {
    "kind": "logistic",
    "features": features,
    "mean": scaler.mean_.tolist(),
    "scale": scaler.scale_.tolist(),
    "coef": lr.coef_[0].tolist(),
    "intercept": float(lr.intercept_[0]),
    "threshold": lr_th,
    "thresholds": {"logistic": lr_th, "lightgbm": gbm_th},
    "parity": [{"x": X[te][i].tolist(), "p": float(lr_te[i])} for i in range(min(20, len(te)))],
    "metrics": metrics,
    "weights_by_size": [{"feature": f, "weight": round(w, 3)} for f, w in importance],
    "train_seconds": {"logistic": round(lr_secs, 2), "lightgbm": round(gbm_secs, 2)},
    "data": {"pairs": n, "positives": int(y.sum()), "train": len(tr), "validation": len(va), "test": len(te),
             "target_precision": TARGET_PRECISION},
}
json.dump(model, open(f"{out_dir}/model.json", "w"), indent=1)
print(json.dumps({k: model[k] for k in ("data", "thresholds", "metrics", "weights_by_size", "train_seconds")}, indent=1))
