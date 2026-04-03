import { AtmosphericScatteringLUT } from './atmosphericScatteringLUT.js';

export class WebGPUAtmosphericScatteringLUT extends AtmosphericScatteringLUT {
    constructor(backend, uniformManager) {
        super(backend, uniformManager);

        this._transmittancePipeline = null;
        this._transmittanceBindGroup = null;
        this._multiScatterPipeline = null;
        this._multiScatterBindGroup = null;
        this._uniformBuffer = null;
        this._sampler = null;
    }
    
    async _initializeResources() {
        this._uniformBuffer = this.backend.createBuffer(
            new Float32Array(16),
            'uniform'
        );

        this._sampler = this.backend.device.createSampler({
            minFilter: 'linear',
            magFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge'
        });

        await this._createTransmittanceTexture();
        await this._createMultiScatterTexture();
        await this._createTransmittancePipeline();
        await this._createMultiScatterPipeline();

        
        
    }
    
    async _createTransmittanceTexture() {
        this.transmittanceLUT._gpuTexture = this.backend.createStorageTexture(
            this.transmittanceSize.width,
            this.transmittanceSize.height,
            'rgba16float'
        );
    }
    
    async _createMultiScatterTexture() {
        this.multiScatterLUT._gpuTexture = this.backend.createStorageTexture(
            this.multiScatterSize.width,
            this.multiScatterSize.height,
            'rgba16float'
        );
    }
    
    async _createTransmittancePipeline() {
        const shaderSource = await this._loadTransmittanceShader();

        const pipelineDescriptor = {
            label: 'Transmittance LUT',
            shaderSource: shaderSource,
            bindGroupLayouts: [
                {
                    entries: [
                        { binding: 0, type: 'uniform' },
                        { binding: 1, type: 'storageTexture', format: 'rgba16float', access: 'write' }
                    ]
                }
            ]
        };

        const result = this.backend.createComputePipeline(pipelineDescriptor);
        this._transmittancePipeline = result.pipeline;
        const bindGroupLayout = result.bindGroupLayout;

        this._transmittanceBindGroup = this.backend.createBindGroup(bindGroupLayout, [
            { binding: 0, resource: this._uniformBuffer },
            { binding: 1, resource: this.transmittanceLUT._gpuTexture }
        ]);
    }

    async _createMultiScatterPipeline() {
        const shaderSource = await this._loadMultiScatterShader();

        const pipelineDescriptor = {
            label: 'Multi-Scatter LUT',
            shaderSource: shaderSource,
            bindGroupLayouts: [
                {
                    entries: [
                        { binding: 0, type: 'uniform' },
                        { binding: 1, type: 'storageTexture', format: 'rgba16float', access: 'write' },
                        { binding: 2, type: 'texture' },
                        { binding: 3, type: 'sampler' }
                    ]
                }
            ]
        };

        const result = this.backend.createComputePipeline(pipelineDescriptor);
        this._multiScatterPipeline = result.pipeline;
        const bindGroupLayout = result.bindGroupLayout;

        this._multiScatterBindGroup = this.backend.createBindGroup(bindGroupLayout, [
            { binding: 0, resource: this._uniformBuffer },
            { binding: 1, resource: this.multiScatterLUT._gpuTexture },
            { binding: 2, resource: this.transmittanceLUT._gpuTexture.view },
            { binding: 3, resource: this._sampler }
        ]);
    }
    
    async _loadTransmittanceShader() {
        const url = new URL('./shaders/webgpu/transmittanceLUT.wgsl', import.meta.url);
        const response = await fetch(url);
        if (!response.ok) {
            return this._getEmbeddedTransmittanceShader();
        }
        return await response.text();
    }

    async _loadMultiScatterShader() {
        const url = new URL('./shaders/webgpu/multiScatterLUT.wgsl', import.meta.url);
        const response = await fetch(url);
        if (!response.ok) {
            return this._getEmbeddedMultiScatterShader();
        }
        return await response.text();
    }
    
