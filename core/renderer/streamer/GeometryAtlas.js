// js/renderer/streamer/GeometryAtlas.js
//
// Unified geometry buffer system for instanced asset rendering.
// Stores multiple geometry types and LOD levels in a single buffer set,
// enabling single-draw-call rendering per category.
//
// Buffer layout:
//   - Positions: all vertices concatenated
//   - Normals: all normals concatenated  
//   - UVs: all UVs concatenated
//   - Indices: all indices concatenated (with base vertex offset)
//
// Lookup table provides (vertexStart, vertexCount, indexStart, indexCount)
// for each (geometryType, lodLevel) pair.

import { Logger } from '../../../shared/Logger.js';

/**
 * @typedef {object} GeometryData
 * @property {Float32Array} positions - Vertex positions (x,y,z per vertex)
 * @property {Float32Array} normals - Vertex normals (x,y,z per vertex)
 * @property {Float32Array} uvs - Texture coordinates (u,v per vertex)
 * @property {Uint16Array|Uint32Array} indices - Triangle indices
 */

/**
 * @typedef {object} GeometryEntry
 * @property {string} geometryType - Type identifier (e.g., 'conifer', 'oak')
 * @property {number} lodLevel - LOD level (0 = highest detail)
 * @property {number} vertexStart - Start index in vertex buffers
 * @property {number} vertexCount - Number of vertices
 * @property {number} indexStart - Start index in index buffer
 * @property {number} indexCount - Number of indices
 */

export class GeometryAtlas {
    /**
     * @param {object} options
     * @param {string} options.name - Atlas identifier (e.g., 'TreeTrunks')
     * @param {number} [options.maxLODs=6] - Maximum LOD levels per type
     */
    constructor(options = {}) {
        this.name = options.name || 'GeometryAtlas';
        this.maxLODs = options.maxLODs ?? 6;
        
        /** @type {GeometryEntry[]} */
        this._entries = [];
        
        /** @type {Map<string, number>} - "type_lod" → entry index */
        this._entryIndex = new Map();
        
        /** @type {Map<string, number>} - geometryType → type index */
        this._typeIndex = new Map();
        
        /** @type {string[]} */
        this._typeList = [];
        
        // Accumulated geometry data
        this._positions = [];
        this._normals = [];
        this._uvs = [];
        this._indices = [];
        
        this._totalVertices = 0;
        this._totalIndices = 0;
        
        // GPU resources
        this._device = null;
        this._positionBuffer = null;
        this._normalBuffer = null;
        this._uvBuffer = null;
        this._indexBuffer = null;
        this._lookupBuffer = null;
        this._isUploaded = false;
        
        // Index format (determined by total vertex count)
        this._use32BitIndices = false;
    }

    /**
     * Add a geometry to the atlas.
     * 
     * @param {string} geometryType - Type identifier
     * @param {number} lodLevel - LOD level (0 = highest detail)
     * @param {GeometryData} geometry - Geometry data
     */
    addGeometry(geometryType, lodLevel, geometry) {
        const key = `${geometryType}_${lodLevel}`;
        
        if (this._entryIndex.has(key)) {
            Logger.warn(`[GeometryAtlas] Duplicate entry: ${key}`);
            return;
        }
        
        // Track geometry type
        if (!this._typeIndex.has(geometryType)) {
            this._typeIndex.set(geometryType, this._typeList.length);
            this._typeList.push(geometryType);
        }
        
        const vertexStart = this._totalVertices;
        const vertexCount = geometry.positions.length / 3;
        const indexStart = this._totalIndices;
        const indexCount = geometry.indices.length;
        
        // Store geometry data
        this._positions.push(...geometry.positions);
        this._normals.push(...geometry.normals);
        this._uvs.push(...geometry.uvs);
        
        // Offset indices by current vertex base
        for (let i = 0; i < geometry.indices.length; i++) {
            this._indices.push(geometry.indices[i] + vertexStart);
        }
        
        this._totalVertices += vertexCount;
        this._totalIndices += indexCount;
        
        // Create entry
        const entry = {
            geometryType,
            lodLevel,
            vertexStart,
            vertexCount,
            indexStart,
            indexCount
        };
        
        this._entryIndex.set(key, this._entries.length);
        this._entries.push(entry);
        
        // Check if we need 32-bit indices
        if (this._totalVertices > 65535) {
            this._use32BitIndices = true;
        }
    }

