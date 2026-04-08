// core/renderer/particles/HeatHazeEmitter.js
//
// Renders screen-space distortion billboards above a heat source (campfire)
// into the distortion map. Each billboard writes UV-offset vectors that
// create a rippling heat haze effect.
//
// The emitter manages a small set of rising "haze particles" on CPU —
// these are invisible in the color pass and only contribute to the
// distortion map.

export class HeatHazeEmitter {
    constructor(device, {
        maxParticles = 32,
        distortionFormat = 'rg16float',
    }) {
        this.device = device;
        this.maxParticles = maxParticles;
        this.distortionFormat = distortionFormat;

        // Heat sources to emit haze from.
        this._sources = [];

        // CPU particle state.
        this._particles = [];
        this._time = 0;

        // GPU resources.
        this._pipeline = null;
        this._bindGroupLayout = null;
        this._uniformBuffer = null;
        this._vertexBuffer = null;
        this._initialized = false;

        // Tuning.
        this.amplitude = 0.0008;    // subtle shimmer instead of visible image doubling
        this.frequency = 10.0;      // lower frequency avoids noisy ripples
        this.speed = 2.0;           // calmer animation reads more like rising heat
        this.riseSpeed = 0.8;       // vertical rise speed
        this.lifetime = 1.0;        // seconds
        this.spawnRate = 5;         // particles per second per source
        this.baseWidth = 0.22;      // smaller billboards keep the warp close to the heat source
        this.baseHeight = 0.14;     // smaller billboards keep the warp close to the heat source
        this.heightOffset = 0.6;    // minimum height above source
    }

