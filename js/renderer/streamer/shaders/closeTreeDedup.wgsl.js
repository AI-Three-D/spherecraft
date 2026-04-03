export function buildCloseTreeDedupShader(config = {}) {
    const TRACKED_MAX_CLOSE_TREES = config.trackedMaxCloseTrees ?? config.maxCloseTrees ?? 512;
    const MAX_CLOSE_TREES = config.maxCloseTrees ?? 512;

    return /* wgsl */`
const TRACKED_MAX_CLOSE_TREES: u32 = ${TRACKED_MAX_CLOSE_TREES}u;
const MAX_CLOSE_TREES: u32 = ${MAX_CLOSE_TREES}u;
const DUPLICATE_DISTANCE_EPSILON: f32 = 0.25;

struct CloseTreeInfo {
    worldPosX: f32, worldPosY: f32, worldPosZ: f32, rotation: f32,
    scaleX: f32, scaleY: f32, scaleZ: f32, distanceToCamera: f32,
    speciesIndex: u32, variantSeed: u32, detailLevel: u32, sourceIndex: u32,
    foliageR: f32, foliageG: f32, foliageB: f32, foliageA: f32,
    barkR: f32, barkG: f32, barkB: f32, barkA: f32,
    leafStart: u32, leafCount: u32, clusterStart: u32, clusterCount: u32,
    windPhase: f32, health: f32, age: f32, tileTypeId: u32,
    bandBlend: f32, _res0: f32, _res1: f32, _res2: f32,
}

@group(0) @binding(0) var<storage, read>       trackedCloseTrees: array<CloseTreeInfo>;
@group(0) @binding(1) var<storage, read>       trackedCloseTreeCount: array<u32>;
@group(0) @binding(2) var<storage, read_write> uniqueCloseTrees: array<CloseTreeInfo>;
@group(0) @binding(3) var<storage, read_write> uniqueCloseTreeCount: array<u32>;
@group(0) @binding(4) var<storage, read_write> dedupStats: array<u32>;

fn sourceHash(tree: CloseTreeInfo) -> u32 {
    return bitcast<u32>(tree._res0);
}

fn approxSameTree(a: CloseTreeInfo, b: CloseTreeInfo) -> bool {
    if (a.tileTypeId != b.tileTypeId) { return false; }

    let posA = vec3<f32>(a.worldPosX, a.worldPosY, a.worldPosZ);
    let posB = vec3<f32>(b.worldPosX, b.worldPosY, b.worldPosZ);
    let posDelta = length(posA - posB);
    let heightDelta = abs(a.scaleY - b.scaleY);
    let widthDelta = abs(a.scaleX - b.scaleX);

    return posDelta <= 0.25 && heightDelta <= 0.25 && widthDelta <= 0.25;
}

fn isDuplicate(candidate: CloseTreeInfo, accepted: CloseTreeInfo) -> bool {
    let candidateHash = sourceHash(candidate);
    let acceptedHash = sourceHash(accepted);
    if (candidateHash != 0u && candidateHash == acceptedHash) {
        return true;
    }
    return approxSameTree(candidate, accepted);
}

fn preferCandidate(candidate: CloseTreeInfo, accepted: CloseTreeInfo) -> bool {
    if (candidate.distanceToCamera + DUPLICATE_DISTANCE_EPSILON < accepted.distanceToCamera) {
        return true;
    }
    if (accepted.distanceToCamera + DUPLICATE_DISTANCE_EPSILON < candidate.distanceToCamera) {
        return false;
    }

    if (candidate.tileTypeId != accepted.tileTypeId) {
        return candidate.tileTypeId < accepted.tileTypeId;
    }
    if (candidate.speciesIndex != accepted.speciesIndex) {
        return candidate.speciesIndex < accepted.speciesIndex;
    }
    if (candidate.scaleY > accepted.scaleY + 0.001) {
        return true;
    }
    if (accepted.scaleY > candidate.scaleY + 0.001) {
        return false;
    }
    if (candidate.scaleX > accepted.scaleX + 0.001) {
        return true;
    }
    if (accepted.scaleX > candidate.scaleX + 0.001) {
        return false;
    }
    if (candidate.worldPosX < accepted.worldPosX - 0.001) {
        return true;
    }
    if (accepted.worldPosX < candidate.worldPosX - 0.001) {
        return false;
    }
    if (candidate.worldPosY < accepted.worldPosY - 0.001) {
        return true;
    }
    if (accepted.worldPosY < candidate.worldPosY - 0.001) {
        return false;
    }
    if (candidate.worldPosZ < accepted.worldPosZ - 0.001) {
        return true;
    }
    if (accepted.worldPosZ < candidate.worldPosZ - 0.001) {
        return false;
    }
    return false;
}

@compute @workgroup_size(1)
fn main() {
    let trackedCount = trackedCloseTreeCount[0];
    let rawCount = min(trackedCount, TRACKED_MAX_CLOSE_TREES);
    let trackerOverflow = trackedCount - rawCount;
    var uniqueCount: u32 = 0u;
    var duplicateCount: u32 = 0u;
    var rejectedUniqueCount: u32 = 0u;

    for (var i = 0u; i < rawCount; i++) {
        let candidate = trackedCloseTrees[i];
        var duplicateIndex = 0xFFFFFFFFu;

        for (var j = 0u; j < uniqueCount; j++) {
            if (isDuplicate(candidate, uniqueCloseTrees[j])) {
                duplicateIndex = j;
                break;
            }
        }

        if (duplicateIndex != 0xFFFFFFFFu) {
            duplicateCount++;
            if (preferCandidate(candidate, uniqueCloseTrees[duplicateIndex])) {
                uniqueCloseTrees[duplicateIndex] = candidate;
            }
            continue;
        }

        if (uniqueCount < MAX_CLOSE_TREES) {
            uniqueCloseTrees[uniqueCount] = candidate;
            uniqueCount++;
            continue;
        }

        var farthestIndex = 0u;
        var farthestDistance = uniqueCloseTrees[0].distanceToCamera;
        for (var j = 1u; j < uniqueCount; j++) {
            let acceptedDistance = uniqueCloseTrees[j].distanceToCamera;
            if (acceptedDistance > farthestDistance) {
                farthestDistance = acceptedDistance;
                farthestIndex = j;
            }
        }

        if (candidate.distanceToCamera < farthestDistance) {
            uniqueCloseTrees[farthestIndex] = candidate;
        } else {
            rejectedUniqueCount++;
        }
    }

    uniqueCloseTreeCount[0] = uniqueCount;
    dedupStats[0] = rawCount;
    dedupStats[1] = uniqueCount;
    dedupStats[2] = duplicateCount;
    dedupStats[3] = trackerOverflow;
    dedupStats[4] = rejectedUniqueCount;
}
`;
}
