"""Neural MS with a physics prior: output x shadow-map transmittance (exp(-k farOd))."""
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
fmt = lambda res: ' | '.join(f"{k} {m['relRmseNoiseCorrected']:.3f} ({m['bias']:.2f})" for k, m in res.items())
out = {}
for k in [1.0, 0.5]:
    for set_name, hidden in [('no-view+maps', [16, 16]), ('no-view+maps', [8, 8])]:
        names = E.FEATURE_SETS[set_name]
        off = lambda rr: (-k * np.minimum(rr['farOd'], 60))[:, None].astype(np.float32)
        m = MLP([len(names)] + hidden + [1], 'softsign', seed=1)
        train(m, E.features(a, names), a['msTarget'][:, None], np.maximum(a['weight'], 0.05), E.features(v, names), v['msTarget'][:, None],
              np.maximum(v['weight'], 0.05), epochs=100, batch=4096, lr=3e-3, loss='rel', eps=1e-3, log=lambda s: None, patience=20,
              offset=off(a), offset_v=off(v))
        ms = np.exp(m.forward(E.features(te, names))[:, 0] + off(te)[:, 0])
        res = E.regimes(single + ms, te, 'sunTotal', 'msVar')
        out[f'k={k} {set_name} {hidden}'] = res
        save(os.path.join('models', f'r4-ms-prior{k}-{set_name}-{hidden[0]}-{hidden[1]}.json'), m,
             {'features': names, 'target': 'msTarget', 'shadowPrior': k})
        print(f'prior k={k} {set_name} {hidden}: hybrid sun {fmt(res)}', flush=True)
json.dump(out, open('results/prior.json', 'w'), indent=1)

# Soft prior (the shipped candidate): log(1 + farOd) as an extra input instead of a hard multiplier.
names = E.FEATURE_SETS['no-view+maps+log']
for seed in [1, 2]:
    m = MLP([len(names), 16, 16, 1], 'softsign', seed=seed)
    train(m, E.features(a, names), a['msTarget'][:, None], np.maximum(a['weight'], 0.05), E.features(v, names), v['msTarget'][:, None],
          np.maximum(v['weight'], 0.05), epochs=100, batch=4096, lr=3e-3, loss='rel', eps=1e-3, log=lambda s: None, patience=20, seed=seed)
    res = E.regimes(single + np.exp(m.forward(E.features(te, names))[:, 0]), te, 'sunTotal', 'msVar')
    out[f'soft prior seed {seed}'] = res
    if seed == 1:
        save(os.path.join('models', 'r4-ms-no-view+maps+log-16-16.json'), m, {'features': names, 'target': 'msTarget'})
    print(f'soft prior (log farOd input) 16-16 seed {seed}: hybrid sun {fmt(res)}', flush=True)
json.dump(out, open('results/prior.json', 'w'), indent=1)
