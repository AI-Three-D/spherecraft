export const waterVertexShader = `#version 300 es
precision highp float;

in vec2 a_position;
out vec2 v_texCoord;

void main() {
    v_texCoord = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

export const waterFragmentShader = `#version 300 es
precision highp float;

layout(location = 0) out vec4 o_waterHeight;
layout(location = 1) out vec4 o_waterDepth;

in vec2 v_texCoord;

uniform sampler2D u_heightMap;
uniform ivec2 u_chunkCoord;
uniform int u_chunkSize;
uniform uint u_seed;
uniform float u_baseSeaLevel;

float hash2D(vec2 p, uint seed) {
    uint h = uint(p.x * 374761393.0) + uint(p.y * 668265263.0);
    h ^= (h >> 13u);
    h += seed * 374761393u;
    h ^= (h >> 17u);
    h *= 668265263u;
    h ^= (h >> 15u);
    float s = sin(float(h) * 0.0001) * 43758.5453;
    return fract(s);
}

float perlin2D(float x, float y) {
    int ix = int(floor(x));
    int iy = int(floor(y));
    float fx = fract(x);
    float fy = fract(y);
    
    float u = fx * fx * (3.0 - 2.0 * fx);
    float v = fy * fy * (3.0 - 2.0 * fy);
    
    float a = hash2D(vec2(ix, iy), u_seed);
    float b = hash2D(vec2(ix + 1, iy), u_seed);
    float c = hash2D(vec2(ix, iy + 1), u_seed);
    float d = hash2D(vec2(ix + 1, iy + 1), u_seed);
    
    return mix(mix(a, b, u), mix(c, d, u), v);
}

float octaveNoise(float x, float y, int octaves) {
    float val = 0.0;
    float amp = 1.0;
    float freq = 1.0;
    float maxv = 0.0;
    
    for (int i = 0; i < octaves; i++) {
        val += perlin2D(x * freq, y * freq) * amp;
        maxv += amp;
        amp *= 0.5;
        freq *= 2.0;
    }
    
    return maxv == 0.0 ? 0.0 : val / maxv;
}

float ridgedNoise(float x, float y, int octaves) {
    float val = 0.0;
    float amp = 1.0;
    float freq = 1.0;
    float maxv = 0.0;
    
    for (int i = 0; i < octaves; i++) {
        float n = 1.0 - abs(perlin2D(x * freq, y * freq));
        val += n * n * amp;
        maxv += amp;
        amp *= 0.5;
        freq *= 2.0;
    }
    
    return maxv == 0.0 ? 0.0 : val / maxv;
}

vec2 getWaterLevel(float wx, float wy, float terrainHeight) {
    float baseSeaLevel = u_baseSeaLevel;
    
    float oceanNoise = octaveNoise(wx * 0.0003, wy * 0.0003, 4);
    float lakeNoise = octaveNoise(wx * 0.001, wy * 0.001, 3);
    
    bool isOcean = oceanNoise < -0.1;
    bool isLake = lakeNoise > 0.3 && !isOcean;
    
    float waterHeight = baseSeaLevel;
    float depth = 0.0;
    
    if (isOcean) {
        waterHeight = baseSeaLevel + oceanNoise * 2.0;
        if (terrainHeight < waterHeight) {
            depth = waterHeight - terrainHeight;
            if (depth > 10.0) {
                depth = depth * 1.2;
            }
        }
    } else if (isLake) {
        float lakeElevation = baseSeaLevel + lakeNoise * 5.0;
        waterHeight = lakeElevation;
        if (terrainHeight < waterHeight) {
            depth = waterHeight - terrainHeight;
        }
    }
    
    float riverNoise1 = ridgedNoise(wx * 0.002, wy * 0.0005, 2);
    float riverNoise2 = ridgedNoise(wx * 0.0005, wy * 0.002, 2);
    float riverMask1 = smoothstep(0.3, 0.45, riverNoise1);
    float riverMask2 = smoothstep(0.3, 0.45, riverNoise2);
    float riverMask = max(riverMask1, riverMask2);
    
    if (riverMask > 0.5 && depth == 0.0 && 
        terrainHeight > baseSeaLevel && 
        terrainHeight < baseSeaLevel + 15.0) {
        waterHeight = terrainHeight + 0.3;
        depth = 0.8 + (1.0 - riverMask) * 0.5;
    }
    
    if (depth > 0.0 && depth < 3.0) {
        float shallowNoise = octaveNoise(wx * 0.01, wy * 0.01, 2);
        depth = depth * (0.8 + shallowNoise * 0.4);
    }
    
    return vec2(waterHeight, depth);
}

void main() {
    ivec2 pixelCoord = ivec2(gl_FragCoord.xy);
    
    float offsetX = float(u_chunkCoord.x * u_chunkSize);
    float offsetY = float(u_chunkCoord.y * u_chunkSize);
    
    float wx = offsetX + float(pixelCoord.x);
    float wy = offsetY + float(pixelCoord.y);
    
    float terrainHeight = texture(
        u_heightMap, 
        vec2(pixelCoord) / vec2(u_chunkSize)
    ).r;
    
    vec2 waterData = getWaterLevel(wx, wy, terrainHeight);
    
    o_waterHeight = vec4(waterData.x, 0.0, 0.0, 1.0);
    o_waterDepth = vec4(waterData.y, 0.0, 0.0, 1.0);
}
`;