
export class GLContextPool {
    static _instance = null;
    static getInstance() {
      if (!GLContextPool._instance) {
        GLContextPool._instance = new GLContextPool();
      }
      return GLContextPool._instance;
    }
  
    constructor(maxContexts = 2) {
      this.maxContexts = maxContexts;
      this.pool = [];
    }
  
    /**
     * Get a shared WebGL context from the pool.
     * Creates a new one if below maxContexts, otherwise returns the least used one.
     */
    acquire(width = 128, height = 128) {
      // Try to find an existing context
      for (const ctx of this.pool) {
        if (!ctx.inUse) {
          ctx.inUse = true;
          if (ctx.glCanvas.width !== width || ctx.glCanvas.height !== height) {
            ctx.glCanvas.width = width;
            ctx.glCanvas.height = height;
          }
          return ctx;
        }
      }
    
      // If pool not full, create a new shared context
      if (this.pool.length < this.maxContexts) {
        const glCanvas = document.createElement('canvas');
        glCanvas.width = width;
        glCanvas.height = height;
        const gl = glCanvas.getContext('webgl2', {
          premultipliedAlpha: false,
          preserveDrawingBuffer: false,
        });
        if (!gl) throw new Error('WebGL2 not supported or failed to initialize');
        const entry = { gl, glCanvas, inUse: true };
        this.pool.push(entry);
        return entry;
      }
    
      // Otherwise reuse first available context (round-robin)
      const ctx = this.pool[0];
      ctx.inUse = true;
      // Resize for new usage
      if (ctx.glCanvas.width !== width || ctx.glCanvas.height !== height) {
        ctx.glCanvas.width = width;
        ctx.glCanvas.height = height;
      }
      return ctx;
    }
  
    release(ctx) {
      if (!ctx) return;
      ctx.inUse = false;
    }
  
    disposeAll() {
      for (const ctx of this.pool) {
        if (!ctx.gl) continue;
        const ext = ctx.gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
        ctx.gl = null;
        ctx.glCanvas = null;
      }
      this.pool.length = 0;
    }
  }
  
export function getAllProceduralVariantsForLevel(level, textureConfig, seasons) {
  if (!textureConfig) {
    throw new Error('getAllProceduralVariantsForLevel requires textureConfig');
  }
  if (!seasons) {
    throw new Error('getAllProceduralVariantsForLevel requires seasons');
  }
  const variants = [];

  for (const entry of textureConfig) {
    if (!entry.textures?.base) continue;

    for (const season of Object.values(seasons)) {
      const seasonCfg = entry.textures.base[season];
      if (!seasonCfg || !seasonCfg[level]) continue;

      const layerSets = seasonCfg[level];
      for (let variantIdx = 0; variantIdx < layerSets.length; variantIdx++) {
        variants.push({
          tileType: entry.id,
          season,
          variant: variantIdx,
          level,
          layers: layerSets[variantIdx],
        }); 

      }
    }
  }

  return variants;
}
import * as THREE from "three";

export class ProceduralTextureGenerator {
  constructor(width = 128, height = 128) {
    this.width = width;
    this.height = height;
    this.layers = [];
  
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  
    // Create dedicated WebGL canvas (no pooling)
    this.glCanvas = document.createElement('canvas');
    this.glCanvas.width = width;
    this.glCanvas.height = height;
    this.gl = this.glCanvas.getContext('webgl2', {
      premultipliedAlpha: false,
      preserveDrawingBuffer: true, // Need this to read back pixels
    });
  
    this.pool = null;
    this.poolCtx = null;
    this.program = null;
    this.attribs = {};
    this.uniforms = {};
    this.seamlessConfig = {
      enabled: true,
      blendRadius: 4,
      blendStrength: 1.0,
      method: 'quad-symmetric',
      cornerBlend: true
    };
  
    if (this.gl) {
      this._initGL();
    } else {
      
    }
  }
  
  dispose() {
    // No pooling to release
    try {
      if (this.gl) {
        try { if (this._quadBuffer) this.gl.deleteBuffer(this._quadBuffer); } catch(e) {}
        try { if (this.program) this.gl.deleteProgram(this.program); } catch(e) {}
        
        const loseExt = this.gl.getExtension('WEBGL_lose_context');
        if (loseExt) loseExt.loseContext();
      }
    } catch (err) {
      
    } finally {
      this.program = null;
      this.attribs = {};
      this.uniforms = {};
      this.gl = null;
      this._quadBuffer = null;
      
      if (this.glCanvas) {
        this.glCanvas.width = this.glCanvas.height = 1; // Don't set to 0
        this.glCanvas = null;
      }
      if (this.canvas) {
        this.canvas.width = this.canvas.height = 1;
        this.ctx = null;
        this.canvas = null;
      }
      this.layers = [];
    }
  }

    addLayer(config) {
      this.layers.push(Object.assign({}, config));
    }
    
    removeLayer(idx) {
      this.layers.splice(idx, 1);
    }
    
    clearLayers() {
      this.layers.length = 0;
    }
    