    _getEmbeddedTransmittanceShader() {
        return `
struct AtmosphereUniforms {
    planetRadius: f32,
    atmosphereRadius: f32,
    rayleighScaleHeight: f32,
    mieScaleHeight: f32,
    rayleighScattering: vec3<f32>,
    mieScattering: f32,
    ozoneAbsorption: vec3<f32>,
    _pad0: f32,
    textureSize: vec2<f32>,
    _pad1: vec2<f32>,
}

@group(0) @binding(0) var<uniform> atmo: AtmosphereUniforms;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rgba16float, write>;

const PI: f32 = 3.14159265359;
const TRANSMITTANCE_STEPS: i32 = 40;

fn raySphereIntersect(origin: vec3<f32>, dir: vec3<f32>, radius: f32) -> vec2<f32> {
    let a = dot(dir, dir);
    let b = 2.0 * dot(origin, dir);
    let c = dot(origin, origin) - radius * radius;
    let d = b * b - 4.0 * a * c;
    if (d < 0.0) { return vec2<f32>(-1.0, -1.0); }
    let sqrtD = sqrt(d);
    return vec2<f32>((-b - sqrtD) / (2.0 * a), (-b + sqrtD) / (2.0 * a));
}

fn uvToTransmittanceParams(uv: vec2<f32>) -> vec2<f32> {
    let H = sqrt(atmo.atmosphereRadius * atmo.atmosphereRadius - atmo.planetRadius * atmo.planetRadius);
    let rho = H * uv.x;
    let r = sqrt(rho * rho + atmo.planetRadius * atmo.planetRadius);
    let dMin = atmo.atmosphereRadius - r;
    let dMax = rho + H;
    let d = dMin + uv.y * (dMax - dMin);
    var cosTheta: f32;
    if (d == 0.0) { cosTheta = 1.0; }
    else { cosTheta = (H * H - rho * rho - d * d) / (2.0 * r * d); }
    return vec2<f32>(r - atmo.planetRadius, clamp(cosTheta, -1.0, 1.0));
}

fn computeTransmittance(altitude: f32, cosTheta: f32) -> vec3<f32> {
    let r = atmo.planetRadius + altitude;
    let origin = vec3<f32>(0.0, r, 0.0);
    let sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
    let dir = vec3<f32>(sinTheta, cosTheta, 0.0);
    
    let intersection = raySphereIntersect(origin, dir, atmo.atmosphereRadius);
    if (intersection.y < 0.0) { return vec3<f32>(1.0); }
    
    let groundIntersect = raySphereIntersect(origin, dir, atmo.planetRadius);
    var rayLength = intersection.y;
    if (groundIntersect.x > 0.0) { rayLength = min(rayLength, groundIntersect.x); }
    
    let stepSize = rayLength / f32(TRANSMITTANCE_STEPS);
    var opticalDepthR = vec3<f32>(0.0);
    var opticalDepthM: f32 = 0.0;
    var opticalDepthO = vec3<f32>(0.0);
    
    for (var i = 0; i < TRANSMITTANCE_STEPS; i++) {
        let t = (f32(i) + 0.5) * stepSize;
        let pos = origin + dir * t;
        let alt = length(pos) - atmo.planetRadius;
        let dR = exp(-max(0.0, alt) / atmo.rayleighScaleHeight);
        let dM = exp(-max(0.0, alt) / atmo.mieScaleHeight);
        let x = (alt - 25000.0) / 15000.0;
        let dO = max(0.0, 1.0 - x * x);
        opticalDepthR += atmo.rayleighScattering * dR * stepSize;
        opticalDepthM += atmo.mieScattering * dM * stepSize;
        opticalDepthO += atmo.ozoneAbsorption * dO * stepSize;
    }
    
    return exp(-(opticalDepthR + vec3<f32>(opticalDepthM) + opticalDepthO));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let texSize = vec2<u32>(u32(atmo.textureSize.x), u32(atmo.textureSize.y));
    if (id.x >= texSize.x || id.y >= texSize.y) { return; }
    let uv = vec2<f32>((f32(id.x) + 0.5) / f32(texSize.x), (f32(id.y) + 0.5) / f32(texSize.y));
    let params = uvToTransmittanceParams(uv);
    let transmittance = computeTransmittance(params.x, params.y);
    textureStore(outputTexture, vec2<i32>(id.xy), vec4<f32>(transmittance, 1.0));
}
`;
    }

