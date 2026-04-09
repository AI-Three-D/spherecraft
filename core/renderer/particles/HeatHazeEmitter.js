// core/renderer/particles/HeatHazeEmitter.js
//
// Renders screen-space distortion billboards for tracked heat sources into
// the shared distortion map. Sources can be static positions or moving anchors
// exposed via callbacks, which keeps this usable for campfires now and other
// distortion-driven effects later.

export class HeatHazeEmitter {
    constructor(device, {
        maxParticles = 32,
        distortionFormat = 'rg16float',
    }) {
        this.device = device;
        this.maxParticles = maxParticles;
        this.distortionFormat = distortionFormat;

        this._sources = [];
        this._nextSourceId = 1;

        this._particles = [];
        this._time = 0;

        this._pipeline = null;
        this._bindGroupLayout = null;
        this._uniformBuffer = null;
        this._vertexBuffer = null;
        this._depthFormat = null;
        this._initialized = false;

        // Tuned to be visible enough for campfire testing without becoming a
        // full-screen smear once the global distortion multiplier is raised.
        this.amplitude = 0.005;
        this.frequency = 10.0;
        this.speed = 2.0;
        this.riseSpeed = 0.8;
        this.lifetime = 1.0;
        this.spawnRate = 5;
        this.baseWidth = 0.22;
        this.baseHeight = 0.14;
        this.heightOffset = 0.6;
    }

