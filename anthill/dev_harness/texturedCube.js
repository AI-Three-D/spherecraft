import { Geometry, Material, Texture } from 'engine/renderer/resources/index.js';
import { ProceduralTextureGenerator } from 'engine/texture/webgpu/textureGenerator.js';

const shader = /* wgsl */ `
struct Transforms { model: mat4x4<f32>, view: mat4x4<f32>, projection: mat4x4<f32> }
@group(0) @binding(0) var<uniform> transforms: Transforms;
@group(0) @binding(1) var surface: texture_2d<f32>;
@group(0) @binding(2) var surfaceSampler: sampler;
struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
}
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) normal: vec3<f32>,
    @location(1) uv: vec2<f32>,
}
`;
const vertexShader = `${shader}
@vertex fn main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = transforms.projection * transforms.view * transforms.model * vec4<f32>(input.position, 1.0);
    output.normal = (transforms.model * vec4<f32>(input.normal, 0.0)).xyz;
    output.uv = input.uv;
    return output;
}
`;
const fragmentShader = `${shader}
@fragment fn main(input: VertexOutput) -> @location(0) vec4<f32> {
    let light = 0.3 + 0.7 * max(dot(normalize(input.normal), normalize(vec3<f32>(0.4, 0.8, 0.6))), 0.0);
    return vec4<f32>(textureSample(surface, surfaceSampler, input.uv).rgb * light, 1.0);
}
`;

function cubeGeometry() {
    const positions = [], normals = [], uvs = [], indices = [];
    // Each face supplies an outward normal and two axes with cross(u, v) = normal.
    for (const [n, u, v] of [
        [[1,0,0], [0,0,-1], [0,1,0]], [[-1,0,0], [0,0,1], [0,1,0]],
        [[0,1,0], [1,0,0], [0,0,-1]], [[0,-1,0], [1,0,0], [0,0,1]],
        [[0,0,1], [1,0,0], [0,1,0]], [[0,0,-1], [-1,0,0], [0,1,0]],
    ]) {
        const base = positions.length / 3;
        for (const [s, t] of [[-1,-1], [1,-1], [1,1], [-1,1]]) {
            positions.push(...n.map((value, axis) => value + s * u[axis] + t * v[axis]));
            normals.push(...n);
            uvs.push((s + 1) / 2, (t + 1) / 2);
        }
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return new Geometry()
        .setAttribute('position', new Float32Array(positions), 3)
        .setAttribute('normal', new Float32Array(normals), 3)
        .setAttribute('uv', new Float32Array(uvs), 2)
        .setIndex(new Uint16Array(indices));
}

/** Example RenderModule: owns its geometry, material, generator, and texture. */
export class TexturedCubeModule {
    id = 'textured-cube';
    paused = false;
    angle = 0;
    transforms = new Float32Array(48);

    async initialize({ backend, device }) {
        this.backend = backend;
        this.generator = new ProceduralTextureGenerator(device, 128, 128);
        this.generator.layers = [
            { type: 'fill', color: '#316078' },
            { type: 'perlin', color: '#e5d5a5', opacity: 0.75, frequency: 6, octaves: 4, seed: 17 },
        ];
        const image = await this.generator.generate();
        this.texture = new Texture({ image, width: image.width, height: image.height, generateMipmaps: false });
        this.geometry = cubeGeometry();
        this.material = new Material({
            name: 'Harness textured cube', vertexShader, fragmentShader,
            uniforms: { transforms: { value: this.transforms }, surface: { value: this.texture } },
            bindGroupLayoutSpec: [{ entries: [
                { binding: 0, name: 'transforms', visibility: 'vertex', buffer: { type: 'uniform' } },
                { binding: 1, name: 'surface', visibility: 'fragment', texture: { sampleType: 'float' } },
                { binding: 2, name: 'surfaceSampler', visibility: 'fragment', sampler: { type: 'filtering' } },
            ] }],
        });
    }

    update({ camera, deltaTime }) {
        if (!this.paused) this.angle += deltaTime * 0.35;
        const c = Math.cos(this.angle), s = Math.sin(this.angle);
        this.transforms.set([c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]);
        this.transforms.set(camera.matrixWorldInverse.elements, 16);
        this.transforms.set(camera.projectionMatrix.elements, 32);
    }

    render({ backend }) { backend.draw(this.geometry, this.material); }

    dispose() {
        this.geometry?.dispose();
        if (this.material) this.backend.destroyMaterial(this.material);
        this.texture?._gpuTexture?.texture.destroy();
        this.texture?.dispose();
        this.generator?.dispose();
    }
}