    generate() {
      // Ensure canvas has valid dimensions
      if (this.canvas.width === 0 || this.canvas.height === 0) {
          this.canvas.width = this.width;
          this.canvas.height = this.height;
      }
      
      this.ctx.clearRect(0, 0, this.width, this.height);
      this.ctx.fillStyle = 'black';
      this.ctx.fillRect(0, 0, this.width, this.height); // Fill with black as base
  
      if (this.gl) {
          try {
              this._generateGPUComposited();
              return this._makeSeamless(this.canvas, this.seamlessConfig);
          } catch (err) {
              
          }
      }
      
      // CPU fallback - process layers manually
      for (const layer of this.layers) {
          this._processLayerCPU(layer);
      }
  
      return this._makeSeamless(this.canvas, this.seamlessConfig);
  }
        _initGL() {
          try {
            // Don't get context again - we already have it from the pool!
            const gl = this.gl;
            if (!gl) {
              
              return;
            }
            
            // Ensure viewport matches canvas size
            gl.viewport(0, 0, this.glCanvas.width, this.glCanvas.height);
    
        const vsSrc = `#version 300 es
          in vec2 a_position;
          out vec2 v_uv;
          void main() {
            v_uv = a_position * 0.5 + 0.5;
            gl_Position = vec4(a_position, 0.0, 1.0);
          }`;
    
        const fsSrc = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;

uniform vec2 u_resolution;
uniform float u_seed;
uniform int u_noiseType;
uniform int u_octaves;
uniform float u_frequency;
uniform float u_amplitude;
uniform float u_persistence;
uniform float u_rotation;
uniform float u_turbulencePower;
uniform float u_ridgeOffset;
uniform float u_warpStrength;
uniform float u_warpFrequency;
uniform float u_cellScale;
uniform float u_cellRandomness;
uniform float u_cellElongation;
uniform vec2 u_cellStretch;
uniform vec3 u_color;
uniform int u_dashCount;
uniform vec4 u_dashParams[64];
uniform vec4 u_dashParams2[64];

// Hash functions for voronoi/cells
uint wangHash(uint x) {
  x = (x ^ 61u) ^ (x >> 16);
  x *= 9u;
  x = x ^ (x >> 4);
  x *= 0x27d4eb2du;
  x = x ^ (x >> 15);
  return x;
}

float hhash(vec2 p) {
  uint x = uint(floatBitsToUint(p.x) ^ floatBitsToUint(p.y));
  return float(wangHash(x)) / 4294967295.0;
}

// Sin-free hash — avoids the banding/circle artifacts of sin-based hashes
float rand(vec2 p) {
  vec3 p3 = fract(vec3(p.x + u_seed * 0.1731, p.y + u_seed * 0.3049, p.x + u_seed * 0.2137) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// CPU-matching smoothstep (cubic)
float smoothstep_cpu(float a, float b, float t) {
  float x = clamp((t - a) / (b - a), 0.0, 1.0);
  return x * x * (3.0 - 2.0 * x);
}

// Value noise matching CPU's gradNoise
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  
  float u = smoothstep_cpu(0.0, 1.0, f.x);
  float v = smoothstep_cpu(0.0, 1.0, f.y);
  
  float a = rand(i);
  float b = rand(i + vec2(1.0, 0.0));
  float c = rand(i + vec2(0.0, 1.0));
  float d = rand(i + vec2(1.0, 1.0));
  
  float val = mix(mix(a, b, u), mix(c, d, u), v);
  return val * 2.0 - 1.0;
}

// Lenticel-shaped SDF (tapered ellipse)
float sdLenticel(vec2 p, vec2 pos, vec2 size, float angle) {
  p -= pos;
  float c = cos(angle);
  float s = sin(angle);
  mat2 R = mat2(c, s, -s, c);
  p = R * p;
  
  // Normalize to ellipse space
  p = p / size;
  
  // Taper the ends - creates the characteristic lenticel shape
  float endFactor = 1.0 - smoothstep(0.6, 1.0, abs(p.x));
  float verticalScale = 0.3 + 0.7 * endFactor;
  
  // Recompute with tapered vertical scale
  vec2 pTapered = vec2(p.x, p.y / verticalScale);
  float dist = length(pTapered) - 1.0;
  
  return dist * min(size.x, size.y);
}

// Irregular dash with procedural edges
float irregularDash(vec2 p, vec2 pos, vec2 size, float angle, float irregularity, float seed) {
  float dist = sdLenticel(p, pos, size, angle);
  
  // Add organic irregularity to edges
  vec2 noisePos = (p - pos) * 8.0;
  float noise1 = valueNoise(noisePos + vec2(seed * 7.3, seed * 3.1)) * irregularity;
  float noise2 = valueNoise(noisePos * 2.3 + vec2(seed * 2.7, seed * 8.9)) * irregularity * 0.5;
  
  dist += (noise1 + noise2) * size.y * 2.0;
  
  return 1.0 - smoothstep(-1.0, 1.0, dist);
}
  
// FBM
float fbm(vec2 p, int oct, float persistence) {
  float value = 0.0;
  float amp = 1.0;
  float freq = 1.0;
  float maxv = 0.0;
  
  for (int i = 0; i < 16; i++) {
    if (i >= oct) break;
    value += amp * valueNoise(p * freq + vec2(u_seed, u_seed));
    maxv += amp;
    amp *= persistence;
    freq *= 2.0;
  }
  return value / maxv;
}

// --- MODIFICATION 1: computeDashes now returns vec4 (color + alpha) ---
// It also handles texture wrapping and intra-dash color variation.
vec4 computeDashes(vec2 coord) {
  vec4 result = vec4(0.0); // r, g, b, a
  
  for (int i = 0; i < 64; i++) {
    if (i >= u_dashCount) break;
    
    vec4 params = u_dashParams[i];
    vec4 params2 = u_dashParams2[i];
    
    vec2 pos = params.xy;
    vec2 size = params.zw;
    float angle = params2.x;
    float irregularity = params2.y;
    float alpha = params2.z;
    float seed = float(i) * 123.456 + u_seed;
    
    float dash = 0.0;

    // --- MODIFICATION 2: 9-tap texture wrapping ---
    // This checks the current pixel against the dash center AND
    // all 8 of its "wrapped" neighbors to ensure seamless tiling.
    for (int j = -1; j <= 1; j++) {
      for (int k = -1; k <= 1; k++) {
        vec2 offset = vec2(float(k), float(j)) * u_resolution;
        vec2 currentPos = pos + offset;
        float currentDash = irregularDash(coord, currentPos, size, angle, irregularity, seed);
        
        float newAlpha = currentDash * alpha;
        
        // --- MODIFICATION 3: Intra-dash color & "Top" dash selection ---
        // If this dash is "stronger" (more visible) than the previous max,
        // replace it and calculate its unique color.
        if (newAlpha > result.a) {
          // Add noise for intra-lenticel color variation
          float colorNoise = valueNoise((coord - currentPos) * 0.3 + seed * 9.1);
          colorNoise = (colorNoise + 1.0) * 0.5; // remap -1..1 to 0..1
          colorNoise = 0.7 + 0.3 * colorNoise;   // remap to 0.7..1.0 (darkens base color)

          vec3 dashColor = u_color * colorNoise;
          result = vec4(dashColor, newAlpha);
        }
      }
    }
  }
  return result;
}

// Turbulence
float turbulence(vec2 p, int oct, float persistence, float power) {
  float v = 0.0;
  float amp = 1.0;
  float freq = 1.0;
  float maxv = 0.0;
  
  for (int i = 0; i < 16; i++) {
    if (i >= oct) break;
    float n = valueNoise(p * freq + vec2(u_seed * 100.0, u_seed * 100.0));
    v += pow(abs(n), power) * amp;
    maxv += amp;
    amp *= persistence;
    freq *= 2.0;
  }
  return clamp(v / maxv, 0.0, 1.0);
}

// Ridged
float ridged(vec2 p, int oct, float persistence, float offset) {
  float v = 0.0;
  float amp = 1.0;
  float freq = 1.0;
  float maxv = 0.0;
  
  for (int i = 0; i < 16; i++) {
    if (i >= oct) break;
    float n = abs(valueNoise(p * freq + vec2(u_seed * 200.0, u_seed * 200.0)));
    n = offset - n;
    n = n * n;
    v += n * amp;
    maxv += amp;
    amp *= persistence;
    freq *= 2.0;
  }
  return clamp(v / maxv, 0.0, 1.0);
}

// Voronoi
float voronoi(vec2 p, float randomness) {
  vec2 i = floor(p);
  float minD = 1e6;
  for (int j = -1; j <= 1; j++) {
    for (int i2 = -1; i2 <= 1; i2++) {
      vec2 neighbor = vec2(float(i2), float(j));
      vec2 point = vec2(
        hhash(i + neighbor + vec2(12.34 * u_seed)),
        hhash(i + neighbor + vec2(56.78 * u_seed))
      );
      point = 0.5 + 0.5 * sin(point * randomness * 6.2831853);
      vec2 diff = neighbor + point - fract(p);
      minD = min(minD, length(diff));
    }
  }
  return minD;
}

// Cell pattern
float cellPattern(vec2 p, float scale, float randomness, float elongation, vec2 stretch) {
  p *= stretch * scale;
  vec2 i = floor(p);
  float min1 = 1e6, min2 = 1e6;
  
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec2 nb = vec2(float(x), float(y));
      vec2 pt = vec2(hhash(i + nb), hhash(i + nb + vec2(5.3)));
      pt = 0.5 + 0.5 * sin(pt * randomness * 6.2831853);
      vec2 diff = nb + pt - fract(p);
      float dist = length(diff);
      if (dist < min1) {
        min2 = min1;
        min1 = dist;
      } else if (dist < min2) {
        min2 = dist;
      }
    }
  }
  float cell = min2 - min1;
  return smoothstep(elongation - 0.1, elongation + 0.1, cell);
}

// Rotation helper
vec2 rotateCoord(vec2 uv, float ang) {
  vec2 center = u_resolution * 0.5;
  vec2 p = uv * u_resolution - center;
  float c = cos(ang), s = sin(ang);
  p = mat2(c, -s, s, c) * p;
  return (p + center) / u_resolution;
}

void main() {

  vec2 coord = v_uv * u_resolution;
  
  if (u_rotation != 0.0) {
    coord = rotateCoord(v_uv, u_rotation) * u_resolution;
  }
  
  // Match CPU coordinate calculation
  float maxDim = max(u_resolution.x, u_resolution.y);
  float px = coord.x / maxDim;
  float py = coord.y / maxDim;
  
  float nx = px * u_frequency * u_resolution.x + u_seed;
  float ny = py * u_frequency * u_resolution.y + u_seed;
  vec2 p = vec2(nx, ny);
  
  
  // Domain warping
  if (u_warpStrength > 0.0) {
    vec2 q = vec2(
      fbm(p * u_warpFrequency, 3, 0.5),
      fbm(p * u_warpFrequency + vec2(5.2, 1.3), 3, 0.5)
    );
    p += q * u_warpStrength;
  }
  
  float val = 0.0;
  
  if (u_noiseType == 0) { // perlin
    val = valueNoise(p);
    val = (val + 1.0) * 0.5;
  } else if (u_noiseType == 1) { // fbm
    val = fbm(p, u_octaves, u_persistence);
    val = (val + 1.0) * 0.5;
  } else if (u_noiseType == 2) { // turbulence
    val = turbulence(p, u_octaves, u_persistence, u_turbulencePower);
  } else if (u_noiseType == 3) { // ridged
    val = ridged(p, u_octaves, u_persistence, u_ridgeOffset);
  } else if (u_noiseType == 4) { // voronoi
    val = voronoi(p * u_cellScale, u_cellRandomness);
  } else if (u_noiseType == 5) { // cells
    val = cellPattern(p, u_cellScale, u_cellRandomness, u_cellElongation, u_cellStretch);
  } 
    
  // --- MODIFICATION 4: Handle the vec4 return from computeDashes ---
  if (u_noiseType == 6) {
    // Lenticels (horizontal dashes)
    vec4 dashVal = computeDashes(coord);
    outColor = vec4(dashVal.rgb, dashVal.a); // Use the computed color and alpha
  } else {
    val = clamp(val * u_amplitude, 0.0, 1.0);
    outColor = vec4(val * u_color, 1.0); // Opaque for noise layers
  }

}
        `;
            
                      const vs = this._compileShader(gl, gl.VERTEX_SHADER, vsSrc);
                      const fs = this._compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
    
                      const prog = gl.createProgram();
                      gl.attachShader(prog, vs);
                      gl.attachShader(prog, fs);
                      gl.bindAttribLocation(prog, 0, 'a_position');
                      gl.linkProgram(prog);
                      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
                        this.gl = null;
                        return;
                      }
                      this.program = prog;
    
                      this._quadBuffer = gl.createBuffer();
                      gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuffer);
                      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
                        -1, -1, 1, -1, -1, 1, 1, 1
                      ]), gl.STATIC_DRAW);
    
                      const getLoc = (name) => gl.getUniformLocation(prog, name);
    
                      this.attribs.a_position = 0;
                      this.uniforms = {
                        u_dashCount: getLoc('u_dashCount'),
                        u_dashParams: getLoc('u_dashParams'),
                        u_dashParams2: getLoc('u_dashParams2'),
                        u_color: getLoc('u_color'),
                        u_resolution: getLoc('u_resolution'),
                        u_seed: getLoc('u_seed'),
                        u_noiseType: getLoc('u_noiseType'),
                        u_octaves: getLoc('u_octaves'),
                        u_frequency: getLoc('u_frequency'),
                        u_amplitude: getLoc('u_amplitude'),
                        u_persistence: getLoc('u_persistence'),
                        u_rotation: getLoc('u_rotation'),
                        u_turbulencePower: getLoc('u_turbulencePower'),
                        u_ridgeOffset: getLoc('u_ridgeOffset'),
                        u_warpStrength: getLoc('u_warpStrength'),
                        u_warpFrequency: getLoc('u_warpFrequency'),
                        u_cellScale: getLoc('u_cellScale'),
                        u_cellRandomness: getLoc('u_cellRandomness'),
                        u_cellElongation: getLoc('u_cellElongation'),
                        u_cellStretch: getLoc('u_cellStretch')
                      };
    
                      gl.disable(gl.BLEND);
                    } catch (err) {
                      
                      this.gl = null;
                    }
                  }
    
                  _compileShader(gl, type, source) {
                    const shader = gl.createShader(type);
                    gl.shaderSource(shader, source);
                    gl.compileShader(shader);
                    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                      const info = gl.getShaderInfoLog(shader);
                      gl.deleteShader(shader);
                      throw new Error('Shader compile error: ' + info);
                    }
                    return shader;
                  }
    
                  _generateGPUComposited() {
                    const gl = this.gl;
                    const prog = this.program;
                    if (!gl || !prog) throw new Error('GL not initialized');
    
                    gl.viewport(0, 0, this.width, this.height);
    
                    gl.useProgram(prog);
                    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuffer);
                    gl.enableVertexAttribArray(this.attribs.a_position || 0);
                    gl.vertexAttribPointer(this.attribs.a_position || 0, 2, gl.FLOAT, false, 0, 0);
    
                    for (let li = 0; li < this.layers.length; li++) {
                      const layer = this.layers[li] || {};
    
                      if (layer.type === 'fill') {
                        const temp = document.createElement('canvas');
                        temp.width = this.width;
                        temp.height = this.height;
                        const tctx = temp.getContext('2d');
                        tctx.fillStyle = layer.color || '#ffffff';
                        //tctx.fillRect(0, 0, this.width, this.height);
                        this._compositeLayerCanvas(temp, layer);
                        continue;
                      }

                      if (layer.type === 'leaf_cluster_mask') {
                        const maskCanvas = this._generateLeafClusterMask(layer);
                        this._compositeLayerCanvas(maskCanvas, layer);
                        continue;
                    }
    
                      if (layer.type === 'custom_leaf_shape') {
                        const leafCanvas = this._generateLeafShapeCPU(layer);
                        this._compositeLayerCanvas(leafCanvas, layer);
                        continue;
                      }
                        // NEW: handle GPU lenticels directly
                        if (layer.type === 'horizontal_dashes') {
                            this._renderDashesGPU(layer);
                            continue;
                        }
                        
                        // Grass billboard generation
                        if (layer.type === 'grass_billboard') {
                            const billboardCanvas = this._generateGrassBillboard(layer);
                            this._compositeLayerCanvas(billboardCanvas, layer);
                            continue;
                        }
    
                      gl.useProgram(prog);
    
                      const setIf = (loc, fn) => { if (loc) fn(); };
                      const { r, g, b } = this._hexToRgb(layer.color || '#ffffff');
                      gl.uniform3f(this.uniforms.u_color, r/255, g/255, b/255);
                      setIf(this.uniforms.u_resolution, () =>
                          gl.uniform2f(this.uniforms.u_resolution, this.width, this.height)
                      );
                      setIf(this.uniforms.u_seed, () =>
                          gl.uniform1f(this.uniforms.u_seed, (layer.seed || 0) )
                      );
                      setIf(this.uniforms.u_noiseType, () =>
                          gl.uniform1i(this.uniforms.u_noiseType, this._noiseTypeIndex(layer.type))
                      );
                      setIf(this.uniforms.u_octaves, () =>
                          gl.uniform1i(this.uniforms.u_octaves, layer.octaves ?? 4)
                      );
                      setIf(this.uniforms.u_frequency, () =>
                          gl.uniform1f(this.uniforms.u_frequency, layer.frequency ?? 0.01)
                      );
                      setIf(this.uniforms.u_amplitude, () =>
                          gl.uniform1f(this.uniforms.u_amplitude, layer.amplitude ?? 1.0)
                      );
                      setIf(this.uniforms.u_persistence, () =>
                          gl.uniform1f(this.uniforms.u_persistence, layer.persistence ?? 0.5)
                      );
                      setIf(this.uniforms.u_rotation, () =>
                          gl.uniform1f(this.uniforms.u_rotation, (layer.rotation || 0) * Math.PI / 180.0)
                      );
                      setIf(this.uniforms.u_turbulencePower, () =>
                          gl.uniform1f(this.uniforms.u_turbulencePower, layer.turbulencePower ?? 1.0)
                      );
                      setIf(this.uniforms.u_ridgeOffset, () =>
                          gl.uniform1f(this.uniforms.u_ridgeOffset, layer.ridgeOffset ?? 0.5)
                      );
                      setIf(this.uniforms.u_warpStrength, () =>
                          gl.uniform1f(this.uniforms.u_warpStrength, layer.domainWarp ? (layer.warpStrength ?? 0) : 0.0)
                      );
                      setIf(this.uniforms.u_warpFrequency, () =>
                          gl.uniform1f(this.uniforms.u_warpFrequency, layer.warpFrequency ?? 0.02)
                      );
                      setIf(this.uniforms.u_cellScale, () =>
                          gl.uniform1f(this.uniforms.u_cellScale, layer.cellScale ?? 1.0)
                      );
                      setIf(this.uniforms.u_cellRandomness, () =>
                          gl.uniform1f(this.uniforms.u_cellRandomness, layer.cellRandomness ?? 1.0)
                      );
                      setIf(this.uniforms.u_cellElongation, () =>
                          gl.uniform1f(this.uniforms.u_cellElongation, layer.cellElongation ?? 0.5)
                      );
                      const stretch = layer.cellStretch ?? [1.0, 1.0];
                      setIf(this.uniforms.u_cellStretch, () =>
                          gl.uniform2f(this.uniforms.u_cellStretch, stretch[0], stretch[1])
                      );
    
                      gl.clearColor(0,0,0,0);
                      gl.clear(gl.COLOR_BUFFER_BIT);
                      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    
                      this._compositeGLCanvasTo2D(layer);
                    }
                  }
                  _compositeGLCanvasTo2D(layer) {
                    const tmpCanvas = document.createElement('canvas');
                    tmpCanvas.width = this.width;
                    tmpCanvas.height = this.height;
                    const tmpCtx = tmpCanvas.getContext('2d');
                    tmpCtx.drawImage(this.glCanvas, 0, 0, this.width, this.height);
                    
                    const testData = tmpCtx.getImageData(0, 0, this.width, this.height).data;
                    const samplePixels = [];
                    for (let i = 0; i < 8; i++) {
                        samplePixels.push(`[${testData[i*4]},${testData[i*4+1]},${testData[i*4+2]},${testData[i*4+3]}]`);
                    }
                    
                    this._compositeLayerCanvas(tmpCanvas, layer);
                }
    
                  _compositeLayerCanvas(layerCanvas, layer) {
                    const ctx = this.ctx;
                    const prevGlobalCompositeOperation = ctx.globalCompositeOperation;
                    const prevAlpha = ctx.globalAlpha;
    
                    ctx.globalAlpha = (typeof layer.opacity === 'number') ? layer.opacity : 1.0;
                    ctx.globalCompositeOperation = this._blendModeToCompositeOp(layer.blendMode);
    
                    ctx.drawImage(layerCanvas, 0, 0, this.width, this.height);
    
                    ctx.globalCompositeOperation = prevGlobalCompositeOperation;
                    ctx.globalAlpha = prevAlpha;
                  }
    
                  _generateLeafClusterMask(layer) {
                    const c = document.createElement('canvas');
                    c.width = this.width;
                    c.height = this.height;
                    const ctx = c.getContext('2d');
                    ctx.clearRect(0, 0, this.width, this.height);
                    ctx.fillStyle = "rgba(0,0,0,0)";
                  
                    const clusterCount = layer.clusterCount ?? 6;
                    const minScale = layer.minScale ?? 0.5;
                    const maxScale = layer.maxScale ?? 1.0;
                  
                    for (let i=0; i<clusterCount; i++) {
                      const scale = minScale + Math.random()*(maxScale-minScale);
                      const w = this.width * 0.25 * scale;
                      const h = this.height * 0.33 * scale;
                      const cx = Math.random() * this.width;
                      const cy = Math.random() * this.height;
                      const rotation = (Math.random()-0.5)*Math.PI*0.8;
                  
                      ctx.save();
                      ctx.translate(cx, cy);
                      ctx.rotate(rotation);
                  
                      // Reuse simple birch leaf shape
                      ctx.beginPath();
                      ctx.moveTo(0,-h);
                      for (let t=0;t<=20;t++) {
                        const tt = t/20;
                        const bx = -w*Math.sin(tt*Math.PI)*(1-tt*0.3);
                        const by = -h+h*1.8*tt;
                        ctx.lineTo(bx,by);
                      }
                      for (let t=20;t>=0;t--) {
                        const tt = t/20;
                        const bx =  w*Math.sin(tt*Math.PI)*(1-tt*0.3);
                        const by = -h+h*1.8*tt;
                        ctx.lineTo(bx,by);
                      }
                      ctx.closePath();
                  
                      const g = ctx.createRadialGradient(0,0,0,0,0,Math.max(w,h));
                      g.addColorStop(0,'rgba(255,255,255,1)');
                      g.addColorStop(0.8,'rgba(255,255,255,1)');
                      g.addColorStop(1,'rgba(255,255,255,0)');
                      ctx.fillStyle = g;
                      ctx.fill();
                  
                      ctx.restore();
                    }
                  
                    return c;
                  }
    
_renderDashesGPU(layer) {
    const gl = this.gl;
    const prog = this.program;
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const density = layer.density ?? 0.15;
    const minWidth = layer.minWidth ?? 0.15;
    const maxWidth = layer.maxWidth ?? 0.35;
    const minHeight = layer.minHeight ?? 0.02;
    const maxHeight = layer.maxHeight ?? 0.06;
    const irregularity = layer.irregularity ?? 0.3;
    const seed = layer.seed ?? 0;
    

    // Scale density based on actual texture size vs reference size (128x128)
const referenceSize = 128;
const sizeScale = (this.width * this.height) / (referenceSize * referenceSize);
const numDashes = Math.min(256, Math.floor(density * 100 * sizeScale));
    
    const params = [];
    const params2 = [];
    for (let i = 0; i < numDashes; i++) {
        // Match the shader's rand() function exactly
        const rand = (x, y, seedOffset) => {
          const pm_x = x % 2048.0;
          const pm_y = y % 2048.0;
          const s = Math.sin(pm_x * 127.1 + pm_y * 311.7 + ((seed + seedOffset) * 13.13) % 2048.0) * 43758.5453123;
          return s - Math.floor(s);
        };
        
        const x = rand(i, 0, 1) * this.width;
        const y = rand(i, 1, 2) * this.height;
        const w = (minWidth + rand(i, 2, 3) * (maxWidth - minWidth)) * this.width;
        const h = (minHeight + rand(i, 3, 4) * (maxHeight - minHeight)) * this.height;
        const rotation = (rand(i, 4, 5) - 0.5) * 0.2;
        const alpha = 0.5 + rand(i, 12, 13) * 0.5;
        
        params.push(x, y, w * 0.5, h * 0.5);
        params2.push(rotation, irregularity, alpha, 0);
      }
    // Pad arrays for the shader
    while (params.length < 256) params.push(0, 0, 0, 0);
    while (params2.length < 256) params2.push(0, 0, 0, 0);
    
    gl.useProgram(prog);
    
    const { r, g, b } = this._hexToRgb(layer.color || '#2a2a2a');
    gl.uniform3f(this.uniforms.u_color, r/255, g/255, b/255);
    gl.uniform2f(this.uniforms.u_resolution, this.width, this.height);
    gl.uniform1f(this.uniforms.u_seed, seed);
    gl.uniform1i(this.uniforms.u_noiseType, 6); // 6 is horizontal_dashes
    gl.uniform1i(this.uniforms.u_dashCount, numDashes);
    gl.uniform1f(this.uniforms.u_frequency, 1.0);
    gl.uniform1f(this.uniforms.u_amplitude, 1.0);
    
    gl.uniform4fv(this.uniforms.u_dashParams, params);
    gl.uniform4fv(this.uniforms.u_dashParams2, params2);
    
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.BLEND);
    this._compositeGLCanvasTo2D(layer);
  }
                  _generateLeafShapeCPU(layer) {
                    const c = document.createElement('canvas');
                    c.width = this.width;
                    c.height = this.height;
                    const ctx = c.getContext('2d');
    
                    ctx.clearRect(0,0,this.width,this.height);
    
                    const shape = layer.shape || 'oak';
                    ctx.fillStyle = 'rgba(255,255,255,1)';
    
                    if (shape === 'oak') {
                      const cx = this.width/2, cy = this.height/2;
                      ctx.beginPath();
                      ctx.moveTo(cx, cy + this.height*0.45);
                      for (let i=0;i<8;i++) {
                        const a = (i/8) * Math.PI * 2;
                        const r = this.width * (0.18 + 0.05 * Math.sin(i*3.2));
                        const x = cx + Math.cos(a) * r;
                        const y = cy + Math.sin(a) * r * 1.2;
                        if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
                      }
                      ctx.closePath();
                      const g = ctx.createRadialGradient(cx,cy,0,cx,cy,Math.max(this.width,this.height));
                      g.addColorStop(0,'rgba(255,255,255,1)');
                      g.addColorStop(0.8,'rgba(255,255,255,1)');
                      g.addColorStop(1,'rgba(255,255,255,0)');
                      ctx.fillStyle = g;
                      ctx.fill();
                    } else if (shape === 'birch') {
                      for (let i=0;i<4;i++) {
                        const scale = 0.6 + Math.random()*0.4;
                        const w = this.width * 0.3 * scale;
                        const h = this.height * 0.45 * scale;
                        const cx = this.width/2 + (Math.random()-0.5) * this.width*0.25;
                        const cy = this.height/2 + (Math.random()-0.5) * this.height*0.25;
                        ctx.save();
                        ctx.translate(cx,cy);
                        ctx.rotate((Math.random()-0.5)*0.8);
                        ctx.beginPath();
                        ctx.moveTo(0,-h);
                        for (let t=0;t<=20;t++) {
                          const tt = t/20;
                          const bx = -w*Math.sin(tt*Math.PI)*(1-tt*0.3);
                          const by = -h + h*1.8*tt;
                          ctx.lineTo(bx,by);
                        }
                        for (let t=20;t>=0;t--) {
                          const tt = t/20;
                          const bx = w*Math.sin(tt*Math.PI)*(1-tt*0.3);
                          const by = -h + h*1.8*tt;
                          ctx.lineTo(bx,by);
                        }
                        ctx.closePath();
                        const g = ctx.createRadialGradient(0,0,0,0,0,Math.max(w,h));
                        g.addColorStop(0,'rgba(255,255,255,1)');
                        g.addColorStop(0.8,'rgba(255,255,255,1)');
                        g.addColorStop(1,'rgba(255,255,255,0)');
                        ctx.fillStyle = g;
                        ctx.fill();
                        ctx.restore();
                      }
                    } else {
                      ctx.beginPath();
                      ctx.ellipse(this.width/2, this.height/2, this.width*0.35, this.height*0.4, 0, 0, Math.PI*2);
                      const g = ctx.createRadialGradient(this.width/2,this.height/2,0,this.width/2,this.height/2,Math.max(this.width,this.height));
                      g.addColorStop(0,'rgba(255,255,255,1)');
                      g.addColorStop(0.8,'rgba(255,255,255,1)');
                      g.addColorStop(1,'rgba(255,255,255,0)');
                      ctx.fillStyle = g;
                      ctx.fill();
                    }
    
                    return c;
                  }
    
                  _hexToRgb(hex) {
                    const res = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '#ffffff');
                    if (!res) return { r:255,g:255,b:255 };
                    return { r: parseInt(res[1],16), g: parseInt(res[2],16), b: parseInt(res[3],16) };
                  }
    
                  _noiseTypeIndex(type) {
                    const map = {
                      perlin: 0,
                      fbm: 1,
                      turbulence: 2,
                      ridged: 3,
                      voronoi: 4,
                      cells: 5,
                      horizontal_dashes: 6  
                    };
                    return map[type] ?? 1;
                  }
    
                  _blendModeToCompositeOp(mode) {
                    switch ((mode || 'normal')) {
                      case 'multiply': return 'multiply';
                      case 'screen': return 'screen';
                      case 'overlay': return 'overlay';
                      case 'lighter': return 'lighter';
                      case 'destination-in': return 'destination-in';
                      case 'source-in': return 'source-in';
                      default: return 'source-over';
                    }
                  }
                  dispose() {
                    try {
                      if (this.gl) {
                        // Delete GL resources if present
                        try { if (this._quadBuffer) this.gl.deleteBuffer(this._quadBuffer); } catch(e) {}
                        try { if (this.program) this.gl.deleteProgram(this.program); } catch(e) {}
                        // shaders were compiled but not kept as properties; if you keep them store and delete them too
                  
                        // try to lose the context (supported in most browsers)
                        const loseExt = this.gl.getExtension && this.gl.getExtension('WEBGL_lose_context');
                        if (loseExt) {
                          loseExt.loseContext();
                        }
                      }
                    } catch (err) {
                      
                    } finally {
                      // Remove references so GC can collect
                      this.program = null;
                      this.attribs = {};
                      this.uniforms = {};
                      this.gl = null;
                      this._quadBuffer = null;
                  
                      // shrink canvas to release internal buffers
                      if (this.glCanvas) {
                        this.glCanvas.width = this.glCanvas.height = 0;
                        // it's fine if canvas is not in DOM; clear reference
                        this.glCanvas = null;
                      }
                      if (this.canvas) {
                        this.canvas.width = this.canvas.height = 0;
                        this.ctx = null;
                        this.canvas = null;
                      }
                      // clear layers
                      this.layers = [];
                    }
                  }
                  
                  /**
                   * Generate grass billboard texture
                   * @param {Object} layer - Layer configuration
                   * @returns {HTMLCanvasElement} Generated billboard canvas
                   */
                  _generateGrassBillboard(layer) {
                    const c = document.createElement('canvas');
                    c.width = this.width;
                    c.height = this.height;
                    const ctx = c.getContext('2d');
                    
                    // Clear background
                    ctx.clearRect(0, 0, this.width, this.height);
                    
                    // Get grass parameters
                    const grassType = layer.grassType || 'meadow';
                    const height = layer.height || 0.6;
                    const density = layer.density || 'medium';
                    const seed = layer.seed || 12345;
                    
                    // Create seeded random
                    let rngSeed = seed;
                    const seededRandom = () => {
                        rngSeed = (rngSeed * 9301 + 49297) % 233280;
                        return rngSeed / 233280;
                    };
                    
                    // Determine grass colors based on type
                    const grassColors = this._getGrassColors(grassType);
                    
                    // Determine blade count based on density
                    const densityMap = { 'high': 25, 'medium': 15, 'low': 8 };
                    const bladeCount = densityMap[density] || 15;
                    
                    // Draw grass blades
                    for (let i = 0; i < bladeCount; i++) {
                        this._drawGrassBlade(ctx, {
                            x: seededRandom() * this.width,
                            y: this.height * 0.8 + seededRandom() * this.height * 0.2,
                            height: height * this.height * (0.7 + seededRandom() * 0.6),
                            width: 2 + seededRandom() * 4,
                            bend: (seededRandom() - 0.5) * 0.3,
                            color: grassColors[Math.floor(seededRandom() * grassColors.length)],
                            rng: seededRandom
                        });
                    }
                    
                    return c;
                  }
                  
                  /**
                   * Get color palette for grass type
                   * @param {string} grassType - Type of grass
                   * @returns {Array<string>} Array of color strings
                   */
                  _getGrassColors(grassType) {
                    const colorSets = {
                        meadow: ['#4a7c2a', '#5a8c3a', '#6fa040', '#3d6b25'],
                        tall: ['#3d6b25', '#2d5b15', '#5d8b35', '#4a7c2a'],
                        short: ['#4f7d30', '#6f9d50', '#7fa055', '#5a8c3a'],
                        wild: ['#456728', '#65873a', '#6b4423', '#4a7c2a']
                    };
                    return colorSets[grassType] || colorSets.meadow;
                  }
                  
                  /**
                   * Draw a single grass blade
                   * @param {CanvasRenderingContext2D} ctx - Canvas context
                   * @param {Object} params - Blade parameters
                   */
                  _drawGrassBlade(ctx, params) {
                    const { x, y, height, width, bend, color, rng } = params;
                    
                    ctx.save();
                    
                    // Set up blade style
                    ctx.strokeStyle = color;
                    ctx.lineWidth = width;
                    ctx.lineCap = 'round';
                    ctx.lineJoin = 'round';
                    
                    // Draw blade with natural curve
                    ctx.beginPath();
                    ctx.moveTo(x, y);
                    
                    const segments = 4;
                    for (let i = 1; i <= segments; i++) {
                        const t = i / segments;
                        const bendAmount = bend * t * t; // Quadratic bend
                        const segmentX = x + bendAmount * height * 0.3;
                        const segmentY = y - (height * t);
                        
                        // Add slight random variation
                        const variation = (rng() - 0.5) * width * 0.3;
                        
                        if (i === segments) {
                            // Taper to a point at the tip
                            ctx.lineWidth = width * 0.3;
                        }
                        
                        ctx.lineTo(segmentX + variation, segmentY);
                    }
                    
                    ctx.stroke();
                    ctx.restore();
                  }

                  _makeSeamless(canvas, config = this.seamlessConfig) {
                    if (!config?.enabled) return canvas;

                    const ctx = canvas.getContext('2d');
                    const width = canvas.width;
                    const height = canvas.height;
                    const maxRadius = Math.min(width, height);
                    const radius = Math.max(0, Math.min(Math.floor(config.blendRadius ?? 0), maxRadius));
                    const strength = Number.isFinite(config.blendStrength)
                      ? Math.min(1, Math.max(0, config.blendStrength))
                      : 1.0;
                    if (radius < 1 || strength <= 0) return canvas;

                    const imageData = ctx.getImageData(0, 0, width, height);
                    const data = imageData.data;
                    const originalData = new Uint8ClampedArray(data);

                    if (config.method === 'quad-symmetric') {
                      this._makeQuadSymmetric(data, originalData, width, height, radius, strength, config.cornerBlend);
                    } else if (config.method === 'wrap') {
                      this._wrapEdges(data, originalData, width, height, radius, strength);
                    } else if (config.method === 'mirror') {
                      this._mirrorEdges(data, originalData, width, height, radius, strength);
                    } else if (config.method === 'fade') {
                      this._fadeEdges(data, originalData, width, height, radius, strength);
                    }

                    ctx.putImageData(imageData, 0, 0);
                    return canvas;
                  }

                  _makeQuadSymmetric(data, original, width, height, radius, strength, blendCorners = true) {
                    const avgEdge = this._calculateAverageEdgeProfile(original, width, height, radius);
                    this._blendEdgeToProfile(data, original, width, height, radius, strength, avgEdge, 'top');
                    this._blendEdgeToProfile(data, original, width, height, radius, strength, avgEdge, 'bottom');
                    this._blendEdgeToProfile(data, original, width, height, radius, strength, avgEdge, 'left');
                    this._blendEdgeToProfile(data, original, width, height, radius, strength, avgEdge, 'right');
                    if (blendCorners) {
                      this._blendCorners(data, original, width, height, radius, strength);
                    }
                  }

                  _calculateAverageEdgeProfile(data, width, height, radius) {
                    const profile = [];
                    const sampleCount = Math.max(width, height);
                    for (let i = 0; i < sampleCount; i++) {
                      let r = 0, g = 0, b = 0, a = 0, count = 0;
                      const t = i / sampleCount;

                      const topX = Math.floor(t * width);
                      const topIdx = (0 * width + topX) * 4;
                      r += data[topIdx]; g += data[topIdx + 1]; b += data[topIdx + 2]; a += data[topIdx + 3];
                      count++;

                      const bottomX = Math.floor(t * width);
                      const bottomIdx = ((height - 1) * width + bottomX) * 4;
                      r += data[bottomIdx]; g += data[bottomIdx + 1]; b += data[bottomIdx + 2]; a += data[bottomIdx + 3];
                      count++;

                      const leftY = Math.floor(t * height);
                      const leftIdx = (leftY * width + 0) * 4;
                      r += data[leftIdx]; g += data[leftIdx + 1]; b += data[leftIdx + 2]; a += data[leftIdx + 3];
                      count++;

                      const rightY = Math.floor(t * height);
                      const rightIdx = (rightY * width + (width - 1)) * 4;
                      r += data[rightIdx]; g += data[rightIdx + 1]; b += data[rightIdx + 2]; a += data[rightIdx + 3];
                      count++;

                      profile.push({
                        r: r / count,
                        g: g / count,
                        b: b / count,
                        a: a / count
                      });
                    }
                    return profile;
                  }

                  _blendEdgeToProfile(data, original, width, height, radius, strength, profile, edge) {
                    const smoothstep = (t) => t * t * (3 - 2 * t);
                    if (edge === 'top' || edge === 'bottom') {
                      const isTop = edge === 'top';
                      for (let dy = 0; dy < radius; dy++) {
                        const blend = smoothstep(dy / radius);
                        const blendToTarget = (1 - blend) * strength;
                        const y = isTop ? dy : height - 1 - dy;
                        for (let x = 0; x < width; x++) {
                          const idx = (y * width + x) * 4;
                          const t = x / width;
                          const profileIdx = Math.floor(t * profile.length);
                          const target = profile[profileIdx];
                          data[idx + 0] = original[idx + 0] * (1 - blendToTarget) + target.r * blendToTarget;
                          data[idx + 1] = original[idx + 1] * (1 - blendToTarget) + target.g * blendToTarget;
                          data[idx + 2] = original[idx + 2] * (1 - blendToTarget) + target.b * blendToTarget;
                          data[idx + 3] = original[idx + 3] * (1 - blendToTarget) + target.a * blendToTarget;
                        }
                      }
                    } else {
                      const isLeft = edge === 'left';
                      for (let dx = 0; dx < radius; dx++) {
                        const blend = smoothstep(dx / radius);
                        const blendToTarget = (1 - blend) * strength;
                        const x = isLeft ? dx : width - 1 - dx;
                        for (let y = 0; y < height; y++) {
                          const idx = (y * width + x) * 4;
                          const t = y / height;
                          const profileIdx = Math.floor(t * profile.length);
                          const target = profile[profileIdx];
                          data[idx + 0] = original[idx + 0] * (1 - blendToTarget) + target.r * blendToTarget;
                          data[idx + 1] = original[idx + 1] * (1 - blendToTarget) + target.g * blendToTarget;
                          data[idx + 2] = original[idx + 2] * (1 - blendToTarget) + target.b * blendToTarget;
                          data[idx + 3] = original[idx + 3] * (1 - blendToTarget) + target.a * blendToTarget;
                        }
                      }
                    }
                  }

                  _blendCorners(data, original, width, height, radius, strength) {
                    const smoothstep = (t) => t * t * (3 - 2 * t);
                    const corners = [
                      { x: 0, y: 0, xDir: 1, yDir: 1 },
                      { x: width - 1, y: 0, xDir: -1, yDir: 1 },
                      { x: 0, y: height - 1, xDir: 1, yDir: -1 },
                      { x: width - 1, y: height - 1, xDir: -1, yDir: -1 }
                    ];

                    for (const corner of corners) {
                      for (let dy = 0; dy < radius; dy++) {
                        for (let dx = 0; dx < radius; dx++) {
                          const x = corner.x + dx * corner.xDir;
                          const y = corner.y + dy * corner.yDir;
                          if (x < 0 || x >= width || y < 0 || y >= height) continue;

                          const idx = (y * width + x) * 4;
                          const distX = dx / radius;
                          const distY = dy / radius;
                          const dist = Math.sqrt(distX * distX + distY * distY);
                          if (dist >= 1.0) continue;

                          const blendFactor = (1.0 - smoothstep(dist)) * strength;
                          const samples = [];

                          const hx = corner.x;
                          const hy = y;
                          if (hx >= 0 && hx < width && hy >= 0 && hy < height) {
                            const hidx = (hy * width + hx) * 4;
                            samples.push([data[hidx], data[hidx + 1], data[hidx + 2], data[hidx + 3]]);
                          }

                          const vx = x;
                          const vy = corner.y;
                          if (vx >= 0 && vx < width && vy >= 0 && vy < height) {
                            const vidx = (vy * width + vx) * 4;
                            samples.push([data[vidx], data[vidx + 1], data[vidx + 2], data[vidx + 3]]);
                          }

                          if (samples.length === 0) continue;
                          let avgR = 0, avgG = 0, avgB = 0, avgA = 0;
                          for (const s of samples) {
                            avgR += s[0]; avgG += s[1]; avgB += s[2]; avgA += s[3];
                          }
                          const count = samples.length;
                          avgR /= count; avgG /= count; avgB /= count; avgA /= count;

                          data[idx + 0] = data[idx + 0] * (1 - blendFactor) + avgR * blendFactor;
                          data[idx + 1] = data[idx + 1] * (1 - blendFactor) + avgG * blendFactor;
                          data[idx + 2] = data[idx + 2] * (1 - blendFactor) + avgB * blendFactor;
                          data[idx + 3] = data[idx + 3] * (1 - blendFactor) + avgA * blendFactor;
                        }
                      }
                    }
                  }

                  _mirrorEdges(data, original, width, height, radius, strength) {
                    for (let y = 0; y < radius; y++) {
                      const blend = y / radius;
                      const blendToMirror = (1 - blend) * strength;
                      for (let x = 0; x < width; x++) {
                        const topIdx = (y * width + x) * 4;
                        const mirrorTopIdx = ((radius - y) * width + x) * 4;
                        const bottomIdx = ((height - 1 - y) * width + x) * 4;
                        const mirrorBottomIdx = ((height - 1 - radius + y) * width + x) * 4;

                        for (let c = 0; c < 4; c++) {
                          data[topIdx + c] = original[topIdx + c] * (1 - blendToMirror) +
                                             original[mirrorTopIdx + c] * blendToMirror;
                          data[bottomIdx + c] = original[bottomIdx + c] * (1 - blendToMirror) +
                                                original[mirrorBottomIdx + c] * blendToMirror;
                        }
                      }
                    }

                    for (let y = 0; y < height; y++) {
                      for (let x = 0; x < radius; x++) {
                        const blend = x / radius;
                        const blendToMirror = (1 - blend) * strength;
                        const leftIdx = (y * width + x) * 4;
                        const mirrorLeftIdx = (y * width + (radius - x)) * 4;
                        const rightIdx = (y * width + (width - 1 - x)) * 4;
                        const mirrorRightIdx = (y * width + (width - 1 - radius + x)) * 4;

                        for (let c = 0; c < 4; c++) {
                          data[leftIdx + c] = original[leftIdx + c] * (1 - blendToMirror) +
                                              original[mirrorLeftIdx + c] * blendToMirror;
                          data[rightIdx + c] = original[rightIdx + c] * (1 - blendToMirror) +
                                               original[mirrorRightIdx + c] * blendToMirror;
                        }
                      }
                    }
                  }

                  _wrapEdges(data, original, width, height, radius, strength) {
                    for (let y = 0; y < radius; y++) {
                      const blend = y / radius;
                      const blendToWrap = (1 - blend) * strength;
                      for (let x = 0; x < width; x++) {
                        const topIdx = (y * width + x) * 4;
                        const wrapTopIdx = ((height - radius + y) * width + x) * 4;
                        const bottomIdx = ((height - 1 - y) * width + x) * 4;
                        const wrapBottomIdx = ((radius - 1 - y) * width + x) * 4;

                        for (let c = 0; c < 4; c++) {
                          data[topIdx + c] = original[topIdx + c] * (1 - blendToWrap) +
                                             original[wrapTopIdx + c] * blendToWrap;
                          data[bottomIdx + c] = original[bottomIdx + c] * (1 - blendToWrap) +
                                                original[wrapBottomIdx + c] * blendToWrap;
                        }
                      }
                    }

                    for (let y = 0; y < height; y++) {
                      for (let x = 0; x < radius; x++) {
                        const blend = x / radius;
                        const blendToWrap = (1 - blend) * strength;
                        const leftIdx = (y * width + x) * 4;
                        const wrapLeftIdx = (y * width + (width - radius + x)) * 4;
                        const rightIdx = (y * width + (width - 1 - x)) * 4;
                        const wrapRightIdx = (y * width + (radius - 1 - x)) * 4;

                        for (let c = 0; c < 4; c++) {
                          data[leftIdx + c] = original[leftIdx + c] * (1 - blendToWrap) +
                                              original[wrapLeftIdx + c] * blendToWrap;
                          data[rightIdx + c] = original[rightIdx + c] * (1 - blendToWrap) +
                                               original[wrapRightIdx + c] * blendToWrap;
                        }
                      }
                    }
                  }

                  _fadeEdges(data, original, width, height, radius, strength) {
                    const avgTop = this._getAverageEdgeColor(original, width, height, 'top', radius);
                    const avgBottom = this._getAverageEdgeColor(original, width, height, 'bottom', radius);
                    const avgLeft = this._getAverageEdgeColor(original, width, height, 'left', radius);
                    const avgRight = this._getAverageEdgeColor(original, width, height, 'right', radius);

                    for (let y = 0; y < radius; y++) {
                      const blend = (1 - (y / radius)) * strength;
                      for (let x = 0; x < width; x++) {
                        const topIdx = (y * width + x) * 4;
                        for (let c = 0; c < 4; c++) {
                          data[topIdx + c] = original[topIdx + c] * (1 - blend) + avgTop[c] * blend;
                        }
                        const bottomIdx = ((height - 1 - y) * width + x) * 4;
                        for (let c = 0; c < 4; c++) {
                          data[bottomIdx + c] = original[bottomIdx + c] * (1 - blend) + avgBottom[c] * blend;
                        }
                      }
                    }

                    for (let y = 0; y < height; y++) {
                      for (let x = 0; x < radius; x++) {
                        const blend = (1 - (x / radius)) * strength;
                        const leftIdx = (y * width + x) * 4;
                        for (let c = 0; c < 4; c++) {
                          data[leftIdx + c] = original[leftIdx + c] * (1 - blend) + avgLeft[c] * blend;
                        }
                        const rightIdx = (y * width + (width - 1 - x)) * 4;
                        for (let c = 0; c < 4; c++) {
                          data[rightIdx + c] = original[rightIdx + c] * (1 - blend) + avgRight[c] * blend;
                        }
                      }
                    }
                  }

                  _getAverageEdgeColor(data, width, height, edge, radius) {
                    let r = 0, g = 0, b = 0, a = 0, count = 0;
                    if (edge === 'top' || edge === 'bottom') {
                      const y = edge === 'top' ? radius : height - radius - 1;
                      for (let x = 0; x < width; x++) {
                        const idx = (y * width + x) * 4;
                        r += data[idx]; g += data[idx + 1]; b += data[idx + 2]; a += data[idx + 3];
                        count++;
                      }
                    } else {
                      const x = edge === 'left' ? radius : width - radius - 1;
                      for (let y = 0; y < height; y++) {
                        const idx = (y * width + x) * 4;
                        r += data[idx]; g += data[idx + 1]; b += data[idx + 2]; a += data[idx + 3];
                        count++;
                      }
                    }
                    return [r / count, g / count, b / count, a / count];
                  }

                  configureSeamless(options) {
                    this.seamlessConfig = { ...this.seamlessConfig, ...options };
                  }
                  
 }    
export default ProceduralTextureGenerator;
