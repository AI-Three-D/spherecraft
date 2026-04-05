// js/renderer/MoonRenderer.js

import { Vector3, Matrix4, Color } from '../../shared/math/index.js';
import { Geometry } from './resources/geometry.js';
import { Material } from './resources/material.js';

/**
 * MoonRenderer - Renders the moon disc in the sky with proper phase illumination.
 * 
 * Similar to StarRenderer but with phase-based illumination to show
 * crescent, quarter, gibbous, and full moon states.
 */
export class MoonRenderer {
    constructor(backend) {
        this.backend = backend;
        this.enabled = true;
        this.visible = false;
        this.opacity = 0;
        
        // Moon properties (updated each frame)
        this.direction = new Vector3(0, 0.5, 0.5).normalize();
        this.angularDiameter = 0.009; // ~0.52 degrees in radians (Earth's moon)
        this.phase = 0.5; // 0 = new, 0.5 = full, 1 = new again
        this.illumination = 1.0; // 0-1 brightness based on phase
        this.color = new Color(0.9, 0.92, 0.98); // Slightly cool white
        this.intensity = 0.3; // Base intensity (modified by illumination)
        
        // Internal
        this._geometry = null;
        this._material = null;
        this._initialized = false;
    }

    async initialize() {
        if (this._initialized) return;

        this._geometry = this._createFullscreenTriangle();

        const vertexShader = this._getMoonVertexWGSL();
        const fragmentShader = this._getMoonFragmentWGSL();

        this._material = new Material({
            name: 'MoonRenderer',
            vertexShader,
            fragmentShader,
            bindGroupLayoutSpec: [
                {
                    label: 'MoonUniforms',
                    entries: [
                        { binding: 0, visibility: 'vertex|fragment', buffer: { type: 'uniform' }, name: 'moonUniforms' }
                    ]
                }
            ],
            uniforms: {
                moonUniforms: { value: new Float32Array(32) }  // was 24
            },
            vertexLayout: [],
            depthTest: true,
            depthWrite: false,
            transparent: true,
            blending: 'normal',
            side: 'double'
        });

        if (this.backend.compileShader) {
            this.backend.compileShader(this._material);
        }

        this._initialized = true;
    }

    /**
     * Update moon state from star system.
     * @param {Object} camera - Camera with position, matrixWorldInverse, projectionMatrix
     * @param {Object} moonInfo - From StarSystem.getMoonInfo()
     * @param {Object} sunDirection - Sun direction for phase rendering
     * @returns {number} Moon visibility factor (0-1)
     */
    update(camera, moonInfo, sunDirection) {
        if (!moonInfo) {
            this.visible = false;
            this.opacity = 0;
            return 0;
        }
        
        this.direction.copy(moonInfo.direction);
        this.angularDiameter = moonInfo.angularDiameter ?? 0.009;
        this.phase = moonInfo.phase ?? 0.5;
        this.illumination = moonInfo.illumination ?? 1.0;
        
        // Moon is visible when above horizon
        this.visible = moonInfo.isAboveHorizon && this.illumination > 0.01;
        
        // Fade near horizon
        const elevation = moonInfo.elevation ?? 0;
        const horizonFade = Math.max(0, Math.min(1, (elevation + 0.05) / 0.1));
        
        // Opacity based on illumination and horizon
        this.opacity = horizonFade * Math.max(0.1, this.illumination);
        
        // Store sun direction for phase rendering
        this._sunDirection = sunDirection ? sunDirection.clone().normalize() : new Vector3(0, 1, 0);
        
        return this.opacity;
    }

    /**
     * Render the moon disc.
     */
    render(camera) {
        if (!this._initialized || !this.visible || this.opacity < 0.01) return;

        const u = this._material.uniforms.moonUniforms.value;

        u[0] = this.direction.x;
        u[1] = this.direction.y;
        u[2] = this.direction.z;
        u[3] = this.angularDiameter;

        u[4] = this.phase;
        u[5] = this.illumination;
        u[6] = this.opacity;
        u[7] = this.intensity;

        u[8] = this.color.r;
        u[9] = this.color.g;
        u[10] = this.color.b;
        u[11] = 0;

        u[12] = this._sunDirection?.x ?? 0;
        u[13] = this._sunDirection?.y ?? 1;
        u[14] = this._sunDirection?.z ?? 0;
        u[15] = 0;

        // Rotation-only inverse view-projection (16 floats)
        const rotOnlyView = camera.matrixWorldInverse.clone();
        rotOnlyView.elements[12] = 0;
        rotOnlyView.elements[13] = 0;
        rotOnlyView.elements[14] = 0;
        const viewProj = new Matrix4().multiplyMatrices(
            camera.projectionMatrix, rotOnlyView
        );
        const invVP = viewProj.clone().invert();
        for (let i = 0; i < 16; i++) {
            u[16 + i] = invVP.elements[i];
        }

        this.backend.draw(this._geometry, this._material);
    }