    initialize(depthFormat = null) {
        const device = this.device;

        // Uniform buffer: viewProj (64B) + time (4B) + amplitude (4B) + frequency (4B) + speed (4B) = 80B -> 96B
        this._uniformBuffer = device.createBuffer({
            label: 'HeatHaze-Uniforms',
            size: 96,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Vertex buffer: per-instance data (position, age, width, height).
        // Each instance: vec3 position + f32 age + f32 width + f32 height = 24 bytes
        // Plus 8 bytes padding to 32.
        this._instanceStride = 32;
        this._vertexBuffer = device.createBuffer({
            label: 'HeatHaze-VertexBuffer',
            size: this.maxParticles * this._instanceStride,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });

        this._bindGroupLayout = device.createBindGroupLayout({
            label: 'HeatHaze-BGL',
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            ],
        });

        const shaderCode = this._buildShader();
        const module = device.createShaderModule({ label: 'HeatHaze-Shader', code: shaderCode });

        this._pipeline = device.createRenderPipeline({
            label: 'HeatHaze-Pipeline',
            layout: device.createPipelineLayout({ bindGroupLayouts: [this._bindGroupLayout] }),
            vertex: {
                module,
                entryPoint: 'vs_haze',
                buffers: [{
                    arrayStride: this._instanceStride,
                    stepMode: 'instance',
                    attributes: [
                        { shaderLocation: 0, offset: 0,  format: 'float32x3' },  // position
                        { shaderLocation: 1, offset: 12, format: 'float32' },    // age
                        { shaderLocation: 2, offset: 16, format: 'float32' },    // width
                        { shaderLocation: 3, offset: 20, format: 'float32' },    // height
                    ],
                }],
            },
            fragment: {
                module,
                entryPoint: 'fs_haze',
                targets: [{
                    format: this.distortionFormat,
                    blend: {
                        color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                    },
                }],
            },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
        });

        this._bindGroup = device.createBindGroup({
            layout: this._bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this._uniformBuffer } },
            ],
        });

        this._initialized = true;
    }

    addSource(position) {
        this._sources.push({ x: position.x, y: position.y, z: position.z });
    }

    update(deltaTime, localUp = { x: 0, y: 1, z: 0 }) {
        const dt = Math.min(deltaTime, 0.05);
        this._time += dt;

        // Age existing particles, remove dead ones.
        this._particles = this._particles.filter(p => {
            p.age += dt;
            p.y += this.riseSpeed * dt * localUp.y;
            p.x += this.riseSpeed * dt * localUp.x;
            p.z += this.riseSpeed * dt * localUp.z;
            return p.age < this.lifetime;
        });

        // Spawn new particles.
        for (const src of this._sources) {
            const count = Math.floor(this.spawnRate * dt + Math.random());
            for (let i = 0; i < count && this._particles.length < this.maxParticles; i++) {
                const angle = Math.random() * Math.PI * 2;
                const r = Math.random() * 0.15;
                this._particles.push({
                    x: src.x + Math.cos(angle) * r + localUp.x * this.heightOffset,
                    y: src.y + Math.sin(angle) * r + localUp.y * this.heightOffset,
                    z: src.z + Math.cos(angle + 1.5) * r + localUp.z * this.heightOffset,
                    age: 0,
                    width: this.baseWidth * (0.8 + Math.random() * 0.4),
                    height: this.baseHeight * (0.8 + Math.random() * 0.4),
                });
            }
        }
    }

    render(commandEncoder, distortionMapView, viewProjMatrix, cameraRight, cameraUp) {
        if (!this._initialized || this._particles.length === 0) return;

        // Upload uniforms.
        const uniforms = new Float32Array(24); // 96 bytes = 24 floats
        uniforms.set(viewProjMatrix, 0);       // mat4 at offset 0
        uniforms[16] = this._time;
        uniforms[17] = this.amplitude;
        uniforms[18] = this.frequency;
        uniforms[19] = this.speed;
        uniforms[20] = cameraRight[0];
        uniforms[21] = cameraRight[1];
        uniforms[22] = cameraRight[2];
        uniforms[23] = 0;
        this.device.queue.writeBuffer(this._uniformBuffer, 0, uniforms);

        // Upload instance data.
        const instanceData = new Float32Array(this._particles.length * (this._instanceStride / 4));
        for (let i = 0; i < this._particles.length; i++) {
            const p = this._particles[i];
            const base = i * (this._instanceStride / 4);
            instanceData[base + 0] = p.x;
            instanceData[base + 1] = p.y;
            instanceData[base + 2] = p.z;
            instanceData[base + 3] = p.age;
            instanceData[base + 4] = p.width;
            instanceData[base + 5] = p.height;
        }
        this.device.queue.writeBuffer(this._vertexBuffer, 0, instanceData);

        // Render into distortion map.
        const pass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: distortionMapView,
                loadOp: 'load',     // preserve existing distortion
                storeOp: 'store',
            }],
        });

        pass.setPipeline(this._pipeline);
        pass.setBindGroup(0, this._bindGroup);
        pass.setVertexBuffer(0, this._vertexBuffer);
        pass.draw(6, this._particles.length); // 6 verts per quad
        pass.end();
    }

    _buildShader() {
        return /* wgsl */`
struct HazeUniforms {
    viewProj:    mat4x4<f32>,
    time:        f32,
    amplitude:   f32,
    frequency:   f32,
    speed:       f32,
    cameraRight: vec3<f32>,
    _pad:        f32,
};

@group(0) @binding(0) var<uniform> u: HazeUniforms;

struct VsOut {
    @builtin(position) clipPos: vec4<f32>,
    @location(0)       uv:      vec2<f32>,
    @location(1)       age:     f32,
    @location(2)       worldY:  f32,
};

fn quadCorner(vid: u32) -> vec2<f32> {
    switch (vid) {
        case 0u: { return vec2<f32>(-1.0, -1.0); }
        case 1u: { return vec2<f32>( 1.0, -1.0); }
        case 2u: { return vec2<f32>(-1.0,  1.0); }
        case 3u: { return vec2<f32>(-1.0,  1.0); }
        case 4u: { return vec2<f32>( 1.0, -1.0); }
        default: { return vec2<f32>( 1.0,  1.0); }
    }
}

@vertex
fn vs_haze(
    @builtin(vertex_index) vid: u32,
    @location(0) position: vec3<f32>,
    @location(1) age: f32,
    @location(2) width: f32,
    @location(3) height: f32,
) -> VsOut {
    let corner = quadCorner(vid);

    // Camera-facing billboard.
    let right = u.cameraRight;
    // Use world up for the vertical axis of the billboard.
    let up = vec3<f32>(0.0, 1.0, 0.0);

    let worldPos = position + right * (corner.x * width) + up * (corner.y * height);

    var out: VsOut;
    out.clipPos = u.viewProj * vec4<f32>(worldPos, 1.0);
    out.uv = corner * 0.5 + vec2<f32>(0.5, 0.5);
    out.age = age;
    out.worldY = worldPos.y;
    return out;
}

@fragment
fn fs_haze(in: VsOut) -> @location(0) vec2<f32> {
    // Radial falloff from billboard center.
    let d = length(in.uv - vec2<f32>(0.5, 0.5)) * 2.0;
    if (d >= 1.0) { discard; }
    let falloff = 1.0 - smoothstep(0.3, 1.0, d);

    // Age-based fade (strongest at birth, fades as it rises).
    let ageFade = 1.0 - smoothstep(0.0, 1.0, in.age / 1.5);

    // Sinusoidal UV offset.
    let phase = in.worldY * u.frequency + u.time * u.speed;
    let dx = sin(phase) * u.amplitude * falloff * ageFade;
    let dy = cos(phase * 0.7 + 1.3) * u.amplitude * 0.5 * falloff * ageFade;

    return vec2<f32>(dx, dy);
}
`;
    }

    dispose() {
        this._uniformBuffer?.destroy();
        this._vertexBuffer?.destroy();
        this._pipeline = null;
        this._bindGroupLayout = null;
        this._initialized = false;
    }
}
