// What the baked field holds along a river's last stretch and on into its lake:
// fall, speed, foam, whether its texels count as lake water. For the claim that a
// river's speed dies on water that is still falling.
// Stations from the trace (rec.points); past the end, straight on along its last direction.
import { sampleRiverField, fieldCoords, pageKey } from '/core/world/water/riverField.js';
import { unpackFlowTexel } from '/core/world/water/riverFlow.js';

const unit = a => { const l = Math.hypot(...a); return a.map(v => v / l); };

export function riverEnds({ pos, stepM = 10, backM = 260, onM = 200, maxRivers = 2 }) {
    const g = window.gameEngine, s = g.waterService, f = g.riverFieldService, R = g.planetConfig.radius, L = f.layout;
    const dir = unit(pos);
    const texel = (d) => {
        const q = fieldCoords(d, L), i = Math.floor(q.x), j = Math.floor(q.y), pi = Math.floor(i / L.P), pj = Math.floor(j / L.P);
        const key = pageKey(q.face, pi, pj, L), slot = f.slots?.get(key);
        if (slot === undefined) return null;
        const k = (j - pj * L.P + L.A) * L.ST + i - pi * L.P + L.A;
        return unpackFlowTexel(f.flow[slot * L.TEX + k]);
    };
    const near = s.rivers.map(r => ({ id: r.id, m: s._riverDistance(r.id, dir) })).filter(r => r.m < 700 && s.riverRecs.has(r.id)).sort((a, b) => a.m - b.m).slice(0, maxRivers);
    const out = [];
    for (const { id, m } of near) {
        const rec = s.riverRecs.get(id), P = rec.points, st = rec.stride, n = P.length / st;
        const at = k => [P[k * st], P[k * st + 1], P[k * st + 2]];
        const sep = (a, b) => Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * R;
        // Both ends, level falling toward the "down" end.
        const down = P[3] > P[(n - 1) * st + 3] ? 1 : -1, last = down > 0 ? n - 1 : 0;
        const ends = [{ name: 'mouth', from: last, step: -down, on: down }, { name: 'source', from: last === 0 ? n - 1 : 0, step: down, on: -down }];
        const river = { id, distanceM: Math.round(m), dest: rec.dest, src: rec.src, ends: {} };
        for (const e of ends) {
            const rows = [];
            let acc = 0, k = e.from;
            const path = [{ d: at(k), x: 0 }];
            while (acc < backM && k + e.step >= 0 && k + e.step < n) { const a = at(k), b = at(k + e.step); acc += sep(a, b); k += e.step; path.push({ d: at(k), x: -acc }); }
            const a = at(e.from), b = at(e.from + e.step), t = unit(a.map((v, i) => v - b[i]));
            for (let x = stepM; x <= onM; x += stepM) path.unshift({ d: unit(a.map((v, i) => v + t[i] * x / sep(a, b) * sep(a, b) / R)), x });
            let nextX = Infinity;
            for (const p of path) {
                if (p.x > nextX - stepM) continue;
                nextX = p.x;
                const w = sampleRiverField(f.pages, L, p.d), fl = texel(p.d);
                rows.push({ x: Math.round(p.x), W: w.found ? +w.W.toFixed(2) : null, sdf: w.found ? +w.sdf.toFixed(1) : null, v: fl ? +Math.hypot(fl.a, fl.b).toFixed(2) : null, foam: fl ? +fl.foam.toFixed(2) : null, n: fl ? +fl.n.toFixed(3) : null });
            }
            river.ends[e.name] = rows;
        }
        out.push(river);
    }
    return out;
}
