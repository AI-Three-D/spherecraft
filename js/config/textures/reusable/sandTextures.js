// js/config/textures/reusable/sandTextures.js

export const SAND_MICRO_A = [
  { type: 'fill', color: '#3a321f', opacity: 1.0 },
  { type: 'fbm', octaves: 5, frequency: 0.06, persistence: 0.58, color: '#FF00FF', opacity: 0.35, blendMode: 'multiply', seed: 18001 },
  { type: 'voronoi', frequency: 0.18, cellRandomness: 0.92, color: '#6f5a2a', opacity: 0.12, blendMode: 'overlay', seed: 18002 },
  { type: 'grain', amplitude: 2.2, color: '#8a8a8a', opacity: 0.05, blendMode: 'overlay', seed: 18031 },
  { type: 'grain', amplitude: 2.2, color: '#767676', opacity: 0.05, blendMode: 'overlay', seed: 18032 }
];

export const SAND_MACRO = [
  { type: 'fbm', octaves: 4, frequency: 0.0022, persistence: 0.55, domainWarp: true, warpStrength: 0.9, warpFrequency: 0.01, color: '#d7c08a', opacity: 1, seed: 15021 },
  { type: 'voronoi', frequency: 0.0019, cellScale: 1.6, cellRandomness: 0.9, color: '#f0dfb2', opacity: 0.10, blendMode: 'overlay', seed: 15031 }
];
