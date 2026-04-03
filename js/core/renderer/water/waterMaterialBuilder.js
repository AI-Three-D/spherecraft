// js/renderer/water/waterMaterialBuilder.js
//
// Creates a WebGPU Material for the global ocean renderer.
// Uses explicit bind-group layout specs and pre-packed uniform buffers.

import { Material } from '../resources/material.js';
import { buildWaterVertexShader, buildWaterFragmentShader } from './waterShader.wgsl.js';

function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value, min, max) {
    if (!isFiniteNumber(value)) return min;
    return Math.max(min, Math.min(max, value));
}

function readMat4Elements(mat) {
    if (mat && Array.isArray(mat.elements) && mat.elements.length >= 16) return mat.elements;
    if (Array.isArray(mat) && mat.length >= 16) return mat;
    return null;
}

function writeMat4(out, offset, mat) {
    const elems = readMat4Elements(mat);
    if (elems) {
        for (let i = 0; i < 16; i++) out[offset + i] = elems[i];
        return;
    }
    // Identity
    out[offset + 0] = 1; out[offset + 1] = 0; out[offset + 2] = 0; out[offset + 3] = 0;
    out[offset + 4] = 0; out[offset + 5] = 1; out[offset + 6] = 0; out[offset + 7] = 0;
    out[offset + 8] = 0; out[offset + 9] = 0; out[offset + 10] = 1; out[offset + 11] = 0;
    out[offset + 12] = 0; out[offset + 13] = 0; out[offset + 14] = 0; out[offset + 15] = 1;
}

function readVec2(value, fallbackX = 1, fallbackY = 0) {
    if (Array.isArray(value) && value.length >= 2) return [value[0], value[1]];
    if (value && typeof value === 'object') {
        if (isFiniteNumber(value.x) && isFiniteNumber(value.y)) return [value.x, value.y];
        if (isFiniteNumber(value.x) && isFiniteNumber(value.z)) return [value.x, value.z];
    }
    return [fallbackX, fallbackY];
}

function normalizeVec2(x, y) {
    const len = Math.hypot(x, y);
    if (!isFiniteNumber(len) || len < 1e-6) return [1, 0];
    return [x / len, y / len];
}

function readVec3(value, fallback = [0, 0, 0]) {
    if (Array.isArray(value) && value.length >= 3) return [value[0], value[1], value[2]];
    if (value && typeof value === 'object') {
        if (isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z)) {
            return [value.x, value.y, value.z];
        }
        if (isFiniteNumber(value.r) && isFiniteNumber(value.g) && isFiniteNumber(value.b)) {
            return [value.r, value.g, value.b];
        }
    }
    return fallback.slice(0, 3);
}

function readColor3(value, fallback = [1, 1, 1]) {
    if (isFiniteNumber(value)) {
        const v = Math.floor(value);
        const r = ((v >> 16) & 255) / 255;
        const g = ((v >> 8) & 255) / 255;
        const b = (v & 255) / 255;
        return [r, g, b];
    }
    return readVec3(value, fallback);
}
const LOG_DEPTH_ENABLED = true;
const LOG_DEPTH_C = 1.0; // Tuning constant (1.0 works well for most cases)

export class WaterMaterialBuilder {
    static VERTEX_FLOATS = 52; // Increased from 52 to add logDepth params
    static FRAGMENT_FLOATS = 40;

