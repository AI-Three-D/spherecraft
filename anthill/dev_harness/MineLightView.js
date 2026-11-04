import { Geometry, Material } from '../core/renderer/resources/index.js';
import { composeClipFromLocal } from '../core/voxel/cameraRelative.js';
import { lightingDeclarationsWGSL } from '../core/voxel/lighting.wgsl.js';
import { Matrix4 } from '../shared/math/index.js';

const common = /* wgsl */ `
struct MarkerView { clip: mat4x4<f32>, plane: vec4<f32>, flags: vec4<f32> }
@group(0) @binding(0) var<uniform> marker: MarkerView;
${lightingDeclarationsWGSL}
struct VertexOutput {
    @builtin(position) position: vec4<f32>, @location(0) local: vec3<f32>,
    @location(1) color: vec3<f32>, @location(2) source: vec2<f32>,
}
`;
const vertexShader = `${common}
struct VertexInput { @location(0) position: vec3<f32>, @location(2) source: vec2<f32>, @location(3) color: vec3<f32> }
@vertex fn main(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.position = marker.clip * vec4<f32>(input.position, 1);
    out.local = input.position; out.color = input.color; out.source = input.source;
    return out;
}`;
const fragmentShader = `${common}
@fragment fn main(input: VertexOutput) -> @location(0) vec4<f32> {
    if(marker.flags.x > 0.5 && dot(input.local,marker.plane.xyz) > marker.plane.w) { discard; }
    let intensity = lighting.lights[u32(round(input.source.x))].colorIntensity.w;
    let emission = select(0.18, 1.5 + intensity * 0.2, input.source.y > 0.5);
    return vec4<f32>(pow(vec3<f32>(1)-exp(-input.color*emission),vec3<f32>(1.0/2.2)),1);
}`;

/** Harness markers for installed lights. Their positions remain fixed when the miner moves. */
export class MineLightView {
    id = 'harness-installed-lights';
    constructor({ volumeView }) {
        this.volumeView = volumeView;
        this.data = new Float32Array(24);
        this.clip = new Matrix4();
    }
    initialize({ backend }) {
        this.backend = backend;
        this.geometry = new Geometry();
        this.material = new Material({ name: 'Installed mine lights', vertexShader, fragmentShader,
            uniforms: { marker: { value: this.data }, lighting: { value: this.volumeView.lighting.data } },
            bindGroupLayoutSpec: [{ entries: [
                { binding: 0, name: 'marker', visibility: 'vertex|fragment', buffer: { type: 'uniform' } },
                { binding: 10, name: 'lighting', visibility: 'fragment', buffer: { type: 'uniform' } },
            ] }],
        });
    }
    update({ camera }) {
        const view = this.volumeView, lighting = view.lighting;
        composeClipFromLocal(view.frame, camera, this.clip);
        this.data.set(this.clip.elements);
        this.data.set([view.plane.normalX,0,view.plane.normalZ,view.plane.offset],16);
        this.data[20] = Number(view.clipEnabled);
        const offset = Number(lighting.carried.enabled && lighting.carried.intensity > 0);
        const lights = [...lighting.lights.values()].filter(light => light.enabled && light.intensity > 0);
        const signature = JSON.stringify([offset, lights]);
        if (signature === this.signature) return;
        this.signature = signature;
        const positions = [], colors = [], sources = [], indices = [];
        const box = (center, size, color, source, emissive) => {
            for (const [normal,u,v] of [
                [[1,0,0],[0,0,-1],[0,1,0]], [[-1,0,0],[0,0,1],[0,1,0]],
                [[0,1,0],[1,0,0],[0,0,-1]], [[0,-1,0],[1,0,0],[0,0,1]],
                [[0,0,1],[1,0,0],[0,1,0]], [[0,0,-1],[-1,0,0],[0,1,0]],
            ]) {
                const base = positions.length / 3;
                for (const [s,t] of [[-1,-1],[1,-1],[1,1],[-1,1]]) {
                    positions.push(...normal.map((n,i) => center[i] + (n+s*u[i]+t*v[i])*size[i]/2));
                    colors.push(...color); sources.push(source,Number(emissive));
                }
                indices.push(base,base+1,base+2,base,base+2,base+3);
            }
        };
        lights.forEach((light,index) => {
            const [x,y,z] = light.position;
            box([x,y-0.3,z],[0.07,0.5,0.07],[0.25,0.14,0.06],index+offset,false);
            box([x,y,z],light.kind === 'lantern' ? [0.22,0.3,0.22] : [0.12,0.22,0.12],light.color,index+offset,true);
        });
        this.count = indices.length;
        this.geometry.setAttribute('position',new Float32Array(positions),3)
            .setAttribute('uv',new Float32Array(sources),2)
            .setAttribute('color',new Float32Array(colors),3).setIndex(new Uint16Array(indices));
    }
    render({ backend }) { if (this.count) backend.draw(this.geometry,this.material); }
    dispose() { this.geometry?.dispose(); if(this.material) this.backend.destroyMaterial(this.material); }
}
