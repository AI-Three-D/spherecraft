import { pageOf } from './riverField.js';

// Conservative tile predicate for changed field pages. Tile UV is gnomonic;
// field pages are equal-angle, so convert the padded tile bounds before
// looking up pages. The padding covers terrain normals and splat sampling.
export function tilesTouchingRiverFieldPages(keys, L, textureSize, paddingTexels, boundaryFallback = null) {
    if (!Number.isFinite(textureSize) || textureSize < 2 || !Number.isFinite(paddingTexels) || paddingTexels < 0) {
        throw new Error('Invalid terrain tile sampling dimensions');
    }
    const byFace = new Map();
    for (const key of keys) {
        const { face, pi, pj } = pageOf(key, L);
        let data = byFace.get(face);
        if (!data) byFace.set(face, (data = { list: [], set: new Set() }));
        const index = pj * L.PE + pi;
        data.list.push(index); data.set.add(index);
    }
    const fieldPage = uv => (Math.atan(uv * 2 - 1) / (Math.PI / 4) + 1) * 0.5 * L.PE;
    return (face, depth, x, y) => {
        const grid = 2 ** depth, pad = (paddingTexels + 2) / (textureSize - 1), data = byFace.get(face);
        const u0 = (x - pad) / grid, u1 = (x + 1 + pad) / grid, v0 = (y - pad) / grid, v1 = (y + 1 + pad) / grid;
        // Padding outside a cube face may sample an adjacent face. Retain
        // boundary tiles conservatively if any other face changed.
        if ((u0 < 0 || v0 < 0 || u1 > 1 || v1 > 1) && byFace.size > (data ? 1 : 0)
            && (!boundaryFallback || boundaryFallback(face, depth, x, y))) return true;
        if (!data) return false;
        const i0 = Math.max(0, Math.floor(fieldPage(Math.max(0, u0))) - 1), i1 = Math.min(L.PE - 1, Math.floor(fieldPage(Math.min(1, u1))) + 1);
        const j0 = Math.max(0, Math.floor(fieldPage(Math.max(0, v0))) - 1), j1 = Math.min(L.PE - 1, Math.floor(fieldPage(Math.min(1, v1))) + 1);
        if ((i1 - i0 + 1) * (j1 - j0 + 1) <= data.list.length) {
            for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (data.set.has(j * L.PE + i)) return true;
            return false;
        }
        return data.list.some(index => { const i = index % L.PE, j = Math.floor(index / L.PE); return i >= i0 && i <= i1 && j >= j0 && j <= j1; });
    };
}
