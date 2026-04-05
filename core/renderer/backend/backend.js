// js/renderer/backend/backend.js
// Abstract base class for rendering backends (WebGPU)

/**
 * @typedef {import('../resources/texture.js').Texture} Texture
 * @typedef {import('../resources/geometry.js').Geometry} Geometry
 * @typedef {import('../resources/material.js').Material} Material
 * @typedef {import('../resources/renderTarget.js').RenderTarget} RenderTarget
 */

/**
 * @typedef {Object} BufferHandle
 * @property {GPUBuffer} glBuffer - The native buffer object
 * @property {number} target - Usage flags
 * @property {number} size - Size of buffer in bytes
 * @property {boolean} [isIndex] - Whether this is an index buffer
 * @property {string} [elementType] - Element type for index buffers ('uint16' or 'uint32')
 */

/**
 * @typedef {Object} GPUTextureHandle
 * @property {GPUTexture} glTexture - The native texture object
 * @property {number|string} internalFormat - Internal texture format
 * @property {number|string} format - Texture format
 * @property {number|string} type - Data type
 * @property {GPUTextureView} [view] - Texture view
 */

/**
 * Abstract base class for graphics API backends.
 * Provides a unified interface for WebGPU rendering.
 *
 * @abstract
 * @class Backend
 */
export class Backend {
    /**
     * Create a new Backend instance.
     * 
     * @param {HTMLCanvasElement} canvas - The canvas element to render to
     */
    constructor(canvas) {
        /** @type {HTMLCanvasElement} */
        this.canvas = canvas;

        /** @type {GPUCanvasContext|null} */
        this.context = null;
        
        /** @type {Object.<string, any>} */
        this.extensions = {};
        
        /** @type {Object.<string, number>} */
        this.capabilities = {};
    }

    // =========================================================================
    // LIFECYCLE METHODS
    // =========================================================================

    /**
     * Initialize the graphics context and set up required state.
     * Must be called before any other rendering operations.
     * 
     * @abstract
     * @async
     * @returns {Promise<void>}
     * @throws {Error} If the graphics API is not supported
     * 
     * @example
     * const backend = new WebGPUBackend(canvas);
     * await backend.initialize();
     */
    async initialize() {
        throw new Error('Backend.initialize() must be implemented');
    }

    /**
     * Clean up all GPU resources and release the graphics context.
     * Should be called when the renderer is no longer needed.
     * 
     * @abstract
     * @returns {void}
     * 
     * @example
     * backend.dispose();
     */
    dispose() {
        throw new Error('Backend.dispose() must be implemented');
    }

    /**
     * Get the name of the graphics API being used.
     *
     * @returns {string} API name ('webgpu' or 'Base')
     *
     * @example
     * console.log(backend.getAPIName()); // 'webgpu'
     */
    getAPIName() {
        return 'Base';
    }

    /**
     * Get the underlying graphics context.
     *
     * @returns {GPUCanvasContext|null} The graphics context
     */
    getContext() {
        return this.context;
    }

    // =========================================================================
    // BUFFER METHODS
    // =========================================================================

    /**
     * Create a GPU buffer from typed array data.
     * 
     * @abstract
     * @param {Float32Array|Uint16Array|Uint32Array|Int32Array} data - The buffer data
     * @param {string} [usage='static'] - Usage hint: 'static', 'dynamic', 'uniform', 'storage', 'index', 'vertex'
     * @returns {BufferHandle} Handle to the created buffer
     * 
     * @example
     * const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
     * const buffer = backend.createBuffer(positions, 'static');
     */
    createBuffer(data, usage) {
        throw new Error('Backend.createBuffer() must be implemented');
    }

    /**
     * Update an existing buffer with new data.
     * 
     * @abstract
     * @param {BufferHandle} buffer - The buffer to update
     * @param {Float32Array|Uint16Array|Uint32Array|Int32Array} data - The new data
     * @param {number} [offset=0] - Byte offset into the buffer
     * @returns {void}
     * 
     * @example
     * backend.updateBuffer(buffer, newPositions, 0);
     */
    updateBuffer(buffer, data, offset = 0) {
        throw new Error('Backend.updateBuffer() must be implemented');
    }

    /**
     * Delete a buffer and release its GPU memory.
     * 
     * @abstract
     * @param {BufferHandle} buffer - The buffer to delete
     * @returns {void}
     */
    deleteBuffer(buffer) {
        throw new Error('Backend.deleteBuffer() must be implemented');
    }

    // =========================================================================
    // TEXTURE METHODS
    // =========================================================================

