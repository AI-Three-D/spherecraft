# The grass canopy's correction, refitted on teacher data drawn with the previous correction in place
# (teacherRun.mjs): the residual of each channel (log of truth over ground) fitted on the same features, added to the
# previous fit's. The teacher's field is drawn over the corrected ground (its gaps show it), so a round or two settles.
# python3 tools/perf/grass/teacherFit2.py DATA.json PREVIOUS-fit.json OUT-fit.json
import json
import sys

import numpy as np

rows = json.load(open(sys.argv[1]))
prev = json.load(open(sys.argv[2]))
rows = [r for r in rows if r['slant'] > 0.008 and min(r['ground']) > 5 and min(r['truth']) > 5]
views = np.array([r['view'] for r in rows])
print(f'{len(rows)} spots from {len(set(views))} views')


def lin(c):
    c = np.asarray(c, dtype=float) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


truth = np.array([lin(r['truth']) for r in rows])
ground = np.array([lin(r['ground']) for r in rows])
game = np.array([lin(r['game']) if r.get('game') else [np.nan] * 3 for r in rows])
slant = np.array([r['slant'] for r in rows])
ls = np.log(np.clip(slant, 0.008, 1.0))
hot = np.array([r['hot'] for r in rows])
su = np.array([r['sunUp'] for r in rows])
ld = np.log(np.clip(np.array([r['d'] for r in rows], dtype=float), 10, 190))
X = np.stack([np.ones_like(ls), ls, ls * ls, hot, hot * ls, su, su * ls, ld, ld * ld], axis=1)
grey = np.array([0.2126, 0.7152, 0.0722])


def report(name, a, b):
    r = np.log(np.maximum(a @ grey, 1e-5) / np.maximum(b @ grey, 1e-5))
    print(f'  {name:16s} mean |log| {np.nanmean(np.abs(r)):.3f}   mean log {np.nanmean(r):+.3f}')


print('before this round:')
report('ground vs truth', ground, truth)
if not np.isnan(game).all():
    report('game vs truth', game, truth)
    report('game vs ground', game, ground)

lam = 0.02
coefs = []
held = []
for c in range(3):
    y = np.log(np.maximum(truth[:, c], 1e-5) / np.maximum(ground[:, c], 1e-5))
    A = X.T @ X + lam * np.eye(X.shape[1])
    coef = np.linalg.solve(A, X.T @ y)
    errs = []
    for v in dict.fromkeys(views):
        m = views == v
        Am = X[~m].T @ X[~m] + lam * np.eye(X.shape[1])
        cm = np.linalg.solve(Am, X[~m].T @ y[~m])
        errs.append(np.abs(X[m] @ cm - y[m]).mean())
    held.append(np.mean(errs))
    coefs.append(coef)
print('residual fit, held out by view, per channel:', ', '.join(f'{e:.3f}' for e in held))

# The new correction per channel: the previous (grey, with its hue as the intercept) plus this round's residual.
base = np.array(prev['coef']) if 'coef' in prev else None
out = {'rgb': []}
for c in range(3):
    if base is not None:
        total = base + coefs[c]
        total[0] += np.log(prev['hue'][c])
    else:
        total = np.array(prev['rgb'][c]) + coefs[c]
    out['rgb'].append(total.tolist())
json.dump(out, open(sys.argv[3], 'w'), indent=1)
for c, name in enumerate('rgb'):
    print(name, ', '.join(f'{x:.5f}' for x in out['rgb'][c]))
