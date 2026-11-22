// @ts-nocheck
import {
    CLOUD_UNIFORMS_WGSL, CLOUD_MATH_WGSL, CLOUD_SHADOW_LOOKUP_WGSL,
} from './shaders/cloudCommon.wgsl.js';
import { AERIAL_PERSPECTIVE_WGSL } from '../atmosphere/shaders/aerialPerspectiveCommon.js';

const HAZE_STEPS = 8;
const HAZE_GRID = [48, 30, 24];

/**
 * Composites VolumetricCloudsModule output into a host's HDR scene colour, after the opaque
 * scene. The host's atmosphere (Bruneton-parametrised transmittance LUT plus its scattering
 * coefficients, in world units) hazes the clouds, so they fade into the host's sky:
 *
 *   scene' = T * shadow * scene + hazeT * cloudL + (1 - T) * hazeL
 *
 * where T is cloud transmittance and haze runs from the camera to the cloud. Drawn with
 * blending (src one, dst src-alpha), so the scene colour is not read in the shader.
 * Cloud shadows darken opaque pixels by `shadowStrength`, keeping `shadowFloor` of the light
 * for the ambient part; haze in front of distant ground is left unshadowed.
 */
export class CloudCompositePass {
    constructor(clouds, { colorFormat, shadowStrength = 0.6, shadowFloor = 0.45 } = {}) {
        this.clouds = clouds;
        this.colorFormat = colorFormat;
        this.shadowStrength = shadowStrength;
        this.shadowFloor = shadowFloor;
        this.gpuTimer = null;
        this._uniforms = new Float32Array(16);
        this._groups = new Map();
        this._groupInputs = [];
    }

    async initialize(device) {
        this.device = device;
        const module = device.createShaderModule({ label: 'clouds composite', code: buildCloudCompositeShader() });
        const info = await module.getCompilationInfo?.();
        const errors = info?.messages?.filter(m => m.type === 'error') ?? [];
        if (errors.length) throw new Error(`clouds composite WGSL: ${errors.map(m => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`);
        const F = GPUShaderStage.FRAGMENT;
        const entries = [
            { buffer: { type: 'uniform' } },
            { buffer: { type: 'uniform' } },
            { texture: { sampleType: 'float' } },
            { texture: { sampleType: 'unfilterable-float' } },
            { texture: { sampleType: 'depth' } },
            { texture: { sampleType: 'float' } },
            { texture: { sampleType: 'float' } },
            { sampler: { type: 'filtering' } },
        ];
        const layout = bindings => device.createBindGroupLayout({
            entries: bindings.map((entry, binding) => ({ binding, visibility: F, ...entry })),
        });
        this._layout = layout(entries);
        const render = (module, bindGroupLayout) => device.createRenderPipelineAsync({
            label: 'clouds composite',
            layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
            vertex: { module, entryPoint: 'vsMain' },
            fragment: {
                module, entryPoint: 'fsMain',
                targets: [{
                    format: this.colorFormat,
                    blend: {
                        color: { srcFactor: 'one', dstFactor: 'src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
                    },
                }],
            },
            primitive: { topology: 'triangle-list' },
        });
        const budget = device.createShaderModule({ label: 'clouds composite with haze lookup', code: buildCloudCompositeShader(true) });
        const hazeTexture = { texture: { sampleType: 'float', viewDimension: '3d' } };
        this._budgetLayout = layout([...entries, hazeTexture, hazeTexture]);
        [this._pipeline, this._budgetPipeline, this._hazePipeline] = await Promise.all([
            render(module, this._layout), render(budget, this._budgetLayout),
            device.createComputePipelineAsync({ label: 'clouds haze lookup', layout: 'auto', compute: { module: budget, entryPoint: 'bakeHaze' } }),
        ]);
        this._uniformBuffer = device.createBuffer({
            label: 'clouds composite uniforms', size: this._uniforms.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
    }

    _bakeHaze(encoder, out, a) {
        if (!this._hazeTextures) {
            this._hazeTextures = ['radiance', 'transmittance'].map(label => this.device.createTexture({
                label: `cloud haze ${label}`, size: HAZE_GRID, dimension: '3d', format: 'rgba16float',
                usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
            }));
            this._hazeViews = this._hazeTextures.map(texture => texture.createView());
        }
        const inputs = [out.uniformBuffer, a.transmittanceView, out.linearSampler];
        if (!this._hazeGroup || inputs.some((input, i) => input !== this._hazeInputs[i])) {
            this._hazeInputs = inputs;
            this._hazeKey = null;
            this._hazeGroup = this.device.createBindGroup({
                layout: this._hazePipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: out.uniformBuffer } },
                    { binding: 1, resource: { buffer: this._uniformBuffer } },
                    { binding: 6, resource: a.transmittanceView },
                    { binding: 7, resource: out.linearSampler },
                    { binding: 10, resource: this._hazeViews[0] },
                    { binding: 11, resource: this._hazeViews[1] },
                ],
            });
        }
        const c = this.clouds;
        const key = JSON.stringify([c._prev, c.sunDirection, c.sunIlluminance, c.moonDirection, c.moonIlluminance,
            a.planetRadius, a.atmosphereRadius, a.scaleHeightRayleigh, a.scaleHeightMie, a.rayleighScattering,
            a.mieScattering, a.mieAnisotropy, a.sunIntensity]);
        if (key === this._hazeKey) return;
        this._hazeKey = key;
        const pass = encoder.beginComputePass({ label: 'clouds haze lookup', timestampWrites: this.gpuTimer?.timestampWrites('clouds haze lookup') });
        pass.setPipeline(this._hazePipeline);
        pass.setBindGroup(0, this._hazeGroup);
        pass.dispatchWorkgroups(Math.ceil(HAZE_GRID[0] / 8), Math.ceil(HAZE_GRID[1] / 4), HAZE_GRID[2]);
        pass.end();
    }

