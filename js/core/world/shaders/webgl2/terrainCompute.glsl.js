// js/world/shaders/webgl2/terrainCompute.glsl.js - FIXED with face support

import { TERRAIN_NOISE_GLSL } from './terrainNoise.glsl.js';

export const terrainVertexShader = `#version 300 es
precision highp float;

in vec3 position;
in vec2 uv;

out vec2 v_texCoord;

void main() {
    v_texCoord = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const terrainFragmentShader = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) out vec4 o_output;
in vec2 v_texCoord;

uniform ivec2 u_chunkCoord;
uniform int u_chunkSize;
uniform int u_seed;
uniform float u_elevationScale;
uniform float u_heightScale;
uniform float u_worldScale;
uniform int u_outputType;
uniform int u_face;
uniform int u_textureSize;
uniform int u_chunksPerFace;

${TERRAIN_NOISE_GLSL}

// SPHERICAL: Convert face + UV to sphere point
vec3 getSpherePoint(int face, float u, float v) {
    vec3 cubePos;
    float x = u * 2.0 - 1.0;
    float y = v * 2.0 - 1.0;
    
    if (face == 0) { cubePos = vec3(1.0, y, -x); }       // +X
    else if (face == 1) { cubePos = vec3(-1.0, y, x); }  // -X
    else if (face == 2) { cubePos = vec3(x, 1.0, -y); }  // +Y
    else if (face == 3) { cubePos = vec3(x, -1.0, y); }  // -Y
    else if (face == 4) { cubePos = vec3(x, y, 1.0); }   // +Z
    else { cubePos = vec3(-x, y, -1.0); }                // -Z

    return normalize(cubePos);
}

void main() {
    vec2 pixelCoord = v_texCoord * float(u_textureSize);
    
    // Calculate world position
    float wx, wy;
    
    // SPHERICAL MODE: Use face + UV to get 3D sphere position
    float totalChunks = float(u_chunksPerFace);
    float normalizedU = (float(u_chunkCoord.x) + pixelCoord.x / float(u_textureSize)) / totalChunks;
    float normalizedV = (float(u_chunkCoord.y) + pixelCoord.y / float(u_textureSize)) / totalChunks;
    
    float radius = max(u_worldScale, 1.0);
    vec3 spherePos = getSpherePoint(u_face, normalizedU, normalizedV) * radius;
    
    // Use spherical coordinates for noise sampling (consistent across faces)
    wx = spherePos.x + spherePos.z * 0.5;
    wy = spherePos.y + spherePos.z * 0.5;

    if (u_outputType == 0) {
        // --- HEIGHT MAP ---
        float h = terrainHeight(wx, wy, u_seed, u_elevationScale, u_heightScale);
        o_output = vec4(h, 0.0, 0.0, 1.0);

    } else if (u_outputType == 1) {
        // --- NORMAL MAP ---
        // Tangent-space normal format matching the fragment shader's TBN matrix:
        // X = slope in U direction (maps to tangent in TBN)
        // Y = slope in V direction (maps to bitangent in TBN)
        // Z = up direction (maps to sphere normal in TBN)
        float e = 0.1;
        float hL = terrainHeight(wx - e, wy, u_seed, u_elevationScale, u_heightScale);
        float hR = terrainHeight(wx + e, wy, u_seed, u_elevationScale, u_heightScale);
        float hD = terrainHeight(wx, wy - e, u_seed, u_elevationScale, u_heightScale);
        float hU = terrainHeight(wx, wy + e, u_seed, u_elevationScale, u_heightScale);

        vec3 normal = normalize(vec3(hL - hR, hD - hU, 2.0 * e));
        o_output = vec4(normal * 0.5 + 0.5, 1.0);

    } else if (u_outputType == 2) {
        // --- TILE ID MAP ---
        float h0 = terrainHeight(wx, wy, u_seed, u_elevationScale, u_heightScale);
        float e = 0.1;
        float hL = terrainHeight(wx - e, wy, u_seed, u_elevationScale, u_heightScale);
        float hR = terrainHeight(wx + e, wy, u_seed, u_elevationScale, u_heightScale);
        float hD = terrainHeight(wx, wy - e, u_seed, u_elevationScale, u_heightScale);
        float hU = terrainHeight(wx, wy + e, u_seed, u_elevationScale, u_heightScale);
        vec3 n = normalize(vec3(hL - hR, hD - hU, 2.0 * e));
        float slope = clamp(1.0 - n.z, 0.0, 1.0);
        uint t = determineTerrain(h0, slope, wx, wy, u_seed);

        float tileNormalized = float(t) / 255.0;
        o_output = vec4(tileNormalized, 0.0, 0.0, 1.0);

    } else if (u_outputType == 3) {
        // --- BIOME/MACRO MASK ---
        float m = biomeMask(wx, wy, u_seed);
        o_output = vec4(m, 0.0, 0.0, 1.0);
    } else {
        o_output = vec4(0.0);
    }
}
`;
