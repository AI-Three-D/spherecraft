// js/shadows/GPUCascadedShadowRenderer.js

import { Logger } from '../config/Logger.js';

const NUM_CASCADES = 3;
const SHADOW_MAP_SIZES = [2048, 2048, 1024];
const DEFAULT_SPLITS = [50.0, 150.0, 400.0];

export class GPUCascadedShadowRenderer {
    /**
     * @param {object} options
     * @param {GPUDevice} options.device
     * @param {object}    options.backend
     * @param {object}    options.quadtreeGPU       - GPU quadtree (visible tile buffer, counters)
     * @param {object}    options.tileManager       - QuadtreeTileManager (for instance buffer layout)
     * @param {number}    options.maxGeomLOD        - Maximum geometry LOD level
     * @param {number[]}  options.lodIndexCounts    - Index count per LOD geometry
     * @param {Map}       options.geometries        - LOD -> geometry map from terrain renderer
     * @param {object}    options.planetConfig
     * @param {object}    options.uniformManager
     * @param {number[]}  [options.cascadeSplits]
     * @param {number[]}  [options.shadowMapSizes]
     * @param {number}    [options.shadowBias=0.002]
     * @param {number}    [options.normalBias=0.5]
     */
    constructor(options = {}) {
        this._prevCascadeCenters = [null, null, null];
        this._cascadeCenterSmoothing = 0.85; 
        this.device = options.device;
        this.backend = options.backend;
        this.quadtreeGPU = options.quadtreeGPU;
        this.tileManager = options.tileManager;
        this.maxGeomLOD = options.maxGeomLOD ?? 6;
        this.lodIndexCounts = options.lodIndexCounts || [];
        this.geometries = options.geometries || new Map();
        this.planetConfig = options.planetConfig;
        this.uniformManager = options.uniformManager;

        this.cascadeSplits = options.cascadeSplits || DEFAULT_SPLITS;
        this.shadowMapSizes = options.shadowMapSizes || SHADOW_MAP_SIZES;
        this.shadowBias = options.shadowBias ?? 0.002;
        this.normalBias = options.normalBias ?? 0.5;

        // GPU resources
        this._cascadeUniformBuffer = null;   // 3 cascade VP matrices + params
        this._shadowParamBuffer = null;       // Camera + sun + splits for setup compute
        this._shadowInstanceBuffer = null;    // Filtered instances for shadow passes
        this._shadowIndirectBuffer = null;    // Indirect args per cascade × LOD
        this._shadowCounterBuffer = null;     // Atomic counters per cascade × LOD

        // Depth textures
        this._shadowDepthTextures = [];       // GPUTexture[3]
        this._shadowDepthViews = [];          // GPUTextureView[3]

        // Comparison sampler for fragment shader sampling
        this._comparisonSampler = null;

        // Pipelines
        this._setupPipeline = null;
        this._setupBindGroupLayout = null;
        this._setupBindGroup = null;

        this._cullPipeline = null;
        this._cullBindGroupLayout = null;
        this._cullBindGroup = null;
        this._cullBindGroupDirty = true;

        this._depthMaterial = null;
        this._depthPipelines = new Map();     // LOD -> pipeline

        // Scratch buffers
        this._paramScratch = new Float32Array(36);
        this._lodCountsScratch = new Uint32Array(16);

        // LOD index count buffer for indirect builder
        this._lodIndexCountBuffer = null;

        this._initialized = false;
        this._frameCount = 0;
    }

    async initialize() {
        if (this._initialized) return;

        this._createBuffers();
        this._createDepthTextures();
        this._createComparisonSampler();
        this._createSetupPipeline();
        this._createCullPipeline();
        this._createIndirectBuilderPipeline();
        await this._createDepthPipelines();
        await this._createAssetDepthPipeline();

        this._initialized = true;
        Logger.info(
            `[GPUCascadedShadowRenderer] Initialized: ` +
            `cascades=${NUM_CASCADES}, sizes=[${this.shadowMapSizes}], ` +
            `maxLOD=${this.maxGeomLOD}`
        );
    }

    get isReady() {
        return this._initialized;
    }

