import { AtmosphericScatteringLUT } from './atmosphericScatteringLUT.js';
import { Geometry } from '../resources/geometry.js';
import { Material } from '../resources/material.js';
import { RenderTarget } from '../resources/RenderTarget.js';
import { TextureFormat } from '../resources/texture.js';

export class WebGL2AtmosphericScatteringLUT extends AtmosphericScatteringLUT {
    constructor(backend, uniformManager) {
        super(backend, uniformManager);
        
        this._transmittanceRT = null;
        this._multiScatterRT = null;
        this._fullscreenQuad = null;
        this._transmittanceMaterial = null;
    }
    
    async _initializeResources() {
        this._createRenderTargets();
        this._createFullscreenQuad();
        await this._createMaterials();
        
        
    }
    
    _createRenderTargets() {
        this._transmittanceRT = new RenderTarget(
            this.transmittanceSize.width,
            this.transmittanceSize.height,
            {
                format: TextureFormat.RGBA16F,
                depthBuffer: false
            }
        );
        this.backend.createRenderTarget(this._transmittanceRT);
        
        this.transmittanceLUT._gpuTexture = this._transmittanceRT.texture._gpuTexture;
        this.transmittanceLUT.width = this.transmittanceSize.width;
        this.transmittanceLUT.height = this.transmittanceSize.height;
        
        this._multiScatterRT = new RenderTarget(
            this.multiScatterSize.width,
            this.multiScatterSize.height,
            {
                format: TextureFormat.RGBA16F,
                depthBuffer: false
            }
        );
        this.backend.createRenderTarget(this._multiScatterRT);
        
        this.multiScatterLUT._gpuTexture = this._multiScatterRT.texture._gpuTexture;
        this.multiScatterLUT.width = this.multiScatterSize.width;
        this.multiScatterLUT.height = this.multiScatterSize.height;
    }
    
    _createFullscreenQuad() {
        const positions = new Float32Array([
            -1, -1, 0,
             1, -1, 0,
            -1,  1, 0,
             1,  1, 0
        ]);
        
        const normals = new Float32Array([
            0, 0, 1,
            0, 0, 1,
            0, 0, 1,
            0, 0, 1
        ]);
        
        const uvs = new Float32Array([
            0, 0,
            1, 0,
            0, 1,
            1, 1
        ]);
        
        const indices = new Uint16Array([0, 1, 2, 2, 1, 3]);
        
        this._fullscreenQuad = new Geometry();
        this._fullscreenQuad.setAttribute('position', positions, 3);
        this._fullscreenQuad.setAttribute('normal', normals, 3);
        this._fullscreenQuad.setAttribute('uv', uvs, 2);
        this._fullscreenQuad.setIndex(indices);
    }
    
