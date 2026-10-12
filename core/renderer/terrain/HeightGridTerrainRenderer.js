// @ts-check
import { Geometry } from '../resources/geometry.js';
import { Material } from '../resources/material.js';

/**
 * Small reference draw implementation for a HeightGridSource. Replace this draw
 * implementation to test textures or different materials while keeping the source.
 */
export class HeightGridTerrainRenderer {
    /** @param {{ backend: import('../contracts.js').RendererBackend, source: import('../../world/fixtures/HeightGridSource.js').HeightGridSource, color?: readonly [number, number, number, number] }} options */
    constructor({ backend, source, color = [0.25, 0.55, 0.18, 1] }) {
        this.backend = backend;
        this.source = source;
        this.geometry = new Geometry();
        this.matrices = new Float32Array(32);
        this.material = new Material({
            name: 'HeightGrid', side: 'double',
            transparent: color[3] < 1, depthWrite: color[3] >= 1,
            vertexLayout: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }],
            bindGroupLayoutSpec: [{ entries: [{ binding: 0, name: 'matrices', visibility: 'vertex', buffer: { type: 'uniform' } }] }],
            uniforms: { matrices: { value: this.matrices } },
            vertexShader: `
                struct Matrices { view: mat4x4<f32>, projection: mat4x4<f32> }
                @group(0) @binding(0) var<uniform> matrices: Matrices;
                struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) height: f32 }
                @vertex fn main(@location(0) position: vec3<f32>) -> VertexOutput {
                    var out: VertexOutput;
                    out.position = matrices.projection * matrices.view * vec4<f32>(position, 1.0);
                    out.height = position.y;
                    return out;
                }`,
            fragmentShader: `
                @fragment fn main(@location(0) height: f32) -> @location(0) vec4<f32> {
                    let shade = 0.7 + 0.3 * clamp(height / 6.0, 0.0, 1.0);
                    return vec4<f32>(vec3<f32>(${color.slice(0, 3).join(', ')}) * shade, ${color[3]});
                }`,
        });
    }

    initialize() {
        this.geometry.setAttribute('position', null, 3, false, {
            count: this.source.grid.width * this.source.grid.height,
            gpuBuffer: this.source.getInstanceBuffer(),
        });
        this.geometry.setIndex(this.source.indices);
        this.source.updateLodIndexCounts([this.source.indices.length]);
    }

    /** @param {import('../contracts.js').RenderCamera} camera @param {import('../contracts.js').Matrix4Like} view @param {import('../contracts.js').Matrix4Like} projection */
    render(camera, view, projection) {
        if (!this.source.isReady()) return;
        this.matrices.set(Array.from(view.elements), 0);
        this.matrices.set(Array.from(projection.elements), 16);
        this.backend.drawIndexedIndirect(this.geometry, this.material, this.source.getIndirectArgsBuffer(), 0);
    }

    dispose() {
        this.geometry.dispose();
        this.backend.destroyMaterial(this.material);
    }
}
