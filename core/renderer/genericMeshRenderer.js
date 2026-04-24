// js/renderer/genericMeshRenderer.js
import { Vector3, Matrix4 } from '../../shared/math/index.js';
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
        this._lastCameraPosition = new Vector3();
        
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
            console.warn('[GenericMeshRenderer] addModel: not a BaseModel:', name);
            return false;
        }

        if (!model._initialized) {
            try {
                await model.initialize(this.backend);
            } catch (e) {
                console.warn(`[GenericMeshRenderer] ${name} initialize failed:`, e);
                return false;
            }
        }

        this.models.set(name, model);
        // Only log a sparse sample so streaming clouds don't flood the
        // console — first model of any kind, plus every 10th after that.
        const n = this.models.size;
        if (n <= 2 || n % 10 === 0) {
            console.log(`[GenericMeshRenderer] addModel "${name}" — geom=${!!model.geometry} mat=${!!model.material} pos=(${model.position.x.toFixed(1)}, ${model.position.y.toFixed(1)}, ${model.position.z.toFixed(1)}) total=${n}`);
        }
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
     * Get a model by name
     * @param {string} name 
     * @returns {BaseModel|null}
     */
    getModel(name) {
        return this.models.get(name) || null;
    }
    
    /**
     * Update all models and prepare for rendering
     * @param {Vector3} cameraPosition - Current camera position
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
     * @param {Matrix4} viewMatrix 
     * @param {Matrix4} projectionMatrix 
     */
    render(viewMatrix, projectionMatrix) {
        if (this.renderQueue.length === 0 && this.models.size === 0) return;

        // If update wasn't called this frame, do a quick update
        if (this.renderQueue.length === 0) {
            this.update(this._lastCameraPosition, 0);
        }

        // One-shot diagnostic: tell the user exactly what this renderer
        // believes it is about to draw. Fires once per session so the
        // logs aren't spammy. window.__GMR_DIAG is the toggle.
        if (!this._diagLogged) {
            this._diagLogged = true;
            const summary = this.renderQueue.map(q => ({
                name: q.name,
                pos: { x: q.model.position.x, y: q.model.position.y, z: q.model.position.z },
                dist: q.distance,
                visible: q.model.visible,
                hasGeom: !!q.model.geometry,
                hasMat: !!q.model.material,
            }));
            console.log('[GenericMeshRenderer] first render queue:',
                JSON.stringify(summary, null, 2),
                'camera:', this._lastCameraPosition);
        }
        
        for (const item of this.renderQueue) {
            const { model } = item;

            // Update material uniforms
            this._updateMaterialUniforms(model, viewMatrix, projectionMatrix);
            
            // Draw. Log first failure so invisible meshes don't stay silent.
            try {
                this.backend.draw(model.geometry, model.material);
            } catch (error) {
                if (!model._drawWarned) {
                    model._drawWarned = true;
                    console.warn(`[GenericMeshRenderer] draw failed for "${item.name}":`, error);
                }
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

        // The generic-mesh shader (core/renderer/shaders/genericMeshShaders.js)
        // declares two packed uniform blocks. `_createBindGroupsFromSpec`
        // resolves them by name, so we publish a Float32Array under
        // `vertexUniforms` / `fragmentUniforms` each frame, matching the
        // WGSL struct layout (std140-ish: vec3s take 16 bytes).
        this._packGenericMeshUniforms(model.material);
    }

    _packGenericMeshUniforms(material) {
        const u = material.uniforms;
        // Only pack if this looks like a generic-mesh material (has the
        // expected modelMatrix uniform). Leaves other materials alone.
        if (!u.modelMatrix) return;

        // Vertex block: 52 f32 (modelMatrix, viewMatrix, projectionMatrix,
        // cameraPosition + 1 pad).
        if (!u.vertexUniforms) {
            u.vertexUniforms = { value: new Float32Array(52) };
        }
        const v = u.vertexUniforms.value;
        v.set(u.modelMatrix.value.elements, 0);
        v.set(u.viewMatrix.value.elements, 16);
        v.set(u.projectionMatrix.value.elements, 32);
        const cp = u.cameraPosition?.value;
        v[48] = cp?.x ?? 0;
        v[49] = cp?.y ?? 0;
        v[50] = cp?.z ?? 0;
        v[51] = 0;

        // Fragment block: 24 f32 with vec3 alignment padding.
        if (!u.fragmentUniforms) {
            u.fragmentUniforms = { value: new Float32Array(24) };
        }
        const f = u.fragmentUniforms.value;
        const base = u.baseColor?.value;
        f[0] = base?.x ?? 1; f[1] = base?.y ?? 1; f[2] = base?.z ?? 1;
        f[3] = u.metalness?.value ?? 0;

        f[4] = u.roughness?.value ?? 0.5;
        f[5] = u.emissiveIntensity?.value ?? 0;
        f[6] = u.time?.value ?? 0;
        f[7] = 0;

        const em = u.emissiveColor?.value;
        f[8] = em?.x ?? 0; f[9] = em?.y ?? 0; f[10] = em?.z ?? 0;
        f[11] = 0;

        const sd = u.sunDirection?.value;
        f[12] = sd?.x ?? 0; f[13] = sd?.y ?? 1; f[14] = sd?.z ?? 0;
        f[15] = u.sunIntensity?.value ?? 1;

        const sc = u.sunColor?.value;
        f[16] = sc?.x ?? 1; f[17] = sc?.y ?? 1; f[18] = sc?.z ?? 1;
        f[19] = 0;

        const ac = u.ambientColor?.value;
        f[20] = ac?.x ?? 0.1; f[21] = ac?.y ?? 0.1; f[22] = ac?.z ?? 0.1;
        f[23] = 0;
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