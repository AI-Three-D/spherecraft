"""Image error of the game's cloud buffer against the path tracer, split into lighting and opacity.
display = L + T * B (B: fixed sky behind the clouds). Monte Carlo noise of the reference is subtracted."""
import glob, os, sys
import numpy as np
W, H = 144, 90
LUM = np.array([.2126, .7152, .0722])
def load(d, name, side, n):
    f = f'{d}/{name}-{side}.hdr.f32'
    return np.fromfile(f, np.float32).reshape(-1, n).astype(float)
def scene(d, name, sides=('before', 'after')):
    t = load(d, name, 'teacher', 8)
    n = np.maximum(t[:, 5], 1)
    Lref = t[:, :3] @ LUM / n; Tref = t[:, 3] / n
    var = np.maximum(t[:, 7] / n - (t[:, 6] / n) ** 2, 0) / n
    mask = np.ones(len(t), bool)
    for s in sides:
        mask &= load(d, name, f'mask-{s}', 1)[:, 0] == 1
    mask &= (1 - Tref) > 0.02
    out = {'n': int(mask.sum()), 'cover': float(np.mean(1 - Tref))}
    if mask.sum() < 200: return out
    m = mask; a = 1 - Tref
    c_ref = Lref / np.maximum(a, .02)
    B = 0.4 * np.average(c_ref[m], weights=a[m])
    # MC covariance of L and T matters little here: opaque pixels dominate.
    noise = np.mean(var[m]); norm = np.mean((Lref + Tref * B)[m] ** 2)
    rel = lambda e, sub=True: float(np.sqrt(max(np.mean(e[m] ** 2) - (noise if sub else 0), 0) / norm))
    for s in sides:
        r = load(d, name, s, 4); L = r[:, :3] @ LUM; T = np.clip(r[:, 3], 0, 1); ar = 1 - T
        c = np.where(ar > .02, L / np.maximum(ar, .02), c_ref)
        out[s] = dict(total=rel(L + T * B - Lref - Tref * B),
                      light=rel(a * c - Lref),                       # perfect opacity, game lighting
                      opac=rel((ar - a) * (c_ref - B), False),       # perfect lighting, game opacity
                      bias=float(np.sum((a * c)[m]) / np.sum(Lref[m])), dop=float(np.mean((ar - a)[m])))
    return out
if __name__ == '__main__':
    d = sys.argv[1]; rows = {}
    names = sorted(os.path.basename(f)[:-len('-teacher.hdr.f32')] for f in glob.glob(f'{d}/*-teacher.hdr.f32'))
    print(f"{'view':24s} {'px':>5s}  {'total b/a':>14s} {'lighting b/a':>14s} {'opacity':>8s} {'light bias b/a':>15s} {'d-opacity':>9s}")
    for n in names:
        o = scene(d, n)
        if 'before' not in o: print(f'{n:24s} {o["n"]:5d}  (too few sky pixels)'); continue
        b, f = o['before'], o['after']; rows[n] = o
        print(f"{n[7:]:24s} {o['n']:5d}  {b['total']:.3f} -> {f['total']:.3f} {b['light']:.3f} -> {f['light']:.3f} {f['opac']:8.3f} {b['bias']:.2f} -> {f['bias']:.2f} {f['dop']:+9.3f}")
    for k in ('total', 'light', 'opac'):
        print(f"mean {k:6s} before {np.mean([o['before'][k] for o in rows.values()]):.4f} after {np.mean([o['after'][k] for o in rows.values()]):.4f}   (n={len(rows)})")
