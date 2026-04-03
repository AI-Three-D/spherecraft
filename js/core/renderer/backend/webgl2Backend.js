// renderer/backend/WebGL2Backend.js

import { Backend } from './backend.js';
import { TextureFormat, TextureFilter, TextureWrap, Texture } from '../resources/texture.js';

  
export class WebGL2Backend extends Backend {
    constructor(canvas) {
        super(canvas);
        this.gl = null;
        this.extensions = {};
        this.capabilities = {};
        
        this._currentProgram = null;
        this._currentRenderTarget = null;
        this._bufferCache = new Map();
        this._textureCache = new Map();
        this._programCache = new Map();
        this._framebufferCache = new Map();
        
        this._textureUnit = 0;
        this._maxTextureUnits = 0;
    }
    /**
 * Upload multiple textures to GPU in batch
 * @param {Texture[]} textures - Array of Texture instances
 * @returns {number} Number of textures successfully uploaded
 */
uploadTextures(textures) {
    if (!Array.isArray(textures)) {
        textures = [textures];
    }
    
    let uploaded = 0;
    for (const texture of textures) {
        if (texture instanceof Texture) {
            try {
                if (!texture._gpuTexture || texture._needsUpload) {
                    this.createTexture(texture);
                    uploaded++;
                  
                }
            } catch (error) {
                
            }
        }
    }
    
    return uploaded;
}
    /** Lazy initialise type->setter map once GL context is ready */
_initUniformSetters() {
    if (this._uniformSetters) return;
    const gl = this.gl;

    this._uniformSetters = {
        [gl.FLOAT]:       (loc, v) => gl.uniform1f(loc, v),
        [gl.FLOAT_VEC2]:  (loc, v) => gl.uniform2fv(loc, v.isVector2 ? [v.x, v.y] : v),
        [gl.FLOAT_VEC3]:  (loc, v) => gl.uniform3fv(loc, v.isVector3 ? [v.x, v.y, v.z] : v),
        [gl.FLOAT_VEC4]:  (loc, v) => gl.uniform4fv(loc, v),

        [gl.INT]:         (loc, v) => gl.uniform1i(loc, v | 0),
        [gl.INT_VEC2]:    (loc, v) => gl.uniform2iv(loc, v),
        [gl.INT_VEC3]:    (loc, v) => gl.uniform3iv(loc, v),
        [gl.INT_VEC4]:    (loc, v) => gl.uniform4iv(loc, v),

        [gl.BOOL]:        (loc, v) => gl.uniform1i(loc, v ? 1 : 0),
        [gl.BOOL_VEC2]:   (loc, v) => gl.uniform2iv(loc, v),
        [gl.BOOL_VEC3]:   (loc, v) => gl.uniform3iv(loc, v),
        [gl.BOOL_VEC4]:   (loc, v) => gl.uniform4iv(loc, v),

        [gl.FLOAT_MAT3]:  (loc, v) => gl.uniformMatrix3fv(loc, false, v.elements || v),
        [gl.FLOAT_MAT4]:  (loc, v) => gl.uniformMatrix4fv(loc, false, v.elements || v),

        [gl.SAMPLER_2D]:  (loc, unit) => gl.uniform1i(loc, unit),
        // Add more sampler types if used (e.g. gl.SAMPLER_CUBE, gl.SAMPLER_2D_ARRAY)
    };
}
    async initialize() {
        if (!this.canvas) {
            throw new Error('WebGL2: No canvas provided');
        }
        if (!(this.canvas instanceof HTMLCanvasElement)) {
            throw new Error('WebGL2: Invalid canvas element');
        }

        const contextOpts = {
            antialias: true,
            alpha: false,
            depth: true,
            stencil: false,
            powerPreference: 'high-performance',
            preserveDrawingBuffer: false
        };

        // Try multiple option sets to maximize the chance of getting a context
        const optSets = [
            contextOpts,
            { ...contextOpts, alpha: true },
            {}
        ];
        for (const opts of optSets) {
            this.gl = this.canvas.getContext('webgl2', opts) ||
                      this.canvas.getContext('experimental-webgl2', opts) ||
                      this.canvas.getContext('webgl', opts);
            if (this.gl) {
                if (opts !== contextOpts) {
                    
                }
                break;
            }
        }

        if (!this.gl) {
            const canvasInfo = `canvas: ${this.canvas.width}x${this.canvas.height}, id=${this.canvas.id}`;
            throw new Error(`WebGL2 not supported (context creation failed). ${canvasInfo}`);
        }
        
        this.context = this.gl;
        this._initUniformSetters();
        this.extensions.colorBufferFloat = this.gl.getExtension('EXT_color_buffer_float');
        this.extensions.floatBlend = this.gl.getExtension('EXT_float_blend');
        this.extensions.floatLinear = this.gl.getExtension('OES_texture_float_linear');
        this.extensions.textureFilterAnisotropic = 
            this.gl.getExtension('EXT_texture_filter_anisotropic') ||
            this.gl.getExtension('WEBKIT_E XT_texture_filter_anisotropic');
        
        this._maxTextureUnits = this.gl.getParameter(this.gl.MAX_TEXTURE_IMAGE_UNITS);
        this.capabilities.maxTextureSize = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
        this.capabilities.maxCubeMapSize = this.gl.getParameter(this.gl.MAX_CUBE_MAP_TEXTURE_SIZE);
        this.capabilities.maxVertexAttributes = this.gl.getParameter(this.gl.MAX_VERTEX_ATTRIBS);
        
        this.gl.enable(this.gl.DEPTH_TEST);
        this.gl.enable(this.gl.CULL_FACE);
        this.gl.cullFace(this.gl.BACK);
        
        
        
        
    }
    