    // ==================== Shaders ====================

    _getMoonVertexWGSL() {
        return `
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var output: VertexOutput;
    let positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0)
    );
    let pos = positions[vertexIndex];
    output.position = vec4<f32>(pos, 0.9998, 1.0); // Slightly in front of sky
    output.uv = pos * 0.5 + 0.5;
    return output;
}
`;
    }

    _getMoonFragmentWGSL() {
        return `
    struct MoonUniforms {
        direction: vec3<f32>,
        angularDiameter: f32,
        phase: f32,
        illumination: f32,
        opacity: f32,
        intensity: f32,
        color: vec3<f32>,
        _pad0: f32,
        sunDirection: vec3<f32>,
        _pad1: f32,
        invViewProj: mat4x4<f32>,
    }
    
    @group(0) @binding(0) var<uniform> moon: MoonUniforms;
    
    const PI: f32 = 3.14159265359;
    
    fn getRayDirection(uv: vec2<f32>) -> vec3<f32> {
        let ndc = vec4<f32>(uv.x * 2.0 - 1.0, uv.y * 2.0 - 1.0, 1.0, 1.0);
        var worldDir = moon.invViewProj * ndc;
        worldDir = worldDir / worldDir.w;
        return normalize(worldDir.xyz);
    }
    
    fn getPhaseShading(localUV: vec2<f32>, phase: f32) -> f32 {
        let terminatorX = cos(phase * 2.0 * PI);
        let edgeSoftness = 0.05;
        return smoothstep(terminatorX - edgeSoftness, terminatorX + edgeSoftness, localUV.x);
    }
    
    @fragment
    fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
        let rayDir = getRayDirection(uv);
        let moonDir = normalize(moon.direction);
        let cosAngle = dot(rayDir, moonDir);
    
        let moonRadius = moon.angularDiameter * 0.5;
        let cosMoonRadius = cos(moonRadius);
    
        if (cosAngle < cosMoonRadius - 0.01) {
            discard;
        }
    
        let edgeSoftness = moonRadius * 0.1;
        let discMask = smoothstep(cosMoonRadius - edgeSoftness, cosMoonRadius + edgeSoftness * 0.3, cosAngle);
    
        let angle = acos(clamp(cosAngle, -1.0, 1.0));
        let distFromCenter = angle / moonRadius;
    
        let toPixel = rayDir - moonDir * cosAngle;
        let toPixelLen = length(toPixel);
        var localUV = vec2<f32>(0.0, 0.0);
        if (toPixelLen > 0.0001) {
            let toPixelNorm = toPixel / toPixelLen;
            let moonUp = vec3<f32>(0.0, 1.0, 0.0);
            let moonRight = normalize(cross(moonUp, moonDir));
            let moonActualUp = normalize(cross(moonDir, moonRight));
            localUV.x = dot(toPixelNorm, moonRight) * distFromCenter;
            localUV.y = dot(toPixelNorm, moonActualUp) * distFromCenter;
        }
    
        let phaseShading = getPhaseShading(localUV, moon.phase);
        let limbDarkening = 1.0 - pow(distFromCenter, 2.0) * 0.2;
    
        let baseColor = moon.color * moon.intensity * moon.illumination;
        let shadedColor = baseColor * phaseShading * limbDarkening;
    
        let glowAmount = smoothstep(1.0, 0.7, distFromCenter) * phaseShading * 0.1;
        let finalColor = shadedColor + moon.color * glowAmount;
    
        let alpha = discMask * moon.opacity;
    
        return vec4<f32>(finalColor, alpha);
    }
    `;
    }
    _createFullscreenTriangle() {
        const geom = new Geometry();
        const positions = new Float32Array([
            -1, -1, 0,
             3, -1, 0,
            -1,  3, 0,
        ]);
        const normals = new Float32Array([
            0, 0, 1,
            0, 0, 1,
            0, 0, 1
        ]);
        const uvs = new Float32Array([
            0, 0,
            2, 0,
            0, 2
        ]);

        geom.setAttribute('position', positions, 3);
        geom.setAttribute('normal', normals, 3);
        geom.setAttribute('uv', uvs, 2);
        return geom;
    }

    dispose() {
        this._initialized = false;
        this._material = null;
        this._geometry = null;
    }
}