    /**
     * Encode the composite into `encoder` (outside any render pass). The cloud module must have
     * run compute() for this frame with the same scene depth.
     * @param {GPUCommandEncoder} encoder
     * @param {object} target colorView (load/store), depthView (scene depth), width, height
     * @param {object} atmosphere transmittanceView, planetRadius, atmosphereRadius, scaleHeightRayleigh,
     *   scaleHeightMie, rayleighScattering [r, g, b], mieScattering, mieAnisotropy, sunIntensity (world units)
     */
    render(encoder, { colorView, depthView, width, height }, atmosphere) {
        const out = this.clouds.getOutputs();
        const a = atmosphere;
        const budget = !!this.clouds.budgetTier;
        const unitsPerKm = this.clouds.planet.unitsPerKm;
        this._uniforms.set([
            width, height, this.shadowStrength, unitsPerKm,
            a.planetRadius, a.atmosphereRadius, a.scaleHeightRayleigh, a.scaleHeightMie,
            ...a.rayleighScattering, a.mieScattering,
            a.mieAnisotropy, a.sunIntensity, this.shadowFloor,
            budget ? Math.max(64, a.atmosphereRadius / unitsPerKm + Math.hypot(...this.clouds._prev.pos)) : 0,
        ]);
        this.device.queue.writeBuffer(this._uniformBuffer, 0, this._uniforms);
        if (budget) this._bakeHaze(encoder, out, a);
        // The cloud history ping-pongs (and may switch interleave), so a few groups are kept per input set.
        const inputs = [depthView, a.transmittanceView];
        if (inputs.some((v, i) => v !== this._groupInputs[i]) || this._groups.size > 8) {
            this._groupInputs = inputs;
            this._groups.clear();
        }
        let group = this._groups.get(out.version);
        if (!group) {
            const resources = [
                { buffer: out.uniformBuffer }, { buffer: this._uniformBuffer },
                out.colorView, out.depthView, depthView, out.shadowView, a.transmittanceView, out.linearSampler,
            ];
            if (budget) resources.push(...this._hazeViews);
            group = this.device.createBindGroup({
                label: 'clouds composite', layout: budget ? this._budgetLayout : this._layout,
                entries: resources.map((resource, binding) => ({ binding, resource })),
            });
            this._groups.set(out.version, group);
        }
        const pass = encoder.beginRenderPass({
            label: 'clouds composite',
            colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
            timestampWrites: this.gpuTimer?.timestampWrites('clouds composite'),
        });
        pass.setViewport(0, 0, width, height, 0, 1);
        pass.setPipeline(budget ? this._budgetPipeline : this._pipeline);
        pass.setBindGroup(0, group);
        pass.draw(3);
        pass.end();
    }

