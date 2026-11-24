"""Density closure: what the budget march's filtered density should have been.
Compares, per ray, the opacity of the march against the fine march, and per interval the density."""
import glob, json, os, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); D = os.path.join(HERE, 'data_closure')
def load(pattern):
    recs, rays = [], []
    for f in sorted(glob.glob(os.path.join(D, pattern + '.json'))):
        m = json.load(open(f)); n = len(m['fields'])
        raw = np.fromfile(f[:-5] + '.closure.f32', np.float32).reshape(-1, n).astype(float)
        r = {k: raw[:, i] for i, k in enumerate(m['fields'])}; r['scene'] = np.full(len(raw), m['name'], object)
        recs.append(r); rays.append((m['name'], np.fromfile(f[:-5] + '.rays.f32', np.float32).reshape(-1, 4).astype(float)))
    return {k: np.concatenate([r[k] for r in recs]) for k in recs[0]}, rays
if __name__ == '__main__':
    pat = sys.argv[1] if len(sys.argv) > 1 else '*'
    r, rays = load(pat)
    print('per ray: mean opacity of march vs truth, rms error')
    for n, a in rays:
        k = (a[:, 0] < .999) | (a[:, 1] < .999)
        if k.sum() > 100: print(f"  {n:34s} cloudy rays {k.sum():5d}  opacity {np.mean(1 - a[k, 0]):.3f} vs {np.mean(1 - a[k, 1]):.3f}   rms {np.sqrt(np.mean((a[k, 0] - a[k, 1]) ** 2)):.3f}")
    print('per interval: march density / truth, by distance (visible intervals)')
    w = r['transmittance'] * r['width']
    for lo, hi in [(0, 3), (3, 10), (10, 22), (22, 38), (38, 70)]:
        m = (r['t'] >= lo) & (r['t'] < hi)
        if m.sum() > 300: print(f"  {lo:2d}-{hi:2d} km n={m.sum():6d}  mean march {np.average(r['dRt'][m], weights=w[m]):.4f}  truth mean {np.average(r['dMean'][m], weights=w[m]):.4f}  effective {np.average(r['dEff'][m], weights=w[m]):.4f}")