    createBuffer(data, usage = 'static') {
        const gl = this.gl;
        const buffer = gl.createBuffer();
        
        const glUsage = usage === 'dynamic' ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW;
        const target = data instanceof Uint16Array || data instanceof Uint32Array 
            ? gl.ELEMENT_ARRAY_BUFFER 
            : gl.ARRAY_BUFFER;
        
        gl.bindBuffer(target, buffer);
        gl.bufferData(target, data, glUsage);
        gl.bindBuffer(target, null);
        
        return {
            glBuffer: buffer,
            target: target,
            size: data.byteLength
        };
    }
    
    updateBuffer(buffer, data, offset = 0) {
        const gl = this.gl;
        gl.bindBuffer(buffer.target, buffer.glBuffer);
        gl.bufferSubData(buffer.target, offset, data);
        gl.bindBuffer(buffer.target, null);
    }
    
    deleteBuffer(buffer) {
        if (buffer && buffer.glBuffer) {
            this.gl.deleteBuffer(buffer.glBuffer);
        }
    }
    
    createTexture(texture) {
        const gl = this.gl;
        const glTexture = gl.createTexture();
        
        gl.bindTexture(gl.TEXTURE_2D, glTexture);
        
        const { internalFormat, format, type } = this._getTextureFormats(texture.format);
        
        if (texture.data) {
            gl.texImage2D(
                gl.TEXTURE_2D, 0, internalFormat,
                texture.width, texture.height, 0,
                format, type, texture.data
            );
        } else if (texture.image) {
            gl.texImage2D(
                gl.TEXTURE_2D, 0, internalFormat,
                format, type, texture.image
            );
        } else {
            gl.texImage2D(
                gl.TEXTURE_2D, 0, internalFormat,
                texture.width, texture.height, 0,
                format, type, null
            );
        }
        
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this._getFilter(texture.minFilter));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, this._getFilter(texture.magFilter));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, this._getWrap(texture.wrapS));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, this._getWrap(texture.wrapT));
        if (this.extensions.textureFilterAnisotropic && texture.anisotropy > 1) {
            const maxAnisotropy = this.gl.getParameter(
                this.extensions.textureFilterAnisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT
            );
            const amount = Math.min(texture.anisotropy, maxAnisotropy);
            this.gl.texParameterf(
                this.gl.TEXTURE_2D, 
                this.extensions.textureFilterAnisotropic.TEXTURE_MAX_ANISOTROPY_EXT, 
                amount
            );
        }

        if (texture.generateMipmaps && this._isPowerOfTwo(texture.width) && this._isPowerOfTwo(texture.height)) {
            gl.generateMipmap(gl.TEXTURE_2D);
        }
        
        gl.bindTexture(gl.TEXTURE_2D, null);
        
        texture._gpuTexture = {
            glTexture,
            internalFormat,
            format,
            type
        };
        texture._needsUpload = false;
        
        return texture._gpuTexture;
    }
    
    updateTexture(texture) {
        if (!texture._gpuTexture) {
            return this.createTexture(texture);
        }
        
        const gl = this.gl;
        const gpuTex = texture._gpuTexture;
        
        gl.bindTexture(gl.TEXTURE_2D, gpuTex.glTexture);
        
        if (texture.data) {
            gl.texSubImage2D(
                gl.TEXTURE_2D, 0, 0, 0,
                texture.width, texture.height,
                gpuTex.format, gpuTex.type, texture.data
            );
        } else if (texture.image) {
            gl.texSubImage2D(
                gl.TEXTURE_2D, 0, 0, 0,
                gpuTex.format, gpuTex.type, texture.image
            );
        }
        
        gl.bindTexture(gl.TEXTURE_2D, null);
        texture._needsUpload = false;
    }
    
    deleteTexture(texture) {
        if (texture._gpuTexture) {
            this.gl.deleteTexture(texture._gpuTexture.glTexture);
            texture._gpuTexture = null;
        }
    }
    


    compileShader(material) {
        const gl = this.gl;
        let vertexSource = material.vertexShader;
        let fragmentSource = material.fragmentShader;
        
        if (material.defines) {
            let definesString = '';
            for (const [key, value] of Object.entries(material.defines)) {
                if (!value) continue;  // Skip false/null/undefined
                if (value === true) {
                    definesString += `#define ${key}\n`;
                } else {
                    definesString += `#define ${key} ${value}\n`;
                }
            }

            // Inject defines after #version directive (if present)
            const versionRegex = /^(#version\s+\d+\s+\w+\s*\n)/;
            const versionMatch = vertexSource.match(versionRegex);
            
            if (versionMatch) {
                // Insert after #version line
                const versionLine = versionMatch[1];
                vertexSource = versionLine + definesString + vertexSource.slice(versionLine.length);
                fragmentSource = fragmentSource.replace(versionRegex, versionMatch[1] + definesString);
            } else {
                // Prepend to start
                vertexSource = definesString + vertexSource;
                fragmentSource = definesString + fragmentSource;
            }
            
            // Debug: Log the injected defines
        }
        const vertexShader = this._compileShaderSource(gl.VERTEX_SHADER, vertexSource);
        const fragmentShader = this._compileShaderSource(gl.FRAGMENT_SHADER, fragmentSource);
    
        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
    
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const error = gl.getProgramInfoLog(program);
            gl.deleteProgram(program);
            gl.deleteShader(vertexShader);
            gl.deleteShader(fragmentShader);
            throw new Error('Shader program link error: ' + error);
        }
    
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);
    
        // --- Collect active uniforms ---
        const uniformLocations = {};
        const uniformTypes = {};
        const numUniforms = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    
        for (let i = 0; i < numUniforms; i++) {
            const info = gl.getActiveUniform(program, i);
            if (!info) continue;
            const baseName = info.name.endsWith('[0]') ? info.name.slice(0, -3) : info.name;
    
            const location = gl.getUniformLocation(program, baseName);
            uniformLocations[baseName] = location;
            uniformTypes[baseName] = info.type;
        }
    
        // --- Collect active vertex attributes ---
        const attributeLocations = {};
        const numAttributes = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES);
    
        for (let i = 0; i < numAttributes; i++) {
            const info = gl.getActiveAttrib(program, i);
            if (!info) continue;
    
            attributeLocations[info.name] = gl.getAttribLocation(program, info.name);
        }
    
        material._gpuProgram = {
            program,
            uniformLocations,
            uniformTypes,
            attributeLocations
        };
    
        material._needsCompile = false;
        return material._gpuProgram;
    }

    deleteShader(material) {
        if (material._gpuProgram) {
            this.gl.deleteProgram(material._gpuProgram.program);
            material._gpuProgram = null;
        }
    }
    
    createRenderTarget(renderTarget) {
        const gl = this.gl;
        const framebuffer = gl.createFramebuffer();
        
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        
        const drawBuffers = [];
        
        for (let i = 0; i < renderTarget.colorAttachments.length; i++) {
            const colorTex = renderTarget.colorAttachments[i];
            if (!colorTex._gpuTexture) {
                this.createTexture(colorTex);
            }
            
            gl.framebufferTexture2D(
                gl.FRAMEBUFFER,
                gl.COLOR_ATTACHMENT0 + i,
                gl.TEXTURE_2D,
                colorTex._gpuTexture.glTexture,
                0
            );
            drawBuffers.push(gl.COLOR_ATTACHMENT0 + i);
        }
        
        if (drawBuffers.length > 1) {
            gl.drawBuffers(drawBuffers);
        }
        
        if (renderTarget.depthAttachment) {
            const depthTex = renderTarget.depthAttachment;
            if (!depthTex._gpuTexture) {
                this.createTexture(depthTex);
            }
            
            gl.framebufferTexture2D(
                gl.FRAMEBUFFER,
                gl.DEPTH_ATTACHMENT,
                gl.TEXTURE_2D,
                depthTex._gpuTexture.glTexture,
                0
            );
        }
        
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            throw new Error('Framebuffer incomplete: ' + status);
        }
        
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        
        renderTarget._gpuFramebuffer = framebuffer;
        renderTarget._needsSetup = false;
        
        return framebuffer;
    }
    
    deleteRenderTarget(renderTarget) {
        if (renderTarget._gpuFramebuffer) {
            this.gl.deleteFramebuffer(renderTarget._gpuFramebuffer);
            renderTarget._gpuFramebuffer = null;
        }
    }
    
    setRenderTarget(renderTarget) {
        const gl = this.gl;
        
        if (renderTarget === null) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, this.canvas.width, this.canvas.height);
            this._currentRenderTarget = null;
        } else {
            if (!renderTarget._gpuFramebuffer || renderTarget._needsSetup) {
                this.createRenderTarget(renderTarget);
            }
            
            gl.bindFramebuffer(gl.FRAMEBUFFER, renderTarget._gpuFramebuffer);
            gl.viewport(0, 0, renderTarget.width, renderTarget.height);
            this._currentRenderTarget = renderTarget;
        }
    }
    
    clear(color = true, depth = true, stencil = false) {
        const gl = this.gl;
        let bits = 0;
        
        if (color) bits |= gl.COLOR_BUFFER_BIT;
        if (depth) bits |= gl.DEPTH_BUFFER_BIT;
        if (stencil) bits |= gl.STENCIL_BUFFER_BIT;
        
        if (bits) gl.clear(bits);
    }
    
    setClearColor(r, g, b, a = 1) {
        this.gl.clearColor(r, g, b, a);
    }
    
    setViewport(x, y, width, height) {
        this.gl.viewport(x, y, width, height);
    }
    
    draw(geometry, material, uniforms = {}) {
        const gl = this.gl;
        
        if (material._needsCompile || !material._gpuProgram) {
            this.compileShader(material);
        }
        
        const program = material._gpuProgram;
        
        if (this._currentProgram !== program.program) {
            gl.useProgram(program.program);
            this._currentProgram = program.program;
        }
        
        this._bindGeometry(geometry, program);
        this._setUniforms(material, uniforms, program);
        this._setState(material);
        
        if (geometry.index) {
            const indexKey = 'index_' + geometry.id;
            let indexBuffer = this._bufferCache.get(indexKey);
            
            if (!indexBuffer || geometry._needsUpload) {
                if (indexBuffer) {
                    gl.deleteBuffer(indexBuffer.glBuffer);
                }
                indexBuffer = this.createBuffer(geometry.index.data);
                this._bufferCache.set(indexKey, indexBuffer);
                geometry._needsUpload = false;
            }
            
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer.glBuffer);
            
            const count = Math.min(geometry.index.count, geometry.drawRange.count);
            const offset = geometry.drawRange.start;
            const type = geometry.index.data instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
            
            gl.drawElements(gl.TRIANGLES, count, type, offset * (type === gl.UNSIGNED_INT ? 4 : 2));
        } else {
            const position = geometry.attributes.get('position');
            if (position) {
                const count = Math.min(position.count, geometry.drawRange.count);
                const offset = geometry.drawRange.start;
                gl.drawArrays(gl.TRIANGLES, offset, count);
            }
        }
    }
    
    readPixels(renderTarget, x, y, width, height, format = 'rgba') {
        const gl = this.gl;
        
        if (renderTarget) {
            this.setRenderTarget(renderTarget);
        }
        
        const glFormat = format === 'rgba' ? gl.RGBA : gl.RED;
        const type = gl.FLOAT;
        const data = new Float32Array(width * height * (format === 'rgba' ? 4 : 1));
        
        gl.readPixels(x, y, width, height, glFormat, type, data);
        
        return data;
    }
    
    dispose() {
        for (const buffer of this._bufferCache.values()) {
            this.gl.deleteBuffer(buffer.glBuffer);
        }
        this._bufferCache.clear();
        
        for (const texture of this._textureCache.values()) {
            this.gl.deleteTexture(texture);
        }
        this._textureCache.clear();
        
        for (const program of this._programCache.values()) {
            this.gl.deleteProgram(program);
        }
        this._programCache.clear();
        
        for (const fb of this._framebufferCache.values()) {
            this.gl.deleteFramebuffer(fb);
        }
        this._framebufferCache.clear();
    }

    getAPIName() {
        return 'webgl2';
    }
    
    _compileShaderSource(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const error = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            const typeStr = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
            throw new Error(`${typeStr} shader compile error: ${error}`);
        }
        
        return shader;
    }
    
    _bindGeometry(geometry, program) {
        const gl = this.gl;
        
        for (const [name, attribute] of geometry.attributes) {
            const location = program.attributeLocations[name];
            if (location === undefined || location === -1) continue;
            
            const bufferKey = name + '_' + geometry.id;
            let buffer = this._bufferCache.get(bufferKey);
            
            if (!buffer || geometry._needsUpload) {
                if (buffer) {
                    gl.deleteBuffer(buffer.glBuffer);
                }
                buffer = this.createBuffer(attribute.data);
                this._bufferCache.set(bufferKey, buffer);
            }
            
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer.glBuffer);
            gl.enableVertexAttribArray(location);
            gl.vertexAttribPointer(
                location,
                attribute.itemSize,
                gl.FLOAT,
                attribute.normalized,
                0,
                0
            );
        }
    }