    initialize(depthFormat = null) {
        const device = this.device;
        this._depthFormat = depthFormat || null;

        // Uniform buffer:
        //   viewProj                  64 B
        //   time/amplitude/freq/speed 16 B
        //   cameraRight/flatWorld     16 B
        //   cameraUp/pad              16 B
        //   planetOrigin/pad          16 B
        // = 128 B total
        this._uniformBuffer = device.createBuffer({
            label: 'HeatHaze-Uniforms',
            size: 128,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Per-instance: vec3 position + age + width + height = 24 B, padded to 32 B.
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

        const module = device.createShaderModule({
            label: 'HeatHaze-Shader',
            code: this._buildShader(),
        });

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
                        { shaderLocation: 0, offset: 0,  format: 'float32x3' },
                        { shaderLocation: 1, offset: 12, format: 'float32' },
                        { shaderLocation: 2, offset: 16, format: 'float32' },
                        { shaderLocation: 3, offset: 20, format: 'float32' },
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
            depthStencil: this._depthFormat ? {
                format: this._depthFormat,
                depthWriteEnabled: false,
                depthCompare: 'less',
            } : undefined,
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

    addSource(sourceOrPosition, options = {}) {
        const source = this._normalizeSourceDescriptor(sourceOrPosition, options);
        this._sources.push(source);
        return source;
    }

    removeSource(sourceOrId) {
        const index = this._sources.findIndex((source) =>
            source === sourceOrId || source.id === sourceOrId
        );
        if (index === -1) return false;
        this._sources.splice(index, 1);
        return true;
    }

    hasSources() {
        return this._sources.some((source) => source.enabled !== false);
    }

    hasRenderableParticles() {
        return this._particles.length > 0;
    }

    update(deltaTime, planetOrigin = null) {
        const dt = Math.min(deltaTime, 0.05);
        this._time += dt;
        this._syncSources(planetOrigin);

        this._particles = this._particles.filter((particle) => {
            particle.age += dt;
            particle.x += this.riseSpeed * dt * (particle.upX ?? 0);
            particle.y += this.riseSpeed * dt * (particle.upY ?? 1);
            particle.z += this.riseSpeed * dt * (particle.upZ ?? 0);
            return particle.age < this.lifetime;
        });

        for (const source of this._sources) {
            if (source.enabled === false) continue;

            const localUp = source.localUp || this._computeLocalUp(source.position, planetOrigin);
            const tangent = this._computeTangent(localUp);
            const bitangent = this._cross(localUp, tangent);
            const count = Math.floor(this.spawnRate * dt + Math.random());

            for (let i = 0; i < count && this._particles.length < this.maxParticles; i++) {
                const angle = Math.random() * Math.PI * 2;
                const radius = Math.random() * 0.15;
                const ringX = tangent.x * Math.cos(angle) + bitangent.x * Math.sin(angle);
                const ringY = tangent.y * Math.cos(angle) + bitangent.y * Math.sin(angle);
                const ringZ = tangent.z * Math.cos(angle) + bitangent.z * Math.sin(angle);

                this._particles.push({
                    x: source.position.x + ringX * radius + localUp.x * this.heightOffset,
                    y: source.position.y + ringY * radius + localUp.y * this.heightOffset,
                    z: source.position.z + ringZ * radius + localUp.z * this.heightOffset,
                    age: 0,
                    width: this.baseWidth * (0.8 + Math.random() * 0.4),
                    height: this.baseHeight * (0.8 + Math.random() * 0.4),
                    upX: localUp.x,
                    upY: localUp.y,
                    upZ: localUp.z,
                });
            }
        }
    }

    render(commandEncoder, distortionMapView, sceneDepthView, viewProjMatrix, cameraRight, cameraUp, planetOrigin = null) {
        if (!this._initialized || this._particles.length === 0) return;

        const hasPlanetOrigin = Number.isFinite(planetOrigin?.x)
            && Number.isFinite(planetOrigin?.y)
            && Number.isFinite(planetOrigin?.z);

        const uniforms = new Float32Array(32);
        uniforms.set(viewProjMatrix, 0);
        uniforms[16] = this._time;
        uniforms[17] = this.amplitude;
        uniforms[18] = this.frequency;
        uniforms[19] = this.speed;
        uniforms[20] = cameraRight[0];
        uniforms[21] = cameraRight[1];
        uniforms[22] = cameraRight[2];
        uniforms[23] = hasPlanetOrigin ? 0 : 1;
        uniforms[24] = cameraUp[0];
        uniforms[25] = cameraUp[1];
        uniforms[26] = cameraUp[2];
        uniforms[27] = 0;
        uniforms[28] = hasPlanetOrigin ? planetOrigin.x : 0;
        uniforms[29] = hasPlanetOrigin ? planetOrigin.y : 0;
        uniforms[30] = hasPlanetOrigin ? planetOrigin.z : 0;
        uniforms[31] = 0;
        this.device.queue.writeBuffer(this._uniformBuffer, 0, uniforms);

        const instanceData = new Float32Array(this._particles.length * (this._instanceStride / 4));
        for (let i = 0; i < this._particles.length; i++) {
            const particle = this._particles[i];
            const base = i * (this._instanceStride / 4);
            instanceData[base + 0] = particle.x;
            instanceData[base + 1] = particle.y;
            instanceData[base + 2] = particle.z;
            instanceData[base + 3] = particle.age;
            instanceData[base + 4] = particle.width;
            instanceData[base + 5] = particle.height;
        }
        this.device.queue.writeBuffer(this._vertexBuffer, 0, instanceData);

        const passDesc = {
            colorAttachments: [{
                view: distortionMapView,
                loadOp: 'load',
                storeOp: 'store',
            }],
        };
        if (sceneDepthView && this._depthFormat) {
            passDesc.depthStencilAttachment = {
                view: sceneDepthView,
                depthLoadOp: 'load',
                depthStoreOp: 'store',
            };
        }

        const pass = commandEncoder.beginRenderPass(passDesc);

        pass.setPipeline(this._pipeline);
        pass.setBindGroup(0, this._bindGroup);
        pass.setVertexBuffer(0, this._vertexBuffer);
        pass.draw(6, this._particles.length);
        pass.end();
    }

    _buildShader() {
        return /* wgsl */`
struct HazeUniforms {
    viewProj:     mat4x4<f32>,
    time:         f32,
    amplitude:    f32,
    frequency:    f32,
    speed:        f32,
    cameraRight:  vec3<f32>,
    flatWorld:    f32,
    cameraUp:     vec3<f32>,
    _pad0:        f32,
    planetOrigin: vec3<f32>,
    _pad1:        f32,
};

@group(0) @binding(0) var<uniform> u: HazeUniforms;

struct VsOut {
    @builtin(position) clipPos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) age: f32,
    @location(2) verticalCoord: f32,
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

fn projectOntoPlane(v: vec3<f32>, n: vec3<f32>) -> vec3<f32> {
    return v - n * dot(v, n);
}

fn resolveLocalUp(position: vec3<f32>) -> vec3<f32> {
    if (u.flatWorld > 0.5) {
        return vec3<f32>(0.0, 1.0, 0.0);
    }

    let fromOrigin = position - u.planetOrigin;
    let lenSq = dot(fromOrigin, fromOrigin);
    if (lenSq > 1e-6) {
        return normalize(fromOrigin);
    }
    return vec3<f32>(0.0, 1.0, 0.0);
}

fn fallbackBillboardRight(localUp: vec3<f32>) -> vec3<f32> {
    if (abs(localUp.z) < 0.999) {
        return normalize(cross(localUp, vec3<f32>(0.0, 0.0, 1.0)));
    }
    return normalize(cross(localUp, vec3<f32>(1.0, 0.0, 0.0)));
}

fn resolveBillboardRight(localUp: vec3<f32>) -> vec3<f32> {
    var right = projectOntoPlane(u.cameraRight, localUp);
    if (dot(right, right) <= 1e-6) {
        right = cross(projectOntoPlane(u.cameraUp, localUp), localUp);
    }
    if (dot(right, right) <= 1e-6) {
        right = fallbackBillboardRight(localUp);
    } else {
        right = normalize(right);
    }
    return right;
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
    let up = resolveLocalUp(position);
    let right = resolveBillboardRight(up);
    let worldPos = position + right * (corner.x * width) + up * (corner.y * height);

    var out: VsOut;
    out.clipPos = u.viewProj * vec4<f32>(worldPos, 1.0);
    out.uv = corner * 0.5 + vec2<f32>(0.5, 0.5);
    out.age = age;
    out.verticalCoord = dot(worldPos - u.planetOrigin, up);
    return out;
}

@fragment
fn fs_haze(in: VsOut) -> @location(0) vec2<f32> {
    let d = length(in.uv - vec2<f32>(0.5, 0.5)) * 2.0;
    if (d >= 1.0) { discard; }
    let falloff = 1.0 - smoothstep(0.3, 1.0, d);
    let ageFade = 1.0 - smoothstep(0.0, 1.0, in.age / 1.5);

    let phase = in.verticalCoord * u.frequency + u.time * u.speed;
    let dx = sin(phase) * u.amplitude * falloff * ageFade;
    let dy = cos(phase * 0.7 + 1.3) * u.amplitude * 0.5 * falloff * ageFade;

    return vec2<f32>(dx, dy);
}
`;
    }

    _normalizeSourceDescriptor(sourceOrPosition, options = {}) {
        const looksLikeDescriptor =
            !!sourceOrPosition &&
            typeof sourceOrPosition === 'object' &&
            (
                Object.prototype.hasOwnProperty.call(sourceOrPosition, 'position') ||
                Object.prototype.hasOwnProperty.call(sourceOrPosition, 'getPosition') ||
                Object.prototype.hasOwnProperty.call(sourceOrPosition, 'getLocalUp') ||
                Object.prototype.hasOwnProperty.call(sourceOrPosition, 'enabled') ||
                Object.prototype.hasOwnProperty.call(sourceOrPosition, 'type')
            );

        const descriptor = looksLikeDescriptor
            ? { ...sourceOrPosition, ...options }
            : { ...options, position: sourceOrPosition };

        const position = this._readVector3(descriptor.position) || { x: 0, y: 0, z: 0 };
        return {
            id: descriptor.id ?? `heat-haze-${this._nextSourceId++}`,
            type: 'heatHaze',
            enabled: descriptor.enabled !== false,
            position: { ...position },
            getPosition: typeof descriptor.getPosition === 'function'
                ? descriptor.getPosition
                : null,
            getLocalUp: typeof descriptor.getLocalUp === 'function'
                ? descriptor.getLocalUp
                : null,
            localUp: { x: 0, y: 1, z: 0 },
        };
    }

    _syncSources(planetOrigin) {
        for (const source of this._sources) {
            const nextPosition = this._readVector3(source.getPosition?.());
            if (nextPosition) {
                source.position.x = nextPosition.x;
                source.position.y = nextPosition.y;
                source.position.z = nextPosition.z;
            }

            source.localUp = this._readVector3(source.getLocalUp?.())
                || this._computeLocalUp(source.position, planetOrigin);
        }
    }

    _readVector3(value) {
        if (!value) return null;
        const x = Number(value.x);
        const y = Number(value.y);
        const z = Number(value.z);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
            return null;
        }
        return { x, y, z };
    }

    _computeLocalUp(position, planetOrigin) {
        const origin = this._readVector3(planetOrigin);
        if (!origin) return { x: 0, y: 1, z: 0 };

        const dx = position.x - origin.x;
        const dy = position.y - origin.y;
        const dz = position.z - origin.z;
        const len = Math.hypot(dx, dy, dz);
        if (len <= 1e-6) return { x: 0, y: 1, z: 0 };

        return {
            x: dx / len,
            y: dy / len,
            z: dz / len,
        };
    }

    _computeTangent(localUp) {
        const ref = Math.abs(localUp.y) > 0.99
            ? { x: 0, y: 0, z: 1 }
            : { x: 0, y: 1, z: 0 };
        const tangent = this._cross(localUp, ref);
        const len = Math.hypot(tangent.x, tangent.y, tangent.z);
        if (len <= 1e-6) return { x: 1, y: 0, z: 0 };

        return {
            x: tangent.x / len,
            y: tangent.y / len,
            z: tangent.z / len,
        };
    }

    _cross(a, b) {
        return {
            x: a.y * b.z - a.z * b.y,
            y: a.z * b.x - a.x * b.z,
            z: a.x * b.y - a.y * b.x,
        };
    }

    dispose() {
        this._uniformBuffer?.destroy();
        this._vertexBuffer?.destroy();
        this._pipeline = null;
        this._bindGroupLayout = null;
        this._initialized = false;
    }
}
