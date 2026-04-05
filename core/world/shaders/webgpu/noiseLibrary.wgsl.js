// js/world/shaders/webgpu/noiseLibrary.wgsl.js
// Full WGSL noise library (drop-in) with:
// - robust hashing via bitcast<u32>(i32) (no negative-cast quirks)
// - Perlin 2D + 3D
// - FBM 2D + 3D (normalized by amplitude sum)
// - Ridged multifractal 2D + 3D (UNnormalized sum, matching your old 2D behavior)
// - Voronoi 2D + edges helper
// - Billow + Turbulence
// - Domain warps 2D + 3D
// - Metric helpers (planet-proof feature size): wavelength_m + sphere/flat metric sampling
// - Proper domain rotation matrix (dot products) and WGSL-safe operator precedence

export function createNoiseLibrary() {
    return `
  // =====================================================================================
  // NOISE LIBRARY (WGSL) — FULL MODULE
  // =====================================================================================
  
  // ==================== CONSTANTS ====================
  const U32_MAX_F: f32 = 4294967295.0;
  
  // ==================== HASH / RNG ====================
  // Avalanche mixer (good diffusion, cheap)
  fn mix32(h: u32) -> u32 {
      var x = h;
      x ^= x >> 16u;
      x *= 0x7FEB352Du;
      x ^= x >> 15u;
      x *= 0x846CA68Bu;
      x ^= x >> 16u;
      return x;
  }
      fn smoothAbs(x: f32, k: f32) -> f32 {
    // k controls smoothing width in noise-value units
    // smooth abs = sqrt(x^2 + k^2) - k  (0 at x=0, smooth derivative)
    return sqrt(x * x + k * k) - k;
}

fn smoothMin(a: f32, b: f32, k: f32) -> f32 {
    // k controls blend width; bigger = smoother switch
    let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
}

  fn smoothMax(a: f32, b: f32, k: f32) -> f32 {
    // Smooth approximation of max(a,b). Larger k => smoother blend.
    let kk = max(k, 1e-4);
    let h = clamp(0.5 + 0.5 * (b - a) / kk, 0.0, 1.0);
    // Polynomial smooth max (C1). Good enough to eliminate visible ledges.
    return mix(b, a, h) + kk * h * (1.0 - h);
}

  fn hash1(seed: i32) -> u32 {
      return mix32(bitcast<u32>(seed));
  }
  
  // IMPORTANT: WGSL requires parentheses when mixing '*' and '^'
  fn hash2d(p: vec2<i32>, seed: i32) -> u32 {
      let ux = bitcast<u32>(p.x);
      let uy = bitcast<u32>(p.y);
      let us = bitcast<u32>(seed);
  
      var h =
          (ux * 0x9E3779B9u) ^
          (uy * 0x85EBCA6Bu) ^
          (us * 0xC2B2AE35u);
  
      return mix32(h);
  }
  
  fn hash3d(p: vec3<i32>, seed: i32) -> u32 {
      let ux = bitcast<u32>(p.x);
      let uy = bitcast<u32>(p.y);
      let uz = bitcast<u32>(p.z);
      let us = bitcast<u32>(seed);
  
      var h =
          (ux * 0x9E3779B9u) ^
          (uy * 0x85EBCA6Bu) ^
          (uz * 0xC2B2AE35u) ^
          (us * 0x27D4EB2Fu);
  
      return mix32(h);
  }
  
  fn hashToFloat01(h: u32) -> f32 {
      return f32(h) / U32_MAX_F;
  }
  
  fn hashToVec2_01(h: u32) -> vec2<f32> {
      let h1 = mix32(h);
      let h2 = mix32(h ^ 0xA5A5A5A5u);
      return vec2<f32>(f32(h1) / U32_MAX_F, f32(h2) / U32_MAX_F);
  }
  
  fn hashToVec3_01(h: u32) -> vec3<f32> {
      let h1 = mix32(h);
      let h2 = mix32(h ^ 0xA5A5A5A5u);
      let h3 = mix32(h ^ 0x3C3C3C3Cu);
      return vec3<f32>(
          f32(h1) / U32_MAX_F,
          f32(h2) / U32_MAX_F,
          f32(h3) / U32_MAX_F
      );
  }
  
  // ==================== INTERPOLATION ====================
  // Quintic Perlin fade: 6t^5 - 15t^4 + 10t^3
  fn fade(t: f32) -> f32 {
      return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
  }
  
  // ==================== GRADIENTS ====================
  // 2D gradients: 8 dirs
  fn grad2(h: u32, x: f32, y: f32) -> f32 {
      let g = h & 7u;
      let u = select(y, x, g < 4u);
      let v = select(x, y, g < 4u);
      let su = select(-u, u, (g & 1u) == 0u);
      let sv = select(-v, v, (g & 2u) == 0u);
      return su + sv;
  }
  
  // 3D gradients: 16 dirs
  fn grad3(h: u32, x: f32, y: f32, z: f32) -> f32 {
      let hh = h & 15u;
      let u = select(y, x, hh < 8u);
      let v = select(select(x, z, hh == 12u || hh == 14u), y, hh < 4u);
      let su = select(-u, u, (hh & 1u) == 0u);
      let sv = select(-v, v, (hh & 2u) == 0u);
      return su + sv;
  }
  
  // ==================== PERLIN 2D ====================
  fn perlin2D(x: f32, y: f32, seed: i32) -> f32 {
      let ix = i32(floor(x));
      let iy = i32(floor(y));
      let fx = x - f32(ix);
      let fy = y - f32(iy);
  
      let u = fade(fx);
      let v = fade(fy);
  
      let a = hash2d(vec2<i32>(ix, iy), seed);
      let b = hash2d(vec2<i32>(ix + 1, iy), seed);
      let c = hash2d(vec2<i32>(ix, iy + 1), seed);
      let d = hash2d(vec2<i32>(ix + 1, iy + 1), seed);
  
      let x1 = mix(grad2(a, fx, fy), grad2(b, fx - 1.0, fy), u);
      let x2 = mix(grad2(c, fx, fy - 1.0), grad2(d, fx - 1.0, fy - 1.0), u);
      return mix(x1, x2, v);
  }
  
  // ==================== PERLIN 3D ====================
  fn perlin3D(p: vec3<f32>, seed: i32) -> f32 {
      let i = vec3<i32>(floor(p));
      let f = fract(p);
  
      let u = vec3<f32>(fade(f.x), fade(f.y), fade(f.z));
  
      let h000 = hash3d(i, seed);
      let h100 = hash3d(i + vec3<i32>(1, 0, 0), seed);
      let h010 = hash3d(i + vec3<i32>(0, 1, 0), seed);
      let h110 = hash3d(i + vec3<i32>(1, 1, 0), seed);
      let h001 = hash3d(i + vec3<i32>(0, 0, 1), seed);
      let h101 = hash3d(i + vec3<i32>(1, 0, 1), seed);
      let h011 = hash3d(i + vec3<i32>(0, 1, 1), seed);
      let h111 = hash3d(i + vec3<i32>(1, 1, 1), seed);
  
      let g000 = grad3(h000, f.x,       f.y,       f.z);
      let g100 = grad3(h100, f.x - 1.0, f.y,       f.z);
      let g010 = grad3(h010, f.x,       f.y - 1.0, f.z);
      let g110 = grad3(h110, f.x - 1.0, f.y - 1.0, f.z);
      let g001 = grad3(h001, f.x,       f.y,       f.z - 1.0);
      let g101 = grad3(h101, f.x - 1.0, f.y,       f.z - 1.0);
      let g011 = grad3(h011, f.x,       f.y - 1.0, f.z - 1.0);
      let g111 = grad3(h111, f.x - 1.0, f.y - 1.0, f.z - 1.0);
  
      let x00 = mix(g000, g100, u.x);
      let x10 = mix(g010, g110, u.x);
      let x01 = mix(g001, g101, u.x);
      let x11 = mix(g011, g111, u.x);
  
      let y0 = mix(x00, x10, u.y);
      let y1 = mix(x01, x11, u.y);
  
      return mix(y0, y1, u.z);
  }
  
  // ==================== FBM (2D / 3D) ====================
  fn fbm(p: vec2<f32>, octaves: i32, seed: i32, lacunarity: f32, gain: f32) -> f32 {
      var value = 0.0;
      var amp = 1.0;
      var freq = 1.0;
      var sumAmp = 0.0;
  
      for (var i = 0; i < 16; i++) {
          if (i >= octaves) { break; }
          value += perlin2D(p.x * freq, p.y * freq, seed + i) * amp;
          sumAmp += amp;
          amp *= gain;
          freq *= lacunarity;
      }
  
      return value / max(sumAmp, 1e-6);
  }
  
  fn fbm3D(p: vec3<f32>, octaves: i32, seed: i32, lacunarity: f32, gain: f32) -> f32 {
      var value = 0.0;
      var amp = 1.0;
      var freq = 1.0;
      var sumAmp = 0.0;

      for (var i = 0; i < 16; i++) {
          if (i >= octaves) { break; }
          value += perlin3D(p * freq, seed + i) * amp;
          sumAmp += amp;
          amp *= gain;
          freq *= lacunarity;
      }

      return value / max(sumAmp, 1e-6);
  }
  
  // ==================== RIDGED MULTIFRACTAL (2D / 3D) ====================
  // UNnormalized accumulation (matches your previous 2D semantics).
  fn ridgedMultifractal(p: vec2<f32>, octaves: i32, seed: i32, lacunarity: f32, gain: f32, offset: f32) -> f32 {
      var value = 0.0;
      var amplitude = 1.0;
      var frequency = 1.0;
      var weight = 1.0;
  
      for (var i = 0; i < 16; i++) {
          if (i >= octaves) { break; }
  
          var signal = perlin2D(p.x * frequency, p.y * frequency, seed + i);
          signal = offset - abs(signal);
          signal = signal * signal;
          signal *= weight;
  
          weight = clamp(signal * amplitude, 0.0, 1.0);
          value += signal * amplitude;
  
          amplitude *= gain;
          frequency *= lacunarity;
      }
  
      return value;
  }
  
  fn ridgedMultifractal3D(p: vec3<f32>, octaves: i32, seed: i32, lacunarity: f32, gain: f32, offset: f32) -> f32 {
      var value = 0.0;
      var amplitude = 1.0;
      var frequency = 1.0;
      var weight = 1.0;
  
      for (var i = 0; i < 16; i++) {
          if (i >= octaves) { break; }
  
          var signal = perlin3D(p * frequency, seed + i);
          signal = offset - abs(signal);
          signal = signal * signal;
          signal *= weight;
  
          weight = clamp(signal * amplitude, 0.0, 1.0);
          value += signal * amplitude;
  
          amplitude *= gain;
          frequency *= lacunarity;
      }
  
      return value;
  }
  
  // ==================== VORONOI 2D ====================
  fn voronoi2D(p: vec2<f32>, seed: i32) -> vec4<f32> {
      let n = floor(p);
      let f = fract(p);
  
      var minDist = 1e9;
      var minDist2 = 1e9;
      var minCell = vec2<i32>(0);
  
      for (var y = -1; y <= 1; y++) {
          for (var x = -1; x <= 1; x++) {
              let cell = vec2<i32>(i32(n.x) + x, i32(n.y) + y);
              let h = hash2d(cell, seed);
              let jitter = hashToVec2_01(h);
              let point = vec2<f32>(f32(x), f32(y)) + jitter;
              let d = length(point - f);
  
              if (d < minDist) {
                  minDist2 = minDist;
                  minDist = d;
                  minCell = cell;
              } else if (d < minDist2) {
                  minDist2 = d;
              }
          }
      }
  
      return vec4<f32>(minDist, minDist2, f32(minCell.x), f32(minCell.y));
  }
  
  fn voronoiWithEdges(p: vec2<f32>, seed: i32) -> vec3<f32> {
      let v = voronoi2D(p, seed);
      let edgeDistance = v.y - v.x;
      return vec3<f32>(v.x, edgeDistance, v.y);
  }
  
  // ==================== BILLOW / TURBULENCE ====================
  fn billow(p: vec2<f32>, octaves: i32, seed: i32, lacunarity: f32, gain: f32) -> f32 {
      var value = 0.0;
      var amp = 1.0;
      var freq = 1.0;
      var sumAmp = 0.0;
  
      for (var i = 0; i < 16; i++) {
          if (i >= octaves) { break; }
          value += abs(perlin2D(p.x * freq, p.y * freq, seed + i)) * amp;
          sumAmp += amp;
          amp *= gain;
          freq *= lacunarity;
      }
  
      return value / max(sumAmp, 1e-6);
  }
  
  fn turbulence(p: vec2<f32>, octaves: i32, seed: i32) -> f32 {
      var value = 0.0;
      var amp = 1.0;
      var freq = 1.0;
  
      for (var i = 0; i < 16; i++) {
          if (i >= octaves) { break; }
          value += abs(perlin2D(p.x * freq, p.y * freq, seed + i)) * amp;
          amp *= 0.5;
          freq *= 2.0;
      }
  
      return value;
  }
  
  // ==================== DOMAIN WARPING ====================
  fn warp(p: vec2<f32>, seed: i32, amount: f32) -> vec2<f32> {
      let w0 = fbm(p * 0.001, 2, seed, 2.0, 0.5) * amount;
      let w1 = fbm((p + vec2<f32>(39784.0, -9083.0)) * 0.001, 2, seed + 1, 2.0, 0.5) * amount;
      return p + vec2<f32>(w0, w1);
  }
  
  fn warpMultiscale(p: vec2<f32>, seed: i32) -> vec2<f32> {
      let q = vec2<f32>(
          fbm(p * 0.0001, 4, seed, 2.0, 0.5),
          fbm(p * 0.0001 + vec2<f32>(5.2, 1.3), 4, seed + 1, 2.0, 0.5)
      );
  
      let r = vec2<f32>(
          fbm(p * 0.001 + 4.0 * q, 4, seed + 2, 2.0, 0.5),
          fbm(p * 0.001 + 4.0 * q + vec2<f32>(1.7, 9.2), 4, seed + 3, 2.0, 0.5)
      );
  
      return p + 50.0 * r;
  }
  
  fn warpMultiscale3D(p: vec3<f32>, seed: i32) -> vec3<f32> {
      let q = vec3<f32>(
          fbm3D(p * 0.0001, 4, seed, 2.0, 0.5),
          fbm3D(p * 0.0001 + vec3<f32>(5.2, 1.3, 7.8), 4, seed + 1, 2.0, 0.5),
          fbm3D(p * 0.0001 + vec3<f32>(3.1, 8.4, 2.9), 4, seed + 2, 2.0, 0.5)
      );
  
      let r = vec3<f32>(
          fbm3D(p * 0.001 + 4.0 * q, 4, seed + 3, 2.0, 0.5),
          fbm3D(p * 0.001 + 4.0 * q + vec3<f32>(1.7, 9.2, 4.3), 4, seed + 4, 2.0, 0.5),
          fbm3D(p * 0.001 + 4.0 * q + vec3<f32>(6.1, 2.8, 5.7), 4, seed + 5, 2.0, 0.5)
      );
  
      return p + 50.0 * r;
  }
  
  // ==================== METRIC / PLANET HELPERS ====================
  // Your design spec:
  // - wavelength_m = scale * geologyScaleMeters
  // - planet radius must not affect feature size
  // - use unit direction + NOISE reference radius (constant across planets)
  
  fn wavelength_m(scale: f32, geologyScaleMeters: f32) -> f32 {
      return max(scale * geologyScaleMeters, 0.0001);
  }
  
  // Length-preserving domain rotation (dot with fixed basis vectors).
  fn rotateDomain3(p: vec3<f32>) -> vec3<f32> {
      let m0 = vec3<f32>( 0.00,  0.80,  0.60);
      let m1 = vec3<f32>(-0.80,  0.36, -0.48);
      let m2 = vec3<f32>(-0.60, -0.48,  0.64);
      return vec3<f32>(dot(p, m0), dot(p, m1), dot(p, m2));
  }
  
  fn sphereDomainPos(unitDir: vec3<f32>, noiseReferenceRadiusM: f32) -> vec3<f32> {
      return unitDir * noiseReferenceRadiusM;
  }
  
  // Metric FBM sampling for sphere (3D)
  fn fbmMetricSphere3D(
      unitDir: vec3<f32>,
      scale: f32,
      geologyScaleMeters: f32,
      noiseReferenceRadiusM: f32,
      octaves: i32,
      seed: i32,
      lacunarity: f32,
      gain: f32
  ) -> f32 {
      let R = max(noiseReferenceRadiusM, 1.0);
      let pM = sphereDomainPos(unitDir, R);   // meters-ish
      let w = wavelength_m(scale, geologyScaleMeters);
      let p = rotateDomain3(pM / w);          // dimensionless
      return fbm3D(p, octaves, seed, lacunarity, gain);
  }
  
  // Metric FBM sampling for flat (2D)
  fn fbmMetricFlat2D(
      wx_m: f32,
      wy_m: f32,
      scale: f32,
      geologyScaleMeters: f32,
      octaves: i32,
      seed: i32,
      lacunarity: f32,
      gain: f32
  ) -> f32 {
      let w = wavelength_m(scale, geologyScaleMeters);
      let p = vec2<f32>(wx_m / w, wy_m / w);
      return fbm(p, octaves, seed, lacunarity, gain);
  }
  
  // Metric ridged sampling for sphere (3D)
  fn ridgedMetricSphere3D(
      unitDir: vec3<f32>,
      scale: f32,
      geologyScaleMeters: f32,
      noiseReferenceRadiusM: f32,
      octaves: i32,
      seed: i32,
      lacunarity: f32,
      gain: f32,
      offset: f32
  ) -> f32 {
      let R = max(noiseReferenceRadiusM, 1.0);
      let pM = sphereDomainPos(unitDir, R);
      let w = wavelength_m(scale, geologyScaleMeters);
      let p = rotateDomain3(pM / w);
      return ridgedMultifractal3D(p, octaves, seed, lacunarity, gain, offset);
  }
  
  // Metric ridged sampling for flat (2D)
  fn ridgedMetricFlat2D(
      wx_m: f32,
      wy_m: f32,
      scale: f32,
      geologyScaleMeters: f32,
      octaves: i32,
      seed: i32,
      lacunarity: f32,
      gain: f32,
      offset: f32
  ) -> f32 {
      let w = wavelength_m(scale, geologyScaleMeters);
      let p = vec2<f32>(wx_m / w, wy_m / w);
      return ridgedMultifractal(p, octaves, seed, lacunarity, gain, offset);
  }
  `;
  }
  