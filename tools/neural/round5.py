"""Round 5: the light-cache networks against the teacher, on every scene including storm decks.

Baked into the light cache, so none of this changes per-pixel cost:
  direct  sun transmittance T (the cache's third channel); the bake's exp(-(near + far)) is
          too dark because it exponentiates filtered density (Jensen gap)
  ms      multiple scattering (albedo included), as deployed
  sky     sky light (albedo included), as deployed

    python3 tools/neural/round5.py [direct|ms|sky|all] [--seeds N] [--hidden 16,16]
"""
import json
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from dataset import load  # noqa: E402
from experiments import FEATURE_SETS, features, hg, metrics, regimes, split  # noqa: E402
from mlp import MLP, save, train  # noqa: E402

NAMES = FEATURE_SETS['no-view+maps+log']   # the 22 inputs the bake already packs
DEPLOYED = {'ms': 'r4-ms-no-view+maps+log-16-16.json', 'sky': 'r3-sky-no-view+maps-16-16.json'}
TARGETS = {'direct': ('T', 'Tvar', 0.01), 'ms': ('msTarget', 'msVar', 1e-3), 'sky': ('skyTotal', 'skyVar', 1e-3)}
log = lambda m: print(m, flush=True)
fmt = lambda res: ' | '.join(f"{k.split(' ')[0]} {m['relRmseNoiseCorrected']:.3f} ({m['bias']:.2f})" for k, m in res.items())


def prepare():
    metas, r = load('*', require_extra=True)
    st = metas[0]['settings']
    c = r['cosTheta']
    r['phase'] = (1 - st['backLobeWeight']) * hg(c, st['phaseForward']) + st['backLobeWeight'] * hg(c, st['phaseBack'])
    r['T'] = r['single'] / r['phase']
    r['Tvar'] = np.zeros_like(r['T'])
    r['msTarget'] = r['albedo'] * r['ms']
    r['bakeT'] = np.exp(-(r['od'] * r['extinction'] + r['farOd']))
    test = np.array([s.startswith('test-') for s in r['scene']])
    return st, split(r, ~test), split(r, test)


def predict_json(path, rr):
    d = json.load(open(os.path.join(HERE, 'models', path)))
    m = MLP.from_json(d)
    return np.exp(np.clip(m.forward(features(rr, d['features']))[:, 0], -30, 10))


def fit(tr, te, which, hidden, seed, tag):
    target, var, eps = TARGETS[which]
    rng = np.random.default_rng(100 + seed)
    vm = rng.random(len(tr['weight'])) < 0.1
    a, v = split(tr, ~vm), split(tr, vm)
    model = MLP([len(NAMES)] + hidden + [1], 'softsign', seed=seed)
    t0 = time.time()
    val = train(model, features(a, NAMES), a[target][:, None], np.maximum(a['weight'], 0.05),
          features(v, NAMES), v[target][:, None], np.maximum(v['weight'], 0.05),
          epochs=100, batch=4096, lr=3e-3, loss='rel', eps=eps, log=lambda m: None, patience=20, seed=seed)
    name = f'r5-{which}-{tag}-{"-".join(map(str, hidden))}-s{seed}.json'
    save(os.path.join(HERE, 'models', name), model, {'features': NAMES, 'target': target, 'validationLoss': float(val)})
    pred = np.exp(np.clip(model.forward(features(te, NAMES))[:, 0], -30, 10))
    return name, pred, time.time() - t0


def report(label, pred, te, which):
    target, var, _ = TARGETS[which]
    res = regimes(pred, te, target, var)
    storm = np.array(['storm' in s or 'ground-e9' in s for s in te['scene']])
    if storm.any():
        res['storm/low-sun decks'] = metrics(pred[storm], split(te, storm), target, var)
        res['other'] = metrics(pred[~storm], split(te, ~storm), target, var)
    log(f'{which:6s} {label:34s} {fmt(res)}')
    return res


def main():
    which = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('--') else 'all'
    seeds = int(sys.argv[sys.argv.index('--seeds') + 1]) if '--seeds' in sys.argv else 1
    hidden = [int(h) for h in (sys.argv[sys.argv.index('--hidden') + 1] if '--hidden' in sys.argv else '16,16').split(',')]
    st, tr, te = prepare()
    log(f'train {len(tr["weight"])} points / {len(set(tr["scene"]))} scenes, test {len(te["weight"])} / {len(set(te["scene"]))}')
    out = {}
    for w in (['direct', 'ms', 'sky'] if which == 'all' else [which]):
        out[w] = {}
        if w == 'direct':
            out[w]['bake exp(-(near+far))'] = report('bake exp(-(near+far))', te['bakeT'], te, w)
        else:
            out[w]['deployed'] = report('deployed', predict_json(DEPLOYED[w], te), te, w)
        for seed in range(seeds):
            name, pred, sec = fit(tr, te, w, hidden, seed, 'all')
            out[w][name] = report(f'{name} ({sec:.0f}s)', pred, te, w)
    # Sun light as the cache delivers it: albedo * phase * T + ms.
    if which == 'all':
        single = te['albedo'] * te['phase']
        ms_dep = predict_json(DEPLOYED['ms'], te)
        best = lambda w: min((k for k in out[w] if k.startswith('r5-')), key=lambda k: out[w][k]['all']['relRmseNoiseCorrected'])
        ms_new = predict_json(best('ms'), te)
        t_new = predict_json(best('direct'), te)
        out['sunTotal'] = {
            'deployed (bake T + deployed ms)': report('deployed (bake T + deployed ms)', single * te['bakeT'] + ms_dep, te, 'sunTotal'),
            'learned T + deployed ms': report('learned T + deployed ms', single * t_new + ms_dep, te, 'sunTotal'),
            'learned T + new ms': report('learned T + new ms', single * t_new + ms_new, te, 'sunTotal'),
        }
    tag = f'{which}-{"-".join(map(str, hidden))}'
    json.dump(out, open(os.path.join(HERE, 'results', f'round5-{tag}.json'), 'w'), indent=1)


TARGETS['sunTotal'] = ('sunTotal', 'msVar', 1e-3)

if __name__ == '__main__':
    main()