    _getEmbeddedMultiScatterShader() {
        return `struct AtmosphereUniforms {
    planetRadius: f32, atmosphereRadius: f32, rayleighScaleHeight: f32, mieScaleHeight: f32,
    rayleighScattering: vec3<f32>, mieScattering: f32, ozoneAbsorption: vec3<f32>, mieAnisotropy: f32,
    textureSize: vec2<f32>, _pad1: vec2<f32>,
}
@group(0) @binding(0) var<uniform> atmo: AtmosphereUniforms;
@group(0) @binding(1) var outputTexture: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var transmittanceLUT: texture_2d<f32>;
@group(0) @binding(3) var transmittanceSampler: sampler;
const PI: f32 = 3.14159265359; const ANGLE_SAMPLES: i32 = 16;
fn rayleighPhase(c: f32) -> f32 { return (3.0/(16.0*PI))*(1.0+c*c); }
fn miePhase(c: f32, g: f32) -> f32 { let g2=g*g; return (1.0/(4.0*PI))*(1.0-g2)/pow(1.0+g2-2.0*g*c,1.5); }
fn transmittanceUV(alt: f32, cosTheta: f32) -> vec2<f32> {
    let H=sqrt(atmo.atmosphereRadius*atmo.atmosphereRadius-atmo.planetRadius*atmo.planetRadius);
    let r=atmo.planetRadius+alt; let rho=sqrt(max(0.0,r*r-atmo.planetRadius*atmo.planetRadius));
    let u=rho/H; let dMin=atmo.atmosphereRadius-r; let dMax=rho+H;
    let cosT=clamp(cosTheta,-1.0,1.0);
    let disc=max(0.0,r*r*cosT*cosT+atmo.atmosphereRadius*atmo.atmosphereRadius-r*r);
    let d=-r*cosT+sqrt(disc);
    return vec2<f32>(clamp(u,0.0,1.0),clamp((d-dMin)/(dMax-dMin),0.0,1.0));
}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let texSize=vec2<u32>(u32(atmo.textureSize.x),u32(atmo.textureSize.y));
    if(id.x>=texSize.x||id.y>=texSize.y){return;}
    let uv=vec2<f32>((f32(id.x)+0.5)/f32(texSize.x),(f32(id.y)+0.5)/f32(texSize.y));
    let alt=uv.y*(atmo.atmosphereRadius-atmo.planetRadius); let cosSun=uv.x*2.0-1.0;
    let rDens=exp(-max(0.0,alt)/atmo.rayleighScaleHeight);
    let mDens=exp(-max(0.0,alt)/atmo.mieScaleHeight);
    let rScat=atmo.rayleighScattering*rDens; let mScat=vec3<f32>(atmo.mieScattering)*mDens;
    var sum=vec3<f32>(0.0);
    for(var i=0;i<ANGLE_SAMPLES;i++){
        let theta=(f32(i)+0.5)/f32(ANGLE_SAMPLES)*PI; let cosT=cos(theta);
        let trans=textureSampleLevel(transmittanceLUT,transmittanceSampler,transmittanceUV(alt,cosT),0.0).rgb;
        sum+=trans*(rScat*rayleighPhase(cosSun)+mScat*miePhase(cosSun,atmo.mieAnisotropy))*sin(theta);
    }
    textureStore(outputTexture,vec2<i32>(id.xy),vec4<f32>(sum*(2.0*PI)/f32(ANGLE_SAMPLES),1.0));
}`;
    }

    _generateTransmittanceLUT() {
        const uniformData = this._getAtmosphereUniformData();
        this.backend.updateBuffer(this._uniformBuffer, uniformData);

        const workgroupsX = Math.ceil(this.transmittanceSize.width / 8);
        const workgroupsY = Math.ceil(this.transmittanceSize.height / 8);

        this.backend.dispatchCompute(
            this._transmittancePipeline,
            this._transmittanceBindGroup,
            workgroupsX,
            workgroupsY,
            1
        );

        

        this._generateMultiScatterLUT();
    }

    _generateMultiScatterLUT() {
        const uniformData = this._getAtmosphereUniformData();
        uniformData[11] = this.uniformManager.uniforms.atmosphereMieAnisotropy.value;
        uniformData[12] = this.multiScatterSize.width;
        uniformData[13] = this.multiScatterSize.height;
        this.backend.updateBuffer(this._uniformBuffer, uniformData);

        const workgroupsX = Math.ceil(this.multiScatterSize.width / 8);
        const workgroupsY = Math.ceil(this.multiScatterSize.height / 8);

        this.backend.dispatchCompute(
            this._multiScatterPipeline,
            this._multiScatterBindGroup,
            workgroupsX,
            workgroupsY,
            1
        );

        
    }
    
    dispose() {
        if (this._uniformBuffer) {
            this.backend.deleteBuffer(this._uniformBuffer);
        }
        if (this.transmittanceLUT._gpuTexture) {
            this.backend.deleteStorageTexture(this.transmittanceLUT._gpuTexture);
        }
        if (this.multiScatterLUT._gpuTexture) {
            this.backend.deleteStorageTexture(this.multiScatterLUT._gpuTexture);
        }
        
        
    }
}
