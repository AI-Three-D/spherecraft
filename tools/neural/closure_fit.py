"""Learned density closure: E[true density | what the coarse sample knows]. Train places -> held-out place."""
import sys
import numpy as np
from closure import load
from mlp import MLP, train
r, rays = load('*')
w = r['transmittance'] * r['width'] / np.mean(r['transmittance'] * r['width'])
y = np.maximum(r['dMean'] - r['alto'], 0); d = np.maximum(r['dRt'] - r['alto'], 0)
te = np.array([s.startswith('test') for s in r['scene']]); deck = np.array([any(k in s for k in ('overcast', 'rain', 'storm')) for s in r['scene']])
lf = np.log2(r['footprint'] / 0.06)
F = {'d, distance': [d, lf], 'base, distance': [r['base'], lf], 'd, base, distance': [d, r['base'], lf],
     '+ height, deck share': [d, r['base'], lf, r['localH'], r['h'], r['stratiform']],
     '+ weather, variety': [d, r['base'], lf, r['localH'], r['h'], r['stratiform'], r['coverage'], r['kind'], r['variety']]}
def score(p, m):
    e = np.sum(w[m] * (p[m] - y[m]) ** 2) / np.sum(w[m] * (y[m]) ** 2)
    return f"err {np.sqrt(e):.3f} ratio {np.sum(w[m] * p[m]) / np.sum(w[m] * y[m]):.2f}"
far = r['t'] > 10
print(f'{len(y)} intervals; held-out place: fair/cloudy near | fair/cloudy beyond 10 km | decks')
show = lambda n, p: print(f"  {n:34s} {score(p, te & ~deck & ~far)} | {score(p, te & ~deck & far)} | {score(p, te & deck)}")
show('march as is', d)
def table(x, n=24):
    qb = np.unique(np.quantile(x[~te & (x > 0)], np.linspace(0, 1, n))); ql = np.linspace(0, 6, 13)
    i = np.where(x > 0, np.searchsorted(qb, x) + 1, 0); j = np.clip(np.searchsorted(ql, lf), 0, 13)
    num = np.zeros((n + 3, 14)); den = np.zeros((n + 3, 14))
    np.add.at(num, (i[~te], j[~te]), (w * y)[~te]); np.add.at(den, (i[~te], j[~te]), w[~te])
    return (num / np.maximum(den, 1e-9))[i, j]
show('table(d, distance)', table(d)); show('table(base, distance)', table(r['base']))
tr = np.flatnonzero(~te); rng = np.random.default_rng(0); tr = rng.permutation(tr)[:400000]; va, tr = tr[:40000], tr[40000:]
for name, cols in F.items():
    X = np.stack(cols, 1).astype(np.float32); mean = np.average(y[tr], weights=w[tr])
    for hidden in ([8, 8], [16, 16]):
        if hidden == [16, 16] and name not in ('d, base, distance', '+ weather, variety'): continue
        net = MLP([X.shape[1]] + hidden + [1], 'softsign', seed=0)
        train(net, X[tr], y[tr][:, None], w[tr], X[va], y[va][:, None], w[va], epochs=40, batch=8192, lr=4e-3, loss='rel', eps=3 * mean, log=lambda s: None, patience=12)
        show(f'net {hidden[0]}-{hidden[1]} {name}', np.exp(np.clip(net.forward(X)[:, 0], -30, 5)))
if 'export' in sys.argv:
    import json, os
    for tag, keys, hidden, eps in [('full', ['d', 'base', 'lf', 'localH', 'h', 'stratiform', 'coverage', 'kind', 'variety'], [16, 16], 1),
                                   ('mid', ['d', 'base', 'lf', 'localH', 'h', 'stratiform'], [8, 8], 1), ('mid3', ['d', 'base', 'lf', 'localH', 'h', 'stratiform'], [8, 8], 3),
                                   ('small', ['d', 'base', 'lf'], [8, 8], 1)]:
        cols = {'d': d, 'base': r['base'], 'lf': lf, 'localH': r['localH'], 'h': r['h'], 'stratiform': r['stratiform'], 'coverage': r['coverage'], 'kind': r['kind'], 'variety': r['variety']}
        X = np.stack([cols[k] for k in keys], 1).astype(np.float32); mean = np.average(y[tr], weights=w[tr])
        net = MLP([len(keys)] + hidden + [1], 'softsign', seed=0)
        train(net, X[tr], y[tr][:, None], w[tr], X[va], y[va][:, None], w[va], epochs=60, batch=8192, lr=4e-3, loss='rel', eps=eps * mean, log=lambda s: None, patience=15)
        show(tag, np.exp(np.clip(net.forward(X)[:, 0], -30, 5)))
        json.dump({**net.to_json(), 'features': keys, 'target': 'dMean'}, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models', f'closure-{tag}.json'), 'w'))
if 'sizes' in sys.argv:
    import json, os
    keys = ['d', 'base', 'lf', 'localH', 'h', 'stratiform']
    cols = {'d': d, 'base': r['base'], 'lf': lf, 'localH': r['localH'], 'h': r['h'], 'stratiform': r['stratiform']}
    for tag, ks, hidden in [('6-8-8', keys, [8, 8]), ('6-8', keys, [8]), ('6-4-4', keys, [4, 4]), ('6-4', keys, [4]), ('4-4-4', ['d', 'base', 'lf', 'stratiform'], [4, 4]), ('3-4-4', ['d', 'base', 'lf'], [4, 4]), ('5-4-4', ['d', 'base', 'lf', 'localH', 'stratiform'], [4, 4])]:
        X = np.stack([cols[k] for k in ks], 1).astype(np.float32); mean = np.average(y[tr], weights=w[tr]); best = None
        for seed in range(2):
            net = MLP([len(ks)] + hidden + [1], 'softsign', seed=seed)
            v = train(net, X[tr], y[tr][:, None], w[tr], X[va], y[va][:, None], w[va], epochs=60, batch=8192, lr=4e-3, loss='rel', eps=mean, log=lambda s: None, patience=15)
            if best is None or v < best[0]: best = (v, net)
        net = best[1]
        show(f'{tag} {sum(a.size for a in net.W) + sum(b.size for b in net.b)} params', np.exp(np.clip(net.forward(X)[:, 0], -30, 5)))
        json.dump({**net.to_json(), 'features': ks, 'target': 'dMean'}, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models', f'closure-{tag}.json'), 'w'))
