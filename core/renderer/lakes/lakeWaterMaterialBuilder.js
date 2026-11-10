// core/renderer/lakes/lakeWaterMaterialBuilder.js
//
// Builds the WebGPU Material for a single lake's water surface. Modeled on
// riverMaterialBuilder.js's shape (packed Float32Array uniforms + explicit
// bindGroupLayoutSpec), simpler still: a real 'position' vertex attribute
// (no storage-buffer reconstruction — there's no simulation grid behind
// these, see lakeWaterSystem.js), so vertexLayout is left for the backend
// to auto-derive from the shader's VertexInput struct.

import { Material } from '../resources/material.js';
import { buildLakeWaterVertexShader, buildLakeWaterFragmentShader } from './lakeWaterShader.wgsl.js';

function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function readMat4Elements(mat) {
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
    out[offset + 0] = 1; out[offset + 5] = 1; out[offset + 10] = 1; out[offset + 15] = 1;
}

function readVec3(value, fallback) {
    if (value && typeof value === 'object' && isFiniteNumber(value.x)) return [value.x, value.y, value.z];
    return fallback;
}

export class LakeWaterMaterialBuilder {
    static VERTEX_FLOATS = 48;
    static FRAGMENT_FLOATS = 24;

    static create() {
        const uniforms = {
            lakeVertexUniforms: { value: new Float32Array(LakeWaterMaterialBuilder.VERTEX_FLOATS) },
            lakeFragmentUniforms: { value: new Float32Array(LakeWaterMaterialBuilder.FRAGMENT_FLOATS) },
        };

        return new Material({
            name: 'LakeWater',
            vertexShader: buildLakeWaterVertexShader(),
            fragmentShader: buildLakeWaterFragmentShader(),
            uniforms,
            side: 'double',
            transparent: true,
            depthTest: true,
            depthWrite: true,
            blending: 'normal',
            bindGroupLayoutSpec: [
                {
                    label: 'Lake-Uniforms',
                    entries: [
                        { binding: 0, visibility: 'vertex', name: 'lakeVertexUniforms', buffer: { type: 'uniform' } },
                        { binding: 1, visibility: 'fragment', name: 'lakeFragmentUniforms', buffer: { type: 'uniform' } },
                    ],
                },
            ],
        });
    }

    static updateUniformBuffers(material, params = {}) {
        const vert = material?.uniforms?.lakeVertexUniforms?.value;
        const frag = material?.uniforms?.lakeFragmentUniforms?.value;
        if (!(vert instanceof Float32Array) || !(frag instanceof Float32Array)) return;

        const center = params.center || { x: 0, y: 0, z: 0 };
        const right = params.right || { x: 1, y: 0, z: 0 };
        const forward = params.forward || { x: 0, y: 0, z: 1 };
        const up = params.up || { x: 0, y: 1, z: 0 };
        const time = isFiniteNumber(params.time) ? params.time : 0;
        const rippleStrength = isFiniteNumber(params.rippleStrength) ? params.rippleStrength : 1.0;

        writeMat4(vert, 0, params.viewMatrix);
        writeMat4(vert, 16, params.projectionMatrix);
        vert[32] = center.x; vert[33] = center.y; vert[34] = center.z; vert[35] = time;
        vert[36] = right.x; vert[37] = right.y; vert[38] = right.z; vert[39] = rippleStrength;
        vert[40] = forward.x; vert[41] = forward.y; vert[42] = forward.z; vert[43] = 0.35;
        vert[44] = up.x; vert[45] = up.y; vert[46] = up.z; vert[47] = 0;

        const uniformManager = params.uniformManager || null;
        const globals = uniformManager?.uniforms || null;
        const sunDir = readVec3(globals?.sunLightDirection?.value, [0.5, 1.0, 0.3]);
        const sunCol = readVec3(globals?.sunLightColor?.value, [1.0, 1.0, 1.0]);
        const sunIntensity = isFiniteNumber(globals?.sunLightIntensity?.value) ? globals.sunLightIntensity.value : 1.0;
        const ambientCol = readVec3(globals?.ambientLightColor?.value, [0.25, 0.25, 0.25]);
        const ambientIntensity = isFiniteNumber(globals?.ambientLightIntensity?.value) ? globals.ambientLightIntensity.value : 0.8;
        const fogCol = readVec3(globals?.fogColor?.value, [0.7, 0.8, 1.0]);
        const fogDensity = isFiniteNumber(globals?.fogDensity?.value) ? globals.fogDensity.value : 0.00005;
        const cam = params.cameraPosition || {};
        const waterTint = Array.isArray(params.waterTint) ? params.waterTint : [0.15, 0.38, 0.42];
        const clarity = isFiniteNumber(params.clarity) ? params.clarity : 1.0;

        frag[0] = sunDir[0]; frag[1] = sunDir[1]; frag[2] = sunDir[2]; frag[3] = sunIntensity;
        frag[4] = sunCol[0]; frag[5] = sunCol[1]; frag[6] = sunCol[2]; frag[7] = ambientIntensity;
        frag[8] = ambientCol[0]; frag[9] = ambientCol[1]; frag[10] = ambientCol[2]; frag[11] = fogDensity;
        frag[12] = fogCol[0]; frag[13] = fogCol[1]; frag[14] = fogCol[2]; frag[15] = time;
        frag[16] = waterTint[0]; frag[17] = waterTint[1]; frag[18] = waterTint[2]; frag[19] = clarity;
        frag[20] = isFiniteNumber(cam.x) ? cam.x : 0;
        frag[21] = isFiniteNumber(cam.y) ? cam.y : 0;
        frag[22] = isFiniteNumber(cam.z) ? cam.z : 0;
        frag[23] = rippleStrength;
    }
}
