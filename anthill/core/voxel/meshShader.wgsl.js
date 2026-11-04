import { viewStruct } from './volumeTraversal.wgsl.js';

const choiceWGSL = /* wgsl */ `
// Deterministic per-pixel coverage for revealing completed geometry.
// The reveal changes only when fade advances; stationary geometry has no noise animation.
fn meshChoice(pixel: vec2<u32>, chunk: u32) -> f32 {
    var h=(pixel.x*1597334677u) ^ (pixel.y*3812015801u) ^ (chunk*2798796415u);
    h=(h^(h>>16u))*2246822519u;
    h=(h^(h>>13u))*3266489917u;
    return f32(h^(h>>16u))/4294967296.0;
}
`;

export const meshVertexWGSL = `${viewStruct}
struct Mesh { control: vec4<f32>, low: vec4<f32> }
@group(0) @binding(1) var<uniform> mesh: Mesh;
struct Out { @builtin(position) clip: vec4<f32>, @location(0) local: vec3<f32> }
@vertex fn main(@location(0) position: vec3<f32>, @location(1) destination: vec3<f32>) -> Out {
    let p=mix(position,destination,mesh.control.x);
    return Out(view.clipFromLocal*vec4<f32>(p,1.0),p);
}`;
export const meshFragmentWGSL = `${viewStruct}
struct Mesh { control: vec4<f32>, low: vec4<f32> }
@group(0) @binding(1) var<uniform> mesh: Mesh;
${choiceWGSL}
@fragment fn main(@builtin(position) pixel: vec4<f32>, @location(0) local: vec3<f32>) -> @location(0) vec4<f32> {
    if(view.params.y>0.5 && dot(local,view.plane.xyz)>view.plane.w) { discard; }
    if(mesh.control.y<1.0 && meshChoice(vec2<u32>(pixel.xy),u32(mesh.control.z))>=mesh.control.y) { discard; }
    var direction=view.direction.xyz;
    if(view.eye.w>0.0) { direction=normalize(local-view.eye.xyz); }
    let high=mesh.low.xyz+vec3<f32>(mesh.control.w);
    var entry=-1e20;
    for(var axis=0u;axis<3u;axis++) {
        if(abs(direction[axis])>0.0000001) {
            let edge=select(high[axis],mesh.low[axis],direction[axis]>0.0);
            entry=max(entry,(edge-local[axis])/direction[axis]);
        }
    }
    // Pack the distance from patch entry to this hit. Zero remains the no-hit
    // clear value; the compute pass needs no grid lookup or dense coverage map.
    return vec4<f32>(local,1.0+max(0.0,-entry));
}`;

export const meshTraceDeclarationsWGSL = /* wgsl */ `
@group(0) @binding(11) var meshHits: texture_2d<f32>;
`;
