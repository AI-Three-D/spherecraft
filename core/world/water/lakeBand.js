// core/world/water/lakeBand.js
//
// A lake's mask (lakeRefine.js: 2 = water, 1 = shore band up to 3 cells
// around it) is solved on the terrain before the rivers are carved. Beside a
// river's channel outside lakes the carve and the valley lower the ground
// (riverCarve.wgsl.js, riverValley.js), so the band there showed the lake's
// water in hollows beside the river, cut by the 16 m cells (lab: terrain-lab
// valley-outlet-check.mjs, outlet 17; owner 2026-10-06: "nothing overflows
// from the river channel"). Until lakes and the carving are solved together,
// band cells within the carve's reach of a river point outside lakes are
// cleared. The lake's water cells are kept.

import { riverCap } from './riverRibbon.js';
import { riverShapeMaxScale } from './riverShapeNoise.js';

/** Reach (m) of a river's carve beyond its centre line, for a half-width (as WaterService passes it to solveRiver). */
export function riverCarveReach(carve = {}) {
    const scale = riverShapeMaxScale({ widthVar: carve.widthVar ?? 0.2, wobble: carve.wobble ?? 0.15 });
    const beyond = (carve.bankW ?? 12) + (carve.blendW ?? 30) + 8;
    return (hw) => hw * scale + beyond;
}

/** Angular radius of a lake's patch around its centre direction. */
function patchAngle(fr, R) {
    const x = Math.max(Math.abs(fr.x0), Math.abs(fr.x0 + fr.nx * fr.spacing));
    const y = Math.max(Math.abs(fr.y0), Math.abs(fr.y0 + fr.ny * fr.spacing));
    return Math.hypot(x, y) / R;
}

/** Whether a river's points can come within reach of a lake's patch. */
export function riverNearLake(river, lake, R, reachM = 200) {
    const cap = riverCap(river), c = lake.frame.c;
    const cos = Math.min(1, cap.c[0] * c[0] + cap.c[1] * c[1] + cap.c[2] * c[2]);
    return Math.acos(cos) < cap.angle + patchAngle(lake.frame, R) + reachM / R;
}

/**
 * The lake's mask with the band cleared near rivers outside lakes: a copy,
 * or the record's own mask when nothing is cleared.
 * @param {object} lake  refined lake record ({ frame, mask })
 * @param {Iterable<object>} rivers  traced river records (points stride >= 12: pool at 9)
 * @param {number} R
 * @param {(hw: number) => number} reachOf  riverCarveReach(carve)
 */
export function trimLakeBand(lake, rivers, R, reachOf) {
    const fr = lake.frame, { nx, ny, spacing } = fr, mask = lake.mask;
    let out = null;
    for (const river of rivers) {
        const P = river.points, st = river.stride, n = P.length / st;
        if (st < 12 || !riverNearLake(river, lake, R)) continue;
        for (let k = 0; k < n; k++) {
            if (P[k * st + 9] < 0) continue;   // inside a lake
            const d0 = P[k * st], d1 = P[k * st + 1], d2 = P[k * st + 2];
            const kc = d0 * fr.c[0] + d1 * fr.c[1] + d2 * fr.c[2];
            if (kc <= 0) continue;
            const x = (d0 * fr.e1[0] + d1 * fr.e1[1] + d2 * fr.e1[2]) / kc * R;
            const y = (d0 * fr.e2[0] + d1 * fr.e2[1] + d2 * fr.e2[2]) / kc * R;
            const reach = reachOf(P[k * st + 4]) + 0.5 * spacing;
            const i0 = Math.max(0, Math.floor((x - reach - fr.x0) / spacing)), i1 = Math.min(nx - 1, Math.floor((x + reach - fr.x0) / spacing));
            const j0 = Math.max(0, Math.floor((y - reach - fr.y0) / spacing)), j1 = Math.min(ny - 1, Math.floor((y + reach - fr.y0) / spacing));
            for (let j = j0; j <= j1; j++) {
                for (let i = i0; i <= i1; i++) {
                    const c = j * nx + i;
                    if (mask[c] !== 1 || (out && out[c] === 0)) continue;
                    if (Math.hypot(fr.x0 + (i + 0.5) * spacing - x, fr.y0 + (j + 0.5) * spacing - y) > reach) continue;
                    out ??= Uint8Array.from(mask);
                    out[c] = 0;
                }
            }
        }
    }
    return out ?? mask;
}
