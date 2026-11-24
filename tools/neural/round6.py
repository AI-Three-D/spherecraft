"""Round 6: round 5 on clean data (main cloud layer only), selected on held-out scenes.

Round 5 trained on every teacher point, including the low stratus layer that the cache never lights
(6 % of the points, all density inputs zero), and validated on points from its own training scenes.

    python3 tools/neural/round6.py search <ms|sky|direct>     # compare settings on validation scenes
    python3 tools/neural/round6.py final <target> <hidden> <eps> <seeds>   # train, then score the test scenes once
"""
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import round5 as R  # noqa: E402
from experiments import features, metrics, split  # noqa: E402
from mlp import MLP, save, train  # noqa: E402

log = lambda m: print(m, flush=True)


def data():
    st, tr, te = R.prepare()
    # Main layer only, and not the night side: there the game's air leaves almost no sunlight.
    tr = split(tr, (tr['h'] > 0) & (tr['density'] > 0) & (tr['muSun'] > -0.12))
    te = split(te, (te['h'] > 0) & (te['density'] > 0) & (te['muSun'] > -0.12))
    te = split(te, np.array([s.startswith('test-r6-') for s in te['scene']]))   # never used before
    scenes = sorted(set(tr['scene']))
    val = set(scenes[2::5])                      # whole scenes, spread over weather and view by name
    vm = np.array([s in val for s in tr['scene']])
    return split(tr, ~vm), split(tr, vm), te


def fit(a, v, target, hidden, eps, seed, names=R.NAMES, power=1.0):
    y, yv = a[target][:, None], v[target][:, None]
    w = lambda r: np.maximum(r['weight'], 0.05) ** power
    m = MLP([len(names)] + hidden + [1], 'softsign', seed=seed)
    t = time.time()
    train(m, features(a, names), y, w(a), features(v, names), yv, w(v), epochs=80, batch=4096, lr=3e-3,
          loss='rel', eps=eps, log=lambda s: None, patience=15, seed=seed)
    return m, time.time() - t


def predict(models, r, names=R.NAMES, cap=None):
    z = np.mean([np.clip(m.forward(features(r, names))[:, 0], -30, 10) for m in models], 0)
    p = np.exp(z)
    return p if cap is None else np.minimum(p, cap)


def score(p, r, which):
    target, var, _ = R.TARGETS[which]
    m = metrics(p, r, target, var)
    per = []
    for s in sorted(set(r['scene'])):
        k = r['scene'] == s
        per.append(metrics(p[k], split(r, k), target, var)['relRmseNoiseCorrected'])
    return f"all {m['relRmseNoiseCorrected']:.3f} ({m['bias']:.2f})  mean over scenes {np.mean(per):.3f}", np.mean(per)


def deployed(which, r):
    if which == 'direct':
        return np.minimum(np.exp(np.mean([np.log(R.predict_json(f'r5-direct-all-8-8-s{i}.json', r)) for i in range(3)], 0)), 1)
    return R.predict_json(R.DEPLOYED[which], r)


if __name__ == '__main__':
    mode, which = sys.argv[1], sys.argv[2]
    a, v, te = data()
    target, var, _ = R.TARGETS[which]
    cap = 1 if which == 'direct' else None
    mean = np.average(a[target], weights=a['weight'])
    log(f'{which}: train {len(a["weight"])} / {len(set(a["scene"]))} scenes, val {len(v["weight"])} / {len(set(v["scene"]))}, mean target {mean:.4f}')
    if mode == 'search':
        log(f'  deployed                 val {score(deployed(which, v), v, which)[0]}   (saw some of these scenes in training)')
        for hidden, rel, power in [([16, 16], .01, 1), ([16, 16], .3, 1), ([16, 16], 1.0, 1), ([16, 16], .3, 2), ([24, 24], .3, 1), ([8, 8], .3, 1)]:
            ms = [fit(a, v, target, hidden, rel * mean, s, power=power) for s in range(2)]
            line = score(predict([m for m, _ in ms], v, cap=cap), v, which)[0]
            one = np.mean([score(predict([m], v, cap=cap), v, which)[1] for m, _ in ms])
            log(f'  {str(hidden):9s} eps {rel:<4} w^{power}  2-seed avg {line}   single {one:.3f}  ({sum(t for _, t in ms):.0f}s)')
    else:
        hidden = [int(h) for h in sys.argv[3].split(',')]
        rel, seeds = float(sys.argv[4]), int(sys.argv[5])
        models = []
        for s in range(seeds):
            m, t = fit(a, v, target, hidden, rel * mean, s)
            models.append(m)
            name = f'{os.environ.get("TAG", "r6")}-{which}-{"-".join(map(str, hidden))}-s{s}.json'
            save(os.path.join(HERE, 'models', name), m, {'features': R.NAMES, 'target': target})
            log(f'  {name} val {score(predict([m], v, cap=cap), v, which)[0]} ({t:.0f}s)')
        log(f'  average  val  {score(predict(models, v, cap=cap), v, which)[0]}')
        log(f'  average  TEST {score(predict(models, te, cap=cap), te, which)[0]}')
        log(f'  deployed TEST {score(deployed(which, te), te, which)[0]}')
        if which == 'direct':
            log(f'  formula  TEST {score(te["bakeT"], te, which)[0]}')
