// renderer/resources/material.js

export class Material {
    constructor(options = {}) {
        this.id = Material._nextId++;
        
        this.vertexShader = options.vertexShader || '';
        this.fragmentShader = options.fragmentShader || '';
        
        this.uniforms = options.uniforms || {};
        this.defines = options.defines || {};
        this.storageBuffers = options.storageBuffers || {};
    
        this.name = options.name || `Material_${this.id}`;
        
        this.vertexLayout = options.vertexLayout || null;
        
        this.side = options.side || 'front';
        this.transparent = options.transparent || false;
        this.depthTest = options.depthTest !== false;
        this.depthWrite = options.depthWrite !== false;
        this.blending = options.blending || 'normal';
        this.bindGroupLayoutSpec = options.bindGroupLayoutSpec || null;
        this.depthCompare = options.depthCompare || 'less';
        this.targetFormat = options.targetFormat || null;
        this._gpuProgram = null;
        this._uniformLocations = null;
        this._needsCompile = true;
        this.bindGroupLayoutSpec = options.bindGroupLayoutSpec || null;
        
    }
    
    static _nextId = 0;
    
    setUniform(name, value) {
        if (!this.uniforms[name]) {
            this.uniforms[name] = { value: value };
        } else {
            this.uniforms[name].value = value;
        }
    }
    
    getUniform(name) {
        return this.uniforms[name]?.value;
    }
    
    clone() {
        const cloned = new Material({
            name: this.name + '_clone',
            vertexShader: this.vertexShader,
            fragmentShader: this.fragmentShader,
            vertexLayout: this.vertexLayout,
            defines: { ...this.defines },
            bindGroupLayoutSpec: this.bindGroupLayoutSpec,
            storageBuffers: { ...this.storageBuffers },
            side: this.side,
            transparent: this.transparent,
            depthTest: this.depthTest,
            depthWrite: this.depthWrite,
            blending: this.blending
        });
        
        for (const [key, uniform] of Object.entries(this.uniforms)) {
            cloned.uniforms[key] = { value: uniform.value };
        }
        
        return cloned;
    }
    
    dispose() {
        this._gpuProgram = null;
        this._uniformLocations = null;
    }
}
