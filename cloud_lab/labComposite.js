import {
    CLOUD_UNIFORMS_WGSL, CLOUD_MATH_WGSL, CLOUD_ATMOSPHERE_WGSL, CLOUD_SHADOW_LOOKUP_WGSL,
} from 'engine/renderer/volumetricClouds/shaders/cloudCommon.wgsl.js';

// Lab-only backdrop: analytic planet, single-scattering sky, aerial perspective
// split at the cloud depth, cloud shadows and tonemapping. Spherecraft will
// composite the cloud outputs into its own sky instead.
//
// The atmosphere is smooth, so it is marched at half resolution in a compute
// pass (in-scatter + transmittance before and after the clouds); the full-res
// fragment pass only does lookups, ground shading and tonemapping.

const SHARED_WGSL = /* wgsl */`${CLOUD_UNIFORMS_WGSL}${CLOUD_MATH_WGSL}${CLOUD_ATMOSPHERE_WGSL}
struct LabUniforms {
    viewport: vec4f,  // width, height, exposure, frame
    flags: vec4f,     // clouds on, shadow strength, view mode, unused
}
`;

// Variance-clipped temporal blend against the 3x3 neighbourhood held in workgroup memory.
const resolveWgsl = (shared, current, history) => /* wgsl */`{
        var m1 = vec3f(0.0);
        var m2 = vec3f(0.0);
        for (var y = -1; y <= 1; y++) {
            for (var x = -1; x <= 1; x++) {
                let c = clamp(lid + vec2i(x, y), vec2i(0), vec2i(7));
                let v = ${shared}[c.y * 8 + c.x];
                m1 += v;
                m2 += v * v;
            }
        }
        let mean = m1 / 9.0;
        let sigma = sqrt(max(m2 / 9.0 - mean * mean, vec3f(0.0)));
        ${current} = mix(clamp(${history}, mean - sigma * 1.5, mean + sigma * 1.5), ${current}, ATMO_BLEND);
    }`;

/**
 * Half-resolution atmosphere: near (camera to clouds) and far (clouds to end)
 * segments, accumulated over frames. Cloud shadows (god rays) make single
 * frames noisy; history is reprojected by camera rotation (the sky is at
 * infinity) and clipped to the current neighbourhood, so motion does not ghost.
 */
