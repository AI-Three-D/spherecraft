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
    chunkPaletteBorderTexels: i32,
    transitionSharpness: f32,
    transitionDominanceStart: f32,
    transitionDominanceEnd: f32,
    centerCategoryBias: f32,
    transitionBreakupScale: f32,
    transitionBreakupWarpScale: f32,
    transitionBreakupWarpStrength: f32,
    transitionBreakupStrength: f32,
    chunkPaletteMinCoverage: f32,
    _padding: vec3<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var heightMap: texture_2d<f32>;
@group(0) @binding(2) var tileMap: texture_2d<f32>;

// Top-4 sparse splat payload:
//   splatWeightTexture  = normalized weights of the top 4 categories
//   splatIndexTexture   = representative tile IDs for those top 4 categories
@group(0) @binding(3) var splatWeightTexture: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var splatIndexTexture:  texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(5) var splatPaletteTexture: texture_2d<f32>;

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

fn paletteCategoryScore(categoryScores: ptr<function, array<f32, CATEGORY_SCORE_COUNT>>, tileId: u32) -> f32 {
    if (!validTile(tileId)) {
        return 0.0;
    }
    let categoryId = tileCategory(tileId);
    if (!validCategory(categoryId)) {
        return 0.0;
    }
    return (*categoryScores)[categoryId];
}

fn paletteContainsCategory(paletteTileIds: ptr<function, array<u32, 4>>, categoryId: u32) -> bool {
    if (!validCategory(categoryId)) {
        return false;
    }
    for (var i = 0; i < 4; i = i + 1) {
        let tileId = (*paletteTileIds)[i];
        if (!validTile(tileId)) {
            continue;
        }
        if (tileCategory(tileId) == categoryId) {
            return true;
        }
    }
    return false;
}

fn sortByWeightDescending(
    tileIds: ptr<function, array<u32, 4>>,
    weights: ptr<function, array<f32, 4>>
) {
    for (var i: i32 = 0; i < 3; i = i + 1) {
        for (var j: i32 = i + 1; j < 4; j = j + 1) {
            let wi = (*weights)[i];
            let wj = (*weights)[j];
            let vi = validTile((*tileIds)[i]);
            let vj = validTile((*tileIds)[j]);
            let shouldSwap = (vj && !vi) ||
                             (vi && vj && (wj > wi || (wj == wi && (*tileIds)[j] < (*tileIds)[i])));
            if (shouldSwap) {
                let tmpId = (*tileIds)[i];
                let tmpWeight = (*weights)[i];
                (*tileIds)[i] = (*tileIds)[j];
                (*weights)[i] = (*weights)[j];
                (*tileIds)[j] = tmpId;
                (*weights)[j] = tmpWeight;
            }
        }
    }
}

fn applyBoundaryShaping(
    topCategories: ptr<function, array<u32, 4>>,
    centerCategory: u32,
    outputWeights: ptr<function, array<f32, 4>>
) {
    var weights = vec4<f32>(
        (*outputWeights)[0],
        (*outputWeights)[1],
        (*outputWeights)[2],
        (*outputWeights)[3]
    );
    let total = weights.x + weights.y + weights.z + weights.w;
    if (total <= SCORE_EPSILON) {
        return;
    }

    weights = weights / total;

    let dominance = max(max(weights.x, weights.y), max(weights.z, weights.w));
    let start = clamp(uniforms.transitionDominanceStart, 0.0, 1.0);
    let end = clamp(max(uniforms.transitionDominanceEnd, start + 0.001), 0.0, 1.0);
    let boundaryFactor = 1.0 - smoothstep(start, end, dominance);
    if (boundaryFactor <= SCORE_EPSILON) {
        return;
    }

    let exponent = mix(1.0, max(uniforms.transitionSharpness, 1.0), boundaryFactor);
    var shaped = vec4<f32>(
        select(0.0, pow(max(weights.x, SCORE_EPSILON), exponent), weights.x > SCORE_EPSILON),
        select(0.0, pow(max(weights.y, SCORE_EPSILON), exponent), weights.y > SCORE_EPSILON),
        select(0.0, pow(max(weights.z, SCORE_EPSILON), exponent), weights.z > SCORE_EPSILON),
        select(0.0, pow(max(weights.w, SCORE_EPSILON), exponent), weights.w > SCORE_EPSILON)
    );

    if (validCategory(centerCategory) && uniforms.centerCategoryBias > 0.0) {
        let centerBoost = mix(1.0, 1.0 + uniforms.centerCategoryBias, boundaryFactor);
        if ((*topCategories)[0] == centerCategory) { shaped.x = shaped.x * centerBoost; }
        if ((*topCategories)[1] == centerCategory) { shaped.y = shaped.y * centerBoost; }
        if ((*topCategories)[2] == centerCategory) { shaped.z = shaped.z * centerBoost; }
        if ((*topCategories)[3] == centerCategory) { shaped.w = shaped.w * centerBoost; }
    }

    let shapedTotal = shaped.x + shaped.y + shaped.z + shaped.w;
    if (shapedTotal <= SCORE_EPSILON) {
        return;
    }

    shaped = shaped / shapedTotal;
    (*outputWeights)[0] = shaped.x;
    (*outputWeights)[1] = shaped.y;
    (*outputWeights)[2] = shaped.z;
    (*outputWeights)[3] = shaped.w;
}

