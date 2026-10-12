// core/renderer/rivers/riverMaterialBuilder.js
//
// Builds the WebGPU Material for the river water surface. Mirrors
// core/renderer/water/waterMaterialBuilder.js's shape (packed Float32Array
// uniform buffers + an explicit bindGroupLayoutSpec), but simpler: a single
// fixed patch needs no per-LOD instancing.

import { Material } from '../resources/material.js';
import { buildRiverVertexShader, buildRiverFragmentShader } from './shaders/riverWaterShader.wgsl.js';

function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function readMat4Elements(mat) {
    if (mat && Array.isArray(mat.elements) && mat.elements.length >= 16) return mat.elements;
    if (mat?.elements?.length >= 16) return mat.elements;
    if (Array.isArray(mat) && mat.length >= 16) return mat;
    return null;
}

function writeMat4(out, offset, mat) {
    const elems = readMat4Elements(mat);
    if (elems) {
        for (let i = 0; i < 16; i++) out[offset + i] = elems[i];
        return;
    }
    out[offset + 0] = 1; out[offset + 1] = 0; out[offset + 2] = 0; out[offset + 3] = 0;
    out[offset + 4] = 0; out[offset + 5] = 1; out[offset + 6] = 0; out[offset + 7] = 0;
    out[offset + 8] = 0; out[offset + 9] = 0; out[offset + 10] = 1; out[offset + 11] = 0;
    out[offset + 12] = 0; out[offset + 13] = 0; out[offset + 14] = 0; out[offset + 15] = 1;
}

function readVec3(value, fallback = [0, 0, 0]) {
    if (Array.isArray(value) && value.length >= 3) return [value[0], value[1], value[2]];
    if (value && typeof value === 'object') {
        if (isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z)) {
            return [value.x, value.y, value.z];
        }
    }
    return fallback.slice(0, 3);
}

export class RiverMaterialBuilder {
    static VERTEX_FLOATS = 52;
    static FRAGMENT_FLOATS = 32;

    static create(options = {}) {
        const uniforms = {
            riverVertexUniforms: { value: new Float32Array(RiverMaterialBuilder.VERTEX_FLOATS) },
            riverFragmentUniforms: { value: new Float32Array(RiverMaterialBuilder.FRAGMENT_FLOATS) },
        };

        const material = new Material({
            name: 'RiverWater',
            vertexShader: buildRiverVertexShader(),
            fragmentShader: buildRiverFragmentShader(),
            uniforms,
            vertexLayout: [],
            side: 'double',
            transparent: true,
            depthTest: true,
            depthWrite: true,
            blending: 'normal',
            bindGroupLayoutSpec: [
                {
                    label: 'River-Uniforms',
                    entries: [
                        { binding: 0, visibility: 'vertex', name: 'riverVertexUniforms', buffer: { type: 'uniform' } },
                        { binding: 1, visibility: 'fragment', name: 'riverFragmentUniforms', buffer: { type: 'uniform' } },
                    ],
                },
                {
                    label: 'River-Storage',
                    entries: [
                        { binding: 0, visibility: 'vertex', name: 'bed', buffer: { type: 'read-only-storage' } },
                        { binding: 1, visibility: 'vertex', name: 'state', buffer: { type: 'read-only-storage' } },
                        { binding: 2, visibility: 'vertex', name: 'turbulence', buffer: { type: 'read-only-storage' } },
                    ],
                },
            ],
        });

        RiverMaterialBuilder.updateUniformBuffers(material, { grid: options.grid });

        return material;
    }

    static updateUniformBuffers(material, params = {}) {
        const vert = material?.uniforms?.riverVertexUniforms?.value;
        const frag = material?.uniforms?.riverFragmentUniforms?.value;
        if (!(vert instanceof Float32Array) || !(frag instanceof Float32Array)) return;

        const anchor = params.anchor || null;
        const grid = params.grid || { W: 128, L: 128, dx: 1.0 };
        const uniformManager = params.uniformManager || null;
        const globals = uniformManager?.uniforms || null;

        const pos = anchor?.position || { x: 0, y: 0, z: 0 };
        const right = anchor?.right || { x: 1, y: 0, z: 0 };
        const up = anchor?.up || { x: 0, y: 1, z: 0 };
        const forward = anchor?.forward || { x: 0, y: 0, z: 1 };
        const time = isFiniteNumber(params.time) ? params.time : 0;
        const hmin = isFiniteNumber(params.hmin) ? params.hmin : 0.02;

        writeMat4(vert, 0, params.viewMatrix);
        writeMat4(vert, 16, params.projectionMatrix);

        vert[32] = pos.x; vert[33] = pos.y; vert[34] = pos.z; vert[35] = grid.dx;
        vert[36] = right.x; vert[37] = right.y; vert[38] = right.z; vert[39] = time;
        vert[40] = up.x; vert[41] = up.y; vert[42] = up.z; vert[43] = hmin;
        vert[44] = forward.x; vert[45] = forward.y; vert[46] = forward.z;
        vert[47] = isFiniteNumber(params.waveAmp) ? params.waveAmp : 0.06;
        vert[48] = grid.W; vert[49] = grid.L; vert[50] = 0; vert[51] = 0;

        const sunDir = readVec3(globals?.sunLightDirection?.value, [0.5, 1.0, 0.3]);
        const sunCol = readVec3(globals?.sunLightColor?.value, [1.0, 1.0, 1.0]);
        const sunIntensity = isFiniteNumber(globals?.sunLightIntensity?.value) ? globals.sunLightIntensity.value : 1.0;
        const ambientCol = readVec3(globals?.ambientLightColor?.value, [0.25, 0.25, 0.25]);
        const ambientIntensity = isFiniteNumber(globals?.ambientLightIntensity?.value) ? globals.ambientLightIntensity.value : 0.8;
        const fogCol = readVec3(globals?.fogColor?.value, [0.7, 0.8, 1.0]);
        const fogDensity = isFiniteNumber(globals?.fogDensity?.value) ? globals.fogDensity.value : 0.00005;

        const cam = params.cameraPosition || {};
        const waterTint = Array.isArray(params.waterTint) ? params.waterTint : [0.184, 0.435, 0.451];
        const clarity = isFiniteNumber(params.clarity) ? params.clarity : 1.0;

        frag[0] = sunDir[0]; frag[1] = sunDir[1]; frag[2] = sunDir[2]; frag[3] = sunIntensity;
        frag[4] = sunCol[0]; frag[5] = sunCol[1]; frag[6] = sunCol[2]; frag[7] = ambientIntensity;
        frag[8] = ambientCol[0]; frag[9] = ambientCol[1]; frag[10] = ambientCol[2]; frag[11] = fogDensity;
        frag[12] = fogCol[0]; frag[13] = fogCol[1]; frag[14] = fogCol[2]; frag[15] = time;
        frag[16] = waterTint[0]; frag[17] = waterTint[1]; frag[18] = waterTint[2]; frag[19] = clarity;
        frag[20] = isFiniteNumber(cam.x) ? cam.x : 0;
        frag[21] = isFiniteNumber(cam.y) ? cam.y : 0;
        frag[22] = isFiniteNumber(cam.z) ? cam.z : 0;
        frag[23] = hmin;
        frag[24] = right.x; frag[25] = right.y; frag[26] = right.z; frag[27] = 0;
        frag[28] = forward.x; frag[29] = forward.y; frag[30] = forward.z; frag[31] = 0;
    }
}
