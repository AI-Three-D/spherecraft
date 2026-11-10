// js/world/terrain/tileTransitionTableBuilder.js
//
// Builds two small GPU lookup textures from tileTransitionRules /
// tileLayerHeights configuration:
//
//   blendModeTable   — 256×256 r8unorm
//                      [tileId1 * 256 + tileId2] = blend mode integer (0-3)
//                      Symmetric: table[a][b] == table[b][a].
//                      All-zeros default → blend_soft everywhere.
//
//   tileLayerHeights — 256×1 r8unorm
//                      [tileId] = layer height in [0, 1]
//                      Used only by step_overlay blend mode.
//
// Both textures are sampled with textureLoad (nearest, no sampler needed).

import { Texture, TextureFormat, TextureFilter } from '../renderer/resources/texture.js';

// ── Blend mode integer constants (shared with the WGSL shader) ────────────────
// Keep in sync with BLEND_MODE_* constants in terrainChunkFragmentShaderBuilder.js.
export const BLEND_MODES = Object.freeze({
    blend_soft:   0,
    blend_hard:   1,
    step_overlay: 2,
});

export const BREAK_STYLES = Object.freeze({
    none:         0,
    smooth_curve: 1,
    uneven:       2,
    streaky:      3,
    turbulent:    4,
});


export class TileTransitionTableBuilder {
    /**
     * @param {GPUDevice} device
     */
    constructor(device) {
        if (!device) throw new Error('TileTransitionTableBuilder: device is required');
        this.device = device;
    }

    /**
     * Build both lookup textures from configuration.
     *
     * @param {object} opts
     * @param {Array}  opts.tileTransitionRules
     *   Each entry: { from, to, mode, breakStyle?, breakStrength? }
     *   mode        — key of BLEND_MODES   (default: 'blend_soft')
     *   breakStyle  — key of BREAK_STYLES  (default: 'none')
     *   breakStrength — float [0,1]        (default: 0)
     * @param {object} opts.tileLayerHeights
     *   tileId (number) → height (float 0..1)
     *
     * @returns {{ blendModeTable: Texture, tileLayerHeights: Texture }}
     */
    build({ tileTransitionRules = [], tileLayerHeights = {} } = {}) {
        return {
            blendModeTable:   this._buildBlendModeTable(tileTransitionRules),
            tileLayerHeights: this._buildLayerHeightsTexture(tileLayerHeights),
        };
    }

    // ── Blend mode + break style table ───────────────────────────────────────
    // rgba8unorm, 256×256
    //   R — blend mode    (BLEND_MODES value, encoded as u8)
    //   G — break style   (BREAK_STYLES value, encoded as u8)
    //   B — break strength (float [0,1] encoded as u8 / 255)
    //   A — reserved (0)

    _buildBlendModeTable(rules) {
        const SIZE = 256;
        // All zeros → blend_soft, no break style, zero strength.
        const data = new Uint8Array(SIZE * SIZE * 4);

        for (const rule of rules) {
            const t1 = this._clampId(rule.from);
            const t2 = this._clampId(rule.to);

            const modeInt     = BLEND_MODES[rule.mode ?? 'blend_soft']
                                ?? BLEND_MODES.blend_soft;
            const styleInt    = BREAK_STYLES[rule.breakStyle ?? 'none']
                                ?? BREAK_STYLES.none;
            const strengthEnc = Math.max(0, Math.min(255,
                                    Math.round((rule.breakStrength ?? 0) * 255)));

            // Symmetric
            for (const [a, b] of [[t1, t2], [t2, t1]]) {
                const idx = (a * SIZE + b) * 4;
                data[idx + 0] = modeInt;
                data[idx + 1] = styleInt;
                data[idx + 2] = strengthEnc;
                data[idx + 3] = 0;
            }
        }

        // bytesPerRow = 256 × 4 = 1024 — satisfies WebGPU's 256-byte alignment.
        const gpuTexture = this.device.createTexture({
            label: 'BlendModeTable',
            size:  [SIZE, SIZE, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.device.queue.writeTexture(
            { texture: gpuTexture },
            data,
            { bytesPerRow: SIZE * 4 },
            { width: SIZE, height: SIZE, depthOrArrayLayers: 1 }
        );
        return this._wrap(gpuTexture, SIZE, SIZE, 'rgba8unorm', TextureFormat.RGBA8);
    }

    // ── Layer heights texture ─────────────────────────────────────────────────
    // r8unorm, 256×1 — unchanged from Step 2

    _buildLayerHeightsTexture(config) {
        const SIZE = 256;
        const data = new Uint8Array(SIZE);
        for (const [key, height] of Object.entries(config)) {
            data[this._clampId(Number(key))] =
                Math.max(0, Math.min(255, Math.round(height * 255)));
        }
        const gpuTexture = this.device.createTexture({
            label: 'TileLayerHeights',
            size:  [SIZE, 1, 1],
            format: 'r8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.device.queue.writeTexture(
            { texture: gpuTexture },
            data,
            { bytesPerRow: 256 },
            { width: SIZE, height: 1, depthOrArrayLayers: 1 }
        );
        return this._wrap(gpuTexture, SIZE, 1, 'r8unorm', TextureFormat.R8);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    _clampId(v) { return Math.max(0, Math.min(255, Math.round(v))); }

    _wrap(gpuTex, w, h, gpuFormat, engineFormat) {
        const t = new Texture({
            width:  w, height: h,
            format: engineFormat,
            minFilter: TextureFilter.NEAREST,
            magFilter: TextureFilter.NEAREST,
            generateMipmaps: false,
        });
        t._gpuTexture = { texture: gpuTex, view: gpuTex.createView(), format: gpuFormat };
        t._needsUpload = false;
        t._isGPUOnly   = true;
        return t;
    }
}