    /**
     * Create a GPU texture from a Texture object.
     * Sets texture._gpuTexture with the native handle.
     * 
     * @abstract
     * @param {Texture} texture - The texture wrapper with .data, .width, .height, .format
     * @returns {GPUTextureHandle} Handle to the created GPU texture
     * 
     * @example
     * const texture = new Texture({ width: 512, height: 512, data: imageData });
     * backend.createTexture(texture);
     * console.log(texture._gpuTexture); // Native GPU handle
     */
    createTexture(texture) {
        throw new Error('Backend.createTexture() must be implemented');
    }

    /**
     * Update an existing texture with new data.
     * Creates the texture if it doesn't exist yet.
     * 
     * @abstract
     * @param {Texture} texture - The texture to update
     * @returns {void}
     */
    updateTexture(texture) {
        throw new Error('Backend.updateTexture() must be implemented');
    }

    /**
     * Delete a texture and release its GPU memory.
     * 
     * @abstract
     * @param {Texture} texture - The texture to delete
     * @returns {void}
     */
    deleteTexture(texture) {
        throw new Error('Backend.deleteTexture() must be implemented');
    }

    /**
     * Upload a Texture object to GPU.
     * Alias for createTexture for semantic clarity.
     * 
     * @param {Texture} texture - The texture wrapper with .data, .width, .height
     * @returns {void} Sets texture._gpuTexture
     */
    uploadTexture(texture) {
        throw new Error('Backend.uploadTexture() must be implemented');
    }

    /**
     * Upload multiple textures to GPU in batch.
     * More efficient than calling uploadTexture repeatedly.
     * 
     * @param {Texture[]} textures - Array of Texture instances
     * @returns {number} Number of textures successfully uploaded
     * 
     * @example
     * const count = backend.uploadTextures([tex1, tex2, tex3]);
     * 
     */
    uploadTextures(textures) {
        if (!Array.isArray(textures)) {
            textures = [textures];
        }
        
        let uploaded = 0;
        for (const texture of textures) {
            try {
                if (!texture._gpuTexture || texture._needsUpload) {
                    this.createTexture(texture);
                    uploaded++;
                }
            } catch (error) {
                
            }
        }
        
        return uploaded;
    }

    // =========================================================================
    // SHADER METHODS
    // =========================================================================

    /**
     * Compile shaders and create a shader program from a Material.
     * Sets material._gpuPipeline.
     *
     * @abstract
     * @param {Material} material - The material containing vertex/fragment shader source
     * @returns {Object} The compiled program/pipeline handle
     * @throws {Error} If shader compilation fails
     * 
     * @example
     * const material = new Material({
     *   vertexShader: vertexSource,
     *   fragmentShader: fragmentSource
     * });
     * backend.compileShader(material);
     */
    compileShader(material) {
        throw new Error('Backend.compileShader() must be implemented');
    }

    /**
     * Delete a compiled shader program and release GPU resources.
     * 
     * @abstract
     * @param {Material} material - The material whose shader should be deleted
     * @returns {void}
     */
    deleteShader(material) {
        throw new Error('Backend.deleteShader() must be implemented');
    }

    // =========================================================================
    // RENDER TARGET METHODS
    // =========================================================================

    /**
     * Create a render target (framebuffer) for off-screen rendering.
     * 
     * @abstract
     * @param {RenderTarget} renderTarget - The render target configuration
     * @returns {Object} The created framebuffer handle
     * @throws {Error} If framebuffer creation fails
     * 
     * @example
     * const rt = new RenderTarget({ width: 1024, height: 1024 });
     * backend.createRenderTarget(rt);
     */
    createRenderTarget(renderTarget) {
        throw new Error('Backend.createRenderTarget() must be implemented');
    }

    /**
     * Delete a render target and release its GPU resources.
     * 
     * @abstract
     * @param {RenderTarget} renderTarget - The render target to delete
     * @returns {void}
     */
    deleteRenderTarget(renderTarget) {
        throw new Error('Backend.deleteRenderTarget() must be implemented');
    }

    /**
     * Set the current render target for subsequent draw calls.
     * Pass null to render to the default framebuffer (canvas).
     * 
     * @abstract
     * @param {RenderTarget|null} renderTarget - The render target, or null for default
     * @returns {void}
     * 
     * @example
     * backend.setRenderTarget(shadowMap);
     * // ... render shadow pass ...
     * backend.setRenderTarget(null); // Back to screen
     */
    setRenderTarget(renderTarget) {
        throw new Error('Backend.setRenderTarget() must be implemented');
    }

    // =========================================================================
    // RENDERING STATE METHODS
    // =========================================================================

