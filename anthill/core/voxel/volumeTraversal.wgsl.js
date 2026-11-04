export const viewStruct = /* wgsl */ `
struct View {
    clipFromLocal: mat4x4<f32>, params: vec4<f32>, cutOrigin: vec4<f32>, cutSize: vec4<f32>,
    eye: vec4<f32>, right: vec4<f32>, up: vec4<f32>, direction: vec4<f32>, plane: vec4<f32>,
}
@group(0) @binding(0) var<uniform> view: View;
`;

export const volumeBoundsDeclarationsWGSL = /* wgsl */ `
@group(0) @binding(8) var<storage, read> chunkMaxima: array<f32>;
@group(0) @binding(9) var<storage, read> coarseMaxima: array<f32>;
`;

export const volumeTraversalWGSL = /* wgsl */ `
// Bounds already include the positive one-sample interpolation halo. The old
// eight-whole-block union needlessly classified open tunnels as potentially solid.
fn blockBounds(p: vec3<f32>, direction: vec3<f32>, fine: bool) -> vec3<f32> {
    var n = volume.counts.w;
    var boundsCounts = volume.chunks.xyz;
    if(fine) { n = u32(view.cutOrigin.x); boundsCounts = vec3<u32>(view.cutOrigin.yzw); }
    let g = clamp((p-volume.origin.xyz)/volume.origin.w, vec3<f32>(0),
        vec3<f32>(volume.counts.xyz-vec3<u32>(2)));
    let block = divideByBlock(vec3<u32>(g),n);
    let index = (block.z*boundsCounts.y+block.y)*boundsCounts.x+block.x;
    var maximum = -127.0;
    if (fine) { maximum = chunkMaxima[index]; }
    else { maximum = coarseMaxima[index]; }
    var edited = 0.0;
    // Carve-only edits cannot put rock above the captured terrain. Keep using
    // its height bound even over mined chunks; fills restore the conservative check.
    if (!fine && view.cutSize.w < 0.5) { for (var z = 0u; z < 2u; z++) {
        for (var y = 0u; y < 2u; y++) {
            for (var x = 0u; x < 2u; x++) {
                let c = min(block+vec3<u32>(x,y,z), boundsCounts-vec3<u32>(1));
                let i = (c.z*boundsCounts.y+c.y)*boundsCounts.x+c.x;
                if(chunkMap[i]!=0u) { edited=1.0; }
            }
        }
    } }
    var exit = 1e20;
    for (var axis = 0u; axis < 3u; axis++) {
        if (abs(direction[axis]) > 0.0000001) {
            var boundary = f32(block[axis]*n)*volume.origin.w+volume.origin[axis];
            if (direction[axis] > 0.0) { boundary += f32(n)*volume.origin.w; }
            exit = min(exit,max(0.0,(boundary-p[axis])/direction[axis]));
        }
    }
    return vec3<f32>(exit, maximum, edited);
}
// Used where samples are procedural, or edits only lowered the baseline density.
// Bound the untouched height function, rather than treating clamped CSG density
// as a signed-distance field. The margin covers all eight lattice corners.
fn baselineAirStep(p: vec3<f32>, direction: vec3<f32>) -> f32 {
    let g=clamp((p-volume.origin.xyz)/volume.origin.w,vec3<f32>(0),vec3<f32>(volume.counts.xyz-vec3<u32>(1)));
    let i=min(vec3<u32>(g),volume.counts.xyz-vec3<u32>(2));
    let t=g-vec3<f32>(i);
    let c=i.z*volume.counts.x+i.x;
    let h=mix(mix(columns[c],columns[c+1u],t.x),
        mix(columns[c+volume.counts.x],columns[c+volume.counts.x+1u],t.x),t.z)*volume.origin.w+volume.origin.y;
    let slopes=view.cutSize.xy;
    let gap=p.y-h-volume.origin.w*(1.01+slopes.x+slopes.y);
    let speed=abs(direction.y)+slopes.x*abs(direction.x)+slopes.y*abs(direction.z);
    return max(0.0,gap/max(speed,0.000001));
}
`;
