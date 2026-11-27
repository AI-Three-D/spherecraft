// @ts-nocheck
// The grain of a grass field seen from afar (GrassPass.js, terrainPass.wgsl.js): tufts with lit tips, the dark between
// them, a share of straw; one stand (the clumps are the blades' own, put on by the terrain: grassField.wgsl.js). Made
// once at load from the same rules as the blades (grassWgsl.js), as a tileable colour factor with mipmaps, so it never
// flickers. The terrain wears it on its grass at two
// scales; the far blades take their colour from it at their root. Where the blades end the ground goes on with the same
// grain, as distant grass in games is drawn from textures made of the grass itself (Skyrim's TexGen HD grass LOD).

/** Metres across the texture, and texels across. The ground's wrap (2048 m) holds whole repeats of every lattice. */
export const GRAIN_PERIOD_M = 4;
export const GRAIN_SIZE = 256;
/** Lattices per wrap of the ground's coordinate (groundSurface.wgsl.js GROUND_WRAP_SHARE): fine (about 4 m), tussocks (about 21 m). */
export const GRAIN_WRAP_M = 2048;
export const GRAIN_LATTICES = Object.freeze([[499, 115], [74, 64]]);

const hash = (x, y, s) => {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 2147483647)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** Linear colour factors (mean 1 in each channel), GRAIN_SIZE x GRAIN_SIZE x 4 (a: how much of it is gap). */
export function makeGrain(size = GRAIN_SIZE) {
    const out = new Float32Array(size * size * 4);
    // Tufts on a jittered lattice about 7 cm apart.
    const tuftCells = Math.round(GRAIN_PERIOD_M / 0.07);
    const tuft = { n: tuftCells, at: [], look: [] };
    for (let j = 0; j < tuftCells; j++) for (let i = 0; i < tuftCells; i++) {
        tuft.at.push([(i + 0.15 + 0.7 * hash(i, j, 1)) / tuftCells, (j + 0.15 + 0.7 * hash(i, j, 2)) / tuftCells]);
        const straw = hash(i, j, 3) < 0.12;
        const tone = 0.85 + 0.3 * hash(i, j, 4);
        const warm = hash(i, j, 5) - 0.5;
        tuft.look.push([straw, tone, warm, 0.6 + 0.8 * hash(i, j, 6), hash(i, j, 7) * Math.PI * 2]);
    }
    const sum = [0, 0, 0];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const u = (x + 0.5) / size, v = (y + 0.5) / size;
        const ti = Math.floor(u * tuftCells), tj = Math.floor(v * tuftCells);
        // The tufts that reach here: blades fan out from each root, lit toward their tips.
        let cover = 0, r = 0, g = 0, b = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const a = ((ti + dx) % tuftCells + tuftCells) % tuftCells, c = ((tj + dy) % tuftCells + tuftCells) % tuftCells;
            const k = c * tuftCells + a;
            const [px, py] = tuft.at[k];
            let ox = (u - px - Math.floor(u - px + 0.5)) * GRAIN_PERIOD_M, oy = (v - py - Math.floor(v - py + 0.5)) * GRAIN_PERIOD_M;
            const [straw, tone, warm, reach, turn] = tuft.look[k];
            const d = Math.hypot(ox, oy) / (0.055 * reach);
            if (d >= 1) continue;
            // Seven blades about the root: a stroke where the angle is near one, fading out to the tip.
            const angle = Math.atan2(oy, ox) + turn;
            const stroke = Math.pow(Math.abs(Math.cos(angle * 3.5)), 6) * (1 - d) + Math.max(0, 1 - d * 3);
            const w = Math.min(1, stroke * 1.6);
            if (w <= cover) continue;
            cover = w;
            // Lit toward the tips (away from the root), darker in.
            const light = tone * (0.7 + 0.55 * d);
            r = light * (straw ? 1.55 : 1 + 0.12 * warm);
            g = light * (straw ? 1.25 : 1);
            b = light * (straw ? 0.85 : 1 - 0.15 * warm);
        }
        // One stand: the clumps are the blades' own, put on by the terrain at their places (grassField.wgsl.js); in the
        // tile they would repeat every 4 m.
        const clump = 1;
        // Between the tufts: the shade deep in the canopy.
        const gap = [0.42, 0.46, 0.40];
        const i = (y * size + x) * 4;
        out[i] = (gap[0] + (r - gap[0]) * cover) * clump;
        out[i + 1] = (gap[1] + (g - gap[1]) * cover) * clump;
        out[i + 2] = (gap[2] + (b - gap[2]) * cover) * clump;
        out[i + 3] = 1 - cover;
        sum[0] += out[i]; sum[1] += out[i + 1]; sum[2] += out[i + 2];
    }
    // Mean 1 in each channel: the grain shifts nothing, as the mips average it away far off.
    const n = size * size;
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) out[i * 4 + c] /= sum[c] / n;
    return out;
}

/** The grain as a texture (rgba16float, all mips: a box filter of the linear factors). */
export function createGrassGrain(device, size = GRAIN_SIZE) {
    const levels = Math.log2(size) + 1;
    const texture = device.createTexture({
        label: 'Grass grain', size: [size, size], format: 'rgba16float', mipLevelCount: levels,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    let level = makeGrain(size), s = size;
    const toHalf = (() => {
        const f = new Float32Array(1), u = new Uint32Array(f.buffer);
        return x => {
            f[0] = x;
            const b = u[0], sign = (b >>> 16) & 0x8000, e = ((b >>> 23) & 0xff) - 112, m = b & 0x7fffff;
            if (e <= 0) return sign;
            if (e >= 31) return sign | 0x7c00;
            return sign | (e << 10) | (m >>> 13);
        };
    })();
    for (let mip = 0; mip < levels; mip++) {
        const data = new Uint16Array(s * s * 4);
        for (let i = 0; i < data.length; i++) data[i] = toHalf(level[i]);
        device.queue.writeTexture({ texture, mipLevel: mip }, data, { bytesPerRow: s * 8 }, [s, s]);
        if (s === 1) break;
        const t = s >> 1, next = new Float32Array(t * t * 4);
        for (let y = 0; y < t; y++) for (let x = 0; x < t; x++) for (let c = 0; c < 4; c++) {
            const at = (yy, xx) => level[((2 * y + yy) * s + 2 * x + xx) * 4 + c];
            next[(y * t + x) * 4 + c] = 0.25 * (at(0, 0) + at(0, 1) + at(1, 0) + at(1, 1));
        }
        level = next;
        s = t;
    }
    return { texture, view: texture.createView(), destroy: () => texture.destroy() };
}
