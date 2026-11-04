import { Geometry, Material } from '../core/renderer/resources/index.js';
import { composeClipFromLocal } from '../core/voxel/cameraRelative.js';
import { Matrix4 } from '../shared/math/index.js';
import { viewStruct, volumeBoundsDeclarationsWGSL, volumeTraversalWGSL } from '../core/voxel/volumeTraversal.wgsl.js';
import { volumeDeclarationsWGSL, volumeFunctionsWGSL } from '../core/voxel/volumeShader.wgsl.js';
import { lightingDeclarationsWGSL, lightingFunctionsWGSL } from '../core/voxel/lighting.wgsl.js';
import { TORCH_OFFSET } from './torchPose.js';

const common = /* wgsl */ `
struct MinerView {
    clip: mat4x4<f32>, feet: vec4<f32>, facing: vec4<f32>, plane: vec4<f32>, state: vec4<f32>, torch: vec4<f32>,
}
@group(0) @binding(11) var<uniform> miner: MinerView;
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) normal: vec3<f32>, @location(1) color: vec3<f32>,
    @location(2) local: vec3<f32>, @location(3) emissive: f32,
}
`;
const vertexShader = `${common}
struct VertexInput {
    @location(0) position: vec3<f32>, @location(1) normal: vec3<f32>,
    @location(2) part: f32, @location(3) color: vec3<f32>,
}
fn rotate(v: vec3<f32>, angle: f32) -> vec3<f32> {
    return vec3<f32>(v.x*cos(angle)-v.y*sin(angle),v.x*sin(angle)+v.y*cos(angle),v.z);
}
@vertex fn main(input: VertexInput) -> VertexOutput {
    var p = input.position;
    var n = input.normal;
    var color = input.color;
    let alive = miner.state.x > 0.5;
    if(input.part == 1.0 || input.part == 2.0) {
        let sign = select(-1.0,1.0,input.part == 1.0);
        let angle = sin(miner.facing.z)*miner.state.y*0.55*sign;
        p = rotate(p-vec3<f32>(0,0.8,0),angle)+vec3<f32>(0,0.8,0);
        n = rotate(n,angle);
    }
    if(input.part == 3.0 || input.part == 4.0) {
        let sign = select(-1.0,1.0,input.part == 3.0);
        var angle = -sin(miner.facing.z)*miner.state.y*0.4*sign;
        if(input.part == 3.0) { angle = 1.2; }
        else if(miner.facing.w > 0.5) { angle = 1.2 + miner.facing.y + sin(miner.state.z*24.0)*0.22; }
        p = rotate(p-vec3<f32>(0,1.35,0),angle)+vec3<f32>(0,1.35,0);
        n = rotate(n,angle);
    }
    if(input.part >= 6.0) {
        p.y += sin(miner.facing.z)*0.025;
        if(!alive || miner.torch.x < 0.5) { p = vec3<f32>(0); }
    }
    if(input.part == 5.0) {
        // A slim 3D aim guide: its centre line is exactly the capsule's axis.
        p = rotate(p,miner.facing.y)+vec3<f32>(0,miner.feet.w,0);
        n = rotate(n,miner.facing.y);
        color = select(vec3<f32>(0.25,0.95,1),vec3<f32>(1,0.77,0.2),miner.facing.w > 0.5);
        if(!alive) { p = vec3<f32>(0); }
    }
    // Keep the carried torch, but hide the body and aim guide at eye level.
    if(miner.torch.y > 0.5 && input.part < 6.0) { p = vec3<f32>(0); }
    if(!alive) {
        p = rotate(p,-1.4)+vec3<f32>(0,0.25,0);
        n = rotate(n,-1.4);
        color = vec3<f32>(0.95,0.22,0.18);
    }
    let c = cos(miner.facing.x); let s = sin(miner.facing.x);
    let heading = mat3x3<f32>(vec3<f32>(c,0,s),vec3<f32>(0,1,0),vec3<f32>(-s,0,c));
    let local = heading*p+miner.feet.xyz;
    var out: VertexOutput;
    out.position = miner.clip*vec4<f32>(local,1);
    out.local = local; out.normal = heading*n; out.color = color;
    out.emissive = select(0.0, 1.0, input.part == 7.0);
    return out;
}`;
const fragmentShader = `${common}
${viewStruct}
${volumeDeclarationsWGSL}
${volumeBoundsDeclarationsWGSL}
${lightingDeclarationsWGSL}
${volumeFunctionsWGSL.split('// A bounded search')[0]}
${volumeTraversalWGSL}
${lightingFunctionsWGSL}
@fragment fn main(input: VertexOutput) -> @location(0) vec4<f32> {
    if(miner.state.w > 0.5 && dot(input.local,miner.plane.xyz) > miner.plane.w) { discard; }
    var radiance = input.color * anthillIrradiance(input.local,normalize(input.normal),false);
    if(input.emissive > 0.5) { radiance = input.color * (2.0 + lighting.settings.x * 0.3); }
    return vec4<f32>(displayRadiance(radiance),1);
}`;