export function buildLabAtmosphereShader() {
    return /* wgsl */`${SHARED_WGSL}
const ATMO_BLEND: f32 = 0.12;

@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var<uniform> lab: LabUniforms;
@group(0) @binding(2) var transLut: texture_2d<f32>;
@group(0) @binding(3) var ambientLut: texture_2d<f32>;
@group(0) @binding(4) var lutSampler: sampler;
@group(0) @binding(5) var cloudDepth: texture_2d<f32>;
@group(0) @binding(6) var shadowMap: texture_2d<f32>;
@group(0) @binding(7) var linearSampler: sampler;
@group(0) @binding(8) var prevNearL: texture_2d<f32>;
@group(0) @binding(9) var prevNearT: texture_2d<f32>;
@group(0) @binding(10) var prevFarL: texture_2d<f32>;
@group(0) @binding(11) var prevFarT: texture_2d<f32>;
@group(0) @binding(12) var outNearL: texture_storage_2d<rgba16float, write>;
@group(0) @binding(13) var outNearT: texture_storage_2d<rgba16float, write>;
@group(0) @binding(14) var outFarL: texture_storage_2d<rgba16float, write>;
@group(0) @binding(15) var outFarT: texture_storage_2d<rgba16float, write>;
${CLOUD_SHADOW_LOOKUP_WGSL}

var<workgroup> sNearL: array<vec3f, 64>;
var<workgroup> sNearT: array<vec3f, 64>;
var<workgroup> sFarL: array<vec3f, 64>;
var<workgroup> sFarT: array<vec3f, 64>;

struct AtmoResult {
    L: vec3f,
    T: vec3f,
}

fn marchAtmosphere(ro: vec3f, rd: vec3f, t0: f32, t1: f32, steps: i32, jitter: f32) -> AtmoResult {
    var res: AtmoResult;
    res.L = vec3f(0.0);
    res.T = vec3f(1.0);
    if (t1 <= t0) { return res; }
    let span = t1 - t0;
    let n = f32(steps);
    let cosTheta = dot(rd, u.sun.xyz);
    let pr = rayleighPhase(cosTheta);
    let pm = henyeyGreenstein(cosTheta, u.atmoMie.w);
    // Inside the lower atmosphere, dense steps near the camera where shadows and haze change
    // fastest; from high up the dense air is at the far end, so step uniformly. Blended with
    // height: a hard switch flashed the haze when climbing through it.
    let power = mix(2.0, 1.0, smoothstep(10.0, 40.0, length(ro) - u.planet.x));
    for (var i = 0; i < steps; i++) {
        let xa = pow(f32(i) / n, power);
        let xb = pow(f32(i + 1) / n, power);
        let x = pow((f32(i) + jitter) / n, power);
        let dt = span * (xb - xa);
        let p = ro + rd * (t0 + span * x);
        let r = length(p);
        let m = atmoMedium(r - u.planet.x);
        let muS = dot(p / r, u.sun.xyz);
        let sunT = sunTransmittance(transLut, lutSampler, r, muS, u.planet.x, u.planet.w) * cloudShadowAt(p, lab.flags.y);
        // Isotropic second-order term from the ambient LUT stands in for multiple scattering.
        let amb = textureSampleLevel(ambientLut, lutSampler, ambientUv(muS, 0.0), 0.0).rgb;
        let S = (sunT * (m.rayleigh * pr + m.mie * pm) + amb * (m.rayleigh + m.mie)) * u.sun.w;
        let stepT = exp(-m.extinction * dt);
        res.L += res.T * (S - S * stepT) / max(m.extinction, vec3f(1.0e-7));
        res.T *= stepT;
    }
    return res;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_id) local: vec3u) {
    let size = textureDimensions(outNearL);
    let inside = id.x < size.x && id.y < size.y;
    let lid = vec2i(local.xy);
    let pix = vec2f(id.xy) + 0.5;
    let rd = cameraRay(pix, vec2f(size), u.camRight, u.camUp, u.camBack, u.frameInfo.x);
    let ro = u.camPos.xyz;
    var near: AtmoResult;
    near.L = vec3f(0.0);
    near.T = vec3f(1.0);
    var far = near;
    let atmo = raySphere(ro, rd, u.planet.w);
    if (inside && atmo.x < atmo.y && atmo.y > 0.0) {
        let ground = raySphere(ro, rd, u.planet.x);
        var tEnd = atmo.y;
        if (ground.x < ground.y && ground.x > 0.0) { tEnd = ground.x; }
        let t0 = max(atmo.x, 0.0);
        var split = tEnd;
        if (lab.flags.x > 0.5) {
            let dims = vec2f(textureDimensions(cloudDepth));
            let uv = pix / vec2f(size);
            split = clamp(textureLoad(cloudDepth, vec2i(clamp(uv * dims, vec2f(0.0), dims - 1.0)), 0).r, t0, tEnd);
        }
        // Animated so the sampling pattern reads as fine grain instead of a fixed stipple.
        let jitter = fract(ign(pix) + lab.viewport.w * 0.61803398875);
        // Temporal accumulation below averages the jitter, so few steps suffice.
        near = marchAtmosphere(ro, rd, t0, split, 16, jitter);
        far = marchAtmosphere(ro, rd, split, tEnd, 24, jitter);
    }
    let li = lid.y * 8 + lid.x;
    sNearL[li] = near.L;
    sNearT[li] = near.T;
    sFarL[li] = far.L;
    sFarT[li] = far.T;
    workgroupBarrier();
    if (!inside) { return; }

    // Rotation-only reprojection into last frame; skipped on history resets.
    let vz = dot(rd, u.prevBack.xyz);
    if (u.march2.z < 0.999 && vz < -1.0e-4) {
        let ndc = vec2f((u.prevRight.w * dot(rd, u.prevRight.xyz) + u.prevBack.w * vz) / -vz,
            (u.prevUp.w * dot(rd, u.prevUp.xyz) + u.prevInfo.x * vz) / -vz);
        let prevUv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
        if (all(prevUv >= vec2f(0.0)) && all(prevUv <= vec2f(1.0))) {
            let hNearL = textureSampleLevel(prevNearL, linearSampler, prevUv, 0.0).rgb;
            let hNearT = textureSampleLevel(prevNearT, linearSampler, prevUv, 0.0).rgb;
            let hFarL = textureSampleLevel(prevFarL, linearSampler, prevUv, 0.0).rgb;
            let hFarT = textureSampleLevel(prevFarT, linearSampler, prevUv, 0.0).rgb;
            ${resolveWgsl('sNearL', 'near.L', 'hNearL')}
            ${resolveWgsl('sNearT', 'near.T', 'hNearT')}
            ${resolveWgsl('sFarL', 'far.L', 'hFarL')}
            ${resolveWgsl('sFarT', 'far.T', 'hFarT')}
        }
    }
    let c = vec2i(id.xy);
    textureStore(outNearL, c, vec4f(near.L, 1.0));
    textureStore(outNearT, c, vec4f(near.T, 1.0));
    textureStore(outFarL, c, vec4f(far.L, 1.0));
    textureStore(outFarT, c, vec4f(far.T, 1.0));
}
`;
}

