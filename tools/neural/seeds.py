"""Seed variance for the chosen models, and a view-independent sky model (light-cache viability)."""
import json, os, numpy as np
import experiments as E
from dataset import load
from mlp import MLP, train, save
metas, r = load('*')
r['msTarget'] = r['albedo'] * r['ms']
st = metas[0]['settings']
te_m = np.array([s.startswith('test-') for s in r['scene']])
tr, te = E.split(r, ~te_m), E.split(r, te_m)
vm = np.random.default_rng(3).random(len(tr['weight'])) < 0.1
a, v = E.split(tr, ~vm), E.split(tr, vm)
c = te['cosTheta']
ph = (1 - st['backLobeWeight']) * E.hg(c, st['phaseForward']) + st['backLobeWeight'] * E.hg(c, st['phaseBack'])
single = te['albedo'] * ph * np.exp(-(te['od'] * te['extinction'] + te['farOd']))
out = {}
fmt = lambda res: ' | '.join(f"{k} {m['relRmseNoiseCorrected']:.3f} ({m['bias']:.2f})" for k, m in res.items())
for tag, target, var, set_name, hidden in [('ms', 'msTarget', 'msVar', 'no-view+maps', [16, 16]),
                                          ('sky', 'skyTotal', 'skyVar', 'probes+maps', [8, 8]),
                                          ('sky', 'skyTotal', 'skyVar', 'no-view+maps', [8, 8]),
                                          ('sky', 'skyTotal', 'skyVar', 'no-view+maps', [16, 16])]:
    names = E.FEATURE_SETS[set_name]
    for seed in [2, 3, 4]:
        m = MLP([len(names)] + hidden + [1], 'softsign', seed=seed)
        train(m, E.features(a, names), a[target][:, None], np.maximum(a['weight'], 0.05), E.features(v, names), v[target][:, None],
              np.maximum(v['weight'], 0.05), epochs=100, batch=4096, lr=3e-3, loss='rel', eps=1e-3, log=lambda s: None, patience=20, seed=seed)
        pred = np.exp(m.forward(E.features(te, names))[:, 0])
        if tag == 'ms':
            pred = pred + single
            res = E.regimes(pred, te, 'sunTotal', 'msVar')
        else:
            res = E.regimes(pred, te, target, var)
        out[f'{tag} {set_name} {hidden} seed {seed}'] = res
        if set_name == 'no-view+maps' and tag == 'sky' and seed == 2:
            save(os.path.join('models', f'r3-sky-no-view+maps-{hidden[0]}-{hidden[1]}.json'), m, {'features': names, 'target': target})
        print(f'{tag} {set_name} {hidden} seed {seed}: {fmt(res)}', flush=True)
json.dump(out, open('results/seeds.json', 'w'), indent=1)