    // ────────────────────────────────────────────────────────────────────
    // Public: per-frame update (compute passes)
    // ────────────────────────────────────────────────────────────────────
    _createIndirectBuilderPipeline() {
        const maxLODSlots = this.maxGeomLOD + 1;
        const shaderSource = this._buildIndirectBuilderShader(maxLODSlots);
        const module = this.device.createShaderModule({
            label: 'Shadow-IndirectBuilder-Shader',
            code: shaderSource
        });

        this._indirectBuilderBindGroupLayout = this.device.createBindGroupLayout({
            label: 'Shadow-IndirectBuilderLayout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'storage' } },  // counters
                { binding: 1, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'storage' } },  // indirect args
                { binding: 2, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'uniform' } },  // lodIndexCounts
            ]
        });

        this._indirectBuilderPipeline = this.device.createComputePipeline({
            label: 'Shadow-IndirectBuilder-Pipeline',
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this._indirectBuilderBindGroupLayout]
            }),
            compute: { module, entryPoint: 'main' }
        });

        this._indirectBuilderBindGroup = this.device.createBindGroup({
            label: 'Shadow-IndirectBuilderBindGroup',
            layout: this._indirectBuilderBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this._shadowCounterBuffer } },
                { binding: 1, resource: { buffer: this._shadowIndirectBuffer } },
                { binding: 2, resource: { buffer: this._lodIndexCountBuffer } },
            ]
        });
    }

    _buildIndirectBuilderShader(maxLODSlots) {
        const totalSlots = NUM_CASCADES * maxLODSlots;
        const maxTilesPerCascade = this._shadowInstanceCapacityPerCascade;
        return /* wgsl */`
const NUM_CASCADES: u32 = ${NUM_CASCADES}u;
const MAX_LOD_SLOTS: u32 = ${maxLODSlots}u;
const TOTAL_SLOTS: u32 = ${totalSlots}u;
const MAX_TILES_PER_CASCADE: u32 = ${maxTilesPerCascade}u;

@group(0) @binding(0) var<storage, read_write> counters: array<atomic<u32>, ${totalSlots}u>;
@group(0) @binding(1) var<storage, read_write> indirectArgs: array<u32>;
@group(0) @binding(2) var<uniform> lodIndexCounts: array<vec4<u32>, ${Math.ceil(maxLODSlots / 4)}>;

fn getLodIndexCount(lod: u32) -> u32 {
    let vecIdx = lod / 4u;
    let compIdx = lod % 4u;
    return lodIndexCounts[vecIdx][compIdx];
}

@compute @workgroup_size(1)
fn main() {
    // For each cascade × LOD slot, build DrawIndexedIndirect args
    // Instance base offset = cascade * MAX_TILES_PER_CASCADE
    // (instances within a cascade are packed contiguously across LODs)

    for (var cascade = 0u; cascade < NUM_CASCADES; cascade++) {
        // Compute instance base for this cascade's LOD
        // Since instances are written per-cascade with per-LOD counters,
        // we need cumulative offsets within the cascade
        var cumulativeOffset = cascade * MAX_TILES_PER_CASCADE;

        for (var lod = 0u; lod < MAX_LOD_SLOTS; lod++) {
            let slotIdx = cascade * MAX_LOD_SLOTS + lod;
            let count = atomicLoad(&counters[slotIdx]);
            let actualCount = min(count, MAX_TILES_PER_CASCADE);

            let base = slotIdx * 5u;
            indirectArgs[base + 0u] = getLodIndexCount(lod);  // indexCount
            indirectArgs[base + 1u] = actualCount;             // instanceCount
            indirectArgs[base + 2u] = 0u;                      // firstIndex
            indirectArgs[base + 3u] = 0u;                      // baseVertex
            indirectArgs[base + 4u] = cumulativeOffset;        // firstInstance

            cumulativeOffset += actualCount;
        }
    }
}
`;
    }

    _renderAssetCascadeDepth(encoder, cascade) {
        if (!this._assetPool || !this._assetGeometries) return;
    
        // Upload cascade select
        const data = new Float32Array(8);
        const u32 = new Uint32Array(data.buffer);
        const origin = this.planetConfig?.origin || { x: 0, y: 0, z: 0 };
        data[0] = origin.x;
        data[1] = origin.y;
        data[2] = origin.z;
        data[3] = this.planetConfig?.radius || 50000;
        u32[4] = cascade;
        this.device.queue.writeBuffer(this._assetCascadeSelectBuffers[cascade], 0, data);
    
        const bindGroup = this.device.createBindGroup({
            label: `Shadow-AssetDepthBG-C${cascade}`,
            layout: this._assetDepthBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this._assetCascadeSelectBuffers[cascade] } },
                { binding: 1, resource: { buffer: this._cascadeUniformBuffer } },
                { binding: 2, resource: { buffer: this._assetPool.instanceBuffer } },
            ]
        });
    
        const size = this.shadowMapSizes[cascade];
    
        // Continue into the SAME depth pass as terrain — begin a fresh one just for assets
        const pass = encoder.beginRenderPass({
            label: `Shadow-AssetDepth-Cascade${cascade}`,
            colorAttachments: [],
            depthStencilAttachment: {
                view: this._shadowDepthViews[cascade],
                depthClearValue: 1.0,
                depthLoadOp:  'load',   // load existing terrain depth
                depthStoreOp: 'store',
            }
        });
        pass.setViewport(0, 0, size, size, 0, 1);
        pass.setPipeline(this._assetDepthPipeline);
        pass.setBindGroup(0, bindGroup);
    
        const TOTAL_BANDS = this._assetGeometries.length;
        for (let band = 0; band < TOTAL_BANDS; band++) {
            const geo = this._assetGeometries[band];
            if (!geo) continue;
    
            pass.setVertexBuffer(0, geo.positionBuffer);
            pass.setVertexBuffer(1, geo.normalBuffer);
            pass.setVertexBuffer(2, geo.uvBuffer);
            pass.setIndexBuffer(geo.indexBuffer, 'uint16');
    
            const indirectOffset = this._assetPool.getIndirectOffset(band);
            pass.drawIndexedIndirect(this._assetPool.indirectBuffer, indirectOffset);
        }
    
        pass.end();
    }
    /**
     * Upload camera + sun parameters and dispatch cascade setup compute.
     * @param {object} camera
     * @param {GPUCommandEncoder} encoder
     */
    updateCascadeParams(camera, encoder) {
        if (!this._initialized) return;
        this._frameCount++;

        this._uploadShadowParams(camera);

        // Dispatch cascade setup: computes 3 light VP matrices on GPU
        const pass = encoder.beginComputePass({ label: 'ShadowCascadeSetup' });
        pass.setPipeline(this._setupPipeline);
        pass.setBindGroup(0, this._setupBindGroup);
        pass.dispatchWorkgroups(1);
        pass.end();
    }

    cullAndBuildIndirect(encoder) {
        if (!this._initialized) return;

        this._maybeRebuildCullBindGroup();
        if (!this._cullBindGroup) return;

        // Reset counters
        const maxSlots = NUM_CASCADES * (this.maxGeomLOD + 1);
        const zeros = new Uint32Array(maxSlots);
        this.device.queue.writeBuffer(this._shadowCounterBuffer, 0, zeros);

        // Cull pass
        const maxTiles = this.quadtreeGPU.maxVisibleTiles;
        {
            const pass = encoder.beginComputePass({ label: 'ShadowCullInstances' });
            pass.setPipeline(this._cullPipeline);
            pass.setBindGroup(0, this._cullBindGroup);
            pass.dispatchWorkgroups(Math.ceil(maxTiles / 64));
            pass.end();
        }

        // Indirect args builder pass
        {
            const pass = encoder.beginComputePass({ label: 'ShadowIndirectBuilder' });
            pass.setPipeline(this._indirectBuilderPipeline);
            pass.setBindGroup(0, this._indirectBuilderBindGroup);
            pass.dispatchWorkgroups(1);
            pass.end();
        }
    }
    renderShadowPasses(encoder) {
        if (!this._initialized) return;
    
        for (let cascade = 0; cascade < NUM_CASCADES; cascade++) {
            if (cascade === 2 && (this._frameCount % 2) !== 0) continue;
            this._renderCascadeDepth(encoder, cascade);
            this._renderAssetCascadeDepth(encoder, cascade); // ADD
        }
    }

    // ────────────────────────────────────────────────────────────────────
    // Public: accessors for terrain/asset shaders
    // ────────────────────────────────────────────────────────────────────

    /** Get the cascade VP + params uniform buffer for fragment shader binding. */
    getCascadeUniformBuffer() {
        return this._cascadeUniformBuffer;
    }

    /** Get shadow depth texture view for a cascade. */
    getShadowDepthView(cascade) {
        return this._shadowDepthViews[cascade] || null;
    }

    /** Get all 3 shadow depth views. */
    getShadowDepthViews() {
        return this._shadowDepthViews;
    }

    /** Get the comparison sampler for shadow PCF. */
    getComparisonSampler() {
        return this._comparisonSampler;
    }

    // ────────────────────────────────────────────────────────────────────
    // Internal: buffer creation
    // ────────────────────────────────────────────────────────────────────

    _createBuffers() {
        // Cascade uniforms: 3 × mat4x4 (VP) + vec4 splits + vec4 params = 224B, pad to 256
        this._cascadeUniformBuffer = this.device.createBuffer({
            label: 'Shadow-CascadeUniforms',
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });

        // Shadow param buffer: camera + sun data for setup compute
        this._shadowParamBuffer = this.device.createBuffer({
            label: 'Shadow-Params',
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        // Shadow instance buffer: same layout as terrain ChunkInstance (32 bytes each)
        // Capacity: 3 cascades × maxTiles
        const maxTiles = this.quadtreeGPU?.maxVisibleTiles || 512;
        const instanceCapacity = NUM_CASCADES * maxTiles;
        const CHUNK_INSTANCE_BYTES = 48; // Match terrain ChunkInstance struct size
        this._shadowInstanceBuffer = this.device.createBuffer({
            label: 'Shadow-Instances',
            size: Math.max(256, instanceCapacity * CHUNK_INSTANCE_BYTES),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        this._shadowInstanceCapacityPerCascade = maxTiles;

        // Indirect args: 3 cascades × (maxGeomLOD+1) × 5 u32 (DrawIndexedIndirect)
        const maxLODSlots = this.maxGeomLOD + 1;
        const indirectSlots = NUM_CASCADES * maxLODSlots;
        this._shadowIndirectBuffer = this.device.createBuffer({
            label: 'Shadow-IndirectArgs',
            size: Math.max(256, indirectSlots * 5 * 4),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST
        });

        // Atomic counters: one per cascade × LOD
        this._shadowCounterBuffer = this.device.createBuffer({
            label: 'Shadow-Counters',
            size: Math.max(256, indirectSlots * 4),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });

        // LOD index counts (for indirect builder in cull shader)
        this._lodIndexCountBuffer = this.device.createBuffer({
            label: 'Shadow-LodIndexCounts',
            size: Math.max(256, maxLODSlots * 4),
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        this._uploadLodIndexCounts();
    }

    _uploadLodIndexCounts() {
        const maxSlots = this.maxGeomLOD + 1;
        const data = new Uint32Array(Math.max(maxSlots, 4));
        for (let i = 0; i < maxSlots; i++) {
            data[i] = this.lodIndexCounts[i] || 0;
        }
        this.device.queue.writeBuffer(this._lodIndexCountBuffer, 0, data);
    }

    _createDepthTextures() {
        this._shadowDepthTextures = [];
        this._shadowDepthViews = [];

        for (let i = 0; i < NUM_CASCADES; i++) {
            const size = this.shadowMapSizes[i];
            const texture = this.device.createTexture({
                label: `Shadow-Depth-Cascade${i}`,
                size: [size, size],
                format: 'depth32float',
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
            });
            const view = texture.createView({
                label: `Shadow-DepthView-Cascade${i}`
            });
            this._shadowDepthTextures.push(texture);
            this._shadowDepthViews.push(view);
        }
    }

    _createComparisonSampler() {
        this._comparisonSampler = this.device.createSampler({
            label: 'Shadow-ComparisonSampler',
            compare: 'less',
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
        });
    }

    // ────────────────────────────────────────────────────────────────────
    // Internal: cascade setup compute pipeline
    // ────────────────────────────────────────────────────────────────────

    _createSetupPipeline() {
        const shaderSource = this._buildSetupShader();
        const module = this.device.createShaderModule({
            label: 'Shadow-CascadeSetup-Shader',
            code: shaderSource
        });

        this._setupBindGroupLayout = this.device.createBindGroupLayout({
            label: 'Shadow-SetupLayout',
            entries: [
                // binding 0: shadow params (camera + sun) [uniform, read]
                { binding: 0, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'uniform' } },
                // binding 1: cascade uniforms output [storage, write]
                { binding: 1, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'storage' } },
            ]
        });

        this._setupPipeline = this.device.createComputePipeline({
            label: 'Shadow-CascadeSetup-Pipeline',
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this._setupBindGroupLayout]
            }),
            compute: { module, entryPoint: 'main' }
        });

        this._setupBindGroup = this.device.createBindGroup({
            label: 'Shadow-SetupBindGroup',
            layout: this._setupBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this._shadowParamBuffer } },
                { binding: 1, resource: { buffer: this._cascadeUniformBuffer } },
            ]
        });
    }

    _buildSetupShader() {
        return /* wgsl */`
// Shadow Cascade Setup Compute Shader
// Computes orthographic light-space VP matrices for 3 cascades.
// Dispatch: (1, 1, 1)

const NUM_CASCADES: u32 = 3u;
const PI: f32 = 3.14159265359;

struct ShadowParams {
    // Camera parameters
    cameraPosition: vec3<f32>,
    cameraNear:     f32,
    cameraForward:  vec3<f32>,
    cameraFar:      f32,
    cameraUp:       vec3<f32>,
    cameraFov:      f32,     // radians
    cameraRight:    vec3<f32>,
    cameraAspect:   f32,
    // Sun direction (world space, pointing toward sun)
    sunDirection:   vec3<f32>,
    _pad0:          f32,
    // Cascade split distances (view-space Z)
    cascadeSplits:  vec4<f32>,  // [split0, split1, split2, near]
    // Shadow map sizes
    shadowMapSizes: vec4<f32>,
    // NEW
    planetRadius:   f32,
    planetOriginX:  f32,
    planetOriginY:  f32,
    planetOriginZ:  f32,
    tanHalfFov:     f32,   // [32]
    _pad1: f32, _pad2: f32, _pad3: f32,
}

struct CascadeOutput {
    // 3 cascade VP matrices (each 64 bytes = 16 floats)
    cascadeVP0: mat4x4<f32>,
    cascadeVP1: mat4x4<f32>,
    cascadeVP2: mat4x4<f32>,
    // Cascade splits (view-space Z) + shadow params
    splits:     vec4<f32>,     // [split0, split1, split2, 0]
    params:     vec4<f32>,     // [bias, normalBias, mapSize, enabled]
}

@group(0) @binding(0) var<uniform>             shadowParams:  ShadowParams;
@group(0) @binding(1) var<storage, read_write> cascadeOutput: CascadeOutput;

fn computeFrustumCorners(
    camPos: vec3<f32>,
    forward: vec3<f32>,
    up: vec3<f32>,
    right: vec3<f32>,
    fov: f32,
    aspect: f32,
    nearDist: f32,
    farDist: f32
) -> array<vec3<f32>, 8> {
    let tanHalfFov = tan(fov * 0.5);
    let nearH = nearDist * tanHalfFov;
    let nearW = nearH * aspect;
    let farH = farDist * tanHalfFov;
    let farW = farH * aspect;

    let nearCenter = camPos + forward * nearDist;
    let farCenter = camPos + forward * farDist;

    return array<vec3<f32>, 8>(
        nearCenter - right * nearW - up * nearH,  // near bottom-left
        nearCenter + right * nearW - up * nearH,  // near bottom-right
        nearCenter + right * nearW + up * nearH,  // near top-right
        nearCenter - right * nearW + up * nearH,  // near top-left
        farCenter  - right * farW  - up * farH,   // far bottom-left
        farCenter  + right * farW  - up * farH,   // far bottom-right
        farCenter  + right * farW  + up * farH,   // far top-right
        farCenter  - right * farW  + up * farH,   // far top-left
    );
}
    fn computeStableRadius(nearDist: f32, farDist: f32, tanHalfFov: f32, aspect: f32) -> f32 {
    // Centroid of frustum is at depth (near+far)/2 along view direction.
    // Distance from centroid to the farthest (far-plane) corner:
    let halfDepth = (farDist - nearDist) * 0.5;
    let farHalfW  = farDist * tanHalfFov * aspect;
    let farHalfH  = farDist * tanHalfFov;
    let nearHalfW = nearDist * tanHalfFov * aspect;
    let nearHalfH = nearDist * tanHalfFov;
    // Take the max of near and far corner distances
    let dFar  = farHalfW  * farHalfW  + farHalfH  * farHalfH  + halfDepth * halfDepth;
    let dNear = nearHalfW * nearHalfW + nearHalfH * nearHalfH + halfDepth * halfDepth;
    return sqrt(max(dFar, dNear));
}
fn computeCascadeVP(
    nearDist:      f32,
    farDist:       f32,
    camPos:        vec3<f32>,
    forward:       vec3<f32>,
    tanHalfFov:    f32,
    aspect:        f32,
    sunDir:        vec3<f32>,
    shadowMapSize: f32
) -> mat4x4<f32> {
    // ── 1. Stable radius (orientation-independent) ───────────────────────
    let radius = computeStableRadius(nearDist, farDist, tanHalfFov, aspect);

    // ── 2. Frustum center (camera-position-dependent, that is fine) ──────
    let center = camPos + forward * ((nearDist + farDist) * 0.5);

    // ── 3. Light-space basis ─────────────────────────────────────────────
    let lightPos = center + sunDir * radius * 2.0;
    let zAxis    = sunDir;
    var upHint   = vec3<f32>(0.0, 1.0, 0.0);
    if (abs(dot(zAxis, upHint)) > 0.99) { upHint = vec3<f32>(0.0, 0.0, 1.0); }
    let xAxis = normalize(cross(upHint, zAxis));
    let yAxis = cross(zAxis, xAxis);

    // ── 4. View matrix ───────────────────────────────────────────────────
    var view: mat4x4<f32>;
    view[0] = vec4<f32>(xAxis.x, yAxis.x, zAxis.x, 0.0);
    view[1] = vec4<f32>(xAxis.y, yAxis.y, zAxis.y, 0.0);
    view[2] = vec4<f32>(xAxis.z, yAxis.z, zAxis.z, 0.0);
    view[3] = vec4<f32>(
        -dot(xAxis, lightPos),
        -dot(yAxis, lightPos),
        -dot(zAxis, lightPos),
        1.0
    );

    // ── 5. Orthographic projection (WebGPU NDC Z in [0,1]) ───────────────
    let orthoFar = radius * 4.0;
    var proj: mat4x4<f32>;
    proj[0] = vec4<f32>(1.0 / radius, 0.0,          0.0,            0.0);
    proj[1] = vec4<f32>(0.0,          1.0 / radius,  0.0,            0.0);
    proj[2] = vec4<f32>(0.0,          0.0,          -1.0 / orthoFar, 0.0);
    proj[3] = vec4<f32>(0.0,          0.0,           0.0,            1.0);

    let vp = proj * view;

    // ── 6. Texel snapping ────────────────────────────────────────────────
    // Project the frustum center through VP to get its texel position.
    // Snap it to the nearest texel. Because radius is stable, texelSize is
    // stable, so this snap produces the same matrix for the same sun angle.
let texelSize  = 2.0 / shadowMapSize;
let centerClip = vp * vec4<f32>(center, 1.0);
let centerSnap = centerClip.xy / texelSize;
let snapDelta  = (round(centerSnap) - centerSnap) * texelSize;


    var snapped = vp;
    snapped[3][0] += snapDelta.x;
    snapped[3][1] += snapDelta.y;
    return snapped;
}
@compute @workgroup_size(1)
fn main() {
    let camPos   = shadowParams.cameraPosition;
    let forward  = shadowParams.cameraForward;
    let aspect   = shadowParams.cameraAspect;
    let tHFov    = shadowParams.tanHalfFov;
    let sunDir   = normalize(shadowParams.sunDirection);
    let splits   = shadowParams.cascadeSplits;
    let near     = splits.w;

    let near0 = max(near, splits.x * 0.05);

    cascadeOutput.cascadeVP0 = computeCascadeVP(
        near0, splits.x, camPos, forward, tHFov, aspect, sunDir,
        shadowParams.shadowMapSizes.x);

    cascadeOutput.cascadeVP1 = computeCascadeVP(
        splits.x, splits.y, camPos, forward, tHFov, aspect, sunDir,
        shadowParams.shadowMapSizes.y);

    cascadeOutput.cascadeVP2 = computeCascadeVP(
        splits.y, splits.z, camPos, forward, tHFov, aspect, sunDir,
        shadowParams.shadowMapSizes.z);

    cascadeOutput.splits = vec4<f32>(splits.x, splits.y, splits.z, 0.0);
    cascadeOutput.params = vec4<f32>(
        ${this.shadowBias}, ${this.normalBias},
        ${this.shadowMapSizes[0]}.0, 1.0);
}
`;
    }

    // ────────────────────────────────────────────────────────────────────
    // Internal: instance culling compute pipeline
    // ────────────────────────────────────────────────────────────────────

    _createCullPipeline() {
        const maxLODSlots = this.maxGeomLOD + 1;
        const shaderSource = this._buildCullShader(maxLODSlots);
        const module = this.device.createShaderModule({
            label: 'Shadow-CullInstances-Shader',
            code: shaderSource
        });

        this._cullBindGroupLayout = this.device.createBindGroupLayout({
            label: 'Shadow-CullLayout',
            entries: [
                // binding 0: cascade uniforms (VP matrices)
                { binding: 0, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'read-only-storage' } },
                // binding 1: visible tile buffer from quadtree
                { binding: 1, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'read-only-storage' } },
                // binding 2: traversal counters (tile count)
                { binding: 2, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'read-only-storage' } },
                // binding 3: shadow params (planet config etc.)
                { binding: 3, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'uniform' } },
                // binding 4: shadow instance buffer (output)
                { binding: 4, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'storage' } },
                // binding 5: shadow counters (atomic)
                { binding: 5, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'storage' } },
                // binding 6: shadow indirect args (output)
                { binding: 6, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'storage' } },
                // binding 7: LOD index counts
                { binding: 7, visibility: GPUShaderStage.COMPUTE,
                  buffer: { type: 'uniform' } },
            ]
        });

        this._cullPipeline = this.device.createComputePipeline({
            label: 'Shadow-CullInstances-Pipeline',
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this._cullBindGroupLayout]
            }),
            compute: { module, entryPoint: 'main' }
        });
    }

    _buildCullShader(maxLODSlots) {
        const maxTilesPerCascade = this._shadowInstanceCapacityPerCascade;
        return /* wgsl */`
    // Shadow Instance Culling Compute Shader
    
    const NUM_CASCADES: u32 = 3u;
    const MAX_LOD_SLOTS: u32 = ${maxLODSlots}u;
    const MAX_TILES_PER_CASCADE: u32 = ${maxTilesPerCascade}u;
    const TOTAL_COUNTER_SLOTS: u32 = ${NUM_CASCADES * maxLODSlots}u;
    
    struct CascadeData {
        cascadeVP0: mat4x4<f32>,
        cascadeVP1: mat4x4<f32>,
        cascadeVP2: mat4x4<f32>,
        splits:     vec4<f32>,
        params:     vec4<f32>,
    }
    
    struct ShadowParams {
        cameraPosition: vec3<f32>,
        cameraNear:     f32,
        cameraForward:  vec3<f32>,
        cameraFar:      f32,
        cameraUp:       vec3<f32>,
        cameraFov:      f32,
        cameraRight:    vec3<f32>,
        cameraAspect:   f32,
        sunDirection:   vec3<f32>,
        _pad0:          f32,
        cascadeSplits:  vec4<f32>,
        shadowMapSizes: vec4<f32>,
            planetRadius:   f32,
        planetOriginX:  f32,
        planetOriginY:  f32,
        planetOriginZ:  f32,
            tanHalfFov:     f32,   // [32]
    _pad1: f32, _pad2: f32, _pad3: f32,
    }
    
    struct ShadowInstance {
        posX:        f32, posY:        f32, posZ:        f32,
        face:        u32,
        chunkLocX:   f32, chunkLocY:   f32,
        chunkSizeUV: f32, _pad:        f32,
        uvOffsetX:   f32, uvOffsetY:   f32,
        uvScale:     f32, lod:         u32,
        neighborLo:  u32, neighborHi:  u32,
        layer:       u32, edgeMask:    u32,
    }
    
    struct VisibleTile {
        face:  u32,
        depth: u32,
        tileX: u32,
        tileY: u32,
    }
    
    @group(0) @binding(0) var<storage, read>       cascades:         CascadeData;
    @group(0) @binding(1) var<storage, read>       visibleTiles:     array<vec4<u32>>;
    @group(0) @binding(2) var<storage, read>       traversalCounters: array<u32>;
    @group(0) @binding(3) var<uniform>             shadowParams:     ShadowParams;
    @group(0) @binding(4) var<storage, read_write> shadowInstances:  array<ShadowInstance>;
    @group(0) @binding(5) var<storage, read_write> shadowCounters:   array<atomic<u32>>;
    @group(0) @binding(6) var<storage, read_write> shadowIndirect:   array<u32>;
    @group(0) @binding(7) var<uniform>             lodIndexCounts:   array<vec4<u32>, ${Math.ceil(maxLODSlots / 4)}>;
    
    fn getLodIndexCount(lod: u32) -> u32 {
        let vecIdx = lod / 4u;
        let compIdx = lod % 4u;
        return lodIndexCounts[vecIdx][compIdx];
    }
    
    fn getCascadeVP(cascade: u32) -> mat4x4<f32> {
        switch (cascade) {
            case 0u { return cascades.cascadeVP0; }
            case 1u { return cascades.cascadeVP1; }
            case 2u { return cascades.cascadeVP2; }
            default { return cascades.cascadeVP0; }
        }
    }
    
    fn getCubePoint(face: u32, u: f32, v: f32) -> vec3<f32> {
        let s = u * 2.0 - 1.0;
        let t = v * 2.0 - 1.0;
        switch (face) {
            case 0u { return vec3<f32>( 1.0,   t,  -s); }
            case 1u { return vec3<f32>(-1.0,   t,   s); }
            case 2u { return vec3<f32>(  s,   1.0,  -t); }
            case 3u { return vec3<f32>(  s,  -1.0,   t); }
            case 4u { return vec3<f32>(  s,    t,  1.0); }
            case 5u { return vec3<f32>( -s,    t, -1.0); }
            default { return vec3<f32>(0.0, 1.0, 0.0); }
        }
    }
    
    fn sphereInCascadeFrustum(vp: mat4x4<f32>, center: vec3<f32>, radius: f32) -> bool {
        let clip = vp * vec4<f32>(center, 1.0);
        let w = max(abs(clip.w), 0.0001);
        let ndc = clip.xyz / w;
        let r = radius / w;
    
        if (ndc.x + r < -1.0 || ndc.x - r > 1.0) { return false; }
        if (ndc.y + r < -1.0 || ndc.y - r > 1.0) { return false; }
        if (ndc.z + r < -0.1 || ndc.z - r > 1.1) { return false; }
        return true;
    }
    
    @compute @workgroup_size(64)
    fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
        let tileIdx = globalId.x;
        let actualTileCount = traversalCounters[2];
        if (tileIdx >= actualTileCount) { return; }
    
        let tile = visibleTiles[tileIdx];
        let face  = tile.x;
        let depth = tile.y;
        let tileX = tile.z;
        let tileY = tile.w;
    
        let gridSize = f32(1u << depth);
        let tileCenterU = (f32(tileX) + 0.5) / gridSize;
        let tileCenterV = (f32(tileY) + 0.5) / gridSize;
        let cubePoint = getCubePoint(face, tileCenterU, tileCenterV);
        let sphereDir = normalize(cubePoint);
    

let planetOrigin = vec3<f32>(
    shadowParams.planetOriginX,
    shadowParams.planetOriginY,
    shadowParams.planetOriginZ
);
let worldCenter = planetOrigin + sphereDir * shadowParams.planetRadius;
let tileWorldSize = shadowParams.planetRadius * 2.0 / gridSize;
let boundRadius = tileWorldSize * 0.75 + shadowParams.cameraFar * 0.02;
    
        let tileLOD = min(depth, MAX_LOD_SLOTS - 1u);
        let chunkSizeUV = 1.0 / gridSize;
        let chunkLocU = f32(tileX) * chunkSizeUV;
        let chunkLocV = f32(tileY) * chunkSizeUV;
    
        for (var cascade = 0u; cascade < NUM_CASCADES; cascade++) {
            let vp = getCascadeVP(cascade);
    
            if (!sphereInCascadeFrustum(vp, worldCenter, boundRadius)) {
                continue;
            }
    
            let counterIdx = cascade * MAX_LOD_SLOTS + tileLOD;
            let instanceIdx = atomicAdd(&shadowCounters[counterIdx], 1u);
            if (instanceIdx >= MAX_TILES_PER_CASCADE) { continue; }
    
            let globalOffset = cascade * MAX_TILES_PER_CASCADE + instanceIdx;
    
            shadowInstances[globalOffset] = ShadowInstance(
                0.0, 0.0, 0.0,
                face,
                chunkLocU, chunkLocV,
                chunkSizeUV, 0.0,
                0.0, 0.0, 1.0,
                tileLOD,
                0u, 0u,
                0u, 0u
            );
        }
    }
    `;
    }
    async _createDepthPipelines() {
        const shaderSource = this._buildDepthVertexShader();
        const vsModule = this.device.createShaderModule({
            label: 'Shadow-DepthVS',
            code: shaderSource
        });
    
        // Minimal fragment shader for depth-only rendering
        const fsModule = this.device.createShaderModule({
            label: 'Shadow-DepthFS',
            code: /* wgsl */`
    @fragment
    fn main() {}
    `
        });
    
        // Updated bind group layout
        this._depthBindGroupLayout = this.device.createBindGroupLayout({
            label: 'Shadow-DepthLayout',
            entries: [
                // binding 0: cascade select params (uniform)
                { binding: 0, visibility: GPUShaderStage.VERTEX,
                  buffer: { type: 'uniform' } },
                // binding 1: cascade matrices (storage, read from setup compute output)
                { binding: 1, visibility: GPUShaderStage.VERTEX,
                  buffer: { type: 'read-only-storage' } },
                // binding 2: shadow instance buffer
                { binding: 2, visibility: GPUShaderStage.VERTEX,
                  buffer: { type: 'read-only-storage' } },
                // binding 3: height texture array
                { binding: 3, visibility: GPUShaderStage.VERTEX,
                  texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' } },
            ]
        });
    
        // Per-cascade uniform buffer
        this._cascadeSelectBuffers = [];
        for (let i = 0; i < NUM_CASCADES; i++) {
            const buf = this.device.createBuffer({
                label: `Shadow-CascadeSelect-${i}`,
                size: 32, // 8 floats
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
            });
            this._cascadeSelectBuffers.push(buf);
        }
    
        this._depthPipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [this._depthBindGroupLayout]
        });
    
        this._depthRenderPipeline = this.device.createRenderPipeline({
            label: 'Shadow-DepthPipeline',
            layout: this._depthPipelineLayout,
            vertex: {
                module: vsModule,
                entryPoint: 'main',
                buffers: [
                    // position
                    { arrayStride: 12, stepMode: 'vertex',
                      attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
                    // normal
                    { arrayStride: 12, stepMode: 'vertex',
                      attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
                    // uv
                    { arrayStride: 8, stepMode: 'vertex',
                      attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
                ]
            },
            fragment: {
                module: fsModule,
                entryPoint: 'main',
                targets: []  // No color targets — depth only
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'back',
                frontFace: 'ccw'
            },
            depthStencil: {
                format: 'depth32float',
                depthWriteEnabled: true,
                depthCompare: 'less'
            }
        });
    }

    setAssetPool(pool, geometries, lodIndexCounts) {
        this._assetPool = pool;
        this._assetGeometries = geometries;   // array[band] from AssetStreamer._geometries
        this._assetLodIndexCounts = lodIndexCounts;
        this._assetDepthBindGroupsDirty = true;
    }

    
_buildAssetDepthVertexShader() {
    return /* wgsl */`
struct AssetCascadeSelect {
    planetOrigin: vec3<f32>,
    planetRadius: f32,
    cascadeIndex: u32,
    _pad0: u32, _pad1: u32, _pad2: u32,
}

struct CascadeMatrices {
    cascadeVP0: mat4x4<f32>,
    cascadeVP1: mat4x4<f32>,
    cascadeVP2: mat4x4<f32>,
    splits:     vec4<f32>,
    params:     vec4<f32>,
}

struct AssetInstance {
    posX: f32, posY: f32, posZ: f32,
    rotation: f32,
    width: f32, height: f32,
    tileTypeId: u32, bandIndex: u32,
    colorR: f32, colorG: f32, colorB: f32, colorA: f32,
}

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal:   vec3<f32>,
    @location(2) uv:       vec2<f32>,
}

struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
}

@group(0) @binding(0) var<uniform>            assetSelect:  AssetCascadeSelect;
@group(0) @binding(1) var<storage, read>      cascadeMats:  CascadeMatrices;
@group(0) @binding(2) var<storage, read>      instances:    array<AssetInstance>;

fn getCascadeVP(idx: u32) -> mat4x4<f32> {
    switch (idx) {
        case 0u { return cascadeMats.cascadeVP0; }
        case 1u { return cascadeMats.cascadeVP1; }
        case 2u { return cascadeMats.cascadeVP2; }
        default { return cascadeMats.cascadeVP0; }
    }
}

@vertex
fn main(input: VertexInput, @builtin(instance_index) instanceIdx: u32) -> VertexOutput {
    var output: VertexOutput;

    let inst        = instances[instanceIdx];
    let worldAnchor = vec3<f32>(inst.posX, inst.posY, inst.posZ);

    // Build sphere-tangent TBN at this world anchor
    let up = normalize(worldAnchor - assetSelect.planetOrigin);
    var _ref = vec3<f32>(0.0, 1.0, 0.0);
    if (abs(dot(up, _ref)) > 0.99) { _ref = vec3<f32>(1.0, 0.0, 0.0); }
    let tangent   = normalize(cross(up, _ref));
    let bitangent = normalize(cross(up, tangent));

    let cosR = cos(inst.rotation);
    let sinR = sin(inst.rotation);
    let rotT = tangent * cosR + bitangent * sinR;
    let rotB = -tangent * sinR + bitangent * cosR;

    var localPos = input.position;
    localPos.x *= inst.width;
    localPos.y *= inst.height;

    let worldPos = worldAnchor
                 + rotT * localPos.x
                 + up   * localPos.y
                 + rotB * localPos.z;

    // Alpha-clip: cull fully transparent verts (billboard tops)
    if (inst.colorA < 0.01) {
        output.clipPosition = vec4<f32>(2.0, 2.0, 2.0, 1.0); // clip space discard
        return output;
    }

    output.clipPosition = getCascadeVP(assetSelect.cascadeIndex) * vec4<f32>(worldPos, 1.0);
    return output;
}
`;
}

async _createAssetDepthPipeline() {
    const vsModule = this.device.createShaderModule({
        label: 'Shadow-AssetDepthVS',
        code: this._buildAssetDepthVertexShader()
    });
    const fsModule = this.device.createShaderModule({
        label: 'Shadow-AssetDepthFS',
        code: `@fragment fn main() {}`
    });

    this._assetDepthBindGroupLayout = this.device.createBindGroupLayout({
        label: 'Shadow-AssetDepthLayout',
        entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
            { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
            { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        ]
    });

    // Per-cascade select buffers (32 bytes)
    this._assetCascadeSelectBuffers = [];
    for (let i = 0; i < NUM_CASCADES; i++) {
        this._assetCascadeSelectBuffers.push(this.device.createBuffer({
            label: `Shadow-AssetSelect-${i}`,
            size: 32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        }));
    }

    this._assetDepthPipeline = this.device.createRenderPipeline({
        label: 'Shadow-AssetDepthPipeline',
        layout: this.device.createPipelineLayout({
            bindGroupLayouts: [this._assetDepthBindGroupLayout]
        }),
        vertex: {
            module: vsModule,
            entryPoint: 'main',
            buffers: [
                { arrayStride: 12, stepMode: 'vertex',
                  attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
                { arrayStride: 12, stepMode: 'vertex',
                  attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
                { arrayStride: 8,  stepMode: 'vertex',
                  attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
            ]
        },
        fragment: { module: fsModule, entryPoint: 'main', targets: [] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: {
            format: 'depth32float',
            depthWriteEnabled: true,
            depthCompare: 'less'
        }
    });
}
    _buildDepthVertexShader() {
        return /* wgsl */`
    // Shadow Depth Vertex Shader
    // Transforms terrain vertices into light-space for shadow map rendering.
    
    struct CascadeSelect {
        planetOrigin: vec3<f32>,
        planetRadius: f32,
        heightScale:  f32,
        cascadeIndex: u32,
        instanceBase: u32,
        _pad:         u32,
    }
    
    struct CascadeMatrices {
        cascadeVP0: mat4x4<f32>,
        cascadeVP1: mat4x4<f32>,
        cascadeVP2: mat4x4<f32>,
        splits:     vec4<f32>,
        params:     vec4<f32>,
    }
    
    struct ShadowInstance {
        posX:        f32, posY:        f32, posZ:        f32,
        face:        u32,
        chunkLocX:   f32, chunkLocY:   f32,
        chunkSizeUV: f32, _pad:        f32,
        uvOffsetX:   f32, uvOffsetY:   f32,
        uvScale:     f32, lod:         u32,
        neighborLo:  u32, neighborHi:  u32,
        layer:       u32, edgeMask:    u32,
    }
    
    struct VertexInput {
        @location(0) position: vec3<f32>,
        @location(1) normal:   vec3<f32>,
        @location(2) uv:       vec2<f32>,
    }
    
    struct VertexOutput {
        @builtin(position) clipPosition: vec4<f32>,
    }
    
    @group(0) @binding(0) var<uniform>       cascadeSelect:   CascadeSelect;
    @group(0) @binding(1) var<storage, read> cascadeMatrices: CascadeMatrices;
    @group(0) @binding(2) var<storage, read> shadowInstances: array<ShadowInstance>;
    @group(0) @binding(3) var               heightTexture:   texture_2d_array<f32>;
    
    fn getCubePoint(face: u32, u: f32, v: f32) -> vec3<f32> {
        let s = u * 2.0 - 1.0;
        let t = v * 2.0 - 1.0;
        switch (face) {
            case 0u { return vec3<f32>( 1.0,   t,  -s); }
            case 1u { return vec3<f32>(-1.0,   t,   s); }
            case 2u { return vec3<f32>(  s,   1.0,  -t); }
            case 3u { return vec3<f32>(  s,  -1.0,   t); }
            case 4u { return vec3<f32>(  s,    t,  1.0); }
            case 5u { return vec3<f32>( -s,    t, -1.0); }
            default { return vec3<f32>(0.0, 1.0, 0.0); }
        }
    }
    
    fn getCascadeVP(idx: u32) -> mat4x4<f32> {
        switch (idx) {
            case 0u { return cascadeMatrices.cascadeVP0; }
            case 1u { return cascadeMatrices.cascadeVP1; }
            case 2u { return cascadeMatrices.cascadeVP2; }
            default { return cascadeMatrices.cascadeVP0; }
        }
    }
    
    fn sampleHeightBilinear(uv: vec2<f32>, layer: i32) -> f32 {
        let texSize = vec2<f32>(textureDimensions(heightTexture));
        let coord = uv * texSize - 0.5;
        let base = floor(coord);
        let f = coord - base;
        let maxCoord = vec2<i32>(texSize) - vec2<i32>(1);
    
        let c00 = textureLoad(heightTexture, clamp(vec2<i32>(base),                  vec2<i32>(0), maxCoord), layer, 0).r;
        let c10 = textureLoad(heightTexture, clamp(vec2<i32>(base) + vec2<i32>(1,0), vec2<i32>(0), maxCoord), layer, 0).r;
        let c01 = textureLoad(heightTexture, clamp(vec2<i32>(base) + vec2<i32>(0,1), vec2<i32>(0), maxCoord), layer, 0).r;
        let c11 = textureLoad(heightTexture, clamp(vec2<i32>(base) + vec2<i32>(1,1), vec2<i32>(0), maxCoord), layer, 0).r;
    
        let h0 = mix(c00, c10, f.x);
        let h1 = mix(c01, c11, f.x);
        return mix(h0, h1, f.y);
    }
    
    @vertex
    fn main(input: VertexInput, @builtin(instance_index) instanceIdx: u32) -> VertexOutput {
        var output: VertexOutput;
    
        let globalIdx = cascadeSelect.instanceBase + instanceIdx;
        let inst = shadowInstances[globalIdx];
    
        // Reconstruct face UV from instance chunk location + vertex UV
        let faceUV = vec2<f32>(inst.chunkLocX, inst.chunkLocY) + input.uv * inst.chunkSizeUV;
    
        // Sample height using the instance's UV transform
        let texUV = vec2<f32>(inst.uvOffsetX, inst.uvOffsetY) + input.uv * inst.uvScale;
        let height = sampleHeightBilinear(texUV, i32(inst.layer));
    
        // Project onto sphere
        let cubePoint = getCubePoint(inst.face, faceUV.x, faceUV.y);
        let sphereDir = normalize(cubePoint);
        let radius = cascadeSelect.planetRadius + height * cascadeSelect.heightScale;
        let worldPos = cascadeSelect.planetOrigin + sphereDir * radius;
    
        // Get the cascade VP matrix and transform to light clip space
        let vp = getCascadeVP(cascadeSelect.cascadeIndex);
        output.clipPosition = vp * vec4<f32>(worldPos, 1.0);
    
        return output;
    }
    `;
    }

    _renderCascadeDepth(encoder, cascade) {
        this._uploadCascadeSelect(cascade);
    
        const bindGroup = this._buildDepthBindGroup(cascade);
        if (!bindGroup) {
            Logger.warn(`[GPUCascadedShadowRenderer] Skip cascade ${cascade}: no bind group`);
            return;
        }
    
        const size = this.shadowMapSizes[cascade];
    
        const passDesc = {
            label: `Shadow-Depth-Cascade${cascade}`,
            colorAttachments: [],
            depthStencilAttachment: {
                view: this._shadowDepthViews[cascade],
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            }
        };
    
        const pass = encoder.beginRenderPass(passDesc);
        pass.setViewport(0, 0, size, size, 0, 1);
        pass.setPipeline(this._depthRenderPipeline);
        pass.setBindGroup(0, bindGroup);
    
        // Draw each LOD level
        for (let lod = 0; lod <= this.maxGeomLOD; lod++) {
            const geo = this.geometries.get(lod);
            if (!geo) continue;
    
            // Set vertex buffers from terrain geometry
            const posAttr = geo.attributes.get('position');
            const normAttr = geo.attributes.get('normal');
            const uvAttr = geo.attributes.get('uv');
    
            if (!posAttr?.gpuBuffer || !normAttr?.gpuBuffer || !uvAttr?.gpuBuffer) {
                continue;
            }
    
            pass.setVertexBuffer(0, posAttr.gpuBuffer);
            pass.setVertexBuffer(1, normAttr.gpuBuffer);
            pass.setVertexBuffer(2, uvAttr.gpuBuffer);
    
            // Ensure index buffer exists
            if (geo.index?.data) {
                if (!geo._shadowIndexBuffer) {
                    const idxData = geo.index.data;
                    const alignedSize = Math.ceil(idxData.byteLength / 4) * 4;
                    geo._shadowIndexBuffer = this.device.createBuffer({
                        label: `Shadow-Index-LOD${lod}`,
                        size: alignedSize,
                        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
                        mappedAtCreation: true
                    });
                    new (idxData.constructor)(
                        geo._shadowIndexBuffer.getMappedRange(0, idxData.byteLength)
                    ).set(idxData);
                    geo._shadowIndexBuffer.unmap();
                }
    
                const format = geo.index.data instanceof Uint32Array ? 'uint32' : 'uint16';
                pass.setIndexBuffer(geo._shadowIndexBuffer, format);
    
                // Indirect draw for this cascade × LOD
                const indirectIdx = cascade * (this.maxGeomLOD + 1) + lod;
                const indirectOffset = indirectIdx * 5 * 4;
                pass.drawIndexedIndirect(this._shadowIndirectBuffer, indirectOffset);
            }
        }
    
        pass.end();
    }

    _uploadCascadeSelect(cascade) {
        const data = new Float32Array(8);
        const u32View = new Uint32Array(data.buffer);
    
        const origin = this.planetConfig?.origin || { x: 0, y: 0, z: 0 };
        const radius = this.planetConfig?.radius || 50000;
        const heightScale = this.planetConfig?.heightScale || 2000;
    
        data[0] = origin.x;
        data[1] = origin.y;
        data[2] = origin.z;
        data[3] = radius;
        data[4] = heightScale;
        u32View[5] = cascade;
        u32View[6] = cascade * this._shadowInstanceCapacityPerCascade;
        u32View[7] = 0;
    
        this.device.queue.writeBuffer(this._cascadeSelectBuffers[cascade], 0, data);
    }

    _buildDepthBindGroup(cascade) {
        const heightTex = this.tileManager?.getArrayTextures?.()?.height;
        const heightGPU = heightTex?._gpuTexture?.texture;
        if (!heightGPU) return null;
    
        const heightView = heightGPU.createView({ dimension: '2d-array' });
    
        return this.device.createBindGroup({
            label: `Shadow-DepthBindGroup-C${cascade}`,
            layout: this._depthBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this._cascadeSelectBuffers[cascade] } },
                { binding: 1, resource: { buffer: this._cascadeUniformBuffer } },
                { binding: 2, resource: { buffer: this._shadowInstanceBuffer } },
                { binding: 3, resource: heightView },
            ]
        });
    }
    _uploadShadowParams(camera) {
        const data = this._paramScratch;
        const pos = camera.position;
        const target = camera.target || { x: pos.x, y: pos.y, z: pos.z - 1 };

        const smoothing = 0.7; // 0 = no smoothing, 1 = frozen

        if (!this._smoothedCamPos) {
            this._smoothedCamPos = { x: pos.x, y: pos.y, z: pos.z };
        } else {
            this._smoothedCamPos.x = this._smoothedCamPos.x * smoothing + pos.x * (1 - smoothing);
            this._smoothedCamPos.y = this._smoothedCamPos.y * smoothing + pos.y * (1 - smoothing);
            this._smoothedCamPos.z = this._smoothedCamPos.z * smoothing + pos.z * (1 - smoothing);
        }
    
        
        // Compute camera basis vectors
        let fx = target.x - pos.x;
        let fy = target.y - pos.y;
        let fz = target.z - pos.z;
        let flen = Math.sqrt(fx * fx + fy * fy + fz * fz);
        if (flen < 1e-6) { fx = 0; fy = 0; fz = -1; flen = 1; }
        fx /= flen; fy /= flen; fz /= flen;

        // Up vector (sphere normal at camera position, or world up)
        let ux = pos.x, uy = pos.y, uz = pos.z;
        if (this.planetConfig?.origin) {
            ux -= this.planetConfig.origin.x;
            uy -= this.planetConfig.origin.y;
            uz -= this.planetConfig.origin.z;
        }
        let ulen = Math.sqrt(ux * ux + uy * uy + uz * uz);
        if (ulen < 1e-6) { ux = 0; uy = 1; uz = 0; ulen = 1; }
        ux /= ulen; uy /= ulen; uz /= ulen;

        // Right = forward × up
        let rx = fy * uz - fz * uy;
        let ry = fz * ux - fx * uz;
        let rz = fx * uy - fy * ux;
        let rlen = Math.sqrt(rx * rx + ry * ry + rz * rz);
        if (rlen < 1e-6) { rx = 1; ry = 0; rz = 0; rlen = 1; }
        rx /= rlen; ry /= rlen; rz /= rlen;

        // Recompute up = right × forward
        ux = ry * fz - rz * fy;
        uy = rz * fx - rx * fz;
        uz = rx * fy - ry * fx;

        // Camera position
        data[0] = this._smoothedCamPos.x;
        data[1] = this._smoothedCamPos.y;
        data[2] = this._smoothedCamPos.z;
        data[3] = camera.near;

        // Camera forward
        data[4] = fx;
        data[5] = fy;
        data[6] = fz;
        data[7] = camera.far;

        // Camera up
        data[8] = ux;
        data[9] = uy;
        data[10] = uz;
        data[11] = (camera.fov * Math.PI) / 180.0;

        // Camera right
        data[12] = rx;
        data[13] = ry;
        data[14] = rz;
        data[15] = camera.aspect;

        // Sun direction
        const sunDir = this.uniformManager?.uniforms?.sunLightDirection?.value;
        data[16] = sunDir?.x ?? 0.5;
        data[17] = sunDir?.y ?? 1.0;
        data[18] = sunDir?.z ?? 0.3;
        data[19] = 0;

        // Cascade splits
        data[20] = this.cascadeSplits[0];
        data[21] = this.cascadeSplits[1];
        data[22] = this.cascadeSplits[2];
        data[23] = camera.near;

        // Shadow map sizes
        data[24] = this.shadowMapSizes[0];
        data[25] = this.shadowMapSizes[1];
        data[26] = this.shadowMapSizes[2];
        data[27] = 0;

    const origin = this.planetConfig?.origin || { x: 0, y: 0, z: 0 };
    data[28] = this.planetConfig?.radius || 50000;
    data[29] = origin.x;
    data[30] = origin.y;
    data[31] = origin.z;
    data[32] = Math.tan((camera.fov * Math.PI / 180) / 2);
        this.device.queue.writeBuffer(this._shadowParamBuffer, 0, data);
    }

    _maybeRebuildCullBindGroup() {
        if (!this._cullBindGroupDirty) return;

        const counterBuffer = this.quadtreeGPU?.getCounterBuffer?.();
        const visibleBuffer = this.quadtreeGPU?.getVisibleTileBuffer?.();
        if (!counterBuffer || !visibleBuffer) return;

        this._cullBindGroup = this.device.createBindGroup({
            label: 'Shadow-CullBindGroup',
            layout: this._cullBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this._cascadeUniformBuffer } },
                { binding: 1, resource: { buffer: visibleBuffer } },
                { binding: 2, resource: { buffer: counterBuffer } },
                { binding: 3, resource: { buffer: this._shadowParamBuffer } },
                { binding: 4, resource: { buffer: this._shadowInstanceBuffer } },
                { binding: 5, resource: { buffer: this._shadowCounterBuffer } },
                { binding: 6, resource: { buffer: this._shadowIndirectBuffer } },
                { binding: 7, resource: { buffer: this._lodIndexCountBuffer } },
            ]
        });

        this._cullBindGroupDirty = false;
    }

    // ────────────────────────────────────────────────────────────────────
    // Cleanup
    // ────────────────────────────────────────────────────────────────────

    dispose() {
        this._cascadeUniformBuffer?.destroy();
        this._shadowParamBuffer?.destroy();
        this._shadowInstanceBuffer?.destroy();
        this._shadowIndirectBuffer?.destroy();
        this._shadowCounterBuffer?.destroy();
        this._lodIndexCountBuffer?.destroy();

        for (const tex of this._shadowDepthTextures) {
            tex?.destroy();
        }
        for (const buf of (this._cascadeSelectBuffers || [])) {
            buf?.destroy();
        }

        this._initialized = false;
    }
}