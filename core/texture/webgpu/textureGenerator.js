import { proceduralNoiseShader } from "./shaders/proceduralNoise.wgsl.js";


export function getAllProceduralVariantsForLevel(level, textureConfig, seasons) {
    if (!textureConfig) {
        throw new Error('getAllProceduralVariantsForLevel requires textureConfig');
    }
    if (!seasons) {
        throw new Error('getAllProceduralVariantsForLevel requires seasons');
    }
    const variants = [];

    for (const entry of textureConfig) {
        if (!entry.textures?.base) continue;

        for (const season of Object.values(seasons)) {
            const seasonCfg = entry.textures.base[season];
            if (!seasonCfg || !seasonCfg[level]) continue;

            const layerSets = seasonCfg[level];
            for (let variantIdx = 0; variantIdx < layerSets.length; variantIdx++) {
                variants.push({
                    tileType: entry.id,
                    season,
                    variant: variantIdx,  
                    level,
                    layers: layerSets[variantIdx],
                });
            }
        }
    }

    return variants;
}

export class ProceduralTextureGenerator {
    constructor(device, width = 128, height = 128) {
        this.device = device;
        this.width = width;
        this.height = height;
        this.layers = [];
        this.initialized = false;
    
        this.canvas = document.createElement('canvas');
        this.canvas.width = width;
        this.canvas.height = height;
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

        this.seamlessConfig = {
            enabled: true,
            blendRadius: 4,          // pixels from edge to blend
            blendStrength: 1.0,       // 0-1, how much to blend
            method: 'quad-symmetric', // 'quad-symmetric', 'wrap', 'mirror', 'fade'
            cornerBlend: true         // blend corners to match all 4 edges
        };
    }
    
    /**
 * Resize the generator's output. Safe to call before or after initialize().
 * If the size is unchanged, this is a no-op. GPU pipeline resources (shader
 * module, pipeline, bind-group layout) are preserved — only the output
 * texture and canvas are recreated.
 *
 * @param {number} width
 * @param {number} height
 */
setSize(width, height) {
    if (this.width === width && this.height === height) return;

    this.width = width;
    this.height = height;

    // Resize canvas (getContext returns the same ctx after resize)
    if (this.canvas) {
        this.canvas.width = width;
        this.canvas.height = height;
    }

    // Recreate GPU output texture only if initialize() already ran.
    if (this.initialized && this.outputTexture) {
        this.outputTexture.destroy();
        this.outputTexture = this.device.createTexture({
            size: [this.width, this.height],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.STORAGE_BINDING |
                   GPUTextureUsage.COPY_SRC |
                   GPUTextureUsage.TEXTURE_BINDING
        });
    }
}

    _makeSeamless(canvas, config = this.seamlessConfig) {
        if (!config?.enabled) return canvas;
    
        const ctx = canvas.getContext('2d');
        const width = canvas.width;
        const height = canvas.height;
        const maxRadius = Math.min(width, height);
        const radius = Math.max(0, Math.min(Math.floor(config.blendRadius ?? 0), maxRadius));
        const strength = Number.isFinite(config.blendStrength)
            ? Math.min(1, Math.max(0, config.blendStrength))
            : 1.0;
        if (radius < 1 || strength <= 0) return canvas;
    
        // Get the full image data
        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;
    
        // Create a copy for reading original values
        const originalData = new Uint8ClampedArray(data);
    
        if (config.method === 'quad-symmetric') {
            // All 4 edges must match for 90° rotation invariance
            this._makeQuadSymmetric(data, originalData, width, height, radius, strength, config.cornerBlend);
        } else if (config.method === 'wrap') {
            this._wrapEdges(data, originalData, width, height, radius, strength);
        } else if (config.method === 'mirror') {
            this._mirrorEdges(data, originalData, width, height, radius, strength);
        } else if (config.method === 'fade') {
            this._fadeEdges(data, originalData, width, height, radius, strength);
        }
    
        ctx.putImageData(imageData, 0, 0);
        return canvas;
    }
    
    // NEW: Quad-symmetric tiling for 90° rotation invariance
    _makeQuadSymmetric(data, original, width, height, radius, strength, blendCorners = true) {
        // Strategy: Average all 4 edges together, then blend each edge to this average
        // This ensures any 90° rotation looks identical at the seams
    
        // Step 1: Calculate average edge profile
        const avgEdge = this._calculateAverageEdgeProfile(original, width, height, radius);
    
        // Step 2: Blend each edge toward this average
        this._blendEdgeToProfile(data, original, width, height, radius, strength, avgEdge, 'top');
        this._blendEdgeToProfile(data, original, width, height, radius, strength, avgEdge, 'bottom');
        this._blendEdgeToProfile(data, original, width, height, radius, strength, avgEdge, 'left');
        this._blendEdgeToProfile(data, original, width, height, radius, strength, avgEdge, 'right');
    
        // Step 3: Blend corners to ensure continuity
        if (blendCorners) {
            this._blendCorners(data, original, width, height, radius, strength);
        }
    }
    
    // Calculate the average color profile across all 4 edges
    _calculateAverageEdgeProfile(data, width, height, radius) {
        const profile = [];
        
        // We'll create a 1D array of averaged colors
        // Since edges can be different lengths, we normalize to a fixed sample count
        const sampleCount = Math.max(width, height);
        
        for (let i = 0; i < sampleCount; i++) {
            let r = 0, g = 0, b = 0, a = 0, count = 0;
            
            // Sample from all 4 edges at proportional positions
            const t = i / sampleCount;
            
            // Top edge
            const topX = Math.floor(t * width);
            const topIdx = (0 * width + topX) * 4;
            r += data[topIdx]; g += data[topIdx + 1]; b += data[topIdx + 2]; a += data[topIdx + 3];
            count++;
            
            // Bottom edge
            const bottomX = Math.floor(t * width);
            const bottomIdx = ((height - 1) * width + bottomX) * 4;
            r += data[bottomIdx]; g += data[bottomIdx + 1]; b += data[bottomIdx + 2]; a += data[bottomIdx + 3];
            count++;
            
            // Left edge
            const leftY = Math.floor(t * height);
            const leftIdx = (leftY * width + 0) * 4;
            r += data[leftIdx]; g += data[leftIdx + 1]; b += data[leftIdx + 2]; a += data[leftIdx + 3];
            count++;
            
            // Right edge
            const rightY = Math.floor(t * height);
            const rightIdx = (rightY * width + (width - 1)) * 4;
            r += data[rightIdx]; g += data[rightIdx + 1]; b += data[rightIdx + 2]; a += data[rightIdx + 3];
            count++;
            
            profile.push({
                r: r / count,
                g: g / count,
                b: b / count,
                a: a / count
            });
        }
        
        return profile;
    }
    