function figureGeometry() {
    const positions = [], normals = [], colors = [], parts = [], indices = [];
    const box = (center, size, color, part = 0) => {
        for (const [n, u, v] of [
            [[1,0,0],[0,0,-1],[0,1,0]], [[-1,0,0],[0,0,1],[0,1,0]],
            [[0,1,0],[1,0,0],[0,0,-1]], [[0,-1,0],[1,0,0],[0,0,1]],
            [[0,0,1],[1,0,0],[0,1,0]], [[0,0,-1],[-1,0,0],[0,1,0]],
        ]) {
            const base = positions.length / 3;
            for (const [s, t] of [[-1,-1],[1,-1],[1,1],[-1,1]]) {
                positions.push(...n.map((value, i) => center[i] + (value + s*u[i] + t*v[i])*size[i]/2));
                normals.push(...n); colors.push(...color); parts.push(part);
            }
            indices.push(base,base+1,base+2,base,base+2,base+3);
        }
    };
    const blue = [0.20,0.68,0.92], dark = [0.12,0.25,0.36], gold = [1,0.72,0.16];
    box([0,1.08,0],[0.30,0.56,0.40],blue);
    box([0,0.42,-0.14],[0.17,0.78,0.16],dark,1);
    box([0,0.42,0.14],[0.17,0.78,0.16],dark,2);
    box([0,1.10,-0.29],[0.14,0.50,0.13],blue,3);
    box([0,1.10,0.29],[0.14,0.50,0.13],blue,4);
    box([0,1.55,0],[0.32,0.32,0.32],[0.95,0.76,0.54]);
    box([0,1.76,0],[0.40,0.10,0.39],gold);
    box([0.18,1.65,0],[0.07,0.10,0.14],[1,1,0.88]);
    box([1.35,0,0],[1.30,0.025,0.025],[0.25,0.95,1],5);
    box([TORCH_OFFSET[0],TORCH_OFFSET[1]-0.30,TORCH_OFFSET[2]],[0.06,0.48,0.06],[0.28,0.12,0.04],6);
    box(TORCH_OFFSET,[0.12,0.22,0.12],[1,0.43,0.06],7);
    return new Geometry().setAttribute('position',new Float32Array(positions),3)
        .setAttribute('normal',new Float32Array(normals),3)
        .setAttribute('color',new Float32Array(colors),3)
        // The backend binds location 2 to uv; here that channel holds one part index.
        .setAttribute('uv',new Float32Array(parts),1).setIndex(new Uint16Array(indices));
}

/** Ordinary depth-tested RenderModule; uses the same double-precision frame transform as voxels. */
export class MineCharacterView {
    id = 'harness-miner';
    constructor({ character, frame, plane, volumeView }) {
        Object.assign(this, { character, frame, plane, volumeView });
        this.data = new Float32Array(36);
        this.clip = new Matrix4();
    }
    initialize({ backend }) {
        this.backend = backend;
        this.geometry = figureGeometry();
        this.material = new Material({ name: 'Harness miner', vertexShader, fragmentShader,
            uniforms: { ...this.volumeView.rayMaterial.uniforms, miner: { value: this.data } },
            storageBuffers: { ...this.volumeView.rayMaterial.storageBuffers },
            bindGroupLayoutSpec: [{ entries: [
                ...this.volumeView.rayMaterial.bindGroupLayoutSpec[0].entries.filter(e => ![1,2,12,14].includes(e.binding)),
                { binding: 11, name: 'miner', visibility: 'vertex|fragment', buffer: { type: 'uniform' } },
            ] }],
        });
    }
    update({ camera, time = 0 }) {
        const a = this.character, p = a.position;
        composeClipFromLocal(this.frame, camera, this.clip);
        this.data.set(this.clip.elements);
        this.data.set([p.x,p.y,p.z,a.config.digHeight],16);
        this.data.set([a.heading,a.pitch,a.phase,Number(a.digging)],20);
        this.data.set([this.plane.normalX,0,this.plane.normalZ,this.plane.offset],24);
        this.data.set([Number(a.alive),Math.min(1,Math.hypot(a.velocity.x,a.velocity.z)),time,Number(this.volumeView.clipEnabled)],28);
        this.data[32] = Number(this.volumeView.lighting.carried.enabled);
        this.data[33] = Number(!!camera.hideCharacter);
        this.material.storageBuffers.densities = this.volumeView.volumeGPU.density;
    }
    render({ backend }) { backend.draw(this.geometry,this.material); }
    dispose() {
        this.geometry?.dispose();
        if (this.material) this.backend.destroyMaterial(this.material);
    }
}
