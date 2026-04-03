
// js/renderer/geometry.js
export class Geometry {
    constructor() {
        this.id = Geometry._nextId++;
        this.attributes = new Map();
        this.index = null;
        this.drawRange = { start: 0, count: Infinity };
        this.instanceCount = 1;
        this.boundingSphere = null;
        this.userData = {};
        
        this._gpuBuffers = null;
        this._needsUpload = true;
    }
    
    static _nextId = 0;
    
    setAttribute(name, data, itemSize, normalized = false, options = {}) {
        const attr = {
            data: data,
            itemSize: itemSize,
            normalized: normalized,
            count: data ? data.length / itemSize : (options.count || 0),
            stepMode: options.stepMode || 'vertex',
            slot: options.slot
        };
        if (options.gpuBuffer) {
            attr.gpuBuffer = options.gpuBuffer;
            attr.gpuBufferOffset = options.gpuBufferOffset || 0;
        }
        this.attributes.set(name, attr);
        this._needsUpload = true;
        return this;
    }
    
    getAttribute(name) {
        return this.attributes.get(name);
    }
    
    setIndex(data) {
        this.index = {
            data: data,
            count: data.length
        };
        this._needsUpload = true;
        return this;
    }
    
    getIndex() {
        return this.index;
    }
    
    setDrawRange(start, count) {
        this.drawRange.start = start;
        this.drawRange.count = count;
    }
    
    computeBoundingSphere() {
        const position = this.attributes.get('position');
        if (!position) return;
        
        const data = position.data;
        const itemSize = position.itemSize;
        
        let centerX = 0, centerY = 0, centerZ = 0;
        const count = position.count;
        
        for (let i = 0; i < count; i++) {
            centerX += data[i * itemSize];
            centerY += data[i * itemSize + 1];
            centerZ += data[i * itemSize + 2];
        }
        
        centerX /= count;
        centerY /= count;
        centerZ /= count;
        
        let maxRadiusSq = 0;
        for (let i = 0; i < count; i++) {
            const dx = data[i * itemSize] - centerX;
            const dy = data[i * itemSize + 1] - centerY;
            const dz = data[i * itemSize + 2] - centerZ;
            maxRadiusSq = Math.max(maxRadiusSq, dx * dx + dy * dy + dz * dz);
        }
        
        this.boundingSphere = {
            center: { x: centerX, y: centerY, z: centerZ },
            radius: Math.sqrt(maxRadiusSq)
        };
    }
    
    dispose() {
        this.attributes.clear();
        this.index = null;
        if (this._gpuBuffers) {
            for (const buffer of this._gpuBuffers.values()) {
                if (buffer?.gpuBuffer?.destroy) buffer.gpuBuffer.destroy();
            }
            this._gpuBuffers.clear();
        }
        this._gpuBuffers = null;
        if (this._bindGroupCache) {
            this._bindGroupCache.clear();
            this._bindGroupCache = null;
        }
    }
}
