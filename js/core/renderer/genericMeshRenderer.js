// js/renderer/genericMeshRenderer.js
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';
import { BaseModel } from '../mesh/model/baseModel.js';

/**
 * Renders generic meshes (vehicles, objects, etc.) using the WebGPU backend.
 * Manages a collection of BaseModel instances and handles their rendering.
 */
export class GenericMeshRenderer {
    constructor(backend) {
        this.backend = backend;
        this.models = new Map(); // name -> BaseModel
        this.renderQueue = [];
        
        this._frameTime = 0;
        this._lastCameraPosition = new THREE.Vector3();
        
        // Sorting and culling
        this.enableFrustumCulling = true;
        this.enableDistanceSorting = true;
        
        
    }
    
    /**
     * Add a model to the renderer
     * @param {string} name - Unique identifier for the model
     * @param {BaseModel} model - The model to add
     */
    async addModel(name, model) {
        if (!(model instanceof BaseModel)) {
            
            return false;
        }
        
        // Initialize model if needed
        if (!model._initialized) {
            await model.initialize(this.backend);
        }
        
        this.models.set(name, model);
        
        return true;
    }
    
    /**
     * Legacy method for compatibility - wraps THREE.js mesh in a simple wrapper
     * @deprecated Use addModel with BaseModel instead
     */
    addMesh(name, threeMesh) {
        
        // Create a wrapper that extracts transform from THREE.js mesh
        const wrapper = {
            threeMesh: threeMesh,
            _initialized: true,
            visible: true,
            modelMatrix: new THREE.Matrix4(),
            geometry: null,
            material: null,
            
            updateModelMatrix() {
                if (this.threeMesh) {
                    this.threeMesh.updateMatrixWorld(true);
                    this.modelMatrix.copy(this.threeMesh.matrixWorld);
                }
            },
            
            selectLOD() { return this.geometry; },
            getDistanceToCamera() { return 0; },
            dispose() {}
        };
        
        this.models.set(name, wrapper);
        return true;
    }
    
    /**
     * Remove a model from the renderer
     * @param {string} name - Name of the model to remove
     */
    removeModel(name) {
        const model = this.models.get(name);
        if (model) {
            model.dispose();
            this.models.delete(name);
            
        }
    }
    
    /**
     * Update a specific model (call after model.update())
     * @param {string} name - Name of the model to update
     */
    updateModel(name) {
        const model = this.models.get(name);
        if (model) {
            model.updateModelMatrix();
        }
    }
    
    /**
     * Legacy alias for updateModel
     * @deprecated
     */
    updateMesh(name) {
        this.updateModel(name);
    }
    
    /**
     * Get a model by name
     * @param {string} name 
     * @returns {BaseModel|null}
     */
    getModel(name) {
        return this.models.get(name) || null;
    }
    
    /**
     * Update all models and prepare for rendering
     * @param {THREE.Vector3} cameraPosition - Current camera position
     * @param {number} deltaTime - Time since last frame
     */
    update(cameraPosition, deltaTime = 0) {
        this._frameTime += deltaTime;
        this._lastCameraPosition.copy(cameraPosition);
        
        this.renderQueue.length = 0;
        
        for (const [name, model] of this.models) {
            if (!model.visible) continue;
            
            // Update model matrix
            model.updateModelMatrix();
            
            // Select LOD based on distance
            const distance = model.getDistanceToCamera ? 
                model.getDistanceToCamera(cameraPosition) : 0;
            
            if (model.selectLOD) {
                model.selectLOD(distance);
            }
            
            // Skip if no geometry or material
            if (!model.geometry || !model.material) continue;
            
            // Add to render queue
            this.renderQueue.push({
                name,
                model,
                distance,
                transparent: model.material.transparent || false
            });
        }
        
        // Sort: opaque front-to-back, transparent back-to-front
        if (this.enableDistanceSorting) {
            this.renderQueue.sort((a, b) => {
                if (a.transparent !== b.transparent) {
                    return a.transparent ? 1 : -1;
                }
                return a.transparent ? b.distance - a.distance : a.distance - b.distance;
            });
        }
    }
    
    /**
     * Render all visible models
     * @param {THREE.Matrix4} viewMatrix 
     * @param {THREE.Matrix4} projectionMatrix 
     */
    render(viewMatrix, projectionMatrix) {
        if (this.renderQueue.length === 0 && this.models.size === 0) return;
        
        // If update wasn't called this frame, do a quick update
        if (this.renderQueue.length === 0) {
            this.update(this._lastCameraPosition, 0);
        }
        
        for (const item of this.renderQueue) {
            const { model } = item;
            
            // Skip legacy THREE.js mesh wrappers (they render differently)
            if (model.threeMesh) continue;
            
            // Update material uniforms
            this._updateMaterialUniforms(model, viewMatrix, projectionMatrix);
            
            // Draw
            try {
                this.backend.draw(model.geometry, model.material);
            } catch (error) {
                
            }
        }
    }
    
    /**
     * Update material uniforms before drawing
     */
    _updateMaterialUniforms(model, viewMatrix, projectionMatrix) {
        const uniforms = model.material.uniforms;
        
        // Transform matrices
        if (uniforms.modelMatrix) {
            uniforms.modelMatrix.value.copy(model.modelMatrix);
        }
        if (uniforms.viewMatrix) {
            uniforms.viewMatrix.value.copy(viewMatrix);
        }
        if (uniforms.projectionMatrix) {
            uniforms.projectionMatrix.value.copy(projectionMatrix);
        }
        
        // Camera position
        if (uniforms.cameraPosition) {
            uniforms.cameraPosition.value.copy(this._lastCameraPosition);
        }
        
        // Time for animations
        if (uniforms.time) {
            uniforms.time.value = this._frameTime;
        }
    }
    
    /**
     * Set global lighting for all models
     * @param {Object} lighting - Lighting parameters
     */
    setGlobalLighting(lighting) {
        for (const model of this.models.values()) {
            if (model.setLighting) {
                model.setLighting(
                    lighting.sunDirection,
                    lighting.sunColor,
                    lighting.sunIntensity,
                    lighting.ambientColor
                );
            }
        }
    }
    
    /**
     * Cleanup all resources
     */
    cleanup() {
        for (const model of this.models.values()) {
            model.dispose();
        }
        this.models.clear();
        this.renderQueue.length = 0;
        
    }
}