fn noiseHash2(cell: vec2<i32>, salt: u32) -> f32 {
    var h = bitcast<u32>(uniforms.seed) + salt;
    h ^= bitcast<u32>(cell.x) * 0x27d4eb2du;
    h ^= bitcast<u32>(cell.y) * 0x165667b1u;
    h = ((h >> 15u) ^ h) * 0x85ebca6bu;
    h = ((h >> 13u) ^ h) * 0xc2b2ae35u;
    h = ((h >> 16u) ^ h) * 0x45d9f3bu;
    h = ((h >> 16u) ^ h) * 0x45d9f3bu;
    h = (h >> 16u) ^ h;
    return f32(h & 0x7fffffffu) / f32(0x7fffffffu);
}

fn valueNoise2(p: vec2<f32>, salt: u32) -> f32 {
    let i = vec2<i32>(floor(p));
    let f = fract(p);
    let n00 = noiseHash2(i, salt) * 2.0 - 1.0;
    let n10 = noiseHash2(i + vec2<i32>(1, 0), salt) * 2.0 - 1.0;
    let n01 = noiseHash2(i + vec2<i32>(0, 1), salt) * 2.0 - 1.0;
    let n11 = noiseHash2(i + vec2<i32>(1, 1), salt) * 2.0 - 1.0;
    let u = f * f * (vec2<f32>(3.0) - 2.0 * f);
    let x0 = mix(n00, n10, u.x);
    let x1 = mix(n01, n11, u.x);
    return mix(x0, x1, u.y);
}

fn breakupNoise(globalSplatPos: vec2<f32>) -> f32 {
    let baseScale = max(uniforms.transitionBreakupScale, 0.00001);
    let warpScale = max(uniforms.transitionBreakupWarpScale, 0.00001);
    let warpDomain = globalSplatPos * warpScale;
    let warp = vec2<f32>(
        valueNoise2(warpDomain + vec2<f32>(17.0, 53.0), 101u),
        valueNoise2(warpDomain + vec2<f32>(89.0, 29.0), 211u)
    ) * uniforms.transitionBreakupWarpStrength;
    let baseDomain = globalSplatPos * baseScale + warp;
    let n0 = valueNoise2(baseDomain + vec2<f32>(13.0, 71.0), 307u);
    let n1 = valueNoise2(baseDomain * 1.97 + vec2<f32>(41.0, 19.0), 401u);
    return clamp(n0 * 0.7 + n1 * 0.3, -1.0, 1.0);
}

