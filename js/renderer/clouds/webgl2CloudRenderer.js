import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';
import { CloudRenderer } from './cloudRenderer.js';
import { Material } from '../resources/material.js';
import { WebGL2FroxelGrid } from './webgl2FroxelGrid.js';

export class WebGL2CloudRenderer extends CloudRenderer {
    async initialize() {
        // Create WebGL2-compatible froxel grid instead of WebGPU version
        this.froxelGrid = new WebGL2FroxelGrid(this.backend, this.config.gridDimensions);
        await this.froxelGrid.initialize();

        // Create fullscreen triangle for ray marching
        this.fullscreenGeometry = this._createFullscreenTriangle();
        this.initialized = true;

        // Default volume parameters
        const defaultVolumeSize = new THREE.Vector3(8000, 4000, 12000);
        const defaultMaxDistance = 12000;
        const defaultNumSteps = 64;

        this.material = new Material({
            name: 'VolumetricClouds_WebGL2',
            vertexShader: this._getVertexShader(),
            fragmentShader: this._getFragmentShader(),
            uniforms: {
                cameraPosition: { value: new THREE.Vector3() },
                sunDirection: { value: new THREE.Vector3(0.5, 1.0, 0.3).normalize() },
                viewMatrix: { value: new THREE.Matrix4() },
                invViewProjMatrix: { value: new THREE.Matrix4() },
                invProjMatrix: { value: new THREE.Matrix4() },
                gridScale: { value: defaultVolumeSize.clone() },
                gridDimensions: { value: new THREE.Vector3(
                    this.config.gridDimensions.x,
                    this.config.gridDimensions.y,
                    this.config.gridDimensions.z
                ) },
                maxDistance: { value: defaultMaxDistance },
                numSteps: { value: defaultNumSteps },
                cloudLowCoverage: { value: 0.3 },
                cloudHighCoverage: { value: 0.2 },
                fogDensity: { value: 0.0001 },
                time: { value: 0 },
                cloudAnisotropy: { value: this.config.cloudAnisotropy },
                froxelTexture: { value: this.froxelGrid.getTexture() },
                cloudBaseColor: { value: new THREE.Vector3(0.9, 0.95, 1.0) },
                // Planet parameters for spherical ray marching
                planetCenter: { value: new THREE.Vector3(0, 0, 0) },
                planetRadius: { value: 2048 },
                cumulusInnerRadius: { value: 2100 },
                cumulusOuterRadius: { value: 2300 },
                cirrusInnerRadius: { value: 2400 },
                cirrusOuterRadius: { value: 2500 }
            },
            transparent: true,
            depthTest: false,
            depthWrite: false,
            side: 'double'
        });

        if (this.backend.compileShader) {
            this.backend.compileShader(this.material);
        }
    }

    render(camera, environmentState, uniformManager) {
        if (!this.enabled || !this.initialized || !this.material || !this.planetConfig) return;

        const common = this.getCommonUniformValues(camera, environmentState, uniformManager);
        if (!common) return;

        // Update froxel grid with current state
        this.froxelGrid.update(camera, environmentState, uniformManager, this.planetConfig);

        const u = this.material.uniforms;

        u.cameraPosition.value.copy(common.cameraPosition);
        u.sunDirection.value.copy(common.sunDirection);
        u.viewMatrix.value.copy(common.viewMatrix);
        u.invViewProjMatrix.value.copy(common.invViewProjMatrix);
        u.invProjMatrix.value.copy(common.invProjMatrix);
        u.gridScale.value.copy(common.gridScale);
        u.gridDimensions.value.copy(common.gridDimensions);
        u.maxDistance.value = common.maxDistance;
        u.numSteps.value = common.numSteps;
        u.cloudLowCoverage.value = common.cloudLowCoverage;
        u.cloudHighCoverage.value = common.cloudHighCoverage;
        u.fogDensity.value = common.fogDensity;
        u.time.value = common.time;
        u.cloudAnisotropy.value = common.cloudAnisotropy;
        u.froxelTexture.value = this.froxelGrid.getTexture();

        // Planet parameters for spherical ray marching
        u.planetCenter.value.copy(common.planetCenter);
        u.planetRadius.value = common.planetRadius;
        u.cumulusInnerRadius.value = common.cumulusInnerRadius;
        u.cumulusOuterRadius.value = common.cumulusOuterRadius;
        u.cirrusInnerRadius.value = common.cirrusInnerRadius;
        u.cirrusOuterRadius.value = common.cirrusOuterRadius;

        this.backend.draw(this.fullscreenGeometry, this.material);
    }

