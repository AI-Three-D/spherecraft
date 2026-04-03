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
@group(0) @binding(3) var splatDataTexture: texture_storage_2d<rgba8unorm, write>;

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

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let splatTexSize = textureDimensions(splatDataTexture);
    if (global_id.x >= splatTexSize.x || global_id.y >= splatTexSize.y) {
        return;
    }

    let tileMapSize = textureDimensions(tileMap);
    let maxCoord = vec2<i32>(tileMapSize) - vec2<i32>(1);
    let inputPadding = u32(max(uniforms.inputPadding, 0));
    let paddedInset = vec2<u32>(inputPadding);
    let innerTileMapSize = max(tileMapSize - paddedInset * 2u, vec2<u32>(1u));

    // Interpret the existing kernel size config as a diameter in source texels.
    // Stage 1 uses the resulting radius directly for the local accumulation field.
    let kernelRadius = max(0.5, 0.5 * f32(max(uniforms.kernelSize, 1)));

    // Map the splat texel center into source-tile texel-center space.
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

    var top0Category: u32 = INVALID_CATEGORY_ID;
    var top1Category: u32 = INVALID_CATEGORY_ID;
    var top0Score: f32 = 0.0;
    var top1Score: f32 = 0.0;

    for (var categoryId = 0u; categoryId < CATEGORY_SCORE_COUNT; categoryId = categoryId + 1u) {
        let score = categoryScores[categoryId];
        if (score <= 0.0) {
            continue;
        }

        if (score > top0Score || (score == top0Score && categoryId < top0Category)) {
            top1Category = top0Category;
            top1Score = top0Score;
            top0Category = categoryId;
            top0Score = score;
        } else if (score > top1Score || (score == top1Score && categoryId < top1Category)) {
            top1Category = categoryId;
            top1Score = score;
        }
    }

    if (!validCategory(top0Category) || top0Score <= SCORE_EPSILON) {
        textureStore(
            splatDataTexture,
            vec2<i32>(global_id.xy),
            vec4<f32>(0.0, 0.0, 1.0, 0.0)
        );
        return;
    }

    let top0Representative = categoryRepresentativeTileId(top0Category);
    let top1Representative = categoryRepresentativeTileId(top1Category);
    let centerCategory = select(INVALID_CATEGORY_ID, tileCategory(centerTileId), validTile(centerTileId));
    let interiorTileId = select(
        top0Representative,
        centerTileId,
        validCategory(centerCategory) && centerCategory == top0Category
    );

    if (!validCategory(top1Category) || top1Score <= SCORE_EPSILON) {
        let encoded = f32(interiorTileId) / 255.0;
        textureStore(
            splatDataTexture,
            vec2<i32>(global_id.xy),
            vec4<f32>(encoded, encoded, 1.0, 0.0)
        );
        return;
    }

    let topPairSum = top0Score + top1Score;
    if (topPairSum <= SCORE_EPSILON) {
        let encoded = f32(interiorTileId) / 255.0;
        textureStore(
            splatDataTexture,
            vec2<i32>(global_id.xy),
            vec4<f32>(encoded, encoded, 1.0, 0.0)
        );
        return;
    }

    var biomeA = top0Representative;
    var biomeB = top1Representative;
    var weightOfBiomeA = top0Score / topPairSum;

    if (top1Representative < top0Representative) {
        biomeA = top1Representative;
        biomeB = top0Representative;
        weightOfBiomeA = top1Score / topPairSum;
    }

    textureStore(
        splatDataTexture,
        vec2<i32>(global_id.xy),
        vec4<f32>(
            f32(biomeA) / 255.0,
            f32(biomeB) / 255.0,
            clamp(weightOfBiomeA, 0.0, 1.0),
            1.0
        )
    );
}
`;
}
