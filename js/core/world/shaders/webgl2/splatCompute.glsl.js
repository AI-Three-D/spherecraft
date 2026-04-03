// js/world/shaders/webgl2/splatCompute.glsl.js - FIXED

import { TERRAIN_NOISE_GLSL } from './terrainNoise.glsl.js';

export const splatVertexShader = `#version 300 es
precision highp float;

in vec3 position;
in vec2 uv;

out vec2 v_texCoord;

void main() {
    v_texCoord = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const splatFragmentShader = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) out vec4 o_splatData;

in vec2 v_texCoord;

uniform sampler2D u_heightMap;
uniform sampler2D u_tileMap;

uniform ivec2 u_chunkCoord;
uniform int u_chunkSize;
uniform int u_seed;
uniform int u_splatDensity;
uniform int u_kernelSize;

${TERRAIN_NOISE_GLSL}

bool validTile(uint t) {
    return (t < 100u);
}

void addTypeWeight(uint t, float w, inout uint types[16], inout float weights[16], inout int count) {
    if (w <= 0.0) return;
    if (!validTile(t)) return;

    for (int i = 0; i < 16; i++) {
        if (i >= count) break;
        if (types[i] == t) {
            weights[i] += w;
            return;
        }
    }

    if (count < 16) {
        types[count] = t;
        weights[count] = w;
        count++;
    }
}

void main() {
    ivec2 tileMapSize = textureSize(u_tileMap, 0);
    ivec2 outputSize = ivec2(tileMapSize.x * u_splatDensity, tileMapSize.y * u_splatDensity);
    
    vec2 splatPixel = v_texCoord * vec2(outputSize);
    vec2 tileCoord = splatPixel / float(u_splatDensity);
    
    // Check if using atlas (texture larger than chunk)
    bool useAtlas = (tileMapSize.x > u_chunkSize || tileMapSize.y > u_chunkSize);
    ivec2 chunkOriginTiles = (u_chunkCoord) * u_chunkSize;

    int N = max(1, u_kernelSize);
    int halfN = N / 2;

    uint types[16];
    float weights[16];
    int typeCount = 0;
    for (int k = 0; k < 16; k++) {
        types[k] = 0u;
        weights[k] = 0.0;
    }

    float totalWeight = 0.0;

    for (int dy = -halfN; dy <= halfN; dy++) {
        for (int dx = -halfN; dx <= halfN; dx++) {
            vec2 sampleTile = tileCoord + vec2(float(dx), float(dy));
            vec2 sampleUV = sampleTile / float(u_chunkSize);
            sampleUV = clamp(sampleUV, vec2(0.0), vec2(1.0));

            float dist = sqrt(float(dx * dx + dy * dy)) / float(halfN);
            float weight = exp(-2.0 * dist * dist);

            ivec2 sampleCoord;
            if (useAtlas) {
                sampleCoord = chunkOriginTiles + ivec2(clamp(sampleTile, vec2(0.0), vec2(float(u_chunkSize) - 1.0)));
            } else {
                sampleCoord = ivec2(sampleUV * vec2(tileMapSize));
            }
            sampleCoord = clamp(sampleCoord, ivec2(0), tileMapSize - ivec2(1));

            vec4 tileSample = texelFetch(u_tileMap, sampleCoord, 0);
            uint t = uint(tileSample.r * 255.0 + 0.5);

            addTypeWeight(t, weight, types, weights, typeCount);
            if (validTile(t)) {
                totalWeight += weight;
            }
        }
    }

    // Find top 2 tile types
    uint top1Type = 0u;
    float top1Weight = 0.0;
    uint top2Type = 0u;
    float top2Weight = 0.0;

    for (int i = 0; i < 16; i++) {
        if (i >= typeCount) break;
        float w = weights[i];
        uint t = types[i];
        if (w > top1Weight) {
            top2Type = top1Type;
            top2Weight = top1Weight;
            top1Type = t;
            top1Weight = w;
        } else if (w > top2Weight) {
            top2Type = t;
            top2Weight = w;
        }
    }

    // Normalize weights
    float w1 = 0.0;
    float w2 = 0.0;
    if (totalWeight > 0.001) {
        w1 = top1Weight / totalWeight;
        w2 = top2Weight / totalWeight;
    }

    // Pack: [weight1, type1/255, weight2, type2/255]
    o_splatData = vec4(
        w1,
        float(top1Type) / 255.0,
        w2,
        float(top2Type) / 255.0
    );
}
`;
