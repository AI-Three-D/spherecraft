export function buildAssetScatterShader(config = {}) {
    const WORKGROUP_SIZE = config.workgroupSize ?? 64;
    const NUM_CATEGORIES = config.numCategories ?? 3;
    const LODS_PER_CATEGORY = config.lodsPerCategory ?? 3;
    const TOTAL_BANDS = NUM_CATEGORIES * LODS_PER_CATEGORY;
    const MAX_SCATTER_TILE_WORLD_SIZE = config.maxScatterTileWorldSize ?? 48;

    const cats = config.categories || [];

    const maxCategoryDist = cats.length > 0
        ? Math.max(...cats.map(c => Math.max(...(c.lodDistances || [200]))))
        : 200;
    const maxScatterDistance = Number.isFinite(config.maxScatterDistance)
        ? config.maxScatterDistance
        : maxCategoryDist;

    // Fixed grid resolution per MAX_SCATTER tile — constant across all LODs.
    // This is the number of candidate cells per MAX_SCATTER_TILE_WORLD_SIZE side.
    const maxDensAll = Math.max(...cats.map(c => Math.max(...(c.densities || [0.001]))));
    const FIXED_GRID_RES = Math.max(1,
        Math.ceil(Math.sqrt(maxDensAll * MAX_SCATTER_TILE_WORLD_SIZE * MAX_SCATTER_TILE_WORLD_SIZE))
    );
    // Hard cap on candidates per tile to protect against huge coarse tiles
    const MAX_CANDIDATES_PER_TILE = FIXED_GRID_RES * FIXED_GRID_RES * 4;

    const tileTypeChecks = cats.map((cat, i) => {
        const checks = (cat.tileTypes || [])
            .map(id => `tileId == ${id}u`).join(' || ');
        return `    if (${checks || 'false'}) { catMask = catMask | (1u << ${i}u); }`;
    }).join('\n');

    const catConstants = cats.map((cat, i) => {
        const ld  = Array.isArray(cat.lodDistances) ? cat.lodDistances.slice() : [30, 80, 200];
        const dens = Array.isArray(cat.densities) ? cat.densities.slice() : [0.001, 0.0005, 0.0001];
        while (ld.length < LODS_PER_CATEGORY) {
            ld.push(ld[ld.length - 1] + 1);
        }
        while (dens.length < LODS_PER_CATEGORY) {
            dens.push(0.0);
        }
        const sw  = cat.sizeRange?.width  || [0.1, 0.3];
        const sh  = cat.sizeRange?.height || [0.3, 1.0];
        const bc  = cat.baseColor || [0.3, 0.3, 0.3];
        const tc  = cat.tipColor  || [0.5, 0.5, 0.5];
        return `
const CAT${i}_LOD_DIST: array<f32, ${LODS_PER_CATEGORY}u> = array<f32, ${LODS_PER_CATEGORY}u>(${ld.map(v => v.toFixed(1)).join(', ')});
const CAT${i}_DENS: array<f32, ${LODS_PER_CATEGORY}u> = array<f32, ${LODS_PER_CATEGORY}u>(${dens.join(', ')});
const CAT${i}_MIN_W:      f32 = ${sw[0]};
const CAT${i}_MAX_W:      f32 = ${sw[1]};
const CAT${i}_MIN_H:      f32 = ${sh[0]};
const CAT${i}_MAX_H:      f32 = ${sh[1]};
const CAT${i}_BASE_R:     f32 = ${bc[0]};
const CAT${i}_BASE_G:     f32 = ${bc[1]};
const CAT${i}_BASE_B:     f32 = ${bc[2]};
const CAT${i}_TIP_R:      f32 = ${tc[0]};
const CAT${i}_TIP_G:      f32 = ${tc[1]};
const CAT${i}_TIP_B:      f32 = ${tc[2]};`;
    }).join('\n');

    // Per-category emit block — uses worldSeed (global, LOD-independent).
    // keepProb is density/m² * cell_area. candidateScale compensates for
    // tiles larger than MAX_SCATTER_TILE_WORLD_SIZE.
    const catEmitBlocks = cats.map((cat, i) => {
        const bandBase = i * LODS_PER_CATEGORY;
        return `
    if ((catMask & (1u << ${i}u)) != 0u) {
        var band${i}: u32 = 0xFFFFFFFFu;
        var dens${i}: f32 = 0.0;
        for (var i${i}: u32 = 0u; i${i} < ${LODS_PER_CATEGORY}u; i${i}++) {
            if (dist < CAT${i}_LOD_DIST[i${i}]) {
                band${i} = ${bandBase}u + i${i};
                dens${i} = CAT${i}_DENS[i${i}];
                break;
            }
        }
        if (band${i} != 0xFFFFFFFFu) {
            // keepProb = P(this cell contains an instance) = density * cellArea * candidateScale
            // candidateScale compensates when this tile covers more world area than
            // MAX_SCATTER_TILE_WORLD_SIZE (coarse LOD tiles).
let keepProb${i} = clamp(
    CAT${i}_DENS_NEAR * td.cellWorldArea * td.candidateScale,
    0.0, 1.0
);
            // Unique per-category thinning from the same world seed
            let thinRng${i} = pcgF(worldSeed ^ ${(i * 7 + 3) >>> 0}u);
            if (thinRng${i} < keepProb${i}) {
                let metab${i} = bandMeta[band${i}];
                let idx${i}  = atomicAdd(&bandCounters[band${i}], 1u);
                if (idx${i} < metab${i}.capacity) {
                    let gIdx${i}  = metab${i}.baseOffset + idx${i};
                    // All attributes from worldSeed — stable across LOD levels
                    let rot${i}  = pcgF(worldSeed ^ ${(i * 13 + 17) >>> 0}u) * 6.2831853;
                    let sw${i}   = pcgF(worldSeed ^ ${(i * 19 + 29) >>> 0}u);
                    let sh${i}   = pcgF(worldSeed ^ ${(i * 23 + 37) >>> 0}u);
                    let w${i}    = mix(CAT${i}_MIN_W, CAT${i}_MAX_W, sw${i});
                    let h${i}    = mix(CAT${i}_MIN_H, CAT${i}_MAX_H, sh${i});
                    let cj${i}   = pcgF(worldSeed ^ ${(i * 31 + 41) >>> 0}u);
                    let cr${i}   = mix(CAT${i}_BASE_R, CAT${i}_TIP_R, cj${i});
                    let cg${i}   = mix(CAT${i}_BASE_G, CAT${i}_TIP_G, cj${i});
                    let cb${i}   = mix(CAT${i}_BASE_B, CAT${i}_TIP_B, cj${i});
                    instances[gIdx${i}] = AssetInstance(
                        worldPos.x, worldPos.y, worldPos.z,
                        rot${i}, w${i}, h${i},
                        tileId, band${i},
                        cr${i}, cg${i}, cb${i}, 1.0,
                        sphereDir.x, sphereDir.y, sphereDir.z, 0.0
                    );
                }
            }
        }
    }`;
    }).join('\n');

    return /* wgsl */`
// ─── Tile-Based Asset Scatter — Face-UV Global Grid ────────────────────────
// Candidates are placed on a global grid in face-UV space.
// The seed of every candidate derives from its integer face-UV cell (gcX, gcY)
// plus the engine seed — completely independent of tile depth/face/x/y.
// This guarantees the same placement, rotation, and size at every LOD level.

const WORKGROUP_SIZE:           u32 = ${WORKGROUP_SIZE}u;
const MAX_SCATTER_TILE_WS:      f32 = ${MAX_SCATTER_TILE_WORLD_SIZE.toFixed(1)};
const MAX_SCATTER_DISTANCE:     f32 = ${maxScatterDistance.toFixed(1)};
const BAND_COUNT:               u32 = ${TOTAL_BANDS}u;
const NUM_CATEGORIES:           u32 = ${NUM_CATEGORIES}u;
const MAX_PARENT_SEARCH:        u32 = 16u;
// Fixed candidates per MAX_SCATTER_TILE side, baked at compile time.
const FIXED_GRID_RES:           u32 = ${FIXED_GRID_RES}u;
// Cell world-space area when tileWorldSize == MAX_SCATTER_TILE_WS
const BASE_CELL_WORLD_AREA:     f32 = ${
    (MAX_SCATTER_TILE_WORLD_SIZE * MAX_SCATTER_TILE_WORLD_SIZE /
     (FIXED_GRID_RES * FIXED_GRID_RES)).toFixed(6)
};
const MAX_CANDIDATES_PER_TILE:  u32 = ${MAX_CANDIDATES_PER_TILE}u;
const MAX_PARENT_SEARCH_COUNT:  u32 = 16u;
${catConstants}

// ── Structs ─────────────────────────────────────────────────────────────────

struct ScatterParams {
    cameraPosition:  vec3<f32>,
    _pad0:           f32,
    planetOrigin:    vec3<f32>,
    planetRadius:    f32,
    heightScale:     f32,
    maxDensity:      f32,
    faceSize:        f32,
    seed:            u32,
    time:            f32,
    tileCount:       u32,
    _pad1:           f32,
    _pad2:           f32,
    viewProjection:  mat4x4<f32>,
}

struct BandMeta {
    baseOffset: u32,
    capacity:   u32,
    _pad0:      u32,
    _pad1:      u32,
}

struct AssetInstance {
    posX: f32, posY: f32, posZ: f32, rotation: f32,
    width: f32, height: f32,
    tileTypeId: u32, bandIndex: u32,
    colorR: f32, colorG: f32, colorB: f32, colorA: f32,
    surfaceNX: f32, surfaceNY: f32, surfaceNZ: f32, _pad0: f32,
}

struct LoadedEntry {
    keyLo: u32, keyHi: u32, layer: u32, _pad: u32,
}

// ── Workgroup shared tile data ───────────────────────────────────────────────
// Populated by thread 0 only; all other threads read after workgroupBarrier().
struct TileData {
    face:          u32,
    depth:         u32,
    tileX:         u32,
    tileY:         u32,
    layer:         i32,
    uvBiasX:       f32,
    uvBiasY:       f32,
    uvScale:       f32,
    tileUMin:      f32,
    tileVMin:      f32,
    tileUVSize:    f32,
    // Global-grid bounds (integer face-UV cell indices)
    gcMinX:        i32,
    gcMinY:        i32,
    gcCellsX:      u32,
    gcCellsY:      u32,
    totalCandidates: u32,
    // Scale: cells-per-face-UV-unit (runtime, depends on faceSize)
    globalCellScale:  f32,
    // World area of one global cell (m²), accounts for candidateScale
    cellWorldArea:    f32,
    // candidateScale: ratio for tiles larger than MAX_SCATTER_TILE_WS
    candidateScale:   f32,
    shouldProcess:    u32,
}

var<workgroup> td: TileData;

// ── Bindings ─────────────────────────────────────────────────────────────────
@group(0) @binding(0) var<uniform>            params:            ScatterParams;
@group(0) @binding(1) var<storage, read>      visibleTiles:      array<vec4<u32>>;
@group(0) @binding(2) var<storage, read_write> instances:        array<AssetInstance>;
@group(0) @binding(3) var<storage, read_write> bandCounters:     array<atomic<u32>, BAND_COUNT>;
@group(0) @binding(4) var<uniform>            bandMeta:          array<BandMeta, BAND_COUNT>;
@group(0) @binding(5) var                     heightTex:         texture_2d_array<f32>;
@group(0) @binding(6) var                     tileTex:           texture_2d_array<f32>;
@group(0) @binding(7) var<storage, read>      loadedTable:       array<LoadedEntry>;
@group(0) @binding(8) var<uniform>            loadedTableParams: vec2<u32>;
@group(0) @binding(9) var<storage, read_write> traversalCounters: array<atomic<u32>, 4>;

const EMPTY_KEY: u32 = 0xFFFFFFFFu;

// ── PCG Hash ─────────────────────────────────────────────────────────────────

fn pcg(v: u32) -> u32 {
    var s = v * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    return (w >> 22u) ^ w;
}

fn pcgF(v: u32) -> f32 {
    return f32(pcg(v)) / 4294967296.0;
}

fn pcg2(a: u32, b: u32) -> u32 {
    return pcg(a ^ (b * 1664525u + 1013904223u));
}

fn pcg2F(seed: u32) -> vec2<f32> {
    let h1 = pcg(seed);
    let h2 = pcg(h1);
    return vec2<f32>(f32(h1) / 4294967296.0, f32(h2) / 4294967296.0);
}

// ── Hash Table ───────────────────────────────────────────────────────────────

fn makeKeyLo(x: u32, y: u32) -> u32 { return x | (y << 16u); }
fn makeKeyHi(face: u32, depth: u32) -> u32 { return (depth & 0xFFFFu) | (face << 16u); }

fn hashKey(keyLo: u32, keyHi: u32, mask: u32) -> u32 {
    return (keyLo * 1664525u + keyHi * 1013904223u) & mask;
}

fn lookupLayerExact(face: u32, depth: u32, x: u32, y: u32) -> i32 {
    let keyLo = makeKeyLo(x, y);
    let keyHi = makeKeyHi(face, depth);
    let mask = loadedTableParams.x;
    let cap  = loadedTableParams.y;
    var idx  = hashKey(keyLo, keyHi, mask);
    for (var i = 0u; i < cap; i++) {
        let e = loadedTable[idx];
        if (e.keyHi == EMPTY_KEY) { return -1; }
        if (e.keyHi == keyHi && e.keyLo == keyLo) { return i32(e.layer); }
        idx = (idx + 1u) & mask;
    }
    return -1;
}

struct FallbackResult { layer: i32, uvBiasX: f32, uvBiasY: f32, uvScale: f32, }

fn lookupLayerWithFallback(face: u32, depth: u32, x: u32, y: u32) -> FallbackResult {
    let exact = lookupLayerExact(face, depth, x, y);
    if (exact >= 0) { return FallbackResult(exact, 0.0, 0.0, 1.0); }
    var d = depth; var tx = x; var ty = y;
    var scale = 1.0; var biasX = 0.0; var biasY = 0.0;
    for (var step = 0u; step < MAX_PARENT_SEARCH; step++) {
        if (d == 0u) { break; }
        scale *= 0.5;
        biasX += f32(tx & 1u) * scale;
        biasY += f32(ty & 1u) * scale;
        tx >>= 1u; ty >>= 1u; d -= 1u;
        let pl = lookupLayerExact(face, d, tx, ty);
        if (pl >= 0) { return FallbackResult(pl, biasX, biasY, scale); }
    }
    return FallbackResult(-1, 0.0, 0.0, 1.0);
}

// ── Sphere projection ────────────────────────────────────────────────────────

fn getCubePoint(face: u32, u: f32, v: f32) -> vec3<f32> {
    let s = u * 2.0 - 1.0;
    let t = v * 2.0 - 1.0;
    switch (face) {
        case 0u { return vec3<f32>( 1.0,  t, -s); }
        case 1u { return vec3<f32>(-1.0,  t,  s); }
        case 2u { return vec3<f32>(  s, 1.0, -t); }
        case 3u { return vec3<f32>(  s,-1.0,  t); }
        case 4u { return vec3<f32>(  s,  t, 1.0); }
        default { return vec3<f32>( -s,  t,-1.0); }
    }
}

// ── Tile culling ─────────────────────────────────────────────────────────────

fn isTileBeyondScatterRange(face: u32, depth: u32, tileX: u32, tileY: u32) -> bool {
    let gridSize   = f32(1u << depth);
    let cu         = (f32(tileX) + 0.5) / gridSize;
    let cv         = (f32(tileY) + 0.5) / gridSize;
    let cWorld     = params.planetOrigin + normalize(getCubePoint(face, cu, cv)) * params.planetRadius;
    let tileDist   = length(params.cameraPosition - cWorld);
    let tileWS     = params.faceSize / gridSize;
    let margin     = tileWS * 0.75 + 1.8 * params.heightScale;
    return (tileDist - margin) > MAX_SCATTER_DISTANCE;
}

fn getRow(m: mat4x4<f32>, r: u32) -> vec4<f32> {
    return vec4<f32>(m[0][r], m[1][r], m[2][r], m[3][r]);
}

fn isTileOutsideFrustum(face: u32, depth: u32, tileX: u32, tileY: u32) -> bool {
    let gridSize  = f32(1u << depth);
    let cu        = (f32(tileX) + 0.5) / gridSize;
    let cv        = (f32(tileY) + 0.5) / gridSize;
    let cWorld    = params.planetOrigin + normalize(getCubePoint(face, cu, cv)) * params.planetRadius;
    let tileWS    = params.faceSize / gridSize;
    let radius    = tileWS * 0.75 + 1.8 * params.heightScale;
    let row0 = getRow(params.viewProjection, 0u);
    let row1 = getRow(params.viewProjection, 1u);
    let row2 = getRow(params.viewProjection, 2u);
    let row3 = getRow(params.viewProjection, 3u);
    let planes = array<vec4<f32>, 6>(
        row3 + row0, row3 - row0,
        row3 + row1, row3 - row1,
        row3 + row2, row3 - row2
    );
    for (var i = 0u; i < 6u; i++) {
        let p = planes[i]; let n = p.xyz; let nLen = length(n);
        if (nLen < 0.0001) { continue; }
        if ((dot(n, cWorld) + p.w) / nLen < -radius) { return true; }
    }
    return false;
}

// ── Main ─────────────────────────────────────────────────────────────────────

@compute @workgroup_size(${WORKGROUP_SIZE}, 1, 1)
fn main(
    @builtin(workgroup_id)          wgId:      vec3<u32>,
    @builtin(local_invocation_index) threadIdx: u32
) {
    let tileIdx = wgId.x;

    // ── Thread 0: tile setup ─────────────────────────────────────────────
    if (threadIdx == 0u) {
        let actualTileCount = min(atomicLoad(&traversalCounters[2]), params.tileCount);

        if (tileIdx >= actualTileCount) {
            td.shouldProcess = 0u;
        } else {
            let tile  = visibleTiles[tileIdx];
            td.face   = tile.x;
            td.depth  = tile.y;
            td.tileX  = tile.z;
            td.tileY  = tile.w;

            if (isTileBeyondScatterRange(td.face, td.depth, td.tileX, td.tileY) ||
                isTileOutsideFrustum(td.face, td.depth, td.tileX, td.tileY)) {
                td.shouldProcess = 0u;
            } else {
                let fb = lookupLayerWithFallback(td.face, td.depth, td.tileX, td.tileY);
                if (fb.layer < 0) {
                    td.shouldProcess = 0u;
                } else {
                    td.layer    = fb.layer;
                    td.uvBiasX  = fb.uvBiasX;
                    td.uvBiasY  = fb.uvBiasY;
                    td.uvScale  = fb.uvScale;

                    let gridSize    = f32(1u << td.depth);
                    td.tileUMin     = f32(td.tileX) / gridSize;
                    td.tileVMin     = f32(td.tileY) / gridSize;
                    td.tileUVSize   = 1.0 / gridSize;

                    // ── Global face-UV grid scale ────────────────────────
                    // globalCellScale = cells per face-UV unit
                    // = FIXED_GRID_RES tiles per MAX_SCATTER_TILE_WS * faceSize
                    // This is a runtime value because faceSize is dynamic.
                    let rawTileWS = params.faceSize / gridSize;
                    let gcs = f32(FIXED_GRID_RES) * params.faceSize / MAX_SCATTER_TILE_WS;
                    td.globalCellScale = gcs;

           let clampedWS      = min(rawTileWS, MAX_SCATTER_TILE_WS);
let scaleRatio     = rawTileWS / max(clampedWS, 0.001);
td.candidateScale  = scaleRatio * scaleRatio;

// Cell world area is ALWAYS based on the global grid spacing,
// not the local tile size. The global grid has fixed cell pitch
// MAX_SCATTER_TILE_WS / FIXED_GRID_RES regardless of which tile
// iterates over it. Using the tile's local size here made keepProb
// depend on tile depth, causing instances to appear/disappear
// when the quadtree refined or coarsened.
let globalCellSizeM = MAX_SCATTER_TILE_WS / f32(FIXED_GRID_RES);
td.cellWorldArea    = globalCellSizeM * globalCellSizeM;

                    // ── Global cell range for this tile ─────────────────
                    // We iterate integer cell indices [gcMinX..gcMinX+gcCellsX) x ...
                    let uMax  = td.tileUMin + td.tileUVSize;
                    let vMax  = td.tileVMin + td.tileUVSize;
                    let gcMinX = i32(floor(td.tileUMin * gcs));
                    let gcMinY = i32(floor(td.tileVMin * gcs));
                    let gcMaxX = i32(ceil(uMax * gcs));
                    let gcMaxY = i32(ceil(vMax * gcs));

                    // Cap: never more than MAX_CANDIDATES_PER_TILE per workgroup.
                    // For very large coarse tiles this subsamples — same semantic as
                    // the original MAX_SCATTER_TILE_WORLD_SIZE cap.
                    let capSide  = i32(ceil(sqrt(f32(MAX_CANDIDATES_PER_TILE))));
                    let clamMaxX = min(gcMaxX, gcMinX + capSide);
                    let clamMaxY = min(gcMaxY, gcMinY + capSide);

                    td.gcMinX        = gcMinX;
                    td.gcMinY        = gcMinY;
                    td.gcCellsX      = u32(max(clamMaxX - gcMinX, 0));
                    td.gcCellsY      = u32(max(clamMaxY - gcMinY, 0));
                    td.totalCandidates = td.gcCellsX * td.gcCellsY;
                    td.shouldProcess = 1u;
                }
            }
        }
    }

    workgroupBarrier();
    if (td.shouldProcess == 0u) { return; }

    // ── Cooperative candidate processing ─────────────────────────────────
    let layer = td.layer;

    for (var candidateIdx = threadIdx;
         candidateIdx < td.totalCandidates;
         candidateIdx += WORKGROUP_SIZE)
    {
        let localX = candidateIdx % td.gcCellsX;
        let localY = candidateIdx / td.gcCellsX;
        let gcX    = td.gcMinX + i32(localX);
        let gcY    = td.gcMinY + i32(localY);

        // ── Stable world seed ────────────────────────────────────────────
        // Depends ONLY on the global cell coordinates and the engine seed.
        // Identical regardless of which tile depth processes this cell.
        let worldSeed = pcg2(
            u32(gcX) ^ (td.face * 2654435761u),
            u32(gcY) ^ params.seed
        );

        // ── Jitter within cell → face UV ─────────────────────────────────
        let jitter = pcg2F(worldSeed);
        let faceU  = (f32(gcX) + jitter.x) / td.globalCellScale;
        let faceV  = (f32(gcY) + jitter.y) / td.globalCellScale;

        // Reject candidates outside this tile's exact UV bounds.
        // Adjacent tiles will handle cells near the edges.
        let uMax = td.tileUMin + td.tileUVSize;
        let vMax = td.tileVMin + td.tileUVSize;
        if (faceU < td.tileUMin || faceU >= uMax ||
            faceV < td.tileVMin || faceV >= vMax) {
            continue;
        }

        // ── Texture sampling UV ──────────────────────────────────────────
        // Convert face UV → tile-relative UV → biased UV for the loaded layer.
        let relU   = (faceU - td.tileUMin) / td.tileUVSize;
        let relV   = (faceV - td.tileVMin) / td.tileUVSize;
        let texU   = td.uvBiasX + relU * td.uvScale;
        let texV   = td.uvBiasY + relV * td.uvScale;

        // Sample tile type (no inverse sphere math — straight face UV)
        let tSize   = vec2<i32>(textureDimensions(tileTex));
        let tCoord  = clamp(vec2<i32>(vec2<f32>(texU, texV) * vec2<f32>(tSize)),
                            vec2<i32>(0), tSize - vec2<i32>(1));
        let tileSmp = textureLoad(tileTex, tCoord, layer, 0);
        let rawR    = tileSmp.r;
        let tileIdF = select(rawR * 255.0, rawR, rawR > 1.0);
        let tileId  = u32(tileIdF + 0.5);

        var catMask: u32 = 0u;
${tileTypeChecks}
        if (catMask == 0u) { continue; }

        // Sample height
        let hSize  = vec2<i32>(textureDimensions(heightTex));
        let hCoord = clamp(vec2<i32>(vec2<f32>(texU, texV) * vec2<f32>(hSize)),
                           vec2<i32>(0), hSize - vec2<i32>(1));
        let heightSample = textureLoad(heightTex, hCoord, layer, 0).r;

        // World position — getCubePoint uses face UV directly, no inverse needed
        let cubePoint  = getCubePoint(td.face, faceU, faceV);
        let sphereDir  = normalize(cubePoint);
        let radius     = params.planetRadius + heightSample * params.heightScale;
        let worldPos   = params.planetOrigin + sphereDir * radius;
        let dist       = length(params.cameraPosition - worldPos);

${catEmitBlocks}
    }
}
`;
}
