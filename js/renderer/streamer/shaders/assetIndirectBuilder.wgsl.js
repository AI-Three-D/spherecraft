// js/renderer/streamer/shaders/assetIndirectBuilder.wgsl.js
//
// Reads per-band atomic counters and writes DrawIndexedIndirect args.

export function buildAssetIndirectShader(config = {}) {
    const TOTAL_BANDS = config.totalBands ?? 9;
    const vec4Count = Math.ceil(TOTAL_BANDS / 4);

    return /* wgsl */`

struct BandMeta {
    baseOffset: u32,
    capacity: u32,
    _pad0: u32,
    _pad1: u32,
}

@group(0) @binding(0) var<storage, read_write> bandCounters: array<atomic<u32>, ${TOTAL_BANDS}u>;
@group(0) @binding(1) var<uniform> bandMeta: array<BandMeta, ${TOTAL_BANDS}u>;
@group(0) @binding(2) var<storage, read_write> indirectArgs: array<u32>;

struct LodIndexCounts {
    counts: array<vec4<u32>, ${vec4Count}u>,
}
@group(0) @binding(3) var<uniform> lodIndexCounts: LodIndexCounts;

fn getIndexCount(band: u32) -> u32 {
    let vecIdx = band / 4u;
    let lane = band - vecIdx * 4u;
    return lodIndexCounts.counts[vecIdx][i32(lane)];
}

@compute @workgroup_size(1)
fn main() {
    for (var band = 0u; band < ${TOTAL_BANDS}u; band++) {
        let count = atomicLoad(&bandCounters[band]);
        let metab = bandMeta[band];
        let actualCount = min(count, metab.capacity);

        // DrawIndexedIndirect: [indexCount, instanceCount, firstIndex, baseVertex, firstInstance]
        let base = band * 5u;
        indirectArgs[base + 0u] = getIndexCount(band);
        indirectArgs[base + 1u] = actualCount;
        indirectArgs[base + 2u] = 0u;
        indirectArgs[base + 3u] = 0u;
        indirectArgs[base + 4u] = metab.baseOffset;
    }
}
`;
}
