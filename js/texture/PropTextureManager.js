// js/texture/PropTextureManager.js
//
// Procedural texture atlas for streamed instanced props (trees, grass,
// stones, etc.). Conceptually parallel to TextureAtlasManager but scoped
// to the AssetStreamer pipeline.
//
// Lifecycle:
//   1. Construct with shared ProceduralTextureGenerator instance
//   2. buildPropAtlas(definitions) — generates a texture-2d-array, one layer
//      per prop definition
//   3. getLayerIndex(propId) / getPropTexture() for shader binding
//   4. dispose()
//
// Prop definitions follow the same layer schema as terrain procedural
// textures (see textureGenerator.js layer types: fbm, voronoi, fill, etc.).

import { Texture, TextureFormat, TextureFilter, TextureWrap } from '../renderer/resources/texture.js';
import { Logger } from '../config/Logger.js';

export class PropTextureManager {
    /**
     * @param {object} options
     * @param {GPUDevice} options.gpuDevice
     * @param {import('./webgpu/textureGenerator.js').ProceduralTextureGenerator} options.proceduralTextureGenerator
     * @param {object} [options.backend]        Rendering backend (for texture upload)
     * @param {number} [options.textureSize]    Per-layer resolution (default 256)
     * @param {object} [options.seamlessConfig] Seamless blend params passed to generator
     */
    constructor(options = {}) {
        if (!options.gpuDevice) {
            throw new Error('[PropTextureManager] gpuDevice required');
        }
        if (!options.proceduralTextureGenerator) {
            throw new Error('[PropTextureManager] proceduralTextureGenerator required');
        }

        this.gpuDevice = options.gpuDevice;
        this.proceduralTextureGenerator = options.proceduralTextureGenerator;
        this._backend = options.backend || null;
        this.textureSize = options.textureSize || 256;
        this.seamlessConfig = options.seamlessConfig || null;

        this.texture = null;
        /** @type {Map<string, number>} propId → layer index */
        this._propMap = new Map();
        this._layerCount = 0;
        this._initialized = false;

        this._logTag = '[PropTextureManager]';
    }

    set backend(value) {
        this._backend = value;
        // Late-upload if buildPropAtlas() ran before backend was assigned.
        if (this._initialized && this.texture && !this.texture._gpuTexture && this._backend) {
            this._backend.createTexture(this.texture);
        }
    }
    get backend() {
        return this._backend;
    }

