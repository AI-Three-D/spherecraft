// js/config/textures/reusable/snowTextures.js

export const SNOW_MICRO_A = [
  { type: 'fill', color: '#d9edf5', opacity: 1.0 },
  { type: 'fbm', octaves: 4, frequency: 0.055, persistence: 0.55, color: '#b8d3de', opacity: 0.24, blendMode: 'multiply', seed: 21001 },
  { type: 'perlin', octaves: 2, frequency: 0.14, amplitude: 0.7, color: '#ffffff', opacity: 0.16, blendMode: 'overlay', seed: 21002 }
];

export const SNOW_MICRO_B = [
  { type: 'fill', color: '#d2e7f1', opacity: 1.0 },
  { type: 'turbulence', octaves: 3, frequency: 0.022, turbulencePower: 1.8, color: '#a7c3cf', opacity: 0.18, blendMode: 'multiply', seed: 21011 },
  { type: 'cells', frequency: 0.18, cellScale: 1.15, cellRandomness: 1.0, color: '#ffffff', opacity: 0.08, blendMode: 'screen', seed: 21012 }
];

export const SNOW_MACRO = [
  { type: 'fbm', octaves: 4, frequency: 0.0022, persistence: 0.55, domainWarp: true, warpStrength: 0.9, warpFrequency: 0.012, color: '#cfe2ea', opacity: 1, seed: 21021 }
];