export function buildLabCompositeShader({ srgbEncode }) {
    return /* wgsl */`${SHARED_WGSL}
const SRGB_ENCODE: bool = ${srgbEncode ? 'true' : 'false'};

@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var<uniform> lab: LabUniforms;
@group(0) @binding(2) var transLut: texture_2d<f32>;
@group(0) @binding(3) var ambientLut: texture_2d<f32>;
@group(0) @binding(4) var lutSampler: sampler;
@group(0) @binding(5) var cloudColor: texture_2d<f32>;
@group(0) @binding(6) var atmoFarT: texture_2d<f32>;
@group(0) @binding(7) var shadowMap: texture_2d<f32>;
@group(0) @binding(8) var linearSampler: sampler;
@group(0) @binding(9) var atmoNearL: texture_2d<f32>;
@group(0) @binding(10) var atmoNearT: texture_2d<f32>;
@group(0) @binding(11) var atmoFarL: texture_2d<f32>;
${CLOUD_SHADOW_LOOKUP_WGSL}

struct VsOut {
    @builtin(position) pos: vec4f,
}

@vertex
fn vsMain(@builtin(vertex_index) i: u32) -> VsOut {
    var o: VsOut;
    let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
    // Reading an input texel here makes the whole pass (not just fragments) wait for the
    // compute passes, so the pass's GPU timestamps measure the composite alone.
    let dependency = textureLoad(atmoFarT, vec2i(0), 0).r;
    o.pos = vec4f(xy * 2.0 - 1.0, select(0.0, 0.5, dependency < -1.0), 1.0);
    return o;
}

fn hash31(p: vec3f) -> f32 {
    var q = fract(p * 0.1031);
    q += dot(q, q.zyx + 31.32);
    return fract((q.x + q.y) * q.z);
}

fn valueNoise(p: vec3f) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let w = f * f * (3.0 - 2.0 * f);
    let a = mix(hash31(i), hash31(i + vec3f(1.0, 0.0, 0.0)), w.x);
    let b = mix(hash31(i + vec3f(0.0, 1.0, 0.0)), hash31(i + vec3f(1.0, 1.0, 0.0)), w.x);
    let c = mix(hash31(i + vec3f(0.0, 0.0, 1.0)), hash31(i + vec3f(1.0, 0.0, 1.0)), w.x);
    let d = mix(hash31(i + vec3f(0.0, 1.0, 1.0)), hash31(i + vec3f(1.0, 1.0, 1.0)), w.x);
    return mix(mix(a, b, w.y), mix(c, d, w.y), w.z);
}

fn fbm(p: vec3f, octaves: i32) -> f32 {
    var sum = 0.0;
    var amp = 0.5;
    var q = p;
    for (var i = 0; i < octaves; i++) {
        sum += valueNoise(q) * amp;
        q = q * 2.03 + vec3f(17.1, 3.7, 9.2);
        amp *= 0.5;
    }
    return sum;
}

fn shadeGround(p: vec3f, rd: vec3f) -> vec3f {
    let n = normalize(p);
    let muS = dot(n, u.sun.xyz);
    let sunT = sunTransmittance(transLut, lutSampler, u.planet.x, muS, u.planet.x, u.planet.w);
    let shadow = cloudShadowSmoothAt(p, lab.flags.y);
    // Single-scattering sky light runs dark; the boost stands in for the missing orders.
    let skyL = textureSampleLevel(ambientLut, lutSampler, ambientUv(muS, 2.0), 0.0).rgb * 1.8;

    // Biased so the start site (+Y) sits on a coast-ringed continent.
    let continents = fbm(n * 3.0, 5) + 0.18 * smoothstep(0.96, 0.995, n.y);
    let water = continents < 0.5;
    let regional = fbm(p * 0.03, 4);
    let local = fbm(p * 1.2, 3);
    var albedo = mix(vec3f(0.06, 0.11, 0.04), vec3f(0.18, 0.16, 0.1), smoothstep(0.35, 0.65, regional));
    albedo = mix(albedo, vec3f(0.2, 0.19, 0.16), smoothstep(0.6, 0.8, regional) * 0.6);
    albedo *= mix(0.7, 1.2, local);
    if (water) { albedo = vec3f(0.012, 0.03, 0.05); }

    let skyShade = mix(0.55, 1.0, shadow);
    // Clouds forward-scatter part of the blocked sunlight down as diffuse light.
    let direct = sunT * max(muS, 0.0) * (shadow + (1.0 - shadow) * 0.3);
    var c = albedo * (direct / PI + skyL * skyShade);
    if (water) {
        let h = normalize(u.sun.xyz - rd);
        let nh = max(dot(n, h), 0.0);
        let fresnel = 0.02 + 0.98 * pow(1.0 - saturate(dot(-rd, n)), 5.0);
        let glint = (pow(nh, 800.0) * 120.0 + pow(nh, 40.0) * 0.4) * step(0.0, muS);
        c += fresnel * (sunT * shadow * glint + skyL * skyShade * PI * 0.3);
    }
    return c * u.sun.w;
}

fn space(rd: vec3f) -> vec3f {
    var c = vec3f(0.0);
    let cosSun = dot(rd, u.sun.xyz);
    let sunCos = cos(0.0065);
    if (cosSun > sunCos) {
        let x = saturate((cosSun - sunCos) / (1.0 - sunCos));
        c += vec3f(2000.0) * (0.4 + 0.6 * sqrt(x)) * u.sun.w;
    }
    let cell = floor(rd * 420.0);
    let h = hash31(cell);
    if (h > 0.9975) { c += vec3f(0.9, 0.95, 1.0) * pow((h - 0.9975) / 0.0025, 6.0) * 0.004; }
    return c;
}

fn acesFitted(color: vec3f) -> vec3f {
    let inM = mat3x3f(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
    let outM = mat3x3f(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
    let v = inM * color;
    let a = v * (v + 0.0245786) - 0.000090537;
    let b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return saturate(outM * (a / b));
}

fn linearToSrgb(c: vec3f) -> vec3f {
    let lo = c * 12.92;
    let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
    return select(hi, lo, c <= vec3f(0.0031308));
}

@fragment
fn fsMain(input: VsOut) -> @location(0) vec4f {
    let pix = input.pos.xy;
    let size = lab.viewport.xy;
    let rd = cameraRay(pix, size, u.camRight, u.camUp, u.camBack, u.frameInfo.x);
    let ro = u.camPos.xyz;
    let ground = raySphere(ro, rd, u.planet.x);
    let hitGround = ground.x < ground.y && ground.x > 0.0;
    let uv = pix / size;
    let mode = i32(lab.flags.z + 0.5);

    var cloud = vec4f(0.0, 0.0, 0.0, 1.0);
    if (lab.flags.x > 0.5) {
        let c = sampleCatmullRom(cloudColor, linearSampler, uv);
        cloud = vec4f(max(c.rgb, vec3f(0.0)), saturate(c.a));
    }
    var bg = space(rd);
    if (hitGround) { bg = shadeGround(ro + rd * ground.x, rd); }

    let nearL = textureSampleLevel(atmoNearL, linearSampler, uv, 0.0).rgb;
    let nearT = textureSampleLevel(atmoNearT, linearSampler, uv, 0.0).rgb;
    let farL = textureSampleLevel(atmoFarL, linearSampler, uv, 0.0).rgb;
    let farT = textureSampleLevel(atmoFarT, linearSampler, uv, 0.0).rgb;
    var color = nearL + nearT * (cloud.rgb + cloud.a * (farL + farT * bg));

    if (mode == 1) {
        color = cloud.rgb + vec3f(0.02, 0.025, 0.035) * cloud.a * u.sun.w;
    } else if (mode == 2) {
        color = vec3f(1.0 - cloud.a) / max(lab.viewport.z, 1.0e-3);
    } else if (mode == 3 && hitGround) {
        color = vec3f(cloudShadowSmoothAt(ro + rd * ground.x, lab.flags.y)) / max(lab.viewport.z, 1.0e-3);
    }

    var mapped = acesFitted(color * lab.viewport.z);
    if (SRGB_ENCODE) { mapped = linearToSrgb(mapped); }
    mapped += (ign(pix + 17.0) - 0.5) / 255.0;
    return vec4f(mapped, 1.0);
}
`;
}