    /**
     * Set the color used when clearing the color buffer.
     * 
     * @abstract
     * @param {number} r - Red component (0.0 - 1.0)
     * @param {number} g - Green component (0.0 - 1.0)
     * @param {number} b - Blue component (0.0 - 1.0)
     * @param {number} [a=1.0] - Alpha component (0.0 - 1.0)
     * @returns {void}
     * 
     * @example
     * backend.setClearColor(0.1, 0.1, 0.1, 1.0);
     */
    setClearColor(r, g, b, a = 1.0) {
        throw new Error('Backend.setClearColor() must be implemented');
    }

    /**
     * Clear the current render target's buffers.
     * 
     * @abstract
     * @param {boolean} [color=true] - Whether to clear the color buffer
     * @param {boolean} [depth=true] - Whether to clear the depth buffer
     * @param {boolean} [stencil=false] - Whether to clear the stencil buffer
     * @returns {void}
     * 
     * @example
     * backend.clear(true, true, false);
     */
    clear(color = true, depth = true, stencil = false) {
        throw new Error('Backend.clear() must be implemented');
    }

    /**
     * Set the viewport rectangle for rendering.
     * 
     * @abstract
     * @param {number} x - Left edge in pixels
     * @param {number} y - Bottom edge in pixels
     * @param {number} width - Width in pixels
     * @param {number} height - Height in pixels
     * @returns {void}
     * 
     * @example
     * backend.setViewport(0, 0, canvas.width, canvas.height);
     */
    setViewport(x, y, width, height) {
        throw new Error('Backend.setViewport() must be implemented');
    }

    // =========================================================================
    // DRAW METHODS
    // =========================================================================

    /**
     * Draw geometry using a material and uniforms.
     * This is the main draw call method.
     * 
     * @abstract
     * @param {Geometry} geometry - The geometry to draw (vertices, indices, attributes)
     * @param {Material} material - The material (shaders, render state)
     * @param {Object.<string, {value: any}>} [uniforms={}] - Additional uniforms to set
     * @returns {void}
     * 
     * @example
     * backend.draw(cubeGeometry, phongMaterial, {
     *   modelMatrix: { value: modelMat },
     *   diffuseColor: { value: [1, 0, 0] }
     * });
     */
    draw(geometry, material, uniforms = {}) {
        throw new Error('Backend.draw() must be implemented');
    }

    // =========================================================================
    // READ METHODS
    // =========================================================================

    /**
     * Read pixels from a render target or the current framebuffer.
     * 
     * @abstract
     * @param {RenderTarget|null} renderTarget - Render target to read from, or null for default
     * @param {number} x - Left edge of rectangle to read
     * @param {number} y - Bottom edge of rectangle to read
     * @param {number} width - Width of rectangle to read
     * @param {number} height - Height of rectangle to read
     * @param {string} [format='rgba'] - Pixel format ('rgba' or 'r')
     * @returns {Float32Array} The pixel data
     * 
     * @example
     * const pixels = backend.readPixels(null, 0, 0, 100, 100, 'rgba');
     */
    readPixels(renderTarget, x, y, width, height, format = 'rgba') {
        throw new Error('Backend.readPixels() must be implemented');
    }

    // =========================================================================
    // COMMAND SUBMISSION
    // =========================================================================

    /**
     * Submit all queued GPU commands for execution.
     *
     * @returns {void}
     *
     * @example
     * // After all draw calls for a frame
     * backend.submitCommands();
     */
    submitCommands() {
        // WebGPU overrides this to submit command buffers
    }

    /**
     * Begin a new frame. Called at the start of each render frame.
     * Implementations may use this to reset per-frame state.
     * 
     * @returns {void}
     */
    beginFrame() {
        // Optional - implementations can override if needed
    }

    /**
     * End the current frame. Called after all draw calls are complete.
     * Implementations may use this to present the frame or flush commands.
     * 
     * @returns {void}
     */
    endFrame() {
        // Optional - implementations can override if needed
        this.submitCommands();
    }

    // =========================================================================
    // UTILITY METHODS
    // =========================================================================

    /**
     * Check if a value is a power of two.
     * Useful for mipmap generation decisions.
     * 
     * @protected
     * @param {number} value - The value to check
     * @returns {boolean} True if value is a power of two
     */
    _isPowerOfTwo(value) {
        return (value & (value - 1)) === 0 && value > 0;
    }

    /**
     * Get the number of bytes per pixel for a texture format.
     * 
     * @protected
     * @param {string|number} format - The texture format
     * @returns {number} Bytes per pixel
     */
    _getBytesPerPixel(format) {
        // Subclasses should override with format-specific logic
        return 4;
    }
}