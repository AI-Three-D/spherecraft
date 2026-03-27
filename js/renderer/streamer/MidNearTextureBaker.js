// js/renderer/streamer/MidNearTextureBaker.js
//
// Bakes canopy proxy and impostor carve-out textures using the same
// ProceduralTextureGenerator pipeline that birch bark and leaf albedo
// textures use. This gives us:
//   - Proper layer composition (fill, fbm, grain, etc.)
//   - Seamless tiling for the proxy surface texture
//   - Consistent visual quality with the rest of the prop system
//
// Output: a single 2d-array texture with:
//   Layer 0:             Canopy proxy surface (tiling leaf-clump noise, RGB, A=1)
//   Layers 1..N:         Impostor carve-out variants (RGB=canopy detail, A=silhouette mask)

import { Logger } from '../../config/Logger.js';

export const MIDNEAR_CANOPY_LAYERS = 1;
export const MIDNEAR_IMPOSTOR_VARIANTS = 4;

/**
 * Layer definitions for the canopy proxy texture.
 * Dense overlapping leaf-clump noise — viewed from 60m+ on the
 * surface of a low-poly blob, so needs to read as "leafy volume"
 * without any recognisable tiling pattern.
 */
function canopyProxyLayers(seed = 0) {
    return [
        // Stronger base contrast to avoid flat plastic read.
        { type: 'fill', color: '#1d3511', opacity: 1.0 },

        // Big canopy mass breakup.
        {
            type: 'fbm', octaves: 4, frequency: 0.045, amplitude: 0.52,
            persistence: 0.52, color: '#4e8e30', opacity: 0.78,
            blendMode: 'screen', seed: seed + 10
        },

        // Leaf-clump cells for visible lobe structure.
        {
            type: 'cells', cellScale: 2.3, cellRandomness: 0.85, cellElongation: 0.38,
            color: '#79b54b', opacity: 0.42,
            blendMode: 'overlay', seed: seed + 18
        },

        // Deep pockets between clumps.
        {
            type: 'ridged', octaves: 4, frequency: 0.11, amplitude: 0.46,
            persistence: 0.55, color: '#10240b', opacity: 0.52,
            blendMode: 'multiply', seed: seed + 24
        },

        // Mid-frequency leafy grain.
        {
            type: 'fbm', octaves: 5, frequency: 0.30, amplitude: 0.26,
            persistence: 0.50, color: '#63a33f', opacity: 0.44,
            blendMode: 'screen', seed: seed + 30
        },

        // Fine roughness; keeps spec-free foliage from reading too smooth.
        {
            type: 'grain', amplitude: 3.6,
            color: '#000000', opacity: 0.12,
            blendMode: 'overlay', seed: seed + 50
        },
        {
            type: 'grain', amplitude: 2.8,
            color: '#ffffff', opacity: 0.08,
            blendMode: 'overlay', seed: seed + 51
        },
    ];
}

/**
 * Layer definitions for impostor carve-out texture variants.
 * RGB: canopy interior detail (darker centre = depth illusion).
 * Alpha: irregular blob silhouette with noisy perimeter.
 *
 * These are rendered as billboard cards at anchor positions, so the
 * silhouette defines the card's visible shape (alpha cutout).
 */
function impostorCarveoutLayers(seed = 0, variantIndex = 0) {
    const vSeed = seed + variantIndex * 1000;
    return [
        // ── Alpha channel: silhouette ─────────────────────────────────────
        // Built by compositing a radial gradient base with noise fringe.
        // The ProceduralTextureGenerator doesn't have a dedicated "alpha
        // mask" mode, so we build the mask in the RGB channels of a
        // separate pass, then the MidNearTextureBaker combines them.
        // For now, generate RGB canopy + use CPU post-pass for alpha.

        // Dark green base (canopy interior)
        { type: 'fill', color: '#1a3510', opacity: 1.0 },

        // Depth gradient — brighter at edges (sky-facing foliage)
        {
            type: 'radial_gradient',
            centerX: 0.5, centerY: 0.5,
            radiusInner: 0.0, radiusOuter: 0.42,
            colorInner: '#0d1a08', colorOuter: '#3a6a28',
            opacity: 0.70, blendMode: 'screen', seed: vSeed + 10
        },

        // Leaf-clump detail
        {
            type: 'fbm', octaves: 4, frequency: 0.18, amplitude: 0.28,
            persistence: 0.50, color: '#4a8830', opacity: 0.35,
            blendMode: 'screen', seed: vSeed + 20
        },

        // Fine breakup
        {
            type: 'fbm', octaves: 5, frequency: 0.45, amplitude: 0.15,
            persistence: 0.48, color: '#1a2a10', opacity: 0.22,
            blendMode: 'multiply', seed: vSeed + 30
        },

        // Surface grain
        {
            type: 'grain', amplitude: 2.2,
            color: '#000000', opacity: 0.05,
            blendMode: 'overlay', seed: vSeed + 40
        },
    ];
}