export class LabCompositeModule {
    id = 'cloud-lab-composite';

    constructor(clouds) {
        this.clouds = clouds;
        this.exposure = 10;
        this.showClouds = true;
        this.shadowStrength = 0.6;
        this.viewMode = 0;
        /** Atmosphere march resolution relative to the canvas. */
        this.atmosphereScale = 0.5;
        this.gpuTimer = null;
        this._uniforms = new Float32Array(8);
        this._renderGroups = new Map();
        this._atmoSize = [0, 0];
        this._atmoVersion = 0;
    }

    async initialize({ backend, device, viewport }) {
        this.device = device;
        this.viewport = viewport;
        const format = backend.sceneFormat ?? backend.format;
        const compile = async (label, code) => {
            const module = device.createShaderModule({ label, code });
            const info = await module.getCompilationInfo?.();
            const errors = info?.messages?.filter(m => m.type === 'error') ?? [];
            if (errors.length) throw new Error(`${label} WGSL: ${errors.map(m => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`);
            return module;
        };
        const [atmoModule, compositeModule] = await Promise.all([
            compile('cloud lab atmosphere', buildLabAtmosphereShader()),
            compile('cloud lab composite', buildLabCompositeShader({ srgbEncode: !format.endsWith('-srgb') })),
        ]);
        const uniform = { buffer: { type: 'uniform' } };
        const tex = { texture: { sampleType: 'float' } };
        const texUnfilterable = { texture: { sampleType: 'unfilterable-float' } };
        const sampler = { sampler: { type: 'filtering' } };
        const store = { storageTexture: { access: 'write-only', format: 'rgba16float' } };
        const layout = (visibility, entries) => device.createBindGroupLayout({
            entries: entries.map((entry, binding) => ({ binding, visibility: entry.visibility ?? visibility, ...entry })),
        });
        const F = GPUShaderStage.FRAGMENT;
        this._atmoLayout = layout(GPUShaderStage.COMPUTE, [
            uniform, uniform, tex, tex, sampler, texUnfilterable, tex, sampler,
            tex, tex, tex, tex, store, store, store, store,
        ]);
        // Binding 6 (far transmittance) is also read by the vertex stage; see vsMain.
        this._renderLayout = layout(F, [
            uniform, uniform, tex, tex, sampler, tex, { ...tex, visibility: F | GPUShaderStage.VERTEX }, tex, sampler, tex, tex, tex,
        ]);
        [this._atmoPipeline, this._pipeline] = await Promise.all([
            device.createComputePipelineAsync({
                label: 'cloud lab atmosphere',
                layout: device.createPipelineLayout({ bindGroupLayouts: [this._atmoLayout] }),
                compute: { module: atmoModule, entryPoint: 'main' },
            }),
            device.createRenderPipelineAsync({
                label: 'cloud lab composite',
                layout: device.createPipelineLayout({ bindGroupLayouts: [this._renderLayout] }),
                vertex: { module: compositeModule, entryPoint: 'vsMain' },
                fragment: { module: compositeModule, entryPoint: 'fsMain', targets: [{ format }] },
                primitive: { topology: 'triangle-list' },
            }),
        ]);
        this._uniformBuffer = device.createBuffer({ size: this._uniforms.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this._ensureAtmosphereTargets();
    }

    resize(viewport) {
        this.viewport = viewport;
        this._ensureAtmosphereTargets();
    }

    update(frame) {
        this.viewport = frame.viewport;
        this._ensureAtmosphereTargets();
        this._uniforms.set([
            frame.viewport.width, frame.viewport.height, this.exposure, frame.index,
            this.showClouds && this.clouds.enabled ? 1 : 0, this.shadowStrength, this.viewMode, 0,
        ]);
        this.device.queue.writeBuffer(this._uniformBuffer, 0, this._uniforms);
    }

    compute(frame, encoder) {
        const out = this.clouds.getOutputs();
        const key = `${out.depthVersion}|${this._atmoVersion}`;
        if (this._atmoGroupKey !== key) {
            this._atmoGroupKey = key;
            // Group [i] writes set i and reads set 1 - i.
            this._atmoGroups = [0, 1].map(write => {
                const resources = [
                    { buffer: out.uniformBuffer }, { buffer: this._uniformBuffer },
                    out.transmittanceView, out.ambientView, out.lutSampler,
                    out.depthView, out.shadowView, out.linearSampler,
                    ...this._atmoViews[1 - write], ...this._atmoViews[write],
                ];
                return this.device.createBindGroup({
                    layout: this._atmoLayout, entries: resources.map((resource, binding) => ({ binding, resource })),
                });
            });
        }
        this._atmoIndex = 1 - this._atmoIndex;
        const [w, h] = this._atmoSize;
        const pass = encoder.beginComputePass({ label: 'lab atmosphere', timestampWrites: this.gpuTimer?.timestampWrites('lab atmosphere') });
        pass.setPipeline(this._atmoPipeline);
        pass.setBindGroup(0, this._atmoGroups[this._atmoIndex]);
        pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
        pass.end();
    }

    // Owns its render pass (every pixel is overwritten, no depth) so it can carry GPU timestamps.
    render({ backend }) {
        const out = this.clouds.getOutputs();
        const key = `${out.version}|${this._atmoVersion}:${this._atmoIndex}`;
        let bindGroup = this._renderGroups.get(key);
        if (!bindGroup) {
            if (this._renderGroups.size >= 4) this._renderGroups.clear();
            const [nearL, nearT, farL, farT] = this._atmoViews[this._atmoIndex];
            const resources = [
                { buffer: out.uniformBuffer }, { buffer: this._uniformBuffer },
                out.transmittanceView, out.ambientView, out.lutSampler,
                out.colorView, farT, out.shadowView, out.linearSampler, nearL, nearT, farL,
            ];
            bindGroup = this.device.createBindGroup({
                layout: this._renderLayout, entries: resources.map((resource, binding) => ({ binding, resource })),
            });
            this._renderGroups.set(key, bindGroup);
        }
        backend.endRenderPassForCompute();
        const pass = backend.getCommandEncoder().beginRenderPass({
            label: 'cloud lab composite',
            colorAttachments: [{
                view: backend.context.getCurrentTexture().createView(),
                loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1],
            }],
            timestampWrites: this.gpuTimer?.timestampWrites('lab composite'),
        });
        pass.setPipeline(this._pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();
    }

    _ensureAtmosphereTargets() {
        const width = Math.max(1, Math.round(this.viewport.width * this.atmosphereScale));
        const height = Math.max(1, Math.round(this.viewport.height * this.atmosphereScale));
        if (width === this._atmoSize[0] && height === this._atmoSize[1]) return;
        for (const texture of this._atmoTextures ?? []) texture.destroy();
        this._atmoTextures = [0, 1].flatMap(set => ['near L', 'near T', 'far L', 'far T'].map(name => this.device.createTexture({
            label: `cloud lab atmosphere ${name} ${set}`, size: [width, height], format: 'rgba16float',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
        })));
        const views = this._atmoTextures.map(texture => texture.createView());
        this._atmoViews = [views.slice(0, 4), views.slice(4, 8)];
        this._atmoIndex = 0;
        this._atmoSize = [width, height];
        this._atmoVersion++;
        this._renderGroups.clear();
    }

    dispose() {
        this._uniformBuffer?.destroy();
        for (const texture of this._atmoTextures ?? []) texture.destroy();
    }
}