    /**
     * Add all LODs for a geometry type at once.
     * 
     * @param {string} geometryType
     * @param {GeometryData[]} lodGeometries - Array indexed by LOD level
     */
    addGeometryWithLODs(geometryType, lodGeometries) {
        for (let lod = 0; lod < lodGeometries.length; lod++) {
            if (lodGeometries[lod]) {
                this.addGeometry(geometryType, lod, lodGeometries[lod]);
            }
        }
    }

    /**
     * Get entry for a specific geometry type and LOD.
     * 
     * @param {string} geometryType
     * @param {number} lodLevel
     * @returns {GeometryEntry|null}
     */
    getEntry(geometryType, lodLevel) {
        const key = `${geometryType}_${lodLevel}`;
        const index = this._entryIndex.get(key);
        return index !== undefined ? this._entries[index] : null;
    }

    /**
     * Get entry index for shader lookup.
     * 
     * @param {string} geometryType
     * @param {number} lodLevel
     * @returns {number} -1 if not found
     */
    getEntryIndex(geometryType, lodLevel) {
        const key = `${geometryType}_${lodLevel}`;
        return this._entryIndex.get(key) ?? -1;
    }

    /**
     * Get type index for a geometry type.
     * 
     * @param {string} geometryType
     * @returns {number} -1 if not found
     */
    getTypeIndex(geometryType) {
        return this._typeIndex.get(geometryType) ?? -1;
    }

    /**
     * Get all geometry types in the atlas.
     * @returns {string[]}
     */
    getGeometryTypes() {
        return [...this._typeList];
    }

    /**
     * Get available LOD levels for a geometry type.
     * 
     * @param {string} geometryType
     * @returns {number[]}
     */
    getAvailableLODs(geometryType) {
        const lods = [];
        for (let lod = 0; lod < this.maxLODs; lod++) {
            if (this.getEntry(geometryType, lod)) {
                lods.push(lod);
            }
        }
        return lods;
    }

    get entryCount() { return this._entries.length; }
    get totalVertices() { return this._totalVertices; }
    get totalIndices() { return this._totalIndices; }
    get typeCount() { return this._typeList.length; }