    // Blend a specific edge toward the average profile
    _blendEdgeToProfile(data, original, width, height, radius, strength, profile, edge) {
        const smoothstep = (t) => t * t * (3 - 2 * t);
        
        if (edge === 'top' || edge === 'bottom') {
            const isTop = edge === 'top';
            
            for (let dy = 0; dy < radius; dy++) {
                const blend = smoothstep(dy / radius); // 0 at edge, 1 at radius
                const blendToTarget = (1 - blend) * strength;
                const y = isTop ? dy : height - 1 - dy;
                
                for (let x = 0; x < width; x++) {
                    const idx = (y * width + x) * 4;
                    const t = x / width;
                    const profileIdx = Math.floor(t * profile.length);
                    const target = profile[profileIdx];
                    
                    // Blend original color toward average edge profile
                    data[idx + 0] = original[idx + 0] * (1 - blendToTarget) + target.r * blendToTarget;
                    data[idx + 1] = original[idx + 1] * (1 - blendToTarget) + target.g * blendToTarget;
                    data[idx + 2] = original[idx + 2] * (1 - blendToTarget) + target.b * blendToTarget;
                    data[idx + 3] = original[idx + 3] * (1 - blendToTarget) + target.a * blendToTarget;
                }
            }
        } else {
            const isLeft = edge === 'left';
            
            for (let dx = 0; dx < radius; dx++) {
                const blend = smoothstep(dx / radius);
                const blendToTarget = (1 - blend) * strength;
                const x = isLeft ? dx : width - 1 - dx;
                
                for (let y = 0; y < height; y++) {
                    const idx = (y * width + x) * 4;
                    const t = y / height;
                    const profileIdx = Math.floor(t * profile.length);
                    const target = profile[profileIdx];
                    
                    data[idx + 0] = original[idx + 0] * (1 - blendToTarget) + target.r * blendToTarget;
                    data[idx + 1] = original[idx + 1] * (1 - blendToTarget) + target.g * blendToTarget;
                    data[idx + 2] = original[idx + 2] * (1 - blendToTarget) + target.b * blendToTarget;
                    data[idx + 3] = original[idx + 3] * (1 - blendToTarget) + target.a * blendToTarget;
                }
            }
        }
    }
    
    // Blend corners to ensure smooth transitions where edges meet
    _blendCorners(data, original, width, height, radius, strength) {
        const smoothstep = (t) => t * t * (3 - 2 * t);
        
        const corners = [
            { x: 0, y: 0, xDir: 1, yDir: 1 },           // Top-left
            { x: width - 1, y: 0, xDir: -1, yDir: 1 },  // Top-right
            { x: 0, y: height - 1, xDir: 1, yDir: -1 }, // Bottom-left
            { x: width - 1, y: height - 1, xDir: -1, yDir: -1 } // Bottom-right
        ];
        
        for (const corner of corners) {
            for (let dy = 0; dy < radius; dy++) {
                for (let dx = 0; dx < radius; dx++) {
                    const x = corner.x + dx * corner.xDir;
                    const y = corner.y + dy * corner.yDir;
                    
                    if (x < 0 || x >= width || y < 0 || y >= height) continue;
                    
                    const idx = (y * width + x) * 4;
                    
                    // Distance from corner (normalized)
                    const distX = dx / radius;
                    const distY = dy / radius;
                    const dist = Math.sqrt(distX * distX + distY * distY);
                    
                    if (dist >= 1.0) continue;
                    
                    // Blend factor: stronger near corner, weaker toward interior
                    const blendFactor = (1.0 - smoothstep(dist)) * strength;
                    
                    // Sample adjacent edge pixels for averaging
                    const samples = [];
                    
                    // Horizontal edge neighbor
                    const hx = corner.x;
                    const hy = y;
                    if (hx >= 0 && hx < width && hy >= 0 && hy < height) {
                        const hidx = (hy * width + hx) * 4;
                        samples.push([data[hidx], data[hidx + 1], data[hidx + 2], data[hidx + 3]]);
                    }
                    
                    // Vertical edge neighbor
                    const vx = x;
                    const vy = corner.y;
                    if (vx >= 0 && vx < width && vy >= 0 && vy < height) {
                        const vidx = (vy * width + vx) * 4;
                        samples.push([data[vidx], data[vidx + 1], data[vidx + 2], data[vidx + 3]]);
                    }
                    
                    if (samples.length === 0) continue;
                    
                    // Average the samples
                    let avgR = 0, avgG = 0, avgB = 0, avgA = 0;
                    for (const s of samples) {
                        avgR += s[0]; avgG += s[1]; avgB += s[2]; avgA += s[3];
                    }
                    const count = samples.length;
                    avgR /= count; avgG /= count; avgB /= count; avgA /= count;
                    
                    // Blend current pixel toward average
                    data[idx + 0] = data[idx + 0] * (1 - blendFactor) + avgR * blendFactor;
                    data[idx + 1] = data[idx + 1] * (1 - blendFactor) + avgG * blendFactor;
                    data[idx + 2] = data[idx + 2] * (1 - blendFactor) + avgB * blendFactor;
                    data[idx + 3] = data[idx + 3] * (1 - blendFactor) + avgA * blendFactor;
                }
            }
        }
    }
    