    static create(options = {}) {
        const heightTexture = options.heightTexture || null;
        const planetConfig = options.planetConfig || null;
        const waterConfig = options.waterConfig || {};
        const useArrayTextures = options.useArrayTextures !== false;
        const lod = isFiniteNumber(options.lod) ? Math.floor(options.lod) : 0;

        const uniforms = {
            // Pre-packed uniform buffers used by bindGroupLayoutSpec
            waterVertexUniforms: { value: new Float32Array(WaterMaterialBuilder.VERTEX_FLOATS) },
            waterFragmentUniforms: { value: new Float32Array(WaterMaterialBuilder.FRAGMENT_FLOATS) },

            // Textures / resources
            heightTexture: { value: heightTexture },

            // Keep references for packer defaults (not bound directly)
            _planetConfig: { value: planetConfig },
            _waterConfig: { value: waterConfig }
        };

        const material = new Material({
            name: `WaterOcean_LOD${lod}`,
            vertexShader: buildWaterVertexShader({ 
                useArrayTextures,
                useLogDepth: LOG_DEPTH_ENABLED 
            }),
            fragmentShader: buildWaterFragmentShader({ 
                useArrayTextures,
                useLogDepth: LOG_DEPTH_ENABLED 
            }),
            uniforms,
            defines: { USE_TEXTURE_ARRAYS: useArrayTextures },
            // Terrain tiles are rendered with reversed culling (`side: 'back'`) in this project.
            // Use double-sided rendering for water so it's visible both above and below the surface.
            side: 'double',
            transparent: true,
            depthTest: true,
            depthWrite: true,
            blending: 'normal',
            bindGroupLayoutSpec: [
                {
                    label: 'Water-Uniforms',
                    entries: [
                        { binding: 0, visibility: 'vertex', name: 'waterVertexUniforms', buffer: { type: 'uniform' } },
                        { binding: 1, visibility: 'fragment', name: 'waterFragmentUniforms', buffer: { type: 'uniform' } }
                    ]
                },
                {
                    label: 'Water-HeightTexture',
                    entries: [
                        {
                            binding: 0,
                            visibility: 'vertex|fragment',
                            name: 'heightTexture',
                            texture: {
                                sampleType: 'unfilterable-float',
                                viewDimension: useArrayTextures ? '2d-array' : '2d'
                            }
                        }
                    ]
                },
                {
                    label: 'Water-ChunkInstances',
                    entries: [
                        { binding: 0, visibility: 'vertex', name: 'chunkInstances', buffer: { type: 'read-only-storage' } }
                    ]
                }
            ]
        });

        // Initialize buffers once (safe defaults)
        this.updateUniformBuffers(material, {
            viewMatrix: null,
            projectionMatrix: null,
            cameraPosition: null,
            uniformManager: options.uniformManager || null,
            planetConfig,
            waterConfig,
            time: 0
        });

        return material;
    }

