// js/actors/nav/DestinationMarker.js
//
// Renders a pulsating ring on the terrain surface at the navigation
// destination. Uses a minimal render pipeline with 4-vertex strip.

import { Logger } from '../../../shared/Logger.js';

const MARKER_SHADER = /* wgsl */`
struct Uniforms {
    viewProj: mat4x4<f32>,     // 0..63
    worldPos: vec3<f32>,       // 64..75
    time:     f32,             // 76
    up:       vec3<f32>,       // 80..91
    radius:   f32,             // 92
    color:    vec4<f32>,       // 96..111
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSOut {
    @builtin(position) pos: vec4<f32>,
    @location(0)       uv:  vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
    // Triangle-strip quad: 0=(-1,-1) 1=(1,-1) 2=(-1,1) 3=(1,1)
    let cx = select(-1.0, 1.0, (vi & 1u) != 0u);
    let cy = select(-1.0, 1.0, (vi & 2u) != 0u);

    // Tangent frame from up
    let ref3 = select(vec3(0.0, 1.0, 0.0), vec3(0.0, 0.0, 1.0), abs(u.up.y) > 0.99);
    let right = normalize(cross(u.up, ref3));
    let fwd   = cross(right, u.up);

    let pulse = 1.0 + 0.18 * sin(u.time * 5.0);
    let r = u.radius * pulse;
    let world = u.worldPos + right * cx * r + fwd * cy * r + u.up * 0.08;

    var o: VSOut;
    o.pos = u.viewProj * vec4(world, 1.0);
    o.uv  = vec2(cx, cy);
    return o;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
    let d = length(in.uv);
    let ring = smoothstep(0.6, 0.72, d) * (1.0 - smoothstep(0.88, 1.0, d));
    let pulse = 0.55 + 0.45 * sin(u.time * 5.0);
    let alpha = ring * pulse * u.color.a;
    if (alpha < 0.01) { discard; }
    return vec4(u.color.rgb * pulse, alpha);
}
`;

export class DestinationMarker {
    /**
     * @param {GPUDevice} device
     * @param {object} backend  WebGPUBackend (for format, depth texture)
     */
    constructor(device, backend) {
        this.device = device;
        this.backend = backend;

        this.active = false;
        this.position = { x: 0, y: 0, z: 0 };
        this.up = { x: 0, y: 1, z: 0 };
        this.radius = 1.2;
        this.color = [0.2, 0.95, 0.4, 0.85];
        this._time = 0;

        this._pipeline = null;
        this._uniformBuffer = null;
        this._bindGroup = null;
        this._initialized = false;
    }

    async initialize() {
        const mod = this.device.createShaderModule({
            label: 'DestMarker-SM', code: MARKER_SHADER,
        });

        const bgl = this.device.createBindGroupLayout({
            label: 'DestMarker-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                  buffer: { type: 'uniform' } },
            ],
        });

        this._pipeline = this.device.createRenderPipeline({
            label: 'DestMarker-Pipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
            vertex:   { module: mod, entryPoint: 'vs' },
            fragment: {
                module: mod, entryPoint: 'fs',
                targets: [{
                    format: this.backend.sceneFormat || this.backend.format,
                    blend: {
                        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' },
                    },
                }],
            },
            primitive: { topology: 'triangle-strip' },
            depthStencil: {
                format: 'depth24plus',
                depthWriteEnabled: false,
                depthCompare: 'less',
            },
        });

        // 128 bytes uniform (mat4 + 3 vec4)
        this._uniformBuffer = this.device.createBuffer({
            label: 'DestMarker-UB',
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this._bindGroup = this.device.createBindGroup({
            layout: bgl,
            entries: [{ binding: 0, resource: { buffer: this._uniformBuffer } }],
        });

        this._initialized = true;
    }

    setTarget(pos, up) {
        this.position = { ...pos };
        if (up) this.up = { ...up };
        this.active = true;
    }

    clear() { this.active = false; }

    /**
     * Called during the render pass. Requires an active render pass encoder.
     * @param {GPURenderPassEncoder} passEncoder
     * @param {object} camera  Frontend camera
     * @param {number} dt
     */
    render(passEncoder, camera, dt) {
        if (!this._initialized || !this.active) return;

        this._time += dt;

        // Build viewProj
        const v = camera.matrixWorldInverse.elements;
        const p = camera.projectionMatrix.elements;
        const vp = _mulMat4(p, v);

        const f = new Float32Array(28); // 112 bytes, padded to 128
        f.set(vp, 0);
        f[16] = this.position.x; f[17] = this.position.y; f[18] = this.position.z;
        f[19] = this._time;
        f[20] = this.up.x; f[21] = this.up.y; f[22] = this.up.z;
        f[23] = this.radius;
        f[24] = this.color[0]; f[25] = this.color[1];
        f[26] = this.color[2]; f[27] = this.color[3];

        this.device.queue.writeBuffer(this._uniformBuffer, 0, f);

        passEncoder.setPipeline(this._pipeline);
        passEncoder.setBindGroup(0, this._bindGroup);
        passEncoder.draw(4);
    }

    dispose() {
        this._uniformBuffer?.destroy();
    }
}

function _mulMat4(a, b) {
    const out = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            out[j * 4 + i] =
                a[0 * 4 + i] * b[j * 4 + 0] +
                a[1 * 4 + i] * b[j * 4 + 1] +
                a[2 * 4 + i] * b[j * 4 + 2] +
                a[3 * 4 + i] * b[j * 4 + 3];
        }
    }
    return out;
}