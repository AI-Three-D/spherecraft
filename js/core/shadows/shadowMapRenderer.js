import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';

export class ShadowMapRenderer {
    constructor(renderer, options = {}) {
        this.renderer = renderer;
        
        this.shadowMapSize = options.shadowMapSize || 2048;
        this.shadowBias = options.shadowBias || 0.0005;
        this.shadowNormalBias = options.shadowNormalBias || 0.05;
        this.shadowRadius = options.shadowRadius || 1.0;
        
        this.shadowCameraSize = options.shadowCameraSize || 80;
        this.shadowCamera = new THREE.OrthographicCamera(
            -this.shadowCameraSize,
            this.shadowCameraSize,
            this.shadowCameraSize,
            -this.shadowCameraSize,
            0.5,
            500
        );
        
        this.shadowMapTarget = new THREE.WebGLRenderTarget(
            this.shadowMapSize,
            this.shadowMapSize,
            {
                minFilter: THREE.NearestFilter,
                magFilter: THREE.NearestFilter,
                format: THREE.RGBAFormat,
                type: THREE.FloatType
            }
        );
        
        this.depthMaterial = new THREE.ShaderMaterial({
            vertexShader: this.buildDepthVertexShader(),
            fragmentShader: this.buildDepthFragmentShader(),
            side: THREE.DoubleSide
        });
        
        this.shadowMatrix = new THREE.Matrix4();
        this.tempMatrix = new THREE.Matrix4();
        this.originalMaterials = new WeakMap();
        
        this.frameCount = 0;
        this.objectsRendered = 0;
        
    }
    renderDirectionalShadowMap(scene, lightDirection, focusPoint) {
        this.frameCount++;
        
        const lightDistance = 150;
        
        const cameraPos = lightDirection.clone()
            .multiplyScalar(-lightDistance)
            .add(focusPoint);
        
        const worldUnitsPerTexel = (this.shadowCameraSize * 2) / this.shadowMapSize;
        cameraPos.x = Math.floor(cameraPos.x / worldUnitsPerTexel) * worldUnitsPerTexel;
        cameraPos.y = Math.floor(cameraPos.y / worldUnitsPerTexel) * worldUnitsPerTexel;
        cameraPos.z = Math.floor(cameraPos.z / worldUnitsPerTexel) * worldUnitsPerTexel;
        
        this.shadowCamera.position.copy(cameraPos);
        
        const snappedFocus = focusPoint.clone();
        snappedFocus.x = Math.floor(snappedFocus.x / worldUnitsPerTexel) * worldUnitsPerTexel;
        snappedFocus.y = 0; // Keep at ground level
        snappedFocus.z = Math.floor(snappedFocus.z / worldUnitsPerTexel) * worldUnitsPerTexel;
        
        this.shadowCamera.lookAt(snappedFocus);
        this.shadowCamera.updateMatrixWorld(true);
        
        const viewMatrix = this.shadowCamera.matrixWorldInverse;
        for (let i = 0; i < 16; i++) {
            viewMatrix.elements[i] = Math.round(viewMatrix.elements[i] * 1000) / 1000;
        }
        
        const shadowProjectionMatrix = this.shadowCamera.projectionMatrix;
        const shadowViewMatrix = this.shadowCamera.matrixWorldInverse;
        
        this.shadowMatrix.set(
            0.5, 0.0, 0.0, 0.5,
            0.0, 0.5, 0.0, 0.5,
            0.0, 0.0, 0.5, 0.5,
            0.0, 0.0, 0.0, 1.0
        );
        this.shadowMatrix.multiply(shadowProjectionMatrix);
        this.shadowMatrix.multiply(shadowViewMatrix);
        
        this.objectsRendered = 0;
        scene.traverse((node) => {
            if ((node.isMesh || node.isInstancedMesh) && node.visible) {
                this.objectsRendered++;
            }
        });
        
        this.overrideMaterials(scene, this.depthMaterial);
        
        const oldRenderTarget = this.renderer.getRenderTarget();
        this.renderer.setRenderTarget(this.shadowMapTarget);
        this.renderer.setClearColor(0xffffff, 1);
        this.renderer.clear();
        this.renderer.render(scene, this.shadowCamera);
        this.renderer.setRenderTarget(oldRenderTarget);
        
        this.restoreMaterials(scene);
        
        return {
            shadowMap: this.shadowMapTarget.texture,
            shadowMatrix: this.shadowMatrix,
            shadowCamera: this.shadowCamera,
            objectsRendered: this.objectsRendered
        };
    }
    overrideMaterials(object, depthMaterial) {
        object.traverse((node) => {
            if (node.isMesh || node.isInstancedMesh) {
                this.originalMaterials.set(node, node.material);
                
                if (node.isInstancedMesh) {
                    node.material = this.createInstancedDepthMaterial();
                } else {
                    node.material = depthMaterial;
                }
            }
        });
    }
    
    restoreMaterials(object) {
        object.traverse((node) => {
            if (node.isMesh || node.isInstancedMesh) {
                const original = this.originalMaterials.get(node);
                if (original) {
                    node.material = original;
                }
            }
        });
    }
    
    createInstancedDepthMaterial() {
        return new THREE.ShaderMaterial({
            vertexShader: this.buildDepthVertexShader(true),
            fragmentShader: this.buildDepthFragmentShader(),
            side: THREE.DoubleSide
        });
    }
    
    buildDepthVertexShader(instanced = false) {
        return `
            ${instanced ? '#define USE_INSTANCING' : ''}
            
            varying float vDepth;
            
            void main() {
                vec4 worldPosition;
                
                #ifdef USE_INSTANCING
                    worldPosition = modelMatrix * instanceMatrix * vec4(position, 1.0);
                #else
                    worldPosition = modelMatrix * vec4(position, 1.0);
                #endif
                
                vec4 viewPosition = viewMatrix * worldPosition;
                vec4 projectedPosition = projectionMatrix * viewPosition;
                
                gl_Position = projectedPosition;
                
                // Store normalized depth [0, 1]
                vDepth = (projectedPosition.z / projectedPosition.w) * 0.5 + 0.5;
            }
        `;
    }
    
    buildDepthFragmentShader() {
        return `
            varying float vDepth;
            
            void main() {
                // Simple depth write
                gl_FragColor = vec4(vDepth, vDepth, vDepth, 1.0);
            }
        `;
    }
    
    setShadowMapSize(size) {
        this.shadowMapSize = size;
        this.shadowMapTarget.setSize(size, size);
        
    }
    
    setShadowCameraSize(size) {
        this.shadowCameraSize = size;
        this.shadowCamera.left = -size;
        this.shadowCamera.right = size;
        this.shadowCamera.top = size;
        this.shadowCamera.bottom = -size;
        this.shadowCamera.updateProjectionMatrix();
        
    }
    
    cleanup() {
        this.shadowMapTarget.dispose();
        this.depthMaterial.dispose();
    }
}
