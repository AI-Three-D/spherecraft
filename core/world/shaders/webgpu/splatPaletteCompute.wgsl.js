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

export function createSplatPaletteComputeShader(options = {}) {
    if (!options.tileCategories) {
        throw new Error('createSplatPaletteComputeShader requires options.tileCategories');
    }
    if (!options.buildTileCategoryLookupWGSL) {
        throw new Error('createSplatPaletteComputeShader requires options.buildTileCategoryLookupWGSL');
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
@group(0) @binding(1) var tileMap: texture_2d<f32>;
@group(0) @binding(2) var paletteTexture: texture_storage_2d<rgba8unorm, write>;

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

fn insertTop4(
    categoryId: u32,
    score: f32,
    topIds: ptr<function, array<u32, 4>>,
    topScores: ptr<function, array<f32, 4>>
) {
    if (!validCategory(categoryId) || score <= SCORE_EPSILON) {
        return;
    }

    for (var i = 0; i < 4; i = i + 1) {
        if ((*topIds)[i] == categoryId) {
            (*topScores)[i] = max((*topScores)[i], score);
            return;
        }
    }

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

@compute @workgroup_size(1, 1)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let paletteSize = textureDimensions(paletteTexture);
    if (global_id.x >= paletteSize.x || global_id.y >= paletteSize.y) {
        return;
    }

    let tileMapSize = vec2<i32>(textureDimensions(tileMap));
    let maxCoord = tileMapSize - vec2<i32>(1);
    let chunkSize = max(uniforms.chunkSize, 1);
    let inputPadding = max(uniforms.inputPadding, 0);
    let border = max(uniforms.chunkPaletteBorderTexels, 0);
    let innerOrigin = vec2<i32>(inputPadding);
    let innerSize = max(tileMapSize - vec2<i32>(inputPadding * 2), vec2<i32>(1));

    let chunkMinInner = vec2<i32>(global_id.xy) * chunkSize;
    if (chunkMinInner.x >= innerSize.x || chunkMinInner.y >= innerSize.y) {
        textureStore(
            paletteTexture,
            vec2<i32>(global_id.xy),
            vec4<f32>(1.0, 1.0, 1.0, 1.0)
        );
        return;
    }

    let chunkMaxInner = min(chunkMinInner + vec2<i32>(chunkSize), innerSize);
    let sampleMin = clamp(
        innerOrigin + chunkMinInner - vec2<i32>(border),
        vec2<i32>(0),
        maxCoord
    );
    let sampleMax = clamp(
        innerOrigin + chunkMaxInner + vec2<i32>(border) - vec2<i32>(1),
        vec2<i32>(0),
        maxCoord
    );

    var categoryScores: array<f32, CATEGORY_SCORE_COUNT>;
    for (var categoryIdx = 0u; categoryIdx < CATEGORY_SCORE_COUNT; categoryIdx = categoryIdx + 1u) {
        categoryScores[categoryIdx] = 0.0;
    }

    for (var y = sampleMin.y; y <= sampleMax.y; y = y + 1) {
        for (var x = sampleMin.x; x <= sampleMax.x; x = x + 1) {
            let tileId = decodeTileIdRaw(textureLoad(tileMap, vec2<i32>(x, y), 0));
            if (!validTile(tileId)) {
                continue;
            }
            let categoryId = tileCategory(tileId);
            if (!validCategory(categoryId)) {
                continue;
            }
            categoryScores[categoryId] = categoryScores[categoryId] + 1.0;
        }
    }

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

    var outputTileIds: array<u32, 4> = array<u32, 4>(
        INVALID_TILE_ID,
        INVALID_TILE_ID,
        INVALID_TILE_ID,
        INVALID_TILE_ID
    );
    for (var i = 0; i < 4; i = i + 1) {
        let categoryId = topCategories[i];
        if (!validCategory(categoryId) || topScores[i] <= SCORE_EPSILON) {
            continue;
        }
        outputTileIds[i] = categoryRepresentativeTileId(categoryId);
    }

    for (var i: i32 = 0; i < 3; i = i + 1) {
        for (var j: i32 = i + 1; j < 4; j = j + 1) {
            let vi = validTile(outputTileIds[i]);
            let vj = validTile(outputTileIds[j]);
            let shouldSwap = (vj && !vi) ||
                             (vi && vj && outputTileIds[j] < outputTileIds[i]);
            if (shouldSwap) {
                let tmpId = outputTileIds[i];
                outputTileIds[i] = outputTileIds[j];
                outputTileIds[j] = tmpId;
            }
        }
    }

    textureStore(
        paletteTexture,
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