    _mirrorEdges(data, original, width, height, radius, strength) {
        // Top and bottom edges
        for (let y = 0; y < radius; y++) {
            const blend = y / radius; // 0 at edge, 1 at radius
            const blendToMirror = (1 - blend) * strength;
            for (let x = 0; x < width; x++) {
                // Top edge
                const topIdx = (y * width + x) * 4;
                const mirrorTopIdx = ((radius - y) * width + x) * 4;
                
                // Bottom edge
                const bottomIdx = ((height - 1 - y) * width + x) * 4;
                const mirrorBottomIdx = ((height - 1 - radius + y) * width + x) * 4;
    
                for (let c = 0; c < 4; c++) {
                    // Blend top
                    data[topIdx + c] = original[topIdx + c] * (1 - blendToMirror) + 
                                       original[mirrorTopIdx + c] * blendToMirror;
                    // Blend bottom
                    data[bottomIdx + c] = original[bottomIdx + c] * (1 - blendToMirror) + 
                                          original[mirrorBottomIdx + c] * blendToMirror;
                }
            }
        }
    
        // Left and right edges
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < radius; x++) {
                const blend = x / radius;
                const blendToMirror = (1 - blend) * strength;
                
                // Left edge
                const leftIdx = (y * width + x) * 4;
                const mirrorLeftIdx = (y * width + (radius - x)) * 4;
                
                // Right edge
                const rightIdx = (y * width + (width - 1 - x)) * 4;
                const mirrorRightIdx = (y * width + (width - 1 - radius + x)) * 4;
    
                for (let c = 0; c < 4; c++) {
                    // Blend left
                    data[leftIdx + c] = original[leftIdx + c] * (1 - blendToMirror) + 
                                        original[mirrorLeftIdx + c] * blendToMirror;
                    // Blend right
                    data[rightIdx + c] = original[rightIdx + c] * (1 - blendToMirror) + 
                                         original[mirrorRightIdx + c] * blendToMirror;
                }
            }
        }
    }
    
    _wrapEdges(data, original, width, height, radius, strength) {
        // Top/Bottom wrapping with blend
        for (let y = 0; y < radius; y++) {
            const blend = y / radius;
            const blendToWrap = (1 - blend) * strength;
            for (let x = 0; x < width; x++) {
                // Top edge blends with bottom
                const topIdx = (y * width + x) * 4;
                const wrapTopIdx = ((height - radius + y) * width + x) * 4;
                
                // Bottom edge blends with top
                const bottomIdx = ((height - 1 - y) * width + x) * 4;
                const wrapBottomIdx = ((radius - 1 - y) * width + x) * 4;
    
                for (let c = 0; c < 4; c++) {
                    data[topIdx + c] = original[topIdx + c] * (1 - blendToWrap) + 
                                       original[wrapTopIdx + c] * blendToWrap;
                    data[bottomIdx + c] = original[bottomIdx + c] * (1 - blendToWrap) + 
                                          original[wrapBottomIdx + c] * blendToWrap;
                }
            }
        }
    
        // Left/Right wrapping with blend
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < radius; x++) {
                const blend = x / radius;
                const blendToWrap = (1 - blend) * strength;
                
                // Left edge blends with right
                const leftIdx = (y * width + x) * 4;
                const wrapLeftIdx = (y * width + (width - radius + x)) * 4;
                
                // Right edge blends with left
                const rightIdx = (y * width + (width - 1 - x)) * 4;
                const wrapRightIdx = (y * width + (radius - 1 - x)) * 4;
    
                for (let c = 0; c < 4; c++) {
                    data[leftIdx + c] = original[leftIdx + c] * (1 - blendToWrap) + 
                                        original[wrapLeftIdx + c] * blendToWrap;
                    data[rightIdx + c] = original[rightIdx + c] * (1 - blendToWrap) + 
                                         original[wrapRightIdx + c] * blendToWrap;
                }
            }
        }
    }
    
    _fadeEdges(data, original, width, height, radius, strength) {
        // Calculate average edge colors
        const avgTop = this._getAverageEdgeColor(original, width, height, 'top', radius);
        const avgBottom = this._getAverageEdgeColor(original, width, height, 'bottom', radius);
        const avgLeft = this._getAverageEdgeColor(original, width, height, 'left', radius);
        const avgRight = this._getAverageEdgeColor(original, width, height, 'right', radius);
    
        // Fade edges
        for (let y = 0; y < radius; y++) {
            const blend = (1 - (y / radius)) * strength;
            for (let x = 0; x < width; x++) {
                // Top
                const topIdx = (y * width + x) * 4;
                for (let c = 0; c < 4; c++) {
                    data[topIdx + c] = original[topIdx + c] * (1 - blend) + avgTop[c] * blend;
                }
                // Bottom
                const bottomIdx = ((height - 1 - y) * width + x) * 4;
                for (let c = 0; c < 4; c++) {
                    data[bottomIdx + c] = original[bottomIdx + c] * (1 - blend) + avgBottom[c] * blend;
                }
            }
        }
    
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < radius; x++) {
                const blend = (1 - (x / radius)) * strength;
                // Left
                const leftIdx = (y * width + x) * 4;
                for (let c = 0; c < 4; c++) {
                    data[leftIdx + c] = original[leftIdx + c] * (1 - blend) + avgLeft[c] * blend;
                }
                // Right
                const rightIdx = (y * width + (width - 1 - x)) * 4;
                for (let c = 0; c < 4; c++) {
                    data[rightIdx + c] = original[rightIdx + c] * (1 - blend) + avgRight[c] * blend;
                }
            }
        }
    }
    
    _getAverageEdgeColor(data, width, height, edge, radius) {
        let r = 0, g = 0, b = 0, a = 0, count = 0;
        
        if (edge === 'top' || edge === 'bottom') {
            const y = edge === 'top' ? radius : height - radius - 1;
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                r += data[idx]; g += data[idx + 1]; b += data[idx + 2]; a += data[idx + 3];
                count++;
            }
        } else {
            const x = edge === 'left' ? radius : width - radius - 1;
            for (let y = 0; y < height; y++) {
                const idx = (y * width + x) * 4;
                r += data[idx]; g += data[idx + 1]; b += data[idx + 2]; a += data[idx + 3];
                count++;
            }
        }
        
        return [r / count, g / count, b / count, a / count];
    }
    
    // Add configuration method
    configureSeamless(options) {
        this.seamlessConfig = { ...this.seamlessConfig, ...options };
    }
    async initialize() {
        if (this.initialized) return;

        this.outputTexture = this.device.createTexture({
            size: [this.width, this.height],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.STORAGE_BINDING |
                   GPUTextureUsage.COPY_SRC |
                   GPUTextureUsage.TEXTURE_BINDING
        });

        this.uniformBuffer = this.device.createBuffer({
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        await this._createPipelines();
        this.initialized = true;
    }

    async _createPipelines() {
        const noiseShader = this._createNoiseShader();
        this.noiseModule = this.device.createShaderModule({
            label: 'Procedural Noise Shader',
            code: noiseShader
        });

        const info = await this.noiseModule.getCompilationInfo();
        if (info.messages.length > 0) {
            for (const msg of info.messages) {
                if (msg.type === 'error') {
                    
                }
            }
        }

        this.bindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: 'uniform' }
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: {
                        access: 'write-only',
                        format: 'rgba8unorm',
                        viewDimension: '2d'
                    }
                }
            ]
        });

        this.pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [this.bindGroupLayout]
        });

        this.noisePipeline = this.device.createComputePipeline({
            layout: this.pipelineLayout,
            compute: {
                module: this.noiseModule,
                entryPoint: 'main'
            }
        });
    }

    _createNoiseShader() {
        return proceduralNoiseShader;
    }

    addLayer(config) {
        this.layers.push(Object.assign({}, config));
    }

    removeLayer(idx) {
        this.layers.splice(idx, 1);
    }

    clearLayers() {
        this.layers.length = 0;
    }

    async generate() {
        if (this._busy) {
            throw new Error(
                'ProceduralTextureGenerator.generate() called while another ' +
                'generation is in progress. Generator is not reentrant.'
            );
        }
        this._busy = true;
        try {
            if (!this.initialized) {
                await this.initialize();
            }


            this.ctx.clearRect(0, 0, this.width, this.height);
            this.ctx.fillStyle = 'black';

            for (const layer of this.layers) {
                if (layer.type === 'fill') {
                    this.ctx.fillStyle = layer.color || '#ffffff';
                    this.ctx.globalAlpha = layer.opacity || 1.0;
                    this.ctx.fillRect(0, 0, this.width, this.height);
                    this.ctx.globalAlpha = 1.0;
                    continue;
                }

                if (layer.type === 'leaf_cluster_mask') {
                    const maskCanvas = this._generateLeafClusterMask(layer);
                    this._compositeLayerCanvas(maskCanvas, layer);
                    continue;
                }

                if (layer.type === 'custom_leaf_shape') {
                    const leafCanvas = this._generateLeafShapeCPU(layer);
                    this._compositeLayerCanvas(leafCanvas, layer);
                    continue;
                }

                if (layer.type === 'grass_billboard') {
                    const billboardCanvas = this._generateGrassBillboard(layer);
                    this._compositeLayerCanvas(billboardCanvas, layer);
                    continue;
                }

                if (layer.type === 'horizontal_dashes') {
                    const dashCanvas = this._generateDashesCPU(layer);
                    this._compositeLayerCanvas(dashCanvas, layer);
                    continue;
                }

                if (this._isAdvancedPixelLayerType(layer.type)) {
                    this._processAdvancedPixelLayerCPU(layer);
                    continue;
                }

                await this._renderNoiseLayer(layer);
                await this._compositeGPUToCanvas(layer);
            }
            this._makeSeamless(this.canvas, this.seamlessConfig);
            return this.canvas;
        } finally {
            this._busy = false;
        }
    }

    async _renderNoiseLayer(layer) {
        const uniformData = new ArrayBuffer(256);
        const view = new DataView(uniformData);
    
        // Offsets 0-63 stay the same...
        view.setFloat32(0, this.width, true);
        view.setFloat32(4, this.height, true);
        view.setFloat32(8, layer.seed || 0, true);
        view.setInt32(12, this._noiseTypeIndex(layer.type), true);
    
        view.setInt32(16, layer.octaves || 4, true);
        view.setFloat32(20, layer.frequency || 0.01, true);
        view.setFloat32(24, layer.amplitude || 1.0, true);
        view.setFloat32(28, layer.persistence || 0.5, true);
    
        view.setFloat32(32, (layer.rotation || 0) * Math.PI / 180, true);
        view.setFloat32(36, layer.turbulencePower || 1.0, true);
        view.setFloat32(40, layer.ridgeOffset || 0.5, true);
        view.setFloat32(44, layer.domainWarp ? (layer.warpStrength || 0) : 0, true);
    
        view.setFloat32(48, layer.warpFrequency || 0.02, true);
        view.setFloat32(52, layer.cellScale || 1.0, true);
        view.setFloat32(56, layer.cellRandomness || 1.0, true);
        view.setFloat32(60, layer.cellElongation || 0.5, true);
    
        // offset 64: _pad (can skip or set to 0)
        view.setFloat32(64, 0.0, true);
        
        // offset 68: implicit padding (skip)
        const stretch = layer.cellStretch || [1.0, 1.0];
        view.setFloat32(72, stretch[0], true);  // cellStretch.x at 72
        view.setFloat32(76, stretch[1], true);  // cellStretch.y at 76
    
        const { r, g, b } = this._hexToRgb(layer.color || '#ffffff');
        view.setFloat32(80, r / 255, true);     // color.r at 80
        view.setFloat32(84, g / 255, true);     // color.g at 84
        view.setFloat32(88, b / 255, true);     // color.b at 88
    
        this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);
        

        const bindGroup = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer } },
                { binding: 1, resource: this.outputTexture.createView() }
            ]
        });

        const commandEncoder = this.device.createCommandEncoder();
        const passEncoder = commandEncoder.beginComputePass();

        passEncoder.setPipeline(this.noisePipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.dispatchWorkgroups(
            Math.ceil(this.width / 8),
            Math.ceil(this.height / 8)
        );
        passEncoder.end();

        this.device.queue.submit([commandEncoder.finish()]);
        await this.device.queue.onSubmittedWorkDone();
    }

    async _compositeGPUToCanvas(layer) {
        const bytesPerRow = Math.ceil(this.width * 4 / 256) * 256;
        const bufferSize = bytesPerRow * this.height;

        const readBuffer = this.device.createBuffer({
            size: bufferSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });

        const commandEncoder = this.device.createCommandEncoder();
        commandEncoder.copyTextureToBuffer(
            { texture: this.outputTexture },
            { buffer: readBuffer, bytesPerRow: bytesPerRow },
            { width: this.width, height: this.height, depthOrArrayLayers: 1 }
        );

        this.device.queue.submit([commandEncoder.finish()]);

        await readBuffer.mapAsync(GPUMapMode.READ);
        const arrayBuffer = readBuffer.getMappedRange();

        const data = new Uint8ClampedArray(this.width * this.height * 4);
        const src = new Uint8Array(arrayBuffer);

        for (let y = 0; y < this.height; y++) {
            const srcRowStart = y * bytesPerRow;
            const dstRowStart = y * this.width * 4;
            for (let x = 0; x < this.width * 4; x++) {
                data[dstRowStart + x] = src[srcRowStart + x];
            }
        }

        readBuffer.unmap();
        readBuffer.destroy();
        
        // === DIAGNOSTIC: Sample first 32 pixels ===
        const samplePixels = [];
        for (let i = 0; i < 32; i++) {
            const r = data[i * 4 + 0];
            const g = data[i * 4 + 1];
            const b = data[i * 4 + 2];
            const a = data[i * 4 + 3];
            samplePixels.push(`[${r},${g},${b},${a}]`);
        }
        
        const imageData = new ImageData(data, this.width, this.height);

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = this.width;
        tempCanvas.height = this.height;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.putImageData(imageData, 0, 0);

        this._compositeLayerCanvas(tempCanvas, layer);
    }

    _compositeLayerCanvas(layerCanvas, layer) {
        const ctx = this.ctx;
        const prevGlobalCompositeOperation = ctx.globalCompositeOperation;
        const prevAlpha = ctx.globalAlpha;

        ctx.globalAlpha = (typeof layer.opacity === 'number') ? layer.opacity : 1.0;
        ctx.globalCompositeOperation = this._blendModeToCompositeOp(layer.blendMode);

        ctx.drawImage(layerCanvas, 0, 0, this.width, this.height);

        ctx.globalCompositeOperation = prevGlobalCompositeOperation;
        ctx.globalAlpha = prevAlpha;
    }

    _generateLeafClusterMask(layer) {
        const c = document.createElement('canvas');
        c.width = this.width;
        c.height = this.height;
        const ctx = c.getContext('2d');
        ctx.clearRect(0, 0, this.width, this.height);

        const clusterCount = layer.clusterCount ?? 6;
        const minScale = layer.minScale ?? 0.5;
        const maxScale = layer.maxScale ?? 1.0;

        for (let i = 0; i < clusterCount; i++) {
            const scale = minScale + Math.random() * (maxScale - minScale);
            const w = this.width * 0.25 * scale;
            const h = this.height * 0.33 * scale;
            const cx = Math.random() * this.width;
            const cy = Math.random() * this.height;
            const rotation = (Math.random() - 0.5) * Math.PI * 0.8;

            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(rotation);

            ctx.beginPath();
            ctx.moveTo(0, -h);
            for (let t = 0; t <= 20; t++) {
                const tt = t / 20;
                const bx = -w * Math.sin(tt * Math.PI) * (1 - tt * 0.3);
                const by = -h + h * 1.8 * tt;
                ctx.lineTo(bx, by);
            }
            for (let t = 20; t >= 0; t--) {
                const tt = t / 20;
                const bx = w * Math.sin(tt * Math.PI) * (1 - tt * 0.3);
                const by = -h + h * 1.8 * tt;
                ctx.lineTo(bx, by);
            }
            ctx.closePath();

            const g = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(w, h));
            g.addColorStop(0, 'rgba(255,255,255,1)');
            g.addColorStop(0.8, 'rgba(255,255,255,1)');
            g.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = g;
            ctx.fill();

            ctx.restore();
        }

        return c;
    }

    _generateLeafShapeCPU(layer) {
        const c = document.createElement('canvas');
        c.width = this.width;
        c.height = this.height;
        const ctx = c.getContext('2d');

        ctx.clearRect(0, 0, this.width, this.height);

        const shape = layer.shape || 'oak';
        ctx.fillStyle = 'rgba(255,255,255,1)';

        if (shape === 'birch') {
            for (let i = 0; i < 4; i++) {
                const scale = 0.6 + Math.random() * 0.4;
                const w = this.width * 0.3 * scale;
                const h = this.height * 0.45 * scale;
                const cx = this.width / 2 + (Math.random() - 0.5) * this.width * 0.25;
                const cy = this.height / 2 + (Math.random() - 0.5) * this.height * 0.25;
                ctx.save();
                ctx.translate(cx, cy);
                ctx.rotate((Math.random() - 0.5) * 0.8);
                ctx.beginPath();
                ctx.moveTo(0, -h);
                for (let t = 0; t <= 20; t++) {
                    const tt = t / 20;
                    const bx = -w * Math.sin(tt * Math.PI) * (1 - tt * 0.3);
                    const by = -h + h * 1.8 * tt;
                    ctx.lineTo(bx, by);
                }
                for (let t = 20; t >= 0; t--) {
                    const tt = t / 20;
                    const bx = w * Math.sin(tt * Math.PI) * (1 - tt * 0.3);
                    const by = -h + h * 1.8 * tt;
                    ctx.lineTo(bx, by);
                }
                ctx.closePath();
                const g = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(w, h));
                g.addColorStop(0, 'rgba(255,255,255,1)');
                g.addColorStop(0.8, 'rgba(255,255,255,1)');
                g.addColorStop(1, 'rgba(255,255,255,0)');
                ctx.fillStyle = g;
                ctx.fill();
                ctx.restore();
            }
        } else {
            ctx.beginPath();
            ctx.ellipse(this.width / 2, this.height / 2, this.width * 0.35, this.height * 0.4, 0, 0, Math.PI * 2);
            const g = ctx.createRadialGradient(this.width / 2, this.height / 2, 0, this.width / 2, this.height / 2, Math.max(this.width, this.height));
            g.addColorStop(0, 'rgba(255,255,255,1)');
            g.addColorStop(0.8, 'rgba(255,255,255,1)');
            g.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = g;
            ctx.fill();
        }

        return c;
    }

    _generateDashesCPU(layer) {
        const c = document.createElement('canvas');
        c.width = this.width;
        c.height = this.height;
        const ctx = c.getContext('2d');
        ctx.clearRect(0, 0, this.width, this.height);

        const density = layer.density ?? 0.15;
        const minWidth = layer.minWidth ?? 0.15;
        const maxWidth = layer.maxWidth ?? 0.35;
        const minHeight = layer.minHeight ?? 0.02;
        const maxHeight = layer.maxHeight ?? 0.06;
        const seed = layer.seed ?? 0;
        const { r, g, b } = this._hexToRgb(layer.color || '#2a2a2a');

        const referenceSize = 128;
        const sizeScale = (this.width * this.height) / (referenceSize * referenceSize);
        const numDashes = Math.min(256, Math.floor(density * 100 * sizeScale));

        const rand = (x, y, seedOffset) => {
            const pm_x = x % 2048.0;
            const pm_y = y % 2048.0;
            const s = Math.sin(pm_x * 127.1 + pm_y * 311.7 + ((seed + seedOffset) * 13.13) % 2048.0) * 43758.5453123;
            return s - Math.floor(s);
        };

        for (let i = 0; i < numDashes; i++) {
            const x = rand(i, 0, 1) * this.width;
            const y = rand(i, 1, 2) * this.height;
            const w = (minWidth + rand(i, 2, 3) * (maxWidth - minWidth)) * this.width;
            const h = (minHeight + rand(i, 3, 4) * (maxHeight - minHeight)) * this.height;
            const rotation = (rand(i, 4, 5) - 0.5) * 0.2;
            const alpha = 0.5 + rand(i, 12, 13) * 0.5;

            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(rotation);
            ctx.globalAlpha = alpha;
            ctx.fillStyle = `rgb(${r},${g},${b})`;
            ctx.beginPath();
            ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }

        ctx.globalAlpha = 1.0;
        return c;
    }

    _generateGrassBillboard(layer) {
        const c = document.createElement('canvas');
        c.width = this.width;
        c.height = this.height;
        const ctx = c.getContext('2d');

        ctx.clearRect(0, 0, this.width, this.height);

        const grassType = layer.grassType || 'meadow';
        const height = layer.height || 0.6;
        const density = layer.density || 'medium';
        const seed = layer.seed || 12345;

        let rngSeed = seed;
        const seededRandom = () => {
            rngSeed = (rngSeed * 9301 + 49297) % 233280;
            return rngSeed / 233280;
        };

        const grassColors = this._getGrassColors(grassType);
        const densityMap = { 'high': 25, 'medium': 15, 'low': 8 };
        const bladeCount = densityMap[density] || 15;

        for (let i = 0; i < bladeCount; i++) {
            this._drawGrassBlade(ctx, {
                x: seededRandom() * this.width,
                y: this.height * 0.8 + seededRandom() * this.height * 0.2,
                height: height * this.height * (0.7 + seededRandom() * 0.6),
                width: 2 + seededRandom() * 4,
                bend: (seededRandom() - 0.5) * 0.3,
                color: grassColors[Math.floor(seededRandom() * grassColors.length)],
                rng: seededRandom
            });
        }

        return c;
    }

    _getGrassColors(grassType) {
        const colorSets = {
            meadow: ['#4a7c2a', '#5a8c3a', '#6fa040', '#3d6b25'],
            tall: ['#3d6b25', '#2d5b15', '#5d8b35', '#4a7c2a'],
            short: ['#4f7d30', '#6f9d50', '#7fa055', '#5a8c3a'],
            wild: ['#456728', '#65873a', '#6b4423', '#4a7c2a']
        };
        return colorSets[grassType] || colorSets.meadow;
    }

    _drawGrassBlade(ctx, params) {
        const { x, y, height, width, bend, color, rng } = params;

        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        ctx.beginPath();
        ctx.moveTo(x, y);

        const segments = 4;
        for (let i = 1; i <= segments; i++) {
            const t = i / segments;
            const bendAmount = bend * t * t;
            const segmentX = x + bendAmount * height * 0.3;
            const segmentY = y - (height * t);

            const variation = (rng() - 0.5) * width * 0.3;

            if (i === segments) {
                ctx.lineWidth = width * 0.3;
            }

            ctx.lineTo(segmentX + variation, segmentY);
        }

        ctx.stroke();
        ctx.restore();
    }

    _isAdvancedPixelLayerType(type) {
        return type === 'vertical_stripe' ||
            type === 'pinnate_veins' ||
            type === 'radial_gradient' ||
            type === 'fbm_normal' ||
            type === 'vertical_stripe_normal' ||
            type === 'pinnate_veins_normal';
    }

    _processAdvancedPixelLayerCPU(layer) {
        const imageData = this.ctx.getImageData(0, 0, this.width, this.height);
        const pixels = imageData.data;
        this._applyAdvancedLayerToPixels(layer, pixels, this.width, this.height);
        this.ctx.putImageData(imageData, 0, 0);
    }

    _applyAdvancedLayerToPixels(layer, pixels, width, height) {
        switch (layer.type) {
            case 'vertical_stripe': {
                const cx = (layer.centerX ?? 0.5) * width;
                const hw = (layer.width ?? 0.05) * width * 0.5;
                const feather = Math.max(0.0001, (layer.feather ?? 0.02) * width);
                const c = this._hexToRgb(layer.color || '#ffffff');
                const rgb = [c.r, c.g, c.b];

                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        const dist = Math.abs(x - cx);
                        let t = 0.0;
                        if (dist <= hw) {
                            t = 1.0;
                        } else if (dist <= hw + feather) {
                            t = 1.0 - (dist - hw) / feather;
                            t = t * t * (3 - 2 * t);
                        }
                        const alpha = t * (layer.opacity ?? 1.0);
                        if (alpha > 0) {
                            this._blendPixel(pixels, x, y, width, rgb, alpha, layer.blendMode);
                        }
                    }
                }
                break;
            }
            case 'pinnate_veins': {
                const veinCount = layer.veinCount ?? 7;
                const yStart = layer.veinYStart ?? 0.12;
                const yEnd = layer.veinYEnd ?? 0.88;
                const angBase = layer.angleBase ?? 0.75;
                const angTip = layer.angleTip ?? 1.05;
                const lenBase = layer.lengthBase ?? 0.42;
                const lenTip = layer.lengthTip ?? 0.22;
                const vw = (layer.veinWidth ?? 0.010) * width;
                const feather = Math.max(0.0001, (layer.feather ?? 0.008) * width);
                const c = this._hexToRgb(layer.color || '#6a9448');
                const rgb = [c.r, c.g, c.b];
                const opacity = layer.opacity ?? 0.65;

                const segments = [];
                for (let v = 0; v < veinCount; v++) {
                    const t = veinCount > 1 ? v / (veinCount - 1) : 0.5;
                    const vy = (yStart + t * (yEnd - yStart)) * height;
                    const angle = angBase + t * (angTip - angBase);
                    const len = (lenBase + t * (lenTip - lenBase)) * width * 0.5;
                    const midX = width * 0.5;
                    segments.push({ x0: midX, y0: vy, x1: midX + Math.cos(angle) * len, y1: vy - Math.sin(angle) * len });
                    segments.push({ x0: midX, y0: vy, x1: midX - Math.cos(angle) * len, y1: vy - Math.sin(angle) * len });
                }

                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        let minDist = Infinity;
                        for (const s of segments) {
                            const d = this._distToSegment(x, y, s.x0, s.y0, s.x1, s.y1);
                            if (d < minDist) minDist = d;
                        }
                        let t = 0;
                        if (minDist <= vw) {
                            t = 1.0;
                        } else if (minDist <= vw + feather) {
                            t = 1.0 - (minDist - vw) / feather;
                            t = t * t * (3 - 2 * t);
                        }
                        if (t > 0) {
                            this._blendPixel(pixels, x, y, width, rgb, t * opacity, layer.blendMode);
                        }
                    }
                }
                break;
            }
            case 'radial_gradient': {
                const cx = (layer.centerX ?? 0.5) * width;
                const cy = (layer.centerY ?? 0.5) * height;
                const rIn = (layer.radiusInner ?? 0.0) * Math.min(width, height);
                const rOut = Math.max(rIn + 0.0001, (layer.radiusOuter ?? 0.5) * Math.min(width, height));
                const cIn = this._hexToRgb(layer.colorInner || '#ffffff');
                const cOut = this._hexToRgb(layer.colorOuter || '#000000');
                const rgbIn = [cIn.r, cIn.g, cIn.b];
                const rgbOut = [cOut.r, cOut.g, cOut.b];
                const opacity = layer.opacity ?? 1.0;

                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
                        let t = 0.0;
                        if (dist <= rIn) {
                            t = 0.0;
                        } else if (dist >= rOut) {
                            t = 1.0;
                        } else {
                            t = (dist - rIn) / (rOut - rIn);
                            t = t * t * (3 - 2 * t);
                        }
                        const rgb = [
                            rgbIn[0] + (rgbOut[0] - rgbIn[0]) * t,
                            rgbIn[1] + (rgbOut[1] - rgbIn[1]) * t,
                            rgbIn[2] + (rgbOut[2] - rgbIn[2]) * t
                        ];
                        this._blendPixel(pixels, x, y, width, rgb, opacity, layer.blendMode);
                    }
                }
                break;
            }
            case 'fbm_normal': {
                const freq = layer.frequency ?? 0.5;
                const amp = layer.amplitude ?? 0.05;
                const octs = layer.octaves ?? 4;
                const persist = layer.persistence ?? 0.5;
                const eps = 1.5;
                const seed = layer.seed ?? 0;

                const h = (px, py) => {
                    let val = 0;
                    let f = freq;
                    let a = amp;
                    for (let o = 0; o < octs; o++) {
                        val += a * this._smoothNoise(px * f / width, py * f / height, seed + o * 17);
                        f *= 2;
                        a *= persist;
                    }
                    return val;
                };

                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        const dX = h(x + eps, y) - h(x - eps, y);
                        const dY = h(x, y + eps) - h(x, y - eps);
                        const nx = Math.max(0, Math.min(1, -dX * 0.5 + 0.5));
                        const ny = Math.max(0, Math.min(1, -dY * 0.5 + 0.5));
                        const idx = (y * width + x) * 4;
                        pixels[idx + 0] = Math.round(pixels[idx + 0] * 0.5 + nx * 255 * 0.5);
                        pixels[idx + 1] = Math.round(pixels[idx + 1] * 0.5 + ny * 255 * 0.5);
                    }
                }
                break;
            }
            case 'vertical_stripe_normal': {
                const cx = (layer.centerX ?? 0.5) * width;
                const hw = (layer.width ?? 0.030) * width * 0.5;
                const feather = Math.max(0.0001, (layer.feather ?? 0.018) * width);
                const ridgeH = layer.height ?? 0.45;

                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        const dist = x - cx;
                        const absDist = Math.abs(dist);
                        let h = 0;
                        if (absDist <= hw) {
                            h = ridgeH * (1.0 - absDist / (hw + feather));
                        } else if (absDist <= hw + feather) {
                            const t = (absDist - hw) / feather;
                            h = ridgeH * (1 - t) * (1 - t);
                        }
                        if (h < 0.001) continue;

                        let dHdX = 0;
                        if (absDist <= hw) {
                            dHdX = -ridgeH * Math.sign(dist) / (hw + feather);
                        } else if (absDist <= hw + feather) {
                            const t = (absDist - hw) / feather;
                            dHdX = ridgeH * 2 * (1 - t) / feather * Math.sign(dist);
                        }

                        const nx = Math.max(0, Math.min(1, 0.5 - dHdX * 0.5));
                        const idx = (y * width + x) * 4;
                        pixels[idx + 0] = Math.round(pixels[idx + 0] * (1 - h) + nx * 255 * h);
                        pixels[idx + 1] = Math.round(pixels[idx + 1]);
                        pixels[idx + 2] = Math.round(Math.max(200, pixels[idx + 2]));
                    }
                }
                break;
            }
            case 'pinnate_veins_normal': {
                const veinCount = layer.veinCount ?? 7;
                const yStart = layer.veinYStart ?? 0.12;
                const yEnd = layer.veinYEnd ?? 0.88;
                const angBase = layer.angleBase ?? 0.75;
                const angTip = layer.angleTip ?? 1.05;
                const lenBase = layer.lengthBase ?? 0.42;
                const lenTip = layer.lengthTip ?? 0.22;
                const vw = (layer.veinWidth ?? 0.014) * width;
                const feather = Math.max(0.0001, (layer.feather ?? 0.010) * width);
                const ridgeH = layer.height ?? 0.22;

                const segments = [];
                for (let v = 0; v < veinCount; v++) {
                    const t = veinCount > 1 ? v / (veinCount - 1) : 0.5;
                    const vy = (yStart + t * (yEnd - yStart)) * height;
                    const angle = angBase + t * (angTip - angBase);
                    const len = (lenBase + t * (lenTip - lenBase)) * width * 0.5;
                    const midX = width * 0.5;
                    const cosA = Math.cos(angle);
                    const sinA = Math.sin(angle);
                    segments.push({ x0: midX, y0: vy, x1: midX + cosA * len, y1: vy - sinA * len, nx: sinA, ny: cosA });
                    segments.push({ x0: midX, y0: vy, x1: midX - cosA * len, y1: vy - sinA * len, nx: -sinA, ny: cosA });
                }

                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        let minDist = Infinity;
                        let bestNx = 0;
                        for (const s of segments) {
                            const d = this._distToSegment(x, y, s.x0, s.y0, s.x1, s.y1);
                            if (d < minDist) {
                                minDist = d;
                                bestNx = s.nx;
                            }
                        }
                        let t = 0;
                        if (minDist <= vw) {
                            t = ridgeH;
                        } else if (minDist <= vw + feather) {
                            const f = 1.0 - (minDist - vw) / feather;
                            t = ridgeH * f * f;
                        }
                        if (t < 0.005) continue;

                        const nxVal = Math.max(0, Math.min(1, 0.5 - bestNx * t * 0.5));
                        const idx = (y * width + x) * 4;
                        pixels[idx + 0] = Math.round(pixels[idx + 0] * (1 - t) + nxVal * 255 * t);
                        pixels[idx + 2] = Math.round(Math.max(200, pixels[idx + 2]));
                    }
                }
                break;
            }
            default:
                break;
        }
    }

    _blendPixel(pixels, x, y, width, rgb, alpha, blendMode) {
        if (alpha <= 0) return;
        const idx = (y * width + x) * 4;
        const srcR = rgb[0];
        const srcG = rgb[1];
        const srcB = rgb[2];
        const dstR = pixels[idx + 0];
        const dstG = pixels[idx + 1];
        const dstB = pixels[idx + 2];
        const blend = blendMode || 'normal';

        let outR = srcR;
        let outG = srcG;
        let outB = srcB;
        if (blend === 'multiply') {
            outR = (srcR * dstR) / 255;
            outG = (srcG * dstG) / 255;
            outB = (srcB * dstB) / 255;
        } else if (blend === 'screen') {
            outR = 255 - ((255 - srcR) * (255 - dstR)) / 255;
            outG = 255 - ((255 - srcG) * (255 - dstG)) / 255;
            outB = 255 - ((255 - srcB) * (255 - dstB)) / 255;
        }

        pixels[idx + 0] = Math.round(dstR * (1 - alpha) + outR * alpha);
        pixels[idx + 1] = Math.round(dstG * (1 - alpha) + outG * alpha);
        pixels[idx + 2] = Math.round(dstB * (1 - alpha) + outB * alpha);
        pixels[idx + 3] = 255;
    }

    _distToSegment(px, py, x0, y0, x1, y1) {
        const vx = x1 - x0;
        const vy = y1 - y0;
        const wx = px - x0;
        const wy = py - y0;
        const c1 = wx * vx + wy * vy;
        if (c1 <= 0) return Math.hypot(px - x0, py - y0);
        const c2 = vx * vx + vy * vy;
        if (c2 <= c1) return Math.hypot(px - x1, py - y1);
        const b = c1 / c2;
        const bx = x0 + b * vx;
        const by = y0 + b * vy;
        return Math.hypot(px - bx, py - by);
    }

    _smoothNoise(x, y, seed) {
        const n = Math.sin((x + seed * 0.137) * 12.9898 + (y + seed * 0.193) * 78.233) * 43758.5453;
        return (n - Math.floor(n)) * 2 - 1;
    }

    _noiseTypeIndex(type) {
        const map = {
            perlin: 0,
            fbm: 1,
            turbulence: 2,
            ridged: 3,
            voronoi: 4,
            cells: 5,
            grain: 6,
        };
        return map[type] ?? 1;
    }

    _hexToRgb(hex) {
        const res = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '#ffffff');
        if (!res) return { r: 255, g: 255, b: 255 };
        return {
            r: parseInt(res[1], 16),
            g: parseInt(res[2], 16),
            b: parseInt(res[3], 16)
        };
    }

    _blendModeToCompositeOp(mode) {
        switch ((mode || 'normal')) {
            case 'multiply': return 'multiply';
            case 'screen': return 'screen';
            case 'overlay': return 'overlay';
            case 'lighter': return 'lighter';
            case 'destination-in': return 'destination-in';
            case 'source-in': return 'source-in';
            default: return 'source-over';
        }
    }

    dispose() {
        if (this.outputTexture) {
            this.outputTexture.destroy();
        }
        if (this.uniformBuffer) {
            this.uniformBuffer.destroy();
        }
        this.layers = [];
        this.ctx = null;
        this.canvas = null;
    }
}