    static updateUniformBuffers(material, params = {}) {
        const u = material?.uniforms;
        const vert = u?.waterVertexUniforms?.value;
        const frag = u?.waterFragmentUniforms?.value;
        if (!(vert instanceof Float32Array) || vert.length < WaterMaterialBuilder.VERTEX_FLOATS) return;
        if (!(frag instanceof Float32Array) || frag.length < WaterMaterialBuilder.FRAGMENT_FLOATS) return;

        const planetConfig = params.planetConfig || u?._planetConfig?.value || null;
        const waterConfig = params.waterConfig || u?._waterConfig?.value || {};
        const uniformManager = params.uniformManager || null;
        const globals = uniformManager?.uniforms || null;

        const terrainWater = planetConfig?.terrainGeneration?.water || {};
        const planetRadius = isFiniteNumber(planetConfig?.radius) ? planetConfig.radius : 50000;
        const origin = planetConfig?.origin || { x: 0, y: 0, z: 0 };
        const heightScale = isFiniteNumber(planetConfig?.heightScale) ? planetConfig.heightScale : 2000;

        // Terrain generator outputs normalized heights; rendering uses meters.
        // Interpret TerrainGenerationConfig.water.oceanLevel as normalized and convert using heightScale.
        const oceanLevel = isFiniteNumber(waterConfig.oceanLevel)
            ? waterConfig.oceanLevel
            : (isFiniteNumber(terrainWater.oceanLevel) ? terrainWater.oceanLevel * heightScale : 0.0);

        const waveHeight = isFiniteNumber(waterConfig.waveHeight)
            ? waterConfig.waveHeight
            : (isFiniteNumber(terrainWater.waveHeight) ? terrainWater.waveHeight : 0.35);

        const waveFrequency = isFiniteNumber(waterConfig.waveFrequency) ? waterConfig.waveFrequency : 0.8;

        const windSpeed = isFiniteNumber(waterConfig.windSpeed) ? waterConfig.windSpeed : 5.0;
        const windDirRaw = [1.0, 0.0];//readVec2(waterConfig.windDirection, 1, 0);
        const windDir = normalizeVec2(windDirRaw[0], windDirRaw[1]);

        const maxWaveLOD = isFiniteNumber(waterConfig.maxWaveLOD) ? waterConfig.maxWaveLOD : 2.0;
        const maxFoamLOD = isFiniteNumber(waterConfig.maxFoamLOD) ? waterConfig.maxFoamLOD : 1.0;

        // ===================== Vertex uniforms (52 floats) =====================
        writeMat4(vert, 0, params.viewMatrix);
        writeMat4(vert, 16, params.projectionMatrix);

              // Add log depth parameters at the end of vertex uniforms
              const cameraNear = params.cameraNear ?? 1.0;
              const cameraFar = params.cameraFar ?? 100000.0;
              
              // Log depth coefficient: Fcoef = 2.0 / log2(far + 1.0)
              const logDepthBufFC = 2.0 / Math.log2(cameraFar + 1.0);
 
              
        const cam = params.cameraPosition || {};
        vert[32] = isFiniteNumber(cam.x) ? cam.x : 0;
        vert[33] = isFiniteNumber(cam.y) ? cam.y : 0;
        vert[34] = isFiniteNumber(cam.z) ? cam.z : 0;
        vert[35] = planetRadius;

        vert[36] = isFiniteNumber(origin.x) ? origin.x : 0;
        vert[37] = isFiniteNumber(origin.y) ? origin.y : 0;
        vert[38] = isFiniteNumber(origin.z) ? origin.z : 0;
        vert[39] = oceanLevel;

        vert[40] = windDir[0];
        vert[41] = windDir[1];
        vert[42] = waveHeight;
        vert[43] = waveFrequency;

        const time = isFiniteNumber(params.time) ? params.time : 0;
        vert[44] = time;
        vert[45] = windSpeed;
        vert[46] = maxWaveLOD;
        vert[47] = maxFoamLOD;

        vert[48] = heightScale;
        vert[49] = 1.0; // useInstancing (global ocean always instanced)
        vert[50] = 0.0;
        vert[51] = 0.0;
        

        // ===================== Fragment uniforms (40 floats) =====================
        const shallowColor = readColor3(waterConfig.colorShallow, [0.184, 0.435, 0.451]); // 0x2f6f73
        const deepColor = readColor3(waterConfig.colorDeep, [0.059, 0.184, 0.231]); // 0x0f2f3b
        // Defaults tuned for darker, less plastic water.
        const shallowAlpha = isFiniteNumber(waterConfig.shallowAlpha) ? waterConfig.shallowAlpha : 0.14;
        const deepAlpha = isFiniteNumber(waterConfig.deepAlpha) ? waterConfig.deepAlpha : 0.82;

        // Visual depth range controls how quickly water becomes "deep" (color + opacity).
        // This is an artistic scattering/absorption length (tens–hundreds of meters),
        // NOT the planet's literal average ocean depth (often thousands of meters).
        const depthRange = isFiniteNumber(waterConfig.depthRange)
            ? waterConfig.depthRange
            : (isFiniteNumber(terrainWater.averageOceanDepth)
                ? clamp(terrainWater.averageOceanDepth * 0.12, 40.0, 600.0)
                : 200.0);

        const foamIntensity = isFiniteNumber(waterConfig.foamIntensity) ? waterConfig.foamIntensity : 0.6;
        const foamDepthStart = isFiniteNumber(waterConfig.foamDepthStart) ? waterConfig.foamDepthStart : 0.0;
        const foamDepthEnd = isFiniteNumber(waterConfig.foamDepthEnd) ? waterConfig.foamDepthEnd : 2.5;
        const foamTiling = isFiniteNumber(waterConfig.foamTiling) ? waterConfig.foamTiling : 0.06;

        const sunDir = readVec3(globals?.sunLightDirection?.value, [0.5, 1.0, 0.3]);
        const sunCol = readVec3(globals?.sunLightColor?.value, [1.0, 1.0, 1.0]);
        const sunIntensity = isFiniteNumber(globals?.sunLightIntensity?.value) ? globals.sunLightIntensity.value : 1.0;

        const ambientCol = readVec3(globals?.ambientLightColor?.value, [0.25, 0.25, 0.25]);
        const ambientIntensity = isFiniteNumber(globals?.ambientLightIntensity?.value) ? globals.ambientLightIntensity.value : 0.8;

        const fogCol = readVec3(globals?.fogColor?.value, [0.7, 0.8, 1.0]);
        const fogDensity = isFiniteNumber(globals?.fogDensity?.value) ? globals.fogDensity.value : 0.00005;

        const weatherIntensity = isFiniteNumber(globals?.weatherIntensity?.value) ? globals.weatherIntensity.value : 0.0;
        const currentWeather = isFiniteNumber(globals?.currentWeather?.value) ? globals.currentWeather.value : 0.0;

        // Convert the sun direction to view-space so the shader can light consistently.
        // (vViewPosition/vViewNormal are in view-space; keep all lighting vectors in the same space.)
        let sunDirPacked = sunDir;
        const viewElems = readMat4Elements(params.viewMatrix);
        if (viewElems) {
            const sx = sunDir[0], sy = sunDir[1], sz = sunDir[2];
            const vx = viewElems[0] * sx + viewElems[4] * sy + viewElems[8] * sz;
            const vy = viewElems[1] * sx + viewElems[5] * sy + viewElems[9] * sz;
            const vz = viewElems[2] * sx + viewElems[6] * sy + viewElems[10] * sz;
            const len = Math.hypot(vx, vy, vz);
            sunDirPacked = (len > 1e-6) ? [vx / len, vy / len, vz / len] : [0.0, 1.0, 0.0];
        }

        // colorShallow + shallowAlpha
        frag[0] = shallowColor[0]; frag[1] = shallowColor[1]; frag[2] = shallowColor[2]; frag[3] = shallowAlpha;
        // colorDeep + deepAlpha
        frag[4] = deepColor[0]; frag[5] = deepColor[1]; frag[6] = deepColor[2]; frag[7] = deepAlpha;

        frag[8] = Math.max(0.001, depthRange);
        frag[9] = clamp(foamIntensity, 0.0, 4.0);
        frag[10] = foamDepthStart;
        frag[11] = foamDepthEnd;

        frag[12] = sunDirPacked[0]; frag[13] = sunDirPacked[1]; frag[14] = sunDirPacked[2]; frag[15] = sunIntensity;
        frag[16] = sunCol[0]; frag[17] = sunCol[1]; frag[18] = sunCol[2]; frag[19] = maxWaveLOD;

        frag[20] = ambientCol[0]; frag[21] = ambientCol[1]; frag[22] = ambientCol[2]; frag[23] = ambientIntensity;
        frag[24] = fogCol[0]; frag[25] = fogCol[1]; frag[26] = fogCol[2]; frag[27] = fogDensity;

        frag[28] = weatherIntensity;
        frag[29] = currentWeather;
        frag[30] = foamTiling;
        frag[31] = maxFoamLOD;

        frag[32] = windDir[0];
        frag[33] = windDir[1];
        frag[34] = windSpeed;
        frag[35] = waveHeight;

        frag[36] = heightScale;
        frag[37] = oceanLevel;
        frag[38] = time;
        frag[39] = 0.0;

    }
}