    /**
     * Upload atlas to GPU.
     * 
     * @param {GPUDevice} device
     */
    uploadToGPU(device) {
        if (this._isUploaded && this._device === device) return;
        
        this._device = device;
        this._disposeGPUResources();
        
        if (this._entries.length === 0) {
            Logger.warn(`[GeometryAtlas:${this.name}] No geometries to upload`);
            return;
        }
        
        // Create typed arrays from accumulated data
        const positions = new Float32Array(this._positions);
        const normals = new Float32Array(this._normals);
        const uvs = new Float32Array(this._uvs);
        const indices = this._use32BitIndices 
            ? new Uint32Array(this._indices)
            : new Uint16Array(this._indices);
        
        // Position buffer
        this._positionBuffer = device.createBuffer({
            label: `${this.name}-Positions`,
            size: Math.max(256, positions.byteLength),
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
        });
        device.queue.writeBuffer(this._positionBuffer, 0, positions);
        
        // Normal buffer
        this._normalBuffer = device.createBuffer({
            label: `${this.name}-Normals`,
            size: Math.max(256, normals.byteLength),
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
        });
        device.queue.writeBuffer(this._normalBuffer, 0, normals);
        
        // UV buffer
        this._uvBuffer = device.createBuffer({
            label: `${this.name}-UVs`,
            size: Math.max(256, uvs.byteLength),
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
        });
        device.queue.writeBuffer(this._uvBuffer, 0, uvs);
        
        // Index buffer
        this._indexBuffer = device.createBuffer({
            label: `${this.name}-Indices`,
            size: Math.max(256, indices.byteLength),
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
        });
        device.queue.writeBuffer(this._indexBuffer, 0, indices);
        
        // Lookup buffer: 4 u32 per entry (vertexStart, vertexCount, indexStart, indexCount)
        const lookupData = new Uint32Array(this._entries.length * 4);
        for (let i = 0; i < this._entries.length; i++) {
            const entry = this._entries[i];
            lookupData[i * 4 + 0] = entry.vertexStart;
            lookupData[i * 4 + 1] = entry.vertexCount;
            lookupData[i * 4 + 2] = entry.indexStart;
            lookupData[i * 4 + 3] = entry.indexCount;
        }
        
        this._lookupBuffer = device.createBuffer({
            label: `${this.name}-Lookup`,
            size: Math.max(256, lookupData.byteLength),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        device.queue.writeBuffer(this._lookupBuffer, 0, lookupData);
        
        this._isUploaded = true;
        
        const totalBytes = positions.byteLength + normals.byteLength + 
                          uvs.byteLength + indices.byteLength + lookupData.byteLength;
        
        Logger.info(
            `[GeometryAtlas:${this.name}] Uploaded: ` +
            `${this._entries.length} entries, ` +
            `${this._totalVertices} vertices, ` +
            `${this._totalIndices} indices, ` +
            `${(totalBytes / 1024).toFixed(1)}KB total`
        );
    }

    /**
     * Get GPU buffers for rendering.
     * 
     * @returns {{
     *   positionBuffer: GPUBuffer,
     *   normalBuffer: GPUBuffer,
     *   uvBuffer: GPUBuffer,
     *   indexBuffer: GPUBuffer,
     *   lookupBuffer: GPUBuffer,
     *   indexFormat: 'uint16'|'uint32'
     * }|null}
     */
    getGPUBuffers() {
        if (!this._isUploaded) return null;
        
        return {
            positionBuffer: this._positionBuffer,
            normalBuffer: this._normalBuffer,
            uvBuffer: this._uvBuffer,
            indexBuffer: this._indexBuffer,
            lookupBuffer: this._lookupBuffer,
            indexFormat: this._use32BitIndices ? 'uint32' : 'uint16'
        };
    }

    /**
     * Build a type-LOD to entry index lookup table.
     * Layout: [maxTypes × maxLODs] entries, each is entry index or 0xFFFFFFFF
     * 
     * @returns {Uint32Array}
     */
    buildTypeLODLookup() {
        const size = this._typeList.length * this.maxLODs;
        const data = new Uint32Array(size);
        data.fill(0xFFFFFFFF); // Invalid marker
        
        for (let i = 0; i < this._entries.length; i++) {
            const entry = this._entries[i];
            const typeIdx = this._typeIndex.get(entry.geometryType);
            if (typeIdx !== undefined) {
                const offset = typeIdx * this.maxLODs + entry.lodLevel;
                data[offset] = i;
            }
        }
        
        return data;
    }

    /**
     * Check if atlas is ready for rendering.
     * @returns {boolean}
     */
    isReady() {
        return this._isUploaded && this._positionBuffer !== null;
    }

    _disposeGPUResources() {
        this._positionBuffer?.destroy();
        this._normalBuffer?.destroy();
        this._uvBuffer?.destroy();
        this._indexBuffer?.destroy();
        this._lookupBuffer?.destroy();
        
        this._positionBuffer = null;
        this._normalBuffer = null;
        this._uvBuffer = null;
        this._indexBuffer = null;
        this._lookupBuffer = null;
        
        this._isUploaded = false;
    }

    dispose() {
        this._disposeGPUResources();
        this._entries = [];
        this._entryIndex.clear();
        this._typeIndex.clear();
        this._typeList = [];
        this._positions = [];
        this._normals = [];
        this._uvs = [];
        this._indices = [];
        this._totalVertices = 0;
        this._totalIndices = 0;
    }
}