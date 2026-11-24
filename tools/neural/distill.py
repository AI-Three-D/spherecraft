"""One network with an ensemble's accuracy: train several, average them, fit a single student to the average.

    python3 tools/neural/distill.py <ms|sky|direct> [teachers] [student-hidden]
Noise-free targets, so the student is not limited by the Monte Carlo labels. Same runtime cost as one network.
"""
import os
import sys

import numpy as np
import round5 as R
import round6 as Q
from experiments import features, metrics, split
from mlp import MLP, save, train

which, count = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 6
hidden = [int(h) for h in (sys.argv[3] if len(sys.argv) > 3 else ('8,8' if which == 'direct' else '16,16')).split(',')]
tag = os.environ.get('TAG', 'r8')
a, v, te = Q.data()
target, var, _ = R.TARGETS[which]
cap = 1 if which == 'direct' else None
mean = np.average(a[target], weights=a['weight'])
print(f'{which}: train {len(a["weight"])} / {len(set(a["scene"]))} scenes, val {len(set(v["scene"]))}', flush=True)
teachers = [Q.fit(a, v, target, [16, 16], .3 * mean, s)[0] for s in range(count)]
ens = lambda r: Q.predict(teachers, r, cap=cap)
print(f'  {count} teachers, single mean over scenes {np.mean([Q.score(Q.predict([m], v, cap=cap), v, which)[1] for m in teachers]):.3f}')
print(f'  ensemble  val {Q.score(ens(v), v, which)[0]}', flush=True)
x, y = features(a, R.NAMES), ens(a)[:, None]
xv, yv = features(v, R.NAMES), ens(v)[:, None]
best = None
for seed in range(3):
    s = MLP([x.shape[1]] + hidden + [1], 'softsign', seed=seed)
    loss = train(s, x, y, np.maximum(a['weight'], .05), xv, yv, np.maximum(v['weight'], .05), epochs=140, batch=4096, lr=4e-3,
                 loss='rel', eps=.1 * mean, log=lambda m: None, patience=30, seed=seed)
    print(f'  student {seed} val {Q.score(Q.predict([s], v, cap=cap), v, which)[0]}', flush=True)
    if best is None or loss < best[0]:
        best = (loss, s)
name = f'{tag}-{which}-{"-".join(map(str, hidden))}-student.json'
save(os.path.join(Q.HERE, 'models', name), best[1], {'features': R.NAMES, 'target': target})
print(f'  {name}')
print(f'  student   TEST {Q.score(Q.predict([best[1]], te, cap=cap), te, which)[0]}')
print(f'  ensemble  TEST {Q.score(ens(te), te, which)[0]}')
print(f'  deployed  TEST {Q.score(Q.deployed(which, te), te, which)[0]}')
ins = np.array(['inside' in s or '-in-' in s for s in v['scene']])
if ins.any():
    q = split(v, ins)
    for n, p in [('student', Q.predict([best[1]], q, cap=cap)), ('deployed', Q.deployed(which, q))]:
        m = metrics(p, q, target, var); print(f"  inside views (val) {n} {m['relRmseNoiseCorrected']:.3f} ({m['bias']:.2f})")
