import { noise3 } from './noise.js';

export const MAX_LAYERS = 8;
export const MAX_VEINS = 4;
export const ROCK_UNIFORM_FLOATS = 184;        // must match struct Rock in rockShader.wgsl.js

function rgb(value, what) {
    if (!Array.isArray(value) || value.length < 3 || !value.slice(0, 3).every(Number.isFinite)) throw new Error(`RockModel: ${what} needs a colour [r, g, b]`);
    return Object.freeze([value[0], value[1], value[2]]);
}

/**
 * Rock described as data.
 *
 * layers, top to bottom:
 *   { name, thickness (m; the last layer has none), color, accent?, banding? (m period), mottle? (0..1),
 *     mottleScale? (1/m), follow? (1 = parallel to the surface, 0 = level), dip? [dx, dz] (m per m),
 *     warp? { amplitude (m), wavelength (m) }, seed? }
 *   The bottom of layer i is
 *     follow * surface + (1 - follow) * datum - (thickness of layers 0..i) + dip . (x, z) + warp noise
 *   and never rises above the bottom of the layer over it, so a layer can pinch out but not cross.
 *
 * veins:
 *   { name, color, frequency (1/m), stretch? [sx, sy, sz], threshold (0..1, higher = thinner),
 *     depthRange [min, max] (m below the surface), fade? (m), seed? }
 *   A vein is where |noise(p * frequency * stretch)| < 1 - threshold, inside its depth range.
 *
 * The same definition runs per fragment in rockShader.wgsl.js; pack() produces its uniform block.
 */
export class RockModel {
    /** @param {{layers: object[], veins?: object[], datum?: number}} description @param {import('./CapturedHeightfield.js').CapturedHeightfield} surface */
    constructor(description, surface) {
        const { layers, veins = [], datum = surface.minHeight } = description ?? {};
        if (!Array.isArray(layers) || layers.length < 1 || layers.length > MAX_LAYERS) throw new Error(`RockModel: 1 to ${MAX_LAYERS} layers are required`);
        if (!Array.isArray(veins) || veins.length > MAX_VEINS) throw new Error(`RockModel: at most ${MAX_VEINS} veins`);
        this.surface = surface;
        this.datum = datum;
        let depth = 0;
        this.layers = layers.map((layer, index) => {
            const last = index === layers.length - 1;
            if (!last && !(layer.thickness > 0)) throw new Error(`RockModel: layer ${index} needs a positive thickness`);
            if (layer.warp?.amplitude && !(layer.warp.wavelength > 0)) throw new Error(`RockModel: layer ${index} warp needs a wavelength`);
            if (!last) depth += layer.thickness;
            const color = rgb(layer.color, `layer ${index}`);
            return Object.freeze({
                name: layer.name ?? `layer ${index}`,
                color,
                accent: layer.accent ? rgb(layer.accent, `layer ${index} accent`) : color,
                banding: layer.banding ?? 0,
                mottle: layer.mottle ?? 0,
                mottleScale: layer.mottleScale ?? 1,
                bottomDepth: last ? Infinity : depth,
                follow: layer.follow ?? 1,
                dipX: layer.dip?.[0] ?? 0,
                dipZ: layer.dip?.[1] ?? 0,
                warpAmplitude: layer.warp?.amplitude ?? 0,
                warpFrequency: layer.warp?.amplitude ? 1 / layer.warp.wavelength : 0,
                seed: layer.seed ?? 101 + index,
            });
        });
        this.veins = veins.map((vein, index) => {
            if (!(vein.frequency > 0) || !(vein.threshold > 0 && vein.threshold < 1)) throw new Error(`RockModel: vein ${index} needs a frequency and a threshold in (0, 1)`);
            if (!Array.isArray(vein.depthRange) || !(vein.depthRange[1] > vein.depthRange[0])) throw new Error(`RockModel: vein ${index} needs depthRange [min, max]`);
            const stretch = vein.stretch ?? [1, 1, 1];
            return Object.freeze({
                name: vein.name ?? `vein ${index}`,
                color: rgb(vein.color, `vein ${index}`),
                threshold: vein.threshold,
                frequency: Object.freeze(stretch.map(s => s * vein.frequency)),
                minDepth: vein.depthRange[0],
                maxDepth: vein.depthRange[1],
                fade: vein.fade ?? 2,
                seed: vein.seed ?? 201 + index,
            });
        });
    }

    /** Raw bottom interface of a layer (before the no-crossing rule), frame metres. */
    layerBottom(index, x, z, surfaceHeight) {
        const layer = this.layers[index];
        let bottom = layer.follow * surfaceHeight + (1 - layer.follow) * this.datum - layer.bottomDepth + layer.dipX * x + layer.dipZ * z;
        if (layer.warpAmplitude !== 0) bottom += layer.warpAmplitude * noise3(x * layer.warpFrequency, 0, z * layer.warpFrequency, layer.seed);
        return bottom;
    }

    /** What the rock is at a frame position (whether or not it has been dug away). */
    describe(x, y, z) {
        const surfaceHeight = this.surface.sample(x, z);
        let top = surfaceHeight, layer = 0;
        for (let i = 1; i < this.layers.length; i++) {
            top = Math.min(top, this.layerBottom(i - 1, x, z, surfaceHeight));
            if (y >= top) break;
            layer = i;
        }
        const depth = surfaceHeight - y;
        let vein = -1;
        this.veins.forEach((candidate, index) => {
            if (depth < candidate.minDepth || depth > candidate.maxDepth) return;
            const f = candidate.frequency;
            if (Math.abs(noise3(x * f[0], y * f[1], z * f[2], candidate.seed)) < 1 - candidate.threshold) vein = index;
        });
        return { depth, layer, layerName: this.layers[layer].name, vein, veinName: vein < 0 ? null : this.veins[vein].name };
    }

    /** Uniform block for rockShader.wgsl.js. */
    pack(out = new Float32Array(ROCK_UNIFORM_FLOATS)) {
        out.fill(0);
        out[0] = this.layers.length;
        out[1] = this.veins.length;
        out[2] = this.datum;
        out[4] = this.surface.minX;
        out[5] = this.surface.minZ;
        out[6] = 1 / this.surface.spacing;
        this.layers.forEach((layer, index) => {
            const o = 8 + index * 16;
            out.set(layer.color, o);
            out[o + 3] = layer.banding;
            out.set(layer.accent, o + 4);
            out[o + 7] = layer.mottle;
            out[o + 8] = Number.isFinite(layer.bottomDepth) ? layer.bottomDepth : 0;
            out[o + 9] = layer.follow;
            out[o + 10] = layer.dipX;
            out[o + 11] = layer.dipZ;
            out[o + 12] = layer.warpAmplitude;
            out[o + 13] = layer.warpFrequency;
            out[o + 14] = layer.seed;
            out[o + 15] = layer.mottleScale;
        });
        this.veins.forEach((vein, index) => {
            const o = 8 + MAX_LAYERS * 16 + index * 12;
            out.set(vein.color, o);
            out[o + 3] = vein.threshold;
            out.set(vein.frequency, o + 4);
            out[o + 7] = vein.seed;
            out[o + 8] = vein.minDepth;
            out[o + 9] = vein.maxDepth;
            out[o + 10] = vein.fade;
        });
        return out;
    }
}