    /**
     * Generate a texture array from prop definitions.
     *
     * @param {Array<{id: string, layers: Array<object>}>} propDefinitions
     *        Each entry: { id, layers: [...proceduralLayerConfigs] }
     * @returns {Promise<Texture|null>}
     */
    async buildPropAtlas(propDefinitions = []) {
        if (!Array.isArray(propDefinitions) || propDefinitions.length === 0) {
            Logger.warn(`${this._logTag} buildPropAtlas: no definitions given — skipping`);
            return null;
        }

        const textureSize = this.textureSize;
        const totalLayers = propDefinitions.length;
        const bytesPerLayer = textureSize * textureSize * 4; // RGBA8
        const allLayerData = new Uint8Array(totalLayers * bytesPerLayer);

        const gen = this.proceduralTextureGenerator;
        gen.setSize(textureSize, textureSize);
        if (this.seamlessConfig && typeof gen.configureSeamless === 'function') {
            gen.configureSeamless(this.seamlessConfig);
        }

        for (let i = 0; i < propDefinitions.length; i++) {
            const def = propDefinitions[i];
            const layerOffset = i * bytesPerLayer;

            try {
                let generated = null;

                if (typeof def.generate === 'function') {
                    generated = await def.generate({
                        textureSize,
                        generator: gen,
                        seamlessConfig: this.seamlessConfig,
                    });
                } else {
                    const layers = def.layers;
                    if (!Array.isArray(layers) || layers.length === 0) {
                        this._fillFallback(allLayerData, layerOffset, textureSize, i);
                        this._propMap.set(def.id, i);
                        continue;
                    }

                    gen.clearLayers();
                    layers.forEach(l => gen.addLayer(l));
                    generated = await gen.generate();
                }

                const canvas = this._normalizeGeneratedTexture(generated, textureSize);

                // Copy generated pixels into the layer buffer slot.
                const copyCanvas = document.createElement('canvas');
                copyCanvas.width = textureSize;
                copyCanvas.height = textureSize;
                const copyCtx = copyCanvas.getContext('2d');
                copyCtx.drawImage(canvas, 0, 0);
                const imageData = copyCtx.getImageData(0, 0, textureSize, textureSize);
                allLayerData.set(new Uint8Array(imageData.data.buffer), layerOffset);

                this._propMap.set(def.id, i);
            } catch (error) {
                Logger.warn(
                    `${this._logTag} Failed to generate "${def.id}": ${error?.message || error}`
                );
                this._fillFallback(allLayerData, layerOffset, textureSize, i);
                this._propMap.set(def.id, i);
            }
        }

        this.texture = new Texture({
            width: textureSize,
            height: textureSize,
            depth: totalLayers,
            format: TextureFormat.RGBA8,
            minFilter: TextureFilter.LINEAR_MIPMAP_LINEAR,
            magFilter: TextureFilter.LINEAR,
            wrapS: TextureWrap.REPEAT,
            wrapT: TextureWrap.REPEAT,
            generateMipmaps: true,
            data: allLayerData,
            _isArray: true
        });

        this._layerCount = totalLayers;
        this._initialized = true;

        if (this._backend) {
            this._backend.createTexture(this.texture);
        }

        Logger.info(
            `${this._logTag} Built prop atlas: ${totalLayers} layers @ ${textureSize}×${textureSize}`
        );
        return this.texture;
    }

    /**
     * @param {string} propId
     * @returns {number} layer index, or -1 if not found
     */
    getLayerIndex(propId) {
        return this._propMap.get(propId) ?? -1;
    }

    /**
     * @returns {Texture|null} The 2d-array texture (null until buildPropAtlas runs)
     */
    getPropTexture() {
        return this.texture;
    }

    /** @returns {number} */
    get layerCount() {
        return this._layerCount;
    }

    /** @returns {boolean} */
    isReady() {
        return this._initialized && this.texture !== null;
    }

    dispose() {
        if (this.texture?.dispose) {
            this.texture.dispose();
        }
        this.texture = null;
        this._propMap.clear();
        this._layerCount = 0;
        this._initialized = false;
    }

    // ─────────────────────────────────────────────────────────────────────

    _fillFallback(buffer, offset, size, index) {
        // Distinct hue per layer so missing props are visible in-editor.
        const r = Math.floor((index * 137.5) % 256);
        for (let p = 0; p < size * size; p++) {
            buffer[offset + p * 4 + 0] = r;
            buffer[offset + p * 4 + 1] = 64;
            buffer[offset + p * 4 + 2] = 64;
            buffer[offset + p * 4 + 3] = 255;
        }
    }

    _normalizeGeneratedTexture(generated, textureSize) {
        if (!generated) {
            throw new Error('No generated texture returned');
        }

        const isHtmlCanvas = typeof HTMLCanvasElement !== 'undefined' && generated instanceof HTMLCanvasElement;
        const isOffscreen = typeof OffscreenCanvas !== 'undefined' && generated instanceof OffscreenCanvas;
        if (isHtmlCanvas || isOffscreen) {
            return generated;
        }

        if (generated.data && generated.width === textureSize && generated.height === textureSize) {
            const canvas = document.createElement('canvas');
            canvas.width = textureSize;
            canvas.height = textureSize;
            const ctx = canvas.getContext('2d');
            const imageData = new ImageData(
                generated.data instanceof Uint8ClampedArray
                    ? generated.data
                    : new Uint8ClampedArray(generated.data),
                generated.width,
                generated.height
            );
            ctx.putImageData(imageData, 0, 0);
            return canvas;
        }

        throw new Error('Unsupported generated texture payload');
    }
}