    dispose() {
        this._uniformBuffer?.destroy();
        for (const texture of this._hazeTextures ?? []) texture.destroy();
        this._groups.clear();
    }
}

export function buildCloudCompositeShader(budget = false) {
    return /* wgsl */`${CLOUD_UNIFORMS_WGSL}${CLOUD_MATH_WGSL}${AERIAL_PERSPECTIVE_WGSL}
struct CompositeUniforms {
    viewport: vec4f,  // width, height, shadow strength, world units per km
    atmo0: vec4f,     // planet radius, atmosphere radius, Rayleigh scale height, Mie scale height (world units)
    atmo1: vec4f,     // Rayleigh scattering rgb, Mie scattering (per world unit)
    atmo2: vec4f,     // Mie g, sun intensity, shadow floor
}

@group(0) @binding(0) var<uniform> u: CloudUniforms;
@group(0) @binding(1) var<uniform> cu: CompositeUniforms;
@group(0) @binding(2) var cloudColor: texture_2d<f32>;
@group(0) @binding(3) var cloudDepth: texture_2d<f32>;
@group(0) @binding(4) var sceneDepth: texture_depth_2d;
@group(0) @binding(5) var shadowMap: texture_2d<f32>;
@group(0) @binding(6) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(7) var linearSampler: sampler;
${budget ? /* wgsl */`
@group(0) @binding(8) var hazeRadiance: texture_3d<f32>;
@group(0) @binding(9) var hazeTransmittance: texture_3d<f32>;
@group(0) @binding(10) var outHazeL: texture_storage_3d<rgba16float, write>;
@group(0) @binding(11) var outHazeT: texture_storage_3d<rgba16float, write>;
` : ''}
${CLOUD_SHADOW_LOOKUP_WGSL}

struct VsOut {
    @builtin(position) pos: vec4f,
}

@vertex
fn vsMain(@builtin(vertex_index) i: u32) -> VsOut {
    var o: VsOut;
    let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
    o.pos = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
    return o;
}

struct Haze {
    T: vec3f,
    L: vec3f,
}

// Single scattering and transmittance from the camera to distKm along rd, in the host's
// atmosphere (world units). Positions are planet-relative.
fn hazeTo(roKm: vec3f, rd: vec3f, distKm: f32) -> Haze {
    var h: Haze;
    h.T = vec3f(1.0);
    h.L = vec3f(0.0);
    let R = cu.atmo0.x;
    let Ra = cu.atmo0.y;
    let ro = roKm * cu.viewport.w;
    let atmo = raySphere(ro, rd, Ra);
    let t0 = max(atmo.x, 0.0);
    let t1 = min(atmo.y, distKm * cu.viewport.w);
    if (atmo.x > atmo.y || t1 <= t0) { return h; }
    let dt = (t1 - t0) / f32(${HAZE_STEPS});
    let cosSun = dot(rd, u.sun.xyz);
    let phaseR = ap_rayleighPhase(cosSun);
    let phaseM = ap_miePhase(cosSun, cu.atmo2.x);
    // Moonlit air: the moon's share of the haze, relative to the sun (u.moon.w / u.sun.w). Sun-only
    // haze went to black at night, so far clouds kept full contrast and read as cut-outs.
    let moonScale = select(0.0, u.moon.w / max(u.sun.w, 1.0e-6), u.moon.w > 0.0 && u.sun.w > 1.0e-3);
    let cosMoon = dot(rd, u.moon.xyz);
    let phaseRMoon = ap_rayleighPhase(cosMoon);
    let phaseMMoon = ap_miePhase(cosMoon, cu.atmo2.x);
    let H = Ra - R;
    for (var i = 0; i < ${HAZE_STEPS}; i++) {
        let p = ro + rd * (t0 + (f32(i) + 0.5) * dt);
        let r = length(p);
        let alt = clamp(r - R, 0.0, H);
        let d = ap_getDensity(alt, cu.atmo0.z, cu.atmo0.w);
        let scatR = cu.atmo1.xyz * d.x;
        let scatM = cu.atmo1.w * d.y;
        let ext = scatR + vec3f(scatM);
        // The LUT has no planet shadow; fade the sun across the terminator like the host's terrain haze.
        let cosSun = dot(p / r, u.sun.xyz);
        let sunT = ap_sampleTransmittance(transmittanceLut, linearSampler, alt, cosSun, R, Ra)
            * smoothstep(-0.08, 0.08, cosSun);
        var S = (scatR * phaseR + vec3f(scatM * phaseM)) * sunT;
        if (moonScale > 0.0) {
            let cosMoonZ = dot(p / r, u.moon.xyz);
            let moonT = ap_sampleTransmittance(transmittanceLut, linearSampler, alt, cosMoonZ, R, Ra)
                * smoothstep(-0.08, 0.08, cosMoonZ) * moonScale;
            S += (scatR * phaseRMoon + vec3f(scatM * phaseMMoon)) * moonT;
        }
        let stepT = exp(-ext * dt);
        h.L += h.T * S * (1.0 - stepT) / max(ext, vec3f(1.0e-12));
        h.T *= stepT;
    }
    h.L *= cu.atmo2.y;
    return h;
}

${budget ? /* wgsl */`
@compute @workgroup_size(8, 4)
fn bakeHaze(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(outHazeL);
    if (any(id >= size)) { return; }
    let uv = (vec2f(id.xy) + 0.5) / vec2f(size.xy);
    let rd = cameraRay(uv, vec2f(1.0), u.camRight, u.camUp, u.camBack, u.frameInfo.x);
    let slice = f32(id.z) / f32(size.z - 1u);
    let depth = exp2(slice * log2(1.0 + cu.atmo2.w)) - 1.0;
    let haze = hazeTo(u.camPos.xyz, rd, depth);
    textureStore(outHazeL, id, vec4f(haze.L, 0.0));
    textureStore(outHazeT, id, vec4f(haze.T, 0.0));
}

fn lookupHaze(uv: vec2f, distance: f32) -> Haze {
    let count = f32(textureDimensions(hazeRadiance).z);
    let depth = log2(1.0 + clamp(distance, 0.0, cu.atmo2.w)) / log2(1.0 + cu.atmo2.w);
    let uvw = vec3f(uv, (0.5 + depth * (count - 1.0)) / count);
    return Haze(textureSampleLevel(hazeTransmittance, linearSampler, uvw, 0.0).rgb,
        textureSampleLevel(hazeRadiance, linearSampler, uvw, 0.0).rgb);
}
` : ''}

// Rough luminance transmittance to a surface (mean-altitude density): how much of the pixel is
// the surface itself rather than haze in front of it.
fn surfaceVisibility(roKm: vec3f, rd: vec3f, distKm: f32) -> f32 {
    let h0 = length(roKm) - u.planet.x;
    let h1 = length(roKm + rd * distKm) - u.planet.x;
    let d = ap_getDensity(max(0.5 * (h0 + h1), 0.0) * cu.viewport.w, cu.atmo0.z, cu.atmo0.w);
    let ext = cu.atmo1.xyz * d.x + vec3f(cu.atmo1.w * d.y);
    return dot(exp(-ext * distKm * cu.viewport.w), vec3f(0.2126, 0.7152, 0.0722));
}

// Optical depth up to the cloud and up to the camera's opaque scene hit.
// Integrating the curved boundary layer makes nearby hills break through the
// haze while longer rays through the low country accumulate more of it.
fn groundMistDepths(ro: vec3f, rd: vec3f, sceneKm: f32, cloudKm: f32) -> vec2f {
    let layer = raySphere(ro, rd, u.groundMist.y);
    let ground = raySphere(ro, rd, u.planet.x);
    let start = max(layer.x, 0.0);
    var end = min(layer.y, sceneKm);
    if (ground.x < ground.y && ground.y > 0.0) { end = min(end, max(0.0, ground.x)); }
    if (start >= end) { return vec2f(0.0); }
    let step = (end - start) / 8.0;
    let height = u.groundMist.y - u.planet.x;
    var path = vec2f(0.0);
    for (var i = 0; i < 8; i++) {
        let a = start + f32(i) * step;
        let altitude = max(0.0, length(ro + rd * (a + 0.5 * step)) - u.planet.x);
        let density = exp(-altitude / u.groundMist.z) * (1.0 - smoothstep(0.65 * height, height, altitude));
        path += density * vec2f(clamp(cloudKm - a, 0.0, step), step);
    }
    return path * (u.groundMist.x * u.groundMist.w);
}

fn groundMistLight(ro: vec3f, rd: vec3f) -> vec3f {
    let up = normalize(ro);
    let sunAbove = dot(up, u.sun.xyz);
    let day = smoothstep(-0.12, 0.19, sunAbove);
    let warm = (1.0 - smoothstep(0.01, 0.28, sunAbove)) * smoothstep(-0.12, 0.02, sunAbove);
    let daylight = mix(vec3f(0.030, 0.037, 0.043), vec3f(0.060, 0.043, 0.034), warm);
    let forward = 1.0 + 0.32 * pow(max(0.0, dot(rd, u.sun.xyz)), 5.0);
    let sun = daylight * (cu.atmo2.y * day * forward * (1.0 - 0.48 * u.weatherStyle.y));
    let moon = vec3f(0.08, 0.10, 0.15) * (u.moon.w * smoothstep(-0.08, 0.25, dot(up, u.moon.xyz)));
    return sun + moon + u.ambientFloor.rgb;
}

// Bicubic upsample; the raymarch already stopped at the nearest surface under each cloud pixel.
fn upsampleCloud(uv: vec2f, cloudSize: vec2i, blocks: vec2i, k: i32, opaque: bool) -> vec4f {
    // Texels whose ray stopped at an opaque surface store a negative depth. Across a silhouette the
    // upsample mixed them with sky texels, so sky pixels next to terrain got the terrain texels' "no
    // cloud": a line of bare sky between clouds and every ridge. Where the 2x2 texels around this pixel
    // disagree, blend only those of this pixel's kind (opaque or sky).
    let sp = uv * vec2f(cloudSize) - 0.5;
    let i0 = vec2i(floor(sp));
    let f = sp - floor(sp);
    let o4 = array<vec2i, 4>(vec2i(0, 0), vec2i(1, 0), vec2i(0, 1), vec2i(1, 1));
    var matching = 0u;
    for (var i = 0; i < 4; i++) {
        let tp = clamp(i0 + o4[i], vec2i(0), cloudSize - 1);
        let texelOpaque = textureLoad(cloudDepth, ${budget ? 'tp' : 'clamp(tp / k, vec2i(0), blocks - 1)'}, 0).r < 0.0;
        if (texelOpaque != opaque) { continue; }
        matching |= 1u << u32(i);
    }
    if (matching != 0u && matching != 15u) {
        let w4 = array<f32, 4>((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
        var sumW = 0.0;
        var sumC = vec4f(0.0);
        for (var i = 0; i < 4; i++) {
            if ((matching & (1u << u32(i))) == 0u) { continue; }
            let tp = clamp(i0 + o4[i], vec2i(0), cloudSize - 1);
            sumW += w4[i];
            sumC += textureLoad(cloudColor, tp, 0) * w4[i];
        }
        if (sumW > 1.0e-4) { return sumC / sumW; }
    }
    return sampleCatmullRom(cloudColor, linearSampler, uv);
}

@fragment
fn fsMain(input: VsOut) -> @location(0) vec4f {
    let pix = input.pos.xy;
    let size = cu.viewport.xy;
    let uv = pix / size;
    let ro = u.camPos.xyz;

    let z = textureLoad(sceneDepth, vec2i(pix), 0);
    let opaque = z < 1.0;
    let cloudSize = vec2i(textureDimensions(cloudColor));
    let blocks = ${budget ? 'cloudSize' : 'vec2i(textureDimensions(cloudDepth))'};
    let k = ${budget ? '1' : 'max(i32(u.quality.x), 1)'};
    var c: vec4f;
    if (all(cloudSize == vec2i(size))) {
        // Pixel centres coincide. Only the centre tap has nonzero weight.
        c = textureLoad(cloudColor, vec2i(pix), 0);
    } else {
        c = upsampleCloud(uv, cloudSize, blocks, k, opaque);
    }
    let cloud = vec4f(max(c.rgb, vec3f(0.0)), saturate(c.a));

    let shadowsOn = opaque && cu.viewport.z > 0.0 && u.shadowInfo.z > 0.0;
    let mistOn = u.groundMist.x > 0.001 && u.groundMist.w > 0.0;
    if (cloud.a > 0.999 && !shadowsOn && !mistOn) { discard; }
    ${budget ? /* wgsl */`
    var rd = vec3f(0.0);
    if (opaque || mistOn) { rd = cameraRay(pix, size, u.camRight, u.camUp, u.camBack, u.frameInfo.x); }
    ` : /* wgsl */`
    let rd = cameraRay(pix, size, u.camRight, u.camUp, u.camBack, u.frameInfo.x);
    `}
    var sceneKm = 1.0e30;
    if (opaque) {
        let viewDepth = u.sceneDepth.y / (z + u.sceneDepth.x);
        sceneKm = viewDepth * u.sceneDepth.z / max(-dot(rd, u.camBack.xyz), 1.0e-4);
    }

    var shadow = 1.0;
    if (shadowsOn) {
        let lit = cloudShadowSmoothAt(ro + rd * sceneKm, cu.viewport.z);
        if (lit < 1.0) { shadow = mix(1.0, mix(cu.atmo2.z, 1.0, lit), surfaceVisibility(ro, rd, sceneKm)); }
    }
    if (cloud.a > 0.999 && shadow > 0.999 && !mistOn) { discard; }

    var color = vec3f(0.0);
    var transmittance = cloud.a;
    var cloudKm = sceneKm;
    if (cloud.a < 0.999) {
        let cloudPix = vec2i(uv * u.frameInfo.zw);
        cloudKm = min(sceneKm, abs(textureLoad(cloudDepth, clamp(cloudPix / k, vec2i(0), blocks - 1), 0).r));
        let haze = ${budget ? 'lookupHaze(uv, cloudKm)' : 'hazeTo(ro, rd, cloudKm)'};
        // Toward the horizon the distant cloud field loses contrast into the
        // host sky. Fade its premultiplied colour and opacity together.
        let cloudHeight = (length(ro) - u.planet.y) / (u.planet.z - u.planet.y);
        let below = 1.0 - smoothstep(0.0, 0.45, cloudHeight);
        let distant = smoothstep(u.banks.z * 0.64, u.banks.z * 1.8, cloudKm);
        let visible = 1.0 - 0.78 * u.banks.x * below * distant * (1.0 - 0.84 * u.weatherStyle.y);
        color = (haze.T * cloud.rgb + (1.0 - cloud.a) * haze.L) * visible;
        transmittance = 1.0 - (1.0 - cloud.a) * visible;
    }
    if (mistOn) {
        let depths = groundMistDepths(ro, rd, sceneKm, cloudKm);
        if (depths.y > 0.001) {
            let T = exp(-depths);
            // Part of the mist lies behind the clouds and is masked by their opacity.
            let veil = mix(1.0 - T.x, 1.0 - T.y, transmittance);
            color = color * T.x + groundMistLight(ro, rd) * veil;
            transmittance *= T.y;
        }
    }
    return vec4f(color, transmittance * shadow);
}
`;
}