_setUniforms(material, additionalUniforms, program) {
    const gl = this.gl;
    this._textureUnit = 0;

    const allUniforms = { ...material.uniforms, ...additionalUniforms };

    // Debug: Log texture uniforms
    const textureUniforms = ['heightTexture', 'normalTexture', 'tileTexture', 'atlasTexture'];
   /* for (const name of textureUniforms) {
        const uniform = allUniforms[name];
        if (uniform) {
            const tex = uniform.value;
        }
    }*/
        for (const [name, uniform] of Object.entries(allUniforms)) {
            const location = program.uniformLocations[name];
            if (location == null) continue;
    
            const value = uniform.value !== undefined ? uniform.value : uniform;
    
            // ====== ROBUST TEXTURE HANDLING ======
            // Check if this is a Texture instance (custom class)
            if (value instanceof Texture) {
                // Ensure GPU texture exists
                if (!value._gpuTexture || value._needsUpload) {
                    if (value._gpuTexture && value._needsUpload) {
                        this.updateTexture(value);
                    } else {
                        this.createTexture(value);
                    }
                }
                
                // Now bind the texture
                if (value._gpuTexture) {
                    gl.activeTexture(gl.TEXTURE0 + this._textureUnit);
                    gl.bindTexture(gl.TEXTURE_2D, value._gpuTexture.glTexture);
                    gl.uniform1i(location, this._textureUnit);
                    this._textureUnit++;
                } else {
                    
                }
                continue;
            }
    
            // Fallback for any texture-like object with _gpuTexture already set
            if (value?._gpuTexture) {
                
    
                gl.activeTexture(gl.TEXTURE0 + this._textureUnit);
                gl.bindTexture(gl.TEXTURE_2D, value._gpuTexture.glTexture);
                gl.uniform1i(location, this._textureUnit);
                this._textureUnit++;
                continue;
            }
    
            // ====== NON-TEXTURE UNIFORMS ======
            const glType = program.uniformTypes[name];
            const setter = this._uniformSetters && this._uniformSetters[glType];
    
            if (setter) {
                setter(location, value);
            } else {
                this._fallbackUniformSetter(location, value);
            }
        }
    }
    _fallbackUniformSetter(location, value) {
        const gl = this.gl;
        
        if (value === null || value === undefined) return;
        
        if (typeof value === 'number') {
            gl.uniform1f(location, value);
        } 
        else if (typeof value === 'boolean') {
            gl.uniform1i(location, value ? 1 : 0);
        }
        else if (value.isVector2) {
            gl.uniform2f(location, value.x, value.y);
        } 
        else if (value.isVector3) {
            gl.uniform3f(location, value.x, value.y, value.z);
        } 
        else if (value.isVector4) {
            gl.uniform4f(location, value.x, value.y, value.z, value.w);
        } 
        else if (value.isColor) {
            gl.uniform3f(location, value.r, value.g, value.b);
        } 
        else if (value.isMatrix4) {
            gl.uniformMatrix4fv(location, false, value.elements);
        } 
        else if (value.isMatrix3) {
            gl.uniformMatrix3fv(location, false, value.elements);
        } 
        else if (Array.isArray(value)) {
            if (value.length === 2) gl.uniform2fv(location, value);
            else if (value.length === 3) gl.uniform3fv(location, value);
            else if (value.length === 4) gl.uniform4fv(location, value);
            else gl.uniform1fv(location, value);
        }
    }


    _setUniformValue(location, value, type = null) {
        const gl = this.gl;
        
        if (value === null || value === undefined) return;
        
        // Handle textures first
        if (value instanceof Texture || (value._gpuTexture !== undefined)) {
            if (!value._gpuTexture) {
                this.createTexture(value);
            }
            gl.activeTexture(gl.TEXTURE0 + this._textureUnit);
            gl.bindTexture(gl.TEXTURE_2D, value._gpuTexture.glTexture);
            gl.uniform1i(location, this._textureUnit);
            this._textureUnit++;
            return;
        }
        
        if (value.isTexture) {
            
            return;
        }
        if (type) {
            switch(type) {
                case 'int':
                    gl.uniform1i(location, value);
                    return;
                case 'ivec2':
                    gl.uniform2iv(location, Array.isArray(value) ? value : [value.x, value.y]);
                    return;
                case 'ivec3':
                    gl.uniform3iv(location, Array.isArray(value) ? value : [value.x, value.y, value.z]);
                    return;
                case 'ivec4':
                    gl.uniform4iv(location, Array.isArray(value) ? value : [value.x, value.y, value.z, value.w]);
                    return;
                case 'float':
                    gl.uniform1f(location, value);
                    return;
                case 'vec2':
                    if (Array.isArray(value)) {
                        gl.uniform2fv(location, value);
                    } else {
                        gl.uniform2f(location, value.x, value.y);
                    }
                    return;
                case 'vec3':
                    if (Array.isArray(value)) {
                        gl.uniform3fv(location, value);
                    } else {
                        gl.uniform3f(location, value.x, value.y, value.z);
                    }
                    return;
                case 'vec4':
                    if (Array.isArray(value)) {
                        gl.uniform4fv(location, value);
                    } else {
                        gl.uniform4f(location, value.x, value.y, value.z, value.w);
                    }
                    return;
                case 'mat3':
                    gl.uniformMatrix3fv(location, false, value.elements || value);
                    return;
                case 'mat4':
                    gl.uniformMatrix4fv(location, false, value.elements || value);
                    return;
                case 'sampler2D':
                    // Already handled above
                    return;
            }
        }
        
        // Auto-detect types based on value (for regular rendering)
        if (typeof value === 'number') {
            gl.uniform1f(location, value);
        } 
        else if (typeof value === 'boolean') {
            gl.uniform1i(location, value ? 1 : 0);
        }
        else if (value.isVector2 || (value.x !== undefined && value.y !== undefined && value.z === undefined && value.w === undefined)) {
            gl.uniform2f(location, value.x, value.y);
        } 
        else if (value.isVector3 || (value.x !== undefined && value.y !== undefined && value.z !== undefined && value.w === undefined)) {
            gl.uniform3f(location, value.x, value.y, value.z);
        } 
        else if (value.isVector4 || (value.x !== undefined && value.w !== undefined)) {
            gl.uniform4f(location, value.x, value.y, value.z, value.w);
        } 
        else if (value.isColor) {
            gl.uniform3f(location, value.r, value.g, value.b);
        } 
        else if (value.isMatrix4 || (value.elements && value.elements.length === 16)) {
            gl.uniformMatrix4fv(location, false, value.elements);
        } 
        else if (value.isMatrix3 || (value.elements && value.elements.length === 9)) {
            gl.uniformMatrix3fv(location, false, value.elements);
        } 
        else if (Array.isArray(value)) {
            // Default arrays to float vectors unless they're clearly integers
            const isInt = value.every(v => Number.isInteger(v));
            
            if (isInt) {
                // Integer array
                if (value.length === 1) gl.uniform1iv(location, value);
                else if (value.length === 2) gl.uniform2iv(location, value);
                else if (value.length === 3) gl.uniform3iv(location, value);
                else if (value.length === 4) gl.uniform4iv(location, value);
                else gl.uniform1iv(location, value); // Array of ints
            } else {
                // Float array
                if (value.length === 2) gl.uniform2fv(location, value);
                else if (value.length === 3) gl.uniform3fv(location, value);
                else if (value.length === 4) gl.uniform4fv(location, value);
                else if (value.length === 9) gl.uniformMatrix3fv(location, false, value);
                else if (value.length === 16) gl.uniformMatrix4fv(location, false, value);
                else gl.uniform1fv(location, value); // Array of floats
            }
        }
        else if (value instanceof Int32Array || value instanceof Uint32Array) {
            if (value.length === 1) gl.uniform1iv(location, value);
            else if (value.length === 2) gl.uniform2iv(location, value);
            else if (value.length === 3) gl.uniform3iv(location, value);
            else if (value.length === 4) gl.uniform4iv(location, value);
            else gl.uniform1iv(location, value);
        }
        else if (value instanceof Float32Array) {
            if (value.length === 2) gl.uniform2fv(location, value);
            else if (value.length === 3) gl.uniform3fv(location, value);
            else if (value.length === 4) gl.uniform4fv(location, value);
            else if (value.length === 9) gl.uniformMatrix3fv(location, false, value);
            else if (value.length === 16) gl.uniformMatrix4fv(location, false, value);
            else gl.uniform1fv(location, value);
        }
    }
    
    _setState(material) {
        const gl = this.gl;
        
        if (material.side === 'double') {
            gl.disable(gl.CULL_FACE);
        } else {
            gl.enable(gl.CULL_FACE);
            gl.cullFace(material.side === 'back' ? gl.FRONT : gl.BACK);
        }
        
        if (material.depthTest) {
            gl.enable(gl.DEPTH_TEST);
        } else {
            gl.disable(gl.DEPTH_TEST);
        }
        
        gl.depthMask(material.depthWrite);
        
        if (material.transparent) {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        } else {
            gl.disable(gl.BLEND);
        }
    }
    
    _getOrCreateBuffer(data, key) {
        if (!this._bufferCache.has(key)) {
            this._bufferCache.set(key, this.createBuffer(data));
        }
        return this._bufferCache.get(key);
    }
    _getTextureFormats(format) {
        const gl = this.gl;
        
        const formatMap = {
            [TextureFormat.RGBA8]: { internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE },
            [TextureFormat.RGBA16F]: { internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT },
            [TextureFormat.RGBA32F]: { internalFormat: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT },
            [TextureFormat.R8]: { internalFormat: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE },
            [TextureFormat.R16F]: { internalFormat: gl.R16F, format: gl.RED, type: gl.HALF_FLOAT },
            [TextureFormat.R32F]: { internalFormat: gl.R32F, format: gl.RED, type: gl.FLOAT },
            [TextureFormat.DEPTH24]: { internalFormat: gl.DEPTH_COMPONENT24, format: gl.DEPTH_COMPONENT, type: gl.UNSIGNED_INT },
            [TextureFormat.DEPTH32F]: { internalFormat: gl.DEPTH_COMPONENT32F, format: gl.DEPTH_COMPONENT, type: gl.FLOAT }
        };
        
        return formatMap[format] || formatMap[TextureFormat.RGBA8];
    }
    
    
    _getFilter(filter) {
        const gl = this.gl;
        const filterMap = {
            [TextureFilter.NEAREST]: gl.NEAREST,
            [TextureFilter.LINEAR]: gl.LINEAR,
            [TextureFilter.NEAREST_MIPMAP_NEAREST]: gl.NEAREST_MIPMAP_NEAREST,
            [TextureFilter.LINEAR_MIPMAP_LINEAR]: gl.LINEAR_MIPMAP_LINEAR,
            [TextureFilter.NEAREST_MIPMAP_LINEAR]: gl.NEAREST_MIPMAP_LINEAR,
            [TextureFilter.LINEAR_MIPMAP_NEAREST]: gl.LINEAR_MIPMAP_NEAREST
        };
        return filterMap[filter] || gl.LINEAR;
    }
    
    _getWrap(wrap) {
        const gl = this.gl;
        const wrapMap = {
            [TextureWrap.REPEAT]: gl.REPEAT,
            [TextureWrap.CLAMP]: gl.CLAMP_TO_EDGE,
            [TextureWrap.MIRROR]: gl.MIRRORED_REPEAT
        };
        return wrapMap[wrap] || gl.CLAMP_TO_EDGE;
    }
    
    _isPowerOfTwo(value) {
        return (value & (value - 1)) === 0;
    }

    // =========================================================================
    // Instancing-aware overrides (appended to ease merges)
    // =========================================================================
    _bindGeometry(geometry, program) {
        const gl = this.gl;
        
        for (const [name, attribute] of geometry.attributes) {
            const location = program.attributeLocations[name];
            if (location === undefined || location === -1) continue;
            
            const bufferKey = name + '_' + geometry.id;
            let buffer = this._bufferCache.get(bufferKey);
            
            if (!buffer || geometry._needsUpload) {
                if (buffer) {
                    gl.deleteBuffer(buffer.glBuffer);
                }
                buffer = this.createBuffer(attribute.data);
                this._bufferCache.set(bufferKey, buffer);
            }
            
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer.glBuffer);
            gl.enableVertexAttribArray(location);
            gl.vertexAttribPointer(
                location,
                attribute.itemSize,
                gl.FLOAT,
                attribute.normalized,
                0,
                0
            );
            const divisor = attribute.stepMode === 'instance' ? 1 : 0;
            gl.vertexAttribDivisor(location, divisor);
        }
    }

    draw(geometry, material, uniforms = {}) {
        const gl = this.gl;
        
        if (material._needsCompile || !material._gpuProgram) {
            this.compileShader(material);
        }
        
        const program = material._gpuProgram;
        
        if (this._currentProgram !== program.program) {
            gl.useProgram(program.program);
            this._currentProgram = program.program;
        }
        
        this._bindGeometry(geometry, program);
        this._setUniforms(material, uniforms, program);
        this._setState(material);
        
        const instanceCount = Math.max(geometry.instanceCount || 1, 1);
        
        if (geometry.index) {
            const indexKey = 'index_' + geometry.id;
            let indexBuffer = this._bufferCache.get(indexKey);
            
            if (!indexBuffer || geometry._needsUpload) {
                if (indexBuffer) {
                    gl.deleteBuffer(indexBuffer.glBuffer);
                }
                indexBuffer = this.createBuffer(geometry.index.data);
                this._bufferCache.set(indexKey, indexBuffer);
            }
            
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer.glBuffer);
            
            const count = Math.min(geometry.index.count, geometry.drawRange.count);
            const offset = geometry.drawRange.start;
            const type = geometry.index.data instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
            
            gl.drawElementsInstanced(gl.TRIANGLES, count, type, offset * (type === gl.UNSIGNED_INT ? 4 : 2), instanceCount);
        } else {
            const position = geometry.attributes.get('position');
            if (position) {
                const count = Math.min(position.count, geometry.drawRange.count);
                const offset = geometry.drawRange.start;
                gl.drawArraysInstanced(gl.TRIANGLES, offset, count, instanceCount);
            }
        }
        
        geometry._needsUpload = false;
    }
}
