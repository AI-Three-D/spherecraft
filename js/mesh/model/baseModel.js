// js/modules/mesh/model/baseModel.js
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js';
import { Geometry } from '../../renderer/resources/geometry.js';
import { Material } from '../../renderer/resources/material.js';

/**
 * Base class for all renderable 3D models.
 * Provides transform management, LOD support, and rendering interface.
 */
export class BaseModel {
    constructor(options = {}) {
        this.id = BaseModel._nextId++;
        this.name = options.name || `Model_${this.id}`;
        
        // Transform (using THREE.js math utilities only)
        this.position = new THREE.Vector3(0, 0, 0);
        this.quaternion = new THREE.Quaternion();
        this.scale = new THREE.Vector3(1, 1, 1);
        this.modelMatrix = new THREE.Matrix4();
        
        // Euler for convenience (synced with quaternion)
        this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
        
        // LOD support
        this.lodGeometries = new Map(); // lodLevel -> Geometry
        this.lodDistances = options.lodDistances || [0, 50, 150, 400];
        this.currentLOD = 0;
        this.maxLOD = options.maxLOD || 3;
        
        // Rendering state
        this.geometry = null;
        this.material = null;
        this.visible = true;
        this.castShadow = options.castShadow !== false;
        this.receiveShadow = options.receiveShadow !== false;
        
        // Culling
        this.boundingSphere = null;
        this.boundingBox = null;
        
        this._needsMatrixUpdate = true;
        this._initialized = false;
    }
    
    static _nextId = 0;
    
    /**
     * Initialize the model - creates default geometry and material
     * @param {WebGPUBackend} backend - The rendering backend
     */
    async initialize(backend) {
        if (this._initialized) return;
        
        this.geometry = this.createGeometry(0);
        this.lodGeometries.set(0, this.geometry);
        
        this.material = await this.createMaterial(backend);
        
        this.computeBoundingSphere();
        this._initialized = true;
    }
    
    /**
     * Override in subclasses to create geometry
     * @param {number} lodLevel - LOD level (0 = highest detail)
     * @returns {Geometry}
     */
    createGeometry(lodLevel = 0) {
        throw new Error('createGeometry must be implemented by subclass');
    }
    
    /**
     * Override in subclasses to create material
     * @param {WebGPUBackend} backend - The rendering backend
     * @returns {Material}
     */
    async createMaterial(backend) {
        throw new Error('createMaterial must be implemented by subclass');
    }
    
    /**
     * Set position in game coordinates
     * Game: X=east, Y=north, Z=altitude
     * Render: X=east, Y=altitude, Z=north
     */
    setPosition(gameX, gameY, gameZ) {
        this.position.set(gameX, gameZ, gameY);
        this._needsMatrixUpdate = true;
    }
    
    /**
     * Set position directly in render coordinates
     */
    setPositionDirect(x, y, z) {
        this.position.set(x, y, z);
        this._needsMatrixUpdate = true;
    }
    
    /**
     * Set rotation from Euler angles (radians)
     * @param {number} yaw - Rotation around Y axis
     * @param {number} pitch - Rotation around X axis
     * @param {number} roll - Rotation around Z axis
     */
    setRotation(yaw, pitch, roll) {
        this._euler.set(pitch, yaw, roll, 'YXZ');
        this.quaternion.setFromEuler(this._euler);
        this._needsMatrixUpdate = true;
    }
    
    /**
     * Set rotation from quaternion
     */
    setQuaternion(x, y, z, w) {
        this.quaternion.set(x, y, z, w);
        this._euler.setFromQuaternion(this.quaternion);
        this._needsMatrixUpdate = true;
    }
    
    /**
     * Set uniform scale
     */
    setScale(s) {
        this.scale.set(s, s, s);
        this._needsMatrixUpdate = true;
    }
    
    /**
     * Set non-uniform scale
     */
    setScaleXYZ(x, y, z) {
        this.scale.set(x, y, z);
        this._needsMatrixUpdate = true;
    }
    
    /**
     * Update model matrix from position, quaternion, scale
     */
    updateModelMatrix() {
        if (!this._needsMatrixUpdate) return this.modelMatrix;
        
        this.modelMatrix.compose(this.position, this.quaternion, this.scale);
        this._needsMatrixUpdate = false;
        
        return this.modelMatrix;
    }
    
    /**
     * Get appropriate LOD geometry based on camera distance
     * @param {number} cameraDistance - Distance from camera to model
     * @returns {Geometry}
     */
    selectLOD(cameraDistance) {
        let selectedLOD = 0;
        
        for (let i = this.lodDistances.length - 1; i >= 0; i--) {
            if (cameraDistance >= this.lodDistances[i]) {
                selectedLOD = Math.min(i, this.maxLOD);
                break;
            }
        }
        
        if (selectedLOD !== this.currentLOD || !this.geometry) {
            this.currentLOD = selectedLOD;
            
            if (!this.lodGeometries.has(selectedLOD)) {
                const newGeometry = this.createGeometry(selectedLOD);
                this.lodGeometries.set(selectedLOD, newGeometry);
            }
            
            this.geometry = this.lodGeometries.get(selectedLOD);
        }
        
        return this.geometry;
    }
    
    /**
     * Compute bounding sphere for culling
     */
    computeBoundingSphere() {
        if (this.geometry) {
            this.geometry.computeBoundingSphere();
            this.boundingSphere = this.geometry.boundingSphere;
        }
    }
    
    /**
     * Check if model is visible from camera (frustum culling)
     * @param {Object} frustum - Camera frustum planes
     * @returns {boolean}
     */
    isInFrustum(frustum) {
        if (!this.boundingSphere) return true;
        
        // Transform bounding sphere center by model matrix
        const center = new THREE.Vector3(
            this.boundingSphere.center.x,
            this.boundingSphere.center.y,
            this.boundingSphere.center.z
        );
        center.applyMatrix4(this.modelMatrix);
        
        const radius = this.boundingSphere.radius * Math.max(
            this.scale.x, this.scale.y, this.scale.z
        );
        
        // Check against frustum planes
        for (const plane of frustum) {
            const distance = plane.normal.dot(center) + plane.constant;
            if (distance < -radius) return false;
        }
        
        return true;
    }
    
    /**
     * Override in subclasses to update from game state
     * @param {Object} state - Game state object
     */
    update(state) {
        // Base implementation - override in subclasses
    }
    
    /**
     * Get distance from camera
     * @param {THREE.Vector3} cameraPosition 
     * @returns {number}
     */
    getDistanceToCamera(cameraPosition) {
        return this.position.distanceTo(cameraPosition);
    }
    
    /**
     * Dispose of all resources
     */
    dispose() {
        for (const geo of this.lodGeometries.values()) {
            if (geo && geo.dispose) geo.dispose();
        }
        this.lodGeometries.clear();
        
        if (this.material && this.material.dispose) {
            this.material.dispose();
        }
        
        this.geometry = null;
        this.material = null;
        this._initialized = false;
    }
}