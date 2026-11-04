// Density decoding matches VoxelVolume, including interpolation across chunk boundaries.
export const volumeDeclarationsWGSL = /* wgsl */ `
struct Volume {
    origin: vec4<f32>, // min xyz, voxel size
    counts: vec4<u32>, // lattice xyz, chunk size
    chunks: vec4<u32>, // chunk grid xyz, packed words per chunk
    normalDepth: vec4<f32>, // normal toward viewer, visibility limit in metres
}
@group(0) @binding(4) var<uniform> volume: Volume;
@group(0) @binding(5) var<storage, read> columns: array<f32>;
@group(0) @binding(6) var<storage, read> chunkMap: array<u32>;
@group(0) @binding(7) var<storage, read> densities: array<u32>;
`;

export const volumeFunctionsWGSL = /* wgsl */ `
fn divideByBlock(i: vec3<u32>, n: u32) -> vec3<u32> {
    if((n & (n-1u)) == 0u) { return i >> vec3<u32>(firstLeadingBit(n)); }
    return i/n;
}
fn latticeDensity(i: vec3<u32>) -> f32 {
    let n = volume.counts.w;
    let chunk = divideByBlock(i,n);
    let slot = chunkMap[(chunk.z * volume.chunks.y + chunk.y) * volume.chunks.x + chunk.x];
    if (slot == 0u) {
        let value = (columns[i.z * volume.counts.x + i.x] - f32(i.y)) * (127.0 / view.cutSize.z);
        return clamp(floor(value + 0.5), -127.0, 127.0);
    }
    let local = i-chunk*n;
    let index = (local.z * n + local.y) * n + local.x;
    let word = densities[(slot - 1u) * volume.chunks.w + index / 4u];
    return f32((word >> ((index % 4u) * 8u)) & 255u) - 128.0;
}

fn volumeDensityAcrossChunks(p: vec3<f32>) -> f32 {
    let g = clamp((p - volume.origin.xyz) / volume.origin.w,
        vec3<f32>(0.0), vec3<f32>(volume.counts.xyz - vec3<u32>(1u)));
    let i = min(vec3<u32>(floor(g)), volume.counts.xyz - vec3<u32>(2u));
    let t = g - vec3<f32>(i);
    let a = mix(latticeDensity(i), latticeDensity(i + vec3<u32>(1, 0, 0)), t.x);
    let b = mix(latticeDensity(i + vec3<u32>(0, 1, 0)), latticeDensity(i + vec3<u32>(1, 1, 0)), t.x);
    let c = mix(latticeDensity(i + vec3<u32>(0, 0, 1)), latticeDensity(i + vec3<u32>(1, 0, 1)), t.x);
    let d = mix(latticeDensity(i + vec3<u32>(0, 1, 1)), latticeDensity(i + vec3<u32>(1, 1, 1)), t.x);
    return mix(mix(a, b, t.y), mix(c, d, t.y), t.z);
}

// Most interpolation cells stay inside one edit chunk. Resolve its address once,
// instead of doing eight vector integer divisions and eight sparse-map lookups.
// Keep the cross-chunk path for exact interpolation at chunk boundaries.
fn packedDensity(base: u32, index: u32) -> f32 {
    let word = densities[base + index / 4u];
    return f32((word >> ((index % 4u) * 8u)) & 255u) - 128.0;
}
struct DensityCell { lower: vec4<f32>, upper: vec4<f32>, t: vec3<f32> }
fn densityCell(p: vec3<f32>) -> DensityCell {
    let g = clamp((p-volume.origin.xyz)/volume.origin.w,vec3<f32>(0),
        vec3<f32>(volume.counts.xyz-vec3<u32>(1)));
    let i = min(vec3<u32>(floor(g)),volume.counts.xyz-vec3<u32>(2));
    let t = g-vec3<f32>(i);
    let n = volume.counts.w;
    let chunk = divideByBlock(i,n);
    let local = i-chunk*n;
    if(any(local >= vec3<u32>(n-1u))) {
        return DensityCell(
            vec4<f32>(latticeDensity(i),latticeDensity(i+vec3<u32>(1,0,0)),latticeDensity(i+vec3<u32>(0,0,1)),latticeDensity(i+vec3<u32>(1,0,1))),
            vec4<f32>(latticeDensity(i+vec3<u32>(0,1,0)),latticeDensity(i+vec3<u32>(1,1,0)),latticeDensity(i+vec3<u32>(0,1,1)),latticeDensity(i+vec3<u32>(1,1,1))),t);
    }
    let slot = chunkMap[(chunk.z*volume.chunks.y+chunk.y)*volume.chunks.x+chunk.x];
    var lower: vec4<f32>;
    var upper: vec4<f32>;
    if(slot == 0u) {
        let c = i.z*volume.counts.x+i.x;
        let h = vec4<f32>(columns[c],columns[c+1u],columns[c+volume.counts.x],columns[c+volume.counts.x+1u]);
        let scale = 127.0/view.cutSize.z;
        lower = clamp(floor((h-f32(i.y))*scale+vec4<f32>(0.5)),vec4<f32>(-127),vec4<f32>(127));
        upper = clamp(floor((h-f32(i.y+1u))*scale+vec4<f32>(0.5)),vec4<f32>(-127),vec4<f32>(127));
    } else {
        let base = (slot-1u)*volume.chunks.w;
        let c = (local.z*n+local.y)*n+local.x;
        lower = vec4<f32>(packedDensity(base,c),packedDensity(base,c+1u),packedDensity(base,c+n*n),packedDensity(base,c+n*n+1u));
        upper = vec4<f32>(packedDensity(base,c+n),packedDensity(base,c+n+1u),packedDensity(base,c+n*n+n),packedDensity(base,c+n*n+n+1u));
    }
    return DensityCell(lower,upper,t);
}
fn volumeDensity(p: vec3<f32>) -> f32 {
    let cell=densityCell(p);
    let lower=cell.lower;
    let upper=cell.upper;
    let t=cell.t;
    let a = mix(lower.x,lower.y,t.x);
    let b = mix(upper.x,upper.y,t.x);
    let c = mix(lower.z,lower.w,t.x);
    let d = mix(upper.z,upper.w,t.x);
    return mix(mix(a,b,t.y),mix(c,d,t.y),t.z);
}
// Exact gradient of the reconstructed trilinear field, from the same eight samples.
// Central differences would gather and decode 48 lattice samples per visible wall.
fn volumeGradient(p: vec3<f32>) -> vec3<f32> {
    let cell=densityCell(p);
    let l=cell.lower;
    let u=cell.upper;
    let t=cell.t;
    return vec3<f32>(
        mix(mix(l.y-l.x,u.y-u.x,t.y),mix(l.w-l.z,u.w-u.z,t.y),t.z),
        mix(mix(u.x-l.x,u.y-l.y,t.x),mix(u.z-l.z,u.w-l.w,t.x),t.z),
        mix(mix(l.z-l.x,l.w-l.y,t.x),mix(u.z-u.x,u.w-u.y,t.x),t.y));
}

// Fallback when a smooth-normal cache slot cannot fit the device's binding limit.
// A continuous shading gradient across interpolation-cell and sparse-chunk borders.
// Four tetrahedral density probes replace a six-probe central difference. This is
// only used at visible hits; traversal and shadow rays keep the exact density field.
fn volumeFilteredGradient(p: vec3<f32>) -> vec3<f32> {
    let h = volume.origin.w * 0.5;
    let a = vec3<f32>(1,-1,-1);
    let b = vec3<f32>(-1,-1,1);
    let c = vec3<f32>(-1,1,-1);
    let d = vec3<f32>(1,1,1);
    return a * volumeDensity(p + a*h) + b * volumeDensity(p + b*h)
        + c * volumeDensity(p + c*h) + d * volumeDensity(p + d*h);
}

// A bounded search through the retained half-space. Step <= half a voxel; no SDF
// sphere tracing assumption (CSG density is clamped and may contain narrow walls).
// .w < 0 means open space / outside the region / beyond the visibility limit.
fn farWall(start: vec3<f32>) -> vec4<f32> {
    let direction = -volume.normalDepth.xyz;
    let step = volume.origin.w * 0.5;
    let end = volume.origin.xyz + vec3<f32>(volume.counts.xyz - vec3<u32>(1u)) * volume.origin.w;
    var previous = 0.0;
    for (var index = 1u; index <= 2048u; index++) {
        let depth = f32(index) * step;
        if (depth > volume.normalDepth.w) { break; }
        let p = start + direction * depth;
        if (any(p < volume.origin.xyz) || any(p > end)) { break; }
        if (volumeDensity(p) > 0.0) {
            var low = previous;
            var high = depth;
            for (var refine = 0u; refine < 6u; refine++) {
                let mid = (low + high) * 0.5;
                if (volumeDensity(start + direction * mid) > 0.0) { high = mid; }
                else { low = mid; }
            }
            return vec4<f32>(start + direction * high, high);
        }
        previous = depth;
    }
    return vec4<f32>(0.0, 0.0, 0.0, -1.0);
}

fn wallShade(hit: vec4<f32>) -> vec3<f32> {
    let p = hit.xyz;
    let gradient = volumeGradient(p);
    let normal = -gradient / max(length(gradient), 0.00001);
    let light = normalize(volume.normalDepth.xyz + vec3<f32>(0.0, 0.7, 0.0));
    let diffuse = 0.25 + 0.55 * max(dot(normal, light), 0.0);
    let visibility = exp(-3.0 * hit.w / volume.normalDepth.w);
    return rockColor(p, view.params.x) * diffuse * visibility;
}
`;
