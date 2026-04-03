// js/config/textures/reusable/tundraTextures.js

export const TUNDRA_MICRO_A = [
  { type: 'fill', color: '#7f8d76', opacity: 1.0 },
  { type: 'fbm', octaves: 5, frequency: 0.05, persistence: 0.6, color: '#f0f0f0', opacity: 0.30, blendMode: 'multiply', seed: 17001 },
  { type: 'perlin', octaves: 2, frequency: 0.12, amplitude: 0.6, color: '#9aa694', opacity: 0.18, blendMode: 'overlay', seed: 17002 }
];

export const TUNDRA_MICRO_B = [
  { type: 'fill', color: '#76846d', opacity: 1.0 },
  { type: 'turbulence', octaves: 3, frequency: 0.022, turbulencePower: 2.0, color: '#3f473b', opacity: 0.22, blendMode: 'multiply', seed: 17011 },
  { type: 'cells', frequency: 0.20, cellScale: 1.1, cellRandomness: 1.0, color: '#aab4a3', opacity: 0.10, blendMode: 'overlay', seed: 17012 }
];

export const TUNDRA_MACRO = [
  { type: 'fbm', octaves: 5, frequency: 0.0024, persistence: 0.6, domainWarp: true, warpStrength: 0.95, warpFrequency: 0.012, color: '#7f8d76', opacity: 1, seed: 17021 }
];