    _getVertexShader() {
        return `#version 300 es
        precision highp float;

        out vec2 vUv;

        void main() {
            vec2 positions[3];
            positions[0] = vec2(-1.0, -1.0);
            positions[1] = vec2(3.0, -1.0);
            positions[2] = vec2(-1.0, 3.0);

            vec2 pos = positions[gl_VertexID];
            gl_Position = vec4(pos, 0.9999, 1.0);
            vUv = pos * 0.5 + 0.5;
        }`;
    }

    _getFragmentShader() {
        return `#version 300 es
        precision highp float;

        in vec2 vUv;
        out vec4 fragColor;

        uniform vec3 cameraPosition;
        uniform vec3 sunDirection;
        uniform mat4 viewMatrix;
        uniform mat4 invViewProjMatrix;
        uniform mat4 invProjMatrix;
        uniform vec3 gridScale;
        uniform vec3 gridDimensions;
        uniform float maxDistance;
        uniform int numSteps;
        uniform float cloudLowCoverage;
        uniform float cloudHighCoverage;
        uniform float fogDensity;
        uniform float time;
        uniform float cloudAnisotropy;
        uniform vec3 cloudBaseColor;
        uniform sampler2D froxelTexture;

        // Planet parameters
        uniform vec3 planetCenter;
        uniform float planetRadius;
        uniform float cumulusInnerRadius;
        uniform float cumulusOuterRadius;
        uniform float cirrusInnerRadius;
        uniform float cirrusOuterRadius;

        const float PI = 3.14159265359;
        const float TRANSMITTANCE_THRESHOLD = 0.01;

        vec3 getRayDirection(vec2 uv) {
            vec4 ndc = vec4(uv * 2.0 - 1.0, 1.0, 1.0);
            vec4 worldPos = invViewProjMatrix * ndc;
            return normalize(worldPos.xyz / worldPos.w - cameraPosition);
        }

        // Ray-sphere intersection
        vec2 raySphereIntersect(vec3 rayOrigin, vec3 rayDir, vec3 sphereCenter, float radius) {
            vec3 oc = rayOrigin - sphereCenter;
            float b = dot(oc, rayDir);
            float c = dot(oc, oc) - radius * radius;
            float discriminant = b * b - c;

            if (discriminant < 0.0) {
                return vec2(-1.0, -1.0);
            }

            float sqrtD = sqrt(discriminant);
            return vec2(-b - sqrtD, -b + sqrtD);
        }

        // Get intersection range with spherical shell
        vec2 rayShellIntersect(vec3 rayOrigin, vec3 rayDir, vec3 center, float innerR, float outerR) {
            vec2 outerHit = raySphereIntersect(rayOrigin, rayDir, center, outerR);
            vec2 innerHit = raySphereIntersect(rayOrigin, rayDir, center, innerR);

            if (outerHit.x < 0.0 && outerHit.y < 0.0) {
                return vec2(-1.0, -1.0);
            }

            float tNear = max(outerHit.x, 0.0);
            float tFar = outerHit.y;

            if (innerHit.x > 0.0) {
                tFar = min(tFar, innerHit.x);
            }

            return vec2(tNear, tFar);
        }

        // Sample cloud density from texture
        vec2 sampleCloudDensity(vec3 worldPos) {
            vec3 toCenter = worldPos - planetCenter;
            float distFromCenter = length(toCenter);
            vec3 dir = toCenter / max(distFromCenter, 0.001);

            float atmosphereHeight = cumulusOuterRadius - planetRadius;
            float altitudeNorm = (distFromCenter - planetRadius) / max(atmosphereHeight, 1.0);

            // Map to UV
            vec3 uvw = vec3(
                dir.x * 0.5 + 0.5,
                clamp(altitudeNorm, 0.0, 1.0),
                dir.z * 0.5 + 0.5
            );

            // Sample from 2D texture (flattened 3D)
            vec3 idx = uvw * (gridDimensions - vec3(1.0));
            float zi = floor(idx.z + 0.5);
            float yi = floor(idx.y + 0.5);
            float xi = floor(idx.x + 0.5);

            float u = (xi + 0.5) / gridDimensions.x;
            float v = (yi + zi * gridDimensions.y + 0.5) / (gridDimensions.y * gridDimensions.z);
            vec4 sample = texture(froxelTexture, vec2(u, v));

            return vec2(sample.r, sample.g);
        }

        float henyeyGreenstein(float cosTheta, float g) {
            float g2 = g * g;
            float denom = pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5);
            return (1.0 - g2) / (4.0 * PI * max(denom, 0.001));
        }

        float cloudPhase(float cosTheta, float g) {
            float forward = henyeyGreenstein(cosTheta, g);
            float back = henyeyGreenstein(cosTheta, -0.3);
            float iso = 0.25 / PI;
            return forward * 0.7 + back * 0.15 + iso * 0.15;
        }

        float beerPowder(float density, float stepSize) {
            float beer = exp(-density * stepSize);
            float powder = 1.0 - exp(-density * stepSize * 2.0);
            return mix(beer, beer * powder, 0.5);
        }

        // Light marching for shadows
        float computeShadow(vec3 pos, vec3 sunDir) {
            float transmittance = 1.0;
            float atmosphereHeight = cumulusOuterRadius - planetRadius;
            float stepSize = atmosphereHeight * 0.05;

            for (int i = 0; i < 4; i++) {
                vec3 samplePos = pos + sunDir * float(i + 1) * stepSize;
                vec2 density = sampleCloudDensity(samplePos);
                float totalDensity = density.x + density.y * 0.5;
                transmittance *= exp(-totalDensity * stepSize * 0.5);
                if (transmittance < 0.1) break;
            }

            return transmittance;
        }

        void main() {
            vec3 rayDir = getRayDirection(vUv);

            // Intersect with cloud shells
            vec2 cumulusHit = rayShellIntersect(cameraPosition, rayDir, planetCenter, cumulusInnerRadius, cumulusOuterRadius);
            vec2 cirrusHit = rayShellIntersect(cameraPosition, rayDir, planetCenter, cirrusInnerRadius, cirrusOuterRadius);

            float tNear = 1e10;
            float tFar = -1.0;

            if (cumulusHit.x >= 0.0) {
                tNear = min(tNear, cumulusHit.x);
                tFar = max(tFar, cumulusHit.y);
            }
            if (cirrusHit.x >= 0.0) {
                tNear = min(tNear, cirrusHit.x);
                tFar = max(tFar, cirrusHit.y);
            }

            if (tFar < 0.0 || tNear >= tFar) {
                fragColor = vec4(0.0, 0.0, 0.0, 0.0);
                return;
            }

            tNear = max(tNear, 0.0);
            float atmosphereHeight = cumulusOuterRadius - planetRadius;
            tFar = min(tFar, atmosphereHeight * 4.0);

            int steps = numSteps;
            float stepSize = (tFar - tNear) / float(steps);

            vec3 sunDir = normalize(sunDirection);
            float cosSun = dot(rayDir, sunDir);
            float phase = cloudPhase(cosSun, cloudAnisotropy);

            vec3 accumulatedColor = vec3(0.0);
            float transmittance = 1.0;
            float t = tNear;

            for (int i = 0; i < 128; i++) {
                if (i >= steps) break;
                if (transmittance < TRANSMITTANCE_THRESHOLD) break;

                vec3 pos = cameraPosition + rayDir * t;
                vec2 density = sampleCloudDensity(pos);

                float cumulusDensity = density.x * cloudLowCoverage;
                float cirrusDensity = density.y * cloudHighCoverage * 0.3;
                float totalDensity = cumulusDensity + cirrusDensity;

                if (totalDensity > 0.001) {
                    float shadow = computeShadow(pos, sunDir);

                    float distFromCenter = length(pos - planetCenter);
                    float altitudeNorm = (distFromCenter - planetRadius) / max(atmosphereHeight, 1.0);
                    float ambient = 0.3 + 0.4 * altitudeNorm;

                    float sunLight = shadow * phase;
                    float lighting = sunLight + ambient;

                    vec3 cloudColor = cloudBaseColor * lighting;

                    float extinction = beerPowder(totalDensity, stepSize);
                    float scatterAmount = (1.0 - extinction) * transmittance;

                    accumulatedColor += cloudColor * scatterAmount;
                    transmittance *= extinction;
                }

                t += stepSize;
            }

            float alpha = clamp(1.0 - transmittance, 0.0, 1.0);
            fragColor = vec4(accumulatedColor, alpha);
        }`;
    }
}
