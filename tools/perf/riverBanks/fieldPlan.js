// Plan view of the baked river field around a pose (page side): natural
// ground + Δ as a hillshade, the water (sdf > 0) tinted, Δ in colour.
// Returns base64 RGB images; tools/perf/riverBanks/fieldPlanPng.mjs writes PNGs.
import { sampleRiverField } from '/core/world/water/riverField.js';
export async function fieldPlan({ pos, look, sizeM = 600, px = 400, aheadM = 250 }) {
    const g = window.gameEngine, svc = g.riverFieldService, L = svc.layout, R = L.R;
    const len = Math.hypot(...pos), up = pos.map(v => v / len);
    // Centre: aheadM along the view's horizontal direction.
    const f = look.map((v, i) => v - pos[i]), fu = f[0] * up[0] + f[1] * up[1] + f[2] * up[2];
    let fwd = f.map((v, i) => v - fu * up[i]); const fl = Math.hypot(...fwd) || 1; fwd = fwd.map(v => v / fl);
    const c0 = up.map((v, i) => v + fwd[i] * aheadM / R), cl = Math.hypot(...c0), c = c0.map(v => v / cl);
    // Image y = forward (top), x = right.
    const right = [fwd[1] * c[2] - fwd[2] * c[1], fwd[2] * c[0] - fwd[0] * c[2], fwd[0] * c[1] - fwd[1] * c[0]];
    const step = sizeM / px, dirs = new Float32Array(px * px * 4);
    for (let j = 0; j < px; j++) for (let i = 0; i < px; i++) {
        const x = (i - px / 2) * step, y = (px / 2 - j) * step;
        const d = [c[0] + (x * right[0] + y * fwd[0]) / R, c[1] + (x * right[1] + y * fwd[1]) / R, c[2] + (x * right[2] + y * fwd[2]) / R];
        const l = Math.hypot(...d), o = (j * px + i) * 4;
        dirs[o] = d[0] / l; dirs[o + 1] = d[1] / l; dirs[o + 2] = d[2] / l;
    }
    const nat = await g.waterService._sampler.sampleDirsNatural(dirs);
    const ground = new Float32Array(px * px), W = new Float32Array(px * px), sdf = new Float32Array(px * px), delta = new Float32Array(px * px);
    for (let k = 0; k < px * px; k++) {
        const s = sampleRiverField(svc.pages, L, [dirs[k * 4], dirs[k * 4 + 1], dirs[k * 4 + 2]]);
        delta[k] = s.found ? s.delta : 0; ground[k] = nat[k] + delta[k]; W[k] = s.W; sdf[k] = s.found ? s.sdf : -16;
    }
    const shade = new Uint8Array(px * px * 3), wet = new Uint8Array(px * px * 3), dImg = new Uint8Array(px * px * 3);
    const ld = [-0.5, 0.5, 0.7], ll = Math.hypot(...ld);
    for (let j = 0; j < px; j++) for (let i = 0; i < px; i++) {
        const k = j * px + i, a = ground[j * px + Math.max(0, i - 1)], b = ground[j * px + Math.min(px - 1, i + 1)];
        const u = ground[Math.max(0, j - 1) * px + i], d = ground[Math.min(px - 1, j + 1) * px + i];
        const gx = (b - a) / (2 * step), gy = (u - d) / (2 * step), n = [-gx, -gy, 1], nl = Math.hypot(...n);
        const lit = Math.max(0, (n[0] * ld[0] + n[1] * ld[1] + n[2] * ld[2]) / (nl * ll));
        const v = Math.round(40 + 215 * lit);
        shade.set([v, v, v], k * 3);
        const under = ground[k] < W[k] && sdf[k] > 0, depth = W[k] - ground[k];
        wet.set(under ? [v * 0.3, v * 0.55, Math.min(255, v * 0.6 + 60 + 20 * Math.min(depth, 3))] : (sdf[k] > -1 && sdf[k] <= 0 ? [255, 200, 0] : [v, v, v]), k * 3);
        const dd = Math.max(-1, Math.min(1, delta[k] / 3));
        dImg.set(dd < 0 ? [255 + 200 * dd, 255 + 200 * dd, 255] : [255, 255 - 200 * dd, 255 - 200 * dd], k * 3);
    }
    const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode(...u8.subarray(i, i + 32768)); return btoa(s); };
    return { px, sizeM, shade: b64(shade), wet: b64(wet), delta: b64(dImg) };
}