fn applyBoundaryBreakup(
    globalSplatPos: vec2<f32>,
    outputWeights: ptr<function, array<f32, 4>>
) {
    if (uniforms.transitionBreakupStrength <= SCORE_EPSILON) {
        return;
    }

    var weights = vec4<f32>(
        (*outputWeights)[0],
        (*outputWeights)[1],
        (*outputWeights)[2],
        (*outputWeights)[3]
    );
    let total = weights.x + weights.y + weights.z + weights.w;
    if (total <= SCORE_EPSILON) {
        return;
    }

    weights = weights / total;
    // This assumes channels 0 and 1 are still the dominant pair in score order.
    // That is true at the current call site because breakup runs before the
    // final tile-ID sort and because centerCategoryBias defaults to 0.0.
    // If shaping starts reordering channels, this function needs to find the
    // actual top-2 contributors dynamically.
    let top2Sum = weights.x + weights.y;
    if (top2Sum <= 0.0001) {
        return;
    }

    let top2Coverage = smoothstep(0.55, 0.9, top2Sum);
    let pairDelta = abs(weights.x - weights.y) / top2Sum;
    let boundaryMask = (1.0 - smoothstep(0.18, 0.62, pairDelta)) * top2Coverage;
    if (boundaryMask <= SCORE_EPSILON) {
        return;
    }

    let noise = breakupNoise(globalSplatPos);
    let pairBalance = weights.x / top2Sum;
    let shiftedBalance = clamp(
        pairBalance + noise * uniforms.transitionBreakupStrength * boundaryMask,
        0.0,
        1.0
    );
    weights.x = shiftedBalance * top2Sum;
    weights.y = (1.0 - shiftedBalance) * top2Sum;

    let renorm = weights.x + weights.y + weights.z + weights.w;
    if (renorm <= SCORE_EPSILON) {
        return;
    }

    weights = weights / renorm;
    (*outputWeights)[0] = weights.x;
    (*outputWeights)[1] = weights.y;
    (*outputWeights)[2] = weights.z;
    (*outputWeights)[3] = weights.w;
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
    var totalCategoryScore = 0.0;

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
            totalCategoryScore = totalCategoryScore + weight;
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
    let chunkSize = max(uniforms.chunkSize, 1);
    let paletteCoord = min(
        vec2<i32>(global_id.xy) / chunkSize,
        vec2<i32>(textureDimensions(splatPaletteTexture)) - vec2<i32>(1)
    );
    let paletteSample = textureLoad(splatPaletteTexture, paletteCoord, 0);
    var paletteTileIds: array<u32, 4> = array<u32, 4>(
        decodeTileIdRaw(vec4<f32>(paletteSample.x, 0.0, 0.0, 0.0)),
        decodeTileIdRaw(vec4<f32>(paletteSample.y, 0.0, 0.0, 0.0)),
        decodeTileIdRaw(vec4<f32>(paletteSample.z, 0.0, 0.0, 0.0)),
        decodeTileIdRaw(vec4<f32>(paletteSample.w, 0.0, 0.0, 0.0))
    );

    var paletteScoreTotal = 0.0;
    var paletteWeights: array<f32, 4> = array<f32, 4>(0.0, 0.0, 0.0, 0.0);
    for (var i = 0; i < 4; i = i + 1) {
        let tileId = paletteTileIds[i];
        if (!validTile(tileId)) {
            continue;
        }
        let score = paletteCategoryScore(&categoryScores, tileId);
        paletteWeights[i] = score;
        paletteScoreTotal = paletteScoreTotal + score;
    }

    let paletteCoverage = paletteScoreTotal / max(totalCategoryScore, SCORE_EPSILON);
    let topCategoryCovered = paletteContainsCategory(&paletteTileIds, topCategories[0]);
    let useChunkPalette =
        paletteScoreTotal > SCORE_EPSILON &&
        paletteCoverage >= uniforms.chunkPaletteMinCoverage &&
        topCategoryCovered;

    if (useChunkPalette) {
        totalScore = paletteScoreTotal;
        for (var i = 0; i < 4; i = i + 1) {
            outputTileIds[i] = paletteTileIds[i];
            outputWeights[i] = paletteWeights[i];
        }
        sortByWeightDescending(&outputTileIds, &outputWeights);
    } else {
        for (var i = 0; i < 4; i = i + 1) {
            let categoryId = topCategories[i];
            let score = topScores[i];
            if (!validCategory(categoryId) || score <= SCORE_EPSILON) {
                continue;
            }
            totalScore = totalScore + score;
            let representativeTileId = categoryRepresentativeTileId(categoryId);
            outputTileIds[i] = representativeTileId;
            outputWeights[i] = score;
        }
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
        outputWeights[i] = outputWeights[i] / totalScore;
    }

    applyBoundaryShaping(&topCategories, centerCategory, &outputWeights);
    let globalSplatPos =
        vec2<f32>(global_id.xy)
        +
        vec2<f32>(0.5)
        +
        vec2<f32>(uniforms.chunkCoord) * f32(uniforms.chunkSize);
    applyBoundaryBreakup(globalSplatPos, &outputWeights);

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