export class MidNearTextureBaker {
    /**
     * @param {GPUDevice} device
     * @param {import('../../texture/webgpu/textureGenerator.js').ProceduralTextureGenerator} proceduralGenerator
     * @param {object} [opts]
     * @param {number} [opts.textureSize=256]
     * @param {number} [opts.seed=0x71D5EED]
     */
    constructor(device, proceduralGenerator, opts = {}) {
        this.device = device;
        this.procGen = proceduralGenerator;
        this.textureSize = opts.textureSize ?? 256;
        this.seed = opts.seed ?? 0x71D5EED;

        this._texture = null;
        this._textureView = null;
        this._sampler = null;
        this._ready = false;
    }

    async initialize() {
        if (this._ready) return;

        const totalLayers = MIDNEAR_CANOPY_LAYERS + MIDNEAR_IMPOSTOR_VARIANTS;
        const size = this.textureSize;

        this._texture = this.device.createTexture({
            label: 'MidNear-CanopyAtlas',
            size: [size, size, totalLayers],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            dimension: '2d',
        });

        this._sampler = this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'nearest',
            addressModeU: 'repeat',
            addressModeV: 'repeat',
        });

        // ── Generate canopy proxy texture (layer 0) via ProceduralTextureGenerator ──
        if (this.procGen) {
            await this._generateWithProcGen(0, canopyProxyLayers(this.seed));
        } else {
            this._uploadLayer(0, this._generateCanopyLeafNoiseCPU(size, this.seed), size);
        }

        // ── Generate impostor variants (layers 1..N) ────────────────────────
        for (let v = 0; v < MIDNEAR_IMPOSTOR_VARIANTS; v++) {
            const variantSeed = this.seed + (v + 1) * 0x9E3779B9;
            if (this.procGen) {
                const rgbLayers = impostorCarveoutLayers(variantSeed, v);
                const canvas = await this._generateCanvasWithProcGen(rgbLayers);
                // Post-process: add alpha silhouette to the canvas
                const withAlpha = this._addImpostorAlpha(canvas, size, variantSeed);
                this._uploadCanvasToLayer(MIDNEAR_CANOPY_LAYERS + v, withAlpha, size);
            } else {
                this._uploadLayer(MIDNEAR_CANOPY_LAYERS + v,
                    this._generateImpostorCarveoutCPU(size, variantSeed), size);
            }
        }

        this._textureView = this._texture.createView({ dimension: '2d-array' });
        this._ready = true;

        Logger.info(
            `[MidNearTextureBaker] Baked ${totalLayers} layers @ ${size}×${size} ` +
            `(canopy=1, impostor=${MIDNEAR_IMPOSTOR_VARIANTS}) ` +
            `procGen=${this.procGen ? 'yes' : 'CPU-fallback'}`
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    // ProceduralTextureGenerator path
    // ─────────────────────────────────────────────────────────────────────

    async _generateWithProcGen(layerIndex, layers) {
        const canvas = await this._generateCanvasWithProcGen(layers);
        this._uploadCanvasToLayer(layerIndex, canvas, this.textureSize);
    }

    async _generateCanvasWithProcGen(layers) {
        const gen = this.procGen;
        const size = this.textureSize;
        gen.setSize(size, size);
        gen.configureSeamless({
            enabled: true,
            blendRadius: 16,
            blendStrength: 0.85,
            method: 'wrap',
            cornerBlend: false,
        });
        gen.clearLayers();
        for (const l of layers) gen.addLayer(l);
        return await gen.generate();
    }

    _uploadCanvasToLayer(layerIndex, canvas, size) {
        const tmpCanvas = document.createElement('canvas');
        tmpCanvas.width = size;
        tmpCanvas.height = size;
        const ctx = tmpCanvas.getContext('2d');
        ctx.drawImage(canvas, 0, 0, size, size);
        const imageData = ctx.getImageData(0, 0, size, size);
        this._uploadLayer(layerIndex, new Uint8Array(imageData.data.buffer), size);
    }



    // ─────────────────────────────────────────────────────────────────────
    // Low-level helpers
    // ─────────────────────────────────────────────────────────────────────

    _uploadLayer(layer, pixels, size) {
        this.device.queue.writeTexture(
            { texture: this._texture, origin: { x: 0, y: 0, z: layer } },
            pixels,
            { bytesPerRow: size * 4, rowsPerImage: size },
            { width: size, height: size, depthOrArrayLayers: 1 }
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    // CPU fallback generators (used when procGen is null)
    // ─────────────────────────────────────────────────────────────────────

    _generateCanopyLeafNoiseCPU(size, seed) {
        const pixels = new Uint8Array(size * size * 4);
        const noise = (x, y, s) => {
            const ix = Math.floor(x), iy = Math.floor(y);
            const fx = x - ix,       fy = y - iy;
            const h = (a, b) => {
                let v = Math.imul(a * 374761393 + b * 668265263 + s, 1274126177) >>> 0;
                v = Math.imul(v ^ (v >>> 13), 1274126177) >>> 0;
                return (v >>> 0) / 4294967296;
            };
            const w = (i) => i & (size - 1);
            const n00 = h(w(ix),   w(iy));
            const n10 = h(w(ix+1), w(iy));
            const n01 = h(w(ix),   w(iy+1));
            const n11 = h(w(ix+1), w(iy+1));
            const sx = fx * fx * (3 - 2 * fx);
            const sy = fy * fy * (3 - 2 * fy);
            return (n00*(1-sx)+n10*sx)*(1-sy) + (n01*(1-sx)+n11*sx)*sy;
        };

        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const n1 = noise(x * 8  / size * size, y * 8  / size * size, seed);
                const n2 = noise(x * 16 / size * size, y * 16 / size * size, seed + 1);
                const n3 = noise(x * 32 / size * size, y * 32 / size * size, seed + 2);
                let n = n1 * 0.5 + n2 * 0.35 + n3 * 0.15;
                n = Math.pow(n, 1.4);
                const r = Math.floor(Math.min(255, (0.25 + n * 0.5) * 255));
                const g = Math.floor(Math.min(255, (0.35 + n * 0.55) * 255));
                const b = Math.floor(Math.min(255, (0.15 + n * 0.3) * 255));
                const idx = (y * size + x) * 4;
                pixels[idx + 0] = r;
                pixels[idx + 1] = g;
                pixels[idx + 2] = b;
                pixels[idx + 3] = 255;
            }
        }
        return pixels;
    }

    _addImpostorAlpha(rgbCanvas, size, seed) {
        const outCanvas = document.createElement('canvas');
        outCanvas.width = size;
        outCanvas.height = size;
        const ctx = outCanvas.getContext('2d');
        ctx.drawImage(rgbCanvas, 0, 0, size, size);

        const imageData = ctx.getImageData(0, 0, size, size);
        const pixels = imageData.data;

        const hash = (i) => {
            let v = Math.imul(i + seed, 0x9E3779B9) >>> 0;
            v = Math.imul(v ^ (v >>> 16), 0x85EBCA6B) >>> 0;
            v = Math.imul(v ^ (v >>> 13), 0xC2B2AE35) >>> 0;
            return (v ^ (v >>> 16)) / 4294967296;
        };
        const smoothstep = (a, b, x) => {
            if (x <= a) return 0;
            if (x >= b) return 1;
            const t = (x - a) / (b - a);
            return t * t * (3 - 2 * t);
        };

        // Generate overlapping leaf clusters instead of thin strands
        const clusterCount = 8 + Math.floor(hash(7) * 6); // 8-13 clusters
        const clusters = [];
        
        for (let i = 0; i < clusterCount; i++) {
            // Vertical distribution - more clusters in middle, fewer at extremes
            const vBias = hash(100 + i);
            const baseY = 0.15 + vBias * 0.70; // Y from 0.15 to 0.85
            
            // Horizontal spread - clusters fan out from center
            const hSpread = (hash(200 + i) - 0.5) * 0.6;
            const yInfluence = (baseY - 0.5) * 0.3; // Lower clusters spread more
            const baseX = 0.5 + hSpread * (0.5 + Math.abs(yInfluence));
            
            // Cluster size varies - larger in middle
            const sizeMul = 0.8 + 0.4 * (1.0 - Math.abs(baseY - 0.5) * 2);
            const radiusX = (0.08 + hash(300 + i) * 0.10) * sizeMul;
            const radiusY = (0.06 + hash(400 + i) * 0.08) * sizeMul;
            
            // Rotation for organic feel
            const rotation = (hash(500 + i) - 0.5) * 0.8;
            
            // Density falloff
            const density = 0.6 + hash(600 + i) * 0.4;
            
            clusters.push({
                x: baseX,
                y: baseY,
                rx: radiusX,
                ry: radiusY,
                rot: rotation,
                density,
            });
        }

        // Add some thin drooping strands for the hanging birch effect
        const strandCount = 5 + Math.floor(hash(700) * 4);
        const strands = [];
        for (let i = 0; i < strandCount; i++) {
            const attachX = 0.3 + hash(800 + i) * 0.4;
            const attachY = 0.2 + hash(900 + i) * 0.3;
            strands.push({
                x: attachX,
                y: attachY,
                len: 0.25 + hash(1000 + i) * 0.35,
                width: 0.015 + hash(1100 + i) * 0.025,
                curve: (hash(1200 + i) - 0.5) * 0.15,
            });
        }

        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const u = (x + 0.5) / size;
                const v = (y + 0.5) / size;

                let alpha = 0;

                // Accumulate cluster contributions
                for (const cl of clusters) {
                    const dx = u - cl.x;
                    const dy = v - cl.y;
                    
                    // Apply rotation
                    const cosR = Math.cos(cl.rot);
                    const sinR = Math.sin(cl.rot);
                    const rx = dx * cosR + dy * sinR;
                    const ry = -dx * sinR + dy * cosR;
                    
                    // Elliptical distance
                    const d = Math.sqrt((rx / cl.rx) ** 2 + (ry / cl.ry) ** 2);
                    
                    // Soft falloff with noise for organic edge
                    const noise = hash((y * size + x) ^ (Math.floor(cl.x * 1000))) * 0.3;
                    const contribution = (1.0 - smoothstep(0.6 - noise * 0.2, 1.0 + noise * 0.1, d)) * cl.density;
                    
                    alpha = Math.max(alpha, contribution);
                }

                // Add strand contributions
                for (const st of strands) {
                    if (v < st.y) continue;
                    const t = (v - st.y) / st.len;
                    if (t > 1.0) continue;
                    
                    const curveX = st.x + st.curve * Math.sin(t * Math.PI);
                    const dx = Math.abs(u - curveX);
                    const w = st.width * (1.0 - t * 0.6);
                    
                    const strandAlpha = (1.0 - smoothstep(w, w * 2.0, dx)) * (1.0 - t * 0.5) * 0.7;
                    alpha = Math.max(alpha, strandAlpha);
                }

                // Overall envelope - oval shape
                const envX = Math.abs(u - 0.5) / 0.48;
                const envY = (v - 0.08) / 0.88;
                const envD = Math.sqrt(envX * envX * 0.7 + envY * envY * 0.5);
                const envelope = 1.0 - smoothstep(0.85, 1.1, envD);
                alpha = Math.min(1.0, alpha) * envelope;

                // Add fine noise for leaf texture
                const fineNoise = hash((y * size + x) ^ 0xA53) * 0.15;
                const edgeBand = 1.0 - smoothstep(0.3, 0.85, alpha);
                alpha = Math.max(0, Math.min(1, alpha - fineNoise * edgeBand));

                const idx = (y * size + x) * 4;
                
                // Shade RGB based on alpha for depth
                const shadeN = 0.82 + hash((y * size + x) ^ 0x71D5) * 0.28;
                const shade = (0.48 + 0.52 * alpha) * shadeN;
                pixels[idx + 0] = Math.min(255, Math.floor(pixels[idx + 0] * shade));
                pixels[idx + 1] = Math.min(255, Math.floor(pixels[idx + 1] * shade));
                pixels[idx + 2] = Math.min(255, Math.floor(pixels[idx + 2] * shade));
                pixels[idx + 3] = Math.floor(alpha * 255);
            }
        }

        ctx.putImageData(imageData, 0, 0);
        return outCanvas;
    }

    // Also replace _generateImpostorCarveoutCPU for consistency:

    _generateImpostorCarveoutCPU(size, seed) {
        const pixels = new Uint8Array(size * size * 4);
        const hash = (i) => {
            let v = Math.imul(i + seed, 0x9E3779B9) >>> 0;
            v = Math.imul(v ^ (v >>> 16), 0x85EBCA6B) >>> 0;
            v = Math.imul(v ^ (v >>> 13), 0xC2B2AE35) >>> 0;
            return (v ^ (v >>> 16)) / 4294967296;
        };
        const smoothstep = (a, b, x) => {
            if (x <= a) return 0;
            if (x >= b) return 1;
            const t = (x - a) / (b - a);
            return t * t * (3 - 2 * t);
        };

        // Same cluster-based approach as _addImpostorAlpha
        const clusterCount = 8 + Math.floor(hash(7) * 6);
        const clusters = [];
        
        for (let i = 0; i < clusterCount; i++) {
            const vBias = hash(100 + i);
            const baseY = 0.15 + vBias * 0.70;
            const hSpread = (hash(200 + i) - 0.5) * 0.6;
            const yInfluence = (baseY - 0.5) * 0.3;
            const baseX = 0.5 + hSpread * (0.5 + Math.abs(yInfluence));
            const sizeMul = 0.8 + 0.4 * (1.0 - Math.abs(baseY - 0.5) * 2);
            const radiusX = (0.08 + hash(300 + i) * 0.10) * sizeMul;
            const radiusY = (0.06 + hash(400 + i) * 0.08) * sizeMul;
            const rotation = (hash(500 + i) - 0.5) * 0.8;
            const density = 0.6 + hash(600 + i) * 0.4;
            
            clusters.push({ x: baseX, y: baseY, rx: radiusX, ry: radiusY, rot: rotation, density });
        }

        const strandCount = 5 + Math.floor(hash(700) * 4);
        const strands = [];
        for (let i = 0; i < strandCount; i++) {
            strands.push({
                x: 0.3 + hash(800 + i) * 0.4,
                y: 0.2 + hash(900 + i) * 0.3,
                len: 0.25 + hash(1000 + i) * 0.35,
                width: 0.015 + hash(1100 + i) * 0.025,
                curve: (hash(1200 + i) - 0.5) * 0.15,
            });
        }

        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const u = (x + 0.5) / size;
                const v = (y + 0.5) / size;

                let alpha = 0;

                for (const cl of clusters) {
                    const dx = u - cl.x;
                    const dy = v - cl.y;
                    const cosR = Math.cos(cl.rot);
                    const sinR = Math.sin(cl.rot);
                    const rx = dx * cosR + dy * sinR;
                    const ry = -dx * sinR + dy * cosR;
                    const d = Math.sqrt((rx / cl.rx) ** 2 + (ry / cl.ry) ** 2);
                    const noise = hash((y * size + x) ^ (Math.floor(cl.x * 1000))) * 0.3;
                    const contribution = (1.0 - smoothstep(0.6 - noise * 0.2, 1.0 + noise * 0.1, d)) * cl.density;
                    alpha = Math.max(alpha, contribution);
                }

                for (const st of strands) {
                    if (v < st.y) continue;
                    const t = (v - st.y) / st.len;
                    if (t > 1.0) continue;
                    const curveX = st.x + st.curve * Math.sin(t * Math.PI);
                    const dx = Math.abs(u - curveX);
                    const w = st.width * (1.0 - t * 0.6);
                    const strandAlpha = (1.0 - smoothstep(w, w * 2.0, dx)) * (1.0 - t * 0.5) * 0.7;
                    alpha = Math.max(alpha, strandAlpha);
                }

                const envX = Math.abs(u - 0.5) / 0.48;
                const envY = (v - 0.08) / 0.88;
                const envD = Math.sqrt(envX * envX * 0.7 + envY * envY * 0.5);
                const envelope = 1.0 - smoothstep(0.85, 1.1, envD);
                alpha = Math.min(1.0, alpha) * envelope;

                const fineNoise = hash((y * size + x) ^ 0xA53) * 0.15;
                const edgeBand = 1.0 - smoothstep(0.3, 0.85, alpha);
                alpha = Math.max(0, Math.min(1, alpha - fineNoise * edgeBand));

                const fineNoiseRGB = 0.84 + hash(y * size + x + 0x10000) * 0.30;
                const depthGrad = 0.42 + alpha * 0.58;
                const br = depthGrad * fineNoiseRGB;
                
                const idx = (y * size + x) * 4;
                pixels[idx + 0] = Math.floor(Math.min(255, br * 0.56 * 255));
                pixels[idx + 1] = Math.floor(Math.min(255, br * 0.92 * 255));
                pixels[idx + 2] = Math.floor(Math.min(255, br * 0.44 * 255));
                pixels[idx + 3] = Math.floor(alpha * 255);
            }
        }
        return pixels;
    }
    isReady() { return this._ready; }
    getTextureView() { return this._textureView; }
    getSampler() { return this._sampler; }

    dispose() {
        this._texture?.destroy();
        this._texture = null;
        this._textureView = null;
        this._sampler = null;
        this._ready = false;
    }
}
