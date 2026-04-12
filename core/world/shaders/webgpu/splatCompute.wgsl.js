// js/world/shaders/webgpu/splatCompute.wgsl.js

function buildCategoryRepresentativeTileIdWGSL(tileCategories) {
    const lines = ['fn categoryRepresentativeTileId(categoryId: u32) -> u32 {'];
    for (const category of tileCategories) {
        const representative = category.ranges[0][0];
        lines.push(
            `    if (categoryId == ${category.id}u) { return ${representative}u; } // ${category.name}`
        );
    }
    lines.push('    return INVALID_TILE_ID;');
    lines.push('}');
    return lines.join('\n');
}

export function createSplatComputeShader(options = {}) {
    if (!options.tileCategories) {
        throw new Error('createSplatComputeShader requires options.tileCategories');
    }
    if (!options.buildTileCategoryLookupWGSL) {
        throw new Error('createSplatComputeShader requires options.buildTileCategoryLookupWGSL');
    }

    const tileCategories = options.tileCategories;
    const categoryScoreCount = tileCategories.length;
    const tileCategoryWGSL = options.buildTileCategoryLookupWGSL();
    const categoryRepresentativeWGSL = buildCategoryRepresentativeTileIdWGSL(tileCategories);

    return /* wgsl */`
struct Uniforms {
    chunkCoord: vec2<i32>,
    chunkSize: i32,
    seed: i32,
    splatDensity: i32,
    kernelSize: i32,
    inputPadding: i32,
    _padding: i32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var heightMap: texture_2d<f32>;
@group(0) @binding(2) var tileMap: texture_2d<f32>;

// Top-4 sparse splat payload:
//   splatWeightTexture  = normalized weights of the top 4 categories
//   splatIndexTexture   = representative tile IDs for those top 4 categories
@group(0) @binding(3) var splatWeightTexture: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var splatIndexTexture:  texture_storage_2d<rgba8unorm, write>;

const INVALID_TILE_ID: u32 = 255u;
const INVALID_CATEGORY_ID: u32 = 255u;
const CATEGORY_SCORE_COUNT: u32 = ${categoryScoreCount}u;
const SCORE_EPSILON: f32 = 1e-5;

fn validTile(tileId: u32) -> bool {
    return tileId < INVALID_TILE_ID;
}

fn validCategory(categoryId: u32) -> bool {
    return categoryId < CATEGORY_SCORE_COUNT;
}

fn encodeTileId(tileId: u32) -> f32 {
    return select(1.0, f32(tileId) / 255.0, validTile(tileId));
}

fn decodeTileIdRaw(tileSample: vec4<f32>) -> u32 {
    let rawR = tileSample.r;
    let tileIdF = select(rawR * 255.0, rawR, rawR > 1.0);
    return u32(tileIdF + 0.5);
}

${tileCategoryWGSL}

${categoryRepresentativeWGSL}

fn radialKernelWeight(distanceToSample: f32, radius: f32) -> f32 {
    if (radius <= 0.0 || distanceToSample >= radius) {
        return 0.0;
    }

    let normalized = distanceToSample / radius;
    let falloff = 1.0 - normalized * normalized;
    return falloff * falloff;
}

fn insertTop4(
    categoryId: u32,
    score: f32,
    topIds: ptr<function, array<u32, 4>>,
    topScores: ptr<function, array<f32, 4>>
) {
    if (!validCategory(categoryId) || score <= SCORE_EPSILON) {
        return;
    }

    // Merge duplicate if present.
    for (var i = 0; i < 4; i = i + 1) {
        if ((*topIds)[i] == categoryId) {
            (*topScores)[i] = max((*topScores)[i], score);
            return;
        }
    }

    // Find insertion point.
    var insertAt = -1;
    for (var i = 0; i < 4; i = i + 1) {
        let existingId = (*topIds)[i];
        let existingScore = (*topScores)[i];
        if (
            score > existingScore ||
            (score == existingScore && (!validCategory(existingId) || categoryId < existingId))
        ) {
            insertAt = i;
            break;
        }
    }

    if (insertAt < 0) {
        return;
    }

    for (var i = 3; i > insertAt; i = i - 1) {
        (*topIds)[i] = (*topIds)[i - 1];
        (*topScores)[i] = (*topScores)[i - 1];
    }

    (*topIds)[insertAt] = categoryId;
    (*topScores)[insertAt] = score;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let splatTexSize = textureDimensions(splatWeightTexture);
    if (global_id.x >= splatTexSize.x || global_id.y >= splatTexSize.y) {
        return;
    }

    let tileMapSize = textureDimensions(tileMap);
    let maxCoord = vec2<i32>(tileMapSize) - vec2<i32>(1);
    let inputPadding = u32(max(uniforms.inputPadding, 0));
    let paddedInset = vec2<u32>(inputPadding);
    let innerTileMapSize = max(tileMapSize - paddedInset * 2u, vec2<u32>(1u));

    let kernelRadius = max(0.5, 0.5 * f32(max(uniforms.kernelSize, 1)));

    let sourcePos =
        vec2<f32>(paddedInset)
        +
        (vec2<f32>(global_id.xy) + vec2<f32>(0.5))
        * vec2<f32>(innerTileMapSize)
        / vec2<f32>(splatTexSize);

    let minX = max(0, i32(floor(sourcePos.x - kernelRadius)));
    let maxX = min(maxCoord.x, i32(ceil(sourcePos.x + kernelRadius)) - 1);
    let minY = max(0, i32(floor(sourcePos.y - kernelRadius)));
    let maxY = min(maxCoord.y, i32(ceil(sourcePos.y + kernelRadius)) - 1);
    let centerCoord = clamp(
        vec2<i32>(floor(sourcePos)),
        vec2<i32>(0),
        maxCoord
    );
    let centerTileId = decodeTileIdRaw(textureLoad(tileMap, centerCoord, 0));

    var categoryScores: array<f32, CATEGORY_SCORE_COUNT>;
    for (var categoryIdx = 0u; categoryIdx < CATEGORY_SCORE_COUNT; categoryIdx = categoryIdx + 1u) {
        categoryScores[categoryIdx] = 0.0;
    }

    for (var y = minY; y <= maxY; y = y + 1) {
        for (var x = minX; x <= maxX; x = x + 1) {
            let samplePos = vec2<f32>(f32(x) + 0.5, f32(y) + 0.5);
            let weight = radialKernelWeight(distance(sourcePos, samplePos), kernelRadius);
            if (weight <= 0.0) {
                continue;
            }

            let tileId = decodeTileIdRaw(textureLoad(tileMap, vec2<i32>(x, y), 0));
            if (!validTile(tileId)) {
                continue;
            }

            let categoryId = tileCategory(tileId);
            if (!validCategory(categoryId)) {
                continue;
            }

            categoryScores[categoryId] = categoryScores[categoryId] + weight;
        }
    }

    let centerCategory = select(INVALID_CATEGORY_ID, tileCategory(centerTileId), validTile(centerTileId));

    var topCategories: array<u32, 4> = array<u32, 4>(
        INVALID_CATEGORY_ID,
        INVALID_CATEGORY_ID,
        INVALID_CATEGORY_ID,
        INVALID_CATEGORY_ID
    );
    var topScores: array<f32, 4> = array<f32, 4>(0.0, 0.0, 0.0, 0.0);

    for (var categoryId = 0u; categoryId < CATEGORY_SCORE_COUNT; categoryId = categoryId + 1u) {
        insertTop4(categoryId, categoryScores[categoryId], &topCategories, &topScores);
    }

    if (!validCategory(topCategories[0]) || topScores[0] <= SCORE_EPSILON) {
        let fallbackTileId = select(INVALID_TILE_ID, centerTileId, validTile(centerTileId));
        textureStore(
            splatWeightTexture,
            vec2<i32>(global_id.xy),
            vec4<f32>(1.0, 0.0, 0.0, 0.0)
        );
        textureStore(
            splatIndexTexture,
            vec2<i32>(global_id.xy),
            vec4<f32>(encodeTileId(fallbackTileId), 1.0, 1.0, 1.0)
        );
        return;
    }

    var outputTileIds: array<u32, 4> = array<u32, 4>(
        INVALID_TILE_ID,
        INVALID_TILE_ID,
        INVALID_TILE_ID,
        INVALID_TILE_ID
    );
    var outputWeights: array<f32, 4> = array<f32, 4>(0.0, 0.0, 0.0, 0.0);
    var totalScore: f32 = 0.0;

    for (var i = 0; i < 4; i = i + 1) {
        let categoryId = topCategories[i];
        let score = topScores[i];
        if (!validCategory(categoryId) || score <= SCORE_EPSILON) {
            continue;
        }
        totalScore = totalScore + score;
        let representativeTileId = categoryRepresentativeTileId(categoryId);
        outputTileIds[i] = representativeTileId;
    }

    if (totalScore <= SCORE_EPSILON) {
        let fallbackTileId = select(INVALID_TILE_ID, centerTileId, validTile(centerTileId));
        textureStore(
            splatWeightTexture,
            vec2<i32>(global_id.xy),
            vec4<f32>(1.0, 0.0, 0.0, 0.0)
        );
        textureStore(
            splatIndexTexture,
            vec2<i32>(global_id.xy),
            vec4<f32>(encodeTileId(fallbackTileId), 1.0, 1.0, 1.0)
        );
        return;
    }

    for (var i = 0; i < 4; i = i + 1) {
        if (!validTile(outputTileIds[i])) {
            continue;
        }
        outputWeights[i] = topScores[i] / totalScore;
    }

    // Sort slots by tile ID (ascending) so that adjacent texels always
    // store the same categories in the same slots, regardless of which
    // category dominates at each texel.  This mirrors the old pair-blend
    // system's biomeA/biomeB sorting and is required for the fragment
    // shader's bilinear consistency check to work reliably across the
    // entire transition zone — not just within the dominant-category side.
    for (var i: i32 = 0; i < 3; i = i + 1) {
        for (var j: i32 = i + 1; j < 4; j = j + 1) {
            let vi = validTile(outputTileIds[i]);
            let vj = validTile(outputTileIds[j]);
            let shouldSwap = (vj && !vi) ||
                             (vi && vj && outputTileIds[j] < outputTileIds[i]);
            if (shouldSwap) {
                let tmpId     = outputTileIds[i];
                let tmpWeight = outputWeights[i];
                outputTileIds[i]  = outputTileIds[j];
                outputWeights[i]  = outputWeights[j];
                outputTileIds[j]  = tmpId;
                outputWeights[j]  = tmpWeight;
            }
        }
    }

    textureStore(
        splatWeightTexture,
        vec2<i32>(global_id.xy),
        vec4<f32>(
            outputWeights[0],
            outputWeights[1],
            outputWeights[2],
            outputWeights[3]
        )
    );

    textureStore(
        splatIndexTexture,
        vec2<i32>(global_id.xy),
        vec4<f32>(
            encodeTileId(outputTileIds[0]),
            encodeTileId(outputTileIds[1]),
            encodeTileId(outputTileIds[2]),
            encodeTileId(outputTileIds[3])
        )
    );
}
`;
}