    async _createMaterials() {
        const vertexShader = `#version 300 es
precision highp float;

in vec3 position;
in vec2 uv;
out vec2 vUv;

void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
        
        const fragmentShader = this._getEmbeddedFragmentShader();
        
        this._transmittanceMaterial = new Material({
            name: 'TransmittanceLUT_WebGL2',
            vertexShader: vertexShader,
            fragmentShader: fragmentShader,
            uniforms: {
                uPlanetRadius: { value: 50000.0 },
                uAtmosphereRadius: { value: 60000.0 },
                uRayleighScattering: { value: [5.5e-5, 13.0e-5, 22.4e-5] },
                uMieScattering: { value: 21e-5 },
                uRayleighScaleHeight: { value: 800.0 },
                uMieScaleHeight: { value: 120.0 },
                uOzoneAbsorption: { value: [0.65e-6, 1.881e-6, 0.085e-6] },
                uTextureSize: { value: [256.0, 64.0] }
            },
            depthTest: false,
            depthWrite: false,
            side: 'double'
        });
        
        this.backend.compileShader(this._transmittanceMaterial);

        const multiScatterFragmentShader = this._getEmbeddedMultiScatterShader();

        this._multiScatterMaterial = new Material({
            name: 'MultiScatterLUT_WebGL2',
            vertexShader: vertexShader,
            fragmentShader: multiScatterFragmentShader,
            uniforms: {
                uPlanetRadius: { value: 50000.0 },
                uAtmosphereRadius: { value: 60000.0 },
                uRayleighScattering: { value: [5.5e-5, 13.0e-5, 22.4e-5] },
                uMieScattering: { value: 21e-5 },
                uRayleighScaleHeight: { value: 800.0 },
                uMieScaleHeight: { value: 120.0 },
                uMieAnisotropy: { value: 0.758 },
                uTransmittanceLUT: { value: this.transmittanceLUT }
            },
            depthTest: false,
            depthWrite: false,
            side: 'double'
        });

        this.backend.compileShader(this._multiScatterMaterial);
    }
    
    _getEmbeddedFragmentShader() {
        return `#version 300 es
precision highp float;

uniform float uPlanetRadius;
uniform float uAtmosphereRadius;
uniform vec3 uRayleighScattering;
uniform float uMieScattering;
uniform float uRayleighScaleHeight;
uniform float uMieScaleHeight;
uniform vec3 uOzoneAbsorption;
uniform vec2 uTextureSize;

in vec2 vUv;
out vec4 fragColor;

const int TRANSMITTANCE_STEPS = 40;

vec2 raySphereIntersect(vec3 origin, vec3 dir, float radius) {
    float a = dot(dir, dir);
    float b = 2.0 * dot(origin, dir);
    float c = dot(origin, origin) - radius * radius;
    float d = b * b - 4.0 * a * c;
    if (d < 0.0) return vec2(-1.0);
    float sqrtD = sqrt(d);
    return vec2((-b - sqrtD) / (2.0 * a), (-b + sqrtD) / (2.0 * a));
}

vec2 uvToTransmittanceParams(vec2 uv) {
    float H = sqrt(uAtmosphereRadius * uAtmosphereRadius - uPlanetRadius * uPlanetRadius);
    float rho = H * uv.x;
    float r = sqrt(rho * rho + uPlanetRadius * uPlanetRadius);
    float dMin = uAtmosphereRadius - r;
    float dMax = rho + H;
    float d = dMin + uv.y * (dMax - dMin);
    float cosTheta = (d == 0.0) ? 1.0 : (H * H - rho * rho - d * d) / (2.0 * r * d);
    return vec2(r - uPlanetRadius, clamp(cosTheta, -1.0, 1.0));
}

vec3 computeTransmittance(float altitude, float cosTheta) {
    float r = uPlanetRadius + altitude;
    vec3 origin = vec3(0.0, r, 0.0);
    float sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
    vec3 dir = vec3(sinTheta, cosTheta, 0.0);
    
    vec2 intersection = raySphereIntersect(origin, dir, uAtmosphereRadius);
    if (intersection.y < 0.0) return vec3(1.0);
    
    vec2 groundIntersect = raySphereIntersect(origin, dir, uPlanetRadius);
    float rayLength = intersection.y;
    if (groundIntersect.x > 0.0) rayLength = min(rayLength, groundIntersect.x);
    
    float stepSize = rayLength / float(TRANSMITTANCE_STEPS);
    vec3 opticalDepthR = vec3(0.0);
    float opticalDepthM = 0.0;
    vec3 opticalDepthO = vec3(0.0);
    
    for (int i = 0; i < TRANSMITTANCE_STEPS; i++) {
        float t = (float(i) + 0.5) * stepSize;
        vec3 pos = origin + dir * t;
        float alt = length(pos) - uPlanetRadius;
        float dR = exp(-max(0.0, alt) / uRayleighScaleHeight);
        float dM = exp(-max(0.0, alt) / uMieScaleHeight);
        float x = (alt - 25000.0) / 15000.0;
        float dO = max(0.0, 1.0 - x * x);
        opticalDepthR += uRayleighScattering * dR * stepSize;
        opticalDepthM += uMieScattering * dM * stepSize;
        opticalDepthO += uOzoneAbsorption * dO * stepSize;
    }
    
    return exp(-(opticalDepthR + vec3(opticalDepthM) + opticalDepthO));
}

void main() {
    vec2 params = uvToTransmittanceParams(vUv);
    vec3 transmittance = computeTransmittance(params.x, params.y);
    fragColor = vec4(transmittance, 1.0);
}
`;
    }

    _getEmbeddedMultiScatterShader() {
        return `#version 300 es
precision highp float;
uniform float uPlanetRadius; uniform float uAtmosphereRadius;
uniform vec3 uRayleighScattering; uniform float uMieScattering;
uniform float uRayleighScaleHeight; uniform float uMieScaleHeight;
uniform float uMieAnisotropy; uniform sampler2D uTransmittanceLUT;
in vec2 vUv; out vec4 fragColor;
const float PI=3.14159265359; const int ANGLE_SAMPLES=16;
float rayleighPhase(float c){return(3.0/(16.0*PI))*(1.0+c*c);}
float miePhase(float c,float g){float g2=g*g;return(1.0/(4.0*PI))*(1.0-g2)/pow(1.0+g2-2.0*g*c,1.5);}
vec2 transmittanceUV(float alt,float cosTheta){
  float H=sqrt(uAtmosphereRadius*uAtmosphereRadius-uPlanetRadius*uPlanetRadius);
  float r=uPlanetRadius+alt; float rho=sqrt(max(0.0,r*r-uPlanetRadius*uPlanetRadius));
  float u=rho/H; float dMin=uAtmosphereRadius-r; float dMax=rho+H;
  float cosT=clamp(cosTheta,-1.0,1.0);
  float disc=max(0.0,r*r*cosT*cosT+uAtmosphereRadius*uAtmosphereRadius-r*r);
  float d=-r*cosT+sqrt(disc);
  return vec2(clamp(u,0.0,1.0),clamp((d-dMin)/(dMax-dMin),0.0,1.0));
}
void main(){
  float alt=vUv.y*(uAtmosphereRadius-uPlanetRadius); float cosSun=vUv.x*2.0-1.0;
  float rDens=exp(-max(0.0,alt)/uRayleighScaleHeight);
  float mDens=exp(-max(0.0,alt)/uMieScaleHeight);
  vec3 rScat=uRayleighScattering*rDens; vec3 mScat=vec3(uMieScattering)*mDens;
  vec3 sum=vec3(0.0);
  for(int i=0;i<ANGLE_SAMPLES;i++){
    float theta=(float(i)+0.5)/float(ANGLE_SAMPLES)*PI; float cosT=cos(theta);
    vec3 trans=texture(uTransmittanceLUT,transmittanceUV(alt,cosT)).rgb;
    sum+=trans*(rScat*rayleighPhase(cosSun)+mScat*miePhase(cosSun,uMieAnisotropy))*sin(theta);
  }
  fragColor=vec4(sum*(2.0*PI)/float(ANGLE_SAMPLES),1.0);
}`;
    }

    _generateTransmittanceLUT() {
        const uniforms = this.uniformManager.uniforms;
        const mat = this._transmittanceMaterial;
        
        mat.uniforms.uPlanetRadius.value = uniforms.atmospherePlanetRadius.value;
        mat.uniforms.uAtmosphereRadius.value = uniforms.atmosphereRadius.value;
        
        const rayleigh = uniforms.atmosphereRayleighScattering.value;
        mat.uniforms.uRayleighScattering.value = [rayleigh.x, rayleigh.y, rayleigh.z];
        
        mat.uniforms.uMieScattering.value = uniforms.atmosphereMieScattering.value;
        mat.uniforms.uRayleighScaleHeight.value = uniforms.atmosphereScaleHeightRayleigh.value;
        mat.uniforms.uMieScaleHeight.value = uniforms.atmosphereScaleHeightMie.value;
        
        const ozone = uniforms.atmosphereOzoneAbsorption.value;
        mat.uniforms.uOzoneAbsorption.value = [ozone.x, ozone.y, ozone.z];
        
        mat.uniforms.uTextureSize.value = [
            this.transmittanceSize.width,
            this.transmittanceSize.height
        ];
        
        const prevViewport = this._getCurrentViewport();
        
        this.backend.setRenderTarget(this._transmittanceRT);
        this.backend.setViewport(0, 0, this.transmittanceSize.width, this.transmittanceSize.height);
        this.backend.setClearColor(0, 0, 0, 1);
        this.backend.clear(true, false, false);
        
        this.backend.draw(this._fullscreenQuad, this._transmittanceMaterial);
        
        this.backend.setRenderTarget(null);
        this.backend.setViewport(prevViewport.x, prevViewport.y, prevViewport.width, prevViewport.height);

        

        this._generateMultiScatterLUT();
    }

    _generateMultiScatterLUT() {
        const uniforms = this.uniformManager.uniforms;
        const mat = this._multiScatterMaterial;

        mat.uniforms.uPlanetRadius.value = uniforms.atmospherePlanetRadius.value;
        mat.uniforms.uAtmosphereRadius.value = uniforms.atmosphereRadius.value;

        const rayleigh = uniforms.atmosphereRayleighScattering.value;
        mat.uniforms.uRayleighScattering.value = [rayleigh.x, rayleigh.y, rayleigh.z];

        mat.uniforms.uMieScattering.value = uniforms.atmosphereMieScattering.value;
        mat.uniforms.uRayleighScaleHeight.value = uniforms.atmosphereScaleHeightRayleigh.value;
        mat.uniforms.uMieScaleHeight.value = uniforms.atmosphereScaleHeightMie.value;
        mat.uniforms.uMieAnisotropy.value = uniforms.atmosphereMieAnisotropy.value;
        mat.uniforms.uTransmittanceLUT.value = this.transmittanceLUT;

        const prevViewport = this._getCurrentViewport();

        this.backend.setRenderTarget(this._multiScatterRT);
        this.backend.setViewport(0, 0, this.multiScatterSize.width, this.multiScatterSize.height);
        this.backend.setClearColor(0, 0, 0, 1);
        this.backend.clear(true, false, false);

        this.backend.draw(this._fullscreenQuad, this._multiScatterMaterial);

        this.backend.setRenderTarget(null);
        this.backend.setViewport(prevViewport.x, prevViewport.y, prevViewport.width, prevViewport.height);

        
        
    }
    
    _getCurrentViewport() {
        const canvas = this.backend.canvas;
        return {
            x: 0,
            y: 0,
            width: canvas.width,
            height: canvas.height
        };
    }
    
    dispose() {
        if (this._transmittanceRT) {
            this.backend.deleteRenderTarget(this._transmittanceRT);
            this._transmittanceRT = null;
        }
        if (this._multiScatterRT) {
            this.backend.deleteRenderTarget(this._multiScatterRT);
            this._multiScatterRT = null;
        }
        if (this._transmittanceMaterial) {
            this.backend.deleteShader(this._transmittanceMaterial);
            this._transmittanceMaterial = null;
        }
        if (this._fullscreenQuad) {
            this._fullscreenQuad.dispose();
            this._fullscreenQuad = null;
        }
        
        
    }
}
